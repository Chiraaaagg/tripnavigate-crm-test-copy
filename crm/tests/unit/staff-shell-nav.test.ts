import { describe, expect, it } from 'vitest';
import { homeWorkRoles, shellPermissions } from '@/app/app/shell-permissions';
import { currentHref, currentNavHref } from '@/components/NavLinks';
import { settingsTabsFor } from '@/modules/settings/contracts';
import type { RolePermissionFact } from '@/modules/access/policy';
import type { MyWorkCounts } from '@/modules/fulfilment/contracts';
import type { StaffContext } from '@/modules/identity/server/session';
import { homeRows, NO_HOME_ROLES } from '@/views/home-view';
import { navItemsFor, type ShellViewer } from '@/views/StaffShell';

/**
 * Direction A R0 menu (copy-catalogue §16.1, DA-01 to DA-08; lead R0
 * decisions 2 and 5): the grouped menu each role gets from today's permission
 * rules (shellPermissions, unchanged), and the Home "What needs you" rows each
 * role gets from the existing my_work_counts read. Navigation convenience
 * only: every page, command and database policy still decides access.
 */

const HC = 'entity-holiday-chacha';
const B = 'entity-synthetic-b';
const FINANCE_ON = [HC];

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

function viewerOf(s: StaffContext, financeEntities = FINANCE_ON): ShellViewer {
  return { displayName: s.displayName, primaryRole: '', primaryBranch: '', ...shellPermissions(s, financeEntities) };
}

/** "Group: label" for every menu item, in order. */
const menuOf = (s: StaffContext, financeEntities = FINANCE_ON) => navItemsFor(viewerOf(s, financeEntities)).map((i) => `${i.group}: ${i.label}`);

// Voice-note batch: Customers to check sits right after To check.
const ACCOUNTS_GROUP = ['Accounts: To check', 'Accounts: Customers to check', 'Accounts: Reported payments', 'Accounts: Department costs', 'Accounts: Branch cash', 'Accounts: Company accounts'];
// Batch 4 (DA-250): one "Settings" item; its tabs (settingsTabsFor) are tested below.
const SETTINGS_GROUP = ['Settings: Settings'];

