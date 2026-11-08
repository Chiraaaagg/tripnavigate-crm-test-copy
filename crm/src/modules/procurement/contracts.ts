import type { PurchaseTaskView } from '@/modules/fulfilment/contracts';

/**
 * Phase 4 procurement contract (docs/implementation/phase-4/contract.md).
 * Lead-owned. Words shown to staff are frozen here.
 *
 * A claimed task is NOT a booked hotel. Only a supplier confirmation with
 * stored proof moves a task to 'supplier_confirmed'. Nothing here creates a
 * payable, payment or invoice. Purchase types carry no selling price, margin
 * or acceptance proof; Sales never receives these types at all.
 */

export const PURCHASE_EVIDENCE_BUCKET = 'purchase-evidence';
export const PURCHASE_EVIDENCE_MAX_BYTES = 4 * 1024 * 1024;
export const PURCHASE_EVIDENCE_SIGNED_URL_SECONDS = 60;

export type SupplierServiceType = 'hotel' | 'transfer' | 'activity';
export type SupplierStatus = 'active' | 'archived';
export type SupplierVerification = 'unverified' | 'verified';
export type QuoteStatus = 'open' | 'withdrawn' | 'selected';
export type CostStage = 'proposed' | 'committed';
export type PurchaseEvidenceKind = 'quote' | 'supplier_confirmation' | 'other';
export type PurchaseEvidenceStatus = 'pending_upload' | 'stored' | 'failed' | 'removed';

export type ProcurementErrorCode =
  | 'not_authorized'
  | 'not_found'
  | 'version_changed'
  | 'task_conflict'
  | 'not_ready'
  | 'over_budget'
  | 'procurement_disabled'
  | 'environment_unset'
  | 'already_confirmed'
  | 'invalid_input'
  | 'evidence_rejected'
  | 'supplier_exists'
  | 'deal_removed'
  // Purchase build (migration 20261130000100, contract A): go-ahead, e-mail, cancellation.
  | 'go_ahead_missing'
  | 'booking_request_not_sent'
  | 'booking_not_approved'
  | 'trip_cancelled'
  | 'payment_in_progress'
  | 'not_self_approval'
  | 'already_decided'
  | 'duplicate_request'
  | 'not_configured';

export type ProcurementIssueCode =
  | 'environment_unset'
  | 'procurement_disabled'
  | 'missing_quote'
  | 'missing_cost'
  | 'cost_not_for_quote'
  | 'over_budget'
  | 'missing_supplier_confirmation_proof'
  | 'evidence_upload_incomplete'
  | 'deal_removed'
  // Purchase build (20261130000100): listed after the Phase 4 issues.
  | 'trip_cancelled'
  | 'booking_request_not_sent'
  | 'go_ahead_missing';

export interface SupplierFields {
  name: string;
  serviceTypes: SupplierServiceType[];
  city: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  paymentTerms: string | null;
  status?: SupplierStatus;
}

export interface SupplierSummary {
  supplierId: string;
  name: string;
  serviceTypes: SupplierServiceType[];
  city: string | null;
  verificationStatus: SupplierVerification;
  status: SupplierStatus;
}

export type BeneficiaryStatus = 'unverified' | 'approved';

export interface BeneficiaryRevisionView {
  revisionNo: number;
  accountHolder: string;
  bankName: string;
  ifsc: string;
  /** Only the last 4 digits ever leave the database. */
  accountLast4: string;
  /** P4-D4: a manager (never the recorder) approves the latest revision. Never used for payment. */
  status: BeneficiaryStatus;
  createdAt: string;
  createdByName: string | null;
  approvedAt: string | null;
  approvedByName: string | null;
  /** The viewer is a manager who may approve this revision now. */
  canApprove: boolean;
}

export interface SupplierDetailView extends SupplierSummary {
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  paymentTerms: string | null;
  rowVersion: number;
  updatedAt: string;
  verifiedAt: string | null;
  verifiedByName: string | null;
  /** Purchase in the entity: may edit details and record bank details. */
  canEdit: boolean;
  /** Manager in the entity (not the person who last entered the details): may verify now. */
  canVerify: boolean;
  beneficiaries: BeneficiaryRevisionView[];
}

