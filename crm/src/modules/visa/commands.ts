import type { z } from 'zod';
import type { RpcClient, RpcError } from '@/modules/fulfilment/commands';
import { VISA_ERROR_STATES, type VisaErrorCode } from './contracts';
import {
  DealVisaHistorySchema,
  DealVisaSummarySchema,
  VisaApplicationResultSchema,
  VisaApplyResultSchema,
  VisaClaimResultSchema,
  VisaDocumentResultSchema,
  VisaEvidenceBegunSchema,
  VisaEvidenceFinishedSchema,
  VisaFeeSendResultSchema,
  VisaHomeCountsSchema,
  VisaNoticeAckResultSchema,
  VisaOtherCostResultSchema,
  VisaQueueSchema,
  VisaReapplyResultSchema,
  VisaRowSaveResultSchema,
  VisaWorkspaceSchema,
} from './dto';
import { isConflictSqlState, stateMatches } from '@/lib/sqlstate';

/**
 * Typed wrappers for the Visa and Passport desk commands and reads (Visa
 * build contract sections 6 and 9; migrations 20261202000100..0199). Every
 * call runs under the staff member's OWN session; the database authorizes,
 * checks every state rule and audits. Every command takes the request id of
 * the screen that sent it (idempotency: same id + same payload replays the
 * stored result as outcome 'existing'; same id + other payload refuses
 * duplicate_request). Payload objects are built here from an explicit key
 * list (absent = unchanged), never passed through from the browser.
 *
 * Responses are zod-validated (unknown keys stripped); anything unexpected
 * throws VisaCommandError with code null (fail closed). Database messages
 * never reach the browser: errors map by SQLSTATE + exact token; a hint is
 * kept only when it is a plain list of field keys ("applicants[1].reference")
 * or applicant tokens ("applicants[2]:documents_missing").
 */

const SESSION_STATES = new Set(['PGRST301', 'PGRST302', 'PGRST303', '401']);
const INPUT_STATES = new Set(['22023', '22P02', '22001', '22003', '22007', '22008', '23514', '23502']);
const FUNCTION_MISSING_STATES = new Set(['PGRST202', '42883']);
const HINT_KEYS = /^[A-Za-z0-9_.[\]:]{1,80}(,[A-Za-z0-9_.[\]:]{1,80}){0,40}$/;

export class VisaCommandError extends Error {
  override name = 'VisaCommandError';
  constructor(
    readonly command: string,
    readonly code: VisaErrorCode | 'session' | null,
    readonly sqlState: string | null,
    /** Field keys or applicant tokens from the database hint; never shown as text. */
    readonly hintKeys: string[] = [],
  ) {
    super(`${command} failed${sqlState ? ` (${sqlState})` : ''}${code ? `: ${code}` : ''}`);
  }
}

export function mapVisaError(error: RpcError): VisaErrorCode | 'session' | null {
  const state = error.code ?? '';
  const token = (error.message ?? '').trim();
  if (Object.hasOwn(VISA_ERROR_STATES, token) && stateMatches(VISA_ERROR_STATES[token as VisaErrorCode], state)) {
    return token as VisaErrorCode;
  }
  // finance_replay's request_conflict when it escapes a wrapper.
  if (token === 'request_conflict' && isConflictSqlState(state)) return 'duplicate_request';
  if (SESSION_STATES.has(state)) return 'session';
  // Without an exact token only the unambiguous states map (a 55000/40001/PT409 is never guessed).
  if (state === '42501') return 'not_authorized';
  if (state === 'P0002') return 'not_found';
  if (INPUT_STATES.has(state)) return 'invalid_input';
  return null;
}

export function isVisaFunctionMissing(error: unknown): boolean {
  return error instanceof VisaCommandError && error.sqlState !== null && FUNCTION_MISSING_STATES.has(error.sqlState);
}

/** Codes whose hint names fields or applicants. */
const HINTED = new Set<VisaErrorCode | 'session'>(['invalid_input', 'not_ready', 'duplicate_reference', 'applicant_removed', 'traveller_changed', 'wrong_state', 'version_changed', 'applied_date_in_future']);

export function visaHintKeys(hint: string | null | undefined): string[] {
  const value = (hint ?? '').trim();
  return HINT_KEYS.test(value) ? value.split(',') : [];
}

