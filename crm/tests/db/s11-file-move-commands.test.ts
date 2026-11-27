import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { CONFLICT_STATE } from '../helpers/sqlstates';
import { ACC_BOX, ACCOUNTS, ID_BOX, type Job, OWNER, REASON, SQL, SUPER, SVC, s11Helpers } from './s11-support';

/**
 * S11 "files to Bitrix", worker commands (20261212000120), Super Admin
 * commands (20261212000130) and owner helpers (20261212000150); contract file
 * 14 section 2.3/2.5, file 11 section 4.2 "s11-file-move-commands":
 *   - the database compares every observation (wrong hash, wrong size, wrong
 *     file id, too early); there is no way for the worker to assert a match;
 *   - file_move_complete refuses verified, delete_pending and deleted;
 *   - nothing is claimed with the switches off, except restore, confirm_delete,
 *     presence and relocate (switch independence);
 *   - pilot scope; the delete switch first needs a pilot; pilot_make_due
 *     refuses any other deal;
 *   - rows of a removed deal are skipped in every mode and resume on return;
 *   - deal_not_found; lease expiry; confirm_deleted / confirm_restored against
 *     storage.objects (and fail closed without it); quarantine turns the delete
 *     switch off; crm_copy_present stays false when a deleted row moves on;
 *   - the Super Admin commands (switches, hold, box, pilot, stops, alerts,
 *     retry, relocate, accept lost) and the owner restore request.
 * The per-deal lock and the two-way rules with DEC-43 are in s11-two-way-lock,
 * the presence check in s11-presence. Synthetic fixtures; every case rolled back.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const s = s11Helpers(() => db);
const { one, owner } = s;
const SUPER_AAL1: Actor = { userId: U.adminJodhpur, aal: 'aal1' };
const NOW_MINUS_1M = "now() - interval '1 minute'";

/** A Bitrix Deal with `n` stored traveller proofs (no Storage rows unless objects) and their move rows. */
async function dealWithRows(sourceDealId: number, n: number, opts: { objects?: boolean } = {}) {
  const deal = await s.bitrixDeal(sourceDealId);
  const rows: Array<{ id: string; fileId: string; objectPath: string; sha: string }> = [];
  for (let seq = 1; seq <= n; seq += 1) {
    const p = await s.storeProof(deal, seq, { object: opts.objects ?? false });
    rows.push({ id: await s.moveIdOf('traveller_id_proofs', p.fileId), fileId: p.fileId, objectPath: p.objectPath, sha: p.sha });
  }
  return { deal, sourceDealId, rows };
}
const modes = (jobs: Job[]) => Object.fromEntries(jobs.filter((j) => j.moveId).map((j) => [j.moveId!, j.mode]));
const settingsNow = async () =>
  (await owner<{ del: boolean; ever: boolean; check: boolean }>(
    `select s.delete_after_hold as del, s.delete_ever_on as ever, s.check_id_proof_copies as check
     from public.file_move_settings s join public.legal_entities e on e.id = s.legal_entity_id where e.code = 'HOLIDAY_CHACHA'`))[0];

describe('claim: switch independence and pilot scope', () => {
  it('all switches off: copy, verify, reverify and delete are not handed out; restore, confirm_delete, presence and relocate are', async () => {
    await asOwner(db, async () => {
      const a = await dealWithRows(993301, 4);
      const b = await dealWithRows(993302, 2);
      const c = await dealWithRows(993303, 1);
      await s.copyPending(a.rows[0]!.id);
      await s.copied(a.rows[1]!.id, 801);
      await s.verifiedPastHold(a.rows[2]!.id, 802);
      await s.deletePending(a.rows[3]!.id, 803);
      await s.soleCopy(b.rows[0]!.id, 811, 'restore_pending');
      await s.soleCopy(b.rows[1]!.id, 812);
      await s.setMove(b.rows[1]!.id, 'relocate_due = true');
      await s.soleCopy(c.rows[0]!.id, 821);
      // No settings row at all: every switch Off.
      const jobs = await s.claimAll();
      expect(modes(jobs)).toEqual({ [a.rows[3]!.id]: 'confirm_delete', [b.rows[0]!.id]: 'restore', [b.rows[1]!.id]: 'relocate' });
      const presence = jobs.filter((j) => j.mode === 'presence');
      expect(presence).toEqual([expect.objectContaining({ moveId: null, bitrixDealId: '993303', bitrixField: ID_BOX, expectedFileIds: ['821'] })]);
      for (const r of a.rows.slice(0, 3)) expect((await s.move(r.id)).lease_token).toBeNull();
    });
  });

  it('switches on: copy, verify, reverify and delete are handed out, at most one job per deal per call', async () => {
    await asOwner(db, async () => {
      await s.settings({ check: true, del: true });
      const a = await dealWithRows(993304, 3);
      const b = await dealWithRows(993305, 1);
      await s.copyPending(a.rows[0]!.id);
      await s.copied(a.rows[1]!.id, 831);
      await s.verifiedPastHold(a.rows[2]!.id, 832);
      await s.deletePending(b.rows[0]!.id, 833);
      const first = await s.claim(5);
      expect(first.filter((j) => j.bitrixDealId === '993304')).toHaveLength(1);
      expect(first.find((j) => j.bitrixDealId === '993304')).toMatchObject({ moveId: a.rows[2]!.id, mode: 'reverify', bitrixFileId: '832' });
      expect(first.find((j) => j.bitrixDealId === '993305')).toMatchObject({ moveId: b.rows[0]!.id, mode: 'delete' });
      const rest = await s.claimAll();
      expect(modes(rest)).toEqual({ [a.rows[1]!.id]: 'verify', [a.rows[0]!.id]: 'copy' });
      // A verified row still inside its hold is not handed out.
      const late = await dealWithRows(993306, 1);
      await s.setMove(late.rows[0]!.id, `state = 'verified', bitrix_file_id = 834, verified_sha256 = m.sha256,
        verified_size_bytes = m.size_bytes, verified_at = now(), delete_after = now() + interval '15 minutes', next_attempt_at = now()`);
      expect(await s.claimAll()).toEqual([]);
    });
  });

  it('pilot scope: with a pilot deal set, a verified row of another deal past its hold is not re-checked or deleted, and Accounts modes run only on the pilot', async () => {
    await asOwner(db, async () => {
      const pilot = await dealWithRows(993311, 1);
      const other = await dealWithRows(993312, 2);
      await s.settings({ check: true, accounts: true, del: true, pilot: 993311, box: ACC_BOX });
      await s.verifiedPastHold(pilot.rows[0]!.id, 841);
      await s.verifiedPastHold(other.rows[0]!.id, 842);
      await s.deletePending(other.rows[1]!.id, 843);
      const pilotAcc = await s.refundFile(pilot.deal, { storedDaysAgo: 91 });
      const otherAcc = await s.refundFile(other.deal, { storedDaysAgo: 91 });
      expect((await one<{ madeDue: number }>(SVC, SQL.sweep, [])).madeDue).toBe(2);
      const jobs = await s.claimAll();
      const pm = await s.moveIdOf('refund_evidence', pilotAcc.id);
      const om = await s.moveIdOf('refund_evidence', otherAcc.id);
      expect(modes(jobs)).toEqual({ [pilot.rows[0]!.id]: 'reverify', [other.rows[1]!.id]: 'confirm_delete', [pm]: 'copy' });
      expect((await s.move(om)).state).toBe('copy_pending');
      expect((await s.move(other.rows[0]!.id)).lease_token).toBeNull();
    });
  });

  it('the delete switch is first turned on only with a pilot; pilot_make_due refuses any other deal', async () => {
    await asOwner(db, async () => {
      const pilot = await dealWithRows(993313, 1);
      await s.refusedWith(SUPER, SQL.setSwitch, ['delete_after_hold', true, REASON], '55000', 'wrong_state', 'pilot_required');
      await s.refusedWith(SUPER, SQL.setPilot, [993999, REASON], '22023', 'invalid_input', 'sourceDealId');
      expect(await one(SUPER, SQL.setPilot, [993313, REASON])).toEqual({ changed: true, pilotBitrixDealId: '993313' });
      expect(await one(SUPER, SQL.setSwitch, ['delete_after_hold', true, REASON])).toEqual({ changed: true, switch: 'delete_after_hold', on: true });
      expect(await settingsNow()).toMatchObject({ del: true, ever: true });
      // Clearing the pilot is the company-wide start; the switch stays on; off and on again needs no pilot any more.
      expect(await one(SUPER, SQL.setPilot, [null, REASON])).toEqual({ changed: true, pilotBitrixDealId: null });
      await one(SUPER, SQL.setSwitch, ['delete_after_hold', false, REASON]);
      expect(await one(SUPER, SQL.setSwitch, ['delete_after_hold', true, REASON])).toMatchObject({ changed: true });

      // pilot_make_due: owner SQL, pilot deal only.
      await one(SUPER, SQL.setPilot, [993313, REASON]);
      const early = await s.refundFile(pilot.deal, { storedDaysAgo: 1 });
      for (const other of [993314, null]) {
        expect(await s.ownerFailure('select authz.file_move_pilot_make_due($1::bigint)', [other]))
          .toMatchObject({ code: '55000', message: 'wrong_state', hint: 'not_pilot' });
      }
      const made = await owner<{ r: { madeDue: number } }>('select authz.file_move_pilot_make_due(993313) as r');
      expect(made[0]!.r.madeDue).toBe(1);
      const m = await s.moveOf('refund_evidence', early.id);
      expect(m!.due_days).toBeLessThan(90);
      expect((await s.audits('files.move_pilot_made_due')).length).toBe(1);
    });
  });
});

