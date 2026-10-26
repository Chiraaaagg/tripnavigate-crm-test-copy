import { describe, expect, it } from 'vitest';
import { canOpenFeaturesSettings, shellPermissions } from '@/app/app/shell-permissions';
import {
  administeredEntityIds,
  canManageFinancePolicy,
  canSeeLeads,
  canSeeQuotations,
  canUseAccounts,
  holdsPurchaseAnywhere,
  type RolePermissionFact,
} from '@/modules/access/policy';
import type { StaffContext } from '@/modules/identity/server/session';
import { accountsRoleEntityIds, importEntityIds } from '@/modules/parties/import-access';

/**
 * The staff frame's section flags (navigation and Home's next steps) come from
 * shellPermissions(). It must give exactly what the staff layout computed on
 * main before the move (main 6d03593, crm/src/app/app/layout.tsx), for every
 * kind of person. Navigation convenience only; the database decides access.
 */

const HC = 'entity-holiday-chacha';
const B = 'entity-synthetic-b';
const FINANCE_ON = [HC];

// Synthetic role → permission facts (entity scope = administrative capability).
const ROLE_PERMISSIONS: RolePermissionFact[] = [
  { roleCode: 'sales', permissionCode: 'deal.read', scope: 'own' },
  { roleCode: 'purchase', permissionCode: 'purchase_task.read', scope: 'own' },
  { roleCode: 'manager', permissionCode: 'deal.read', scope: 'entity' },
  { roleCode: 'accounts', permissionCode: 'deal.read', scope: 'own' },
  { roleCode: 'super_admin', permissionCode: 'staff.manage', scope: 'entity' },
  { roleCode: 'super_admin', permissionCode: 'access.grant', scope: 'entity' },
  { roleCode: 'super_admin', permissionCode: 'integration.manage', scope: 'entity' },
];

function staff(userId: string, roles: Array<{ roleCode: string; legalEntityId?: string; branchId?: string }>): StaffContext {
  const memberships = roles.map((r) => ({
    legalEntityId: r.legalEntityId ?? HC,
    legalEntityName: r.legalEntityId === B ? 'Synthetic Entity B' : 'Synthetic Entity HC',
    branchId: r.branchId ?? 'jdh',
    branchName: r.branchId === 'del' ? 'Delhi' : 'Jodhpur',
    isHeadOffice: false,
    roleCode: r.roleCode,
    roleName: r.roleCode,
  }));
  return {
    userId,
    email: `${userId}@example.test`,
    displayName: `Synthetic ${userId}`,
    memberships,
    access: {
      userId,
      memberships: memberships.map((m) => ({ legalEntityId: m.legalEntityId, branchId: m.branchId, roleCode: m.roleCode })),
      rolePermissions: ROLE_PERMISSIONS,
      grants: [],
    },
    supabase: {} as StaffContext['supabase'],
  };
}

/** Verbatim copy of the expressions in main's former StaffLayout (6d03593). */
function formerLayoutFlags(s: StaffContext, financeEntities: string[]) {
  return {
    canAdministerStaff: administeredEntityIds(s.access, 'staff.manage').length > 0,
    canManageGrants: administeredEntityIds(s.access, 'access.grant').length > 0,
    canManageIntegration: administeredEntityIds(s.access, 'integration.manage').length > 0,
    canSeeLeads: canSeeLeads(s.access) && !holdsPurchaseAnywhere(s.access),
    canSeePurchaseTasks: s.memberships.some((m) => m.roleCode === 'purchase' || m.roleCode === 'manager'),
    // B1 (10 October 2026): Flight tasks link for the Flight role only.
    canSeeFlightTasks: s.memberships.some((m) => m.roleCode === 'flight'),
    // B1.1 (11 October 2026): Visa & Passport desk link for the visa role only (no Manager link).
    canSeeVisaDesk: s.memberships.some((m) => m.roleCode === 'visa'),
    canUseAccounts: canUseAccounts(s.access, financeEntities),
    canManageFinancePolicy: canManageFinancePolicy(s.access, financeEntities),
  };
}

const NONE = {
  canAdministerStaff: false,
  canManageGrants: false,
  canManageIntegration: false,
  // Batch 4: Settings · Bitrix connection tab (integration.manage, no Purchase anywhere).
  canOpenBitrixConnection: false,
  canSeeLeads: false,
  // Batch 3 (FP-001): Quotations and Itineraries items.
  canSeeQuotations: false,
  canSeePurchaseTasks: false,
  canSeeFlightTasks: false,
  canSeeVisaDesk: false,
  canUseAccounts: false,
  canManageFinancePolicy: false,
  canImport: false,
  canCheckCustomers: false,
};