async function invoke(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  let result: { data: unknown; error: RpcError | null };
  try {
    result = await client.rpc(fn, args);
  } catch {
    throw new VisaCommandError(fn, null, null);
  }
  if (result.error) {
    const code = mapVisaError(result.error);
    throw new VisaCommandError(fn, code, result.error.code ?? null, code && HINTED.has(code) ? visaHintKeys(result.error.hint) : []);
  }
  return result.data;
}

function parse<S extends z.ZodType>(fn: string, schema: S, data: unknown): z.output<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new VisaCommandError(fn, null, null);
  return parsed.data;
}

/** Reads answer null when the caller may not read (never a partial object). */
function parseNullable<S extends z.ZodType>(fn: string, schema: S, data: unknown): z.output<S> | null {
  return data === null ? null : parse(fn, schema, data);
}

/** Copies only the listed keys that are present (absent = unchanged in every command). */
function pick<T extends object>(input: T, keys: readonly (keyof T)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(input, key) && input[key] !== undefined) out[key as string] = input[key];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Command field shapes (section 6; the database validates every value again)
// ---------------------------------------------------------------------------

export type VisaKindValue = 'e_visa' | 'sticker';
export type JurisdictionValue = 'yes' | 'no';
export type HandoverMethodValue = 'office' | 'executive' | 'courier' | 'not_with_us';

/** C2 visa_application_set_row (absent = unchanged). */
export interface VisaRowFields {
  appointmentDate?: string | null;
  appointmentTime?: string | null;
  remark?: string | null;
  documents?: { documentId: string; received: boolean }[];
  passportNumber?: string | null;
  visaKind?: VisaKindValue | null;
  jurisdiction?: JurisdictionValue | null;
  jurisdictionPlace?: string | null;
}
const ROW_KEYS = ['appointmentDate', 'appointmentTime', 'remark', 'documents', 'passportNumber', 'visaKind', 'jurisdiction', 'jurisdictionPlace'] as const;

/** C3 visa_application_document_add: a catalogue code or an "Other" label. */
export type VisaDocumentAddFields =
  | { catalogueCode: string; label?: undefined; received: boolean; remark: string | null }
  | { catalogueCode?: undefined; label: string; received: boolean; remark: string | null };

export interface VisaApplyApplicant {
  applicationId: string;
  expectedRowVersion: number;
  reference: string;
  appliedOn: string;
  governmentFeePaise: string;
  serviceFeePaise: string | null;
}

/** C5 visa_applications_apply. */
export interface VisaApplyFields {
  applicants: VisaApplyApplicant[];
  visaKind?: VisaKindValue;
  jurisdiction?: JurisdictionValue;
  jurisdictionPlace?: string | null;
  passportTaken?: boolean;
  paidBy: 'company' | 'customer_direct';
  paymentMode?: 'bank_transfer' | 'upi' | 'card' | 'cash' | 'other';
  receiptEvidenceId?: string | null;
  remark?: string | null;
}
const APPLY_KEYS = ['applicants', 'visaKind', 'jurisdiction', 'jurisdictionPlace', 'passportTaken', 'paidBy', 'paymentMode', 'receiptEvidenceId', 'remark'] as const;

export interface VisaHandoverChoice {
  method: HandoverMethodValue;
  courierNumber?: string | null;
}

/** C6 visa_application_decide. */
export interface VisaDecideFields {
  decision: 'approved' | 'rejected';
  outcomeEvidenceId: string;
  visaKind?: VisaKindValue;
  remark?: string | null;
  reason?: string;
  recipientEmail?: string;
  handover?: VisaHandoverChoice;
}
const DECIDE_KEYS = ['decision', 'outcomeEvidenceId', 'visaKind', 'remark', 'reason', 'recipientEmail', 'handover'] as const;

/** C7 visa_application_set_handover: exactly one of the three shapes. */
export type VisaHandoverFields =
  | { method: HandoverMethodValue; courierNumber?: string | null; remark?: string | null }
  | { recipientEmail: string }
  | { customerTold: true };
const HANDOVER_KEYS = ['method', 'courierNumber', 'remark', 'recipientEmail', 'customerTold'] as const;

