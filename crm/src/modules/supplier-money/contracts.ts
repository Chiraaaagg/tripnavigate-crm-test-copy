import type { GoAheadState } from '@/modules/procurement/contracts';

/**
 * Supplier money contract (Track B of the Purchase build, frozen 2 Nov 2026).
 *
 * Owner rules (binding): supplier payment requests are approved by Accounts
 * while the cumulative live total for the same supplier on the same Deal is
 * at most ₹50,000 (exactly ₹50,000 = Accounts) and by the manager of the
 * Deal's branch above that; splitting a payment never bypasses the limit.
 * Approval is not payment: Accounts records the payment (the approver may
 * record it) and a DIFFERENT Accounts person verifies it. Nobody approves
 * their own request. Nothing is ever paid automatically. A hotel payment
 * request needs a valid Accounts go-ahead; a deposit may be asked before the
 * supplier confirms, the balance or full payment only after. A payment is not
 * recorded while the supplier's latest bank details are not approved, or
 * while company funding for it is not approved.
 *
 * Migration: crm/supabase/migrations/20261130000200_supplier_money.sql.
 * Every RPC returns exactly these camelCase shapes. Amounts are whole paise
 * as decimal digit strings (never JS numbers). Purchase shapes never carry a
 * selling price, margin, customer receipt amounts, company funding amount or
 * reason, or a payment proof file.
 *
 * Changes after the freeze are additive only.
 *
 * Flight build (4 Nov 2026, migrations 20261201000200..0220): Accounts and
 * Manager rows gain the asking department; flight payment requests pay one
 * ticket batch, so their costVersionNo is null and their proforma optional
 * (the one non-additive change: those two Accounts row fields became
 * nullable). Purchase views are unchanged.
 */

export const SUPPLIER_MONEY_BUCKET = 'supplier-money';
export const SUPPLIER_MONEY_MAX_BYTES = 4 * 1024 * 1024;
export const SUPPLIER_MONEY_SIGNED_URL_SECONDS = 60;
export const SUPPLIER_MONEY_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const;

/** ₹50,000 in paise. Cumulative totals at or below go to Accounts; above go to the branch Manager. */
export const APPROVAL_LIMIT_PAISE = '5000000';

export type Paise = string;

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export type SupplierPaymentPart = 'deposit' | 'balance' | 'full';
export const SUPPLIER_PAYMENT_PARTS: readonly SupplierPaymentPart[] = ['deposit', 'balance', 'full'];

export type SupplierPaymentStatus = 'pending' | 'approved' | 'returned' | 'cancelled' | 'paid' | 'verified';
export const SUPPLIER_PAYMENT_STATUSES: readonly SupplierPaymentStatus[] = [
  'pending',
  'approved',
  'returned',
  'cancelled',
  'paid',
  'verified',
];
/** Statuses that count towards totals ("live"). */
export const LIVE_PAYMENT_STATUSES: readonly SupplierPaymentStatus[] = ['pending', 'approved', 'paid', 'verified'];

/** Who approves: decided once when the request is created, from the cumulative live total. */
export type ApprovalRoute = 'accounts' | 'manager';

export type SupplierPaymentMode = 'bank_transfer' | 'upi' | 'cheque';
export const SUPPLIER_PAYMENT_MODES: readonly SupplierPaymentMode[] = ['bank_transfer', 'upi', 'cheque'];

export type FundingStatus = 'pending' | 'approved' | 'returned' | 'recovered';

export type SupplierDocumentKind = 'invoice' | 'credit_note';
export type SupplierDocumentStatus = 'uploaded' | 'accepted' | 'returned';

export type SupplierMoneyEvidenceKind = 'proforma' | 'payment_proof' | 'invoice' | 'credit_note';
/** Kinds Purchase may upload and download (never payment_proof). */
export const PURCHASE_UPLOAD_KINDS: readonly SupplierMoneyEvidenceKind[] = ['proforma', 'invoice', 'credit_note'];
export type SupplierMoneyEvidenceStatus = 'pending_upload' | 'stored' | 'failed' | 'removed';

/** Why an approved payment cannot be recorded yet (derived on read). */
export type PaymentHoldReason = 'bank_details_on_hold' | 'funding_pending' | 'funding_returned';

/** Accounts go-ahead state of a task (Track A helper authz.purchase_go_ahead_state). */
export type { GoAheadState };

