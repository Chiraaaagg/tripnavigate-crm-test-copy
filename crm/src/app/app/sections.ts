import type { MyWorkCounts } from '@/modules/fulfilment/contracts';
import { SETTINGS_PREFIX, settingsHomeHref, settingsTabsFor } from '@/modules/settings/contracts';
import type { SupplierMoneyHomeCounts } from '@/modules/supplier-money/contracts';
import {
  type AccountsCounts,
  type AccountsSection,
  type AccountsSectionKey,
  accountsSectionCount,
  accountsSectionHref,
  accountsSectionsFor,
} from '@/views/accounts-desk/sections';
import type { ShellViewer } from '@/views/StaffShell';

/*
 * UX redesign R1 (build plan 4.4, CQ-7): the one list of "sections this
 * person may see". The menu (desktop sidebar and phone Menu sheet) reads it;
 * Home and the page gates can read the same answer through mayOpenAddress()
 * so the three can never disagree.
 *
 * It reads exactly the flags the frame already had (shellPermissions and
 * accountsDeskLinks in shell-permissions.ts) and adds no rule: every address
 * it offers is one today's menu offered to the same person
 * (tests/unit/r1-sections.test.ts proves this for every role combination).
 * Navigation convenience only: every page, command and database policy still
 * decides access on its own.
 *
 * Groups (design plan 1.1, owner answer C1 and D5): a top group without a
 * heading (Home, Approvals), Sales, Desks, Accounts (the six sections), and
 * Settings pinned at the bottom. A group shows only when the person has a
 * link in it; a group with one link shows no heading.
 *
 * Itineraries, Payment requests and Rate contracts keep their own links in
 * R1: the tabs that replace them (Quotations, Purchase tasks, Suppliers) are
 * built in R2 and R3. Removing a link is then a one-line change here.
 *
 * Plain data and pure functions only (no reads), so the browser bundle can
 * use it too. Icons are named here, next to the link (CQ-6); NavLinks maps
 * each name to its picture.
 */

export type MenuGroupKey = 'top' | 'sales' | 'desks' | 'accounts';

/** Group headings (the top group has none). */
export const MENU_GROUP_LABEL: Record<MenuGroupKey, string> = { top: '', sales: 'Sales', desks: 'Desks', accounts: 'Accounts' };

export const MENU_GROUP_ORDER: readonly MenuGroupKey[] = ['top', 'sales', 'desks', 'accounts'];

/** One picture name per link (decorative; the words are the link's name). */
export type SectionIcon =
  | 'house'
  | 'list-checks'
  | 'inbox'
  | 'briefcase'
  | 'file-text'
  | 'map'
  | 'calendar-clock'
  | 'clipboard-list'
  | 'receipt-text'
  | 'plane'
  | 'stamp'
  | 'building-2'
  | 'scroll-text'
  | 'clipboard-check'
  | 'arrow-down-to-line'
  | 'arrow-up-from-line'
  | 'landmark'
  | 'folder-search'
  | 'book-check'
  | 'settings';

export type SectionKey =
  | 'home'
  | 'approvals'
  | 'leads'
  | 'deals'
  | 'quotations'
  | 'itineraries'
  | 'own-dues'
  | 'purchase'
  | 'payment-requests'
  | 'flight'
  | 'visa'
  | 'suppliers'
  | 'rate-contracts'
  | `accounts:${AccountsSectionKey}`
  | 'settings';

export interface SectionLink {
  key: SectionKey;
  href: string;
  label: string;
  group: MenuGroupKey | 'settings';
  icon: SectionIcon;
  /** More addresses that mark this link as the current page (an Accounts section's tabs; every Settings page). */
  prefixes?: readonly string[];
  /** The words read after the count ("3 waiting"). */
  countWord?: string;
  /** Accounts sections only: the tabs this person may open (all existing addresses). */
  tabs?: readonly string[];
}

/** The flags the sections read: the frame's viewer without the name and role words. */
export type SectionsViewer = Omit<ShellViewer, 'displayName' | 'primaryRole' | 'primaryBranch' | 'memberships'>;

/** A count per address: a number, 'unknown' when the read failed, absent when the address has no count. */
export type MenuCounts = AccountsCounts;

const ACCOUNTS_ICON: Record<AccountsSectionKey, SectionIcon> = {
  'to-check': 'clipboard-check',
  'money-in': 'arrow-down-to-line',
  'money-out': 'arrow-up-from-line',
  'cash-bank': 'landmark',
  records: 'folder-search',
  tally: 'book-check',
};

