import { z } from 'zod';
import type { RpcClient, RpcError } from '@/modules/fulfilment/commands';
import { DuesWriteOffSchema } from '@/modules/write-offs/dto';
import {
  ACCOUNTS_DESK_ERROR_STATES,
  type AccountsDeskErrorCode,
  CSV_COLUMNS,
  CSV_PHASE2_KEYS,
  DEPARTMENTS,
  DIRECTIONS,
  DUES_STATUSES,
  type DuesFilter,
  LINK_KINDS,
  ORIGINAL_WHATS,
  RECORD_KINDS,
  RECORD_STAGES,
  type RecordsFilter,
  REVIEW_STATUSES,
  TALLY_ANY_RECORD_KINDS,
  TALLY_MAPPING_ROW_KINDS,
  TALLY_RECORD_KINDS,
  TALLY_SERVICE_CLASSES,
  TALLY_STATUSES,
  type TallyMappingHistoryView,
  type TallyMappingSetResult,
  type TallyMappingView,
  type TallyRecordKind,
} from './contracts';
import { stateMatches } from '@/lib/sqlstate';

/**
 * Typed wrappers for the Accounts desk reads and commands (migrations
 * 20261203000200..0250). Every call runs under the staff member's OWN
 * session; the database authorizes and audits. Responses are zod-validated
 * with every key listed (unknown keys are stripped); anything unexpected
 * throws AccountsDeskCommandError with code null (fail closed). Database
 * messages never reach the browser: errors map by SQLSTATE + exact token.
 */

const SESSION_STATES = new Set(['PGRST301', 'PGRST302', 'PGRST303', '401']);
const INPUT_STATES = new Set(['22023', '22P02', '22001', '22003', '22007', '22008', '23514', '23502']);

export class AccountsDeskCommandError extends Error {
  override name = 'AccountsDeskCommandError';
  constructor(
    readonly command: string,
    readonly code: AccountsDeskErrorCode | 'session' | null,
    readonly sqlState: string | null,
    /** The database hint: the refused field for invalid_input, 'neverExported' for a refused reopen. */
    readonly hint: string | null = null,
  ) {
    super(`${command} failed${sqlState ? ` (${sqlState})` : ''}${code ? `: ${code}` : ''}`);
  }
}

export function mapAccountsDeskError(error: RpcError): AccountsDeskErrorCode | 'session' | null {
  const state = error.code ?? '';
  const token = (error.message ?? '').trim();
  if (Object.hasOwn(ACCOUNTS_DESK_ERROR_STATES, token) && stateMatches(ACCOUNTS_DESK_ERROR_STATES[token as AccountsDeskErrorCode], state)) {
    return token as AccountsDeskErrorCode;
  }
  if (SESSION_STATES.has(state)) return 'session';
  if (state === '42501') return 'not_authorized';
  if (state === 'P0002') return 'not_found';
  if (INPUT_STATES.has(state)) return 'invalid_input';
  return null;
}

async function invoke(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  let result: { data: unknown; error: RpcError | null };
  try {
    result = await client.rpc(fn, args);
  } catch {
    throw new AccountsDeskCommandError(fn, null, null);
  }
  if (result.error) {
    throw new AccountsDeskCommandError(fn, mapAccountsDeskError(result.error), result.error.code ?? null, result.error.hint ?? null);
  }
  return result.data;
}

