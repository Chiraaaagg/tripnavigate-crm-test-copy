import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { accountsDeskLinks, homeWorkRoles, shellPermissions } from '@/app/app/shell-permissions';
import {
  currentMenuKey,
  groupCount,
  type MenuCountRoles,
  type MenuCounts,
  mayOpenAddress,
  maySeeSection,
  menuCountReads,
  menuCountsFrom,
  menuFor,
  reachableAddresses,
  sectionsFor,
  type SectionsViewer,
} from '@/app/app/sections';
import { FOLD_STORAGE_KEY, isGroupOpen, parseFoldedGroups, withGroupFolded } from '@/components/NavLinks';
import { isTypingTarget, opensQuickSearch } from '@/components/ui/quick-search';
import type { RolePermissionFact } from '@/modules/access/policy';
import type { MyWorkCounts } from '@/modules/fulfilment/contracts';
import type { StaffContext } from '@/modules/identity/server/session';
import type { SupplierMoneyHomeCounts } from '@/modules/supplier-money/contracts';
import { frameScopeLine, type ShellViewer } from '@/views/StaffShell';
import { legacyMenuHrefs } from './helpers/legacy-menu';

/**
 * UX redesign R1 (build plan 4.4, CQ-7): the one "sections this person may
 * see" function (src/app/app/sections.ts), the menu counts, the group fold
 * state and the quick search key. The menu must offer every person exactly
 * the addresses the menu offered before R1 (legacyMenuHrefs, a frozen copy):
 * the old flags were each written to match their page's own gate, so the
 * regrouping adds no link to a page that refuses the person and loses none.
 */

const HC = 'entity-holiday-chacha';
const B = 'entity-synthetic-b';
const app = join(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), 'src/app');

const ROLE_PERMISSIONS: RolePermissionFact[] = [
  { roleCode: 'sales', permissionCode: 'deal.read', scope: 'own' },
  { roleCode: 'purchase', permissionCode: 'purchase_task.read', scope: 'own' },
  { roleCode: 'manager', permissionCode: 'deal.read', scope: 'entity' },
  { roleCode: 'accounts', permissionCode: 'deal.read', scope: 'own' },
  { roleCode: 'super_admin', permissionCode: 'staff.manage', scope: 'entity' },
  { roleCode: 'super_admin', permissionCode: 'access.grant', scope: 'entity' },
  { roleCode: 'super_admin', permissionCode: 'integration.manage', scope: 'entity' },
];
const ROLES = ['sales', 'purchase', 'manager', 'accounts', 'super_admin', 'flight', 'visa'] as const;

function staff(roles: Array<{ roleCode: string; legalEntityId?: string; branchId?: string }>): StaffContext {
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
    userId: 'u',
    email: 'u@example.test',
    displayName: 'Synthetic Person',
    memberships,
    access: {
      userId: 'u',
      memberships: memberships.map((m) => ({ legalEntityId: m.legalEntityId, branchId: m.branchId, roleCode: m.roleCode })),
      rolePermissions: ROLE_PERMISSIONS,
      grants: [],
    },
    supabase: {} as StaffContext['supabase'],
  };
}

/** The viewer exactly as the layout builds it. */
function viewerOf(s: StaffContext, finance: string[]): ShellViewer {
  return { displayName: 'x', primaryRole: '', primaryBranch: '', ...shellPermissions(s, finance), ...accountsDeskLinks(s, finance) };
}

/** Every role combination (128), each with finance on and off, and with the first role in a second company. */
function everyPerson(): Array<{ name: string; viewer: ShellViewer }> {
  const out: Array<{ name: string; viewer: ShellViewer }> = [];
  for (let mask = 1; mask < 2 ** ROLES.length; mask += 1) {
    const roles = ROLES.filter((_, i) => mask & (1 << i));
    for (const finance of [[HC], []]) {
      for (const split of [false, true]) {
        const s = staff(roles.map((roleCode, i) => ({ roleCode, legalEntityId: split && i === 0 ? B : HC, branchId: i % 2 ? 'del' : 'jdh' })));
        out.push({ name: `${roles.join('+')}${finance.length ? '' : ' (finance off)'}${split ? ' (two companies)' : ''}`, viewer: viewerOf(s, finance) });
      }
    }
  }
  return out;
}

const PEOPLE = everyPerson();

