/**
 * Flight money contract (Track B of the Flight build, frozen 4 Nov 2026).
 * Contract sections 4, 6.2, 6.3, 9.3, 9.4; migrations
 * crm/supabase/migrations/20261201000200..0220.
 *
 * Owner decisions (binding): the per-passenger fare breakup is the only
 * flight cost record (D3): Basic + K + YQ + YR + Other (+ Markup − Discount
 * on flight-only Deals) = total per person; supplier cost = Basic + K + YQ +
 * YR + Other. Markup and discount exist only on flight-only Deals (D4). Above
 * the Deal's flight budget the branch Manager approves the exact fare set
 * before tickets are confirmed. Flight pays the supplier directly while the
 * cumulative total for that supplier on that Deal (direct payments not
 * returned + live payment requests + this one) stays at or below ₹50,000;
 * above that a supplier payment request goes to the branch Manager (D2, C1).
 * Accounts records; a different Accounts person verifies. Nothing pays
 * automatically.
 *
 * Every RPC returns exactly these camelCase shapes; amounts are whole paise
 * as decimal digit strings. Purchase and Visa get null from every flight
 * read. Package Deals carry no markup, discount or customer amounts.
 */

export type Paise = string;

/** ₹50,000 in paise: the cumulative direct-payment ceiling per Deal and supplier. */
export const FLIGHT_DIRECT_LIMIT_PAISE = '5000000';

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export type FlightPaxType = 'adult' | 'child' | 'infant';
export const FLIGHT_PAX_TYPES: readonly FlightPaxType[] = ['adult', 'child', 'infant'];

export type FlightDealKind = 'package' | 'flight_only';

export type FlightCrsType = 'amadeus' | 'galileo' | 'sabre' | 'airline_direct' | 'other';
export const FLIGHT_CRS_TYPES: readonly FlightCrsType[] = ['amadeus', 'galileo', 'sabre', 'airline_direct', 'other'];

export type FlightPaymentState =
  | 'unpaid'
  | 'direct_submitted'
  | 'direct_accepted'
  | 'direct_returned'
  | 'request_pending'
  | 'request_approved'
  | 'request_paid'
  | 'request_verified'
  | 'request_returned'
  | 'request_cancelled';

export type FlightPaymentRoute = 'direct' | 'accounts' | 'manager';

export type FlightDirectPaymentMode = 'bank_transfer' | 'upi' | 'card' | 'cash' | 'other';
export const FLIGHT_DIRECT_PAYMENT_MODES: readonly FlightDirectPaymentMode[] = ['bank_transfer', 'upi', 'card', 'cash', 'other'];

export type FlightFareApprovalStatus = 'pending' | 'approved' | 'returned' | 'withdrawn' | 'used';

export type FlightBudgetSource = 'typed' | 'estimate' | 'none';

// ---------------------------------------------------------------------------
// Refusal tokens (the database message is exactly the token)
// ---------------------------------------------------------------------------

export type FlightMoneyErrorCode =
  | 'not_authorized'
  | 'not_found'
  | 'version_changed'
  | 'duplicate_request'
  | 'invalid_input'
  | 'not_ready'
  | 'booking_changed'
  | 'traveller_not_on_sector'
  | 'already_confirmed'
  | 'not_self_approval'
  | 'already_decided'
  | 'ticket_number_taken'
  | 'discount_over_fare'
  | 'over_budget'
  | 'fare_approval_mismatch'
  | 'not_over_budget'
  | 'payment_in_progress'
  | 'direct_payment_over_limit'
  | 'receipt_required'
  | 'cost_locked'
  | 'trip_cancelled'
  | 'duplicate_supplier'
  | 'evidence_rejected'
  | 'deal_removed'
  | 'environment_unset'
  | 'not_configured';

/** SQLSTATE each token arrives with (a token with any other state is not trusted). */
export const FLIGHT_MONEY_ERROR_STATES: Record<FlightMoneyErrorCode, string> = {
  not_authorized: '42501',
  not_found: 'P0002',
  version_changed: '40001',
  duplicate_request: '40001',
  invalid_input: '22023',
  not_ready: '55000',
  booking_changed: '55000',
  traveller_not_on_sector: '22023',
  already_confirmed: '55000',
  not_self_approval: '42501',
  already_decided: '55000',
  ticket_number_taken: '23505',
  discount_over_fare: '22023',
  over_budget: '55000',
  fare_approval_mismatch: '55000',
  not_over_budget: '55000',
  payment_in_progress: '55000',
  direct_payment_over_limit: '22023',
  receipt_required: '55000',
  cost_locked: '55000',
  trip_cancelled: '55000',
  duplicate_supplier: '23505',
  evidence_rejected: '22023',
  deal_removed: '55000',
  environment_unset: '55000',
  not_configured: '55000',
};

