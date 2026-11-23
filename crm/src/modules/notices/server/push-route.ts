import 'server-only';
import { checkBearer } from '@/modules/integration/bitrix/auth';
import { MIN_TIMER_SECRET_LENGTH } from '@/modules/timer/contracts';
import { dispatchPush, type PushDispatchCounts } from './push-dispatch';

/**
 * POST /api/integrations/push (8.4). Bearer TIMER_SECRET, constant-time
 * compare, before anything else. Runs dispatchPush(), waits a few seconds and
 * runs it once more, so a job whose kick was skipped by the 5-second limit
 * still leaves within seconds. Counts only.
 */

export interface PushRouteDeps {
  secret: string | undefined;
  dispatch(): Promise<PushDispatchCounts | null>;
  wait(ms: number): Promise<void>;
}

export const SECOND_PASS_DELAY_MS = 6_000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function add(a: PushDispatchCounts | null, b: PushDispatchCounts | null): PushDispatchCounts | null {
  if (!a) return b;
  if (!b) return a;
  return { claimed: a.claimed + b.claimed, sent: a.sent + b.sent, failed: a.failed + b.failed, gone: a.gone + b.gone };
}

export async function handlePushRequest(request: Request, deps: PushRouteDeps): Promise<Response> {
  const secret = deps.secret ?? '';
  if (secret.length < MIN_TIMER_SECRET_LENGTH) return json(503, { status: 'not_configured' });
  if (!checkBearer(request.headers.get('authorization'), secret)) return json(401, { status: 'unauthorized' });
  let total: PushDispatchCounts | null = null;
  try {
    const first = await deps.dispatch();
    if (first === null) return json(200, { status: 'skipped' });
    total = first;
    await deps.wait(SECOND_PASS_DELAY_MS);
    total = add(total, await deps.dispatch());
  } catch {
    return json(200, { status: 'failed', ...(total ?? {}) });
  }
  return json(200, { status: 'ok', ...(total ?? {}) });
}

export function productionPushRouteDeps(): PushRouteDeps {
  return {
    secret: process.env.TIMER_SECRET,
    dispatch: () => dispatchPush(),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
