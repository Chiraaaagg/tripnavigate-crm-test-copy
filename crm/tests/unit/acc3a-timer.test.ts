import { describe, expect, it } from 'vitest';
import { TIMER_MAX_DURATION_SECONDS, TIMER_STEP_BUDGET_MS, TIMER_STEPS, type TimerRunResult, type TimerStep } from '@/modules/timer/contracts';
import { countsOf, errorCodeOf, runTimerSteps } from '@/modules/timer/jobs';
import { callTimerTick, handleTimerRequest } from '@/modules/timer/server/run';
import * as route from '@/app/api/integrations/timer/route';

/**
 * Accounts phase 3, track A's own unit checks for the timer (contract 5.2):
 * step isolation and budgets, counts-only results, the bearer check of the
 * route and the timer_tick result parsing. Track T's acc3-* suites are the
 * independent tests.
 */

const SECRET = 'x'.repeat(40);
const ok: TimerRunResult = { status: 'ok', steps: [] };

describe('timer steps', () => {
  it('step order and budgets fit the 55 s route', () => {
    expect(TIMER_STEPS).toEqual(['timer_tick', 'customer_messages', 'push', 'render']);
    const total = Object.values(TIMER_STEP_BUDGET_MS).reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(TIMER_MAX_DURATION_SECONDS * 1000);
    expect(route.maxDuration).toBe(TIMER_MAX_DURATION_SECONDS);
    expect(Object.keys(route).sort()).toEqual(['POST', 'maxDuration']);
  });

  it('a failing or slow step never stops the next; results keep counts and codes only', async () => {
    const order: string[] = [];
    const steps: TimerStep[] = [
      { name: 'timer_tick', run: async () => { order.push('tick'); throw Object.assign(new Error('Customer Pooja Test +916000000001'), { code: '22012' }); } },
      { name: 'customer_messages', run: async () => { order.push('messages'); throw new Error('secret text'); } },
      { name: 'push', run: (signal) => new Promise((resolve) => { order.push('push'); signal.addEventListener('abort', () => resolve({ late: 1 })); }) },
      { name: 'render', run: async () => { order.push('render'); return { claimed: 2, sent: 1, name: 'Pooja Test', amount: 1.5, nested: { n: 1 } }; } },
    ];
    const result = await runTimerSteps(steps, { budgets: { push: 20 } });
    expect(order).toEqual(['tick', 'messages', 'push', 'render']);
    expect(result.status).toBe('partial');
    expect(result.steps.map((s) => ({ step: s.step, status: s.status, counts: s.counts, errorCode: s.errorCode }))).toEqual([
      { step: 'timer_tick', status: 'failed', counts: {}, errorCode: '22012' },
      { step: 'customer_messages', status: 'failed', counts: {}, errorCode: 'unexpected' },
      { step: 'push', status: 'timeout', counts: {}, errorCode: 'timeout' },
      { step: 'render', status: 'ok', counts: { claimed: 2, sent: 1 }, errorCode: null },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Pooja Test|6000000001|secret text/);
  });

  it('null means skipped; all ok or skipped is ok', async () => {
    const result = await runTimerSteps([
      { name: 'timer_tick', run: async () => ({ ran: 3 }) },
      { name: 'render', run: async () => null },
    ]);
    expect(result.status).toBe('ok');
    expect(result.steps.map((s) => [s.step, s.status, s.counts])).toEqual([
      ['timer_tick', 'ok', { ran: 3 }],
      ['render', 'skipped', {}],
    ]);
  });

  it('countsOf and errorCodeOf keep only safe values', () => {
    expect(countsOf([1, 2])).toEqual({});
    expect(countsOf({ a: 1, 'bad key': 2, b: '3', c: Number.NaN, d: 2 ** 60 })).toEqual({ a: 1 });
    expect(errorCodeOf({ code: 'not_authorized' })).toBe('not_authorized');
    expect(errorCodeOf({ code: 'has space' })).toBe('unexpected');
    expect(errorCodeOf('boom')).toBe('unexpected');
  });
});

describe('timer route', () => {
  const post = (auth?: string) =>
    new Request('http://127.0.0.1/api/integrations/timer', { method: 'POST', headers: auth ? { authorization: auth } : {} });

  it('503 when the secret is missing or short, without running anything', async () => {
    let ran = 0;
    const run = async () => { ran += 1; return ok; };
    for (const secret of [undefined, '', 'short-secret']) {
      const res = await handleTimerRequest(post(`Bearer ${SECRET}`), { secret, run });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: 'not_configured' });
    }
    expect(ran).toBe(0);
  });

  it('401 on a missing, malformed or wrong bearer; 200 with counts on the right one', async () => {
    let ran = 0;
    const run = async (): Promise<TimerRunResult> => { ran += 1; return { status: 'ok', steps: [{ step: 'timer_tick', status: 'ok', counts: { ran: 1 }, errorCode: null, ms: 3 }] }; };
    for (const auth of [undefined, SECRET, `Basic ${SECRET}`, `Bearer ${SECRET}x`, `Bearer ${'y'.repeat(40)}`]) {
      const res = await handleTimerRequest(post(auth), { secret: SECRET, run });
      expect(res.status).toBe(401);
    }
    expect(ran).toBe(0);
    const res = await handleTimerRequest(post(`Bearer ${SECRET}`), { secret: SECRET, run });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.text();
    expect(JSON.parse(body)).toMatchObject({ status: 'ok', steps: [{ step: 'timer_tick', counts: { ran: 1 } }] });
    expect(body).not.toContain(SECRET);
    expect(ran).toBe(1);
  });
});

describe('timer_tick result', () => {
  const rpc = (data: unknown, error: { code?: string } | null = null) => ({
    rpc: async (fn: string) => {
      expect(fn).toBe('timer_tick');
      return { data, error };
    },
  });

  it('parses ok and busy; maps errors and unexpected shapes to codes', async () => {
    const data = { status: 'ok', ran: 2, failed: 1, pruned: 0, tasks: { timer_health: { alerts: 0 }, tst_bad: { errorCode: '22012' } } };
    expect(await callTimerTick(rpc(data))).toEqual(data);
    expect(await callTimerTick(rpc({ status: 'busy' }))).toEqual({ status: 'busy' });
    await expect(callTimerTick(rpc(null, { code: '42501' }))).rejects.toMatchObject({ code: '42501' });
    await expect(callTimerTick(rpc(null, { code: 'weird code!' }))).rejects.toMatchObject({ code: 'rpc_error' });
    await expect(callTimerTick(rpc({ status: 'ok', ran: 1, name: 'Pooja Test' }))).rejects.toMatchObject({ code: 'bad_response' });
  });
});