describe('observations: the database compares', () => {
  async function verifyJob(sourceDealId: number, fileId: number) {
    const d = await dealWithRows(sourceDealId, 1);
    await s.copied(d.rows[0]!.id, fileId);
    const [job] = await s.claim(1);
    expect(job).toMatchObject({ moveId: d.rows[0]!.id, mode: 'verify', bitrixFileId: String(fileId) });
    return { d, job: job!, row: d.rows[0]! };
  }

  it('first check equal: verified, delete_after = now + hold, lease released; there is no argument to assert a match', async () => {
    await asOwner(db, async () => {
      await s.settings({ check: true });
      const { job, row } = await verifyJob(993321, 851);
      expect(await s.observe(job, 851, row.sha, 2048, null)).toEqual({ result: 'verified' });
      const [t] = await owner<{ hold: boolean; next: boolean; at: boolean }>(
        `select delete_after = now() + interval '15 minutes' as hold, next_attempt_at = delete_after as next, verified_at = now() as at
         from public.file_bitrix_moves where id = $1`, [row.id]);
      expect(t).toEqual({ hold: true, next: true, at: true });
      expect(await s.move(row.id)).toMatchObject({ state: 'verified', lease_token: null, lease_mode: null });
      expect(await s.audits('files.move_verified', row.id)).toHaveLength(1);
      const [args] = await owner<{ a: string }>(
        `select pg_get_function_identity_arguments('public.file_move_record_observation(uuid, uuid, bigint, text, integer, timestamptz)'::regprocedure) as a`);
      expect(args!.a).toBe('p_id uuid, p_lease_token uuid, p_bitrix_file_id bigint, p_observed_sha256 text, p_observed_size integer, p_read_started_at timestamp with time zone');
    });
  });

  it('wrong hash or wrong size: quarantined, an alert, the delete switch off (audited); wrong file id is refused', async () => {
    await asOwner(db, async () => {
      await s.settings({ check: true, del: true });
      const one1 = await verifyJob(993322, 852);
      await s.refusedWith(SVC, SQL.observe, [one1.job.moveId, one1.job.leaseToken, 999, one1.row.sha, 2048, null], '22023', 'invalid_input', 'bitrixFileId');
      await s.refusedWith(SVC, SQL.observe, [one1.job.moveId, one1.job.leaseToken, 852, 'NOT-A-HASH', 2048, null], '22023', 'invalid_input', 'observedSha256');
      expect((await s.move(one1.row.id)).state).toBe('copied');
      expect(await s.observe(one1.job, 852, 'f'.repeat(64), 2048, null)).toEqual({ result: 'quarantined' });
      expect(await s.move(one1.row.id)).toMatchObject({ state: 'quarantined', last_error_code: 'copy_mismatch', crm_copy_present: true });
      expect(await settingsNow()).toMatchObject({ del: false });
      expect((await s.stops()).map((x) => [x.move_id, x.reason_code])).toEqual([[one1.row.id, 'copy_mismatch']]);
      const [auto] = await s.audits('files.move_switch_changed');
      expect(auto!.details).toMatchObject({ switch: 'delete_after_hold', before: true, after: false, automatic: true, reasonCode: 'copy_mismatch' });
      expect(await s.audits('files.move_quarantined', one1.row.id)).toHaveLength(1);

      const two = await verifyJob(993323, 853);
      expect(await s.observe(two.job, 853, two.row.sha, 2047, null)).toEqual({ result: 'quarantined' });
      expect((await s.move(two.row.id)).state).toBe('quarantined');
    });
  });

  it('second check: too early, read started before the hold or not after the last append -> retry; otherwise delete_pending', async () => {
    await asOwner(db, async () => {
      await s.settings({ check: true, del: true });
      const d = await dealWithRows(993324, 2);
      // Just verified (hold not over): a reverify lease given by hand is answered "retry".
      const early = d.rows[0]!;
      await s.setMove(early.id, `state = 'verified', bitrix_file_id = 861, verified_sha256 = m.sha256, verified_size_bytes = m.size_bytes,
        verified_at = now(), delete_after = now() + interval '15 minutes'`);
      const t1 = await s.lease(early.id, 'reverify');
      expect(await s.observe({ moveId: early.id, leaseToken: t1 }, 861, early.sha, 2048, 'now()')).toEqual({ result: 'retry' });
      expect(await s.move(early.id)).toMatchObject({ state: 'verified', lease_token: null });

      const row = d.rows[1]!;
      await s.verifiedPastHold(row.id, 862);
      await s.appendSettledAgo(993324, ID_BOX, 10);
      const [job] = (await s.claimAll()).filter((j) => j.moveId === row.id);
      expect(job).toMatchObject({ mode: 'reverify' });
      // Read started before delete_after (now - 5 minutes).
      expect(await s.observe(job!, 862, row.sha, 2048, "now() - interval '6 minutes'")).toEqual({ result: 'retry' });
      await s.due(row.id);
      const [again] = (await s.claimAll()).filter((j) => j.moveId === row.id);
      // Read start missing, or in the future.
      expect(await s.observe(again!, 862, row.sha, 2048, null)).toEqual({ result: 'retry' });
      await s.due(row.id);
      const [third] = (await s.claimAll()).filter((j) => j.moveId === row.id);
      expect(await s.observe(third!, 862, row.sha, 2048, "now() + interval '1 second'")).toEqual({ result: 'retry' });
      // Not after the last append.
      await s.appendSettledAgo(993324, ID_BOX, 2);
      await s.due(row.id);
      const [fourth] = (await s.claimAll()).filter((j) => j.moveId === row.id);
      expect(await s.observe(fourth!, 862, row.sha, 2048, "now() - interval '3 minutes'")).toEqual({ result: 'retry' });
      // Read started after the hold and after the last append: delete_pending, with the read start recorded.
      await s.due(row.id);
      const [fifth] = (await s.claimAll()).filter((j) => j.moveId === row.id);
      expect(await s.observe(fifth!, 862, row.sha, 2048, NOW_MINUS_1M)).toEqual({ result: 'delete_pending' });
      const [after] = await owner<{ ok: boolean }>(
        `select reverified_after_append_at = now() - interval '1 minute' and reverified_at = now() as ok from public.file_bitrix_moves where id = $1`, [row.id]);
      expect(after!.ok).toBe(true);
      expect(await s.audits('files.move_reverified', row.id)).toHaveLength(1);
      // A mismatch at the second check quarantines.
      const d2 = await dealWithRows(993325, 1);
      await s.verifiedPastHold(d2.rows[0]!.id, 863);
      const [j2] = (await s.claimAll()).filter((j) => j.moveId === d2.rows[0]!.id);
      expect(await s.observe(j2!, 863, 'e'.repeat(64), 2048, NOW_MINUS_1M)).toEqual({ result: 'quarantined' });
    });
  });

  it('a lease is needed and must match the mode; an expired lease is refused', async () => {
    await asOwner(db, async () => {
      await s.settings({ check: true });
      const { job, row } = await verifyJob(993326, 864);
      await s.refusedWith(SVC, SQL.observe, [row.id, '00000000-0000-4000-8000-000000000000', 864, row.sha, 2048, null], CONFLICT_STATE, 'task_conflict');
      await s.expireLease(row.id);
      await s.refusedWith(SVC, SQL.observe, [row.id, job.leaseToken, 864, row.sha, 2048, null], CONFLICT_STATE, 'task_conflict');
      const copyLease = await s.lease(row.id, 'copy');
      await s.refusedWith(SVC, SQL.observe, [row.id, copyLease, 864, row.sha, 2048, null], '55000', 'wrong_state', 'state');
    });
  });
});

