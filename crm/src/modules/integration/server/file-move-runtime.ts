import 'server-only';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getIntegrationEnv, resolveBitrixRestTarget, type BitrixRestTarget } from '../bitrix/config';
import {
  createBitrixFileReader,
  createBitrixFileWriter,
  FileStoreError,
  IDENTITY_BOX,
  neutralBoxFileName,
  sha256Hex,
  type BitrixFileReader,
  type BitrixFileWriter,
  type BoxEntry,
  type ReadBoxResult,
} from '../bitrix/file-store';
import { BitrixWriteError } from '../bitrix/id-proof-copy';
import type { FileMoveResult } from '../bitrix/worker-endpoint';
import { asRpcClient } from '../commands';
import { selectActiveConfig, selectIntakeConfig, type IntakeConfig } from '../intake-config';
import {
  claimFileMoves,
  completeFileMove,
  confirmFileMoveDeleted,
  confirmFileMoveRestored,
  FileMoveCommandError,
  markFileMoveSending,
  recordFileMoveObservation,
  recordFilePresence,
  recordFileRelocated,
  stopFileMove,
  type FileMoveJob,
  type FileMoveOutcome,
  type FileMoveRowJob,
  type FileMoveStopReason,
  type FilePresenceJob,
  type ObservationResult,
} from './file-move-commands';
import { removeMovedSourceObject, type StorageRemoveResult } from './file-storage-remove';

/**
 * S11 "files to Bitrix": the file-move worker (?task=files on the Bitrix
 * worker endpoint). Contract: hosting-migration file 14 (wins) and file 11
 * sections 2.3 to 2.6; job shapes and modes from the lead's slice 0 freeze.
 *
 * processFileMoveBatch is the core: every dependency is injected (database
 * commands, Bitrix reader and writer, Storage), so it is unit-tested with a
 * mock portal and an in-memory database. runFileMoveBatch is the production
 * wiring.
 *
 * Rules kept here (the database enforces its own rules as well):
 *   - one job at a time: claim limit 1, lease 180 s;
 *   - before each claim the time left in the invocation is checked: one step
 *     may need up to 60 s (the deadline the endpoint passes already keeps the
 *     margin for the alert check that runs after the answer);
 *   - bounded timeouts: box read 10 s, download 10 s, write 20 s, Storage 10 s;
 *   - the worker never says "it matched": it hands the observed hash and size
 *     to the database, which compares and answers;
 *   - a lost write answer is resolved by reading the box back, never by
 *     sending again; a prior file missing after a write stops everything;
 *   - a restore uploads (upsert false) only after the database answered
 *     restore_checked, and only the bytes that were hashed;
 *   - the write credential (BITRIX_WRITE_WEBHOOK_BASE_URL) is used for
 *     appends only; every read uses the read webhook;
 *   - Storage objects are removed only through file-storage-remove.ts;
 *   - it does NOT run the DEC-43 ID-proof copy batch (S4's copy kick does).
 * The result holds codes and counts only: never a Bitrix id, a link, a path
 * or a file name.
 */

export const FILE_MOVE_LEASE_SECONDS = 180;
/** Worst case of one step (read 10 s + download 10 s + write 20 s + read-back and downloads + database calls). */
export const FILE_MOVE_STEP_WORST_CASE_MS = 60_000;
export const FILE_MOVE_TIMEOUTS = { readMs: 10_000, downloadMs: 10_000, writeMs: 20_000, storageMs: 10_000 } as const;
/** Upper bound of jobs per invocation (the time check normally ends the batch first). */
export const FILE_MOVE_MAX_JOBS = 20;
/** Relocation and own-file search look at no more than this many unknown entries. */
export const FILE_MOVE_MAX_CANDIDATES = 10;

export type FileMoveEnd =
  | 'no_work'
  | 'time'
  | 'limit'
  | 'stopped'
  | 'rate_limited'
  | 'bitrix_unavailable'
  | 'bitrix_auth'
  | 'write_not_configured'
  | 'db_error';

