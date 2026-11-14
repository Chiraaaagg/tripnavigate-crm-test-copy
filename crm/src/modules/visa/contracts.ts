import { ERROR_TEXT } from '@/modules/fulfilment/contracts';
import type {
  VisaApplicationState,
  VisaClosedReason,
  VisaCostKind,
  VisaDealHistoryKind,
  VisaHandoverMethod,
  VisaKind,
  VisaNotReadyToken,
  VisaStepKey,
  VisaTaskStep,
} from './dto';

/**
 * Visa and Passport desk contract (Visa build contract, frozen 8 Nov 2026;
 * track B). Sections 6 (commands and refusal tokens), 8 (status words, steps,
 * Home rows), 9 (reads) and 10 (TypeScript layout); migrations
 * crm/supabase/migrations/20261202000100..0199.
 *
 * Owner decisions (binding): all passengers in one table (Q2); "received"
 * replaces "checked" (Q4); decision proof required (Q3/V5); appointment date
 * for sticker visas and passports only (Q5/V8); each passenger's exact fee,
 * never split, receipt before Accounts (Q6/V6); no default handover (Q8/V7);
 * notices to the Deal's Sales owner (Q11/V10); passport tasks complete
 * (Q12/V12). The CRM never sends the e-visa (R8): wording says "recorded",
 * never "e-mailed". Never matching people by name (section 16).
 *
 * Pure module: types, frozen refusal messages, words, the document
 * catalogue and the form field names. DTO types come from dto.ts.
 */

export type {
  DealVisaHistoryDTO,
  DealVisaHistoryEventDTO,
  DealVisaNoticeDTO,
  DealVisaSummaryDTO,
  DealVisaTaskDTO,
  PassportFactsDTO,
  VisaApplicantCanDTO,
  VisaApplicantDTO,
  VisaApplicationResult,
  VisaApplicationState,
  VisaApplyResult,
  VisaBookingChangeDTO,
  VisaClaimResult,
  VisaClosedReason,
  VisaCostKind,
  VisaCostSummaryDTO,
  VisaDealHistoryKind,
  VisaDocumentDTO,
  VisaDocumentResult,
  VisaDocumentSource,
  VisaDocumentStatus,
  VisaEvidenceKind,
  VisaExpenseStatus,
  VisaFactsDTO,
  VisaFeeDTO,
  VisaFeeSendResult,
  VisaFileDTO,
  VisaHandoverKind,
  VisaHandoverMethod,
  VisaHomeCountsDTO,
  VisaKind,
  VisaKindSource,
  VisaNotReadyToken,
  VisaNoticeAckResult,
  VisaNoticeOutcome,
  VisaOtherCostResult,
  VisaOutcome,
  VisaPaidBy,
  VisaPaymentMode,
  VisaPreviousApplicationDTO,
  VisaQueueDTO,
  VisaQueueTaskDTO,
  VisaReapplyResult,
  VisaReturnedFeeDTO,
  VisaRowSaveResult,
  VisaServiceType,
  VisaStepDTO,
  VisaStepKey,
  VisaTaskStatusCode,
  VisaTaskStatusDTO,
  VisaTaskStep,
  VisaWorkspaceDTO,
  VisaWorkspaceFactsDTO,
} from './dto';

// ---------------------------------------------------------------------------
// Addendum 1 (9 Nov 2026): launch state of the Visa queue
// ---------------------------------------------------------------------------

/**
 * visa_passport_tasks_enabled as read through workflow_settings_get: 'on',
 * 'off', or 'unknown' when the read failed or did not report it (never 'off').
 */
export type VisaLaunchState = 'on' | 'off' | 'unknown';

/** What loadVisaQueue returns: the visa_queue read plus the launch state. */
export type VisaQueueLoadDTO = import('./dto').VisaQueueDTO & {
  launch: VisaLaunchState;
  /** Sold visa/passport services waiting for the launch, when known; null otherwise (no read reports it today). */
  waitingCount: number | null;
};

