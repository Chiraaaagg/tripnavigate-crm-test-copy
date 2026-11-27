import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getAppConfig } from '@/lib/config';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { asRpcClient, type RpcClient, type RpcError } from '@/modules/fulfilment/commands';
import { EVIDENCE_MAX_BYTES, EVIDENCE_MIME_TYPES } from '@/modules/fulfilment/contracts';
import { sniffEvidenceMime } from '@/modules/fulfilment/evidence';
import type { StaffContext } from '@/modules/identity/server/session';
import type { BitrixFileReader, BoxEntry, DownloadResult, ReadBoxResult } from '@/modules/integration/bitrix/file-store';
import { openBitrixFileReader } from '@/modules/integration/server/file-store-access';
import { fileUnavailableHtml } from '@/views/files/file-unavailable-page';

/**
 * S11 "files to Bitrix": one way to open a stored file (file 14 section 2.4,
 * file 11 section 2.5 item 5). The nine download handlers call deliverFile
 * instead of authorizing and signing themselves.
 *
 *   1. file_view_begin runs under the user's own session. The database calls
 *      the same authorize function the handler called before (same rule, same
 *      audit row) and answers where the file is: 'crm' or 'bitrix' plus a
 *      one-time view id. A refusal comes back to the caller unchanged, so the
 *      caller answers exactly as before (the same indistinguishable 404).
 *      A database that does not have file_view_begin yet (PostgREST PGRST202,
 *      Postgres 42883) falls back to the handler's own authorize command.
 *   2. CRM: the same 60-second signed URL and 302 as before, byte for byte.
 *   3. Bitrix: only after step 1 allowed it, the privileged client resolves the
 *      view id (once, within 60 seconds), the read-only Bitrix reader reads the
 *      Deal's file box and downloads that one file into memory, and the bytes
 *      must match the CRM's record (size, SHA-256 and the file type's leading
 *      bytes). The outcome is written under the user's session FIRST; only
 *      then the whole file is answered (200, never streamed, no ranges).
 *
 * Nothing is cached anywhere: not in memory between requests, not on disk,
 * not at the edge. Nothing here logs. No Bitrix deal id, file id, box key,
 * link or host is put in any answer, header or error.
 */

/** The seven file tables file_view_begin knows (a fixed list in the database too). */
export type FileViewSourceTable =
  | 'traveller_id_proofs'
  | 'department_evidence'
  | 'customer_party_documents'
  | 'finance_evidence'
  | 'refund_evidence'
  | 'supplier_money_evidence'
  | 'booking_evidence';

/** What the table's authorize function answers: where the CRM keeps the object and its recorded name and type. */
export interface AuthorizedFile {
  objectPath: string;
  fileName: string;
  mime: string;
}

export interface DeliverFileInput {
  /** The signed-in staff member (requireStaff() already ran). Only the user's own session client is used for begin and finish. */
  staff: Pick<StaffContext, 'supabase'>;
  sourceTable: FileViewSourceTable;
  /** The file row id (already checked to be a UUID by the handler). */
  sourceId: string;
  /** The private Storage bucket the handler signed from before. */
  bucket: string;
  /** Lifetime of the signed URL (60 seconds in every handler today). */
  signedUrlSeconds: number;
  /**
   * The download name, the same one today's signed URL uses for this handler
   * (the recorded name, or a neutral name such as `id-proof.jpg`). Null
   * refuses the file, as the handler's own answer check did before.
   */
  downloadName: (file: AuthorizedFile) => string | null;
  /** An extra check the handler made before (for example "the path ends in this file id"). False refuses the file. */
  accept?: (file: AuthorizedFile) => boolean;
  /** Today's authorize command for this table, used only on a database without file_view_begin. */
  legacyAuthorize: () => Promise<AuthorizedFile | null>;
  /** The handler's own "not available right now" answer, used when signing the CRM link fails (today's 503, unchanged). */
  crmUnavailable: () => Response;
}

/**
 * `response`: answer it as is (302 to the CRM copy, the file from Bitrix, or a
 * 503 page). `refused`: the database refused, failed or answered something
 * unexpected, or the handler's own check refused; the handler answers exactly
 * as it did before for that error.
 */
export type DeliverFileResult = { kind: 'response'; response: Response } | { kind: 'refused'; error: unknown };

/** A file_view_begin failure. Carries only the SQLSTATE (or PostgREST code); never any file detail. */
export class FileViewError extends Error {
  override name = 'FileViewError';
  constructor(readonly sqlState: string | null) {
    super(`file_view_begin failed${sqlState ? ` (${sqlState})` : ''}`);
  }
}

