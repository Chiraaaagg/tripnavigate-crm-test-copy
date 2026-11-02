import { finishResync, nextResyncJob, recordResyncPage, releaseResync, type ResyncJob, type ResyncResult, type RpcClient } from '../commands';
import type { IntakeConfig } from '../intake-config';
import type { BitrixClient } from './client';
import { toLeadIdText, toUnixSeconds } from './deal';

/**
 * Full Bitrix -> CRM resync (20261008000200), one bounded step per scheduled run.
 *
 * Lists Bitrix with exactly the job's filter (ticked pipelines, ticked stages,
 * DATE_CREATE on/after the sync date at 00:00 IST), paging by ID cursor
 * (>ID, order ID ASC) so it continues across runs from where it stopped and
 * never truncates. Each page is recorded in ONE command that enqueues every
 * deal through integration_enqueue_reconcile (dedupe, up-to-date check).
 * Once listing is done, finish() completes the job when the inbox has drained
 * and records Bitrix vs CRM counts. A lease (SKIP LOCKED) keeps two runs from
 * listing the same job at once; the database queues the daily job itself.
 */

export const RESYNC_LEASE_SECONDS = 120;
/** At most this many Bitrix pages (50 deals each) per run. */
export const RESYNC_MAX_PAGES_PER_RUN = 40;
/** Do not start another page with less time than this left. */
const MIN_PAGE_MS = 3_000;

export interface ResyncDeps {
  rpc: RpcClient;
  bitrix: Pick<BitrixClient, 'listDeals'>;
  config: IntakeConfig;
  deadlineMs: number;
  maxPages?: number;
  now?: () => number;
}

export interface ResyncStep {
  job: ResyncJob | null;
  pages: number;
  scanned: number;
  enqueued: number;
  listingDone: boolean;
  /** Bitrix `total` for the whole filter (first page of the job). */
  bitrixTotal: number | null;
  /** Listed Deals (this run) whose Bitrix LEAD_ID is set: counts only. */
  withLeadId: number;
  /** Stored Deals re-queued because their Lead link differs from Bitrix (20261113000100). */
  leadLinkRequeued: number;
}

export async function runResyncListing(deps: ResyncDeps): Promise<ResyncStep> {
  const now = deps.now ?? Date.now;
  const job = await nextResyncJob(deps.rpc, deps.config.portalMemberId, RESYNC_LEASE_SECONDS);
  const step: ResyncStep = {
    job,
    pages: 0,
    scanned: job?.scanned ?? 0,
    enqueued: 0,
    listingDone: job?.listingDone ?? false,
    bitrixTotal: job?.bitrixTotal ?? null,
    withLeadId: 0,
    leadLinkRequeued: 0,
  };
  if (!job) return step;

  let cursor = job.cursorId;
  const maxPages = deps.maxPages ?? RESYNC_MAX_PAGES_PER_RUN;
  try {
    while (!step.listingDone && step.pages < maxPages && deps.deadlineMs - now() >= MIN_PAGE_MS) {
      const page = await deps.bitrix.listDeals({
        filter: {
          '@CATEGORY_ID': job.categoryIds,
          '@STAGE_ID': job.stageIds,
          '>=DATE_CREATE': job.cutoffAt,
          '>ID': cursor,
        },
        // LEAD_ID lets the database re-read a stored Deal whose Lead link is missing or changed.
        select: ['ID', 'DATE_MODIFY', 'LEAD_ID'],
        start: 0,
      });
      const deals: Array<{ id: number; modified: number; leadId: string }> = [];
      for (const item of page.items) {
        const id = Number(item.ID);
        const modified = toUnixSeconds(item.DATE_MODIFY);
        if (Number.isSafeInteger(id) && id > cursor && modified !== null) {
          const leadId = toLeadIdText(item.LEAD_ID);
          if (leadId) step.withLeadId += 1;
          deals.push({ id, modified, leadId });
        }
      }
      const last = page.next === null || page.items.length === 0;
      if (cursor === 0 && step.bitrixTotal === null) step.bitrixTotal = page.total;
      const recorded = await recordResyncPage(deps.rpc, job, deals, page.total, last);
      step.pages += 1;
      step.scanned = recorded.scanned;
      step.enqueued += recorded.enqueued;
      step.leadLinkRequeued += recorded.leadLinkRequeued;
      step.listingDone = last;
      // Every listed ID moves the cursor, even one skipped as malformed.
      const maxListed = page.items.reduce((m, i) => Math.max(m, Number(i.ID) || 0), cursor);
      if (!last && maxListed <= cursor) break; // provider ignored the cursor: stop, retry next run
      cursor = Math.max(recorded.cursorId, maxListed);
    }
  } catch (error) {
    await releaseResync(deps.rpc, job).catch(() => undefined);
    throw error;
  }
  if (!step.listingDone) await releaseResync(deps.rpc, job).catch(() => undefined);
  return step;
}

/** After the worker drained the inbox: complete a fully listed job (or release it). */
export async function finishResyncIfDrained(
  rpc: RpcClient,
  job: Pick<ResyncJob, 'jobId' | 'lockToken'>,
): Promise<{ done: true; result: ResyncResult } | { done: false; waiting: number }> {
  try {
    return await finishResync(rpc, job);
  } catch (error) {
    await releaseResync(rpc, job).catch(() => undefined);
    throw error;
  }
}
