import type { IntakeErrorCode } from '../contracts';
import type { BitrixRestTarget } from './config';

/**
 * B1.2 DEC-43: copy a stored traveller identity proof to the linked Bitrix
 * Deal's field "Aadhar and Passports" (UF_CRM_1784359513, file, multiple).
 * The ONLY Bitrix write the CRM makes.
 *
 * Hard limits, enforced here and tested with a mock portal only:
 *   - one method: crm.item.update with entityTypeId 2 (Deal); one field:
 *     ufCrm_1784359513 (item-API key of UF_CRM_1784359513); no record or
 *     field is ever created;
 *   - append, never replace: the request lists every file id the field held
 *     (read just before through crm.item.get, see below) as {id} and adds the
 *     new file as [name, base64]; files left out of a multiple file field are
 *     deleted by Bitrix, so the prior ids are always sent, checked in the
 *     reply (which carries the whole item) and checked again by a read-back;
 *   - separate credential: BITRIX_WRITE_WEBHOOK_BASE_URL (server env only;
 *     never logged, never in an error);
 *   - a lost answer is "unknown" and is resolved by reading the field back,
 *     never by sending again blindly.
 *
 * Method (lead decision, 13 Oct 2026, following Bitrix's public docs):
 * crm.item.update. Bitrix recommends it for file fields and documents the
 * keep-by-{id} plus [name, base64] shape for it; crm.deal.update is no longer
 * developed. The owner approved the field (DEC-43/DEC-47); the method is
 * within that scope. The item-API key was confirmed by one read-only
 * crm.item.fields call (13 Oct 2026). A one-off check on a test Deal holding
 * two dummy files stays part of the activation approval (the reply check and
 * the read-back below stop on any loss).
 *
 * Review E7 (Echo, 13 Oct 2026):
 *   - E7-1 circuit breaker: when a read shows that a file the field held
 *     before is gone, the worker stops at once: the job fails, the switch goes
 *     off and an alert opens (deps.stop -> bitrix_id_proof_copy_stop); the
 *     batch ends.
 *   - E7-2: the CRM file is downloaded and checked first; the field is read
 *     immediately before the write. The claim hands out one job per Deal and
 *     none for a Deal with another job in flight; the worker claims one job at
 *     a time (one lease per job).
 *   - E7-3: a new file id counts as this job's file only when its facts match:
 *     the content hash when the file can be read, otherwise the size and, when
 *     Bitrix shows a name, the hash part of the neutral name. A guess is never
 *     marked sent.
 *
 * Read path (13 Oct 2026 live probe): the field is read through crm.item.get
 * (entityTypeId 2, key ufCrm_1784359513) with the READ webhook. Its file
 * entries are {id, url, urlMachine}; urlMachine carries its own access token
 * and is the link Bitrix documents for server-side download. crm.deal.get
 * returned only {id, showUrl, downloadUrl}, browser-session links that a
 * webhook caller cannot download, so the worker could never recognise its own
 * file (every read-back ended file_facts_unavailable). urlMachine embeds a
 * credential: it is never logged, stored, put in an error, an audit row or an
 * answer.
 */

/** The field's original Bitrix name (crm.deal.* and the Bitrix field settings). */
export const ID_PROOF_FIELD = 'UF_CRM_1784359513';
/** The same field under the item API: read (crm.item.get), write (crm.item.update) and its reply. */
export const ID_PROOF_ITEM_FIELD = 'ufCrm_1784359513';
export const DEAL_ENTITY_TYPE_ID = 2;
export const ID_PROOF_WRITE_METHODS = ['crm.item.update'] as const;
export type IdProofWriteMethod = (typeof ID_PROOF_WRITE_METHODS)[number];
export const ID_PROOF_WRITE_TIMEOUT_MS = 30_000;

