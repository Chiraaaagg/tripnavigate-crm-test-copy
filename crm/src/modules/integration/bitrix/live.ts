import type { IntegrationEnv } from '@/lib/config';
import { intakeRuntimeRefusal } from '@/lib/config';
import type { RecordedEvent, RpcClient } from '../commands';
import type { InboxStatus } from '../contracts';
import type { IntakeConfig } from '../intake-config';
import { createBitrixClient, type BitrixClient } from './client';
import { resolveBitrixRestTarget } from './config';
import { runWorkerWithHeartbeat } from './runs';
import type { WorkerRunStats } from './worker';

/**
 * Live processing of push events (sync completion §1). After the receiver has
 * recorded an event and is about to answer 200, a pending inbox row gets one
 * bounded batch scheduled with Next.js `after()`: the same worker code as the
 * scheduled run (claim with lease and SKIP LOCKED, read Bitrix, apply), at most
 * LIVE_BATCH_LIMIT items, heartbeat trigger 'event'.
 *
 * The batch never changes the receiver's response: it runs after the response,
 * and every error is swallowed here (the heartbeat has already recorded the
 * failed run). Nothing is logged with provider or customer text.
 */

export const LIVE_BATCH_LIMIT = 5;
/** Well inside the events route's maxDuration (60 s). */
export const LIVE_BATCH_DEADLINE_MS = 30_000;

/**
 * Whether a recorded event should trigger a live batch. With `status` from the
 * database the answer is exact ('pending' only). Without it (a database that
 * does not return the status yet) the answer is 'unknown': the caller looks the
 * row up after the response before running anything.
 */
export function liveBatchDecision(recorded: Pick<RecordedEvent, 'status'>): 'run' | 'skip' | 'unknown' {
  if (recorded.status === undefined) return 'unknown';
  return recorded.status === 'pending' ? 'run' : 'skip';
}

export interface LiveBatchDeps {
  env: IntegrationEnv;
  appEnv: string | undefined;
  vercelEnv: string | undefined;
  config: IntakeConfig;
  recorded: RecordedEvent;
  rpc: () => RpcClient;
  /** Status of one inbox row (service role); used only when the record result has none. */
  inboxStatus?: (inboxId: string) => Promise<InboxStatus | null>;
  /** Test seam for the Bitrix client. */
  bitrix?: Pick<BitrixClient, 'getDeal' | 'getLead' | 'listDeals'>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export type LiveBatchResult =
  | { ran: true; stats: WorkerRunStats }
  | { ran: false; reason: 'not_pending' | 'not_configured' | 'failed' };

/** Runs the live batch; never throws. */
export async function runLiveBatch(deps: LiveBatchDeps): Promise<LiveBatchResult> {
  try {
    // Same environment gate as the worker endpoint: a Preview or unknown runtime never processes.
    if (intakeRuntimeRefusal(deps.appEnv, deps.vercelEnv, deps.env) !== null) return { ran: false, reason: 'not_configured' };
    let decision = liveBatchDecision(deps.recorded);
    if (decision === 'unknown') {
      const status = deps.inboxStatus ? await deps.inboxStatus(deps.recorded.inboxId) : null;
      decision = status === 'pending' ? 'run' : 'skip';
    }
    if (decision !== 'run') return { ran: false, reason: 'not_pending' };

    let bitrix = deps.bitrix;
    if (!bitrix) {
      try {
        const target = resolveBitrixRestTarget(deps.env.bitrixWebhookBaseUrl, deps.config.portalDomain, deps.appEnv);
        bitrix = createBitrixClient({ target, fetchImpl: deps.fetchImpl });
      } catch {
        return { ran: false, reason: 'not_configured' };
      }
    }
    const stats = await runWorkerWithHeartbeat(
      {
        rpc: deps.rpc(),
        bitrix,
        config: deps.config,
        prefetch: true,
        limit: LIVE_BATCH_LIMIT,
        deadlineMs: LIVE_BATCH_DEADLINE_MS,
        now: deps.now,
      },
      { trigger: 'event' },
    );
    return { ran: true, stats };
  } catch {
    // Recorded as a failed worker run by the heartbeat; leased rows are retried by the next run.
    return { ran: false, reason: 'failed' };
  }
}