function parse<T>(fn: string, schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new AccountsDeskCommandError(fn, null, null);
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Schemas (every key listed)
// ---------------------------------------------------------------------------

const paise = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
const signedPaise = z.string().regex(/^-?(0|[1-9][0-9]{0,17})$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestamp = z.string().min(1).refine((v) => !Number.isNaN(Date.parse(v)));
const text = z.string().nullable();

export const RecordRowSchema = z.object({
  rowId: z.string().min(3),
  kind: z.enum(RECORD_KINDS),
  recordId: z.uuid(),
  recordDate: isoDate,
  createdAt: timestamp,
  reference: text,
  otherReferences: z.array(z.string()),
  dealId: z.uuid().nullable(),
  dealReference: text,
  bitrixDealId: text,
  branchName: text,
  collectingBranchName: text,
  department: z.enum(DEPARTMENTS).nullable(),
  taskId: z.uuid().nullable(),
  serviceLabel: text,
  supplierId: z.uuid().nullable(),
  supplierName: text,
  amountPaise: paise.nullable(),
  direction: z.enum(DIRECTIONS),
  statusCode: text,
  stage: z.enum(RECORD_STAGES),
  reviewStatus: z.enum(REVIEW_STATUSES),
  tally: z.object({
    status: z.enum(TALLY_STATUSES),
    rowVersion: z.number().int().nonnegative(),
    recordKind: z.enum(TALLY_RECORD_KINDS).nullable(),
    recordId: z.uuid().nullable(),
    changedSinceExport: z.boolean(),
    lastExportedAt: timestamp.nullable(),
    exportCount: z.number().int().nonnegative(),
    voucherRef: text,
    voucherDate: isoDate.nullable(),
    exceptionReason: text,
  }),
  files: z.object({
    count: z.number().int().nonnegative(),
    links: z.array(z.object({ kind: z.enum(['finance', 'supplier_money', 'department']), evidenceId: z.uuid(), fileName: z.string() })),
  }),
  original: z
    .object({
      what: z.enum(ORIGINAL_WHATS),
      state: z.enum(['expected', 'missing']),
      since: isoDate,
      ownerRole: z.string(),
      ownerName: text,
    })
    .nullable(),
  link: z.object({ kind: z.enum(LINK_KINDS), id: z.uuid().nullable(), dealId: z.uuid().nullable(), ref: text }),
  can: z.object({ match: z.boolean(), exception: z.boolean(), reopen: z.boolean(), linkTask: z.boolean() }),
});
export type RecordRowRecord = z.output<typeof RecordRowSchema>;

export const RecordsPageSchema = z.object({
  scope: z.object({ mode: z.enum(['accounts', 'manager']), readOnly: z.boolean() }),
  items: z.array(RecordRowSchema),
  hasMore: z.boolean(),
  nextAfter: z.string().nullable(),
});
export type RecordsPageRecord = z.output<typeof RecordsPageSchema>;

export const RecordsTotalsSchema = z.object({
  count: z.number().int().nonnegative(),
  byKind: z.array(z.object({ kind: z.enum(RECORD_KINDS), count: z.number().int().nonnegative(), inPaise: paise, outPaise: paise })),
});

export const DailyCheckSchema = z.object({
  exceptionOwner: z.object({ userId: z.uuid().nullable(), name: text, isYou: z.boolean(), set: z.boolean() }),
  exceptionsOpen: z.object({ count: z.number().int().nonnegative(), oldestAt: timestamp.nullable() }),
  changedAfterExport: z.number().int().nonnegative(),
  originalsMissing: z.number().int().nonnegative(),
  receiptsAwaitingVerificationOverOneWorkingDay: z.number().int().nonnegative(),
  paymentsApprovedNotRecordedOverOneWorkingDay: z.number().int().nonnegative(),
  urgentNoticesUnopenedOverOneWorkingDay: z.array(z.object({ branchName: z.string(), count: z.number().int().nonnegative() })),
  // Accounts phase 2 (contract 13, additive)
  documentsToRelease: z.number().int().nonnegative(),
  pdfFailed: z.number().int().nonnegative(),
  refundPayoutsDueOverOneWorkingDay: z.number().int().nonnegative(),
  supplierRefundsToVerify: z.number().int().nonnegative(),
  supplierRefundsDue: z.number().int().nonnegative(),
  // Accounts phase 3 (track B 20261205000230, contract 6.5, additive; optional so older fixtures parse).
  billsHeldOverOneWorkingDay: z.number().int().nonnegative().optional().default(0),
  customerMessagesFailedOverOneWorkingDay: z.number().int().nonnegative().nullable().optional().default(null),
  tallyFileUnmatchedOverOneWorkingDay: z.number().int().nonnegative().nullable().optional().default(null),
  messageQueueOldestMinutes: z.number().int().nullable().optional().default(null),
  writeOffsToReview: z.number().int().nonnegative().optional().default(0),
  filters: z.object({
    exceptionsOpen: z.object({ tallyStatus: z.literal('exception') }),
    changedAfterExport: z.object({ changedSinceExport: z.literal(true) }),
    originalsMissing: z.object({ originals: z.literal('missing') }),
    receiptsAwaitingVerificationOverOneWorkingDay: z.object({ overdueCheck: z.literal('receipts_unverified') }),
    paymentsApprovedNotRecordedOverOneWorkingDay: z.object({ overdueCheck: z.literal('payments_unrecorded') }),
  }),
});

const DuesBasisSchema = z.object({
  versionNo: z.number().int().positive(),
  // Accounts phase 2 (Track C, LD10): 'cancelled' after an approved cancellation settlement (total = customer charge, no plan).
  kind: z.enum(['approved', 'awaiting_review', 'cancelled']),
  newerVersionPending: z.boolean(),
  provisional: z.boolean(),
  lastApprovedAt: timestamp.nullable(),
});

export const DuesRowSchema = z.object({
  dealId: z.uuid(),
  dealReference: z.string(),
  branchName: text,
  ownerName: text,
  basis: DuesBasisSchema,
  totalPaise: paise,
  verifiedPaise: signedPaise,
  balancePaise: paise,
  overduePaise: paise,
  dueNowPaise: paise,
  nextDue: z.object({ date: isoDate, openPaise: paise }).nullable(),
  reportedPaise: paise,
  awaitingVerificationPaise: paise,
  creditPaise: paise,
  status: z.enum(DUES_STATUSES),
  reported: z.boolean(),
  cancellation: z.enum(['open', 'approved']).nullable(),
});

export const DuesPageSchema = z.object({
  scope: z.object({ mode: z.enum(['accounts', 'manager', 'sales']), readOnly: z.boolean() }),
  items: z.array(DuesRowSchema),
  hasMore: z.boolean(),
  nextAfter: z.string().nullable(),
});

export const SupplierPayableSchema = z.object({
  supplierId: z.uuid(),
  supplierName: z.string(),
  requestedLivePaise: paise,
  paidPaise: paise,
  verifiedPaise: paise,
  invoicedAcceptedPaise: paise,
  creditNotesAcceptedPaise: paise,
  invoicesUploadedPaise: paise,
});

export const DealDuesSchema = DuesRowSchema.extend({
  instalments: z.array(
    z.object({
      seq: z.number().int().positive(),
      label: z.string(),
      dueDate: isoDate,
      amountPaise: paise,
      coveredPaise: paise,
      openPaise: paise,
      status: z.enum(['paid', 'overdue', 'due_now', 'upcoming']),
      partlyPaid: z.boolean(),
    }),
  ),
  tallyInvoices: z.array(
    z.object({
      id: z.uuid(),
      invoiceRef: z.string(),
      invoiceDate: isoDate,
      status: z.enum(['active', 'withdrawn']),
      rowVersion: z.number().int().positive(),
      tallyStatus: z.enum(TALLY_STATUSES),
    }),
  ),
  supplierPayables: z.array(SupplierPayableSchema).nullable(),
  canAddTallyInvoice: z.boolean(),
  viewer: z.enum(['accounts', 'manager', 'sales']),
  // Accounts phase 2 (Track C, 7.2): the Deal's refunds (amounts only).
  refunds: z.object({
    live: z.object({ refNo: z.string(), status: z.enum(['requested', 'returned', 'approved']), amountPaise: paise }).nullable(),
    paidPaise: paise,
    keptAsCreditPaise: paise,
    // Addendum L6: customer owes after a reversed payment (already inside dueNowPaise).
    shortfallPaise: paise.optional().transform((v) => v ?? '0'),
  }).optional().transform((v) => v ?? { live: null, paidPaise: '0', keptAsCreditPaise: '0', shortfallPaise: '0' }),
  // Accounts phase 3 (track B patch, contract 6.6; DuesWriteOffKeysSchema of @/modules/write-offs/dto): the active
  // write-off and the "needs review" flag. Optional so pre-phase-3 fixtures parse (null / false).
  writeOff: DuesWriteOffSchema.nullable().optional().transform((v) => v ?? null),
  writeOffNeedsReview: z.boolean().optional().transform((v) => v ?? false),
});

export const LinkTargetsSchema = z.object({
  documentId: z.uuid(),
  items: z.array(z.object({
    taskId: z.uuid(),
    dealId: z.uuid(),
    dealReference: z.string(),
    department: z.enum(['purchase', 'flight']),
    serviceLabel: text,
    alreadyLinked: z.boolean(),
  })),
  links: z.array(z.object({
    linkId: z.uuid(),
    taskId: z.uuid(),
    dealId: z.uuid(),
    dealReference: z.string(),
    linkedAt: timestamp,
    linkedByName: text,
  })),
});

export const FilterOptionsSchema = z.object({
  branches: z.array(z.object({ branchId: z.uuid(), name: z.string() })),
  suppliers: z.array(z.object({ supplierId: z.uuid(), name: z.string() })),
  owners: z.array(z.object({ userId: z.uuid(), name: z.string() })),
});

export const SupplierPayablesSchema = z.object({
  dealId: z.uuid(),
  dealReference: z.string(),
  suppliers: z.array(SupplierPayableSchema),
});

export const TallyExportHeaderSchema = z.object({
  exportId: z.uuid(),
  exportNo: z.string().regex(/^TE-\d{4}-\d{6}$/),
  entityId: z.uuid(),
  periodFrom: isoDate,
  periodTo: isoDate,
  kinds: z.array(z.enum(TALLY_ANY_RECORD_KINDS)),
  includeExported: z.boolean(),
  branchNames: z.array(z.string()).nullable(),
  rowCount: z.number().int().positive(),
  alreadyExportedCount: z.number().int().nonnegative(),
  createdAt: timestamp,
  createdByName: text,
  fileName: z.string().regex(/^(tripnavigate-TE-\d{4}-\d{6}\.csv|TE-\d{4}-\d{6}\.xml)$/),
  // Accounts phase 3 (R-C1, additive; absent on the download-log header).
  format: z.enum(['csv', 'xml']).optional(),
  leftOutCount: z.number().int().nonnegative().optional(),
  includeReason: z.string().nullable().optional(),
  companyName: z.string().nullable().optional(),
});

export const TallyExportsSchema = z.object({
  entities: z.array(
    z.object({
      entityId: z.uuid(),
      name: z.string(),
      exportEnabled: z.boolean(),
      branches: z.array(z.object({ branchId: z.uuid(), name: z.string() })),
      mappingMissingCount: z.number().int().nonnegative(),
      xmlEnabled: z.boolean().optional(),
      companyName: z.string().nullable().optional(),
    }),
  ),
  items: z.array(TallyExportHeaderSchema),
});

const csvValue = z.string().nullable();
/** Phase 2 columns are absent on lines exported before 20261204000410: missing reads as an empty cell. */
const csvValueNew = z.string().nullable().default(null);
const PHASE2 = new Set<string>(CSV_PHASE2_KEYS);
export const CsvValuesSchema = z.object(
  Object.fromEntries(CSV_COLUMNS.map((c) => [c.key, PHASE2.has(c.key) ? csvValueNew : csvValue])) as Record<
    (typeof CSV_COLUMNS)[number]['key'],
    typeof csvValue
  >,
);

export const TallyExportLinesSchema = z.object({
  exportId: z.uuid(),
  exportNo: z.string(),
  lines: z.array(z.object({ lineNo: z.number().int().positive(), values: CsvValuesSchema })),
  nextAfter: z.number().int().positive().nullable(),
});
export type TallyExportLinesRecord = z.output<typeof TallyExportLinesSchema>;

export const AdminAccountsSettingsSchema = z.object({
  entityId: z.uuid(),
  exceptionOwnerUserId: z.uuid().nullable(),
  exceptionOwnerName: text,
  exceptionOwnerActive: z.boolean(),
  tallyExportEnabled: z.boolean(),
  // Phase 2 / 3 switches (track B 20261205000200; optional so older fixtures parse).
  customerDocumentsEnabled: z.boolean().optional(),
  refundsEnabled: z.boolean().optional(),
  autoBillsEnabled: z.boolean().optional(),
  autoBillReleaseEnabled: z.boolean().optional(),
  writeOffEnabled: z.boolean().optional(),
  writeOffLimitPaise: paise.optional(),
  tallyXmlEnabled: z.boolean().optional(),
  tallyCompanyName: z.string().nullable().optional(),
  rowVersion: z.number().int().nonnegative(),
  updatedAt: timestamp.nullable(),
  candidates: z.array(z.object({ userId: z.uuid(), name: z.string() })),
});

const ledgerName = z.string().min(1).max(100).nullable();

export const TallyMappingSchema = z.object({
  entityId: z.uuid(),
  rows: z.array(z.object({
    mappingId: z.uuid(),
    rowKind: z.enum(TALLY_MAPPING_ROW_KINDS),
    serviceClass: z.enum(TALLY_SERVICE_CLASSES),
    debitLedger: ledgerName,
    creditLedger: ledgerName,
    voucherType: z.string().min(1).max(60).nullable(),
    rowVersion: z.number().int().positive(),
    updatedAt: timestamp,
    updatedByName: text,
  })),
  missingCount: z.number().int().nonnegative(),
}) satisfies z.ZodType<TallyMappingView>;

const MAPPING_FIELDS = ['debitLedger', 'creditLedger', 'voucherType'] as const;

export const TallyMappingHistorySchema = z.object({
  mappingId: z.uuid(),
  items: z.array(z.object({
    field: z.enum(MAPPING_FIELDS),
    oldValue: text,
    newValue: text,
    changedAt: timestamp,
    changedByName: text,
    reason: z.string(),
  })),
}) satisfies z.ZodType<TallyMappingHistoryView>;

const TallyMappingSetSchema = z.object({
  outcome: z.enum(['updated', 'existing']),
  mappingId: z.uuid(),
  rowVersion: z.number().int().positive(),
  fields: z.array(z.enum(MAPPING_FIELDS)),
}) satisfies z.ZodType<TallyMappingSetResult>;

const TallyCommandSchema = z.object({
  outcome: z.enum(['updated', 'existing']),
  tallyRecordId: z.uuid(),
  status: z.enum(['ready', 'exported', 'matched', 'exception']),
  rowVersion: z.number().int().positive(),
});

const TallyInvoiceSchema = z.object({
  outcome: z.enum(['created', 'updated', 'existing']),
  id: z.uuid(),
  tallyRecordId: z.uuid().optional(),
  status: z.enum(['active', 'withdrawn']).optional(),
  rowVersion: z.number().int().positive(),
});

const ExportCreatedSchema = z.object({
  outcome: z.enum(['created', 'existing']),
  exportId: z.uuid(),
  exportNo: z.string().regex(/^TE-\d{4}-\d{6}$/),
  rowCount: z.number().int().positive(),
  alreadyExportedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
});

const SettingsResultSchema = z.object({
  changed: z.boolean(),
  exceptionOwnerUserId: z.uuid().nullable().optional(),
  tallyExportEnabled: z.boolean().optional(),
  rowVersion: z.number().int().positive(),
  updatedAt: timestamp,
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function accountsRecords(client: RpcClient, filter: RecordsFilter, after: string | null, limit = 50) {
  const fn = 'accounts_records';
  return parse(fn, RecordsPageSchema.nullable(), await invoke(client, fn, { p_filter: filter, p_after: after, p_limit: limit }));
}

export async function accountsRecordsTotals(client: RpcClient, filter: RecordsFilter) {
  const fn = 'accounts_records_totals';
  return parse(fn, RecordsTotalsSchema.nullable(), await invoke(client, fn, { p_filter: filter }));
}

export async function accountsDailyCheck(client: RpcClient) {
  const fn = 'accounts_daily_check';
  return parse(fn, DailyCheckSchema.nullable(), await invoke(client, fn, {}));
}

export async function accountsDues(client: RpcClient, filter: DuesFilter, after: string | null, limit = 50) {
  const fn = 'accounts_dues';
  return parse(fn, DuesPageSchema.nullable(), await invoke(client, fn, { p_filter: filter, p_after: after, p_limit: limit }));
}

export async function dealDues(client: RpcClient, dealId: string) {
  const fn = 'deal_dues';
  return parse(fn, DealDuesSchema.nullable(), await invoke(client, fn, { p_deal_id: dealId }));
}

export async function accountsSupplierPayables(client: RpcClient, dealId: string) {
  const fn = 'accounts_supplier_payables';
  return parse(fn, SupplierPayablesSchema.nullable(), await invoke(client, fn, { p_deal_id: dealId }));
}

export async function accountsTallyExports(client: RpcClient, limit = 50) {
  const fn = 'accounts_tally_exports';
  return parse(fn, TallyExportsSchema.nullable(), await invoke(client, fn, { p_limit: limit }));
}

export async function tallyExportLines(client: RpcClient, exportId: string, afterLine: number, limit: number) {
  const fn = 'accounts_tally_export_lines';
  return parse(fn, TallyExportLinesSchema.nullable(),
    await invoke(client, fn, { p_export_id: exportId, p_after_line: afterLine, p_limit: limit }));
}

export async function supplierDocumentLinkTargets(client: RpcClient, documentId: string) {
  const fn = 'supplier_document_link_targets';
  return parse(fn, LinkTargetsSchema.nullable(), await invoke(client, fn, { p_document_id: documentId }));
}

export async function accountsFilterOptions(client: RpcClient) {
  const fn = 'accounts_filter_options';
  return parse(fn, FilterOptionsSchema.nullable(), await invoke(client, fn, {}));
}

export async function adminAccountsSettings(client: RpcClient, entityId: string) {
  const fn = 'admin_accounts_settings';
  return parse(fn, AdminAccountsSettingsSchema.nullable(), await invoke(client, fn, { p_entity: entityId }));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface TallyTarget {
  kind: TallyRecordKind;
  recordId: string;
  expectedRowVersion: number;
}

export async function tallyMatch(client: RpcClient, t: TallyTarget, fields: { voucherRef: string; voucherDate: string }, requestId: string) {
  const fn = 'accounts_tally_match';
  return parse(fn, TallyCommandSchema, await invoke(client, fn, {
    p_kind: t.kind, p_record_id: t.recordId, p_expected_row_version: t.expectedRowVersion, p_fields: fields, p_request_id: requestId,
  }));
}

export async function tallyException(
  client: RpcClient,
  t: TallyTarget,
  fields: { reason: string; tallyAmountPaise?: string },
  requestId: string,
) {
  const fn = 'accounts_tally_exception';
  return parse(fn, TallyCommandSchema, await invoke(client, fn, {
    p_kind: t.kind, p_record_id: t.recordId, p_expected_row_version: t.expectedRowVersion, p_fields: fields, p_request_id: requestId,
  }));
}

export async function tallyReopen(client: RpcClient, t: TallyTarget, reason: string, requestId: string) {
  const fn = 'accounts_tally_reopen';
  return parse(fn, TallyCommandSchema, await invoke(client, fn, {
    p_kind: t.kind, p_record_id: t.recordId, p_expected_row_version: t.expectedRowVersion, p_reason: reason, p_request_id: requestId,
  }));
}

export async function tallyInvoiceAdd(
  client: RpcClient,
  dealId: string,
  fields: { invoiceRef: string; invoiceDate: string; note?: string | null },
  requestId: string,
) {
  const fn = 'accounts_tally_invoice_add';
  return parse(fn, TallyInvoiceSchema, await invoke(client, fn, { p_deal_id: dealId, p_fields: fields, p_request_id: requestId }));
}

export async function tallyInvoiceWithdraw(client: RpcClient, id: string, expectedRowVersion: number, reason: string, requestId: string) {
  const fn = 'accounts_tally_invoice_withdraw';
  return parse(fn, TallyInvoiceSchema, await invoke(client, fn, {
    p_id: id, p_expected_row_version: expectedRowVersion, p_reason: reason, p_request_id: requestId,
  }));
}

export interface ExportFields {
  entityId: string;
  from: string;
  to: string;
  kinds: TallyRecordKind[];
  includeExported: boolean;
  branchIds?: string[];
}

export async function tallyExportCreate(client: RpcClient, fields: ExportFields, requestId: string) {
  const fn = 'accounts_tally_export_create';
  return parse(fn, ExportCreatedSchema, await invoke(client, fn, { p_fields: fields, p_request_id: requestId }));
}

/** T10: one audit row per download; returns the header. Call once before streaming. */
export async function tallyExportDownloadLog(client: RpcClient, exportId: string) {
  const fn = 'accounts_tally_export_download_log';
  return parse(fn, TallyExportHeaderSchema, await invoke(client, fn, { p_export_id: exportId }));
}

export async function setExceptionOwner(client: RpcClient, entityId: string, userId: string | null, reason: string) {
  const fn = 'admin_set_accounts_exception_owner';
  return parse(fn, SettingsResultSchema, await invoke(client, fn, { p_entity: entityId, p_user_id: userId, p_reason: reason }));
}

export async function setTallyExportEnabled(client: RpcClient, entityId: string, enabled: boolean, reason: string) {
  const fn = 'admin_set_tally_export_enabled';
  return parse(fn, SettingsResultSchema, await invoke(client, fn, { p_entity: entityId, p_enabled: enabled, p_reason: reason }));
}

// ---------------------------------------------------------------------------
// Tally ledger mapping (Accounts phase 2, contract 8.1 D1/D2)
// ---------------------------------------------------------------------------

/** D1: the mapping grid of one entity (Accounts of the entity; null otherwise). */
export async function tallyMappingList(client: RpcClient, entityId: string): Promise<TallyMappingView | null> {
  const fn = 'tally_mapping_list';
  return parse(fn, TallyMappingSchema.nullable(), await invoke(client, fn, { p_entity: entityId }));
}

/** History of one mapping row (Accounts of the entity; null otherwise). */
export async function tallyMappingHistory(client: RpcClient, mappingId: string): Promise<TallyMappingHistoryView | null> {
  const fn = 'tally_mapping_history';
  return parse(fn, TallyMappingHistorySchema.nullable(), await invoke(client, fn, { p_mapping_id: mappingId }));
}

/** Fields of D2: a present key sets the value; null clears it. */
export interface TallyMappingFields {
  debitLedger?: string | null;
  creditLedger?: string | null;
  voucherType?: string | null;
}

/** D2: change one mapping row (reason 10..500; history rows; audit accounts.tally_mapping_changed). */
export async function tallyMappingSet(
  client: RpcClient,
  mappingId: string,
  expectedRowVersion: number,
  fields: TallyMappingFields,
  reason: string,
  requestId: string,
): Promise<TallyMappingSetResult> {
  const fn = 'tally_mapping_set';
  return parse(fn, TallyMappingSetSchema, await invoke(client, fn, {
    p_mapping_id: mappingId, p_expected_row_version: expectedRowVersion, p_fields: fields, p_reason: reason, p_request_id: requestId,
  }));
}
