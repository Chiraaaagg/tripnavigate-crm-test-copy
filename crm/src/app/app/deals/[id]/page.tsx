import type { Metadata } from 'next';
import { loadDealDues } from '@/modules/accounts-desk/server/queries';
import { addTallyInvoiceAction, withdrawTallyInvoiceAction } from '@/modules/accounts-desk/server/actions';
import { DealDuesCard } from '@/views/accounts-desk/deal-money';
import { customerDocumentsCard, refundsCard } from '../../accounts/acc2-cards';
import { resendCustomerMessageAction, restartWhatsappAction, setDealMessagePrefsAction } from '@/modules/customer-messages/server/actions';
import { loadDealCustomerMessages } from '@/modules/customer-messages/server/queries';
import { DealCustomerMessagesCard } from '@/views/customer-messages/deal-card';
import { openChangeVersionAction, requestAddServiceAction, requestChangeAction, requestRemoveServiceAction, resubmitChangeAction, setBookingChangesAction, setServiceChangesAction, withdrawChangeAction } from '@/modules/booking-changes/server/actions';
import { loadChangeHistory, loadDealChangeRequests } from '@/modules/booking-changes/server/queries';
import { changeHistoryView, dealChangesView } from '@/views/booking-changes/adapt';
import { DealChangesCard, RequestChangeHeaderAction } from '@/views/booking-changes/deal-card';
import { ChangeHistory } from '@/views/booking-changes/history';
import type { ReactNode } from 'react';
import { LiveDealsRefresh } from '@/components/LiveDealsRefresh';
import { getAppConfig } from '@/lib/config';
import { loadDealDocuments } from '@/modules/deals/server/documents';
import { loadDealLeadLink } from '@/modules/deals/server/lead-link';
import { getVisibleDeal, loadBitrixNameLookup } from '@/modules/deals/server/queries';
import { buildDealWorkspace, canListDealMessages, DEAL_TAB_LABEL, dealHref, isDeskOnlyViewer, requestedDealTab, type DealBookingInput } from '@/modules/deals/workspace';
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
import { ReportPaymentDialog } from '@/views/deal-workspace/claim-dialog';
import { MovedCardsNote, type MovedCardLink } from '@/views/deal-workspace/moved-cards';
import { StateBlock } from '@/components/ui/state-block';
import { reportPaymentClaimAction, withdrawPaymentClaimAction } from '@/modules/finance/server/claim-actions';
import { blockingCount } from '@/views/b11/book-fields';
import { StartBookNowForm } from '@/views/b11/book-entry-forms';
import { DealBookingUnavailable, DealBookNowCard, type DealBookNowState } from '@/views/b11/book-views';
import type { BookNowView } from '@/modules/fulfilment/contracts';
import { openTripCancellationAction } from '@/modules/procurement/server/actions';
import { loadDealCancellation } from '@/modules/procurement/server/queries';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { TripCancellationCard } from '@/views/purchase/trip-cancellation';
import { decideFlightChangeAction, fillTravellerNameAction } from '@/modules/flight/server/actions';
import { loadDealFlightHistory, loadDealFlightSummary } from '@/modules/flight/server/queries';
import { DealFlightCard, DealFlightUnavailable } from '@/views/flight/deal-flight-card';
import { acknowledgeVisaNoticeAction } from '@/modules/visa/server/actions';
import { loadDealVisaHistory, loadDealVisaSummary } from '@/modules/visa/server/queries';
import { DealVisaCard, DealVisaUnavailable } from '@/views/visa/deal-visa-card';

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
  // Allowlist parse only (no authorization): decides which tab-only reads to start early. Retired values
  // map to their new tab (quotations → documents); no tab or an unknown value starts no tab-only read here
  // (the default tab depends on the deal, so its reads start once the deal is known).
  const requestedTab = requestedDealTab(query.tab);
  const staff = await requireStaff();
  const roleCodes = (staff.memberships ?? []).map((m) => m.roleCode);
  // Money fence (build plan section 5): no customer-money read is started for a person who holds only
  // Purchase, Flight or Visa, even though the database would return nothing to them.
  const deskOnly = isDeskOnlyViewer(roleCodes);
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
  // else). Needed on every tab: Documents tab visibility and DA-22 depend on them.
  const quotationsRead = loadQuotationsForDeal(staff, id).catch(() => null);
  const itinerariesRead = loadItinerariesForDeal(staff, id).catch(() => null);
  // Bitrix stage names (B1-1, switch Off by default): a failure shows the fallback wording.
  const namesRead = loadBitrixNameLookup(staff).catch(() => ({ state: 'list_unreadable' as const }));
  // Tab-only reads, started early only when the address names the tab (speed plan C4); otherwise started
  // below once the open tab is known. A tab named in the address that turns out to be refused only costs a read.
  const readSettings = () =>
    loadWorkflowSettings(staff).then(
      (s) => s.serviceItemsEnabled,
      () => false,
    );
  const readFlightSummary = () => loadDealFlightSummary(staff, id).catch(() => 'error' as const);
  const readVisaSummary = () => loadDealVisaSummary(staff, id).catch(() => 'error' as const);
  const early = {
    // Services tab only: the "Open intake" secondary link (navigation convenience; the intake route decides).
    settings: requestedTab === 'services' ? readSettings() : null,
    // Documents tab only (B1-2).
    documents: requestedTab === 'documents' ? loadDealDocuments(staff, id) : null,
    // Flight build: the Deal's flight card (Services tab) and flight events (History tab). null = not for
    // this viewer (Purchase, Visa, Flight-only roles); a failed read shows nothing on Services and an error on History.
    flightSummary: requestedTab === 'services' ? readFlightSummary() : null,
    // Visa build (contract 9.3 / 11.2): the visa card and result notices (Services tab).
    visaSummary: requestedTab === 'services' ? readVisaSummary() : null,
    flightHistory: requestedTab === 'history' ? loadDealFlightHistory(staff, id).catch(() => 'error' as const) : null,
    visaHistory: requestedTab === 'history' ? loadDealVisaHistory(staff, id).catch(() => 'error' as const) : null,
  };
  const deal = await getVisibleDeal(staff, id);
  // Same response for "does not exist" and "not yours" so IDs cannot be probed.
  if (!deal) return <DealNotFoundView />;
  const config = getAppConfig();
  const [booking, services, leadLink, bookResult, quotationResult, itineraryResult, names] = await Promise.all([
    bookingRead,
    servicesRead,
    leadLinkRead,
    bookRead,
    quotationsRead,
    itinerariesRead,
    namesRead,
  ]);
  const documentsResult = early.documents ? await early.documents : null;
  const [flightHistory, visaHistory] = await Promise.all([early.flightHistory ?? Promise.resolve(undefined), early.visaHistory ?? Promise.resolve(undefined)]);
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
    flightHistory,
    visaHistory,
    // Documents tab (B1-2): listed for every Deal reader; the read lists only files the viewer may
    // open. Read only when the tab is open; a database without the read hides the files (never partial).
    documentsAvailable: documentsResult?.state !== 'not_installed',
    ...(documentsResult && documentsResult.state !== 'not_installed'
      ? { documents: documentsResult.state === 'ok' ? documentsResult.files : ('error' as const) }
      : {}),
    // Messages tab: Sales owner, branch Manager, Accounts (never a desk-only viewer); the read decides the rest.
    messagesListed: canListDealMessages(deal.relation, roleCodes),
  });
  const current = workspace.current;
  // People who may read customer money on this Deal; a failed money read shows its error card only to them
  // (review item 16). Purchase, Flight and Visa see nothing about customer money.
  const moneyReader = !deskOnly && (roleCodes.some((r) => r === 'accounts' || r === 'manager') || deal.relation === 'owner');

  const bookHref = `/app/deals/${deal.id}/book`;
  const startForm =
    workspace.header.primary?.kind === 'start_booking' ? (
      <StartBookNowForm dealId={deal.id} action={startBookNowAction} continueHref={`${bookHref}/travellers`} label="Start booking" />
    ) : undefined;

  let servicesTab: ReactNode;
  if (current === 'services') {
    const [serviceItemsEnabled, flightSummary, visaSummary] = await Promise.all([
      early.settings ?? readSettings(),
      early.flightSummary ?? readFlightSummary(),
      early.visaSummary ?? readVisaSummary(),
    ]);
    // Visa build: the desk task page opens for Visa role holders and the branch Manager (visa_workspace decides);
    // read only where a card needs it, as canOpenFlightWorkspace is.
    const canOpenVisaDesk = () => roleCodes.some((r) => r === 'visa' || r === 'manager');
    const packageVersion = servicesView?.version?.serviceType === 'package';
    // Editors get the link while the switch is on; every booking reader keeps it for a package
    // version (the intake screen is where its proof, selling total and readiness live; review E8).
    const legacyIntakeHref = servicesView && (packageVersion || (serviceItemsEnabled && servicesView.canEdit)) ? `/app/deals/${deal.id}/intake` : null;
    const bookState = bookView ? dealBookState(bookView) : null;
    const intakeHref = bookState || bookFailed ? null : legacyIntakeHref;
    // Accounts phase 3 (contract 10.5 R-G1, R-G4; screen 15.10): changes after a supplier confirmed and their
    // history. Sales owner, branch Manager and Accounts read; Purchase, Flight and Visa get null (no card).
    const [dealChanges, changeHistory] = await Promise.all([
      loadDealChangeRequests(staff, deal.id).catch(() => 'error' as const),
      loadChangeHistory(staff, deal.id).catch(() => 'error' as const),
    ]);
    const changeViewer = roleCodes.includes('accounts') ? 'accounts' : roleCodes.includes('manager') ? 'manager' : 'sales';
    const changeActions =
      changeViewer === 'accounts'
        ? null
        : {
            create: requestChangeAction as unknown as DecisionAction,
            createAdd: requestAddServiceAction as unknown as DecisionAction,
            createRemove: requestRemoveServiceAction as unknown as DecisionAction,
            resubmit: resubmitChangeAction as unknown as DecisionAction,
            withdraw: withdrawChangeAction as unknown as DecisionAction,
            openVersion: openChangeVersionAction as unknown as DecisionAction,
          };
    // R2 (SL-8): "Request a change" in the Services sold header when that card is shown.
    const changesView = dealChanges && dealChanges !== 'error' ? dealChangesView(dealChanges) : null;
    const askInServicesHeader = Boolean(servicesView) && Boolean(changesView?.canRequest);
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
      <DealServicesCard
        services={servicesView}
        intakeHref={bookState ? bookHref : intakeHref}
        linkLabel={bookState ? 'Open the booking' : undefined}
        canOpenFlightWorkspace={roleCodes.some((r) => r === 'flight' || r === 'manager')}
        canOpenVisaDesk={canOpenVisaDesk()}
        headerAction={askInServicesHeader && changesView ? <RequestChangeHeaderAction changes={changesView} actions={changeActions} /> : undefined}
      />
    ) : null;
    // Flight build (contract 11.2): current flights, the approval card for the decider, e-ticket links. No fares.
    const flightCard =
      flightSummary === 'error' ? (
        <DealFlightUnavailable />
      ) : flightSummary && flightSummary.flights.length > 0 ? (
        <DealFlightCard
          summary={flightSummary}
          dealId={deal.id}
          actions={{ decideChange: decideFlightChangeAction as unknown as DecisionAction, fillName: fillTravellerNameAction as unknown as DecisionAction }}
          eTicketBase="/app/flight/e-tickets"
          viewerIsSalesOwner={deal.relation === 'owner'}
        />
      ) : null;
    const visaCard =
      visaSummary === 'error' ? (
        <DealVisaUnavailable />
      ) : visaSummary && (visaSummary.tasks.length > 0 || visaSummary.notices.length > 0) ? (
        <DealVisaCard
          summary={visaSummary}
          dealId={deal.id}
          actions={{ ackNotice: acknowledgeVisaNoticeAction as unknown as DecisionAction }}
          canOpenTasks={canOpenVisaDesk()}
        />
      ) : null;
    const changesCard =
      dealChanges === null || (dealChanges === 'error' && !moneyReader) ? null : (
        <DealChangesCard
          changes={changesView ?? 'error'}
          viewer={changeViewer}
          actions={changeActions}
          askInServicesHeader={askInServicesHeader}
          editHref={() => `/app/deals/${deal.id}/book`}
          // Super Admins switch both features (the setters refuse anyone else).
          switches={
            roleCodes.includes('super_admin')
              ? { setChanges: setBookingChangesAction as unknown as DecisionAction, setServiceChanges: setServiceChangesAction as unknown as DecisionAction }
              : null
          }
        />
      );
    const historyCard =
      changeHistory === null || (changeHistory !== 'error' && changeHistory.versions.length <= 1 && changeHistory.confirmations.length === 0) || (changeHistory === 'error' && !moneyReader) ? null : (
        <ChangeHistory history={changeHistory === 'error' ? 'error' : changeHistoryView(changeHistory)} viewer={changeViewer} />
      );
    // Never a blank tab: when neither the booking card nor the services card applies, show one
    // empty state (D-12). When the header carries the booking action, say where it is instead.
    servicesTab =
      panel || servicesCard || flightCard || visaCard || changesCard ? (
        <>
          {panel}
          {flightCard}
          {visaCard}
          {servicesCard}
          {changesCard}
          {historyCard}
        </>
      ) : headerHasBookingAction ? (
        <DealServicesUseHeader primaryLabel={workspace.header.primary?.label ?? ''} />
      ) : (
        <DealServicesEmpty />
      );
    // R2: older saved links (bookmarks, notices already pushed) still say `?tab=services#dues` and the like; keep those anchors
    // here with a pointer to the card's new tab, for money readers and only to tabs they may open.
    if (moneyReader) {
      const listed = new Set(workspace.tabs.map((t) => t.tab));
      const moved: MovedCardLink[] = (
        [
          ['dues', 'Customer dues', 'money'],
          ['refunds', 'Refunds', 'money'],
          ['customer-documents', 'Customer documents', 'documents'],
          ['customer-messages', 'Messages to customer', 'messages'],
        ] as const
      )
        .filter(([, , tab]) => listed.has(tab))
        .map(([anchor, label, tab]) => ({ anchor, label, href: `${dealHref(deal.id, tab)}#${anchor}`, tabLabel: DEAL_TAB_LABEL[tab] }));
      if (moved.length > 0) {
        servicesTab = (
          <>
            {servicesTab}
            <MovedCardsNote links={moved} />
          </>
        );
      }
    }
    // Purchase build (owner decision 4): the branch Manager's "Trip cancelled". Shown only when the
    // database says this viewer may open it or a cancellation exists; a failed read shows nothing.
    const cancellation = await loadDealCancellation(staff, deal.id).catch(() => null);
    if (cancellation && (cancellation.canOpen || cancellation.cancellation)) {
      servicesTab = (
        <>
          {servicesTab}
          <TripCancellationCard dealId={deal.id} summary={cancellation} action={openTripCancellationAction as unknown as DecisionAction} />
        </>
      );
    }
  }

  // Money tab (R2: dues and plan, reported payments, refunds). The tab is listed only for price readers,
  // so these reads never start for Purchase, Flight or Visa; deskOnly is checked again on purpose.
  let moneyTab: ReactNode;
  let reportPayment: ReactNode;
  if (current === 'money' && workspace.money && !deskOnly) {
    // Accounts phase (contract 8.3 deal_dues, 11.4) and phase 2 (7.5 R-C1): Customer dues and Refunds. The reads
    // fence every viewer (null = no card); a failed read shows the error card only to money readers.
    const [dues, refundCard] = await Promise.all([loadDealDues(staff, deal.id).catch(() => 'error' as const), refundsCard(staff, deal.id, { moneyReader })]);
    const duesCard =
      dues === 'error' ? (
        moneyReader ? (
          <DealDuesCard dues="error" viewer="sales" />
        ) : null
      ) : dues ? (
        <DealDuesCard
          dues={dues}
          viewer={dues.viewer}
          actions={dues.viewer === 'accounts' ? { addTallyInvoice: addTallyInvoiceAction as unknown as DecisionAction, withdrawTallyInvoice: withdrawTallyInvoiceAction as unknown as DecisionAction } : null}
        />
      ) : null;
    moneyTab =
      duesCard || refundCard ? (
        <>
          {duesCard}
          {refundCard}
        </>
      ) : undefined;
    // "Tell Accounts about a payment": the existing Book now claim panel in a dialog, for people the claims
    // read lets report (deal_payment_claims; canReport). The same server actions as Book now.
    const claims = bookView?.claims;
    reportPayment = claims?.canReport ? (
      <ReportPaymentDialog dealId={deal.id} claims={claims} reportAction={reportPaymentClaimAction} withdrawAction={withdrawPaymentClaimAction} />
    ) : undefined;
  }

  // Documents tab (R2): files, then Customer documents (bills and vouchers), then the quotations and
  // itineraries that were the old Quotations tab (`?tab=quotations` opens here).
  let documentsTab: ReactNode;
  if (current === 'documents') {
    // Batch 3 (DA-71): referral drafts actively linked to this Deal that the viewer can open. null (not an
    // editor), a failed read or an older database shows no section, never an error.
    const [customerDocsCard, referralRead] = await Promise.all([
      // Accounts phase 2 (contract 6.9 R-B1; screen 11.1): no customer-money read for a desk-only viewer.
      deskOnly ? Promise.resolve(null) : customerDocumentsCard(staff, deal.id, { moneyReader, numberPrefix: deal.source?.sourceDealId ?? deal.reference }),
      quotationList ? loadReferralDraftsForSubject(staff, 'deal', deal.id) : Promise.resolve(null),
    ]);
    const referralDrafts = quotationList ? subjectReferralDraftsVM(referralRead) : null;
    documentsTab =
      customerDocsCard || quotationList || referralDrafts || itineraryList ? (
        <>
          {customerDocsCard}
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
      ) : undefined;
  }

  // Messages tab (R2, new): the customer messages card (Accounts phase 3, contract 5.10 R-A1, screen 15.2,
  // LD9). Listed only for the Sales owner, branch Manager and Accounts; the read still decides (null = none).
  let messagesTab: ReactNode;
  if (current === 'messages' && !deskOnly) {
    const customerMessages = await loadDealCustomerMessages(staff, deal.id).catch(() => 'error' as const);
    messagesTab =
      customerMessages === null || (customerMessages === 'error' && !moneyReader) ? (
        <StateBlock kind="empty" title="No customer messages to show" text="Messages to the customer on this deal are shown to its Sales owner, the branch Manager and Accounts." />
      ) : (
        <DealCustomerMessagesCard
          data={customerMessages}
          actions={{
            setPrefs: setDealMessagePrefsAction as unknown as DecisionAction,
            resend: resendCustomerMessageAction as unknown as DecisionAction,
            restartWhatsapp: restartWhatsappAction as unknown as DecisionAction,
          }}
        />
      );
  }

  return (
    <DealWorkspaceView
      workspace={workspace}
      startBookingForm={startForm}
      servicesTab={servicesTab}
      reportPayment={reportPayment}
      moneyTab={moneyTab}
      documentsTab={documentsTab}
      messagesTab={messagesTab}
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