const MIME_EXT: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** A neutral file name for Bitrix (no traveller name, no original file name). */
export function neutralFileName(travellerSeq: number, sha256: string, mime: string): string {
  const ext = MIME_EXT[mime] ?? 'bin';
  return `traveller-${travellerSeq}-id-${sha256.slice(0, 8)}.${ext}`;
}

/**
 * File ids held by the field, from a crm.item.get / crm.item.update item: a
 * multiple file field reads as a list of {id, url, urlMachine}; a bare id or a
 * single object is accepted too. Unusable entries are ignored.
 */
export function fieldFileIds(record: Record<string, unknown> | null | undefined, key: string = ID_PROOF_ITEM_FIELD): number[] {
  const raw = record?.[key];
  const list = Array.isArray(raw) ? raw : raw === null || raw === undefined || raw === '' || raw === false ? [] : [raw];
  const ids = list
    .map((v) => (v && typeof v === 'object' ? (v as Record<string, unknown>).id : v))
    .map((v) => (typeof v === 'number' ? v : typeof v === 'string' && /^[1-9]\d{0,17}$/.test(v) ? Number(v) : NaN))
    .filter((v) => Number.isSafeInteger(v) && v > 0);
  return [...new Set(ids)].sort((a, b) => a - b);
}

/** One entry of the field: its id and whatever Bitrix returned with it (links, maybe name or size). Never logged. */
export interface FieldFileEntry {
  id: number;
  raw: Record<string, unknown> | null;
}

export function fieldFileEntries(record: Record<string, unknown> | null | undefined, key: string = ID_PROOF_ITEM_FIELD): FieldFileEntry[] {
  const raw = record?.[key];
  const list = Array.isArray(raw) ? raw : raw === null || raw === undefined || raw === '' || raw === false ? [] : [raw];
  const out = new Map<number, FieldFileEntry>();
  for (const v of list) {
    const obj = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
    const idRaw = obj ? obj.id : v;
    const id = typeof idRaw === 'number' ? idRaw : typeof idRaw === 'string' && /^[1-9]\d{0,17}$/.test(idRaw) ? Number(idRaw) : NaN;
    if (Number.isSafeInteger(id) && id > 0 && !out.has(id)) out.set(id, { id, raw: obj });
  }
  return [...out.values()].sort((a, b) => a.id - b.id);
}

/** What the worker could learn about one Bitrix file (all optional). */
export interface FileFacts {
  sizeBytes: number | null;
  name: string | null;
  sha256: string | null;
}

/** Facts Bitrix returned with the entry itself (no download). */
export function entryFacts(raw: Record<string, unknown> | null): FileFacts {
  const pick = (...keys: string[]) => keys.map((k) => raw?.[k]).find((v) => v !== undefined && v !== null && v !== '');
  const sizeRaw = pick('size', 'fileSize', 'FILE_SIZE');
  const size = typeof sizeRaw === 'number' ? sizeRaw : typeof sizeRaw === 'string' && /^\d{1,12}$/.test(sizeRaw) ? Number(sizeRaw) : null;
  const nameRaw = pick('name', 'fileName', 'ORIGINAL_NAME');
  return { sizeBytes: size !== null && Number.isSafeInteger(size) ? size : null, name: typeof nameRaw === 'string' ? nameRaw : null, sha256: null };
}

export type FileMatch = 'match' | 'no_match' | 'unknown';

/**
 * Review E7-3: is this Bitrix file the job's file? The content hash decides
 * when known; otherwise the size must match and, when a name is shown, it
 * must carry the hash part of the neutral name. Without hash or size the
 * answer is unknown (never a guess).
 */
export function matchFile(facts: FileFacts | null, job: Pick<IdProofCopyJob, 'sha256' | 'sizeBytes'>): FileMatch {
  if (!facts) return 'unknown';
  if (facts.sha256) return facts.sha256 === job.sha256 ? 'match' : 'no_match';
  if (facts.name !== null && !facts.name.includes(`-id-${job.sha256.slice(0, 8)}`)) return 'no_match';
  if (facts.sizeBytes === null) return 'unknown';
  return facts.sizeBytes === job.sizeBytes ? 'match' : 'no_match';
}

