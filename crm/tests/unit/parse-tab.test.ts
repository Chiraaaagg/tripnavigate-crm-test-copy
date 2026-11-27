import { describe, expect, it } from 'vitest';
import { parseTab } from '@/lib/parse-tab';

/** CQ-10: one rule for reading ?tab= values. */

const TABS = ['details', 'work', 'history'] as const;

describe('parseTab', () => {
  it('returns an allowed value unchanged', () => {
    for (const t of TABS) expect(parseTab(t, TABS, 'details')).toBe(t);
  });

  it('gives the fallback for a missing, unknown or not-allowed value', () => {
    for (const raw of [undefined, null, '', 'money', 'Work', ' work', 'work ', 42, {}, ['nope']]) {
      expect(parseTab(raw, TABS, 'details')).toBe('details');
    }
    // A real tab this viewer may not open is not in their allowed list.
    expect(parseTab('history', ['details', 'work'] as const, 'work')).toBe('work');
  });

  it('uses the first entry when the value is given twice', () => {
    expect(parseTab(['work', 'history'], TABS, 'details')).toBe('work');
    expect(parseTab(['bad', 'work'], TABS, 'details')).toBe('details');
    expect(parseTab([], TABS, 'details')).toBe('details');
  });

  it('matches the existing task-tab rule (parseTaskTab) for every value it accepts', async () => {
    const { parseTaskTab } = await import('@/modules/settings/contracts');
    const allowed = ['details', 'work', 'history'] as Parameters<typeof parseTaskTab>[1];
    for (const raw of [undefined, 'details', 'work', 'history', 'bad', ['work', 'details']] as const) {
      expect(parseTab(raw, allowed, 'details')).toBe(parseTaskTab(raw as string | string[] | undefined, allowed));
    }
  });
});
