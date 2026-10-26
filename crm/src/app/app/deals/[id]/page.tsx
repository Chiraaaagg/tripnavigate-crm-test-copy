import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { LiveDealsRefresh } from '@/components/LiveDealsRefresh';
import { getAppConfig } from '@/lib/config';
import { loadDealDocuments } from '@/modules/deals/server/documents';
import { loadDealLeadLink } from '@/modules/deals/server/lead-link';
import { getVisibleDeal, loadBitrixNameLookup } from '@/modules/deals/server/queries';
import { buildDealWorkspace, parseDealTab, type DealBookingInput } from '@/modules/deals/workspace';
import { loadDealServices, loadWorkflowSettings } from '@/modules/fulfilment/server/intake';
import { loadBookingForDeal } from '@/modules/fulfilment/server/queries';
import { BOOK_NOW_NOT_INSTALLED, loadBookNow } from '@/modules/fulfilment/server/book-now';
import { startBookNowAction } from '@/modules/fulfilment/server/book-now-actions';
import { WorkErrorBoundary } from '@/components/WorkErrorBoundary';
import { requireStaff } from '@/modules/identity/server/session';
import { loadQuotationsForDeal, QUOTATIONS_NOT_INSTALLED } from '@/modules/quotations/server/queries';
import { SubjectQuotationsCard } from '@/views/b12/quote-page';
import { QUOTE_ACTIONS } from '../../quotations/quote-actions';
import { ITINERARIES_NOT_INSTALLED, loadItinerariesForDeal } from '@/modules/itineraries/server/queries';
import { ItinerariesCard } from '@/views/b12/itin-views';
import { loadReferralDraftsForSubject } from '@/modules/quotations/server/referral';
import { subjectReferralDraftsVM } from '@/modules/quotations/work-model';
import { SubjectReferralDraftsSection } from '@/views/b12/referral-views';
import { ITINERARY_ACTIONS } from '../../itineraries/itinerary-actions';
import { HotelBookingPanel, HotelBookingUnavailable } from '@/views/booking-views';
import { DealServicesCard, DealServicesEmpty, DealServicesUnavailable, DealServicesUseHeader } from '@/views/deal-services-view';
import { DealNotFoundView } from '@/views/staff-views';
import { DealWorkspaceView } from '@/views/deal-workspace/workspace';
import { blockingCount } from '@/views/b11/book-fields';
import { StartBookNowForm } from '@/views/b11/book-entry-forms';
import { DealBookingUnavailable, DealBookNowCard, type DealBookNowState } from '@/views/b11/book-views';
import type { BookNowView } from '@/modules/fulfilment/contracts';

export const metadata: Metadata = { title: 'Deal' };

