import { describe, expect, it } from 'vitest';
import {
  type MembershipFact,
  type ViewerAccess,
  accountsEntityIds,
  canManageFinancePolicy,
  canSeeLeads,
  canUseAccounts,
  financePolicyEntityIds,
  hasFinanceDealConflict,
} from '@/modules/access/policy';

/**
 * Phase 5A navigation predicates (phase-5a-contract.md §4, §15). These mirror
 * authz.can_accounts and authz.can_manage_finance_policy for navigation only;
 * the database refuses independently (tests/db/finance-access-*.test.ts).
 */

const HC = 'entity-holiday-chacha';
const B = 'entity-synthetic-b';
const ENABLED = [HC];

const viewer = (userId: string, memberships: Array<Partial<MembershipFact> & { roleCode: string }>): ViewerAccess => ({
  userId,
  memberships: memberships.map((m) => ({ legalEntityId: m.legalEntityId ?? HC, branchId: m.branchId ?? 'jdh', roleCode: m.roleCode })),
  rolePermissions: [],
  grants: [],
});

describe('canUseAccounts', () => {
  it('allows an active accounts membership in a finance-enabled entity', () => {
    const v = viewer('acc-1', [{ roleCode: 'accounts' }]);
    expect(canUseAccounts(v, ENABLED)).toBe(true);
    expect(accountsEntityIds(v, ENABLED)).toEqual([HC]);
  });

  it('refuses every role other than accounts', () => {
    for (const role of ['sales', 'purchase', 'manager', 'super_admin', 'visa', 'flight']) {
      expect(canUseAccounts(viewer('u', [{ roleCode: role }]), ENABLED), role).toBe(false);
    }
  });

  it('refuses mixed Accounts + Purchase in the same entity, even across branches', () => {
    const v = viewer('mixed', [
      { roleCode: 'accounts', branchId: 'jdh' },
      { roleCode: 'purchase', branchId: 'del' },
    ]);
    expect(canUseAccounts(v, ENABLED)).toBe(false);
    expect(accountsEntityIds(v, ENABLED)).toEqual([]);
  });

  it('a purchase role in another entity does not block Accounts here', () => {
    const v = viewer('acc', [
      { roleCode: 'accounts', legalEntityId: HC },
      { roleCode: 'purchase', legalEntityId: B },
    ]);
    expect(accountsEntityIds(v, [HC, B])).toEqual([HC]);
  });

  it('refuses a finance-disabled entity and fails closed when the enabled list is missing', () => {
    const v = viewer('acc-b', [{ roleCode: 'accounts', legalEntityId: B }]);
    expect(canUseAccounts(v, ENABLED)).toBe(false);
    expect(canUseAccounts(viewer('acc-1', [{ roleCode: 'accounts' }]))).toBe(false);
    expect(canUseAccounts(viewer('acc-1', [{ roleCode: 'accounts' }]), [])).toBe(false);
  });

  it('refuses a viewer without memberships (inactive staff carry none)', () => {
    expect(canUseAccounts(viewer('former', []), ENABLED)).toBe(false);
  });

  it('Accounts never implies Leads navigation', () => {
    expect(canSeeLeads(viewer('acc-1', [{ roleCode: 'accounts' }]))).toBe(false);
  });
});

describe('canManageFinancePolicy', () => {
  it('allows super_admin in a finance-enabled entity without accounts', () => {
    const v = viewer('admin', [{ roleCode: 'super_admin' }]);
    expect(canManageFinancePolicy(v, ENABLED)).toBe(true);
    expect(financePolicyEntityIds(v, ENABLED)).toEqual([HC]);
  });

  it('refuses Super Admin + Accounts in the same entity', () => {
    const v = viewer('admin-acc', [{ roleCode: 'super_admin' }, { roleCode: 'accounts', branchId: 'del' }]);
    expect(canManageFinancePolicy(v, ENABLED)).toBe(false);
  });

  it('accounts in another entity does not block policy here', () => {
    const v = viewer('admin', [
      { roleCode: 'super_admin', legalEntityId: HC },
      { roleCode: 'accounts', legalEntityId: B },
    ]);
    expect(financePolicyEntityIds(v, [HC, B])).toEqual([HC]);
  });

  it('refuses non-admin roles, a disabled entity and a missing enabled list', () => {
    for (const role of ['sales', 'purchase', 'manager', 'accounts']) {
      expect(canManageFinancePolicy(viewer('u', [{ roleCode: role }]), ENABLED), role).toBe(false);
    }
    expect(canManageFinancePolicy(viewer('admin', [{ roleCode: 'super_admin', legalEntityId: B }]), ENABLED)).toBe(false);
    expect(canManageFinancePolicy(viewer('admin', [{ roleCode: 'super_admin' }]))).toBe(false);
  });

  it('Super Admin alone never gets Accounts', () => {
    expect(canUseAccounts(viewer('admin', [{ roleCode: 'super_admin' }]), ENABLED)).toBe(false);
  });
});

describe('hasFinanceDealConflict', () => {
  const deal = { ownerUserId: 'owner', activeSalesAssigneeIds: ['assignee'] };
  it('flags the deal owner and an active Sales assignee only', () => {
    expect(hasFinanceDealConflict(viewer('owner', [{ roleCode: 'accounts' }]), deal)).toBe(true);
    expect(hasFinanceDealConflict(viewer('assignee', [{ roleCode: 'accounts' }]), deal)).toBe(true);
    expect(hasFinanceDealConflict(viewer('other', [{ roleCode: 'accounts' }]), deal)).toBe(false);
  });
});
