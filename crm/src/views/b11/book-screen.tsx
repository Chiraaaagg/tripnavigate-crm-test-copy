import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import type { BookSection } from '@/modules/fulfilment/contracts';
import type { BookStepSectionsVM } from '@/modules/fulfilment/book-flow-contract';
import type { PrefillUiVM } from '@/modules/fulfilment/prefill-contract';
import { SalesClaimsPanel } from './book-claims';
import { FixBookingForm, StartBookNowForm } from './book-entry-forms';
import { BOOK_STEP_LABEL, nextStep, previousStep } from './book-fields';
import { ReviewStep, type ReviewPreview } from './book-review';
import { ServicesSection } from './book-services';
import { BOOKING_FOR_PREFILL, PrefillPanel } from './prefill-panel';
import { CustomerSection, IdentitySection, PassengersSection, PlanSection, PriceSection, TripSection } from './book-steps';
import { BookNowFrame, BookNowLanding, SubmittedBookingView } from './book-views';
import { DraftSyncProvider } from './draft-sync';
import { OpenPartsProvider } from './open-parts';
import { PrefillFillEmpty, PrefillInlineProvider, PrefillReference, PrefillSectionCheck } from './prefill-inline';
import { SectionFocus } from './section-focus';
import { SaveAndContinue, StepFooterBar, StepSaveReport, StepSaveReportProvider } from './step-footer';
import { BookSectionBlock, StepSectionsNav, StepSectionsProvider } from './step-sections-nav';
import { BOOK_PRICE_AND_PAYMENT_LABEL, BOOK_PRICE_NOTE, bookStepSections } from '@/modules/fulfilment/book-flow';
import { TravellerIdProofSlot } from './id-proof-slot';
import type { UiResult } from './form-kit';
import type { BookActions, BookNowView, BookServiceType, BookStep } from './shapes';

/*
 * Puts one Book now screen together from a view, the frozen actions and the
 * addresses of the steps. B1.2: three steps (freeze note §2.1), each one page
 * with several sections; every section saves on its own; steps 1 and 2 end
 * with "Save and continue", step 3 with "Submit booking and create tasks".
 * The routes pass the real server actions and /app/deals/... addresses; the
 * preview gallery passes stand-in actions and /preview/... addresses. No data
 * access here.
 */

export interface BookLinks {
  steps: Record<BookStep, string>;
  /** Reload the current page (shows the latest draft; drops typed values). */
  reload: string;
  deal: string;
  /** The submitted booking / landing page. */
  book: string;
}

export interface BookScreenPreview {
  /** First answer of one section's form (gallery). */
  initialState?: UiResult | null;
  /** Which section gets `initialState` (default: the step's first section). */
  stateSection?: 'customer' | 'passengers' | 'trip' | 'price' | 'payment';
  addInitialState?: UiResult | null;
  addType?: BookServiceType | null;
  claimState?: UiResult | null;
  review?: ReviewPreview;
  startState?: UiResult | null;
  notice?: ReactNode;
}

