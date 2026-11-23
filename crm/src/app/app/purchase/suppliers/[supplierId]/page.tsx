import type { Metadata } from 'next';
import { searchHotelsAction } from '@/modules/hotels/server/hotel-actions';
import { requireStaff, type StaffContext } from '@/modules/identity/server/session';
import { loadSupplier } from '@/modules/procurement/server/queries';
import type { SupplierViewer } from '@/modules/suppliers/contracts';
import {
  linkSupplierHotelAction,
  removeSupplierContactAction,
  saveSupplierContactAction,
  unlinkSupplierHotelAction,
  updateSupplierAction,
} from '@/modules/suppliers/server/actions';
import { loadSupplierMaster } from '@/modules/suppliers/server/queries';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { GST_STATES } from '@/views/b11/book-fields';
import { VerifySupplierForm } from '@/views/procurement-forms';
import { SupplierBankSection, SupplierNotFoundView } from '@/views/procurement-views';
import { SupplierMasterPage, SupplierPageError } from '@/views/suppliers/supplier-page';
import { supplierTabFrom } from '@/views/suppliers/tabs';

export const metadata: Metadata = { title: 'Supplier' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const act = (a: unknown) => a as unknown as DecisionAction;

function viewerOf(staff: StaffContext, flightSupplier: boolean): SupplierViewer {
  const holds = (code: string) => staff.memberships.some((m) => m.roleCode === code);
  if (flightSupplier && holds('flight')) return 'flight';
  if (holds('purchase')) return 'purchase';
  if (holds('flight')) return 'flight';
  if (holds('manager')) return 'manager';
  return 'accounts';
}

/**
 * Supplier page (Accounts phase 2, R-A2, contract 11.9): details, contacts,
 * hotels sold, history and possible duplicates. Readers per section 10
 * (Purchase non-flight, Flight flight suppliers, Managers, Accounts); the
 * read returns null for everyone else (same words as "does not exist").
 * Bank details (UX redesign R3: their own tab, ?tab=bank) keep the existing
 * section from supplier_get when this viewer may read it (Purchase,
 * Managers); otherwise R-A2's revision summary. No read was added.
 */
export default async function SupplierRoute({
  params,
  searchParams,
}: {
  params: Promise<{ supplierId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ supplierId }, query] = await Promise.all([params, searchParams]);
  const staff = await requireStaff();
  if (!UUID.test(supplierId)) return <SupplierNotFoundView />;
  // Old addresses keep their tab (details, contacts, hotels, history); ?tab=bank is the new Bank details tab.
  const tab = supplierTabFrom(query.tab);
  const fromFlight = (Array.isArray(query.from) ? query.from[0] : query.from) === 'flight';
  const [master, legacy] = await Promise.all([
    loadSupplierMaster(staff, supplierId).catch(() => 'error' as const),
    // The existing bank section (revisions, approve, record new); null when supplier_get does not serve this viewer.
    loadSupplier(staff, supplierId).catch(() => null),
  ]);
  if (master === 'error') return <SupplierPageError backHref={fromFlight ? '/app/flight' : '/app/purchase/suppliers'} />;
  if (!master) return <SupplierNotFoundView />;
  const viewer = viewerOf(staff, master.serviceTypes.includes('flight'));
  const created = (Array.isArray(query.created) ? query.created[0] : query.created) === '1';
  return (
    <SupplierMasterPage
      supplier={master}
      tab={tab}
      viewer={viewer}
      back={fromFlight ? { href: '/app/flight', label: 'Back to Flight tasks' } : undefined}
      states={GST_STATES}
      actions={
        master.can.edit
          ? {
              update: act(updateSupplierAction),
              saveContact: act(saveSupplierContactAction),
              removeContact: act(removeSupplierContactAction),
              linkHotel: act(linkSupplierHotelAction),
              unlinkHotel: act(unlinkSupplierHotelAction),
            }
          : master.can.linkHotel
            ? { linkHotel: act(linkSupplierHotelAction), unlinkHotel: act(unlinkSupplierHotelAction) }
            : null
      }
      searchHotels={master.can.linkHotel ? searchHotelsAction : null}
      verifyAction={master.can.verify ? <VerifySupplierForm supplierId={master.supplierId} rowVersion={master.rowVersion} /> : undefined}
      bank={legacy ? <SupplierBankSection supplier={legacy} /> : undefined}
      justCreated={created}
    />
  );
}