/**
 * Flight build (20261201000220): which department asked. Flight requests pay
 * one confirmed ticket batch (no cost version, optional proforma).
 */
export type SupplierPaymentDepartment = 'purchase' | 'flight';

export type AccountsPaymentTab = 'to_approve' | 'to_record' | 'to_verify' | 'all';
export type AccountsDocumentTab = 'to_review' | 'missing' | 'all';
export type AccountsFundingTab = 'to_approve' | 'to_recover' | 'all';
export type PurchasePaymentScope = 'mine' | 'all';

// ---------------------------------------------------------------------------
// Refusal tokens (the database message is exactly the token)
// ---------------------------------------------------------------------------

export type SupplierMoneyErrorCode =
  | 'not_authorized'
  | 'not_found'
  | 'version_changed'
  | 'task_conflict'
  | 'not_ready'
  | 'over_budget'
  | 'already_confirmed'
  | 'invalid_input'
  | 'evidence_rejected'
  | 'go_ahead_missing'
  | 'booking_request_not_sent'
  | 'booking_not_approved'
  | 'trip_cancelled'
  | 'payment_in_progress'
  | 'over_agreed_cost'
  | 'customer_money_short'
  | 'bank_details_on_hold'
  | 'funding_pending'
  | 'not_self_approval'
  | 'not_self_verification'
  | 'already_decided'
  | 'duplicate_request'
  // Environment and gate refusals shared with procurement and finance.
  | 'environment_unset'
  | 'not_configured'
  | 'procurement_disabled'
  | 'deal_removed';

/** SQLSTATE each token arrives with (a token with any other state is not trusted). */
export const SUPPLIER_MONEY_ERROR_STATES: Record<SupplierMoneyErrorCode, string> = {
  not_authorized: '42501',
  not_found: 'P0002',
  version_changed: '40001',
  task_conflict: '40001',
  not_ready: '55000',
  over_budget: '55000',
  already_confirmed: '55000',
  invalid_input: '22023',
  evidence_rejected: '22023',
  go_ahead_missing: '55000',
  booking_request_not_sent: '55000',
  booking_not_approved: '55000',
  trip_cancelled: '55000',
  payment_in_progress: '55000',
  over_agreed_cost: '55000',
  customer_money_short: '55000',
  bank_details_on_hold: '55000',
  funding_pending: '55000',
  not_self_approval: '42501',
  not_self_verification: '42501',
  already_decided: '55000',
  duplicate_request: '40001',
  environment_unset: '55000',
  not_configured: '55000',
  procurement_disabled: '55000',
  deal_removed: '55000',
};

// ---------------------------------------------------------------------------
// Purchase views (no selling price, margin, receipts, funding amount/reason, proof files)
// ---------------------------------------------------------------------------

/** A Purchase-visible file (proforma, invoice or credit note). Never a payment proof. */
export interface SupplierMoneyFileView {
  id: string;
  kind: Exclude<SupplierMoneyEvidenceKind, 'payment_proof'>;
  fileName: string;
  mime: string;
  sizeBytes: number;
  status: Exclude<SupplierMoneyEvidenceStatus, 'removed'>;
  createdAt: string;
  uploadedByName: string | null;
}

export interface PurchasePaymentRequestView {
  id: string;
  /** SP-YYYY-NNNNNN */
  refNo: string;
  dealId: string;
  dealReference: string;
  taskId: string;
  /** Hotel name or service title. */
  serviceTitle: string;
  serviceType: string;
  supplierId: string;
  supplierName: string;
  part: SupplierPaymentPart;
  amountPaise: Paise;
  dueDate: string | null;
  note: string | null;
  route: ApprovalRoute;
  status: SupplierPaymentStatus;
  costVersionNo: number;
  proformaEvidenceId: string;
  returnReason: string | null;
  requestedAt: string;
  requestedByName: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  paidOn: string | null;
  paymentMode: SupplierPaymentMode | null;
  bankReference: string | null;
  verifiedAt: string | null;
  /**
   * @deprecated Review F1 (lead, 2 Nov 2026): Purchase gets no company funding signal. Always false; the
   * database no longer returns it. Do not render.
   */
  companyFundingAsked: boolean;
  /** Waiting for the supplier's latest bank details (the only hold Purchase sees; funding holds stay with Accounts). */
  onHold: boolean;
  holdReason: PaymentHoldReason | null;
  /** This returned request was sent again as another request. */
  resubmittedAs: string | null;
  /** This request re-sends a returned one (its reference number). */
  resubmitsRefNo: string | null;
  /** The viewer (the requester, still pending) may cancel it. */
  canCancel: boolean;
  /** The viewer may "Change and send again" (returned, not yet re-sent, viewer works the task). */
  canResubmit: boolean;
  /** Optimistic version for cancel (expectedRowVersion). Resubmit binds to PaymentContextView.costVersionNo. */
  rowVersion: number;
}

