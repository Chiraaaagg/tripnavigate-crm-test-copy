/**
 * Refunds (Accounts phase 2, Track C): frozen DTO shapes, words and refusal
 * texts for customer refunds (request, Manager decision, one-person payout),
 * keep-as-credit and charge-only settlements, and supplier refunds received.
 *
 * Contract: implementation/accounts-phase2-2026-11-11/contract.md sections
 * 7.1-7.5, 9, 10 and Addenda L1, L3, L5. Database:
 * crm/supabase/migrations/20261204000300..0350. Money is whole paise as
 * decimal strings; nothing here is a float.
 */
import { CONFLICT_STATES } from '@/lib/sqlstate';

export type Paise = string;

export const REFUND_KINDS = ['cancellation', 'overpayment'] as const;
export type RefundKind = (typeof REFUND_KINDS)[number];

export const REFUND_OUTCOMES = ['payout', 'keep_credit', 'charge_only'] as const;
export type RefundOutcome = (typeof REFUND_OUTCOMES)[number];

export const REFUND_STATUSES = ['requested', 'returned', 'approved', 'paid', 'withdrawn'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export const PAYEE_KINDS = ['original_payer', 'other'] as const;
export type PayeeKind = (typeof PAYEE_KINDS)[number];

export const PAYOUT_MODES = ['bank_transfer', 'upi', 'cash', 'cheque'] as const;
export type PayoutMode = (typeof PAYOUT_MODES)[number];

/** Accounts phase 3 (track G, LD29): + 'reconfirmation' = a lower supplier rate after an applied change (no cancellation). */
export const SUPPLIER_REFUND_SOURCES = ['purchase_charge', 'flight_charge', 'visa_fee', 'reconfirmation'] as const;
export type SupplierRefundSource = (typeof SUPPLIER_REFUND_SOURCES)[number];
export const SUPPLIER_REFUND_CHANGE_SOURCE = 'reconfirmation' as const;

export const SUPPLIER_REFUND_MODES = ['bank_transfer', 'upi', 'cheque', 'card_reversal', 'other'] as const;
export type SupplierRefundMode = (typeof SUPPLIER_REFUND_MODES)[number];

export const SUPPLIER_REFUND_STATUSES = ['verified', 'rejected'] as const;
export type SupplierRefundStatus = (typeof SUPPLIER_REFUND_STATUSES)[number];

export const REFUND_EVIDENCE_SUBJECTS = ['customer_refund', 'supplier_refund'] as const;
export type RefundEvidenceSubject = (typeof REFUND_EVIDENCE_SUBJECTS)[number];

export const REFUND_VIEWERS = ['accounts', 'manager', 'sales'] as const;
export type RefundViewer = (typeof REFUND_VIEWERS)[number];

export const REFUND_LIST_PRESETS = ['payout_due', 'to_approve'] as const;
export type RefundListPreset = (typeof REFUND_LIST_PRESETS)[number];

export const REFUND_EVIDENCE_BUCKET = 'finance-evidence';
export const REFUND_EVIDENCE_MAX_BYTES = 4 * 1024 * 1024;
export const REFUND_EVIDENCE_SIGNED_URL_SECONDS = 60;

// ---------------------------------------------------------------------------
// R-C1 deal_refunds
// ---------------------------------------------------------------------------

export interface RefundRequestCan {
  resubmit: boolean;
  withdraw: boolean;
  approve: boolean;
  return: boolean;
  payout: boolean;
}

export interface RefundRequestView {
  id: string;
  refNo: string;
  kind: RefundKind;
  outcome: RefundOutcome;
  status: RefundStatus;
  customerChargePaise: Paise;
  amountPaise: Paise;
  heldAtRequestPaise: Paise;
  payeeKind: PayeeKind | null;
  payeeName: string | null;
  payeeReason: string | null;
  payeeReceiptId: string | null;
  reason: string;
  requestedByName: string | null;
  requestedAt: string;
  requestedAs: 'sales_owner' | 'manager';
  decidedByName: string | null;
  decidedAt: string | null;
  returnReason: string | null;
  withdrawnByName: string | null;
  withdrawnAt: string | null;
  withdrawReason: string | null;
  rowVersion: number;
  /** Addendum L7: this payout uses the Deal's unused kept credit. */
  useKeptCredit?: boolean;
  /** Addendum L7 review 4: 'charge_below_costs_kept' (warning only). */
  warnings?: string[];
  /** reference and evidenceId: Accounts and the branch Manager only (null otherwise). */
  payout: { mode: PayoutMode; paidOn: string; reference: string | null; evidenceId: string | null; recordedByName: string | null } | null;
  creditNote: { documentId: string; number: string | null; status: string } | null;
  can: RefundRequestCan;
}

export interface SupplierRefundReceiptView {
  id: string;
  amountPaise: Paise;
  receivedOn: string;
  mode: SupplierRefundMode;
  reference: string;
  evidenceId: string;
  status: SupplierRefundStatus;
  rowVersion: number;
  recordedByName: string | null;
  rejectReason: string | null;
  canCancel: boolean;
}

export interface SupplierRefundSourceView {
  sourceKind: SupplierRefundSource;
  sourceId: string;
  /** Null for a 'reconfirmation' source (Accounts phase 3). */
  cancellationId: string | null;
  supplierId: string | null;
  supplierName: string | null;
  taskId: string;
  expectedPaise: Paise;
  receivedPaise: Paise;
  canRecord: boolean;
  receipts: SupplierRefundReceiptView[];
}

export interface DealRefundsView {
  dealId: string;
  dealReference: string;
  viewer: RefundViewer;
  enabled: boolean;
  heldPaise: Paise;
  cancellation: { id: string; status: string } | null;
  /** LD11: one combined "supplier and airline charges kept" figure. */
  chargesKeptPaise: Paise | null;
  basisTotalPaise: Paise | null;
  /** Addendum L7: highest charge of an approved settlement (a new request may not go below it); null when none. */
  approvedChargePaise?: Paise | null;
  /** Addendum L7: approved keep-as-credit not yet used by a payout (reserved unless a payout uses it). */
  keptCreditUnusedPaise?: Paise;
  maxRefundPaise: Paise;
  canRequest: boolean;
  payers: Array<{ receiptId: string; receiptNo: string; payerName: string; amountPaise: Paise }>;
  requests: RefundRequestView[];
  /** Accounts and the branch Manager only (absent for the Sales owner). */
  supplierRefunds?: SupplierRefundSourceView[];
}

// ---------------------------------------------------------------------------
// R-C2 refund_requests_list, R-C3 supplier_refunds_due
// ---------------------------------------------------------------------------

export interface RefundListFilter {
  preset?: RefundListPreset;
  status?: RefundStatus[];
  outcome?: RefundOutcome[];
  dealReference?: string;
  branchId?: string;
  from?: string;
  to?: string;
}

export interface RefundListRow {
  id: string;
  refNo: string;
  dealId: string;
  dealReference: string;
  branchName: string;
  kind: RefundKind;
  outcome: RefundOutcome;
  status: RefundStatus;
  amountPaise: Paise;
  customerChargePaise: Paise;
  requestedByName: string | null;
  requestedAt: string;
  ageWorkingDays: number;
  /** 20261204000370 (always present from the database; optional so older fixtures still type). */
  rowVersion?: number;
  can?: { approve: boolean; return: boolean; payout: boolean };
  /** The amounts a decision or payout binds to (hidden form fields); null unless the viewer may act. */
  expectedAmountPaise?: Paise | null;
  expectedChargePaise?: Paise | null;
  /** Addendum L7. */
  useKeptCredit?: boolean;
  warnings?: string[];
  /** 20261204000390 (Q7): Accounts and the branch Manager only; null for the Sales owner. */
  reason?: string | null;
  payeeKind?: PayeeKind | null;
  payeeName?: string | null;
  payeeReason?: string | null;
  /** The original payer's receipt number (R-…). */
  payeeReceiptNo?: string | null;
}

export interface RefundListPage {
  items: RefundListRow[];
  nextAfter: string | null;
}

export interface SupplierRefundsDueFilter {
  state?: 'open' | 'all';
  dealReference?: string;
  branchId?: string;
}

export interface SupplierRefundDueRow {
  /** Null for a 'reconfirmation' source (Accounts phase 3); changeRequestId / changeRefNo then name the change. */
  cancellationId: string | null;
  changeRequestId: string | null;
  changeRefNo: string | null;
  dealId: string;
  dealReference: string;
  branchName: string;
  approvedAt: string;
  sourceKind: SupplierRefundSource;
  sourceId: string;
  taskId: string;
  supplierId: string | null;
  supplierName: string | null;
  expectedPaise: Paise;
  receivedPaise: Paise;
  outstandingPaise: Paise;
  receipts: Array<{ id: string; amountPaise: Paise; receivedOn: string; mode: SupplierRefundMode; reference: string;
    status: SupplierRefundStatus; rowVersion: number; recordedByName: string | null }>;
}

export interface SupplierRefundsDuePage {
  items: SupplierRefundDueRow[];
  nextAfter: string | null;
}

// ---------------------------------------------------------------------------
// Command results
// ---------------------------------------------------------------------------

export type CommandOutcome = 'created' | 'updated' | 'existing';

export interface RefundCommandResult {
  outcome: CommandOutcome;
  refundRequestId: string;
  refNo: string;
  status: RefundStatus;
  rowVersion: number;
  payoutId?: string;
  journalEntryId?: string;
}

export interface SupplierRefundResult {
  outcome: CommandOutcome;
  supplierRefundId: string;
  status: SupplierRefundStatus;
  rowVersion: number;
}

export interface RefundEvidenceBegun {
  outcome: CommandOutcome;
  evidenceId: string;
  objectPath: string;
}

export interface RefundsSwitchResult {
  changed: boolean;
  refundsEnabled: boolean;
  rowVersion: number;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Server action results (Addendum L3)
// ---------------------------------------------------------------------------

export type RefundActionResult<T> =
  | { ok: true; message: string; data?: T }
  | {
      ok: false;
      code: RefundErrorCode | 'session' | 'file_rejected' | 'upload_failed';
      message: string;
      /** The refused contract key (amountPaise, paidOn, ...); the UI maps it to its input. */
      field?: string;
      /** What the person typed, returned so a refused form can show it again. */
      values?: Record<string, string>;
    };

// ---------------------------------------------------------------------------
// Refusal tokens (section 9) and frozen messages
// ---------------------------------------------------------------------------

export type RefundErrorCode =
  | 'refunds_off'
  | 'refund_open_exists'
  | 'refund_exceeds_money'
  | 'charge_below_approved'
  | 'evidence_missing'
  | 'over_expected'
  | 'duplicate_file'
  | 'not_self_approval'
  | 'not_ready'
  | 'wrong_state'
  | 'version_changed'
  | 'invalid_input'
  | 'not_authorized'
  | 'not_found'
  | 'request_conflict'
  | 'environment_unset'
  | 'not_configured';

export const REFUND_ERROR_STATES: Record<RefundErrorCode, string | readonly string[]> = {
  refunds_off: '55000',
  refund_open_exists: '23505',
  refund_exceeds_money: '22023',
  charge_below_approved: '22023',
  evidence_missing: '55000',
  over_expected: '22023',
  duplicate_file: '23505',
  not_self_approval: '42501',
  not_ready: '55000',
  wrong_state: '55000',
  version_changed: CONFLICT_STATES,
  invalid_input: '22023',
  not_authorized: '42501',
  not_found: 'P0002',
  request_conflict: CONFLICT_STATES,
  environment_unset: '55000',
  not_configured: '55000',
};

export const REFUND_ERROR_TEXT: Record<RefundErrorCode | 'session' | 'file_rejected' | 'upload_failed', string> = {
  refunds_off: 'Refunds are not switched on yet.',
  refund_open_exists: 'This Deal already has a refund in progress. Finish or withdraw it first.',
  refund_exceeds_money: 'The refund is more than the verified money held minus the customer charge.',
  charge_below_approved: 'The customer charge cannot be lower than the charge already approved. Ask the Manager to withdraw that approval first.',
  evidence_missing: 'Upload the payment proof first.',
  over_expected: 'This is more than the refund expected. Give a reason.',
  duplicate_file: 'This file is already uploaded. Choose the right proof.',
  not_self_approval: 'You cannot approve or pay out something you asked for or approved.',
  not_ready: 'This step is not available yet. The trip cancellation must be approved first.',
  wrong_state: 'This step is already done. Reload the page.',
  version_changed: 'Someone changed this meanwhile. Reload and try again.',
  invalid_input: 'Check the highlighted field.',
  not_authorized: 'You cannot do this here.',
  not_found: 'This item is no longer available. Reload the page.',
  request_conflict: 'This was already sent with different details. Reload the page and try again.',
  environment_unset: 'This CRM environment is not set up yet. Ask an admin.',
  not_configured: 'Accounts work is not switched on for this company yet. Ask an admin.',
  session: 'You were signed out. Sign in again; what you typed is still on this page.',
  file_rejected: 'This file cannot be used. Upload a PDF, JPG, PNG or WEBP file up to 4 MB.',
  upload_failed: 'The file did not upload. Try again.',
};

export const REFUND_UNKNOWN_OUTCOME_TEXT =
  'We could not confirm this was saved. Reload the page to check before you try again. Your typed details are still here.';

export const REFUND_DONE_TEXT = {
  requested: 'Refund request sent to the branch Manager.',
  resubmitted: 'Refund request sent again.',
  withdrawn: 'Refund request withdrawn.',
  approved: 'Refund approved.',
  returned: 'Refund returned to the requester.',
  paid: 'Refund paid out and verified.',
  proofStored: 'Proof uploaded.',
  supplierRefundRecorded: 'Supplier refund recorded and verified.',
  supplierRefundCancelled: 'Supplier refund cancelled.',
  switched: 'Refund setting saved.',
  existing: 'This was already done. Nothing changed.',
} as const;

/** FormData field names (Addendum L3: contract keys; staff-typed money as <key>Rupees). */
export const REFUND_FIELD = {
  dealId: 'dealId',
  refundRequestId: 'refundRequestId',
  supplierRefundId: 'supplierRefundId',
  entityId: 'entityId',
  requestId: 'requestId',
  expectedRowVersion: 'expectedRowVersion',
  reason: 'reason',
  kind: 'kind',
  outcome: 'outcome',
  customerChargeRupees: 'customerChargeRupees',
  amountRupees: 'amountRupees',
  payeeKind: 'payeeKind',
  payeeReceiptId: 'payeeReceiptId',
  payeeName: 'payeeName',
  payeeReason: 'payeeReason',
  useKeptCredit: 'useKeptCredit',
  decision: 'decision',
  expectedAmountPaise: 'expectedAmountPaise',
  expectedChargePaise: 'expectedChargePaise',
  mode: 'mode',
  paidOn: 'paidOn',
  reference: 'reference',
  evidenceId: 'evidenceId',
  file: 'file',
  subjectKind: 'subjectKind',
  subjectId: 'subjectId',
  sourceKind: 'sourceKind',
  sourceId: 'sourceId',
  receivedOn: 'receivedOn',
  overExpectedReason: 'overExpectedReason',
  enabled: 'enabled',
} as const;

/** Pages revalidated after a refund command. */
export const REFUND_PATHS = ['/app/accounts/refunds', '/app/approvals', '/app/accounts', '/app/accounts/dues'] as const;
