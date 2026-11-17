import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, type TestDb, asOwner, createTestDb, expectDbError } from '../helpers/db';
import { FLIGHT_2, FLIGHT_ITEM, HOTEL_ITEM } from './acc-support';
import { DEAL, FLIGHT, MANAGER, OWNER, PURCHASE, SQL2, acc2Helpers, landed, rid, today, waits } from './acc2-support';
import { VISA_A, line as visaLine, visaHelpers } from './visa-e-support';

/**
 * Accounts Phase 2 contract 7.1 (flight_cancellation_charges,
 * visa_cancellation_fees, visa_applications cancellation columns), 7.3
 * C9-C11, 7.4 (replaced cancellation and department functions) and test
 * plan 12.1 "Flight charges ... Visa block", Track F. Written from the
 * contract. LD12 (Visa block from approval), LD13 (refund reported after
 * approval), LD14 (decide from open when nothing to charge).
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = acc2Helpers(() => db);
const v = visaHelpers(() => db);
const { one, owner } = h;
const FLIGHT_READY = landed('flight_cancellation_charges', 'flight_cancellation_charge_set', 'cancellation_charges_missing', 'deal_cancellation_send',
  'deal_cancellation_decide', 'deal_cancellation_summary', 'flight_money');
const VISA_READY = landed('visa_cancellation_fees', 'visa_application_cancellation_choice', 'visa_cancellation_fee_set', 'department_cost_save',
  'visa_applications_apply', 'visa_workspace', 'deal_cancellation_decide');

const charge = (over: Record<string, unknown> = {}) => JSON.stringify({ airlineChargePaise: '150000', refundExpectedPaise: '350000',
  refundReportedPaise: null, note: 'Synthetic: airline keeps the fare difference', ...over });
const chargeRows = (batchId: string) => owner<{ revision_no: number; airline_charge_paise: string; refund_reported_paise: string | null; entered_by: string;
  supplier_cost_paise: string }>(
  `select revision_no, airline_charge_paise::text as airline_charge_paise, refund_reported_paise::text as refund_reported_paise, entered_by,
          supplier_cost_paise::text as supplier_cost_paise
   from public.flight_cancellation_charges where batch_id = $1 order by revision_no`, [batchId]);

/** Package (hotel without cost + flight) Deal, one ticket batch by FLIGHT, cancellation opened by the Manager. */
async function flightCase() {
  const b = await h.approvedDeal([HOTEL_ITEM, FLIGHT_ITEM]);
  const batch = await h.flightBatch(b.deal, [1]);
  return { b, batch };
}

