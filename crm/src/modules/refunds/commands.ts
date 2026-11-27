import { z } from 'zod';
import type { RpcClient, RpcError } from '@/modules/fulfilment/commands';
import {
  type DealRefundsView,
  type PayeeKind,
  type PayoutMode,
  REFUND_ERROR_STATES,
  REFUND_STATUSES,
  SUPPLIER_REFUND_STATUSES,
  type RefundCommandResult,
  type RefundErrorCode,
  type RefundEvidenceBegun,
  type RefundEvidenceSubject,
  type RefundKind,
  type RefundListFilter,
  type RefundListPage,
  type RefundOutcome,
  type RefundsSwitchResult,
  type SupplierRefundMode,
  type SupplierRefundResult,
  type SupplierRefundSource,
  type SupplierRefundsDueFilter,
  type SupplierRefundsDuePage,
} from './contracts';
import { DealRefundsSchema, RefundListSchema, SupplierRefundsDueSchema, toDealRefunds, toRefundList, toSupplierRefundsDue } from './dto';
import { isConflictSqlState, stateMatches } from '@/lib/sqlstate';

/**
 * Typed wrappers for the refund commands and reads (migrations
 * 20261204000310..0350). Every call runs under the staff member's OWN
 * session; the database authorizes and audits. Responses are zod-validated;
 * anything unexpected throws RefundCommandError with code null (fail
 * closed). Database messages never reach the browser: errors map by SQLSTATE
 * plus exact token.
 */

const SESSION_STATES = new Set(['PGRST301', 'PGRST302', 'PGRST303', '401']);
const INPUT_STATES = new Set(['22023', '22P02', '22001', '22003', '22007', '22008', '23514', '23502']);

export class RefundCommandError extends Error {
  override name = 'RefundCommandError';
  constructor(
    readonly command: string,
    readonly code: RefundErrorCode | 'session' | null,
    readonly sqlState: string | null,
    /** The database hint: the refused contract key for invalid_input and refund_exceeds_money. */
    readonly hint: string | null = null,
  ) {
    super(`${command} failed${sqlState ? ` (${sqlState})` : ''}${code ? `: ${code}` : ''}`);
  }
}

export function mapRefundError(error: RpcError): RefundErrorCode | 'session' | null {
  const state = error.code ?? '';
  const token = (error.message ?? '').trim();
  if (Object.hasOwn(REFUND_ERROR_STATES, token) && stateMatches(REFUND_ERROR_STATES[token as RefundErrorCode], state)) {
    return token as RefundErrorCode;
  }
  // The Visa desk replay turns a request conflict into duplicate_request (40001 or PT409).
  if (token === 'duplicate_request' && isConflictSqlState(state)) return 'request_conflict';
  if (SESSION_STATES.has(state)) return 'session';
  if (state === '42501') return 'not_authorized';
  if (state === 'P0002') return 'not_found';
  if (INPUT_STATES.has(state)) return 'invalid_input';
  return null;
}

export async function invokeRefund(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  let result: { data: unknown; error: RpcError | null };
  try {
    result = await client.rpc(fn, args);
  } catch {
    throw new RefundCommandError(fn, null, null);
  }
  if (result.error) {
    throw new RefundCommandError(fn, mapRefundError(result.error), result.error.code ?? null, result.error.hint ?? null);
  }
  return result.data;
}

export function parseRefund<T>(fn: string, schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new RefundCommandError(fn, null, null);
  return parsed.data;
}