/** C8 visa_application_mark_delivered. */
export interface VisaDeliveredFields {
  deliveredOn: string;
  remark?: string | null;
}

/** C9 visa_application_withdraw. */
export interface VisaWithdrawFields {
  reason: string;
  customerInformed: true;
  handover?: VisaHandoverChoice;
}

/** C12 visa_fee_send. */
export interface VisaFeeSendFields {
  amountPaise: string;
  receiptEvidenceId?: string | null;
  remark?: string | null;
}

function handoverPayload(h: VisaHandoverChoice | undefined): Record<string, unknown> | undefined {
  if (!h) return undefined;
  return h.method === 'courier' ? { method: h.method, courierNumber: h.courierNumber ?? null } : { method: h.method };
}

// ---------------------------------------------------------------------------
// Reads (section 9)
// ---------------------------------------------------------------------------

export async function visaQueue(client: RpcClient) {
  const fn = 'visa_queue';
  return parseNullable(fn, VisaQueueSchema, await invoke(client, fn, {}));
}

export async function visaWorkspace(client: RpcClient, taskId: string) {
  const fn = 'visa_workspace';
  return parseNullable(fn, VisaWorkspaceSchema, await invoke(client, fn, { p_task_id: taskId }));
}

export async function dealVisaSummary(client: RpcClient, dealId: string) {
  const fn = 'deal_visa_summary';
  return parseNullable(fn, DealVisaSummarySchema, await invoke(client, fn, { p_deal_id: dealId }));
}

export async function dealVisaHistory(client: RpcClient, dealId: string) {
  const fn = 'deal_visa_history';
  return parseNullable(fn, DealVisaHistorySchema, await invoke(client, fn, { p_deal_id: dealId }));
}

export async function visaHomeCounts(client: RpcClient) {
  const fn = 'visa_home_counts';
  return parseNullable(fn, VisaHomeCountsSchema, await invoke(client, fn, {}));
}

// ---------------------------------------------------------------------------
// Commands (section 6)
// ---------------------------------------------------------------------------

/** C1 "Take this task" (existing signature; no request id: a second take answers alreadyYours). */
export async function visaTaskClaim(client: RpcClient, taskId: string) {
  const fn = 'visa_task_claim';
  return parse(fn, VisaClaimResultSchema, await invoke(client, fn, { p_task_id: taskId }));
}

/** C2 Passengers table row Save. */
export async function visaApplicationSetRow(
  client: RpcClient,
  input: { applicationId: string; expectedRowVersion: number; fields: VisaRowFields; requestId: string },
) {
  const fn = 'visa_application_set_row';
  const fields = pick(input.fields, ROW_KEYS);
  if (input.fields.documents) fields.documents = input.fields.documents.map((d) => ({ documentId: d.documentId, received: d.received }));
  return parse(fn, VisaRowSaveResultSchema, await invoke(client, fn, {
    p_application_id: input.applicationId, p_expected_row_version: input.expectedRowVersion, p_fields: fields, p_request_id: input.requestId,
  }));
}

/** C3 Add document. */
export async function visaApplicationDocumentAdd(
  client: RpcClient,
  input: { applicationId: string; expectedRowVersion: number; fields: VisaDocumentAddFields; requestId: string },
) {
  const fn = 'visa_application_document_add';
  const f = input.fields;
  const fields: Record<string, unknown> = f.catalogueCode !== undefined
    ? { catalogueCode: f.catalogueCode, received: f.received, remark: f.remark }
    : { label: f.label, received: f.received, remark: f.remark };
  return parse(fn, VisaDocumentResultSchema, await invoke(client, fn, {
    p_application_id: input.applicationId, p_expected_row_version: input.expectedRowVersion, p_fields: fields, p_request_id: input.requestId,
  }));
}

/** C4 Remove a not-received document (expected = the parent application's row version). */
export async function visaApplicationDocumentRemove(
  client: RpcClient,
  input: { documentId: string; expectedRowVersion: number; requestId: string },
) {
  const fn = 'visa_application_document_remove';
  return parse(fn, VisaDocumentResultSchema, await invoke(client, fn, {
    p_document_id: input.documentId, p_expected_row_version: input.expectedRowVersion, p_request_id: input.requestId,
  }));
}