/** The states every handler treated as a plain refusal before: not allowed, not found, wrong state, ended session. */
const REFUSAL_STATES: ReadonlySet<string> = new Set(['42501', 'P0002', '55000', 'PGRST301', 'PGRST302', 'PGRST303', '401']);

/**
 * True when a refused deliverFile error is a refusal (the same 404), not a
 * temporary failure. For handlers that tell the two apart (finance, refunds).
 */
export function isFileViewRefusal(error: unknown): boolean {
  return error instanceof FileViewError && error.sqlState !== null && REFUSAL_STATES.has(error.sqlState);
}

/** True when the last path segment is this file id (case-insensitive), as the ID-proof and customer-document handlers check. */
export function objectPathEndsWith(objectPath: string, id: string): boolean {
  const parts = objectPath.toLowerCase().split('/');
  return parts[parts.length - 1] === id.toLowerCase();
}

/**
 * The rule the booking and department authorize answers were checked against
 * before (letters, digits, dot, space, underscore, dash; 1 to 120 characters).
 * Those handlers keep refusing any other recorded name, as before.
 */
export function isRecordedFileName(name: string): boolean {
  return name.length >= 1 && name.length <= 120 && /^[A-Za-z0-9._ -]+$/.test(name);
}

/** PostgREST "function not in the schema cache" or Postgres "undefined function": an older database. */
const FUNCTION_MISSING_STATES: ReadonlySet<string> = new Set(['PGRST202', '42883']);
/** file_view_begin's view limit (30 Bitrix-held files per person per minute). */
const VIEW_LIMIT_STATE = 'PT429';

/** One attempt at Bitrix, at most 15 seconds for reading the box and downloading the file together. */
export const BITRIX_VIEW_TIMEOUT_MS = 15_000;

/** Headers of today's CRM answers (302 and every refusal): kept exactly. */
const CRM_NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0', 'Referrer-Policy': 'no-referrer' } as const;

/** Headers on every answer of the Bitrix path. */
const BITRIX_NO_STORE = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
} as const;

const SafeText = (max: number) => z.string().min(1).max(max);

const BeginAnswerSchema = z.discriminatedUnion('location', [
  z.object({ location: z.literal('crm'), objectPath: SafeText(1024), fileName: SafeText(255), mime: SafeText(100) }),
  z.object({ location: z.literal('bitrix'), viewId: z.uuid(), objectPath: SafeText(1024), fileName: SafeText(255), mime: SafeText(100) }),
]);
type BeginAnswer = z.infer<typeof BeginAnswerSchema>;

