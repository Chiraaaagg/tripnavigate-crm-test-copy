import type { ShellViewer } from '@/views/StaffShell';

/*
 * D5: the six Accounts sections (owner answer D5: To check, Money in, Money
 * out, Cash and bank, Records, Tally). One list, lead-owned, read by the menu
 * (R1) and by the section tab strip on each Accounts page (ui/section-tabs.tsx).
 *
 * Every tab is an address that exists today; no page moves and no address
 * changes. Who sees a tab uses exactly the flags navItemsFor() reads today
 * (src/views/StaffShell.tsx, src/app/app/shell-permissions.ts): this file adds
 * no access rule. It is navigation only; every page, command and database
 * policy still decides access on its own. tests/unit/acc-sections.test.ts
 * proves both points (every address is a page; for every combination of
 * flags the visible tabs equal today's Accounts menu links).
 *
 * Tab lists follow design plan 1.1 and the approved prototype, limited to
 * pages that exist: the design plan's "Bills to release" (To check) has no
 * page of its own yet and is not listed; Rate contracts stays with Suppliers.
 */

export type AccountsSectionKey = 'to-check' | 'money-in' | 'money-out' | 'cash-bank' | 'records' | 'tally';

/** The menu flags a tab depends on (the same names as ShellViewer). */
export type AccountsSectionViewer = Pick<
  ShellViewer,
  'canUseAccounts' | 'canCheckCustomers' | 'canSeeAccountsDesk' | 'canSeeBranchMoney' | 'canSeeOwnDues'
>;

export interface AccountsTab {
  href: string;
  label: string;
  /** The same rule as the matching menu link in navItemsFor(). */
  visible: (v: AccountsSectionViewer) => boolean;
}

export interface AccountsSection {
  key: AccountsSectionKey;
  label: string;
  tabs: AccountsTab[];
}

const accounts = (v: AccountsSectionViewer) => !!v.canUseAccounts;
const desk = (v: AccountsSectionViewer) => !!v.canSeeAccountsDesk;
// navItemsFor: the Manager's view-only links appear only when the desk links do not.
const deskOrBranch = (v: AccountsSectionViewer) => !!v.canSeeAccountsDesk || !!v.canSeeBranchMoney;

export const ACCOUNTS_SECTIONS: readonly AccountsSection[] = [
  {
    key: 'to-check',
    label: 'To check',
    tabs: [
      { href: '/app/accounts', label: 'To check', visible: accounts },
      { href: '/app/accounts/claims', label: 'Reported payments', visible: accounts },
      { href: '/app/accounts/customers', label: 'Customers', visible: (v) => !!v.canCheckCustomers },
    ],
  },
  {
    key: 'money-in',
    label: 'Money in',
    tabs: [
      {
        href: '/app/accounts/dues',
        label: 'Dues',
        visible: (v) => deskOrBranch(v) || !!v.canSeeOwnDues,
      },
      { href: '/app/accounts/documents', label: 'Customer documents', visible: deskOrBranch },
      { href: '/app/accounts/refunds', label: 'Refunds', visible: desk },
      { href: '/app/accounts/small-balances', label: 'Small balances', visible: deskOrBranch },
    ],
  },
  {
    key: 'money-out',
    label: 'Money out',
    tabs: [
      { href: '/app/accounts/go-ahead', label: 'Hotel go-ahead', visible: accounts },
      { href: '/app/accounts/supplier-payments', label: 'Supplier payments', visible: accounts },
      { href: '/app/accounts/supplier-invoices', label: 'Supplier invoices', visible: accounts },
      { href: '/app/accounts/funding', label: 'Company funding', visible: accounts },
      { href: '/app/accounts/expenses', label: 'Department costs', visible: accounts },
    ],
  },
  {
    key: 'cash-bank',
    label: 'Cash and bank',
    tabs: [
      { href: '/app/accounts/cash', label: 'Branch cash', visible: accounts },
      { href: '/app/accounts/destinations', label: 'Company accounts', visible: accounts },
    ],
  },
  {
    key: 'records',
    label: 'Records',
    tabs: [{ href: '/app/accounts/records', label: 'Documents and money', visible: deskOrBranch }],
  },
  {
    key: 'tally',
    label: 'Tally',
    tabs: [{ href: '/app/accounts/tally', label: 'Tally', visible: desk }],
  },
];

export const ACCOUNTS_SECTION_KEYS = ACCOUNTS_SECTIONS.map((s) => s.key);

/** Counts per tab address: a number, 'unknown' when it could not be read, absent when the page has no count. */
export type AccountsCounts = Readonly<Partial<Record<string, number | 'unknown'>>>;

/** The sections this person may open, each with only their tabs; sections with no tab are left out. */
export function accountsSectionsFor(viewer: AccountsSectionViewer): AccountsSection[] {
  return ACCOUNTS_SECTIONS.map((s) => ({ ...s, tabs: s.tabs.filter((t) => t.visible(viewer)) })).filter((s) => s.tabs.length > 0);
}

export function accountsSection(key: AccountsSectionKey): AccountsSection {
  return ACCOUNTS_SECTIONS.find((s) => s.key === key)!;
}

const pathOf = (href: string) => href.split(/[?#]/)[0]!.replace(/\/+$/, '') || '/';

/** The tab an address belongs to: the longest tab path equal to it or above it ("/app/accounts/customers/C-1" → Customers). */
export function accountsTabOf(href: string, sections: readonly AccountsSection[] = ACCOUNTS_SECTIONS): { section: AccountsSection; tab: AccountsTab } | null {
  const path = pathOf(href);
  let best: { section: AccountsSection; tab: AccountsTab } | null = null;
  for (const section of sections) {
    for (const tab of section.tabs) {
      if ((path === tab.href || path.startsWith(`${tab.href}/`)) && (!best || tab.href.length > best.tab.href.length)) best = { section, tab };
    }
  }
  return best;
}

/** The section holding an address ("/app/accounts/deals/BX-1" → To check, by address; "/app/deals" → null). */
export function accountsSectionOf(href: string): AccountsSection | null {
  return accountsTabOf(href)?.section ?? null;
}

/** Menu badge for a section: the sum of its tabs' counts; 'unknown' when no tab could be counted; null when none has a count. */
export function accountsSectionCount(section: AccountsSection, counts: AccountsCounts): number | 'unknown' | null {
  const values = section.tabs.map((t) => counts[t.href]).filter((c) => c !== undefined);
  if (values.length === 0) return null;
  const known = values.filter((c): c is number => typeof c === 'number');
  if (known.length === 0) return 'unknown';
  return known.reduce((a, n) => a + n, 0);
}

/** Where the section's menu link goes: its first tab with something waiting, otherwise its first tab. */
export function accountsSectionHref(section: AccountsSection, counts: AccountsCounts): string {
  const waiting = section.tabs.find((t) => {
    const c = counts[t.href];
    return typeof c === 'number' && c > 0;
  });
  return (waiting ?? section.tabs[0]!).href;
}
