/**
 * Phase 5A finance contract (docs/implementation/next/phase-5a-contract.md).
 * Lead-owned (the Phase 5B Milestone A database agent owns the cash overview
 * and queue shape changes of migration 20261103000100). Every RPC in
 * migrations 20261101000100 and 20261103000100 returns exactly these
 * camelCase shapes; every staff-facing word for a state lives here.
 *
 * Amounts are whole paise carried as decimal digit strings (never JS numbers).
 * This is an internal operational record, not an official ledger, a tax
 * receipt voucher or a tax invoice.
 */

export const FINANCE_EVIDENCE_BUCKET = 'finance-evidence';
export const FINANCE_EVIDENCE_MAX_BYTES = 4 * 1024 * 1024;
export const FINANCE_EVIDENCE_SIGNED_URL_SECONDS = 60;
export const FINANCE_EVIDENCE_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const;

export type Paise = string;

export type ReceiptMode = 'bank_transfer' | 'upi' | 'cash' | 'cheque';
export const RECEIPT_MODES: readonly ReceiptMode[] = ['bank_transfer', 'upi', 'cash', 'cheque'];

export type ReceiptStatus =
  | 'recorded'
  | 'verified'
  | 'pending_clearance'
  | 'cleared'
  | 'bounced'
  | 'stopped'
  | 'cancelled'
  | 'rejected'
  | 'reversed';

export type RejectionKind = 'not_received' | 'data_error';
export type ReversalKind = 'bank_return' | 'not_received' | 'data_error';
export type ChequeMarkKind = 'bounced' | 'stopped' | 'cancelled';
export type BillingStatus = 'draft' | 'verified';
export type ReviewStatus = 'pending' | 'returned' | 'approved';
export type DepositStatus = 'recorded' | 'verified' | 'rejected';
export type ReconciliationStatus = 'recorded' | 'verified';
export type FinanceEvidenceKind = 'bank_proof' | 'cheque_image' | 'deposit_slip';
export type FinanceEvidenceStatus = 'pending_upload' | 'stored' | 'failed' | 'removed';

/** Receipt actions; the database decides which are allowed for this viewer. */
export type ReceiptAction =
  | 'verify'
  | 'reject'
  | 'cheque_clear'
  | 'cheque_mark'
  | 'cheque_represent'
  | 'reverse'
  | 'correct';

/** Why an action is unavailable to this viewer (null = available). */
export type ActionBlock =
  | 'own_record'
  | 'own_verification'
  | 'own_clearance'
  | 'deal_conflict'
  | 'wrong_state'
  | 'evidence_required'
  | 'mode_not_live'
  | 'in_unverified_deposit'
  | null;

export type FinanceErrorCode =
  | 'not_authorized'
  | 'not_self_approval'
  | 'environment_unset'
  | 'not_configured'
  | 'mode_not_live'
  | 'invalid_input'
  | 'duplicate_reference'
  | 'request_conflict'
  | 'version_changed'
  | 'wrong_state'
  | 'cash_cap_exceeded'
  | 'evidence_required'
  | 'billing_not_verified'
  | 'destination_changed'
  | 'deal_removed'
  | 'not_found'
  // B1.1 advance claims (appendix B §2.6) and expense records (freeze note §3.2)
  | 'duplicate_claim'
  | 'receipt_already_linked'
  | 'claim_over_total'
  | 'service_items_disabled'
  | 'deal_not_active'
  | 'receipt_required'
  // B1.1 revision (20261119000300): review, receipt and claim commands on a replaced version
  | 'version_superseded';

/** SQLSTATE each token must arrive with; anything else maps to null (fail closed). */
export const FINANCE_ERROR_STATES: Record<FinanceErrorCode, string> = {
  not_authorized: '42501',
  not_self_approval: '42501',
  environment_unset: '55000',
  not_configured: '55000',
  mode_not_live: '55000',
  invalid_input: '22023',
  duplicate_reference: '23505',
  request_conflict: '40001',
  version_changed: '40001',
  wrong_state: '55000',
  cash_cap_exceeded: '55000',
  evidence_required: '55000',
  billing_not_verified: '55000',
  destination_changed: '55000',
  deal_removed: '55000',
  not_found: 'P0002',
  duplicate_claim: '23505',
  receipt_already_linked: '23505',
  claim_over_total: '55000',
  service_items_disabled: '55000',
  deal_not_active: '55000',
  receipt_required: '55000',
  version_superseded: '55000',
};