/** C5 Mark as applied / Confirm applied: 1..100 applicants in one transaction. */
export async function visaApplicationsApply(client: RpcClient, input: { taskId: string; fields: VisaApplyFields; requestId: string }) {
  const fn = 'visa_applications_apply';
  const fields = pick(input.fields, APPLY_KEYS);
  fields.applicants = input.fields.applicants.map((a) => ({
    applicationId: a.applicationId,
    expectedRowVersion: a.expectedRowVersion,
    reference: a.reference,
    appliedOn: a.appliedOn,
    governmentFeePaise: a.governmentFeePaise,
    serviceFeePaise: a.serviceFeePaise,
  }));
  return parse(fn, VisaApplyResultSchema, await invoke(client, fn, { p_task_id: input.taskId, p_fields: fields, p_request_id: input.requestId }));
}

/** C6 Approve / Reject. */
export async function visaApplicationDecide(
  client: RpcClient,
  input: { applicationId: string; expectedRowVersion: number; fields: VisaDecideFields; requestId: string },
) {
  const fn = 'visa_application_decide';
  const fields = pick(input.fields, DECIDE_KEYS);
  if (input.fields.handover) fields.handover = handoverPayload(input.fields.handover);
  return parse(fn, VisaApplicationResultSchema, await invoke(client, fn, {
    p_application_id: input.applicationId, p_expected_row_version: input.expectedRowVersion, p_fields: fields, p_request_id: input.requestId,
  }));
}

/** C7 Set handover / Record handover. */
export async function visaApplicationSetHandover(
  client: RpcClient,
  input: { applicationId: string; expectedRowVersion: number; fields: VisaHandoverFields; requestId: string },
) {
  const fn = 'visa_application_set_handover';
  const fields = pick(input.fields as Record<string, unknown>, HANDOVER_KEYS);
  return parse(fn, VisaApplicationResultSchema, await invoke(client, fn, {
    p_application_id: input.applicationId, p_expected_row_version: input.expectedRowVersion, p_fields: fields, p_request_id: input.requestId,
  }));
}

/** C8 Mark delivered. */
export async function visaApplicationMarkDelivered(
  client: RpcClient,
  input: { applicationId: string; expectedRowVersion: number; fields: VisaDeliveredFields; requestId: string },
) {
  const fn = 'visa_application_mark_delivered';
  const fields = { deliveredOn: input.fields.deliveredOn, remark: input.fields.remark ?? null };
  return parse(fn, VisaApplicationResultSchema, await invoke(client, fn, {
    p_application_id: input.applicationId, p_expected_row_version: input.expectedRowVersion, p_fields: fields, p_request_id: input.requestId,
  }));
}

/** C9 Withdrawn by customer. */
export async function visaApplicationWithdraw(
  client: RpcClient,
  input: { applicationId: string; expectedRowVersion: number; fields: VisaWithdrawFields; requestId: string },
) {
  const fn = 'visa_application_withdraw';
  const fields: Record<string, unknown> = { reason: input.fields.reason, customerInformed: input.fields.customerInformed };
  if (input.fields.handover) fields.handover = handoverPayload(input.fields.handover);
  return parse(fn, VisaApplicationResultSchema, await invoke(client, fn, {
    p_application_id: input.applicationId, p_expected_row_version: input.expectedRowVersion, p_fields: fields, p_request_id: input.requestId,
  }));
}

/** C10 Apply again (after Rejected only). */
export async function visaApplicationReapply(client: RpcClient, input: { applicationId: string; expectedRowVersion: number; requestId: string }) {
  const fn = 'visa_application_reapply';
  return parse(fn, VisaReapplyResultSchema, await invoke(client, fn, {
    p_application_id: input.applicationId, p_expected_row_version: input.expectedRowVersion, p_request_id: input.requestId,
  }));
}

/** C12 Fix fee / Send fee to Accounts. */
export async function visaFeeSend(client: RpcClient, input: { entryId: string; expectedRowVersion: number; fields: VisaFeeSendFields; requestId: string }) {
  const fn = 'visa_fee_send';
  const fields: Record<string, unknown> = { amountPaise: input.fields.amountPaise, remark: input.fields.remark ?? null };
  if (input.fields.receiptEvidenceId) fields.receiptEvidenceId = input.fields.receiptEvidenceId;
  return parse(fn, VisaFeeSendResultSchema, await invoke(client, fn, {
    p_entry_id: input.entryId, p_expected_row_version: input.expectedRowVersion, p_fields: fields, p_request_id: input.requestId,
  }));
}