export interface FileMoveSummary {
  claimed: number;
  /** Count per step label (outcome or database answer), codes only. */
  done: Record<string, number>;
  /** The batch ended because a stop opened or a copy was quarantined (delete switch now off). */
  stopped: boolean;
  endedBy: FileMoveEnd;
  /** Codes only. */
  errors: string[];
}

export type RowLease = Pick<FileMoveRowJob, 'moveId' | 'leaseToken'>;

export interface FileMoveDeps {
  now(): number;
  /** Epoch ms after which no step may still be running. */
  deadline: number;
  maxJobs?: number;
  /** One leased job, or null when nothing is due. */
  claim(): Promise<FileMoveJob | null>;
  markSending(job: RowLease, priorFileIds: number[]): Promise<void>;
  recordObservation(job: RowLease, observation: { bitrixFileId: number; sha256: string; sizeBytes: number; readStartedAt: string }): Promise<ObservationResult>;
  complete(job: RowLease, outcome: FileMoveOutcome, errorCode: string | null, bitrixFileId: number | null): Promise<void>;
  confirmDeleted(job: RowLease): Promise<'deleted' | 'still_present' | 'back_to_verified'>;
  confirmRestored(job: RowLease): Promise<'restored' | 'missing'>;
  stop(job: RowLease, reason: FileMoveStopReason): Promise<void>;
  /** null = Bitrix does not know the deal (the database opens the alert). */
  presence(job: FilePresenceJob, presentFileIds: number[] | null): Promise<void>;
  relocated(job: RowLease, observation: { newFileId: number; sha256: string; sizeBytes: number }): Promise<'relocated' | 'no_match'>;
  reader: BitrixFileReader;
  /** A writer allowed the identity box and, for an Accounts row, that row's box; null = no write credential. */
  writerFor(accountsBox: string | null): BitrixFileWriter | null;
  /** The CRM's copy (throws when it cannot be read). */
  downloadCrm(bucket: string, objectPath: string): Promise<Uint8Array>;
  /** Upload with upsert false: 'exists' when an object is already at the path. */
  uploadCrm(bucket: string, objectPath: string, bytes: Uint8Array, mime: string): Promise<'uploaded' | 'exists' | 'error'>;
  removeCrm(bucket: string, objectPath: string): Promise<StorageRemoveResult>;
}

interface Step {
  label: string;
  end?: FileMoveEnd;
  code?: string;
}

function endFor(error: FileStoreError): FileMoveEnd {
  return error.kind === 'rate_limited' ? 'rate_limited' : error.kind === 'auth' ? 'bitrix_auth' : 'bitrix_unavailable';
}

function asStoreError(error: unknown): FileStoreError {
  return error instanceof FileStoreError ? error : new FileStoreError('unavailable', 'bitrix_unavailable');
}

type OwnFile = { kind: 'found'; id: number } | { kind: 'none' } | { kind: 'unreadable' } | { kind: 'not_matched' };

/**
 * Which new entry (not among `prior`) is this row's file: one whose bytes,
 * read now, hash to the row's sha256 at the row's size. A new entry that is
 * not positively ours is never read as "ours is absent".
 */
async function findOwnFile(reader: BitrixFileReader, job: FileMoveRowJob, entries: BoxEntry[], prior: number[]): Promise<OwnFile> {
  const before = new Set(prior);
  const fresh = entries.filter((e) => !before.has(e.id)).slice(0, FILE_MOVE_MAX_CANDIDATES);
  if (fresh.length === 0) return { kind: 'none' };
  let unreadable = false;
  for (const entry of fresh) {
    const read = await reader.downloadEntry(entry, job.sizeBytes);
    if (read.kind === 'ok') {
      if (read.sha256 === job.sha256 && read.sizeBytes === job.sizeBytes) return { kind: 'found', id: entry.id };
    } else if (read.code !== 'too_large') {
      unreadable = true;
    }
  }
  return unreadable ? { kind: 'unreadable' } : { kind: 'not_matched' };
}

const iso = (ms: number) => new Date(ms).toISOString();