export const FINANCE_ERROR_TEXT: Record<FinanceErrorCode, string> = {
  not_authorized: 'You do not have Accounts access for this record.',
  not_self_approval: 'Another Accounts person must do this step. You cannot approve or verify your own work or your own deal.',
  environment_unset: 'Finance is switched off in this environment.',
  not_configured: 'Finance is not set up for this company yet.',
  mode_not_live: 'This payment mode is not live yet. The owner turns it on after the CA confirms the rules.',
  invalid_input: 'Some details are missing or not in the expected format. Check the highlighted fields.',
  duplicate_reference: 'This bank, UPI or cheque reference is already recorded. Check the existing receipt before recording it again.',
  request_conflict: 'This form was already submitted with different details. Reload the page and try again.',
  version_changed: 'Someone else changed this record. Reload the page to see the latest version.',
  wrong_state: 'This receipt is no longer in a state where that action is possible. Reload the page.',
  cash_cap_exceeded: 'This cash amount is over the company cash limit for this payer or trip. Ask for a bank transfer, UPI or cheque instead.',
  evidence_required: 'Upload the required proof first.',
  billing_not_verified: 'Verify the customer billing details before approving the review.',
  destination_changed:
    'The company account you chose is no longer the approved current one (it was replaced or retired). Nothing was recorded. The list now shows the accounts in use; choose again.',
  deal_removed: 'This deal was removed from the CRM by the Bitrix sync because it no longer matches the import settings (start date, pipeline or stage). New receipts are paused; recorded money, verification, reversals and cash or cheque settlement continue.',
  not_found: 'This record was not found or you cannot see it.',
  duplicate_claim: 'This payment reference is already reported on this deal. Check the claims listed below before reporting it again.',
  receipt_already_linked: 'That receipt already backs another claim. One receipt can back only one claim.',
  claim_over_total: 'The amount is more than the final selling total. Check the amount or the total.',
  service_items_disabled: 'Book now is switched off, so payments cannot be reported here yet.',
  deal_not_active: 'This deal is lost or rejected in Bitrix, so new booking work is paused.',
  receipt_required: 'The fee receipt (or, for a flight, the direct-payment proof) must be stored before this expense record can be accepted.',
  version_superseded: 'This booking version was replaced by a newer one. Reload to see the current version.',
};

export const RECEIPT_MODE_LABEL: Record<ReceiptMode, string> = {
  bank_transfer: 'Bank transfer',
  upi: 'UPI',
  cash: 'Cash',
  cheque: 'Cheque',
};

export const RECEIPT_STATUS_LABEL: Record<ReceiptStatus, string> = {
  recorded: 'Awaiting verification',
  verified: 'Verified',
  pending_clearance: 'Cheque awaiting bank clearance',
  cleared: 'Cleared',
  bounced: 'Cheque bounced',
  stopped: 'Cheque stopped',
  cancelled: 'Cheque cancelled',
  rejected: 'Rejected',
  reversed: 'Reversed',
};

export const ACTION_BLOCK_TEXT: Record<Exclude<ActionBlock, null>, string> = {
  own_record: 'You recorded this receipt. Another Accounts person must do this step.',
  own_verification: 'You verified this receipt. Another Accounts person must reverse it.',
  own_clearance: 'You recorded the bank clearance. Another Accounts person must reverse it.',
  deal_conflict: 'You own or sell this deal, so another Accounts person must do this step.',
  wrong_state: 'Not possible in the current state.',
  evidence_required: 'Upload the required proof first.',
  mode_not_live: 'This payment mode is not live yet.',
  in_unverified_deposit: 'This cash is in a deposit awaiting verification. Verify or reject the deposit first.',
};

// A-13
export const FINANCE_DISCLAIMER = 'Receipt numbers are internal. They are not tax invoices.';

// ---------------------------------------------------------------------------
// RPC result shapes
// ---------------------------------------------------------------------------

export interface MoneySummary {
  availablePaise: Paise;
  awaitingVerificationPaise: Paise;
  chequesAwaitingClearancePaise: Paise;
}

export interface LiveModes {
  bank_transfer: boolean;
  upi: boolean;
  cash: boolean;
  cheque: boolean;
}

/** One row of the Accounts queue (see AccountsQueuePage). */
export interface AccountsQueueItem {
  dealId: string;
  dealReference: string;
  dealTitle: string;
  branchName: string;
  hasConfirmedBooking: boolean;
  billingStatus: BillingStatus | null;
  reviewStatus: ReviewStatus | null;
  money: MoneySummary;
  updatedAt: string;
}