const CASES: Array<{ name: string; who: StaffContext; expected: typeof NONE }> = [
  { name: 'Sales', who: staff('sales', [{ roleCode: 'sales' }]), expected: { ...NONE, canSeeLeads: true, canSeeQuotations: true } },
  { name: 'Purchase', who: staff('purchase', [{ roleCode: 'purchase' }]), expected: { ...NONE, canSeePurchaseTasks: true } },
  { name: 'Flight', who: staff('flight', [{ roleCode: 'flight' }]), expected: { ...NONE, canSeeFlightTasks: true } },
  { name: 'Visa & Passport desk', who: staff('visa', [{ roleCode: 'visa' }]), expected: { ...NONE, canSeeVisaDesk: true } },
  {
    name: 'Manager',
    who: staff('manager', [{ roleCode: 'manager', branchId: 'del' }]),
    expected: { ...NONE, canSeeLeads: true, canSeeQuotations: true, canSeePurchaseTasks: true },
  },
  { name: 'Accounts', who: staff('accounts', [{ roleCode: 'accounts' }]), expected: { ...NONE, canUseAccounts: true, canImport: true, canCheckCustomers: true } },
  {
    // Purchase anywhere hides Leads everywhere (the Leads page refuses them), even with Sales elsewhere.
    name: 'Purchase in one entity + Sales in another',
    who: staff('multi', [
      { roleCode: 'purchase', legalEntityId: HC },
      { roleCode: 'sales', legalEntityId: B },
    ]),
    expected: { ...NONE, canSeePurchaseTasks: true },
  },
  {
    name: 'Accounts + Purchase in the same entity',
    who: staff('acc-pur', [{ roleCode: 'accounts' }, { roleCode: 'purchase', branchId: 'del' }]),
    expected: { ...NONE, canSeePurchaseTasks: true },
  },
  {
    name: 'Super admin',
    who: staff('admin', [{ roleCode: 'super_admin' }]),
    expected: {
      ...NONE,
      canAdministerStaff: true,
      canManageGrants: true,
      canManageIntegration: true,
      canOpenBitrixConnection: true,
      canSeeLeads: true,
      canManageFinancePolicy: true,
      canImport: true,
    },
  },
  {
    name: 'Super admin who also holds Accounts (cannot set the cash cap)',
    who: staff('admin-acc', [{ roleCode: 'super_admin' }, { roleCode: 'accounts' }]),
    expected: {
      ...NONE,
      canAdministerStaff: true,
      canManageGrants: true,
      canManageIntegration: true,
      canOpenBitrixConnection: true,
      canSeeLeads: true,
      canUseAccounts: true,
      canImport: true,
      canCheckCustomers: true,
    },
  },
  {
    // Batch 4: the Bitrix connection page refuses anyone holding Purchase, so its tab is hidden too.
    name: 'Super admin who also holds Purchase (no Bitrix connection tab)',
    who: staff('admin-pur', [{ roleCode: 'super_admin' }, { roleCode: 'purchase', branchId: 'del' }]),
    expected: {
      ...NONE,
      canAdministerStaff: true,
      canManageGrants: true,
      canManageIntegration: true,
      canSeePurchaseTasks: true,
      canManageFinancePolicy: true,
    },
  },
  { name: 'No membership', who: staff('none', []), expected: NONE },
];

const expectedFor = (who: StaffContext) => CASES.find((c) => c.who === who)!.expected;

describe('shellPermissions()', () => {
  for (const { name, who, expected } of CASES) {
    it(`${name}: every flag as expected and identical to the former layout`, () => {
      const flags = shellPermissions(who, FINANCE_ON);
      expect(flags).toEqual(expected);
      // Batch 3 adds canSeeQuotations, Batch 4 canOpenBitrixConnection; every earlier flag stays exactly as the former layout computed it.
      const { canSeeQuotations: quotations, canOpenBitrixConnection: bitrix, canImport: imports, canCheckCustomers: customers, ...earlier } = flags;
      expect(earlier).toEqual(formerLayoutFlags(who, FINANCE_ON));
      expect(quotations).toBe(canSeeQuotations(who.access));
      expect(bitrix).toBe(earlier.canManageIntegration && !holdsPurchaseAnywhere(who.access));
      // Voice-note batch (Echo-B N2): the pages' rules (role without Purchase in that company), not the finance switch.
      expect(imports).toBe(importEntityIds(who.access, 'hotel').length > 0 || importEntityIds(who.access, 'customer').length > 0);
      expect(customers).toBe(accountsRoleEntityIds(who.access).length > 0);
    });
  }

  it('finance switched off: no Accounts and no Finance policy, other flags unchanged', () => {
    for (const { who } of CASES) {
      const flags = shellPermissions(who, []);
      expect(flags.canUseAccounts).toBe(false);
      expect(flags.canManageFinancePolicy).toBe(false);
      const { canSeeQuotations: quotations, canOpenBitrixConnection: bitrix, canImport: imports, canCheckCustomers: customers, ...earlier } = flags;
      expect(earlier).toEqual(formerLayoutFlags(who, []));
      // Echo-B N2: Imports and Customers to check do not follow the finance switch (same as their pages).
      expect(imports).toBe(expectedFor(who).canImport);
      expect(customers).toBe(expectedFor(who).canCheckCustomers);
      expect(bitrix).toBe(expectedFor(who).canOpenBitrixConnection);
      expect(quotations).toBe(expectedFor(who).canSeeQuotations);
    }
  });

  it('returns exactly the expected flags (no extra keys)', () => {
    expect(Object.keys(shellPermissions(CASES[0]!.who, FINANCE_ON)).sort()).toEqual(Object.keys(NONE).sort());
  });
});