// ---------------------------------------------------------------------------
// Document catalogue (section 4, frozen; code -> label, in this order)
// ---------------------------------------------------------------------------

export const VISA_DOCUMENT_CATALOGUE = [
  { code: 'passport_copy', label: 'Passport copy (front and back)' },
  { code: 'photo', label: 'Photo, white background' },
  { code: 'bank_statement', label: 'Bank statement (6 months)' },
  { code: 'parent_passport', label: 'Parent’s passport copy' },
  { code: 'travel_insurance', label: 'Travel insurance' },
  { code: 'stay_proof', label: 'Hotel booking' },
  { code: 'birth_certificate', label: 'Birth certificate' },
  { code: 'parent_consent', label: 'Parents’ consent letter' },
  { code: 'onward_ticket', label: 'Onward flight ticket' },
  { code: 'original_passport', label: 'Original passport' },
  { code: 'old_passports', label: 'Old passports' },
  { code: 'passport_size_photos_2', label: 'Passport-size photos (2)' },
  { code: 'aadhaar_card', label: 'Aadhaar card' },
  { code: 'pan_card', label: 'PAN card' },
  { code: 'itr_last_3_years', label: 'ITR (last 3 years)' },
  { code: 'salary_slips_3_months', label: 'Salary slips (3 months)' },
  { code: 'employment_letter_or_noc', label: 'Employment letter or NOC' },
  { code: 'leave_letter', label: 'Leave letter' },
  { code: 'cover_letter', label: 'Cover letter' },
  { code: 'return_flight_booking', label: 'Return flight booking' },
  { code: 'visa_application_form_signed', label: 'Visa application form (signed)' },
  { code: 'marriage_certificate', label: 'Marriage certificate' },
  { code: 'invitation_letter', label: 'Invitation letter' },
  { code: 'business_registration_documents', label: 'Business registration documents' },
  { code: 'school_or_college_id', label: 'School or college ID' },
] as const;

export type VisaCatalogueCode = (typeof VISA_DOCUMENT_CATALOGUE)[number]['code'];

/** Limits the database enforces again (sections 5.2, 6). */
export const VISA_LIMITS = {
  documentsPerApplicant: 40,
  documentLabel: 120,
  remark: 300,
  reference: 120,
  reasonMin: 3,
  reasonMax: 300,
  email: 200,
  courierNumber: 80,
  jurisdictionPlace: 120,
  applicantsPerApply: 100,
  filesPerVisaTask: 200,
} as const;

// ---------------------------------------------------------------------------
// Refusal tokens (section 6.1): the database message is exactly the token,
// arriving with exactly this SQLSTATE.
// ---------------------------------------------------------------------------

export type VisaErrorCode =
  | 'not_authorized'
  | 'not_found'
  | 'version_changed'
  | 'duplicate_request'
  | 'task_conflict'
  | 'invalid_input'
  | 'deal_removed'
  | 'task_closed'
  | 'application_closed'
  | 'wrong_state'
  | 'not_ready'
  | 'applicant_removed'
  | 'traveller_changed'
  | 'duplicate_reference'
  | 'applied_date_in_future'
  | 'delivered_date_in_future'
  | 'duplicate_document'
  | 'too_many_documents'
  | 'document_received'
  | 'outcome_document_required'
  | 'already_recorded'
  | 'receipt_required'
  | 'cost_locked'
  | 'evidence_rejected'
  // Accounts phase 2 (Track C, LD12): new Visa spending stops once the trip cancellation is approved.
  | 'trip_cancelled';