/**
 * Section 16 (VL18 changed): an "other" visa cost of one passenger (for example
 * courier), recorded with department_cost_save (visa: costKind 'other' and an
 * applicationId only; fees come from Applied). Company-paid ones start as a
 * draft and go to Accounts with visaFeeSend once the receipt is attached.
 * New entry: entryId null, expectedRowVersion 0.
 */
export interface VisaOtherCostFields {
  applicationId: string;
  amountPaise: string;
  paidBy: 'company' | 'customer_direct';
  paymentMode: 'bank_transfer' | 'upi' | 'card' | 'cash' | 'other' | null;
  paidOn: string;
  reference: string | null;
  receiptEvidenceId: string | null;
}

export async function visaOtherCostSave(
  client: RpcClient,
  input: { taskId: string; entryId: string | null; expectedRowVersion: number; fields: VisaOtherCostFields; requestId: string },
) {
  const fn = 'department_cost_save';
  const f = input.fields;
  const fields = {
    applicationId: f.applicationId, costKind: 'other', amountPaise: f.amountPaise, paidBy: f.paidBy, paymentMode: f.paymentMode,
    paidOn: f.paidOn, reference: f.reference, receiptEvidenceId: f.receiptEvidenceId,
  };
  return parse(fn, VisaOtherCostResultSchema, await invoke(client, fn, {
    p_task_id: input.taskId, p_entry_id: input.entryId, p_expected_row_version: input.expectedRowVersion, p_fields: fields,
    p_request_id: input.requestId,
  }));
}

/** C13 "OK, checked" on a traveller change. */
export async function visaApplicationConfirmTraveller(client: RpcClient, input: { applicationId: string; expectedRowVersion: number; requestId: string }) {
  const fn = 'visa_application_confirm_traveller';
  return parse(fn, VisaApplicationResultSchema, await invoke(client, fn, {
    p_application_id: input.applicationId, p_expected_row_version: input.expectedRowVersion, p_request_id: input.requestId,
  }));
}

/** C14 "OK, seen" on a result notice (Sales owner; branch Manager without one). */
export async function visaResultNoticeAck(client: RpcClient, noticeId: string) {
  const fn = 'visa_result_notice_ack';
  return parse(fn, VisaNoticeAckResultSchema, await invoke(client, fn, { p_notice_id: noticeId }));
}

// ---------------------------------------------------------------------------
// Files (C11 and department evidence)
// ---------------------------------------------------------------------------

export interface VisaFileMeta {
  fileName: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
}

/** C11 "Upload" on a document: an applicant_document linked to the document and its application. */
export async function visaDocumentFileBegin(client: RpcClient, input: { documentId: string } & VisaFileMeta) {
  const fn = 'visa_document_file_begin';
  return parse(fn, VisaEvidenceBegunSchema, await invoke(client, fn, {
    p_document_id: input.documentId, p_file_name: input.fileName, p_mime: input.mime, p_size_bytes: input.sizeBytes, p_sha256: input.sha256,
  }));
}

/** Fee receipts, decision proofs and other task files (department_evidence_begin, visa kinds only). */
export async function visaEvidenceBegin(
  client: RpcClient,
  input: { taskId: string; applicationId: string | null; kind: 'applicant_document' | 'fee_receipt' | 'authority_outcome' | 'other' } & VisaFileMeta,
) {
  const fn = 'department_evidence_begin';
  return parse(fn, VisaEvidenceBegunSchema, await invoke(client, fn, {
    p_task_id: input.taskId, p_application_id: input.applicationId, p_kind: input.kind, p_file_name: input.fileName, p_mime: input.mime,
    p_size_bytes: input.sizeBytes, p_sha256: input.sha256,
  }));
}

export async function visaEvidenceFinish(client: RpcClient, evidenceId: string, ok: boolean) {
  const fn = 'department_evidence_finish';
  return parse(fn, VisaEvidenceFinishedSchema, await invoke(client, fn, { p_evidence_id: evidenceId, p_ok: ok }));
}