export function BookStepScreen({
  view,
  step,
  actions,
  links,
  ownerText,
  preview = {},
  prefillUi = null,
  stepSections = null,
}: {
  view: BookNowView;
  step: BookStep;
  actions: BookActions;
  links: BookLinks;
  ownerText?: string | null;
  preview?: BookScreenPreview;
  /** Batch 2 (D1): how Bitrix values show. Absent or panel → today's "From Bitrix" panel; inline → values in the fields. */
  prefillUi?: PrefillUiVM | null;
  /** Batch 2 (G13): the section list of this step (step 3). Absent → built from the view's section status. */
  stepSections?: BookStepSectionsVM | null;
}) {
  const back = previousStep(step);
  const next = nextStep(step);
  const editable = view.canEdit && view.version?.status === 'draft' && !view.dealNotActive;
  const st = (s: BookScreenPreview['stateSection'], first: BookScreenPreview['stateSection']) => ((preview.stateSection ?? first) === s ? preview.initialState : undefined);
  const services = { add: actions.addServiceItem, save: actions.saveServiceItem, remove: actions.removeServiceItem, participants: actions.saveParticipants };
  const travellersHref = `${links.steps.travellers}#passengers`;
  const inline = prefillUi?.mode === 'inline';
  const panelView = prefillUi?.mode === 'panel' ? prefillUi.view : view.prefill;
  const prefillProps = {
    prefill: panelView,
    target: 'booking_version' as const,
    versionId: view.version?.versionId ?? '',
    dealId: view.dealId,
    rowVersion: view.version?.rowVersion ?? 0,
    editable,
    useAction: actions.usePrefill,
    checkAction: actions.markPrefillChecked,
    reloadHref: links.reload,
  };
  const finishSections =
    step === 'finish'
      ? (stepSections ?? bookStepSections(view, 'finish'))
      : null;
  const previewOpen: BookSection[] = [
    ...(preview.stateSection === 'price' || preview.stateSection === 'payment' ? [preview.stateSection] : []),
    ...(preview.claimState ? (['payment'] as const) : []),
    ...(preview.addType && preview.addType !== 'hotel' ? (['services'] as const) : []),
  ];
  let body: ReactNode;
  switch (step) {
    case 'travellers':
      body = (
        <>
          {inline ? <PrefillFillEmpty idPrefix="travellers" /> : null}
          <BookSectionBlock section="customer" status={view.sectionStatus.customer}>
            {inline ? <PrefillReference /> : <PrefillPanel {...prefillProps} codes={['contacts.contactName', 'contacts.mobile', 'contacts.email', BOOKING_FOR_PREFILL]} showReference idPrefix="customer" />}
            <CustomerSection view={view} reloadHref={links.reload} initialState={st('customer', 'customer')} saveAction={actions.saveCustomer} />
            {inline ? <PrefillSectionCheck section="customer" idPrefix="customer" /> : null}
          </BookSectionBlock>
          <BookSectionBlock section="passengers" status={view.sectionStatus.passengers}>
            <PassengersSection view={view} reloadHref={links.reload} initialState={st('passengers', 'customer')} saveAction={actions.saveTravellers} idProofActions={{ upload: actions.uploadIdProof, remove: actions.removeIdProof, retryCopy: actions.retryIdProofCopy }} />
          </BookSectionBlock>
        </>
      );
      break;
    case 'stay':
      body = (
        <>
          {inline ? <PrefillFillEmpty idPrefix="stay" /> : null}
          <BookSectionBlock section="trip" status={view.sectionStatus.trip}>
            {inline ? null : <PrefillPanel {...prefillProps} codes={['trip.start', 'trip.end']} idPrefix="trip" />}
            <TripSection view={view} reloadHref={links.reload} initialState={st('trip', 'trip')} saveAction={actions.saveTripBlock} />
            {inline ? <PrefillSectionCheck section="trip" idPrefix="trip" /> : null}
          </BookSectionBlock>
          <BookSectionBlock section="hotels" status={view.sectionStatus.hotels}>
            <ServicesSection view={view} section="hotels" reloadHref={links.reload} travellersHref={travellersHref} actions={services} addInitialState={preview.addInitialState} addType={preview.addType === 'hotel' ? 'hotel' : null} />
          </BookSectionBlock>
        </>
      );
      break;
    case 'finish': {
      const priceNote = finishSections?.priceAccess === 'note';
      const claims = <SalesClaimsPanel dealId={view.dealId} claims={view.claims} reportAction={actions.reportClaim} withdrawAction={actions.withdrawClaim} reportInitialState={preview.claimState} headingLevel={4} />;
      body = (
        <>
          {finishSections ? <StepSectionsNav sections={finishSections} stepLabel={`step 3`} /> : null}
          <BookSectionBlock section="services" status={view.sectionStatus.services}>
            <ServicesSection
              view={view}
              section="services"
              reloadHref={links.reload}
              travellersHref={travellersHref}
              actions={services}
              addInitialState={preview.addType && preview.addType !== 'hotel' ? preview.addInitialState : undefined}
              addType={preview.addType && preview.addType !== 'hotel' ? preview.addType : null}
            />
          </BookSectionBlock>
          <BookSectionBlock section="identity" status={view.sectionStatus.identity}>
            <IdentitySection view={view} reloadHref={links.reload} identityAction={actions.saveIdentity} />
          </BookSectionBlock>
          {priceNote ? (
            <BookSectionBlock section="price" status={view.sectionStatus.price} title={BOOK_PRICE_AND_PAYMENT_LABEL}>
              {/* Old links to #payment land here. */}
              <span id="payment" />
              <p className="m-0 flex gap-2 text-copy">
                <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-faint" />
                <span>{finishSections?.priceNote ?? BOOK_PRICE_NOTE}</span>
              </p>
              {view.claims ? <div className="border-t border-line pt-6">{claims}</div> : null}
            </BookSectionBlock>
          ) : (
            <>
              <BookSectionBlock section="price" status={view.sectionStatus.price}>
                <PriceSection view={view} reloadHref={links.reload} initialState={st('price', 'price')} saveAction={actions.savePrice} />
              </BookSectionBlock>
              <BookSectionBlock section="payment" status={view.sectionStatus.payment}>
                <div className="flex flex-col gap-8">
                  {view.commercials ? (
                    <PlanSection view={view} reloadHref={links.reload} initialState={st('payment', 'price')} saveAction={actions.savePlan} />
                  ) : (
                    <p className="m-0 text-quiet">Only someone who can see this deal’s selling price (the deal owner or an assigned salesperson) can enter the payment plan. Ask them to fill this section.</p>
                  )}
                  <div className="border-t border-line pt-6">{claims}</div>
                </div>
              </BookSectionBlock>
            </>
          )}
          <BookSectionBlock section="review" status={view.sectionStatus.review} alwaysOpen>
            <ReviewStep
              view={view}
              stepHrefs={links.steps}
              reloadHref={links.reload}
              actions={{ submit: actions.submit, uploadEvidence: actions.uploadEvidence, removeEvidence: actions.removeEvidence, classifyRevision: actions.classifyRevision, discardRevision: actions.discardRevision }}
              preview={preview.review}
            />
          </BookSectionBlock>
        </>
      );
      break;
    }
  }
  const content = (
    <>
      <SectionFocus />
      <div className="flex flex-col gap-6">{body}</div>
      <StepSaveReport />
      <StepFooterBar backHref={back ? links.steps[back] : null} editable={editable}>
        {next ? <SaveAndContinue nextHref={links.steps[next]} label={`Save and continue to step ${step === 'travellers' ? 2 : 3}: ${BOOK_STEP_LABEL[next]}`} editable={editable} /> : null}
      </StepFooterBar>
    </>
  );
  return (
    <BookNowFrame view={view} step={step} hrefs={links.steps} ownerText={ownerText} dealHref={links.deal}>
      <DraftSyncProvider view={view}>
        <PrefillInlineProvider
          ui={prefillUi}
          panel={panelView}
          target="booking_version"
          versionId={view.version?.versionId ?? ''}
          dealId={view.dealId}
          rowVersion={view.version?.rowVersion ?? 0}
          editable={editable}
          actions={{ use: actions.usePrefill, check: actions.markPrefillChecked, fillEmpty: actions.fillEmptyPrefill, dismiss: actions.dismissPrefillNotice }}
          reloadHref={links.reload}
        >
          {finishSections ? (
            <StepSectionsProvider sections={finishSections} sectionStatus={view.sectionStatus} collapsible extraOpen={previewOpen}>
              <StepSaveReportProvider>{content}</StepSaveReportProvider>
            </StepSectionsProvider>
          ) : (
            <OpenPartsProvider initialOpen={[]} collapsible={false}>
              <StepSaveReportProvider>{content}</StepSaveReportProvider>
            </OpenPartsProvider>
          )}
        </PrefillInlineProvider>
      </DraftSyncProvider>
    </BookNowFrame>
  );
}