/** Frozen staff messages (contract 6.3; gate, file and session tokens keep the existing supplier money wording). */
export const FLIGHT_MONEY_ERROR_TEXT: Record<FlightMoneyErrorCode | 'session' | 'upload_failed', string> = {
  not_authorized: 'You cannot do this on this flight.',
  not_found: 'This item is no longer available. Reload the page.',
  version_changed: 'Someone changed this flight meanwhile. Reload and try again.',
  duplicate_request: 'This was already sent with different details. Reload the page.',
  invalid_input: 'Check the highlighted field.',
  not_ready: 'Finish the steps listed before doing this.',
  booking_changed: 'Sales sent a new booking. Review "Booking changed" first.',
  traveller_not_on_sector: 'A chosen traveller is not on that flight.',
  already_confirmed: 'This traveller already has a ticket on that flight.',
  not_self_approval: 'You cannot approve your own request.',
  already_decided: 'This was already decided. Reload the page.',
  ticket_number_taken: 'This ticket number already belongs to another traveller.',
  discount_over_fare: 'The discount is more than the fare.',
  over_budget: 'The supplier cost is above the approved budget. Ask the Manager to approve these fares.',
  fare_approval_mismatch: 'The fares changed after the Manager approved them. Ask again.',
  not_over_budget: 'These fares are within the budget. No approval is needed.',
  payment_in_progress: 'A payment for these tickets already exists.',
  direct_payment_over_limit: 'Above ₹50,000 for this supplier on this Deal, raise a payment request.',
  receipt_required: 'Attach the payment proof first.',
  cost_locked: 'This payment record is with Accounts and cannot be changed now.',
  trip_cancelled: 'This trip is cancelled. No new tickets or payments.',
  duplicate_supplier: 'A supplier with this name already exists.',
  evidence_rejected:
    'This file can’t be used. Upload a PDF, JPG, PNG or WebP up to 4 MB that belongs to this flight.',
  deal_removed:
    'This deal was removed from the CRM by the Bitrix sync. New work is paused; recorded money and history stay.',
  environment_unset: 'This CRM environment is not set up yet. Ask an admin.',
  not_configured: 'Supplier payments are not switched on for this company yet. Ask an admin.',
  session: 'You were signed out. Sign in again; what you typed is still on this page.',
  upload_failed: 'The file was not accepted and does not count. Upload it again.',
};

/**
 * Lead decision 5 Nov 2026: on a flight-only Deal a caller who also holds
 * Purchase may not enter markup or discount. The database refuses
 * not_authorized with this hint (preview, approval request, confirm); the
 * action returns it in `fields` with the message below.
 */
export const FLIGHT_PURCHASE_HOLDER_HINT = 'purchase_holder_margin';
export const FLIGHT_PURCHASE_HOLDER_TEXT =
  'Another Flight person must confirm fares on this flight-only Deal, because you also work in Purchase.';

export const FLIGHT_MONEY_UNKNOWN_OUTCOME_TEXT =
  'We could not confirm whether this was saved. Reload the page to check before trying again.';

// ---------------------------------------------------------------------------
// Inputs (p_fields of the commands; camelCase, exactly these keys)
// ---------------------------------------------------------------------------

/** One fare line per passenger type present among the posted travellers. */
export interface FlightFareInput {
  paxType: FlightPaxType;
  basicPaise: Paise;
  kPaise: Paise;
  yqPaise: Paise;
  yrPaise: Paise;
  otherPaise: Paise;
  /** Flight-only Deals only (required there, 0 allowed); absent on package Deals. */
  markupPaise?: Paise;
  discountPaise?: Paise;
}

/** One passenger line of "Confirm tickets". Preview and approval ignore the ticket identifiers. */
export interface FlightTicketLineInput {
  seq: number;
  crsType: FlightCrsType;
  /** Required unless crsType is airline_direct (then null). */
  crsPnr: string | null;
  airlinePnr: string;
  ticketNumber: string;
}

/** p_fields of flight_fare_preview / flight_fare_approval_request / flight_tickets_confirm. */
export interface FlightFareFields {
  sectorIds: string[];
  supplierId: string;
  fareApprovalId: string | null;
  fares: FlightFareInput[];
  travellers: FlightTicketLineInput[];
}

