import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb, resetActor } from '../helpers/db';
import { FLIGHT, OTHER_ENTITY, SALES_B, SELLING, VISA } from './acc-support';
import {
  ACC, DEAL, HOTEL, HOTEL_ITEM, MANAGER, NEW_SELLING, OWNER, PURCHASE, REASON, SQLB, TRANSFER_ITEM, relbHelpers, rid, sha, text, today,
} from './acc3-relb-support';

/**
 * Accounts phase 3, track G's own database checks (contract 10.1-10.5).
 * Uses Track T's scenario helpers.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = relbHelpers(() => db);
const { one, owner } = h;

const scalar = async <T>(sql: string, params: unknown[]) => {
  await resetActor(db);
  return (await owner<{ r: T }>(sql, params))[0]!.r;
};

/** The reconfirmation proof through purchase_evidence_begin / _finish (Addendum L5). */
const proof = (taskId: string) => h.reconfirmProof(taskId);

async function record(reconfId: string, taskId: string, rate: string, fee = '0', ref = 'SYN-CONF-0002') {
  const evidenceId = await proof(taskId);
  return one<Record<string, unknown>>(PURCHASE, SQLB.reconfirmRecord, [reconfId, await h.reconfRv(reconfId), JSON.stringify({
    newRatePaise: rate, supplierFeePaise: fee, newReference: ref, evidenceId, note: null }), rid()]);
}

