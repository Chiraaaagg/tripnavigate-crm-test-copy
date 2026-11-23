import { z } from 'zod';
import type { RpcClient } from '@/modules/fulfilment/commands';
import { AccountsDeskCommandError, mapAccountsDeskError } from './commands';
import {
  LEFT_OUT_REASONS,
  MATCH_OUTCOMES,
  TALLY_ANY_RECORD_KINDS,
  type TallyFileCreated,
  type TallyFilePreview,
  type TallyLeftOutPage,
  type TallyMatchApplied,
  type TallyMatchBatch,
  type TallyMatchPage,
  type TallyPartyName,
  type TallyXmlSettingResult,
} from './contracts';

/**
 * Typed wrappers for the Tally import file and the matching upload (Accounts phase 3, contract 7; migrations
 * 20261205000300..0320). Every call runs under the staff member's OWN session; the database authorizes (Accounts
 * only) and audits. Responses are zod-validated with every key listed; anything unexpected throws
 * AccountsDeskCommandError with code null (fail closed). The CRM never contacts Tally.
 */

async function invoke(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  let result: Awaited<ReturnType<RpcClient['rpc']>>;
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

const paise = z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestamp = z.string().min(1).refine((v) => !Number.isNaN(Date.parse(v)));
const exportNo = z.string().regex(/^TE-\d{4}-\d{6}$/);
const kind = z.enum(TALLY_ANY_RECORD_KINDS);
const reason = z.enum(LEFT_OUT_REASONS);
const outcome = z.enum(MATCH_OUTCOMES);

const LeftOutRowSchema = z.object({
  recordKind: kind,
  recordId: z.uuid(),
  reference: z.string().nullable(),
  reason,
  detail: z.string().nullable(),
});

export const TallyFilePreviewSchema = z.object({
  lines: z.array(z.object({
    recordKind: kind,
    recordId: z.uuid(),
    reference: z.string().nullable(),
    dealReference: z.string().nullable(),
    voucherType: z.string(),
    date: isoDate,
    amountPaise: paise,
  })),
  leftOut: z.array(LeftOutRowSchema),
  counts: z.object({
    lines: z.number().int().nonnegative(),
    leftOut: z.number().int().nonnegative(),
    byReason: z.partialRecord(reason, z.number().int().nonnegative()),
  }),
  truncated: z.boolean(),
  companyName: z.string().nullable(),
}) satisfies z.ZodType<TallyFilePreview>;

const TallyFileCreatedSchema = z.object({
  outcome: z.enum(['created', 'existing']),
  exportId: z.uuid(),
  exportNo,
  lines: z.number().int().positive(),
  leftOut: z.number().int().nonnegative(),
}) satisfies z.ZodType<TallyFileCreated>;

export const TallyLeftOutPageSchema = z.object({
  exportId: z.uuid(),
  exportNo,
  items: z.array(LeftOutRowSchema),
  nextAfter: z.string().nullable(),
  hasMore: z.boolean(),
}) satisfies z.ZodType<TallyLeftOutPage>;

const summary = z.object(Object.fromEntries(MATCH_OUTCOMES.map((o) => [o, z.number().int().nonnegative()])) as Record<
  (typeof MATCH_OUTCOMES)[number],
  z.ZodNumber
>);

export const TallyMatchBatchSchema = z.object({
  batchId: z.uuid(),
  fileName: z.string(),
  status: z.enum(['staged', 'applied', 'cancelled']),
  rowCount: z.number().int().positive(),
  summary,
  proposalHash: z.string().regex(/^[0-9a-f]{64}$/),
  stagedAt: timestamp,
  stagedByName: z.string().nullable(),
  appliedAt: timestamp.nullable(),
}) satisfies z.ZodType<TallyMatchBatch>;

const StagedSchema = TallyMatchBatchSchema.extend({ outcome: z.enum(['created', 'existing']) });

export const TallyMatchPageSchema = z.object({
  batch: TallyMatchBatchSchema,
  outcome: outcome.nullable(),
  rows: z.array(z.object({
    rowNo: z.number().int().positive(),
    tnTag: z.string().nullable(),
    voucherRef: z.string(),
    voucherDate: isoDate,
    voucherType: z.string().nullable(),
    amountPaise: paise,
    outcome,
    crmAmountPaise: paise.nullable(),
    crmReference: z.string().nullable(),
  })),
  nextAfter: z.string().nullable(),
  hasMore: z.boolean(),
}) satisfies z.ZodType<TallyMatchPage>;

const AppliedSchema = z.object({
  outcome: z.enum(['updated', 'existing']),
  batchId: z.uuid(),
  status: z.literal('applied'),
  matched: z.number().int().nonnegative(),
  exceptions: z.number().int().nonnegative(),
}) satisfies z.ZodType<TallyMatchApplied>;

const CancelledSchema = z.object({ outcome: z.enum(['updated', 'existing']), batchId: z.uuid(), status: z.literal('cancelled') });

const PartyNameSchema = z.object({ partyId: z.uuid(), name: z.string().nullable(), rowVersion: z.number().int().positive() }) satisfies
  z.ZodType<TallyPartyName>;
const PartyNameSetSchema = PartyNameSchema.extend({ outcome: z.enum(['updated', 'existing']) });

const XmlSettingSchema = z.object({
  changed: z.boolean(),
  tallyXmlEnabled: z.boolean(),
  tallyCompanyName: z.string().nullable(),
  rowVersion: z.number().int().positive(),
  updatedAt: timestamp,
}) satisfies z.ZodType<TallyXmlSettingResult>;

export const TallyFileDownloadSchema = z.object({
  exportId: z.uuid(),
  exportNo,
  companyName: z.string().min(1).max(100),
  rowCount: z.number().int().positive(),
  fileName: z.string().regex(/^TE-\d{4}-\d{6}\.xml$/),
});

const ledger = z.string().min(1).max(100);
/** The frozen voucher of one XML line (tally_export_lines.values.voucher). */
export const TallyXmlVoucherSchema = z.object({
  date: isoDate,
  voucherType: z.string().min(1).max(60),
  narration: z.string().min(1).max(500),
  reference: z.string().nullable(),
  partyLedger: ledger.nullable(),
  entries: z.array(z.union([
    z.object({ ledger, debitPaise: paise }),
    z.object({ ledger, creditPaise: paise }),
  ])).min(2),
});

export const TallyFileLinesSchema = z.object({
  exportId: z.uuid(),
  exportNo,
  lines: z.array(z.object({ lineNo: z.number().int().positive(), values: z.object({ voucher: TallyXmlVoucherSchema }) })),
  nextAfter: z.number().int().positive().nullable(),
});

// ---------------------------------------------------------------------------
// Reads (Accounts only; null otherwise)
// ---------------------------------------------------------------------------

export interface TallyFileArgs {
  entityId: string;
  from: string;
  to: string;
  /** null = every kind. */
  kinds: string[] | null;
  branchIds: string[] | null;
}

/** R-C2: what would go in and what would be left out, and why (not audited). */
export async function tallyFilePreview(client: RpcClient, a: TallyFileArgs): Promise<TallyFilePreview | null> {
  const fn = 'accounts_tally_file_preview';
  return parse(fn, TallyFilePreviewSchema.nullable(), await invoke(client, fn, {
    p_entity: a.entityId, p_from: a.from, p_to: a.to, p_kinds: a.kinds, p_branch_ids: a.branchIds,
  }));
}

/** R-C3: the left-out list of one file, keyset "<kind>|<id>". */
export async function tallyLeftOut(client: RpcClient, exportId: string, after: string | null, limit = 100): Promise<TallyLeftOutPage | null> {
  const fn = 'accounts_tally_export_left_out';
  return parse(fn, TallyLeftOutPageSchema.nullable(), await invoke(client, fn, { p_export_id: exportId, p_after: after, p_limit: limit }));
}

/** R-C4: one matching upload with its rows (keyset on the row number). */
export async function tallyMatchGet(client: RpcClient, batchId: string, outcomeFilter: string | null, after: string | null,
  limit = 100): Promise<TallyMatchPage | null> {
  const fn = 'accounts_tally_match_get';
  return parse(fn, TallyMatchPageSchema.nullable(), await invoke(client, fn, {
    p_batch_id: batchId, p_outcome: outcomeFilter, p_after: after, p_limit: limit,
  }));
}

/** The Tally party name of a customer party (Accounts of its entity). */
export async function partyTallyName(client: RpcClient, partyId: string): Promise<TallyPartyName | null> {
  const fn = 'customer_party_tally_name';
  return parse(fn, PartyNameSchema.nullable(), await invoke(client, fn, { p_party_id: partyId }));
}

/** One audit row per XML download; returns the header with the frozen company name. Call once before streaming. */
export async function tallyFileDownloadLog(client: RpcClient, exportId: string) {
  const fn = 'accounts_tally_file_download_log';
  return parse(fn, TallyFileDownloadSchema, await invoke(client, fn, { p_export_id: exportId }));
}

/** The frozen lines of an XML file, page by page (accounts_tally_export_lines). */
export async function tallyFileLines(client: RpcClient, exportId: string, afterLine: number, limit: number) {
  const fn = 'accounts_tally_export_lines';
  return parse(fn, TallyFileLinesSchema.nullable(), await invoke(client, fn, { p_export_id: exportId, p_after_line: afterLine, p_limit: limit }));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** C3: make the file. */
export async function tallyFileCreate(client: RpcClient, a: TallyFileArgs & { includeAgain: boolean; includeReason: string | null },
  requestId: string): Promise<TallyFileCreated> {
  const fn = 'accounts_tally_file_create';
  return parse(fn, TallyFileCreatedSchema, await invoke(client, fn, {
    p_entity: a.entityId, p_from: a.from, p_to: a.to, p_kinds: a.kinds, p_branch_ids: a.branchIds,
    p_include_again: a.includeAgain, p_include_reason: a.includeReason, p_request_id: requestId,
  }));
}

/** One row of the matching upload as sent to the database (the narration stays on the server). */
export interface TallyMatchUploadRow {
  tnTag: string | null;
  voucherRef: string;
  voucherDate: string;
  voucherType: string | null;
  amountPaise: string;
}

/** C4: stage an uploaded Day Book. */
export async function tallyMatchStage(client: RpcClient, entityId: string, fileName: string, fileSha256: string,
  rows: TallyMatchUploadRow[], requestId: string) {
  const fn = 'accounts_tally_match_stage';
  return parse(fn, StagedSchema, await invoke(client, fn, {
    p_entity: entityId, p_file_name: fileName, p_file_sha256: fileSha256, p_rows: rows, p_request_id: requestId,
  }));
}

/** C5: apply a staged upload bound to its proposal hash. */
export async function tallyMatchApply(client: RpcClient, batchId: string, expectedProposalHash: string, requestId: string) {
  const fn = 'accounts_tally_match_apply';
  return parse(fn, AppliedSchema, await invoke(client, fn, {
    p_batch_id: batchId, p_expected_proposal_hash: expectedProposalHash, p_request_id: requestId,
  }));
}

/** C6: cancel a staged upload. */
export async function tallyMatchCancel(client: RpcClient, batchId: string, requestId: string) {
  const fn = 'accounts_tally_match_cancel';
  return parse(fn, CancelledSchema, await invoke(client, fn, { p_batch_id: batchId, p_request_id: requestId }));
}

/** C1: set or clear (null) the Tally party name of a customer party. */
export async function partyTallyNameSet(client: RpcClient, partyId: string, expectedRowVersion: number, name: string | null,
  requestId: string) {
  const fn = 'customer_party_tally_name_set';
  return parse(fn, PartyNameSetSchema, await invoke(client, fn, {
    p_party_id: partyId, p_expected_row_version: expectedRowVersion, p_name: name, p_request_id: requestId,
  }));
}

/** C2: the Tally file switch and company name (finance policy managers). companyName null keeps the saved name. */
export async function setTallyXml(client: RpcClient, entityId: string, enabled: boolean, companyName: string | null, reasonText: string) {
  const fn = 'admin_set_tally_xml';
  return parse(fn, XmlSettingSchema, await invoke(client, fn, {
    p_entity: entityId, p_enabled: enabled, p_company_name: companyName, p_reason: reasonText,
  }));
}
