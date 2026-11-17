import { z } from 'zod';

/**
 * Timer (Accounts phase 3 contract 5.2, LD1; migration 20261205000100).
 *
 * One POST per minute to /api/integrations/timer (database cron job
 * `crm-timer`, created paused, bearer from Vault) runs these steps in order,
 * each with its own time budget and try/catch, so one failing or slow step
 * never stops the next:
 *   1. timer_tick         public.timer_tick(): every due database task (registry)
 *   2. customer_messages  dispatchCustomerMessages() (track A, 5.9)
 *   3. push               dispatchPush() (track D, @/modules/notices/server/push-dispatch)
 *   4. render             renderOneQueuedJob() (track B, render-online.ts; only when PDF_RENDER_ONLINE=on)
 * The response and the logs carry counts and codes only: never names,
 * amounts, addresses, message text or secrets.
 */

export const TIMER_STEPS = ['timer_tick', 'customer_messages', 'push', 'render'] as const;
export type TimerStepName = (typeof TIMER_STEPS)[number];

/** Route budget (`maxDuration`); the step budgets below add up to less. */
export const TIMER_MAX_DURATION_SECONDS = 55;

/** Per-step time budgets in milliseconds (sum 50 s, under the 55 s route limit). */
export const TIMER_STEP_BUDGET_MS: Record<TimerStepName, number> = {
  timer_tick: 20_000,
  customer_messages: 15_000,
  push: 8_000,
  render: 7_000,
};

/** A bearer shorter than this counts as not configured. */
export const MIN_TIMER_SECRET_LENGTH = 32;

/** Counts only: whole numbers keyed by a short code. */
export type TimerCounts = Record<string, number>;

export type TimerStepStatus = 'ok' | 'skipped' | 'failed' | 'timeout';

export interface TimerStepOutcome {
  step: TimerStepName;
  status: TimerStepStatus;
  counts: TimerCounts;
  /** A code (SQLSTATE, refusal token or `unexpected`), never message text. */
  errorCode: string | null;
  ms: number;
}

export interface TimerRunResult {
  /** `ok` when every step was ok or skipped. */
  status: 'ok' | 'partial';
  steps: TimerStepOutcome[];
}

/**
 * A step: returns any result object (only its whole-number fields are kept as
 * counts), or `null` when it has nothing to do in this environment (skipped).
 * The signal aborts when the step's budget is spent.
 */
export interface TimerStep {
  name: TimerStepName;
  run(signal: AbortSignal): Promise<unknown>;
}

/** public.timer_tick() result (counts and per-task counts or error codes). */
export const timerTickResultSchema = z.union([
  z.object({ status: z.literal('busy') }).strict(),
  z
    .object({
      status: z.literal('ok'),
      ran: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      pruned: z.number().int().nonnegative(),
      tasks: z.record(z.string().regex(/^[a-z_]{3,40}$/), z.record(z.string(), z.union([z.number(), z.string()]))),
    })
    .strict(),
]);
export type TimerTickResult = z.infer<typeof timerTickResultSchema>;