async function handleRow(d: FileMoveDeps, job: FileMoveRowJob): Promise<Step> {
  const done = async (outcome: FileMoveOutcome, code: string | null, fileId: number | null = null, end?: FileMoveEnd): Promise<Step> => {
    await d.complete(job, outcome, code, fileId);
    return { label: outcome, ...(end ? { end } : {}), ...(code && end ? { code } : {}) };
  };
  const stopped = async (reason: FileMoveStopReason): Promise<Step> => {
    await d.stop(job, reason);
    return { label: 'stopped', end: 'stopped', code: reason };
  };
  /** A box read failed: the row backs off ('retry'), or stays undecided ('unknown') after a send. */
  const readFailed = (error: unknown, outcome: 'retry' | 'unknown' = 'retry'): Promise<Step> => {
    const e = asStoreError(error);
    return done(outcome, e.code, null, endFor(e));
  };
  /** The box read alone (a database failure afterwards is never taken for a Bitrix failure). */
  const readTheBox = async (): Promise<{ box: ReadBoxResult } | { error: unknown }> => {
    try {
      return { box: await d.reader.readBox(job.bitrixDealId, job.bitrixField) };
    } catch (error) {
      return { error };
    }
  };

  // Out of time before the first Bitrix call: hand the job back untouched.
  if (d.deadline - d.now() < FILE_MOVE_STEP_WORST_CASE_MS) return done('released', null, null, 'time');

  switch (job.mode) {
    case 'copy': {
      // A row's box must fit its class: identity papers only in the identity
      // box, Accounts papers never in it.
      if (job.fileClass === 'id_proof' ? job.bitrixField !== IDENTITY_BOX : job.bitrixField === IDENTITY_BOX) return done('failed', 'box_not_allowed');
      const writer = d.writerFor(job.fileClass === 'accounts' ? job.bitrixField : null);
      if (!writer) return done('retry', 'write_credential_missing', null, 'write_not_configured');
      // The CRM's file first (checked against its own record), so the box is read immediately before the write.
      let bytes: Uint8Array;
      try {
        bytes = await d.downloadCrm(job.bucket, job.objectPath);
      } catch {
        return done('retry', 'crm_file_unavailable');
      }
      if (bytes.byteLength !== job.sizeBytes || sha256Hex(bytes) !== job.sha256) return done('failed', 'crm_file_changed');
      let fileName: string;
      try {
        fileName = neutralBoxFileName(job.kindCode, job.sha256, job.mime);
      } catch {
        return done('failed', 'name_not_allowed');
      }
      const first = await readTheBox();
      if ('error' in first) return readFailed(first.error);
      if (first.box.kind === 'deal_not_found') return done('deal_not_found', 'deal_not_found');
      const entries = first.box.entries;
      const prior = entries.map((e) => e.id);
      try {
        await d.markSending(job, prior);
      } catch (error) {
        // The database refused the send (a sole copy in the box, an append in
        // flight, or the lease is gone): nothing was written. Hand the job back.
        if (error instanceof FileMoveCommandError && (error.refusal === 'wrong_state' || error.refusal === 'task_conflict')) {
          try {
            await d.complete(job, 'released', null, null);
          } catch {
            // Lease already gone: it expires on its own.
          }
          return { label: 'send_refused' };
        }
        throw error;
      }
      let reply: { replyFileIds: number[] | null };
      try {
        reply = await writer.appendToBox({
          bitrixDealId: job.bitrixDealId,
          box: job.bitrixField,
          priorFileIds: prior,
          fileName,
          base64: Buffer.from(bytes).toString('base64'),
        });
      } catch (error) {
        if (error instanceof BitrixWriteError) {
          if (error.kind === 'lost') return done('unknown', `answer_${error.code}`);
          if (error.kind === 'rate_limited') return done('retry', 'bitrix_rate_limited', null, 'rate_limited');
          if (error.kind === 'auth') return done('failed', 'bitrix_auth_failed', null, 'bitrix_auth');
          return done('failed', error.code === 'bitrix_refused' ? 'bitrix_refused' : `write_${error.code}`);
        }
        return done('unknown', 'answer_unexpected');
      }
      // The reply carries the whole item: a prior file missing there stops everything.
      const replyIds = reply.replyFileIds;
      if (replyIds !== null && prior.some((id) => !replyIds.includes(id))) return stopped('prior_files_lost');
      const back = await readTheBox();
      if ('error' in back) return done('unknown', 'read_back_failed');
      if (back.box.kind === 'deal_not_found') return done('unknown', 'read_back_not_found');
      const after = back.box.entries;
      const afterIds = after.map((e) => e.id);
      if (prior.some((id) => !afterIds.includes(id))) return stopped('prior_files_lost');
      const own = await findOwnFile(d.reader, job, after, prior);
      if (own.kind === 'found') return done('copied', null, own.id);
      if (own.kind === 'none') return done('unknown', 'not_visible_after_send');
      return done('unknown', own.kind === 'unreadable' ? 'file_unreadable' : 'new_file_not_matched');
    }

    case 'verify_copy': {
      // A send whose answer was lost: decide from a read-back, never send blindly.
      const first = await readTheBox();
      if ('error' in first) return readFailed(first.error, 'unknown');
      if (first.box.kind === 'deal_not_found') return done('deal_not_found', 'deal_not_found');
      const entries = first.box.entries;
      const ids = entries.map((e) => e.id);
      if (job.priorFileIds.some((id) => !ids.includes(id))) return stopped('prior_files_lost');
      const own = await findOwnFile(d.reader, job, entries, job.priorFileIds);
      if (own.kind === 'found') return done('copied', null, own.id);
      // Only a box with no new file at all lets the row be sent again.
      if (own.kind === 'none') return done('not_sent', 'not_found_on_read_back');
      return done('unknown', own.kind === 'unreadable' ? 'file_unreadable' : 'new_file_not_matched');
    }

    case 'verify':
    case 'reverify':
    case 'restore': {
      // Noted before the read: a second check counts only if its read started
      // after the last append to this box (the database compares).
      const readStartedAt = iso(d.now());
      if (job.bitrixFileId === null) return done('failed', 'no_bitrix_file_id');
      const first = await readTheBox();
      if ('error' in first) return readFailed(first.error);
      if (first.box.kind === 'deal_not_found') return done('deal_not_found', 'deal_not_found');
      const entries = first.box.entries;
      const entry = entries.find((e) => e.id === job.bitrixFileId);
      if (!entry) return done('not_in_box', 'not_in_box');
      // Always downloaded and hashed; a size Bitrix shows is never used.
      const read = await d.reader.downloadEntry(entry, job.sizeBytes);
      if (read.kind !== 'ok') return done('retry', `download_${read.code}`);
      const result = await d.recordObservation(job, { bitrixFileId: entry.id, sha256: read.sha256, sizeBytes: read.sizeBytes, readStartedAt });
      if (result === 'quarantined') return { label: 'quarantined', end: 'stopped', code: 'copy_mismatch' };
      if (job.mode !== 'restore' || result !== 'restore_checked') return { label: result };
      // Restore: the database compared and said equal; the bytes uploaded are
      // exactly the bytes hashed (checked again here), never overwriting.
      if (read.sha256 !== job.sha256 || read.sizeBytes !== job.sizeBytes) return done('failed', 'restore_hash_differs', null, 'stopped');
      const upload = await d.uploadCrm(job.bucket, job.objectPath, read.bytes, job.mime);
      if (upload === 'error') return done('retry', 'storage_upload_failed');
      return { label: `restore_${await d.confirmRestored(job)}` };
    }

    case 'delete': {
      // The database already holds two matching observations (constraint);
      // Storage is asked to remove the object, then the database looks itself.
      const removed = await d.removeCrm(job.bucket, job.objectPath);
      // A refusal (bucket or path outside the allowlist) is retried like an
      // error: delete_pending is never left half-done, and the row shows in
      // the alerts with the code.
      if (removed.kind !== 'removed') return done('retry', `remove_${removed.code}`);
      return { label: `delete_${await d.confirmDeleted(job)}` };
    }

    case 'confirm_delete':
      // Deletion not allowed now: no remove, only look whether the object is gone.
      return { label: `delete_${await d.confirmDeleted(job)}` };

    case 'relocate': {
      const first = await readTheBox();
      if ('error' in first) return readFailed(first.error);
      if (first.box.kind === 'deal_not_found') return done('deal_not_found', 'deal_not_found');
      const entries = first.box.entries;
      const known = new Set(job.knownFileIds);
      const candidates = entries.filter((e) => !known.has(e.id)).slice(0, FILE_MOVE_MAX_CANDIDATES);
      let unreadable = false;
      for (const candidate of candidates) {
        const read = await d.reader.downloadEntry(candidate, job.sizeBytes);
        if (read.kind !== 'ok') {
          // Larger than the file: not it. Anything else: could not tell.
          if (read.code !== 'too_large') unreadable = true;
          continue;
        }
        if ((await d.relocated(job, { newFileId: candidate.id, sha256: read.sha256, sizeBytes: read.sizeBytes })) === 'relocated') return { label: 'relocated' };
      }
      if (unreadable) return done('retry', 'relocate_unreadable');
      return done('not_in_box', 'no_matching_file');
    }
  }
}

