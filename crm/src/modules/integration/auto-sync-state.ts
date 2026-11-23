import type { AutoSyncView } from './contracts';

/** pg_cron calls the CRM every 30 seconds (20261006000100). */
export const SYNC_INTERVAL_SECONDS = 30;
/** No successful run for more than this many intervals = stopped. */
export const STOPPED_AFTER_INTERVALS = 3;

export type AutoSyncState =
  | { kind: 'running'; lastRunSecondsAgo: number }
  | { kind: 'paused' }
  | { kind: 'stopped'; since: string | null; reason: string }
  | { kind: 'unknown' };

/**
 * Plain status of the automatic sync for the admin page. Stopped means no
 * successful sync run (any trigger) for more than 3 intervals while the
 * switch is on. The reason comes from the cron job state or the last
 * scheduler call (integration_sync_dispatches), in that order.
 */
export function autoSyncState(view: AutoSyncView | null | undefined, nowMs: number): AutoSyncState {
  if (!view) return { kind: 'unknown' };
  if (view.enabled === false) return { kind: 'paused' };
  const last = view.lastSuccessAt ? Date.parse(view.lastSuccessAt) : NaN;
  const ago = Number.isNaN(last) ? Infinity : Math.max(0, Math.round((nowMs - last) / 1000));
  if (ago <= SYNC_INTERVAL_SECONDS * STOPPED_AFTER_INTERVALS && view.cronInstalled && view.jobActive) {
    return { kind: 'running', lastRunSecondsAgo: ago };
  }
  const since = view.lastSuccessAt ?? view.failingSince;
  if (!view.cronInstalled) {
    return {
      kind: 'stopped',
      since,
      reason: 'The scheduler job ("bitrix-sync") is missing from the database. An administrator with database access needs to restore it.',
    };
  }
  if (!view.jobActive) {
    return {
      kind: 'stopped',
      since,
      reason: 'The scheduler job is switched off in the database. An administrator with database access needs to switch it back on.',
    };
  }
  const failed = view.lastCalls.find((c) => c.ok === false);
  const answered = view.lastCalls.find((c) => c.ok !== null);
  if (answered && answered.ok === false && failed?.reason) return { kind: 'stopped', since, reason: failed.reason };
  if (view.lastCalls.length === 0) {
    return {
      kind: 'stopped',
      since,
      reason: 'The scheduler has not called the CRM recently. Check the CRM address and worker secret the scheduler uses.',
    };
  }
  if (answered?.ok) {
    return { kind: 'stopped', since, reason: 'The CRM answered the scheduler, but the sync did not complete (Bitrix could not be read); see "Needs attention".' };
  }
  return { kind: 'stopped', since, reason: 'Waiting for the CRM to answer the scheduler.' };
}

export interface RunProblems24h {
  /** Worker and reconcile runs that ended provider_error or internal_error. */
  failedRuns: number;
  /** Runs that finished only part of their work (more is retried by the next run). */
  partialRuns: number;
  itemsFailed: number;
  itemsDeadLettered: number;
  lastFailedAt: string | null;
}

/**
 * Problems of the last 24 hours from the heartbeat counts (sync reliability,
 * 9 October 2026). The page never reports a clean sync while runs fail: the
 * "running" line is about the scheduler, this is about what the runs did.
 * Null = the database did not give the counts (older version), so nothing is claimed.
 */
export function runProblems24h(view: AutoSyncView | null | undefined): RunProblems24h | null {
  const runs = view?.runs24h;
  if (!runs) return null;
  return {
    failedRuns:
      runs.worker.providerError + runs.worker.internalError + runs.reconcile.providerError + runs.reconcile.internalError,
    partialRuns: runs.worker.partial + runs.reconcile.partial,
    itemsFailed: runs.itemsFailed,
    itemsDeadLettered: runs.itemsDeadLettered,
    lastFailedAt: runs.lastFailedAt,
  };
}
