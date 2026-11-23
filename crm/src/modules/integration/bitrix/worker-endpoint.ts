import 'server-only';
import { intakeRuntimeRefusal, type IntegrationEnv } from '@/lib/config';
import { IntakeCommandError, loadActiveManifest, type RpcClient, type RunTrigger } from '../commands';
import type { SourceObject } from '../contracts';
import { selectActiveConfig, type IntakeConfig } from '../intake-config';
import { runSyncAlerts, type SyncAlertDeps } from '../sync-alerts';
import { checkBearer } from './auth';
import { createBitrixClient, type BitrixClient } from './client';
import { BitrixConfigError, MIN_WORKER_SECRET_LENGTH, resolveBitrixRestTarget } from './config';
import { runBitrixNameRefresh, type NameRefreshResult } from './name-refresh';
import { json } from './receiver';
import type { LeadWatermarkStore } from './reconcile';
import { runReconcileWithHeartbeat, runWorkerWithHeartbeat } from './runs';
import { runBitrixSync } from './sync';

/**
 * /api/integrations/bitrix/worker, two triggers with separate secrets:
 *   POST  Authorization: Bearer INTAKE_WORKER_SECRET  (manual run, or pg_cron + pg_net)
 *   GET   Authorization: Bearer CRON_SECRET           (Vercel Cron on Production;
 *         Vercel sends GET with this header when CRON_SECRET is set)
 * Both (constant-time bearer check):
 *   ?limit=1..25        one bounded batch, run synchronously; returns WorkerRunSummary
 *   ?task=reconcile     missed-event reconciliation instead; returns ReconcileSummary
 *   ?task=sync          pull changes + drain the inbox within ~45 s (runBitrixSync);
 *                       what the Supabase pg_cron job calls every 30 s. B1.2
 *                       DEC-43: afterwards, ONLY when the config's switch
 *                       bitrix_id_proof_copy is on, at most one ID-proof copy
 *                       job runs within the remaining time (idProofCopy); its
 *                       outcome is added to the answer as codes and never
 *                       changes the sync's status. Switch off: no extra call
 *                       and the same answer as before. Batch 1 B1-1: then,
 *                       ONLY when the switch bitrix_name_read is on and time
 *                       is left, the daily read of Bitrix stage, status and
 *                       source names (bitrixNames, codes and counts only;
 *                       read-only crm.status.list; never changes the sync's
 *                       status). Switch off: no extra call, same answer.
 *   ?task=health        sync-stopped alert check only (sync completion §4): opens or
 *                       closes incidents, sends the pending emails, marks them sent;
 *                       returns counts only. Needs no Bitrix configuration.
 * After every answer past authentication and the environment gate (any run
 * result, and configuration failures too) the same alert check is scheduled with `schedule` (Next.js after() in production), so the
 * run's answer never waits for or depends on it.
 *
 * Runs only with APP_ENV=local, or APP_ENV=production on VERCEL_ENV=production
 * (intakeRuntimeRefusal); a Preview build answers 503 even if it holds secrets.
 * 401 bad/missing bearer; 503 not configured; 500 unexpected failure (code only).
 */

export type WorkerTrigger = 'manual' | 'cron';

