import type { ReactNode } from 'react';
import type { BookNowView, BookStep } from '@/modules/fulfilment/contracts';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import { renderB1State } from './b1-states';
import { BookOverviewScreen, BookStepScreen, type BookLinks, type BookScreenPreview } from '@/views/b11/book-screen';
import { BookNowLoading, BookNowNotAvailableView, BookNowUnavailableView, DealBookingUnavailable, DealBookNowCard, DealBookNowCardPreview } from '@/views/b11/book-views';
import { StartBookNowForm } from '@/views/b11/book-entry-forms';
import { TravellerIdProofsCard } from '@/views/b11/id-proofs-list';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import type { B11Action, BookActions } from '@/views/b11/shapes';
import type { PrefillUiVM } from '@/modules/fulfilment/prefill-contract';
import { previewCopyRetriedAction, previewPrefillCheckedAction, previewPrefillUsedAction } from './b12-preview-actions';
import { ID_PROOF_COPY_STATUS_TEXT } from '@/modules/fulfilment/contracts';
import { prefillView } from './b12-itin-fixtures';
import {
  ACTIVITY_1,
  CLAIMS_EMPTY,
  DEAL_ID,
  FLIGHT_1,
  HOTEL_1,
  HOTEL_2,
  PASSPORT_1,
  TRANSFER_1,
  VISA_1,
  check,
  draftView,
  emptyDraft,
  idProof,
  inlinePrefillUi,
  item,
  travellers,
} from './b11-fixtures';
import {
  previewB11ClaimDuplicateAction,
  previewB11ClaimReportedAction,
  previewB11ClassificationRefusedAction,
  previewB11ConflictAction,
  previewB11NotReadyAction,
  previewB11RefuseCustomerAction,
  previewB11RefusePlanAction,
  previewB11RefusePriceAction,
  previewB11RefuseServiceAction,
  previewB11RefuseTripAction,
  previewB11RevisionNotAllowedAction,
  previewB11SavedAction,
  previewB11UploadFailedAction,
  previewB12ChainFirstAction,
  previewB2FillEmptyNothingAction,
  previewB12ChainSecondAction,
  previewB12IdProofRejectedAction,
  previewB12IdProofRemovedAction,
  previewB12IdProofUploadedAction,
} from './b11-preview-actions';

/*
 * B1.1/B1.2 preview states (LOCAL DESIGN-REVIEW GALLERY ONLY): the three-step Book now form,
 * the submitted booking and the revision path, rendered with synthetic views
 * and stand-in actions. Not evidence of a real journey.
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

const REFUSING_ACTIONS: BookActions = {
  ...SAVING_ACTIONS,
  saveCustomer: previewB11RefuseCustomerAction,
  saveTravellers: previewB11RefuseTripAction,
  saveTripBlock: previewB11RefuseTripAction,
  addServiceItem: previewB11RefuseServiceAction,
  saveServiceItem: previewB11RefuseServiceAction,
  savePrice: previewB11RefusePriceAction,
  savePlan: previewB11RefusePlanAction,
  reportClaim: previewB11ClaimDuplicateAction,
  submit: previewB11NotReadyAction,
  uploadEvidence: previewB11UploadFailedAction,
  classifyRevision: previewB11ClassificationRefusedAction,
};

const PREFILL_ACTIONS: BookActions = { ...SAVING_ACTIONS, usePrefill: previewPrefillUsedAction as unknown as B11Action, markPrefillChecked: previewPrefillCheckedAction as unknown as B11Action };
/** Batch 2 inline mode: Use it, Keep mine, the section check and Fill empty fields (stand-ins that read and write nothing). */
const INLINE_ACTIONS: BookActions = { ...PREFILL_ACTIONS, fillEmptyPrefill: saved, dismissPrefillNotice: saved };
const MOBILE_NOTICE = { field: 'contacts.mobile' as const, fieldId: 'customer-mobile', bitrixValueText: '9876500099', sourceModifiedAt: '2026-10-14T09:00:00.000Z', inline: true, canUse: true, canKeep: true };
const START_NOTICE = { field: 'trip.start' as const, fieldId: 'trip-start', bitrixValueText: '22 Nov 2026', sourceModifiedAt: '2026-10-14T09:00:00.000Z', inline: true, canUse: true, canKeep: true };
const END_NOTICE = { field: 'trip.end' as const, fieldId: 'trip-end', bitrixValueText: '28 Nov 2026', sourceModifiedAt: '2026-10-14T09:00:00.000Z', inline: false, canUse: false, canKeep: false };
const CONFLICT_ACTIONS: BookActions = { ...SAVING_ACTIONS, saveCustomer: previewB11ConflictAction, saveTravellers: previewB11ConflictAction, saveTripBlock: previewB11ConflictAction, savePrice: previewB11ConflictAction, savePlan: previewB11ConflictAction, submit: previewB11ConflictAction };

