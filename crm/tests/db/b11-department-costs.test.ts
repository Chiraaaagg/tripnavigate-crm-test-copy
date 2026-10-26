import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { DEAL, FLIGHT, FLIGHT_CLAIM_SQL, FLIGHT_FACTS, HOTEL, OWNER, PURCHASE, PURCHASE_CLAIM_SQL } from './b1-support';
import { COST_SAVE_SQL, COST_SUBMIT_SQL, DESK, VISA_CLAIM_SQL, WORK_FORM_SQL, b11Helpers, rid } from './b11-support';

/**
 * The shared cost block (migration 20261119000500): the task's assignee
 * records the actual cost or fee; a company-paid one is an expense record
 * (draft -> submitted) that needs its receipt; Flight company-paid above
 * INR 50,000 is refused (DEC-21); Purchase gets the read-only placeholder.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b11Helpers(() => db);
const { one, refused, refusedWithHint, deskTask, deskEvidence, readyDraft, confirm, addFlight } = h;
type Saved = { entryId: string; rowVersion: number; expenseStatus: string | null };
const FEE = { costKind: 'government_fee', amountPaise: '650000', paidBy: 'company', paymentMode: 'upi', paidOn: '2026-10-10', reference: 'GOV-SYN-1' };

describe('department_cost_save and submit', () => {
  it('company-paid fee: draft expense record, receipt required to submit, locked once submitted; exact retry by request id', async () => {
    await asOwner(db, async () => {
      const { taskId } = await deskTask();
      await refused(DESK, COST_SAVE_SQL, [taskId, null, 0, JSON.stringify(FEE), rid()], '42501', 'not_authorized'); // not taken yet
      await one(DESK, VISA_CLAIM_SQL, [taskId]);
      const req = rid();
      const saved = await one<Saved>(DESK, COST_SAVE_SQL, [taskId, null, 0, JSON.stringify(FEE), req]);
      expect(saved).toMatchObject({ rowVersion: 1, expenseStatus: 'draft' });
      expect(await one<Saved>(DESK, COST_SAVE_SQL, [taskId, null, 0, JSON.stringify(FEE), req])).toEqual(saved);
      await refused(DESK, COST_SUBMIT_SQL, [saved.entryId, 1], '55000', 'receipt_required');
      const receipt = await deskEvidence(DESK, taskId, 'fee_receipt');
      const withReceipt = await one<Saved>(DESK, COST_SAVE_SQL, [taskId, saved.entryId, 1, JSON.stringify({ ...FEE, receiptEvidenceId: receipt }), rid()]);
      const submitted = await one<Saved>(DESK, COST_SUBMIT_SQL, [saved.entryId, withReceipt.rowVersion]);
      expect(submitted.expenseStatus).toBe('submitted');
      await refused(DESK, COST_SAVE_SQL, [taskId, saved.entryId, submitted.rowVersion, JSON.stringify(FEE), rid()], '55000', 'cost_locked');
      await refused(DESK, 'select public.department_evidence_remove($1) as r', [receipt], '55000', 'cost_locked');
      // Customer paid directly: a record, not an expense for Accounts.
      const direct = await one<Saved>(DESK, COST_SAVE_SQL, [taskId, null, 0, JSON.stringify({ ...FEE, paidBy: 'customer_direct' }), rid()]);
      expect(direct.expenseStatus).toBeNull();
      await refused(DESK, COST_SUBMIT_SQL, [direct.entryId, direct.rowVersion], '55000', 'wrong_state');
      const notYet = await one<Saved>(DESK, COST_SAVE_SQL, [taskId, null, 0, JSON.stringify({ costKind: 'service_fee', amountPaise: '10000', paidBy: 'not_yet' }), rid()]);
      expect(notYet.expenseStatus).toBeNull();
      const form = await one<{ costs: Array<Record<string, unknown>> }>(DESK, WORK_FORM_SQL, [taskId]);
      // Same transaction, same created_at: compare without order.
      expect(form.costs.map((c) => [c.paidBy, c.expenseStatus]).sort()).toEqual([['company', 'submitted'], ['customer_direct', null], ['not_yet', null]]);
      // The audit never carries the amount.
      expect(JSON.stringify(await h.owner(`select details from public.audit_events where action like 'department.cost_%'`))).not.toMatch(/650000/);
    });
  });

  it('validates fields; Flight company-paid above INR 50,000 is refused; Purchase gets only the placeholder', async () => {
    await asOwner(db, async () => {
      const { taskId, hotelTaskId } = await deskTask();
      await one(DESK, VISA_CLAIM_SQL, [taskId]);
      for (const [fields, hint] of [
        [{ ...FEE, amountPaise: '0' }, /^amountPaise$/],
        [{ ...FEE, paidBy: 'friend' }, /^paidBy$/],
        [{ ...FEE, paymentMode: null }, /^paymentMode$/],
        [{ ...FEE, paidOn: '2999-01-01' }, /^paidOn$/],
        [{ ...FEE, paidBy: 'not_yet' }, /paymentMode/],
        [{ ...FEE, costKind: 'fare', extra: 1 }, /^extra$/],
      ] as Array<[unknown, RegExp]>) {
        await refusedWithHint(DESK, COST_SAVE_SQL, [taskId, null, 0, JSON.stringify(fields), rid()], hint);
      }
      await one(PURCHASE, PURCHASE_CLAIM_SQL, [hotelTaskId]);
      await refusedWithHint(PURCHASE, COST_SAVE_SQL, [hotelTaskId, null, 0, JSON.stringify({ ...FEE, costKind: 'other' }), rid()], /^department$/);
      expect(await one(PURCHASE, WORK_FORM_SQL, [hotelTaskId])).toMatchObject({ department: 'purchase', costs: [] });
    });
    await asOwner(db, async () => {
      await addFlight();
      const ready = await readyDraft(OWNER, DEAL, [['flight', FLIGHT_FACTS]]);
      const { taskIds } = await confirm(OWNER, ready.versionId, ready.hash);
      await one(FLIGHT, FLIGHT_CLAIM_SQL, [taskIds![0]]);
      const fare = { costKind: 'fare', amountPaise: '5000001', paidBy: 'company', paymentMode: 'card', paidOn: '2026-10-10' };
      await refused(FLIGHT, COST_SAVE_SQL, [taskIds![0], null, 0, JSON.stringify(fare), rid()], '22023', 'direct_payment_over_limit');
      const ok = await one<Saved>(FLIGHT, COST_SAVE_SQL, [taskIds![0], null, 0, JSON.stringify({ ...fare, amountPaise: '5000000' }), rid()]);
      expect(ok.expenseStatus).toBe('draft');
      // Review V2: the cap is per purchase: a second company-paid entry may not take the task over INR 50,000.
      await refused(FLIGHT, COST_SAVE_SQL, [taskIds![0], null, 0, JSON.stringify({ ...fare, amountPaise: '1' }), rid()], '22023', 'direct_payment_over_limit');
      const customer = await one<Saved>(FLIGHT, COST_SAVE_SQL, [taskIds![0], null, 0, JSON.stringify({ ...fare, paidBy: 'customer_direct', amountPaise: '4000000' }), rid()]);
      expect(customer.expenseStatus).toBeNull();
      // Flight's receipt is the direct-payment proof.
      await refused(FLIGHT, COST_SUBMIT_SQL, [ok.entryId, ok.rowVersion], '55000', 'receipt_required');
      const proof = await deskEvidence(FLIGHT, taskIds![0]!, 'direct_payment_proof');
      const linked = await one<Saved>(FLIGHT, COST_SAVE_SQL, [taskIds![0], ok.entryId, ok.rowVersion, JSON.stringify({ ...fare, amountPaise: '5000000', receiptEvidenceId: proof }), rid()]);
      expect((await one<Saved>(FLIGHT, COST_SUBMIT_SQL, [ok.entryId, linked.rowVersion])).expenseStatus).toBe('submitted');
      expect(HOTEL.rooms).toBe(2);
    });
  });

  it('review V2: two company-paid fares of INR 40,000 on one purchase: the second is refused', async () => {
    await asOwner(db, async () => {
      await addFlight();
      const ready = await readyDraft(OWNER, DEAL, [['flight', FLIGHT_FACTS]]);
      const { taskIds } = await confirm(OWNER, ready.versionId, ready.hash);
      await one(FLIGHT, FLIGHT_CLAIM_SQL, [taskIds![0]]);
      const fare = { costKind: 'fare', amountPaise: '4000000', paidBy: 'company', paymentMode: 'card', paidOn: '2026-10-10' };
      const first = await one<Saved>(FLIGHT, COST_SAVE_SQL, [taskIds![0], null, 0, JSON.stringify(fare), rid()]);
      await refused(FLIGHT, COST_SAVE_SQL, [taskIds![0], null, 0, JSON.stringify(fare), rid()], '22023', 'direct_payment_over_limit');
      // Editing the first entry itself is not double-counted.
      const edited = await one<Saved>(FLIGHT, COST_SAVE_SQL, [taskIds![0], first.entryId, first.rowVersion, JSON.stringify({ ...fare, amountPaise: '5000000' }), rid()]);
      expect(edited.rowVersion).toBe(2);
    });
  });
});
