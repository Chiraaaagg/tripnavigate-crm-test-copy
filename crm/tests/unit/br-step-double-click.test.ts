import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStepGuard, STEP_BUTTON_PAUSE_MS } from '@/views/booking-form/step-guard';

/*
 * Booking reliability B1-7 (BR-36): a double click on "Go to step 2" lands on
 * step 2, not step 3. For 400 ms after a step change the footer step button
 * ignores activation (click, Enter and Space all arrive as a click); it stays
 * focusable and is not shown as disabled.
 */

describe('footer step button after a step change', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-01-01T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('acts on the first press when no step changed yet', () => {
    expect(createStepGuard().ready()).toBe(true);
  });

  it('ignores a second press within 400 ms (the double click)', () => {
    const guard = createStepGuard();
    guard.mark();
    vi.advanceTimersByTime(120);
    expect(guard.ready()).toBe(false);
    vi.advanceTimersByTime(279);
    expect(guard.ready()).toBe(false);
  });

  it('a press after 500 ms goes on to the next step', () => {
    const guard = createStepGuard();
    guard.mark();
    vi.advanceTimersByTime(500);
    expect(guard.ready()).toBe(true);
  });

  it('Enter held down (repeats every 30 ms) does not skip a step', () => {
    const guard = createStepGuard();
    let steps = 1;
    const press = () => {
      if (!guard.ready()) return;
      steps += 1;
      guard.mark();
    };
    press();
    for (let i = 0; i < 12; i += 1) {
      vi.advanceTimersByTime(30);
      press();
    }
    expect(steps).toBe(2);
  });

  it('the pause is 400 ms', () => {
    expect(STEP_BUTTON_PAUSE_MS).toBe(400);
    const guard = createStepGuard();
    guard.mark();
    vi.advanceTimersByTime(400);
    expect(guard.ready()).toBe(true);
  });
});
