import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { supplierGet, supplierList } from '@/modules/procurement/commands';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { rpcAs } from './b12-ts-support';
import {
  ACC,
  DEAL,
  DEAL2,
  FLIGHT,
  LEG_DEL_GOI,
  LEG_JDH_DEL,
  MANAGER,
  OWNER,
  PURCHASE,
  SALES_B,
  SQL,
  confirmFields,
  fare,
  flightHelpers,
  rid,
  ticketFor,
  typedFlight,
} from './flight-support';

/**
 * Track B author's smoke test for the flight money migrations
 * (20261201000200..0220). The independent suites are Track D's
 * flight-*.test.ts. Covers: fares and generated totals, the package/flight-only
 * markup rule, the over-budget Manager approval bound to the fare hash, the
 * cumulative INR 50,000 direct-payment cap per (Deal, supplier) counted with
 * live requests, the flight branch of supplier payment requests, the money
 * checklist tokens, the money fence of flight_money, Accounts/Manager rows and
 * the refused manual flight cost form.
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

type Batch = { batchId: string; batchNo: number; ticketCount: number; travellersConfirmed: number; stillPending: number };
type Money = {
  dealKind: string;
  supplierCostPaise: string;
  overBudget: boolean;
  customerTotalPaise: string | null;
  batches: Array<Record<string, unknown> & { fares: Array<Record<string, unknown>>; payment: Record<string, unknown> }>;
  approvals: Array<Record<string, unknown>>;
  supplierTotals: Array<Record<string, unknown>>;
};

const moneyIssues = async (deal: string = DEAL) =>
  (await owner<{ i: string[] }>('select authz.flight_money_issues($1) as i', [deal]))[0]!.i;

/** Package Deal (hotel + one typed flight JDH-DEL-GOI, budget INR 28,000), taken by FLIGHT, with a flight supplier. */
async function packageSetup() {
  await h.addFlightPeople();
  await h.addSecondAccounts();
  const booked = await h.packageDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL, LEG_DEL_GOI]) }]);
  await h.claim(FLIGHT, DEAL);
  const sectors = (await h.sectors(booked.flightTasks[0]!)).map((s) => s.id);
  const supplierId = await h.flightSupplier();
  await h.approvedBank(supplierId);
  return { booked, sectors, supplierId, taskId: booked.flightTasks[0]! };
}