describe('track G apply path', () => {
  it('within budget: applied in one step with review, costs, history, go-ahead, dues, basis', async () => {
    await asOwner(db, async () => {
      const { b, hotelItem, hotelTask } = await h.committedDeal();
      const { cr, versionId } = await h.submittedChange(hotelItem);
      const [x] = await h.reconfirmations(cr.changeRequestId);
      expect(x!.status).toBe('pending');
      await record(x!.id, hotelTask, '12000000', '500000');
      expect((await h.crRow(cr.changeRequestId)).status).toBe('applied');
      const versions = await owner<{ status: string; acceptance_from_version_id: string | null }>(
        'select status, acceptance_from_version_id from public.booking_versions where id = any ($1::uuid[]) order by version_no',
        [[b.versionId, versionId]]);
      expect(versions.map((v) => v.status)).toEqual(['superseded', 'confirmed']);
      expect(versions[1]!.acceptance_from_version_id).toBe(b.versionId);
      const [rv] = await owner<Record<string, unknown>>(
        'select status, approval_source, change_request_id, reviewed_by from public.accounts_booking_reviews where booking_version_id = $1', [versionId]);
      expect(rv).toMatchObject({ status: 'approved', approval_source: 'change_request', change_request_id: cr.changeRequestId, reviewed_by: null });
      const committed = await owner<{ confirmation_no: number; amount_paise: string; change_fee_paise: string | null }>(
        `select confirmation_no, amount_paise::text, change_fee_paise::text from public.purchase_cost_versions
         where task_id = $1 and stage = 'committed' order by confirmation_no`, [hotelTask]);
      expect(committed).toEqual([
        { confirmation_no: 1, amount_paise: expect.any(String), change_fee_paise: null },
        { confirmation_no: 2, amount_paise: '12500000', change_fee_paise: '500000' },
      ]);
      const confs = await owner<{ confirmation_no: number; supplier_reference: string; change_request_id: string | null }>(
        'select confirmation_no, supplier_reference, change_request_id from public.task_confirmations where task_id = $1 order by confirmation_no',
        [hotelTask]);
      expect(confs).toEqual([
        { confirmation_no: 1, supplier_reference: 'SYN-CONF-0001', change_request_id: null },
        { confirmation_no: 2, supplier_reference: 'SYN-CONF-0002', change_request_id: cr.changeRequestId },
      ]);
      expect(await h.taskRow(hotelTask)).toMatchObject({ status: 'supplier_confirmed', supplier_reference: 'SYN-CONF-0002' });
      expect(await scalar<boolean>(SQLB.goAheadValid, [hotelTask])).toBe(true);
      const dues = await one<{ totalPaise: string }>(ACC, SQLB.dealDues, [DEAL]);
      expect(dues.totalPaise).toBe(NEW_SELLING);
      const [basis] = await owner<{ basis_version_id: string }>('select basis_version_id from public.purchase_task_basis where task_id = $1', [hotelTask]);
      expect(basis!.basis_version_id).toBe(versionId);
      const [applied] = await h.audits('booking.change_applied');
      expect(applied!.details).toMatchObject({ changeRequestId: cr.changeRequestId, versionId, baseVersionId: b.versionId });
      expect(text(await h.audits('purchase.reconfirm_recorded'))).not.toContain('12000000');
      expect(await scalar<boolean>(SQLB.changeOpen, [DEAL])).toBe(false);
    });
  });

  it('a submitted change version cannot be edited; booking_open_revision answers use_change_flow', async () => {
    await asOwner(db, async () => {
      const { b, hotelItem } = await h.committedDeal();
      const { versionId } = await h.submittedChange(hotelItem);
      const [v] = await owner<{ row_version: number }>('select row_version from public.booking_versions where id = $1', [versionId]);
      const r = await h.attempt(OWNER, SQLB.itemSave, [hotelItem, versionId, v!.row_version, JSON.stringify({ ...HOTEL, roomType: 'Synthetic Other' }),
        '20000000']);
      expect(r).toMatchObject({ ok: false });
      await h.refusedToken(OWNER, SQLB.openRevision, [b.versionId], 'use_change_flow', undefined, '55000');
    });
  });

  it('over budget waits for the Approver (not the recorder); the approval is bound to the new version', async () => {
    await asOwner(db, async () => {
      const { hotelItem, hotelTask } = await h.committedDeal();
      const { cr, versionId } = await h.submittedChange(hotelItem);
      const [x] = await h.reconfirmations(cr.changeRequestId);
      await record(x!.id, hotelTask, '19800000', '500000');
      const rec = (await h.reconfirmations(cr.changeRequestId))[0]!;
      expect(rec).toMatchObject({ status: 'recorded', over_budget: true });
      expect((await h.crRow(cr.changeRequestId)).status).toBe('approved');
      await h.refused(PURCHASE, SQLB.reconfirmApprove, [x!.id, rec.row_version, rid()], 'not_authorized', '42501');
      await one(MANAGER, SQLB.reconfirmApprove, [x!.id, rec.row_version, rid()]);
      expect((await h.crRow(cr.changeRequestId)).status).toBe('applied');
      const rows = await owner<{ booking_version_id: string; reconfirmation_id: string; version_no: number }>(
        'select booking_version_id, reconfirmation_id, version_no from public.purchase_cost_approvals where task_id = $1 and reconfirmation_id is not null',
        [hotelTask]);
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({ booking_version_id: versionId, reconfirmation_id: x!.id });
      expect(await scalar<boolean>(SQLB.costApproved, [hotelTask, rows[0]!.version_no])).toBe(true);
    });
  });

  it('two suppliers: one refusal voids the other recorded row; nothing else changes', async () => {
    await asOwner(db, async () => {
      const { b, hotelItem, hotelTask } = await h.committedDeal([{ ...HOTEL_ITEM, facts: { ...HOTEL, hotelName: 'Synthetic Second Hotel' } }]);
      const second = b.itemIds[1]!;
      const secondTask = h.taskOf(b, 'hotel', 1);
      await h.supplierConfirmed(secondTask);
      const { cr, versionId } = await h.submittedChange(hotelItem, {
        itemIds: [hotelItem, second],
        edit: async (v, rv) => h.editHotel(second, v, await h.editHotel(hotelItem, v, rv), { hotelName: 'Synthetic Second Hotel', roomType: 'Synthetic Suite' }),
      });
      const rows = await h.reconfirmations(cr.changeRequestId);
      const first = rows.find((r) => r.task_id === hotelTask)!;
      const other = rows.find((r) => r.task_id === secondTask)!;
      await record(first.id, hotelTask, '19900000', '500000');
      await one(PURCHASE, SQLB.reconfirmRefuse, [other.id, await h.reconfRv(other.id), REASON, rid()]);
      const after = await h.reconfirmations(cr.changeRequestId);
      expect(after.find((r) => r.id === first.id)!.status).toBe('void');
      expect(after.find((r) => r.id === other.id)!.status).toBe('refused');
      expect((await h.crRow(cr.changeRequestId)).status).toBe('not_possible');
      const [v] = await owner<{ status: string }>('select status from public.booking_versions where id = $1', [versionId]);
      expect(v!.status).toBe('discarded');
      const [t] = await owner<{ n: number }>('select count(*)::int as n from public.task_confirmations where task_id = $1', [hotelTask]);
      expect(t!.n).toBe(1);
    });
  });

  it('paid more than the new cost: a reconfirmation supplier refund is expected', async () => {
    await asOwner(db, async () => {
      const { hotelItem, hotelTask } = await h.committedDeal();
      const agreed = (await owner<{ v: number }>(`select max(version_no)::int as v from public.purchase_cost_versions where task_id = $1 and stage = 'proposed'`,
        [hotelTask]))[0]!.v;
      await h.receipt(DEAL, '5000000');
      const paid = await h.purchaseRequest(hotelTask, 4_000_000, { expectedCostVersionNo: agreed });
      await h.payThrough(paid.id, 'verified');
      const { cr } = await h.submittedChange(hotelItem);
      const [x] = await h.reconfirmations(cr.changeRequestId);
      await record(x!.id, hotelTask, '3000000');
      expect((await h.crRow(cr.changeRequestId)).status).toBe('applied');
      const due = await one<{ items: Array<Record<string, unknown>> }>(ACC, SQLB.refundsDue, ['{}', null, 50]);
      const row = due.items.find((i) => i.changeRequestId === cr.changeRequestId)!;
      expect(row).toMatchObject({ sourceKind: 'reconfirmation', sourceId: x!.id, expectedPaise: '1000000', cancellationId: null });
      // Accounts records the money back with a proof whose subject is the change request (0680).
      const begun = await one<{ evidenceId: string; objectPath: string }>(ACC, 'select public.refund_evidence_begin($1, $2, $3, $4, $5, $6, $7) as r',
        ['supplier_refund', cr.changeRequestId, 'proof.pdf', 'application/pdf', 2048, sha(), rid()]);
      await owner(`insert into storage.objects (bucket_id, name, metadata) values ('finance-evidence', $1, jsonb_build_object('size', 2048))`,
        [begun.objectPath]);
      await one(ACC, 'select public.refund_evidence_finish($1, $2) as r', [begun.evidenceId, true]);
      const attempt = await h.attempt(ACC, 'select public.supplier_refund_record($1::jsonb, $2) as r', [JSON.stringify({
        sourceKind: 'reconfirmation', sourceId: x!.id, amountPaise: '1000000', receivedOn: today(), mode: 'bank_transfer',
        reference: 'SYNREF-0001', evidenceId: begun.evidenceId }), rid()]);
      expect(attempt.ok ? 'ok' : `${attempt.error}:${attempt.hint ?? ''}`).toBe('ok');
      const [r] = await owner<{ cancellation_id: string | null; change_request_id: string }>(
        `select cancellation_id, change_request_id from public.supplier_refund_receipts where source_kind = 'reconfirmation'`);
      expect(r).toEqual({ cancellation_id: null, change_request_id: cr.changeRequestId });
    });
  });

  it('withdraw after a recorded reconfirmation voids it and discards the version', async () => {
    await asOwner(db, async () => {
      const { hotelItem, hotelTask } = await h.committedDeal();
      const { cr, versionId } = await h.submittedChange(hotelItem);
      const [x] = await h.reconfirmations(cr.changeRequestId);
      await record(x!.id, hotelTask, '19900000', '500000');
      await one(OWNER, SQLB.crWithdraw, [cr.changeRequestId, (await h.crRow(cr.changeRequestId)).row_version, REASON, rid()]);
      expect((await h.crRow(cr.changeRequestId)).status).toBe('withdrawn');
      expect((await h.reconfirmations(cr.changeRequestId))[0]!.status).toBe('void');
      const [v] = await owner<{ status: string }>('select status from public.booking_versions where id = $1', [versionId]);
      expect(v!.status).toBe('discarded');
    });
  });
});

