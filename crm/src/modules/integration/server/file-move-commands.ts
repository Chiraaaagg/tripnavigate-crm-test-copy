import 'server-only';
import { z } from 'zod';
import type { RpcClient } from '../commands';

/**
 * S11 "files to Bitrix": typed wrappers for the worker's database commands
 * (service role only; migrations 20261212000120 and 20261212000130). The
 * caller passes the service-role client. Every answer is checked; anything
 * unexpected throws FileMoveCommandError (fail closed).
 *
 * The database, not the worker, compares observed hashes and sizes with its
 * own record: these wrappers only hand over what was observed.
 *
 * Bitrix ids (deal ids and file ids) arrive as digit strings and are passed
 * on as given (deal ids) or as safe integers (file ids). They never appear in
 * an error message.
 */

/** Database refusals the worker distinguishes; anything else is 'other'. */
export type FileMoveRefusal = 'task_conflict' | 'wrong_state' | 'invalid_input' | 'not_authorized' | 'not_found' | 'other';

const REFUSALS: Record<string, FileMoveRefusal> = {
  PT409: 'task_conflict',
  '55000': 'wrong_state',
  '22023': 'invalid_input',
  '42501': 'not_authorized',
  P0002: 'not_found',
};

export class FileMoveCommandError extends Error {
  override name = 'FileMoveCommandError';
  constructor(
    readonly command: string,
    readonly sqlState: string | null,
    readonly refusal: FileMoveRefusal | null,
  ) {
    // Never the database message: it could echo arguments.
    super(`${command} failed${sqlState ? ` (${sqlState})` : ''}`);
  }
}

async function invoke(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await client.rpc(fn, args);
  if (error) {
    const state = typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null;
    throw new FileMoveCommandError(fn, state, state ? (REFUSALS[state] ?? 'other') : 'other');
  }
  return data;
}

function parse<T>(fn: string, schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new FileMoveCommandError(fn, null, null);
  return parsed.data;
}

const digits = z.union([z.string().regex(/^[1-9]\d{0,17}$/), z.number().int().positive()]).transform(String);
/** A Bitrix file id as a safe integer. */
const fileId = z
  .union([z.string().regex(/^[1-9]\d{0,15}$/), z.number().int().positive()])
  .transform(Number)
  .refine((n) => Number.isSafeInteger(n) && n > 0);
const fileIds = z.array(fileId);
const boxKey = z.string().regex(/^ufCrm_[0-9A-Za-z_]{1,40}$/);

export const FILE_MOVE_MODES = ['copy', 'verify_copy', 'verify', 'reverify', 'delete', 'confirm_delete', 'restore', 'relocate'] as const;
export type FileMoveRowMode = (typeof FILE_MOVE_MODES)[number];
export const FILE_MOVE_MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const;
export const FILE_MOVE_KIND_CODES = ['id', 'bank', 'chq', 'dep', 'rfd', 'pro', 'pay', 'inv', 'cn', 'bill', 'fee', 'dpp'] as const;

const RowJobSchema = z.object({
  moveId: z.uuid(),
  leaseToken: z.uuid(),
  mode: z.enum(FILE_MOVE_MODES),
  fileClass: z.enum(['id_proof', 'accounts']),
  sourceTable: z.enum([
    'traveller_id_proofs',
    'department_evidence',
    'customer_party_documents',
    'finance_evidence',
    'refund_evidence',
    'supplier_money_evidence',
    'booking_evidence',
  ]),
  kindCode: z.enum(FILE_MOVE_KIND_CODES),
  bitrixDealId: digits,
  bitrixField: boxKey,
  bucket: z.string().regex(/^[a-z0-9-]{3,63}$/),
  objectPath: z.string().min(1).max(1024),
  mime: z.enum(FILE_MOVE_MIMES),
  sizeBytes: z.number().int().min(1).max(4_194_304),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bitrixFileId: fileId.nullable(),
  priorFileIds: fileIds.default([]),
  knownFileIds: fileIds.default([]),
  attempts: z.number().int().nonnegative(),
  /** Database time the lease was handed out (review 14a P2-1). */
  leasedAt: z.string().refine((v) => Number.isFinite(Date.parse(v)), 'leasedAt').optional(),
});

const PresenceJobSchema = z.object({
  moveId: z.null(),
  leaseToken: z.uuid(),
  mode: z.literal('presence'),
  bitrixDealId: digits,
  bitrixField: boxKey,
  expectedFileIds: fileIds,
});

export type FileMoveRowJob = z.infer<typeof RowJobSchema>;
export type FilePresenceJob = z.infer<typeof PresenceJobSchema>;
export type FileMoveJob = FileMoveRowJob | FilePresenceJob;