export type AccountsQueueFilter = 'all' | 'needs_review' | 'returned' | 'awaiting_verification' | 'cheques_pending';

/** Default and largest page size of accounts_queue (p_limit is clamped to 1..100). */
export const ACCOUNTS_QUEUE_PAGE_SIZE = 50;
export const ACCOUNTS_QUEUE_PAGE_MAX = 100;

/**
 * accounts_queue(p_filter text, p_after text default null, p_limit int default 50) -> AccountsQueuePage
 *
 * Items are ordered by dealReference then dealId. totalCount counts every item
 * matching the filter (not just this page), so a page is never presented as
 * the whole queue. nextAfter is an opaque cursor (pass it back as p_after);
 * it is null exactly when hasMore is false.
 */
export interface AccountsQueuePage {
  items: AccountsQueueItem[];
  hasMore: boolean;
  nextAfter: string | null;
  totalCount: number;
}

/** accounts_deal_lookup(p_reference text) -> AccountsDealLookup | null */
export interface AccountsDealLookup {
  dealId: string;
  dealReference: string;
  dealTitle: string;
  branchName: string;
  hasConfirmedBooking: boolean;
}

export interface BillingProfileView {
  billingName: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  stateCode: string;
  postalCode: string;
  gstin: string | null;
  status: BillingStatus;
  rowVersion: number;
  updatedByName: string | null;
  updatedAt: string;
  verifiedByName: string | null;
  verifiedAt: string | null;
  /** B1.1: 'sales' when Sales proposed these details from the Book now form. Absent on older databases. */
  prefillSource?: 'none' | 'sales';
  /**
   * Booking form Bill To (absent on an older database, null on a legacy
   * profile). Accounts sees them, can edit them (including switching GST
   * registered ⇄ not registered) and verifies.
   */
  billToType?: 'personal' | 'business' | null;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  gstStatus?: 'registered' | 'unregistered' | null;
  gstReason?: string | null;
}

export interface AccountsBookingPrices {
  lines: Array<{ category: 'adult' | 'child_bed' | 'child_no_bed' | 'infant'; quantity: number; salePaise: Paise | null }>;
  source: 'per_person' | 'quotation_total' | 'legacy_total' | null;
  sellingTotalPaise: Paise | null;
}

export interface BookingReviewView {
  bookingVersionId: string;
  versionNo: number;
  hotelName: string | null;
  city: string | null;
  checkIn: string | null;
  checkOut: string | null;
  rooms: number | null;
  adults: number | null;
  children: number | null;
  sellingTotalPaise: Paise | null;
  confirmedAt: string;
  confirmedByName: string | null;
  reviewStatus: ReviewStatus;
  reviewRowVersion: number;
  returnReason: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  canApprove: boolean;
  approveBlock: ActionBlock | 'billing_not_verified';
  // B1.1 additive keys (appendix B §3.3, freeze note §3.1). Absent on older databases.
  serviceType?: 'hotel' | 'package';
  listPricePaise?: Paise | null;
  discountPaise?: Paise | null;
  /** null for hotel versions without a plan. */
  paymentPlan?: PaymentPlanView | null;
  services?: Array<{ itemNo: number; serviceType: string }>;
  contact?: AccountsBookingContact | null;
  /** Revision of a returned version (migration 0300). */
  revision?: AccountsBookingRevision | null;
  earlierVersions?: Array<{ versionNo: number; reviewStatus: ReviewStatus; returnReason: string | null }>;
  /**
   * Booking form (20261124000120, Echo review A M1): per-person selling side
   * only (category, people, sale per person) and the selling total. Never
   * purchase or markup. Absent on an older database and for versions
   * without per-person prices.
   */
  prices?: AccountsBookingPrices | null;
}

export interface ReceiptEvidenceView {
  id: string;
  kind: FinanceEvidenceKind;
  fileName: string;
  status: FinanceEvidenceStatus;
  createdAt: string;
}

export interface ReceiptView {
  receiptId: string;
  receiptNo: string;
  mode: ReceiptMode;
  status: ReceiptStatus;
  amountPaise: Paise;
  receivedOn: string;
  branchName: string;
  collectorName: string | null;
  payerName: string;
  payerPanMasked: string | null;
  payerMobileMasked: string | null;
  reference: string | null;
  chequeNumber: string | null;
  micrCode: string | null;
  chequeDate: string | null;
  rejectionKind: RejectionKind | null;
  reversalKind: ReversalKind | null;
  reason: string | null;
  correctsReceiptNo: string | null;
  correctedByReceiptNo: string | null;
  recordedByName: string | null;
  recordedAt: string;
  verifiedByName: string | null;
  verifiedAt: string | null;
  outcomeDate: string | null;
  policyVersionNo: number;
  evidence: ReceiptEvidenceView[];
  actions: Record<ReceiptAction, ActionBlock>;
  /** Stage 2: masked snapshot of the company destination; `unmapped` for older bank-transfer/UPI receipts; null for cash and cheque. */
  destination: ReceiptDestinationView | null;
}

