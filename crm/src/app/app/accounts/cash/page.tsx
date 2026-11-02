import type { Metadata } from 'next';
import { loadCashOverview } from '@/modules/finance/server/queries';
import { requireStaff } from '@/modules/identity/server/session';
import { CashOverviewView } from '@/views/finance-cash-views';
import { FinanceNoAccessView, FinanceUnavailableView } from '@/views/finance-views';
import { FINANCE_ACTIONS, financeRead, pickEntity } from '../finance-page-support';

export const metadata: Metadata = { title: 'Branch cash' };

export default async function AccountsCashPage({ searchParams }: { searchParams: Promise<{ entity?: string | string[] }> }) {
  const staff = await requireStaff();
  const { entity } = await searchParams;
  const entityId = pickEntity(staff, 'accounts', entity);
  if (!entityId) return <FinanceNoAccessView area="accounts" />;
  const overview = await financeRead(() => loadCashOverview(staff, entityId));
  if (!overview.ok) {
    if (overview.code === 'not_authorized') return <FinanceNoAccessView area="accounts" />;
    return <FinanceUnavailableView code={overview.code} title="Branch cash" />;
  }
  return <CashOverviewView overview={overview.value} actions={FINANCE_ACTIONS} />;
}
