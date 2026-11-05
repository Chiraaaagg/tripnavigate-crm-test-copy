import {
  IntakeCommandError,
  recordWorkerRun,
  type RpcClient,
  type RunOutcome,
  type RunTrigger,
  type WorkerRunRecord,
} from '../commands';
import { BitrixClientError } from './client';
import { reconcileEligibleDeals, type ReconcileDeps, type ReconcileSummary } from './reconcile';
import { runInboxBatch, type WorkerDeps, type WorkerRunStats } from './worker';

/**
 * Worker / reconcile runs with a durable heartbeat (contract §12 M2): every run
 * that got past configuration writes one integration_worker_runs row (counts and
 * outcome only). The heartbeat write is best effort: its failure never changes
 * the run's result, and errors are never logged with provider text.
 */

type Counts = Omit<WorkerRunRecord, 'kind' | 'startedAt' | 'finishedAt' | 'outcome' | 'trigger'>;

async function heartbeat(
  rpc: RpcClient,
  kind: 'worker' | 'reconcile',
  startedAt: string,
  now: () => number,
  outcome: RunOutcome,
  counts: Counts,
  trigger?: RunTrigger,
): Promise<void> {
  const run: WorkerRunRecord = { kind, startedAt, finishedAt: new Date(now()).toISOString(), outcome, ...counts };
  try {
    await recordWorkerRun(rpc, trigger ? { ...run, trigger } : run);
  } catch (error) {
    // A database that does not yet accept the trigger key refuses the row as an
    // invalid argument (22023); the run is still recorded, without the trigger.
    if (trigger && error instanceof IntakeCommandError && error.sqlState === '22023') {
      await recordWorkerRun(rpc, run).catch(() => undefined);
    }
  }
}

function failureOutcome(error: unknown): RunOutcome {
  return error instanceof BitrixClientError && error.code !== 'internal_error' ? 'provider_error' : 'internal_error';
}

/** `trigger` is recorded on the heartbeat ('event' = live run scheduled by the receiver, §1). */
export async function runWorkerWithHeartbeat(deps: WorkerDeps, options: { trigger?: RunTrigger } = {}): Promise<WorkerRunStats> {
  const now = deps.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  try {
    const stats = await runInboxBatch(deps);
    await heartbeat(deps.rpc, 'worker', startedAt, now, stats.outcome, { ...stats.summary }, options.trigger);
    return stats;
  } catch (error) {
    await heartbeat(deps.rpc, 'worker', startedAt, now, failureOutcome(error), {}, options.trigger);
    throw error;
  }
}

export async function runReconcileWithHeartbeat(
  deps: ReconcileDeps,
  options: { trigger?: RunTrigger } = {},
): Promise<ReconcileSummary> {
  const now = deps.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  try {
    const summary = await reconcileEligibleDeals(deps);
    await heartbeat(
      deps.rpc,
      'reconcile',
      startedAt,
      now,
      summary.truncated ? 'partial' : 'ok',
      { enqueued: summary.enqueued },
      options.trigger,
    );
    return summary;
  } catch (error) {
    await heartbeat(deps.rpc, 'reconcile', startedAt, now, failureOutcome(error), {}, options.trigger);
    throw error;
  }
}
