import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb, migrationFiles } from '../helpers/db';
import { CONFLICT_STATE } from '../helpers/sqlstates';
import { ID_BOX, READ_AT_LEASE, REASON, REVERT_FILE, SQL, SUPER, SVC, bodyOf, migrationText, s11Helpers } from './s11-support';

/**
 * S11 "files to Bitrix", migration 20261212000140 and the two-way rules
 * between S11 and DEC-43 (contract file 14 section 1.5 C3 and 2.1 item 4;
 * file 11 sections 2.3, 2.4 (j)(l), 4.2 "s11-two-way-lock"):
 *   - restate-and-compare: each of the three restated DEC-43 functions equals
 *     its newest definition (claim: 20261120000700; mark_sending and complete:
 *     20261206000200) once the lines from "-- S11 begin" to "-- S11 end" are
 *     removed, in the migration text and in the live database; the prepared
 *     revert file holds exactly the newest definitions;
 *   - one writer per deal both ways: DEC-43 gets no job while an S11 append
 *     of the deal is in flight, and S11 hands out no copy while a DEC-43 job of
 *     the deal is leased or unknown;
 *   - D6 in both claims: no append while the box holds a file whose only copy
 *     is in Bitrix (deleted, quarantined, failed, needs_manual_check); those
 *     rows become restore_pending and are handed out first;
 *   - B1: no second check or deletion while an append is in flight; the second
 *     check refuses delete_pending when an append started after the claim or
 *     its lease (leased_at, database clock) did not start after the last append;
 *   - I2: a copy-back that cannot succeed ends lost_in_bitrix, the blocked
 *     upload shows in the alerts, file_move_accept_lost releases the deal
 *     (audit files.move_lost_accepted).
 * The S11 copies of traveller-proof rows here are stand-ins (owner SQL puts a
 * proof's row in copy_pending / copy_sending): S11 itself copies visa applicant
 * papers and Accounts files; the rules read only the deal, the box and the
 * state. Synthetic fixtures; every case rolled back.
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

/** Removes every line from "-- S11 begin" to "-- S11 end", inclusive. */
function withoutS11(text: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of text.split('\n')) {
    if (line.includes('-- S11 begin')) skipping = true;
    if (!skipping) out.push(line);
    if (line.includes('-- S11 end')) skipping = false;
  }
  return out.join('\n');
}
const asCreate = (def: string) => def.replace(/^create or replace function /, 'create function ');
/** The function body between its $$ delimiters (what pg_proc.prosrc holds). */
const bodyText = (def: string) => def.slice(def.indexOf('$$') + 2, def.lastIndexOf('$$'));

const RESTATED = [
  { name: 'public.bitrix_id_proof_copy_claim', from: '20261120000700', sig: 'bitrix_id_proof_copy_claim(integer, integer)' },
  { name: 'public.bitrix_id_proof_copy_mark_sending', from: '20261206000200', sig: 'bitrix_id_proof_copy_mark_sending(uuid, uuid, bigint[])' },
  { name: 'public.bitrix_id_proof_copy_complete', from: '20261206000200', sig: 'bitrix_id_proof_copy_complete(uuid, uuid, text, text, bigint)' },
] as const;

