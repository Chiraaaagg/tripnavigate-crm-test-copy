import { z } from 'zod';
import type { RpcClient, RpcError } from '@/modules/fulfilment/commands';
import {
  type AutoBillsSwitchResult,
  DOCUMENT_ERROR_STATES,
  DOCUMENT_KINDS,
  DOCUMENT_STATUSES,
  type DocumentCommandResult,
  type DocumentErrorCode,
  type DocumentKind,
  type DocumentsSwitchResult,
  type RenderRetryResult,
} from './contracts';
import {
  DealDocumentsSchema,
  DocumentDetailSchema,
  DocumentListSchema,
  type DealDocuments,
  type DocumentDetail,
  type DocumentList,
  type DocumentListFilter,
} from './dto';
import { stateMatches } from '@/lib/sqlstate';

/**
 * Typed wrappers of the customer document commands and reads (contract 6.7,
 * 6.9). Every call runs under the CALLER's client (the staff member's own
 * session); replies are validated with zod and anything unexpected throws
 * DocumentCommandError with code null (fail closed). Database messages never
 * reach the browser: errors map by SQLSTATE + exact token.
 */

const SESSION_STATES = new Set(['PGRST301', 'PGRST302', 'PGRST303', '401']);
const INPUT_STATES = new Set(['22023', '22P02', '22001', '22003', '22007', '22008', '23514', '23502']);

export class DocumentCommandError extends Error {
  override name = 'DocumentCommandError';
  constructor(
    readonly command: string,
    readonly code: DocumentErrorCode | 'session' | null,
    readonly sqlState: string | null,
    /** The database hint: the refused field for invalid_input, the reason for not_ready / wrong_state. */
    readonly hint: string | null = null,
  ) {
    super(`${command} failed${sqlState ? ` (${sqlState})` : ''}${code ? `: ${code}` : ''}`);
  }
}

export function mapDocumentError(error: RpcError): DocumentErrorCode | 'session' | null {
  const state = error.code ?? '';
  const token = (error.message ?? '').trim();
  if (Object.hasOwn(DOCUMENT_ERROR_STATES, token) && stateMatches(DOCUMENT_ERROR_STATES[token as DocumentErrorCode], state)) {
    return token as DocumentErrorCode;
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
    throw new DocumentCommandError(fn, null, null);
  }
  if (result.error) throw new DocumentCommandError(fn, mapDocumentError(result.error), result.error.code ?? null, result.error.hint ?? null);
  return result.data;
}

function parse<T>(fn: string, schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new DocumentCommandError(fn, null, null);
  return parsed.data;
}

const sha = z.string().regex(/^[0-9a-f]{64}$/);

export const DocumentCommandResultSchema = z
  .object({
    outcome: z.enum(['created', 'updated', 'existing']),
    documentId: z.uuid(),
    dealId: z.uuid(),
    kind: z.enum(DOCUMENT_KINDS),
    status: z.enum(DOCUMENT_STATUSES),
    number: z.string().nullable(),
    rowVersion: z.number().int().positive(),
    contentSha256: sha,
    warnings: z.array(z.string()).optional(),
    seq: z.number().int().positive().optional(),
    issueDate: z.string().optional(),
    renderJobId: z.uuid().optional(),
    replacedDocumentId: z.uuid().nullable().optional(),
    replacesDocumentId: z.uuid().optional(),
  })
  .strict() satisfies z.ZodType<DocumentCommandResult>;

const RetrySchema = z
  .object({ outcome: z.enum(['created', 'existing']), documentId: z.uuid(), renderJobId: z.uuid() })
  .strict() satisfies z.ZodType<RenderRetryResult>;

const AutoBillsSwitchSchema = z
  .object({
    changed: z.boolean(),
    autoBillsEnabled: z.boolean(),
    autoBillReleaseEnabled: z.boolean(),
    autoBillsSince: z.string().nullable(),
    rowVersion: z.number().int().nonnegative(),
    updatedAt: z.string().nullable(),
  })
  .strict() satisfies z.ZodType<AutoBillsSwitchResult>;

const SwitchSchema = z
  .object({ changed: z.boolean(), customerDocumentsEnabled: z.boolean(), rowVersion: z.number().int().nonnegative(), updatedAt: z.string().nullable() })
  .strict() satisfies z.ZodType<DocumentsSwitchResult>;

export const DownloadSchema = z
  .object({
    documentId: z.uuid(),
    objectPath: z.string().regex(/^[0-9a-f-]{36}\/customer-documents\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.pdf$/),
    fileName: z.string().regex(/^.{1,40}-(ADV|INV|CN)-[0-9]{1,4}\.pdf$/),
    sizeBytes: z.number().int().positive(),
    sha256: sha,
  })
  .strict();
export type DownloadAuthorization = z.infer<typeof DownloadSchema>;

export const SettingsSchema = z
  .object({
    entityId: z.uuid(),
    customerDocumentsEnabled: z.boolean(),
    refundsEnabled: z.boolean(),
    rowVersion: z.number().int().nonnegative(),
    updatedAt: z.string().nullable(),
  })
  .strict();
