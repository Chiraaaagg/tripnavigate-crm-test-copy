import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { PURCHASE } from './acc-support';
import { ACC, CSQL, DEAL, MANAGER, OWNER, REASON, acc2cHelpers, rid } from './acc2c-support';

/**
 * Accounts phase 2 contract Addendum L7, Track C: refund limits are
 * cumulative (review 1, incl. the reviewer's probe), charges below costs kept
 * (review 4, warning only) and the refund list fence (review 9).
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

type Dues = Record<string, unknown> & { refunds: Record<string, unknown> };
const payout = (receiptId: string, amount: string, charge: string, extra: Record<string, unknown> = {}) => ({
  kind: 'cancellation', outcome: 'payout', customerChargePaise: charge, amountPaise: amount, payeeKind: 'original_payer',
  payeeReceiptId: receiptId, ...extra });

describe('L7 review 1: cumulative limits', () => {
  it('probe: keep credit 40k + charge 10k, then payout 50k charge 0 -> charge_below_approved; kept credit reserved unless used', async () => {
    await asOwner(db, async () => {
      const { receipt } = await c.paidBooking('5000000');
      await c.cancelApproved();
      const kept = await c.request({ kind: 'cancellation', outcome: 'keep_credit', customerChargePaise: '1000000', amountPaise: '4000000' });
      await c.decide(kept.refundRequestId, 'approve');
      let dues = await one<Dues>(ACC, CSQL.dealDues, [DEAL]);
      expect(dues).toMatchObject({ totalPaise: '1000000', creditPaise: '4000000', refunds: { keptAsCreditPaise: '4000000' } });
      // The reviewer's probe: charge lowered to 0 and the kept credit paid out on top.
      await c.refusedHint(OWNER, CSQL.create, [DEAL, JSON.stringify({ reason: REASON, ...payout(receipt!.id, '5000000', '0') }), rid()],
        'charge_below_approved', /approvedChargePaise/, '22023');
      // Kept credit stays reserved: nothing left to pay out without naming it.
      await c.refusedHint(OWNER, CSQL.create, [DEAL, JSON.stringify({ reason: REASON, ...payout(receipt!.id, '4000000', '1000000') }), rid()],
        'refund_exceeds_money', /amountPaise/);
      await c.refusedHint(OWNER, CSQL.create, [DEAL, JSON.stringify({ reason: REASON, kind: 'cancellation', outcome: 'keep_credit',
        customerChargePaise: '1000000', amountPaise: '100', useKeptCredit: true }), rid()], 'invalid_input', /useKeptCredit/);
      const r = await c.request(payout(receipt!.id, '4000000', '1000000', { useKeptCredit: true }));
      expect((await c.row(r.refundRequestId)).use_kept_credit).toBe(true);
      await c.decide(r.refundRequestId, 'approve');
      await c.payout(r.refundRequestId);
      dues = await one<Dues>(ACC, CSQL.dealDues, [DEAL]);
      expect(dues).toMatchObject({ totalPaise: '1000000', verifiedPaise: '1000000', balancePaise: '0', creditPaise: '0',
        refunds: { paidPaise: '4000000', keptAsCreditPaise: '0' } });
      const view = await one<Record<string, unknown>>(OWNER, CSQL.dealRefunds, [DEAL]);
      expect(view).toMatchObject({ approvedChargePaise: '1000000', keptCreditUnusedPaise: '0', heldPaise: '1000000' });
      // Used kept credit cannot be withdrawn.
      const k = await c.row(kept.refundRequestId);
      await c.refusedHint(MANAGER, CSQL.withdraw, [kept.refundRequestId, k.row_version, REASON, rid()], 'wrong_state', /keptCreditUsed/);
    });
  });

  it('a lower charge needs the Manager to withdraw the earlier approval; the highest approved charge sets the dues total', async () => {
    await asOwner(db, async () => {
      const { receipt } = await c.paidBooking('5000000');
      await c.cancelApproved();
      const first = await c.request({ kind: 'cancellation', outcome: 'charge_only', customerChargePaise: '3000000', amountPaise: '0' });
      await c.decide(first.refundRequestId, 'approve');
      const second = await c.request({ kind: 'cancellation', outcome: 'charge_only', customerChargePaise: '3500000', amountPaise: '0' });
      await c.decide(second.refundRequestId, 'approve');
      expect(await one<Dues>(ACC, CSQL.dealDues, [DEAL])).toMatchObject({ totalPaise: '3500000' });
      await c.refusedHint(OWNER, CSQL.create, [DEAL, JSON.stringify({ reason: REASON, ...payout(receipt!.id, '1000000', '3000000') }), rid()],
        'charge_below_approved', /approvedChargePaise/);
      // The requester cannot withdraw an approved settlement; the branch Manager can.
      const s = await c.row(second.refundRequestId);
      await c.refused(OWNER, CSQL.withdraw, [second.refundRequestId, s.row_version, REASON, rid()], 'not_authorized', '42501');
      await one(MANAGER, CSQL.withdraw, [second.refundRequestId, s.row_version, REASON, rid()]);
      expect(await one<Dues>(ACC, CSQL.dealDues, [DEAL])).toMatchObject({ totalPaise: '3000000' });
      const r = await c.request(payout(receipt!.id, '2000000', '3000000'));
      expect(r.status).toBe('requested');
    });
  });
});

describe('L7 review 4: charges below costs kept (warning, no block)', () => {
  it('the requester and the approving Manager see charge_below_costs_kept', async () => {
    await asOwner(db, async () => {
      const { booked } = await c.paidBooking('5000000');
      const task = c.taskOf(booked, 'hotel');
      await c.purchaseCost(task, await c.purchaseSupplier());
      const opened = await one<{ cancellationId: string }>(MANAGER, CSQL.cancelOpen, [DEAL, REASON, rid()]);
      await one(PURCHASE, CSQL.purchaseCharge, [task, '200000', '0', null, null, 0, rid()]);
      const [cx] = await owner<{ row_version: number }>('select row_version from public.deal_cancellations where id = $1', [opened.cancellationId]);
      const sent = await one<{ rowVersion: number }>(PURCHASE, CSQL.cancelSend, [opened.cancellationId, cx!.row_version, rid()]);
      await one(MANAGER, CSQL.cancelDecide, [opened.cancellationId, 'approve', null, sent.rowVersion, rid()]);
      const r = await c.request({ kind: 'cancellation', outcome: 'charge_only', customerChargePaise: '100000', amountPaise: '0' });
      for (const actor of [OWNER, MANAGER]) {
        const v = await one<{ requests: Array<{ warnings: string[] }> }>(actor, CSQL.dealRefunds, [DEAL]);
        expect(v.requests[0]!.warnings).toEqual(['charge_below_costs_kept']);
      }
      const list = await one<{ items: Array<{ id: string; warnings: string[] }> }>(MANAGER, CSQL.list, [JSON.stringify({ preset: 'to_approve' }), null, 50]);
      expect(list.items.find((i) => i.id === r.refundRequestId)!.warnings).toEqual(['charge_below_costs_kept']);
      expect((await c.decide(r.refundRequestId, 'approve')).status).toBe('approved');
    });
  });
});

describe('20261204000390 (Q7): the approver and payer see payee and reason in the queue', () => {
  it('Manager and Accounts rows carry reason, payeeKind, payeeName, payeeReason, payeeReceiptNo; the Sales owner gets null', async () => {
    await asOwner(db, async () => {
      const { receipt } = await c.paidBooking('5000000');
      await c.cancelApproved();
      const r = await c.request({ kind: 'cancellation', outcome: 'payout', customerChargePaise: '1000000', amountPaise: '100000',
        payeeKind: 'other', payeeName: 'Synthetic Other Payee', payeeReason: 'Synthetic: the payer asked to refund his spouse' });
      type Row = Record<string, unknown> & { id: string };
      const m = (await one<{ items: Row[] }>(MANAGER, CSQL.list, [JSON.stringify({ preset: 'to_approve' }), null, 50])).items
        .find((i) => i.id === r.refundRequestId)!;
      expect(m).toMatchObject({ reason: REASON, payeeKind: 'other', payeeName: 'Synthetic Other Payee',
        payeeReason: 'Synthetic: the payer asked to refund his spouse', payeeReceiptNo: null, customerChargePaise: '1000000' });
      await c.decide(r.refundRequestId, 'approve');
      const a = (await one<{ items: Row[] }>(ACC, CSQL.list, [JSON.stringify({ preset: 'payout_due' }), null, 50])).items[0]!;
      expect(a).toMatchObject({ payeeKind: 'other', payeeName: 'Synthetic Other Payee' });
      const so = (await one<{ items: Row[] }>(OWNER, CSQL.list, ['{}', null, 50])).items.find((i) => i.id === r.refundRequestId)!;
      expect(so).toMatchObject({ reason: null, payeeKind: null, payeeName: null, payeeReason: null, payeeReceiptNo: null });
      // Original payer: the receipt number is shown to the approver.
      await one(MANAGER, CSQL.withdraw, [r.refundRequestId, (await c.row(r.refundRequestId)).row_version, REASON, rid()]);
      const r2 = await c.request(payout(receipt!.id, '100000', '1000000'));
      const m2 = (await one<{ items: Row[] }>(MANAGER, CSQL.list, [JSON.stringify({ preset: 'to_approve' }), null, 50])).items
        .find((i) => i.id === r2.refundRequestId)!;
      expect(m2).toMatchObject({ payeeKind: 'original_payer', payeeName: 'Synthetic Payer', payeeReceiptNo: expect.stringMatching(/^R-/) });
    });
  });
});

describe('L7 review 9: refund list fence', () => {
  it('every scope (A, M, SO) passes the finance gate: finance off for the entity -> nothing listed', async () => {
    await asOwner(db, async () => {
      await c.paidBooking('5000000');
      await c.cancelApproved();
      await c.request({ kind: 'cancellation', outcome: 'charge_only', customerChargePaise: '100000', amountPaise: '0' });
      for (const actor of [ACC, MANAGER, OWNER]) {
        expect((await one<{ items: unknown[] }>(actor, CSQL.list, ['{}', null, 50])).items).toHaveLength(1);
      }
      await owner('delete from public.finance_live_settings where legal_entity_id = $1', [await c.entityId()]);
      for (const actor of [ACC, MANAGER, OWNER]) {
        const page = await one<{ items: unknown[] } | null>(actor, CSQL.list, ['{}', null, 50]);
        expect(page?.items ?? []).toEqual([]);
        expect(await one(actor, CSQL.dealRefunds, [DEAL])).toBeNull();
      }
    });
  });
});
