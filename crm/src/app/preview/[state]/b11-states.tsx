import type { ReactNode } from 'react';
import type { BookNowView, BookStep } from '@/modules/fulfilment/contracts';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import { renderB1State } from './b1-states';
import { BookOverviewScreen, type BookLinks, type BookScreenPreview } from '@/views/b11/book-screen';
import { BookNowLoading, BookNowNotAvailableView, BookNowUnavailableView, DealBookingUnavailable, DealBookNowCard, DealBookNowCardPreview } from '@/views/b11/book-views';
import { StartBookNowForm } from '@/views/b11/book-entry-forms';
import type { UiResult } from '@/views/b11/form-kit';
import { TravellerIdProofsCard } from '@/views/b11/id-proofs-list';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import type { B11Action, BookActions } from '@/views/b11/shapes';
import { previewCopyRetriedAction } from './b12-preview-actions';
import { ID_PROOF_COPY_STATUS_TEXT } from '@/modules/fulfilment/contracts';
import { CLAIMS_EMPTY, DEAL_ID, FLIGHT_1, HOTEL_1, TRANSFER_1, VISA_1, draftView, emptyDraft, idProof, travellers } from './b11-fixtures';
import { previewB11ClaimDuplicateAction, previewB11ClaimReportedAction, previewB11SavedAction, previewB12IdProofRejectedAction, previewB12IdProofRemovedAction, previewB12IdProofUploadedAction } from './b11-preview-actions';

/*
 * B1.1/B1.2 preview states (LOCAL DESIGN-REVIEW GALLERY ONLY): the Book now
 * landing, the submitted booking (with its traveller ID proofs and reported
 * payments), the Deal page card and the fixed (revised) booking, rendered
 * with synthetic views and stand-in actions. Not evidence of a real journey.
 * The October step screen and its states were removed on 17 November 2026
 * (owner decision D2); the booking form's own states live in
 * bookform-states.tsx.
 */

export const sales: ShellViewer = { displayName: 'Synthetic Sales Delhi A', primaryRole: 'Sales', primaryBranch: 'Delhi', canAdministerStaff: false, canManageGrants: false };
export const accounts: ShellViewer = { ...sales, displayName: 'Synthetic Accounts 1', primaryRole: 'Accounts', canUseAccounts: true, canCheckCustomers: true };
export const manager: ShellViewer = { ...sales, displayName: 'Synthetic Manager Delhi', primaryRole: 'Manager' };

const saved = previewB11SavedAction;

export const SAVING_ACTIONS: BookActions = {
  openDraft: saved,
  saveCustomer: saved,
  saveTravellers: saved,
  saveTripBlock: saved,
  uploadIdProof: previewB12IdProofUploadedAction,
  removeIdProof: previewB12IdProofRemovedAction,
  saveIdentity: saved,
  addServiceItem: saved,
  saveServiceItem: saved,
  removeServiceItem: saved,
  saveParticipants: saved,
  savePrice: saved,
  savePlan: saved,
  reportClaim: previewB11ClaimReportedAction,
  withdrawClaim: previewB11ClaimReportedAction,
  uploadEvidence: saved,
  removeEvidence: saved,
  submit: saved,
  openRevision: saved,
  classifyRevision: saved,
  discardRevision: saved,
  retryIdProofCopy: previewCopyRetriedAction as unknown as B11Action,
};

/** DEC-43: one copied file, one failed (Try again), one only the Super Admin may retry. */
const COPY_TRAVELLERS = travellers(false, [
  [
    idProof(1, { bitrixCopy: { jobId: 'cj000000-0000-4000-8000-000000000001', status: 'sent', statusText: ID_PROOF_COPY_STATUS_TEXT.sent, reasonText: null, attempts: 1, maxAttempts: 5, updatedAt: '2026-10-12T08:25:00.000Z', sentAt: '2026-10-12T08:25:00.000Z', canRetry: false, retryNeedsSuperAdmin: false } }),
    idProof(2, { bitrixCopy: { jobId: 'cj000000-0000-4000-8000-000000000002', status: 'failed', statusText: ID_PROOF_COPY_STATUS_TEXT.failed, reasonText: 'Bitrix did not accept the file just now.', attempts: 5, maxAttempts: 5, updatedAt: '2026-10-12T09:00:00.000Z', sentAt: null, canRetry: true, retryNeedsSuperAdmin: false } }),
  ],
  [idProof(3, { bitrixCopy: { jobId: 'cj000000-0000-4000-8000-000000000003', status: 'needs_manual_check', statusText: ID_PROOF_COPY_STATUS_TEXT.needs_manual_check, reasonText: null, attempts: 2, maxAttempts: 5, updatedAt: '2026-10-12T09:05:00.000Z', sentAt: null, canRetry: false, retryNeedsSuperAdmin: true } })],
  [],
]);