const JobSchema = z.union([PresenceJobSchema, RowJobSchema]);

/** Leased jobs (the worker asks for one at a time: limit 1, lease 180 s). */
export async function claimFileMoves(client: RpcClient, limit = 1, leaseSeconds = 180): Promise<FileMoveJob[]> {
  const fn = 'file_move_claim';
  const data = await invoke(client, fn, { p_limit: limit, p_lease_seconds: leaseSeconds });
  return parse(fn, z.array(JobSchema), data ?? []);
}

type Lease = { moveId: string; leaseToken: string };

const MOVE_STATES = [
  'no_target',
  'waiting',
  'copy_pending',
  'copy_sending',
  'copy_unknown',
  'copied',
  'verified',
  'delete_pending',
  'deleted',
  'restore_pending',
  'quarantined',
  'needs_manual_check',
  'failed',
  'lost_in_bitrix',
  'lost_accepted',
  'cancelled',
] as const;
export type FileMoveState = (typeof MOVE_STATES)[number];

/** Records the box's file ids and moves the row to copy_sending before the write. */
export async function markFileMoveSending(client: RpcClient, job: Lease, priorFileIds: number[]): Promise<{ moveId: string; state: FileMoveState }> {
  const fn = 'file_move_mark_sending';
  const data = await invoke(client, fn, { p_id: job.moveId, p_lease_token: job.leaseToken, p_prior_file_ids: priorFileIds });
  return parse(fn, z.object({ moveId: z.uuid(), state: z.enum(MOVE_STATES) }), data);
}

export type ObservationResult = 'verified' | 'delete_pending' | 'restore_checked' | 'retry' | 'quarantined';

/** Hands over one observation; the database compares it with its own record and answers. */
export async function recordFileMoveObservation(
  client: RpcClient,
  job: Lease,
  observation: { bitrixFileId: number; sha256: string; sizeBytes: number; readStartedAt: string },
): Promise<ObservationResult> {
  const fn = 'file_move_record_observation';
  const data = await invoke(client, fn, {
    p_id: job.moveId,
    p_lease_token: job.leaseToken,
    p_bitrix_file_id: observation.bitrixFileId,
    p_observed_sha256: observation.sha256,
    p_observed_size: observation.sizeBytes,
    p_read_started_at: observation.readStartedAt,
  });
  return parse(fn, z.object({ result: z.enum(['verified', 'delete_pending', 'restore_checked', 'retry', 'quarantined']) }), data).result;
}

export const FILE_MOVE_OUTCOMES = ['copied', 'unknown', 'not_sent', 'retry', 'failed', 'deal_not_found', 'not_in_box', 'released'] as const;
export type FileMoveOutcome = (typeof FILE_MOVE_OUTCOMES)[number];
/** Error codes the database accepts. */
export const FILE_MOVE_ERROR_CODE = /^[a-z_]{1,60}$/;

/** Every outcome that is not an observation. A code is required except for copied and released. */
export async function completeFileMove(
  client: RpcClient,
  job: Lease,
  outcome: FileMoveOutcome,
  errorCode: string | null,
  bitrixFileId: number | null = null,
): Promise<{ moveId: string; state: FileMoveState; attempts: number }> {
  const fn = 'file_move_complete';
  if (errorCode !== null && !FILE_MOVE_ERROR_CODE.test(errorCode)) throw new FileMoveCommandError(fn, null, 'invalid_input');
  if (errorCode === null && outcome !== 'copied' && outcome !== 'released') throw new FileMoveCommandError(fn, null, 'invalid_input');
  if (outcome === 'copied' && bitrixFileId === null) throw new FileMoveCommandError(fn, null, 'invalid_input');
  const data = await invoke(client, fn, {
    p_id: job.moveId,
    p_lease_token: job.leaseToken,
    p_outcome: outcome,
    p_error_code: errorCode,
    p_bitrix_file_id: bitrixFileId,
  });
  return parse(fn, z.object({ moveId: z.uuid(), state: z.enum(MOVE_STATES), attempts: z.number().int() }), data);
}

/** After a Storage remove (or instead of one): the database looks at Storage itself. */
export async function confirmFileMoveDeleted(client: RpcClient, job: Lease): Promise<'deleted' | 'still_present' | 'back_to_verified'> {
  const fn = 'file_move_confirm_deleted';
  const data = await invoke(client, fn, { p_id: job.moveId, p_lease_token: job.leaseToken });
  return parse(fn, z.object({ result: z.enum(['deleted', 'still_present', 'back_to_verified']) }), data).result;
}