describe('flight money: package Deal', () => {
  it('fares, approval, cap, request route, checklist tokens and the fence', async () => {
    await asOwner(db, async () => {
      const { sectors, supplierId, taskId } = await packageSetup();

      // Owner D4: no markup or discount on a package Deal.
      await refusedHint(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmFields({ sectorIds: sectors, supplierId,
        fares: [fare('adult', { markupPaise: '0' })], travellers: [ticketFor(1), ticketFor(2)] }), rid()], 'invalid_input', /markupPaise/);

      // Within budget: 2 adults x INR 6,000 = INR 12,000 <= INR 28,000.
      const preview = await one<Record<string, unknown>>(FLIGHT, SQL.farePreview, [DEAL, confirmFields({ sectorIds: sectors, supplierId,
        fares: [fare('adult')], travellers: [ticketFor(1), ticketFor(2)] })]);
      expect(preview).toMatchObject({ batchSupplierCostPaise: '1200000', batchCustomerTotalPaise: null, overBudget: false,
        dealBudgetPaise: '2800000', approval: null, costTaskId: taskId });
      expect(String(preview.fareHash)).toMatch(/^[0-9a-f]{64}$/);
      await refused(FLIGHT, SQL.fareApprovalRequest, [DEAL, confirmFields({ sectorIds: sectors, supplierId, fares: [fare('adult')],
        travellers: [ticketFor(1), ticketFor(2)] }), rid()], 'not_over_budget', '55000');

      const b1 = await h.confirmTickets({ sectorIds: sectors, supplierId, seqs: [1, 2] });
      expect(b1).toMatchObject({ batchNo: 1, ticketCount: 4, travellersConfirmed: 2, stillPending: 4 });
      const [fares1] = await owner<{ supplier_per_person_paise: string; total_per_person_paise: string; markup_paise: string | null }>(
        'select supplier_per_person_paise::text, total_per_person_paise::text, markup_paise::text from public.flight_batch_fares where batch_id = $1', [b1.batchId]);
      expect(fares1).toEqual({ supplier_per_person_paise: '600000', total_per_person_paise: '600000', markup_paise: null });
      await refused(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmFields({ sectorIds: sectors, supplierId, fares: [fare('adult')],
        travellers: [ticketFor(1)] }), rid()], 'already_confirmed', '55000');

      // Direct payment of batch 1 (INR 12,000) with proof; Accounts (not the submitter) accepts.
      const paid = await h.directPay(b1.batchId);
      expect(paid).toMatchObject({ outcome: 'created', expenseStatus: 'submitted' });
      const [running1] = await owner<{ t: string }>('select authz.sm_supplier_running_total($1, $2)::text as t', [DEAL, supplierId]);
      expect(running1!.t).toBe('1200000');
      await one(ACC, SQL.expenseAccept, [paid.entryId, paid.rowVersion, rid()]);

      // Batch 2: travellers 3 (adult) and 4 (child) at INR 21,000 each: Deal INR 54,000 > budget INR 28,000.
      const big = (t: 'adult' | 'child') => fare(t, { basicPaise: '2000000' });
      const fields2 = { sectorIds: sectors, supplierId, fares: [big('adult'), big('child')], travellers: [ticketFor(3), ticketFor(4)] };
      await refused(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmFields(fields2), rid()], 'over_budget', '55000');
      // Fares go to the Manager before ticket details exist (passenger lines: seq only).
      const asked = await one<{ approvalId: string; rowVersion: number; fareHash: string }>(FLIGHT, SQL.fareApprovalRequest,
        [DEAL, JSON.stringify({ sectorIds: sectors, supplierId, fareApprovalId: null, fares: fields2.fares, travellers: [{ seq: 3 }, { seq: 4 }] }), rid()]);
      // The approved fare set can be read back (popup after a reload); never by Purchase.
      const sets = await one<Array<Record<string, unknown> & { fares: Array<Record<string, unknown>> }>>(MANAGER,
        'select public.flight_fare_approval_sets($1) as r', [DEAL]);
      expect(sets).toHaveLength(1);
      expect(sets[0]).toMatchObject({ approvalId: asked.approvalId, status: 'pending', supplierId,
        travellers: [{ seq: 3, type: 'adult' }, { seq: 4, type: 'child' }] });
      expect(sets[0]!.fares[0]).toEqual({ paxType: 'adult', basicPaise: '2000000', kPaise: '50000', yqPaise: '30000', yrPaise: '10000',
        otherPaise: '10000', paxCount: 1 });
      expect(await one(PURCHASE, 'select public.flight_fare_approval_sets($1) as r', [DEAL])).toBeNull();
      expect(await moneyIssues()).toEqual(['fare_approval_pending']);
      const homeM = await one<Record<string, number | null>>(MANAGER, SQL.smHomeCounts, []);
      expect(homeM.flightFaresToApprove).toBe(1);
      const approvals = await one<{ flightFares: Array<Record<string, unknown>> }>(MANAGER, SQL.managerApprovals, []);
      expect(approvals.flightFares).toHaveLength(1);
      expect(approvals.flightFares[0]).toMatchObject({ approvalId: asked.approvalId, batchSupplierCostPaise: '4200000',
        projectedSupplierCostPaise: '5400000', budgetPaise: '2800000', canApprove: true });
      await refused(FLIGHT, SQL.fareApprovalDecide, [asked.approvalId, 'approve', null, asked.rowVersion, rid()], 'not_authorized', '42501');
      await one(MANAGER, SQL.fareApprovalDecide, [asked.approvalId, 'approve', null, asked.rowVersion, rid()]);
      // Changed fares no longer match the approved hash.
      await refused(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmFields({ ...fields2, fares: [big('adult'), fare('child', { basicPaise: '2000001' })],
        fareApprovalId: asked.approvalId }), rid()], 'fare_approval_mismatch', '55000');
      const b2 = await one<Batch>(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmFields({ ...fields2, travellers: [ticketFor(3), ticketFor(4)],
        fareApprovalId: asked.approvalId }), rid()]);
      expect(b2).toMatchObject({ batchNo: 2, ticketCount: 4, stillPending: 0 });
      const [used] = await owner<{ status: string }>('select status from public.flight_fare_approvals where id = $1', [asked.approvalId]);
      expect(used!.status).toBe('used');

      // C1: INR 12,000 direct + INR 42,000 = INR 54,000 > INR 50,000: no direct payment; the request goes to the Manager.
      const proof = await h.evidence(FLIGHT, taskId, 'direct_payment_proof');
      await refused(FLIGHT, SQL.directPayment, [b2.batchId, null, JSON.stringify({ paymentMode: 'card', paidOn: h.today(),
        reference: 'SYN-CARD-2', proofEvidenceId: proof }), rid()], 'direct_payment_over_limit', '22023');
      expect(await moneyIssues()).toEqual(['payment_missing']);
      const req = await one<{ id: string; route: string; status: string }>(FLIGHT, SQL.paymentRequest,
        [b2.batchId, JSON.stringify({ dueDate: null, note: 'Synthetic consolidator invoice' }), rid()]);
      expect(req).toMatchObject({ route: 'manager', status: 'pending' });
      await refused(FLIGHT, SQL.paymentRequest, [b2.batchId, JSON.stringify({}), rid()], 'payment_in_progress', '55000');
      const [row] = await owner<{ part: string; cost_version_no: number | null; amount_paise: string }>(
        'select part, cost_version_no, amount_paise::text from public.supplier_payment_requests where id = $1', [req.id]);
      expect(row).toEqual({ part: 'full', cost_version_no: null, amount_paise: '4200000' });

      // Accounts list labels the department; the Manager approves the request.
      const accounts = await one<Array<Record<string, unknown>>>(ACC, SQL.accountsPayments, ['all']);
      expect(accounts.find((r) => r.id === req.id)).toMatchObject({ department: 'flight', flightBatchNo: 2, agreedCostPaise: '4200000',
        costVersionNo: null });
      const [pm] = await owner<{ row_version: number }>('select row_version from public.supplier_payment_requests where id = $1', [req.id]);
      await one(MANAGER, SQL.paymentDecide, [req.id, 'approve', null, pm!.row_version, rid()]);
      expect(await moneyIssues()).toEqual([]);

      const full = await one<Money>(FLIGHT, SQL.money, [DEAL]);
      expect(full).toMatchObject({ dealKind: 'package', supplierCostPaise: '5400000', overBudget: true, marginsAllowed: false });
      expect(full).not.toHaveProperty('customerTotalPaise');
      expect(full.batches.map((b) => b.payment.state)).toEqual(['direct_accepted', 'request_approved']);
      // Flight never sees a company funding hold.
      expect(full.batches[1]!.payment).toMatchObject({ route: 'manager', onHold: false, holdReason: null });
      expect(full.batches[1]!.fares).toHaveLength(2);
      expect(Object.keys(full.batches[1]!.fares[0]!)).not.toContain('markupPaise');
      expect(full.supplierTotals).toEqual([{ supplierId, supplierName: expect.any(String), runningTotalPaise: '5400000' }]);
      // The Sales owner of a package Deal: supplier cost vs budget and payment state only (other keys absent).
      const so = await one<Money>(OWNER, SQL.money, [DEAL]);
      expect(Object.keys(so).sort()).toEqual(['batches', 'budget', 'dealKind', 'marginsAllowed', 'overBudget', 'supplierCostPaise']);
      expect(so.batches[0]!.payment).toEqual({ state: 'direct_accepted' });
      expect(so.batches[0]).not.toHaveProperty('fares');
      expect(so.batches[0]).not.toHaveProperty('canPayDirect');
      // The Manager sees fares but not the Flight person's action ids.
      const mgr = await one<Money>(MANAGER, SQL.money, [DEAL]);
      expect(mgr.batches[1]!.fares).toHaveLength(2);
      expect(mgr.batches[1]!.payment).not.toHaveProperty('paymentId');
      expect(mgr.batches[1]).not.toHaveProperty('canRequest');
      expect(await one(PURCHASE, SQL.money, [DEAL])).toBeNull();
      // (Visa Jodhpur is also the second Accounts person in this scenario: no pure-Visa check here.)
      expect(await one(SALES_B, SQL.money, [DEAL])).toBeNull();

      // R9: Purchase cannot retype or edit a flight supplier.
      const [sup] = await owner<{ row_version: number }>('select row_version from public.suppliers where id = $1', [supplierId]);
      await refused(PURCHASE, 'select public.supplier_update($1, $2, $3::jsonb) as r', [supplierId, sup!.row_version,
        JSON.stringify({ name: 'Synthetic Retyped', serviceTypes: ['hotel'] })], 'not_authorized', '42501');
      // L15: Flight edits and archives its own supplier; details changed = unverified again.
      const listed = await one<Array<{ supplierId: string; rowVersion: number; contactEmail: string | null }>>(FLIGHT, SQL.supplierList, []);
      const mine = listed.find((x) => x.supplierId === supplierId)!;
      expect(mine.contactEmail).toBe('air.desk@example.test');
      const upd = { name: 'Synthetic Air Consolidator Renamed', city: 'Synthetic City', contactName: null, contactPhone: null,
        contactEmail: 'air.desk@example.test' };
      await refused(PURCHASE, 'select public.flight_supplier_update($1, $2, $3::jsonb) as r', [supplierId, mine.rowVersion,
        JSON.stringify(upd)], 'not_authorized', '42501');
      const saved = await one<{ rowVersion: number }>(FLIGHT, 'select public.flight_supplier_update($1, $2, $3::jsonb) as r',
        [supplierId, mine.rowVersion, JSON.stringify(upd)]);
      await refused(FLIGHT, 'select public.flight_supplier_update($1, $2, $3::jsonb) as r', [supplierId, mine.rowVersion,
        JSON.stringify(upd)], 'version_changed', '40001');
      const [after] = await owner<{ service_types: string[]; verification_status: string }>(
        'select service_types, verification_status from public.suppliers where id = $1', [supplierId]);
      expect(after).toEqual({ service_types: ['flight'], verification_status: 'unverified' });
      expect(saved.rowVersion).toBe(mine.rowVersion + 1);

      // B13: the manual flight cost form is refused.
      await refusedHint(FLIGHT, SQL.costSave, [taskId, null, 0, JSON.stringify({ costKind: 'fare', amountPaise: '100', paidBy: 'company',
        paymentMode: 'card', paidOn: h.today() }), rid()], 'invalid_input', /^flightFares$/);
      // The audit trail carries no amounts.
      const audit = JSON.stringify(await owner(`select details from public.audit_events where action like 'flight.%'`));
      expect(audit).not.toMatch(/1200000|4200000|5400000/);
    });
  });
});