describe('canSeeQuotations: who sees Quotations and Itineraries (Batch 3, FP-001, lead ruling 21 Oct)', () => {
  const sees = (roles: Array<{ roleCode: string; legalEntityId?: string; branchId?: string }>) => shellPermissions(staff('x', roles), FINANCE_ON).canSeeQuotations;

  it('Sales and branch Manager see them (the people who may edit quotations today)', () => {
    expect(sees([{ roleCode: 'sales' }])).toBe(true);
    expect(sees([{ roleCode: 'manager', branchId: 'del' }])).toBe(true);
    expect(sees([{ roleCode: 'sales', legalEntityId: B }])).toBe(true);
  });

  it('never by role alone: Accounts, Purchase, Flight, Visa desk, Super Admin (even with integration.manage), no membership', () => {
    for (const roleCode of ['accounts', 'purchase', 'flight', 'visa', 'super_admin']) expect(sees([{ roleCode }]), roleCode).toBe(false);
    expect(sees([])).toBe(false);
  });

  it('Purchase anywhere hides them everywhere (as the Leads link), even with Sales or Manager elsewhere', () => {
    expect(sees([{ roleCode: 'purchase', legalEntityId: HC }, { roleCode: 'sales', legalEntityId: B }])).toBe(false);
    expect(sees([{ roleCode: 'manager' }, { roleCode: 'purchase', branchId: 'del' }])).toBe(false);
  });

  it('a person with several roles gets them through Sales or Manager (Accounts + Sales, Flight + Manager)', () => {
    expect(sees([{ roleCode: 'accounts' }, { roleCode: 'sales' }])).toBe(true);
    expect(sees([{ roleCode: 'flight' }, { roleCode: 'manager' }])).toBe(true);
    expect(sees([{ roleCode: 'super_admin' }, { roleCode: 'sales', legalEntityId: B }])).toBe(true);
  });

  it('does not depend on finance being switched on', () => {
    expect(shellPermissions(staff('s', [{ roleCode: 'sales' }]), []).canSeeQuotations).toBe(true);
  });
});

describe('canOpenFeaturesSettings: Settings · Features tab and page (Batch 5, carried Low N1)', () => {
  // A synthetic integration-manager role (integration.manage at entity scope, not a Super Admin).
  const withIntegrationRole = (s: StaffContext): StaffContext => ({
    ...s,
    access: { ...s.access, rolePermissions: [...s.access.rolePermissions, { roleCode: 'integration', permissionCode: 'integration.manage', scope: 'entity' }] },
  });
  const opens = (roles: Array<{ roleCode: string; legalEntityId?: string; branchId?: string }>) =>
    canOpenFeaturesSettings(withIntegrationRole(staff('x', roles)).access);

  it('Super Admin opens Features, also when holding Purchase (the database returns the workflow section to them)', () => {
    expect(opens([{ roleCode: 'super_admin' }])).toBe(true);
    expect(opens([{ roleCode: 'super_admin' }, { roleCode: 'purchase', branchId: 'del' }])).toBe(true);
  });

  it('an integration manager without Purchase opens Features (read only)', () => {
    expect(opens([{ roleCode: 'integration' }])).toBe(true);
  });

  it('an integration manager who holds Purchase anywhere and is not a Super Admin does not (N1)', () => {
    expect(opens([{ roleCode: 'integration' }, { roleCode: 'purchase', branchId: 'del' }])).toBe(false);
    expect(opens([{ roleCode: 'integration', legalEntityId: HC }, { roleCode: 'purchase', legalEntityId: B }])).toBe(false);
  });

  it('nobody without integration.manage opens Features', () => {
    for (const roles of [[{ roleCode: 'sales' }], [{ roleCode: 'purchase' }], [{ roleCode: 'manager' }], [{ roleCode: 'accounts' }], []]) {
      expect(opens(roles)).toBe(false);
    }
  });

  it('never opens Features for someone without the integration flag the shell already computes', () => {
    for (const { who } of CASES) {
      if (canOpenFeaturesSettings(who.access)) expect(shellPermissions(who, FINANCE_ON).canManageIntegration).toBe(true);
    }
  });
});