export interface QuoteView {
  quoteId: string;
  supplierId: string;
  supplierName: string;
  supplierVerification: SupplierVerification;
  hotelName: string;
  roomType: string | null;
  mealPlan: string | null;
  quotedCostPaise: string;
  holdUntil: string | null;
  cancellationTerms: string | null;
  status: QuoteStatus;
  createdAt: string;
  createdByName: string | null;
  /** Purchase build: rate per room per night (hotel), when the supplier gave one. Null otherwise and on older rows. */
  perRoomNightPaise: string | null;
  /** Purchase build: short note on the rate (up to 300 characters). */
  note: string | null;
}

export interface CostVersionView {
  versionNo: number;
  quoteId: string;
  stage: CostStage;
  amountPaise: string;
  dueDate: string | null;
  note: string | null;
  /** Always 'not_requested' in Phase 4: no payable is created. */
  payableStatus: 'not_requested';
  createdAt: string;
  createdByName: string | null;
  /** P4-D2: the branch manager approved this version above the budget. */
  overBudgetApprovedAt: string | null;
  overBudgetApprovedByName: string | null;
}

export interface PurchaseEvidenceView {
  id: string;
  kind: PurchaseEvidenceKind;
  fileName: string;
  mime: string;
  sizeBytes: number;
  status: Exclude<PurchaseEvidenceStatus, 'removed'>;
  createdAt: string;
  uploadedByName: string | null;
}

export interface PurchaseWorkspaceView {
  task: PurchaseTaskView;
  canWork: boolean;
  /** The assignee may hand the task back (P4-D5). */
  canRelease: boolean;
  /** Manager of the deal's branch: may reassign the in-progress task (P4-D5). */
  canReassign: boolean;
  /** Manager of the deal's branch: may approve the latest proposed cost above the budget (P4-D2). */
  canApproveOverBudget: boolean;
  assigneeUserId: string | null;
  /** Other active Purchase people in the entity (only when canReassign). */
  reassignCandidates: Array<{ userId: string; name: string }>;
  gateIssue: 'environment_unset' | 'procurement_disabled' | 'deal_removed' | null;
  issues: ProcurementIssueCode[];
  supplierReference: string | null;
  selectedQuoteId: string | null;
  supplierConfirmedByName: string | null;
  quotes: QuoteView[];
  costVersions: CostVersionView[];
  evidence: PurchaseEvidenceView[];
  /**
   * Active suppliers of the task's service type for the rate and e-mail forms
   * (empty when the viewer cannot work the task). Purchase build: e-mail added.
   */
  supplierChoices: SupplierChoice[];
  // --- Purchase build (20261130000100) -------------------------------------
  /** Accounts go-ahead for hotel commitments ('not_needed' for transfer and activity tasks). */
  goAhead: GoAheadView;
  /** Rate and booking request e-mails recorded on this task, newest first. */
  emails: SupplierEmailView[];
  /** The Deal's trip cancellation as this task sees it; null when the trip is not cancelled. */
  cancellation: TaskCancellationView | null;
  /** Server switch supplier_email_sending_enabled: true = "Send" through the CRM; false = draft, copy, open in e-mail app, mark as sent. */
  emailSendingEnabled: boolean;
}

export interface SupplierChoice {
  supplierId: string;
  name: string;
  verificationStatus: SupplierVerification;
  /** Purchase build: the supplier's contact e-mail (prefills "To"); null when none recorded. */
  email: string | null;
}

// ---------------------------------------------------------------------------
// Purchase build (migration 20261130000100): go-ahead, supplier e-mail,
// trip cancellation. Purchase types never carry selling price, margin,
// receipts, funding reasons or customer-side cancellation amounts.
// ---------------------------------------------------------------------------

/**
 * Computed, never stored: 'approved' only while the approved request matches
 * the item's current accepted booking version AND the latest agreed cost
 * version AND its offer. 'stale' = the latest request no longer matches.
 */
export type GoAheadState = 'not_needed' | 'not_requested' | 'pending' | 'approved' | 'returned' | 'stale';
/** Stored status of one request. 'superseded' = a stale pending request replaced by a newer booking request. */
export type GoAheadRequestStatus = 'pending' | 'approved' | 'returned' | 'superseded';
export type GoAheadDecision = 'approve' | 'return';