/** accounts_deal_detail(p_deal_id uuid) -> AccountsDealDetail | null */
export interface AccountsDealDetail {
  dealId: string;
  dealReference: string;
  dealTitle: string;
  legalEntityId: string;
  branchId: string;
  branchName: string;
  isSynthetic: boolean;
  booking: BookingReviewView | null;
  billing: BillingProfileView | null;
  money: MoneySummary;
  receipts: ReceiptView[];
  liveModes: LiveModes;
  modesAllowed: LiveModes;
  branches: Array<{ id: string; name: string }>;
  collectors: Array<{ userId: string; name: string }>;
  policy: FinancePolicyView;
  /** B1.1: advance claims from Sales, newest first. Absent on older databases (DTO default []). */
  claims?: AccountsClaimView[];
  /** B1.1: sum of open claims, labelled "Reported by Sales (not money)". */
  claimsReportedPaise?: Paise;
}

export interface FinancePolicyView {
  versionNo: number;
  effectiveAt: string;
  receiptMaxPaise: Paise;
  cashPayerDayCapPaise: Paise;
  cashTripCapPaise: Paise;
  cashDepositDays: number;
  reconciliationRequired: boolean;
  reason: string;
  createdByName: string | null;
  createdAt: string;
}

/** finance_policy_get(p_entity_id uuid) -> FinancePolicyPage */
export interface FinancePolicyPage {
  legalEntityId: string;
  legalEntityName: string;
  current: FinancePolicyView;
  scheduled: FinancePolicyView[];
  history: FinancePolicyView[];
  ceilings: { cashCapCeilingPaise: Paise; receiptMaxCeilingPaise: Paise };
  canEdit: boolean;
}

export type UnresolvedCashKind =
  | 'deposit_overdue'
  | 'verification_overdue'
  | 'reversed_undeposited'
  | 'reconciliation_missing'
  | 'reconciliation_awaiting_verification'
  | 'reconciliation_stale';

export const UNRESOLVED_CASH_KINDS: readonly UnresolvedCashKind[] = [
  'deposit_overdue',
  'verification_overdue',
  'reversed_undeposited',
  'reconciliation_missing',
  'reconciliation_awaiting_verification',
  'reconciliation_stale',
];

/** At most this many unresolved items of each kind are listed per branch; totals stay complete. */
export const UNRESOLVED_DISPLAY_LIMIT_PER_KIND = 50;

export interface UnresolvedCashItem {
  kind: UnresolvedCashKind;
  receiptId: string | null;
  receiptNo: string | null;
  businessDate: string | null;
  amountPaise: Paise | null;
}

export interface CashDepositView {
  depositId: string;
  depositedOn: string;
  bankReference: string;
  totalPaise: Paise;
  status: DepositStatus;
  receiptNos: string[];
  recordedByName: string | null;
  verifiedByName: string | null;
  rejectReason: string | null;
  evidence: ReceiptEvidenceView[];
  actions: { verify: ActionBlock; reject: ActionBlock };
}

export interface CashReconciliationView {
  reconciliationId: string;
  businessDate: string;
  countedPaise: Paise;
  expectedPaise: Paise;
  differencePaise: Paise;
  unverifiedCashPaise: Paise;
  note: string | null;
  status: ReconciliationStatus;
  stale: boolean;
  recordedByName: string | null;
  verifiedByName: string | null;
  actions: { verify: ActionBlock };
}

export interface CashBranchView {
  branchId: string;
  branchName: string;
  cashInHandPaise: Paise;
  recordedUnverifiedCashPaise: Paise;
  undepositedVerified: Array<{ receiptId: string; receiptNo: string; amountPaise: Paise; receivedOn: string; dealReference: string }>;
  /**
   * Unresolved work, oldest first within each kind, at most
   * UNRESOLVED_DISPLAY_LIMIT_PER_KIND items per kind. A reconciliation
   * obligation never expires with age; only a current verified
   * reconciliation clears it.
   */
  unresolved: UnresolvedCashItem[];
  /** Full count per kind (every kind present, zero when none), including items not listed. */
  unresolvedTotals: Record<UnresolvedCashKind, number>;
  /** Oldest businessDate per kind; only kinds with at least one item appear. */
  oldestUnresolvedDate: Partial<Record<UnresolvedCashKind, string>>;
  /** True when at least one kind has more items than are listed. */
  unresolvedTruncated: boolean;
  deposits: CashDepositView[];
  reconciliations: CashReconciliationView[];
}

