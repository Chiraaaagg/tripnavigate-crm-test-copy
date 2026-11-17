import { mappingMissing } from '@/modules/accounts-desk/contracts';
import type { TallyMappingRow, TallyMappingRowKind, TallyServiceClass } from './types';

/*
 * Words for the Tally mapping screen (contract 8.1, 11.11). Row kinds are
 * grouped the way Accounts read their Tally day book: money in, money out,
 * customer documents, supplier documents.
 */

export const ROW_KIND_LABEL: Record<TallyMappingRowKind, string> = {
  receipt_bank: 'Customer receipt (bank)',
  receipt_cash: 'Customer receipt (cash)',
  receipt_reversal: 'Receipt reversal',
  cash_deposit: 'Cash deposit to bank',
  customer_refund_bank: 'Customer refund (bank)',
  customer_refund_cash: 'Customer refund (cash)',
  supplier_payment: 'Supplier payment',
  supplier_invoice: 'Supplier invoice',
  supplier_credit_note: 'Supplier credit note',
  expense: 'Company-paid expense',
  customer_advance_invoice: 'Customer advance invoice',
  customer_invoice: 'Customer invoice',
  customer_credit_note: 'Customer credit note',
  supplier_refund: 'Supplier refund received',
  tally_gst_invoice: 'Tally GST invoice reference',
  write_off_due: 'Write-off (balance waived)',
  write_off_excess: 'Write-off (excess kept)',
};

export const SERVICE_LABEL: Record<TallyServiceClass, string> = {
  any: 'All services',
  hotel: 'Hotel',
  transfer: 'Transfer',
  activity: 'Activity',
  flight_domestic: 'Domestic flight',
  flight_international: 'International flight',
  package_domestic: 'Domestic package',
  package_overseas: 'Overseas package',
  visa: 'Visa',
  passport: 'Passport',
  misc: 'Miscellaneous',
};

export const ROW_KIND_GROUPS: Array<{ title: string; kinds: TallyMappingRowKind[] }> = [
  { title: 'Money in', kinds: ['receipt_bank', 'receipt_cash', 'receipt_reversal', 'cash_deposit', 'supplier_refund'] },
  { title: 'Money out', kinds: ['customer_refund_bank', 'customer_refund_cash', 'supplier_payment', 'expense'] },
  { title: 'Customer documents', kinds: ['customer_advance_invoice', 'customer_invoice', 'customer_credit_note', 'tally_gst_invoice'] },
  { title: 'Supplier documents', kinds: ['supplier_invoice', 'supplier_credit_note'] },
];

export const FIELD_LABEL: Record<string, string> = { debitLedger: 'Debit ledger', creditLedger: 'Credit ledger', voucherType: 'Voucher type' };

/** Same rule as the database and the CSV "Mapping missing" column (track D, LD20). */
export function rowMissing(r: Pick<TallyMappingRow, 'debitLedger' | 'creditLedger' | 'voucherType'>): boolean {
  return mappingMissing(r);
}

/** The plain line under a row's title: what Tally gets today. */
export function mappingLine(r: TallyMappingRow): string {
  return `${ROW_KIND_LABEL[r.rowKind]} · ${SERVICE_LABEL[r.serviceClass]}`;
}
