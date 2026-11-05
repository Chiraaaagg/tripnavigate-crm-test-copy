import { describe, expect, it } from 'vitest';
import { progressText } from '@/modules/fulfilment/contracts';
import { computeProgress, nextStepFor } from '@/modules/fulfilment/dto';

/** Contract §5.4: progress is computed from the items' task states, never stored. */

type Item = Parameters<typeof computeProgress>[0][number];
const planned: Item = { state: 'planned', task: null };
const notStarted: Item = { state: 'active', task: { status: 'not_started' } };
const inProgress: Item = { state: 'active', task: { status: 'in_progress' } };
const done: Item = { state: 'active', task: { status: 'supplier_confirmed' } };
const cancelled: Item = { state: 'cancelled', task: { status: 'in_progress' } };

describe('nextStepFor', () => {
  it('derives the next step from state and task', () => {
    expect(nextStepFor(planned)).toBe('confirm_version');
    expect(nextStepFor({ state: 'active', task: null })).toBe('confirm_version');
    expect(nextStepFor(notStarted)).toBe('take_task');
    expect(nextStepFor(inProgress)).toBe('supplier_confirmation');
    expect(nextStepFor(done)).toBe('done');
  });
});

describe('computeProgress', () => {
  it('is empty with no items (never fulfilled)', () => {
    expect(computeProgress([])).toEqual({
      total: 0,
      byState: { planned: 0, notStarted: 0, inProgress: 0, supplierConfirmed: 0 },
      fulfilled: false,
      staleCount: 0,
      needs: [],
    });
    expect(progressText(computeProgress([]))).toBe('No services yet');
  });

  it('counts per state, lists open needs once in display order, staleCount 0', () => {
    const p = computeProgress([planned, notStarted, inProgress, done, notStarted]);
    expect(p).toEqual({
      total: 5,
      byState: { planned: 1, notStarted: 2, inProgress: 1, supplierConfirmed: 1 },
      fulfilled: false,
      staleCount: 0,
      needs: ['take_task', 'supplier_confirmation', 'confirm_version'],
    });
    expect(progressText(p)).toBe('1 of 4 confirmed · 1 in progress · 2 not started · 1 planned');
  });

  it('is fulfilled only when every counted item is supplier confirmed', () => {
    expect(computeProgress([done, done]).fulfilled).toBe(true);
    expect(computeProgress([done, inProgress]).fulfilled).toBe(false);
    expect(computeProgress([done, planned]).fulfilled).toBe(false);
  });

  it('leaves cancelled (on hold) items out of every count', () => {
    const p = computeProgress([done, cancelled]);
    expect(p.total).toBe(1);
    expect(p.fulfilled).toBe(true);
    expect(p.needs).toEqual([]);
    expect(computeProgress([cancelled]).fulfilled).toBe(false);
  });

  it('a draft-only Deal reads as planned', () => {
    expect(progressText(computeProgress([planned, planned]))).toBe('2 planned');
  });
});