export interface SupplierDocumentView {
  id: string;
  kind: SupplierDocumentKind;
  taskId: string;
  dealReference: string;
  serviceTitle: string;
  supplierId: string;
  supplierName: string;
  number: string;
  docDate: string;
  totalPaise: Paise;
  gstIncluded: boolean;
  evidenceId: string;
  status: SupplierDocumentStatus;
  returnReason: string | null;
  uploadedAt: string;
  uploadedByName: string | null;
  reviewedAt: string | null;
  reviewedByName: string | null;
  rowVersion: number;
}

/** purchase_payment_context(task): everything the Supplier payments card, drawer and Files section need. */
export interface PaymentContextView {
  taskId: string;
  dealId: string;
  dealReference: string;
  serviceType: string;
  serviceTitle: string;
  taskStatus: string;
  /** Supplier of the latest agreed cost (null when no cost yet). */
  supplierId: string | null;
  supplierName: string | null;
  /** The cost version a new request is bound to (the proposed one the committed copy came from). */
  costVersionNo: number | null;
  agreedCostPaise: Paise | null;
  /** Live requests on this task (pending, approved, paid, verified). */
  requestedPaise: Paise;
  /** agreedCost − requested, never below zero. */
  remainingPaise: Paise;
  goAheadState: GoAheadState;
  goAheadNeeded: boolean;
  goAheadValid: boolean;
  /** Parts allowed right now (deposit before confirmation; balance/full after). */
  allowedParts: SupplierPaymentPart[];
  /** Why a new request is refused right now, in check order (empty = allowed). */
  blockers: SupplierMoneyErrorCode[];
  /** The viewer is the assignee and may create a request (ignores blockers). */
  canRequest: boolean;
  /** Purchase may upload invoices and credit notes on this task. */
  canUploadDocuments: boolean;
  /**
   * @deprecated Review F1 (lead, 2 Nov 2026): Purchase gets no customer money signal. Always false; the database
   * no longer returns it. The drawer always offers the optional "note for Accounts" instead.
   */
  customerMoneyShort: boolean;
  /** Live total for this supplier on this Deal before a new request (for the route notice). */
  routeRunningTotalPaise: Paise;
  approvalLimitPaise: Paise;
  /** The supplier's latest bank details are approved (payments are otherwise held after approval). */
  bankDetailsApproved: boolean;
  /** Task confirmed, trip ended, no non-returned invoice. */
  invoiceMissing: boolean;
  requests: PurchasePaymentRequestView[];
  documents: SupplierDocumentView[];
  files: SupplierMoneyFileView[];
}

// ---------------------------------------------------------------------------
// Accounts views
// ---------------------------------------------------------------------------

export interface BankDetailsSummary {
  revisionNo: number;
  accountHolder: string;
  bankName: string;
  ifsc: string;
  /** Only the last 4 digits ever leave the database. */
  accountLast4: string;
  status: 'unverified' | 'approved';
}

export interface FundingSummary {
  id: string;
  amountPaise: Paise;
  reason: string;
  route: ApprovalRoute;
  status: FundingStatus;
}