export const VISA_ERROR_STATES: Record<VisaErrorCode, string> = {
  not_authorized: '42501',
  not_found: 'P0002',
  version_changed: '40001',
  duplicate_request: '40001',
  task_conflict: '40001',
  invalid_input: '22023',
  deal_removed: '55000',
  task_closed: '55000',
  application_closed: '55000',
  wrong_state: '55000',
  not_ready: '55000',
  applicant_removed: '55000',
  traveller_changed: '55000',
  duplicate_reference: '23505',
  applied_date_in_future: '22023',
  delivered_date_in_future: '22023',
  duplicate_document: '23505',
  too_many_documents: '22023',
  document_received: '55000',
  outcome_document_required: '55000',
  already_recorded: '55000',
  receipt_required: '55000',
  cost_locked: '55000',
  evidence_rejected: '22023',
  trip_cancelled: '55000',
};

export type VisaFailureCode = VisaErrorCode | 'upload_failed' | 'session';

/** Frozen staff messages (section 6.1; deal_removed and evidence_rejected keep the existing wording). */
export const VISA_ERROR_TEXT: Record<VisaFailureCode, string> = {
  not_authorized: 'You cannot do this on this visa task.',
  not_found: 'This item is no longer available. Reload the page.',
  version_changed: 'Someone changed this passenger meanwhile. Reload and try again.',
  duplicate_request: 'This was already sent with different details. Reload the page.',
  task_conflict: 'Someone at the desk took this task first.',
  invalid_input: 'Check the highlighted field.',
  deal_removed: ERROR_TEXT.deal_removed,
  task_closed: 'This task is complete. Nothing can be changed here now.',
  application_closed: 'This passenger is closed. Nothing can be changed here now.',
  wrong_state: 'This step is already done for this passenger. Reload the page.',
  not_ready: 'Not ready to apply yet: {reason}.',
  applicant_removed: 'This passenger was removed from the booking. Only the decision, handover or withdrawal can be recorded.',
  traveller_changed: 'The traveller’s name changed in the booking. Check it and press "OK, checked" first.',
  duplicate_reference: 'This reference is already used on this task.',
  applied_date_in_future: 'The applied date cannot be after today.',
  delivered_date_in_future: 'The delivery date cannot be after today.',
  duplicate_document: 'This document is already on the list.',
  too_many_documents: 'This passenger already has 40 documents.',
  document_received: 'A received document cannot be removed.',
  outcome_document_required: 'Upload the visa or refusal document first.',
  already_recorded: 'This handover is already recorded.',
  receipt_required: 'Attach the fee receipt first.',
  cost_locked: 'This fee is with Accounts and cannot be changed now.',
  evidence_rejected: ERROR_TEXT.evidence_rejected,
  trip_cancelled: 'The trip is cancelled. New fees, applications and payments are stopped.',
  upload_failed: 'The file could not be uploaded. Nothing was saved. Please try again.',
  session: 'You were signed out. Sign in again; what you typed is still on this page.',
};

/** The {reason} of not_ready, per notReady token (section 6.1). */
export const VISA_NOT_READY_REASON: Record<VisaNotReadyToken, string> = {
  removed: 'removed from the booking',
  superseded: 'this application was replaced by a new one',
  wrong_state: 'already applied',
  traveller_changed: 'the traveller changed in the booking',
  no_documents: 'no document list yet',
  documents_missing: 'documents not received',
  appointment_missing: 'no appointment date',
  kind_missing: 'set the appointment date or choose E-visa',
};

/** "Not ready to apply yet: documents not received." (unknown token: the generic reason). */
export function visaNotReadyText(token: string | null | undefined): string {
  const reason = token && Object.hasOwn(VISA_NOT_READY_REASON, token) ? VISA_NOT_READY_REASON[token as VisaNotReadyToken] : 'finish this passenger’s row first';
  return VISA_ERROR_TEXT.not_ready.replace('{reason}', reason);
}

/** The command may have committed before the failure: never claim "nothing changed". */
export const VISA_UNKNOWN_OUTCOME_TEXT =
  'We could not confirm this was saved. Reload the page to check before you try again. Your typed details are still here.';