describe('sectionsFor: the one list of sections a person may see', () => {
  it(`offers each of ${PEOPLE.length} role combinations exactly the addresses the menu offered before R1 (no new link, none lost)`, () => {
    const wrong: string[] = [];
    for (const { name, viewer } of PEOPLE) {
      const now = [...reachableAddresses(viewer)].sort();
      const before = [...new Set(legacyMenuHrefs(viewer))].sort();
      if (JSON.stringify(now) !== JSON.stringify(before)) wrong.push(`${name}: now ${now.join(' ')} | before ${before.join(' ')}`);
    }
    expect(wrong).toEqual([]);
  });

  it('every link and every Accounts section tab is an existing page', () => {
    const all = new Set(PEOPLE.flatMap((p) => reachableAddresses(p.viewer)));
    for (const href of all) {
      const page = join(app, href.replace(/^\/app/, 'app'), 'page.tsx');
      const grouped = join(app, href.replace(/^\/app/, 'app'), '(list)', 'page.tsx');
      expect(existsSync(page) || existsSync(grouped), `${href} has a page`).toBe(true);
    }
  });

  it('never gives a desk-only person (Purchase, Flight, Visa) an Accounts section, Leads or Quotations (money fence)', () => {
    for (const roles of [['purchase'], ['flight'], ['visa'], ['purchase', 'flight', 'visa']]) {
      for (const finance of [[HC], []]) {
        const links = sectionsFor(viewerOf(staff(roles.map((roleCode) => ({ roleCode }))), finance));
        expect(links.filter((l) => l.group === 'accounts'), roles.join('+')).toEqual([]);
        expect(links.map((l) => l.key), roles.join('+')).not.toContain('leads');
        expect(links.map((l) => l.key), roles.join('+')).not.toContain('quotations');
      }
    }
  });

  it('puts each link in its group, in order: top, Sales, Desks, Accounts, then Settings', () => {
    const order = ['top', 'sales', 'desks', 'accounts', 'settings'];
    for (const { name, viewer } of PEOPLE) {
      const groups = sectionsFor(viewer).map((l) => order.indexOf(l.group));
      expect(groups, name).toEqual([...groups].sort((a, b) => a - b));
      const keys = sectionsFor(viewer).map((l) => l.key);
      expect(new Set(keys).size, name).toBe(keys.length);
    }
  });

  it('Accounts: six sections at most; each opens its first tab and marks every tab current', () => {
    const v = viewerOf(staff([{ roleCode: 'accounts' }]), [HC]);
    const accounts = sectionsFor(v).filter((l) => l.group === 'accounts');
    expect(accounts.map((l) => [l.label, l.href])).toEqual([
      ['To check', '/app/accounts'],
      ['Money in', '/app/accounts/dues'],
      ['Money out', '/app/accounts/go-ahead'],
      ['Cash and bank', '/app/accounts/cash'],
      ['Records', '/app/accounts/records'],
      ['Tally', '/app/accounts/tally'],
    ]);
    const links = sectionsFor(v);
    expect(currentMenuKey(links, '/app/accounts/claims')).toBe('accounts:to-check');
    expect(currentMenuKey(links, '/app/accounts/customers/C-1')).toBe('accounts:to-check');
    expect(currentMenuKey(links, '/app/accounts/supplier-invoices')).toBe('accounts:money-out');
    expect(currentMenuKey(links, '/app/accounts/small-balances/monthly')).toBe('accounts:money-in');
    expect(currentMenuKey(links, '/app/accounts/destinations')).toBe('accounts:cash-bank');
    expect(currentMenuKey(links, '/app')).toBe('home');
    expect(currentMenuKey(links, '/app/purchase/rate-contracts/RC-1')).toBe('rate-contracts');
  });

  it('Sales with Dues of their own Deals only: "Dues" in the Sales group, no Accounts group', () => {
    const v = viewerOf(staff([{ roleCode: 'sales' }]), [HC]);
    expect(v.canSeeOwnDues).toBe(true);
    const menu = menuFor(v);
    expect(menu.groups.map((g) => g.key)).toEqual(['top', 'sales']);
    expect(menu.groups[1]!.links.map((l) => l.label)).toEqual(['Leads', 'Deals', 'Quotations', 'Itineraries', 'Dues']);
  });

  it('a group with one link has no heading; with more it has its name', () => {
    const purchase = menuFor(viewerOf(staff([{ roleCode: 'flight' }]), [HC]));
    expect(purchase.groups.map((g) => [g.key, g.label])).toEqual([
      ['top', ''],
      ['sales', ''],
      ['desks', ''],
    ]);
    const manager = menuFor(viewerOf(staff([{ roleCode: 'manager' }]), [HC]));
    expect(manager.groups.map((g) => g.label)).toEqual(['', 'Sales', 'Desks', 'Accounts']);
  });

  it('maySeeSection and mayOpenAddress give the menu’s answer for Home and page gates', () => {
    const purchase = viewerOf(staff([{ roleCode: 'purchase' }]), [HC]);
    expect(maySeeSection(purchase, 'purchase')).toBe(true);
    expect(maySeeSection(purchase, 'accounts:to-check')).toBe(false);
    expect(mayOpenAddress(purchase, '/app/purchase/T-1?tab=work')).toBe(true);
    expect(mayOpenAddress(purchase, '/app/accounts/claims')).toBe(false);
    expect(mayOpenAddress(purchase, '/app/leads')).toBe(false);
    const accounts = viewerOf(staff([{ roleCode: 'accounts' }]), [HC]);
    expect(mayOpenAddress(accounts, '/app/accounts/claims')).toBe(true);
    expect(mayOpenAddress(accounts, '/app/accounts/deals/BX-1')).toBe(true);
    expect(mayOpenAddress(accounts, '/app')).toBe(true);
    expect(mayOpenAddress(accounts, '/app/approvals')).toBe(false);
  });
});