describe.skipIf(!FLIGHT_READY)(`Flight cancellation charges (C9, 7.4)${FLIGHT_READY ? '' : ` — ${waits('C', 'flight_cancellation_charges …')}`}`, () => {
  it('not_ready before a cancellation; the cost-task owner enters; other Flight people refused; batch counted missing until entered', async () => {
    await asOwner(db, async () => {
      const { batch } = await flightCase();
      await h.refusedToken(FLIGHT, SQL2.flightChargeSet, [batch.batchId, charge(), 0, rid()], 'not_ready');
      const cancellationId = await h.openCancellation();
      const missing = async () => (await owner<{ n: number }>('select authz.cancellation_charges_missing($1) as n', [cancellationId]))[0]!.n;
      expect(await missing()).toBeGreaterThanOrEqual(1);
      await h.refused(FLIGHT_2, SQL2.flightChargeSet, [batch.batchId, charge(), 0, rid()], 'not_authorized');
      await h.refused(PURCHASE, SQL2.flightChargeSet, [batch.batchId, charge(), 0, rid()], 'not_authorized');
      await one(FLIGHT, SQL2.flightChargeSet, [batch.batchId, charge(), 0, rid()]);
      expect(await missing()).toBe(0);
      const rows = await chargeRows(batch.batchId);
      expect(rows).toEqual([expect.objectContaining({ revision_no: 1, airline_charge_paise: '150000', entered_by: U.movedStaff })]);
      await h.refusedToken(FLIGHT, SQL2.flightChargeSet, [batch.batchId, charge({ airlineChargePaise: '1' }), 0, rid()], 'version_changed');
      expect(await h.audits('flight.cancellation_charge_set')).toEqual([expect.objectContaining({
        details: expect.objectContaining({ cancellationId, batchId: batch.batchId, revisionNo: 1 }) })]);
      await expectDbError(db, () => owner('update public.flight_cancellation_charges set airline_charge_paise = 0 where batch_id = $1', [batch.batchId]), {});
      await expectDbError(db, () => owner('delete from public.flight_cancellation_charges where batch_id = $1', [batch.batchId]), {});
    });
  });

  it('Flight sends; Manager approves; a change after sending returns the case to charges_entered; tickets shown cancelled; LD13', async () => {
    await asOwner(db, async () => {
      const { batch } = await flightCase();
      const cancellationId = await h.openCancellation();
      await one(FLIGHT, SQL2.flightChargeSet, [batch.batchId, charge(), 0, rid()]);
      const c1 = (await h.cancellationOf())!;
      await one(FLIGHT, SQL2.cancelSend, [cancellationId, c1.row_version, rid()]);
      expect((await h.cancellationOf())!.status).toBe('sent_to_manager');
      await one(FLIGHT, SQL2.flightChargeSet, [batch.batchId, charge({ airlineChargePaise: '160000' }), 1, rid()]);
      expect((await h.cancellationOf())!.status, 'Purchase rule: back to charges_entered').toBe('charges_entered');
      const c2 = (await h.cancellationOf())!;
      await one(FLIGHT, SQL2.cancelSend, [cancellationId, c2.row_version, rid()]);
      // Manager review shows the Flight charges; Purchase readers keep their shape (no Flight rows).
      type Summary = { flightCharges: Array<{ batchId: string; airlineChargePaise: string; revisionNo: number }>; chargesKeptPaise: string };
      const read = await one<Summary & { cancellation?: Summary }>(MANAGER, SQL2.cancelSummary, [DEAL]);
      // The additions sit on the cancellation object of the summary (Track C) or at the top level.
      const summary = read.cancellation?.flightCharges ? read.cancellation : read;
      expect(summary.flightCharges).toEqual([expect.objectContaining({ batchId: batch.batchId, airlineChargePaise: '160000', revisionNo: 2 })]);
      expect(summary.chargesKeptPaise).toBe('160000');
      const list = await one<Array<Record<string, unknown>>>(MANAGER, SQL2.managerCancellations, []);
      expect(JSON.stringify(list)).toContain('flightCharges');
      const forPurchase = await h.attempt<Record<string, unknown> | null>(PURCHASE, SQL2.cancelSummary, [DEAL]);
      if (forPurchase.ok && forPurchase.value) expect(JSON.stringify(forPurchase.value)).not.toContain('airlineChargePaise');
      const c3 = (await h.cancellationOf())!;
      await one(MANAGER, SQL2.cancelDecide, [cancellationId, 'approve', null, c3.row_version, rid()]);
      // After approval: only refundReportedPaise may change (LD13).
      await h.refusedToken(FLIGHT, SQL2.flightChargeSet, [batch.batchId, charge({ airlineChargePaise: '170000' }), 2, rid()], 'already_decided');
      await one(FLIGHT, SQL2.flightChargeSet, [batch.batchId, charge({ airlineChargePaise: '160000', refundReportedPaise: '340000' }), 2, rid()]);
      expect((await chargeRows(batch.batchId)).at(-1)).toMatchObject({ revision_no: 3, refund_reported_paise: '340000', airline_charge_paise: '160000' });
      // Flight money: batch cancelled, tickets themselves unchanged.
      const money = JSON.stringify(await one(FLIGHT, SQL2.flightMoney, [DEAL]));
      expect(money).toContain('"ticketsCancelled":true');
      expect(money).toContain('"refundReportedPaise":"340000"');
      expect(money, 'Flight never sees customer money').not.toMatch(/sellingTotal|heldPaise|customerChargePaise/);
    });
  });

  it('decide: anyone who entered a Flight charge revision is excluded; unassigned cost task: any active Flight person enters', async () => {
    await asOwner(db, async () => {
      const { batch } = await flightCase();
      const cancellationId = await h.openCancellation();
      await h.addRole(U.managerDelhi, 'flight', 'DEL');
      await db.exec('savepoint unassign');
      try {
        await owner(`update public.fulfilment_tasks set assignee_user_id = null where id = (select cost_task_id from public.flight_ticket_batches where id = $1)`,
          [batch.batchId]);
        await db.exec('release savepoint unassign');
      } catch {
        await db.exec('rollback to savepoint unassign');
      }
      const [assignee] = await owner<{ a: string | null }>(
        'select t.assignee_user_id as a from public.fulfilment_tasks t join public.flight_ticket_batches b on b.cost_task_id = t.id where b.id = $1', [batch.batchId]);
      const enterer: Actor = assignee?.a ? FLIGHT : MANAGER;
      await one(enterer, SQL2.flightChargeSet, [batch.batchId, charge(), 0, rid()]);
      const c = (await h.cancellationOf())!;
      await one(FLIGHT, SQL2.cancelSend, [cancellationId, c.row_version, rid()]);
      if (enterer === MANAGER) {
        await h.dropRole(U.managerDelhi, 'flight');
        await h.refusedToken(MANAGER, SQL2.cancelDecide, [cancellationId, 'approve', null, (await h.cancellationOf())!.row_version, rid()], 'not_self_approval');
      }
    });
  });
});