// ---------------------------------------------------------------------------
// Status words (section 8, frozen)
// ---------------------------------------------------------------------------

/** Task status words (queue, header, Deal summary): not_taken, the first unfinished step, completed. */
export const VISA_TASK_STATUS_WORD = {
  not_taken: 'Not taken',
  ready: 'Documents and date pending',
  applied: 'Not applied yet',
  decision: 'Waiting for decision',
  handover: 'Handover pending',
  completed: 'Completed',
} as const satisfies Record<'not_taken' | VisaTaskStep | 'completed', string>;

export const VISA_STEP_LABEL: Record<VisaStepKey, string> = {
  take: 'Task taken',
  ready: 'Documents and date',
  applied: 'Applied',
  decision: 'Decision',
  handover: 'Handover',
};

/** Step bar words of a step that is not the current one (the current one shows "x of y" or "Now"). */
export const VISA_STEP_WORD = { done: 'Completed', pending: 'Pending', now: 'Now', progress: '{x} of {y}' } as const;

/** Applicant words (section 8). */
export const VISA_APPLICANT_WORD = {
  notApplied: 'Not applied',
  ready: 'Ready',
  inAppointment: 'in Appointment',
  applied: 'Applied · waiting for decision',
  approved: 'Approved',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  removed: 'Removed from the booking',
  travellerChanged: 'Traveller changed',
  closed: 'Closed',
  secondApplication: 'Second application',
} as const;

/** Applicant state words by database state (submitted and decision_pending both read as Applied). */
export const VISA_APPLICATION_STATE_WORD: Record<VisaApplicationState, string> = {
  docs_pending: VISA_APPLICANT_WORD.notApplied,
  submitted: VISA_APPLICANT_WORD.applied,
  decision_pending: VISA_APPLICANT_WORD.applied,
  issued: VISA_APPLICANT_WORD.approved,
  refused: VISA_APPLICANT_WORD.rejected,
  withdrawn: VISA_APPLICANT_WORD.withdrawn,
};

export const VISA_KIND_LABEL: Record<VisaKind, string> = { e_visa: 'E-visa', sticker: 'Sticker visa' };
export const VISA_KIND_NOT_DECIDED = 'Not decided yet';

/** Handover words (section 10). */
export const VISA_HANDOVER_LABEL: Record<VisaHandoverMethod, string> = {
  office: 'Customer collects from the office',
  executive: 'Our executive delivers',
  courier: 'By courier',
  not_with_us: 'Passport is not with us',
};

export const VISA_HANDOVER_TEXT = {
  /** The CRM sends nothing (R8): "sent to", never "e-mailed". */
  evisaSent: 'E-visa sent to {email}',
  stickerReturn: 'Sticker visa return',
  passportReturn: 'Passport return',
  courierNumber: 'Courier number {number}',
  delivered: 'Delivered {date}',
  notDecided: 'Not decided yet',
  setHandover: 'Set handover',
  legacyReturned: 'Returned {date}',
  notRecorded: 'Not recorded',
  recordHandover: 'Record handover',
  customerTold: 'Customer told',
} as const;

export const VISA_CLOSED_REASON_LABEL: Record<VisaClosedReason, string> = {
  evisa_sent: 'E-visa sent to the customer',
  refusal_told: 'Customer told about the refusal',
  not_with_us: 'Passport is not with us',
  courier_dispatched: 'Sent by courier',
  delivered: 'Delivered',
  customer_informed: 'Customer informed',
  reapplied: 'Applied again',
  legacy: 'Closed',
};

/** Visa line under the passenger's name (H:15270). */
export const VISA_LINE_TEXT = {
  evisa: 'E-visa · Passport photo only',
  sticker: 'Sticker visa',
  passportWithUs: 'Passport with us',
  passportNotWithUs: 'Passport not with us',
  passportReturned: 'Passport returned',
  jurisdiction: 'Jurisdiction {place}',
  noJurisdiction: 'No jurisdiction',
} as const;

