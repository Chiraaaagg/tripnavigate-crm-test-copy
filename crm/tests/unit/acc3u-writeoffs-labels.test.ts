import { describe, expect, it } from 'vitest';
import { blockText, duesWriteOffLine, monthlyTotal, monthText, parseSmallBalancesQuery, proposeBlockedReason, shiftMonth, smallBalancesHref } from '@/views/write-offs/labels';
import type { DuesWriteOff, SmallBalanceRow } from '@/views/write-offs/types';

/** Track U pure helpers for the write-off screens (contract 6.6, 15 screen 6). */

const row = (over: Partial<SmallBalanceRow> = {}): SmallBalanceRow => ({
  dealId: 'a0000000-0000-4000-8000-000000000001',
  dealReference: 'SYN-JOD-1',
  branchName: 'Jodhpur',
  tripEnd: '2026-10-01',
  direction: 'due',
  balancePaise: '30000',
  limitPaise: '500000',
  writeOff: null,
  blockedBy: [],
  can: { propose: true, approve: false, return: false, withdraw: false, undo: false },
  ...over,
});

describe('proposeBlockedReason', () => {
  it('allows a proposable row', () => expect(proposeBlockedReason(row())).toBeNull());
  it('names the first block code in words', () => expect(proposeBlockedReason(row({ blockedBy: ['refund_open', 'trip_not_ended'] }))).toBe('A refund request is still open on this Deal.'));
  it('refuses above the limit and a zero balance (BigInt compare, no floats)', () => {
    expect(proposeBlockedReason(row({ balancePaise: '500001' }))).toMatch(/limit/);
    expect(proposeBlockedReason(row({ balancePaise: '500000' }))).toBeNull();
    expect(proposeBlockedReason(row({ balancePaise: '0' }))).toMatch(/Nothing/);
  });
  it('refuses when a live write-off exists or the viewer cannot propose', () => {
    expect(proposeBlockedReason(row({ writeOff: { id: 'x', refNo: 'WO-2026-000001', status: 'proposed', amountPaise: '1', reason: 'r', proposedByName: null, rowVersion: 1 } }))).toMatch(/already/);
    expect(proposeBlockedReason(row({ can: { propose: false, approve: true, return: true, withdraw: false, undo: false } }))).toMatch(/Accounts/);
  });
  it('gives a generic line for an unknown code', () => expect(blockText('new_code')).toMatch(/stops a write-off/));
});

describe('dues line', () => {
  const w: DuesWriteOff = { refNo: 'WO-2026-000009', direction: 'due', amountPaise: '30000', status: 'approved', reason: 'Bank charges.', proposedByName: 'A', decidedByName: 'Synthetic Manager', decidedAt: '2026-11-10' };
  it('reads as the contract sentence', () => expect(duesWriteOffLine(w)).toBe('Written off ₹300.00 by Synthetic Manager on 10 Nov 2026 — Bank charges.'));
  it('words an excess and a proposal', () => {
    expect(duesWriteOffLine({ ...w, direction: 'excess' })).toMatch(/^Overpayment kept ₹300.00/);
    expect(duesWriteOffLine({ ...w, status: 'proposed', decidedByName: null, decidedAt: null })).toMatch(/proposed by A — waiting for the Manager/);
  });
});

describe('addresses and months', () => {
  it('round-trips the list address', () => {
    const href = smallBalancesHref({ preset: 'to_approve', branchId: 'a0000000-0000-4000-8000-000000000011' }, '2026-10-01|x');
    const q = Object.fromEntries(new URL(href, 'http://x').searchParams);
    expect(parseSmallBalancesQuery(q)).toEqual({ filter: { preset: 'to_approve', branchId: 'a0000000-0000-4000-8000-000000000011' }, after: '2026-10-01|x' });
    expect(parseSmallBalancesQuery({ preset: 'nope', branch: 'bad' })).toEqual({ filter: { preset: undefined, branchId: undefined }, after: null });
    expect(smallBalancesHref({})).toBe('/app/accounts/small-balances');
  });
  it('sums monthly totals in paise strings', () => expect(monthlyTotal([{ count: 2, duePaise: '99999999999999999', excessPaise: '1' }, { count: 1, duePaise: '1', excessPaise: '0' }])).toEqual({ count: 3, duePaise: '100000000000000000', excessPaise: '1' }));
  it('moves across years', () => {
    expect(shiftMonth('2026-01-01', -1)).toBe('2025-12-01');
    expect(shiftMonth('2026-12-01', 1)).toBe('2027-01-01');
    expect(monthText('2026-11-01')).toBe('November 2026');
  });
});
