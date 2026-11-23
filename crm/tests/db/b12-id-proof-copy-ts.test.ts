import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ID_PROOF_FIELD } from '@/modules/fulfilment/b11-forms';
import { ID_PROOF_COPY_TEXT } from '@/modules/fulfilment/contracts';
import { FIELD } from '@/modules/fulfilment/forms';
import { SYNTHETIC_INTAKE_CONFIG as CONFIG, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { OWNER, SUPER, SVC } from './b1-support';
import { b11Helpers } from './b11-support';
import { staffAs } from './b12-ts-support';

/**
 * DEC-43 copy status, "Try again" and the Super Admin's stop alerts through
 * the TS layer on the real 0700 SQL (PGlite, synthetic; no Bitrix call: the
 * worker steps are played with the service-role commands). Rolled back.
 */

const requireStaff = vi.fn();
vi.mock('@/modules/identity/server/session', () => ({ requireStaff: () => requireStaff() }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => {
    throw new Error('not used');
  },
}));

const { retryIdProofCopyAction } = await import('@/modules/fulfilment/server/id-proof-actions');
const { loadIdProofCopyAlerts, loadIdProofCopyManualChecks, loadIdProofCopyStatus } = await import('@/modules/fulfilment/server/id-proofs');
/** The loaders take the session's Supabase client; the PGlite adapter answers the same rpc calls. */
const staffOf = (actor: Parameters<typeof staffAs>[1]) => staffAs(() => db, actor) as unknown as Parameters<typeof loadIdProofCopyStatus>[0];

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b11Helpers(() => db);
const { one, owner } = h;
const CLAIM = 'select public.bitrix_id_proof_copy_claim($1, $2) as r';
const COMPLETE = 'select public.bitrix_id_proof_copy_complete($1, $2, $3, $4, $5) as r';
const STOP = 'select public.bitrix_id_proof_copy_stop($1, $2, $3) as r';

let sourceId = 995000;
async function importedDealWithProof(): Promise<{ deal: string; proof: string }> {
  await owner('update public.integration_intake_config set bitrix_id_proof_copy = true where id = $1', [CONFIG]);
  const deal = await h.insertRealDeal('C7:NEW', 7, (sourceId += 1));
  await h.draftWithTravellers(OWNER, deal);
  const proof = await h.storeIdProof(OWNER, deal, 1);
  return { deal, proof };
}
async function claimOne(): Promise<{ jobId: string; leaseToken: string }> {
  const [job] = await one<Array<{ jobId: string; leaseToken: string }>>(SVC, CLAIM, [10, 60]);
  return job!;
}
function retryForm(deal: string, jobId: string): FormData {
  const f = new FormData();
  f.set(FIELD.dealId, deal);
  f.set(ID_PROOF_FIELD.copyJobId, jobId);
  return f;
}

