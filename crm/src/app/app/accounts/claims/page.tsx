import type { Metadata } from 'next';
import { ACCOUNTS_CLAIMS_FILTERS, type AccountsClaimsFilter } from '@/modules/finance/contracts';
import { loadClaimsQueue } from '@/modules/finance/server/queries';
import { requireStaff } from '@/modules/identity/server/session';
import { B11NotInstalledView } from '@/views/b11/book-views';
import { AccountsClaimsListView } from '@/views/b11/accounts-claims';
import { FinanceNoAccessView, FinanceUnavailableView } from '@/views/finance-views';
import { financeRead } from '../finance-page-support';

// A-20 / DA-276
export const metadata: Metadata = { title: 'Reported payments' };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** B1.1b: advance claims reported by Sales, for Accounts (accounts_payment_claims). */
export default async function AccountsClaimsPage({ searchParams }: { searchParams: Promise<{ filter?: string | string[]; after?: string | string[] }> }) {
  const staff = await requireStaff();
  const sp = await searchParams;
  const raw = first(sp.filter);
  const filter: AccountsClaimsFilter = (ACCOUNTS_CLAIMS_FILTERS as readonly string[]).includes(raw ?? '') ? (raw as AccountsClaimsFilter) : 'reported';
  const page = await financeRead(() => loadClaimsQueue(staff, filter, first(sp.after) ?? null));
  if (!page.ok) {
    if (page.code === 'not_authorized') return <FinanceNoAccessView area="accounts" />;
    return <FinanceUnavailableView code={page.code} title="Reported payments" />;
  }
  if (!page.value) return <B11NotInstalledView title="Reported payments" text="Reported payments are not available on this CRM yet." />;
  const hrefs = Object.fromEntries(ACCOUNTS_CLAIMS_FILTERS.map((f) => [f, `/app/accounts/claims?filter=${f}`])) as Record<AccountsClaimsFilter, string>;
  const moreHref = page.value.nextAfter ? `/app/accounts/claims?filter=${filter}&after=${encodeURIComponent(page.value.nextAfter)}` : null;
  return <AccountsClaimsListView page={page.value} filter={filter} hrefs={hrefs} moreHref={moreHref} />;
}
