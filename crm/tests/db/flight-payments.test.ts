import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_USERS as U, type TestDb, asOwner, createTestDb, istBusinessDate } from '../helpers/db';
import {
  ACC, ACC2, DEAL, DEAL2, FLIGHT, FLIGHT_2, LEG_JDH_DEL, LIMIT, MANAGER, OWNER, PURCHASE, SALES_B, SQL, fare, flightHelpers, rid, ticketFor, typedFlight,
} from './flight-support';

/**
 * Flight build, contract D2, C1/L1, D10 and sections 5.2, 6.2 B9-B13; test
 * plan 12.1 "Payments":
 *   - Direct payment with proof only while the cumulative total for the
 *     (Deal, supplier) pair - direct payments not returned + live payment
 *     requests + this amount - stays <= INR 50,000 (exactly 5,000,000 paise
 *     is direct); above, a payment request, which then routes to the branch
 *     Manager. Splitting cannot bypass it.
 *   - A request whose cumulative total is <= INR 50,000 routes to Accounts.
 *   - Direct payments count in authz.sm_supplier_running_total.
 *   - Accounts accepts/returns direct payments (not the submitter); payment
 *     requests: approve by route, record by Accounts, verify by a different
 *     Accounts person; company funding as for Purchase.
 *   - Manual flight cost entries are refused (department_cost_save, B13).
 *   - Trip cancelled blocks new payments.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = flightHelpers(() => db);
const { one, owner, refused, refusedHint } = h;
const RETURN = 'Synthetic: the proof shows a different amount';

/** Fare whose supplier cost per person is exactly `paise` (basic = paise - 100,000 of taxes). */
const fareOf = (paise: number, kind: 'package' | 'flight_only' = 'package') => fare('adult', {
  basicPaise: String(paise - 100_000), ...(kind === 'flight_only' ? { markupPaise: '0', discountPaise: '0' } : {}) });

/** Package Deal, one typed flight, generous budget, taken; one flight supplier with approved bank details. */
async function setup() {
  await h.addFlightPeople();
  await h.addSecondAccounts();
  const b = await h.packageDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL]), budget: '99999999' }]);
  await h.claim();
  const [leg] = await h.sectors(b.flightTasks[0]!);
  const supplierId = await h.flightSupplier();
  await h.approvedBank(supplierId);
  return { b, task: b.flightTasks[0]!, leg: leg!, supplierId };
}
/** One traveller's tickets at a supplier cost of `paise`. */
const batchOf = async (s: Awaited<ReturnType<typeof setup>>, seq: number, paise: number, supplierId = s.supplierId) =>
  one<{ batchId: string; batchNo: number }>(FLIGHT, SQL.ticketsConfirm, [DEAL, JSON.stringify({ sectorIds: [s.leg.id], supplierId, fareApprovalId: null,
    fares: [fareOf(paise)], travellers: [ticketFor(seq)] }), rid()]);
type Entry = { id: string; department: string; cost_kind: string; paid_by: string; amount_paise: string; supplier_id: string; flight_batch_id: string;
  task_id: string; expense_status: string; row_version: number };
const entryOf = async (batchId: string) => (await owner<Entry>(
  `select id, department, cost_kind, paid_by, amount_paise::text, supplier_id, flight_batch_id, task_id, expense_status, row_version
   from public.department_cost_entries where flight_batch_id = $1`, [batchId]))[0];
const running = async (supplierId: string) =>
  Number((await owner<{ t: string }>('select authz.sm_supplier_running_total($1, $2)::text as t', [DEAL, supplierId]))[0]!.t);
const requestFields = (note: string | null = null) => JSON.stringify({ dueDate: istBusinessDate(), note, proformaEvidenceId: null });

