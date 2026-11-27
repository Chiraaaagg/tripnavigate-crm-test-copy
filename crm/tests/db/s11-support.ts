import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { expect } from 'vitest';
import {
  type Actor,
  FIXTURE_DEALS as D,
  FIXTURE_USERS as U,
  SYNTHETIC_INTAKE_CONFIG,
  type TestDb,
  migrationFiles,
  resetActor,
  setActor,
} from '../helpers/db';
import { DEAL, HOTEL, OWNER, SALES_B, SUPER, SVC, rid } from './b1-support';
import { SETTING_SQL_B11, SWITCH_REASON, TRAVELLERS, VISA, b11Helpers } from './b11-support';
import { ACC, financeHelpers } from './finance-support';

/**
 * Shared helpers for the S11 "files to Bitrix" database suites
 * (tests/db/s11-*.test.ts), migrations 20261212000100 to 20261212000150.
 *
 * Every scenario runs inside ONE rolled-back owner transaction (asOwner) and
 * switches to an impersonated request only for the statement under test, so
 * the suites run unchanged on PGlite and on the real local Postgres
 * (TEST_DATABASE_URL). Inside one transaction now() does not move: rows that
 * must look old get their times set back explicitly (owner SQL), never by
 * waiting.
 *
 * Synthetic data only. Bitrix deal ids are invented (99xxxx); no Bitrix call
 * is made anywhere (database only).
 */

export const ID_BOX = 'ufCrm_1784359513';
export const ACC_BOX = 'ufCrm_S11SynAccountsBox';
export const PORTAL = 'SYNTHETIC_MEMBER_0001';
export const CONFIG = SYNTHETIC_INTAKE_CONFIG;
export const REASON = 'Synthetic S11 test run, owner approval APPROVE';
export const DESK: Actor = { userId: U.visaJodhpur };
export const ACCOUNTS: Actor = { userId: U.accountsJodhpur };
export const PURCHASE: Actor = { userId: U.purchaseJodhpur };
export const MANAGER: Actor = { userId: U.managerDelhi };
export const ANON: Actor = { userId: null };
export { DEAL, OWNER, SALES_B, SUPER, SVC, rid };
export const DEAL2 = D.del002;

/** The six S11 migrations, in order. */
export const S11_VERSIONS = ['20261212000100', '20261212000110', '20261212000120', '20261212000130', '20261212000140', '20261212000150'];
const root = join(import.meta.dirname, '..', '..');
export const s11Files = () => migrationFiles().filter((f) => S11_VERSIONS.includes(basename(f).slice(0, 14)));
export const REVERT_FILE = join(root, 'supabase', 's11-files-bitrix', 'revert-dec43-functions.sql');
export const migrationText = (version: string): string => {
  const f = migrationFiles().find((x) => basename(x).startsWith(version));
  if (!f) throw new Error(`migration ${version} not found`);
  return readFileSync(f, 'utf8');
};

/** Comment lines dropped; trailing " -- comment" removed. */
export const stripComments = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .map((l) => l.replace(/\s--\s.*$/, ''))
    .join('\n');

/** Text of one function definition: from "create [or replace] function <name>(" to its closing "$$;". */
export function bodyOf(code: string, name: string): string {
  const start = code.search(new RegExp(`create (or replace )?function ${name.replace('.', '\\.')}\\(`));
  if (start < 0) throw new Error(`${name} not found`);
  const end = code.indexOf('\n$$;', start);
  return code.slice(start, end + 4);
}