describe('navItemsFor: grouped menu per role (Direction A)', () => {
  it('Sales: Home, Leads, Deals, Quotations, Itineraries (DA-01)', () => {
    expect(menuOf(staff('sales', [{ roleCode: 'sales' }]))).toEqual(['Work: Home', 'Work: Leads', 'Work: Deals', 'Work: Quotations', 'Work: Itineraries']);
  });

  it('Manager: Home, Leads, Deals, Quotations, Itineraries, Purchase tasks, Suppliers (DA-02)', () => {
    expect(menuOf(staff('manager', [{ roleCode: 'manager', branchId: 'del' }]))).toEqual([
      'Work: Home',
      'Work: Leads',
      'Work: Deals',
      'Work: Quotations',
      'Work: Itineraries',
      'Work: Purchase tasks',
      'Work: Suppliers',
    ]);
  });

  it('Purchase: Home, Deals, Purchase tasks, Suppliers (never Leads)', () => {
    const menu = menuOf(staff('purchase', [{ roleCode: 'purchase' }]));
    expect(menu).toEqual(['Work: Home', 'Work: Deals', 'Work: Purchase tasks', 'Work: Suppliers']);
    expect(menu.some((m) => m.includes('Leads'))).toBe(false);
  });

  it('Flight: Home, Deals, Flight tasks', () => {
    expect(menuOf(staff('flight', [{ roleCode: 'flight' }]))).toEqual(['Work: Home', 'Work: Deals', 'Work: Flight tasks']);
  });

  it('Visa & Passport desk: Home, Deals, Visa and passport tasks', () => {
    expect(menuOf(staff('visa', [{ roleCode: 'visa' }]))).toEqual(['Work: Home', 'Work: Deals', 'Work: Visa and passport tasks']);
  });

  it('Accounts: Home, Deals, the Accounts group with all six items, and Settings with only the Imports tab (customer list)', () => {
    const s = staff('accounts', [{ roleCode: 'accounts' }]);
    expect(menuOf(s)).toEqual(['Work: Home', 'Work: Deals', ...ACCOUNTS_GROUP, ...SETTINGS_GROUP]);
    expect(settingsTabsFor(viewerOf(s)).map((t) => t.category)).toEqual(['imports']);
    expect(navItemsFor(viewerOf(s)).find((i) => i.group === 'Settings')?.href).toBe('/app/admin/imports');
  });

  it('Accounts with finance switched off: no money items, but Customers to check and Imports stay (Echo-B N2: same rule as those pages)', () => {
    expect(menuOf(staff('accounts', [{ roleCode: 'accounts' }]), [])).toEqual(['Work: Home', 'Work: Deals', 'Accounts: Customers to check', 'Settings: Settings']);
  });

  it('Super Admin: Home, Leads (Bitrix connection permission), Deals, then one Settings item with all seven tabs (DA-250, Imports added in the voice-note batch)', () => {
    const s = staff('admin', [{ roleCode: 'super_admin' }]);
    expect(menuOf(s)).toEqual(['Work: Home', 'Work: Leads', 'Work: Deals', ...SETTINGS_GROUP]);
    const item = navItemsFor(viewerOf(s)).find((i) => i.group === 'Settings')!;
    expect(item).toEqual({ href: '/app/admin/staff', label: 'Settings', group: 'Settings', activePrefix: '/app/admin' });
    expect(settingsTabsFor(viewerOf(s)).map((t) => t.label)).toEqual(['People and access', 'Company and branches', 'Money rules', 'Bitrix connection', 'Imports', 'Features', 'System health']);
  });

  it('Super Admin who also holds Accounts: Accounts group, one Settings item, and no Money rules tab (cannot set the cash cap)', () => {
    const s = staff('admin-acc', [{ roleCode: 'super_admin' }, { roleCode: 'accounts' }]);
    expect(menuOf(s)).toEqual(['Work: Home', 'Work: Leads', 'Work: Deals', ...ACCOUNTS_GROUP, ...SETTINGS_GROUP]);
    expect(settingsTabsFor(viewerOf(s)).map((t) => t.category)).toEqual(['people', 'company', 'bitrix', 'imports', 'features', 'health']);
  });

  it('Settings item: absent for roles with no Settings right; its address is the first tab the person may open', () => {
    // Accounts now opens Settings · Imports (customer list), tested above.
    for (const roleCode of ['sales', 'manager', 'purchase', 'flight', 'visa']) {
      expect(navItemsFor(viewerOf(staff(roleCode, [{ roleCode }]))).filter((i) => i.group === 'Settings'), roleCode).toEqual([]);
    }
    const base: ShellViewer = { displayName: 'x', primaryRole: '', primaryBranch: '', canAdministerStaff: false, canManageGrants: false };
    const href = (v: Partial<ShellViewer>) => navItemsFor({ ...base, ...v }).find((i) => i.group === 'Settings')?.href;
    expect(href({ canManageIntegration: true, canOpenBitrixConnection: true })).toBe('/app/admin/company');
    expect(href({ canManageGrants: true })).toBe('/app/admin/access');
    expect(href({ canManageFinancePolicy: true })).toBe('/app/admin/company');
    // integration.manage while holding Purchase: no Bitrix connection tab, Features and System health stay.
    expect(settingsTabsFor({ ...base, canManageIntegration: true, canOpenBitrixConnection: false }).map((t) => t.category)).toEqual(['company', 'features', 'health']);
  });

  it('the one Settings item is current on every Settings address, never on another page', () => {
    const items = navItemsFor({ displayName: 'x', primaryRole: '', primaryBranch: '', canAdministerStaff: true, canManageGrants: true, canManageIntegration: true, canOpenBitrixConnection: true, canManageFinancePolicy: true });
    for (const path of ['/app/admin/staff', '/app/admin/access', '/app/admin/company', '/app/admin/finance-policy', '/app/admin/integration', '/app/admin/imports', '/app/admin/workflow', '/app/admin/bookings']) {
      expect(currentNavHref(items, path), path).toBe('/app/admin/staff');
    }
    expect(currentNavHref(items, '/app/deals')).toBe('/app/deals');
    expect(currentNavHref(items, '/app/access')).toBeUndefined();
  });

  it('several roles get the union in group order, never a duplicate', () => {
    const menu = menuOf(
      staff('multi', [
        { roleCode: 'sales', legalEntityId: B },
        { roleCode: 'flight' },
        { roleCode: 'visa' },
        { roleCode: 'manager', branchId: 'del' },
        { roleCode: 'accounts' },
      ]),
    );
    expect(menu).toEqual([
      'Work: Home',
      'Work: Leads',
      'Work: Deals',
      'Work: Quotations',
      'Work: Itineraries',
      'Work: Purchase tasks',
      'Work: Suppliers',
      'Work: Flight tasks',
      'Work: Visa and passport tasks',
      ...ACCOUNTS_GROUP,
      ...SETTINGS_GROUP,
    ]);
    expect(new Set(menu).size).toBe(menu.length);
  });

  it('Purchase in one entity hides Leads even with Sales in another (the Leads page refuses them)', () => {
    const menu = menuOf(
      staff('multi', [
        { roleCode: 'purchase', legalEntityId: HC },
        { roleCode: 'sales', legalEntityId: B },
      ]),
    );
    expect(menu).not.toContain('Work: Leads');
    expect(menu).toEqual(['Work: Home', 'Work: Deals', 'Work: Purchase tasks', 'Work: Suppliers']);
  });

  it('"My access" is never a menu item for any role (it is in the account panel; /app/access still opens)', () => {
    for (const roleCode of ['sales', 'manager', 'purchase', 'flight', 'visa', 'accounts', 'super_admin']) {
      const items = navItemsFor(viewerOf(staff(roleCode, [{ roleCode }])));
      expect(items.map((i) => i.label)).not.toContain('My access');
      expect(items.map((i) => i.href)).not.toContain('/app/access');
    }
  });

  it('Quotations and Itineraries only for quotation editors: never Purchase (anywhere), Flight, Visa, Accounts or Super Admin by role (DA-03..DA-07)', () => {
    const quoteItems = (s: StaffContext) => navItemsFor(viewerOf(s)).filter((i) => i.href === '/app/quotations' || i.href === '/app/itineraries');
    for (const roleCode of ['purchase', 'flight', 'visa', 'accounts', 'super_admin']) expect(quoteItems(staff(roleCode, [{ roleCode }])), roleCode).toEqual([]);
    // Purchase in one entity hides them even with Sales elsewhere (same rule as Leads).
    expect(quoteItems(staff('ps', [{ roleCode: 'purchase', legalEntityId: HC }, { roleCode: 'sales', legalEntityId: B }]))).toEqual([]);
    // Accounts who also sells gets them; each appears once, right after Deals.
    const acc = navItemsFor(viewerOf(staff('as', [{ roleCode: 'accounts' }, { roleCode: 'sales' }]))).map((i) => i.href);
    expect(acc.slice(0, 5)).toEqual(['/app', '/app/leads', '/app/deals', '/app/quotations', '/app/itineraries']);
    expect(quoteItems(staff('sm', [{ roleCode: 'sales' }, { roleCode: 'manager' }])).map((i) => `${i.group}: ${i.label}`)).toEqual(['Work: Quotations', 'Work: Itineraries']);
  });

  it('every item opens an existing address (same addresses as before R0)', () => {
    const all = navItemsFor({
      displayName: 'x',
      primaryRole: '',
      primaryBranch: '',
      canAdministerStaff: true,
      canManageGrants: true,
      canManageIntegration: true,
      canSeePurchaseTasks: true,
      canSeeLeads: true,
      canSeeQuotations: true,
      canUseAccounts: true,
      canCheckCustomers: true,
      canManageFinancePolicy: true,
      canSeeFlightTasks: true,
      canSeeVisaDesk: true,
    }).map((i) => i.href);
    expect(all).toEqual([
      '/app',
      '/app/leads',
      '/app/deals',
      '/app/quotations',
      '/app/itineraries',
      '/app/purchase',
      '/app/purchase/suppliers',
      '/app/flight',
      '/app/visa',
      '/app/accounts',
      '/app/accounts/customers',
      '/app/accounts/claims',
      '/app/accounts/expenses',
      '/app/accounts/cash',
      '/app/accounts/destinations',
      // Batch 4: one Settings item (first tab); the other Settings addresses are its tabs, unchanged (L1).
      '/app/admin/staff',
    ]);
  });
});

