/**
 * Accounts desk (Accounts phase 1, Track B): frozen DTO shapes, words and
 * refusal texts for the "Documents and money" workspace, Dues, Tally
 * matching and the CSV evidence export.
 *
 * Contract: implementation/accounts-phase-2026-11-10/contract.md sections
 * 7.1-7.4, 7.7, 8.1-8.3 (frozen 10 Nov 2026). Database:
 * crm/supabase/migrations/20261203000200..0250. Money is whole paise as
 * decimal strings; nothing here is a float.
 */

import type { DuesWriteOff } from '@/modules/write-offs/dto';
import { CONFLICT_STATES } from '@/lib/sqlstate';

export type Paise = string;

// ---------------------------------------------------------------------------
// Workspace kinds, stages and statuses (8.1)
// ---------------------------------------------------------------------------

export const RECORD_KINDS = [
  'receipt',
  'receipt_reversal',
  'claim',
  'cash_deposit',
  'cash_count',
  'supplier_payment',
  'company_funding',
  'supplier_invoice',
  'supplier_credit_note',
  'expense',
  'flight_ticket_batch',
  'visa_application',
  'tally_gst_invoice',
  'original',
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export const RECORD_STAGES = ['open', 'done', 'returned', 'cancelled'] as const;
export type RecordStage = (typeof RECORD_STAGES)[number];

export const REVIEW_STATUSES = ['waiting', 'done', 'returned', 'not_needed'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const TALLY_STATUSES = ['not_ready', 'ready', 'exported', 'matched', 'exception', 'not_applicable'] as const;
export type TallyStatus = (typeof TALLY_STATUSES)[number];

/** record_kind of tally_records and of the Tally commands (T1-T3); phase 2 adds customer documents and supplier refunds (8.2). */
export const TALLY_RECORD_KINDS = [
  'journal_entry',
  'supplier_payment',
  'supplier_document',
  'expense',
  'tally_gst_invoice',
  'customer_document',
  'supplier_refund',
] as const;
export type TallyRecordKind = (typeof TALLY_RECORD_KINDS)[number];

/**
 * Accounts phase 3 (7.2): every record kind tally_records / tally_exports may hold — the CSV kinds above plus
 * 'write_off' (a write-off becomes a Journal in the Tally import file only; the CSV export form keeps the list above).
 */
export const TALLY_ANY_RECORD_KINDS = [...TALLY_RECORD_KINDS, 'write_off'] as const;
export type TallyAnyRecordKind = (typeof TALLY_ANY_RECORD_KINDS)[number];

export const DEPARTMENTS = ['sales', 'accounts', 'purchase', 'flight', 'visa'] as const;
export type RecordDepartment = (typeof DEPARTMENTS)[number];

export const DIRECTIONS = ['in', 'out', 'contra', 'bill', 'credit', 'info'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const LINK_KINDS = [
  'accounts_deal',
  'claim',
  'supplier_payment',
  'supplier_document',
  'expense',
  'flight_deal',
  'visa_task',
  'purchase_task',
  'cash',
  /** Branch Manager: the Deal page dues card (/app/deals/{id}?tab=money#dues; Money tab since UX redesign R2). */
  'deal_dues',
  /** No screen this viewer can open. */
  'none',
] as const;
export type RecordLinkKind = (typeof LINK_KINDS)[number];

export const ORIGINAL_WHATS = ['supplier_invoice', 'airline_bill', 'fee_receipt', 'bank_proof', 'gst_invoice_ref'] as const;
export type OriginalWhat = (typeof ORIGINAL_WHATS)[number];
export type OriginalState = 'expected' | 'missing';
export type OriginalsFilter = OriginalState | 'any';

export type FileLinkKind = 'finance' | 'supplier_money' | 'department';

/** Filter of accounts_records / accounts_records_totals (allowlist; unknown keys are refused). */
export interface RecordsFilter {
  from?: string;
  to?: string;
  kinds?: RecordKind[];
  department?: RecordDepartment;
  dealReference?: string;
  supplierId?: string;
  stage?: RecordStage;
  reviewStatus?: ReviewStatus;
  tallyStatus?: TallyStatus;
  changedSinceExport?: boolean;
  originals?: OriginalsFilter;
  amountMin?: Paise;
  amountMax?: Paise;
  branchId?: string;
  /** Exact reference (R-, SP-, BX-, invoice number, PNR, ticket number, visa reference, GST ref). Ignores other filters except branchId. */
  q?: string;
  /** The rows a daily check count counts (Track B 20261203000300). */
  overdueCheck?: OverdueCheck;
}

export const OVERDUE_CHECKS = ['receipts_unverified', 'payments_unrecorded'] as const;
export type OverdueCheck = (typeof OVERDUE_CHECKS)[number];

/** One workspace row (frozen shape, 8.1). */
export interface RecordRow {
  rowId: string;
  kind: RecordKind;
  recordId: string;
  recordDate: string;
  createdAt: string;
  reference: string | null;
  /** PNRs, ticket ranges "176-2410394501 – 176-2410394508", credit note's invoice number. */
  otherReferences: string[];
  dealId: string | null;
  dealReference: string | null;
  bitrixDealId: string | null;
  branchName: string | null;
  /** Receipts and reversals: the branch that collected the money. */
  collectingBranchName: string | null;
  department: RecordDepartment | null;
  taskId: string | null;
  /** "Hotel 1", "Flight 2", "Visa 1". */
  serviceLabel: string | null;
  supplierId: string | null;
  supplierName: string | null;
  amountPaise: Paise | null;
  direction: Direction;
  /** The record's own status token (receipt status, payment status, ...). */
  statusCode: string | null;
  stage: RecordStage;
  reviewStatus: ReviewStatus;
  tally: {
    status: TallyStatus;
    /** 0 when no tally_records row exists yet (p_expected_row_version of T1-T3). */
    rowVersion: number;
    recordKind: TallyRecordKind | null;
    /** Addition to the frozen shape: the record id the Tally commands take (a receipt's journal entry id). */
    recordId: string | null;
    changedSinceExport: boolean;
    lastExportedAt: string | null;
    exportCount: number;
    /** Accounts only (null for the Manager). */
    voucherRef: string | null;
    voucherDate: string | null;
    exceptionReason: string | null;
  };
  files: { count: number; links: Array<{ kind: FileLinkKind; evidenceId: string; fileName: string }> };
  original: null | {
    what: OriginalWhat;
    state: OriginalState;
    since: string;
    ownerRole: string;
    ownerName: string | null;
  };
  /**
   * A screen this viewer can open (Track B 20261203000300). Accounts: the Accounts Deal page (accounts_deal) or the
   * record's list (claim, supplier_payment, supplier_document, expense, cash) with `ref` to find it; Manager:
   * deal_dues or none. `dealId` is always the row's Deal (null for cash rows).
   */
  link: { kind: RecordLinkKind; id: string | null; dealId?: string | null; ref?: string | null };
  can: { match: boolean; exception: boolean; reopen: boolean; linkTask: boolean };
}

export interface RecordsPage {
  scope: { mode: 'accounts' | 'manager'; readOnly: boolean };
  items: RecordRow[];
  hasMore: boolean;
  nextAfter: string | null;
}

export interface RecordsTotals {
  count: number;
  byKind: Array<{ kind: RecordKind; count: number; inPaise: Paise; outPaise: Paise }>;
}

export interface DailyCheck {
  exceptionOwner: { userId: string | null; name: string | null; isYou: boolean; set: boolean };
  exceptionsOpen: { count: number; oldestAt: string | null };
  changedAfterExport: number;
  originalsMissing: number;
  receiptsAwaitingVerificationOverOneWorkingDay: number;
  paymentsApprovedNotRecordedOverOneWorkingDay: number;
  urgentNoticesUnopenedOverOneWorkingDay: Array<{ branchName: string; count: number }>;
  /**
   * Accounts phase 2 (contract 13, additive; always sent by the database, optional in the type only so older
   * fixtures compile): drafts waiting plus verified payments without an Advance Invoice (documents switched on).
   */
  documentsToRelease?: number;
  /** Released documents whose last PDF job failed. */
  pdfFailed?: number;
  /** Approved payout refunds not paid within one working day. */
  refundPayoutsDueOverOneWorkingDay?: number;
  /** Always 0 under Addendum L1 (supplier refunds are verified when recorded). */
  supplierRefundsToVerify?: number;
  /** Approved cancellations whose expected supplier, airline or Visa-fee refunds are not yet received. */
  supplierRefundsDue?: number;
  /** Accounts phase 3 (6.5, additive): automatic bills held for more than one working day. */
  billsHeldOverOneWorkingDay?: number;
  /** Customer messages failed for more than one working day (null when messages are not installed). */
  customerMessagesFailedOverOneWorkingDay?: number | null;
  /** Entries put into a Tally import file and still not matched after one working day. */
  tallyFileUnmatchedOverOneWorkingDay?: number | null;
  /** Minutes the oldest due customer message has waited (null: none waiting). */
  messageQueueOldestMinutes?: number | null;
  /** Write-off proposals to decide plus approved write-offs that need review. */
  writeOffsToReview?: number;
  /** The workspace filter that lists exactly the rows of each count (link targets for the Daily check card). */
  filters?: {
    exceptionsOpen: RecordsFilter;
    changedAfterExport: RecordsFilter;
    originalsMissing: RecordsFilter;
    receiptsAwaitingVerificationOverOneWorkingDay: RecordsFilter;
    paymentsApprovedNotRecordedOverOneWorkingDay: RecordsFilter;
  };
}

// ---------------------------------------------------------------------------
// Dues (8.3)
// ---------------------------------------------------------------------------

export const DUES_STATUSES = ['overdue', 'due_now', 'upcoming', 'paid', 'credit', 'unallocated', 'no_plan'] as const;
export type DuesStatus = (typeof DUES_STATUSES)[number];
export type InstalmentStatus = 'paid' | 'overdue' | 'due_now' | 'upcoming';
/** Accounts phase 2 (Track C, LD10): 'cancelled' = an approved cancellation settlement (total = customer charge, plan ignored). */
export type DuesBasisKind = 'approved' | 'awaiting_review' | 'cancelled';
export type CancellationFlag = 'open' | 'approved' | null;

export interface DuesFilter {
  status?: DuesStatus[];
  reported?: boolean;
  branchId?: string;
  ownerUserId?: string;
  dealReference?: string;
  nextDueFrom?: string;
  nextDueTo?: string;
}

export interface DuesBasis {
  versionNo: number;
  kind: DuesBasisKind;
  newerVersionPending: boolean;
  /** kind = 'awaiting_review': label "Provisional — booking not yet approved by Accounts" (lead decision AL3). */
  provisional: boolean;
  lastApprovedAt: string | null;
}

export interface DuesRow {
  dealId: string;
  dealReference: string;
  branchName: string | null;
  ownerName: string | null;
  basis: DuesBasis;
  totalPaise: Paise;
  /** Raw customer_advances balance (may be negative in theory; allocation uses max(0, value)). */
  verifiedPaise: Paise;
  balancePaise: Paise;
  overduePaise: Paise;
  dueNowPaise: Paise;
  nextDue: { date: string; openPaise: Paise } | null;
  /** Reported claims — not money. */
  reportedPaise: Paise;
  awaitingVerificationPaise: Paise;
  creditPaise: Paise;
  status: DuesStatus;
  reported: boolean;
  cancellation: CancellationFlag;
}

export interface DuesPage {
  scope: { mode: 'accounts' | 'manager' | 'sales'; readOnly: boolean };
  items: DuesRow[];
  hasMore: boolean;
  nextAfter: string | null;
}

export interface DuesInstalment {
  seq: number;
  label: string;
  dueDate: string;
  amountPaise: Paise;
  coveredPaise: Paise;
  openPaise: Paise;
  status: InstalmentStatus;
  partlyPaid: boolean;
}

export interface SupplierPayableRow {
  supplierId: string;
  supplierName: string;
  requestedLivePaise: Paise;
  paidPaise: Paise;
  verifiedPaise: Paise;
  invoicedAcceptedPaise: Paise;
  creditNotesAcceptedPaise: Paise;
  invoicesUploadedPaise: Paise;
}

export interface DealTallyInvoiceView {
  id: string;
  invoiceRef: string;
  invoiceDate: string;
  status: 'active' | 'withdrawn';
  rowVersion: number;
  tallyStatus: TallyStatus;
}

export interface DealDues extends DuesRow {
  instalments: DuesInstalment[];
  tallyInvoices: DealTallyInvoiceView[];
  /** Accounts and the branch Manager only (null for Sales). Never a difference column (H10). */
  supplierPayables: SupplierPayableRow[] | null;
  /** Addition to 8.3 (addendum B1): Accounts of the entity may add/withdraw GST invoice references. */
  canAddTallyInvoice: boolean;
  /** Addendum B2: who is reading (the Deal money card shows actions and payables by this, never by guessing). */
  viewer: 'accounts' | 'manager' | 'sales';
  /** Accounts phase 2 (Track C, 7.2): live refund request, paid out, kept as customer credit. */
  refunds?: { live: { refNo: string; status: 'requested' | 'returned' | 'approved'; amountPaise: Paise } | null; paidPaise: Paise;
    keptAsCreditPaise: Paise;
    /** Addendum L6: "Customer owes after a reversed payment" (already inside dueNowPaise). */
    shortfallPaise?: Paise };
  /**
   * Accounts phase 3 (track B, contract 6.6): the Deal's active
   * write-off (proposed or approved) and whether an approved one needs review after a later money change.
   */
  writeOff: DuesWriteOff | null;
  writeOffNeedsReview: boolean;
}

/** Addendum B2: tasks a supplier bill may be linked to ("Link to another task"). */
export interface LinkTargetsView {
  documentId: string;
  items: Array<{
    taskId: string;
    dealId: string;
    dealReference: string;
    department: 'purchase' | 'flight';
    serviceLabel: string | null;
    alreadyLinked: boolean;
  }>;
  /** Active links (Accounts only; empty for the task assignee). */
  links: Array<{ linkId: string; taskId: string; dealId: string; dealReference: string; linkedAt: string; linkedByName: string | null }>;
}

/** Addendum B2: what the workspace and dues may be filtered by (ids and names only). */
export interface FilterOptionsView {
  branches: Array<{ branchId: string; name: string }>;
  suppliers: Array<{ supplierId: string; name: string }>;
  owners: Array<{ userId: string; name: string }>;
}

export interface SupplierPayablesView {
  dealId: string;
  dealReference: string;
  suppliers: SupplierPayableRow[];
}

// ---------------------------------------------------------------------------
// Tally export (7.2, 7.4)
// ---------------------------------------------------------------------------

export interface TallyExportHeader {
  exportId: string;
  exportNo: string;
  entityId: string;
  periodFrom: string;
  periodTo: string;
  /** Accounts phase 3: an XML file may hold write-offs. */
  kinds: TallyAnyRecordKind[];
  includeExported: boolean;
  branchNames: string[] | null;
  rowCount: number;
  alreadyExportedCount: number;
  createdAt: string;
  createdByName: string | null;
  fileName: string;
  /** Accounts phase 3 (R-C1, additive; optional in the type only so older fixtures compile). */
  format?: 'csv' | 'xml';
  leftOutCount?: number;
  includeReason?: string | null;
  /** The Tally company frozen with an XML file (null for CSV exports). */
  companyName?: string | null;
}

export interface TallyExportCreated {
  outcome: 'created' | 'existing';
  exportId: string;
  exportNo: string;
  rowCount: number;
  alreadyExportedCount: number;
  skippedCount: number;
}

export interface TallyExportsView {
  entities: Array<{
    entityId: string;
    name: string;
    exportEnabled: boolean;
    branches: Array<{ branchId: string; name: string }>;
    /** Accounts phase 2 (8.1): mapping rows still missing a ledger or voucher type (optional in the type only). */
    mappingMissingCount?: number;
    /** Accounts phase 3 (R-C1): the Tally import file switch (optional in the type only). */
    xmlEnabled?: boolean;
    /** The saved Tally company name (null: not set). */
    companyName?: string | null;
  }>;
  items: TallyExportHeader[];
}

// ---------------------------------------------------------------------------
// Tally ledger mapping (Accounts phase 2, contract 8.1; migration 20261204000400)
// ---------------------------------------------------------------------------

export const TALLY_MAPPING_ROW_KINDS = [
  'receipt_bank',
  'receipt_cash',
  'receipt_reversal',
  'cash_deposit',
  'customer_refund_bank',
  'customer_refund_cash',
  'supplier_payment',
  'supplier_invoice',
  'supplier_credit_note',
  'expense',
  'customer_advance_invoice',
  'customer_invoice',
  'customer_credit_note',
  'supplier_refund',
  'tally_gst_invoice',
  // Accounts phase 3 (20261205000300): write-offs (Journal; ledgers for Accounts to choose).
  'write_off_due',
  'write_off_excess',
] as const;
export type TallyMappingRowKind = (typeof TALLY_MAPPING_ROW_KINDS)[number];

export const TALLY_SERVICE_CLASSES = [
  'any',
  'hotel',
  'transfer',
  'activity',
  'flight_domestic',
  'flight_international',
  'package_domestic',
  'package_overseas',
  'visa',
  'passport',
  'misc',
] as const;
export type TallyServiceClass = (typeof TALLY_SERVICE_CLASSES)[number];

/** Grid words (screen 11). */
export const TALLY_MAPPING_ROW_KIND_WORDS: Record<TallyMappingRowKind, string> = {
  receipt_bank: 'Receipt (bank)',
  receipt_cash: 'Receipt (cash)',
  receipt_reversal: 'Receipt reversal',
  cash_deposit: 'Cash deposit',
  customer_refund_bank: 'Customer refund (bank)',
  customer_refund_cash: 'Customer refund (cash)',
  supplier_payment: 'Supplier payment',
  supplier_invoice: 'Supplier invoice',
  supplier_credit_note: 'Supplier credit note',
  expense: 'Expense',
  customer_advance_invoice: 'Customer advance invoice',
  customer_invoice: 'Customer invoice',
  customer_credit_note: 'Customer credit note',
  supplier_refund: 'Supplier refund',
  tally_gst_invoice: 'GST invoice reference',
  write_off_due: 'Write-off (balance waived)',
  write_off_excess: 'Write-off (excess kept)',
};

/** Service words (the CSV "Service" column uses the same words; 'any' = every service). */
export const TALLY_SERVICE_WORDS: Record<TallyServiceClass, string> = {
  any: 'Any service',
  hotel: 'Hotel',
  transfer: 'Transfer',
  activity: 'Activity',
  flight_domestic: 'Flight (domestic)',
  flight_international: 'Flight (international)',
  package_domestic: 'Package (domestic)',
  package_overseas: 'Package (overseas)',
  visa: 'Visa',
  passport: 'Passport',
  misc: 'Miscellaneous',
};

export interface TallyMappingRow {
  mappingId: string;
  rowKind: TallyMappingRowKind;
  serviceClass: TallyServiceClass;
  debitLedger: string | null;
  creditLedger: string | null;
  voucherType: string | null;
  rowVersion: number;
  updatedAt: string;
  updatedByName: string | null;
}

/** D1 tally_mapping_list (Accounts of the entity; null otherwise). */
export interface TallyMappingView {
  entityId: string;
  rows: TallyMappingRow[];
  missingCount: number;
}

/** Addition (screen 11 history): tally_mapping_history. */
export interface TallyMappingHistoryView {
  mappingId: string;
  items: Array<{
    field: 'debitLedger' | 'creditLedger' | 'voucherType';
    oldValue: string | null;
    newValue: string | null;
    changedAt: string;
    changedByName: string | null;
    reason: string;
  }>;
}

/** D2 tally_mapping_set result. */
export interface TallyMappingSetResult {
  outcome: 'updated' | 'existing';
  mappingId: string;
  rowVersion: number;
  fields: Array<'debitLedger' | 'creditLedger' | 'voucherType'>;
}

/**
 * "Mapping missing" (LD20, same rule as authz.tally_mapping_missing): no voucher type, or neither ledger named (the
 * other side is the party ledger in the Party column).
 */
export function mappingMissing(row: Pick<TallyMappingRow, 'debitLedger' | 'creditLedger' | 'voucherType'>): boolean {
  return row.voucherType === null || (row.debitLedger === null && row.creditLedger === null);
}

/** Ledger / voucher name rule of the database (1..max, no control characters, no leading = + - @, trimmed). */
export function tallyNameOk(value: string, max: number): boolean {
  return value.length >= 1 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) && !/^[=+@-]/.test(value) && value === value.trim();
}

export const TALLY_LEDGER_MAX = 100;
export const TALLY_VOUCHER_MAX = 60;

export interface AdminAccountsSettingsView {
  entityId: string;
  exceptionOwnerUserId: string | null;
  exceptionOwnerName: string | null;
  /** False when the named person is no longer an active Accounts person without Purchase ("not set"). */
  exceptionOwnerActive: boolean;
  tallyExportEnabled: boolean;
  /** Phase 2 / 3 switches (admin_accounts_settings, track B 20261205000200; optional in the type only). */
  customerDocumentsEnabled?: boolean;
  refundsEnabled?: boolean;
  autoBillsEnabled?: boolean;
  /** On by default (owner 17.1); effective only while documents and automatic drafts are on. */
  autoBillReleaseEnabled?: boolean;
  writeOffEnabled?: boolean;
  /** Paise as a decimal string (default "500000" = Rs 5,000). */
  writeOffLimitPaise?: Paise;
  tallyXmlEnabled?: boolean;
  tallyCompanyName?: string | null;
  rowVersion: number;
  updatedAt: string | null;
  candidates: Array<{ userId: string; name: string }>;
}

/** CSV values of one line as stored (masked) — keys in CSV column order below. */
export type CsvLineValues = Record<CsvColumnKey, string | null>;

/** CSV columns in order (7.4): key in tally_export_lines.values, header in English. */
export const CSV_COLUMNS = [
  { key: 'exportNo', header: 'Export no' },
  { key: 'line', header: 'Line' },
  { key: 'recordType', header: 'Record type' },
  { key: 'voucherType', header: 'Voucher type hint' },
  { key: 'date', header: 'Date' },
  { key: 'reference', header: 'Reference' },
  { key: 'deal', header: 'Deal' },
  { key: 'bitrixDealId', header: 'Bitrix Deal id' },
  { key: 'branch', header: 'Branch' },
  { key: 'party', header: 'Party' },
  { key: 'debitLedger', header: 'Debit ledger hint' },
  { key: 'creditLedger', header: 'Credit ledger hint' },
  // Accounts phase 2 (8.2): mapped columns, inserted after "Credit ledger hint" (not part of the source hash, LD19).
  { key: 'service', header: 'Service' },
  { key: 'tallyDebitLedger', header: 'Tally debit ledger' },
  { key: 'tallyCreditLedger', header: 'Tally credit ledger' },
  { key: 'tallyVoucherType', header: 'Tally voucher type' },
  { key: 'mappingMissing', header: 'Mapping missing' },
  { key: 'narration', header: 'Narration' },
  { key: 'tallyNumber', header: 'Tally number' },
  { key: 'amount', header: 'Amount (INR)' },
  { key: 'mode', header: 'Mode' },
  { key: 'bankReference', header: 'Bank reference' },
  { key: 'pan', header: 'PAN' },
  { key: 'mobile', header: 'Mobile' },
  { key: 'gstIncluded', header: 'GST included' },
  { key: 'creditNoteFor', header: 'Credit note for' },
  { key: 'linkedTasks', header: 'Linked tasks' },
  { key: 'alreadyExportedOn', header: 'Already exported on' },
  { key: 'changedSinceLastExport', header: 'Changed since last export' },
  { key: 'crmRecordId', header: 'CRM record id' },
] as const;
export type CsvColumnKey = (typeof CSV_COLUMNS)[number]['key'];

/** Columns added in Accounts phase 2: lines exported before 20261204000410 do not carry them (empty cells). */
export const CSV_PHASE2_KEYS = ['service', 'tallyDebitLedger', 'tallyCreditLedger', 'tallyVoucherType', 'mappingMissing', 'narration', 'tallyNumber'] as const;

/** Record type words of the CSV (Phase 1 plus phase 2, 8.2). */
export const CSV_RECORD_TYPES = [
  'Receipt',
  'Cash deposit',
  'Receipt reversal',
  'Supplier payment',
  'Supplier invoice',
  'Supplier credit note',
  'Expense',
  'GST invoice reference',
  'Customer refund',
  'Customer advance invoice',
  'Customer invoice',
  'Customer credit note',
  'Supplier refund',
] as const;

/** Most rows one export may hold (7.2). */
export const EXPORT_MAX_ROWS = 10_000;
/** Page size the CSV route reads with (T9 maximum). */
export const EXPORT_PAGE_SIZE = 1000;

// ---------------------------------------------------------------------------
// Command results
// ---------------------------------------------------------------------------

export interface TallyCommandResult {
  outcome: 'updated' | 'existing';
  tallyRecordId: string;
  /** 'ready': reopened back to its computed state (Addendum L1). */
  status: 'ready' | 'exported' | 'matched' | 'exception';
  rowVersion: number;
}

export interface TallyInvoiceResult {
  outcome: 'created' | 'updated' | 'existing';
  id: string;
  tallyRecordId?: string;
  status?: 'active' | 'withdrawn';
  rowVersion: number;
}

export type AccountsDeskActionResult<T> =
  | { ok: true; data: T; message: string }
  | {
      ok: false;
      code: AccountsDeskErrorCode | 'session';
      message: string;
      /** The refused field (invalid_input hint), when the database named it. */
      field?: string;
      /** What the person typed, returned so a refused form can show it again. */
      values?: Record<string, string>;
    };

// ---------------------------------------------------------------------------
// Refusal tokens (7.7) and frozen messages
// ---------------------------------------------------------------------------

export type AccountsDeskErrorCode =
  | 'not_authorized'
  | 'not_found'
  | 'version_changed'
  | 'invalid_input'
  | 'tally_not_ready'
  | 'already_matched'
  | 'tally_exception_open'
  | 'duplicate_tally_invoice'
  | 'tally_export_off'
  | 'export_too_large'
  | 'nothing_to_export'
  | 'duplicate_supplier_document'
  | 'link_not_allowed'
  | 'already_recorded'
  | 'wrong_state'
  | 'request_conflict'
  | 'duplicate_request'
  | 'environment_unset'
  | 'not_configured'
  // Accounts phase 3 (track C, section 13)
  | 'tally_xml_off';

export const ACCOUNTS_DESK_ERROR_STATES: Record<AccountsDeskErrorCode, string | readonly string[]> = {
  not_authorized: '42501',
  not_found: 'P0002',
  version_changed: CONFLICT_STATES,
  invalid_input: '22023',
  tally_not_ready: '55000',
  already_matched: '55000',
  tally_exception_open: '55000',
  duplicate_tally_invoice: '23505',
  tally_export_off: '55000',
  export_too_large: '22023',
  nothing_to_export: '55000',
  duplicate_supplier_document: '23505',
  link_not_allowed: '55000',
  already_recorded: '55000',
  wrong_state: '55000',
  request_conflict: CONFLICT_STATES,
  duplicate_request: CONFLICT_STATES,
  environment_unset: '55000',
  not_configured: '55000',
  tally_xml_off: '55000',
};

export const ACCOUNTS_DESK_ERROR_TEXT: Record<AccountsDeskErrorCode | 'session', string> = {
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
  duplicate_supplier_document:
    'This supplier bill is already recorded (same supplier, number and financial year). Link it to this task instead.',
  link_not_allowed:
    'This bill cannot be linked to that task: the supplier is different or the task has no work with this supplier.',
  already_recorded: 'This is already recorded.',
  wrong_state: 'This step is already done. Reload the page.',
  request_conflict: 'This was already sent with different details. Reload the page and try again.',
  duplicate_request: 'This was already sent with different details. Reload the page and try again.',
  environment_unset: 'This CRM environment is not set up yet. Ask an admin.',
  not_configured: 'Accounts work is not switched on for this company yet. Ask an admin.',
  tally_xml_off: 'The Tally file is not switched on yet.',
  session: 'You were signed out. Sign in again; what you typed is still on this page.',
};

/** Reopen refused because the record was never exported (hint neverExported). */
/** Reopen refused (hint notReopenable): only an exception or a matched record can be reopened. */
export const REOPEN_NEVER_EXPORTED_TEXT = 'Only a matched record or an open exception can be reopened. Reload the page.';

export const ACCOUNTS_DESK_UNKNOWN_OUTCOME_TEXT =
  'We could not confirm this was saved. Reload the page to check before you try again. Your typed details are still here.';

export const ACCOUNTS_DESK_DONE_TEXT = {
  matched: 'Marked matched in Tally.',
  exceptionRaised: 'Exception raised. The exception owner is told.',
  reopened: 'Reopened.',
  invoiceAdded: 'GST invoice reference added.',
  invoiceWithdrawn: 'GST invoice reference withdrawn.',
  exportCreated: 'Export ready. Download the CSV.',
  linked: 'Bill linked to the task.',
  unlinked: 'Link removed.',
  creditLinked: 'Credit note linked to its invoice.',
  ownerSet: 'Exception owner saved.',
  ownerCleared: 'Exception owner cleared.',
  exportSwitched: 'Tally export setting saved.',
  mappingSaved: 'Tally mapping saved. The next export uses it.',
  existing: 'This was already done. Nothing changed.',
} as const;

// ---------------------------------------------------------------------------
// Form field names (server actions read exactly these)
// ---------------------------------------------------------------------------

export const ACCOUNTS_DESK_FIELD = {
  requestId: 'requestId',
  kind: 'kind',
  recordId: 'recordId',
  expectedRowVersion: 'expectedRowVersion',
  voucherRef: 'voucherRef',
  voucherDate: 'voucherDate',
  reason: 'reason',
  tallyAmountRupees: 'tallyAmountRupees',
  dealId: 'dealId',
  invoiceRef: 'invoiceRef',
  invoiceDate: 'invoiceDate',
  note: 'note',
  invoiceId: 'invoiceId',
  documentId: 'documentId',
  taskId: 'taskId',
  linkId: 'linkId',
  entityId: 'entityId',
  from: 'from',
  to: 'to',
  kinds: 'kinds',
  includeExported: 'includeExported',
  branchIds: 'branchIds',
  userId: 'userId',
  enabled: 'enabled',
  // Accounts phase 2 (8.1, Addendum L3)
  mappingId: 'mappingId',
  debitLedger: 'debitLedger',
  creditLedger: 'creditLedger',
  voucherType: 'voucherType',
} as const;

/** Server action names exported by server/actions.ts. */
export const ACCOUNTS_DESK_ACTIONS = [
  'matchTallyRecordAction',
  'raiseTallyExceptionAction',
  'reopenTallyRecordAction',
  'addTallyInvoiceAction',
  'withdrawTallyInvoiceAction',
  'createTallyExportAction',
  'linkSupplierDocumentAction',
  'unlinkSupplierDocumentAction',
  'setCreditNoteLinkAction',
  'setExceptionOwnerAction',
  'setTallyExportEnabledAction',
  'showRecordsTotalsAction',
  'setTallyMappingAction',
] as const;

/** Read helpers exported by server/queries.ts. */
export const ACCOUNTS_DESK_QUERIES = [
  'loadRecords',
  'loadRecordsTotals',
  'loadDailyCheck',
  'loadDues',
  'loadDealDues',
  'loadSupplierPayables',
  'loadTallyExports',
  'loadAdminAccountsSettings',
  'loadLinkTargets',
  'loadFilterOptions',
  'loadTallyMapping',
  'loadTallyMappingHistory',
] as const;

/** CSV download route (GET, Accounts only): /app/accounts/tally/exports/[exportId]/csv */
export function tallyExportCsvHref(exportId: string): string {
  return `/app/accounts/tally/exports/${encodeURIComponent(exportId)}/csv`;
}

/** Pages revalidated after every Accounts desk command. */
export const ACCOUNTS_DESK_PATHS = ['/app/accounts/records', '/app/accounts/dues', '/app/accounts/tally'] as const;

// ---------------------------------------------------------------------------
// Accounts phase 3, track C: Tally import file and matching upload
// (contract 7, 13, 14; migrations 20261205000300..0320). Accounts only.
// ---------------------------------------------------------------------------

/** Kinds the Tally file form offers (7.1). The database also accepts 'expense' (always left out as kind_not_in_file). */
export const TALLY_FILE_KINDS = ['journal_entry', 'supplier_payment', 'supplier_refund', 'write_off'] as const;
export type TallyFileKind = (typeof TALLY_FILE_KINDS)[number];
/** Every kind a left-out row or a file header can name. */
export type TallyAnyKind = TallyAnyRecordKind;

export const LEFT_OUT_REASONS = ['ledger_not_mapped', 'party_not_mapped', 'voucher_type_missing', 'already_in_file', 'kind_not_in_file',
  'changed_since_file'] as const;
export type LeftOutReason = (typeof LEFT_OUT_REASONS)[number];

export const MATCH_OUTCOMES = ['matched', 'amount_differs', 'not_found', 'already_matched', 'duplicate_in_file', 'no_tag'] as const;
export type MatchOutcome = (typeof MATCH_OUTCOMES)[number];

/** One voucher that would go into the file (R-C2 preview). */
export interface TallyFileLine {
  recordKind: TallyAnyKind;
  recordId: string;
  /** The CRM reference (R-…, SP-…, RF-…, WO-…, supplier refund reference; a deposit's bank reference). */
  reference: string | null;
  dealReference: string | null;
  voucherType: string;
  date: string;
  amountPaise: Paise;
}

/** One record left out, with the reason (R-C2 preview, R-C3 list). */
export interface TallyLeftOutRow {
  recordKind: TallyAnyKind;
  recordId: string;
  reference: string | null;
  reason: LeftOutReason;
  /** The missing mapping row ("receipt_bank (any): debit ledger"), "customer party" / "supplier", the earlier file number or the record type. */
  detail: string | null;
}

/** R-C2 accounts_tally_file_preview (first 200 lines / left-out rows; counts are complete). */
export interface TallyFilePreview {
  lines: TallyFileLine[];
  leftOut: TallyLeftOutRow[];
  counts: { lines: number; leftOut: number; byReason: Partial<Record<LeftOutReason, number>> };
  truncated: boolean;
  /** The Tally company the file would be made for (the saved setting; null when not set). Always sent; optional in the type only. */
  companyName?: string | null;
}

/** C3 result. */
export interface TallyFileCreated {
  outcome: 'created' | 'existing';
  exportId: string;
  exportNo: string;
  lines: number;
  leftOut: number;
}

/** R-C1 row of an XML file (the file list item with the Phase 3 keys). */
export interface TallyFileHeader {
  exportId: string;
  exportNo: string;
  format: 'csv' | 'xml';
  periodFrom: string;
  periodTo: string;
  kinds: TallyAnyKind[];
  rowCount: number;
  leftOutCount: number;
  includeReason: string | null;
  /** The Tally company frozen with the file (null for CSV exports). Always sent; optional in the type only. */
  companyName?: string | null;
  createdAt: string;
  createdByName: string | null;
}

/** R-C3 page. */
export interface TallyLeftOutPage {
  exportId: string;
  exportNo: string;
  items: TallyLeftOutRow[];
  nextAfter: string | null;
  hasMore: boolean;
}

export type MatchBatchStatus = 'staged' | 'applied' | 'cancelled';

/** C4 result and the header of R-C4. */
export interface TallyMatchBatch {
  batchId: string;
  fileName: string;
  status: MatchBatchStatus;
  rowCount: number;
  summary: Record<MatchOutcome, number>;
  proposalHash: string;
  stagedAt: string;
  stagedByName: string | null;
  appliedAt: string | null;
}

/** R-C4 row. */
export interface TallyMatchRow {
  rowNo: number;
  tnTag: string | null;
  voucherRef: string;
  voucherDate: string;
  voucherType: string | null;
  amountPaise: Paise;
  outcome: MatchOutcome;
  crmAmountPaise: Paise | null;
  crmReference: string | null;
}

/** R-C4. */
export interface TallyMatchPage {
  batch: TallyMatchBatch;
  outcome: MatchOutcome | null;
  rows: TallyMatchRow[];
  nextAfter: string | null;
  hasMore: boolean;
}

/** C5 result. */
export interface TallyMatchApplied {
  outcome: 'updated' | 'existing';
  batchId: string;
  status: 'applied';
  matched: number;
  exceptions: number;
}

/** The Tally party name of a customer party (C1 result, and the read for the customer page). */
export interface TallyPartyName {
  partyId: string;
  name: string | null;
  rowVersion: number;
}

/** C2 result. */
export interface TallyXmlSettingResult {
  changed: boolean;
  tallyXmlEnabled: boolean;
  tallyCompanyName: string | null;
  rowVersion: number;
  updatedAt: string;
}

/** Refusal codes a Tally file action can return: the Accounts desk tokens (incl. tally_xml_off) plus a refused upload. */
export type TallyFileErrorCode = AccountsDeskErrorCode | 'file_refused';

/** Frozen messages (section 13); the shared tokens keep the Accounts desk wording except where the file needs its own. */
export const TALLY_FILE_ERROR_TEXT: Record<'tally_xml_off' | 'nothing_to_export' | 'already_recorded' | 'file_refused' | 'include_reason', string> = {
  tally_xml_off: 'The Tally file is not switched on yet.',
  nothing_to_export: 'Nothing can go into the file. See the left-out list for the reasons.',
  already_recorded: 'This file was already uploaded. Open the earlier upload from the Tally page.',
  file_refused: 'This is not a Tally Day Book we can read. Export the Day Book from TallyPrime as XML, at most 4 MB and 5,000 vouchers (export a shorter period if it is larger), and try again.',
  include_reason: 'Say why the entries go in again (10 to 500 characters).',
};

export const TALLY_FILE_DONE_TEXT = {
  fileCreated: 'Tally file made. Download the XML and import it in TallyPrime.',
  staged: 'Checked. Review what will be matched, then apply.',
  applied: 'Matching applied.',
  cancelled: 'Upload cancelled. Nothing changed.',
  partyNamed: 'Tally party name saved.',
  xmlSwitched: 'Tally file setting saved.',
  existing: 'This was already done. Nothing changed.',
} as const;

/** Form field names the Tally file actions read (Addendum L3 shape). */
export const TF_FIELD = {
  entityId: 'entityId',
  from: 'from',
  to: 'to',
  kinds: 'kinds',
  branchIds: 'branchIds',
  includeAgain: 'includeAgain',
  includeReason: 'includeReason',
  file: 'file',
  batchId: 'batchId',
  proposalHash: 'expectedProposalHash',
  partyId: 'partyId',
  expectedRowVersion: 'expectedRowVersion',
  name: 'name',
  enabled: 'enabled',
  companyName: 'companyName',
  reason: 'reason',
  requestId: 'requestId',
} as const;

/** Server actions exported by server/tally-file-actions.ts. */
export const TALLY_FILE_ACTIONS = [
  'previewTallyFileAction',
  'createTallyFileAction',
  'stageTallyMatchAction',
  'applyTallyMatchAction',
  'cancelTallyMatchAction',
  'setPartyTallyNameAction',
  'setTallyXmlAction',
] as const;

/** Read helpers exported by server/tally-file-queries.ts. */
export const TALLY_FILE_QUERIES = ['loadTallyFilePreview', 'loadTallyLeftOut', 'loadTallyMatch', 'loadPartyTallyName'] as const;

/** XML download route (GET, Accounts only): /app/accounts/tally/exports/[exportId]/xml */
export function tallyXmlHref(exportId: string): string {
  return `/app/accounts/tally/exports/${encodeURIComponent(exportId)}/xml`;
}
