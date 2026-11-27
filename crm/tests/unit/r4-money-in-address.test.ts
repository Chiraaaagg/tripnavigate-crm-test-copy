import { describe, expect, it } from 'vitest';
import { duesFilterFromParams } from '@/modules/accounts-desk/filters';
import type { DailyCheck } from '@/views/accounts-desk/types';
import {
  dailyCheckWaiting,
  duesDefaultApplies,
  duesEveryStatusHref,
  duesFilterWithDefault,
  duesToggleHref,
  tallyMethodFrom,
  tallyMethodHref,
  tallyMethodsOn,
} from '@/views/accounts-desk/r4-address';

/**
 * UX redesign R4, helper A3: old addresses of Dues and Tally keep working.
 * Dues: only the bare address gets the new default (Overdue plus Due today);
 * every address that names a filter means what it meant before; "Every
 * status" survives a round trip. Tally (D11): no ?method= opens the first
 * switched-on method; a method that is off falls back; both off gives null.
 */

type Sp = Record<string, string | string[] | undefined>;
const read = (sp: Sp) => duesFilterWithDefault(sp, duesFilterFromParams(sp));
const query = (href: string): Sp => Object.fromEntries(new URL(href, 'http://x').searchParams);

describe('Dues default (audit A9)', () => {
  it('the bare address shows Overdue plus Due today', () => {
    expect(read({})).toEqual({ filter: { status: ['overdue', 'due_now'] }, defaulted: true });
  });

  it('an empty search form (blank fields) still gets the default', () => {
    expect(read({ deal: '', nextFrom: '', nextTo: '' }).defaulted).toBe(true);
  });

  it('old addresses that name a filter keep their meaning (no status added)', () => {
    for (const sp of [{ deal: 'BX-10101' }, { reported: 'yes' }, { reported: 'no' }, { status: 'paid' }, { branch: 'a0000011-0000-4000-8000-000000000011' }, { nextFrom: '2026-11-01' }]) {
      const { filter, defaulted } = read(sp);
      expect(defaulted, JSON.stringify(sp)).toBe(false);
      expect(filter).toEqual(duesFilterFromParams(sp));
    }
  });

  it('?status=all (and an empty status) means every status, not the default', () => {
    expect(read({ status: 'all' })).toEqual({ filter: {}, defaulted: false });
    expect(read({ status: '' })).toEqual({ filter: {}, defaulted: false });
    expect(duesDefaultApplies({ status: 'all' }, {})).toBe(false);
  });

  it('"Every status" keeps the other filters and does not fall back to the default', () => {
    const href = duesEveryStatusHref({ status: ['overdue'], dealReference: 'BX-1' });
    expect(href).toBe('/app/accounts/dues?deal=BX-1&status=all');
    expect(read(query(href))).toEqual({ filter: { dealReference: 'BX-1' }, defaulted: false });
    expect(duesEveryStatusHref({})).toBe('/app/accounts/dues?status=all');
  });

  it('chips add and remove one status; removing the last shows every status', () => {
    const f = { status: ['overdue', 'due_now'] as Array<'overdue' | 'due_now'> };
    expect(duesToggleHref(f, 'overdue')).toBe('/app/accounts/dues?status=due_now');
    expect(duesToggleHref(f, 'paid')).toBe('/app/accounts/dues?status=overdue%2Cdue_now%2Cpaid');
    const last = duesToggleHref({ status: ['due_now'] }, 'due_now');
    expect(last).toBe('/app/accounts/dues?status=all');
    expect(read(query(last)).defaulted).toBe(false);
  });
});

describe('Tally method (D11)', () => {
  const both = { file: true, csv: true };
  it('lists the methods switched on, Tally file first', () => {
    expect(tallyMethodsOn(both)).toEqual(['file', 'csv']);
    expect(tallyMethodsOn({ file: false, csv: true })).toEqual(['csv']);
    expect(tallyMethodsOn({ file: false, csv: false })).toEqual([]);
  });

  it('the old address (no ?method=) opens the first switched-on method', () => {
    expect(tallyMethodFrom(undefined, both)).toBe('file');
    expect(tallyMethodFrom(undefined, { file: false, csv: true })).toBe('csv');
    expect(tallyMethodFrom(undefined, { file: true, csv: false })).toBe('file');
  });

  it('?method= picks a switched-on method; an off or unknown one falls back', () => {
    expect(tallyMethodFrom('csv', both)).toBe('csv');
    expect(tallyMethodFrom(['csv', 'file'], both)).toBe('csv');
    expect(tallyMethodFrom('csv', { file: true, csv: false })).toBe('file');
    expect(tallyMethodFrom('xml', both)).toBe('file');
    expect(tallyMethodFrom('file', { file: false, csv: false })).toBeNull();
  });

  it('builds the tab addresses', () => {
    expect(tallyMethodHref('file')).toBe('/app/accounts/tally?method=file');
    expect(tallyMethodHref('csv')).toBe('/app/accounts/tally?method=csv');
  });
});

describe('Daily check waiting count (audit A5)', () => {
  const quiet: DailyCheck = {
    exceptionOwner: { userId: null, name: null, isYou: false, set: false },
    exceptionsOpen: { count: 0, oldestAt: null },
    changedAfterExport: 0,
    originalsMissing: 0,
    receiptsAwaitingVerificationOverOneWorkingDay: 0,
    paymentsApprovedNotRecordedOverOneWorkingDay: 0,
    urgentNoticesUnopenedOverOneWorkingDay: [],
  };

  it('is 0 when every count is 0 or absent (the check folds to one line)', () => {
    expect(dailyCheckWaiting(quiet)).toBe(0);
    expect(dailyCheckWaiting({ ...quiet, customerMessagesFailedOverOneWorkingDay: null, tallyFileUnmatchedOverOneWorkingDay: null, messageQueueOldestMinutes: 5 })).toBe(0);
  });

  it('adds every count, the urgent notices of each branch and a late message queue', () => {
    expect(
      dailyCheckWaiting({
        ...quiet,
        exceptionsOpen: { count: 1, oldestAt: '2026-11-06T09:00:00Z' },
        originalsMissing: 3,
        writeOffsToReview: 2,
        urgentNoticesUnopenedOverOneWorkingDay: [{ branchName: 'Jodhpur', count: 1 }, { branchName: 'Delhi', count: 2 }],
        messageQueueOldestMinutes: 60,
      }),
    ).toBe(10);
  });
});
