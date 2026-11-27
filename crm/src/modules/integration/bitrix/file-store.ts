import { createHash } from 'node:crypto';
import { BitrixClientError, createBitrixClient } from './client';
import type { BitrixRestTarget } from './config';
import {
  BitrixWriteError,
  DEAL_ENTITY_TYPE_ID,
  FILE_MAX_REDIRECTS,
  ID_PROOF_ITEM_FIELD,
  NOT_A_FILE_CONTENT_TYPE,
  fieldFileEntries,
  fieldFileIds,
} from './id-proof-copy';

/**
 * S11 "files to Bitrix": the one adapter that names Bitrix methods for the
 * file move and the view path. Contract: hosting-migration file 14 (wins) and
 * file 11 sections 2.5 and 2.7.
 *
 * Methods: crm.item.get (read a Deal's file box, through the existing
 * read-only client) and crm.item.update (append one file to one box). The
 * file itself is read through the entry's urlMachine link.
 *
 * Hard limits enforced here (unit-tested with a mock portal only):
 *   - writes go to a Deal (entityTypeId 2) only, to exactly ONE of two
 *     allowlisted boxes per request: the identity box (ufCrm_1784359513, the
 *     DEC-43 field) or the configured Accounts box; never a third field;
 *   - append, never replace: every file id the box held is sent again as
 *     {id}, and the new file is the last entry as [name, base64];
 *   - file names are neutral (id-<sha8>.<ext>, acc-<kind>-<sha8>.<ext>):
 *     never a customer, supplier or original file name;
 *   - a download always reads the bytes and hashes them; a size that Bitrix
 *     shows with the entry is never trusted;
 *   - a download link must be on the portal host, redirects are followed by
 *     hand (at most 3, same host only), text/JSON/XML answers are not a file,
 *     and at most maxBytes are read, in memory;
 *   - urlMachine carries its own access token and the webhook base URL is a
 *     credential: neither is ever logged, stored, put in an error or returned.
 *     Errors carry fixed codes only.
 *
 * This file does not change id-proof-copy.ts (DEC-43); it reuses its checks
 * by import.
 */

/** Item-API key of the identity box "Aadhar and Passports" (same field as DEC-43). */
export const IDENTITY_BOX = ID_PROOF_ITEM_FIELD;
/** Shape of an item-API key of a Deal file box (the Accounts box is set by the Super Admin). */
export const BOX_KEY_PATTERN = /^ufCrm_[0-9A-Za-z_]{1,40}$/;
export const FILE_WRITE_METHODS = ['crm.item.update'] as const;
export type FileWriteMethod = (typeof FILE_WRITE_METHODS)[number];

export const FILE_READ_TIMEOUT_MS = 10_000;
export const FILE_DOWNLOAD_TIMEOUT_MS = 10_000;
export const FILE_WRITE_TIMEOUT_MS = 20_000;
/** Longest urlMachine link accepted (a longer value is not a link Bitrix documents). */
const MAX_LINK_LENGTH = 2_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEAL_ID = /^[1-9]\d{0,15}$/;

/** One entry of a box: its id and whatever Bitrix returned with it. raw holds urlMachine: never log it. */
export interface BoxEntry {
  id: number;
  raw: Record<string, unknown> | null;
}

export type ReadBoxResult = { kind: 'ok'; entries: BoxEntry[] } | { kind: 'deal_not_found' };

export type UnreadableCode = 'no_link' | 'other_host' | 'redirect' | 'not_a_file' | 'too_large' | 'http_error' | 'timeout';

export type DownloadResult =
  | { kind: 'ok'; bytes: Uint8Array; sha256: string; sizeBytes: number }
  | { kind: 'unreadable'; code: UnreadableCode };

export type FileStoreErrorKind = 'unavailable' | 'rate_limited' | 'auth';