/** The Accounts sections this person may open; "Dues" alone (Sales, own Deals) moves to the Sales group. */
function accountsSectionsOf(v: SectionsViewer): { sections: AccountsSection[]; ownDuesInSales: boolean } {
  const withoutOwnDues = accountsSectionsFor({ ...v, canSeeOwnDues: false });
  if (v.canSeeOwnDues && withoutOwnDues.length === 0) return { sections: [], ownDuesInSales: true };
  return { sections: accountsSectionsFor(v), ownDuesInSales: false };
}

/** The address of the pinned Settings link: the person's first Settings area, as settingsHomeHref gives it (none: no Settings link). */
function settingsHref(v: SectionsViewer): string | null {
  const tabs = settingsTabsFor({
    canAdministerStaff: v.canAdministerStaff,
    canManageGrants: v.canManageGrants,
    canManageIntegration: !!v.canManageIntegration,
    canOpenBitrixConnection: !!v.canOpenBitrixConnection,
    canManageFinancePolicy: !!v.canManageFinancePolicy,
    canImport: !!v.canImport,
  });
  return settingsHomeHref(tabs);
}

/**
 * Every link the person's menu shows, in menu order, before counts. An
 * Accounts section points at its first tab here; menuFor() moves it to the
 * first tab with something waiting once counts are known.
 */
export function sectionsFor(v: SectionsViewer): SectionLink[] {
  const out: SectionLink[] = [];
  const add = (link: SectionLink) => out.push(link);

  add({ key: 'home', href: '/app', label: 'Home', group: 'top', icon: 'house' });
  if (v.canSeeApprovals) add({ key: 'approvals', href: '/app/approvals', label: 'Approvals', group: 'top', icon: 'list-checks', countWord: 'waiting for you' });

  if (v.canSeeLeads) add({ key: 'leads', href: '/app/leads', label: 'Leads', group: 'sales', icon: 'inbox' });
  add({ key: 'deals', href: '/app/deals', label: 'Deals', group: 'sales', icon: 'briefcase' });
  if (v.canSeeQuotations) {
    add({ key: 'quotations', href: '/app/quotations', label: 'Quotations', group: 'sales', icon: 'file-text', countWord: 'drafts to finish' });
    add({ key: 'itineraries', href: '/app/itineraries', label: 'Itineraries', group: 'sales', icon: 'map' });
  }
  const { sections, ownDuesInSales } = accountsSectionsOf(v);
  if (ownDuesInSales) add({ key: 'own-dues', href: '/app/accounts/dues', label: 'Dues', group: 'sales', icon: 'calendar-clock' });

  if (v.canSeePurchaseTasks) add({ key: 'purchase', href: '/app/purchase', label: 'Purchase tasks', group: 'desks', icon: 'clipboard-list', countWord: 'not taken yet' });
  if (v.canSeePurchasePayments) add({ key: 'payment-requests', href: '/app/purchase/payments', label: 'Payment requests', group: 'desks', icon: 'receipt-text' });
  if (v.canSeeFlightTasks) add({ key: 'flight', href: '/app/flight', label: 'Flight tasks', group: 'desks', icon: 'plane', countWord: 'waiting' });
  if (v.canSeeVisaDesk) add({ key: 'visa', href: '/app/visa', label: 'Visa and passport tasks', group: 'desks', icon: 'stamp', countWord: 'waiting' });
  if (v.canSeePurchaseTasks) add({ key: 'suppliers', href: '/app/purchase/suppliers', label: 'Suppliers', group: 'desks', icon: 'building-2' });
  // N5: one fixed place for Rate contracts (next to Suppliers) for Purchase, Managers and Accounts alike.
  if (v.canSeePurchaseTasks || v.canSeeAccountsDesk) {
    add({ key: 'rate-contracts', href: '/app/purchase/rate-contracts', label: 'Rate contracts', group: 'desks', icon: 'scroll-text' });
  }

  for (const s of sections) {
    const tabs = s.tabs.map((t) => t.href);
    add({ key: `accounts:${s.key}`, href: tabs[0]!, label: s.label, group: 'accounts', icon: ACCOUNTS_ICON[s.key], prefixes: tabs, tabs, countWord: 'waiting' });
  }

  const settings = settingsHref(v);
  if (settings) add({ key: 'settings', href: settings, label: 'Settings', group: 'settings', icon: 'settings', prefixes: [SETTINGS_PREFIX] });
  return out;
}

/** True when the person has a menu link (or an Accounts section tab) for this section. */
export function maySeeSection(v: SectionsViewer, key: SectionKey): boolean {
  return sectionsFor(v).some((s) => s.key === key);
}