export interface AccountsSupplierPaymentRow {
  id: string;
  refNo: string;
  dealId: string;
  dealReference: string;
  branchName: string;
  taskId: string;
  serviceTitle: string;
  serviceType: string;
  supplierId: string;
  supplierName: string;
  part: SupplierPaymentPart;
  amountPaise: Paise;
  /** amount − company funding: the customer-money part. */
  customerMoneyPaise: Paise;
  dueDate: string | null;
  note: string | null;
  route: ApprovalRoute;
  status: SupplierPaymentStatus;
  /** Purchase: the bound cost version. Flight: null (the batch is the basis). */
  costVersionNo: number | null;
  agreedCostPaise: Paise | null;
  /** Required for Purchase; optional for flight requests. */
  proformaEvidenceId: string | null;
  returnReason: string | null;
  requestedAt: string;
  requestedByName: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  paidOn: string | null;
  paymentMode: SupplierPaymentMode | null;
  bankReference: string | null;
  paymentProofEvidenceId: string | null;
  bankRevisionNo: number | null;
  recordedAt: string | null;
  recordedByName: string | null;
  verifiedAt: string | null;
  verifiedByName: string | null;
  /** The supplier's latest bank details (null when none recorded). */
  bankDetails: BankDetailsSummary | null;
  funding: FundingSummary | null;
  onHold: boolean;
  holdReason: PaymentHoldReason | null;
  rowVersion: number;
  canDecide: boolean;
  canRecord: boolean;
  canVerify: boolean;
  /** Flight build: the asking department, and the ticket batch number of a flight request. */
  department: SupplierPaymentDepartment;
  flightBatchNo: number | null;
}

export interface MissingInvoiceRow {
  taskId: string;
  dealReference: string;
  serviceTitle: string;
  supplierId: string | null;
  supplierName: string | null;
  tripEnd: string;
  assigneeName: string | null;
  /** Flight build: flight tasks are listed too. */
  department: SupplierPaymentDepartment;
}

export interface AccountsSupplierDocumentsView {
  documents: Array<SupplierDocumentView & { branchName: string; canReview: boolean; department: SupplierPaymentDepartment }>;
  /** Filled for tabs 'missing' and 'all'. */
  missingInvoices: MissingInvoiceRow[];
}

export interface CompanyFundingRow {
  id: string;
  paymentRequestId: string;
  paymentRefNo: string;
  paymentStatus: SupplierPaymentStatus;
  dealId: string;
  dealReference: string;
  branchName: string;
  supplierName: string;
  serviceTitle: string;
  amountPaise: Paise;
  reason: string;
  route: ApprovalRoute;
  status: FundingStatus;
  returnReason: string | null;
  requestedAt: string;
  requestedByName: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  recoveredAt: string | null;
  recoveredByName: string | null;
  recoveryNote: string | null;
  rowVersion: number;
  canDecide: boolean;
  canMarkRecovered: boolean;
}

// ---------------------------------------------------------------------------
// Manager approvals (branches the viewer manages)
// ---------------------------------------------------------------------------

export interface ManagerCostAboveBudgetRow {
  taskId: string;
  dealReference: string;
  serviceTitle: string;
  supplierName: string | null;
  versionNo: number;
  amountPaise: Paise;
  budgetPaise: Paise;
  proposedAt: string;
  proposedByName: string | null;
  canApprove: boolean;
}

export interface ManagerBankDetailsRow {
  supplierId: string;
  supplierName: string;
  /** Flight build (20261201000290): the supplier's service types ('flight' = a Flight supplier). Always sent by the read; optional for older fixtures. */
  serviceTypes?: string[];
  revisionNo: number;
  accountHolder: string;
  bankName: string;
  ifsc: string;
  accountLast4: string;
  createdAt: string;
  createdByName: string | null;
  canApprove: boolean;
}

export interface ManagerSupplierToVerifyRow {
  supplierId: string;
  name: string;
  city: string | null;
  serviceTypes: string[];
  rowVersion: number;
  updatedAt: string;
  canVerify: boolean;
}

export interface ManagerCancellationRow {
  cancellationId: string;
  dealId: string;
  dealReference: string;
  reason: string;
  status: string;
  sentAt: string | null;
  sentByName: string | null;
  chargeCount: number;
  supplierKeepsPaise: Paise;
  supplierRefundPaise: Paise;
  rowVersion: number;
  canDecide: boolean;
}

/** Flight build: flight fares above the Deal's flight budget (approve / return with reason). */
export interface ManagerFlightFareRow {
  approvalId: string;
  dealId: string;
  dealReference: string;
  flightTitles: string[];
  supplierName: string | null;
  batchSupplierCostPaise: Paise;
  projectedSupplierCostPaise: Paise;
  /** null = no flight budget set on the Deal. */
  budgetPaise: Paise | null;
  requestedAt: string;
  requestedByName: string | null;
  rowVersion: number;
  canApprove: boolean;
}

