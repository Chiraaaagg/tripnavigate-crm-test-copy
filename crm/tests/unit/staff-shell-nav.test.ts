import { describe, expect, it } from 'vitest';
import { homeWorkRoles, settingsAreasFor, shellPermissions } from '@/app/app/shell-permissions';
import { currentHref } from '@/components/NavLinks';
import { settingsTabsFor } from '@/modules/settings/contracts';
import type { RolePermissionFact } from '@/modules/access/policy';
import type { MyWorkCounts } from '@/modules/fulfilment/contracts';
import type { StaffContext } from '@/modules/identity/server/session';
import { flightRows, homeRows, NO_HOME_ROLES } from '@/views/home-view';
import type { ShellViewer } from '@/views/StaffShell';
import { currentMenuKey, menuFor, sectionsFor } from '@/app/app/sections';

/**
 * The grouped menu each role gets from today's permission rules
 * (shellPermissions, unchanged; menu regrouped in the UX redesign R1, C1 and
 * D5, src/app/app/sections.ts), and the Home "What needs you" rows each
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

/** "group: label" for every menu link, in order (the pinned Settings link last). */
const menuOf = (s: StaffContext, financeEntities = FINANCE_ON) => {
  const menu = menuFor(viewerOf(s, financeEntities));
  return [...menu.groups.flatMap((g) => g.links), ...(menu.settings ? [menu.settings] : [])].map((l) => `${l.group}: ${l.label}`);
};

// UX redesign R1 (C1, D5): Accounts is six sections; a person sees only the sections that hold a tab they may open.
const ACCOUNTS_GROUP = ['accounts: To check', 'accounts: Money out', 'accounts: Cash and bank'];
// Batch 4 (DA-250): one "Settings" item, pinned under the menu (R1); its areas (settingsTabsFor, settingsAreasFor) are tested below.
const SETTINGS_GROUP = ['settings: Settings'];