describe('track G proof (Addendum L5)', () => {
  it('a proof needs an open reconfirmation and is linked to it; another row cannot use it', async () => {
    await asOwner(db, async () => {
      const { hotelItem, hotelTask } = await h.committedDeal();
      // No open reconfirmation: refused as before.
      const r = await h.attempt(PURCHASE, 'select public.purchase_evidence_begin($1, $2, $3, $4, $5, $6) as r',
        [hotelTask, 'supplier_confirmation', 'x.pdf', 'application/pdf', 2048, '0'.repeat(64)]);
      expect(r).toMatchObject({ ok: false, error: 'already_confirmed' });
      const { cr } = await h.submittedChange(hotelItem);
      const [x] = await h.reconfirmations(cr.changeRequestId);
      expect((await one<{ can: { uploadProof: boolean } }>(PURCHASE, SQLB.reconfirmGet, [hotelTask])).can.uploadProof).toBe(true);
      const ev = await proof(hotelTask);
      const ws = await one<{ evidence: Array<{ id: string; reconfirmationId: string | null }> }>(PURCHASE,
        'select public.purchase_workspace($1) as r', [hotelTask]);
      expect(ws.evidence.find((e) => e.id === ev)!.reconfirmationId).toBe(x!.id);
      expect(ws.evidence.filter((e) => e.id !== ev).every((e) => e.reconfirmationId === null)).toBe(true);
      const [row] = await owner<{ reconfirmation_id: string; status: string }>('select reconfirmation_id, status from public.purchase_evidence where id = $1', [ev]);
      expect(row).toMatchObject({ reconfirmation_id: x!.id, status: 'stored' });
    });
  });
});