export function previewLinks(current: string): BookLinks {
  const steps = Object.fromEntries((['travellers', 'stay', 'finish'] as BookStep[]).map((s) => [s, `/preview/b11-book-${s}`])) as Record<BookStep, string>;
  return { steps, reload: `/preview/${current}`, deal: '/preview/b11-deal-draft', book: '/preview/b11-submitted-sales' };
}

interface StepState {
  view: BookNowView;
  step: BookStep;
  actions?: BookActions;
  viewer?: ShellViewer;
  preview?: BookScreenPreview;
  prefillUi?: PrefillUiVM;
}

const INTL_ITEMS = [HOTEL_1, HOTEL_2, FLIGHT_1, TRANSFER_1, ACTIVITY_1, VISA_1];
const stageNotWon = { stageId: 'PREPARATION', label: 'Quotation sent', isTriggerStage: false };

const STEP_STATES: Record<string, StepState> = {
  // B1.2: filled package draft, one state per step (the step list links between them).
  'b11-book-travellers': { view: draftView(), step: 'travellers' },
  'b11-book-stay': { view: draftView(), step: 'stay' },
  'b11-book-finish': { view: draftView(), step: 'finish' },
  'b12-book-copy-status': { view: draftView({ travellers: COPY_TRAVELLERS }), step: 'travellers' },
  'b11-book-travellers-empty': { view: emptyDraft(), step: 'travellers' },
  // B1.2 Bitrix prefill (0600): contact name filled from Bitrix (not checked), mobile offered; hidden notes; switched off.
  'b12-book-prefill-travellers': { view: draftView({ prefill: prefillView({}, { 'contacts.contactName': 'from_bitrix' }) }), step: 'travellers', actions: PREFILL_ACTIONS },
  'b12-book-prefill-stay': { view: draftView({ prefill: prefillView({ notesHidden: true, bookingNotes: null }, { 'trip.start': 'checked', 'trip.end': 'changed' }) }), step: 'stay', actions: PREFILL_ACTIONS },
  'b12-book-prefill-off': { view: draftView({ prefill: prefillView({ available: false, fields: [], bookingNotes: null, customerTypeLabel: null, travellerTotal: null }) }), step: 'travellers', actions: PREFILL_ACTIONS },
  // Batch 2: switch prefill_auto_fill on (inline mode). Values sit in the fields; markers, one-line notices, section check.
  'b2-book-inline-travellers': { view: draftView({ contacts: { ...draftView().contacts!, contactConfirmed: false, confirmedAt: null, confirmedByName: null } }), step: 'travellers', actions: INLINE_ACTIONS, prefillUi: inlinePrefillUi({ notices: [MOBILE_NOTICE] }) },
  'b2-book-inline-stay': { view: draftView(), step: 'stay', actions: INLINE_ACTIONS, prefillUi: inlinePrefillUi({ notices: [START_NOTICE, END_NOTICE] }) },
  'b2-book-inline-fill-empty': {
    view: emptyDraft(),
    step: 'travellers',
    actions: { ...INLINE_ACTIONS, fillEmptyPrefill: previewB2FillEmptyNothingAction },
    prefillUi: inlinePrefillUi({ states: { 'contacts.contactName': null, 'contacts.mobile': null, 'trip.start': null, 'trip.end': null }, fillEmptyOffered: true, notFilled: [{ field: 'contacts.email', reasonText: 'Bitrix has nothing here.' }] }),
  },
  'b2-book-inline-unavailable': { view: emptyDraft(), step: 'travellers', actions: INLINE_ACTIONS, prefillUi: inlinePrefillUi({ available: false }) },
  // Batch 2 step 3: an editor without price access sees one line instead of two locked sections.
  'b2-book-finish-no-price': { view: draftView({ commercials: undefined, canEditCommercials: false, plan: undefined, claims: undefined }), step: 'finish' },
  'b2-book-finish-to-finish': {
    view: draftView({ travellers: travellers(true), trip: { destination: 'Dubai and Udaipur', scope: 'international', start: '2026-11-18', end: '2026-11-26' }, items: INTL_ITEMS, checklist: [check('identity_missing', true, { travellerSeqs: [2, 3] }), check('missing_selling_total', true), check('missing_acceptance_proof', true)] }),
    step: 'finish',
  },
  // Batch 2 (Echo L9): three hotels; edit the 2nd, remove the 3rd.
  'b2-book-stay-three-hotels': {
    view: draftView({ items: [HOTEL_1, HOTEL_2, item(6, 'hotel', { mode: 'specific', hotelName: 'Sample Hill Fort', city: 'Kumbhalgarh', checkIn: '2026-11-25', checkOut: '2026-11-26', rooms: 1, adults: 2, children: 1, childAges: [8] }), TRANSFER_1] }),
    step: 'stay',
  },
  'b11-book-stay-no-hotel': { view: draftView({ items: [TRANSFER_1, ACTIVITY_1] }), step: 'stay' },
  'b11-book-travellers-refused': { view: draftView(), step: 'travellers', actions: REFUSING_ACTIONS, preview: { stateSection: 'passengers', initialState: { ok: false, code: 'invalid_input', message: 'Some details aren’t valid. Check the highlighted fields.', fields: ['travellerName[1]'] } } },
  // B1.2 traveller identity proof (step 1 · passengers)
  'b12-book-id-proof': {
    view: draftView({ checklist: [check('id_proof_missing', true, { travellerSeqs: [2], section: 'passengers', step: 'travellers' }), check('id_proof_missing_child', false, { travellerSeqs: [3], section: 'passengers', step: 'travellers' }), check('missing_acceptance_proof', true)] }),
    step: 'travellers',
  },
  'b12-book-id-proof-failed': {
    view: draftView({ travellers: travellers(false, [[idProof(1)], [idProof(3, { status: 'failed', storedAt: null, downloadHref: null, fileName: 'sample-id-blurred.png' })], []]) }),
    step: 'travellers',
  },
  'b12-book-id-proof-limit': { view: draftView({ travellers: travellers(false, [[idProof(1), idProof(2), idProof(3), idProof(4)], [idProof(5)], []]) }), step: 'travellers' },
  'b12-book-id-proof-rejected': { view: draftView(), step: 'travellers', actions: { ...SAVING_ACTIONS, uploadIdProof: previewB12IdProofRejectedAction } },
  'b12-book-chain': { view: draftView(), step: 'travellers', actions: { ...SAVING_ACTIONS, saveCustomer: previewB12ChainFirstAction, saveTravellers: previewB12ChainSecondAction } },
  'b12-book-id-proof-paused': { view: draftView({ idProofCanEdit: false }), step: 'travellers' },
  'b12-book-id-proof-locked': { view: draftView({ idProofCanEdit: false, idProofCanRemove: false }), step: 'travellers' },
  'b12-book-id-proof-hidden': { view: draftView({ travellers: travellers(false, [undefined, undefined, undefined]) }), step: 'travellers' },
  // Older gallery names (B1.1 steps), now shown on the step and section that hold the same content.
  'b11-book-customer': { view: draftView(), step: 'travellers' },
  'b11-book-trip': { view: draftView(), step: 'stay' },
  'b11-book-services': { view: draftView(), step: 'stay' },
  'b11-book-price': { view: draftView(), step: 'finish' },
  'b11-book-payment': { view: draftView(), step: 'finish' },
  'b11-book-review': { view: draftView(), step: 'finish' },
  // Step 1
  'b11-book-customer-empty': { view: emptyDraft(), step: 'travellers' },
  'b11-book-customer-business': {
    view: draftView({ contacts: { ...draftView().contacts!, bookingFor: 'business', payerDifferent: true, payerName: 'Sample Company Pvt Ltd' }, billing: { ...draftView().billing, billingName: 'Sample Company Pvt Ltd', gstin: '08ABCDE1234F1Z5' } }),
    step: 'travellers',
  },
  'b11-book-customer-billing-verified': { view: draftView({ billing: { ...draftView().billing, status: 'verified', editableBySales: false } }), step: 'travellers' },
  'b11-book-customer-refused': { view: emptyDraft(), step: 'travellers', actions: REFUSING_ACTIONS, preview: { initialState: { ok: false, code: 'invalid_input', message: 'Some details aren’t valid. Check the highlighted fields.', fields: ['mobile', 'postalCode'] } } },
  // Step 2
  'b11-book-trip-domestic': { view: draftView(), step: 'stay' },
  'b11-book-trip-international': {
    view: draftView({ trip: { destination: 'Dubai and Udaipur', scope: 'international', start: '2026-11-18', end: '2026-11-26' }, travellers: travellers(true), items: INTL_ITEMS, checklist: [check('identity_missing', true, { travellerSeqs: [2, 3] }), check('passport_details_later', false), check('missing_acceptance_proof', true)] }),
    step: 'finish',
  },
  'b11-book-trip-child': { view: emptyDraft({ travellers: [{ ...travellers()[2]!, ageYears: null }] , checklist: [check('child_age_missing', true, { travellerSeqs: [1] })] }), step: 'travellers' },
  'b11-book-trip-refused': { view: draftView(), step: 'stay', actions: REFUSING_ACTIONS, preview: { stateSection: 'trip', initialState: { ok: false, code: 'invalid_input', message: 'Some details aren’t valid. Check the highlighted fields.', fields: ['tripEnd'] } } },
  // Step 3
  'b11-book-services-empty': { view: emptyDraft({ travellers: travellers() }), step: 'stay' },
  'b11-book-services-package': {
    view: draftView({ trip: { destination: 'Dubai and Udaipur', scope: 'international', start: '2026-11-18', end: '2026-11-26' }, items: INTL_ITEMS, checklist: [check('visa_waiting_for_launch', false, { itemNos: [6] }), check('budget_missing', false, { itemNos: [2], section: 'hotels', step: 'stay' }), check('missing_acceptance_proof', true)] }),
    step: 'finish',
  },
  'b11-book-services-train-refused': { view: draftView(), step: 'finish' },
  'b11-book-services-passport': { view: draftView({ items: [PASSPORT_1], checklist: [check('missing_acceptance_proof', true)] }), step: 'finish' },
  'b11-book-services-add-hotel': { view: draftView(), step: 'stay', actions: REFUSING_ACTIONS, preview: { addType: 'hotel', addInitialState: { ok: false, code: 'invalid_input', message: 'Some details aren’t valid. Check the highlighted fields.', fields: ['checkOut'] } } },
  'b11-book-services-limit': { view: draftView({ items: Array.from({ length: 20 }, (_, i) => item(i + 1, 'activity', { name: `Sample activity ${i + 1}`, city: 'Udaipur', date: '2026-11-21', participants: 3 })) }), step: 'finish' },
  // Step 4
  'b11-book-price-empty': { view: draftView({ commercials: { listPricePaise: null, discountPaise: null, sellingTotalPaise: null }, checklist: [check('missing_selling_total', true)] }), step: 'finish' },
  'b11-book-price-mismatch': { view: draftView({ commercials: { listPricePaise: '13000000', discountPaise: '1000000', sellingTotalPaise: '11500000' } }), step: 'finish', actions: REFUSING_ACTIONS, preview: { stateSection: 'price', initialState: { ok: false, code: 'invalid_input', message: 'Some details aren’t valid. Check the highlighted fields.', fields: ['sellingTotalRupees'] } } },
  'b11-book-price-filled': { view: draftView(), step: 'finish' },
  // Step 5
  'b11-book-payment-no-advance': { view: draftView({ plan: [{ seq: 1, label: 'Full payment', amountPaise: '12000000', dueDate: '2026-11-10' }] }), step: 'finish' },
  'b11-book-payment-partial': {
    view: draftView({
      claims: {
        ...CLAIMS_EMPTY,
        reportedPaise: '3000000',
        balancePaise: '12000000',
        claims: [
          { claimId: 'c1', status: 'reported', displayStatus: 'reported', amountPaise: '3000000', mode: 'upi', reference: 'UTR226700009911', chequeNumber: null, chequeDate: null, paidOn: '2026-10-10', payerName: 'Sample Customer A', note: null, destinationLabel: 'Synthetic UPI ••••@bank', receiptAmountPaise: null, notReceivedReason: null, reportedByName: 'Synthetic Sales Delhi A', reportedAt: '2026-10-10T11:00:00.000Z', rowVersion: 1, canWithdraw: true },
        ],
      },
    }),
    step: 'finish',
  },
  'b11-book-payment-claim-refused': { view: draftView(), step: 'finish', actions: REFUSING_ACTIONS, preview: { claimState: { ok: false, code: 'invalid_input', message: 'This payment reference is already reported on this deal. Check the payments listed below before reporting it again.', fields: ['claimReference'] } } },
  'b11-book-payment-plan-mismatch': {
    view: draftView({ plan: [{ seq: 1, label: 'Advance', amountPaise: '3000000', dueDate: '2026-10-12' }, { seq: 2, label: 'Balance', amountPaise: '8000000', dueDate: '2026-11-10' }], checklist: [check('plan_total_mismatch', true), check('missing_acceptance_proof', true)] }),
    step: 'finish',
  },
  // Step 6
  'b11-book-review-blocked': { view: emptyDraft(), step: 'finish' },
  'b11-book-review-not-won': { view: draftView({ stage: stageNotWon, checklist: [check('stage_not_confirmed', true)] }), step: 'finish' },
  'b11-book-review-ready': { view: draftView({ checklist: [check('billing_unverified', false)], evidence: [{ id: 'e1', kind: 'acceptance_message', fileName: 'sample-acceptance.png', sizeLabel: '210 KB', status: 'stored', uploadedByYou: true, uploadedAt: '2026-10-11T08:40:00.000Z' }] }), step: 'finish' },
  'b11-book-review-confirm-dialog': {
    view: draftView({ items: INTL_ITEMS, checklist: [], evidence: [{ id: 'e1', kind: 'acceptance_message', fileName: 'sample-acceptance.png', sizeLabel: '210 KB', status: 'stored', uploadedByYou: true, uploadedAt: '2026-10-11T08:40:00.000Z' }] }),
    step: 'finish',
    preview: { review: { dialogOpen: true } },
  },
  'b11-book-upload-failed': {
    view: draftView({ evidence: [{ id: 'e2', kind: 'acceptance_message', fileName: 'sample-acceptance.pdf', sizeLabel: '1.2 MB', status: 'failed', uploadedByYou: true, uploadedAt: '2026-10-11T08:41:00.000Z' }] }),
    step: 'finish',
    actions: REFUSING_ACTIONS,
    preview: { review: { uploadState: { ok: false, code: 'upload_failed', message: '' } } },
  },
  'b11-book-concurrent-edit': {
    view: draftView(),
    step: 'travellers',
    actions: CONFLICT_ACTIONS,
    preview: { initialState: { ok: false, code: 'version_changed', message: '', conflict: { savedByName: 'Synthetic Manager Delhi', savedAt: '2026-10-11T08:32:00.000Z' } } },
  },
  'b11-book-saved': { view: draftView(), step: 'stay', preview: { stateSection: 'trip', initialState: { ok: true, data: undefined, message: 'Saved. Nothing has been booked or paid.' } } },
  'b11-book-read-only': { view: draftView({ canEdit: false, canEditCommercials: false, canSubmit: false }), step: 'stay', viewer: manager },
  'b11-book-deal-lost-draft': { view: draftView({ dealNotActive: true, canSubmit: false, stage: { stageId: 'LOSE', label: 'Booking Rejected', isTriggerStage: false } }), step: 'finish' },
  // Revision path
  'b11-revision-draft': {
    view: draftView({ version: { ...draftView().version!, versionNo: 2, revisesVersionId: 'v-base', revisesVersionNo: 1, changedFields: ['items.1.checkIn', 'items.1.checkOut'] }, checklist: [check('revision_class_missing', true)] }),
    step: 'stay',
  },
  'b11-revision-classify': {
    view: draftView({ version: { ...draftView().version!, versionNo: 2, revisesVersionId: 'v-base', revisesVersionNo: 1, changedFields: ['items.1.checkIn', 'sellingTotal'], allowedClasses: ['format_only', 'customer_material', 'internal_only'] }, checklist: [check('revision_class_missing', true)] }),
    step: 'finish',
  },
  'b11-revision-acceptance-required': {
    view: draftView({ version: { ...draftView().version!, versionNo: 2, revisesVersionId: 'v-base', revisesVersionNo: 1, changeClass: 'customer_material', changedFields: ['items.1.checkIn'] }, checklist: [check('customer_acceptance_required', true)] }),
    step: 'finish',
  },
  'b11-revision-classification-refused': {
    view: draftView({ version: { ...draftView().version!, versionNo: 2, revisesVersionId: 'v-base', revisesVersionNo: 1, changedFields: ['items.1.checkIn'] }, checklist: [check('revision_class_missing', true)] }),
    step: 'finish',
    actions: REFUSING_ACTIONS,
    preview: { review: { classifyState: { ok: false, code: 'classification_not_allowed', message: '', fields: ['changeClass'] } } },
  },
  'b11-revision-no-changes': {
    view: draftView({ version: { ...draftView().version!, versionNo: 2, revisesVersionId: 'v-base', revisesVersionNo: 1, changedFields: [] }, checklist: [check('no_changes', true)] }),
    step: 'finish',
  },
  'b11-revision-base-approved': {
    view: draftView({ version: { ...draftView().version!, versionNo: 2, revisesVersionId: 'v-base', revisesVersionNo: 1, changeClass: 'format_only', changedFields: ['contacts.mobile'] }, checklist: [check('base_no_longer_returned', true)] }),
    step: 'finish',
    actions: { ...SAVING_ACTIONS, submit: previewB11RevisionNotAllowedAction },
  },
  'b11-revision-confirm-dialog': {
    view: draftView({ version: { ...draftView().version!, versionNo: 2, revisesVersionId: 'v-base', revisesVersionNo: 1, changeClass: 'format_only', changedFields: ['contacts.mobile'] }, checklist: [] }),
    step: 'finish',
    preview: { review: { dialogOpen: true } },
  },
};

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