/** A box could not be read. Codes only: never a URL, a body or Bitrix text. */
export class FileStoreError extends Error {
  override name = 'FileStoreError';
  constructor(
    readonly kind: FileStoreErrorKind,
    readonly code: string,
  ) {
    super(`Bitrix file store ${kind}: ${code}`);
  }
}

export interface BitrixFileReader {
  /** The box of one Deal through crm.item.get. Throws FileStoreError. */
  readBox(bitrixDealId: string, box: string): Promise<ReadBoxResult>;
  /** The bytes of one entry, hashed. Never throws. */
  downloadEntry(entry: BoxEntry, maxBytes: number): Promise<DownloadResult>;
}

export interface BitrixFileReaderOptions {
  /** READ webhook target. */
  target: BitrixRestTarget;
  fetchImpl?: typeof fetch;
  /** Per crm.item.get request. */
  readTimeoutMs?: number;
  /** Per download, all redirect hops included. */
  downloadTimeoutMs?: number;
  /** Rate-limit retries inside the client (default 0: the database backs off instead). */
  maxRateLimitRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function storeErrorFrom(error: unknown): FileStoreError {
  if (error instanceof BitrixClientError) {
    if (error.code === 'provider_rate_limited') return new FileStoreError('rate_limited', 'bitrix_rate_limited');
    if (error.code === 'provider_auth_failed') return new FileStoreError('auth', 'bitrix_auth_failed');
    if (error.code === 'provider_timeout') return new FileStoreError('unavailable', 'bitrix_timeout');
    if (error.code === 'provider_bad_response') return new FileStoreError('unavailable', 'bitrix_bad_response');
    return new FileStoreError('unavailable', 'bitrix_unavailable');
  }
  if (error instanceof FileStoreError) return error;
  return new FileStoreError('unavailable', 'bitrix_unavailable');
}

export function createBitrixFileReader(options: BitrixFileReaderOptions): BitrixFileReader {
  const fetchImpl = options.fetchImpl ?? fetch;
  const downloadTimeoutMs = options.downloadTimeoutMs ?? FILE_DOWNLOAD_TIMEOUT_MS;
  const origin = new URL(options.target.baseUrl).origin;
  const client = createBitrixClient({
    target: options.target,
    fetchImpl,
    timeoutMs: options.readTimeoutMs ?? FILE_READ_TIMEOUT_MS,
    maxRateLimitRetries: options.maxRateLimitRetries ?? 0,
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });

  async function readBox(bitrixDealId: string, box: string): Promise<ReadBoxResult> {
    if (!DEAL_ID.test(bitrixDealId) || !Number.isSafeInteger(Number(bitrixDealId)) || !BOX_KEY_PATTERN.test(box)) {
      throw new FileStoreError('unavailable', 'invalid_input');
    }
    let result: unknown;
    try {
      // The client's generic call (crm.item.get is allowlisted for Deals only).
      // getDealItemField is not used because its key check accepts digits
      // only, and the Accounts box key may contain letters.
      ({ result } = await client.call('crm.item.get', { entityTypeId: DEAL_ENTITY_TYPE_ID, id: Number(bitrixDealId), useOriginalUfNames: 'N' }));
    } catch (error) {
      // crm.item.get documents a missing item as HTTP 400 NOT_FOUND.
      if (error instanceof BitrixClientError && (error.httpStatus === 400 || error.httpStatus === 404) && error.providerCode === 'NOT_FOUND') {
        return { kind: 'deal_not_found' };
      }
      throw storeErrorFrom(error);
    }
    const item = result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>).item : null;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new FileStoreError('unavailable', 'bitrix_bad_response');
    const record = item as Record<string, unknown>;
    // The answer must be for this Deal and must show the box: a missing key is
    // never read as an empty box (an append from that reading would drop files).
    if (String(record.id) !== bitrixDealId || !Object.prototype.hasOwnProperty.call(record, box)) {
      throw new FileStoreError('unavailable', 'bitrix_bad_response');
    }
    // Only this box is kept; everything else in the item is dropped here.
    return { kind: 'ok', entries: fieldFileEntries({ [box]: record[box] }, box) };
  }

