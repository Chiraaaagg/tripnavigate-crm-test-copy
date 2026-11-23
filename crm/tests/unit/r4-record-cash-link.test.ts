import { describe, expect, it } from 'vitest';
import { recordHref, rowBranchId } from '@/views/accounts-desk/record-cells';

/*
 * R4 review P3-3: a cash record in Records opens Branch cash on its own
 * branch (?branch=). The records read carries the branch name only, so the
 * page resolves it against its branch choices. Synthetic ids only.
 */

const JODHPUR = 'b0000000-0000-4000-8000-000000000001';
const DELHI = 'b0000000-0000-4000-8000-000000000002';
const BRANCHES = [
  { id: JODHPUR, name: 'Jodhpur' },
  { id: DELHI, name: 'Delhi' },
];
const CASH = { kind: 'cash' as const, id: 'c0000000-0000-4000-8000-000000000001' };

describe('cash record link', () => {
  it('carries the branch when it is known', () => {
    expect(recordHref(CASH, DELHI)).toBe(`/app/accounts/cash?branch=${DELHI}`);
  });
  it('falls back to the bare address without a branch', () => {
    expect(recordHref(CASH)).toBe('/app/accounts/cash');
    expect(recordHref(CASH, null)).toBe('/app/accounts/cash');
  });
  it('resolves the branch by name, the collecting branch when the row has none, and only on exactly one match', () => {
    expect(rowBranchId({ branchName: 'Delhi', collectingBranchName: null }, BRANCHES)).toBe(DELHI);
    expect(rowBranchId({ branchName: null, collectingBranchName: 'Jodhpur' }, BRANCHES)).toBe(JODHPUR);
    expect(rowBranchId({ branchName: 'Udaipur', collectingBranchName: null }, BRANCHES)).toBeNull();
    expect(rowBranchId({ branchName: null, collectingBranchName: null }, BRANCHES)).toBeNull();
    expect(rowBranchId({ branchName: 'Delhi', collectingBranchName: null }, [...BRANCHES, { id: 'b0000000-0000-4000-8000-000000000003', name: 'Delhi' }])).toBeNull();
  });
  it('other kinds are unchanged', () => {
    expect(recordHref({ kind: 'expense', id: null }, DELHI)).toBe('/app/accounts/expenses');
    expect(recordHref({ kind: 'accounts_deal', id: 'd1' })).toBe('/app/accounts/deals/d1');
  });
});
