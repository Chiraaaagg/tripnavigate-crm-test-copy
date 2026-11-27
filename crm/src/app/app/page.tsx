import type { Metadata } from 'next';
import { financeEnabledEntityIds } from '@/modules/finance/server/queries';
import { loadMyWorkCounts } from '@/modules/fulfilment/server/counts';
import { requireStaff } from '@/modules/identity/server/session';
import { loadSupplierMoneyHomeCounts } from '@/modules/supplier-money/server/queries';
import { loadFlightHomeCounts } from '@/modules/flight/server/queries';
import { loadVisaHomeCounts } from '@/modules/visa/server/queries';
import { loadPurchaseHomeCounts } from '@/modules/procurement/server/booking-change-actions';
import { HomeView } from '@/views/home-view';
import type { SectionsViewer } from './sections';
import { accountsDeskLinks, homeWorkRoles, shellPermissions } from './shell-permissions';

export const metadata: Metadata = { title: 'Home' };

export default async function HomePage() {
  const staff = await requireStaff();
  // financeEnabledEntityIds and requireStaff are request-cached: the layout already ran them.
  // B1: the "My work" counts are read together; null (read failed) shows "counts unavailable".
  // Direction A R0: the same reads as before, shown as "What needs you"; no new read.
  // Purchase build: supplier-money and go-ahead counts; a failed read only hides those rows.
  // Flight build: flight_home_counts (personal Flight rows, Sales flight decisions); a failed read hides them.
  // Visa build: visa_home_counts (Visa desk rows, Sales owner's visa results); a failed read hides them.
  // UX redesign R2 (SL-19, DM-18): the "Your deals" counts are no longer shown, so countMyDeals is not read here.
  const [financeEntities, myWork, supplierMoney, flight, visa, purchaseChanges] = await Promise.all([
    financeEnabledEntityIds(staff),
    loadMyWorkCounts(staff).catch(() => null),
    loadSupplierMoneyHomeCounts(staff).catch(() => null),
    loadFlightHomeCounts(staff).catch(() => null),
    loadVisaHomeCounts(staff).catch(() => null),
    // Accounts phase (contract 8.5, 11.8): "Bookings changed on your tasks" (Purchase only; null hides it).
    staff.memberships.some((m) => m.roleCode === 'purchase') ? loadPurchaseHomeCounts().catch(() => null) : Promise.resolve(null),
  ]);
  const allowed = shellPermissions(staff, financeEntities);
  // UX redesign R2: the same menu flags the frame uses (layout.tsx), so Home offers only addresses the menu offers
  // (sections.ts mayOpenAddress). Navigation convenience only; every page still decides access on its own.
  const sections: SectionsViewer = { ...allowed, ...accountsDeskLinks(staff, financeEntities) };
  return (
    <HomeView
      displayName={staff.displayName}
      canUseAccounts={allowed.canUseAccounts}
      // Batch 3 (FP-081): the two quotation rows show only for people who see the Quotations menu item.
      roles={{ ...homeWorkRoles(staff, financeEntities), quotations: allowed.canSeeQuotations }}
      myWork={myWork}
      supplierMoney={supplierMoney}
      flight={flight}
      visa={visa}
      purchaseChanges={purchaseChanges}
      sections={sections}
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
