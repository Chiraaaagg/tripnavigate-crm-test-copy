import 'server-only';
import { financeEnabledEntityIds } from '@/modules/finance/server/queries';
import type { StaffContext } from '@/modules/identity/server/session';
import type { AccountsSectionViewer } from '@/views/accounts-desk/sections';
import { accountsDeskLinks, shellPermissions } from '../shell-permissions';

/**
 * UX redesign R4 (D5): the menu flags the Accounts section tab strip reads, on
 * every Accounts page (one helper since R4 integration), from the same rules
 * as the staff frame (shellPermissions and accountsDeskLinks;
 * financeEnabledEntityIds is cached per request, so this is the read the
 * frame already made). Navigation only: the page and the database still
 * decide access.
 */
export async function accountsSectionViewer(staff: StaffContext): Promise<AccountsSectionViewer> {
  const financeEntities = await financeEnabledEntityIds(staff);
  const flags = shellPermissions(staff, financeEntities);
  return { canUseAccounts: flags.canUseAccounts, canCheckCustomers: flags.canCheckCustomers, ...accountsDeskLinks(staff, financeEntities) };
}