export interface WorkerEndpointDeps {
  env: IntegrationEnv;
  appEnv: string | undefined;
  /** VERCEL_ENV of this deployment (undefined off Vercel). */
  vercelEnv?: string | undefined;
  /** POST = 'manual' (INTAKE_WORKER_SECRET), GET = 'cron' (CRON_SECRET). Default 'manual'. */
  trigger?: WorkerTrigger;
  loadConfigRows: () => Promise<unknown[]>;
  rpc: () => RpcClient;
  /** Which source deal IDs CRM already holds for the portal (reconcile update pass). */
  heldDealIds?: (memberId: string, ids: number[]) => Promise<Set<number>>;
  /** Phase 6: last_verified_at of manifest records CRM holds (bounded reconcile order). */
  manifestVerifiedAt?: (memberId: string, sourceObject: SourceObject, ids: string[]) => Promise<Map<string, number>>;
  /** Sync completion §2: Lead watermark for the Lead scope pass (omitted = pass skipped). */
  leadWatermark?: (memberId: string) => LeadWatermarkStore;

  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Sync time budget override (tests). */
  syncBudgetMs?: number;
  /**
   * Runs work after the response (Next.js after()). Omitted: the post-run alert
   * check is awaited before answering (tests, scripts).
   */
  schedule?: (task: () => Promise<void>) => void;
  /** Alert sender overrides (tests): environment, fetch for Resend, log sink. */
  alerts?: Omit<SyncAlertDeps, 'rpc'>;
  /**
   * B1.2 DEC-43: one ID-proof copy job after a sync run (runIdProofCopyBatch
   * with limit 1 and the in-worker timeouts). Called only when the config's
   * switch is on and enough time is left. Omitted = never.
   */
  idProofCopy?: (config: IntakeConfig) => Promise<IdProofCopyResult>;
  /** Time the whole invocation may use (route maxDuration minus a margin). Default 85 s. */
  invocationBudgetMs?: number;
}

/** Codes and counts only (never ids of people, file names or values). */
export type IdProofCopyResult =
  | { status: 'ran'; claimed: number; sent: number; retried: number; failed: number; unknown: number; stopped: boolean; errors: string[] }
  | { status: 'not_configured'; code: string };

export type IdProofCopyAnswer = IdProofCopyResult | { status: 'skipped'; code: 'not_enough_time' } | { status: 'error'; code: 'copy_failed' };

/** Route maxDuration (90 s) minus a 5 s margin. */
export const WORKER_INVOCATION_BUDGET_MS = 85_000;
/**
 * Worst case of one copy job: the in-worker timeouts (download 10 s, read
 * 10 s, write 20 s, read-back 10 s, file check 10 s over both links) plus
 * database calls. A run cut short after the write is still safe: the job was
 * marked unknown before the call and is resolved by read-back.
 */
export const ID_PROOF_COPY_WORST_CASE_MS = 60_000;
/**
 * Review E11-2: time kept free after the copy for the sync-stopped alert
 * check, which runs after the answer (after()) inside the same invocation.
 */
export const ALERT_CHECK_MARGIN_MS = 15_000;
/** A copy job starts only with this much of the invocation budget left. */
export const ID_PROOF_COPY_MIN_REMAINING_MS = ID_PROOF_COPY_WORST_CASE_MS + ALERT_CHECK_MARGIN_MS;
/**
 * Batch 1 B1-1: the name read starts only with this much left; it starts no
 * new Bitrix read after the deadline (budget minus the alert margin), and a
 * list cut short is not applied.
 */
export const NAME_REFRESH_MIN_REMAINING_MS = 10_000 + ALERT_CHECK_MARGIN_MS;

export type BitrixNamesAnswer = NameRefreshResult | { status: 'skipped'; code: 'not_enough_time' };

export async function handleWorkerRequest(request: Request, deps: WorkerEndpointDeps): Promise<Response> {
  const startedAt = (deps.now ?? Date.now)();
  const trigger = deps.trigger ?? 'manual';
  const secret = trigger === 'cron' ? deps.env.cronSecret : deps.env.intakeWorkerSecret;
  if (!secret || secret.length < MIN_WORKER_SECRET_LENGTH) return json(503, { error: 'not_configured' });
  if (!checkBearer(request.headers.get('authorization'), secret)) return json(401, { error: 'unauthorized' });
  // Environment gate after authentication, before any database or provider call.
  if (intakeRuntimeRefusal(deps.appEnv, deps.vercelEnv, deps.env) !== null) return json(503, { error: 'not_configured' });

  const url = new URL(request.url);
  const task = url.searchParams.get('task') ?? 'batch';
  if (task !== 'batch' && task !== 'reconcile' && task !== 'sync' && task !== 'health') {
    return json(400, { error: 'invalid_request' });
  }

  // Sync completion §4: the alert check needs only the database, so a broken Bitrix
  // configuration (often the reason the sync stopped) does not block it.
  if (task === 'health') {
    try {
      const summary = await runSyncAlerts({ ...deps.alerts, rpc: deps.rpc() });
      return json(summary.checkFailed ? 503 : 200, { ...summary });
    } catch {
      return json(503, { error: 'unavailable' });
    }
  }

  // Every answer past authentication and the environment gate is followed by
  // the sync-stopped alert check, including configuration failures (§4).
  const response = await prepareAndRun(deps, task, url, startedAt);
  await afterRun(deps);
  return response;
}

