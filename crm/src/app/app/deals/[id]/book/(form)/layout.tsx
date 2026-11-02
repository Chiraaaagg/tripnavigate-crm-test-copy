import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { WorkErrorBoundary } from '@/components/WorkErrorBoundary';
import { getVisibleDeal } from '@/modules/deals/server/queries';
import { toPrefillUi } from '@/modules/fulfilment/prefill-ui';
import { BOOK_NOW_NOT_INSTALLED, loadBookingForm } from '@/modules/fulfilment/server/book-form-load';
import { requireStaff } from '@/modules/identity/server/session';
import { dealOwnerText } from '@/views/deal-labels';
import { BookNowNotAvailableView, BookNowUnavailableView } from '@/views/b11/book-views';
import { BookingFormScreen } from '@/views/booking-form/booking-form-screen';
import { BOOKING_FORM_ACTIONS, bookLinks, voiceNoteProps } from '../book-actions';

/**
 * The booking form (/app/deals/[id]/book/{travellers|stay|finish}; Echo
 * review B-H2). The form is loaded and rendered here, in a layout that does
 * not change with the step: moving between steps changes only the [step]
 * page (which renders nothing visible), so a save's refresh never remounts
 * the screen and unsaved entries on other steps survive. The screen reads
 * the step from the address (useSelectedLayoutSegment). Only a draft is
 * edited here; without a draft the overview (/book) decides what to show.
 * The route group (form) keeps the /book landing page outside this layout.
 */
export default async function BookingFormLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const staff = await requireStaff();
  let loaded;
  let deal;
  try {
    [loaded, deal] = await Promise.all([loadBookingForm(staff, id, { step: null, ownerText: null }), getVisibleDeal(staff, id)]);
  } catch {
    return <BookNowUnavailableView dealHref={`/app/deals/${id}`} />;
  }
  if (loaded === BOOK_NOW_NOT_INSTALLED) redirect(`/app/deals/${id}/intake`);
  if (!loaded || !deal) return <BookNowNotAvailableView />;
  const { view } = loaded;
  if (view.version?.status !== 'draft') redirect(`/app/deals/${id}/book`);
  const ownerText = dealOwnerText(deal);
  const vm = { ...loaded.vm, statusLine: { ...loaded.vm.statusLine, owner: ownerText ? `Owner: ${ownerText}` : null } };
  const editable = view.canEdit && !view.dealNotActive;
  // Switch off (live now): no Bitrix values anywhere and no buttons; switch on: passive "From Bitrix" markers.
  const prefillUi = view.prefill && vm.prefillMode === 'auto' ? toPrefillUi(view.prefill, { target: 'booking', editable }) : null;
  return (
    <WorkErrorBoundary title="Book now">
      {/* `reload` is the step address the screen is on; the screen keeps it current. */}
      <BookingFormScreen vm={vm} view={view} actions={BOOKING_FORM_ACTIONS} links={bookLinks(id, `/app/deals/${id}/book/${vm.initialStep}`)} prefillUi={prefillUi} ownerText={ownerText} vn={voiceNoteProps(id, vm, editable)} />
      {children}
    </WorkErrorBoundary>
  );
}