export const VISA_COST_KIND_LABEL: Record<VisaCostKind, string> = {
  government_fee: 'Government fee',
  service_fee: 'Service fee',
  other: 'Other visa cost',
};

export const VISA_TEXT = {
  managerBanner: 'View only. The Visa desk does this work.',
  passportHidden: 'Passport shown to the assigned executive',
  applicantsAfterTake: 'Applicants appear when the task is taken.',
  addedAfterCompletion: '{n} travellers added after completion have no visa application',
  bookingChanged: 'Booking version {n} changed this task',
  salesBlankHint: 'Sales did not set this on the booking.',
  evisaEmailHint: 'Record where you sent the e-visa. The CRM does not send it.',
  rejectEvisaHint: 'Saving records that the customer was told.',
  feeToAccounts: 'Company-paid fees go to Accounts for review once the receipt is attached.',
  uploadMarksReceived: 'Saving marks it received.',
  costSummaryTitle: 'Visa costs per traveller',
  costSummaryText: 'Fees recorded per traveller for Accounts. These are costs, not the customer’s price.',
  taskLevelFees: 'Task-level fees (recorded before per-passenger fees)',
  reasonNotRecorded: 'Reason not recorded',
  feePaidByAccountsReview: '(recorded for Accounts review)',
  notAvailable: 'This task is not available to you. It may not exist, or you may not have access.',
  appliedTogether: 'Applied together: {n} travellers',
  reapplyConfirm: 'Start a new application for {name}? The rejected one stays in History.',
} as const;

/** Home rows (section 8). */
export const VISA_HOME_ROW_LABEL = {
  visaApplicantsWaitingResult: 'Travellers waiting for a visa result',
  visaHandoverPending: 'Visa handovers to finish',
  visaFeesReturned: 'Visa fees returned by Accounts',
  visaFeesWithoutReceipt: 'Visa fees waiting for a receipt',
  visaTravellerChanged: 'Travellers changed in the booking',
  salesVisaResultsToSee: 'Visa results to see',
} as const;

/** Deal History "Visa and passport" group titles (deal_visa_history kinds). */
export const VISA_DEAL_HISTORY_TITLE: Record<VisaDealHistoryKind, string> = {
  taken: 'Visa task taken',
  applied: 'Applied',
  approved: 'Visa approved',
  rejected: 'Visa rejected',
  withdrawn: 'Withdrawn by customer',
  evisa_sent: 'E-visa sent to the customer',
  handed_over: 'Passport handover recorded',
  delivered: 'Passport delivered',
  reapplied: 'Applied again',
  completed: 'Visa task completed',
};

/** Deal page "Visa results" notice words (Q11). */
export const VISA_NOTICE_TEXT = {
  approved: 'Visa approved for {name}',
  rejected: 'Visa rejected for {name}',
  unnamed: 'the traveller',
  ack: 'OK, seen',
} as const;

// ---------------------------------------------------------------------------
// Form field names (the screens post these; the actions read only these)
// ---------------------------------------------------------------------------