describe('Bitrix copy status and try again', () => {
  it('pending → failed (refused) shows plain words and Try again; retry queues it again', async () => {
    await asOwner(db, async () => {
      const staff = staffOf(OWNER);
      requireStaff.mockResolvedValue(staff);
      const { deal, proof } = await importedDealWithProof();
      expect((await loadIdProofCopyStatus(staff, deal))![proof]).toMatchObject({ status: 'pending', statusText: 'Waiting to be copied to the Bitrix deal.', canRetry: false, reasonText: null });

      const job = await claimOne();
      await one(SVC, COMPLETE, [job.jobId, job.leaseToken, 'failed', 'bitrix_refused', null]);
      const failed = (await loadIdProofCopyStatus(staff, deal))![proof]!;
      expect(failed).toMatchObject({ jobId: job.jobId, status: 'failed', reasonText: 'Bitrix refused the file.', canRetry: true, retryNeedsSuperAdmin: false });

      expect(await retryIdProofCopyAction(null, retryForm(deal, job.jobId))).toEqual({ ok: true, data: { jobId: job.jobId, status: 'pending' }, message: ID_PROOF_COPY_TEXT.retried });
      expect((await loadIdProofCopyStatus(staff, deal))![proof]).toMatchObject({ status: 'pending', attempts: 0 });
      // A second click: already queued.
      expect(await retryIdProofCopyAction(null, retryForm(deal, job.jobId))).toMatchObject({ ok: false, code: 'wrong_state' });
    });
  });

  it('a lost answer stays "being checked" after a retry; read codes fall back by prefix', async () => {
    await asOwner(db, async () => {
      const staff = staffOf(OWNER);
      requireStaff.mockResolvedValue(staff);
      const { deal, proof } = await importedDealWithProof();
      const job = await claimOne();
      await one(SVC, COMPLETE, [job.jobId, job.leaseToken, 'unknown', 'answer_timeout', null]);
      expect((await loadIdProofCopyStatus(staff, deal))![proof]).toMatchObject({ status: 'unknown', reasonText: expect.stringContaining('did not answer clearly'), canRetry: true });
      expect(await retryIdProofCopyAction(null, retryForm(deal, job.jobId))).toMatchObject({ ok: true, data: { status: 'unknown' }, message: ID_PROOF_COPY_TEXT.retriedChecking });
    });
  });

  it('a refused sign-in is for the Super Admin only; the editor is told so', async () => {
    await asOwner(db, async () => {
      const staff = staffOf(OWNER);
      requireStaff.mockResolvedValue(staff);
      const { deal, proof } = await importedDealWithProof();
      const job = await claimOne();
      await one(SVC, COMPLETE, [job.jobId, job.leaseToken, 'failed', 'bitrix_auth_failed', null]);
      expect((await loadIdProofCopyStatus(staff, deal))![proof]).toMatchObject({ status: 'failed', canRetry: false, retryNeedsSuperAdmin: true });
      expect(await retryIdProofCopyAction(null, retryForm(deal, job.jobId))).toMatchObject({ ok: false, code: 'not_authorized', message: ID_PROOF_COPY_TEXT.askSuperAdmin });
      requireStaff.mockResolvedValue(staffOf(SUPER));
      expect(await retryIdProofCopyAction(null, retryForm(deal, job.jobId))).toMatchObject({ ok: true, data: { status: 'pending' } });
    });
  });

  it('an automatic stop: Super Admin alert (open), copy switched off, retry refused until switched on; others see no alerts', async () => {
    await asOwner(db, async () => {
      const { deal } = await importedDealWithProof();
      const job = await claimOne();
      await one(SVC, STOP, [job.jobId, job.leaseToken, 'prior_files_lost']);
      const superStaff = staffOf(SUPER);
      const alerts = await loadIdProofCopyAlerts(superStaff);
      expect(alerts!.stops).toEqual([expect.objectContaining({ jobId: job.jobId, bitrixDealId: String(sourceId), open: true, acknowledgedAt: null, reasonText: expect.stringContaining('Copying stopped for safety') })]);
      expect(await loadIdProofCopyManualChecks(superStaff)).toEqual([]);
      expect(await loadIdProofCopyAlerts(staffOf(OWNER))).toBeNull();
      requireStaff.mockResolvedValue(superStaff);
      expect(await retryIdProofCopyAction(null, retryForm(deal, job.jobId))).toMatchObject({ ok: false, code: 'wrong_state', message: ID_PROOF_COPY_TEXT.switchOff });
    });
  });

  it('nothing for a non-editor or a malformed id', async () => {
    await asOwner(db, async () => {
      const { deal } = await importedDealWithProof();
      expect(await loadIdProofCopyStatus(staffOf(SVC), deal)).toBeNull();
      expect(await loadIdProofCopyStatus(staffOf(OWNER), 'nope')).toBeNull();
    });
  });

  it('needs_manual_check (five unclear read-backs): editor sees it as the Super Admin\'s; the Super Admin sees it listed and retries it into a read-back', async () => {
    await asOwner(db, async () => {
      const owner_ = staffOf(OWNER);
      requireStaff.mockResolvedValue(owner_);
      const { deal, proof } = await importedDealWithProof();
      const job = await claimOne();
      // Five unclear read-backs in a row (played by the worker until the job stops).
      await one(SVC, COMPLETE, [job.jobId, job.leaseToken, 'unknown', 'answer_timeout', null]);
      for (let i = 0; i < 4; i += 1) {
        await owner(`update public.bitrix_id_proof_copy_jobs set next_attempt_at = now() - interval '1 second' where id = $1`, [job.jobId]);
        const again = await claimOne();
        await one(SVC, COMPLETE, [again.jobId, again.leaseToken, 'unknown', 'read_back_failed', null]);
      }
      expect((await loadIdProofCopyStatus(owner_, deal))![proof]).toMatchObject({ status: 'needs_manual_check', canRetry: false, retryNeedsSuperAdmin: true });
      expect(await retryIdProofCopyAction(null, retryForm(deal, job.jobId))).toMatchObject({ ok: false, code: 'not_authorized', message: ID_PROOF_COPY_TEXT.askSuperAdmin });

      const superStaff = staffOf(SUPER);
      expect(await loadIdProofCopyManualChecks(staffOf(OWNER))).toBeNull();
      expect(await loadIdProofCopyManualChecks(superStaff)).toEqual([expect.objectContaining({ jobId: job.jobId, bitrixDealId: String(sourceId), readBackAttempts: 5, reasonText: expect.stringContaining('could not be read') })]);
      requireStaff.mockResolvedValue(superStaff);
      const f = new FormData();
      f.set(ID_PROOF_FIELD.copyJobId, job.jobId); // from the alerts list: no Deal id
      expect(await retryIdProofCopyAction(null, f)).toEqual({ ok: true, data: { jobId: job.jobId, status: 'unknown' }, message: ID_PROOF_COPY_TEXT.retriedChecking });
      expect(await loadIdProofCopyManualChecks(superStaff)).toEqual([]);
    });
  });
});