const OVERVIEW_STATES: Record<string, { view: BookNowView; viewer?: ShellViewer; preview?: BookScreenPreview }> = {
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
        <DealBookNowCard state={state} bookHref="/preview/b11-book-travellers" startForm={startForm} />
      </DealBookNowCardPreview>
    </StaffShell>
  );
}

export const B11_BOOK_STATES = [...Object.keys(STEP_STATES), ...Object.keys(OVERVIEW_STATES), 'b11-book-not-visible', 'b11-book-loading', 'b11-book-unavailable', 'b11-deal-not-started', 'b11-deal-not-won', 'b11-deal-draft', 'b11-deal-submitted', 'b11-deal-returned', 'b11-deal-lost', 'b11-deal-lost-after-submit', 'b11-deal-read-only', 'b11-deal-switch-off', 'b11-deal-booking-unavailable', 'b12-task-id-proofs', 'b12-task-id-proofs-refused'];

export function renderB11BookState(state: string): ReactNode | null {
  const s = STEP_STATES[state];
  if (s) {
    return (
      <StaffShell viewer={s.viewer ?? sales} currentPath="/app/deals">
        <BookStepScreen view={s.view} step={s.step} actions={s.actions ?? SAVING_ACTIONS} links={previewLinks(state)} ownerText="You" preview={s.preview} prefillUi={s.prefillUi ?? null} />
      </StaffShell>
    );
  }
  const o = OVERVIEW_STATES[state];
  if (o) {
    return (
      <StaffShell viewer={o.viewer ?? sales} currentPath="/app/deals">
        <BookOverviewScreen view={o.view} actions={SAVING_ACTIONS} links={previewLinks(state)} ownerText="You" preview={o.preview} />
      </StaffShell>
    );
  }
  const start = <StartBookNowForm dealId={DEAL_ID} action={previewB11SavedAction} continueHref="/preview/b11-book-travellers-empty" />;
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