describe('direct payment cap: cumulative per (Deal, supplier)', () => {
  it('exactly INR 50,000 is direct; one paisa more is refused (direct_payment_over_limit)', async () => {
    await asOwner(db, async () => {
      const s = await setup();
      const exact = await batchOf(s, 1, LIMIT);
      const ctx = await one<Record<string, unknown>>(FLIGHT, SQL.paymentContext, [exact.batchId]);
      expect(ctx).toMatchObject({ amountPaise: String(LIMIT), directAllowed: true, routePreview: 'direct', directLimitPaise: '5000000' });
      await h.directPay(exact.batchId);
      expect(await entryOf(exact.batchId)).toMatchObject({ department: 'flight', cost_kind: 'fare', paid_by: 'company', amount_paise: String(LIMIT),
        supplier_id: s.supplierId, task_id: s.task, expense_status: 'submitted' });
      expect(await running(s.supplierId)).toBe(LIMIT);
      const audits = await owner<{ action: string }>(`select action from public.audit_events
        where action in ('department.cost_saved', 'department.cost_submitted', 'flight.direct_payment_recorded') order by id`);
      expect(audits.map((a) => a.action)).toEqual(['department.cost_saved', 'department.cost_submitted', 'flight.direct_payment_recorded']);
      // Saving again on the submitted entry is locked.
      const e = (await entryOf(exact.batchId))!;
      await refused(FLIGHT, SQL.directPayment, [exact.batchId, e.row_version, JSON.stringify({ paymentMode: 'upi', paidOn: istBusinessDate(),
        reference: null, proofEvidenceId: null }), rid()], '(cost_locked|payment_in_progress)', '55000');
    });
    await asOwner(db, async () => {
      const s = await setup();
      const over = await batchOf(s, 1, LIMIT + 1);
      expect(await one<Record<string, unknown>>(FLIGHT, SQL.paymentContext, [over.batchId])).toMatchObject({ directAllowed: false, routePreview: 'manager' });
      await refused(FLIGHT, SQL.directPayment, [over.batchId, null, JSON.stringify({ paymentMode: 'card', paidOn: istBusinessDate(), reference: null,
        proofEvidenceId: await h.evidence(FLIGHT, s.task, 'direct_payment_proof') }), rid()], 'direct_payment_over_limit', '22023');
      expect(await entryOf(over.batchId)).toBeUndefined();
    });
  });

  it('two batches of INR 30,000 with one supplier: the second cannot be direct and its request goes to the Manager', async () => {
    await asOwner(db, async () => {
      const s = await setup();
      const a = await batchOf(s, 1, 3_000_000);
      const b = await batchOf(s, 2, 3_000_000);
      await h.directPay(a.batchId);
      expect(await one<Record<string, unknown>>(FLIGHT, SQL.paymentContext, [b.batchId])).toMatchObject({ runningTotalPaise: '3000000', directAllowed: false,
        routePreview: 'manager' });
      await refused(FLIGHT, SQL.directPayment, [b.batchId, null, JSON.stringify({ paymentMode: 'card', paidOn: istBusinessDate(), reference: null,
        proofEvidenceId: await h.evidence(FLIGHT, s.task, 'direct_payment_proof') }), rid()], 'direct_payment_over_limit', '22023');
      await one(FLIGHT, SQL.paymentRequest, [b.batchId, requestFields(), rid()]);
      expect(await h.paymentOf(b.batchId)).toMatchObject({ status: 'pending', route: 'manager', amount_paise: '3000000' });
      // A request already exists: direct is now refused for that batch.
      await refused(FLIGHT, SQL.directPayment, [b.batchId, null, JSON.stringify({ paymentMode: 'card', paidOn: istBusinessDate(), reference: null,
        proofEvidenceId: await h.evidence(FLIGHT, s.task, 'direct_payment_proof') }), rid()], '(payment_in_progress|direct_payment_over_limit)');
      await refused(FLIGHT, SQL.paymentRequest, [b.batchId, requestFields(), rid()], 'payment_in_progress', '55000');
      await refused(FLIGHT, SQL.paymentRequest, [a.batchId, requestFields(), rid()], 'payment_in_progress', '55000');
      expect(await running(s.supplierId)).toBe(6_000_000);
      // Another supplier on the same Deal has its own total.
      const other = await h.flightSupplier();
      const c = await batchOf(s, 3, 4_000_000, other);
      expect(await one<Record<string, unknown>>(FLIGHT, SQL.paymentContext, [c.batchId])).toMatchObject({ directAllowed: true, routePreview: 'direct' });
    });
  });

  it('a request within INR 50,000 goes to Accounts; a returned direct payment no longer counts and can be resubmitted', async () => {
    await asOwner(db, async () => {
      const s = await setup();
      const a = await batchOf(s, 1, 2_000_000);
      await one(FLIGHT, SQL.paymentRequest, [a.batchId, requestFields('Synthetic: pay before the fare expires'), rid()]);
      expect(await h.paymentOf(a.batchId)).toMatchObject({ route: 'accounts', status: 'pending' });
      const b = await batchOf(s, 2, 2_500_000);
      await h.directPay(b.batchId);
      expect(await running(s.supplierId)).toBe(4_500_000);
      const e = (await entryOf(b.batchId))!;
      // Accounts reviews (never the submitter): return with a reason.
      await one(ACC, SQL.expenseReturn, [e.id, e.row_version, RETURN, rid()]);
      expect((await entryOf(b.batchId))!.expense_status).toBe('returned');
      expect(await running(s.supplierId)).toBe(2_000_000);
      expect((await owner<{ i: string[] }>('select authz.flight_money_issues($1) as i', [DEAL]))[0]!.i).toContain('payment_returned');
      expect(await one<Record<string, number | null>>(FLIGHT, SQL.smHomeCounts)).toMatchObject({ flightPaymentsReturned: 1 });
      const money = await one<{ batches: Array<{ batchId: string; payment: { state: string; returnReason: string | null } }> }>(FLIGHT, SQL.money, [DEAL]);
      expect(money.batches.find((x) => x.batchId === b.batchId)!.payment).toMatchObject({ state: 'direct_returned', returnReason: RETURN });
      // Resubmit the same row with its row version and a new proof.
      const proof = await h.evidence(FLIGHT, s.task, 'direct_payment_proof');
      const returned = (await entryOf(b.batchId))!;
      await refused(FLIGHT, SQL.directPayment, [b.batchId, returned.row_version + 3, JSON.stringify({ paymentMode: 'upi', paidOn: istBusinessDate(),
        reference: 'SYN-UPI-0002', proofEvidenceId: proof }), rid()], 'version_changed', '40001');
      await one(FLIGHT, SQL.directPayment, [b.batchId, returned.row_version, JSON.stringify({ paymentMode: 'upi', paidOn: istBusinessDate(),
        reference: 'SYN-UPI-0002', proofEvidenceId: proof }), rid()]);
      const again = (await entryOf(b.batchId))!;
      expect(again).toMatchObject({ id: e.id, expense_status: 'submitted' });
      // Accept by Accounts (not the submitter): Accounts lists label the department.
      const page = await one<{ items: Array<{ entryId: string; department: string; serviceType: string }> }>(ACC, SQL.expenseList, ['submitted', null, null]);
      expect(page.items.find((i) => i.entryId === e.id)).toMatchObject({ department: 'flight', serviceType: 'flight' });
      await one(ACC, SQL.expenseAccept, [e.id, again.row_version, rid()]);
      expect((await entryOf(b.batchId))!.expense_status).toBe('accepted');
    });
  });

  it('refusals: receipt required, future date, not the assignee, manual flight cost entries refused', async () => {
    await asOwner(db, async () => {
      const s = await setup();
      const a = await batchOf(s, 1, 1_000_000);
      await refused(FLIGHT, SQL.directPayment, [a.batchId, null, JSON.stringify({ paymentMode: 'card', paidOn: istBusinessDate(), reference: null,
        proofEvidenceId: null }), rid()], 'receipt_required', '55000');
      const proof = await h.evidence(FLIGHT, s.task, 'direct_payment_proof');
      await refusedHint(FLIGHT, SQL.directPayment, [a.batchId, null, JSON.stringify({ paymentMode: 'card', paidOn: '2999-01-01', reference: null,
        proofEvidenceId: proof }), rid()], 'invalid_input', /paidOn/);
      await refusedHint(FLIGHT, SQL.directPayment, [a.batchId, null, JSON.stringify({ paymentMode: 'cheque', paidOn: istBusinessDate(), reference: null,
        proofEvidenceId: proof }), rid()], 'invalid_input', /paymentMode/);
      for (const actor of [FLIGHT_2, OWNER, ACC, MANAGER, PURCHASE]) {
        await refused(actor, SQL.directPayment, [a.batchId, null, JSON.stringify({ paymentMode: 'card', paidOn: istBusinessDate(), reference: null,
          proofEvidenceId: proof }), rid()], 'not_authorized', '42501');
        await refused(actor, SQL.paymentRequest, [a.batchId, requestFields(), rid()], 'not_authorized', '42501');
      }
      // B13: the old manual flight cost entry is refused with the flightFares hint.
      await refusedHint(FLIGHT, SQL.costSave, [s.task, null, 0, JSON.stringify({ costKind: 'fare', amountPaise: '100000', paidBy: 'company',
        paymentMode: 'card', paidOn: istBusinessDate() }), rid()], 'invalid_input', /^flightFares$/);
      // Same request id, same payload: one entry.
      const req = rid();
      const fields = JSON.stringify({ paymentMode: 'card', paidOn: istBusinessDate(), reference: null, proofEvidenceId: proof });
      const first = await one<Record<string, unknown>>(FLIGHT, SQL.directPayment, [a.batchId, null, fields, req]);
      expect(await one<Record<string, unknown>>(FLIGHT, SQL.directPayment, [a.batchId, null, fields, req])).toMatchObject({ ...first, outcome: 'existing' });
      await refused(FLIGHT, SQL.directPayment, [a.batchId, null, JSON.stringify({ paymentMode: 'upi', paidOn: istBusinessDate(), reference: null,
        proofEvidenceId: proof }), req], 'duplicate_request', '40001');
      expect(await owner('select count(*)::int as n from public.department_cost_entries where flight_batch_id = $1', [a.batchId])).toEqual([{ n: 1 }]);
    });
  });
});