export function previewLinks(current: string): BookLinks {
  // The step pages are the booking form; its preview states are /preview/bookform-{scenario}--{step}.
  const steps = Object.fromEntries((['travellers', 'stay', 'finish'] as BookStep[]).map((s) => [s, `/preview/bookform-owner--${s}`])) as Record<BookStep, string>;
  return { steps, reload: `/preview/${current}`, deal: '/preview/b11-deal-draft', book: '/preview/b11-submitted-sales' };
}

const stageNotWon = { stageId: 'PREPARATION', label: 'Quotation sent', isTriggerStage: false };

function submittedView(over: Partial<BookNowView> = {}): BookNowView {
  const items = [HOTEL_1, FLIGHT_1, TRANSFER_1, VISA_1].map((i) =>
    i.serviceType === 'visa'
      ? { ...i, state: 'active' as const, nextStep: 'waiting_for_desk_launch' as const, waitingForLaunch: true }
      : { ...i, state: 'active' as const, nextStep: 'take_task' as const, task: { taskId: `task-${i.itemNo}`, status: 'not_started' as const, assigneeName: null, assignedToYou: false, supplierConfirmedAt: null } },
  );
  return draftView({
    version: { ...draftView().version!, status: 'confirmed' },
    canEdit: false,
    canSubmit: false,
    accountsReview: { status: 'pending', reviewedAt: null, reason: null, reasonHidden: false },
    items,
    checklist: [],
    progress: { total: 4, byState: { planned: 0, notStarted: 3, inProgress: 0, supplierConfirmed: 0, waitingForLaunch: 1 }, fulfilled: false, staleCount: 0, needs: ['take_task', 'waiting_for_desk_launch'] },
    history: [{ versionId: 'v1', versionNo: 1, status: 'confirmed', confirmedAt: '2026-10-11T09:00:00.000Z', revisesVersionId: null, changeClass: null, changedFields: [], reviewStatus: 'pending', reviewReason: null, reviewReasonHidden: false, supersededAt: null, sellingTotalPaise: '12000000', sellingTotalDeltaPaise: null }],
    ...over,
  });
}

function claimsWith(displayStatus: NonNullable<BookNowView['claims']>['claims'][number]['displayStatus'], extra: Partial<NonNullable<BookNowView['claims']>['claims'][number]> = {}) {
  return {
    ...CLAIMS_EMPTY,
    reportedPaise: '3000000',
    confirmedPaise: displayStatus === 'verified' || displayStatus === 'cleared' ? '3000000' : '0',
    balancePaise: displayStatus === 'verified' || displayStatus === 'cleared' ? '9000000' : '12000000',
    claims: [
      { claimId: 'c1', status: displayStatus === 'reported' ? ('reported' as const) : displayStatus === 'not_received' ? ('not_received' as const) : ('linked' as const), displayStatus, amountPaise: '3000000', mode: 'bank_transfer' as const, reference: 'UTR226700009911', chequeNumber: null, chequeDate: null, paidOn: '2026-10-10', payerName: 'Sample Customer A', note: null, destinationLabel: 'Synthetic Bank •••• 4321', receiptAmountPaise: displayStatus === 'reported' ? null : '3000000', notReceivedReason: null, reportedByName: 'Synthetic Sales Delhi A', reportedAt: '2026-10-10T11:00:00.000Z', rowVersion: 1, canWithdraw: displayStatus === 'reported', ...extra },
    ],
  };
}

const REFUSED_CLAIM: UiResult = { ok: false, code: 'invalid_input', message: 'This payment reference is already reported on this deal. Check the payments listed below before reporting it again.', fields: ['claimReference'] };