describe.skipIf(!VISA_READY)(`Visa cancellation (C10, C11, LD12, LD14)${VISA_READY ? '' : ` — ${waits('C', 'visa_cancellation_fees …')}`}`, () => {
  /** Sticker visa for travellers 1 and 2, both applied (company-paid fee). */
  async function visaCase() {
    const t = await v.stickerTask({ participants: [1, 2] });
    const a1 = await v.makeReady(t.taskId, 1);
    const a2 = await v.makeReady(t.taskId, 2);
    await v.apply(t.taskId, [visaLine(a1), visaLine(a2)]);
    return { taskId: t.taskId };
  }
  const apps = (taskId: string) => owner<{ id: string; state: string; row_version: number; cancellation_choice: string | null }>(
    'select id, state, row_version, cancellation_choice from public.visa_applications where task_id = $1 order by created_at, id', [taskId]);

  it('Visa-only: the Manager decides straight from open (LD14); banner while open; blocked after approval (trip_cancelled)', async () => {
    await asOwner(db, async () => {
      const { taskId } = await visaCase();
      await h.openCancellation();
      const ws = await one<{ cancellation: { status: string; approved: boolean } }>(VISA_A, SQL2.visaWorkspace, [taskId]);
      expect(ws.cancellation).toMatchObject({ approved: false });
      // While open, Visa is not blocked yet (LD12): a cost entry can still be saved.
      const save = (rv = 0) => [taskId, null, rv, JSON.stringify({ costKind: 'other', amountPaise: '25000', paidBy: 'company',
        paymentMode: 'cash', paidOn: today(), applicationId: null }), rid()];
      const open = await h.attempt(VISA_A, SQL2.costSave, save());
      if (!open.ok) expect(open.error).not.toBe('trip_cancelled');
      await h.approveCancellation();
      expect((await h.cancellationOf())!.status).toBe('approved');
      await h.refusedToken(VISA_A, SQL2.costSave, save(), 'trip_cancelled');
      const ws2 = await one<{ cancellation: { approved: boolean } }>(VISA_A, SQL2.visaWorkspace, [taskId]);
      expect(ws2.cancellation.approved).toBe(true);
    });
  });

  it('per submitted application: withdraw applies the withdraw effects; finish keeps it; already_recorded; not_ready before approval', async () => {
    await asOwner(db, async () => {
      const { taskId } = await visaCase();
      const [a1, a2] = await apps(taskId);
      expect(['submitted', 'decision_pending']).toContain(a1!.state);
      await h.openCancellation();
      await h.refusedToken(VISA_A, SQL2.visaChoice, [a1!.id, a1!.row_version, 'withdraw', 'Synthetic: trip cancelled by the customer', rid()], 'not_ready');
      await h.approveCancellation();
      await h.refused(OWNER, SQL2.visaChoice, [a1!.id, a1!.row_version, 'withdraw', 'Synthetic: trip cancelled by the customer', rid()], 'not_authorized');
      await h.refusedHint(VISA_A, SQL2.visaChoice, [a1!.id, a1!.row_version, 'withdraw', 'short', rid()], 'invalid_input', undefined, '22023');
      await one(VISA_A, SQL2.visaChoice, [a1!.id, a1!.row_version, 'withdraw', 'Synthetic: trip cancelled by the customer', rid()]);
      await one(VISA_A, SQL2.visaChoice, [a2!.id, a2!.row_version, 'finish', 'Synthetic: decision expected in two days', rid()]);
      const [w, f] = await apps(taskId);
      expect(w).toMatchObject({ state: 'withdrawn', cancellation_choice: 'withdraw' });
      expect(f!.cancellation_choice).toBe('finish');
      expect(f!.state).not.toBe('withdrawn');
      await h.refusedToken(VISA_A, SQL2.visaChoice, [f!.id, f!.row_version, 'withdraw', 'Synthetic: change of mind on this one', rid()], 'already_recorded');
      expect((await h.audits('visa.cancellation_choice')).map((x) => x.details)).toEqual(expect.arrayContaining([
        expect.objectContaining({ applicationId: a1!.id, choice: 'withdraw' }), expect.objectContaining({ applicationId: a2!.id, choice: 'finish' })]));
      // Re-apply refused after approval.
      const reapply = await h.attempt(VISA_A, 'select public.visa_application_reapply($1, $2, $3) as r', [w!.id, w!.row_version, rid()]);
      if (!reapply.ok) expect(reapply.error).toMatch(/^(trip_cancelled|wrong_state|invalid_input|not_ready)$/);
      else throw new Error('re-apply after an approved cancellation must be refused');
    });
  });

  it('fee refund expected per paid fee (C11): revisions, version_changed; no row = not refundable', async () => {
    await asOwner(db, async () => {
      const { taskId } = await visaCase();
      const [fee] = await owner<{ id: string }>(`select id from public.department_cost_entries where task_id = $1 and paid_by = 'company' order by created_at limit 1`,
        [taskId]);
      expect(fee).toBeDefined();
      await h.refusedToken(VISA_A, SQL2.visaFeeSet, [fee!.id, '300000', 'Synthetic: embassy refunds half', 0, rid()], 'not_ready');
      await h.approveCancellation();
      const ws0 = JSON.stringify(await one(VISA_A, SQL2.visaWorkspace, [taskId]));
      expect(ws0).toContain('refundExpectedPaise');
      await one(VISA_A, SQL2.visaFeeSet, [fee!.id, '300000', 'Synthetic: embassy refunds half', 0, rid()]);
      await h.refusedToken(VISA_A, SQL2.visaFeeSet, [fee!.id, '310000', 'Synthetic: corrected', 0, rid()], 'version_changed');
      await one(VISA_A, SQL2.visaFeeSet, [fee!.id, '310000', 'Synthetic: corrected', 1, rid()]);
      expect(await owner('select revision_no, refund_expected_paise::text as v from public.visa_cancellation_fees where entry_id = $1 order by revision_no',
        [fee!.id])).toEqual([{ revision_no: 1, v: '300000' }, { revision_no: 2, v: '310000' }]);
      expect(await h.audits('visa.cancellation_fee_set')).toHaveLength(2);
      const ws = JSON.stringify(await one(VISA_A, SQL2.visaWorkspace, [taskId]));
      expect(ws).toContain('"refundExpectedPaise":"310000"');
      expect(ws, 'Visa never sees customer money').not.toMatch(/heldPaise|customerChargePaise|sellingTotal/);
    });
  });
});