/**
 * Heartbeat trigger (§7): GET is Vercel Cron; POST ?task=sync is the Supabase
 * pg_cron job's call; any other POST is an operator's manual run.
 */
export function runTriggerFor(endpointTrigger: WorkerTrigger, task: string): RunTrigger {
  if (endpointTrigger === 'cron' || task === 'sync') return 'cron';
  return 'manual';
}

async function prepareAndRun(deps: WorkerEndpointDeps, task: 'batch' | 'reconcile' | 'sync', url: URL, startedAt: number): Promise<Response> {
  let rows: unknown[];
  try {
    rows = await deps.loadConfigRows();
  } catch {
    return json(503, { error: 'unavailable' });
  }
  const active = selectActiveConfig(rows);
  if (!active.config) return json(503, { error: 'not_configured' });

  let bitrix;
  try {
    const target = resolveBitrixRestTarget(deps.env.bitrixWebhookBaseUrl, active.config.portalDomain, deps.appEnv);
    bitrix = createBitrixClient({ target, fetchImpl: deps.fetchImpl });
  } catch (error) {
    if (error instanceof BitrixConfigError) return json(503, { error: 'not_configured' });
    return json(500, { error: 'internal_error' });
  }
  return runTask(deps, task, url, active.config, bitrix, startedAt);
}

/**
 * B1.2 DEC-43: at most one ID-proof copy job after the sync. null (nothing
 * added to the answer, no call made) when the switch is off or no copy runner
 * is wired. Never throws: a copy failure never fails the sync run.
 */
async function maybeCopyIdProof(deps: WorkerEndpointDeps, config: IntakeConfig, startedAt: number): Promise<IdProofCopyAnswer | null> {
  if (config.idProofCopy !== true || !deps.idProofCopy) return null;
  const now = deps.now ?? Date.now;
  const remaining = (deps.invocationBudgetMs ?? WORKER_INVOCATION_BUDGET_MS) - (now() - startedAt);
  if (remaining < ID_PROOF_COPY_MIN_REMAINING_MS) return { status: 'skipped', code: 'not_enough_time' };
  try {
    return await deps.idProofCopy(config);
  } catch {
    return { status: 'error', code: 'copy_failed' };
  }
}

/**
 * Batch 1 B1-1: the daily name read after the sync (and after the copy).
 * null (nothing added, no call made) while the switch is off. Never throws.
 */
async function maybeRefreshNames(
  deps: WorkerEndpointDeps,
  config: IntakeConfig,
  bitrix: BitrixClient,
  startedAt: number,
): Promise<BitrixNamesAnswer | null> {
  // Voice-note batch: the destination option names follow the trip details switch.
  if (config.bitrixNameRead !== true && config.tripDetailsRead !== true) return null;
  const now = deps.now ?? Date.now;
  const budget = deps.invocationBudgetMs ?? WORKER_INVOCATION_BUDGET_MS;
  if (budget - (now() - startedAt) < NAME_REFRESH_MIN_REMAINING_MS) return { status: 'skipped', code: 'not_enough_time' };
  try {
    return await runBitrixNameRefresh({ rpc: deps.rpc(), bitrix, config, now, deadline: startedAt + budget - ALERT_CHECK_MARGIN_MS });
  } catch {
    return { status: 'error', code: 'apply_failed' };
  }
}