const OVERVIEW_STATES: Record<string, { view: BookNowView; viewer?: ShellViewer; preview?: BookScreenPreview; actions?: BookActions }> = {
  'b11-book-landing': { view: emptyDraft({ version: null, checklist: [] }) },
  'b11-book-landing-not-won': { view: emptyDraft({ version: null, checklist: [], stage: stageNotWon }) },
  'b11-submitted-sales': { view: submittedView() },
  'b12-submitted-copy-status': { view: submittedView({ travellers: COPY_TRAVELLERS }) },
  'b11-submitted-duplicate': { view: submittedView(), preview: { notice: <Notice tone="info" role="status">Already submitted. Tasks already exist for this version; nothing was created twice.</Notice> } },
  'b11-submitted-claim-reported': { view: submittedView({ claims: claimsWith('reported') }) },
  'b11-submitted-claim-verified': { view: submittedView({ claims: claimsWith('verified') }) },
  'b11-submitted-cheque-pending': { view: submittedView({ claims: claimsWith('pending_clearance', { mode: 'cheque', reference: null, chequeNumber: '004512', chequeDate: '2026-10-10', destinationLabel: null }) }) },
  'b11-submitted-cheque-bounced': { view: submittedView({ claims: claimsWith('bounced', { mode: 'cheque', reference: null, chequeNumber: '004512', chequeDate: '2026-10-10', destinationLabel: null }) }) },
  'b11-submitted-claim-not-found': { view: submittedView({ claims: claimsWith('not_received', { notReceivedReason: 'No credit with this reference on the statement for 10 and 11 October.' }) }) },
  // Reporting a payment that the server refuses keeps the typed values (form reset check).
  'b11-submitted-claim-refused': { view: submittedView(), actions: { ...SAVING_ACTIONS, reportClaim: previewB11ClaimDuplicateAction }, preview: { claimState: REFUSED_CLAIM } },
  // B1.2 traveller identity proof on the submitted booking (the same slot component, DEC-38 to DEC-42).
  'b12-submitted-id-proof': { view: submittedView() },
  'b12-submitted-id-proof-failed': { view: submittedView({ travellers: travellers(false, [[idProof(1)], [idProof(3, { status: 'failed', storedAt: null, downloadHref: null, fileName: 'sample-id-blurred.png' })], []]) }) },
  'b12-submitted-id-proof-limit': { view: submittedView({ travellers: travellers(false, [[idProof(1), idProof(2), idProof(3), idProof(4)], [idProof(5)], []]) }) },
  'b12-submitted-id-proof-rejected': { view: submittedView(), actions: { ...SAVING_ACTIONS, uploadIdProof: previewB12IdProofRejectedAction } },
  'b12-submitted-id-proof-paused': { view: submittedView({ idProofCanEdit: false }) },
  'b12-submitted-id-proof-locked': { view: submittedView({ idProofCanEdit: false, idProofCanRemove: false }) },
  'b12-submitted-id-proof-hidden': { view: submittedView({ travellers: travellers(false, [undefined, undefined, undefined]) }) },
  'b11-submitted-visa-waiting': { view: submittedView() },
  'b11-submitted-manager': { view: submittedView(), viewer: manager },
  'b11-deal-stage-moved-after-submit': { view: submittedView({ stage: { stageId: 'WON', label: 'Deal Closed', isTriggerStage: false } }) },
  'b11-submitted-returned': {
    view: submittedView({ accountsReview: { status: 'returned', reviewedAt: '2026-10-11T10:00:00.000Z', reason: 'The check-out date in the acceptance is 24 November, not 23. Please correct the hotel dates.', reasonHidden: false }, canOpenRevision: true }),
  },
  'b11-revision-confirmed': {
    view: submittedView({
      version: { ...draftView().version!, status: 'confirmed', versionNo: 2, revisesVersionId: 'v1', revisesVersionNo: 1, changeClass: 'customer_material', changedFields: ['items.1.checkOut'] },
      history: [
        { versionId: 'v1', versionNo: 1, status: 'superseded', confirmedAt: '2026-10-11T09:00:00.000Z', revisesVersionId: null, changeClass: null, changedFields: [], reviewStatus: 'returned', reviewReason: null, reviewReasonHidden: false, supersededAt: '2026-10-11T12:00:00.000Z', sellingTotalPaise: '12000000', sellingTotalDeltaPaise: null },
        { versionId: 'v2', versionNo: 2, status: 'confirmed', confirmedAt: '2026-10-11T12:00:00.000Z', revisesVersionId: 'v1', changeClass: 'customer_material', changedFields: ['items.1.checkOut', 'sellingTotal'], reviewStatus: 'pending', reviewReason: null, reviewReasonHidden: false, supersededAt: null, sellingTotalPaise: '12500000', sellingTotalDeltaPaise: '500000' },
      ],
    }),
  },
};

function bookDealCard(state: Parameters<typeof DealBookNowCard>[0]['state'], startForm?: ReactNode) {
  return (
    <StaffShell viewer={sales} currentPath="/app/deals">
      <DealBookNowCardPreview title="Synthetic family trip to Udaipur">
        <DealBookNowCard state={state} bookHref="/preview/bookform-owner--travellers" startForm={startForm} />
      </DealBookNowCardPreview>
    </StaffShell>
  );
}

