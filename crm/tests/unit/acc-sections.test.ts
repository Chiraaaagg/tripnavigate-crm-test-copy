import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SectionTabs } from '@/components/ui/section-tabs';
import {
  ACCOUNTS_SECTIONS,
  ACCOUNTS_SECTION_KEYS,
  accountsSection,
  accountsSectionCount,
  accountsSectionHref,
  accountsSectionOf,
  accountsSectionsFor,
  accountsTabOf,
  type AccountsSectionViewer,
} from '@/views/accounts-desk/sections';
import { navItemsFor, type ShellViewer } from '@/views/StaffShell';

/**
 * D5: the six Accounts sections (src/views/accounts-desk/sections.ts).
 * Every tab address exists as a page, and for every combination of the menu
 * flags a person sees exactly the Accounts addresses today's menu gives them
 * (navItemsFor), so the sections add no access rule and hide nothing.
 */

const app = join(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), 'src/app');
const FLAGS = ['canUseAccounts', 'canCheckCustomers', 'canSeeAccountsDesk', 'canSeeBranchMoney', 'canSeeOwnDues'] as const;

function combinations(): AccountsSectionViewer[] {
  const out: AccountsSectionViewer[] = [];
  for (let mask = 0; mask < 2 ** FLAGS.length; mask += 1) {
    out.push(Object.fromEntries(FLAGS.map((f, i) => [f, Boolean(mask & (1 << i))])) as AccountsSectionViewer);
  }
  return out;
}

const shell = (v: AccountsSectionViewer, extra: Partial<ShellViewer> = {}): ShellViewer => ({
  displayName: 'Sample Person',
  primaryRole: 'Accounts',
  primaryBranch: 'Jodhpur',
  canAdministerStaff: false,
  canManageGrants: false,
  ...v,
  ...extra,
});

/** Today's menu: Accounts-group links, plus the Sales "Dues" link (Work group); Rate contracts stays with Suppliers. */
function menuAccountsHrefs(viewer: ShellViewer): string[] {
  return navItemsFor(viewer)
    .filter((i) => (i.group === 'Accounts' || i.href === '/app/accounts/dues') && i.href !== '/app/purchase/rate-contracts')
    .map((i) => i.href)
    .sort();
}