describe('menu counts from the existing reads', () => {
  const NONE: MenuCountRoles = { bookings: false, purchase: false, flight: false, visa: false, accounts: false, branchManager: false, quotations: false };
  const work = (extra: Partial<MyWorkCounts>): MyWorkCounts => ({
    waitingForMe: 0,
    returnedToMe: 0,
    missingDetails: 0,
    intakeNeeded: 0,
    receiptsToVerify: null,
    requestsToApprove: null,
    ...extra,
  });
  const money = (extra: Partial<SupplierMoneyHomeCounts>): SupplierMoneyHomeCounts => ({
    requestsToApprove: null,
    purchaseTasksNotTaken: null,
    purchaseWaitingForGoAhead: null,
    purchaseCostsWaitingForManager: null,
    paymentRequestsReturned: null,
    supplierInvoicesMissing: null,
    goAheadToApprove: null,
    supplierPaymentsToApprove: null,
    supplierPaymentsToRecord: null,
    supplierPaymentsToVerify: null,
    supplierDocumentsToReview: null,
    fundingToApprove: null,
    fundingToRecover: null,
    managerApprovals: null,
    flightFaresToApprove: null,
    flightPaymentsReturned: null,
    flightPaymentsMissing: null,
    ...extra,
  });

  it('Accounts: each list gets its own count; disjoint stages are added; Bookings to review joins To check when Accounts is the only role counted', () => {
    const counts = menuCountsFrom(
      {
        myWork: work({ waitingForMe: 4, receiptsToVerify: 2, claimsToProcess: 1, expensesToReview: 0 }),
        supplierMoney: money({ goAheadToApprove: 3, supplierPaymentsToApprove: 1, supplierPaymentsToRecord: 2, supplierPaymentsToVerify: null, supplierDocumentsToReview: 5, fundingToApprove: 0, fundingToRecover: 1 }),
      },
      { ...NONE, accounts: true },
    );
    expect(counts).toEqual({
      '/app/accounts': 6,
      '/app/accounts/claims': 1,
      '/app/accounts/expenses': 0,
      '/app/accounts/go-ahead': 3,
      '/app/accounts/supplier-payments': 3,
      '/app/accounts/supplier-invoices': 5,
      '/app/accounts/funding': 1,
    });
    // With Sales too, waitingForMe mixes roles: only the receipts count for To check.
    expect(menuCountsFrom({ myWork: work({ waitingForMe: 4, receiptsToVerify: 2 }) }, { ...NONE, accounts: true, bookings: true })['/app/accounts']).toBe(2);
  });

  it('a failed read shows "count not known" only on the lists it would have counted; a null count shows nothing', () => {
    const counts = menuCountsFrom({ myWork: 'failed', supplierMoney: money({ goAheadToApprove: null }) }, { ...NONE, accounts: true });
    expect(counts['/app/accounts']).toBe('unknown');
    expect(counts['/app/accounts/claims']).toBe('unknown');
    expect(counts['/app/accounts/go-ahead']).toBeUndefined();
    expect(menuCountsFrom({ flight: 'failed' }, { ...NONE, flight: true })).toEqual({ '/app/flight': 'unknown' });
  });

  it('each desk gets only its own count; a Purchase person never gets an Accounts or Approvals count', () => {
    const src = {
      myWork: work({ waitingForMe: 9, receiptsToVerify: 2, visaTasksWaiting: 4, quotationDraftsToFinish: 1 }),
      supplierMoney: money({ purchaseTasksNotTaken: 3, goAheadToApprove: 7, managerApprovals: 2 }),
      flight: { flightDealsNotTaken: 2, flightDealsMine: 1 },
    };
    expect(menuCountsFrom(src, { ...NONE, purchase: true })).toEqual({ '/app/purchase': 3 });
    expect(menuCountsFrom(src, { ...NONE, flight: true })).toEqual({ '/app/flight': 3 });
    expect(menuCountsFrom(src, { ...NONE, visa: true })).toEqual({ '/app/visa': 4 });
    expect(menuCountsFrom(src, { ...NONE, branchManager: true, quotations: true })).toEqual({ '/app/approvals': 2, '/app/quotations': 1 });
    // Deals has no count: its Home rows overlap, and the menu never invents a total.
    expect(Object.keys(menuCountsFrom(src, { ...NONE, bookings: true, quotations: true }))).toEqual(['/app/quotations']);
  });

  it('only the reads a person needs are made (Super Admin and Sales without quotations: none)', () => {
    expect(menuCountReads(NONE)).toEqual({ myWork: false, supplierMoney: false, flight: false });
    expect(menuCountReads({ ...NONE, purchase: true })).toEqual({ myWork: false, supplierMoney: true, flight: false });
    expect(menuCountReads({ ...NONE, accounts: true })).toEqual({ myWork: true, supplierMoney: true, flight: false });
    expect(menuCountReads({ ...NONE, flight: true })).toEqual({ myWork: false, supplierMoney: false, flight: true });
    const roles = homeWorkRoles(staff([{ roleCode: 'super_admin' }]), [HC]);
    expect(menuCountReads({ ...roles, quotations: false })).toEqual({ myWork: false, supplierMoney: false, flight: false });
  });

  it('menuFor: an Accounts section shows the sum of its tabs and opens the first tab with something waiting', () => {
    const v = viewerOf(staff([{ roleCode: 'accounts' }]), [HC]);
    const counts: MenuCounts = { '/app/accounts/go-ahead': 0, '/app/accounts/supplier-invoices': 4, '/app/accounts/funding': 'unknown', '/app/accounts/claims': 'unknown' };
    const accounts = menuFor(v, counts).groups.find((g) => g.key === 'accounts')!;
    const out = accounts.links.find((l) => l.key === 'accounts:money-out')!;
    expect(out).toMatchObject({ count: 4, href: '/app/accounts/supplier-invoices' });
    expect(accounts.links.find((l) => l.key === 'accounts:to-check')).toMatchObject({ count: 'unknown', href: '/app/accounts' });
    expect(accounts.links.find((l) => l.key === 'accounts:tally')).toMatchObject({ count: null, href: '/app/accounts/tally' });
    // A folded group shows its total; "unknown" only when nothing in it is known.
    expect(groupCount(accounts)).toBe(4);
    expect(groupCount({ links: [{ count: 'unknown' }, { count: null }] as never })).toBe('unknown');
    expect(groupCount({ links: [{ count: null }] as never })).toBeNull();
  });

  it('counts change no link and no group', () => {
    for (const { name, viewer } of PEOPLE.slice(0, 60)) {
      const plain = menuFor(viewer);
      const counted = menuFor(viewer, { '/app/accounts': 'unknown', '/app/purchase': 3, '/app/accounts/funding': 2 });
      expect(counted.groups.map((g) => g.links.map((l) => l.key)), name).toEqual(plain.groups.map((g) => g.links.map((l) => l.key)));
    }
  });
});

