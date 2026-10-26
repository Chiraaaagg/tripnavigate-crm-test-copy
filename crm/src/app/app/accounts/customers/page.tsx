import type { Metadata } from 'next';
import { accountsRoleEntityIds } from '@/modules/parties/import-access';
import { requireStaff } from '@/modules/identity/server/session';
import { loadPartiesToCheck, PARTY_FILTER_LABEL, PARTY_FILTERS, PARTY_PAGE_SIZE, parsePageOffset, parsePartyFilter } from '@/modules/parties/server/party-check';
import { CustomersToCheckView } from '@/views/accounts/customer-check';
import { FinanceNoAccessView } from '@/views/finance-views';

export const metadata: Metadata = { title: 'Customers to check' };

/**
 * Accounts · Customers to check (voice-note batch, owner item 10): new and
 * imported customers start Not checked; Accounts checks, edits or returns
 * them with a reason. Accounts only (the database decides the list; this
 * page only hides itself from others). Bounded pages via ?offset=; the
 * filter is ?status= (allowlisted). No search words in the address.
 */
export default async function CustomersToCheckPage({ searchParams }: { searchParams: Promise<{ status?: string | string[]; offset?: string | string[] }> }) {
  const staff = await requireStaff();
  if (accountsRoleEntityIds(staff.access).length === 0) return <FinanceNoAccessView area="accounts" />;
  const { status: rawStatus, offset: rawOffset } = await searchParams;
  const status = parsePartyFilter(rawStatus);
  const offset = parsePageOffset(rawOffset);
  const page = await loadPartiesToCheck(staff, status, offset);
  const href = (s: string, o = 0) => `/app/accounts/customers?status=${s}${o > 0 ? `&offset=${o}` : ''}`;
  return (
    <CustomersToCheckView
      items={page?.items ?? null}
      filters={PARTY_FILTERS.map((key) => ({ key, label: PARTY_FILTER_LABEL[key], href: href(key), count: null, current: key === status }))}
      nextHref={page?.hasMore ? href(status, offset + PARTY_PAGE_SIZE) : null}
    />
  );
}