/**
 * p_fields of flight_fare_preview / flight_fare_approval_request: fares can be
 * previewed and sent to the Manager before ticket details exist. Ticket
 * identifiers are optional there and never part of the fare hash, so the
 * approved hash equals the hash of the confirm that posts the same fares.
 */
export interface FlightFareSetFields {
  sectorIds: string[];
  supplierId: string;
  fareApprovalId: string | null;
  fares: FlightFareInput[];
  travellers: Array<{ seq: number }>;
}

/** p_fields of flight_direct_payment_save. */
export interface FlightDirectPaymentFields {
  paymentMode: FlightDirectPaymentMode;
  paidOn: string;
  reference: string | null;
  proofEvidenceId: string;
}

/** p_fields of flight_payment_request_create (batchId comes from the argument) and of a flight resubmit. */
export interface FlightPaymentRequestFields {
  dueDate: string | null;
  note: string | null;
  proformaEvidenceId: string | null;
}

/** p_fields of flight_supplier_create. */
export interface FlightSupplierFields {
  name: string;
  city: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
}

/** p_fields of flight_supplier_update (all fields each time; status optional = unchanged). */
export interface FlightSupplierUpdateFields extends FlightSupplierFields {
  status?: 'active' | 'archived';
}

/** p_fields of flight_supplier_add_beneficiary. */
export interface FlightBeneficiaryFields {
  accountHolder: string;
  bankName: string;
  ifsc: string;
  accountNumber: string;
}

// ---------------------------------------------------------------------------
// Command results
// ---------------------------------------------------------------------------

export type FlightMoneyOutcome = 'created' | 'updated' | 'existing';

export interface FlightTicketsConfirmed {
  outcome: FlightMoneyOutcome;
  batchId: string;
  batchNo: number;
  ticketCount: number;
  travellersConfirmed: number;
  /** Ticket pairs of the Deal's open flight tasks still without a ticket. */
  stillPending: number;
}

export interface FlightFareApprovalRequested {
  outcome: FlightMoneyOutcome;
  approvalId: string;
  approvalNo: number;
  status: FlightFareApprovalStatus;
  rowVersion: number;
  fareHash: string;
}

export interface FlightFareApprovalChanged {
  outcome: FlightMoneyOutcome;
  approvalId: string;
  status: FlightFareApprovalStatus;
  rowVersion: number;
}

export interface FlightDirectPaymentSaved {
  outcome: FlightMoneyOutcome;
  batchId: string;
  entryId: string;
  rowVersion: number;
  expenseStatus: 'submitted';
}

export interface FlightPaymentRequestCreated {
  outcome: FlightMoneyOutcome;
  id: string;
  refNo: string;
  route: 'accounts' | 'manager';
  status: 'pending';
}

export interface FlightSupplierCreated {
  outcome: FlightMoneyOutcome;
  supplierId: string;
  rowVersion: number;
}

export interface FlightBeneficiaryRecorded {
  revisionId: string;
  revisionNo: number;
  created: boolean;
}

// ---------------------------------------------------------------------------
// Reads (contract 9.3 / 9.4)
// ---------------------------------------------------------------------------

export interface FlightSupplierView {
  supplierId: string;
  name: string;
  city: string | null;
  status: 'active' | 'archived';
  bankDetailsApproved: boolean;
  verification: 'unverified' | 'verified';
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  rowVersion: number;
}

export interface FlightFarePreviewView {
  fareHash: string;
  batchSupplierCostPaise: Paise;
  /** Flight-only Deals only. */
  batchCustomerTotalPaise: Paise | null;
  dealSupplierCostAfterPaise: Paise;
  /** null = no flight budget on the Deal (every fare set needs the Manager). */
  dealBudgetPaise: Paise | null;
  overBudget: boolean;
  /** The Manager approval of exactly these fares on the current other batches. */
  approval: null | { approvalId: string; status: 'pending' | 'approved' | 'returned' };
  costTaskId: string;
}

export interface FlightBatchFareView {
  paxType: FlightPaxType;
  basicPaise: Paise;
  kPaise: Paise;
  yqPaise: Paise;
  yrPaise: Paise;
  otherPaise: Paise;
  supplierPerPersonPaise: Paise;
  paxCount: number;
  supplierAmountPaise: Paise;
  /** Flight-only Deals only (null on package Deals). */
  markupPaise: Paise | null;
  discountPaise: Paise | null;
  totalPerPersonPaise: Paise | null;
  customerAmountPaise: Paise | null;
}