describe('restate-and-compare of the three DEC-43 functions (C3)', () => {
  const s11 = migrationText('20261212000140');

  it('each is the newest definition plus only its S11 block, in the migration text', () => {
    for (const f of RESTATED) {
      const restated = bodyOf(s11, f.name);
      const source = bodyOf(migrationText(f.from), f.name);
      expect(restated.match(/-- S11 begin/g), f.name).toHaveLength(1);
      expect(restated.match(/-- S11 end/g), f.name).toHaveLength(1);
      expect(asCreate(withoutS11(restated)), f.name).toBe(asCreate(source));
    }
    const claimBlock = bodyOf(s11, RESTATED[0].name).split('-- S11 begin')[1]!.split('-- S11 end')[0]!;
    expect(claimBlock).toMatch(/if not authz\.file_move_dec43_gate\(r\.id\) then\s+continue;\s+end if;/);
    const markBlock = bodyOf(s11, RESTATED[1].name).split('-- S11 begin')[1]!.split('-- S11 end')[0]!;
    expect(markBlock).toMatch(/insert into public\.file_move_box_state/);
    expect(markBlock).toMatch(/set last_append_started_at = now\(\), last_append_at = now\(\);/);
    const completeBlock = bodyOf(s11, RESTATED[2].name).split('-- S11 begin')[1]!.split('-- S11 end')[0]!;
    expect(completeBlock).toMatch(/if v_job\.status = 'unknown' then/);
    expect(completeBlock).toMatch(/on conflict \(source_deal_id, bitrix_field\) do update set last_append_at = now\(\);/);
  });

  it('the newest definition is the one named: no other migration redefines these functions', () => {
    const definers = (name: string) =>
      migrationFiles().filter((file) => readFileSync(file, 'utf8').includes(`function ${name}(`)).map((file) => basename(file).slice(0, 14));
    expect(definers(RESTATED[0].name)).toEqual(['20261120000700', '20261212000140']);
    expect(definers(RESTATED[1].name)).toEqual(['20261120000700', '20261206000200', '20261212000140']);
    expect(definers(RESTATED[2].name)).toEqual(['20261120000700', '20261206000200', '20261212000140']);
  });

  it('in the database: each live body minus its S11 block equals the newest definition; attributes unchanged', async () => {
    for (const f of RESTATED) {
      const [row] = await db.query<{ src: string; secdef: boolean; config: string[] | null; volatile: string; rettype: string }>(
        `select p.prosrc as src, p.prosecdef as secdef, p.proconfig as config, p.provolatile::text as volatile,
                p.prorettype::regtype::text as rettype
         from pg_proc p where p.oid = $1::regprocedure`,
        [`public.${f.sig}`],
      );
      expect(withoutS11(row!.src), f.name).toBe(bodyText(bodyOf(migrationText(f.from), f.name)));
      expect(row!.src, f.name).toBe(bodyText(bodyOf(s11, f.name)));
      expect({ secdef: row!.secdef, config: row!.config, volatile: row!.volatile, rettype: row!.rettype }, f.name)
        .toEqual({ secdef: true, config: ['search_path=""'], volatile: 'v', rettype: 'jsonb' });
    }
  });

  it('the prepared revert file holds exactly the newest definitions', () => {
    const revert = readFileSync(REVERT_FILE, 'utf8');
    expect(revert).not.toMatch(/-- S11 begin|file_move_dec43_gate\(r\.id\)|insert into public\.file_move_box_state/);
    for (const f of RESTATED) {
      expect(asCreate(bodyOf(revert, f.name)), f.name).toBe(asCreate(bodyOf(migrationText(f.from), f.name)));
    }
  });

  it('one per-deal lock for both engines: the same key; single-row commands take it before any row lock', async () => {
    const src = async (name: string) =>
      (await db.query<{ s: string }>(`select p.prosrc as s from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname || '.' || p.proname = $1`, [name]))[0]!.s;
    for (const helper of ['authz.file_move_deal_lock', 'authz.file_move_try_deal_lock']) {
      expect(await src(helper)).toContain("hashtextextended('file_move_deal:' || p_source_deal_id::text, 0)");
    }
    expect(await src('authz.file_move_dec43_gate')).toContain('authz.file_move_try_deal_lock(v_deal)');
    expect(await src('public.file_move_claim')).toContain('authz.file_move_try_deal_lock(v_m.source_deal_id)');
    for (const name of ['public.file_move_mark_sending', 'public.file_move_record_observation']) {
      const body = await src(name);
      expect(body.indexOf('authz.file_move_deal_lock(v_deal)'), name).toBeGreaterThan(0);
      expect(body.indexOf('authz.file_move_deal_lock(v_deal)'), name).toBeLessThan(body.indexOf('for update'));
    }
  });
});

/** A Bitrix deal with traveller proofs; `dec43At` lists the seqs stored while DEC-43 is on (they get a job). */
async function scene(sourceDealId: number, seqs: number[], dec43At: number[] = []) {
  const deal = await s.bitrixDeal(sourceDealId);
  const rows: Record<number, { id: string; fileId: string; objectPath: string; sha: string }> = {};
  for (const seq of seqs) {
    await s.dec43(dec43At.includes(seq));
    const p = await s.storeProof(deal, seq);
    rows[seq] = { id: await s.moveIdOf('traveller_id_proofs', p.fileId), fileId: p.fileId, objectPath: p.objectPath, sha: p.sha };
  }
  await s.dec43(true);
  return { deal, sourceDealId, rows };
}
const r = <T>(x: T | undefined): T => {
  if (x === undefined) throw new Error('missing row');
  return x;
};

