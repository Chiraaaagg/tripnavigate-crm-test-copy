import type { ReactNode } from 'react';
import { SalesClaimsPanel } from './book-claims';
import { FixBookingForm, StartBookNowForm } from './book-entry-forms';
import { BookNowLanding, SubmittedBookingView } from './book-views';
import { TravellerIdProofSlot } from './id-proof-slot';
import type { UiResult } from './form-kit';
import type { BookActions, BookNowView, BookStep } from './shapes';

/*
 * The Book now overview (/book without a step): the landing page before a
 * version exists, or the submitted booking. The step pages are the booking
 * form (src/views/booking-form). The routes pass the real server actions and
 * /app/deals/... addresses; the preview gallery passes stand-in actions and
 * /preview/... addresses. No data access here.
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
  claimState?: UiResult | null;
  startState?: UiResult | null;
  notice?: ReactNode;
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