export interface GoAheadView {
  state: GoAheadState;
  /** The latest request (null when none). */
  requestId: string | null;
  costVersionNo: number | null;
  requestedAt: string | null;
  requestedByName: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  /** Accounts' reason when the latest request was returned. */
  returnReason: string | null;
}

export type SupplierEmailKind = 'rate_request' | 'booking_request';
/** marked_sent = sent by the person from their own e-mail app (switch off); queued/sent/failed = sent through the CRM (switch on). */
export type SupplierEmailStatus = 'marked_sent' | 'queued' | 'sent' | 'failed';

export interface SupplierEmailView {
  emailId: string;
  kind: SupplierEmailKind;
  supplierId: string;
  supplierName: string;
  toEmail: string;
  ccEmails: string[];
  subject: string;
  body: string;
  status: SupplierEmailStatus;
  /** booking_request: the cost version it asked the supplier to book. */
  costVersionNo: number | null;
  sentAt: string;
  sentByName: string | null;
  /** Only "the e-mail could not be sent"; provider details never reach the page. */
  failed: boolean;
}

export type CancellationStatus = 'open' | 'charges_entered' | 'sent_to_manager' | 'approved';
export type CancellationDecision = 'approve' | 'return';

/** What the supplier keeps and refunds on one task (latest revision). Purchase and the branch Manager only. */
export interface CancellationChargeView {
  taskId: string;
  revisionNo: number;
  supplierId: string;
  supplierName: string;
  /** Snapshot of the task's latest cost when the charge was entered. */
  committedCostPaise: string;
  supplierKeepsPaise: string;
  supplierRefundPaise: string;
  note: string | null;
  creditNoteEvidenceId: string | null;
  enteredAt: string;
  enteredByName: string | null;
}

export interface TaskCancellationView {
  cancellationId: string;
  status: CancellationStatus;
  /** The Manager's reason for the trip cancellation (never a customer amount). */
  reason: string;
  openedAt: string;
  openedByName: string | null;
  rowVersion: number;
  /** The Manager's reason when the charges were last sent back. */
  returnReason: string | null;
  /** This task's current charge, null until entered. */
  myCharge: CancellationChargeView | null;
  /** The viewer may enter or change this task's charge now. */
  canEnter: boolean;
  /** The viewer may send the Deal's charges to the Manager now. */
  canSend: boolean;
  /** Purchase tasks of the Deal with an agreed or committed cost that still have no charge. */
  chargesMissing: number;
}

/** Accounts: one hotel go-ahead request (accounts_go_ahead_list). Accounts sees the supplier cost; never the selling price. */
export interface AccountsGoAheadRow {
  requestId: string;
  status: GoAheadRequestStatus;
  /** False when the booking version, cost version or offer changed since the request (approve then refuses version_changed). */
  current: boolean;
  dealId: string;
  dealReference: string;
  branchName: string;
  taskId: string;
  itemTitle: string;
  checkIn: string | null;
  checkOut: string | null;
  supplierName: string;
  amountPaise: string;
  costVersionNo: number;
  requestedAt: string;
  requestedByName: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  returnReason: string | null;
  rowVersion: number;
  /** Accounts review of that booking version; approve needs 'approved'. 'missing' = not sent for review yet. */
  bookingReviewStatus: 'pending' | 'returned' | 'approved' | 'missing';
  /** The viewer may approve or return it now (pending, current, not their own request). */
  canDecide: boolean;
}

/** Manager: one trip cancellation of a Deal in the Manager's branches (manager_cancellation_list). */
export interface ManagerCancellationRow {
  cancellationId: string;
  dealId: string;
  dealReference: string;
  branchName: string;
  status: CancellationStatus;
  reason: string;
  openedAt: string;
  openedByName: string | null;
  sentAt: string | null;
  sentByName: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  returnReason: string | null;
  rowVersion: number;
  charges: Array<CancellationChargeView & { itemTitle: string }>;
  totalKeepsPaise: string;
  totalRefundPaise: string;
  /** The viewer may approve or return now (sent to the Manager, viewer entered no current charge). */
  canDecide: boolean;
}