  async function downloadEntry(entry: BoxEntry, maxBytes: number): Promise<DownloadResult> {
    const link = entry.raw?.urlMachine;
    if (typeof link !== 'string' || link.length === 0 || link.length > MAX_LINK_LENGTH) return { kind: 'unreadable', code: 'no_link' };
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return { kind: 'unreadable', code: 'too_large' };
    let url: URL;
    try {
      url = new URL(link, origin);
    } catch {
      return { kind: 'unreadable', code: 'no_link' };
    }
    if (url.origin !== origin) return { kind: 'unreadable', code: 'other_host' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), downloadTimeoutMs);
    try {
      let res: Response | null = null;
      for (let hop = 0; ; hop += 1) {
        // Redirects one hop at a time, so a hop to another host is never requested.
        res = await fetchImpl(url.toString(), { method: 'GET', redirect: 'manual', signal: controller.signal, cache: 'no-store' });
        if (!REDIRECT_STATUSES.has(res.status)) break;
        await res.body?.cancel().catch(() => undefined);
        const location = res.headers.get('location');
        if (!location || hop >= FILE_MAX_REDIRECTS) return { kind: 'unreadable', code: 'redirect' };
        try {
          url = new URL(location, url);
        } catch {
          return { kind: 'unreadable', code: 'redirect' };
        }
        if (url.origin !== origin) return { kind: 'unreadable', code: 'other_host' };
      }
      if (!res || res.status !== 200 || !res.body) {
        await res?.body?.cancel().catch(() => undefined);
        return { kind: 'unreadable', code: 'http_error' };
      }
      if (NOT_A_FILE_CONTENT_TYPE.test(res.headers.get('content-type') ?? '')) {
        await res.body.cancel().catch(() => undefined);
        return { kind: 'unreadable', code: 'not_a_file' };
      }
      const reader = res.body.getReader();
      const parts: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          return { kind: 'unreadable', code: 'too_large' };
        }
        parts.push(value);
      }
      const bytes = new Uint8Array(total);
      let at = 0;
      for (const part of parts) {
        bytes.set(part, at);
        at += part.byteLength;
      }
      // The size is the number of bytes read, never a size Bitrix reported.
      return { kind: 'ok', bytes, sha256: sha256Hex(bytes), sizeBytes: total };
    } catch {
      return { kind: 'unreadable', code: controller.signal.aborted ? 'timeout' : 'http_error' };
    } finally {
      clearTimeout(timer);
    }
  }

  return { readBox, downloadEntry };
}

// ---------------------------------------------------------------------------
// Neutral file names
// ---------------------------------------------------------------------------

export const FILE_MIME_EXT: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** kindCode the database returns: `id` for identity papers, the others for Accounts papers. */
export const ACCOUNTS_KIND_CODES = ['bank', 'chq', 'dep', 'rfd', 'pro', 'pay', 'inv', 'cn', 'bill', 'fee', 'dpp'] as const;
export type FileKindCode = 'id' | (typeof ACCOUNTS_KIND_CODES)[number];

const IDENTITY_NAME = /^id-[0-9a-f]{8}\.(?:pdf|jpg|png|webp)$/;
const ACCOUNTS_NAME = new RegExp(`^acc-(?:${ACCOUNTS_KIND_CODES.join('|')})-[0-9a-f]{8}\\.(?:pdf|jpg|png|webp)$`);

/** id-<sha8>.<ext> for identity papers, acc-<kind>-<sha8>.<ext> for Accounts papers. Throws on anything else. */
export function neutralBoxFileName(kindCode: string, sha256: string, mime: string): string {
  const ext = FILE_MIME_EXT[mime];
  if (!ext || !/^[0-9a-f]{64}$/.test(sha256)) throw new BitrixWriteError('refused', 'name_not_allowed');
  if (kindCode === 'id') return `id-${sha256.slice(0, 8)}.${ext}`;
  if ((ACCOUNTS_KIND_CODES as readonly string[]).includes(kindCode)) return `acc-${kindCode}-${sha256.slice(0, 8)}.${ext}`;
  throw new BitrixWriteError('refused', 'name_not_allowed');
}

