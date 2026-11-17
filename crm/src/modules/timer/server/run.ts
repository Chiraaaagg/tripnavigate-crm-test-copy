import 'server-only';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { asRpcClient, type RpcClient } from '@/modules/fulfilment/commands';
import { dispatchCustomerMessages } from '@/modules/customer-messages/server/dispatch';
import { dispatchPush } from '@/modules/notices/server/push-dispatch';
import { renderOneQueuedJob } from '@/modules/documents/server/render-online';
import { checkBearer } from '@/modules/integration/bitrix/auth';
import {
  MIN_TIMER_SECRET_LENGTH,
  type TimerRunResult,
  type TimerStep,
  type TimerTickResult,
  timerTickResultSchema,
} from '../contracts';
import { runTimerSteps } from '../jobs';

/**
 * Timer route and local script (contract 5.2). Machine-only: the route checks
 * `Authorization: Bearer TIMER_SECRET` (constant time) before anything else;
 * staff sessions cannot call it (it is outside the staff proxy and has no
 * session path), and public.timer_tick() is executable by service_role only.
 */

export class TimerTickError extends Error {
  override name = 'TimerTickError';
  constructor(readonly code: string) {
    super(`timer_tick failed: ${code}`);
  }
}

/** Step 1: public.timer_tick() under the service role. */
export async function callTimerTick(rpc: RpcClient): Promise<TimerTickResult> {
  const { data, error } = await rpc.rpc('timer_tick');
  if (error) throw new TimerTickError(error.code && /^[A-Za-z0-9_]{1,40}$/.test(error.code) ? error.code : 'rpc_error');
  const parsed = timerTickResultSchema.safeParse(data);
  if (!parsed.success) throw new TimerTickError('bad_response');
  return parsed.data;
}

/** Counts of a tick for the response: ran, failed, pruned (busy = skipped). */
function tickCounts(result: TimerTickResult): Record<string, number> | null {
  if (result.status === 'busy') return null;
  return { ran: result.ran, failed: result.failed, pruned: result.pruned };
}

/**
 * The production steps, in contract order. Step 3 sends closed-browser alerts
 * (track D, @/modules/notices/server/push-dispatch, 8.4).
 * Step 4 renders at most one queued PDF job; it returns null (skipped) while
 * PDF_RENDER_ONLINE is not "on" (track B, 6.4).
 */
export function productionTimerSteps(): TimerStep[] {
  return [
    {
      name: 'timer_tick',
      run: async () => tickCounts(await callTimerTick(asRpcClient(createSupabaseAdminClient()))),
    },
    {
      name: 'customer_messages',
      run: async (signal) => dispatchCustomerMessages(undefined, signal),
    },
    // Contract 5.2 step 3 / 8.4: closed-browser alerts. Returns null (skipped)
    // until the push keys are saved.
    {
      name: 'push',
      run: async () => {
        const counts = await dispatchPush();
        return counts ? { ...counts } : null;
      },
    },
    {
      name: 'render',
      run: async () => renderOneQueuedJob(),
    },
  ];
}

export async function runTimerOnce(steps: readonly TimerStep[] = productionTimerSteps()): Promise<TimerRunResult> {
  return runTimerSteps(steps);
}

export interface TimerRequestDeps {
  /** TIMER_SECRET (read at call time; never logged or returned). */
  secret: string | undefined;
  run(): Promise<TimerRunResult>;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** POST /api/integrations/timer. 503 when the secret is not configured, 401 on a bad bearer. */
export async function handleTimerRequest(request: Request, deps: TimerRequestDeps): Promise<Response> {
  const secret = deps.secret ?? '';
  if (secret.length < MIN_TIMER_SECRET_LENGTH) return json(503, { status: 'not_configured' });
  if (!checkBearer(request.headers.get('authorization'), secret)) return json(401, { status: 'unauthorized' });
  const result = await deps.run();
  return json(200, result);
}

export function productionTimerDeps(): TimerRequestDeps {
  return { secret: process.env.TIMER_SECRET, run: () => runTimerOnce() };
}