/** Deal page: the trip-cancellation state (deal_cancellation_summary). No amounts. */
export interface DealCancellationSummary {
  /** Branch Manager of the Deal and no cancellation exists yet. */
  canOpen: boolean;
  cancellation: {
    cancellationId: string;
    status: CancellationStatus;
    reason: string;
    openedAt: string;
    openedByName: string | null;
    decidedAt: string | null;
  } | null;
}

/** Purchase queue flags per task (purchase_task_list additions). */
export interface PurchaseQueueFlags {
  goAheadState: GoAheadState;
  tripCancelled: boolean;
}

// ---- Action result shapes (data of ProcurementActionResult) ----------------

export interface EmailRecordResult {
  emailId: string;
  status: SupplierEmailStatus;
  outcome: 'created' | 'existing';
}

export interface BookingRequestResult extends EmailRecordResult {
  /** Hotel: the go-ahead request (new or the existing matching one); null for transfer and activity. */
  goAheadRequestId: string | null;
  goAheadState: GoAheadState;
}

export interface GoAheadDecisionResult {
  requestId: string;
  status: 'approved' | 'returned';
  outcome: 'created' | 'existing';
}

export interface CancellationResult {
  cancellationId: string;
  status: CancellationStatus;
  rowVersion: number;
  outcome: 'created' | 'existing';
}

export interface CancellationChargeResult {
  cancellationId: string;
  revisionNo: number;
  status: CancellationStatus;
  outcome: 'created' | 'existing';
}

/**
 * Server actions added by the Purchase build ('use server', modules/procurement/server/actions.ts).
 * Each takes (prev, formData) and returns ProcurementActionResult<...>.
 */
export const PURCHASE_BUILD_ACTIONS = {
  /** Rate request: Purchase assignee. Switch off = "Mark as sent"; on = send through the CRM. Fields: taskId, supplierId, to, cc, subject, body, requestId. */
  recordRateRequest: 'recordRateRequestAction',
  /** "Send booking request": Purchase assignee. Fields: taskId, expectedVersionNo, to, cc, subject, body, requestId. */
  sendBookingRequest: 'sendBookingRequestAction',
  /** Accounts: approve or return a hotel go-ahead. Fields: goAheadRequestId, decision, reason (return), rowVersion, requestId. */
  decideGoAhead: 'decideGoAheadAction',
  /** Branch Manager: "Trip cancelled" on the Deal. Fields: dealId, reason, requestId. */
  openTripCancellation: 'openTripCancellationAction',
  /** Purchase: what the supplier keeps and refunds. Fields: taskId, keepsRupees, refundRupees, note, creditNoteEvidenceId, expectedRevisionNo, requestId. */
  setCancellationCharge: 'setCancellationChargeAction',
  /** Purchase: "Send charges to the Manager". Fields: cancellationId, rowVersion, requestId (taskId optional: the page to refresh). */
  sendCancellationCharges: 'sendCancellationChargesAction',
  /** Branch Manager: approve or return the charges. Fields: cancellationId, decision, reason (return), rowVersion, requestId. */
  decideCancellation: 'decideCancellationAction',
  /** Super Admin: switch supplier e-mail sending on or off. Fields: enabled ('true'|'false'), reason. */
  setSupplierEmailSending: 'setSupplierEmailSendingAction',
} as const;

/**
 * Existing addQuoteAction also accepts perRoomNightRupees (hotel only) and
 * quoteNote (up to 300 characters). Pure helpers for the e-mail drawer live in
 * modules/procurement/email-draft.ts (buildSupplierEmailDraft,
 * buildMailtoHref, draftAsText); bookingRequestVersionNo in dto.ts gives the
 * expectedVersionNo for "Send booking request".
 */

/** Reads added by the Purchase build (modules/procurement/server/queries.ts). */
export const PURCHASE_BUILD_QUERIES = {
  accountsGoAhead: 'loadAccountsGoAheadList',
  managerCancellations: 'loadManagerCancellations',
  dealCancellation: 'loadDealCancellation',
  queueFlags: 'loadPurchaseQueueFlags',
} as const;