export type DocumentSettings = z.infer<typeof SettingsSchema>;

/** Source of a new draft (B1). */
export type DraftSource = { receiptId: string } | { refundRequestId: string } | { replacesDocumentId: string } | Record<string, never>;

const command = (client: RpcClient, fn: string, args: Record<string, unknown>) =>
  invoke(client, fn, args).then((data) => parse(fn, DocumentCommandResultSchema, data));

// B1
export function draftCreate(client: RpcClient, dealId: string, kind: DocumentKind, source: DraftSource, requestId: string) {
  return command(client, 'customer_document_draft_create', { p_deal_id: dealId, p_kind: kind, p_source: source, p_request_id: requestId });
}
// B2
export function refresh(client: RpcClient, documentId: string, expectedRowVersion: number, requestId: string) {
  return command(client, 'customer_document_refresh', { p_document_id: documentId, p_expected_row_version: expectedRowVersion, p_request_id: requestId });
}
// B3
export function release(client: RpcClient, documentId: string, expectedRowVersion: number, expectedContentSha256: string, requestId: string) {
  return command(client, 'customer_document_release', {
    p_document_id: documentId,
    p_expected_row_version: expectedRowVersion,
    p_expected_content_sha256: expectedContentSha256,
    p_request_id: requestId,
  });
}
// B4
export function discard(client: RpcClient, documentId: string, expectedRowVersion: number, reason: string, requestId: string) {
  return command(client, 'customer_document_discard', { p_document_id: documentId, p_expected_row_version: expectedRowVersion, p_reason: reason, p_request_id: requestId });
}
// B5
export function cancel(client: RpcClient, documentId: string, expectedRowVersion: number, reason: string, requestId: string) {
  return command(client, 'customer_document_cancel', { p_document_id: documentId, p_expected_row_version: expectedRowVersion, p_reason: reason, p_request_id: requestId });
}
// B6
export function replace(client: RpcClient, documentId: string, expectedRowVersion: number, reason: string, requestId: string) {
  return command(client, 'customer_document_replace', { p_document_id: documentId, p_expected_row_version: expectedRowVersion, p_reason: reason, p_request_id: requestId });
}
// B7
export function linkTally(client: RpcClient, documentId: string, tallyInvoiceId: string | null, expectedRowVersion: number, requestId: string) {
  return command(client, 'customer_document_link_tally', {
    p_document_id: documentId,
    p_tally_invoice_id: tallyInvoiceId,
    p_expected_row_version: expectedRowVersion,
    p_request_id: requestId,
  });
}
// B8
export async function renderRetry(client: RpcClient, documentId: string, requestId: string): Promise<RenderRetryResult> {
  const fn = 'customer_document_render_retry';
  return parse(fn, RetrySchema, await invoke(client, fn, { p_document_id: documentId, p_request_id: requestId }));
}
// B9
export async function setDocumentsEnabled(client: RpcClient, entityId: string, enabled: boolean, reason: string): Promise<DocumentsSwitchResult> {
  const fn = 'admin_set_customer_documents_enabled';
  return parse(fn, SwitchSchema, await invoke(client, fn, { p_entity: entityId, p_enabled: enabled, p_reason: reason }));
}
// Accounts phase 3, B1: automatic drafts and automatic release (finance policy managers).
export async function setAutoBills(client: RpcClient, entityId: string, drafts: boolean, release: boolean, reason: string): Promise<AutoBillsSwitchResult> {
  const fn = 'admin_set_auto_bills';
  return parse(fn, AutoBillsSwitchSchema, await invoke(client, fn, { p_entity: entityId, p_drafts: drafts, p_release: release, p_reason: reason }));
}
// B10 (audited, one row per call)
export async function authorizeDownload(client: RpcClient, documentId: string): Promise<DownloadAuthorization> {
  const fn = 'customer_document_authorize_download';
  return parse(fn, DownloadSchema, await invoke(client, fn, { p_document_id: documentId }));
}

// Reads (null = not allowed)
export async function readDealDocuments(client: RpcClient, dealId: string): Promise<DealDocuments | null> {
  const fn = 'deal_customer_documents';
  const data = await invoke(client, fn, { p_deal_id: dealId });
  return data === null ? null : parse(fn, DealDocumentsSchema, data);
}
export async function readDocument(client: RpcClient, documentId: string): Promise<DocumentDetail | null> {
  const fn = 'customer_document_get';
  const data = await invoke(client, fn, { p_document_id: documentId });
  return data === null ? null : parse(fn, DocumentDetailSchema, data);
}
export async function readDocumentList(client: RpcClient, filter: DocumentListFilter, after: string | null, limit = 50): Promise<DocumentList | null> {
  const fn = 'customer_documents_list';
  const data = await invoke(client, fn, { p_filter: filter, p_after: after, p_limit: limit });
  return data === null ? null : parse(fn, DocumentListSchema, data);
}
export async function readSettings(client: RpcClient, entityId: string): Promise<DocumentSettings | null> {
  const fn = 'admin_customer_documents_settings';
  const data = await invoke(client, fn, { p_entity: entityId });
  return data === null ? null : parse(fn, SettingsSchema, data);
}