describe('flight money: flight-only Deal', () => {
  it('markup and discount required; discount over fare refused; customer totals for the Sales owner', async () => {
    await asOwner(db, async () => {
      await h.addFlightPeople();
      const booked = await h.flightOnlyDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL], 4) }], { deal: DEAL2, actor: SALES_B });
      await h.claim(FLIGHT, DEAL2);
      const sectors = (await h.sectors(booked.flightTasks[0]!)).map((s) => s.id);
      const supplierId = await h.flightSupplier();
      const base = { sectorIds: sectors, supplierId, travellers: [ticketFor(1)] };
      await refusedHint(FLIGHT, SQL.ticketsConfirm, [DEAL2, confirmFields({ ...base, fares: [fare('adult')] }), rid()], 'invalid_input',
        /markupPaise/);
      await refused(FLIGHT, SQL.ticketsConfirm, [DEAL2, confirmFields({ ...base,
        fares: [fare('adult', { markupPaise: '50000', discountPaise: '700000' })] }), rid()], 'discount_over_fare', '22023');
      const b = await one<Batch>(FLIGHT, SQL.ticketsConfirm, [DEAL2, confirmFields({ ...base, travellers: [ticketFor(1)],
        fares: [fare('adult', { markupPaise: '100000', discountPaise: '20000' })] }), rid()]);
      const so = await one<Money>(SALES_B, SQL.money, [DEAL2]);
      expect(so).toMatchObject({ dealKind: 'flight_only', customerTotalPaise: '680000', marginsAllowed: true });
      expect(so.batches[0]!.fares[0]).toMatchObject({ markupPaise: '100000', discountPaise: '20000', totalPerPersonPaise: '680000',
        supplierAmountPaise: '600000', customerAmountPaise: '680000' });
      expect(so.batches[0]!.customerTotalPaise).toBe('680000');
      const ctx = await one<Record<string, unknown>>(FLIGHT, SQL.paymentContext, [b.batchId]);
      expect(ctx).toMatchObject({ amountPaise: '600000', routePreview: 'direct', directAllowed: true, directLimitPaise: '5000000' });
      expect(await one(OWNER, SQL.paymentContext, [b.batchId])).toBeNull();
    });
  });
});

