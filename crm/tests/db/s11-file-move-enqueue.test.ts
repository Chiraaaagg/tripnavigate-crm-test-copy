import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb, expectDbError } from '../helpers/db';
import { ACC_BOX, DEAL, DEAL2, ID_BOX, OWNER, SQL, SUPER, SVC, hex, s11Helpers } from './s11-support';

/**
 * S11 "files to Bitrix", migration 20261212000110 (listing, cancel, adoption,
 * removed deals, the kick) and the sweep of 20261212000120 (contract file 14
 * sections 1.3 and 2.1-2.2, file 11 section 4.2 "s11-file-move-enqueue"):
 *   - class by table and kind for all seven tables (the class table, and the
 *     trigger on real rows of every table);
 *   - class B due_at = stored_at + 90 days, never claimable earlier, nor with
 *     the Accounts switch off, nor with no Accounts box; accounts_hold_days
 *     never under 90;
 *   - no_target (deposit slip, customer-level paper, a Deal that is not a
 *     Bitrix Deal);
 *   - a failing listing never blocks the upload; enqueue_enabled off; cancel;
 *   - adoption only from waiting / copy_pending; a job turning sent again
 *     leaves a checked or deleted row untouched (files.move_adoption_ignored);
 *     the re-upload of a file already sent is adopted at creation;
 *   - a stuck row appears in the alerts; the sweep creates a missed row.
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

describe('class table (file 14 section 1.3)', () => {
  it('authz.file_move_kind gives the class and kind code of every kind of the seven tables; class C kinds get none', async () => {
    const cases: Array<[string, string | null, [string, string] | null]> = [
      ['traveller_id_proofs', null, ['id_proof', 'id']],
      ['department_evidence', 'applicant_document', ['id_proof', 'id']],
      ['department_evidence', 'fee_receipt', ['accounts', 'fee']],
      ['department_evidence', 'direct_payment_proof', ['accounts', 'dpp']],
      ['department_evidence', 'authority_outcome', null],
      ['department_evidence', 'other', null],
      ['department_evidence', 'e_ticket', null],
      ['department_evidence', 'boarding_pass', null],
      ['customer_party_documents', 'id_proof', ['id_proof', 'id']],
      ['customer_party_documents', 'gst_certificate', null],
      ['customer_party_documents', 'other', null],
      ['finance_evidence', 'bank_proof', ['accounts', 'bank']],
      ['finance_evidence', 'cheque_image', ['accounts', 'chq']],
      ['finance_evidence', 'deposit_slip', ['accounts', 'dep']],
      ['refund_evidence', 'customer_refund', ['accounts', 'rfd']],
      ['refund_evidence', 'supplier_refund', ['accounts', 'rfd']],
      ['supplier_money_evidence', 'proforma', ['accounts', 'pro']],
      ['supplier_money_evidence', 'payment_proof', ['accounts', 'pay']],
      ['supplier_money_evidence', 'invoice', ['accounts', 'inv']],
      ['supplier_money_evidence', 'credit_note', ['accounts', 'cn']],
      ['booking_evidence', 'bill', ['accounts', 'bill']],
      ['booking_evidence', 'payment_proof', ['accounts', 'pay']],
      ['booking_evidence', 'acceptance_message', null],
      ['booking_evidence', 'ticket', null],
      ['booking_evidence', 'other', null],
      ['purchase_evidence', 'supplier_confirmation', null],
    ];
    for (const [table, kind, expected] of cases) {
      const [row] = await db.query<{ k: string[] | null }>('select authz.file_move_kind($1, $2) as k', [table, kind]);
      expect(row!.k, `${table} ${kind}`).toEqual(expected);
    }
    const buckets = await db.query<{ t: string; b: string }>(
      `select t, authz.file_move_bucket(t) as b from unnest(array['traveller_id_proofs', 'department_evidence', 'customer_party_documents',
         'finance_evidence', 'refund_evidence', 'supplier_money_evidence', 'booking_evidence']) t`);
    expect(Object.fromEntries(buckets.map((r) => [r.t, r.b]))).toEqual({
      traveller_id_proofs: 'traveller-id-proofs', department_evidence: 'department-evidence', customer_party_documents: 'customer-party-documents',
      finance_evidence: 'finance-evidence', refund_evidence: 'finance-evidence', supplier_money_evidence: 'supplier-money',
      booking_evidence: 'booking-evidence',
    });
  });

  it('every stored file of the seven tables is listed by the trigger with its class; class C and unstored files are not; then the sweep lists them on a Bitrix Deal', async () => {
    await asOwner(db, async () => {
      const pkg = await s.confirmedPackage();
      const dep = {
        applicant: await s.departmentFile(pkg.visaTask, 'applicant_document'),
        fee: await s.departmentFile(pkg.visaTask, 'fee_receipt'),
        dpp: await s.departmentFile(pkg.visaTask, 'direct_payment_proof'),
        outcome: await s.departmentFile(pkg.visaTask, 'authority_outcome'),
        pending: await s.departmentFile(pkg.visaTask, 'fee_receipt', 'pending_upload'),
      };
      const sm = {
        pro: await s.supplierMoneyFile(pkg.purchaseTask, 'proforma'),
        inv: await s.supplierMoneyFile(pkg.purchaseTask, 'invoice'),
        cn: await s.supplierMoneyFile(pkg.purchaseTask, 'credit_note'),
      };
      const fin = await s.financeFiles();
      const refund = await s.refundFile(DEAL);
      const partyId = await s.partyFile('id_proof');
      const partyGst = await s.partyFile('gst_certificate');

      // SYN-DEL-001 is not a Bitrix Deal: every moving kind is listed, no_target.
      const expected: Array<[string, string, string, string]> = [
        ...pkg.proofs.map((id) => ['traveller_id_proofs', id, 'id_proof', 'id'] as [string, string, string, string]),
        ['booking_evidence', pkg.bookingPayment, 'accounts', 'pay'],
        ['booking_evidence', pkg.bookingBill, 'accounts', 'bill'],
        ['department_evidence', dep.applicant, 'id_proof', 'id'],
        ['department_evidence', dep.fee, 'accounts', 'fee'],
        ['department_evidence', dep.dpp, 'accounts', 'dpp'],
        ['supplier_money_evidence', sm.pro, 'accounts', 'pro'],
        ['supplier_money_evidence', sm.inv, 'accounts', 'inv'],
        ['supplier_money_evidence', sm.cn, 'accounts', 'cn'],
        ['finance_evidence', fin.bankProof, 'accounts', 'bank'],
        ['finance_evidence', fin.chequeImage, 'accounts', 'chq'],
        ['finance_evidence', fin.slip, 'accounts', 'dep'],
        ['refund_evidence', refund.id, 'accounts', 'rfd'],
        ['customer_party_documents', partyId, 'id_proof', 'id'],
      ];
      expect(pkg.proofs.length).toBeGreaterThan(0);
      for (const [table, id, cls, kind] of expected) {
        expect(await s.moveOf(table, id), `${table} ${kind}`).toMatchObject({
          file_class: cls, kind_code: kind, state: 'no_target', source_deal_id: null, crm_copy_present: true, enqueued_by: 'trigger',
          bucket_id: (await owner<{ b: string }>('select authz.file_move_bucket($1) as b', [table]))[0]!.b,
        });
      }
      for (const [table, id] of [['booking_evidence', pkg.bookingAcceptance], ['department_evidence', dep.outcome],
        ['department_evidence', dep.pending], ['finance_evidence', fin.pending], ['customer_party_documents', partyGst]] as const) {
        expect(await s.moveOf(table, id), `${table} not listed`).toBeUndefined();
      }
      // Codes and ids only in the listing audit.
      const [enq] = await s.audits('files.move_enqueued');
      expect(Object.keys(enq!.details).sort()).toEqual(['adoptedAtCreation', 'attempts', 'dec43JobId', 'fileClass', 'kindCode', 'moveId',
        'sourceId', 'sourceTable', 'state', 'via']);

      // The Deal becomes a Bitrix Deal; the rows of its files are gone (a missed listing): the sweep lists them again, with a target.
      await s.bitrixify(DEAL, 993201);
      await owner('delete from public.file_bitrix_moves where source_id = any ($1::uuid[])', [expected.map((e) => e[1])]);
      const swept = await one<{ created: number; madeDue: number; stuck: number }>(SVC, SQL.sweep, []);
      expect(swept.created).toBeGreaterThanOrEqual(expected.length);
      expect(swept.madeDue).toBe(0);
      for (const [table, id, cls, kind] of expected) {
        const m = await s.moveOf(table, id);
        expect(m, `${table} ${kind}`).toBeDefined();
        expect(m!.enqueued_by).toBe('sweep');
        if (table === 'customer_party_documents' || kind === 'dep') {
          expect(m, `${table} ${kind} has no Bitrix deal`).toMatchObject({ state: 'no_target', source_deal_id: null });
        } else if (table === 'traveller_id_proofs') {
          expect(m).toMatchObject({ state: 'waiting', bitrix_field: ID_BOX, source_deal_id: '993201', due_days: null });
        } else if (cls === 'id_proof') {
          expect(m, 'visa applicant paper: S11 copies it at once').toMatchObject({ state: 'copy_pending', bitrix_field: ID_BOX, source_deal_id: '993201' });
        } else {
          expect(m, `${table} ${kind} waits 90 days`).toMatchObject({ state: 'waiting', bitrix_field: null, source_deal_id: '993201', due_days: 90 });
        }
      }
    });
  }, 180_000);
});

describe('Accounts files wait 90 days', () => {
  it('due_at = stored_at + 90 days; never claimable earlier, nor with the Accounts switch off, nor with no Accounts box', async () => {
    await asOwner(db, async () => {
      const deal = await s.bitrixDeal(993211);
      const early = await s.refundFile(deal, { storedDaysAgo: 89 });
      const late = await s.refundFile(deal, { storedDaysAgo: 91 });
      const e = await s.moveIdOf('refund_evidence', early.id);
      const l = await s.moveIdOf('refund_evidence', late.id);
      expect(await s.move(e)).toMatchObject({ state: 'waiting', file_class: 'accounts', kind_code: 'rfd', due_days: 90, bitrix_field: null });
      expect((await s.move(l)).due_days).toBe(90);

      // Due, but the Accounts switch is off.
      await s.settings({ check: true, accounts: false, box: ACC_BOX });
      expect((await one<{ madeDue: number }>(SVC, SQL.sweep, [])).madeDue).toBe(0);
      // Accounts switch on, no box set.
      await s.settings({ check: true, accounts: true, box: null });
      expect((await one<{ madeDue: number }>(SVC, SQL.sweep, [])).madeDue).toBe(0);
      expect(await s.claimAll()).toEqual([]);
      expect((await s.move(l)).state).toBe('waiting');

      // Switch on and box set: only the file stored more than 90 days ago becomes copy_pending, into the Accounts box.
      await s.settings({ check: true, accounts: true, box: ACC_BOX });
      expect((await one<{ madeDue: number }>(SVC, SQL.sweep, [])).madeDue).toBe(1);
      expect(await s.move(l)).toMatchObject({ state: 'copy_pending', bitrix_field: ACC_BOX });
      expect(await s.move(e)).toMatchObject({ state: 'waiting', bitrix_field: null });
      const jobs = await s.claimAll();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        moveId: l, mode: 'copy', fileClass: 'accounts', sourceTable: 'refund_evidence', kindCode: 'rfd', bitrixDealId: '993211',
        bitrixField: ACC_BOX, bucket: 'finance-evidence', objectPath: late.objectPath, mime: 'application/pdf', sizeBytes: 2048,
        sha256: late.sha, bitrixFileId: null, priorFileIds: [], knownFileIds: [], attempts: 0,
      });
      // Moving the clock (due_at) one day on makes the other one due too.
      await s.setMove(e, `due_at = now() - interval '1 second'`);
      expect((await one<{ madeDue: number }>(SVC, SQL.sweep, [])).madeDue).toBe(1);
    });
  });

  it('a raised hold (owner SQL, audited) gives a later due date; it never goes under 90 days', async () => {
    await asOwner(db, async () => {
      await s.settings({ holdDays: 120 });
      const deal = await s.bitrixDeal(993212);
      const file = await s.refundFile(deal, { storedDaysAgo: 100 });
      expect((await s.moveOf('refund_evidence', file.id))!.due_days).toBe(120);
      await s.settings({ check: true, accounts: true, box: ACC_BOX, holdDays: 120 });
      expect((await one<{ madeDue: number }>(SVC, SQL.sweep, [])).madeDue).toBe(0);
      await expectDbError(db, () => s.settings({ holdDays: 89 }), { code: '23514', message: /accounts_hold_days/ });
      const changed = await s.audits('settings.file_move_changed');
      expect(changed.some((a) => JSON.stringify(a.details).includes('accounts_hold_days'))).toBe(true);
    });
  });

  it('a removed Deal\'s due row stays waiting until the Deal returns', async () => {
    await asOwner(db, async () => {
      await s.settings({ accounts: true, box: ACC_BOX });
      const deal = await s.bitrixDeal(993213);
      const file = await s.refundFile(deal, { storedDaysAgo: 95 });
      await s.removeDeal(deal);
      expect((await one<{ madeDue: number }>(SVC, SQL.sweep, [])).madeDue).toBe(0);
      await s.restoreDeal(deal);
      expect((await one<{ madeDue: number }>(SVC, SQL.sweep, [])).madeDue).toBe(1);
      expect((await s.moveOf('refund_evidence', file.id))!.state).toBe('copy_pending');
    });
  });
});

describe('no_target', () => {
  it('a deposit slip (branch), a customer-level paper and a file of a Deal that is not from Bitrix stay in the CRM', async () => {
    await asOwner(db, async () => {
      await s.bitrixify(DEAL, 993221);
      const fin = await s.financeFiles();
      const party = await s.partyFile('id_proof');
      expect(await s.moveOf('finance_evidence', fin.slip)).toMatchObject({ state: 'no_target', kind_code: 'dep', source_deal_id: null });
      expect(await s.moveOf('customer_party_documents', party)).toMatchObject({ state: 'no_target', file_class: 'id_proof', source_deal_id: null });
      // The receipt's bank proof on the (now Bitrix) Deal does get a target.
      expect(await s.moveOf('finance_evidence', fin.bankProof)).toMatchObject({ state: 'waiting', source_deal_id: '993221', due_days: 90 });
      // A Deal that is not a Bitrix Deal.
      const other = await s.refundFile(DEAL2);
      expect(await s.moveOf('refund_evidence', other.id)).toMatchObject({ state: 'no_target', source_deal_id: null });
      // no_target rows are never handed out and counted for the Super Admin.
      await s.settings({ check: true, accounts: true, box: ACC_BOX });
      expect(await s.claimAll()).toEqual([]);
      const alerts = await one<{ counts: { noTarget: number } }>(SUPER, SQL.alerts, []);
      expect(alerts.counts.noTarget).toBeGreaterThanOrEqual(3);
    });
  });
});

describe('listing never blocks staff work', () => {
  it('a failing listing is audited by code and the upload is stored; the sweep lists the file within its next run', async () => {
    await asOwner(db, async () => {
      const deal = await s.bitrixDeal(993231);
      // SYNTHETIC FAULT: refuse every new traveller-proof move row, inside this rolled-back transaction only.
      await owner(`alter table public.file_bitrix_moves add constraint s11_test_refuse_listing check (source_table <> 'traveller_id_proofs') not valid`);
      const proof = await s.storeProof(deal, 1, { object: true });
      expect((await owner<{ status: string }>('select status from public.traveller_id_proofs where id = $1', [proof.fileId]))[0]!.status).toBe('stored');
      expect(await s.moveOf('traveller_id_proofs', proof.fileId)).toBeUndefined();
      const [failed] = await s.audits('files.move_enqueue_failed', proof.fileId);
      expect(failed!.details).toEqual({ sourceTable: 'traveller_id_proofs', operation: 'update', sqlState: '23514' });
      // Counted as a missed listing until the sweep runs.
      const before = await one<{ counts: { missedEnqueue: number } }>(SUPER, SQL.alerts, []);
      expect(before.counts.missedEnqueue).toBeGreaterThanOrEqual(1);
      await owner('alter table public.file_bitrix_moves drop constraint s11_test_refuse_listing');
      const swept = await one<{ created: number }>(SVC, SQL.sweep, []);
      expect(swept.created).toBeGreaterThanOrEqual(1);
      expect(await s.moveOf('traveller_id_proofs', proof.fileId)).toMatchObject({ state: 'waiting', enqueued_by: 'sweep', bitrix_field: ID_BOX });
      const after = await one<{ counts: { missedEnqueue: number } }>(SUPER, SQL.alerts, []);
      expect(after.counts.missedEnqueue).toBeGreaterThanOrEqual(1); // the swept row is still counted (enqueued_by = sweep)
    });
  });

  it('the sweep lists only files stored after the install; the owner backfill lists older ones', async () => {
    await asOwner(db, async () => {
      const deal = await s.bitrixDeal(993232);
      await s.settings({ enqueue: false });
      const proof = await s.storeProof(deal, 1, { object: true });
      expect(await s.moveOf('traveller_id_proofs', proof.fileId)).toBeUndefined();
      await s.settings({ enqueue: true });
      await owner(`update public.file_move_kick_state set installed_at = now() + interval '1 minute' where id`);
      await one(SVC, SQL.sweep, []);
      expect(await s.moveOf('traveller_id_proofs', proof.fileId)).toBeUndefined();
      const backfilled = await owner<{ r: { created: number } }>('select authz.file_move_backfill(100) as r');
      expect(backfilled[0]!.r.created).toBeGreaterThanOrEqual(1);
      expect(await s.moveOf('traveller_id_proofs', proof.fileId)).toMatchObject({ state: 'waiting', enqueued_by: 'backfill' });
    });
  });

  it('enqueue_enabled off: nothing is listed, not even by the sweep; on again: the sweep lists it', async () => {
    await asOwner(db, async () => {
      const deal = await s.bitrixDeal(993233);
      await s.settings({ enqueue: false });
      const file = await s.refundFile(deal, { storedDaysAgo: 1 });
      expect(await s.moveOf('refund_evidence', file.id)).toBeUndefined();
      await one(SVC, SQL.sweep, []);
      expect(await s.moveOf('refund_evidence', file.id)).toBeUndefined();
      await s.settings({ enqueue: true });
      await one(SVC, SQL.sweep, []);
      expect(await s.moveOf('refund_evidence', file.id)).toMatchObject({ state: 'waiting', enqueued_by: 'sweep' });
    });
  });
});

describe('cancel', () => {
  const removeProof = async (fileId: string) => {
    const [file] = await owner<{ row_version: number }>('select row_version from public.traveller_id_proofs where id = $1', [fileId]);
    await one(OWNER, 'select public.traveller_id_proof_remove($1, $2) as r', [fileId, file!.row_version]);
  };

  it('a file that leaves stored is cancelled while the CRM still holds it; never once Bitrix holds the only copy or a send is in flight', async () => {
    await asOwner(db, async () => {
      const deal = await s.bitrixDeal(993241);
      const a = await s.storeProof(deal, 1, { object: true });
      const b = await s.storeProof(deal, 2, { object: true });
      const c = await s.storeProof(deal, 3, { object: true });
      const ma = await s.moveIdOf('traveller_id_proofs', a.fileId);
      const mb = await s.moveIdOf('traveller_id_proofs', b.fileId);
      const mc = await s.moveIdOf('traveller_id_proofs', c.fileId);
      await s.soleCopy(mb, 601);
      await s.setMove(mc, `state = 'copy_sending', prior_file_ids = '{}'`);
      for (const f of [a, b, c]) await removeProof(f.fileId);
      expect(await s.move(ma)).toMatchObject({ state: 'cancelled', last_error_code: 'source_removed', crm_copy_present: true });
      expect(await s.move(mb)).toMatchObject({ state: 'deleted', crm_copy_present: false });
      expect((await s.move(mc)).state).toBe('copy_sending');
      expect(await s.audits('files.move_cancelled', ma)).toHaveLength(1);
      expect(await s.audits('files.move_cancelled', mb)).toHaveLength(0);
    });
  });
});

describe('adoption of a DEC-43 send', () => {
  async function sentJob(deal: string, fileId: number) {
    const [job] = await s.dec43Claim();
    expect(job).toBeDefined();
    await one(SVC, SQL.dec43Mark, [job!.jobId, job!.leaseToken, []]);
    await one(SVC, SQL.dec43Complete, [job!.jobId, job!.leaseToken, 'sent', null, fileId]);
    expect((await s.dec43Jobs(deal)).find((j) => j.id === job!.jobId)!.status).toBe('sent');
    return job!.jobId;
  }

  it('a waiting or copy_pending row becomes copied with the job\'s Bitrix file id; audited', async () => {
    await asOwner(db, async () => {
      await s.dec43(true);
      const deal = await s.bitrixDeal(993251);
      const proof = await s.storeProof(deal, 1, { object: true });
      const m = await s.moveIdOf('traveller_id_proofs', proof.fileId);
      expect((await s.move(m)).state).toBe('waiting');
      const jobId = await sentJob(deal, 701);
      expect(await s.move(m)).toMatchObject({ state: 'copied', bitrix_file_id: '701', dec43_job_id: jobId, bitrix_field: ID_BOX });
      const [copied] = await s.audits('files.move_copied', m);
      expect(copied!.details).toMatchObject({ via: 'dec43', dec43JobId: jobId });

      const second = await s.storeProof(deal, 2, { object: true });
      const m2 = await s.moveIdOf('traveller_id_proofs', second.fileId);
      await s.copyPending(m2);
      await sentJob(deal, 702);
      expect(await s.move(m2)).toMatchObject({ state: 'copied', bitrix_file_id: '702' });
    });
  });

  it('a job turning sent a second time leaves a verified, delete_pending or deleted row untouched and audits files.move_adoption_ignored', async () => {
    await asOwner(db, async () => {
      await s.dec43(true);
      const deal = await s.bitrixDeal(993252);
      const proof = await s.storeProof(deal, 1, { object: true });
      const m = await s.moveIdOf('traveller_id_proofs', proof.fileId);
      const jobId = await sentJob(deal, 711);
      for (const [state, prepare] of [
        ['verified', () => s.verifiedPastHold(m, 711)],
        ['delete_pending', () => s.deletePending(m, 711)],
        ['deleted', () => s.soleCopy(m, 711)],
      ] as const) {
        await prepare();
        // SYNTHETIC: the job is sent again (owner SQL), with another file id.
        await owner(`update public.bitrix_id_proof_copy_jobs set status = 'unknown', sent_at = null where id = $1`, [jobId]);
        await owner(`update public.bitrix_id_proof_copy_jobs set status = 'sent', sent_at = now(), bitrix_file_id = 799 where id = $1`, [jobId]);
        expect(await s.move(m), state).toMatchObject({ state, bitrix_file_id: '711' });
      }
      const ignored = await s.audits('files.move_adoption_ignored', m);
      expect(ignored).toHaveLength(3);
      expect(ignored[0]!.details).toMatchObject({ dec43JobId: jobId, state: 'verified' });
    });
  });

  it('the same file stored again after its job was sent is adopted at creation (no new DEC-43 job)', async () => {
    await asOwner(db, async () => {
      await s.dec43(true);
      const deal = await s.bitrixDeal(993253);
      const sha = hex('s11-reupload');
      const first = await s.storeProof(deal, 1, { object: true, sha });
      const jobId = await sentJob(deal, 721);
      const [file] = await owner<{ row_version: number }>('select row_version from public.traveller_id_proofs where id = $1', [first.fileId]);
      await one(OWNER, 'select public.traveller_id_proof_remove($1, $2) as r', [first.fileId, file!.row_version]);
      const again = await s.storeProof(deal, 1, { object: true, sha });
      const m = await s.moveIdOf('traveller_id_proofs', again.fileId);
      expect(await s.move(m)).toMatchObject({ state: 'copied', bitrix_file_id: '721', dec43_job_id: jobId });
      expect(await s.dec43Jobs(deal)).toEqual([{ id: jobId, status: 'sent', bitrix_file_id: '721' }]);
      const enq = (await s.audits('files.move_enqueued', m))[0]!;
      expect(enq.details).toMatchObject({ adoptedAtCreation: true, dec43JobId: jobId, state: 'copied' });
    });
  });
});

describe('stuck rows and the sweep counts', () => {
  it('an identity row still waiting a day after it was stored appears in the alerts as stuck and in the sweep count', async () => {
    await asOwner(db, async () => {
      const entity = await s.entityId();
      const [row] = await owner<{ id: string }>(
        `insert into public.file_bitrix_moves (legal_entity_id, source_table, source_id, file_class, kind_code, bucket_id, object_path, mime,
           size_bytes, sha256, stored_at, deal_id, source_portal, source_deal_id, bitrix_field, state)
         values ($1, 'traveller_id_proofs', gen_random_uuid(), 'id_proof', 'id', 'traveller-id-proofs', 'synthetic/stuck', 'image/jpeg',
           2048, $2, now() - interval '2 days', $3, 'SYNTHETIC_MEMBER_0001', 993261, $4, 'waiting')
         returning id`,
        [entity, hex('s11-stuck'), DEAL, ID_BOX],
      );
      const alerts = await one<{ items: Array<{ moveId: string; kind: string; state: string }> }>(SUPER, SQL.alerts, []);
      expect(alerts.items).toContainEqual(expect.objectContaining({ moveId: row!.id, kind: 'stuck', state: 'waiting' }));
      expect((await one<{ stuck: number }>(SVC, SQL.sweep, [])).stuck).toBeGreaterThanOrEqual(1);
      expect(await one(OWNER, SQL.alerts, [])).toBeNull();
    });
  });
});
