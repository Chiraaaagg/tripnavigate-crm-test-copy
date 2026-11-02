import type { IntakeErrorCode, WorkerRunSummary } from '../contracts';
import type { ResyncResult, RpcClient, RunOutcome, RunTrigger } from '../commands';
import type { IntakeConfig } from '../intake-config';
import { BitrixClientError, type BitrixClient } from './client';
import type { ReconcileDeps, ReconcileSummary } from './reconcile';
import { finishResyncIfDrained, runResyncListing } from './resync';
import { runReconcileWithHeartbeat, runWorkerWithHeartbeat } from './runs';
import { emptySummary, WORKER_MAX_LIMIT } from './worker';

/**
 * One automatic Bitrix -> CRM sync run (the scheduler, the worker route with
 * ?task=sync and the admin "Sync now" button all call this):
 *
 *   1. Full resync step: if a resync job is open (settings saved, "Sync now",
 *      or the daily job the database queues itself), list the next Bitrix
 *      pages by ID cursor with exactly the configured filter. Continues across
 *      runs until complete; never truncates.
 *   2. Pull changes: reconcile UPDATE pass (>DATE_MODIFY since the watermark,
 *      every pipeline). A poll with no changes costs one crm.deal.list call.
 *   3. Drain the inbox: bounded worker batches (claim with lease + SKIP LOCKED
 *      -> one crm.deal.list per batch, crm.deal.get for anything it did not
 *      return -> apply) until it is empty, Bitrix pushes back, or the time
 *      budget is used up. Unprocessed leased rows are released.
 *   4. A fully listed resync job is completed once the inbox has drained:
 *      Bitrix vs CRM counts are recorded.
 *   Heartbeats: each reconcile and worker batch writes integration_worker_runs.
 *
 * Bounded (time budget), idempotent (dedupe in the SQL commands) and safe when
 * two runs overlap (leases, SKIP LOCKED, forward-only watermark). It keeps no
 * in-memory state between runs: everything it needs is read from the database.
 *
 * If Bitrix fails during steps 1-2, step 3 is skipped: queued rows stay pending
 * untouched instead of using up retry attempts against an unavailable portal.
 */

export const SYNC_BUDGET_MS = 45_000;
/** Up to 10 000 changed deals per pass; beyond that the next run continues. */
export const SYNC_MAX_PAGES = 200;
/** Time kept for the update pass and the worker when a resync is listing. */
const RESYNC_RESERVE_MS = 20_000;
/** Never start a worker batch with less time than this left. */
const MIN_BATCH_MS = 2_000;

export interface SyncDeps {
  rpc: RpcClient;
  bitrix: Pick<BitrixClient, 'listDeals' | 'listLeads' | 'getDeal' | 'getLead'>;
  config: IntakeConfig;
  heldDealIds?: (ids: number[]) => Promise<Set<number>>;
  /** Phase 6: active manifest IDs per object (see ReconcileDeps). Omitted = Leads are not reconciled. */
  activeManifestIds?: ReconcileDeps['activeManifestIds'];
  /** Phase 6: last_verified_at of manifest IDs CRM holds (see ReconcileDeps). */
  verifiedAt?: ReconcileDeps['verifiedAt'];
  /** Sync completion §2: Lead watermark for the scope pass (see ReconcileDeps). */
  leadWatermark?: ReconcileDeps['leadWatermark'];
  /** Sync completion §7: recorded on every heartbeat of this run. */
  trigger?: RunTrigger;
  budgetMs?: number;
  batchLimit?: number;
  now?: () => number;
}

export interface ResyncProgress {
  jobId: string;
  /** Deals listed so far / Bitrix total from the first page. */
  scanned: number;
  bitrixTotal: number | null;
  pages: number;
  listingDone: boolean;
  /** Set when the job completed in this run. */
  result: ResyncResult | null;
  /** Inbox rows still open when completion was attempted. */
  waiting: number | null;
  /** Deals listed in this run whose Bitrix LEAD_ID is set (counts only). */
  withLeadId: number;
  /** Stored Deals re-queued to fill or correct their Lead link. */
  leadLinkRequeued: number;
}