/**
 * Every address the menu lets this person reach: each link, every tab of
 * their Accounts sections and the pinned Settings link. Settings tabs are
 * decided by settingsTabsFor (the Settings frame), so only the first is here.
 */
export function reachableAddresses(v: SectionsViewer): string[] {
  return [...new Set(sectionsFor(v).flatMap((s) => [s.href, ...(s.tabs ?? [])]))];
}

const pathOf = (href: string) => href.split(/[?#]/)[0]!.replace(/\/+$/, '') || '/';

/**
 * True when the address (or a page under it) is one of this person's menu
 * addresses. For Home and page gates that want the menu's answer; a page
 * still checks access on its own.
 */
export function mayOpenAddress(v: SectionsViewer, href: string): boolean {
  const path = pathOf(href);
  return sectionsFor(v).some((s) =>
    [s.href, ...(s.prefixes ?? [])].some((p) => {
      const base = pathOf(p);
      return base === '/app' ? path === '/app' : path === base || path.startsWith(`${base}/`);
    }),
  );
}

// ---------------------------------------------------------------------------
// The grouped menu with counts
// ---------------------------------------------------------------------------

export interface MenuLink extends SectionLink {
  /** A number to show, 'unknown' (dash, read out as "count not known"), or null for no badge. */
  count: number | 'unknown' | null;
}

export interface MenuGroup {
  key: MenuGroupKey;
  /** Empty for the top group and for a group with one link (no heading). */
  label: string;
  links: MenuLink[];
}

export interface Menu {
  groups: MenuGroup[];
  /** The pinned Settings link, or null. */
  settings: MenuLink | null;
}

/** An Accounts section as the shared section helpers expect it (only the tab addresses matter to them). */
const asSection = (link: SectionLink): AccountsSection => ({
  key: link.key.slice('accounts:'.length) as AccountsSectionKey,
  label: link.label,
  tabs: (link.tabs ?? []).map((href) => ({ href, label: '', visible: () => true })),
});

/**
 * The person's menu, grouped, with counts. An Accounts section shows the sum
 * of its tabs and opens its first tab with something waiting, otherwise its
 * first tab (design plan 1.1; the shared rules accountsSectionCount and
 * accountsSectionHref). Counts change no link and no group: a count that is
 * not known shows as a dash, a missing count shows nothing.
 */
export function menuFor(v: SectionsViewer, counts: MenuCounts = {}): Menu {
  return menuFromLinks(sectionsFor(v), counts);
}

/** menuFor() over links already worked out (the frame passes sectionsFor() to the browser, counts arrive later). */
export function menuFromLinks(sections: readonly SectionLink[], counts: MenuCounts = {}): Menu {
  const links: MenuLink[] = sections.map((s) =>
    s.tabs
      ? { ...s, href: accountsSectionHref(asSection(s), counts), count: accountsSectionCount(asSection(s), counts) }
      : { ...s, count: counts[s.href] ?? null },
  );
  const groups = MENU_GROUP_ORDER.map((key) => {
    const list = links.filter((l) => l.group === key);
    return { key, label: list.length > 1 ? MENU_GROUP_LABEL[key] : '', links: list };
  }).filter((g) => g.links.length > 0);
  return { groups, settings: links.find((l) => l.group === 'settings') ?? null };
}

/** The total badge of a folded group: the sum of what is known; 'unknown' only when nothing is known; null when no link counts. */
export function groupCount(group: Pick<MenuGroup, 'links'>): number | 'unknown' | null {
  const values = group.links.map((l) => l.count).filter((c) => c !== null);
  if (values.length === 0) return null;
  const known = values.filter((c): c is number => typeof c === 'number');
  if (known.length === 0) return 'unknown';
  return known.reduce((a, n) => a + n, 0);
}

/**
 * The current link: the longest of each link's address and extra prefixes
 * that equals the path or sits above it. "/app" marks only Home.
 */
export function currentMenuKey(links: ReadonlyArray<Pick<SectionLink, 'key' | 'href' | 'prefixes'>>, path: string | null | undefined): SectionKey | undefined {
  if (!path) return undefined;
  const p = pathOf(path);
  let best: { key: SectionKey; length: number } | undefined;
  for (const link of links) {
    for (const prefix of [link.href, ...(link.prefixes ?? [])].map(pathOf)) {
      const hit = prefix === '/app' ? p === '/app' : p === prefix || p.startsWith(`${prefix}/`);
      if (hit && (!best || prefix.length > best.length)) best = { key: link.key, length: prefix.length };
    }
  }
  return best?.key;
}

// ---------------------------------------------------------------------------
// Counts from the reads Home already makes (no new read, build plan 2.4 N3)
// ---------------------------------------------------------------------------

/** The Flight count keys the menu uses (flight_home_counts). */
export interface FlightMenuCounts {
  flightDealsNotTaken?: number | null;
  flightDealsMine?: number | null;
}

/** Which roles a count is meant for (the same flags Home uses, homeWorkRoles). */
export interface MenuCountRoles {
  /** Sales or Manager (my_work_counts adds their drafts to waitingForMe). */
  bookings: boolean;
  purchase: boolean;
  flight: boolean;
  visa: boolean;
  accounts: boolean;
  branchManager: boolean;
  quotations: boolean;
}

/** The result of one existing read: its value, or 'failed' when it could not be read. Absent = not read (not for this person). */
export interface MenuCountSources {
  myWork?: MyWorkCounts | 'failed';
  supplierMoney?: SupplierMoneyHomeCounts | 'failed';
  flight?: FlightMenuCounts | 'failed';
}

const num = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/**
 * Map the existing count reads to menu addresses. Only counts that mean
 * exactly "waiting in this list" are used, and only for the role the
 * database counts them for; overlapping counts (for example the Deals rows on
 * Home) are never added up, so Deals has no count. A failed read gives
 * 'unknown' on the addresses it would have counted; a count the database
 * returned as null (not for this person) gives nothing. Several disjoint
 * counts for one list (supplier payments to approve, to record, to verify)
 * are summed.
 */
export function menuCountsFrom(src: MenuCountSources, roles: MenuCountRoles): MenuCounts {
  const out: Record<string, number | 'unknown'> = {};
  const put = (href: string, failed: boolean, values: Array<number | null | undefined>) => {
    if (failed) {
      out[href] = 'unknown';
      return;
    }
    const known = values.filter(num);
    if (known.length > 0) out[href] = known.reduce((a, n) => a + n, 0);
  };
  const work = src.myWork === 'failed' ? null : src.myWork;
  const workFailed = src.myWork === 'failed';
  const money = src.supplierMoney === 'failed' ? null : src.supplierMoney;
  const moneyFailed = src.supplierMoney === 'failed';
  const flight = src.flight === 'failed' ? null : src.flight;
  const flightFailed = src.flight === 'failed';

  if (roles.purchase && src.supplierMoney !== undefined) put('/app/purchase', moneyFailed, [money?.purchaseTasksNotTaken]);
  if (roles.flight && src.flight !== undefined) put('/app/flight', flightFailed, [flight?.flightDealsNotTaken, flight?.flightDealsMine]);
  if (roles.visa && src.myWork !== undefined) put('/app/visa', workFailed, [work?.visaTasksWaiting]);
  if (roles.quotations && src.myWork !== undefined) put('/app/quotations', workFailed, [work?.quotationDraftsToFinish]);
  if (roles.branchManager && src.supplierMoney !== undefined) put('/app/approvals', moneyFailed, [money?.managerApprovals ?? money?.requestsToApprove]);
  if (roles.accounts) {
    if (src.myWork !== undefined) {
      // "Bookings to review" is waitingForMe only when Accounts is the one role it counts for (as on Home).
      const reviewsOnly = !roles.bookings && !roles.purchase && !roles.visa;
      put('/app/accounts', workFailed, [work?.receiptsToVerify, reviewsOnly ? work?.waitingForMe : null]);
      put('/app/accounts/claims', workFailed, [work?.claimsToProcess]);
      put('/app/accounts/expenses', workFailed, [work?.expensesToReview]);
    }
    if (src.supplierMoney !== undefined) {
      put('/app/accounts/go-ahead', moneyFailed, [money?.goAheadToApprove]);
      put('/app/accounts/supplier-payments', moneyFailed, [money?.supplierPaymentsToApprove, money?.supplierPaymentsToRecord, money?.supplierPaymentsToVerify]);
      put('/app/accounts/supplier-invoices', moneyFailed, [money?.supplierDocumentsToReview]);
      put('/app/accounts/funding', moneyFailed, [money?.fundingToApprove, money?.fundingToRecover]);
    }
  }
  return out;
}

/** Which existing reads the menu needs for these roles (so a person with none of them costs no read). */
export function menuCountReads(roles: MenuCountRoles): { myWork: boolean; supplierMoney: boolean; flight: boolean } {
  return {
    myWork: roles.visa || roles.quotations || roles.accounts,
    supplierMoney: roles.purchase || roles.branchManager || roles.accounts,
    flight: roles.flight,
  };
}