export interface AppendPayload {
  entityTypeId: typeof DEAL_ENTITY_TYPE_ID;
  id: number;
  fields: { [ID_PROOF_ITEM_FIELD]: Array<{ id: number } | [string, string]> };
}

/** The one request body the writer ever sends: every prior file kept, the new file appended. */
export function buildAppendPayload(bitrixDealId: string, priorFileIds: number[], fileName: string, base64: string): AppendPayload {
  if (!/^[1-9]\d{0,17}$/.test(bitrixDealId)) throw new Error('invalid deal id');
  return {
    entityTypeId: DEAL_ENTITY_TYPE_ID,
    id: Number(bitrixDealId),
    fields: { [ID_PROOF_ITEM_FIELD]: [...priorFileIds.map((id) => ({ id })), [fileName, base64]] },
  };
}

const isNewFile = (v: unknown): v is [string, string] =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' && v[0].length > 0 && v[1].length > 0;
const isKeptFile = (v: unknown): v is { id: number } =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).join(',') === 'id' && Number.isSafeInteger((v as { id: unknown }).id) && (v as { id: number }).id > 0;

/**
 * Refuses anything but crm.item.update on a Deal (entityTypeId 2) touching
 * exactly the one field, with every entry either a kept file {id} or the one
 * new file [name, base64].
 */
export function assertAllowedWrite(method: string, body: unknown): asserts body is AppendPayload {
  if (!(ID_PROOF_WRITE_METHODS as readonly string[]).includes(method)) throw new BitrixWriteError('refused', 'method_not_allowed');
  if (!body || typeof body !== 'object') throw new BitrixWriteError('refused', 'body_invalid');
  const b = body as Record<string, unknown>;
  if (Object.keys(b).sort().join(',') !== 'entityTypeId,fields,id') throw new BitrixWriteError('refused', 'body_invalid');
  if (b.entityTypeId !== DEAL_ENTITY_TYPE_ID) throw new BitrixWriteError('refused', 'entity_not_allowed');
  if (!Number.isSafeInteger(b.id) || (b.id as number) <= 0) throw new BitrixWriteError('refused', 'body_invalid');
  const fields = b.fields as Record<string, unknown> | null;
  if (!fields || typeof fields !== 'object' || Object.keys(fields).join(',') !== ID_PROOF_ITEM_FIELD) throw new BitrixWriteError('refused', 'field_not_allowed');
  const value = fields[ID_PROOF_ITEM_FIELD];
  if (!Array.isArray(value) || value.length === 0) throw new BitrixWriteError('refused', 'body_invalid');
  const news = value.filter(isNewFile);
  const kept = value.filter(isKeptFile);
  if (news.length !== 1 || kept.length + news.length !== value.length || !isNewFile(value[value.length - 1])) throw new BitrixWriteError('refused', 'body_invalid');
}

export type BitrixWriteKind = 'refused' | 'lost' | 'rate_limited' | 'auth';

/** Codes only: never the URL, never the body, never Bitrix text. */
export class BitrixWriteError extends Error {
  override name = 'BitrixWriteError';
  constructor(
    readonly kind: BitrixWriteKind,
    readonly code: string,
  ) {
    super(`Bitrix write ${kind}: ${code}`);
  }
}

export interface BitrixIdProofWriter {
  /**
   * Sends the one update. Returns the file ids of the field in Bitrix's reply
   * (crm.item.update answers with the whole item), or null when the reply
   * does not show the field.
   */
  appendFile(input: { bitrixDealId: string; priorFileIds: number[]; fileName: string; base64: string }): Promise<{ replyFileIds: number[] | null }>;
}

