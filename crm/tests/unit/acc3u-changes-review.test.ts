import { describe, expect, it } from 'vitest';
import { factLines, factValueText } from '@/views/booking-changes/adapt';
import { STATUS_WORD } from '@/views/booking-changes/labels';
import { reviewServiceRows } from '@/views/booking-changes/review-model';
import { changeNextStep, LIVE_STATUSES, overBudgetBlockedReason } from '@/views/booking-changes/rules';
import type { ReviewSideView } from '@/views/booking-changes/types';

/* Addendum O2 (Manager approves the final version) and the UI review findings 7 and 8. Synthetic values only. */

const side = (versionNo: number, services: ReviewSideView['services']): ReviewSideView => ({ versionNo, tripStart: null, tripEnd: null, sellingTotalPaise: '100', plan: [], services });
const svc = (id: string, no: number, facts: Array<[string, string | null]>) => ({ itemId: id, itemNo: no, serviceType: 'hotel', serviceTitle: `Hotel ${no}`, budgetPaise: null, facts: facts.map(([key, value]) => ({ key, label: key, value })) });

describe('O2 status and next step', () => {
  it('draft is a live status with plain words', () => {
    expect(LIVE_STATUSES.has('draft')).toBe(true);
    expect(STATUS_WORD.draft).toBe('Being prepared — not sent yet');
  });
  it('the next step follows request → fill → send → Manager → suppliers', () => {
    const r = { kind: 'change' as const, removalRoute: null, charges: [], reconfirmations: [] };
    expect(changeNextStep({ ...r, status: 'draft', changeVersionId: null }, 'sales')).toMatch(/open the booking/);
    expect(changeNextStep({ ...r, status: 'draft', changeVersionId: 'v' }, 'sales')).toMatch(/Send change/);
    expect(changeNextStep({ ...r, status: 'requested', changeVersionId: 'v' }, 'sales')).toMatch(/side by side/);
    expect(changeNextStep({ ...r, status: 'returned', changeVersionId: 'v' }, 'sales')).toMatch(/Send change.* again/);
    expect(changeNextStep({ ...r, status: 'approved', changeVersionId: 'v', reconfirmations: [{ taskId: 't', serviceTitle: 'x', status: 'pending', overBudget: false, refusedReason: null }] }, 'sales')).toMatch(/Purchase asks each supplier/);
    expect(changeNextStep({ ...r, status: 'applied', changeVersionId: 'v' }, 'sales')).toBeNull();
  });
});

describe('finding 7: facts in words, never raw JSON', () => {
  it('lists, objects and booleans become text; internal keys are dropped', () => {
    expect(factValueText([4, 7])).toBe('4, 7');
    expect(factValueText({ adults: 2, childAges: [5] })).toBe('Adults: 2; Children’s ages: 5');
    expect(factValueText(true)).toBe('Yes');
    expect(factValueText([])).toBeNull();
    const lines = factLines({ childAges: [6, 9], requestItems: [{ a: 1 }], entryMode: 'manual', schema: 2, rooms: 2 });
    expect(lines.map((l) => l.key)).toEqual(['childAges', 'rooms']);
    expect(lines[0]).toEqual({ key: 'childAges', label: 'Children’s ages', value: '6, 9' });
    expect(lines.every((l) => !l.value?.includes('{'))).toBe(true);
  });
});

describe('finding 8: over-budget reason from the real cause', () => {
  it('names who approves', () => {
    expect(overBudgetBlockedReason({ isManager: false, worksTask: true, canApprove: false })).toBe('The branch Manager approves a cost above budget.');
    expect(overBudgetBlockedReason({ isManager: true, worksTask: true, canApprove: false })).toMatch(/You recorded this answer/);
    expect(overBudgetBlockedReason({ isManager: true, worksTask: false, canApprove: false })).toMatch(/Another branch Manager/);
    expect(overBudgetBlockedReason({ isManager: true, worksTask: false, canApprove: true })).toBeNull();
  });
});

describe('O2 side-by-side review rows', () => {
  it('marks changed, added, removed and unchanged services, changed lines first', () => {
    const base = side(2, [svc('a', 1, [['checkIn', '12 Dec'], ['rooms', '2']]), svc('b', 2, [['rooms', '1']])]);
    const next = side(3, [svc('a', 1, [['checkIn', '13 Dec'], ['rooms', '2']]), svc('c', 3, [['date', '13 Dec']])]);
    const rows = reviewServiceRows(base, next, ['a']);
    expect(rows.map((r) => [r.itemId, r.state])).toEqual([['a', 'changed'], ['c', 'added'], ['b', 'removed']]);
    const a = rows[0]!;
    expect(a.lines.find((l) => l.key === 'checkIn')).toMatchObject({ before: '12 Dec', after: '13 Dec', changed: true });
    expect(a.lines.find((l) => l.key === 'rooms')).toMatchObject({ changed: false });
    expect(rows[1]!.lines[0]).toMatchObject({ before: null, after: '13 Dec', changed: false });
  });
  it('an untouched service is "same"', () => {
    const s = svc('a', 1, [['rooms', '2']]);
    expect(reviewServiceRows(side(1, [s]), side(2, [s]), [])[0]!.state).toBe('same');
  });
});