describe('copy, read-back and complete', () => {
  it('copy: mark_sending records the prior ids and the append start; copied records the id and settles the append', async () => {
    await asOwner(db, async () => {
      await s.settings({ check: true });
      const d = await dealWithRows(993331, 1);
      const row = d.rows[0]!;
      await s.copyPending(row.id);
      const [job] = await s.claim(1);
      expect(job).toMatchObject({ moveId: row.id, mode: 'copy', fileClass: 'id_proof', kindCode: 'id', bitrixField: ID_BOX, priorFileIds: [] });
      await s.refusedWith(SVC, SQL.mark, [row.id, job!.leaseToken, [11, -1]], '22023', 'invalid_input', 'priorFileIds');
      await s.refusedWith(SVC, SQL.mark, [row.id, '00000000-0000-4000-8000-000000000000', [11]], CONFLICT_STATE, 'task_conflict');
      expect(await one(SVC, SQL.mark, [row.id, job!.leaseToken, [11, 12]])).toEqual({ moveId: row.id, state: 'copy_sending' });
      expect(await s.boxState(993331, ID_BOX)).toEqual({ started_set: true, appended_now: true });
      expect(await s.move(row.id)).toMatchObject({ state: 'copy_sending', attempts: 1 });
      await s.refusedWith(SVC, SQL.complete, [row.id, job!.leaseToken, 'copied', null, 12], '22023', 'invalid_input', 'bitrixFileId');
      await s.refusedWith(SVC, SQL.complete, [row.id, job!.leaseToken, 'released', null, null], '55000', 'wrong_state', 'outcome_not_allowed');
      expect(await s.complete(job!, 'copied', null, 13)).toEqual({ moveId: row.id, state: 'copied', attempts: 1 });
      expect(await s.move(row.id)).toMatchObject({ state: 'copied', bitrix_file_id: '13', lease_token: null });
      expect(await s.audits('files.move_copied', row.id)).toHaveLength(1);
    });
  });

  it('a lost answer is read back (verify_copy with the prior ids), never re-sent blindly; five undecided read-backs end needs_manual_check', async () => {
    await asOwner(db, async () => {
      await s.settings({ check: true });
      const d = await dealWithRows(993332, 2);
      const row = d.rows[0]!;
      await s.copyPending(row.id);
      const [job] = await s.claim(1);
      await one(SVC, SQL.mark, [row.id, job!.leaseToken, [21]]);
      expect(await s.complete(job!, 'unknown', 'answer_lost')).toMatchObject({ state: 'copy_unknown' });
      expect(await s.claimAll()).toEqual([]); // back-off
      await s.due(row.id);
      const [read] = await s.claim(1);
      expect(read).toMatchObject({ moveId: row.id, mode: 'verify_copy', priorFileIds: ['21'], attempts: 1 });
      expect(await s.complete(read!, 'not_sent', 'no_new_file')).toMatchObject({ state: 'copy_pending' });

      const other = d.rows[1]!;
      await s.copyPending(other.id);
      await s.due(row.id);
      await s.setMove(row.id, `state = 'copy_pending', next_attempt_at = now() + interval '1 hour'`);
      const [c2] = await s.claim(1);
      expect(c2!.moveId).toBe(other.id);
      await one(SVC, SQL.mark, [other.id, c2!.leaseToken, []]);
      let last = await s.complete(c2!, 'unknown', 'answer_lost');
      for (let i = 2; i <= 5; i += 1) {
        expect(last.state).toBe('copy_unknown');
        await s.due(other.id);
        const [again] = (await s.claimAll()).filter((j) => j.moveId === other.id);
        expect(again!.mode).toBe('verify_copy');
        last = await s.complete(again!, 'unknown', 'read_back_undecided');
      }
      expect(last.state).toBe('needs_manual_check');
      expect(await s.move(other.id)).toMatchObject({ read_back_attempts: 5, last_error_code: 'read_back_undecided' });
    });
  });

  it('complete refuses verified, delete_pending, deleted and unknown outcomes; codes are required and checked; it checks the token only', async () => {
    await asOwner(db, async () => {
      await s.settings({ check: true });
      const d = await dealWithRows(993333, 1);
      const row = d.rows[0]!;
      await s.copied(row.id, 871);
      const [job] = await s.claim(1);
      for (const outcome of ['verified', 'delete_pending', 'deleted', 'restored', 'matched', null]) {
        await s.refusedWith(SVC, SQL.complete, [row.id, job!.leaseToken, outcome, 'x_code', 871], '22023', 'invalid_input', 'outcome');
      }
      await s.refusedWith(SVC, SQL.complete, [row.id, job!.leaseToken, 'retry', null, null], '22023', 'invalid_input', 'outcome');
      await s.refusedWith(SVC, SQL.complete, [row.id, job!.leaseToken, 'retry', 'Bad Code!', null], '22023', 'invalid_input', 'outcome');
      await s.refusedWith(SVC, SQL.complete, [row.id, '00000000-0000-4000-8000-000000000000', 'released', null, null], CONFLICT_STATE, 'task_conflict');
      // The lease lapsed, the token still matches: complete accepts it (token only).
      await s.expireLease(row.id);
      expect(await s.complete(job!, 'released', null)).toMatchObject({ state: 'copied' });
      expect((await s.move(row.id)).lease_token).toBeNull();
    });
  });

  it('not_in_box queues a search by hash; failed is permanent; released frees the lease', async () => {
    await asOwner(db, async () => {
      await s.settings({ check: true });
      const d = await dealWithRows(993334, 2);
      await s.copied(d.rows[0]!.id, 872);
      const [job] = await s.claim(1);
      expect(await s.complete(job!, 'not_in_box', 'file_id_absent')).toMatchObject({ state: 'copied' });
      expect(await s.move(d.rows[0]!.id)).toMatchObject({ relocate_due: true, last_error_code: 'file_id_absent' });
      const [reloc] = await s.claim(1);
      expect(reloc).toMatchObject({ moveId: d.rows[0]!.id, mode: 'relocate', bitrixFileId: '872', knownFileIds: [] });
      await s.copyPending(d.rows[1]!.id);
      await s.complete(reloc!, 'released', null);
      const jobs = await s.claimAll();
      const copy = jobs.find((j) => j.moveId === d.rows[1]!.id);
      expect(copy).toMatchObject({ mode: 'copy' });
      expect(await s.complete(copy!, 'failed', 'bitrix_refused')).toMatchObject({ state: 'failed' });
    });
  });
});