export interface ManagerApprovalsView {
  costsAboveBudget: ManagerCostAboveBudgetRow[];
  payments: AccountsSupplierPaymentRow[];
  funding: CompanyFundingRow[];
  bankDetails: ManagerBankDetailsRow[];
  suppliersToVerify: ManagerSupplierToVerifyRow[];
  cancellations: ManagerCancellationRow[];
  flightFares: ManagerFlightFareRow[];
}

// ---------------------------------------------------------------------------
// Home counts: RPC supplier_money_home_counts() (null = not applicable to the viewer).
// my_work_counts keeps its key set; its requestsToApprove now counts real items too.
// ---------------------------------------------------------------------------

export interface SupplierMoneyHomeCounts {
  /** Accounts + Manager: every item waiting for the viewer's approval (also my_work_counts.requestsToApprove). */
  requestsToApprove: number | null;
  // Purchase
  purchaseTasksNotTaken: number | null;
  purchaseWaitingForGoAhead: number | null;
  purchaseCostsWaitingForManager: number | null;
  paymentRequestsReturned: number | null;
  supplierInvoicesMissing: number | null;
  // Accounts
  goAheadToApprove: number | null;
  supplierPaymentsToApprove: number | null;
  supplierPaymentsToRecord: number | null;
  supplierPaymentsToVerify: number | null;
  supplierDocumentsToReview: number | null;
  fundingToApprove: number | null;
  fundingToRecover: number | null;
  // Manager
  managerApprovals: number | null;
  // Flight build (20261201000220)
  /** Manager: flight fares above budget they may approve (also inside managerApprovals). */
  flightFaresToApprove: number | null;
  /** Flight: own ticket batches whose payment Accounts or the approver returned. */
  flightPaymentsReturned: number | null;
  /** Flight: own ticket batches with no payment yet. */
  flightPaymentsMissing: number | null;
}

export const SUPPLIER_MONEY_HOME_LABEL: Record<keyof SupplierMoneyHomeCounts, string> = {
  requestsToApprove: 'Requests to approve',
  purchaseTasksNotTaken: 'Purchase tasks not taken',
  purchaseWaitingForGoAhead: 'Hotel tasks waiting for Accounts go-ahead',
  purchaseCostsWaitingForManager: 'Costs above budget waiting for the Manager',
  paymentRequestsReturned: 'Payment requests returned to you',
  supplierInvoicesMissing: 'Supplier invoices missing after the trip',
  goAheadToApprove: 'Hotel go-ahead requests to check',
  supplierPaymentsToApprove: 'Supplier payments to approve',
  supplierPaymentsToRecord: 'Supplier payments to pay and record',
  supplierPaymentsToVerify: 'Supplier payments to verify',
  supplierDocumentsToReview: 'Supplier invoices and credit notes to check',
  fundingToApprove: 'Company funding to approve',
  fundingToRecover: 'Company funding to recover',
  managerApprovals: 'Waiting for your approval',
  flightFaresToApprove: 'Flight fares above budget to approve',
  flightPaymentsReturned: 'Flight payments returned',
  flightPaymentsMissing: 'Flight batches to pay',
};

// ---------------------------------------------------------------------------
// Command inputs and results
// ---------------------------------------------------------------------------

export interface PaymentRequestInput {
  taskId: string;
  expectedCostVersionNo: number;
  part: SupplierPaymentPart;
  amountPaise: Paise;
  dueDate: string | null;
  note: string | null;
  proformaEvidenceId: string;
  /** @deprecated Ignored by the database (review F1). Send false. */
  askFunding: boolean;
  /**
   * Optional note for Accounts (10–500). Stored as the company funding reason only if the server finds that
   * customer money does not cover the payment; never shown to Purchase again.
   */
  fundingReason: string | null;
}

export type Outcome = 'created' | 'existing';

export interface PaymentRequestCreated {
  outcome: Outcome;
  id: string;
  refNo: string;
  route: ApprovalRoute;
  status: SupplierPaymentStatus;
  /** @deprecated Review F1: always false; the database no longer returns it. */
  companyFundingAsked: boolean;
}

export interface DecisionResult {
  outcome: Outcome;
  id: string;
  status: string;
  rowVersion: number;
}

export interface EvidenceBegun {
  outcome: Outcome;
  evidenceId: string;
  objectPath: string;
}

export interface EvidenceFinished {
  evidenceId: string;
  status: 'stored' | 'failed';
}