describe('menuFor: grouped menu per role (UX redesign R1)', () => {
  it('Sales: Home, then the Sales group: Leads, Deals, Quotations, Itineraries', () => {
    expect(menuOf(staff('sales', [{ roleCode: 'sales' }]))).toEqual(['top: Home', 'sales: Leads', 'sales: Deals', 'sales: Quotations', 'sales: Itineraries']);
  });

  it('Manager: Home and Approvals, Sales, and the Desks group with the read-only Flight and Visa queues', () => {
    expect(menuOf(staff('manager', [{ roleCode: 'manager', branchId: 'del' }]))).toEqual([
      'top: Home',
      'top: Approvals',
      'sales: Leads',
      'sales: Deals',
      'sales: Quotations',
      'sales: Itineraries',
      'desks: Purchase tasks',
      'desks: Flight tasks',
      'desks: Visa and passport tasks',
      'desks: Suppliers',
      'desks: Rate contracts',
    ]);
  });

  it('Purchase: Home, Deals, Purchase tasks, Payment requests, Suppliers, Rate contracts (never Leads)', () => {
    const menu = menuOf(staff('purchase', [{ roleCode: 'purchase' }]));
    expect(menu).toEqual(['top: Home', 'sales: Deals', 'desks: Purchase tasks', 'desks: Payment requests', 'desks: Suppliers', 'desks: Rate contracts']);
    expect(menu.some((m) => m.includes('Leads'))).toBe(false);
  });

  it('Flight: Home, Deals, Flight tasks', () => {
    expect(menuOf(staff('flight', [{ roleCode: 'flight' }]))).toEqual(['top: Home', 'sales: Deals', 'desks: Flight tasks']);
  });

  it('Visa & Passport desk: Home, Deals, Visa and passport tasks', () => {
    expect(menuOf(staff('visa', [{ roleCode: 'visa' }]))).toEqual(['top: Home', 'sales: Deals', 'desks: Visa and passport tasks']);
  });

  it('Accounts: Home, Deals, the Accounts sections, and Settings with only the Imports tab (customer list)', () => {
    const s = staff('accounts', [{ roleCode: 'accounts' }]);
    expect(menuOf(s)).toEqual(['top: Home', 'sales: Deals', ...ACCOUNTS_GROUP, ...SETTINGS_GROUP]);
    expect(settingsTabsFor(viewerOf(s)).map((t) => t.category)).toEqual(['imports']);
    expect(menuFor(viewerOf(s)).settings?.href).toBe('/app/admin/imports');
  });

  it('Accounts with finance switched off: no money sections, but To check › Customers and Imports stay (Echo-B N2: same rule as those pages)', () => {
    const menu = menuFor(viewerOf(staff('accounts', [{ roleCode: 'accounts' }]), []));
    expect(menuOf(staff('accounts', [{ roleCode: 'accounts' }]), [])).toEqual(['top: Home', 'sales: Deals', 'accounts: To check', 'settings: Settings']);
    // One link: no group heading; the section opens its only tab.
    const accounts = menu.groups.find((g) => g.key === 'accounts')!;
    expect(accounts.label).toBe('');
    expect(accounts.links[0]!.href).toBe('/app/accounts/customers');
  });

  it('Super Admin: Home, Leads (Bitrix connection permission), Deals, then the pinned Settings item that opens Overview, with all ten areas', () => {
    const s = staff('admin', [{ roleCode: 'super_admin' }]);
    expect(menuOf(s)).toEqual(['top: Home', 'sales: Leads', 'sales: Deals', ...SETTINGS_GROUP]);
    const item = menuFor(viewerOf(s)).settings!;
    // R1 (S1): the Settings item opens the Overview landing, the first area of anyone with an admin right.
    expect(item).toMatchObject({ href: '/app/admin', label: 'Settings', group: 'settings', prefixes: ['/app/admin'] });
    const areas = [
      'Overview',
      'People and access',
      'Company and branches',
      'Money rules',
      'Accounts',
      'Bitrix connection',
      'Features',
      'Customer messages',
      'Imports',
      'System health',
    ];
    expect(settingsTabsFor(viewerOf(s)).map((t) => t.label)).toEqual(areas);
    // The frame's own rule (admin layout and Overview page) gives the same list to a Super Admin.
    expect(settingsAreasFor(s, FINANCE_ON).map((t) => t.label)).toEqual(areas);
    expect(settingsAreasFor(s, FINANCE_ON)[0]!.href).toBe(item.href);
  });

  it('Super Admin who also holds Accounts: Accounts sections, one Settings item, and no Money rules tab (cannot set the cash cap)', () => {
    const s = staff('admin-acc', [{ roleCode: 'super_admin' }, { roleCode: 'accounts' }]);
    expect(menuOf(s)).toEqual(['top: Home', 'sales: Leads', 'sales: Deals', ...ACCOUNTS_GROUP, ...SETTINGS_GROUP]);
    expect(settingsTabsFor(viewerOf(s)).map((t) => t.category)).toEqual(['overview', 'people', 'company', 'bitrix', 'features', 'messages', 'imports', 'health']);
    expect(settingsAreasFor(s, FINANCE_ON).map((t) => t.category)).toEqual(['overview', 'people', 'company', 'bitrix', 'features', 'messages', 'imports', 'health']);
  });

  it('Customer messages area: only for a Super Admin (its page answers no one else), never for an integration manager who is not one', () => {
    // A synthetic integration-manager role (integration.manage at entity scope, not a Super Admin), as in shell-permissions.test.ts.
    const integration = staff('integration', [{ roleCode: 'integration' }]);
    integration.access.rolePermissions = [...ROLE_PERMISSIONS, { roleCode: 'integration', permissionCode: 'integration.manage', scope: 'entity' }];
    expect(shellPermissions(integration, FINANCE_ON).canManageIntegration).toBe(true);
    expect(settingsAreasFor(integration, FINANCE_ON).map((t) => t.category)).toEqual(['overview', 'company', 'bitrix', 'features', 'health']);
    expect(settingsAreasFor(staff('admin', [{ roleCode: 'super_admin' }]), FINANCE_ON).map((t) => t.category)).toContain('messages');
    for (const roleCode of ['sales', 'manager', 'purchase', 'flight', 'visa', 'accounts']) {
      expect(settingsAreasFor(staff(roleCode, [{ roleCode }]), FINANCE_ON).map((t) => t.category), roleCode).not.toContain('messages');
    }
  });

  it('Settings item: absent for roles with no Settings right; its address is the first area the person may open (Overview for any admin right)', () => {
    for (const roleCode of ['sales', 'manager', 'purchase', 'flight', 'visa']) {
      expect(menuFor(viewerOf(staff(roleCode, [{ roleCode }]))).settings, roleCode).toBeNull();
    }
    const base: ShellViewer = { displayName: 'x', primaryRole: '', primaryBranch: '', canAdministerStaff: false, canManageGrants: false };
    const href = (v: Partial<ShellViewer>) => menuFor({ ...base, ...v }).settings?.href;
    expect(href({ canManageIntegration: true, canOpenBitrixConnection: true })).toBe('/app/admin');
    expect(href({ canManageGrants: true })).toBe('/app/admin');
    expect(href({ canManageFinancePolicy: true })).toBe('/app/admin');
    // No admin right, only Imports (Accounts): straight to Imports, no Overview.
    expect(href({ canImport: true })).toBe('/app/admin/imports');
    // The first area after Overview is still the one the person may open (Extra access without staff.manage).
    expect(settingsTabsFor({ ...base, canManageGrants: true })[1]).toMatchObject({ category: 'people', href: '/app/admin/access' });
    // integration.manage while holding Purchase: no Bitrix connection area; Features, Customer messages (flag not given) and System health stay.
    expect(settingsTabsFor({ ...base, canManageIntegration: true, canOpenBitrixConnection: false }).map((t) => t.category)).toEqual(['overview', 'company', 'features', 'messages', 'health']);
  });

  it('the one Settings item is current on every Settings address, never on another page', () => {
    const links = sectionsFor({ canAdministerStaff: true, canManageGrants: true, canManageIntegration: true, canOpenBitrixConnection: true, canManageFinancePolicy: true });
    for (const path of ['/app/admin', '/app/admin/staff', '/app/admin/access', '/app/admin/company', '/app/admin/finance-policy', '/app/admin/integration', '/app/admin/imports', '/app/admin/workflow', '/app/admin/bookings', '/app/admin/customer-messages']) {
      expect(currentMenuKey(links, path), path).toBe('settings');
    }
    expect(currentMenuKey(links, '/app/deals')).toBe('deals');
    expect(currentMenuKey(links, '/app/access')).toBeUndefined();
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
      'top: Home',
      'top: Approvals',
      'sales: Leads',
      'sales: Deals',
      'sales: Quotations',
      'sales: Itineraries',
      'desks: Purchase tasks',
      'desks: Flight tasks',
      'desks: Visa and passport tasks',
      'desks: Suppliers',
      'desks: Rate contracts',
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
    expect(menu).not.toContain('sales: Leads');
    expect(menu).toEqual(['top: Home', 'sales: Deals', 'desks: Purchase tasks', 'desks: Payment requests', 'desks: Suppliers', 'desks: Rate contracts']);
  });

  it('"My access" is never a menu item for any role (it is in the account panel; /app/access still opens)', () => {
    for (const roleCode of ['sales', 'manager', 'purchase', 'flight', 'visa', 'accounts', 'super_admin']) {
      const links = sectionsFor(viewerOf(staff(roleCode, [{ roleCode }])));
      expect(links.map((i) => i.label)).not.toContain('My access');
      expect(links.map((i) => i.href)).not.toContain('/app/access');
    }
  });

  it('Quotations and Itineraries only for quotation editors: never Purchase (anywhere), Flight, Visa, Accounts or Super Admin by role (DA-03..DA-07)', () => {
    const quoteItems = (s: StaffContext) => sectionsFor(viewerOf(s)).filter((i) => i.href === '/app/quotations' || i.href === '/app/itineraries');
    for (const roleCode of ['purchase', 'flight', 'visa', 'accounts', 'super_admin']) expect(quoteItems(staff(roleCode, [{ roleCode }])), roleCode).toEqual([]);
    // Purchase in one entity hides them even with Sales elsewhere (same rule as Leads).
    expect(quoteItems(staff('ps', [{ roleCode: 'purchase', legalEntityId: HC }, { roleCode: 'sales', legalEntityId: B }]))).toEqual([]);
    // Accounts who also sells gets them; each appears once, right after Deals.
    const acc = sectionsFor(viewerOf(staff('as', [{ roleCode: 'accounts' }, { roleCode: 'sales' }]))).map((i) => i.href);
    expect(acc.slice(0, 5)).toEqual(['/app', '/app/leads', '/app/deals', '/app/quotations', '/app/itineraries']);
    expect(quoteItems(staff('sm', [{ roleCode: 'sales' }, { roleCode: 'manager' }])).map((i) => `${i.group}: ${i.label}`)).toEqual(['sales: Quotations', 'sales: Itineraries']);
  });

  it('every link opens an existing address (same addresses as before R1)', () => {
    const all = sectionsFor({
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
      canSeePurchasePayments: true,
      canSeeApprovals: true,
    }).map((i) => i.href);
    expect(all).toEqual([
      '/app',
      '/app/approvals',
      '/app/leads',
      '/app/deals',
      '/app/quotations',
      '/app/itineraries',
      '/app/purchase',
      '/app/purchase/payments',
      '/app/flight',
      '/app/visa',
      '/app/purchase/suppliers',
      '/app/purchase/rate-contracts',
      // The Accounts sections open their first tab (an existing address).
      '/app/accounts',
      '/app/accounts/go-ahead',
      '/app/accounts/cash',
      // Batch 4: one Settings item (first area: the R1 Overview at /app/admin); the other Settings addresses are its areas, unchanged (L1).
      '/app/admin',
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
    // Flight build (migration 20261201000150, contract D12): waitingForMe no longer counts flight tasks, so a Flight-only
    // person gets no combined row; Flight's own rows come from flight_home_counts (flightRows), one row per key.
    expect(homeRows(ZERO, { ...NO_HOME_ROLES, flight: true })).toEqual([]);
    expect(flightRows({ flightDealsNotTaken: 2, flightDealsMine: 1, flightBookingChanged: 0, flightChangesDecided: 0, flightReadyToFinish: 0,
      salesFlightChangesToDecide: null, salesTravellersToName: null } as unknown as Parameters<typeof flightRows>[0], null,
    { ...NO_HOME_ROLES, flight: true })).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'flightDealsNotTaken', count: 2, href: '/app/flight' }),
      expect.objectContaining({ key: 'flightDealsMine', count: 1 }),
    ]));
    // Flight build (lead UI review, 5 Nov 2026; migration 0180): precise links per row; Sales rows open the one Deal.
    const precise = flightRows({ flightDealsNotTaken: 0, flightDealsMine: 0, flightBookingChanged: 1, flightChangesDecided: 1, flightReadyToFinish: 1,
      salesFlightChangesToDecide: 1, salesFlightChangesToDecideDealId: 'd-one', salesTravellersToName: 2, salesTravellersToNameDealId: null,
    } as unknown as Parameters<typeof flightRows>[0], null, { ...NO_HOME_ROLES, flight: true, bookings: true });
    const href = (key: string) => precise.find((r) => r.key === key)?.href;
    expect(href('flightBookingChanged')).toBe('/app/flight?show=mine&only=booking_changed');
    expect(href('flightChangesDecided')).toBe('/app/flight?show=mine&only=change_decision');
    expect(href('flightReadyToFinish')).toBe('/app/flight?show=mine&only=ready');
    expect(precise.find((r) => r.key === 'salesFlightChangesToDecide')).toMatchObject({ href: '/app/deals/d-one?tab=services', action: 'Open the deal' });
    expect(precise.find((r) => r.key === 'salesTravellersToName')).toMatchObject({ href: '/app/deals', action: 'Open deals' });
    // Contract Addendum 2 (R3): Flight sees the travellers Sales has named; the row shows only when there is one.
    const named = (n: number) => flightRows({ flightDealsNotTaken: 0, flightDealsMine: 0, flightBookingChanged: 0, flightChangesDecided: 0, flightReadyToFinish: 0,
      flightTravellersNamed: n } as unknown as Parameters<typeof flightRows>[0], null, { ...NO_HOME_ROLES, flight: true });
    expect(named(2).find((r) => r.key === 'flightTravellersNamed')).toMatchObject({ label: 'Travellers Sales has named', count: 2 });
    expect(named(0).find((r) => r.key === 'flightTravellersNamed')).toBeUndefined();
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
