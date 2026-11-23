import { describe, expect, it } from 'vitest';
import { TASK_TABS, type TaskTab } from '@/modules/settings/contracts';
import { defaultTaskTab, taskTabFor } from '@/views/department/task-default-tab';

/** D6: Purchase, Flight and Visa task pages open on Work for the person who holds the task. */

const ALL: readonly TaskTab[] = TASK_TABS;

describe('defaultTaskTab', () => {
  it('opens Work for the task holder', () => {
    expect(defaultTaskTab(ALL, true)).toBe('work');
  });

  it('opens Details when nobody holds the task, or the viewer only reads it', () => {
    expect(defaultTaskTab(ALL, false)).toBe('details');
  });

  it('never opens a Work tab the viewer does not have', () => {
    expect(defaultTaskTab(['details', 'history'], true)).toBe('details');
    // A status-only viewer (Sales, Accounts on a Purchase task) has no tab bar at all.
    expect(defaultTaskTab([], true)).toBe('details');
  });
});

describe('taskTabFor', () => {
  it('without ?tab=, lands the holder on Work and everyone else on Details', () => {
    expect(taskTabFor(undefined, ALL, true)).toBe('work');
    expect(taskTabFor(undefined, ALL, false)).toBe('details');
  });

  it('keeps every old ?tab= address on the same tab, for the holder and for readers', () => {
    for (const holds of [true, false]) {
      for (const tab of ALL) expect(taskTabFor(tab, ALL, holds), `${tab}, holds ${holds}`).toBe(tab);
      // An explicit Details stays Details for the holder too.
      expect(taskTabFor('details', ALL, holds)).toBe('details');
    }
  });

  it('uses the first value when ?tab= is given twice, as before', () => {
    expect(taskTabFor(['files', 'work'], ALL, false)).toBe('files');
    expect(taskTabFor(['details', 'work'], ALL, true)).toBe('details');
  });

  it('falls back to the D6 default for an unknown value or a tab the viewer does not have', () => {
    for (const raw of ['', 'money', 'Work', ' work']) {
      expect(taskTabFor(raw, ALL, true), raw).toBe('work');
      expect(taskTabFor(raw, ALL, false), raw).toBe('details');
    }
    // Status-only viewer: any ?tab= gives Details (no Work, Files or History data is read).
    for (const raw of [undefined, 'work', 'files', 'history']) expect(taskTabFor(raw, [], true)).toBe('details');
    expect(taskTabFor('work', ['details', 'history'], true)).toBe('details');
  });
});