/** accounts_cash_overview(p_entity_id uuid) -> CashOverview */
export interface CashOverview {
  legalEntityId: string;
  policy: FinancePolicyView;
  branches: CashBranchView[];
}

/** Every command returns { outcome: 'created' | 'existing' | 'updated', id, ... }. */
export interface FinanceCommandResult {
  outcome: 'created' | 'existing' | 'updated';
  id: string;
  receiptNo?: string;
  /** B1.1: receipt_record_from_claim / payment_claim_link_receipt return the linked receipt. */
  receiptId?: string;
  status?: string;
  rowVersion?: number;
}

// ---------------------------------------------------------------------------
// Stage 2: company destinations (stage-2-company-destinations-contract-2026-10-08.md)
// ---------------------------------------------------------------------------

export const DESTINATION_KINDS = ['bank', 'upi'] as const;
export type DestinationKind = (typeof DESTINATION_KINDS)[number];

export const DESTINATION_VERSION_STATUSES = ['submitted', 'returned', 'approved', 'superseded'] as const;
export type DestinationVersionStatus = (typeof DESTINATION_VERSION_STATUSES)[number];

/** Panel state of a destination: its latest open/returned version, its approved current version, or retired. */
export const DESTINATION_STATES = ['submitted', 'returned', 'approved', 'retired'] as const;
export type DestinationState = (typeof DESTINATION_STATES)[number];

export type DestinationAction = 'submit' | 'decide' | 'retire';

/** One immutable version, masked (account last four, UPI first character and handle). */
export interface DestinationVersionView {
  versionId: string;
  versionNo: number;
  status: DestinationVersionStatus;
  predecessorVersionNo: number | null;
  holderName: string | null;
  bankName: string | null;
  accountMasked: string | null;
  ifsc: string | null;
  payeeName: string | null;
  upiMasked: string | null;
  makerId: string;
  makerName: string | null;
  createdAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
}

export interface CompanyDestinationView {
  destinationId: string;
  kind: DestinationKind;
  label: string;
  rowVersion: number;
  state: DestinationState;
  createdByName: string | null;
  createdAt: string;
  retiredAt: string | null;
  retiredByName: string | null;
  retireReason: string | null;
  current: DestinationVersionView | null;
  pending: DestinationVersionView | null;
  latestVersionNo: number;
  versions: DestinationVersionView[];
  /** null = the viewer may act; otherwise why not (own_record: the viewer made the open version). */
  actions: Record<DestinationAction, 'wrong_state' | 'own_record' | null>;
}

/** company_destinations_list(p_entity_id uuid) */
export interface CompanyDestinationsPage {
  entityId: string;
  destinations: CompanyDestinationView[];
}

/** company_destination_options(p_deal_id uuid): approved current versions selectable for a new receipt. */
export interface DestinationOption {
  versionId: string;
  destinationId: string;
  kind: DestinationKind;
  label: string;
  versionNo: number;
  bankName: string | null;
  accountMasked: string | null;
  payeeName: string | null;
  upiMasked: string | null;
}

/** company_destination_version_detail(p_version_id uuid): full values, audited. */
export interface DestinationVersionDetail {
  versionId: string;
  versionNo: number;
  holderName: string | null;
  bankName: string | null;
  accountNumber: string | null;
  ifsc: string | null;
  payeeName: string | null;
  upiId: string | null;
}

export type ReceiptDestinationView =
  | { unmapped: true }
  | {
      unmapped: false;
      label: string;
      kind: DestinationKind;
      versionNo: number;
      bankName: string | null;
      accountMasked: string | null;
      upiMasked: string | null;
    };

export const DESTINATION_KIND_LABEL: Record<DestinationKind, string> = { bank: 'Bank account', upi: 'UPI ID' };

export const DESTINATION_STATE_LABEL: Record<DestinationState, string> = {
  submitted: 'Waiting for approval',
  returned: 'Returned for correction',
  approved: 'Approved, in use',
  retired: 'Retired',
};

export const DESTINATION_VERSION_STATUS_LABEL: Record<DestinationVersionStatus, string> = {
  submitted: 'Waiting for approval',
  returned: 'Returned',
  approved: 'Approved, current',
  superseded: 'Replaced',
};