async function handlePresence(d: FileMoveDeps, job: FilePresenceJob): Promise<Step> {
  // No row to hand back: when out of time or Bitrix fails, the lease expires.
  if (d.deadline - d.now() < FILE_MOVE_STEP_WORST_CASE_MS) return { label: 'presence_abandoned', end: 'time' };
  let ids: number[] | null;
  try {
    const box = await d.reader.readBox(job.bitrixDealId, job.bitrixField);
    // null tells the database Bitrix does not know the deal: alert, delete switch off.
    ids = box.kind === 'ok' ? box.entries.map((e) => e.id) : null;
  } catch (error) {
    const e = asStoreError(error);
    return { label: 'presence_failed', end: endFor(e), code: e.code };
  }
  await d.presence(job, ids);
  return { label: 'presence_checked' };
}

/** One batch: jobs claimed one at a time while time is left. Never throws. */
export async function processFileMoveBatch(d: FileMoveDeps): Promise<FileMoveSummary> {
  const summary: FileMoveSummary = { claimed: 0, done: {}, stopped: false, endedBy: 'no_work', errors: [] };
  const maxJobs = d.maxJobs ?? FILE_MOVE_MAX_JOBS;
  for (;;) {
    if (summary.claimed >= maxJobs) {
      summary.endedBy = 'limit';
      break;
    }
    if (d.deadline - d.now() < FILE_MOVE_STEP_WORST_CASE_MS) {
      summary.endedBy = 'time';
      break;
    }
    let job: FileMoveJob | null;
    try {
      job = await d.claim();
    } catch {
      summary.errors.push('claim_failed');
      summary.endedBy = 'db_error';
      break;
    }
    if (!job) break;
    summary.claimed += 1;
    try {
      const step = job.mode === 'presence' ? await handlePresence(d, job) : await handleRow(d, job);
      summary.done[step.label] = (summary.done[step.label] ?? 0) + 1;
      if (step.end) {
        summary.endedBy = step.end;
        summary.stopped = step.end === 'stopped';
        if (step.code) summary.errors.push(step.code);
        break;
      }
    } catch {
      // A database call failed: the lease expires and the job is claimed again
      // (a row already marked as sending is then read back, never re-sent).
      summary.errors.push('job_not_completed');
      summary.endedBy = 'db_error';
      break;
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve(promise),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Storage's answer to an upload over an existing object (upsert false). */
function isAlreadyExists(error: unknown): boolean {
  const e = error as { statusCode?: unknown; status?: unknown; message?: unknown } | null;
  if (!e) return false;
  return String(e.statusCode) === '409' || e.status === 409 || (typeof e.message === 'string' && /already exists|duplicate/i.test(e.message));
}

export interface FileMoveRunOptions {
  /** The config the endpoint already loaded (no second read). */
  config?: IntakeConfig;
  /** Epoch ms: no step may still be running after it. */
  deadline: number;
  now?: () => number;
}

export async function runFileMoveBatch(options: FileMoveRunOptions): Promise<FileMoveResult> {
  const now = options.now ?? Date.now;
  let admin: ReturnType<typeof createSupabaseAdminClient>;
  try {
    admin = createSupabaseAdminClient();
  } catch {
    return { status: 'not_configured', code: 'database_unavailable' };
  }
  let config = options.config ?? null;
  if (!config) {
    const { data, error } = await selectIntakeConfig((columns) => admin.from('integration_intake_config').select(columns).eq('source_system', 'bitrix'));
    if (error) return { status: 'not_configured', code: 'config_unavailable' };
    const active = selectActiveConfig(data ?? []);
    if (!active.config) return { status: 'not_configured', code: active.reason };
    config = active.config;
  }
  let readTarget: BitrixRestTarget;
  try {
    readTarget = resolveBitrixRestTarget(getIntegrationEnv().bitrixWebhookBaseUrl, config.portalDomain, process.env.APP_ENV);
  } catch {
    return { status: 'not_configured', code: 'bitrix_target_invalid' };
  }
  // The write credential is needed for appends only; without it the other modes still run.
  let writeTarget: BitrixRestTarget | null = null;
  const writeUrl = process.env.BITRIX_WRITE_WEBHOOK_BASE_URL?.trim() || null;
  if (writeUrl) {
    try {
      writeTarget = resolveBitrixRestTarget(writeUrl, config.portalDomain, process.env.APP_ENV);
    } catch {
      writeTarget = null;
    }
  }
  const t = FILE_MOVE_TIMEOUTS;
  const rpc = asRpcClient(admin);
  const reader = createBitrixFileReader({ target: readTarget, readTimeoutMs: t.readMs, downloadTimeoutMs: t.downloadMs, maxRateLimitRetries: 0 });
  const summary = await processFileMoveBatch({
    now,
    deadline: options.deadline,
    claim: async () => (await claimFileMoves(rpc, 1, FILE_MOVE_LEASE_SECONDS))[0] ?? null,
    markSending: async (job, prior) => {
      await markFileMoveSending(rpc, job, prior);
    },
    recordObservation: (job, observation) => recordFileMoveObservation(rpc, job, observation),
    complete: async (job, outcome, code, fileId) => {
      await completeFileMove(rpc, job, outcome, code, fileId);
    },
    confirmDeleted: (job) => confirmFileMoveDeleted(rpc, job),
    confirmRestored: (job) => confirmFileMoveRestored(rpc, job),
    stop: async (job, reason) => {
      await stopFileMove(rpc, job, reason);
    },
    presence: async (job, ids) => {
      await recordFilePresence(rpc, job, ids);
    },
    relocated: (job, observation) => recordFileRelocated(rpc, job, observation),
    reader,
    writerFor: (accountsBox) => (writeTarget ? createBitrixFileWriter({ target: writeTarget, accountsBox, timeoutMs: t.writeMs }) : null),
    downloadCrm: async (bucket, objectPath) => {
      const { data, error } = await withTimeout(admin.storage.from(bucket).download(objectPath), t.storageMs);
      if (error || !data) throw new Error('file unavailable');
      return new Uint8Array(await data.arrayBuffer());
    },
    uploadCrm: async (bucket, objectPath, bytes, mime) => {
      try {
        const { error } = await withTimeout(admin.storage.from(bucket).upload(objectPath, bytes, { upsert: false, contentType: mime }), t.storageMs);
        if (!error) return 'uploaded';
        return isAlreadyExists(error) ? 'exists' : 'error';
      } catch {
        return 'error';
      }
    },
    removeCrm: (bucket, objectPath) => removeMovedSourceObject(admin, bucket, objectPath, t.storageMs),
  });
  return { status: 'ran', ...summary };
}