export function createBitrixIdProofWriter(options: {
  target: BitrixRestTarget;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): BitrixIdProofWriter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? ID_PROOF_WRITE_TIMEOUT_MS;
  return {
    async appendFile(input) {
      const method: IdProofWriteMethod = 'crm.item.update';
      const body = buildAppendPayload(input.bitrixDealId, input.priorFileIds, input.fileName, input.base64);
      assertAllowedWrite(method, body);
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
        answer = (await res.json()) as Record<string, unknown>;
      } catch {
        answer = null;
      }
      const code = answer && typeof answer.error === 'string' ? answer.error : null;
      if (res.status === 429 || code === 'QUERY_LIMIT_EXCEEDED' || code === 'OPERATION_TIME_LIMIT') throw new BitrixWriteError('rate_limited', 'rate_limited');
      if (res.status === 401 || res.status === 403 || (code && /^(NO_AUTH_FOUND|INVALID_CREDENTIALS|insufficient_scope|expired_token|ACCESS_DENIED)$/.test(code))) {
        throw new BitrixWriteError('auth', 'auth_failed');
      }
      if (res.status >= 500 || !answer) throw new BitrixWriteError('lost', `http_${res.status >= 500 ? '5xx' : 'unreadable'}`);
      const result = answer.result as Record<string, unknown> | null | undefined;
      const item = result && typeof result === 'object' ? (result.item as Record<string, unknown> | null | undefined) : null;
      // An explicit Bitrix error (or a non-200 answer) is a refusal.
      if (res.status !== 200 || code) throw new BitrixWriteError('refused', 'bitrix_refused');
      // Review E9-1: a 200 answer without the expected item may still have
      // applied the update: treat it as a lost answer (read back later), never
      // as a refusal that a manual retry would turn into a duplicate.
      if (!item || typeof item !== 'object') throw new BitrixWriteError('lost', 'reply_unexpected');
      if (String(item.id) !== input.bitrixDealId) throw new BitrixWriteError('lost', 'reply_mismatch');
      return { replyFileIds: ID_PROOF_ITEM_FIELD in item ? fieldFileIds(item, ID_PROOF_ITEM_FIELD) : null };
    },
  };
}

// ---------------------------------------------------------------------------
// One batch of copy jobs (worker side; every dependency injected)
// ---------------------------------------------------------------------------

export interface IdProofCopyJob {
  jobId: string;
  leaseToken: string;
  mode: 'send' | 'verify';
  bitrixDealId: string;
  objectPath: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  travellerSeq: number;
  priorFileIds: number[];
  attempts: number;
}

export type CopyOutcome = 'sent' | 'retry' | 'failed' | 'unknown' | 'stopped';

export interface IdProofCopyDeps {
  claim(limit: number): Promise<IdProofCopyJob[]>;
  markSending(job: IdProofCopyJob, priorFileIds: number[]): Promise<void>;
  complete(job: IdProofCopyJob, outcome: Exclude<CopyOutcome, 'stopped'>, errorCode: string | null, bitrixFileId: number | null): Promise<void>;
  /** Review E7-1: fail the job, switch the copy off and open an alert (one transaction). */
  stop(job: IdProofCopyJob, reasonCode: 'prior_files_lost'): Promise<void>;
  /** Review E7-3: facts of one new file of the field (null = could not be learnt). Never logs a URL. */
  inspectFile(job: IdProofCopyJob, entry: FieldFileEntry): Promise<FileFacts | null>;
  /**
   * The field through crm.item.get (READ webhook) as an item record holding
   * at least ID_PROOF_ITEM_FIELD; null = Deal not found. Throws
   * BitrixClientError-like errors, also when the answer does not show the field.
   */
  readDealItem(bitrixDealId: string): Promise<Record<string, unknown> | null>;
  download(objectPath: string): Promise<Uint8Array>;
  sha256(bytes: Uint8Array): string;
  writer: BitrixIdProofWriter;
}