describe('one writer per deal, both ways', () => {
  it('DEC-43 hands out no job while an S11 append of the same deal is sending, unknown or leased for copy', async () => {
    await asOwner(db, async () => {
      const sc = await scene(993401, [1, 2], [1]);
      const s11Row = r(sc.rows[2]).id;
      expect(await s.dec43Jobs(sc.deal)).toHaveLength(1);
      for (const sets of [`state = 'copy_sending', prior_file_ids = '{}'`, `state = 'copy_unknown', prior_file_ids = '{}'`]) {
        await s.setMove(s11Row, sets);
        expect(await s.dec43Claim()).toEqual([]);
      }
      await s.copyPending(s11Row);
      await s.lease(s11Row, 'copy');
      expect(await s.dec43Claim()).toEqual([]);
      // The S11 append settled: DEC-43 goes ahead.
      await s.setMove(s11Row, `state = 'copied', bitrix_file_id = 1101, lease_token = null, locked_until = null, lease_mode = null`);
      const jobs = await s.dec43Claim();
      expect(jobs).toEqual([expect.objectContaining({ mode: 'send', bitrixDealId: '993401' })]);
      // With no S11 row in flight the gate answers true.
      const [gate] = await owner<{ g: boolean }>('select authz.file_move_dec43_gate($1) as g', [jobs[0]!.jobId]);
      expect(gate!.g).toBe(true);
    });
  });

  it('S11 hands out no copy while a DEC-43 job of the same deal is leased or unknown', async () => {
    await asOwner(db, async () => {
      await s.settings({ check: true });
      const sc = await scene(993402, [1, 2], [1]);
      const s11Row = r(sc.rows[2]).id;
      const [job] = await s.dec43Claim();
      await s.copyPending(s11Row);
      expect(s.jobFor(await s.claimAll(), s11Row)).toBeUndefined();
      await one(SVC, SQL.dec43Mark, [job!.jobId, job!.leaseToken, []]);
      await one(SVC, SQL.dec43Complete, [job!.jobId, job!.leaseToken, 'unknown', 'answer_lost', null]);
      expect(s.jobFor(await s.claimAll(), s11Row)).toBeUndefined();
      // DEC-43 reads back and finds its file: the deal is free.
      await owner(`update public.bitrix_id_proof_copy_jobs set next_attempt_at = now() - interval '1 second' where id = $1`, [job!.jobId]);
      const [verify] = await s.dec43Claim();
      expect(verify).toMatchObject({ jobId: job!.jobId, mode: 'verify' });
      await one(SVC, SQL.dec43Complete, [verify!.jobId, verify!.leaseToken, 'sent', null, 1102]);
      const jobs = await s.claimAll();
      expect(s.jobFor(jobs, s11Row)).toMatchObject({ mode: 'copy' });
      // The DEC-43 send was adopted by its S11 row (first check next).
      expect(s.jobFor(jobs, r(sc.rows[1]).id)).toMatchObject({ mode: 'verify', bitrixFileId: '1102' });
    });
  });

  it('DEC-43 mark_sending and complete record the append to the identity box', async () => {
    await asOwner(db, async () => {
      const sc = await scene(993403, [1], [1]);
      const [job] = await s.dec43Claim();
      expect(await s.boxState(993403, ID_BOX)).toBeUndefined();
      await one(SVC, SQL.dec43Mark, [job!.jobId, job!.leaseToken, [7]]);
      expect(await s.boxState(993403, ID_BOX)).toEqual({ started_set: true, appended_now: true });
      await s.appendSettledAgo(993403, ID_BOX, 10);
      await one(SVC, SQL.dec43Complete, [job!.jobId, job!.leaseToken, 'sent', null, 1103]);
      expect(await s.boxState(993403, ID_BOX)).toEqual({ started_set: true, appended_now: true });
      expect(sc.deal).toBeTruthy();
    });
  });
});