/** /book without a step: the landing (no version) or the submitted booking. Drafts redirect in the route. */
export function BookOverviewScreen({
  view,
  actions,
  links,
  ownerText,
  preview = {},
}: {
  view: BookNowView;
  actions: BookActions;
  links: BookLinks;
  ownerText?: string | null;
  preview?: BookScreenPreview;
}) {
  if (!view.version) {
    return (
      <BookNowLanding
        view={view}
        ownerText={ownerText}
        dealHref={links.deal}
        startForm={view.canEdit && !view.dealNotActive ? <StartBookNowForm dealId={view.dealId} action={actions.openDraft} continueHref={links.steps.travellers} initialState={preview.startState} /> : null}
      />
    );
  }
  const returned = view.accountsReview?.status === 'returned';
  return (
    <SubmittedBookingView
      view={view}
      ownerText={ownerText}
      dealHref={links.deal}
      notice={preview.notice}
      idProofs={
        view.idProofLimits && view.travellers.some((t) => t.idProofs !== undefined)
          ? [...view.travellers]
              .sort((a, b) => a.seq - b.seq)
              .filter((t) => t.idProofs !== undefined)
              .map((t) => (
                <TravellerIdProofSlot
                  key={t.seq}
                  dealId={view.dealId}
                  seq={t.seq}
                  rowNo={t.seq}
                  name={t.fullName}
                  savedName={t.fullName}
                  type={t.type}
                  proofs={t.idProofs ?? []}
                  limits={view.idProofLimits}
                  canEdit={view.idProofCanEdit}
                  canRemove={view.idProofCanRemove}
                  submitted
                  uploadAction={actions.uploadIdProof}
                  removeAction={actions.removeIdProof}
                  retryCopyAction={actions.retryIdProofCopy}
                />
              ))
          : undefined
      }
      fixForm={returned && view.canOpenRevision ? <FixBookingForm dealId={view.dealId} baseVersionId={view.version.versionId} action={actions.openRevision} continueHref={links.steps.travellers} initialState={preview.startState} /> : undefined}
      claimsPanel={
        view.claims && view.claims.canReport ? (
          <SalesClaimsPanel dealId={view.dealId} claims={view.claims} reportAction={actions.reportClaim} withdrawAction={actions.withdrawClaim} reportInitialState={preview.claimState} headingLevel={2} />
        ) : undefined
      }
    />
  );
}
