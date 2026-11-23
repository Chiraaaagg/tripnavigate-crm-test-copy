import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { FLIGHT, PURCHASE, SALES_B } from './acc-support';
import { ACC, ACC_J2, CSQL, DEAL, FLIGHT_J, MANAGER, MANAGER_F, MANAGER_J2, OWNER, VISA_J2, acc2cHelpers, rid, today } from './acc2c-support';

/**
 * Accounts phase 2 contract section 10 fences and 7.5 reads (R-C1..R-C3),
 * Track C: every refund read returns null (never a partial object) for
 * Purchase, Flight, Visa, other Sales, A+Purchase and M+Flight; the Sales
 * owner never gets supplier refunds, payout references or proof ids; the
 * refund list presets and keyset; supplier refunds on Purchase charges.
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

async function paidRefund() {
  const { receipt, booked } = await c.paidBooking('5000000');
  await c.cancelApproved();
  const r = await c.request({ kind: 'cancellation', outcome: 'payout', customerChargePaise: '1000000', amountPaise: '2345678',
    payeeKind: 'original_payer', payeeReceiptId: receipt!.id });
  await c.decide(r.refundRequestId, 'approve');
  await c.payout(r.refundRequestId);
  return { r, booked };
}

describe('section 10 fences', () => {
  it('deal_refunds: A, M, SO read; P, F, V, other Sales, A+P, M+F get null; SO never sees supplier refunds or payout reference', async () => {
    await asOwner(db, async () => {
      await paidRefund();
      const a = await one<Record<string, unknown> & { requests: Array<{ payout: Record<string, unknown> }> }>(ACC, CSQL.dealRefunds, [DEAL]);
      expect(a).toMatchObject({ viewer: 'accounts', heldPaise: '2654322' });
      expect(a.requests[0]!.payout).toMatchObject({ reference: 'SYNRF0001', evidenceId: expect.any(String) });
      expect(a).toHaveProperty('supplierRefunds');
      const m = await one<Record<string, unknown>>(MANAGER, CSQL.dealRefunds, [DEAL]);
      expect(m).toMatchObject({ viewer: 'manager' });
      const so = await one<Record<string, unknown> & { requests: Array<{ payout: Record<string, unknown> }> }>(OWNER, CSQL.dealRefunds, [DEAL]);
      expect(so).toMatchObject({ viewer: 'sales', chargesKeptPaise: '0' });
      expect(so).not.toHaveProperty('supplierRefunds');
      expect(so.requests[0]!.payout).toMatchObject({ reference: null, evidenceId: null });
      // A Manager holding Flight (not M, AL7) and an Accounts person holding Purchase (not A).
      await c.addRole(U.accountsJodhpur, 'purchase');
      for (const actor of [PURCHASE, FLIGHT, FLIGHT_J, VISA_J2, SALES_B, MANAGER_F, ACC, MANAGER_J2]) {
        expect(await one(actor, CSQL.dealRefunds, [DEAL]), `actor ${actor.userId}`).toBeNull();
        expect(await one(actor, CSQL.due, ['{}', null, 50])).toBeNull();
      }
      for (const actor of [PURCHASE, FLIGHT_J, VISA_J2]) {
        expect(await one(actor, CSQL.list, ['{}', null, 50])).toBeNull();
      }
      // Fence leak scan: P/F/V see nothing of the refund in any read they have.
      const text = JSON.stringify(await one(FLIGHT, 'select public.flight_money($1) as r', [DEAL]));
      expect(text).not.toContain('2345678');
    });
  });

  it('refund_requests_list: presets payout_due (A) and to_approve (M); SO own Deals only; keyset pages', async () => {
    await asOwner(db, async () => {
      const { receipt } = await c.paidBooking('5000000');
      await c.cancelApproved();
      const r1 = await c.request({ kind: 'cancellation', outcome: 'keep_credit', customerChargePaise: '0', amountPaise: '100' });
      let toApprove = await one<{ items: Array<Record<string, unknown> & { id: string; ageWorkingDays: number }> }>(MANAGER, CSQL.list, [JSON.stringify({ preset: 'to_approve' }), null, 50]);
      expect(toApprove.items.map((i) => i.id)).toEqual([r1.refundRequestId]);
      expect(toApprove.items[0]!.ageWorkingDays).toBe(0);
      expect(toApprove.items[0]).toMatchObject({ rowVersion: 1, can: { approve: true, return: true, payout: false },
        expectedAmountPaise: '100', expectedChargePaise: '0' });
      await c.decide(r1.refundRequestId, 'approve');
      const r2 = await c.request({ kind: 'cancellation', outcome: 'payout', customerChargePaise: '0', amountPaise: '200',
        payeeKind: 'original_payer', payeeReceiptId: receipt!.id });
      await c.decide(r2.refundRequestId, 'approve');
      const due = await one<{ items: Array<Record<string, unknown> & { id: string }> }>(ACC, CSQL.list, [JSON.stringify({ preset: 'payout_due' }), null, 50]);
      expect(due.items.map((i) => i.id)).toEqual([r2.refundRequestId]);
      // 20261204000370: act from the queue (row version, can, binding amounts only where the viewer may act).
      expect(due.items[0]).toMatchObject({ rowVersion: 2, can: { approve: false, return: false, payout: true },
        expectedAmountPaise: '200', expectedChargePaise: '0' });
      const ownView = await one<{ items: Array<Record<string, unknown> & { id: string }> }>(OWNER, CSQL.list, ['{}', null, 50]);
      expect(ownView.items.find((i) => i.id === r2.refundRequestId)).toMatchObject({ can: { approve: false, return: false, payout: false },
        expectedAmountPaise: null, expectedChargePaise: null });
      toApprove = await one(MANAGER, CSQL.list, [JSON.stringify({ preset: 'to_approve' }), null, 50]);
      expect(toApprove.items).toEqual([]);
      const page1 = await one<{ items: Array<{ id: string }>; nextAfter: string | null }>(OWNER, CSQL.list, ['{}', null, 1]);
      expect(page1.items).toHaveLength(1);
      expect(page1.nextAfter).not.toBeNull();
      const page2 = await one<{ items: Array<{ id: string }>; nextAfter: string | null }>(OWNER, CSQL.list, ['{}', page1.nextAfter, 1]);
      expect(new Set([...page1.items, ...page2.items].map((i) => i.id))).toEqual(new Set([r1.refundRequestId, r2.refundRequestId]));
      expect(page2.nextAfter).toBeNull();
      expect((await one<{ items: unknown[] }>(SALES_B, CSQL.list, ['{}', null, 50])).items).toEqual([]);
      await c.refusedHint(ACC, CSQL.list, [JSON.stringify({ status: ['bogus'] }), null, 50], 'invalid_input', /status/);
    });
  });

  it('supplier refund on a Purchase charge: expected = latest supplier refund; R-C1 lists it for A and M; Purchase never reads the money side', async () => {
    await asOwner(db, async () => {
      const { booked } = await c.paidBooking('5000000');
      const task = c.taskOf(booked, 'hotel');
      const supplierId = await c.purchaseSupplier();
      await c.purchaseCost(task, supplierId);
      const opened = await one<{ cancellationId: string }>(MANAGER, CSQL.cancelOpen, [DEAL, 'Synthetic reason for the accounts phase test', rid()]);
      await one(PURCHASE, CSQL.purchaseCharge, [task, '200000', '800000', null, null, 0, rid()]);
      const [cx] = await owner<{ row_version: number }>('select row_version from public.deal_cancellations where id = $1', [opened.cancellationId]);
      const sent = await one<{ rowVersion: number }>(PURCHASE, CSQL.cancelSend, [opened.cancellationId, cx!.row_version, rid()]);
      await one(MANAGER, CSQL.cancelDecide, [opened.cancellationId, 'approve', null, sent.rowVersion, rid()]);
      const [charge] = await owner<{ id: string }>('select id from public.purchase_cancellation_charges where task_id = $1 order by revision_no desc limit 1', [task]);
      const ev = await c.proof('supplier_refund', opened.cancellationId, ACC_J2);
      const rec = await one<{ status: string }>(ACC_J2, CSQL.srRecord, [JSON.stringify({ sourceKind: 'purchase_charge', sourceId: charge!.id,
        amountPaise: '800000', receivedOn: today(), mode: 'upi', reference: 'SYNUPI0001', evidenceId: ev }), rid()]);
      expect(rec.status).toBe('verified');
      const a = await one<{ supplierRefunds: Array<Record<string, unknown>>; chargesKeptPaise: string }>(ACC, CSQL.dealRefunds, [DEAL]);
      expect(a.chargesKeptPaise).toBe('200000');
      expect(a.supplierRefunds).toEqual([expect.objectContaining({ sourceKind: 'purchase_charge', expectedPaise: '800000', receivedPaise: '800000' })]);
      const m = await one<{ supplierRefunds: unknown[] }>(MANAGER, CSQL.dealRefunds, [DEAL]);
      expect(m.supplierRefunds).toHaveLength(1);
      expect(await one(PURCHASE, CSQL.payables, [DEAL])).toBeNull();
      // Open sources only by default: fully received -> not due.
      expect((await one<{ items: unknown[] }>(ACC, CSQL.due, ['{}', null, 50])).items).toEqual([]);
    });
  });
});