describe('review fixes (20261201000250)', () => {
  it('L18: an old-form flight payment links to the first batch; only the rest is paid; counted in the cap', async () => {
    await asOwner(db, async () => {
      const { sectors, supplierId, taskId } = await packageSetup();
      // A live old-form entry: company paid INR 5,000, accepted by Accounts (written as the table owner, as on live).
      const [legacy] = await owner<{ id: string }>(
        `insert into public.department_cost_entries (task_id, deal_id, legal_entity_id, branch_id, department, cost_kind, amount_paise,
           paid_by, payment_mode, paid_on, expense_status, submitted_by, submitted_at, reviewed_by, reviewed_at, request_id, created_by)
         select t.id, t.deal_id, t.legal_entity_id, t.branch_id, 'flight', 'fare', 500000, 'company', 'card', current_date - 1,
           'accepted', $2, now(), $3, now(), gen_random_uuid(), $2
         from public.fulfilment_tasks t where t.id = $1 returning id`, [taskId, FLIGHT.userId, ACC.userId]);
      const b = await h.confirmTickets({ sectorIds: sectors, supplierId, seqs: [1, 2] });
      expect(await owner('select entry_id, batch_id from public.flight_batch_legacy_costs')).toEqual([{ entry_id: legacy!.id, batch_id: b.batchId }]);
      const ctx = await one<Record<string, unknown>>(FLIGHT, SQL.paymentContext, [b.batchId]);
      expect(ctx).toMatchObject({ amountPaise: '700000', supplierCostPaise: '1200000', legacyPaidPaise: '500000', runningTotalPaise: '500000' });
      expect(await moneyIssues()).toEqual(['payment_missing']);
      const paid = await h.directPay(b.batchId);
      const [entry] = await owner<{ amount_paise: string }>('select amount_paise::text from public.department_cost_entries where id = $1', [paid.entryId]);
      expect(entry!.amount_paise).toBe('700000');
      const [running] = await owner<{ t: string }>('select authz.sm_supplier_running_total($1, $2)::text as t', [DEAL, supplierId]);
      expect(running!.t).toBe('1200000');
      expect(await moneyIssues()).toEqual([]);
      const money = await one<Money>(FLIGHT, SQL.money, [DEAL]);
      expect(money.batches[0]).toMatchObject({ legacyPaidPaise: '500000', duePaise: '700000' });
    });
  });

  it('L18: old-form payments covering the whole batch make it paid; nothing more can be paid', async () => {
    await asOwner(db, async () => {
      const { sectors, supplierId, taskId } = await packageSetup();
      await owner(
        `insert into public.department_cost_entries (task_id, deal_id, legal_entity_id, branch_id, department, cost_kind, amount_paise,
           paid_by, payment_mode, paid_on, expense_status, submitted_by, submitted_at, request_id, created_by)
         select t.id, t.deal_id, t.legal_entity_id, t.branch_id, 'flight', 'fare', 1200000, 'company', 'card', current_date - 1,
           'submitted', $2, now(), gen_random_uuid(), $2
         from public.fulfilment_tasks t where t.id = $1`, [taskId, FLIGHT.userId]);
      const b = await h.confirmTickets({ sectorIds: sectors, supplierId, seqs: [1, 2] });
      const money = await one<Money>(FLIGHT, SQL.money, [DEAL]);
      expect(money.batches[0]).toMatchObject({ duePaise: '0', canPayDirect: false, canRequest: false });
      expect(money.batches[0]!.payment).toMatchObject({ state: 'direct_submitted', route: 'direct' });
      expect(await moneyIssues()).toEqual([]);
      await refused(FLIGHT, SQL.paymentRequest, [b.batchId, JSON.stringify({}), rid()], 'not_ready', '55000');
    });
  });

  it('Flight + Purchase holder may not enter markup or discount on a flight-only Deal; package Deals as before', async () => {
    await asOwner(db, async () => {
      await h.addFlightPeople();
      const fo = await h.flightOnlyDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL], 4) }], { deal: DEAL2, actor: SALES_B });
      await h.claim(FLIGHT, DEAL2);
      const foSectors = (await h.sectors(fo.flightTasks[0]!)).map((s) => s.id);
      const supplierId = await h.flightSupplier();
      await h.addRole(FLIGHT.userId!, 'purchase');
      const foFields = confirmFields({ sectorIds: foSectors, supplierId, travellers: [ticketFor(1)],
        fares: [fare('adult', { markupPaise: '100000', discountPaise: '20000' })] });
      for (const [sql, params] of [[SQL.ticketsConfirm, [DEAL2, foFields, rid()]], [SQL.farePreview, [DEAL2, foFields]],
        [SQL.fareApprovalRequest, [DEAL2, foFields, rid()]]] as Array<[string, unknown[]]>) {
        expect(await refusedHint(FLIGHT, sql, params, 'not_authorized', /^purchase_holder_margin$/)).toBe('purchase_holder_margin');
      }
      expect(await owner('select id from public.flight_ticket_batches where deal_id = $1', [DEAL2])).toEqual([]);
      // Package Deal: no markup or discount, so the same person confirms as before.
      const pkg = await h.packageDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL]) }]);
      await h.claim(FLIGHT, DEAL);
      const pkgSectors = (await h.sectors(pkg.flightTasks[0]!)).map((s) => s.id);
      expect((await h.confirmTickets({ sectorIds: pkgSectors, supplierId, seqs: [1] })).batchNo).toBe(1);
    });
  });

  it('Flight + Purchase holder: supplier-side fares only, never markup, discount or customer totals', async () => {
    await asOwner(db, async () => {
      await h.addFlightPeople();
      const booked = await h.flightOnlyDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL], 4) }], { deal: DEAL2, actor: SALES_B });
      await h.claim(FLIGHT, DEAL2);
      const sectors = (await h.sectors(booked.flightTasks[0]!)).map((s) => s.id);
      const supplierId = await h.flightSupplier();
      await one(FLIGHT, SQL.ticketsConfirm, [DEAL2, confirmFields({ sectorIds: sectors, supplierId, travellers: [ticketFor(1)],
        fares: [fare('adult', { markupPaise: '100000', discountPaise: '20000' })] }), rid()]);
      await h.addRole(FLIGHT.userId!, 'purchase');
      const m = await one<Money>(FLIGHT, SQL.money, [DEAL2]);
      const text = JSON.stringify(m);
      expect(text).not.toMatch(/markupPaise|discountPaise|totalPerPersonPaise|customerAmountPaise|customerTotalPaise/);
      expect(m.batches[0]!.fares[0]).toMatchObject({ basicPaise: '500000', supplierPerPersonPaise: '600000' });
      expect(m).toMatchObject({ marginsAllowed: false });
    });
  });
});

