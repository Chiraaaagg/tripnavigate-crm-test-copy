import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { WorkErrorBoundary } from '@/components/WorkErrorBoundary';
import { getVisibleDeal } from '@/modules/deals/server/queries';
import { BOOK_NOW_NOT_INSTALLED, loadBookingForm } from '@/modules/fulfilment/server/book-form-load';
import { requireStaff } from '@/modules/identity/server/session';
import { dealOwnerText } from '@/views/deal-labels';
import { BookOverviewScreen } from '@/views/b11/book-screen';
import { BookNowNotAvailableView, BookNowUnavailableView } from '@/views/b11/book-views';
import { BOOKING_FORM_ACTIONS, bookLinks } from './book-actions';

export const metadata: Metadata = { title: 'Book now' };

/**
 * Book now overview (/app/deals/[id]/book). No version: the landing with
 * "Start booking". A draft (first or revision): straight to the first step
 * of the booking form that still needs input. The accepted version: the
 * read-only booking. Booking editors and acceptors only (booking_form_get);
 * everyone else gets the same "not available" answer as a missing Deal. A
 * database without the B1.1 functions falls back to the B1 intake screen.
 */
export default async function BookOverviewPage({ params }: { params: Promise<{ id: string }> }) {
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
  if (loaded.view.version?.status === 'draft') redirect(`/app/deals/${id}/book/${loaded.vm.initialStep}`);
  return (
    <WorkErrorBoundary title="Book now">
      <BookOverviewScreen view={loaded.view} actions={BOOKING_FORM_ACTIONS} links={bookLinks(id, `/app/deals/${id}/book`)} ownerText={dealOwnerText(deal)} />
    </WorkErrorBoundary>
  );
}