export type ProcurementActionResult<T> =
  | { ok: true; data: T; message: string }
  | {
      ok: false;
      code: ProcurementErrorCode | 'upload_failed' | 'session';
      message: string;
      /** What the person typed, returned so a refused form can show it again (never commercial values). */
      values?: Record<string, string>;
    };

// ---------------------------------------------------------------------------
// Frozen wording
// ---------------------------------------------------------------------------

export const SERVICE_TYPE_LABEL: Record<SupplierServiceType, string> = {
  hotel: 'Hotel',
  transfer: 'Transfer',
  activity: 'Activity',
};

export const VERIFICATION_LABEL: Record<SupplierVerification, string> = {
  unverified: 'Details not verified',
  verified: 'Verified',
};

export const QUOTE_STATUS_LABEL: Record<QuoteStatus, string> = {
  open: 'Open offer',
  withdrawn: 'Withdrawn',
  selected: 'Chosen · supplier confirmed',
};

export const COST_STAGE_LABEL: Record<CostStage, string> = {
  proposed: 'Proposed cost',
  committed: 'Committed cost',
};

export const PURCHASE_EVIDENCE_KIND_LABEL: Record<PurchaseEvidenceKind, string> = {
  quote: 'Supplier quote',
  supplier_confirmation: 'Supplier confirmation email',
  other: 'Other Purchase file',
};

export const PROCUREMENT_ISSUE_TEXT: Record<ProcurementIssueCode, string> = {
  environment_unset: 'This CRM environment is not set up yet. Ask an admin.',
  procurement_disabled:
    'Supplier confirmation is turned off for real bookings until the owner approves the Purchase rules. Your work is saved.',
  missing_quote: 'Add at least one open supplier offer.',
  missing_cost: 'Propose the cost you agreed with the supplier.',
  cost_not_for_quote: 'The latest cost belongs to an offer that is no longer open. Propose the cost again for an open offer.',
  over_budget:
    'The cost is above the approved Purchase budget. The manager of the deal’s branch must approve this cost version before the supplier confirmation can be recorded.',
  missing_supplier_confirmation_proof:
    'Upload the supplier’s confirmation email, saved as a PDF or a screenshot (JPG, PNG or WebP).',
  evidence_upload_incomplete: 'A file did not finish uploading. Remove it or upload it again.',
  deal_removed: 'This deal was removed from the CRM by the Bitrix sync because it no longer matches the import settings (start date, pipeline or stage). New work is paused; recorded money and history stay.',
  trip_cancelled: 'The branch Manager marked this trip cancelled. New bookings, payments and confirmations are stopped. Enter what the supplier keeps and refunds instead.',
  booking_request_not_sent: 'Send the booking request for the latest final rate to the supplier first.',
  go_ahead_missing: 'Accounts has not given the go-ahead for this hotel at the latest final rate yet. Send the booking request and wait for Accounts.',
};

export const PROCUREMENT_ERROR_TEXT: Record<ProcurementErrorCode | 'upload_failed' | 'session', string> = {
  not_authorized:
    'You can’t do this. Only the Purchase colleague who took this task works on it, managers approve, and nobody approves their own entry.',
  not_found: 'We couldn’t find this. It may have been removed, or you may not have access.',
  version_changed: 'Someone changed this after you opened it. Nothing was saved. Review the latest details and try again.',
  task_conflict: 'This task was already handled differently by someone else. Reload to see the latest state.',
  not_ready: 'Some things are missing. Nothing was confirmed. Fix the items listed and try again.',
  over_budget: PROCUREMENT_ISSUE_TEXT.over_budget,
  procurement_disabled: PROCUREMENT_ISSUE_TEXT.procurement_disabled,
  environment_unset: PROCUREMENT_ISSUE_TEXT.environment_unset,
  already_confirmed: 'The supplier already confirmed this hotel. Changes after confirmation aren’t supported yet.',
  invalid_input: 'Some details aren’t valid. Check the fields and try again.',
  evidence_rejected:
    'This file can’t be used. Upload a PDF, JPG, PNG or WebP up to 4 MB (at most 10 files). Save emails as PDF or a screenshot; .eml files aren’t accepted.',
  supplier_exists: 'A supplier with this name already exists in this company.',
  deal_removed: PROCUREMENT_ISSUE_TEXT.deal_removed,
  go_ahead_missing: PROCUREMENT_ISSUE_TEXT.go_ahead_missing,
  booking_request_not_sent: PROCUREMENT_ISSUE_TEXT.booking_request_not_sent,
  booking_not_approved:
    'Accounts must approve the booking review for this booking version before giving the go-ahead. Nothing was approved.',
  trip_cancelled: PROCUREMENT_ISSUE_TEXT.trip_cancelled,
  payment_in_progress:
    'A supplier payment request is open on this rate. The final rate can’t change until that payment request is cancelled or returned.',
  not_self_approval: 'You can’t approve your own request or your own entry. Another colleague must decide.',
  already_decided: 'This was already decided by someone else. Reload to see the latest state.',
  duplicate_request: 'This was already sent with different details. Reload the page before you try again.',
  not_configured: 'Accounts work is not set up for this company yet. Ask an admin.',
  upload_failed: 'The file was not accepted and does not count. Remove it if it is listed, then upload it again.',
  // G-06
  session: 'You were signed out. Sign in again; what you typed is still on this page.',
};

