import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { fare } from './flight-support';
import {
  ACC, ACC2, DEAL, FLIGHT, FLIGHT_ITEM, HOTEL_ITEM, MANAGER, MANAGER_AMD, OWNER, PURCHASE, REASON, SQL, accHelpers, rid,
} from './acc-support';

/**
 * Accounts phase contract 9.1, the kinds acc-notices.test.ts does not drive
 * (lead request, 10 Nov): #6 supplier_confirmed, #7 task_completed, #15
 * funding_to_approve, #16 bank details (urgent while a payment is live;
 * superseded by a newer revision), #19 cost_over_budget, #20/#21 fares,
 * #22 expense_returned, #23 supplier_bill_returned. For each: recipients,
 * never the actor, money kinds never to a Purchase holder (an Accounts or
 * Manager person who also holds Purchase), priority, shared resolution, and
 * the kill switch (off = nothing written for the same command).
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = accHelpers(() => db);
const { one, owner } = h;
const ids = (...a: Actor[]) => a.map((x) => x.userId!).sort();
const GROUP_COMPLETE = 'select public.flight_group_complete($1, $2::uuid[], $3) as r';
const FARE_REQUEST = 'select public.flight_fare_approval_request($1, $2::jsonb, $3) as r';
const FARE_DECIDE = 'select public.flight_fare_approval_decide($1, $2, $3, $4, $5) as r';
const OVER_BUDGET_APPROVE = 'select public.purchase_cost_approve_over_budget($1, $2) as r';
const EXPENSE_RETURN = 'select public.expense_record_return($1, $2, $3, $4) as r';

/** Hotel booking on DEAL, approved, customer money, a costed hotel task with the go-ahead. */
async function costedHotel(opts: { cost?: string; money?: string } = {}) {
  await h.addAcc2();
  const b = await h.book([HOTEL_ITEM]);
  await h.approve(b.versionId);
  await h.receipt(DEAL, opts.money ?? '30000000');
  const task = h.taskOf(b, 'hotel');
  const supplierId = await h.purchaseSupplier();
  await h.purchaseCost(task, supplierId, opts.cost);
  return { b, task, supplierId };
}

describe('#6 supplier_confirmed and #23 supplier_bill_returned', () => {
  it('supplier confirmation tells the Sales owner (normal); a returned bill tells the task assignee', async () => {
    await asOwner(db, async () => {
      const { task } = await costedHotel();
      await h.goAhead(task);
      await h.noticesOn();
      await h.confirmSupplier(task);
      expect((await h.notices('supplier_confirmed')).map((n) => [n.recipient_user_id, n.priority, n.task_id])).toEqual([[OWNER.userId, 'normal', task]]);
      const doc = await h.uploadDoc(task, { number: 'SYN-RET-23' });
      await h.reviewDoc(doc.id, 'return', 'Synthetic: the bill shows another hotel');
      expect((await h.notices('supplier_bill_returned')).map((n) => [n.recipient_user_id, n.subject_id])).toEqual([[PURCHASE.userId, doc.id]]);
      expect(await h.recipientsOf('supplier_bill_returned')).not.toContain(ACC.userId);
    });
  });
});

describe('#15 funding and #16 bank details', () => {
  it('funding_to_approve goes to the route (Accounts), never the actor or a Purchase holder; resolves when decided', async () => {
    await asOwner(db, async () => {
      // Customer money (INR 10,000) below the request: company funding is needed.
      const { task } = await costedHotel({ money: '1000000' });
      await h.goAhead(task);
      await h.addAcc3();
      await h.addRole(U.invitedStaff, 'purchase');
      await h.noticesOn();
      const p = await h.purchaseRequest(task, 3_000_000, { fundingReason: 'Synthetic funding reason: customer transfer delayed' });
      const [funding] = await owner<{ id: string; row_version: number }>(
        'select id, row_version from public.company_funding_requests where payment_request_id = $1', [p.id]);
      expect(funding, 'funding row created').toBeDefined();
      expect(await h.recipientsOf('funding_to_approve')).toEqual(ids(ACC, ACC2));
      await one(ACC, 'select public.company_funding_decide($1, $2, $3, $4, $5) as r', [funding!.id, 'approve', null, funding!.row_version, rid()]);
      expect((await h.notices('funding_to_approve')).every((n) => n.resolved_at)).toBe(true);
      // AL24: no funding decision notice to the requester.
      expect((await h.notices()).filter((n) => n.recipient_user_id === PURCHASE.userId && /funding/.test(n.kind))).toEqual([]);
    });
  });

  it('bank details: urgent when a payment is live; a newer revision supersedes the older notice; never the recorder', async () => {
    await asOwner(db, async () => {
      const { task, supplierId } = await costedHotel();
      await h.goAhead(task);
      await h.purchaseRequest(task, 2_000_000);
      await h.noticesOn();
      const add = (acct: string) => one(PURCHASE, SQL.supplierBeneficiary, [supplierId, rid(), JSON.stringify({ accountHolder: 'Synthetic Stays',
        bankName: 'Synthetic Bank', ifsc: 'SYNB0000001', accountNumber: acct })]);
      await add('000011114444');
      const first = await h.notices('bank_details_to_approve');
      expect(first.length).toBeGreaterThan(0);
      expect(first.every((n) => n.priority === 'urgent'), 'a payment request is live').toBe(true);
      expect(first.map((n) => n.recipient_user_id)).toEqual(expect.arrayContaining(ids(MANAGER, MANAGER_AMD)));
      expect(first.map((n) => n.recipient_user_id)).not.toContain(PURCHASE.userId);
      await add('000011115555');
      const after = await h.notices('bank_details_to_approve');
      expect(after.filter((n) => first.some((f) => f.id === n.id)).every((n) => n.resolved_reason === 'superseded')).toBe(true);
    });
  });
});