describe('Accounts sections', () => {
  it('are the six owner-approved sections, in order (D5)', () => {
    expect(ACCOUNTS_SECTIONS.map((s) => s.label)).toEqual(['To check', 'Money in', 'Money out', 'Cash and bank', 'Records', 'Tally']);
    expect(ACCOUNTS_SECTION_KEYS).toEqual(['to-check', 'money-in', 'money-out', 'cash-bank', 'records', 'tally']);
  });

  it('use every tab address once, and every address is an existing page', () => {
    const hrefs = ACCOUNTS_SECTIONS.flatMap((s) => s.tabs.map((t) => t.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const href of hrefs) {
      expect(href).toMatch(/^\/app\/accounts(\/[a-z-]+)*$/);
      const page = join(app, href.replace(/^\/app/, 'app'), 'page.tsx');
      expect(existsSync(page), `${href} has a page at ${page}`).toBe(true);
    }
  });

  it.each(combinations().map((v) => [FLAGS.filter((f) => v[f]).join('+') || 'no flags', v] as const))(
    'show %s exactly the Accounts links of today’s menu',
    (_name, viewer) => {
      const fromSections = accountsSectionsFor(viewer).flatMap((s) => s.tabs.map((t) => t.href)).sort();
      expect(fromSections).toEqual(menuAccountsHrefs(shell(viewer)));
      // Holding Purchase tasks changes only the Rate contracts link, which is not in a section.
      expect(fromSections).toEqual(menuAccountsHrefs(shell(viewer, { canSeePurchaseTasks: true })));
      for (const s of accountsSectionsFor(viewer)) expect(s.tabs.length).toBeGreaterThan(0);
    },
  );

  it('give a Sales person with own dues only Money in › Dues, and a branch Manager no Money out', () => {
    const sales = accountsSectionsFor({ canSeeOwnDues: true });
    expect(sales.map((s) => [s.key, s.tabs.map((t) => t.label)])).toEqual([['money-in', ['Dues']]]);
    const manager = accountsSectionsFor({ canSeeBranchMoney: true });
    expect(manager.map((s) => s.key)).toEqual(['money-in', 'records']);
    expect(manager.find((s) => s.key === 'money-in')!.tabs.map((t) => t.label)).toEqual(['Dues', 'Customer documents', 'Small balances']);
  });

  it('find the section and tab of an address, including sub-pages and query strings', () => {
    expect(accountsTabOf('/app/accounts')?.tab.label).toBe('To check');
    expect(accountsTabOf('/app/accounts?filter=all')?.tab.label).toBe('To check');
    expect(accountsTabOf('/app/accounts/customers/C-1')?.tab.label).toBe('Customers');
    expect(accountsTabOf('/app/accounts/small-balances/monthly')?.section.key).toBe('money-in');
    expect(accountsTabOf('/app/accounts/tally/exports/x/left-out')?.section.key).toBe('tally');
    // The Accounts view of a Deal has its own record tabs; it falls under To check by address only.
    expect(accountsSectionOf('/app/accounts/deals/BX-1')?.key).toBe('to-check');
    expect(accountsSectionOf('/app/deals')).toBeNull();
  });

  it('count a section as the sum of its tabs, "unknown" only when nothing could be counted', () => {
    const out = accountsSection('money-out');
    expect(accountsSectionCount(out, {})).toBeNull();
    expect(accountsSectionCount(out, { '/app/accounts/go-ahead': 2, '/app/accounts/funding': 3 })).toBe(5);
    expect(accountsSectionCount(out, { '/app/accounts/go-ahead': 2, '/app/accounts/funding': 'unknown' })).toBe(2);
    expect(accountsSectionCount(out, { '/app/accounts/funding': 'unknown' })).toBe('unknown');
  });

  it('open the first tab with something waiting, otherwise the first tab', () => {
    const out = accountsSection('money-out');
    expect(accountsSectionHref(out, {})).toBe('/app/accounts/go-ahead');
    expect(accountsSectionHref(out, { '/app/accounts/go-ahead': 0, '/app/accounts/funding': 4 })).toBe('/app/accounts/funding');
    expect(accountsSectionHref(out, { '/app/accounts/go-ahead': 'unknown' })).toBe('/app/accounts/go-ahead');
  });
});

describe('<SectionTabs>', () => {
  const accounts: AccountsSectionViewer = { canUseAccounts: true, canCheckCustomers: true, canSeeAccountsDesk: true };
  const html = (props: Parameters<typeof SectionTabs>[0]) => renderToStaticMarkup(createElement(SectionTabs, props));

  it('renders the visible tabs as links, the current one with aria-current, counts with words', () => {
    const out = html({ section: 'money-out', currentHref: '/app/accounts/supplier-payments?page=2', viewer: accounts, counts: { '/app/accounts/supplier-payments': 5, '/app/accounts/funding': 'unknown' } });
    expect(out).toContain('aria-label="Money out sections"');
    expect(out.match(/<a /g)).toHaveLength(5);
    expect(out).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/app\/accounts\/supplier-payments"|<a[^>]*href="\/app\/accounts\/supplier-payments"[^>]*aria-current="page"/);
    expect(out.match(/aria-current="page"/g)).toHaveLength(1);
    expect(out).toContain('<span class="sr-only">, </span>5');
    expect(out).toContain('count not known');
    expect(out).not.toMatch(/\sstyle="/);
  });

  it('shows only the tabs the viewer may open, and nothing for a one-tab section', () => {
    const manager = html({ section: 'money-in', currentHref: '/app/accounts/dues', viewer: { canSeeBranchMoney: true } });
    expect(manager).not.toContain('/app/accounts/refunds');
    expect(manager).toContain('/app/accounts/small-balances');
    expect(html({ section: 'tally', currentHref: '/app/accounts/tally', viewer: accounts })).toBe('');
    expect(html({ section: 'money-in', currentHref: '/app/accounts/dues', viewer: { canSeeOwnDues: true } })).toBe('');
  });
});