export interface SyncSummary {
  resync: ResyncProgress | null;
  reconcile: ReconcileSummary | null;
  /** Set when the pull step failed; the worker step was skipped. */
  reconcileError: IntakeErrorCode | null;
  batches: number;
  worker: WorkerRunSummary;
  released: number;
  /** Stopped because the time budget ran out (more work may remain). */
  budgetReached: boolean;
  outcome: RunOutcome;
}

function errorCodeOf(error: unknown): IntakeErrorCode {
  return error instanceof BitrixClientError ? error.code : 'internal_error';
}

function pullFailure(error: unknown): RunOutcome {
  return error instanceof BitrixClientError && error.code !== 'internal_error' ? 'provider_error' : 'internal_error';
}

export async function runBitrixSync(deps: SyncDeps): Promise<SyncSummary> {
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.budgetMs ?? SYNC_BUDGET_MS);
  const worker = emptySummary();
  const result: SyncSummary = {
    resync: null,
    reconcile: null,
    reconcileError: null,
    batches: 0,
    worker,
    released: 0,
    budgetReached: false,
    outcome: 'ok',
  };

  let job: Awaited<ReturnType<typeof runResyncListing>>['job'] = null;
  try {
    const step = await runResyncListing({
      rpc: deps.rpc,
      bitrix: deps.bitrix,
      config: deps.config,
      deadlineMs: deadline - RESYNC_RESERVE_MS,
      now,
    });
    job = step.job;
    if (job) {
      result.resync = {
        jobId: job.jobId,
        scanned: step.scanned,
        bitrixTotal: step.bitrixTotal,
        pages: step.pages,
        listingDone: step.listingDone,
        result: null,
        waiting: null,
        withLeadId: step.withLeadId,
        leadLinkRequeued: step.leadLinkRequeued,
      };
    }
    result.reconcile = await runReconcileWithHeartbeat(
      {
        rpc: deps.rpc,
        bitrix: deps.bitrix,
        config: deps.config,
        heldDealIds: deps.heldDealIds,
        activeManifestIds: deps.activeManifestIds,
        verifiedAt: deps.verifiedAt,
        leadWatermark: deps.leadWatermark,
        maxPages: SYNC_MAX_PAGES,
        now,
      },
      { trigger: deps.trigger },
    );
  } catch (error) {
    result.reconcileError = errorCodeOf(error);
    result.outcome = pullFailure(error);
    return result;
  }

  const limit = Math.min(Math.max(1, deps.batchLimit ?? WORKER_MAX_LIMIT), WORKER_MAX_LIMIT);
  let problems = false;
  for (;;) {
    const remaining = deadline - now();
    if (remaining < MIN_BATCH_MS) {
      result.budgetReached = true;
      break;
    }
    let stats;
    try {
      stats = await runWorkerWithHeartbeat(
        {
          rpc: deps.rpc,
          bitrix: deps.bitrix,
          config: deps.config,
          limit,
          deadlineMs: remaining,
          prefetch: true,
          now,
        },
        { trigger: deps.trigger },
      );
    } catch (error) {
      // Claim failed (database refusal or unavailable). Leases expire on their own.
      result.outcome = errorCodeOf(error) === 'internal_error' ? 'internal_error' : 'provider_error';
      return result;
    }
    result.batches += 1;
    for (const key of Object.keys(worker) as Array<keyof WorkerRunSummary>) worker[key] += stats.summary[key];
    result.released += stats.released;
    if (stats.outcome !== 'ok') problems = true;
    if (stats.deadlineReached) {
      result.budgetReached = true;
      break;
    }
    // Drained, or Bitrix pushed back (rate limit / outage): stop for this run.
    if (stats.summary.claimed < limit || stats.providerErrors > 0) break;
  }

  if (job && result.resync?.listingDone) {
    try {
      const finished = await finishResyncIfDrained(deps.rpc, job);
      if (finished.done) result.resync.result = finished.result;
      else result.resync.waiting = finished.waiting;
    } catch {
      problems = true;
    }
  }

  const resyncOpen = result.resync !== null && result.resync.result === null;
  if (result.reconcile?.truncated || result.budgetReached || problems || resyncOpen) result.outcome = 'partial';
  return result;
}
