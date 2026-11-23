import type { Metadata } from 'next';
import { financeEnabledEntityIds } from '@/modules/finance/server/queries';
import { requireStaff } from '@/modules/identity/server/session';
import { loadCompanyPage, loadSettingsStates } from '@/modules/settings/server/queries';
import { CompanyBranchesErrorView, CompanyBranchesNoPermissionView, CompanyBranchesView } from '@/views/settings/company-view';
import { shellPermissions } from '../../shell-permissions';

export const metadata: Metadata = { title: 'Company and branches' };

/**
 * Settings · Company and branches (DA-261, DEC-50; lead ruling D1): read only,
 * for anyone holding a Settings right. The company identity is the reviewed
 * code record; the branches and the Bitrix pilot come from reads under the
 * person's own session. No form, no switch, no customer data.
 */
export default async function CompanyBranchesRoute() {
  const staff = await requireStaff();
  const flags = shellPermissions(staff, await financeEnabledEntityIds(staff));
  if (!(flags.canAdministerStaff || flags.canManageGrants || flags.canManageIntegration || flags.canManageFinancePolicy)) {
    return <CompanyBranchesNoPermissionView />;
  }
  const model = await loadCompanyPage(staff, await loadSettingsStates(staff)).catch(() => null);
  return model ? <CompanyBranchesView model={model} /> : <CompanyBranchesErrorView />;
}