describe('currentHref: the current menu item', () => {
  const hrefs = ['/app', '/app/deals', '/app/purchase', '/app/purchase/suppliers', '/app/accounts', '/app/accounts/claims'];
  it('marks the longest matching address only', () => {
    expect(currentHref(hrefs, '/app/purchase/suppliers')).toBe('/app/purchase/suppliers');
    expect(currentHref(hrefs, '/app/purchase/tasks/1')).toBe('/app/purchase');
    expect(currentHref(hrefs, '/app/accounts/deals/abc')).toBe('/app/accounts');
    expect(currentHref(hrefs, '/app')).toBe('/app');
    expect(currentHref(hrefs, '/app/deals/1/book')).toBe('/app/deals');
  });
  it('Batch 3: an editor, a new page and a referral draft mark Quotations; an itinerary marks Itineraries', () => {
    const withWork = [...hrefs, '/app/quotations', '/app/itineraries'];
    expect(currentHref(withWork, '/app/quotations/qv1')).toBe('/app/quotations');
    expect(currentHref(withWork, '/app/quotations/new')).toBe('/app/quotations');
    expect(currentHref(withWork, '/app/quotations/drafts/rd1')).toBe('/app/quotations');
    expect(currentHref(withWork, '/app/itineraries/id1/preview')).toBe('/app/itineraries');
  });
  it('marks nothing for an address outside the menu (for example My access)', () => {
    expect(currentHref(hrefs, '/app/access')).toBeUndefined();
  });
});

