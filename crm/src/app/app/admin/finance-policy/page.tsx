import type { Metadata } from 'next';
import { canUseAccounts } from '@/modules/access/policy';
import { financeEnabledEntityIds, loadFinancePolicy } from '@/modules/finance/server/queries';
import { requireStaff } from '@/modules/identity/server/session';
import { loadSettingsStates, moneyRulesModel } from '@/modules/settings/server/queries';
import { FinancePolicyPageView } from '@/views/finance-cash-views';
import { FinanceNoAccessView, FinanceUnavailableView } from '@/views/finance-views';
import { FINANCE_ACTIONS, financeRead, pickEntity } from '../../accounts/finance-page-support';

export const metadata: Metadata = { title: 'Money rules' };

/** Settings · Money rules (AD-06, DA-264; address and ?entity= kept, L1). Payment modes are read only. */
export default async function FinancePolicyPage({ searchParams }: { searchParams: Promise<{ entity?: string | string[] }> }) {
  const staff = await requireStaff();
  const { entity } = await searchParams;
  // Super Admin of a finance-enabled entity; the database also refuses Super Admin + Accounts (contract §4).
  const entityId = pickEntity(staff, 'super_admin', entity);
  if (!entityId) return <FinanceNoAccessView area="policy" />;
  const [page, states, financeEntities] = await Promise.all([financeRead(() => loadFinancePolicy(staff, entityId)), loadSettingsStates(staff), financeEnabledEntityIds(staff)]);
  if (!page.ok) {
    if (page.code === 'not_authorized') return <FinanceNoAccessView area="policy" />;
    return <FinanceUnavailableView code={page.code} title="Money rules" inSettings />;
  }
  return (
    <FinancePolicyPageView
      page={page.value}
      actions={FINANCE_ACTIONS}
      paymentModes={moneyRulesModel(states)}
      companyAccountsHref={canUseAccounts(staff.access, financeEntities) ? '/app/accounts/destinations' : null}
    />
  );
}