export interface IdProofCopySummary {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  unknown: number;
  /** Review E7-1: the batch ended because files were lost (switch now off). */
  stopped: boolean;
  /** Codes only (for the run log). */
  errors: string[];
}

function readErrorCode(error: unknown): IntakeErrorCode | 'internal_error' {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? (code as IntakeErrorCode) : 'internal_error';
}

/**
 * The new files of the field (ids not held before) that are this job's file.
 *   - {id}: a new file positively matched this job's file;
 *   - 'no_new_file': the field holds no file id beyond the prior ones (the
 *     only reading that may lead to a send);
 *   - 'unreadable': new files exist, none matched, at least one could not be
 *     inspected;
 *   - 'not_matched': new files exist and every one was read and differs.
 *
 * Review E12-1: a new file that is not positively ours is never taken as
 * "our file is absent". A download link can answer 200 with something that is
 * not the file (an error page, an expired one-time link served as bytes), so
 * a mismatch may be ours read wrongly; sending again then could duplicate it.
 * Both 'unreadable' and 'not_matched' therefore end unknown (and, repeated,
 * needs_manual_check), never a retry.
 */
type OwnFile = { id: number } | 'no_new_file' | 'unreadable' | 'not_matched';

async function findOwnFile(deps: IdProofCopyDeps, job: IdProofCopyJob, entries: FieldFileEntry[], prior: number[]): Promise<OwnFile> {
  const before = new Set(prior);
  const fresh = entries.filter((e) => !before.has(e.id));
  if (fresh.length === 0) return 'no_new_file';
  let unreadable = false;
  for (const entry of fresh) {
    let facts: FileFacts | null;
    try {
      facts = await deps.inspectFile(job, entry);
    } catch {
      facts = null;
    }
    const m = matchFile(facts, job);
    if (m === 'match') return { id: entry.id };
    if (m === 'unknown') unreadable = true;
  }
  return unreadable ? 'unreadable' : 'not_matched';
}

/** Codes for a read-back that did not find this job's file among new files. */
const UNDECIDED_CODE = { unreadable: 'file_facts_unavailable', not_matched: 'new_file_not_matched' } as const;

