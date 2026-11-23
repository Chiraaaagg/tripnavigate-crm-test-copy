import {
  TIMER_STEP_BUDGET_MS,
  type TimerCounts,
  type TimerRunResult,
  type TimerStep,
  type TimerStepName,
  type TimerStepOutcome,
} from './contracts';

/**
 * Pure timer runner (contract 5.2): runs the steps one after another, each
 * inside its own budget and try/catch. A failed or slow step is recorded and
 * the next step still runs. Results keep counts and codes only.
 */

const CODE = /^[A-Za-z0-9_]{1,40}$/;

/** Whole-number fields of a result object (one level), as counts. */
export function countsOf(value: unknown): TimerCounts {
  const counts: TimerCounts = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return counts;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (CODE.test(key) && typeof v === 'number' && Number.isSafeInteger(v)) counts[key] = v;
  }
  return counts;
}

/** A safe code for a thrown value: its `code` when it looks like one, else `unexpected`. */
export function errorCodeOf(error: unknown): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && CODE.test(code) ? code : 'unexpected';
}

class StepTimeout extends Error {
  override name = 'StepTimeout';
}

export interface RunTimerOptions {
  budgets?: Partial<Record<TimerStepName, number>>;
  now?: () => number;
}

export async function runTimerSteps(steps: readonly TimerStep[], options: RunTimerOptions = {}): Promise<TimerRunResult> {
  const now = options.now ?? (() => Date.now());
  const outcomes: TimerStepOutcome[] = [];
  for (const step of steps) {
    const budget = options.budgets?.[step.name] ?? TIMER_STEP_BUDGET_MS[step.name];
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = now();
    let outcome: Omit<TimerStepOutcome, 'ms'>;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new StepTimeout());
        }, budget);
      });
      const result = await Promise.race([Promise.resolve().then(() => step.run(controller.signal)), timeout]);
      outcome = result === null
        ? { step: step.name, status: 'skipped', counts: {}, errorCode: null }
        : { step: step.name, status: 'ok', counts: countsOf(result), errorCode: null };
    } catch (error) {
      outcome = error instanceof StepTimeout
        ? { step: step.name, status: 'timeout', counts: {}, errorCode: 'timeout' }
        : { step: step.name, status: 'failed', counts: {}, errorCode: errorCodeOf(error) };
    } finally {
      if (timer) clearTimeout(timer);
    }
    outcomes.push({ ...outcome, ms: Math.max(0, now() - started) });
  }
  return {
    status: outcomes.every((o) => o.status === 'ok' || o.status === 'skipped') ? 'ok' : 'partial',
    steps: outcomes,
  };
}