describe('track G hooks', () => {
  it('apply runs the bill hook (track B) and queues booking_changed once per channel (track A)', async () => {
    await asOwner(db, async () => {
      const { hotelItem, hotelTask } = await h.committedDeal([TRANSFER_ITEM], { changes: false });
      await h.docsOn();
      await h.autoBills(true, true);
      await h.messagesOn(['booking_changed']);
      await h.changesOn();
      const { cr } = await h.submittedChange(hotelItem);
      const [x] = await h.reconfirmations(cr.changeRequestId);
      await record(x!.id, hotelTask, '12000000');
      expect((await h.crRow(cr.changeRequestId)).status).toBe('applied');
      const msgs = (await h.messages(DEAL, 'booking_changed')).filter((m) => m.event_key === `cr:${cr.changeRequestId}`);
      expect(msgs.map((m) => m.channel).sort()).toEqual(['email', 'whatsapp']);
      expect(await h.pending()).toEqual([]);
    });
  });
});

describe('track G reads', () => {
  it('fences and money keys', async () => {
    await asOwner(db, async () => {
      const { hotelItem, hotelTask } = await h.committedDeal();
      const { cr } = await h.submittedChange(hotelItem);
      const [x] = await h.reconfirmations(cr.changeRequestId);
      const so = await one<Record<string, unknown>>(OWNER, SQLB.dealChanges, [DEAL]);
      expect(so).toMatchObject({ dealId: DEAL, enabled: true, canRequest: false });
      expect(text(so)).not.toContain('SYN-CONF-0001');
      expect(text(await one(MANAGER, SQLB.dealChanges, [DEAL]))).toContain('SYN-CONF-0001');
      await h.addFlightPeople();
      for (const actor of [PURCHASE, FLIGHT, VISA, SALES_B, OTHER_ENTITY]) {
        expect(await h.readOrNull(actor, SQLB.dealChanges, [DEAL]), `fenced ${actor.userId}`).toBeNull();
      }
      const p = await one<Record<string, unknown>>(PURCHASE, SQLB.reconfirmGet, [hotelTask]);
      expect(p).toMatchObject({ taskId: hotelTask, can: { record: true, refuse: true } });
      expect(text(p)).not.toContain(NEW_SELLING);
      expect(text(p)).not.toContain(SELLING);
      expect(await h.readOrNull(OWNER, SQLB.reconfirmGet, [hotelTask])).toBeNull();
      const list = await one<{ items: Array<{ id: string }> }>(OWNER, SQLB.changesList, ['{}', null, 50]);
      expect(list.items.map((i) => i.id)).toContain(cr.changeRequestId);
      expect(await h.readOrNull(PURCHASE, SQLB.changesList, ['{}', null, 50])).toBeNull();
      await record(x!.id, hotelTask, '12000000', '500000');
      const m = await one<{ confirmations: Array<Record<string, unknown>> }>(MANAGER, SQLB.changeHistory, [DEAL]);
      expect(m.confirmations.map((c) => c.confirmationNo)).toEqual([1, 2]);
      expect(m.confirmations[1]).toMatchObject({ amountPaise: '12500000', changeFeePaise: '500000' });
      expect(text(await one(OWNER, SQLB.changeHistory, [DEAL]))).not.toMatch(/"(amountPaise|changeFeePaise)"/);
      expect(text(await one(PURCHASE, SQLB.changeHistory, [DEAL]))).not.toContain(NEW_SELLING);
      expect(await h.readOrNull(VISA, SQLB.changeHistory, [DEAL])).toBeNull();
    });
  });
});