export const SQL = {
  claim: 'select public.file_move_claim($1, $2) as r',
  mark: 'select public.file_move_mark_sending($1, $2, $3::bigint[]) as r',
  observe: 'select public.file_move_record_observation($1, $2, $3::bigint, $4, $5, $6::timestamptz) as r',
  complete: 'select public.file_move_complete($1, $2, $3, $4, $5::bigint) as r',
  confirmDeleted: 'select public.file_move_confirm_deleted($1, $2) as r',
  confirmRestored: 'select public.file_move_confirm_restored($1, $2) as r',
  stop: 'select public.file_move_stop($1, $2, $3) as r',
  presence: 'select public.file_move_presence_result($1::bigint, $2, $3, $4::bigint[]) as r',
  relocated: 'select public.file_move_relocated($1, $2, $3::bigint, $4, $5) as r',
  sweep: 'select public.file_move_sweep() as r',
  viewBegin: 'select public.file_view_begin($1, $2) as r',
  viewResolve: 'select public.file_view_resolve($1) as r',
  viewFinish: 'select public.file_view_finish($1, $2) as r',
  settingsGet: 'select public.file_move_settings_get() as r',
  setSwitch: 'select public.file_move_set_switch($1, $2, $3) as r',
  setHold: 'select public.file_move_set_hold($1, $2) as r',
  setBox: 'select public.file_move_set_accounts_box($1, $2) as r',
  setPilot: 'select public.file_move_set_pilot($1::bigint, $2) as r',
  ackStop: 'select public.file_move_acknowledge_stop($1, $2) as r',
  alerts: 'select public.file_move_alerts() as r',
  retry: 'select public.file_move_retry($1) as r',
  relocate: 'select public.file_move_relocate($1, $2::bigint) as r',
  acceptLost: 'select public.file_move_accept_lost($1, $2) as r',
  dec43Claim: 'select public.bitrix_id_proof_copy_claim($1, $2) as r',
  dec43Mark: 'select public.bitrix_id_proof_copy_mark_sending($1, $2, $3::bigint[]) as r',
  dec43Complete: 'select public.bitrix_id_proof_copy_complete($1, $2, $3, $4, $5::bigint) as r',
} as const;

export type Job = {
  moveId: string | null;
  leaseToken: string;
  mode: string;
  fileClass?: string;
  sourceTable?: string;
  kindCode?: string;
  bitrixDealId: string;
  bitrixField: string;
  bucket?: string;
  objectPath?: string;
  mime?: string;
  sizeBytes?: number;
  sha256?: string;
  bitrixFileId?: string | null;
  priorFileIds?: string[];
  knownFileIds?: string[];
  attempts?: number;
  expectedFileIds?: string[];
};
export type Dec43Job = { jobId: string; leaseToken: string; mode: string; bitrixDealId: string };

export type MoveRow = {
  id: string; state: string; source_table: string; source_id: string; file_class: string; kind_code: string;
  bucket_id: string; object_path: string; sha256: string; size_bytes: number; deal_id: string | null;
  source_deal_id: string | null; bitrix_field: string | null; bitrix_file_id: string | null; due_days: number | null;
  crm_copy_present: boolean; relocate_due: boolean; keep_in_crm: boolean; last_error_code: string | null;
  lease_token: string | null; lease_mode: string | null; dec43_job_id: string | null; attempts: number;
  read_back_attempts: number; enqueued_by: string; deleted_at_set: boolean; presence_checked: boolean;
};
const MOVE_COLS = `m.id, m.state, m.source_table, m.source_id, m.file_class, m.kind_code, m.bucket_id, m.object_path, m.sha256,
  m.size_bytes, m.deal_id, m.source_deal_id::text as source_deal_id, m.bitrix_field, m.bitrix_file_id::text as bitrix_file_id,
  round(extract(epoch from (m.due_at - m.stored_at)) / 86400)::int as due_days, m.crm_copy_present, m.relocate_due,
  m.keep_in_crm, m.last_error_code, m.lease_token, m.lease_mode, m.dec43_job_id, m.attempts, m.read_back_attempts,
  m.enqueued_by, m.deleted_at is not null as deleted_at_set, m.presence_checked_at is not null as presence_checked`;

/** SHA-256 hex of a label (distinct synthetic file hashes). */
export const hex = (label: string) => createHash('sha256').update(label).digest('hex');

/** The fields of a database error that reach a caller. */
export type DbError = { code?: string; message?: string; hint?: string; detail?: string };
export const pickError = (e: unknown): DbError => {
  const x = e as DbError;
  return { code: x.code, message: x.message, hint: x.hint ?? undefined, detail: x.detail ?? undefined };
};

/** One call as an actor, rolled back: its answer or error, and the audit rows it wrote. */
export type Attempt = {
  ok: boolean;
  value?: Record<string, unknown> | null;
  error?: DbError;
  audits: Array<Record<string, unknown>>;
};

let fileSeq = 0;