describe('removed deals, deal_not_found, lease expiry', () => {
  it('rows of a deal the sync marked removed are skipped in every mode and resume when it returns; sole copies open an alert', async () => {
    await asOwner(db, async () => {
      await s.settings({ check: true, del: true });
      const d = await dealWithRows(993341, 4);
      await s.copied(d.rows[0]!.id, 881);
      await s.verifiedPastHold(d.rows[1]!.id, 882);
      await s.soleCopy(d.rows[2]!.id, 883, 'restore_pending');
      await s.soleCopy(d.rows[3]!.id, 884);
      await s.removeDeal(d.deal);
      expect(await s.claimAll()).toEqual([]);
      expect((await s.stops()).filter((x) => x.reason_code === 'deal_removed_with_files')).toEqual([
        expect.objectContaining({ move_id: null, source_deal_id: '993341', acknowledged: false }),
      ]);
      // A second check under way when the deal is removed answers retry.
      const t = await s.lease(d.rows[1]!.id, 'reverify');
      await s.appendSettledAgo(993341, ID_BOX, 10);
      expect(await s.observe({ moveId: d.rows[1]!.id, leaseToken: t }, 882, d.rows[1]!.sha, 2048, NOW_MINUS_1M)).toEqual({ result: 'retry' });
      await s.restoreDeal(d.deal);
      await s.due(d.rows[1]!.id);
      const jobs = await s.claimAll();
      expect(jobs.length).toBeGreaterThan(0);
      expect(jobs.every((j) => j.bitrixDealId === '993341')).toBe(true);
      expect(Object.values(modes(jobs))).toContain('restore');
    });
  });

  it('deal_not_found: needs_manual_check and an alert; the delete switch goes off when the deal holds sole copies; never a deletion', async () => {
    await asOwner(db, async () => {
      await s.settings({ check: true, del: true });
      const d = await dealWithRows(993342, 2);
      await s.copied(d.rows[0]!.id, 891);
      await s.soleCopy(d.rows[1]!.id, 892);
      const [job] = (await s.claim(1)).filter((j) => j.moveId === d.rows[0]!.id);
      expect(await s.complete(job!, 'deal_not_found', 'deal_not_found')).toMatchObject({ state: 'needs_manual_check' });
      expect((await s.stops()).map((x) => x.reason_code)).toEqual(['deal_not_found']);
      expect(await settingsNow()).toMatchObject({ del: false });
      expect((await s.move(d.rows[1]!.id)).state).toBe('deleted');
    });
  });

  it('an expired lease is refused by mark_sending and the row is handed out again with a new token', async () => {
    await asOwner(db, async () => {
      await s.settings({ check: true });
      const d = await dealWithRows(993343, 1);
      await s.copyPending(d.rows[0]!.id);
      const [job] = await s.claim(1);
      await s.expireLease(d.rows[0]!.id);
      await s.refusedWith(SVC, SQL.mark, [d.rows[0]!.id, job!.leaseToken, []], CONFLICT_STATE, 'task_conflict');
      const [again] = await s.claim(1);
      expect(again!.moveId).toBe(d.rows[0]!.id);
      expect(again!.leaseToken).not.toBe(job!.leaseToken);
      await s.refusedWith(SVC, SQL.mark, [d.rows[0]!.id, job!.leaseToken, []], CONFLICT_STATE, 'task_conflict');
      // A source no longer stored is refused at mark time.
      await owner(`update public.traveller_id_proofs set status = 'removed', removed_at = now(), removed_reason = 'traveller_removed' where id = $1`,
        [d.rows[0]!.fileId]);
      await s.refusedWith(SVC, SQL.mark, [d.rows[0]!.id, again!.leaseToken, []], '55000', 'wrong_state', 'source_removed');
    });
  });
});