export interface EvidenceDownload {
  objectPath: string;
  fileName: string;
  mime: string;
}

export type SupplierMoneyActionResult<T> =
  | { ok: true; data: T; message: string }
  | {
      ok: false;
      code: SupplierMoneyErrorCode | 'upload_failed' | 'session';
      message: string;
      /** What the person typed (never money amounts of others), returned so a refused form can show it again. */
      values?: Record<string, string>;
    };

// ---------------------------------------------------------------------------
// Form field names (server actions read exactly these)
// ---------------------------------------------------------------------------

export const SM_FIELD = {
  taskId: 'taskId',
  requestId: 'requestId',
  paymentId: 'paymentId',
  fundingId: 'fundingId',
  documentId: 'documentId',
  evidenceId: 'evidenceId',
  expectedCostVersionNo: 'expectedCostVersionNo',
  expectedRowVersion: 'expectedRowVersion',
  part: 'part',
  amountRupees: 'amountRupees',
  dueDate: 'dueDate',
  note: 'note',
  proformaEvidenceId: 'proformaEvidenceId',
  askFunding: 'askFunding',
  fundingReason: 'fundingReason',
  decision: 'decision',
  reason: 'reason',
  paidOn: 'paidOn',
  paymentMode: 'paymentMode',
  bankReference: 'bankReference',
  proofEvidenceId: 'proofEvidenceId',
  kind: 'kind',
  file: 'file',
  number: 'number',
  docDate: 'docDate',
  totalRupees: 'totalRupees',
  gstIncluded: 'gstIncluded',
} as const;

/** Server action names exported by crm/src/modules/supplier-money/server/actions.ts. */
export const SUPPLIER_MONEY_ACTIONS = [
  'uploadSupplierMoneyFileAction',
  'createPaymentRequestAction',
  'resubmitPaymentRequestAction',
  'cancelPaymentRequestAction',
  'decidePaymentRequestAction',
  'recordSupplierPaymentAction',
  'verifySupplierPaymentAction',
  'decideCompanyFundingAction',
  'markFundingRecoveredAction',
  'uploadSupplierDocumentAction',
  'reviewSupplierDocumentAction',
] as const;

/** Read helpers exported by crm/src/modules/supplier-money/server/queries.ts. */
export const SUPPLIER_MONEY_QUERIES = [
  'loadPurchasePaymentRequests',
  'loadPaymentContext',
  'loadAccountsSupplierPayments',
  'loadAccountsSupplierDocuments',
  'loadAccountsCompanyFunding',
  'loadManagerApprovals',
  'loadSupplierMoneyHomeCounts',
] as const;

/**
 * Download route helper exported by crm/src/modules/supplier-money/server/evidence.ts:
 * `supplierMoneyEvidenceDownloadResponse(id)` (GET handler body; 302 to a 60 s signed URL or 404).
 */
export const SUPPLIER_MONEY_EVIDENCE_ROUTE_HELPER = 'supplierMoneyEvidenceDownloadResponse' as const;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Route for a new request: cumulative live total for this supplier on this Deal including it. */
export function previewRoute(runningTotalPaise: Paise, amountPaise: Paise): ApprovalRoute {
  if (!/^\d+$/.test(runningTotalPaise) || !/^\d+$/.test(amountPaise)) return 'accounts';
  return BigInt(runningTotalPaise) + BigInt(amountPaise) > BigInt(APPROVAL_LIMIT_PAISE) ? 'manager' : 'accounts';
}

// ---------------------------------------------------------------------------
// Frozen wording
// ---------------------------------------------------------------------------

export const PAYMENT_PART_LABEL: Record<SupplierPaymentPart, string> = {
  deposit: 'Deposit',
  balance: 'Balance',
  full: 'Full payment',
};

export const PAYMENT_MODE_LABEL: Record<SupplierPaymentMode, string> = {
  bank_transfer: 'Bank transfer',
  upi: 'UPI',
  cheque: 'Cheque',
};

export const ROUTE_LABEL: Record<ApprovalRoute, string> = {
  accounts: 'Accounts approves',
  manager: 'Branch Manager approves',
};

/** Live notice in the payment drawer. */
export const ROUTE_NOTICE: Record<ApprovalRoute, string> = {
  accounts:
    'Accounts approves this request: the total for this supplier on this Deal, including this request, is ₹50,000 or less.',
  manager:
    'The branch Manager approves this request: the total for this supplier on this Deal, including this request, is above ₹50,000. Splitting a payment does not change who approves.',
};

