import type { StatusTone } from '@/components/ui/badge';
import type { PayoutMode, RefundKind, RefundOutcome, RefundStatus, SupplierRefundMode, SupplierRefundSource } from './types';
import { maxPaiseForDigits, rupeesToPaise as readRupees } from '@/lib/money';

/*
 * Words for the refund screens (contract 7, screens 11.3–11.5). Every status
 * is an icon plus these words, never colour alone. Plain constants: safe in
 * client components.
 */

export const REFUND_KIND_WORD: Record<RefundKind, string> = {
  cancellation: 'Trip cancellation',
  overpayment: 'Paid too much',
};

export const OUTCOME_WORD: Record<RefundOutcome, string> = {
  payout: 'Pay the money back',
  keep_credit: 'Keep as customer credit',
  charge_only: 'Charge only, nothing to pay back',
};

export const OUTCOME_HINT: Record<RefundOutcome, string> = {
  payout: 'Accounts pay the amount back after the Manager approves.',
  keep_credit: 'The money stays with us as credit for this customer. No expiry.',
  charge_only: 'Settles the cancellation charge. The customer may still owe the difference.',
};

export const STATUS_WORD: Record<RefundStatus, string> = {
  requested: 'Waiting for the Manager',
  returned: 'Returned to the requester',
  approved: 'Approved',
  paid: 'Paid out and verified',
  withdrawn: 'Withdrawn',
};

export const STATUS_TONE: Record<RefundStatus, StatusTone> = {
  requested: 'info',
  returned: 'warning',
  approved: 'brand',
  paid: 'success',
  withdrawn: 'neutral',
};

/** Status word for an approved request that needs no payout. */
export function statusWord(status: RefundStatus, outcome: RefundOutcome): string {
  if (status === 'approved' && outcome === 'payout') return 'Approved — waiting for payout';
  if (status === 'approved' && outcome === 'keep_credit') return 'Approved — kept as credit';
  if (status === 'approved' && outcome === 'charge_only') return 'Approved — charge settled';
  return STATUS_WORD[status];
}

export const PAYOUT_MODE_WORD: Record<PayoutMode, string> = {
  bank_transfer: 'Bank transfer',
  upi: 'UPI',
  cash: 'Cash',
  cheque: 'Cheque',
};

export const SUPPLIER_REFUND_MODE_WORD: Record<SupplierRefundMode, string> = {
  bank_transfer: 'Bank transfer',
  upi: 'UPI',
  cheque: 'Cheque',
  card_reversal: 'Card reversal',
  other: 'Other',
};

export const SOURCE_WORD: Record<SupplierRefundSource, string> = {
  purchase_charge: 'Hotel or service supplier',
  flight_charge: 'Airline ticket batch',
  visa_fee: 'Visa fee',
  // Accounts phase 3 (contract 10.4 step 4): the supplier's new, lower rate after a change.
  reconfirmation: 'Lower rate after a booking change',
};

const REFUND_MAX_PAISE = maxPaiseForDigits(15);

/** "1,234.56" typed by staff → paise, or null (empty, "₹" sign, more than 2 decimals, negative, not a number; src/lib/money.ts). */
export function rupeesToPaise(raw: string): bigint | null {
  const paise = readRupees(raw, { max: REFUND_MAX_PAISE });
  return typeof paise === 'string' ? BigInt(paise) : null;
}

/** Paise string → plain rupees for a form's default value ("1500.50"). */
export function paiseToRupeesText(paise: string): string {
  const n = BigInt(paise);
  const r = n / 100n;
  const p = n % 100n;
  return p === 0n ? r.toString() : `${r}.${p.toString().padStart(2, '0')}`;
}

/** Indian digit grouping (12,34,567) on a non-negative integer string. */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  return `${digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${digits.slice(-3)}`;
}

/** Paise (bigint or decimal string) → "₹1,23,456.78". Pure BigInt, no float; safe in client components. */
export function rupees(paise: bigint | string): string {
  const v = BigInt(paise);
  const neg = v < 0n;
  const a = neg ? -v : v;
  return `${neg ? '-' : ''}₹${groupIndian((a / 100n).toString())}.${(a % 100n).toString().padStart(2, '0')}`;
}

const SHORT_DAY = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-11-12" → "12 Nov 2026" (calendar date, no time zone shift). */
export function shortDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[3])} ${SHORT_DAY[Number(m[2]) - 1] ?? m[2]} ${m[1]}` : iso;
}