const ZERO: MyWorkCounts = {
  waitingForMe: 0,
  returnedToMe: 0,
  missingDetails: 0,
  intakeNeeded: 0,
  receiptsToVerify: null,
  requestsToApprove: null,
  claimsToProcess: null,
  expensesToReview: null,
  visaTasksWaiting: null,
};
const keys = (counts: MyWorkCounts, roles: typeof NO_HOME_ROLES) => homeRows(counts, roles).map((r) => r.key);

describe('homeRows: "What needs you" shows only counts that apply (plan T4)', () => {
  it('Sales and Manager: drafts, returned, missing details, confirmed deals needing a booking; never "Requests to approve"', () => {
    const roles = { ...NO_HOME_ROLES, bookings: true };
    expect(keys({ ...ZERO, requestsToApprove: 0 }, roles)).toEqual(['waitingForMe', 'returnedToMe', 'missingDetails', 'intakeNeeded']);
    expect(homeRows({ ...ZERO, waitingForMe: 3 }, roles)[0]).toMatchObject({ label: 'Booking drafts you can continue', count: 3, href: '/app/deals' });
  });

  it('every count names its scope (Sales: your deals; Manager: your deals and branches)', () => {
    expect(homeRows(ZERO, { ...NO_HOME_ROLES, bookings: true }).map((r) => r.label)).toEqual([
      'Booking drafts you can continue',
      'Returned by Accounts (your deals)',
      'Booking drafts missing details (your deals)',
      'Confirmed deals needing a booking (your deals)',
    ]);
    expect(homeRows(ZERO, { ...NO_HOME_ROLES, bookings: true, branchManager: true }).map((r) => r.label)).toEqual([
      'Booking drafts you can continue',
      'Returned by Accounts (your deals and branches)',
      'Booking drafts missing details (your deals and branches)',
      'Confirmed deals needing a booking (your deals and branches)',
    ]);
  });

  it('Purchase, Flight: one row for their own queue, no Sales-only zeros', () => {
    expect(homeRows({ ...ZERO, waitingForMe: 5 }, { ...NO_HOME_ROLES, purchase: true })).toEqual([
      expect.objectContaining({ key: 'waitingForMe', count: 5, href: '/app/purchase', action: 'Open Purchase tasks' }),
    ]);
    expect(homeRows(ZERO, { ...NO_HOME_ROLES, flight: true })).toEqual([expect.objectContaining({ key: 'waitingForMe', href: '/app/flight' })]);
  });

  it('Visa desk: one row that opens the desk in one click (no duplicate of the same number)', () => {
    const rows = homeRows({ ...ZERO, waitingForMe: 2, visaTasksWaiting: 2 }, { ...NO_HOME_ROLES, visa: true });
    expect(rows).toEqual([expect.objectContaining({ key: 'visaTasksWaiting', count: 2, href: '/app/visa' })]);
  });

  it('Accounts: reviews, receipts, reported payments and department costs; no Sales-only zeros', () => {
    const rows = homeRows({ ...ZERO, waitingForMe: 4, receiptsToVerify: 2, claimsToProcess: 1, expensesToReview: 0 }, { ...NO_HOME_ROLES, accounts: true });
    expect(rows.map((r) => [r.key, r.href])).toEqual([
      ['waitingForMe', '/app/accounts?filter=needs_review'],
      ['receiptsToVerify', '/app/accounts?filter=awaiting_verification'],
      ['claimsToProcess', '/app/accounts/claims'],
      ['expensesToReview', '/app/accounts/expenses'],
    ]);
  });

  it('a count the database returned as null (not applicable) is hidden', () => {
    expect(keys(ZERO, { ...NO_HOME_ROLES, accounts: true })).toEqual(['waitingForMe']);
  });

  it('Super Admin by role alone: nothing applies', () => {
    expect(homeRows({ ...ZERO, requestsToApprove: 0 }, NO_HOME_ROLES)).toEqual([]);
  });

  it('several roles: one combined "waiting" row plus each role\'s own rows', () => {
    const rows = homeRows({ ...ZERO, waitingForMe: 7 }, { ...NO_HOME_ROLES, bookings: true, purchase: true });
    expect(rows[0]).toMatchObject({ key: 'waitingForMe', label: 'Waiting for you across your roles', count: 7 });
    expect(rows.map((r) => r.key)).toEqual(['waitingForMe', 'returnedToMe', 'missingDetails', 'intakeNeeded']);
  });

  it('homeWorkRoles follows the memberships and the Accounts menu rule', () => {
    expect(homeWorkRoles(staff('s', [{ roleCode: 'sales' }]), FINANCE_ON)).toEqual({ ...NO_HOME_ROLES, bookings: true });
    expect(homeWorkRoles(staff('m', [{ roleCode: 'manager' }]), FINANCE_ON)).toEqual({ ...NO_HOME_ROLES, bookings: true, branchManager: true });
    expect(homeWorkRoles(staff('a', [{ roleCode: 'accounts' }]), FINANCE_ON)).toEqual({ ...NO_HOME_ROLES, accounts: true });
    expect(homeWorkRoles(staff('a', [{ roleCode: 'accounts' }]), [])).toEqual(NO_HOME_ROLES);
    expect(homeWorkRoles(staff('ap', [{ roleCode: 'accounts' }, { roleCode: 'purchase' }]), FINANCE_ON)).toEqual({ ...NO_HOME_ROLES, purchase: true });
    expect(homeWorkRoles(staff('admin', [{ roleCode: 'super_admin' }]), FINANCE_ON)).toEqual(NO_HOME_ROLES);
  });
});