// ---------------------------------------------------------------------------
// Append (the one write)
// ---------------------------------------------------------------------------

export interface BoxAppendPayload {
  entityTypeId: typeof DEAL_ENTITY_TYPE_ID;
  id: number;
  fields: Record<string, Array<{ id: number } | [string, string]>>;
}

/** The one request body the writer sends: every prior file kept by id, the new file last. */
export function buildBoxAppendPayload(bitrixDealId: string, box: string, priorFileIds: number[], fileName: string, base64: string): BoxAppendPayload {
  if (!DEAL_ID.test(bitrixDealId) || !Number.isSafeInteger(Number(bitrixDealId))) throw new BitrixWriteError('refused', 'body_invalid');
  return {
    entityTypeId: DEAL_ENTITY_TYPE_ID,
    id: Number(bitrixDealId),
    fields: { [box]: [...priorFileIds.map((id) => ({ id })), [fileName, base64]] },
  };
}

const isNewFile = (v: unknown): v is [string, string] =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' && v[0].length > 0 && v[1].length > 0;
const isKeptFile = (v: unknown): v is { id: number } =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).join(',') === 'id' &&
  Number.isSafeInteger((v as { id: unknown }).id) &&
  (v as { id: number }).id > 0;

/**
 * The allowlist: the identity box always; the Accounts box only when it is a
 * well-formed key different from the identity box. Never more than two.
 */
export function allowedBoxes(accountsBox: string | null): string[] {
  return accountsBox && BOX_KEY_PATTERN.test(accountsBox) && accountsBox !== IDENTITY_BOX ? [IDENTITY_BOX, accountsBox] : [IDENTITY_BOX];
}

/**
 * Like DEC-43's assertAllowedWrite, for the chosen box: crm.item.update on a
 * Deal, exactly one field which is one of the allowed boxes, every entry a
 * kept file {id} (each id once) or the one new file [name, base64] as the
 * last entry, and a neutral name that fits the box (id- in the identity box,
 * acc- in the Accounts box).
 */
export function assertAllowedBoxWrite(method: string, body: unknown, boxes: readonly string[]): asserts body is BoxAppendPayload {
  if (!(FILE_WRITE_METHODS as readonly string[]).includes(method)) throw new BitrixWriteError('refused', 'method_not_allowed');
  if (boxes.length < 1 || boxes.length > 2 || boxes[0] !== IDENTITY_BOX || boxes.some((b) => !BOX_KEY_PATTERN.test(b)) || new Set(boxes).size !== boxes.length) {
    throw new BitrixWriteError('refused', 'field_not_allowed');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BitrixWriteError('refused', 'body_invalid');
  const b = body as Record<string, unknown>;
  if (Object.keys(b).sort().join(',') !== 'entityTypeId,fields,id') throw new BitrixWriteError('refused', 'body_invalid');
  if (b.entityTypeId !== DEAL_ENTITY_TYPE_ID) throw new BitrixWriteError('refused', 'entity_not_allowed');
  if (!Number.isSafeInteger(b.id) || (b.id as number) <= 0) throw new BitrixWriteError('refused', 'body_invalid');
  const fields = b.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new BitrixWriteError('refused', 'field_not_allowed');
  const keys = Object.keys(fields);
  if (keys.length !== 1 || !boxes.includes(keys[0]!)) throw new BitrixWriteError('refused', 'field_not_allowed');
  const box = keys[0]!;
  const value = (fields as Record<string, unknown>)[box];
  if (!Array.isArray(value) || value.length === 0) throw new BitrixWriteError('refused', 'body_invalid');
  const news = value.filter(isNewFile);
  const kept = value.filter(isKeptFile);
  const last = value[value.length - 1];
  if (news.length !== 1 || kept.length + news.length !== value.length || !isNewFile(last)) throw new BitrixWriteError('refused', 'body_invalid');
  if (new Set(kept.map((k) => k.id)).size !== kept.length) throw new BitrixWriteError('refused', 'body_invalid');
  const name = last[0];
  if (!(box === IDENTITY_BOX ? IDENTITY_NAME : ACCOUNTS_NAME).test(name)) throw new BitrixWriteError('refused', 'name_not_allowed');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(last[1])) throw new BitrixWriteError('refused', 'body_invalid');
}

