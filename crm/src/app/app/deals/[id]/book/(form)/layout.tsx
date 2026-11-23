import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { WorkErrorBoundary } from '@/components/WorkErrorBoundary';
import { getVisibleDeal } from '@/modules/deals/server/queries';
import { toPrefillUi } from '@/modules/fulfilment/prefill-ui';
import { BOOK_NOW_NOT_INSTALLED, loadBookingForm } from '@/modules/fulfilment/server/book-form-load';
import { requireStaff } from '@/modules/identity/server/session';
import { dealOwnerText } from '@/views/deal-labels';
import { BookNowNotAvailableView } from '@/views/b11/book-views';
import { BookingFormHost } from '@/views/booking-form/booking-form-host';
import { submitChangeAction } from '@/modules/booking-changes/server/actions';
import { loadChangePreview, loadDealChangeRequests } from '@/modules/booking-changes/server/queries';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { changeModeView } from '@/views/booking-changes/adapt';
import { ChangeModeBanner } from '@/views/booking-changes/change-mode';
import type { ChangeModeView } from '@/views/booking-changes/types';
import type { BookingFormScreenProps } from '@/views/booking-form/types';
import type { BookingFormLoad } from '@/modules/fulfilment/contracts';
import { setDealMessagePrefsAction } from '@/modules/customer-messages/server/actions';
import { loadDealMessagePrefs } from '@/modules/customer-messages/server/queries';
import { BookNowMessagePrefsCard, BookNowMessagePrefsUnavailable } from '@/views/customer-messages/book-now-card';
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
 *
 * Booking reliability B1-3: the layout always renders the same tree,
 * WorkErrorBoundary › (change-mode banner slot) › BookingFormHost › step page,
 * whether the read worked or not. A failed read (a required read threw)
 * hands the host { status: 'refresh_failed' } instead of replacing the form:
 * the host keeps the last good form mounted (typed values, open drawers and
 * the save queue survive) and says the refresh failed; on a first load it has
 * nothing to keep and shows the "Booking did not load" view. Answers that are
 * not failures are unchanged: not installed → intake, not visible → "not
 * available", not a draft → overview.
 */
export default async function BookingFormLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const staff = await requireStaff();
  let loaded;
  let deal;
  try {
    [loaded, deal] = await Promise.all([loadBookingForm(staff, id, { step: null, ownerText: null }), getVisibleDeal(staff, id)]);
  } catch {
    return <BookingFormFrame banner={null} load={{ status: 'refresh_failed' }}>{children}</BookingFormFrame>;
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
  const changeMode = view.version ? await changeModeFor(staff, id, view.version.versionId) : null;
  // Accounts phase 3 (contract 5.3 A1, screen 15.1): language and WhatsApp live on the Deal, not on the
  // draft, so they have their own small form; deal_message_prefs_get returns null for anyone who may not
  // change them → nothing shows. A failed read says so on the customer step (lead, 13 Nov 2026).
  const prefs = await loadDealMessagePrefs(staff, id).catch(() => 'error' as const);
  const messagePrefsCard = prefs === 'error' ? (
    <BookNowMessagePrefsUnavailable />
  ) : prefs ? (
    <BookNowMessagePrefsCard
      prefs={{ dealId: prefs.dealId, language: prefs.language, whatsappSameAsMobile: prefs.whatsappSameAsMobile, whatsappMasked: prefs.whatsappMasked, rowVersion: prefs.rowVersion }}
      action={setDealMessagePrefsAction as unknown as DecisionAction}
    />
  ) : null;
  const screen: BookingFormScreenProps = {
    vm,
    view,
    actions: BOOKING_FORM_ACTIONS,
    // `reload` is the step address the screen is on; the screen keeps it current.
    links: bookLinks(id, `/app/deals/${id}/book/${vm.initialStep}`),
    prefillUi,
    ownerText,
    vn: voiceNoteProps(id, vm, editable),
    changeMode,
    messagePrefsCard,
  };
  return (
    <BookingFormFrame
      banner={changeMode ? <ChangeModeBanner view={changeMode} submit={changeMode.canSubmit ? (submitChangeAction as unknown as DecisionAction) : null} /> : null}
      load={{ status: 'ok', ...screen }}
    >
      {children}
    </BookingFormFrame>
  );
}

/**
 * The one tree of the booking form (B1-3). Every render, good or failed,
 * puts the host in the same place so React keeps it (and the form inside)
 * mounted across a failed refresh.
 */
function BookingFormFrame({ banner, load, children }: { banner: ReactNode; load: BookingFormLoad<BookingFormScreenProps>; children: ReactNode }) {
  return (
    <WorkErrorBoundary title="Book now">
      {banner}
      <BookingFormHost load={load} />
      {children}
    </WorkErrorBoundary>
  );
}

/**
 * Accounts phase 3 (contract 10.3 G5/G6, screen 15.10; Addendum O2): change mode
 * when the open draft is the change version of a request being prepared,
 * sent to the Manager or returned by them (the Manager approves that version). Any failed
 * read means "no change mode" (the database still refuses edits outside the
 * request and a plain confirm of a change version: use_change_flow).
 */
async function changeModeFor(staff: Awaited<ReturnType<typeof requireStaff>>, dealId: string, versionId: string): Promise<ChangeModeView | null> {
  const changes = await loadDealChangeRequests(staff, dealId).catch(() => null);
  const request = changes?.requests.find((r) => r.changeVersionId === versionId && (r.status === 'draft' || r.status === 'returned' || r.status === 'requested'));
  if (!request) return null;
  const preview = await loadChangePreview(staff, request.id).catch(() => null);
  return preview ? changeModeView(preview) : null;
}