async function handle(deps: IdProofCopyDeps, job: IdProofCopyJob): Promise<CopyOutcome> {
  const done = async (outcome: Exclude<CopyOutcome, 'stopped'>, code: string | null, fileId: number | null = null) => {
    await deps.complete(job, outcome, code, fileId);
    return outcome;
  };
  const stop = async () => {
    await deps.stop(job, 'prior_files_lost');
    return 'stopped' as const;
  };

  if (job.mode === 'verify') {
    // A send whose answer was lost: did the field gain this job's file since?
    let record: Record<string, unknown> | null;
    try {
      record = await deps.readDealItem(job.bitrixDealId);
    } catch (error) {
      return done('unknown', `read_${readErrorCode(error)}`);
    }
    if (!record) return done('failed', 'deal_not_found');
    const entries = fieldFileEntries(record);
    const now = entries.map((e) => e.id);
    if (job.priorFileIds.some((id) => !now.includes(id))) return stop();
    const own = await findOwnFile(deps, job, entries, job.priorFileIds);
    // Only a field with no new file at all lets the job be sent again.
    if (own === 'no_new_file') return done('retry', 'not_found_on_read_back');
    if (own === 'unreadable' || own === 'not_matched') return done('unknown', UNDECIDED_CODE[own]);
    return done('sent', null, own.id);
  }

  // Send. Review E7-2: the CRM file first, so the field is read immediately before the write.
  let bytes: Uint8Array;
  try {
    bytes = await deps.download(job.objectPath);
  } catch {
    return done('retry', 'file_unavailable');
  }
  if (deps.sha256(bytes) !== job.sha256 || bytes.byteLength !== job.sizeBytes) return done('failed', 'file_changed');
  const base64 = Buffer.from(bytes).toString('base64');

  let record: Record<string, unknown> | null;
  try {
    record = await deps.readDealItem(job.bitrixDealId);
  } catch (error) {
    return done('retry', `read_${readErrorCode(error)}`);
  }
  if (!record) return done('failed', 'deal_not_found');
  const prior = fieldFileIds(record);

  await deps.markSending(job, prior);
  let reply: { replyFileIds: number[] | null };
  try {
    reply = await deps.writer.appendFile({
      bitrixDealId: job.bitrixDealId,
      priorFileIds: prior,
      fileName: neutralFileName(job.travellerSeq, job.sha256, job.mime),
      base64,
    });
  } catch (error) {
    if (error instanceof BitrixWriteError) {
      if (error.kind === 'lost') return done('unknown', `answer_${error.code}`);
      if (error.kind === 'rate_limited') return done('retry', 'rate_limited');
      if (error.kind === 'auth') return done('failed', 'bitrix_auth_failed');
      return done('failed', error.code);
    }
    return done('unknown', 'answer_unexpected');
  }
  // The reply carries the whole item: a prior file missing there stops everything at once.
  if (reply.replyFileIds !== null && prior.some((id) => !reply.replyFileIds!.includes(id))) return stop();

  // Read back: every prior file must still be there (else stop everything), and this job's file added.
  let entries: FieldFileEntry[];
  try {
    const back = await deps.readDealItem(job.bitrixDealId);
    if (!back) return done('unknown', 'read_back_not_found');
    entries = fieldFileEntries(back);
  } catch {
    return done('unknown', 'read_back_failed');
  }
  const after = entries.map((e) => e.id);
  if (prior.some((id) => !after.includes(id))) return stop();
  const own = await findOwnFile(deps, job, entries, prior);
  if (own === 'no_new_file') return done('unknown', 'not_visible_after_send');
  if (own === 'unreadable' || own === 'not_matched') return done('unknown', UNDECIDED_CODE[own]);
  return done('sent', null, own.id);
}

/**
 * Up to `limit` jobs, claimed one at a time (one lease per job, review E7-6).
 * Ends at once after an automatic stop (review E7-1).
 */
