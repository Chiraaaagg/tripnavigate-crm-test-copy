import 'server-only';
import { z } from 'zod';
import type { RpcClient, RpcError } from '@/modules/fulfilment/commands';

/**
 * Typed wrappers for the voice-note batch customer (bill-to party) commands
 * and reads (migration 20261128000130; shapes: Atlas notes atlas-vn-shapes.md
 * section g and v2). Every call runs under the CALLER's own session; the
 * database authorizes. Replies are checked with zod; anything unexpected
 * throws VnDbError with code null (fail closed). Database text is never
 * surfaced: refusals map by the exact token and its SQLSTATE; the hint is kept
 * only when it is a plain list of input keys.
 *
 * VnDbError and callVn are shared by the hotel, import and destination
 * wrappers of the same batch.
 */

/** Refusal tokens of the batch and the only SQLSTATE each may arrive with. */
export const VN_ERROR_STATES = {
  not_authorized: '42501',
  version_changed: '40001',
  request_conflict: '40001',
  import_stale: '40001',
  not_found: 'P0002',
  invalid_input: '22023',
  consent_required: '22023',
  evidence_rejected: '22023',
  party_incomplete: '22023',
  party_count_mismatch: '22023',
  traveller_count_exceeded: '22023',
  import_too_large: '22023',
  party_checked: '55000',
  party_returned: '55000',
  party_doc_limit: '55000',
  billing_verified: '55000',
  deal_removed: '55000',
  deal_not_active: '55000',
  service_items_disabled: '55000',
  already_confirmed: '55000',
  wrong_state: '55000',
  import_not_validated: '55000',
  import_applied: '55000',
} as const;
export type VnErrorCode = keyof typeof VN_ERROR_STATES | 'not_configured' | 'session';

/** Refusals whose hint names input keys (or traveller types). */
const HINTED = new Set<string>(['invalid_input', 'party_incomplete', 'party_count_mismatch', 'traveller_count_exceeded']);
const HINT_KEYS = /^[A-Za-z0-9_.[\]]{1,60}(,[A-Za-z0-9_.[\]]{1,60}){0,30}$/;
const SESSION_STATES = new Set(['PGRST301', 'PGRST302', 'PGRST303', '401']);
const INPUT_STATES = new Set(['22023', '22P02', '22001', '22003', '22007', '22008', '23514', '23502']);
/** The settings reason rule raises this exact text (20261114000100). */
const REASON_MESSAGE = 'a reason of 10 to 500 characters is required';

export class VnDbError extends Error {
  override name = 'VnDbError';
  constructor(
    readonly command: string,
    /** The mapped refusal, 'session' for an ended JWT, or null for anything unexpected. */
    readonly code: VnErrorCode | null,
    readonly sqlState: string | null,
    /** Input keys from the database hint (hinted refusals only); never shown as text. */
    readonly hintKeys: string[] = [],
  ) {
    super(`${command} failed${sqlState ? ` (${sqlState})` : ''}${code ? `: ${code}` : ''}`);
  }
}

export function mapVnError(error: RpcError): { code: VnErrorCode | null; hintKeys: string[] } {
  const state = error.code ?? '';
  const token = (error.message ?? '').trim();
  const hint = (error.hint ?? '').trim();
  const keys = HINT_KEYS.test(hint) ? hint.split(',') : [];
  if (Object.hasOwn(VN_ERROR_STATES, token) && VN_ERROR_STATES[token as keyof typeof VN_ERROR_STATES] === state) {
    return { code: token as VnErrorCode, hintKeys: HINTED.has(token) ? keys : [] };
  }
  if (token === REASON_MESSAGE && state === '22023') return { code: 'invalid_input', hintKeys: ['reason'] };
  if (token === 'intake is not configured' && state === '55000') return { code: 'not_configured', hintKeys: [] };
  if (SESSION_STATES.has(state)) return { code: 'session', hintKeys: [] };
  if (state === '42501') return { code: 'not_authorized', hintKeys: [] };
  if (state === 'P0002') return { code: 'not_found', hintKeys: [] };
  if (INPUT_STATES.has(state)) return { code: 'invalid_input', hintKeys: [] };
  return { code: null, hintKeys: [] };
}