export const PAYMENT_STATUS_LABEL: Record<SupplierPaymentStatus, string> = {
  pending: 'Waiting for approval',
  approved: 'Approved · not paid yet',
  returned: 'Returned',
  cancelled: 'Cancelled',
  paid: 'Paid · Accounts to verify',
  verified: 'Paid and verified',
};

export const PAYMENT_STATUS_HELP: Record<SupplierPaymentStatus, string> = {
  pending: 'Accounts or the branch Manager will approve or return it. Nothing is paid yet.',
  approved: 'Approved to pay. Accounts pays the supplier and records the payment. Approval is not payment.',
  returned: 'Sent back with a reason. Change it and send it again, or leave it.',
  cancelled: 'Cancelled by Purchase before a decision. Nothing was paid.',
  paid: 'Accounts recorded the payment. Another Accounts person checks it.',
  verified: 'Payment recorded and checked by a second Accounts person.',
};

export const HOLD_REASON_TEXT: Record<PaymentHoldReason, string> = {
  bank_details_on_hold:
    'On hold until the Manager approves the supplier’s latest bank details. Do not pay the old or the new account meanwhile.',
  funding_pending: 'On hold until the company funding for this payment is approved.',
  funding_returned: 'On hold: the company funding for this payment was returned. Return this payment request or ask again.',
};

export const FUNDING_STATUS_LABEL: Record<FundingStatus, string> = {
  pending: 'Waiting for approval',
  approved: 'Approved · to recover',
  returned: 'Returned',
  recovered: 'Recovered',
};

export const DOCUMENT_KIND_LABEL: Record<SupplierDocumentKind, string> = {
  invoice: 'Supplier invoice',
  credit_note: 'Credit note',
};

export const DOCUMENT_STATUS_LABEL: Record<SupplierDocumentStatus, string> = {
  uploaded: 'Uploaded · Accounts to check',
  accepted: 'Accepted by Accounts',
  returned: 'Returned by Accounts',
};

export const EVIDENCE_KIND_LABEL: Record<SupplierMoneyEvidenceKind, string> = {
  proforma: 'Supplier proforma or hold document',
  payment_proof: 'Payment proof',
  invoice: 'Supplier invoice',
  credit_note: 'Credit note',
};

/** One source for go-ahead wording: Track A's procurement contract. */
export { GO_AHEAD_STATE_LABEL } from '@/modules/procurement/contracts';

/** Optional field in every payment drawer (review F1): no customer money signal is shown to Purchase. */
export const NOTE_FOR_ACCOUNTS = {
  label: 'Note for Accounts (optional)',
  hint: 'Why the supplier must be paid by this date (a deadline or a hold). 10 to 500 characters. Do not mention customer amounts.',
} as const;

/** @deprecated Review F1: Purchase never sees a customer money signal. Use NOTE_FOR_ACCOUNTS. */
export const CUSTOMER_MONEY_SHORT_NOTICE = {
  title: 'Customer money has not arrived yet',
  body: 'You can ask the company to pay this supplier first. Tell Accounts why the supplier cannot wait (a deadline or a hold). Do not mention customer amounts.',
  checkboxLabel: 'Ask for company funding for this payment',
  reasonLabel: 'Why must the supplier be paid now?',
  reasonHint: '10 to 500 characters. Accounts or the branch Manager reads it.',
} as const;

export const INVOICE_MISSING_TEXT = 'Original invoice missing: the trip has ended and no supplier invoice is uploaded.';

export const SUPPLIER_MONEY_FILE_HINT =
  'PDF, JPG, PNG or WebP, up to 4 MB. Save an e-mail as PDF or take a screenshot; .eml files aren’t accepted.';