describe('homeRows: drafts read draftsToContinue (Batch 1), never waitingForMe', () => {
  const bookings = { ...NO_HOME_ROLES, bookings: true };
  it('Sales: the drafts row shows draftsToContinue; no combined row', () => {
    const rows = homeRows({ ...ZERO, waitingForMe: 9, draftsToContinue: 2 }, bookings);
    expect(rows[0]).toMatchObject({ key: 'draftsToContinue', label: 'Booking drafts you can continue', count: 2, href: '/app/deals' });
    expect(rows.map((r) => r.key)).not.toContain('waitingForMe');
  });

  it('Sales and Purchase: drafts and the Purchase queue are separate rows; the queue row leaves the drafts out', () => {
    const rows = homeRows({ ...ZERO, waitingForMe: 7, draftsToContinue: 2 }, { ...bookings, purchase: true });
    expect(rows.slice(0, 2)).toEqual([
      expect.objectContaining({ key: 'draftsToContinue', count: 2 }),
      expect.objectContaining({ key: 'waitingForMe', count: 5, label: 'Purchase tasks not taken yet, or yours in progress', href: '/app/purchase' }),
    ]);
  });

  it('an older database without the count keeps the combined row', () => {
    expect(homeRows({ ...ZERO, waitingForMe: 3 }, bookings)[0]).toMatchObject({ key: 'waitingForMe', count: 3 });
    expect(homeRows({ ...ZERO, waitingForMe: 3, draftsToContinue: null }, bookings)[0]).toMatchObject({ key: 'waitingForMe', count: 3 });
  });
});