describe('menu group fold state (remembered on this device)', () => {
  it('reads only known group keys; anything unreadable means nothing folded', () => {
    expect(FOLD_STORAGE_KEY).toBe('tn-nav-folded');
    expect(parseFoldedGroups('["accounts","desks","nonsense"]')).toEqual(['desks', 'accounts']);
    expect(parseFoldedGroups('{"accounts":true}')).toEqual([]);
    expect(parseFoldedGroups('not json')).toEqual([]);
    expect(parseFoldedGroups(null)).toEqual([]);
    // The top group has no heading and can never be folded.
    expect(parseFoldedGroups('["top"]')).toEqual([]);
  });

  it('folding and unfolding change only that group', () => {
    expect(withGroupFolded([], 'accounts', false)).toEqual(['accounts']);
    expect(withGroupFolded(['accounts'], 'desks', false)).toEqual(['desks', 'accounts']);
    expect(withGroupFolded(['desks', 'accounts'], 'accounts', true)).toEqual(['desks']);
    expect(withGroupFolded(['desks'], 'desks', false)).toEqual(['desks']);
  });

  it('a folded group stays folded, except the group of the current page, which opens until folded again on that page', () => {
    expect(isGroupOpen('desks', ['desks'], 'accounts')).toBe(false);
    expect(isGroupOpen('accounts', ['desks'], 'accounts')).toBe(true);
    expect(isGroupOpen('accounts', ['accounts'], 'accounts')).toBe(true);
    expect(isGroupOpen('accounts', ['accounts'], 'accounts', ['accounts'])).toBe(false);
    expect(isGroupOpen('sales', [], undefined)).toBe(true);
  });
});