describe('the two writers of crm_copy_present', () => {
  it('confirm_deleted: object gone -> deleted (CRM copy fact false); object present -> still_present; confirm_delete mode -> back_to_verified', async () => {
    await asOwner(db, async () => {
      await s.settings({ check: true, del: true });
      const gone = await dealWithRows(993351, 1, { objects: false });
      const present = await dealWithRows(993352, 1, { objects: true });
      await s.deletePending(gone.rows[0]!.id, 901);
      await s.deletePending(present.rows[0]!.id, 902);
      const jobs = await s.claimAll();
      const g = s.jobFor(jobs, gone.rows[0]!.id)!;
      const p = s.jobFor(jobs, present.rows[0]!.id)!;
      expect([g.mode, p.mode]).toEqual(['delete', 'delete']);
      await s.refusedWith(SVC, SQL.confirmDeleted, [g.moveId, '00000000-0000-4000-8000-000000000000'], CONFLICT_STATE, 'task_conflict');
      expect(await one(SVC, SQL.confirmDeleted, [g.moveId, g.leaseToken])).toEqual({ result: 'deleted' });
      expect(await s.move(g.moveId!)).toMatchObject({ state: 'deleted', crm_copy_present: false, deleted_at_set: true, presence_checked: true, lease_token: null });
      expect(await s.audits('files.move_deleted_from_crm', g.moveId!)).toHaveLength(1);
      expect(await one(SVC, SQL.confirmDeleted, [p.moveId, p.leaseToken])).toEqual({ result: 'still_present' });
      expect(await s.move(p.moveId!)).toMatchObject({ state: 'delete_pending', crm_copy_present: true, lease_token: null });
      await s.refusedWith(SVC, SQL.confirmDeleted, [g.moveId, g.leaseToken], CONFLICT_STATE, 'task_conflict');

      // Delete switch off: the same row is confirmed only (no remove), and goes back to verified.
      await s.settings({ check: true, del: false, everOn: true });
      await s.due(p.moveId!);
      const [c] = (await s.claimAll()).filter((j) => j.moveId === p.moveId);
      expect(c!.mode).toBe('confirm_delete');
      expect(await one(SVC, SQL.confirmDeleted, [c!.moveId, c!.leaseToken])).toEqual({ result: 'back_to_verified' });
      expect(await s.move(p.moveId!)).toMatchObject({ state: 'verified', crm_copy_present: true });
    });
  });

  it('confirm_restored: needs the database-compared copy-back first and the object back with the stored size; restored rows hold the CRM copy again', async () => {
    await asOwner(db, async () => {
      const d = await dealWithRows(993353, 3, { objects: false });
      const row = d.rows[0]!;
      await s.soleCopy(row.id, 911, 'restore_pending');
      // No switch needed: restore always runs.
      const [job] = await s.claim(1);
      expect(job).toMatchObject({ moveId: row.id, mode: 'restore', bitrixFileId: '911' });
      await s.refusedWith(SVC, SQL.confirmRestored, [row.id, job!.leaseToken], '55000', 'wrong_state', 'not_checked');
      expect(await s.observe(job!, 911, row.sha, 2048, null)).toEqual({ result: 'restore_checked' });
      // Nothing uploaded yet.
      expect(await one(SVC, SQL.confirmRestored, [row.id, job!.leaseToken])).toEqual({ result: 'missing' });
      expect(await s.move(row.id)).toMatchObject({ state: 'restore_pending', crm_copy_present: false, read_back_attempts: 1, lease_token: null });
      await s.due(row.id);
      const [again] = await s.claim(1);
      await s.observe(again!, 911, row.sha, 2048, null);
      await s.putObject('traveller-id-proofs', row.objectPath);
      expect(await one(SVC, SQL.confirmRestored, [row.id, again!.leaseToken])).toEqual({ result: 'restored' });
      expect(await s.move(row.id)).toMatchObject({ state: 'copied', crm_copy_present: true, read_back_attempts: 0, lease_token: null });
      expect(await s.audits('files.move_restored', row.id)).toHaveLength(1);

      // An object of another size at the path is not the file.
      const sized = d.rows[2]!;
      await s.soleCopy(sized.id, 913, 'restore_pending');
      await s.putObject('traveller-id-proofs', sized.objectPath, 1000);
      const [sj] = (await s.claimAll()).filter((j) => j.moveId === sized.id);
      await s.observe(sj!, 913, sized.sha, 2048, null);
      expect(await one(SVC, SQL.confirmRestored, [sized.id, sj!.leaseToken])).toEqual({ result: 'missing' });
      expect(await s.move(sized.id)).toMatchObject({ state: 'restore_pending', crm_copy_present: false });

      // A copy-back that differs five times ends lost_in_bitrix with an alert.
      const other = d.rows[1]!;
      await s.soleCopy(other.id, 912, 'restore_pending');
      let result = '';
      for (let i = 1; i <= 5; i += 1) {
        await s.due(other.id);
        const [r] = (await s.claimAll()).filter((j) => j.moveId === other.id);
        result = (await s.observe(r!, 912, 'd'.repeat(64), 2048, null)).result;
      }
      expect(result).toBe('quarantined');
      expect(await s.move(other.id)).toMatchObject({ state: 'lost_in_bitrix', crm_copy_present: false });
      expect((await s.stops()).map((x) => x.reason_code)).toContain('copy_mismatch');
    });
  });

  it('a pinned (keep_in_crm) restore stops at verified and is never re-checked for deletion', async () => {
    await asOwner(db, async () => {
      await s.settings({ check: true, del: true });
      const d = await dealWithRows(993354, 3, { objects: false });
      await s.soleCopy(d.rows[0]!.id, 921);
      await s.verifiedPastHold(d.rows[1]!.id, 922);
      await s.deletePending(d.rows[2]!.id, 923);
      const asked = await owner<{ r: { restorePending: number; pinned: number; skipped: string[] } }>(
        'select authz.file_move_request_restore($1::uuid[], $2) as r', [d.rows.map((r) => r.id), REASON]);
      expect(asked[0]!.r).toEqual({ restorePending: 1, pinned: 1, skipped: [d.rows[2]!.id] });
      expect(await s.move(d.rows[0]!.id)).toMatchObject({ state: 'restore_pending', keep_in_crm: true });
      expect(await s.move(d.rows[1]!.id)).toMatchObject({ state: 'verified', keep_in_crm: true });
      const jobs = await s.claimAll();
      const r = s.jobFor(jobs, d.rows[0]!.id)!;
      expect(r.mode).toBe('restore');
      expect(s.jobFor(jobs, d.rows[1]!.id)).toBeUndefined();
      await s.observe(r, 921, d.rows[0]!.sha, 2048, null);
      await s.putObject('traveller-id-proofs', d.rows[0]!.objectPath);
      expect(await one(SVC, SQL.confirmRestored, [r.moveId, r.leaseToken])).toEqual({ result: 'restored' });
      expect(await s.move(d.rows[0]!.id)).toMatchObject({ state: 'verified', keep_in_crm: true, crm_copy_present: true });
      await s.due(d.rows[0]!.id);
      expect((await s.claimAll()).filter((j) => j.moveId === d.rows[0]!.id || j.moveId === d.rows[1]!.id)).toEqual([]);
      expect(await s.audits('files.move_restore_requested')).toHaveLength(2);
    });
  });

  it('a deleted row that moves on (failed, quarantined) keeps the CRM copy fact false', async () => {
    await asOwner(db, async () => {
      const d = await dealWithRows(993355, 2);
      await s.soleCopy(d.rows[0]!.id, 931, 'restore_pending');
      await s.soleCopy(d.rows[1]!.id, 932, 'restore_pending');
      const jobs = await s.claimAll();
      const a = s.jobFor(jobs, d.rows[0]!.id)!;
      const b = s.jobFor(jobs, d.rows[1]!.id)!;
      expect(await s.complete(a, 'failed', 'synthetic_failure')).toMatchObject({ state: 'failed' });
      expect(await one(SVC, SQL.stop, [b.moveId, b.leaseToken, 'copy_mismatch'])).toEqual({ stopId: expect.any(String) });
      expect(await s.move(a.moveId!)).toMatchObject({ state: 'failed', crm_copy_present: false });
      expect(await s.move(b.moveId!)).toMatchObject({ state: 'quarantined', crm_copy_present: false });
    });
  });

  it('both confirm functions fail closed when storage.objects does not exist', async () => {
    await asOwner(db, async () => {
      const code = (await owner<{ src: string }>(
        `select string_agg(p.prosrc, E'\\n') as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname in ('file_move_confirm_deleted', 'file_move_confirm_restored')`))[0]!.src;
      expect(code.match(/to_regclass\('storage\.objects'\) is null then\s+raise exception 'wrong_state' using errcode = '55000', hint = 'storage_unavailable'/g))
        .toHaveLength(2);
      if (db.mode !== 'pglite') return; // the real storage.objects belongs to the Storage service; the source check above covers it
      await s.settings({ check: true, del: true });
      const d = await dealWithRows(993356, 2);
      await s.deletePending(d.rows[0]!.id, 941);
      await s.soleCopy(d.rows[1]!.id, 942, 'restore_pending');
      const jobs = await s.claimAll();
      const del = s.jobFor(jobs, d.rows[0]!.id)!;
      const res = s.jobFor(jobs, d.rows[1]!.id)!;
      await s.observe(res, 942, d.rows[1]!.sha, 2048, null);
      await owner('alter table storage.objects rename to objects_hidden_s11');
      await s.refusedWith(SVC, SQL.confirmDeleted, [del.moveId, del.leaseToken], '55000', 'wrong_state', 'storage_unavailable');
      await s.refusedWith(SVC, SQL.confirmRestored, [res.moveId, res.leaseToken], '55000', 'wrong_state', 'storage_unavailable');
      await owner('alter table storage.objects_hidden_s11 rename to objects');
      expect((await s.move(d.rows[0]!.id)).state).toBe('delete_pending');
    });
  });
});