export const B11_BOOK_STATES = [...Object.keys(OVERVIEW_STATES), 'b11-book-not-visible', 'b11-book-loading', 'b11-book-unavailable', 'b11-deal-not-started', 'b11-deal-not-won', 'b11-deal-draft', 'b11-deal-submitted', 'b11-deal-returned', 'b11-deal-lost', 'b11-deal-lost-after-submit', 'b11-deal-read-only', 'b11-deal-switch-off', 'b11-deal-booking-unavailable', 'b12-task-id-proofs', 'b12-task-id-proofs-refused'];

export function renderB11BookState(state: string): ReactNode | null {
  const o = OVERVIEW_STATES[state];
  if (o) {
    return (
      <StaffShell viewer={o.viewer ?? sales} currentPath="/app/deals">
        <BookOverviewScreen view={o.view} actions={o.actions ?? SAVING_ACTIONS} links={previewLinks(state)} ownerText="You" preview={o.preview} />
      </StaffShell>
    );
  }
  const start = <StartBookNowForm dealId={DEAL_ID} action={previewB11SavedAction} continueHref="/preview/bookform-empty--travellers" />;
  switch (state) {
    case 'b11-book-not-visible':
      return (
        <StaffShell viewer={sales} currentPath="/app/deals">
          <BookNowNotAvailableView />
        </StaffShell>
      );
    case 'b11-book-loading':
      return (
        <StaffShell viewer={sales} currentPath="/app/deals">
          <BookNowLoading />
        </StaffShell>
      );
    case 'b11-book-unavailable':
      return (
        <StaffShell viewer={sales} currentPath="/app/deals">
          <BookNowUnavailableView dealHref="/preview/b11-deal-draft" />
        </StaffShell>
      );
    case 'b11-deal-not-started':
      return bookDealCard({ kind: 'not_started', canStart: true, waitsForWon: false }, start);
    case 'b11-deal-not-won':
      return bookDealCard({ kind: 'not_started', canStart: true, waitsForWon: true }, start);
    case 'b11-deal-read-only':
      return bookDealCard({ kind: 'not_started', canStart: false, waitsForWon: false });
    case 'b11-deal-draft':
      return bookDealCard({ kind: 'draft', savedAt: '2026-10-11T08:35:00.000Z', savedByName: 'Synthetic Sales Delhi A', needCount: 4, revision: false });
    case 'b11-deal-submitted':
      return bookDealCard({ kind: 'submitted', reviewStatus: 'pending' });
    case 'b11-deal-returned':
      return bookDealCard({ kind: 'submitted', reviewStatus: 'returned' });
    case 'b11-deal-lost':
      return bookDealCard({ kind: 'lost', hasBooking: false });
    case 'b11-deal-lost-after-submit':
      return bookDealCard({ kind: 'lost', hasBooking: true });
    case 'b11-deal-booking-unavailable':
      return (
        <StaffShell viewer={sales} currentPath="/app/deals">
          <DealBookNowCardPreview title="Synthetic family trip to Udaipur">
            <DealBookingUnavailable />
          </DealBookNowCardPreview>
        </StaffShell>
      );
    case 'b12-task-id-proofs':
      return (
        <StaffShell viewer={{ ...sales, displayName: 'Synthetic Purchase Delhi', primaryRole: 'Purchase' }} currentPath="/app/purchase">
          <PageHeader eyebrow="Purchase task · SYN-JOD-012" title="Hotel · Sample Lake Palace Hotel" />
          <TravellerIdProofsCard
            state={{
              taskId: 'task-1',
              idProofRequired: true,
              travellers: [
                { seq: 1, fullName: 'Sample Traveller A', type: 'adult', idProofs: [idProof(1), idProof(2)].map((f) => ({ fileId: f.fileId, fileName: f.fileName, mime: f.mime, sizeLabel: f.sizeLabel, storedAt: f.storedAt!, downloadHref: '/preview/b12-task-id-proofs' })) },
                { seq: 2, fullName: 'Sample Traveller B', type: 'adult', idProofs: [] },
                { seq: 3, fullName: 'Sample Child C', type: 'child', idProofs: [] },
              ],
            }}
          />
        </StaffShell>
      );
    case 'b12-task-id-proofs-refused':
      return (
        <StaffShell viewer={sales} currentPath="/app/purchase">
          <PageHeader eyebrow="Purchase task · SYN-JOD-012" title="Hotel · Sample Lake Palace Hotel" />
          <TravellerIdProofsCard state="refused" />
        </StaffShell>
      );
    case 'b11-deal-switch-off':
      // Book now switched off and nothing started: the B1 hotel booking panel stays (no Book now card).
      return renderB1State('deal-services-legacy-hotel');
    default:
      return null;
  }
}
