import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { CONFLICT_STATE } from '../helpers/sqlstates';
import { ID_BOX, SQL, SUPER, SVC, s11Helpers } from './s11-support';

/**
 * S11 "files to Bitrix", the daily presence check and the search by hash
 * (migration 20261212000120; contract file 11 sections 2.6 and 4.2
 * "s11-presence"): a deal whose box holds sole copies is checked at most once
 * a day whatever the switches say; a missing id queues a relocation; the
 * relocation is compared by the database; no match ends lost_in_bitrix with an
 * alert and the delete switch off; "deal not found" opens an alert.
 * Synthetic fixtures; every case rolled back.
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

async function soleCopies(sourceDealId: number, fileIds: number[]) {
  const deal = await s.bitrixDeal(sourceDealId);
  const rows: Array<{ id: string; sha: string; fileId: number }> = [];
  for (const [i, fileId] of fileIds.entries()) {
    const p = await s.storeProof(deal, i + 1);
    const id = await s.moveIdOf('traveller_id_proofs', p.fileId);
    await s.soleCopy(id, fileId);
    rows.push({ id, sha: p.sha, fileId });
  }
  return { deal, rows };
}
const presenceJob = async (sourceDealId: number) =>
  (await s.claimAll()).find((j) => j.mode === 'presence' && j.bitrixDealId === String(sourceDealId));

describe('presence check', () => {
  it('one job per deal and box with every sole-copy id; present ids are checked, a missing id queues a search by hash', async () => {
    await asOwner(db, async () => {
      const { rows } = await soleCopies(993501, [1201, 1202, 1203, 1204]);
      await s.setMove(rows[3]!.id, `state = 'quarantined'`);
      // No settings row: every switch Off, the check still runs.
      const job = await presenceJob(993501);
      expect(job).toMatchObject({ moveId: null, mode: 'presence', bitrixField: ID_BOX, expectedFileIds: ['1201', '1202', '1203', '1204'] });
      for (const row of rows) expect((await s.move(row.id)).lease_mode).toBe('presence');
      // The presence lease is stamped by the database clock too, on every row and in the job.
      expect(Number.isFinite(Date.parse(job!.leasedAt!))).toBe(true);
      for (const row of rows) expect(await s.leaseTimes(row.id)).toMatchObject({ leased_now: true });

      await s.refusedWith(SVC, SQL.presence, [993501, ID_BOX, '00000000-0000-4000-8000-000000000000', [1201]], CONFLICT_STATE, 'task_conflict');
      await s.refusedWith(SVC, SQL.presence, [993501, ID_BOX, job!.leaseToken, [0]], '22023', 'invalid_input', 'presentIds');
      await s.refusedWith(SVC, SQL.presence, [993501, 'not a box', job!.leaseToken, [1201]], '22023', 'invalid_input', 'bitrixField');
      await s.refusedWith(SVC, SQL.presence, [993509, ID_BOX, job!.leaseToken, [1201]], CONFLICT_STATE, 'task_conflict');

      expect(await one(SVC, SQL.presence, [993501, ID_BOX, job!.leaseToken, [1201, 1202, 1204, 9999]])).toEqual({ checked: 3, missing: 1 });
      expect(await s.move(rows[0]!.id)).toMatchObject({ state: 'deleted', presence_checked: true, lease_token: null, relocate_due: false });
      // A quarantined file that is present is copied back (its hash is compared again).
      expect(await s.move(rows[3]!.id)).toMatchObject({ state: 'restore_pending', crm_copy_present: false });
      expect(await s.move(rows[2]!.id)).toMatchObject({ state: 'deleted', relocate_due: true, last_error_code: 'missing_at_presence', lease_token: null });

      // The search by hash: candidates are compared by the database.
      const jobs = await s.claimAll();
      const reloc = s.jobFor(jobs, rows[2]!.id)!;
      expect(reloc).toMatchObject({ mode: 'relocate', bitrixDealId: '993501', bitrixFileId: '1203', sizeBytes: 2048, sha256: rows[2]!.sha });
      expect(reloc.knownFileIds).toEqual(['1201', '1202', '1204']);
      expect(s.jobFor(jobs, rows[3]!.id)).toMatchObject({ mode: 'restore' });
      expect(jobs.filter((j) => j.mode === 'presence')).toEqual([]); // checked today
      await s.refusedWith(SVC, SQL.relocated, [rows[2]!.id, reloc.leaseToken, 1213, 'NOT A HASH', 2048], '22023', 'invalid_input', 'observedSha256');
      expect(await one(SVC, SQL.relocated, [rows[2]!.id, reloc.leaseToken, 1213, 'a'.repeat(64), 2048])).toEqual({ result: 'no_match' });
      expect(await one(SVC, SQL.relocated, [rows[2]!.id, reloc.leaseToken, 1213, rows[2]!.sha, 2047])).toEqual({ result: 'no_match' });
      // An id another row already holds is never taken.
      expect(await one(SVC, SQL.relocated, [rows[2]!.id, reloc.leaseToken, 1201, rows[2]!.sha, 2048])).toEqual({ result: 'no_match' });
      expect(await one(SVC, SQL.relocated, [rows[2]!.id, reloc.leaseToken, 1213, rows[2]!.sha, 2048])).toEqual({ result: 'relocated' });
      expect(await s.move(rows[2]!.id)).toMatchObject({ state: 'deleted', bitrix_file_id: '1213', relocate_due: false, presence_checked: true, lease_token: null });
      const [audit] = await s.audits('files.move_relocated', rows[2]!.id);
      expect(audit!.details).toMatchObject({ phase: 'found' });
      expect(JSON.stringify(audit!.details)).not.toMatch(/1213|993501/);
      // The lease is gone: no second report with it.
      await s.refusedWith(SVC, SQL.relocated, [rows[2]!.id, reloc.leaseToken, 1214, rows[2]!.sha, 2048], CONFLICT_STATE, 'task_conflict');
    });
  });

  it('each deal at most once every 24 hours; a deal the sync removed is not checked', async () => {
    await asOwner(db, async () => {
      const { deal, rows } = await soleCopies(993502, [1221, 1222]);
      const first = await presenceJob(993502);
      await one(SVC, SQL.presence, [993502, ID_BOX, first!.leaseToken, [1221, 1222]]);
      expect(await presenceJob(993502)).toBeUndefined();
      await s.setMove(rows[0]!.id, `presence_checked_at = now() - interval '25 hours'`);
      const again = await presenceJob(993502);
      expect(again).toMatchObject({ expectedFileIds: ['1221', '1222'] });
      await one(SVC, SQL.presence, [993502, ID_BOX, again!.leaseToken, [1221, 1222]]);
      await s.setMove(rows[0]!.id, `presence_checked_at = now() - interval '25 hours'`);
      await s.removeDeal(deal);
      expect(await presenceJob(993502)).toBeUndefined();
    });
  });

  it('no match anywhere: lost_in_bitrix, alert missing_in_bitrix, delete switch off', async () => {
    await asOwner(db, async () => {
      await s.settings({ check: true, del: true });
      const { rows } = await soleCopies(993503, [1231]);
      const job = await presenceJob(993503);
      expect(await one(SVC, SQL.presence, [993503, ID_BOX, job!.leaseToken, []])).toEqual({ checked: 0, missing: 1 });
      const [reloc] = (await s.claimAll()).filter((j) => j.moveId === rows[0]!.id);
      expect(reloc).toMatchObject({ mode: 'relocate', knownFileIds: [] });
      expect(await s.complete(reloc!, 'not_in_box', 'no_candidate_matched')).toMatchObject({ state: 'lost_in_bitrix' });
      expect(await s.move(rows[0]!.id)).toMatchObject({ state: 'lost_in_bitrix', crm_copy_present: false, relocate_due: false });
      expect((await s.stops()).map((x) => [x.move_id, x.reason_code])).toEqual([[rows[0]!.id, 'missing_in_bitrix']]);
      expect((await s.settingsRow())!.delete_after_hold).toBe(false);
      const alerts = await one<{ items: Array<{ moveId: string; kind: string }>; stops: Array<{ reasonCode: string }> }>(SUPER, SQL.alerts, []);
      expect(alerts.items).toContainEqual(expect.objectContaining({ moveId: rows[0]!.id, kind: 'lost_in_bitrix' }));
      expect(alerts.stops.map((x) => x.reasonCode)).toEqual(['missing_in_bitrix']);
    });
  });

  it('deal not found: an alert deal_not_found, the delete switch off, never a deletion or a re-send', async () => {
    await asOwner(db, async () => {
      await s.settings({ check: true, del: true });
      const { rows } = await soleCopies(993504, [1241, 1242]);
      const job = await presenceJob(993504);
      expect(await one(SVC, SQL.presence, [993504, ID_BOX, job!.leaseToken, null])).toEqual({ checked: 0, missing: 0, dealNotFound: true });
      for (const row of rows) expect(await s.move(row.id)).toMatchObject({ state: 'deleted', lease_token: null, last_error_code: 'deal_not_found' });
      expect((await s.stops()).map((x) => [x.move_id, x.source_deal_id, x.reason_code])).toEqual([[null, '993504', 'deal_not_found']]);
      expect((await s.settingsRow())!.delete_after_hold).toBe(false);
      // At most once every 24 hours (file 11 section 2.6) holds for a deal Bitrix did not find too: the next
      // safety run must not check it again at once and open a second alert.
      expect(await presenceJob(993504)).toBeUndefined();
      expect((await s.stops()).filter((x) => x.reason_code === 'deal_not_found')).toHaveLength(1);
    });
  });
});

describe('search on another deal (merged in Bitrix)', () => {
  it('the Super Admin names the new deal; the worker searches its box, skipping ids the CRM knows there; a match moves the row', async () => {
    await asOwner(db, async () => {
      const { rows } = await soleCopies(993511, [1251]);
      // The new deal holds a DEC-43 copy (id 1301) the CRM knows.
      await s.dec43(true);
      const target = await s.bitrixDeal(993512);
      await s.storeProof(target, 1);
      const [dj] = await s.dec43Claim();
      await one(SVC, SQL.dec43Mark, [dj!.jobId, dj!.leaseToken, []]);
      await one(SVC, SQL.dec43Complete, [dj!.jobId, dj!.leaseToken, 'sent', null, 1301]);
      expect(await one(SUPER, SQL.relocate, [rows[0]!.id, 993512])).toEqual({ moveId: rows[0]!.id });
      const [job] = (await s.claimAll()).filter((j) => j.moveId === rows[0]!.id);
      expect(job).toMatchObject({ mode: 'relocate', bitrixDealId: '993512', knownFileIds: ['1301'] });
      expect(await one(SVC, SQL.relocated, [rows[0]!.id, job!.leaseToken, 1302, rows[0]!.sha, 2048])).toEqual({ result: 'relocated' });
      const [moved] = await owner<{ deal: string; other: string | null; file: string }>(
        'select source_deal_id::text as deal, relocate_source_deal_id::text as other, bitrix_file_id::text as file from public.file_bitrix_moves where id = $1',
        [rows[0]!.id]);
      expect(moved).toEqual({ deal: '993512', other: null, file: '1302' });
    });
  });

  it('a row that still has its CRM copy gets a fresh first check after relocation', async () => {
    await asOwner(db, async () => {
      await s.settings({ check: true });
      const deal = await s.bitrixDeal(993513);
      const p = await s.storeProof(deal, 1);
      const id = await s.moveIdOf('traveller_id_proofs', p.fileId);
      await s.copied(id, 1261);
      const [verify] = await s.claim(1);
      await s.complete(verify!, 'not_in_box', 'file_id_absent');
      const [reloc] = await s.claim(1);
      expect(reloc).toMatchObject({ moveId: id, mode: 'relocate' });
      expect(await one(SVC, SQL.relocated, [id, reloc!.leaseToken, 1262, p.sha, 2048])).toEqual({ result: 'relocated' });
      expect(await s.move(id)).toMatchObject({ state: 'copied', bitrix_file_id: '1262', crm_copy_present: true, relocate_due: false });
      const [next] = await s.claim(1);
      expect(next).toMatchObject({ moveId: id, mode: 'verify', bitrixFileId: '1262' });
    });
  });
});
