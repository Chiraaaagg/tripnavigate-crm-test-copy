import { mappingMissing } from '@/modules/accounts-desk/contracts';
import type { NoticeInbox } from '@/views/notices/types';
import type { TallyMappingChange, TallyMappingList, TallyMappingRow, TallyServiceClass } from '@/views/tally-mapping/types';
import { INBOX, INBOX_ACCOUNTS } from './acc-fixtures';

/*
 * Synthetic fixtures for the Accounts phase 2 settings states (acc2-settings-):
 * the Tally mapping pre-filled as contract 8.1 says (names from
 * tally-structure.md only; bank, cash, customer advance, purchase and expense
 * ledgers blank), the Accounts settings switches and the bell pop-up states.
 */

export const ENTITY_ID = 'a0000001-0000-4000-8000-000000000001';
const at = '2026-11-11T10:30:00Z';
let n = 0;
function row(rowKind: TallyMappingRow['rowKind'], serviceClass: TallyServiceClass, debitLedger: string | null, creditLedger: string | null, voucherType: string | null, over: Partial<TallyMappingRow> = {}): TallyMappingRow {
  n += 1;
  return {
    mappingId: `a0007${String(n).padStart(3, '0')}-0000-4000-8000-000000007${String(n).padStart(3, '0')}`,
    rowKind,
    serviceClass,
    debitLedger,
    creditLedger,
    voucherType,
    rowVersion: 1,
    updatedAt: at,
    updatedByName: null,
    ...over,
  };
}

const INVOICE_NAMES: Array<[TallyServiceClass, string, string, string]> = [
  ['hotel', 'Hotel Booking', 'Hotel Invoice', 'Hotel Cn'],
  ['flight_domestic', 'Domestic Air Ticket', 'Domestic Tkt', 'Domestic CN'],
  ['flight_international', 'International Air Ticket', 'International Tkt', 'Int. Cn'],
  ['package_domestic', 'Domestic Package', 'Package Invoice', 'Package Cn'],
  ['package_overseas', 'Overseas Package', 'Package Invoice', 'Package Cn'],
  ['visa', 'Visa', 'Visa Inv', 'VisaCn'],
  ['passport', 'Passport', 'Passport Inv', 'Miscellaneous CN'],
  ['transfer', 'Transport', 'Transport Inv', 'Miscellaneous CN'],
  ['activity', 'Excursion', 'Misc Inv', 'Miscellaneous CN'],
  ['misc', 'Miscellaneous', 'Misc Inv', 'Miscellaneous CN'],
];

export const MAPPING_ROWS: TallyMappingRow[] = [
  row('receipt_bank', 'any', 'HDFC Current Account (synthetic)', null, 'Receipt', { rowVersion: 2, updatedAt: '2026-11-12T06:15:00Z', updatedByName: 'Synthetic Accounts 1' }),
  row('receipt_cash', 'any', null, null, 'Receipt'),
  row('receipt_reversal', 'any', null, null, 'Journal'),
  row('cash_deposit', 'any', null, null, 'Contra'),
  row('supplier_refund', 'any', null, null, 'Receipt'),
  row('customer_refund_bank', 'any', null, null, 'Payment'),
  row('customer_refund_cash', 'any', null, null, 'Payment'),
  row('supplier_payment', 'any', null, null, 'Payment'),
  row('expense', 'any', null, null, 'Payment'),
  row('customer_advance_invoice', 'any', null, null, 'Receipt'),
  ...INVOICE_NAMES.map(([s, ledger, voucher]) => row('customer_invoice', s, 'Sundry Debtors (synthetic)', ledger, voucher, { updatedByName: 'Synthetic Accounts 1', rowVersion: 2 })),
  ...INVOICE_NAMES.map(([s, ledger, , cn]) => row('customer_credit_note', s, ledger, null, cn)),
  row('supplier_invoice', 'any', null, null, 'Purchase'),
  row('supplier_credit_note', 'any', null, null, 'Debit Note M'),
];

export const MAPPING_LIST: TallyMappingList = { entityId: ENTITY_ID, rows: MAPPING_ROWS, missingCount: MAPPING_ROWS.filter(mappingMissing).length };
export const MAPPING_COMPLETE: TallyMappingList = {
  entityId: ENTITY_ID,
  rows: MAPPING_ROWS.map((r) => ({ ...r, debitLedger: r.debitLedger ?? 'Synthetic Ledger A', creditLedger: r.creditLedger ?? 'Synthetic Ledger B' })),
  missingCount: 0,
};

export const MAPPING_HISTORY: TallyMappingChange[] = [
  
  { changedAt: '2026-11-12T06:15:00Z', changedByName: 'Synthetic Accounts 1', field: 'debitLedger', oldValue: null, newValue: 'HDFC Current Account (synthetic)', reason: 'Bank ledger name copied from the synthetic Tally sample.' },
  { changedAt: '2026-11-11T10:30:00Z', changedByName: null, field: 'voucherType', oldValue: null, newValue: 'Receipt', reason: 'Filled from the Tally structure notes when the mapping was installed.' },
];

/** Inboxes with sound on (the Phase 2 default) and pop-up state. */
export const INBOX_SOUND_ON: NoticeInbox = { ...INBOX, soundOn: true };
export const INBOX_ACCOUNTS_ALL_OFF: NoticeInbox = { ...INBOX_ACCOUNTS, soundOn: false };