describe('D6: never rewrite a box that holds a sole copy', () => {
  it('S11: no copy while the identity box holds a deleted file; that file becomes restore_pending and is handed out first', async () => {
    await asOwner(db, async () => {
      await s.settings({ check: true });
      const sc = await scene(993411, [1, 2]);
      const sole = r(sc.rows[1]);
      const upload = r(sc.rows[2]).id;
      await s.soleCopy(sole.id, 1111);
      await s.copyPending(upload);
      expect(await s.claim(5)).toEqual([]);
      expect((await s.move(sole.id)).state).toBe('restore_pending');
      expect(await s.audits('files.move_copy_back_before_append', sole.id)).toHaveLength(1);
      const next = await s.claim(5);
      expect(next).toEqual([expect.objectContaining({ moveId: sole.id, mode: 'restore', bitrixFileId: '1111' })]);
      expect(s.jobFor(await s.claimAll(), upload)).toBeUndefined();
      // Copied back and confirmed: the append goes ahead.
      expect(await s.observe(next[0]!, 1111, sole.sha, 2048, null)).toEqual({ result: 'restore_checked' });
      await s.putObject('traveller-id-proofs', sole.objectPath);
      expect(await s.confirmRestored(next[0]!, sole.sha)).toEqual({ result: 'restored' });
      expect(s.jobFor(await s.claimAll(), upload)).toMatchObject({ mode: 'copy' });
    });
  });

  it('DEC-43: no job while the identity box holds a sole copy; the file is copied back first (S11 restore)', async () => {
    await asOwner(db, async () => {
      const sc = await scene(993412, [1, 2], [2]);
      const sole = r(sc.rows[1]);
      await s.soleCopy(sole.id, 1112);
      expect(await s.dec43Claim()).toEqual([]);
      expect((await s.move(sole.id)).state).toBe('restore_pending');
      expect(await s.audits('files.move_copy_back_before_append', sole.id)).toHaveLength(1);
      expect(await s.claim(5)).toEqual([expect.objectContaining({ moveId: sole.id, mode: 'restore' })]);
      expect(await s.dec43Claim()).toEqual([]);
    });
  });

  it('D6 counts a quarantined, failed or needs_manual_check row without a CRM copy; not a lost file once accepted', async () => {
    await asOwner(db, async () => {
      await s.settings({ check: true });
      for (const [i, state] of (['quarantined', 'failed', 'needs_manual_check'] as const).entries()) {
        const sc = await scene(993413 + i, [1, 2]);
        await s.soleCopy(r(sc.rows[1]).id, 1120 + i, state);
        await s.copyPending(r(sc.rows[2]).id);
        expect(await s.claim(5), state).toEqual([]); // the copy-back is requested instead of the append
        const jobs = await s.claimAll();
        expect(s.jobFor(jobs, r(sc.rows[2]).id), state).toBeUndefined();
        expect(s.jobFor(jobs, r(sc.rows[1]).id), state).toMatchObject({ mode: 'restore' });
      }
      const sc = await scene(993417, [1, 2]);
      await s.soleCopy(r(sc.rows[1]).id, 1129, 'lost_accepted');
      await s.copyPending(r(sc.rows[2]).id);
      expect(s.jobFor(await s.claimAll(), r(sc.rows[2]).id)).toMatchObject({ mode: 'copy' });
    });
  });

  it('the Accounts box is checked on its own: a sole copy in the identity box does not block an Accounts append, nor the reverse', async () => {
    await asOwner(db, async () => {
      await s.settings({ check: true, accounts: true });
      const sc = await scene(993418, [1]);
      await s.soleCopy(r(sc.rows[1]).id, 1130);
      const acc = await s.refundFile(sc.deal, { storedDaysAgo: 91 });
      await one(SVC, SQL.sweep, []);
      const accId = await s.moveIdOf('refund_evidence', acc.id);
      expect(s.jobFor(await s.claimAll(), accId)).toMatchObject({ mode: 'copy' });
      expect((await s.move(r(sc.rows[1]).id)).state).toBe('deleted');
    });
  });
});