export async function processIdProofCopyBatch(deps: IdProofCopyDeps, limit = 5): Promise<IdProofCopySummary> {
  const summary: IdProofCopySummary = { claimed: 0, sent: 0, retried: 0, failed: 0, unknown: 0, stopped: false, errors: [] };
  for (let i = 0; i < limit; i += 1) {
    const jobs = await deps.claim(1);
    const job = jobs[0];
    if (!job) break;
    summary.claimed += 1;
    try {
      const outcome = await handle(deps, job);
      if (outcome === 'sent') summary.sent += 1;
      else if (outcome === 'retry') summary.retried += 1;
      else if (outcome === 'failed') summary.failed += 1;
      else if (outcome === 'stopped') {
        summary.failed += 1;
        summary.stopped = true;
        summary.errors.push('prior_files_lost');
        break;
      } else summary.unknown += 1;
    } catch {
      // A database call failed: the lease expires and the job is claimed again
      // (a job already marked unknown is then read back, never re-sent blindly).
      // Stop the batch too: the next claim would hit the same failure.
      summary.errors.push('job_not_completed');
      break;
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Review E7-3: learning the facts of a new file in the field
// ---------------------------------------------------------------------------

export const FILE_INSPECT_TIMEOUT_MS = 30_000;

/**
 * The entry links tried, in this order, by the worker and by the probe check
 * script (scripts/dev/id-proof-copy-probe-check.mjs). Only urlMachine: it is
 * the link Bitrix documents for server-side download (its own token inside).
 * The item API's other link, url, needs a signed-in browser session and
 * returns a login page to a webhook caller, so it is not tried (13 Oct 2026
 * live probe; review E11-3 order kept for the one key).
 */
export const FILE_LINK_KEYS = ['urlMachine'] as const;

/**
 * Same-host redirects followed per download (Bitrix's own download example
 * follows redirects). A redirect to any other host, or more hops than this,
 * makes the link unusable.
 */
export const FILE_MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Answers that are never an ID proof (PDF or image): any text/* (HTML login
 * page, plain-text error), JSON and XML, including +json / +xml types
 * (review E12-1b). The probe check script uses the same rule.
 */
export const NOT_A_FILE_CONTENT_TYPE = /^\s*(?:text\/|application\/(?:json|xml)\b|[\w.!#$&^-]+\/[\w.!#$&^-]+\+(?:json|xml)\b)/i;

/**
 * Facts of one file of the field: what Bitrix returned with the entry, and,
 * when no size came with it, the content hash and size from reading the file
 * through the entry's own download link. The link, and every redirect hop,
 * must be on the portal host (a relative link is resolved against it); at
 * most the job's size plus one chunk is read, in memory only, the bytes are
 * dropped after hashing, and nothing is kept or logged (never a URL, a file
 * name or the credential inside urlMachine). A text, JSON or XML answer
 * (login page, error) is not the file. Null when the file cannot be read: the job then
 * stays unknown, never sent on a guess.
 */

export function createFieldFileInspector(options: { target: BitrixRestTarget; fetchImpl?: typeof fetch; timeoutMs?: number; sha256(bytes: Uint8Array): string }) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? FILE_INSPECT_TIMEOUT_MS;
  const origin = new URL(options.target.baseUrl).origin;

  /** One link: the file's facts, or null (not usable: other host, login page, error, timeout). */
  async function tryLink(job: IdProofCopyJob, facts: FileFacts, link: string, signal: AbortSignal): Promise<FileFacts | null> {
    let url: URL;
    try {
      url = new URL(link, origin);
    } catch {
      return null;
    }
    if (url.origin !== origin) return null;
    try {
      let res: Response | null = null;
      for (let hop = 0; ; hop += 1) {
        // Redirects are handled here, one hop at a time, so a hop to another
        // host is never requested (fetch's own 'follow' would go anywhere).
        res = await fetchImpl(url.toString(), { method: 'GET', redirect: 'manual', signal, cache: 'no-store' });
        if (!REDIRECT_STATUSES.has(res.status)) break;
        await res.body?.cancel().catch(() => undefined);
        const location = res.headers.get('location');
        if (!location || hop >= FILE_MAX_REDIRECTS) return null;
        try {
          url = new URL(location, url);
        } catch {
          return null;
        }
        if (url.origin !== origin) return null;
      }
      const type = res.headers.get('content-type') ?? '';
      if (res.status !== 200 || NOT_A_FILE_CONTENT_TYPE.test(type) || !res.body) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      const reader = res.body.getReader();
      const parts: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > job.sizeBytes) {
          await reader.cancel();
          return { ...facts, sizeBytes: total, sha256: null };
        }
        parts.push(value);
      }
      const bytes = new Uint8Array(total);
      let at = 0;
      for (const part of parts) {
        bytes.set(part, at);
        at += part.byteLength;
      }
      return { ...facts, sizeBytes: total, sha256: options.sha256(bytes) };
    } catch {
      return null;
    }
  }

  return async function inspectFile(job: IdProofCopyJob, entry: FieldFileEntry): Promise<FileFacts | null> {
    const facts = entryFacts(entry.raw);
    if (facts.sizeBytes !== null) return facts;
    const links = FILE_LINK_KEYS.map((k) => entry.raw?.[k]).filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 2000);
    if (links.length === 0) return null;
    // One time limit for the whole inspection, whichever links are tried.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      for (const link of links) {
        const found = await tryLink(job, facts, link, controller.signal);
        if (found) return found;
        if (controller.signal.aborted) return null;
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