const outcome = z.enum(['created', 'updated', 'existing']);
const RefundResultSchema = z.object({
  outcome,
  refundRequestId: z.uuid(),
  refNo: z.string(),
  status: z.enum(REFUND_STATUSES),
  rowVersion: z.number().int().positive(),
  payoutId: z.uuid().optional(),
  journalEntryId: z.uuid().optional(),
});
const SupplierRefundResultSchema = z.object({
  outcome,
  supplierRefundId: z.uuid(),
  status: z.enum(SUPPLIER_REFUND_STATUSES),
  rowVersion: z.number().int().positive(),
});
const EvidenceBegunSchema = z.object({ outcome, evidenceId: z.uuid(), objectPath: z.string().min(10) });
const EvidenceFinishedSchema = z.object({ outcome, evidenceId: z.uuid(), status: z.enum(['stored', 'failed']) });
const EvidenceDownloadSchema = z.object({ objectPath: z.string().min(10), fileName: z.string().min(1), mime: z.string().min(1) });
const SwitchSchema = z.object({ changed: z.boolean(), refundsEnabled: z.boolean(), rowVersion: z.number().int().positive(), updatedAt: z.string() });

// ---------------------------------------------------------------------------
// Commands (C1-C8, C12)
// ---------------------------------------------------------------------------

export interface RefundRequestFields {
  kind: RefundKind;
  outcome: RefundOutcome;
  customerChargePaise: string | null;
  amountPaise: string | null;
  payeeKind: PayeeKind | null;
  payeeReceiptId: string | null;
  payeeName: string | null;
  payeeReason: string | null;
  reason: string;
  /** Addendum L7: payout only; uses the Deal's unused kept credit. */
  useKeptCredit?: boolean;
}

export async function refundRequestCreate(client: RpcClient, dealId: string, fields: RefundRequestFields, requestId: string): Promise<RefundCommandResult> {
  const fn = 'customer_refund_request_create';
  return parseRefund(fn, RefundResultSchema, await invokeRefund(client, fn, { p_deal_id: dealId, p_fields: fields, p_request_id: requestId }));
}

export async function refundRequestResubmit(client: RpcClient, id: string, expectedRowVersion: number, fields: RefundRequestFields,
  requestId: string): Promise<RefundCommandResult> {
  const fn = 'customer_refund_request_resubmit';
  return parseRefund(fn, RefundResultSchema, await invokeRefund(client, fn, {
    p_id: id, p_expected_row_version: expectedRowVersion, p_fields: fields, p_request_id: requestId }));
}

export async function refundRequestWithdraw(client: RpcClient, id: string, expectedRowVersion: number, reason: string,
  requestId: string): Promise<RefundCommandResult> {
  const fn = 'customer_refund_request_withdraw';
  return parseRefund(fn, RefundResultSchema, await invokeRefund(client, fn, {
    p_id: id, p_expected_row_version: expectedRowVersion, p_reason: reason, p_request_id: requestId }));
}

export async function refundDecide(client: RpcClient, input: { id: string; decision: 'approve' | 'return'; expectedAmountPaise: string;
  expectedChargePaise: string; reason: string | null; expectedRowVersion: number; requestId: string }): Promise<RefundCommandResult> {
  const fn = 'customer_refund_decide';
  return parseRefund(fn, RefundResultSchema, await invokeRefund(client, fn, {
    p_id: input.id, p_decision: input.decision, p_expected_amount_paise: input.expectedAmountPaise,
    p_expected_charge_paise: input.expectedChargePaise, p_reason: input.reason, p_expected_row_version: input.expectedRowVersion,
    p_request_id: input.requestId }));
}

export async function refundEvidenceBegin(client: RpcClient, input: { subjectKind: RefundEvidenceSubject; subjectId: string; fileName: string;
  mime: string; sizeBytes: number; sha256: string; requestId: string }): Promise<RefundEvidenceBegun> {
  const fn = 'refund_evidence_begin';
  return parseRefund(fn, EvidenceBegunSchema, await invokeRefund(client, fn, {
    p_subject_kind: input.subjectKind, p_subject_id: input.subjectId, p_file_name: input.fileName, p_mime: input.mime,
    p_size_bytes: input.sizeBytes, p_sha256: input.sha256, p_request_id: input.requestId }));
}