/**
 * After a restore upload: the worker read the object back from Storage and
 * passes what it observed; the database compares it with the row and looks at
 * Storage itself (review 14a P3-6).
 */
export async function confirmFileMoveRestored(
  client: RpcClient,
  job: Lease,
  stored: { sha256: string; sizeBytes: number },
): Promise<'restored' | 'missing'> {
  const fn = 'file_move_confirm_restored';
  const data = await invoke(client, fn, {
    p_id: job.moveId,
    p_lease_token: job.leaseToken,
    p_stored_sha256: stored.sha256,
    p_stored_size: stored.sizeBytes,
  });
  return parse(fn, z.object({ result: z.enum(['restored', 'missing']) }), data).result;
}

/** Just before the Storage remove: is this delete lease still held, with time left? (review 14a P3-7) */
export async function fileMoveLeaseOk(client: RpcClient, job: Lease, minSeconds: number): Promise<boolean> {
  const fn = 'file_move_lease_ok';
  const data = await invoke(client, fn, { p_id: job.moveId, p_lease_token: job.leaseToken, p_min_seconds: minSeconds });
  return parse(fn, z.object({ ok: z.boolean() }), data).ok;
}

export type FileMoveStopReason = 'prior_files_lost' | 'copy_mismatch' | 'missing_in_bitrix' | 'deal_not_found';

/** Opens a stop and turns the delete switch off (audited, one transaction). */
export async function stopFileMove(client: RpcClient, job: Lease, reasonCode: FileMoveStopReason): Promise<{ stopId: string }> {
  const fn = 'file_move_stop';
  const data = await invoke(client, fn, { p_id: job.moveId, p_lease_token: job.leaseToken, p_reason_code: reasonCode });
  return parse(fn, z.object({ stopId: z.uuid() }), data);
}

/** Every file id present in one Deal's box (presence job); null = Bitrix does not know the deal. */
export async function recordFilePresence(
  client: RpcClient,
  job: Pick<FilePresenceJob, 'bitrixDealId' | 'bitrixField' | 'leaseToken'>,
  presentFileIds: number[] | null,
): Promise<{ checked: number; missing: number; dealNotFound?: boolean }> {
  const fn = 'file_move_presence_result';
  const data = await invoke(client, fn, {
    p_source_deal_id: job.bitrixDealId,
    p_bitrix_field: job.bitrixField,
    p_lease_token: job.leaseToken,
    p_present_ids: presentFileIds,
  });
  return parse(fn, z.object({ checked: z.number().int().nonnegative(), missing: z.number().int().nonnegative(), dealNotFound: z.boolean().optional() }), data);
}

/** One relocation candidate's observation; the database compares. */
export async function recordFileRelocated(
  client: RpcClient,
  job: Lease,
  observation: { newFileId: number; sha256: string; sizeBytes: number },
): Promise<'relocated' | 'no_match'> {
  const fn = 'file_move_relocated';
  const data = await invoke(client, fn, {
    p_id: job.moveId,
    p_lease_token: job.leaseToken,
    p_new_file_id: observation.newFileId,
    p_observed_sha256: observation.sha256,
    p_observed_size: observation.sizeBytes,
  });
  return parse(fn, z.object({ result: z.enum(['relocated', 'no_match']) }), data).result;
}

/** Lists files a failed listing trigger missed and marks due rows. */
export async function sweepFileMoves(client: RpcClient): Promise<{ created: number; madeDue: number; stuck: number }> {
  const fn = 'file_move_sweep';
  const data = await invoke(client, fn, {});
  return parse(fn, z.object({ created: z.number().int().nonnegative(), madeDue: z.number().int().nonnegative(), stuck: z.number().int().nonnegative() }), data);
}

/**
 * The location of one view the authorize call just allowed (once, within
 * 60 seconds). Slice 3 may call this or its own wrapper; the shape is the
 * freeze's. The answer holds Bitrix ids: server memory only, never logged.
 */
export async function resolveFileView(
  client: RpcClient,
  viewId: string,
): Promise<{ bitrixDealId: string; bitrixField: string; bitrixFileId: number; sha256: string; sizeBytes: number; mime: (typeof FILE_MOVE_MIMES)[number] }> {
  const fn = 'file_view_resolve';
  const data = await invoke(client, fn, { p_view_id: viewId });
  return parse(
    fn,
    z.object({
      bitrixDealId: digits,
      bitrixField: boxKey,
      bitrixFileId: fileId,
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      sizeBytes: z.number().int().min(1).max(4_194_304),
      mime: z.enum(FILE_MOVE_MIMES),
    }),
    data,
  );
}