describe('stop', () => {
  it('prior_files_lost fails the row, settles the append, opens an alert and turns the delete switch off; never on a delete_pending row', async () => {
    await asOwner(db, async () => {
      await s.settings({ check: true, del: true });
      const d = await dealWithRows(993361, 2);
      await s.copyPending(d.rows[0]!.id);
      const [job] = await s.claim(1);
      await one(SVC, SQL.mark, [job!.moveId, job!.leaseToken, [1, 2]]);
      await s.refusedWith(SVC, SQL.stop, [job!.moveId, job!.leaseToken, 'something_else'], '22023', 'invalid_input', 'reason');
      await s.refusedWith(SVC, SQL.stop, [job!.moveId, '00000000-0000-4000-8000-000000000000', 'prior_files_lost'], CONFLICT_STATE, 'task_conflict');
      const stopped = await one<{ stopId: string }>(SVC, SQL.stop, [job!.moveId, job!.leaseToken, 'prior_files_lost']);
      expect(await s.move(job!.moveId!)).toMatchObject({ state: 'failed', last_error_code: 'prior_files_lost', lease_token: null });
      expect(await settingsNow()).toMatchObject({ del: false });
      const [audit] = await s.audits('files.move_stopped', stopped.stopId);
      expect(audit!.details).toMatchObject({ reasonCode: 'prior_files_lost', deleteSwitchTurnedOff: true, moveId: job!.moveId });
      await s.deletePending(d.rows[1]!.id, 951);
      const t = await s.lease(d.rows[1]!.id, 'delete');
      await s.refusedWith(SVC, SQL.stop, [d.rows[1]!.id, t, 'copy_mismatch'], '55000', 'wrong_state', 'state');
    });
  });
});