/** One batch, reconcile or sync run; failures become fixed-code answers. */
async function runTask(
  deps: WorkerEndpointDeps,
  task: 'batch' | 'reconcile' | 'sync',
  url: URL,
  config: IntakeConfig,
  bitrix: BitrixClient,
  startedAt: number,
): Promise<Response> {
  const trigger = runTriggerFor(deps.trigger ?? 'manual', task);
  const leadWatermark = deps.leadWatermark?.(config.portalMemberId);
  try {
    const held = deps.heldDealIds;
    if (task === 'sync') {
      const rpc = deps.rpc();
      const summary = await runBitrixSync({
        rpc,
        bitrix,
        config,
        heldDealIds: held ? (ids) => held(config.portalMemberId, ids) : undefined,
        // Phase 6: the sync's reconcile pass is manifest-scoped like ?task=reconcile.
        verifiedAt: deps.manifestVerifiedAt
          ? (object, ids) => deps.manifestVerifiedAt!(config.portalMemberId, object, ids)
          : undefined,
        activeManifestIds: async (object) => (await loadActiveManifest(rpc, config.portalMemberId, object))?.ids ?? null,
        leadWatermark,
        budgetMs: deps.syncBudgetMs,
        now: deps.now,
        trigger,
      });
      // B1.2 DEC-43: one copy job after the sync work (switch on only).
      const copy = await maybeCopyIdProof(deps, config, startedAt);
      // Batch 1 B1-1: the daily name read (switch on only).
      const names = await maybeRefreshNames(deps, config, bitrix, startedAt);
      // Counts and codes only; a pull failure is a 503 so schedulers see it.
      return json(summary.reconcileError ? 503 : 200, {
        ...summary,
        ...(copy ? { idProofCopy: copy } : {}),
        ...(names ? { bitrixNames: names } : {}),
      });
    }
    if (task === 'reconcile') {
      const rpc = deps.rpc();
      const summary = await runReconcileWithHeartbeat(
        {
          rpc,
          bitrix,
          config,
          heldDealIds: held ? (ids) => held(config.portalMemberId, ids) : undefined,
          verifiedAt: deps.manifestVerifiedAt
            ? (object, ids) => deps.manifestVerifiedAt!(config.portalMemberId, object, ids)
            : undefined,
          activeManifestIds: async (object) => (await loadActiveManifest(rpc, config.portalMemberId, object))?.ids ?? null,
          leadWatermark,
          now: deps.now,
        },
        { trigger },
      );
      return json(200, { ...summary });
    }
    const stats = await runWorkerWithHeartbeat(
      {
        rpc: deps.rpc(),
        bitrix,
        config,
        limit: Number(url.searchParams.get('limit') ?? NaN),
        now: deps.now,
      },
      { trigger },
    );
    return json(200, { ...stats.summary });
  } catch (error) {
    if (error instanceof IntakeCommandError && error.refusal) return json(503, { error: 'not_configured' });
    if (error instanceof Error && error.name === 'BitrixClientError') {
      return json(503, { error: (error as { code?: string }).code ?? 'provider_unavailable' });
    }
    return json(500, { error: 'internal_error' });
  }
}

/** Post-run alert check (§4): scheduled after the response when possible; never throws. */
async function afterRun(deps: WorkerEndpointDeps): Promise<void> {
  const check = async () => {
    try {
      await runSyncAlerts({ ...deps.alerts, rpc: deps.rpc() });
    } catch {
      // runSyncAlerts does not throw; creating the client might. The next run checks again.
    }
  };
  if (deps.schedule) {
    try {
      deps.schedule(check);
      return;
    } catch {
      // Scheduling unavailable: fall through and check inline.
    }
  }
  await check();
}