describe('quick search "/" key', () => {
  const el = (selector: string | null, editable = false) => ({ isContentEditable: editable, closest: (s: string) => (selector && s.split(', ').includes(selector) ? {} : null) });
  const key = (target: unknown, extra: Partial<KeyboardEvent> = {}) =>
    ({ key: '/', ctrlKey: false, metaKey: false, altKey: false, isComposing: false, defaultPrevented: false, target, ...extra }) as unknown as KeyboardEvent;

  it('opens on "/" from the page, never while typing in a field or with a dialog open', () => {
    expect(opensQuickSearch(key(el(null)), false)).toBe(true);
    for (const field of ['input', 'textarea', 'select', '[role="combobox"]']) expect(opensQuickSearch(key(el(field)), false), field).toBe(false);
    expect(opensQuickSearch(key(el(null, true)), false)).toBe(false);
    expect(opensQuickSearch(key(el(null)), true)).toBe(false);
    expect(opensQuickSearch(key(el(null), { ctrlKey: true }), false)).toBe(false);
    expect(opensQuickSearch(key(el(null), { key: '?' }), false)).toBe(false);
    expect(opensQuickSearch(key(el(null), { isComposing: true }), false)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('frame header line (N6)', () => {
  const base: ShellViewer = { displayName: 'x', primaryRole: 'Sales', primaryBranch: 'Jodhpur', canAdministerStaff: false, canManageGrants: false };
  it('one branch: the branch; several: the company name; several companies: "All companies"', () => {
    expect(frameScopeLine(base)).toBe('Jodhpur branch');
    expect(frameScopeLine({ ...base, memberships: [{ roleName: 'Sales', branchName: 'Jodhpur', isHeadOffice: false }, { roleName: 'Accounts', branchName: 'Jodhpur', isHeadOffice: false }] })).toBe('Jodhpur branch');
    expect(
      frameScopeLine({
        ...base,
        memberships: [
          { roleName: 'Sales', branchName: 'Jodhpur', isHeadOffice: true, companyName: 'Holiday Chacha Pvt LTD' },
          { roleName: 'Manager', branchName: 'Delhi', isHeadOffice: false, companyName: 'Holiday Chacha Pvt LTD' },
        ],
      }),
    ).toBe('Holiday Chacha Pvt LTD');
    expect(
      frameScopeLine({
        ...base,
        memberships: [
          { roleName: 'Sales', branchName: 'Jodhpur', isHeadOffice: false, companyName: 'Company A' },
          { roleName: 'Sales', branchName: 'Delhi', isHeadOffice: false, companyName: 'Company B' },
        ],
      }),
    ).toBe('All companies');
    // Older callers without companies fall back to the company name.
    expect(frameScopeLine({ ...base, memberships: [{ roleName: 'Sales', branchName: 'Jodhpur', isHeadOffice: false }, { roleName: 'Sales', branchName: 'Delhi', isHeadOffice: false }] })).toBe('Holiday Chacha Pvt LTD');
  });
});

// Keep the SectionsViewer type honest: the frame's viewer satisfies it.
const _typeCheck: SectionsViewer = viewerOf(staff([{ roleCode: 'sales' }]), [HC]);
void _typeCheck;