// G-05
export const PROCUREMENT_UNKNOWN_OUTCOME_TEXT = 'We could not confirm this was saved. Reload the page to check before you try again. Your typed details are still here.';

/** What the supplier-confirmation dialog must say before the irreversible action. */
export const SUPPLIER_CONFIRM_DIALOG_TEXT = {
  title: 'Record that the supplier confirmed this hotel?',
  body: [
    'This records the supplier’s confirmation reference and commits the latest proposed cost.',
    'The task is then locked: offers, costs and files can’t be changed afterwards.',
    'It does not pay the supplier, create a bill or invoice, or message the customer.',
  ],
  confirmLabel: 'Record supplier confirmation',
  cancelLabel: 'Go back',
} as const;

export const SUPPLIER_CONFIRM_SUCCESS_TEXT =
  'Supplier confirmation recorded. The cost is committed; no payment or invoice was created.';

/** Shown where a beneficiary is listed (P4-D4). */
export const BENEFICIARY_NOTICE =
  'A manager who did not record them approves the latest bank details. Supplier payments are held until then; Accounts pays only to approved details, and the CRM never sends money itself.';

export const BENEFICIARY_STATUS_LABEL: Record<BeneficiaryStatus, string> = {
  unverified: 'not approved',
  approved: 'approved by a manager',
};

/** Upload hint for Purchase files (P4-D3: supplier confirmations mostly arrive by email). */
export const PURCHASE_FILE_HINT =
  'PDF, JPG, PNG or WebP, up to 4 MB. Up to 10 files. Save a supplier’s email as PDF or take a screenshot; .eml files aren’t accepted.';

/** Manager and assignee actions added by amendment A1 (contract §9). */
export const A1_TEXT = {
  verifyLabel: 'Mark supplier verified',
  verifyHelp: 'You checked these supplier details. Any later change by Purchase marks them not verified again.',
  verifyDone: 'Supplier marked verified.',
  verifyExisting: 'This supplier was already verified. Nothing changed.',
  approveBankLabel: 'Approve these bank details',
  approveBankDone: 'Bank details approved. Nothing is paid from them in this CRM.',
  approveBankExisting: 'These bank details were already approved. Nothing changed.',
  approveCostLabel: 'Approve this cost above budget',
  approveCostHelp: 'Approves only this cost version. If Purchase proposes a newer cost, it needs a new approval. Nothing is paid.',
  approveCostDone: 'Cost approved above budget for this version only.',
  approveCostExisting: 'This cost version was already approved. Nothing changed.',
  releaseLabel: 'Hand the task back',
  releaseHelp: 'The task goes back to the queue. Offers, costs and files stay for the next person.',
  releaseDone: 'Task handed back. A Purchase colleague can take it now.',
  releaseExisting: 'This task was already handed back. Nothing changed.',
  reassignLabel: 'Reassign task',
  reassignHelp: 'Moves the task to another Purchase colleague. Offers, costs and files stay.',
  reassignDone: 'Task reassigned.',
  reassignExisting: 'The task is already with this person. Nothing changed.',
  reassignNobody: 'No other active Purchase colleague can take this task.',
} as const;