describe('flight suppliers stay out of the Purchase register (20261201000280)', () => {
  it('a flight supplier exists: Purchase and Manager supplier reads parse with the Purchase schemas and leave it out', async () => {
    await asOwner(db, async () => {
      await h.addFlightPeople();
      const flightSupplierId = await h.flightSupplier();
      const [entity] = await owner<{ id: string }>(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`);
      const { supplierId: hotelSupplierId } = await one<{ supplierId: string }>(PURCHASE, 'select public.supplier_create($1, $2::jsonb) as r', [entity!.id,
        JSON.stringify({ name: `Synthetic Hotel Supplier ${rid().slice(0, 6)}`, serviceTypes: ['hotel'], city: 'Synthetic City', contactName: null,
          contactPhone: null, contactEmail: 'desk@example.test', paymentTerms: null })]);
      for (const actor of [PURCHASE, MANAGER]) {
        // The real TS wrappers (zod schemas accept hotel/transfer/activity only) must not throw.
        const list = await supplierList(rpcAs(() => db, actor));
        expect(list.some((x) => x.supplierId === flightSupplierId)).toBe(false);
        expect(list.some((x) => x.supplierId === hotelSupplierId)).toBe(true);
        expect(await supplierGet(rpcAs(() => db, actor), flightSupplierId)).toBeNull();
        expect((await supplierGet(rpcAs(() => db, actor), hotelSupplierId))?.supplierId).toBe(hotelSupplierId);
      }
      // Flight still lists it; the Manager still verifies it from Approvals.
      expect((await one<Array<{ supplierId: string }>>(FLIGHT, SQL.supplierList, [])).some((x) => x.supplierId === flightSupplierId)).toBe(true);
      const ap = await one<{ suppliersToVerify: Array<{ supplierId: string }> }>(MANAGER, SQL.managerApprovals, []);
      expect(ap.suppliersToVerify.some((x) => x.supplierId === flightSupplierId)).toBe(true);
      // Bank-detail rows carry the service types (20261201000290).
      const rev = await one<{ revisionNo: number }>(FLIGHT, SQL.supplierBeneficiary, [flightSupplierId, rid(),
        JSON.stringify({ accountHolder: 'Synthetic Air Ltd', bankName: 'Synthetic Bank', ifsc: 'SYNB0000001', accountNumber: '000033334444' })]);
      const banks = await one<{ bankDetails: Array<{ supplierId: string; revisionNo: number; serviceTypes: string[] }> }>(MANAGER, SQL.managerApprovals, []);
      expect(banks.bankDetails.find((x) => x.supplierId === flightSupplierId && x.revisionNo === rev.revisionNo)?.serviceTypes).toEqual(['flight']);
    });
  });

  it('Purchase workspace loads with a flight supplier in the entity', async () => {
    await asOwner(db, async () => {
      await h.addFlightPeople();
      await h.flightSupplier();
      const booked = await h.packageDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL]) }]);
      const hotelTask = booked.allTasks.find((t) => !booked.flightTasks.includes(t))!;
      await one(PURCHASE, 'select public.purchase_task_claim($1) as r', [hotelTask]);
      const { loadPurchaseWorkspace } = await import('@/modules/procurement/server/queries');
      const ws = await loadPurchaseWorkspace({ supabase: rpcAs(() => db, PURCHASE) } as never, hotelTask);
      expect(ws).not.toBeNull();
    });
  });
});
