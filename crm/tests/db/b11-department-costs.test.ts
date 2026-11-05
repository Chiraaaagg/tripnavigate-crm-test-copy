import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { DEAL, FLIGHT, FLIGHT_CLAIM_SQL, FLIGHT_FACTS, HOTEL, OWNER, PURCHASE, PURCHASE_CLAIM_SQL } from './b1-support';
import { COST_SAVE_SQL, COST_SUBMIT_SQL, DESK, VISA_CLAIM_SQL, WORK_FORM_SQL, b11Helpers, rid } from './b11-support';

/**
 * The shared cost block (migration 20261119000500): the task's assignee
 * records the actual cost or fee; a company-paid one is an expense record
 * (draft -> submitted) that needs its receipt; Purchase gets the read-only
 * placeholder.
 *
 * Flight build (contract 4 Nov 2026, D3 and B13): the per-passenger fare
 * breakup is the only flight cost record, so department_cost_save refuses
 * department flight (invalid_input, hint flightFares). The DEC-21 per-task
 * INR 50,000 cap these tests asserted for manual flight entries is replaced
 * by the cumulative per (Deal, supplier) cap of flight direct payments
 * (conflict note C1, lead decision L1), tested in flight-payments.test.ts.
 * Manual flight rows saved before the build stay readable and submittable
 * (L18): that part is kept below with a synthetic pre-build row.
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
      // Flight build (B13): every manual flight cost entry is refused, whatever the amount or payer. These replace the
      // DEC-21 assertions (5,000,001 refused, 5,000,000 accepted, second entry over the per-task cap, customer_direct
      // accepted), which no longer hold by design: the fare breakup is the only flight cost record (D3).
      for (const fields of [fare, { ...fare, amountPaise: '5000000' }, { ...fare, amountPaise: '1' }, { ...fare, paidBy: 'customer_direct', amountPaise: '4000000' }]) {
        await refusedWithHint(FLIGHT, COST_SAVE_SQL, [taskIds![0], null, 0, JSON.stringify(fields), rid()], /^flightFares$/);
      }
      expect(await h.owner('select count(*)::int as n from public.department_cost_entries where task_id = $1', [taskIds![0]])).toEqual([{ n: 0 }]);
      // L18: a manual flight row saved before the build stays submittable; Flight's receipt is the direct-payment proof (kept).
      // SYNTHETIC FIXTURE: such pre-build draft rows, written as the table owner (one without, one with the proof).
      const preBuild = (receipt: string | null) => h.owner<{ id: string; row_version: number }>(
        `insert into public.department_cost_entries (legal_entity_id, branch_id, deal_id, task_id, department, cost_kind, amount_paise, paid_by,
           payment_mode, paid_on, expense_status, receipt_evidence_id, created_by, request_id)
         select t.legal_entity_id, d.branch_id, t.deal_id, t.id, 'flight', 'fare', 1000000, 'company', 'card', date '2026-10-10', 'draft', $2,
           t.assignee_user_id, gen_random_uuid()
         from public.fulfilment_tasks t join public.deals d on d.id = t.deal_id where t.id = $1 returning id, row_version`, [taskIds![0], receipt]);
      const [old] = await preBuild(null);
      await refused(FLIGHT, COST_SUBMIT_SQL, [old!.id, old!.row_version], '55000', 'receipt_required');
      const proof = await deskEvidence(FLIGHT, taskIds![0]!, 'direct_payment_proof');
      const [linked] = await preBuild(proof);
      expect((await one<Saved>(FLIGHT, COST_SUBMIT_SQL, [linked!.id, linked!.row_version])).expenseStatus).toBe('submitted');
      expect(HOTEL.rooms).toBe(2);
    });
  });

  it('review V2 (superseded by the flight build): two company-paid fares of INR 40,000 on one purchase are both refused as manual entries', async () => {
    // The per-purchase cap (review V2) is replaced by the cumulative per (Deal, supplier) cap of flight
    // direct payments (contract C1/L1, flight-payments.test.ts); manual flight entries are refused (B13).
    await asOwner(db, async () => {
      await addFlight();
      const ready = await readyDraft(OWNER, DEAL, [['flight', FLIGHT_FACTS]]);
      const { taskIds } = await confirm(OWNER, ready.versionId, ready.hash);
      await one(FLIGHT, FLIGHT_CLAIM_SQL, [taskIds![0]]);
      const fare = { costKind: 'fare', amountPaise: '4000000', paidBy: 'company', paymentMode: 'card', paidOn: '2026-10-10' };
      await refusedWithHint(FLIGHT, COST_SAVE_SQL, [taskIds![0], null, 0, JSON.stringify(fare), rid()], /^flightFares$/);
      await refusedWithHint(FLIGHT, COST_SAVE_SQL, [taskIds![0], null, 0, JSON.stringify(fare), rid()], /^flightFares$/);
    });
  });
});