// ---------------------------------------------------------------------------
// Purchase build frozen wording (20261130000100)
// ---------------------------------------------------------------------------

export const GO_AHEAD_STATE_LABEL: Record<GoAheadState, string> = {
  not_needed: 'No go-ahead needed',
  not_requested: 'Booking request not sent',
  pending: 'Waiting for Accounts go-ahead',
  approved: 'Accounts go-ahead given',
  returned: 'Go-ahead returned by Accounts',
  stale: 'Go-ahead out of date · send the booking request again',
};

export const SUPPLIER_EMAIL_KIND_LABEL: Record<SupplierEmailKind, string> = {
  rate_request: 'Rate request',
  booking_request: 'Booking request',
};

export const SUPPLIER_EMAIL_STATUS_LABEL: Record<SupplierEmailStatus, string> = {
  marked_sent: 'Marked as sent',
  queued: 'Sending…',
  sent: 'Sent',
  failed: 'Not sent',
};

export const CANCELLATION_STATUS_LABEL: Record<CancellationStatus, string> = {
  open: 'Trip cancelled · charges not entered',
  charges_entered: 'Charges entered · not sent to the Manager',
  sent_to_manager: 'Charges sent to the Manager',
  approved: 'Charges approved by the Manager',
};

export const PURCHASE_BUILD_TEXT = {
  rateRequestLabel: 'Ask for rates',
  bookingRequestLabel: 'Send booking request',
  bookingRequestAgainLabel: 'Send booking request again',
  bookingRequestHelp:
    'Records the booking request to the supplier and, for a hotel, asks Accounts for the go-ahead at this final rate. Nothing is paid.',
  copyDraftLabel: 'Copy draft',
  openInEmailAppLabel: 'Open in e-mail app',
  markAsSentLabel: 'Mark as sent',
  sendLabel: 'Send',
  emailOffNotice: 'E-mails are not sent from the CRM yet. Send it from your own e-mail, then press “Mark as sent”.',
  emailMarkedSent: 'Recorded as sent.',
  emailSent: 'E-mail sent to the supplier.',
  emailExisting: 'This e-mail was already recorded. Nothing changed.',
  emailSendFailed:
    'The e-mail could not be sent from the CRM. It is recorded as not sent. Copy the draft and send it from your own e-mail.',
  bookingRequestRecorded: 'Booking request recorded. Accounts will review the go-ahead for this hotel.',
  bookingRequestRecordedNoGoAhead: 'Booking request recorded.',
  goAheadApproveLabel: 'Give go-ahead',
  goAheadReturnLabel: 'Return to Purchase',
  goAheadApproved: 'Go-ahead given for this hotel at this rate. Nothing is paid.',
  goAheadReturned: 'Go-ahead returned to Purchase with your reason.',
  goAheadExisting: 'This decision was already recorded. Nothing changed.',
  tripCancelLabel: 'Trip cancelled',
  tripCancelHelp:
    'Stops new bookings, payments and supplier confirmations on this Deal. Purchase then enters what each supplier keeps and refunds. The customer refund is not handled here.',
  tripCancelDone: 'Trip marked cancelled. Purchase will enter the supplier charges.',
  chargeSaved: 'Supplier charges saved. Send them to the Manager when every service has its charges.',
  chargeExisting: 'These charges were already saved. Nothing changed.',
  sendChargesLabel: 'Send charges to the Manager',
  chargesSent: 'Charges sent to the Manager.',
  chargesApproveLabel: 'Approve charges',
  chargesReturnLabel: 'Return to Purchase',
  chargesApproved: 'Cancellation charges approved.',
  chargesReturned: 'Charges returned to Purchase with your reason.',
  switchOn: 'Supplier e-mails are now sent from the CRM.',
  switchOff: 'Supplier e-mails are no longer sent from the CRM. Staff send them from their own e-mail and mark them as sent.',
} as const;

export const SUPPLIER_EMAIL_MAX_CC = 10;
export const SUPPLIER_EMAIL_SUBJECT_MAX = 300;
export const SUPPLIER_EMAIL_BODY_MAX = 8000;