/** Which destination kind a receipt mode needs; null for modes without a destination. */
export function destinationKindForMode(mode: ReceiptMode): DestinationKind | null {
  return mode === 'bank_transfer' ? 'bank' : mode === 'upi' ? 'upi' : null;
}

// ===========================================================================
// B1.1: advance claims (appendix B, migration 20261119000200) and the
// Accounts side of department expense records (freeze note §3.2; Atlas's
// department_cost_entries in 20261119000500). Lead-owned (written by Terra on
// the lead's behalf). A claim is what Sales says the customer paid; it is
// never money.
// ===========================================================================

export type PaymentClaimStatus = 'reported' | 'linked' | 'not_received' | 'withdrawn';
export const PAYMENT_CLAIM_STATUSES = ['reported', 'linked', 'not_received', 'withdrawn'] as const satisfies readonly PaymentClaimStatus[];
export type PaymentClaimDisplayStatus =
  | 'reported'
  | 'recorded'
  | 'verified'
  | 'pending_clearance'
  | 'cleared'
  | 'bounced'
  | 'rejected'
  | 'reversed'
  | 'not_received'
  | 'withdrawn';
export const PAYMENT_CLAIM_DISPLAY_STATUSES = [
  'reported',
  'recorded',
  'verified',
  'pending_clearance',
  'cleared',
  'bounced',
  'rejected',
  'reversed',
  'not_received',
  'withdrawn',
] as const satisfies readonly PaymentClaimDisplayStatus[];
export type ClaimLinkKind = 'recorded_from_claim' | 'linked_existing';
export type ClaimAction = 'recordReceipt' | 'linkReceipt' | 'markNotReceived';
export type ClaimActionBlock = 'own_record' | 'deal_conflict' | 'wrong_state' | 'mode_not_live' | 'deal_removed' | null;
export type ClaimReportBlock = 'service_items_disabled' | 'deal_not_active' | 'finance_not_ready' | 'no_booking' | null;
export type AccountsClaimsFilter = 'reported' | 'linked' | 'closed' | 'all';
export const ACCOUNTS_CLAIMS_FILTERS = ['reported', 'linked', 'closed', 'all'] as const satisfies readonly AccountsClaimsFilter[];

/** p_fields of payment_claim_report: every key present (null where not used by the mode). */
export interface PaymentClaimReportFields {
  mode: ReceiptMode;
  amountPaise: Paise;
  paidOn: string;
  payerName: string;
  reference: string | null;
  chequeNumber: string | null;
  chequeDate: string | null;
  destinationVersionId: string | null;
  note: string | null;
}

export interface SalesClaimView {
  claimId: string;
  status: PaymentClaimStatus;
  displayStatus: PaymentClaimDisplayStatus;
  amountPaise: Paise;
  mode: ReceiptMode;
  reference: string | null;
  chequeNumber: string | null;
  chequeDate: string | null;
  paidOn: string;
  payerName: string;
  note: string | null;
  destinationLabel: string | null;
  receiptAmountPaise: Paise | null;
  notReceivedReason: string | null;
  reportedByName: string | null;
  reportedAt: string;
  rowVersion: number;
  canWithdraw: boolean;
}

export interface SalesDestinationOption {
  versionId: string;
  kind: DestinationKind;
  label: string;
  bankName: string | null;
  accountMasked: string | null;
  upiMasked: string | null;
}

/** deal_payment_claims(p_deal_id): the Sales projection. null for anyone who may not report on the Deal. */
export interface SalesPaymentClaims {
  dealId: string;
  sellingTotalPaise: Paise | null;
  /** Sum of reported + linked claims. Never money. */
  reportedPaise: Paise;
  /** Verified money (journal balance), with or without a claim. */
  confirmedPaise: Paise;
  balancePaise: Paise | null;
  canReport: boolean;
  reportBlock: ClaimReportBlock;
  destinations: SalesDestinationOption[];
  claims: SalesClaimView[];
}

export interface AccountsClaimDestination {
  label: string;
  kind: DestinationKind;
  versionNo: number;
  bankName: string | null;
  accountMasked: string | null;
  upiMasked: string | null;
  isCurrent: boolean;
}