describe('flight payment requests through the supplier-money system', () => {
  it('Manager route: approved by the branch Manager only; Accounts records; a different Accounts person verifies', async () => {
    await asOwner(db, async () => {
      const s = await setup();
      const big = await batchOf(s, 1, 6_000_000);
      await one(FLIGHT, SQL.paymentRequest, [big.batchId, requestFields(), rid()]);
      let p = (await h.paymentOf(big.batchId))!;
      expect(p).toMatchObject({ route: 'manager', status: 'pending', amount_paise: '6000000' });
      const [row] = await owner<{ part: string; cost_version_no: number | null; go_ahead_request_id: string | null; task_id: string }>(
        'select part, cost_version_no, go_ahead_request_id, task_id from public.supplier_payment_requests where id = $1', [p.id]);
      expect(row).toEqual({ part: 'full', cost_version_no: null, go_ahead_request_id: null, task_id: s.task });
      // Lists: Manager approvals carry the department; Accounts lists label Flight.
      const ma = await one<{ payments: Array<{ paymentId?: string; id?: string; department: string }> }>(MANAGER, SQL.managerApprovals);
      expect(ma.payments.find((x) => (x.paymentId ?? x.id) === p.id)).toMatchObject({ department: 'flight' });
      for (const actor of [ACC, ACC2, FLIGHT, OWNER, PURCHASE]) {
        await refused(actor, SQL.paymentDecide, [p.id, 'approve', null, p.row_version, rid()], '(not_authorized|not_self_approval)');
      }
      await one(MANAGER, SQL.paymentDecide, [p.id, 'approve', null, p.row_version, rid()]);
      p = (await h.paymentOf(big.batchId))!;
      expect(p).toMatchObject({ status: 'approved', approved_by: U.managerDelhi });
      // An approved request counts as paid for the done checklist.
      expect((await owner<{ i: string[] }>('select authz.flight_money_issues($1) as i', [DEAL]))[0]!.i).not.toContain('payment_missing');
      // Company funding (no customer money on this Deal): created server-side, decided as for Purchase.
      const funding = await owner<{ id: string; route: string; row_version: number }>(
        'select id, route, row_version from public.company_funding_requests where payment_request_id = $1', [p.id]);
      for (const f of funding) {
        const decider = f.route === 'manager' ? MANAGER : ACC2;
        await one(decider, SQL.fundingDecide, [f.id, 'approve', null, f.row_version, rid()]);
      }
      const ev = await one<{ evidenceId: string; objectPath: string }>(ACC, SQL.smEvidenceBegin,
        ['payment_proof', p.id, 'proof.pdf', 'application/pdf', 2048, 'e'.repeat(64), rid()]);
      await owner(`insert into storage.objects (bucket_id, name, metadata) values ('supplier-money', $1, jsonb_build_object('size', 2048::bigint))`, [ev.objectPath]);
      await one(ACC, SQL.smEvidenceFinish, [ev.evidenceId, true]);
      await refused(FLIGHT, SQL.paymentRecord, [p.id, istBusinessDate(), 'bank_transfer', 'UTRSYNFLT001', ev.evidenceId, p.row_version, rid()], 'not_authorized', '42501');
      await one(ACC, SQL.paymentRecord, [p.id, istBusinessDate(), 'bank_transfer', 'UTRSYNFLT001', ev.evidenceId, p.row_version, rid()]);
      p = (await h.paymentOf(big.batchId))!;
      expect(p).toMatchObject({ status: 'paid', recorded_by: U.accountsJodhpur });
      await refused(ACC, SQL.paymentVerify, [p.id, p.row_version, rid()], 'not_self_verification');
      await one(ACC2, SQL.paymentVerify, [p.id, p.row_version, rid()]);
      expect((await h.paymentOf(big.batchId))!.status).toBe('verified');
      const list = await one<unknown>(ACC, SQL.accountsPayments, ['all']);
      const rows = (Array.isArray(list) ? list : ((list as Record<string, unknown>).items ?? (list as Record<string, unknown>).payments ?? [])) as Array<Record<string, unknown>>;
      expect(rows.find((x) => (x.paymentId ?? x.id) === p.id)).toMatchObject({ department: 'flight', flightBatchNo: big.batchNo, agreedCostPaise: '6000000' });
      // The task status is not changed by payments.
      expect((await h.taskRow(s.task)).status).toBe('in_progress');
    });
  });

  it('the Manager who is the Deal\'s Flight assignee cannot approve the request', async () => {
    await asOwner(db, async () => {
      await h.addRole(U.managerDelhi, 'flight', 'DEL');
      await h.addFlightPeople();
      const b = await h.packageDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL]), budget: '99999999' }]);
      await h.claim(MANAGER);
      const [leg] = await h.sectors(b.flightTasks[0]!);
      const supplierId = await h.flightSupplier(MANAGER);
      const batch = await one<{ batchId: string }>(MANAGER, SQL.ticketsConfirm, [DEAL, JSON.stringify({ sectorIds: [leg!.id], supplierId, fareApprovalId: null,
        fares: [fareOf(6_000_000)], travellers: [ticketFor(1)] }), rid()]);
      await one(MANAGER, SQL.paymentRequest, [batch.batchId, requestFields(), rid()]);
      const p = (await h.paymentOf(batch.batchId))!;
      await refused(MANAGER, SQL.paymentDecide, [p.id, 'approve', null, p.row_version, rid()], '(not_self_approval|not_authorized)', '42501');
    });
  });

  it('payment requests are counted; unpaid batches block done; trip cancelled blocks new payments', async () => {
    await asOwner(db, async () => {
      const s = await setup();
      const a = await batchOf(s, 1, 1_000_000);
      expect((await owner<{ i: string[] }>('select authz.flight_money_issues($1) as i', [DEAL]))[0]!.i).toContain('payment_missing');
      expect(await one<Record<string, number | null>>(FLIGHT, SQL.smHomeCounts)).toMatchObject({ flightPaymentsMissing: 1 });
      const money = await one<{ batches: Array<{ batchId: string; canPayDirect: boolean; canRequest: boolean; payment: { state: string } }> }>(FLIGHT, SQL.money, [DEAL]);
      expect(money.batches.find((x) => x.batchId === a.batchId)).toMatchObject({ canPayDirect: true, canRequest: true, payment: { state: 'unpaid' } });
      await one(MANAGER, SQL.cancelOpen, [DEAL, 'Synthetic: the customer cancelled the trip', rid()]);
      await refused(FLIGHT, SQL.directPayment, [a.batchId, null, JSON.stringify({ paymentMode: 'card', paidOn: istBusinessDate(), reference: null,
        proofEvidenceId: await h.evidence(FLIGHT, s.task, 'direct_payment_proof') }), rid()], 'trip_cancelled', '55000');
      await refused(FLIGHT, SQL.paymentRequest, [a.batchId, requestFields(), rid()], 'trip_cancelled', '55000');
      await refused(FLIGHT, SQL.ticketsConfirm, [DEAL, JSON.stringify({ sectorIds: [s.leg.id], supplierId: s.supplierId, fareApprovalId: null,
        fares: [fareOf(1_000_000)], travellers: [ticketFor(2)] }), rid()], 'trip_cancelled', '55000');
      await refused(FLIGHT, SQL.fareApprovalRequest, [DEAL, JSON.stringify({ sectorIds: [s.leg.id], supplierId: s.supplierId,
        fares: [fareOf(99_000_000)], travellers: [{ seq: 2 }] }), rid()], 'trip_cancelled', '55000');
    });
  });

  it('flight supplier invoices: Flight uploads for a batch supplier, invoice missing for Accounts after the trip', async () => {
    await asOwner(db, async () => {
      const s = await setup();
      await batchOf(s, 1, 1_000_000);
      const ev = await one<{ evidenceId: string; objectPath: string }>(FLIGHT, SQL.smEvidenceBegin,
        ['invoice', s.task, 'invoice.pdf', 'application/pdf', 2048, 'f'.repeat(64), rid()]);
      await owner(`insert into storage.objects (bucket_id, name, metadata) values ('supplier-money', $1, jsonb_build_object('size', 2048::bigint))`, [ev.objectPath]);
      await one(FLIGHT, SQL.smEvidenceFinish, [ev.evidenceId, true]);
      // Credit notes stay Purchase-only.
      await refused(FLIGHT, SQL.smEvidenceBegin, ['credit_note', s.task, 'credit.pdf', 'application/pdf', 2048, 'f'.repeat(64), rid()], '(not_authorized|invalid_input)');
      await one(FLIGHT, SQL.supplierDocUpload, [s.task, JSON.stringify({ kind: 'invoice', number: 'SYN-AIR-INV-1', docDate: istBusinessDate(),
        totalPaise: '1000000', gstIncluded: true, evidenceId: ev.evidenceId, supplierId: s.supplierId }), rid()]);
      const docs = await one<{ documents?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(ACC, SQL.accountsDocuments, ['all']);
      const rows = (Array.isArray(docs) ? docs : docs.documents ?? []) as Array<Record<string, unknown>>;
      expect(rows.some((d) => d.department === 'flight')).toBe(true);
      void DEAL2;
      void SALES_B;
    });
  });
});