export async function refundEvidenceFinish(client: RpcClient, evidenceId: string, ok: boolean): Promise<{ status: 'stored' | 'failed' }> {
  const fn = 'refund_evidence_finish';
  return parseRefund(fn, EvidenceFinishedSchema, await invokeRefund(client, fn, { p_evidence_id: evidenceId, p_ok: ok }));
}

export async function refundEvidenceAuthorizeDownload(client: RpcClient, evidenceId: string): Promise<z.infer<typeof EvidenceDownloadSchema>> {
  const fn = 'refund_evidence_authorize_download';
  return parseRefund(fn, EvidenceDownloadSchema, await invokeRefund(client, fn, { p_evidence_id: evidenceId }));
}

export interface PayoutFields {
  mode: PayoutMode;
  paidOn: string;
  reference: string | null;
  evidenceId: string;
}

export async function refundPayoutRecord(client: RpcClient, id: string, expectedRowVersion: number, fields: PayoutFields,
  requestId: string): Promise<RefundCommandResult> {
  const fn = 'customer_refund_payout_record';
  return parseRefund(fn, RefundResultSchema, await invokeRefund(client, fn, {
    p_id: id, p_expected_row_version: expectedRowVersion, p_fields: fields, p_request_id: requestId }));
}

export interface SupplierRefundFields {
  sourceKind: SupplierRefundSource;
  sourceId: string;
  amountPaise: string;
  receivedOn: string;
  mode: SupplierRefundMode;
  reference: string;
  evidenceId: string;
  overExpectedReason: string | null;
}

export async function supplierRefundRecord(client: RpcClient, fields: SupplierRefundFields, requestId: string): Promise<SupplierRefundResult> {
  const fn = 'supplier_refund_record';
  return parseRefund(fn, SupplierRefundResultSchema, await invokeRefund(client, fn, { p_fields: fields, p_request_id: requestId }));
}

export async function supplierRefundCancel(client: RpcClient, id: string, expectedRowVersion: number, reason: string,
  requestId: string): Promise<SupplierRefundResult> {
  const fn = 'supplier_refund_cancel';
  return parseRefund(fn, SupplierRefundResultSchema, await invokeRefund(client, fn, {
    p_id: id, p_expected_row_version: expectedRowVersion, p_reason: reason, p_request_id: requestId }));
}

export async function setRefundsEnabled(client: RpcClient, entityId: string, enabled: boolean, reason: string): Promise<RefundsSwitchResult> {
  const fn = 'admin_set_refunds_enabled';
  return parseRefund(fn, SwitchSchema, await invokeRefund(client, fn, { p_entity: entityId, p_enabled: enabled, p_reason: reason }));
}

// ---------------------------------------------------------------------------
// Reads (R-C1..R-C3): null when the database says this person may not read
// ---------------------------------------------------------------------------

export async function dealRefunds(client: RpcClient, dealId: string): Promise<DealRefundsView | null> {
  const fn = 'deal_refunds';
  const data = await invokeRefund(client, fn, { p_deal_id: dealId });
  return data == null ? null : toDealRefunds(parseRefund(fn, DealRefundsSchema, data));
}

export async function refundRequestsList(client: RpcClient, filter: RefundListFilter, after: string | null, limit = 50): Promise<RefundListPage | null> {
  const fn = 'refund_requests_list';
  const data = await invokeRefund(client, fn, { p_filter: filter, p_after: after, p_limit: limit });
  return data == null ? null : toRefundList(parseRefund(fn, RefundListSchema, data));
}

export async function supplierRefundsDue(client: RpcClient, filter: SupplierRefundsDueFilter, after: string | null,
  limit = 50): Promise<SupplierRefundsDuePage | null> {
  const fn = 'supplier_refunds_due';
  const data = await invokeRefund(client, fn, { p_filter: filter, p_after: after, p_limit: limit });
  return data == null ? null : toSupplierRefundsDue(parseRefund(fn, SupplierRefundsDueSchema, data));
}