export interface FlightBatchPaymentView {
  state: FlightPaymentState;
  /** null for the Sales owner (state only). */
  route: FlightPaymentRoute | null;
  refNo: string | null;
  returnReason: string | null;
  /** The Flight person only. */
  entryId: string | null;
  entryRowVersion: number | null;
  paymentId: string | null;
  paymentRowVersion: number | null;
  /** Flight sees only a bank-details hold (never a company funding signal). */
  onHold: boolean | null;
  holdReason: string | null;
}

export interface FlightMoneyBatchView {
  batchId: string;
  batchNo: number;
  costTaskId: string;
  supplierId: string;
  supplierName: string;
  sectorIds: string[];
  confirmedAt: string;
  confirmedByName: string | null;
  /** Empty for the Sales owner of a package Deal. */
  fares: FlightBatchFareView[];
  /** null for the Sales owner of a package Deal. */
  supplierCostPaise: Paise | null;
  /** Old-form flight payments (before the fare breakup) linked to this batch and with Accounts (lead L18); null when not shown. */
  legacyPaidPaise: Paise | null;
  /** Still to pay: supplier cost less legacyPaidPaise (what a direct payment or request is for); null when not shown. */
  duePaise: Paise | null;
  /** Flight-only Deals only. */
  customerTotalPaise: Paise | null;
  payment: FlightBatchPaymentView;
  /** The Flight person only. */
  canPayDirect: boolean;
  canRequest: boolean;
  /** null for the Sales owner. */
  routePreview: FlightPaymentRoute | null;
}

export interface FlightFareApprovalView {
  approvalId: string;
  approvalNo: number;
  status: FlightFareApprovalStatus;
  batchSupplierCostPaise: Paise;
  projectedSupplierCostPaise: Paise;
  budgetPaise: Paise | null;
  requestedAt: string;
  requestedByName: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  returnReason: string | null;
  rowVersion: number;
  canDecide: boolean;
  canWithdraw: boolean;
}

export interface FlightInvoiceView {
  documentId: string;
  supplierId: string;
  number: string;
  docDate: string;
  totalPaise: Paise;
  status: 'uploaded' | 'accepted' | 'returned';
}

export interface FlightMoneyView {
  dealKind: FlightDealKind;
  /** True only on flight-only Deals for a caller who may see and enter markup and discount (never a Purchase holder). */
  marginsAllowed: boolean;
  budget: { dealPaise: Paise | null; tasks: Array<{ taskId: string; budgetPaise: Paise | null; source: FlightBudgetSource }> };
  supplierCostPaise: Paise;
  overBudget: boolean;
  /** Flight-only Deals only. */
  customerTotalPaise: Paise | null;
  batches: FlightMoneyBatchView[];
  /** Empty for the Sales owner. */
  supplierTotals: Array<{ supplierId: string; supplierName: string; runningTotalPaise: Paise }>;
  approvals: FlightFareApprovalView[];
  invoices: FlightInvoiceView[];
  /** null for the Sales owner. */
  invoiceMissing: boolean | null;
}

/** flight_fare_approval_sets: the exact fare set of a pending or approved approval (F, M, A). */
export interface FlightFareApprovalSetView {
  approvalId: string;
  approvalNo: number;
  status: 'pending' | 'approved';
  rowVersion: number;
  fareHash: string;
  supplierId: string;
  supplierName: string | null;
  sectorIds: string[];
  travellers: Array<{ seq: number; type: FlightPaxType }>;
  fares: Array<{
    paxType: FlightPaxType;
    basicPaise: Paise;
    kPaise: Paise;
    yqPaise: Paise;
    yrPaise: Paise;
    otherPaise: Paise;
    /** Flight-only Deals only (null on package Deals). */
    markupPaise: Paise | null;
    discountPaise: Paise | null;
    paxCount: number;
  }>;
}

export interface FlightPaymentContextView {
  batchId: string;
  batchNo: number;
  costTaskId: string;
  /** Still to pay (the amount of a direct payment or request): supplier cost less old-form payments. */
  amountPaise: Paise;
  supplierCostPaise: Paise;
  legacyPaidPaise: Paise;
  supplierId: string;
  supplierName: string;
  runningTotalPaise: Paise;
  routePreview: 'direct' | 'manager';
  directAllowed: boolean;
  directLimitPaise: Paise;
  proofs: Array<{ evidenceId: string; fileName: string }>;
}

// ---------------------------------------------------------------------------
// Action results and form fields
// ---------------------------------------------------------------------------