describe('B1: no second check or deletion while an append is in flight', () => {
  it('S11 copy in flight: no reverify and no delete for the deal and box; handed out once it settled', async () => {
    await asOwner(db, async () => {
      await s.settings({ check: true, del: true });
      const sc = await scene(993421, [1, 2, 3]);
      const [checked, sending, pending] = [r(sc.rows[1]).id, r(sc.rows[2]).id, r(sc.rows[3]).id];
      await s.verifiedPastHold(checked, 1141);
      await s.deletePending(pending, 1143);
      await s.setMove(sending, `state = 'copy_sending', prior_file_ids = '{}'`);
      const jobs = await s.claimAll();
      expect(s.jobFor(jobs, checked)).toBeUndefined();
      expect(s.jobFor(jobs, pending)).toBeUndefined();
      await s.setMove(sending, `state = 'copied', bitrix_file_id = 1142, lease_token = null, locked_until = null, lease_mode = null`);
      await s.due(checked);
      await s.due(pending);
      const after = await s.claimAll();
      expect(s.jobFor(after, checked)).toMatchObject({ mode: 'reverify' });
      expect(s.jobFor(after, pending)).toMatchObject({ mode: 'delete' });
    });
  });

  it('DEC-43 job leased or unknown: no reverify, delete or confirm_delete for the identity box', async () => {
    await asOwner(db, async () => {
      await s.settings({ check: true, del: true });
      const sc = await scene(993422, [1, 2, 3], [3]);
      const [checked, pending] = [r(sc.rows[1]).id, r(sc.rows[2]).id];
      await s.verifiedPastHold(checked, 1151);
      // The DEC-43 job is leased first (a delete_pending row would stop DEC-43 by D6), then a row reaches delete_pending.
      const [job] = await s.dec43Claim();
      expect(job).toBeDefined();
      await s.deletePending(pending, 1152);
      expect(await s.claimAll()).toEqual([]);
      await one(SVC, SQL.dec43Mark, [job!.jobId, job!.leaseToken, [1151, 1152]]);
      await one(SVC, SQL.dec43Complete, [job!.jobId, job!.leaseToken, 'unknown', 'answer_lost', null]);
      expect(await s.claimAll()).toEqual([]);
      // Delete switch off: confirm_delete waits too.
      await s.settings({ check: true, del: false, everOn: true });
      expect(await s.claimAll()).toEqual([]);
      // A DEC-43 job stuck unknown shows as "deletion waiting".
      const alerts = await one<{ items: Array<{ moveId: string; kind: string }> }>(SUPER, SQL.alerts, []);
      expect(alerts.items).toContainEqual(expect.objectContaining({ moveId: checked, kind: 'deletion_waiting' }));
    });
  });

  it('second check refuses delete_pending when an S11 append started after the claim', async () => {
    await asOwner(db, async () => {
      await s.settings({ check: true, del: true });
      const sc = await scene(993423, [1, 2]);
      const [x, y] = [r(sc.rows[1]), r(sc.rows[2])];
      await s.verifiedPastHold(x.id, 1161);
      await s.appendSettledAgo(993423, ID_BOX, 10);
      const [check] = await s.claim(5);
      expect(check).toMatchObject({ moveId: x.id, mode: 'reverify' });
      await s.copyPending(y.id);
      const [copy] = await s.claim(5);
      expect(copy).toMatchObject({ moveId: y.id, mode: 'copy' });
      await one(SVC, SQL.mark, [y.id, copy!.leaseToken, [1161]]);
      expect(await s.observe(check!, 1161, x.sha, 2048, READ_AT_LEASE)).toEqual({ result: 'retry' });
      expect(await s.move(x.id)).toMatchObject({ state: 'verified', crm_copy_present: true });
      // Y's write settled, but X's lease started before it settled (database clock): still no deletion.
      await s.complete(copy!, 'copied', null, 1162);
      await s.due(x.id);
      const [again] = (await s.claimAll()).filter((j) => j.moveId === x.id);
      expect(again).toMatchObject({ mode: 'reverify' });
      expect(await s.observe(again!, 1161, x.sha, 2048, READ_AT_LEASE)).toEqual({ result: 'retry' });
      expect((await s.move(x.id)).state).toBe('verified');
    });
  });

  it('second check refuses delete_pending while a DEC-43 job of the deal is leased, and when its lease did not start after that append', async () => {
    await asOwner(db, async () => {
      await s.settings({ check: true, del: true });
      const sc = await scene(993424, [1, 2], [2]);
      const x = r(sc.rows[1]);
      await s.verifiedPastHold(x.id, 1171);
      await s.appendSettledAgo(993424, ID_BOX, 10);
      const [check] = await s.claim(5);
      expect(check).toMatchObject({ moveId: x.id, mode: 'reverify' });
      const [job] = await s.dec43Claim();
      expect(job).toBeDefined();
      expect(await s.observe(check!, 1171, x.sha, 2048, READ_AT_LEASE)).toEqual({ result: 'retry' });
      await one(SVC, SQL.dec43Mark, [job!.jobId, job!.leaseToken, [1171]]);
      await one(SVC, SQL.dec43Complete, [job!.jobId, job!.leaseToken, 'sent', null, 1172]);
      await s.due(x.id);
      const [again] = (await s.claimAll()).filter((j) => j.moveId === x.id);
      expect(await s.observe(again!, 1171, x.sha, 2048, READ_AT_LEASE)).toEqual({ result: 'retry' });
      // Once the append is in the past and the read started after it: delete_pending.
      await s.appendSettledAgo(993424, ID_BOX, 2);
      await s.due(x.id);
      const [third] = (await s.claimAll()).filter((j) => j.moveId === x.id);
      expect(await s.observe(third!, 1171, x.sha, 2048, READ_AT_LEASE)).toEqual({ result: 'delete_pending' });
    });
  });

  it('mark_sending refuses an S11 append while a DEC-43 job of the deal is leased (PT409) or the box gained a sole copy (55000)', async () => {
    await asOwner(db, async () => {
      await s.settings({ check: true });
      const sc = await scene(993425, [1, 2, 3], [3]);
      const y = r(sc.rows[2]).id;
      await s.copyPending(y);
      const [copy] = await s.claim(5);
      expect(copy).toMatchObject({ moveId: y, mode: 'copy' });
      // A DEC-43 job leased by hand on the same deal (the claim would have refused it).
      await owner(`update public.bitrix_id_proof_copy_jobs set lease_token = gen_random_uuid(), locked_until = now() + interval '1 minute'
                   where deal_id = $1`, [sc.deal]);
      await s.refusedWith(SVC, SQL.mark, [y, copy!.leaseToken, []], CONFLICT_STATE, 'task_conflict');
      await owner(`update public.bitrix_id_proof_copy_jobs set lease_token = null, locked_until = null where deal_id = $1`, [sc.deal]);
      await s.soleCopy(r(sc.rows[1]).id, 1181);
      await s.refusedWith(SVC, SQL.mark, [y, copy!.leaseToken, []], '55000', 'wrong_state', 'sole_copy_present');
    });
  });
});

