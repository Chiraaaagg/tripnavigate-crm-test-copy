import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, expectDbError, SYNTHETIC_INTAKE_CONFIG as CONFIG, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { DEAL, OWNER, PURCHASE, SALES_B, SUPER, SVC } from './b1-support';
import { b11Helpers } from './b11-support';

/**
 * B1.2 DEC-43 (migration 20261120000700_b12_id_proof_bitrix_copy): copy jobs
 * for stored traveller ID proofs to the linked Bitrix Deal. Switch off by
 * default; enqueue only for a Deal imported from the configured portal;
 * idempotent per (Deal, traveller, sha256); claim / mark_sending / complete
 * for the service role; back-off and at most 5 attempts; a lost answer is
 * read back (verify) instead of re-sent; manual retry for booking editors and
 * the Super Admin; audit carries ids and the hash, never a file name.
 * No Bitrix call here (database only). Synthetic fixtures; rolled back.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b11Helpers(() => db);
const { one, refused, owner } = h;
const REASON = 'Owner approval APPROVE, synthetic test run';
const SWITCH = 'select public.integration_set_bitrix_id_proof_copy($1, $2) as r';
const CLAIM = 'select public.bitrix_id_proof_copy_claim($1, $2) as r';
const MARK = 'select public.bitrix_id_proof_copy_mark_sending($1, $2, $3::bigint[]) as r';
const COMPLETE = 'select public.bitrix_id_proof_copy_complete($1, $2, $3, $4, $5) as r';
const RETRY = 'select public.bitrix_id_proof_copy_retry($1) as r';
const STATUS = 'select public.bitrix_id_proof_copy_status($1) as r';
const STOP = 'select public.bitrix_id_proof_copy_stop($1, $2, $3) as r';
const ALERTS = 'select public.bitrix_id_proof_copy_alerts() as r';

type Job = { jobId: string; leaseToken: string; mode: string; bitrixDealId: string; objectPath: string; mime: string; sha256: string; travellerSeq: number; priorFileIds: number[]; attempts: number };
type Row = { status: string; attempts: number; last_error_code: string | null; prior_file_ids: string | null; bitrix_file_id: string | null };

let sourceId = 991000;
async function importedDealWithProof(opts: { on?: boolean } = {}): Promise<{ deal: string; proof: string }> {
  if (opts.on ?? true) await owner('update public.integration_intake_config set bitrix_id_proof_copy = true where id = $1', [CONFIG]);
  const deal = await h.insertRealDeal('C7:NEW', 7, (sourceId += 1));
  await h.draftWithTravellers(OWNER, deal);
  const proof = await h.storeIdProof(OWNER, deal, 1);
  return { deal, proof };
}
const jobs = (deal: string) =>
  owner<Row & { id: string }>(
    `select id, status, attempts, last_error_code, prior_file_ids::text, bitrix_file_id::text from public.bitrix_id_proof_copy_jobs where deal_id = $1 order by created_at`,
    [deal],
  );
const claim = (limit = 10) => one<Job[]>(SVC, CLAIM, [limit, 60]);
const due = (deal: string) => owner(`update public.bitrix_id_proof_copy_jobs set next_attempt_at = now() - interval '1 second' where deal_id = $1`, [deal]);
const audits = (action: string) =>
  owner<{ actor_user_id: string | null; details: Record<string, unknown> }>(
    'select actor_user_id, details from public.audit_events where action = $1 order by occurred_at, id',
    [action],
  );

describe('switch and enqueue', () => {
  it('off by default: a stored proof on an imported Deal makes no job', async () => {
    await asOwner(db, async () => {
      expect((await owner<{ on: boolean }>('select bitrix_id_proof_copy as on from public.integration_intake_config'))[0]!.on).toBe(false);
      const { deal } = await importedDealWithProof({ on: false });
      expect(await jobs(deal)).toEqual([]);
    });
  });

  it('only a Super Admin at aal2 switches it, with a reason; audited', async () => {
    await asOwner(db, async () => {
      for (const actor of [OWNER, { userId: U.managerDelhi }, { userId: U.accountsJodhpur }, { userId: U.adminJodhpur, aal: 'aal1' } as Actor, SVC]) {
        await refused(actor, SWITCH, [true, REASON], '42501');
      }
      await refused(SUPER, SWITCH, [true, 'short'], '22023');
      expect(await one(SUPER, SWITCH, [true, REASON])).toEqual({ changed: true, on: true });
      expect(await one(SUPER, SWITCH, [true, REASON])).toEqual({ changed: false, on: true });
      const trigger = (await audits('settings.intake_config_changed')).find((a) => a.details.command === 'integration_set_bitrix_id_proof_copy');
      expect(trigger!.details).toMatchObject({ changes: { bitrix_id_proof_copy: { from: false, to: true } } });
      expect(await audits('integration.id_proof_copy_switch_set')).toHaveLength(1);
    });
  });

  it('switch on: one job per (Deal, traveller, file hash), audited with ids and the hash only', async () => {
    await asOwner(db, async () => {
      const { deal } = await importedDealWithProof();
      // The same file again for the same traveller: no second job.
      await h.storeIdProof(OWNER, deal, 1);
      const rows = await jobs(deal);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'pending', attempts: 0 });
      const [enq] = await audits('integration.id_proof_copy_enqueued');
      expect(Object.keys(enq!.details).sort()).toEqual(['attempt', 'bitrixDealId', 'jobId', 'sha256', 'travellerId']);
      const everything = JSON.stringify(await owner("select details from public.audit_events where action like 'integration.id_proof_copy%'"));
      expect(everything).not.toMatch(/id-proof-\d\.jpg|\.jpg|image\/jpeg/);
    });
  });

  it('a Deal that was not imported from Bitrix gets no job', async () => {
    await asOwner(db, async () => {
      await owner('update public.integration_intake_config set bitrix_id_proof_copy = true where id = $1', [CONFIG]);
      await h.draftWithTravellers(OWNER, DEAL);
      await h.storeIdProof(OWNER, DEAL, 1);
      expect(await jobs(DEAL)).toEqual([]);
    });
  });
});

describe('worker commands (service role)', () => {
  it('claim leases a due job with what the worker needs; nothing while the switch is off', async () => {
    await asOwner(db, async () => {
      const { deal } = await importedDealWithProof();
      await owner('update public.integration_intake_config set bitrix_id_proof_copy = false where id = $1', [CONFIG]);
      expect(await claim()).toEqual([]);
      await owner('update public.integration_intake_config set bitrix_id_proof_copy = true where id = $1', [CONFIG]);
      const [job] = await claim();
      expect(job).toMatchObject({ mode: 'send', bitrixDealId: String(sourceId), mime: 'image/jpeg', sizeBytes: 2048, travellerSeq: 1, priorFileIds: [], attempts: 0 });
      expect(job!.objectPath).toMatch(new RegExp(`/${deal}/`));
      expect(await claim()).toEqual([]); // leased
      for (const actor of [OWNER, SUPER]) await refused(actor, CLAIM, [10, 60], '42501');
    });
  });

  it('send then sent: prior file ids recorded, attempt counted, audited', async () => {
    await asOwner(db, async () => {
      const { deal } = await importedDealWithProof();
      const [job] = await claim();
      await refused(SVC, MARK, [job!.jobId, '00000000-0000-4000-8000-000000000000', [11]], '40001', 'task_conflict');
      expect(await one(SVC, MARK, [job!.jobId, job!.leaseToken, [11, 12]])).toMatchObject({ status: 'unknown', attempts: 1 });
      expect(await one(SVC, COMPLETE, [job!.jobId, job!.leaseToken, 'sent', null, 13])).toMatchObject({ status: 'sent', attempts: 1, errorCode: null });
      expect((await jobs(deal))[0]).toMatchObject({ status: 'sent', prior_file_ids: '{11,12}', bitrix_file_id: '13' });
      expect((await audits('integration.id_proof_copy_sent'))[0]!.details).toMatchObject({ bitrixFileId: 13, bitrixDealId: sourceId });
    });
  });

  it('a lost answer becomes unknown and is claimed again as a read-back (verify) with the prior ids', async () => {
    await asOwner(db, async () => {
      const { deal } = await importedDealWithProof();
      const [job] = await claim();
      await one(SVC, MARK, [job!.jobId, job!.leaseToken, [21]]);
      expect(await one(SVC, COMPLETE, [job!.jobId, job!.leaseToken, 'unknown', 'answer_timeout', null])).toMatchObject({ status: 'unknown' });
      expect(await claim()).toEqual([]); // back-off
      await due(deal);
      const [again] = await claim();
      expect(again).toMatchObject({ jobId: job!.jobId, mode: 'verify', priorFileIds: [21], attempts: 1 });
      // Not found on read-back: pending again (it may be sent once more).
      expect(await one(SVC, COMPLETE, [again!.jobId, again!.leaseToken, 'retry', 'not_found_on_read_back', null])).toMatchObject({ status: 'pending' });
    });
  });

  it('retries back off and stop after 5 attempts; errors before sending count too', async () => {
    await asOwner(db, async () => {
      const { deal } = await importedDealWithProof();
      for (let i = 1; i <= 5; i += 1) {
        await due(deal);
        const [job] = await claim();
        const r = await one<{ status: string; attempts: number }>(SVC, COMPLETE, [job!.jobId, job!.leaseToken, 'retry', 'read_provider_timeout', null]);
        expect(r).toMatchObject({ attempts: i, status: i < 5 ? 'pending' : 'failed' });
      }
      await due(deal);
      expect(await claim()).toEqual([]);
      expect((await jobs(deal))[0]).toMatchObject({ status: 'failed', attempts: 5, last_error_code: 'read_provider_timeout' });
    });
  });

  it('refuses bad outcomes; a permanent failure stops at once', async () => {
    await asOwner(db, async () => {
      const { deal } = await importedDealWithProof();
      const [job] = await claim();
      await refused(SVC, COMPLETE, [job!.jobId, job!.leaseToken, 'sent', null, null], '22023');
      await refused(SVC, COMPLETE, [job!.jobId, job!.leaseToken, 'retry', null, null], '22023');
      await refused(SVC, COMPLETE, [job!.jobId, job!.leaseToken, 'retry', 'Bad Code!', null], '22023');
      await refused(SVC, COMPLETE, [job!.jobId, job!.leaseToken, 'deleted', 'x', null], '22023');
      expect(await one(SVC, COMPLETE, [job!.jobId, job!.leaseToken, 'failed', 'prior_files_lost', null])).toMatchObject({ status: 'failed' });
      expect((await jobs(deal))[0]).toMatchObject({ status: 'failed', last_error_code: 'prior_files_lost' });
    });
  });

  it('a proof removed before sending cancels its pending job', async () => {
    await asOwner(db, async () => {
      const { deal, proof } = await importedDealWithProof();
      const [file] = await owner<{ row_version: number }>('select row_version from public.traveller_id_proofs where id = $1', [proof]);
      await one(OWNER, 'select public.traveller_id_proof_remove($1, $2) as r', [proof, file!.row_version]);
      expect(await claim()).toEqual([]);
      expect((await jobs(deal))[0]).toMatchObject({ status: 'cancelled', last_error_code: 'proof_removed' });
    });
  });
});

describe('review E7: one job per Deal, circuit breaker, re-arm', () => {
  it('E7-2/E7-6: at most one job of a Deal in flight; an unknown job blocks the Deal until read back', async () => {
    await asOwner(db, async () => {
      const { deal } = await importedDealWithProof();
      await h.storeIdProof(OWNER, deal, 2);
      expect(await jobs(deal)).toHaveLength(2);
      const first = await claim(10);
      expect(first).toHaveLength(1);
      expect(await claim(10)).toEqual([]); // the other job of the Deal waits
      await one(SVC, MARK, [first[0]!.jobId, first[0]!.leaseToken, [11]]);
      await one(SVC, COMPLETE, [first[0]!.jobId, first[0]!.leaseToken, 'unknown', 'answer_timeout', null]);
      expect(await claim(10)).toEqual([]); // unknown and not yet due: still blocks the pending one
      await due(deal);
      const [verify] = await claim(10);
      expect(verify).toMatchObject({ jobId: first[0]!.jobId, mode: 'verify' }); // read-back goes first
      expect(await claim(10)).toEqual([]);
      await one(SVC, COMPLETE, [verify!.jobId, verify!.leaseToken, 'sent', null, 31]);
      const [second] = await claim(10);
      expect(second).toMatchObject({ mode: 'send' });
      expect(second!.jobId).not.toBe(first[0]!.jobId);
    });
  });

  it('E7-1: stop fails the job, switches the copy off with an audit, opens an alert; only the Super Admin retries', async () => {
    await asOwner(db, async () => {
      const { deal } = await importedDealWithProof();
      const [job] = await claim();
      await one(SVC, MARK, [job!.jobId, job!.leaseToken, [11, 12]]);
      for (const actor of [OWNER, SUPER]) await refused(actor, STOP, [job!.jobId, job!.leaseToken, 'prior_files_lost'], '42501');
      await refused(SVC, STOP, [job!.jobId, job!.leaseToken, 'something_else'], '22023');
      await refused(SVC, STOP, [job!.jobId, '00000000-0000-4000-8000-000000000000', 'prior_files_lost'], '40001');
      const stopped = await one<{ stopId: string; switchOn: boolean }>(SVC, STOP, [job!.jobId, job!.leaseToken, 'prior_files_lost']);
      expect(stopped.switchOn).toBe(false);
      expect((await jobs(deal))[0]).toMatchObject({ status: 'failed', last_error_code: 'prior_files_lost' });
      expect((await owner<{ on: boolean }>('select bitrix_id_proof_copy as on from public.integration_intake_config'))[0]!.on).toBe(false);
      const settings = (await audits('settings.intake_config_changed')).filter((a) => a.details.command === 'bitrix_id_proof_copy_stop');
      expect(settings).toHaveLength(1);
      expect(settings[0]!.details).toMatchObject({ changes: { bitrix_id_proof_copy: { from: true, to: false } } });
      const [auto] = await audits('integration.id_proof_copy_auto_stopped');
      expect(auto!.details).toMatchObject({ reasonCode: 'prior_files_lost', stopId: stopped.stopId, switchWasOn: true });

      // A second job elsewhere is not claimed while stopped.
      await importedDealWithProof({ on: false });
      expect(await claim()).toEqual([]);

      // Alert for the Super Admin only.
      expect(await one(OWNER, ALERTS, [])).toBeNull();
      const alerts = await one<{ stops: Array<Record<string, unknown>>; manualChecks: unknown[] }>(SUPER, ALERTS, []);
      expect(alerts.stops).toEqual([expect.objectContaining({ stopId: stopped.stopId, jobId: job!.jobId, reasonCode: 'prior_files_lost', acknowledgedAt: null })]);
      expect(alerts.manualChecks).toEqual([]);

      // Retry: never by a booking editor; by the Super Admin only once the copy is on again.
      await refused(OWNER, RETRY, [job!.jobId], '42501');
      await refused(SUPER, RETRY, [job!.jobId], '55000');
      await one(SUPER, SWITCH, [true, REASON]);
      const [acked] = (await one<{ stops: Array<{ acknowledgedAt: string | null }> }>(SUPER, ALERTS, [])).stops;
      expect(acked!.acknowledgedAt).not.toBeNull();
      expect(await one(SUPER, RETRY, [job!.jobId])).toEqual({ jobId: job!.jobId, status: 'pending' });
      // The alert row is append and acknowledge only.
      await expectDbError(db, () => owner('delete from public.bitrix_id_proof_copy_stops'), { code: '23514' });
      await expectDbError(db, () => owner("update public.bitrix_id_proof_copy_stops set acknowledged_at = now() + interval '1 minute'"), { code: '23514' });
      for (const actor of [OWNER, SUPER, SVC]) await refused(actor, 'select * from public.bitrix_id_proof_copy_stops', [], '42501');
    });
  });

  it('E8-2: five undecided read-backs in a row end as needs_manual_check; the Deal is freed; Super Admin sees and retries it', async () => {
    await asOwner(db, async () => {
      const { deal } = await importedDealWithProof();
      await h.storeIdProof(OWNER, deal, 2);
      const [job] = await claim();
      await one(SVC, MARK, [job!.jobId, job!.leaseToken, [11]]);
      let last = await one<{ status: string }>(SVC, COMPLETE, [job!.jobId, job!.leaseToken, 'unknown', 'answer_timeout', null]);
      for (let i = 2; i <= 5; i += 1) {
        expect(last.status).toBe('unknown');
        await due(deal);
        const [again] = await claim();
        expect(again).toMatchObject({ jobId: job!.jobId, mode: 'verify' });
        last = await one<{ status: string }>(SVC, COMPLETE, [again!.jobId, again!.leaseToken, 'unknown', 'file_facts_unavailable', null]);
      }
      expect(last.status).toBe('needs_manual_check');
      const row = (await owner<{ status: string; read_back_attempts: number }>('select status, read_back_attempts from public.bitrix_id_proof_copy_jobs where id = $1', [job!.jobId]))[0];
      expect(row).toEqual({ status: 'needs_manual_check', read_back_attempts: 5 });
      expect((await audits('integration.id_proof_copy_needs_manual_check'))[0]!.details).toMatchObject({ errorCode: 'file_facts_unavailable', readBackAttempts: 5 });
      // The Deal is free again: its other job is handed out.
      await due(deal);
      const [other] = await claim();
      expect(other).toMatchObject({ mode: 'send' });
      expect(other!.jobId).not.toBe(job!.jobId);
      // Alerts for the Super Admin; retry by the Super Admin only, as a read-back.
      const alerts = await one<{ manualChecks: Array<Record<string, unknown>> }>(SUPER, ALERTS, []);
      expect(alerts.manualChecks).toEqual([expect.objectContaining({ jobId: job!.jobId, lastErrorCode: 'file_facts_unavailable', readBackAttempts: 5 })]);
      await refused(OWNER, RETRY, [job!.jobId], '42501');
      expect(await one(SUPER, RETRY, [job!.jobId])).toEqual({ jobId: job!.jobId, status: 'unknown' });
      const status = await one<Array<{ jobId: string; status: string }>>(OWNER, STATUS, [deal]);
      expect(status.find((r) => r.jobId === job!.jobId)!.status).toBe('unknown');
    });
  });

  it('E7-8: a copy refused for its credentials is retried by the Super Admin only', async () => {
    await asOwner(db, async () => {
      await importedDealWithProof();
      const [job] = await claim();
      await one(SVC, MARK, [job!.jobId, job!.leaseToken, []]);
      await one(SVC, COMPLETE, [job!.jobId, job!.leaseToken, 'failed', 'bitrix_auth_failed', null]);
      await refused(OWNER, RETRY, [job!.jobId], '42501');
      expect(await one(SUPER, RETRY, [job!.jobId])).toEqual({ jobId: job!.jobId, status: 'pending' });
    });
  });

  it('E7-5: the same file stored again after its job was cancelled re-arms that job', async () => {
    await asOwner(db, async () => {
      const { deal, proof } = await importedDealWithProof();
      const [file] = await owner<{ row_version: number }>('select row_version from public.traveller_id_proofs where id = $1', [proof]);
      await one(OWNER, 'select public.traveller_id_proof_remove($1, $2) as r', [proof, file!.row_version]);
      expect(await claim()).toEqual([]);
      const [cancelled] = await jobs(deal);
      expect(cancelled).toMatchObject({ status: 'cancelled' });
      await h.storeIdProof(OWNER, deal, 1);
      const rows = await jobs(deal);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: cancelled!.id, status: 'pending', attempts: 0, last_error_code: null });
      const [again] = await claim();
      expect(again).toMatchObject({ jobId: cancelled!.id, mode: 'send' });
    });
  });
});

describe('staff: retry and status', () => {
  it('booking editors and the Super Admin retry a failed or unknown copy; others cannot; status shows codes only', async () => {
    await asOwner(db, async () => {
      const { deal } = await importedDealWithProof();
      const [job] = await claim();
      await refused(OWNER, RETRY, [job!.jobId], '55000', 'wrong_state'); // still pending
      await one(SVC, COMPLETE, [job!.jobId, job!.leaseToken, 'failed', 'bitrix_refused', null]);
      for (const actor of [PURCHASE, SALES_B, { userId: U.salesAhmedabad }]) await refused(actor, RETRY, [job!.jobId], '42501');
      expect(await one(OWNER, RETRY, [job!.jobId])).toEqual({ jobId: job!.jobId, status: 'pending' });
      expect((await jobs(deal))[0]).toMatchObject({ status: 'pending', attempts: 0 });
      const [again] = await claim();
      await one(SVC, MARK, [again!.jobId, again!.leaseToken, []]);
      await one(SVC, COMPLETE, [again!.jobId, again!.leaseToken, 'unknown', 'answer_network', null]);
      // An unknown copy stays a read-back after a manual retry (never re-sent blindly).
      expect(await one(SUPER, RETRY, [job!.jobId])).toEqual({ jobId: job!.jobId, status: 'unknown' });
      const [retried] = await audits('integration.id_proof_copy_manual_retry');
      expect(retried!.actor_user_id).toBe(U.salesDelhiA);

      const status = await one<Array<Record<string, unknown>>>(OWNER, STATUS, [deal]);
      expect(status).toHaveLength(1);
      expect(Object.keys(status[0]!).sort()).toEqual(['attempts', 'idProofId', 'jobId', 'lastErrorCode', 'maxAttempts', 'sentAt', 'status', 'travellerId', 'updatedAt']);
      expect(await one(PURCHASE, STATUS, [deal])).toBeNull();
    });
  });

  it('no API role reads the jobs table', async () => {
    await asOwner(db, async () => {
      for (const actor of [OWNER, SUPER, SVC]) await refused(actor, 'select * from public.bitrix_id_proof_copy_jobs', [], '42501');
    });
  });
});