/** accounts_deal_detail.claims[] (appendix B §3.3). */
export interface AccountsClaimView {
  claimId: string;
  status: PaymentClaimStatus;
  displayStatus: PaymentClaimDisplayStatus;
  amountPaise: Paise;
  mode: ReceiptMode;
  reference: string | null;
  chequeNumber: string | null;
  chequeDate: string | null;
  paidOn: string;
  payerName: string;
  note: string | null;
  destination: AccountsClaimDestination | null;
  bookingVersionNo: number;
  reportedByName: string | null;
  reportedAt: string;
  linkedReceiptId: string | null;
  linkedReceiptNo: string | null;
  linkKind: ClaimLinkKind | null;
  linkReason: string | null;
  linkedByName: string | null;
  linkedAt: string | null;
  closedReason: string | null;
  closedByName: string | null;
  closedAt: string | null;
  rowVersion: number;
  possibleReceiptIds: string[];
  actions: Record<ClaimAction, ClaimActionBlock>;
}

/** accounts_payment_claims item (appendix B §3.4). */
export interface AccountsClaimListItem {
  claimId: string;
  dealId: string;
  dealReference: string;
  dealTitle: string;
  branchName: string;
  amountPaise: Paise;
  mode: ReceiptMode;
  paidOn: string;
  payerName: string;
  reference: string | null;
  chequeNumber: string | null;
  status: PaymentClaimStatus;
  displayStatus: PaymentClaimDisplayStatus;
  reportedByName: string | null;
  reportedAt: string;
  linkedReceiptNo: string | null;
}

export interface AccountsClaimsPage {
  items: AccountsClaimListItem[];
  hasMore: boolean;
  nextAfter: string | null;
  totalCount: number;
}

export interface PaymentPlanView {
  instalments: Array<{ seq: number; label: string; amountPaise: Paise; dueDate: string }>;
  totalPaise: Paise;
  matchesSellingTotal: boolean;
}

export interface AccountsBookingContact {
  name: string;
  mobile: string | null;
  email: string | null;
  bookingFor: 'individual' | 'business';
  payerName: string | null;
}

export interface AccountsBookingRevision {
  revisesVersionNo: number;
  changeClass: 'format_only' | 'internal_only' | 'customer_material';
  changedFields: string[];
  sellingDeltaPaise: Paise | null;
}

/** receipt_record_from_claim p_fields: the receipt form minus correctsReceiptId, plus mismatchReason. */
export interface ReceiptFromClaimFields {
  mode: ReceiptMode;
  amountPaise: Paise;
  receivedOn: string;
  branchId: string;
  collectorUserId: string | null;
  payerName: string;
  payerPan: string | null;
  payerMobile: string | null;
  reference: string | null;
  micrCode: string | null;
  chequeNumber: string | null;
  chequeDate: string | null;
  accountPayee: boolean | null;
  bookingVersionId: string | null;
  note: string | null;
  destinationVersionId: string | null;
  mismatchReason: string | null;
}

export const CLAIM_DISPLAY_STATUS_LABEL: Record<PaymentClaimDisplayStatus, { sales: string; accounts: string }> = {
  // DA-291: Sales words match the summary ("Reported, not checked" / "Checked by Accounts"); Accounts words stay.
  reported: { sales: 'Reported, not checked yet', accounts: 'Reported by Sales: record or link the receipt' },
  recorded: { sales: 'Receipt recorded, waiting for a second Accounts check', accounts: 'Receipt recorded, awaiting verification' },
  verified: { sales: 'Checked by Accounts', accounts: 'Verified' },
  pending_clearance: { sales: 'Cheque waiting for bank clearance (not counted yet)', accounts: 'Cheque awaiting bank clearance' },
  cleared: { sales: 'Cheque cleared', accounts: 'Cleared' },
  bounced: { sales: 'Cheque not paid (bounced, stopped or cancelled)', accounts: 'Cheque not paid' },
  rejected: { sales: 'Accounts could not confirm this payment', accounts: 'Receipt rejected' },
  reversed: { sales: 'Payment reversed by Accounts', accounts: 'Receipt reversed' },
  not_received: { sales: 'Accounts did not find this money', accounts: 'Money not found' },
  withdrawn: { sales: 'Withdrawn by Sales', accounts: 'Withdrawn by Sales' },
};

export const CLAIM_ACTION_BLOCK_TEXT: Record<Exclude<ClaimActionBlock, null>, string> = {
  own_record: 'You reported this payment or you sell this deal, so another Accounts person must handle it.',
  deal_conflict: 'You own or sell this deal, so another Accounts person must handle it.',
  wrong_state: 'This claim was already handled. Reload the page.',
  mode_not_live: 'This payment mode is not live yet, so a receipt cannot be recorded.',
  deal_removed: 'This deal was removed from the CRM by the Bitrix sync. New receipts are paused.',
};