export const VISA_FIELD = {
  taskId: 'taskId',
  dealId: 'dealId',
  applicationId: 'applicationId',
  documentId: 'documentId',
  entryId: 'entryId',
  noticeId: 'noticeId',
  evidenceId: 'evidenceId',
  expectedRowVersion: 'expectedRowVersion',
  requestId: 'requestId',
  file: 'file',
  kind: 'kind',
  // Passengers row (C2)
  appointmentDate: 'appointmentDate',
  appointmentTime: 'appointmentTime',
  remark: 'remark',
  passportNumber: 'passportNumber',
  visaKind: 'visaKind',
  jurisdiction: 'jurisdiction',
  jurisdictionPlace: 'jurisdictionPlace',
  /** Every document id shown on the row (repeated); unlisted documents are left as they are. */
  documentIds: 'documentIds',
  /** The ticked (received) document ids (repeated). */
  receivedDocumentIds: 'receivedDocumentIds',
  // Add document (C3)
  catalogueCode: 'catalogueCode',
  label: 'label',
  received: 'received',
  /** The document's current status on the page ('received' | 'not_received'), for the upload follow-up. */
  documentStatus: 'documentStatus',
  // Applied (C5): per applicant fields are visaApplicantField(i, key)
  applicantCount: 'applicantCount',
  passportTaken: 'passportTaken',
  paidBy: 'paidBy',
  paymentMode: 'paymentMode',
  receiptEvidenceId: 'receiptEvidenceId',
  // Decision, handover, delivery, withdraw (C6 - C9)
  decision: 'decision',
  outcomeEvidenceId: 'outcomeEvidenceId',
  reason: 'reason',
  recipientEmail: 'recipientEmail',
  handoverMethod: 'handoverMethod',
  courierNumber: 'courierNumber',
  customerTold: 'customerTold',
  customerInformed: 'customerInformed',
  deliveredOn: 'deliveredOn',
  // Fix fee (C12) and other visa costs (section 16)
  amount: 'amount',
  paidOn: 'paidOn',
  reference: 'reference',
} as const;

export const VISA_APPLICANT_FIELD_KEYS = [
  'applicationId',
  'expectedRowVersion',
  'reference',
  'appliedOn',
  'governmentFee',
  'serviceFee',
] as const;
export type VisaApplicantFieldKey = (typeof VISA_APPLICANT_FIELD_KEYS)[number];

/** Field name of one applicant line in the Mark as applied / Confirm applied popups: "applicants[0].reference". */
export function visaApplicantField(index: number, key: VisaApplicantFieldKey): string {
  return `applicants[${index}].${key}`;
}

/** Result of every Visa action (fits useActionState). */
export type VisaActionResult<T> =
  | { ok: true; data: T; message: string }
  | {
      ok: false;
      code: VisaFailureCode;
      message: string;
      /**
       * Refused input keys from the database hint (invalid_input, duplicate_reference: e.g.
       * "applicants[1].reference", "visaKind") or the applicant of a not_ready refusal
       * ("applicants[1]"). The screens highlight these; never shown as text.
       */
      fields?: string[];
    };

/** Success messages of the Visa actions. */
export const VISA_DONE_TEXT = {
  claimed: 'You have taken this task. Fill each passenger’s documents and date next.',
  claimedExisting: 'This task is already yours.',
  rowSaved: 'Passenger saved.',
  rowSavedReady: 'Passenger saved. Ready for Appointment.',
  documentAdded: 'Document added.',
  documentRemoved: 'Document removed from the list.',
  appliedOne: 'Saved as applied. Waiting for the decision.',
  appliedMany: 'Saved as applied for {n} passengers. Waiting for the decision.',
  approved: 'Approval saved.',
  rejected: 'Rejection saved.',
  handoverSaved: 'Handover saved.',
  delivered: 'Delivery saved.',
  withdrawn: 'Withdrawal saved.',
  reapplied: 'New application started. The rejected one stays in History.',
  travellerConfirmed: 'Traveller change checked.',
  feeSent: 'Fee sent to Accounts.',
  otherCostSaved: 'Cost saved.',
  otherCostSavedDraft: 'Cost saved. Attach the receipt and send it to Accounts.',
  noticeSeen: 'Noted.',
  fileStored: 'File uploaded.',
  fileStoredReceived: 'File uploaded and the document marked received.',
  fileStoredNotMarked: 'File uploaded. The document is not marked received yet: {reason} Tick it in the row.',
  closedSuffix: ' This passenger is closed.',
  completedSuffix: ' Every passenger is closed, so the task is completed.',
} as const;

export const VISA_EVIDENCE_BUCKET = 'department-evidence';
export const VISA_EVIDENCE_MAX_BYTES = 4 * 1024 * 1024;
