import type { StatusTone } from '@/components/ui/badge';
import { formatPaise } from '@/modules/deals/dto';
import type { Department, Direction, DuesStatus, InstalmentStatus, OriginalWhat, RecordKind, RecordStage, ReviewState, TallyAnyRecordKind, TallyStatus } from './types';

/*
 * Words for the Accounts desk screens (contract 11.1–11.4). Every status is
 * shown as an icon plus these words, never colour alone. Refusal messages are
 * the frozen texts of contract 5.4 / 7.7; the server actions return them, the
 * screens show them as given (these copies are for the preview gallery).
 */

const DAY = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'Asia/Kolkata' });
const DAY_UTC = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'UTC' });
const WHEN = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });

/** A date (YYYY-MM-DD) or a timestamp, as a calendar day (timestamps in IST). */
export function dayText(iso: string | null | undefined): string {
  if (!iso) return 'Not set';
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const t = Date.parse(`${iso}T00:00:00Z`);
    return Number.isNaN(t) ? iso : DAY_UTC.format(t);
  }
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : DAY.format(t);
}

/** A timestamp with time, IST. */
export function whenText(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : `${WHEN.format(t)} IST`;
}

export const inr = (paise: string | null | undefined): string => (paise === null || paise === undefined ? '—' : formatPaise(paise));

export const KIND_LABEL: Record<RecordKind, string> = {
  receipt: 'Receipt',
  receipt_reversal: 'Receipt reversal',
  claim: 'Reported payment',
  cash_deposit: 'Cash deposit',
  cash_count: 'Cash count',
  supplier_payment: 'Supplier payment',
  company_funding: 'Company funding',
  supplier_invoice: 'Supplier invoice',
  supplier_credit_note: 'Supplier credit note',
  expense: 'Company-paid expense',
  flight_ticket_batch: 'Flight tickets',
  visa_application: 'Visa application',
  tally_gst_invoice: 'GST invoice reference',
  original: 'Original needed',
};

/** Plural nouns for the record-type filter. */
export const KIND_FILTER_LABEL: Record<RecordKind, string> = {
  receipt: 'Receipts',
  receipt_reversal: 'Receipt reversals',
  claim: 'Reported payments',
  cash_deposit: 'Cash deposits',
  cash_count: 'Cash counts',
  supplier_payment: 'Supplier payments',
  company_funding: 'Company funding',
  supplier_invoice: 'Supplier invoices',
  supplier_credit_note: 'Supplier credit notes',
  expense: 'Company-paid expenses',
  flight_ticket_batch: 'Flight tickets',
  visa_application: 'Visa applications',
  tally_gst_invoice: 'GST invoice references',
  original: 'Originals needed',
};

/** Contract 11.1: amount direction in words. */
export const DIRECTION_LABEL: Record<Direction, string> = {
  in: 'Received',
  out: 'Paid out',
  contra: 'Moved to bank',
  bill: 'Bill',
  credit: 'Credit note',
  info: 'Info',
};

export const STAGE_LABEL: Record<RecordStage, string> = { open: 'Open', done: 'Done', returned: 'Returned', cancelled: 'Cancelled' };
export const STAGE_TONE: Record<RecordStage, StatusTone> = { open: 'info', done: 'success', returned: 'warning', cancelled: 'neutral' };

export const REVIEW_LABEL: Record<ReviewState, string> = { waiting: 'Waiting for review', done: 'Reviewed', returned: 'Returned', not_needed: 'No review needed' };
export const REVIEW_TONE: Record<ReviewState, StatusTone> = { waiting: 'warning', done: 'success', returned: 'danger', not_needed: 'neutral' };

export const TALLY_LABEL: Record<TallyStatus, string> = {
  not_ready: 'Not ready',
  ready: 'Ready for Tally',
  exported: 'Exported',
  matched: 'Matched',
  exception: 'Exception',
  not_applicable: 'Not for Tally',
};
export const TALLY_TONE: Record<TallyStatus, StatusTone> = { not_ready: 'neutral', ready: 'info', exported: 'brand', matched: 'success', exception: 'danger', not_applicable: 'neutral' };