const ResolveAnswerSchema = z.object({
  bitrixDealId: z.string().regex(/^[0-9]{1,20}$/),
  bitrixField: z.string().regex(/^ufCrm_[0-9A-Za-z_]{1,40}$/),
  bitrixFileId: z.string().regex(/^[0-9]{1,20}$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().positive().max(EVIDENCE_MAX_BYTES),
  mime: z.enum(EVIDENCE_MIME_TYPES),
});
type ResolveAnswer = z.infer<typeof ResolveAnswerSchema>;

type FinishOutcome = 'served' | 'bitrix_unavailable' | 'mismatch' | 'not_found_in_bitrix' | 'deal_not_found';

async function callRpc(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: RpcError | null }> {
  const reply = await client.rpc(fn, args);
  // A client that answers nothing usable is treated like any other unexpected failure.
  if (!reply || typeof reply !== 'object') throw new FileViewError(null);
  return { data: reply.data, error: reply.error ?? null };
}

type BeginResult = { kind: 'ok'; answer: BeginAnswer } | { kind: 'missing' } | { kind: 'error'; error: FileViewError };

async function beginView(staff: DeliverFileInput['staff'], sourceTable: FileViewSourceTable, sourceId: string): Promise<BeginResult> {
  let reply;
  try {
    reply = await callRpc(asRpcClient(staff.supabase), 'file_view_begin', { p_source_table: sourceTable, p_source_id: sourceId });
  } catch {
    return { kind: 'error', error: new FileViewError(null) };
  }
  if (reply.error) {
    const state = typeof reply.error.code === 'string' ? reply.error.code : null;
    if (state !== null && FUNCTION_MISSING_STATES.has(state)) return { kind: 'missing' };
    return { kind: 'error', error: new FileViewError(state) };
  }
  const parsed = BeginAnswerSchema.safeParse(reply.data);
  return parsed.success ? { kind: 'ok', answer: parsed.data } : { kind: 'error', error: new FileViewError(null) };
}

/** Writes the view outcome under the user's own session. True only when the database confirmed exactly this outcome. */
async function finishView(staff: DeliverFileInput['staff'], viewId: string, outcome: FinishOutcome): Promise<boolean> {
  try {
    const reply = await callRpc(asRpcClient(staff.supabase), 'file_view_finish', { p_view_id: viewId, p_outcome: outcome });
    if (reply.error) return false;
    const parsed = z.object({ outcome: z.literal(outcome) }).safeParse(reply.data);
    return parsed.success;
  } catch {
    return false;
  }
}

/** Resolves the view with the privileged client (only after file_view_begin allowed it). Null on any failure. */
async function resolveView(viewId: string): Promise<ResolveAnswer | null> {
  try {
    const reply = await callRpc(asRpcClient(createSupabaseAdminClient()), 'file_view_resolve', { p_view_id: viewId });
    if (reply.error) return null;
    const parsed = ResolveAnswerSchema.safeParse(reply.data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Today's CRM path, unchanged: sign for the configured Supabase origin only, then 302. */
async function crmRedirect(input: DeliverFileInput, file: AuthorizedFile, downloadName: string): Promise<Response> {
  let signedUrl: string | null = null;
  try {
    const { data, error } = await createSupabaseAdminClient()
      .storage.from(input.bucket)
      .createSignedUrl(file.objectPath, input.signedUrlSeconds, { download: downloadName });
    signedUrl = error ? null : (data?.signedUrl ?? null);
  } catch {
    signedUrl = null;
  }
  // Redirect only to the configured Supabase origin (never to an arbitrary host).
  const expectedOrigin = new URL(getAppConfig().supabaseUrl).origin;
  if (!signedUrl || new URL(signedUrl, expectedOrigin).origin !== expectedOrigin) {
    return input.crmUnavailable();
  }
  return new Response(null, { status: 302, headers: { ...CRM_NO_STORE, Location: new URL(signedUrl, expectedOrigin).toString() } });
}

/** The 503 page for a Bitrix-held file (texts owned by the UI slice). Inline styles only; no script may run. */
function unavailablePage(kind: 'bitrix_unavailable' | 'needs_attention', extra: Record<string, string> = {}): Response {
  return new Response(fileUnavailableHtml(kind), {
    status: 503,
    headers: {
      ...BITRIX_NO_STORE,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      ...extra,
    },
  });
}

/**
 * `attachment` with the same name today's signed URL uses. Recorded names are
 * already limited to letters, digits, dot, space, underscore and dash at
 * upload; anything else is replaced in the plain name and also given in the
 * RFC 5987 form so the browser can still show it.
 */
export function attachmentDisposition(name: string): string {
  const plain = name.replace(/[^A-Za-z0-9._ -]/g, '_');
  if (plain === name) return `attachment; filename="${plain}"`;
  return `attachment; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

const TIMED_OUT = Symbol('timed_out');

/** Resolves to TIMED_OUT when the deadline passes first. The timer never outlives the call. */
async function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T | typeof TIMED_OUT> {
  const left = deadline - Date.now();
  if (left <= 0) return TIMED_OUT;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), left);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type BitrixRead =
  | { kind: 'ok'; bytes: Uint8Array }
  | { kind: 'fail'; outcome: Exclude<FinishOutcome, 'served'> };

/** Reads the box and downloads the one file. Every Bitrix detail stays inside this function. */
async function readFromBitrix(reader: BitrixFileReader, resolved: ResolveAnswer, file: AuthorizedFile): Promise<BitrixRead> {
  const deadline = Date.now() + BITRIX_VIEW_TIMEOUT_MS;

  let box: ReadBoxResult | typeof TIMED_OUT;
  try {
    box = await beforeDeadline(reader.readBox(resolved.bitrixDealId, resolved.bitrixField), deadline);
  } catch {
    // FileStoreError (unavailable, rate limited, sign-in problem) or anything unexpected.
    return { kind: 'fail', outcome: 'bitrix_unavailable' };
  }
  if (box === TIMED_OUT) return { kind: 'fail', outcome: 'bitrix_unavailable' };
  if (box.kind === 'deal_not_found') return { kind: 'fail', outcome: 'deal_not_found' };
  if (box.kind !== 'ok') return { kind: 'fail', outcome: 'bitrix_unavailable' };

  const entry: BoxEntry | undefined = box.entries.find((e) => String(e.id) === resolved.bitrixFileId);
  if (!entry) return { kind: 'fail', outcome: 'not_found_in_bitrix' };

  let download: DownloadResult | typeof TIMED_OUT;
  try {
    // Capped at the recorded size: a bigger file cannot be ours.
    download = await beforeDeadline(reader.downloadEntry(entry, resolved.sizeBytes), deadline);
  } catch {
    return { kind: 'fail', outcome: 'bitrix_unavailable' };
  }
  if (download === TIMED_OUT) return { kind: 'fail', outcome: 'bitrix_unavailable' };
  if (download.kind !== 'ok') {
    // Bitrix did not answer in time or answered an HTTP error: try again later.
    // Anything else (no link, another host, a redirect, not a file, too large)
    // means the box does not hold our file as recorded: never served, flagged.
    return { kind: 'fail', outcome: download.code === 'timeout' || download.code === 'http_error' ? 'bitrix_unavailable' : 'mismatch' };
  }

  // Never trust a size or hash reported by anyone else: measure the bytes here.
  const bytes = download.bytes;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const sameFile =
    bytes.byteLength === resolved.sizeBytes &&
    download.sizeBytes === resolved.sizeBytes &&
    sha256 === resolved.sha256 &&
    download.sha256.toLowerCase() === resolved.sha256 &&
    resolved.mime === file.mime &&
    sniffEvidenceMime(bytes) === file.mime;
  if (!sameFile) return { kind: 'fail', outcome: 'mismatch' };
  return { kind: 'ok', bytes };
}

async function bitrixAnswer(input: DeliverFileInput, file: AuthorizedFile, viewId: string, downloadName: string): Promise<Response> {
  const resolved = await resolveView(viewId);
  if (!resolved) {
    await finishView(input.staff, viewId, 'bitrix_unavailable');
    return unavailablePage('bitrix_unavailable');
  }

  let reader: BitrixFileReader | null;
  try {
    reader = await openBitrixFileReader({ timeoutMs: BITRIX_VIEW_TIMEOUT_MS });
  } catch {
    reader = null;
  }
  if (!reader) {
    await finishView(input.staff, viewId, 'bitrix_unavailable');
    return unavailablePage('bitrix_unavailable');
  }

  const read = await readFromBitrix(reader, resolved, file);
  if (read.kind === 'fail') {
    await finishView(input.staff, viewId, read.outcome);
    return unavailablePage(read.outcome === 'bitrix_unavailable' ? 'bitrix_unavailable' : 'needs_attention');
  }

  // The outcome is recorded before a single byte leaves; if it cannot be recorded, nothing is served.
  if (!(await finishView(input.staff, viewId, 'served'))) return unavailablePage('bitrix_unavailable');

  // The whole body with its length (never streamed, no ranges); a private copy of the bytes for this answer only.
  const body = new ArrayBuffer(read.bytes.byteLength);
  new Uint8Array(body).set(read.bytes);
  return new Response(body, {
    status: 200,
    headers: {
      ...BITRIX_NO_STORE,
      'Content-Type': file.mime,
      'Content-Length': String(body.byteLength),
      'Content-Disposition': attachmentDisposition(downloadName),
      'Content-Security-Policy': "sandbox; default-src 'none'",
    },
  });
}

/** Opens one stored file for the signed-in staff member. See the module comment for the full sequence. */
export async function deliverFile(input: DeliverFileInput): Promise<DeliverFileResult> {
  const begun = await beginView(input.staff, input.sourceTable, input.sourceId);

  let file: AuthorizedFile;
  let viewId: string | null = null;
  if (begun.kind === 'missing') {
    // Older database: today's authorize command decides, and the file is in the CRM.
    let legacy: AuthorizedFile | null;
    try {
      legacy = await input.legacyAuthorize();
    } catch (error) {
      return { kind: 'refused', error };
    }
    if (!legacy) return { kind: 'refused', error: null };
    file = legacy;
  } else if (begun.kind === 'error') {
    // The view limit is reached only after the person was allowed to open the file: say "try again".
    if (begun.error.sqlState === VIEW_LIMIT_STATE) return { kind: 'response', response: unavailablePage('bitrix_unavailable', { 'Retry-After': '60' }) };
    return { kind: 'refused', error: begun.error };
  } else {
    file = { objectPath: begun.answer.objectPath, fileName: begun.answer.fileName, mime: begun.answer.mime };
    if (begun.answer.location === 'bitrix') viewId = begun.answer.viewId;
  }

  if (input.accept && !input.accept(file)) return { kind: 'refused', error: null };
  const downloadName = input.downloadName(file);
  if (!downloadName) return { kind: 'refused', error: null };

  if (viewId === null) return { kind: 'response', response: await crmRedirect(input, file, downloadName) };
  return { kind: 'response', response: await bitrixAnswer(input, file, viewId, downloadName) };
}
