/* Booking reliability B1-7 (pure; used by step-context.tsx). */

/** Booking reliability B1-7: how long the footer step buttons ignore activation after a step change. */
export const STEP_BUTTON_PAUSE_MS = 400;

/**
 * B1-7 (pure, unit-tested): a double click on "Go to step 2" must not land on
 * step 3, because the second click hits the next step's button that appears
 * in the same place. For `pauseMs` after a step change `ready()` is false; the
 * button stays focusable and is not shown as disabled, it only ignores the
 * activation (click, Enter, Space all arrive as a click).
 */
export function createStepGuard(pauseMs = STEP_BUTTON_PAUSE_MS, now: () => number = () => Date.now()) {
  let changedAt = Number.NEGATIVE_INFINITY;
  return {
    /** A step change happened now. */
    mark: () => {
      changedAt = now();
    },
    /** The footer step button may act. */
    ready: () => now() - changedAt >= pauseMs,
  };
}
