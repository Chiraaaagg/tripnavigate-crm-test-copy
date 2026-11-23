import type { Metadata } from 'next';
import { loadCompanyDestinations } from '@/modules/finance/server/queries';
import { requireStaff } from '@/modules/identity/server/session';
import { CompanyDestinationsView } from '@/views/finance-destination-views';
import { FinanceNoAccessView, FinanceUnavailableView } from '@/views/finance-views';
import { FINANCE_ACTIONS, financeRead, pickEntity } from '../finance-page-support';
import { accountsSectionViewer } from '../section-viewer';

export const metadata: Metadata = { title: 'Company accounts' };

export default async function AccountsDestinationsPage({ searchParams }: { searchParams: Promise<{ entity?: string | string[] }> }) {
  const staff = await requireStaff();
  const { entity } = await searchParams;
  const entityId = pickEntity(staff, 'accounts', entity);
  if (!entityId) return <FinanceNoAccessView area="accounts" />;
  // The section strip's flags: the menu's own read, cached per request (no new database read).
  const [page, sectionViewer] = await Promise.all([financeRead(() => loadCompanyDestinations(staff, entityId)), accountsSectionViewer(staff)]);
  if (!page.ok) {
    if (page.code === 'not_authorized') return <FinanceNoAccessView area="accounts" />;
    return <FinanceUnavailableView code={page.code} title="Company accounts" />;
  }
  return (
    <CompanyDestinationsView
      page={page.value}
      actions={FINANCE_ACTIONS}
      viewer={sectionViewer}
    />
  );
}