/** One RPC under the caller's session, its reply checked by `schema`. */
export async function callVn<T>(client: RpcClient, fn: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  let result: { data: unknown; error: RpcError | null };
  try {
    result = await client.rpc(fn, args);
  } catch {
    throw new VnDbError(fn, null, null);
  }
  if (result.error) {
    const mapped = mapVnError(result.error);
    throw new VnDbError(fn, mapped.code, result.error.code ?? null, mapped.hintKeys);
  }
  const parsed = schema.safeParse(result.data);
  if (!parsed.success) throw new VnDbError(fn, null, null);
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export const PARTY_TYPES = ['personal', 'business'] as const;
export const PARTY_CHECK_STATES = ['not_checked', 'checked', 'returned'] as const;
export const PARTY_DOCUMENT_KINDS = ['id_proof', 'gst_certificate', 'other'] as const;
export type PartyType = (typeof PARTY_TYPES)[number];
export type PartyCheckStatus = (typeof PARTY_CHECK_STATES)[number];
export type PartyDocumentKind = (typeof PARTY_DOCUMENT_KINDS)[number];

const Text = z.string().nullable();
const Uuid = z.uuid();

/** Field input of create / save / Accounts save (absent key = unchanged on a save). */
export interface PartyFields {
  partyType?: PartyType;
  name?: string;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  stateCode?: string | null;
  postalCode?: string | null;
  gstStatus?: 'registered' | 'unregistered' | null;
  gstin?: string | null;
  gstReason?: string | null;
}

export const PartySearchHitSchema = z.object({
  id: Uuid,
  partyType: z.enum(PARTY_TYPES),
  name: z.string(),
  city: Text,
  stateCode: Text,
  gstin: Text,
  checkStatus: z.enum(PARTY_CHECK_STATES),
  branchName: Text,
});
export type PartySearchHit = z.infer<typeof PartySearchHitSchema>;
const SearchSchema = z.object({ items: z.array(PartySearchHitSchema), hasMore: z.boolean() });
export type PartySearchResult = z.infer<typeof SearchSchema>;

export const PartyDocumentSchema = z.object({
  id: Uuid,
  kind: z.enum(PARTY_DOCUMENT_KINDS),
  fileName: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int(),
  status: z.enum(['pending_upload', 'stored', 'failed']),
  rowVersion: z.number().int(),
  createdAt: z.string(),
  uploadedByYou: z.boolean(),
});
export type PartyDocument = z.infer<typeof PartyDocumentSchema>;

export const PartyRecordSchema = z.object({
  id: Uuid,
  partyType: z.enum(PARTY_TYPES),
  name: z.string(),
  contactPerson: Text,
  phone: Text,
  email: Text,
  addressLine1: Text,
  addressLine2: Text,
  city: Text,
  stateCode: Text,
  postalCode: Text,
  gstStatus: z.enum(['registered', 'unregistered']).nullable(),
  gstin: Text,
  gstReason: Text,
  checkStatus: z.enum(PARTY_CHECK_STATES),
  checkReason: Text,
  checkedByName: Text,
  checkedAt: Text,
  sourceRef: Text,
  branchId: Uuid.nullable(),
  branchName: Text,
  rowVersion: z.number().int(),
  createdByName: Text,
  createdAt: z.string(),
  updatedAt: z.string(),
  documents: z.array(PartyDocumentSchema),
  /** Newest first, at most 50: actions, field names and reasons (never values). */
  history: z.array(z.object({
    action: z.string(),
    at: z.string(),
    byName: Text,
    byYou: z.boolean(),
    reason: Text,
    changedFields: z.array(z.string()),
    previousStatus: Text,
  })).default([]),
  /** Deals whose billing was copied from this party that the caller may open (no money). */
  usedOn: z.array(z.object({ dealId: Uuid, reference: Text, title: Text, branchName: Text, copiedAt: Text })).default([]),
  canEdit: z.boolean(),
  canAccountsEdit: z.boolean(),
  canCheck: z.boolean(),
});
export type PartyRecord = z.infer<typeof PartyRecordSchema>;

const QueueItemSchema = z.object({
  id: Uuid,
  partyType: z.enum(PARTY_TYPES),
  name: z.string(),
  city: Text,
  gstin: Text,
  checkStatus: z.enum(PARTY_CHECK_STATES),
  branchName: Text,
  createdByName: Text,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PartyQueueItem = z.infer<typeof QueueItemSchema>;
const QueueSchema = z.object({ items: z.array(QueueItemSchema), hasMore: z.boolean() });

const CreatedSchema = z.object({
  partyId: Uuid,
  rowVersion: z.number().int(),
  checkStatus: z.literal('not_checked'),
  outcome: z.enum(['created', 'existing']),
});
export type PartyCreated = z.infer<typeof CreatedSchema>;
const SavedSchema = z.object({
  rowVersion: z.number().int(),
  checkStatus: z.enum(PARTY_CHECK_STATES),
  outcome: z.enum(['updated', 'unchanged']),
});
export type PartySaved = z.infer<typeof SavedSchema>;

const SelectedSchema = z.object({
  rowVersion: z.number().int(),
  contentHash: z.string(),
  partyId: Uuid,
  billing: z.object({ outcome: z.string(), status: z.literal('draft'), rowVersion: z.number().int() }),
  outcome: z.literal('existing').optional(),
});
export type BillToPartySelected = z.infer<typeof SelectedSchema>;

const DocBeginSchema = z.object({
  fileId: Uuid,
  outcome: z.enum(['created', 'existing']),
  status: z.enum(['pending_upload', 'stored', 'failed', 'removed']),
  rowVersion: z.number().int(),
  objectPath: z.string().nullable(),
});
export type PartyDocumentBegun = z.infer<typeof DocBeginSchema>;
const DocStatusSchema = z.object({
  fileId: Uuid,
  status: z.enum(['pending_upload', 'stored', 'failed', 'removed']),
  rowVersion: z.number().int(),
});
const DownloadSchema = z.object({ objectPath: z.string().min(1), fileName: z.string(), mime: z.string() });

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Type-ahead (2+ characters; fewer answers no items). With dealId: that Deal's entity and branch, booking editors only. */
export function searchParties(
  client: RpcClient,
  args: { query: string; dealId?: string | null; limit?: number; offset?: number },
): Promise<PartySearchResult> {
  return callVn(client, 'customer_party_search', {
    p_query: args.query, p_deal_id: args.dealId ?? null, p_limit: args.limit ?? 20, p_offset: args.offset ?? 0,
  }, SearchSchema);
}

/** null = not readable by the caller (or no such party). */
export function getParty(client: RpcClient, partyId: string): Promise<PartyRecord | null> {
  return callVn(client, 'customer_party_get', { p_party_id: partyId }, PartyRecordSchema.nullable());
}

/** Accounts list by check state (null status = every state). */
export function accountsParties(
  client: RpcClient,
  args: { status: PartyCheckStatus | null; limit?: number; offset?: number },
): Promise<{ items: PartyQueueItem[]; hasMore: boolean }> {
  return callVn(client, 'customer_party_accounts_list', { p_status: args.status, p_limit: args.limit ?? 50, p_offset: args.offset ?? 0 },
    QueueSchema);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** A booking editor of the Deal creates a party in the Deal's entity and branch (not checked). Idempotent by request id. */
export function createParty(client: RpcClient, args: { dealId: string; fields: PartyFields; requestId: string }): Promise<PartyCreated> {
  return callVn(client, 'customer_party_create', { p_deal_id: args.dealId, p_fields: args.fields, p_request_id: args.requestId },
    CreatedSchema);
}

/** Sales / Manager edit (refused party_checked when checked; a returned party goes back to not_checked). */
export function saveParty(client: RpcClient, args: { partyId: string; expectedRowVersion: number; fields: PartyFields }): Promise<PartySaved> {
  return callVn(client, 'customer_party_save', {
    p_party_id: args.partyId, p_expected_row_version: args.expectedRowVersion, p_fields: args.fields,
  }, SavedSchema);
}

/** Accounts edit; the party goes back to not_checked. */
export function partyAccountsSave(
  client: RpcClient,
  args: { partyId: string; expectedRowVersion: number; fields: PartyFields; reason: string | null },
): Promise<PartySaved> {
  return callVn(client, 'customer_party_accounts_save', {
    p_party_id: args.partyId, p_expected_row_version: args.expectedRowVersion, p_fields: args.fields, p_reason: args.reason,
  }, SavedSchema);
}

/** Accounts: checked (full field rule, else party_incomplete) or returned (reason 10-500). */
export function checkParty(
  client: RpcClient,
  args: { partyId: string; expectedRowVersion: number; decision: 'checked' | 'returned'; reason: string | null },
): Promise<PartySaved> {
  return callVn(client, 'customer_party_check', {
    p_party_id: args.partyId, p_expected_row_version: args.expectedRowVersion, p_decision: args.decision, p_reason: args.reason,
  }, SavedSchema);
}

/** Copies the party into the Deal billing (snapshot) and keeps the reference. Idempotent by request id. */
export function selectBillToParty(
  client: RpcClient,
  args: { versionId: string; expectedRowVersion: number; partyId: string; billingExpectedRowVersion: number; requestId: string },
): Promise<BillToPartySelected> {
  return callVn(client, 'booking_bill_to_select_party', {
    p_version_id: args.versionId, p_expected_row_version: args.expectedRowVersion, p_party_id: args.partyId,
    p_billing_expected_row_version: args.billingExpectedRowVersion, p_request_id: args.requestId,
  }, SelectedSchema);
}

/** Starts one private upload (objectPath only while it waits for its upload). */
export function partyDocumentBegin(
  client: RpcClient,
  args: { partyId: string; kind: PartyDocumentKind; requestId: string; consent: boolean; fileName: string; mime: string; sizeBytes: number; sha256: string },
): Promise<PartyDocumentBegun> {
  return callVn(client, 'customer_party_document_begin', {
    p_party_id: args.partyId, p_kind: args.kind, p_request_id: args.requestId, p_consent: args.consent, p_file_name: args.fileName,
    p_mime: args.mime, p_size_bytes: args.sizeBytes, p_sha256: args.sha256,
  }, DocBeginSchema);
}

export function partyDocumentFinish(client: RpcClient, fileId: string, ok: boolean): Promise<z.infer<typeof DocStatusSchema>> {
  return callVn(client, 'customer_party_document_finish', { p_file_id: fileId, p_ok: ok }, DocStatusSchema);
}

export function partyDocumentRemove(client: RpcClient, fileId: string, expectedRowVersion: number): Promise<z.infer<typeof DocStatusSchema>> {
  return callVn(client, 'customer_party_document_remove', { p_file_id: fileId, p_expected_row_version: expectedRowVersion }, DocStatusSchema);
}

/** Authorizes one audited download (the server then signs a short URL with the secret key). */
export function partyDocumentAuthorizeDownload(client: RpcClient, fileId: string): Promise<z.infer<typeof DownloadSchema>> {
  return callVn(client, 'customer_party_document_authorize_download', { p_file_id: fileId }, DownloadSchema);
}
