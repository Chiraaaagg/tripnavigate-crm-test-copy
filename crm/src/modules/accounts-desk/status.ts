import type {
  Direction,
  DuesBasis,
  DuesStatus,
  InstalmentStatus,
  OriginalState,
  OriginalWhat,
  RecordKind,
  RecordStage,
  ReviewStatus,
  TallyStatus,
} from './contracts';

/**
 * Display words for the Accounts desk (pure). Status is always shown as a
 * word, never by colour alone. Track D renders these; the database decides
 * the values.
 */

export const RECORD_KIND_LABEL: Record<RecordKind, string> = {
  receipt: 'Receipt',
  receipt_reversal: 'Receipt reversal',
  claim: 'Payment reported by Sales',
  cash_deposit: 'Cash deposit',
  cash_count: 'Cash count',
  supplier_payment: 'Supplier payment',
  company_funding: 'Company funding',
  supplier_invoice: 'Supplier invoice',
  supplier_credit_note: 'Supplier credit note',
  expense: 'Expense paid by the company',
  flight_ticket_batch: 'Flight tickets',
  visa_application: 'Visa application',
  tally_gst_invoice: 'GST invoice reference',
  original: 'Original document',
};

/** Amount column words (11.1). */
export const DIRECTION_LABEL: Record<Direction, string> = {
  in: 'Received',
  out: 'Paid out',
  bill: 'Bill',
  credit: 'Credit note',
  contra: 'Moved to bank',
  info: 'Info',
};

export const STAGE_LABEL: Record<RecordStage, string> = {
  open: 'Open',
  done: 'Done',
  returned: 'Returned',
  cancelled: 'Cancelled',
};

export const REVIEW_LABEL: Record<ReviewStatus, string> = {
  waiting: 'Waiting for Accounts',
  done: 'Checked',
  returned: 'Returned',
  not_needed: 'No check needed',
};

export const TALLY_STATUS_LABEL: Record<TallyStatus, string> = {
  not_ready: 'Not ready',
  ready: 'Ready',
  exported: 'Exported',
  matched: 'Matched',
  exception: 'Exception',
  not_applicable: 'Not for Tally',
};

export const ORIGINAL_WHAT_LABEL: Record<OriginalWhat, string> = {
  supplier_invoice: 'Supplier invoice',
  airline_bill: 'Airline or portal bill',
  fee_receipt: 'Fee receipt',
  bank_proof: 'Bank proof',
  gst_invoice_ref: 'GST invoice reference',
};

export const ORIGINAL_STATE_LABEL: Record<OriginalState, string> = {
  expected: 'Expected',
  missing: 'Missing',
};

/** A claim is never money. */
export const CLAIM_NOT_MONEY_TEXT = 'Reported — not money';

export const DUES_STATUS_LABEL: Record<DuesStatus, string> = {
  overdue: 'Overdue',
  due_now: 'Due today',
  upcoming: 'Upcoming',
  paid: 'Paid',
  credit: 'Customer credit',
  unallocated: 'Received, not linked to a plan',
  no_plan: 'No payment plan',
};

export const INSTALMENT_STATUS_LABEL: Record<InstalmentStatus, string> = {
  paid: 'Paid',
  overdue: 'Overdue',
  due_now: 'Due today',
  upcoming: 'Upcoming',
};

export const REPORTED_FLAG_TEXT = 'Reported, not yet money';
export const CANCELLATION_OPEN_TEXT = 'Cancellation open';
export const CANCELLATION_APPROVED_TEXT = 'Cancellation approved';
export const PROVISIONAL_TEXT = 'Provisional — booking not yet approved by Accounts';
export const PAYABLES_NOTE_TEXT = 'TDS and bank charges are not worked out here.';

/** The basis line under the dues (11.2, lead decision AL3). */
export function basisLine(basis: DuesBasis): string {
  if (basis.kind === 'awaiting_review') return PROVISIONAL_TEXT;
  if (basis.newerVersionPending) {
    return `A newer version is waiting for Accounts; dues follow version ${basis.versionNo}.`;
  }
  return `Based on version ${basis.versionNo} approved by Accounts`;
}

/** "Already exported on <date>" note for a row, or null. */
export function exportedNote(lastExportedAt: string | null): string | null {
  return lastExportedAt ? `Already exported on ${lastExportedAt.slice(0, 10)}` : null;
}