describe('#19 cost_over_budget', () => {
  it('a proposed cost above budget is urgent to the branch Managers (existing Manager list rule); the approval resolves it', async () => {
    await asOwner(db, async () => {
      await h.addAcc2();
      const b = await h.book([{ ...HOTEL_ITEM, budget: '4500000' }]);
      await h.approve(b.versionId);
      const task = h.taskOf(b, 'hotel');
      await h.addRole(U.managerAhmedabad, 'manager', 'DEL');
      await h.addRole(U.managerAhmedabad, 'purchase', 'DEL');
      await h.noticesOn();
      await h.purchaseCost(task, await h.purchaseSupplier(), '5000000');
      const rows = await h.notices('cost_over_budget');
      // Lead note (10 Nov): #19 follows the existing Manager approvals list, which does not exclude a Manager holding Purchase.
      expect(rows.map((n) => n.recipient_user_id).sort()).toEqual(ids(MANAGER, MANAGER_AMD));
      expect(rows.every((n) => n.priority === 'urgent' && n.task_id === task)).toBe(true);
      await one(MANAGER, OVER_BUDGET_APPROVE, [task, 1]);
      expect((await h.notices('cost_over_budget')).every((n) => n.resolved_at)).toBe(true);
    });
  });
});

describe('#20 / #21 fares, #22 expense_returned, #7 task_completed (Flight)', () => {
  it('fare approval: urgent to the branch Managers, decided back to the requester', async () => {
    await asOwner(db, async () => {
      await h.addFlightPeople();
      await h.book([HOTEL_ITEM, { ...FLIGHT_ITEM, budget: '100000' }]);
      await h.claim(FLIGHT, DEAL);
      const task = (await owner<{ id: string }>(`select id from public.fulfilment_tasks where deal_id = $1 and department = 'flight'`, [DEAL]))[0]!.id;
      const [leg] = await h.sectors(task);
      const supplierId = await h.flightSupplier();
      await h.noticesOn();
      await one(FLIGHT, FARE_REQUEST, [DEAL, JSON.stringify({ sectorIds: [leg!.id], supplierId, fares: [fare('adult'), fare('child')],
        travellers: [1, 2, 3, 4].map((seq) => ({ seq })) }), rid()]);
      const rows = await h.notices('fare_to_approve');
      expect(rows.map((n) => n.recipient_user_id)).toEqual(ids(MANAGER));
      expect(rows.every((n) => n.priority === 'urgent')).toBe(true);
      const [a] = await owner<{ id: string; row_version: number }>(`select id, row_version from public.flight_fare_approvals where deal_id = $1 and status = 'pending'`, [DEAL]);
      await one(MANAGER, FARE_DECIDE, [a!.id, 'approve', null, a!.row_version, rid()]);
      expect((await h.notices('fare_to_approve')).every((n) => n.resolved_at)).toBe(true);
      expect((await h.notices('fare_decided')).map((n) => [n.recipient_user_id, n.priority])).toEqual([[FLIGHT.userId, 'normal']]);
    });
  });

  it('a returned Flight direct payment tells the assignee; the finished Flight group tells the Sales owner (#7)', async () => {
    await asOwner(db, async () => {
      await h.addAcc2();
      const b = await h.book([HOTEL_ITEM, FLIGHT_ITEM]);
      const batch = await h.flightBatch(DEAL, [1, 2, 3, 4]);
      await h.noticesOn();
      await h.directPay(batch.batchId);
      const [entry] = await owner<{ id: string; row_version: number }>('select id, row_version from public.department_cost_entries where flight_batch_id = $1', [batch.batchId]);
      await one(ACC, EXPENSE_RETURN, [entry!.id, entry!.row_version, 'Synthetic: the proof shows a different amount', rid()]);
      expect((await h.notices('expense_returned')).map((n) => n.recipient_user_id)).toEqual(ids(FLIGHT));
      // Fix and finish: direct payment again, e-ticket, group complete.
      const [again] = await owner<{ row_version: number }>('select row_version from public.department_cost_entries where id = $1', [entry!.id]);
      await one(FLIGHT, 'select public.flight_direct_payment_save($1, $2, $3::jsonb, $4) as r', [batch.batchId, again!.row_version, JSON.stringify({
        paymentMode: 'card', paidOn: h.today(), reference: null, proofEvidenceId: await h.evidence(FLIGHT, batch.flightTask, 'direct_payment_proof') }), rid()]);
      expect((await h.notices('expense_returned')).every((n) => n.resolved_at), 'resolved when it leaves returned').toBe(true);
      await h.evidence(FLIGHT, batch.flightTask, 'e_ticket');
      const flightTasks = b.tasks.filter((t) => t.department === 'flight').map((t) => t.id);
      await one(FLIGHT, GROUP_COMPLETE, [DEAL, flightTasks, rid()]);
      const done = await h.notices('task_completed');
      expect(done.map((n) => n.recipient_user_id)).toEqual(flightTasks.map(() => OWNER.userId));
      expect(done.every((n) => n.priority === 'normal')).toBe(true);
    });
  });
});

describe('kill switch on the same commands', () => {
  it('with notices off the same chain writes no notice rows', async () => {
    await asOwner(db, async () => {
      const { task } = await costedHotel();
      await h.noticesOn(false);
      await h.goAhead(task);
      const p = await h.purchaseRequest(task, 2_000_000);
      await h.payThrough(p.id, 'verified');
      await h.confirmSupplier(task);
      const [v] = await owner<{ id: string }>('select id from public.booking_versions where deal_id = $1', [DEAL]);
      await h.attempt(ACC, SQL.reviewReturn, [v!.id, REASON, rid()]);
      expect(await h.notices()).toEqual([]);
    });
  });
});