export type FlightMoneyActionResult<T> =
  | { ok: true; data: T; message: string }
  | {
      ok: false;
      code: FlightMoneyErrorCode | 'session' | 'upload_failed';
      message: string;
      /** For invalid_input: the input keys the database named ("fares[0].markupPaise", "supplierId"). */
      fields?: string[];
    };

/** Form field names the money server actions read. */
export const FM_FIELD = {
  dealId: 'dealId',
  taskId: 'taskId',
  batchId: 'batchId',
  paymentId: 'paymentId',
  approvalId: 'approvalId',
  supplierId: 'supplierId',
  status: 'status',
  requestId: 'requestId',
  expectedRowVersion: 'expectedRowVersion',
  /** JSON of FlightFareFields (Confirm tickets popup). */
  fareFields: 'fareFields',
  decision: 'decision',
  reason: 'reason',
  paymentMode: 'paymentMode',
  paidOn: 'paidOn',
  reference: 'reference',
  proofEvidenceId: 'proofEvidenceId',
  dueDate: 'dueDate',
  note: 'note',
  proformaEvidenceId: 'proformaEvidenceId',
  name: 'name',
  city: 'city',
  contactName: 'contactName',
  contactPhone: 'contactPhone',
  contactEmail: 'contactEmail',
  accountHolder: 'accountHolder',
  bankName: 'bankName',
  ifsc: 'ifsc',
  accountNumber: 'accountNumber',
  file: 'file',
  kind: 'kind',
  number: 'number',
  docDate: 'docDate',
  totalRupees: 'totalRupees',
  gstIncluded: 'gstIncluded',
} as const;

// ---------------------------------------------------------------------------
// Labels and texts (contract 11.1)
// ---------------------------------------------------------------------------

export const FLIGHT_PAYMENT_STATE_LABEL: Record<FlightPaymentState, string> = {
  unpaid: 'Not paid yet',
  direct_submitted: 'Paid directly · Accounts to check',
  direct_accepted: 'Paid directly · checked by Accounts',
  direct_returned: 'Returned by Accounts',
  request_pending: 'Payment request waiting for approval',
  request_approved: 'Payment approved · Accounts to pay',
  request_paid: 'Paid by Accounts · to verify',
  request_verified: 'Paid and verified',
  request_returned: 'Payment request returned',
  request_cancelled: 'Payment request cancelled',
};

export const FLIGHT_DIRECT_PAYMENT_MODE_LABEL: Record<FlightDirectPaymentMode, string> = {
  bank_transfer: 'Bank transfer',
  upi: 'UPI',
  card: 'Card',
  cash: 'Cash',
  other: 'Other',
};

export const FLIGHT_ROUTE_TEXT = {
  directAllowed: 'Within ₹50,000 for this supplier on this Deal: pay directly',
  directRefused: 'Above ₹50,000 for this supplier on this Deal: raise a payment request',
  requestAccounts: 'Goes to Accounts',
  requestManager: 'Goes to the branch Manager (above ₹50,000 for this supplier on this Deal)',
} as const;

export const FLIGHT_FARE_APPROVAL_STATUS_LABEL: Record<FlightFareApprovalStatus, string> = {
  pending: 'Waiting for the Manager',
  approved: 'Approved by the Manager',
  returned: 'Returned by the Manager',
  withdrawn: 'Withdrawn',
  used: 'Used for confirmed tickets',
};

export const FLIGHT_MONEY_DONE_TEXT = {
  existing: 'This was already saved.',
  ticketsConfirmed: (n: number) => `${n} ${n === 1 ? 'ticket' : 'tickets'} confirmed.`,
  approvalRequested: 'Sent to the Manager to approve these fares.',
  approvalApproved: 'Fares approved.',
  approvalReturned: 'Fares returned with your reason.',
  approvalWithdrawn: 'Approval request withdrawn.',
  directPaymentSaved: 'Direct payment recorded and sent to Accounts. A different Accounts person checks it.',
  requestCreatedAccounts: 'Payment request sent. Accounts approves it. Nothing is paid yet.',
  requestCreatedManager: 'Payment request sent. The branch Manager approves it. Nothing is paid yet.',
  requestCancelled: 'Payment request cancelled.',
  supplierCreated: 'Supplier added.',
  supplierUpdated: 'Supplier saved. Changed details are checked again by the Manager.',
  supplierArchived: 'Supplier archived. It is no longer offered for new tickets.',
  beneficiaryRecorded: 'Bank details saved. The Manager checks them before any payment is recorded.',
  fileUploaded: 'File uploaded.',
  invoiceUploaded: 'Supplier invoice saved. Accounts checks it.',
} as const;
