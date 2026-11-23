import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { FLIGHT, FLIGHT_ITEM, PURCHASE, VISA_DESK, VISA_ITEM } from './acc-support';
import { line as visaLine, visaHelpers } from './visa-e-support';
import { ACC, ACC_J2, CSQL, DEAL, FLIGHT_J, MANAGER, MANAGER_F, OWNER, REASON, acc2cHelpers, rid, today } from './acc2c-support';
import { CONFLICT_STATE } from '../helpers/sqlstates';

/**
 * Accounts phase 2 contract 7.3 C7-C11 (Addendum L1), 7.4, LD11-LD14, owner
 * Q11, Track C: Flight charges per ticket batch, Visa block and choices,
 * supplier refunds received in one step, cancellation reads for the Manager.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const c = acc2cHelpers(() => db);
const { one, owner } = c;

type Opened = { cancellationId: string; rowVersion: number; status: string };
const cancelRow = async (id: string) =>
  (await owner<{ status: string; row_version: number }>('select status, row_version from public.deal_cancellations where id = $1', [id]))[0]!;
const latestFlightCharge = async (batchId: string) =>
  (await owner<{ id: string; revision_no: number }>(
    'select id, revision_no from public.flight_cancellation_charges where batch_id = $1 order by revision_no desc limit 1', [batchId]))[0]!;

async function flightDeal() {
  await c.people();
  const b = await c.book([FLIGHT_ITEM]);
  await c.approve(b.versionId);
  const batch = await c.flightBatch(DEAL, [1]);
  await c.refundsOn();
  return { b, batch };
}

describe('Flight charges (C9, 7.4, LD13)', () => {
  it('batches count as missing; owner enters; Flight sends; a Flight enterer cannot decide; Manager approves; tickets read cancelled', async () => {
    await asOwner(db, async () => {
      const { batch } = await flightDeal();
      const opened = await one<Opened>(MANAGER, CSQL.cancelOpen, [DEAL, REASON, rid()]);
      expect((await owner<{ n: number }>('select authz.cancellation_charges_missing($1) as n', [opened.cancellationId]))[0]!.n).toBe(1);
      // Something to charge: no approval straight from open (LD14 does not apply).
      await c.refused(MANAGER, CSQL.cancelDecide, [opened.cancellationId, 'approve', null, opened.rowVersion, rid()], 'not_ready', '55000');
      // Another Flight person while the cost task has an owner: refused.
      await c.refused(FLIGHT_J, CSQL.flightCharge, [batch.batchId, JSON.stringify({ airlineChargePaise: '1', refundExpectedPaise: '1' }), 0, rid()],
        'not_authorized', '42501');
      await c.refusedHint(FLIGHT, CSQL.flightCharge, [batch.batchId, JSON.stringify({ airlineChargePaise: 'x', refundExpectedPaise: '1' }), 0, rid()],
        'invalid_input', /airlineChargePaise/);
      await c.refused(FLIGHT, CSQL.flightCharge, [batch.batchId, JSON.stringify({ airlineChargePaise: '100000', refundExpectedPaise: '500000' }), 1, rid()],
        'version_changed', CONFLICT_STATE);
      const set = await one<{ revisionNo: number; status: string }>(FLIGHT, CSQL.flightCharge, [batch.batchId,
        JSON.stringify({ airlineChargePaise: '100000', refundExpectedPaise: '500000', note: 'Synthetic airline rule' }), 0, rid()]);
      expect(set).toMatchObject({ revisionNo: 1, status: 'charges_entered' });
      expect((await owner<{ n: number }>('select authz.cancellation_charges_missing($1) as n', [opened.cancellationId]))[0]!.n).toBe(0);
      // Flight may send the case (7.4).
      const sent = await one<Opened>(FLIGHT, CSQL.cancelSend, [opened.cancellationId, (await cancelRow(opened.cancellationId)).row_version, rid()]);
      expect(sent.status).toBe('sent_to_manager');
      // A Manager who entered a Flight revision never decides (synthetic fixture step: revision by the Manager holding Flight).
      await owner(`insert into public.flight_cancellation_charges (cancellation_id, legal_entity_id, deal_id, batch_id, cost_task_id, supplier_id,
          revision_no, supplier_cost_paise, airline_charge_paise, refund_expected_paise, entered_by, request_id)
        select cancellation_id, legal_entity_id, deal_id, batch_id, cost_task_id, supplier_id, 2, supplier_cost_paise, airline_charge_paise,
          refund_expected_paise, $2, gen_random_uuid() from public.flight_cancellation_charges where batch_id = $1 and revision_no = 1`,
        [batch.batchId, U.managerDelhi]);
      await c.refused(MANAGER, CSQL.cancelDecide, [opened.cancellationId, 'approve', null, sent.rowVersion, rid()], 'not_self_approval', '42501');
      await owner('set local session_replication_role = replica');
      await owner('delete from public.flight_cancellation_charges where batch_id = $1 and revision_no = 2', [batch.batchId]);
      await owner('set local session_replication_role = origin');
      // The Manager reads the Flight charges and the combined kept figure.
      const list = await one<Array<Record<string, unknown> & { flightCharges: Array<Record<string, unknown>> }>>(MANAGER, CSQL.managerList, []);
      expect(list[0]).toMatchObject({ chargesKeptPaise: '100000', canDecide: true });
      expect(list[0]!.flightCharges).toEqual([expect.objectContaining({ batchId: batch.batchId, airlineChargePaise: '100000',
        refundExpectedPaise: '500000', revisionNo: 1, note: 'Synthetic airline rule' })]);
      const summaryM = await one<{ cancellation: Record<string, unknown> }>(MANAGER, CSQL.cancelSummary, [DEAL]);
      expect(summaryM.cancellation).toMatchObject({ chargesKeptPaise: '100000' });
      const summaryS = await one<{ cancellation: Record<string, unknown> }>(OWNER, CSQL.cancelSummary, [DEAL]);
      expect(summaryS.cancellation).not.toHaveProperty('flightCharges');
      expect(summaryS.cancellation).not.toHaveProperty('chargesKeptPaise');
      const approved = await one<Opened>(MANAGER, CSQL.cancelDecide, [opened.cancellationId, 'approve', null, sent.rowVersion, rid()]);
      expect(approved.status).toBe('approved');
      // LD13: after approval only the reported refund may change.
      await c.refused(FLIGHT, CSQL.flightCharge, [batch.batchId, JSON.stringify({ airlineChargePaise: '200000', refundExpectedPaise: '500000' }), 1, rid()],
        'already_decided', '55000');
      const rep = await one<{ revisionNo: number; status: string }>(FLIGHT, CSQL.flightCharge, [batch.batchId,
        JSON.stringify({ airlineChargePaise: '100000', refundExpectedPaise: '500000', refundReportedPaise: '450000' }), 1, rid()]);
      expect(rep).toMatchObject({ revisionNo: 2, status: 'approved' });
      const money = await one<{ batches: Array<Record<string, unknown>> }>(FLIGHT, 'select public.flight_money($1) as r', [DEAL]);
      expect(money.batches[0]).toMatchObject({ ticketsCancelled: true, cancellation: { state: 'approved', revisionNo: 2,
        airlineChargePaise: '100000', refundExpectedPaise: '500000', refundReportedPaise: '450000', supplierRefundReceivedPaise: '0', note: null } });
      expect(await c.audit('flight.cancellation_charge_set')).toHaveLength(2);
    });
  });

  it('supplier refund: one Accounts person records it verified at once; over expected needs a reason; cancel = rejected; never in dues', async () => {
    await asOwner(db, async () => {
      const { batch } = await flightDeal();
      await c.receipt(DEAL, '3000000');
      const opened = await one<Opened>(MANAGER, CSQL.cancelOpen, [DEAL, REASON, rid()]);
      await one(FLIGHT, CSQL.flightCharge, [batch.batchId, JSON.stringify({ airlineChargePaise: '100000', refundExpectedPaise: '500000' }), 0, rid()]);
      const sent = await one<Opened>(FLIGHT, CSQL.cancelSend, [opened.cancellationId, (await cancelRow(opened.cancellationId)).row_version, rid()]);
      const charge = await latestFlightCharge(batch.batchId);
      // Not approved yet: not_ready.
      await c.refused(ACC, CSQL.evBegin, ['supplier_refund', opened.cancellationId, 'p.pdf', 'application/pdf', 10, 'c'.repeat(64), rid()],
        'not_ready', '55000');
      await one(MANAGER, CSQL.cancelDecide, [opened.cancellationId, 'approve', null, sent.rowVersion, rid()]);
      const duesBefore = await one<Record<string, unknown>>(ACC, CSQL.dealDues, [DEAL]);
      const ev = await c.proof('supplier_refund', opened.cancellationId);
      const fields = { sourceKind: 'flight_charge', sourceId: charge.id, amountPaise: '300000', receivedOn: today(), mode: 'bank_transfer',
        reference: 'SYNSR0001', evidenceId: ev };
      for (const actor of [PURCHASE, FLIGHT, OWNER, MANAGER]) {
        await c.refused(actor, CSQL.srRecord, [JSON.stringify(fields), rid()], 'not_authorized', '42501');
      }
      await c.refusedHint(ACC, CSQL.srRecord, [JSON.stringify({ ...fields, evidenceId: undefined }), rid()], 'evidence_missing', undefined, '55000');
      const first = await one<{ supplierRefundId: string; status: string; rowVersion: number }>(ACC, CSQL.srRecord, [JSON.stringify(fields), rid()]);
      expect(first.status).toBe('verified');
      const [r1] = await owner<{ recorded_by: string; verified_by: string }>('select recorded_by, verified_by from public.supplier_refund_receipts where id = $1',
        [first.supplierRefundId]);
      expect(r1).toEqual({ recorded_by: U.accountsJodhpur, verified_by: U.accountsJodhpur });
      const ev2 = await c.proof('supplier_refund', opened.cancellationId);
      await c.refusedHint(ACC, CSQL.srRecord, [JSON.stringify({ ...fields, evidenceId: ev2, reference: 'SYNSR0002' }), rid()],
        'over_expected', /overExpectedReason/, '22023');
      const second = await one<{ status: string }>(ACC, CSQL.srRecord, [JSON.stringify({ ...fields, evidenceId: ev2, reference: 'SYNSR0002',
        overExpectedReason: 'Synthetic: airline returned the fuel charge too' }), rid()]);
      expect(second.status).toBe('verified');
      const money = await one<{ batches: Array<{ cancellation: Record<string, unknown> }> }>(FLIGHT, 'select public.flight_money($1) as r', [DEAL]);
      expect(money.batches[0]!.cancellation.supplierRefundReceivedPaise).toBe('600000');
      const payables = await one<Record<string, unknown>>(ACC, CSQL.payables, [DEAL]);
      expect(payables).toMatchObject({ supplierRefundsExpectedPaise: '500000', supplierRefundsReceivedPaise: '600000' });
      const due = await one<{ items: unknown[] }>(ACC, CSQL.due, [JSON.stringify({ state: 'all' }), null, 50]);
      expect(due.items).toEqual([expect.objectContaining({ sourceKind: 'flight_charge', expectedPaise: '500000', receivedPaise: '600000' })]);
      expect(await one(MANAGER, CSQL.due, ['{}', null, 50])).toBeNull();
      // Any Accounts person cancels it (also not the recorder) with a reason.
      const cancelled = await one<{ status: string }>(ACC_J2, CSQL.srCancel, [first.supplierRefundId, 1, REASON, rid()]);
      expect(cancelled.status).toBe('rejected');
      expect(await c.audit('accounts.supplier_refund.verified')).toHaveLength(2);
      expect(await c.audit('accounts.supplier_refund.rejected')).toHaveLength(1);
      const duesAfter = await one<Record<string, unknown>>(ACC, CSQL.dealDues, [DEAL]);
      expect(duesAfter.verifiedPaise).toBe(duesBefore.verifiedPaise);
      expect(duesAfter.totalPaise).toBe(duesBefore.totalPaise);
      const deal = await one<{ supplierRefunds: unknown[]; chargesKeptPaise: string }>(OWNER, CSQL.dealRefunds, [DEAL]);
      expect(deal.chargesKeptPaise).toBe('100000');
      expect(deal).not.toHaveProperty('supplierRefunds');
    });
  });
});

describe('LD14 nothing to charge', () => {
  it('an open case with nothing to charge lists canDecide true for the Manager and is approved straight from open', async () => {
    await asOwner(db, async () => {
      await c.people();
      const b = await c.book([{ ...VISA_ITEM, participants: [1] }]);
      await c.approve(b.versionId);
      const opened = await one<Opened>(MANAGER, CSQL.cancelOpen, [DEAL, REASON, rid()]);
      const list = await one<Array<Record<string, unknown>>>(MANAGER, CSQL.managerList, []);
      expect(list.find((r) => r.cancellationId === opened.cancellationId)).toMatchObject({ status: 'open', canDecide: true,
        flightCharges: [], chargesKeptPaise: '0' });
      const ok = await one<Opened>(MANAGER, CSQL.cancelDecide, [opened.cancellationId, 'approve', null, opened.rowVersion, rid()]);
      expect(ok.status).toBe('approved');
      // Return is not offered from open (nothing was sent).
      expect((await one<Array<Record<string, unknown>>>(MANAGER, CSQL.managerList, []))
        .find((r) => r.cancellationId === opened.cancellationId)).toMatchObject({ status: 'approved', canDecide: false });
    });
  });
});

describe('Visa (C10, C11, LD12) and LD14', () => {
  async function visaDeal() {
    await c.people();
    await c.addRole(U.salesAhmedabad, 'visa');
    const b = await c.book([{ ...VISA_ITEM, participants: [1] }]);
    await c.approve(b.versionId);
    const vh = visaHelpers(() => db);
    const visaTask = c.taskOf(b, 'visa');
    await one(VISA_DESK, 'select public.visa_task_claim($1) as r', [visaTask]);
    const a = await vh.makeReady(visaTask, 1, { actor: VISA_DESK });
    await vh.apply(visaTask, [visaLine(a)], {}, rid(), VISA_DESK);
    const [app] = await owner<{ id: string; row_version: number; state: string }>(
      'select id, row_version, state from public.visa_applications where task_id = $1 and superseded_at is null', [visaTask]);
    const [fee] = await owner<{ id: string; amount_paise: string }>(
      `select id, amount_paise::text from public.department_cost_entries where task_id = $1 and paid_by = 'company' order by created_at limit 1`, [visaTask]);
    return { b, visaTask, app: app!, fee: fee! };
  }

  it('Visa-only case approved straight from open; then spending stops and each submitted application gets a choice', async () => {
    await asOwner(db, async () => {
      const { visaTask, app, fee } = await visaDeal();
      const opened = await one<Opened>(MANAGER, CSQL.cancelOpen, [DEAL, REASON, rid()]);
      type Ws = { cancellation: Record<string, unknown> & { fees?: unknown[] }; applicants: Array<Record<string, unknown>> };
      let ws = await one<Ws>(VISA_DESK, 'select public.visa_workspace($1) as r', [visaTask]);
      expect(ws.cancellation).toMatchObject({ status: 'open', approved: false });
      // Choice before approval: not_ready.
      await c.refused(VISA_DESK, CSQL.visaChoice, [app.id, app.row_version, 'withdraw', REASON, rid()], 'not_ready', '55000');
      const approved = await one<Opened>(MANAGER, CSQL.cancelDecide, [opened.cancellationId, 'approve', null, opened.rowVersion, rid()]);
      expect(approved.status).toBe('approved');
      // LD12 block.
      await c.refused(VISA_DESK, 'select public.department_cost_save($1, null, null, $2::jsonb, $3) as r', [visaTask, JSON.stringify({
        applicationId: app.id, costKind: 'other', amountPaise: '1000', paidBy: 'company', paymentMode: 'cash', paidOn: today() }), rid()],
        'trip_cancelled', '55000');
      ws = await one<Ws>(VISA_DESK,
        'select public.visa_workspace($1) as r', [visaTask]);
      expect(ws.cancellation).toMatchObject({ approved: true });
      expect(ws.applicants[0]).toMatchObject({ cancellationChoice: null, canChooseCancellation: true });
      // Fee refund expected (C11).
      if (fee) {
        await c.refusedHint(VISA_DESK, CSQL.visaFee, [fee.id, String(BigInt(fee.amount_paise) + 1n), null, 0, rid()], 'invalid_input', /refundExpectedPaise/);
        const set = await one<{ revisionNo: number }>(VISA_DESK, CSQL.visaFee, [fee.id, '1000', 'Synthetic: embassy refunds part', 0, rid()]);
        expect(set.revisionNo).toBe(1);
        await c.refused(VISA_DESK, CSQL.visaFee, [fee.id, '1000', null, 0, rid()], 'version_changed', CONFLICT_STATE);
      }
      const [cur] = await owner<{ row_version: number }>('select row_version from public.visa_applications where id = $1', [app.id]);
      await c.refusedHint(VISA_DESK, CSQL.visaChoice, [app.id, cur!.row_version, 'withdraw', 'short', rid()], 'invalid_input', /reason/);
      const chosen = await one<{ state: string; closed: boolean; cancellationChoice: string }>(VISA_DESK, CSQL.visaChoice,
        [app.id, cur!.row_version, 'withdraw', REASON, rid()]);
      expect(chosen).toMatchObject({ state: 'withdrawn', closed: true, cancellationChoice: 'withdraw' });
      const after = await one<Ws>(VISA_DESK, 'select public.visa_workspace($1) as r', [visaTask]);
      expect(after.applicants[0]).toMatchObject({ cancellationChoice: 'withdraw', cancellationChoiceReason: REASON, canChooseCancellation: false });
      expect(await c.audit('visa.cancellation_choice')).toHaveLength(1);
      // Purchase never reads the Visa workspace money and the refund reads.
      expect(await one(PURCHASE, CSQL.dealRefunds, [DEAL])).toBeNull();
      expect(await one(FLIGHT, CSQL.dealRefunds, [DEAL])).toBeNull();
      expect(await one(VISA_DESK, CSQL.dealRefunds, [DEAL])).toBeNull();
      expect(MANAGER_F).toBeTruthy();
    });
  });
});