export const TALLY_KIND_LABEL: Record<TallyAnyRecordKind, string> = {
  journal_entry: 'Receipts, reversals, deposits and customer refunds',
  supplier_payment: 'Supplier payments',
  supplier_document: 'Supplier invoices and credit notes',
  expense: 'Company-paid expenses',
  tally_gst_invoice: 'GST invoice references',
  customer_document: 'Customer documents (Advance Invoices, Invoices, Credit Notes)',
  supplier_refund: 'Supplier refunds',
  write_off: 'Write-off',
};

export const DEPARTMENT_LABEL: Record<Department, string> = { sales: 'Sales', accounts: 'Accounts', purchase: 'Purchase', flight: 'Flight', visa: 'Visa and passport' };

export const ORIGINAL_LABEL: Record<OriginalWhat, string> = {
  supplier_invoice: 'Supplier invoice',
  airline_bill: 'Airline or portal bill',
  fee_receipt: 'Fee receipt',
  bank_proof: 'Bank proof',
  gst_invoice_ref: 'Tally GST invoice reference',
};

/** Contract 11.2 status words. */
export const DUES_LABEL: Record<DuesStatus, string> = {
  overdue: 'Overdue',
  due_now: 'Due today',
  upcoming: 'Upcoming',
  paid: 'Paid',
  credit: 'Customer credit',
  unallocated: 'Received, not linked to a plan',
  no_plan: 'No payment plan',
};
export const DUES_TONE: Record<DuesStatus, StatusTone> = { overdue: 'danger', due_now: 'warning', upcoming: 'info', paid: 'success', credit: 'brand', unallocated: 'warning', no_plan: 'neutral' };

export const INSTALMENT_LABEL: Record<InstalmentStatus, string> = { paid: 'Paid', overdue: 'Overdue', due_now: 'Due today', upcoming: 'Upcoming' };
export const INSTALMENT_TONE: Record<InstalmentStatus, StatusTone> = { paid: 'success', overdue: 'danger', due_now: 'warning', upcoming: 'info' };

export { PROVISIONAL_TEXT, REPORTED_FLAG_TEXT as REPORTED_TEXT, basisLine as basisText } from '@/modules/accounts-desk/status';
export const CANCELLATION_TEXT = { open: 'Cancellation open', approved: 'Cancellation approved' } as const;

/** Frozen staff messages (contract 5.4, 7.7) for the preview gallery's refusal states. */
export const DESK_REFUSAL_TEXT = {
  not_authorized: 'You cannot do this here.',
  not_found: 'This item is no longer available. Reload the page.',
  version_changed: 'Someone changed this meanwhile. Reload and try again.',
  invalid_input: 'Check the highlighted field.',
  tally_not_ready: 'This record is not ready for Tally yet: its review is not finished.',
  already_matched: 'This record is already matched in Tally.',
  tally_exception_open: 'This record has an open exception. Clear the exception first.',
  duplicate_tally_invoice: 'This GST invoice reference is already recorded for this financial year.',
  tally_export_off: 'Tally export is not switched on yet.',
  export_too_large: 'More than 10,000 rows. Narrow the dates.',
  nothing_to_export: 'Nothing is ready to export for these dates.',
  duplicate_supplier_document: 'This supplier bill is already recorded (same supplier, number and financial year). Link it to this task instead.',
  link_not_allowed: 'This bill cannot be linked to that task: the supplier is different or the task has no work with this supplier.',
  already_recorded: 'This is already recorded.',
  wrong_state: 'This step is already done. Reload the page.',
} as const;

/** Contract 5.2 frozen text: the Accounts return is blocked after commitment. */
export const REVIEW_RETURN_BLOCKED_TEXT =
  'This booking cannot be returned: a supplier has already confirmed it. To stop or change the trip, ask the branch Manager to start a cancellation.';

/** Form field names the server actions read (track B's ACCOUNTS_DESK_FIELD). */
export { ACCOUNTS_DESK_FIELD as DESK_FIELD } from '@/modules/accounts-desk/contracts';
