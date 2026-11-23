import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { MenuCounts } from '@/app/app/sections';
import { isUiPreviewEnabled } from '@/lib/config';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import { previewMenuSearchDeals, previewMenuSearchDealsError, previewMenuSearchLeads } from './actions';

/**
 * LOCAL DESIGN-REVIEW GALLERY of the R1 staff frame (UX redesign build plan
 * 4.4): the grouped, foldable menu with counts, pinned Settings, the bell in
 * the header row and the quick search, for four people, with synthetic data.
 * 404 unless the preview gallery is enabled (isUiPreviewEnabled), so it never
 * serves on Vercel. tests/e2e/app-frame.e2e.ts opens it.
 *
 * Query: person=accounts|admin-accounts|manager|four-roles|purchase,
 * counts=known|unknown|none, search=closed|results|none|error, path=<the
 * address the menu should mark as current>.
 */

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Staff frame gallery' };

const NO_RIGHTS = { canAdministerStaff: false, canManageGrants: false };
const ACCOUNTS_FLAGS = { canUseAccounts: true, canCheckCustomers: true, canSeeAccountsDesk: true, canImport: true };
const ADMIN_FLAGS = { canAdministerStaff: true, canManageGrants: true, canManageIntegration: true, canOpenBitrixConnection: true, canSeeLeads: true, canImport: true };

const PEOPLE: Record<string, { viewer: ShellViewer; path: string; counts: MenuCounts }> = {
  accounts: {
    viewer: {
      displayName: 'Synthetic Accounts Jodhpur',
      primaryRole: 'Accounts',
      primaryBranch: 'Jodhpur',
      memberships: [{ roleName: 'Accounts', branchName: 'Jodhpur', isHeadOffice: true, companyName: 'Holiday Chacha Pvt LTD' }],
      ...NO_RIGHTS,
      ...ACCOUNTS_FLAGS,
    },
    path: '/app/accounts/supplier-payments',
    counts: { '/app/accounts': 3, '/app/accounts/claims': 1, '/app/accounts/go-ahead': 0, '/app/accounts/supplier-payments': 4, '/app/accounts/supplier-invoices': 2, '/app/accounts/funding': 0, '/app/accounts/expenses': 0 },
  },
  'admin-accounts': {
    viewer: {
      displayName: 'Synthetic Admin Accounts Jodhpur',
      primaryRole: 'Super Admin',
      primaryBranch: 'Jodhpur',
      memberships: [
        { roleName: 'Super Admin', branchName: 'Jodhpur', isHeadOffice: true, companyName: 'Holiday Chacha Pvt LTD' },
        { roleName: 'Accounts', branchName: 'Jodhpur', isHeadOffice: true, companyName: 'Holiday Chacha Pvt LTD' },
      ],
      ...ADMIN_FLAGS,
      ...ACCOUNTS_FLAGS,
    },
    path: '/app/accounts',
    counts: { '/app/accounts': 2, '/app/accounts/claims': 0, '/app/accounts/supplier-payments': 1 },
  },
  manager: {
    viewer: {
      displayName: 'Synthetic Manager Delhi',
      primaryRole: 'Manager',
      primaryBranch: 'Delhi',
      memberships: [{ roleName: 'Manager', branchName: 'Delhi', isHeadOffice: false, companyName: 'Holiday Chacha Pvt LTD' }],
      ...NO_RIGHTS,
      canSeeLeads: true,
      canSeeQuotations: true,
      canSeePurchaseTasks: true,
      canSeeApprovals: true,
      canSeeFlightTasks: true,
      canSeeVisaDesk: true,
      canSeeBranchMoney: true,
    },
    path: '/app/approvals',
    counts: { '/app/approvals': 5, '/app/quotations': 2 },
  },
  'four-roles': {
    viewer: {
      displayName: 'Synthetic Owner Jodhpur',
      primaryRole: 'Super Admin',
      primaryBranch: 'Jodhpur',
      memberships: [
        { roleName: 'Super Admin', branchName: 'Jodhpur', isHeadOffice: true, companyName: 'Holiday Chacha Pvt LTD' },
        { roleName: 'Sales', branchName: 'Jodhpur', isHeadOffice: true, companyName: 'Holiday Chacha Pvt LTD' },
        { roleName: 'Manager', branchName: 'Delhi', isHeadOffice: false, companyName: 'Holiday Chacha Pvt LTD' },
        { roleName: 'Accounts', branchName: 'Ahmedabad', isHeadOffice: false, companyName: 'Holiday Chacha Pvt LTD' },
      ],
      ...ADMIN_FLAGS,
      ...ACCOUNTS_FLAGS,
      canSeeQuotations: true,
      canSeePurchaseTasks: true,
      canSeeApprovals: true,
      canSeeFlightTasks: true,
      canSeeVisaDesk: true,
    },
    path: '/app/deals',
    counts: { '/app/approvals': 1, '/app/quotations': 3, '/app/accounts': 4, '/app/accounts/supplier-payments': 2 },
  },
  purchase: {
    viewer: {
      displayName: 'Synthetic Purchase Jodhpur',
      primaryRole: 'Purchase',
      primaryBranch: 'Jodhpur',
      memberships: [{ roleName: 'Purchase', branchName: 'Jodhpur', isHeadOffice: false, companyName: 'Holiday Chacha Pvt LTD' }],
      ...NO_RIGHTS,
      canSeePurchaseTasks: true,
      canSeePurchasePayments: true,
    },
    path: '/app/purchase',
    counts: { '/app/purchase': 3 },
  },
};

const unknownOf = (counts: MenuCounts): MenuCounts => Object.fromEntries(Object.keys(counts).map((k) => [k, 'unknown' as const]));

export default async function MenuGalleryPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (!isUiPreviewEnabled(process.env)) notFound();
  const q = await searchParams;
  const person = PEOPLE[q.person ?? 'accounts'] ?? PEOPLE.accounts!;
  const counts = q.counts === 'none' ? undefined : q.counts === 'unknown' ? unknownOf(person.counts) : person.counts;
  const mode = q.search ?? 'closed';
  const search = {
    deals: mode === 'error' ? previewMenuSearchDealsError : previewMenuSearchDeals,
    leads: person.viewer.canSeeLeads ? previewMenuSearchLeads : undefined,
    defaultOpen: mode !== 'closed',
    defaultQuery: mode === 'none' ? 'Nothing like this' : mode === 'closed' ? '' : 'BX-43',
  };
  return (
    <StaffShell viewer={person.viewer} currentPath={q.path ?? person.path} counts={counts} search={search}>
      <h1 className="m-0 text-2xl font-display text-ink">Staff frame preview</h1>
      <p className="mt-2 text-base text-quiet">Synthetic people and counts. The menu, the bell row and the quick search are the real frame.</p>
      <form className="mt-4 flex max-w-sm flex-col gap-1.5" action="#">
        <label htmlFor="preview-field" className="text-sm font-semibold text-ink">
          A field on the page
        </label>
        <input id="preview-field" name="note" className="rounded-control border border-line-strong px-3 py-2" />
      </form>
      <p className="mt-6">
        <Link href="/preview/ui-gallery/menu?person=four-roles">Four roles</Link>
      </p>
    </StaffShell>
  );
}