export const SUPPLIER_MONEY_ERROR_TEXT: Record<SupplierMoneyErrorCode | 'upload_failed' | 'session', string> = {
  not_authorized:
    'You can’t do this. Only the Purchase colleague who took the task asks for payment, Accounts or the branch Manager approves, and Accounts pays and checks.',
  not_found: 'We couldn’t find this. It may have been removed, or you may not have access.',
  version_changed: 'Someone changed this after you opened it. Nothing was saved. Review the latest details and try again.',
  task_conflict: 'This was already handled differently by someone else. Reload to see the latest state.',
  not_ready:
    'This can’t be done yet. A balance or full payment needs the supplier’s confirmation first; a deposit needs an agreed cost.',
  over_budget: 'The agreed cost is above the approved budget. The branch Manager must approve this cost first.',
  already_confirmed: 'The supplier already confirmed this service. This can’t change any more.',
  invalid_input: 'Some details aren’t valid. Check the fields and try again.',
  evidence_rejected:
    'This file can’t be used. Upload a PDF, JPG, PNG or WebP up to 4 MB that belongs to this task. Save e-mails as PDF or a screenshot.',
  go_ahead_missing: 'Waiting for Accounts go-ahead. Accounts approves every hotel commitment.',
  booking_request_not_sent: 'Send the booking request to the supplier first.',
  booking_not_approved: 'Accounts has not approved this booking yet. Approve the booking review first.',
  trip_cancelled: 'This trip is being cancelled. No new commitments or payment requests can be made.',
  payment_in_progress:
    'A payment request is open on this cost. Cancel it, or wait until it is returned, before changing the cost.',
  over_agreed_cost: 'The payment requests on this service would be more than the agreed supplier cost.',
  // Accounts/Manager only (approval re-check); never returned to Purchase.
  customer_money_short:
    'Customer money on this Deal no longer covers the customer part of this payment. Return it, or approve company funding first.',
  bank_details_on_hold:
    'The supplier’s latest bank details are not approved yet. The branch Manager must approve them before this payment is recorded.',
  funding_pending: 'The company funding for this payment is not approved yet. Nothing was recorded.',
  not_self_approval: 'You can’t approve your own request. Someone else must decide.',
  not_self_verification: 'You recorded this payment, so another Accounts person must verify it.',
  already_decided: 'Someone already decided this. Reload to see the latest state.',
  duplicate_request: 'This was already sent with different details. Reload the page and try again.',
  environment_unset: 'This CRM environment is not set up yet. Ask an admin.',
  not_configured: 'Supplier payments are not switched on for this company yet. Ask an admin.',
  procurement_disabled:
    'Purchase work is turned off for real bookings until the owner approves the Purchase rules. Your work is saved.',
  deal_removed:
    'This deal was removed from the CRM by the Bitrix sync. New work is paused; recorded money and history stay.',
  upload_failed: 'The file was not accepted and does not count. Upload it again.',
  session: 'You were signed out. Sign in again; what you typed is still on this page.',
};

export const SUPPLIER_MONEY_UNKNOWN_OUTCOME_TEXT =
  'We could not confirm this was saved. Reload the page to check before you try again. Your typed details are still here.';

/** Success wording for each action. */
export const SUPPLIER_MONEY_DONE_TEXT = {
  fileUploaded: 'File uploaded.',
  requestCreatedAccounts: 'Payment request sent to Accounts. Nothing is paid yet.',
  requestCreatedManager: 'Payment request sent to the branch Manager. Nothing is paid yet.',
  requestFundingAsked: 'Company funding was asked with it.',
  requestExisting: 'This payment request was already sent. Nothing changed.',
  requestCancelled: 'Payment request cancelled. Nothing was paid.',
  paymentApproved: 'Payment approved. Accounts pays the supplier and records it; approval is not payment.',
  paymentReturned: 'Payment request returned with your reason.',
  paymentRecorded: 'Payment recorded. Another Accounts person verifies it.',
  paymentVerified: 'Payment verified.',
  fundingApproved: 'Company funding approved.',
  fundingReturned: 'Company funding returned with your reason.',
  fundingRecovered: 'Company funding marked recovered.',
  documentUploaded: 'Document uploaded. Accounts checks it.',
  documentAccepted: 'Document accepted.',
  documentReturned: 'Document returned with your reason.',
  existing: 'This was already done. Nothing changed.',
} as const;

/** Confirmation dialogs for irreversible money actions. */
export const RECORD_PAYMENT_DIALOG_TEXT = {
  title: 'Record that this supplier was paid?',
  body: [
    'Record this only after the money has left the company’s bank account.',
    'Attach the payment proof. Another Accounts person verifies it.',
    'The CRM does not send any money.',
  ],
  confirmLabel: 'Record payment',
  cancelLabel: 'Go back',
} as const;