export function s11Helpers(getDb: () => TestDb) {
  const db = () => getDb();
  const h = b11Helpers(getDb);
  const f = financeHelpers(getDb);
  const { one, owner } = h;

  const entityId = async () => (await owner<{ id: string }>(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`))[0]!.id;
  const branchId = async (code: string) =>
    (await owner<{ id: string }>(
      `select b.id from public.branches b join public.legal_entities e on e.id = b.legal_entity_id where e.code = 'HOLIDAY_CHACHA' and b.code = $1`,
      [code],
    ))[0]!.id;

  /** Runs `sql` as `actor`; returns the error (never throws), restoring the transaction with a savepoint. */
  async function failure(actor: Actor, sql: string, params: unknown[] = []): Promise<DbError | null> {
    await db().exec('savepoint s11_fail');
    try {
      await setActor(db(), actor);
      await db().query(sql, params);
      await resetActor(db());
      await db().exec('release savepoint s11_fail');
      return null;
    } catch (e) {
      await db().exec('rollback to savepoint s11_fail');
      await resetActor(db());
      return pickError(e);
    }
  }
  /** Owner SQL that must fail: its error (savepoint; the transaction stays usable). */
  async function ownerFailure(sql: string, params: unknown[] = []): Promise<DbError | null> {
    await resetActor(db());
    await db().exec('savepoint s11_owner_fail');
    try {
      await db().query(sql, params);
      await db().exec('release savepoint s11_owner_fail');
      return null;
    } catch (e) {
      await db().exec('rollback to savepoint s11_owner_fail');
      return pickError(e);
    }
  }
  /** Asserts a refusal with this code, message token and (optionally) hint. */
  async function refusedWith(actor: Actor, sql: string, params: unknown[], code: string, message?: string, hint?: string): Promise<void> {
    const e = await failure(actor, sql, params);
    expect(e, `expected ${code} ${message ?? ''} from: ${sql}`).not.toBeNull();
    expect(e!.code).toBe(code);
    if (message !== undefined) expect(e!.message).toBe(message);
    if (hint !== undefined) expect(e!.hint).toBe(hint);
  }

  /**
   * One call as an actor inside a savepoint that is always rolled back: its
   * answer (or error) and every audit row it wrote. Leaves no trace.
   */
  async function attempt(actor: Actor, sql: string, params: unknown[]): Promise<Attempt> {
    await resetActor(db());
    const [top] = await owner<{ n: string }>('select coalesce(max(id), 0)::text as n from public.audit_events');
    await db().exec('savepoint s11_attempt');
    try {
      await setActor(db(), actor);
      const rows = await db().query<{ r: Record<string, unknown> | null }>(sql, params);
      await resetActor(db());
      const audits = await owner<Record<string, unknown>>(
        `select action, actor_user_id, legal_entity_id, branch_id, target_type, target_id, reason, details
         from public.audit_events where id > $1::bigint order by id`,
        [top!.n],
      );
      await db().exec('rollback to savepoint s11_attempt');
      return { ok: true, value: rows[0]!.r, audits };
    } catch (e) {
      await db().exec('rollback to savepoint s11_attempt');
      await resetActor(db());
      return { ok: false, error: pickError(e), audits: [] };
    }
  }

  // ------------------------------------------------------------------ settings

  type SettingsOver = {
    check?: boolean; accounts?: boolean; del?: boolean; everOn?: boolean; box?: string | null; pilot?: number | null;
    hold?: number; holdDays?: number; enqueue?: boolean;
  };
  /** Owner SQL: the company's S11 settings row (created when missing), as given; delete on implies "has been on". */
  async function settings(over: SettingsOver = {}): Promise<void> {
    await resetActor(db());
    const entity = await entityId();
    const del = over.del ?? false;
    await owner(
      `insert into public.file_move_settings (legal_entity_id, check_id_proof_copies, move_accounts_files, delete_after_hold,
         delete_ever_on, accounts_bitrix_field, pilot_source_deal_id, delete_hold_minutes, accounts_hold_days, enqueue_enabled)
       values ($1, $2, $3, $4, $5, $6, $7::bigint, $8, $9, $10)
       on conflict (legal_entity_id) do update set
         check_id_proof_copies = excluded.check_id_proof_copies, move_accounts_files = excluded.move_accounts_files,
         delete_after_hold = excluded.delete_after_hold, delete_ever_on = excluded.delete_ever_on,
         accounts_bitrix_field = excluded.accounts_bitrix_field, pilot_source_deal_id = excluded.pilot_source_deal_id,
         delete_hold_minutes = excluded.delete_hold_minutes, accounts_hold_days = excluded.accounts_hold_days,
         enqueue_enabled = excluded.enqueue_enabled`,
      [entity, over.check ?? false, over.accounts ?? false, del, over.everOn ?? del, over.box === undefined ? ACC_BOX : over.box,
        over.pilot ?? null, over.hold ?? 15, over.holdDays ?? 90, over.enqueue ?? true],
    );
  }
  const settingsRow = async () =>
    (await owner<{ check_id_proof_copies: boolean; move_accounts_files: boolean; delete_after_hold: boolean; delete_ever_on: boolean }>(
      `select s.check_id_proof_copies, s.move_accounts_files, s.delete_after_hold, s.delete_ever_on
       from public.file_move_settings s join public.legal_entities e on e.id = s.legal_entity_id where e.code = 'HOLIDAY_CHACHA'`,
    ))[0];
  async function dec43(on: boolean): Promise<void> {
    await resetActor(db());
    await owner('update public.integration_intake_config set bitrix_id_proof_copy = $2 where id = $1', [CONFIG, on]);
  }

  // ------------------------------------------------------------------ deals

  /** A test-only imported (Bitrix) Deal with the four synthetic travellers saved (no files yet). */
  async function bitrixDeal(sourceDealId: number): Promise<string> {
    const deal = await h.insertRealDeal('C7:NEW', 7, sourceDealId);
    await h.draftWithTravellers(OWNER, deal);
    return deal;
  }
  /**
   * SYNTHETIC FIXTURE STEP: a synthetic fixture Deal is given a Bitrix
   * identity. deals_provenance forbids that for a synthetic Deal; the check is
   * dropped inside this rolled-back transaction only (as acc2-documents does).
   */
  async function bitrixify(deal: string, sourceDealId: number): Promise<void> {
    await resetActor(db());
    await owner('alter table public.deals drop constraint if exists deals_provenance');
    await owner(`update public.deals set source_system = 'bitrix', source_portal = $2, source_deal_id = $3::bigint where id = $1`,
      [deal, PORTAL, sourceDealId]);
  }
  /** Marks a Deal removed by the sync (a synthetic Deal too: that check is dropped inside the transaction only). */
  async function removeDeal(deal: string): Promise<void> {
    await resetActor(db());
    await owner('alter table public.deals drop constraint if exists deals_removed_imported_only');
    await owner(`update public.deals set removed_at = now(), removed_reason = 'stage_not_eligible' where id = $1`, [deal]);
  }
  async function restoreDeal(deal: string): Promise<void> {
    await resetActor(db());
    await owner('update public.deals set removed_at = null, removed_reason = null where id = $1', [deal]);
  }

  // ------------------------------------------------------------------ files

  /** Inserts the Storage row a real upload would leave (owner SQL; the shim or real storage.objects). */
  async function putObject(bucket: string, name: string, size = 2048): Promise<void> {
    await resetActor(db());
    await owner(`insert into storage.objects (bucket_id, name, metadata) values ($1, $2, jsonb_build_object('size', $3::bigint))`,
      [bucket, name, size]);
  }

  /**
   * A stored traveller ID proof. With object: true the Storage row exists and
   * the finish command stores it; otherwise the row is set stored by owner
   * SQL (the guard allows pending_upload -> stored) and Storage holds nothing
   * at its path, which lets the delete confirmations see "object gone".
   */
  async function storeProof(deal: string, seq: number, opts: { sha?: string; object?: boolean; actor?: Actor } = {}) {
    const sha = opts.sha ?? hex(`s11-proof-${deal}-${seq}-${(fileSeq += 1)}`);
    const actor = opts.actor ?? OWNER;
    const begun = await one<{ fileId: string; objectPath: string }>(actor,
      'select public.traveller_id_proof_begin($1, $2, $3, true, $4, $5, $6, $7) as r',
      [deal, seq, rid(), `id-proof-${seq}.jpg`, 'image/jpeg', 2048, sha]);
    if (opts.object) {
      await putObject('traveller-id-proofs', begun.objectPath);
      const fin = await one<{ status: string }>(actor, 'select public.traveller_id_proof_finish($1, true) as r', [begun.fileId]);
      expect(fin.status).toBe('stored');
    } else {
      await resetActor(db());
      await owner(`update public.traveller_id_proofs set status = 'stored', stored_at = now() where id = $1`, [begun.fileId]);
    }
    return { fileId: begun.fileId, objectPath: begun.objectPath, sha };
  }

  /**
   * A stored refund proof (class B "rfd"), inserted directly (owner SQL) on
   * any Deal, with its stored time `storedDaysAgo` days back. No Storage row
   * unless object: true.
   */
  async function refundFile(deal: string, opts: { storedDaysAgo?: number; object?: boolean; status?: 'stored' | 'pending_upload' } = {}) {
    await resetActor(db());
    const id = rid();
    const subject = rid();
    const status = opts.status ?? 'stored';
    const [row] = await owner<{ object_path: string; sha256: string }>(
      `insert into public.refund_evidence (id, legal_entity_id, deal_id, subject_kind, subject_id, object_path, file_name, mime,
         size_bytes, sha256, status, uploaded_by, request_id, stored_at)
       select $1::uuid, d.legal_entity_id, d.id, 'customer_refund', $2::uuid, d.legal_entity_id::text || '/refund/' || $2::text || '/' || $1::text,
         'refund-proof.pdf', 'application/pdf', 2048, $3::text, $5::text, $6::uuid, gen_random_uuid(),
         case when $5::text = 'stored' then now() - make_interval(days => $4::int) end
       from public.deals d where d.id = $7::uuid
       returning object_path, sha256`,
      [id, subject, hex(`s11-refund-${id}`), opts.storedDaysAgo ?? 0, status, U.accountsJodhpur, deal],
    );
    if (opts.object) await putObject('finance-evidence', row!.object_path);
    return { id, objectPath: row!.object_path, sha: row!.sha256 };
  }

  // ------------------------------------------------------------------ move rows

  const moveOf = async (table: string, sourceId: string): Promise<MoveRow | undefined> =>
    (await owner<MoveRow>(`select ${MOVE_COLS} from public.file_bitrix_moves m where m.source_table = $1 and m.source_id = $2`,
      [table, sourceId]))[0];
  const move = async (id: string): Promise<MoveRow> =>
    (await owner<MoveRow>(`select ${MOVE_COLS} from public.file_bitrix_moves m where m.id = $1`, [id]))[0]!;
  const moveIdOf = async (table: string, sourceId: string): Promise<string> => {
    const m = await moveOf(table, sourceId);
    if (!m) throw new Error(`no move row for ${table} ${sourceId}`);
    return m.id;
  };

  /** Owner SQL on one move row (`sets` is a literal SET list written by the test). */
  async function setMove(id: string, sets: string): Promise<void> {
    await resetActor(db());
    await owner(`update public.file_bitrix_moves m set ${sets} where m.id = $1`, [id]);
  }
  /** As setMove, inside the confirm functions' transaction flag (the only way crm_copy_present may change). */
  async function setMoveAsCopyWriter(id: string, sets: string): Promise<void> {
    await resetActor(db());
    await owner(`select set_config('tripnavigate.file_move_copy_writer', 'on', true)`);
    await owner(`update public.file_bitrix_moves m set ${sets} where m.id = $1`, [id]);
    await owner(`select set_config('tripnavigate.file_move_copy_writer', '', true)`);
  }

  const CHECKED = `verified_sha256 = m.sha256, verified_size_bytes = m.size_bytes, verified_at = now() - interval '40 minutes',
    delete_after = now() - interval '25 minutes'`;
  const RECHECKED = `reverified_sha256 = m.sha256, reverified_size_bytes = m.size_bytes, reverified_at = now() - interval '20 minutes',
    reverified_after_append_at = now() - interval '21 minutes'`;
  const NO_LEASE = 'lease_token = null, locked_until = null, lease_mode = null';

  /** copy_pending (S11 copies it), due now. */
  const copyPending = (id: string) => setMove(id, `state = 'copy_pending', next_attempt_at = now(), ${NO_LEASE}`);
  /** copied with a Bitrix file id, due now. */
  const copied = (id: string, fileId: number) =>
    setMove(id, `state = 'copied', bitrix_file_id = ${fileId}, next_attempt_at = now(), ${NO_LEASE}`);
  /** verified, first check 20 minutes ago, hold ended 5 minutes ago (constraint: hold >= 15 minutes). */
  const verifiedPastHold = (id: string, fileId: number) =>
    setMove(id, `state = 'verified', bitrix_file_id = ${fileId}, verified_sha256 = m.sha256, verified_size_bytes = m.size_bytes,
      verified_at = now() - interval '20 minutes', delete_after = now() - interval '5 minutes', next_attempt_at = now(), ${NO_LEASE}`);
  /** delete_pending after two matching observations (CRM copy still present). */
  const deletePending = (id: string, fileId: number) =>
    setMove(id, `state = 'delete_pending', bitrix_file_id = ${fileId}, ${CHECKED}, ${RECHECKED}, next_attempt_at = now(), ${NO_LEASE}`);
  /**
   * Bitrix holds the only copy: the row as after file_move_confirm_deleted,
   * then (optionally) moved on to another state. presence_checked_at stays
   * null so the presence check picks the deal.
   */
  async function soleCopy(id: string, fileId: number, state = 'deleted'): Promise<void> {
    await setMoveAsCopyWriter(id, `state = 'deleted', bitrix_file_id = ${fileId}, ${CHECKED}, ${RECHECKED},
      deleted_at = now() - interval '19 minutes', crm_copy_present = false, presence_checked_at = null, next_attempt_at = now(), ${NO_LEASE}`);
    if (state !== 'deleted') await setMove(id, `state = '${state}', next_attempt_at = now()`);
  }
  /** Gives a row a lease of this mode (as a claim would); returns the token. */
  async function lease(id: string, mode: string, seconds = 180): Promise<string> {
    const token = rid();
    await setMove(id, `lease_token = '${token}'::uuid, locked_until = now() + make_interval(secs => ${seconds}), lease_mode = '${mode}'`);
    return token;
  }
  const expireLease = (id: string) => setMove(id, `locked_until = now() - interval '1 second'`);
  const due = (id: string) => setMove(id, `next_attempt_at = now() - interval '1 second'`);
  /** Moves the box's last append into the past (inside one transaction now() does not move). */
  async function appendSettledAgo(sourceDealId: number, box: string, minutes: number): Promise<void> {
    await resetActor(db());
    await owner(
      `insert into public.file_move_box_state (source_deal_id, bitrix_field, last_append_started_at, last_append_at)
       values ($1::bigint, $2, now() - make_interval(mins => $3), now() - make_interval(mins => $3))
       on conflict (source_deal_id, bitrix_field) do update
         set last_append_started_at = excluded.last_append_started_at, last_append_at = excluded.last_append_at`,
      [sourceDealId, box, minutes],
    );
  }
  const boxState = async (sourceDealId: number, box: string) =>
    (await owner<{ started_set: boolean; appended_now: boolean }>(
      `select b.last_append_started_at is not null as started_set, b.last_append_at = now() as appended_now
       from public.file_move_box_state b where b.source_deal_id = $1::bigint and b.bitrix_field = $2`,
      [sourceDealId, box],
    ))[0];

  // ------------------------------------------------------------------ worker calls

  const claim = (limit = 5, leaseSeconds = 180) => one<Job[]>(SVC, SQL.claim, [limit, leaseSeconds]);
  /** Claims until nothing more is handed out (each call gives at most one job per deal). */
  async function claimAll(): Promise<Job[]> {
    const out: Job[] = [];
    for (let i = 0; i < 20; i += 1) {
      const got = await claim(5);
      if (got.length === 0) break;
      out.push(...got);
    }
    return out;
  }
  const jobFor = (jobs: Job[], moveId: string) => jobs.find((j) => j.moveId === moveId);
  const observe = (job: { moveId: string | null; leaseToken: string }, fileId: number, sha: string, size: number, readStartedSql: string | null) =>
    one<{ result: string }>(SVC, `select public.file_move_record_observation($1, $2, $3::bigint, $4, $5, (${readStartedSql ?? 'null'})::timestamptz) as r`,
      [job.moveId, job.leaseToken, fileId, sha, size]);
  const complete = (job: { moveId: string | null; leaseToken: string }, outcome: string, code: string | null, fileId: number | null = null) =>
    one<{ moveId: string; state: string; attempts: number }>(SVC, SQL.complete, [job.moveId, job.leaseToken, outcome, code, fileId]);

  const dec43Claim = () => one<Dec43Job[]>(SVC, SQL.dec43Claim, [5, 60]);
  const dec43Jobs = (deal: string) =>
    owner<{ id: string; status: string; bitrix_file_id: string | null }>(
      'select id, status, bitrix_file_id::text as bitrix_file_id from public.bitrix_id_proof_copy_jobs where deal_id = $1 order by created_at, id',
      [deal],
    );

  // ------------------------------------------------------------------ records

  const audits = (action: string, targetId?: string) =>
    owner<{ actor_user_id: string | null; target_id: string | null; reason: string | null; details: Record<string, unknown> }>(
      `select actor_user_id, target_id, reason, details from public.audit_events
       where action = $1 and ($2::uuid is null or target_id = $2::uuid) order by id`,
      [action, targetId ?? null],
    );
  const stops = () =>
    owner<{ id: string; move_id: string | null; source_deal_id: string | null; reason_code: string; acknowledged: boolean }>(
      `select id, move_id, source_deal_id::text as source_deal_id, reason_code, acknowledged_at is not null as acknowledged
       from public.file_move_stops order by opened_at, id`,
    );

  // ------------------------------------------------------------------ the seven tables

  const VISA_TASK_SQL = `select id, department from public.fulfilment_tasks where deal_id = $1 order by department`;

  /**
   * SYN-DEL-001 with a confirmed package (hotel + visa, every traveller with
   * an identity and a stored ID proof, a stored acceptance message, booking
   * payment proof and bill), the Visa desk switched on: a Purchase task and a
   * Visa task. As in batch1-deal-documents.
   */
  async function confirmedPackage() {
    const n = TRAVELLERS.length;
    const ready = await h.readyDraft(OWNER, DEAL, [['hotel', { ...HOTEL, adults: n, children: 0 }], ['visa', VISA]], { identities: true });
    expect(ready.issues).toEqual([]);
    const bookingPayment = await h.storeEvidence(OWNER, ready.versionId, 'payment_proof', hex('s11-booking-payment'));
    const bookingBill = await h.storeEvidence(OWNER, ready.versionId, 'bill', hex('s11-booking-bill'));
    const hash = (await h.readiness(OWNER, ready.versionId)).contentHash;
    await h.confirm(OWNER, ready.versionId, hash);
    await one(SUPER, SETTING_SQL_B11, ['visa_passport_tasks_enabled', true, SWITCH_REASON]);
    const tasks = await owner<{ id: string; department: string }>(VISA_TASK_SQL, [DEAL]);
    const task = (dep: string) => {
      const t = tasks.find((x) => x.department === dep);
      if (!t) throw new Error(`no ${dep} task`);
      return t.id;
    };
    const [acceptance] = await owner<{ id: string }>(
      `select id from public.booking_evidence where version_id = $1 and kind = 'acceptance_message' and status = 'stored'`, [ready.versionId]);
    const proofs = await owner<{ id: string }>(`select id from public.traveller_id_proofs where deal_id = $1 and status = 'stored' order by traveller_seq`, [DEAL]);
    return { versionId: ready.versionId, purchaseTask: task('purchase'), visaTask: task('visa'), bookingPayment, bookingBill,
      bookingAcceptance: acceptance!.id, proofs: proofs.map((p) => p.id) };
  }

  /** A Visa / Flight desk file inserted directly (as batch1-deal-documents does). */
  async function departmentFile(taskId: string, kind: string, status: 'stored' | 'pending_upload' = 'stored'): Promise<string> {
    await resetActor(db());
    const id = rid();
    await owner(
      `insert into public.department_evidence (id, task_id, legal_entity_id, kind, object_path, file_name, mime, size_bytes, sha256, status, uploaded_by, stored_at)
       select $1::uuid, t.id, t.legal_entity_id, $2::text, t.legal_entity_id::text || '/' || t.id::text || '/' || $1::text, 'desk-file.pdf',
         'application/pdf', 2048, $3::text, $4::text, $5::uuid, case when $4::text = 'stored' then now() end
       from public.fulfilment_tasks t where t.id = $6::uuid`,
      [id, kind, hex(`s11-dep-${id}`), status, U.visaJodhpur, taskId],
    );
    return id;
  }
  /** A supplier money file inserted directly on a Purchase task (not payment_proof: that needs a payment request). */
  async function supplierMoneyFile(taskId: string, kind: 'proforma' | 'invoice' | 'credit_note', status: 'stored' | 'pending_upload' = 'stored'): Promise<string> {
    await resetActor(db());
    const id = rid();
    await owner(
      `insert into public.supplier_money_evidence (id, legal_entity_id, task_id, kind, object_path, file_name, mime, size_bytes, sha256,
         status, uploaded_by, request_id, stored_at)
       select $1::uuid, t.legal_entity_id, t.id, $2::text, t.legal_entity_id::text || '/' || t.id::text || '/' || $1::text, 'supplier-file.pdf',
         'application/pdf', 2048, $3::text, $4::text, $5::uuid, gen_random_uuid(), case when $4::text = 'stored' then now() end
       from public.fulfilment_tasks t where t.id = $6::uuid`,
      [id, kind, hex(`s11-sm-${id}`), status, U.purchaseJodhpur, taskId],
    );
    return id;
  }
  /** A customer party of SYN-DEL-001's company (Delhi) with a file of this kind; stored unless pending. */
  async function partyFile(kind: 'id_proof' | 'gst_certificate' | 'other', status: 'stored' | 'pending_upload' = 'stored'): Promise<string> {
    await resetActor(db());
    const [party] = await owner<{ id: string }>(
      `insert into public.customer_parties (legal_entity_id, branch_id, party_type, name, created_by, updated_by)
       select b.legal_entity_id, b.id, 'personal', 'Synthetic S11 Party', $1::uuid, $1::uuid
       from public.branches b join public.legal_entities e on e.id = b.legal_entity_id where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL'
       returning id`,
      [U.salesDelhiA],
    );
    const id = rid();
    await owner(
      `insert into public.customer_party_documents (id, party_id, legal_entity_id, kind, request_id, consent_by, consent_at, object_path,
         file_name, mime, size_bytes, sha256, uploaded_by)
       select $1::uuid, p.id, p.legal_entity_id, $2::text, gen_random_uuid(), case when $2::text = 'id_proof' then $3::uuid end,
         case when $2::text = 'id_proof' then now() end, p.legal_entity_id::text || '/' || p.id::text || '/' || $1::text,
         'party-file.pdf', 'application/pdf', 2048, $4::text, $3::uuid
       from public.customer_parties p where p.id = $5::uuid`,
      [id, kind, U.salesDelhiA, hex(`s11-party-${id}`), party!.id],
    );
    if (status === 'stored') {
      await owner(`update public.customer_party_documents set status = 'stored', stored_at = now() where id = $1`, [id]);
    }
    return id;
  }
  /** A bank receipt with a stored bank proof, a cheque receipt with a stored cheque image, a stored deposit slip. */
  async function financeFiles() {
    const bank = await f.record(ACC, DEAL, await f.bankFields());
    const bankProof = await f.proof(ACC, 'receipt', bank.id, 'bank_proof', hex(`s11-bank-${bank.id}`));
    const cheque = await f.record(ACC, DEAL, await f.chequeFields());
    const chequeImage = await f.proof(ACC, 'receipt', cheque.id, 'cheque_image', hex(`s11-cheque-${cheque.id}`));
    const slip = await f.proof(ACC, 'branch', await branchId('JDH'), 'deposit_slip', hex(`s11-slip-${bank.id}`));
    // A begun (never finished) bank proof on a third receipt: a non-stored file.
    const third = await f.record(ACC, DEAL, await f.bankFields());
    const pending = await one<{ id: string }>(ACC, 'select public.finance_evidence_begin($1, $2, $3, $4, $5, $6, $7, $8) as r',
      ['receipt', third.id, 'bank_proof', 'pending.pdf', 'application/pdf', 2048, hex(`s11-bank-pending-${third.id}`), rid()]);
    return { bankProof, chequeImage, slip, pending: pending.id };
  }
  /** A booking draft on SYN-DEL-001 with stored acceptance, payment proof and bill; a begun file on SYN-DEL-002. */
  async function bookingFiles() {
    await h.setSwitch('service_items_enabled', true);
    const opened = await h.openDraft(OWNER, DEAL);
    const acceptance = await h.storeEvidence(OWNER, opened.versionId, 'acceptance_message', hex('s11-booking-acc'));
    const payment = await h.storeEvidence(OWNER, opened.versionId, 'payment_proof', hex('s11-booking-pay'));
    const bill = await h.storeEvidence(OWNER, opened.versionId, 'bill', hex('s11-booking-bill2'));
    const other = await h.openDraft(SALES_B, DEAL2);
    const pending = await one<{ evidenceId: string }>(SALES_B, 'select public.booking_begin_evidence($1, $2, $3, $4, $5, $6) as r',
      [other.versionId, 'payment_proof', 'pending.pdf', 'application/pdf', 2048, hex('s11-booking-pending')]);
    return { versionId: opened.versionId, acceptance, payment, bill, pending: pending.evidenceId };
  }
  /** Stored traveller proofs on SYN-DEL-001 (seq 1, 2) and a begun proof on SYN-DEL-002. */
  async function proofFiles() {
    await h.draftWithTravellers(OWNER, DEAL);
    const one1 = await storeProof(DEAL, 1, { object: true });
    const two = await storeProof(DEAL, 2, { object: true });
    await h.draftWithTravellers(SALES_B, DEAL2);
    const begun = await one<{ fileId: string }>(SALES_B, 'select public.traveller_id_proof_begin($1, $2, $3, true, $4, $5, $6, $7) as r',
      [DEAL2, 1, rid(), 'pending.jpg', 'image/jpeg', 2048, hex('s11-proof-pending')]);
    return { stored: [one1.fileId, two.fileId], pending: begun.fileId };
  }

  return {
    ...h, h, f, entityId, branchId, failure, ownerFailure, refusedWith, attempt, settings, settingsRow, dec43, bitrixDeal, bitrixify, removeDeal,
    restoreDeal, putObject, storeProof, refundFile, moveOf, move, moveIdOf, setMove, setMoveAsCopyWriter, copyPending, copied,
    verifiedPastHold, deletePending, soleCopy, lease, expireLease, due, appendSettledAgo, boxState, claim, claimAll, jobFor,
    observe, complete, dec43Claim, dec43Jobs, audits, stops, confirmedPackage, departmentFile, supplierMoneyFile, partyFile,
    financeFiles, bookingFiles, proofFiles,
  };
}