export const CLAIM_REPORT_BLOCK_TEXT: Record<Exclude<ClaimReportBlock, null>, string> = {
  service_items_disabled: 'Book now is switched off, so payments cannot be reported here yet.',
  deal_not_active: 'This deal is lost or rejected in Bitrix, so new booking work is paused.',
  finance_not_ready: 'Finance is not set up for this company yet, so payments cannot be reported.',
  no_booking: 'Start the booking first. A payment can be reported once a draft or accepted booking exists.',
};

/** Claim-context overrides of FINANCE_ERROR_TEXT. */
export const CLAIM_ERROR_TEXT: Partial<Record<FinanceErrorCode, string>> = {
  wrong_state: 'This claim was already handled. Reload the page.',
  not_self_approval: 'You reported this payment or you sell this deal, so another Accounts person must handle it.',
};

export const CLAIM_TEXT = {
  // A-19
  disclaimer: 'Reported by Sales. Not money until a receipt is recorded and checked by a second Accounts person.',
  accountsCallout:
    'Reported by Sales. Not money until a receipt is recorded and checked by a second Accounts person. Record the real receipt from it, or link a receipt already recorded.',
  reportedNotMoney: 'Reported by Sales (not money)',
  // BC-04
  reportLabel: 'Send to Accounts',
  withdrawLabel: 'Withdraw report',
  recordLabel: 'Record receipt from this claim',
  linkLabel: 'Link an existing receipt',
  notReceivedLabel: 'Money not found',
  notReceivedReasonNote: 'Sales will read this reason.',
} as const;

// ---------------------------------------------------------------------------
// Expense records: Accounts review of company-paid department costs
// ---------------------------------------------------------------------------

export type ExpenseRecordStatus = 'draft' | 'submitted' | 'accepted' | 'returned';
export type AccountsExpenseFilter = 'submitted' | 'returned' | 'accepted' | 'all';
export const ACCOUNTS_EXPENSE_FILTERS = ['submitted', 'returned', 'accepted', 'all'] as const satisfies readonly AccountsExpenseFilter[];
export type ExpenseAction = 'accept' | 'return';
export type ExpenseActionBlock = 'own_submission' | 'deal_conflict' | 'wrong_state' | 'receipt_required' | null;

export interface ExpenseEvidenceView {
  id: string;
  kind: 'fee_receipt' | 'direct_payment_proof' | 'authority_outcome';
  fileName: string;
  status: FinanceEvidenceStatus;
  createdAt: string;
}

/** accounts_expense_records item (appendix B §7, ids as entryId). Never applicant documents or identity. */
export interface AccountsExpenseRecordItem {
  entryId: string;
  dealId: string | null;
  dealReference: string;
  department: 'purchase' | 'flight' | 'visa';
  serviceType: string | null;
  kind: 'government_fee' | 'service_fee' | 'fare' | 'other';
  amountPaise: Paise;
  paidBy: 'company' | 'customer_direct' | 'not_yet';
  paymentMode: string | null;
  paidOn: string | null;
  reference: string | null;
  status: ExpenseRecordStatus;
  submittedByName: string | null;
  submittedAt: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  returnReason: string | null;
  rowVersion: number;
  evidence: ExpenseEvidenceView[];
  actions: Record<ExpenseAction, ExpenseActionBlock>;
}

export interface AccountsExpenseRecordsPage {
  items: AccountsExpenseRecordItem[];
  hasMore: boolean;
  nextAfter: string | null;
  totalCount: number;
}

export const EXPENSE_RECORD_STATUS_LABEL: Record<ExpenseRecordStatus, string> = {
  draft: 'Draft',
  submitted: 'Waiting for Accounts review',
  // A-21
  accepted: 'Accepted (recorded only; not approved for payment)',
  returned: 'Returned by Accounts',
};

export const EXPENSE_ACTION_BLOCK_TEXT: Record<Exclude<ExpenseActionBlock, null>, string> = {
  own_submission: 'You recorded or sent this cost, so another Accounts person must review it.',
  deal_conflict: 'You own or sell this deal, so another Accounts person must review it.',
  wrong_state: 'This expense record was already reviewed. Reload the page.',
  receipt_required: 'The fee receipt (or direct-payment proof) is not stored yet.',
};

export const EXPENSE_TEXT = {
  callout:
    'An expense record is what a department paid or will pay. Accepting it records it for Accounts only: it never approves, makes or schedules a payment.',
  acceptLabel: 'Accept expense record',
  returnLabel: 'Return to the department',
} as const;
