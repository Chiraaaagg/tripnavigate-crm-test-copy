import type { Metadata } from 'next';
import { loadCashOverview } from '@/modules/finance/server/queries';
import { requireStaff } from '@/modules/identity/server/session';
import { CashOverviewView } from '@/views/finance-cash-views';
import { FinanceNoAccessView, FinanceUnavailableView } from '@/views/finance-views';
import { FINANCE_ACTIONS, financeRead, pickEntity } from '../finance-page-support';
import { accountsSectionViewer } from '../section-viewer';

export const metadata: Metadata = { title: 'Branch cash' };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

/**
 * Accounts › Branch cash. R4 (A8) adds ?branch= for the branch tabs; the bare
 * address and ?entity= work as before (no ?branch=: the first branch with
 * work). The database decides every read and write.
 */
export default async function AccountsCashPage({ searchParams }: { searchParams: Promise<{ entity?: string | string[]; branch?: string | string[] }> }) {
  const staff = await requireStaff();
  const { entity, branch } = await searchParams;
  const entityId = pickEntity(staff, 'accounts', entity);
  if (!entityId) return <FinanceNoAccessView area="accounts" />;
  // The section strip's flags: the menu's own read, cached per request (no new database read).
  const [overview, sectionViewer] = await Promise.all([financeRead(() => loadCashOverview(staff, entityId)), accountsSectionViewer(staff)]);
  if (!overview.ok) {
    if (overview.code === 'not_authorized') return <FinanceNoAccessView area="accounts" />;
    return <FinanceUnavailableView code={overview.code} title="Branch cash" />;
  }
  return (
    <CashOverviewView
      overview={overview.value}
      actions={FINANCE_ACTIONS}
      viewer={sectionViewer}
      branchId={first(branch)}
      keepEntity={first(entity) === entityId}
    />
  );
}