export default async function DealPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = (await searchParams) ?? {};
  // Allowlist parse only (no authorization): decides which tab-only reads to start early.
  const requestedTab = parseDealTab(query.tab);
  const staff = await requireStaff();
  // Every read starts together with the deal read (speed plan C4). All run under the viewer's own
  // session (RLS), are read-only, and their results are used only after the deal is known to be
  // visible. A booking or services read failure must not hide the deal, and must not look like
  // "no booking yet" / "no services yet" (DA-31). The Lead link shows nothing on any failure and is
  // refused for Purchase before any query (lead-link.ts).
  const bookingRead = loadBookingForDeal(staff, id).then(
    (view) => ({ ok: true as const, view }),
    () => ({ ok: false as const }),
  );
  const servicesRead = loadDealServices(staff, id).then(
    (view) => ({ ok: true as const, view }),
    () => ({ ok: false as const }),
  );
  const leadLinkRead = loadDealLeadLink(staff, id).catch(() => null);
  // B1.1 Book now (editors and acceptors only; null for everyone else, 'not_installed' on an older database).
  const bookRead = loadBookNow(staff, id).then(
    (value) => ({ ok: true as const, value }),
    () => ({ ok: false as const }),
  );
  // B1.2 quotations and itineraries: Sales owner, assignee and branch Manager only (null for everyone
  // else: no Quotations tab). Needed on every tab: tab visibility and DA-22 depend on them.
  const quotationsRead = loadQuotationsForDeal(staff, id).catch(() => null);
  const itinerariesRead = loadItinerariesForDeal(staff, id).catch(() => null);
  // Bitrix stage names (B1-1, switch Off by default): a failure shows the fallback wording.
  const namesRead = loadBitrixNameLookup(staff).catch(() => ({ state: 'list_unreadable' as const }));
  // Services tab only: the "Open intake" secondary link (navigation convenience; the intake route decides).
  const settingsRead =
    requestedTab === 'services'
      ? loadWorkflowSettings(staff).then(
          (s) => s.serviceItemsEnabled,
          () => false,
        )
      : Promise.resolve(false);
  // Documents tab only (B1-2): one read when the tab is open, started with the others (speed plan C4).
  const documentsRead = requestedTab === 'documents' ? loadDealDocuments(staff, id) : null;
  const deal = await getVisibleDeal(staff, id);
  // Same response for "does not exist" and "not yours" so IDs cannot be probed.
  if (!deal) return <DealNotFoundView />;
  const config = getAppConfig();
  const [booking, services, serviceItemsEnabled, leadLink, bookResult, quotationResult, itineraryResult, names] = await Promise.all([
    bookingRead,
    servicesRead,
    settingsRead,
    leadLinkRead,
    bookRead,
    quotationsRead,
    itinerariesRead,
    namesRead,
  ]);
  const documentsResult = documentsRead ? await documentsRead : null;
  const quotationList = quotationResult && quotationResult !== QUOTATIONS_NOT_INSTALLED ? quotationResult : null;
  const itineraryList = itineraryResult && itineraryResult !== ITINERARIES_NOT_INSTALLED ? itineraryResult : null;
  const bookView: BookNowView | null = bookResult.ok && bookResult.value && bookResult.value !== BOOK_NOW_NOT_INSTALLED ? bookResult.value : null;
  const bookFailed = !bookResult.ok;
  const servicesView = services.ok ? services.view : null;
  const bookInput: DealBookingInput['book'] = bookFailed ? { state: 'failed' } : bookView ? { state: 'ok', view: bookView } : { state: 'none' };

  // View models only: BookNowView, DealDetail and the quotation list stay on the server.
  const workspace = buildDealWorkspace({
    dealId: deal.id,
    deal,
    tab: query.tab,
    book: bookInput,
    legacyBooking: booking.ok ? { ok: true, exists: booking.view !== null } : { ok: false },
    services: services.ok ? { ok: true, view: servicesView } : { ok: false },
    quotations: quotationList,
    itinerariesReadable: itineraryList !== null,
    leadLink,
    names,
    // Documents tab (B1-2): listed for every Deal reader; the read lists only files the viewer may
    // open. Read only when the tab is open; a database without the read hides the tab (never partial).
    documentsAvailable: documentsResult?.state !== 'not_installed',
    ...(documentsResult && documentsResult.state !== 'not_installed'
      ? { documents: documentsResult.state === 'ok' ? documentsResult.files : ('error' as const) }
      : {}),
  });

  const bookHref = `/app/deals/${deal.id}/book`;
  const startForm =
    workspace.header.primary?.kind === 'start_booking' ? (
      <StartBookNowForm dealId={deal.id} action={startBookNowAction} continueHref={`${bookHref}/travellers`} label="Start booking" />
    ) : undefined;

  let servicesTab: ReactNode;
  if (workspace.current === 'services') {
    const packageVersion = servicesView?.version?.serviceType === 'package';
    // Editors get the link while the switch is on; every booking reader keeps it for a package
    // version (the intake screen is where its proof, selling total and readiness live; review E8).
    const legacyIntakeHref = servicesView && (packageVersion || (serviceItemsEnabled && servicesView.canEdit)) ? `/app/deals/${deal.id}/intake` : null;
    const bookState = bookView ? dealBookState(bookView) : null;
    const intakeHref = bookState || bookFailed ? null : legacyIntakeHref;
    // A failed Book now read is "could not be loaded", never the legacy hotel panel. view null: the
    // viewer has no booking view (for example Purchase): no panel. A package version is worked on
    // the intake screen: the legacy hotel panel stays only for hotel versions.
    // One primary action (lead ruling 3): when the header already carries the booking action, the
    // Book now card (whose start form and Continue/Fix/View links duplicate it) is not rendered.
    const headerHasBookingAction = headerBookingActionKinds.has(workspace.header.primary?.kind ?? '');
    const panel = bookFailed ? (
      <DealBookingUnavailable />
    ) : bookState ? (
      headerHasBookingAction ? null : <DealBookNowCard state={bookState} bookHref={bookHref} actionVariant="secondary" />
    ) : !booking.ok ? (
      <HotelBookingUnavailable />
    ) : booking.view && !packageVersion ? (
      <WorkErrorBoundary title="Hotel booking">
        <HotelBookingPanel booking={booking.view} />
      </WorkErrorBoundary>
    ) : null;
    const servicesCard = !services.ok ? (
      <DealServicesUnavailable />
    ) : servicesView ? (
      <DealServicesCard services={servicesView} intakeHref={bookState ? bookHref : intakeHref} linkLabel={bookState ? 'Open the booking' : undefined} />
    ) : null;
    // Never a blank tab: when neither the booking card nor the services card applies, show one
    // empty state (D-12). When the header carries the booking action, say where it is instead.
    servicesTab =
      panel || servicesCard ? (
        <>
          {panel}
          {servicesCard}
        </>
      ) : headerHasBookingAction ? (
        <DealServicesUseHeader primaryLabel={workspace.header.primary?.label ?? ''} />
      ) : (
        <DealServicesEmpty />
      );
  }

  let quotationsTab: ReactNode;
  if (workspace.current === 'quotations') {
    // Batch 3 (DA-71): referral drafts actively linked to this Deal that the viewer can open. Read only on
    // this tab; null (not an editor), a failed read or an older database shows no section, never an error.
    const referralDrafts = quotationList ? subjectReferralDraftsVM(await loadReferralDraftsForSubject(staff, 'deal', deal.id)) : null;
    quotationsTab = (
      <>
        {quotationList ? (
          <SubjectQuotationsCard
            list={quotationList}
            subjectId={deal.id}
            defaultTitle={deal.title}
            createAction={QUOTE_ACTIONS.create}
            // One primary per page (copy §16.3): the Deal header holds it, so the card's create button is secondary.
            createVariant="secondary"
            blockedReason={
              quotationList.canCreate
                ? null
                : bookView?.dealNotActive
                  ? 'Lost or rejected in Bitrix: no new quotations.'
                  : 'You cannot start a quotation on this deal right now.'
            }
          />
        ) : null}
        {referralDrafts ? <SubjectReferralDraftsSection vm={referralDrafts} /> : null}
        {itineraryList ? <ItinerariesCard list={itineraryList} defaultTitle={deal.title} createAction={ITINERARY_ACTIONS.create} /> : null}
      </>
    );
  }

  return (
    <DealWorkspaceView
      workspace={workspace}
      startBookingForm={startForm}
      servicesTab={servicesTab}
      quotationsTab={quotationsTab}
      live={<LiveDealsRefresh supabaseUrl={config.supabaseUrl} supabasePublishableKey={config.supabasePublishableKey} dealId={deal.id} />}
    />
  );
}

/** Header primaries that the Book now card would repeat or contradict (start, start from quotation, Continue, Review, Fix, View). */
const headerBookingActionKinds = new Set<string>(['start_booking', 'start_from_quotation', 'continue_booking', 'review_and_submit', 'fix_and_send_again', 'view_booking']);

/**
 * The Book now card for this Deal on the Services and tasks tab, or null when
 * the legacy hotel panel stays (a B1 hotel version, or Book now switched off
 * with nothing started).
 */
function dealBookState(view: BookNowView): DealBookNowState | null {
  const v = view.version;
  if (v?.serviceType === 'hotel') return null;
  if (!v && !view.serviceItemsEnabled) return null;
  if (view.dealNotActive) return { kind: 'lost', hasBooking: Boolean(v) };
  if (!v) return { kind: 'not_started', canStart: view.canEdit, waitsForWon: Boolean(view.stage && !view.stage.isTriggerStage) };
  if (v.status === 'draft') return { kind: 'draft', savedAt: v.savedAt, savedByName: v.savedByName, needCount: blockingCount(view.checklist), revision: Boolean(v.revisesVersionId) };
  return { kind: 'submitted', reviewStatus: view.accountsReview?.status ?? null };
}
