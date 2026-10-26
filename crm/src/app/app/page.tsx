import type { Metadata } from 'next';
import { countMyDeals } from '@/modules/deals/server/queries';
import { financeEnabledEntityIds } from '@/modules/finance/server/queries';
import { loadMyWorkCounts } from '@/modules/fulfilment/server/counts';
import { requireStaff } from '@/modules/identity/server/session';
import { HomeView } from '@/views/staff-views';
import { homeWorkRoles, shellPermissions } from './shell-permissions';

export const metadata: Metadata = { title: 'Home' };

export default async function HomePage() {
  const staff = await requireStaff();
  // financeEnabledEntityIds and requireStaff are request-cached: the layout already ran them.
  // B1: the "My work" counts are read together; null (read failed) shows "counts unavailable".
  // Direction A R0: the same reads as before, shown as "What needs you"; no new read.
  const [counts, financeEntities, myWork] = await Promise.all([
    countMyDeals(staff),
    financeEnabledEntityIds(staff),
    loadMyWorkCounts(staff).catch(() => null),
  ]);
  const allowed = shellPermissions(staff, financeEntities);
  return (
    <HomeView
      displayName={staff.displayName}
      counts={counts}
      canUseAccounts={allowed.canUseAccounts}
      // Batch 3 (FP-081): the two quotation rows show only for people who see the Quotations menu item.
      roles={{ ...homeWorkRoles(staff, financeEntities), quotations: allowed.canSeeQuotations }}
      myWork={myWork}
      // Echo L10: with no work role (Super Admin) the one primary opens Settings work, not an empty Deals list.
      // Batch 4 (Echo-B L6): only a tab this person may open (the Bitrix connection page refuses Purchase holders).
      adminPrimary={
        allowed.canOpenBitrixConnection
          ? { href: '/app/admin/integration', label: 'Open Bitrix connection' }
          : allowed.canAdministerStaff
            ? { href: '/app/admin/staff', label: 'Open Staff' }
            : undefined
      }
    />
  );
}