export interface BitrixFileWriter {
  /**
   * Sends the one update. Returns the file ids of the box in Bitrix's reply
   * (crm.item.update answers with the whole item), or null when the reply
   * does not show the box. Throws BitrixWriteError (codes only):
   *   refused: nothing was applied (own check, or an explicit Bitrix error);
   *   lost: the request may have been applied (read back, never resend blindly);
   *   rate_limited, auth.
   */
  appendToBox(input: { bitrixDealId: string; box: string; priorFileIds: number[]; fileName: string; base64: string }): Promise<{ replyFileIds: number[] | null }>;
}

export function createBitrixFileWriter(options: {
  /** WRITE webhook target (BITRIX_WRITE_WEBHOOK_BASE_URL). */
  target: BitrixRestTarget;
  /** The configured Accounts box, or null (identity box only). */
  accountsBox: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): BitrixFileWriter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? FILE_WRITE_TIMEOUT_MS;
  const boxes = allowedBoxes(options.accountsBox);
  return {
    async appendToBox(input) {
      const method: FileWriteMethod = 'crm.item.update';
      const body = buildBoxAppendPayload(input.bitrixDealId, input.box, input.priorFileIds, input.fileName, input.base64);
      assertAllowedBoxWrite(method, body, boxes);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(`${options.target.baseUrl}${method}.json`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
          redirect: 'error',
          signal: controller.signal,
          cache: 'no-store',
        });
      } catch {
        // The request may have reached Bitrix: the outcome is unknown.
        throw new BitrixWriteError('lost', controller.signal.aborted ? 'timeout' : 'network');
      } finally {
        clearTimeout(timer);
      }
      let answer: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = await res.json();
        answer = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
      } catch {
        answer = null;
      }
      const code = answer && typeof answer.error === 'string' ? answer.error : null;
      if (res.status === 429 || code === 'QUERY_LIMIT_EXCEEDED' || code === 'OPERATION_TIME_LIMIT') throw new BitrixWriteError('rate_limited', 'rate_limited');
      if (res.status === 401 || res.status === 403 || (code && /^(NO_AUTH_FOUND|INVALID_CREDENTIALS|insufficient_scope|expired_token|ACCESS_DENIED)$/.test(code))) {
        throw new BitrixWriteError('auth', 'auth_failed');
      }
      if (res.status >= 500 || !answer) throw new BitrixWriteError('lost', res.status >= 500 ? 'http_server_error' : 'http_unreadable');
      if (res.status !== 200 || code) throw new BitrixWriteError('refused', 'bitrix_refused');
      const result = answer.result as Record<string, unknown> | null | undefined;
      const item = result && typeof result === 'object' ? (result.item as Record<string, unknown> | null | undefined) : null;
      // A 200 answer without the expected item may still have applied the update.
      if (!item || typeof item !== 'object') throw new BitrixWriteError('lost', 'reply_unexpected');
      if (String(item.id) !== input.bitrixDealId) throw new BitrixWriteError('lost', 'reply_mismatch');
      return { replyFileIds: Object.prototype.hasOwnProperty.call(item, input.box) ? fieldFileIds(item, input.box) : null };
    },
  };
}