describe('I2: a lost file never blocks a deal silently', () => {
  it('a copy-back that cannot succeed ends lost_in_bitrix; the blocked upload shows in the alerts; accept-lost releases the deal', async () => {
    await asOwner(db, async () => {
      await s.settings({ check: true, del: true });
      const sc = await scene(993431, [1, 2]);
      const lost = r(sc.rows[1]);
      const upload = r(sc.rows[2]).id;
      await s.soleCopy(lost.id, 1191);
      await s.copyPending(upload);
      expect(await s.claim(5)).toEqual([]); // copy-back requested
      const [restore] = await s.claim(5);
      expect(restore).toMatchObject({ moveId: lost.id, mode: 'restore' });
      // The file id is not in the box: one search by hash.
      expect(await s.complete(restore!, 'not_in_box', 'file_id_absent')).toMatchObject({ state: 'restore_pending' });
      const [search] = await s.claim(5);
      expect(search).toMatchObject({ moveId: lost.id, mode: 'relocate', knownFileIds: [] });
      expect(await one(SVC, SQL.relocated, [lost.id, search!.leaseToken, 1192, 'c'.repeat(64), 2048])).toEqual({ result: 'no_match' });
      expect(await s.complete(search!, 'not_in_box', 'no_candidate_matched')).toMatchObject({ state: 'lost_in_bitrix' });
      expect(await s.move(lost.id)).toMatchObject({ state: 'lost_in_bitrix', crm_copy_present: false, relocate_due: false });
      expect((await s.stops()).map((x) => [x.move_id, x.reason_code])).toEqual([[lost.id, 'missing_in_bitrix']]);
      expect((await s.settingsRow())!.delete_after_hold).toBe(false);

      // The upload waits: never copied over the lost file, listed for the Super Admin.
      expect(s.jobFor(await s.claimAll(), upload)).toBeUndefined();
      const alerts = await one<{ items: Array<{ moveId: string; kind: string }> }>(SUPER, SQL.alerts, []);
      expect(alerts.items).toContainEqual(expect.objectContaining({ moveId: lost.id, kind: 'lost_in_bitrix' }));
      expect(alerts.items).toContainEqual(expect.objectContaining({ moveId: upload, kind: 'blocked_by_lost_file' }));

      expect(await one(SUPER, SQL.acceptLost, [lost.id, REASON])).toEqual({ moveId: lost.id, state: 'lost_accepted' });
      const [audit] = await s.audits('files.move_lost_accepted', lost.id);
      expect(audit).toMatchObject({ reason: REASON, details: expect.objectContaining({ moveId: lost.id, state: 'lost_accepted' }) });
      expect(s.jobFor(await s.claimAll(), upload)).toMatchObject({ mode: 'copy' });
    });
  });
});