describe('Home summary: never a total of overlapping rows (Echo M3, DA-134)', () => {
  it('drafts and drafts missing details overlap, so the summary names no number', async () => {
    const { homeSummary } = await import('@/views/home-view');
    const rows = homeRows({ ...ZERO, waitingForMe: 5, draftsToContinue: 5, missingDetails: 1, intakeNeeded: 2 }, { ...NO_HOME_ROLES, bookings: true, branchManager: true });
    // 5 drafts (1 of them missing details) + 2 deals needing a booking = 7 pieces of work, not 8.
    expect(rows.map((r) => [r.key, r.count])).toEqual([
      ['draftsToContinue', 5],
      ['returnedToMe', 0],
      ['missingDetails', 1],
      ['intakeNeeded', 2],
    ]);
    expect(homeSummary(rows)).toBe('Work is waiting for you below.');
    expect(homeSummary(rows)).not.toMatch(/\d/);
    expect(homeSummary(homeRows(ZERO, { ...NO_HOME_ROLES, bookings: true }))).toBe('Nothing needs you right now.');
  });
});

describe('homeRows: quotation rows (Batch 3, FP-081)', () => {
  const sales = { ...NO_HOME_ROLES, bookings: true, quotations: true };
  it('Sales who may see Quotations: "Quotation drafts to finish" and "Accepted quotations to link", each opening the list with the same filter in scope all', () => {
    const rows = homeRows({ ...ZERO, quotationDraftsToFinish: 2, acceptedQuotesToLink: 0 }, sales);
    expect(rows.slice(-2)).toEqual([
      expect.objectContaining({ key: 'quotationDraftsToFinish', label: 'Quotation drafts to finish (yours)', count: 2, href: '/app/quotations?filter=to_finish&scope=all' }),
      expect.objectContaining({ key: 'acceptedQuotesToLink', label: 'Accepted quotations to link to a deal (yours)', count: 0, href: '/app/quotations?filter=accepted_not_linked&scope=all' }),
    ]);
  });
  it('Manager words name the branches', () => {
    const rows = homeRows({ ...ZERO, quotationDraftsToFinish: 1, acceptedQuotesToLink: 1 }, { ...sales, branchManager: true });
    expect(rows.filter((r) => r.key === 'quotationDraftsToFinish')[0]?.label).toBe('Quotation drafts to finish (yours and your branches’)');
  });
  it('hidden without the Quotations menu rule, and when the count is null or missing (older database): never shown as 0', () => {
    expect(keys({ ...ZERO, quotationDraftsToFinish: 3, acceptedQuotesToLink: 1 }, { ...NO_HOME_ROLES, bookings: true })).not.toContain('quotationDraftsToFinish');
    expect(keys({ ...ZERO, quotationDraftsToFinish: null }, sales)).not.toContain('quotationDraftsToFinish');
    expect(keys(ZERO, sales)).not.toContain('acceptedQuotesToLink');
  });
  it('every quotation row opens an address the menu offers, with a query', () => {
    for (const row of homeRows({ ...ZERO, quotationDraftsToFinish: 1, acceptedQuotesToLink: 1 }, sales).filter((r) => r.key.startsWith('quotation') || r.key === 'acceptedQuotesToLink')) {
      expect(row.href.split('?')[0]).toBe('/app/quotations');
    }
  });
});