describe('Super Admin commands', () => {
  it('switches: Super Admin at aal2 only, with a reason; audited; turning delete on is refused while a stop is open', async () => {
    await asOwner(db, async () => {
      for (const actor of [OWNER, ACCOUNTS, SUPER_AAL1]) {
        await s.refusedWith(actor, SQL.setSwitch, ['check_id_proof_copies', true, REASON], '42501', 'not_authorized');
      }
      await s.refusedWith(SUPER, SQL.setSwitch, ['all_of_them', true, REASON], '22023', 'invalid_input', 'switch');
      await s.refusedWith(SUPER, SQL.setSwitch, ['check_id_proof_copies', null, REASON], '22023', 'invalid_input', 'on');
      await s.refusedWith(SUPER, SQL.setSwitch, ['check_id_proof_copies', true, 'short'], '22023');
      expect(await one(SUPER, SQL.setSwitch, ['check_id_proof_copies', true, REASON])).toEqual({ changed: true, switch: 'check_id_proof_copies', on: true });
      expect(await one(SUPER, SQL.setSwitch, ['check_id_proof_copies', true, REASON])).toEqual({ changed: false, switch: 'check_id_proof_copies', on: true });
      const [changed] = await s.audits('files.move_switch_changed');
      expect(changed).toMatchObject({ actor_user_id: U.adminJodhpur, reason: REASON,
        details: expect.objectContaining({ switch: 'check_id_proof_copies', before: false, after: true, automatic: false }) });
      const settingAudit = (await s.audits('settings.file_move_changed')).find((a) => a.details.command === 'file_move_set_switch');
      expect(settingAudit).toMatchObject({ reason: REASON, details: expect.objectContaining({ via: 'command' }) });
      expect(await one(SUPER, SQL.settingsGet, [])).toMatchObject({ checkIdProofCopies: true, moveAccountsFiles: false, deleteAfterHold: false });

      // An open stop blocks turning delete on, until acknowledged.
      const d = await dealWithRows(993371, 1);
      await one(SUPER, SQL.setPilot, [993371, REASON]);
      const entity = await s.entityId();
      const [stop] = await owner<{ id: string }>(
        `insert into public.file_move_stops (legal_entity_id, move_id, source_deal_id, reason_code) values ($1, $2, 993371, 'copy_mismatch') returning id`,
        [entity, d.rows[0]!.id]);
      await s.refusedWith(SUPER, SQL.setSwitch, ['delete_after_hold', true, REASON], '55000', 'wrong_state', 'open_stops');
      expect(await one(SUPER, SQL.settingsGet, [])).toMatchObject({ openStops: 1, pilotBitrixDealId: '993371' });
      await s.refusedWith(OWNER, SQL.ackStop, [stop!.id, REASON], '42501', 'not_authorized');
      await s.refusedWith(SUPER, SQL.ackStop, [stop!.id, 'short'], '22023');
      expect(await one(SUPER, SQL.ackStop, [stop!.id, REASON])).toEqual({ stopId: stop!.id });
      await s.refusedWith(SUPER, SQL.ackStop, [stop!.id, REASON], '55000', 'wrong_state', 'acknowledged');
      expect(await one(SUPER, SQL.setSwitch, ['delete_after_hold', true, REASON])).toMatchObject({ changed: true });
    });
  });

  it('the Accounts box: an item key, never the identity box; fixed once a row has used it', async () => {
    await asOwner(db, async () => {
      for (const key of [ID_BOX, 'Accounts papers', 'ufCrm_', 'UF_CRM_1']) {
        await s.refusedWith(SUPER, SQL.setBox, [key, REASON], '22023', 'invalid_input', 'itemKey');
      }
      await s.refusedWith(OWNER, SQL.setBox, [ACC_BOX, REASON], '42501');
      expect(await one(SUPER, SQL.setBox, [ACC_BOX, REASON])).toEqual({ changed: true, accountsBox: ACC_BOX });
      expect(await one(SUPER, SQL.setBox, [ACC_BOX, REASON])).toEqual({ changed: false, accountsBox: ACC_BOX });
      await one(SUPER, SQL.setSwitch, ['move_accounts_files', true, REASON]);
      const deal = await s.bitrixDeal(993372);
      await s.refundFile(deal, { storedDaysAgo: 91 });
      expect((await one<{ madeDue: number }>(SVC, SQL.sweep, [])).madeDue).toBe(1);
      await s.refusedWith(SUPER, SQL.setBox, ['ufCrm_AnotherBox', REASON], '55000', 'wrong_state', 'box_in_use');
      const audit = (await s.audits('files.move_switch_changed')).find((a) => a.details.setting === 'accounts_bitrix_field');
      expect(audit!.details).toMatchObject({ before: null, after: ACC_BOX });
    });
  });

  it('alerts: codes, ids and times only; quarantined, manual checks, lost, failed and deletion waiting', async () => {
    await asOwner(db, async () => {
      await s.settings({ check: true, del: true });
      const d = await dealWithRows(993373, 4);
      await s.setMove(d.rows[0]!.id, `state = 'quarantined', last_error_code = 'copy_mismatch'`);
      await s.setMove(d.rows[1]!.id, `state = 'needs_manual_check', last_error_code = 'read_back_undecided'`);
      await s.setMove(d.rows[2]!.id, `state = 'failed', last_error_code = 'bitrix_refused'`);
      await s.verifiedPastHold(d.rows[3]!.id, 961);
      // An append in flight on the deal (a leased DEC-43 job stand-in: an S11 row sending).
      const other = await dealWithRows(993374, 2);
      await s.setMove(other.rows[0]!.id, `state = 'copy_sending', prior_file_ids = '{}'`);
      await s.verifiedPastHold(other.rows[1]!.id, 962);
      const alerts = await one<{ items: Array<Record<string, unknown>>; stops: unknown[]; counts: Record<string, number> }>(SUPER, SQL.alerts, []);
      const kinds = Object.fromEntries(alerts.items.map((i) => [i.moveId as string, i.kind]));
      expect(kinds).toMatchObject({
        [d.rows[0]!.id]: 'quarantined', [d.rows[1]!.id]: 'needs_manual_check', [d.rows[2]!.id]: 'failed', [other.rows[1]!.id]: 'deletion_waiting',
      });
      expect(kinds[d.rows[3]!.id]).toBeUndefined();
      for (const item of alerts.items) {
        expect(Object.keys(item).sort()).toEqual(['bitrixDealId', 'fileClass', 'kind', 'lastErrorCode', 'moveId', 'sourceTable', 'state', 'updatedAt']);
      }
      expect(Object.keys(alerts.counts).sort()).toEqual(['missedEnqueue', 'noTarget', 'soleCopies', 'waitingAccounts']);
      expect(JSON.stringify(alerts)).not.toMatch(/objectPath|\.jpg|image\/jpeg|https?:/);
    });
  });

  it('retry: always a read-back or a copy-back first; Super Admin only; never on a leased or healthy row', async () => {
    await asOwner(db, async () => {
      const d = await dealWithRows(993375, 4);
      await s.soleCopy(d.rows[0]!.id, 971, 'needs_manual_check');
      await s.setMove(d.rows[1]!.id, `state = 'failed', bitrix_file_id = 972`);
      await s.setMove(d.rows[2]!.id, `state = 'needs_manual_check', prior_file_ids = '{5}'`);
      await s.setMove(d.rows[3]!.id, `state = 'failed'`);
      await s.refusedWith(OWNER, SQL.retry, [d.rows[0]!.id], '42501', 'not_authorized');
      expect(await one(SUPER, SQL.retry, [d.rows[0]!.id])).toEqual({ moveId: d.rows[0]!.id, state: 'restore_pending' });
      expect(await one(SUPER, SQL.retry, [d.rows[1]!.id])).toEqual({ moveId: d.rows[1]!.id, state: 'copied' });
      // A traveller proof is DEC-43's to send: it waits for DEC-43, whatever was marked.
      expect(await one(SUPER, SQL.retry, [d.rows[2]!.id])).toEqual({ moveId: d.rows[2]!.id, state: 'waiting' });
      expect(await one(SUPER, SQL.retry, [d.rows[3]!.id])).toEqual({ moveId: d.rows[3]!.id, state: 'waiting' });
      await s.refusedWith(SUPER, SQL.retry, [d.rows[1]!.id], '55000', 'wrong_state', 'state');
      await s.setMove(d.rows[3]!.id, `state = 'failed'`);
      await s.lease(d.rows[3]!.id, 'copy');
      await s.refusedWith(SUPER, SQL.retry, [d.rows[3]!.id], CONFLICT_STATE, 'task_conflict');
      const [audit] = await s.audits('files.move_retry', d.rows[0]!.id);
      expect(audit!.details).toMatchObject({ by: 'super_admin' });
    });
  });

  it('relocate (a deal merged in Bitrix) and accept-lost are Super Admin only, audited', async () => {
    await asOwner(db, async () => {
      const d = await dealWithRows(993376, 2);
      await s.soleCopy(d.rows[0]!.id, 981);
      await s.refusedWith(OWNER, SQL.relocate, [d.rows[0]!.id, 993377], '42501');
      await s.refusedWith(SUPER, SQL.relocate, [d.rows[0]!.id, 0], '22023', 'invalid_input', 'newSourceDealId');
      await s.refusedWith(SUPER, SQL.relocate, [d.rows[1]!.id, 993377], '55000', 'wrong_state', 'state');
      expect(await one(SUPER, SQL.relocate, [d.rows[0]!.id, 993377])).toEqual({ moveId: d.rows[0]!.id });
      expect((await s.move(d.rows[0]!.id)).relocate_due).toBe(true);
      const [job] = await s.claim(1);
      expect(job).toMatchObject({ moveId: d.rows[0]!.id, mode: 'relocate', bitrixDealId: '993377' });
      await s.refusedWith(SUPER, SQL.acceptLost, [d.rows[0]!.id, REASON], '55000', 'wrong_state', 'state');
      await s.complete(job!, 'not_in_box', 'no_candidate_matched');
      expect((await s.move(d.rows[0]!.id)).state).toBe('lost_in_bitrix');
      await s.refusedWith(OWNER, SQL.acceptLost, [d.rows[0]!.id, REASON], '42501');
      await s.refusedWith(SUPER, SQL.acceptLost, [d.rows[0]!.id, 'short'], '22023');
      expect(await one(SUPER, SQL.acceptLost, [d.rows[0]!.id, REASON])).toEqual({ moveId: d.rows[0]!.id, state: 'lost_accepted' });
      const [audit] = await s.audits('files.move_lost_accepted', d.rows[0]!.id);
      expect(audit).toMatchObject({ actor_user_id: U.adminJodhpur, reason: REASON });
      const [requested] = await s.audits('files.move_relocated', d.rows[0]!.id);
      expect(requested!.details).toMatchObject({ phase: 'requested', otherDeal: true });
    });
  });
});

describe('owner helpers', () => {
  it('the safety tick runs the sweep then one kick; the sweep job is provisioned paused, and only with pg_cron', async () => {
    await asOwner(db, async () => {
      const [tick] = await owner<{ r: Record<string, unknown> }>('select authz.file_move_safety_tick() as r');
      expect(Object.keys(tick!.r).sort()).toEqual(['created', 'kicked', 'madeDue', 'stuck']);
      const [cron] = await owner<{ c: string | null }>(`select to_regclass('cron.job')::text as c`);
      if (cron!.c === null) {
        expect(await s.ownerFailure('select authz.provision_file_move_sweep_job()')).toMatchObject({ code: '55000' });
      } else {
        const [r] = await owner<{ r: unknown }>('select authz.provision_file_move_sweep_job() as r');
        expect(r!.r).toEqual([{ jobname: 'file-move-sweep', schedule: '*/10 * * * *', active: false }]);
        const [again] = await owner<{ r: unknown }>('select authz.provision_file_move_sweep_job() as r');
        expect(again!.r).toEqual([{ jobname: 'file-move-sweep', schedule: '*/10 * * * *', active: false }]);
      }
    });
  });
});
