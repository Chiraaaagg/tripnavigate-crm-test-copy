import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { WorkErrorBoundary } from '@/components/WorkErrorBoundary';
import { getVisibleDeal } from '@/modules/deals/server/queries';
import { INTAKE_DISABLED_TEXT } from '@/modules/fulfilment/contracts';
import { openBookingDraftAction } from '@/modules/fulfilment/server/actions';
import { loadIntake } from '@/modules/fulfilment/server/intake';
import { BOOK_NOW_NOT_INSTALLED, loadBookNow } from '@/modules/fulfilment/server/book-now';
import {
  addServiceItemAction,
  confirmIntakeAction,
  removeServiceItemAction,
  saveServiceItemAction,
  saveTravellersAction,
} from '@/modules/fulfilment/server/intake-actions';
import { requireStaff } from '@/modules/identity/server/session';
import { dealOwnerText } from '@/views/deal-labels';
import { IntakeNotAvailableView, IntakeScreen } from '@/views/intake-views';

export const metadata: Metadata = { title: 'Confirmed booking intake' };

/**
 * SCR-INTAKE (B1; B1.1 redirects editors to Book now). The intake read and the deal read run together under the
 * viewer's session; the screen is shown only when both say the deal is
 * visible. While service items are switched off, the route sends the viewer
 * back to the deal page (the hotel booking works there as before).
 */
export default async function IntakePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const staff = await requireStaff();
  const [view, deal, book] = await Promise.all([loadIntake(staff, id), getVisibleDeal(staff, id), loadBookNow(staff, id).catch(() => null)]);
  // B1.1: the Book now form replaces this screen for its editors and acceptors. The intake
  // screen stays read-only for a database without B1.1 and for other booking readers.
  if (book && book !== BOOK_NOW_NOT_INSTALLED && book.version?.serviceType !== 'hotel' && (book.serviceItemsEnabled || book.version)) redirect(`/app/deals/${id}/book`);
  // Same response for "does not exist" and "not yours", so IDs cannot be probed.
  if (!view || !deal) return <IntakeNotAvailableView />;
  // Switch off and no package version: the hotel booking on the Deal page is the place to work.
  // Switch off with an existing package version (rollback case, review E8): the intake stays
  // readable, nothing is editable, and the note says why.
  const packageVersion = view.services.version?.serviceType === 'package';
  if (!view.serviceItemsEnabled && !packageVersion) redirect(`/app/deals/${id}`);
  const shown = view.serviceItemsEnabled
    ? view
    : { ...view, canEdit: false, canConfirm: false, confirmBlockedReason: INTAKE_DISABLED_TEXT, services: { ...view.services, canEdit: false, canConfirm: false } };
  return (
    <WorkErrorBoundary title="Confirmed booking intake">
      <IntakeScreen
        view={shown}
        ownerText={dealOwnerText(deal)}
        actions={{
          openDraft: openBookingDraftAction,
          addServiceItem: addServiceItemAction,
          saveServiceItem: saveServiceItemAction,
          removeServiceItem: removeServiceItemAction,
          saveTravellers: saveTravellersAction,
          confirmIntake: confirmIntakeAction,
        }}
      />
    </WorkErrorBoundary>
  );
}
