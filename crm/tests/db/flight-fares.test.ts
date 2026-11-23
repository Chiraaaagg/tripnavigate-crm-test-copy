import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_USERS as U, type TestDb, asOwner, createTestDb, expectDbError } from '../helpers/db';
import {
  ACC, DEAL, DEAL2, FLIGHT, FLIGHT_2, type FareIn, LEG_DEL_GOI, LEG_JDH_DEL, MANAGER, MANAGER_AMD, OWNER, PURCHASE, SALES_B, SQL, confirmFields, fare,
  flightHelpers, rid, ticketFor, typedFlight,
} from './flight-support';

/**
 * Flight build, contract D3, D4 and sections 4 (budget), 5.2 (batches, fares,
 * approvals), 6.2 B4-B8; test plan 12.1 "Fares":
 *   - Basic + K + YQ + YR + Other + Markup - Discount = Total per person;
 *     supplier cost = Basic + K + YQ + YR + Other; × count = amount.
 *   - Package Deals: markup/discount refused and stored null; flight-only:
 *     both required (0 allowed); discount over fare refused.
 *   - Over budget (Deal level, L5) needs a branch Manager approval for that
 *     exact fare set before confirmation; the approval is used once; changed
 *     fares or another batch meanwhile -> fare_approval_mismatch; budget
 *     falls back to the Sales fare estimate (L4); no budget = approval needed.
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
const CHILD = fare('child', { basicPaise: '300000' }); // supplier per child 400,000
const PKG_FARES = [fare('adult'), CHILD]; // 3 adults + 1 child = 2,200,000
const RETURN_REASON = 'Synthetic: these fares are above the agreed range';

async function setup(opts: { kind?: 'package' | 'flight_only'; budget?: string | null } = {}) {
  await h.addFlightPeople();
  const items = [{ type: 'flight', facts: typedFlight([LEG_JDH_DEL, LEG_DEL_GOI]), budget: opts.budget === undefined ? '2800000' : opts.budget }];
  const b = opts.kind === 'flight_only'
    ? await h.flightOnlyDeal(items, { deal: DEAL2, actor: SALES_B })
    : await h.packageDeal(items);
  const deal = opts.kind === 'flight_only' ? DEAL2 : DEAL;
  await h.claim(FLIGHT, deal);
  const [leg1, leg2] = await h.sectors(b.flightTasks[0]!);
  const supplierId = await h.flightSupplier();
  return { b, deal, task: b.flightTasks[0]!, leg1: leg1!, leg2: leg2!, supplierId };
}
const all = (s: { leg1: { id: string }; leg2: { id: string } }) => [s.leg1.id, s.leg2.id];
const confirmAll = (s: Awaited<ReturnType<typeof setup>>, fares: FareIn[], extra: { fareApprovalId?: string | null; seqs?: number[] } = {}) =>
  JSON.stringify({ sectorIds: all(s), supplierId: s.supplierId, fareApprovalId: extra.fareApprovalId ?? null, fares,
    travellers: (extra.seqs ?? [1, 2, 3, 4]).map((q) => ticketFor(q)) });
const approvalFields = (s: Awaited<ReturnType<typeof setup>>, fares: FareIn[], seqs = [1, 2, 3, 4]) =>
  JSON.stringify({ sectorIds: all(s), supplierId: s.supplierId, fares, travellers: seqs.map((seq) => ({ seq })) });
type Batch = { id: string; deal_kind: string; supplier_cost_paise: string; customer_total_paise: string | null; budget_paise: string | null;
  over_budget: boolean; fare_approval_id: string | null; cost_task_id: string };
const batchRow = async (id: string) => (await owner<Batch>(
  `select id, deal_kind, supplier_cost_paise::text, customer_total_paise::text, budget_paise::text, over_budget, fare_approval_id, cost_task_id
   from public.flight_ticket_batches where id = $1`, [id]))[0]!;
const fareRows = (batchId: string) => owner<Record<string, string | number | null>>(
  `select pax_type, basic_paise::text, markup_paise::text, discount_paise::text, supplier_per_person_paise::text, total_per_person_paise::text, pax_count
   from public.flight_batch_fares where batch_id = $1 order by pax_type`, [batchId]);
const approvalRow = async (deal: string) => (await owner<{ id: string; status: string; row_version: number; requested_by: string;
  decided_by: string | null; fare_hash: string; projected_supplier_cost_paise: string; batch_supplier_cost_paise: string; budget_paise: string | null }>(
  `select id, status, row_version, requested_by, decided_by, fare_hash, projected_supplier_cost_paise::text, batch_supplier_cost_paise::text, budget_paise::text
   from public.flight_fare_approvals where deal_id = $1 order by approval_no desc limit 1`, [deal]))[0];

describe('fare formula and the package / flight-only fence', () => {
  it('package: markup and discount refused and stored null; supplier cost = Σ (basic+K+YQ+YR+other) × count', async () => {
    await asOwner(db, async () => {
      const s = await setup();
      for (const over of [{ markupPaise: '10000' }, { discountPaise: '10000' }, { markupPaise: '0', discountPaise: '0' }]) {
        await refusedHint(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmAll(s, [fare('adult', over), CHILD]), rid()], 'invalid_input', /markupPaise|discountPaise/);
      }
      for (const bad of [{ basicPaise: '-1' }, { basicPaise: '100.5' }, { kPaise: 'abc' }, { basicPaise: undefined }]) {
        await refusedHint(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmAll(s, [{ ...fare('adult'), ...bad } as FareIn, CHILD]), rid()], 'invalid_input');
      }
      // Fares must list exactly the types among the posted travellers.
      await refusedHint(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmAll(s, [fare('adult')]), rid()], 'invalid_input', /fares/);
      await refusedHint(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmAll(s, [fare('adult'), CHILD, fare('infant')]), rid()], 'invalid_input', /fares/);
      const r = await one<{ batchId: string; batchNo: number; ticketCount: number; travellersConfirmed: number; stillPending: number }>(
        FLIGHT, SQL.ticketsConfirm, [DEAL, confirmAll(s, PKG_FARES), rid()]);
      expect(r).toMatchObject({ batchNo: 1, ticketCount: 8, travellersConfirmed: 4, stillPending: 0 });
      expect(await batchRow(r.batchId)).toMatchObject({ deal_kind: 'package', supplier_cost_paise: '2200000', customer_total_paise: null,
        budget_paise: '2800000', over_budget: false, fare_approval_id: null, cost_task_id: s.task });
      expect(await fareRows(r.batchId)).toEqual([
        { pax_type: 'adult', basic_paise: '500000', markup_paise: null, discount_paise: null, supplier_per_person_paise: '600000', total_per_person_paise: '600000', pax_count: 3 },
        { pax_type: 'child', basic_paise: '300000', markup_paise: null, discount_paise: null, supplier_per_person_paise: '400000', total_per_person_paise: '400000', pax_count: 1 },
      ]);
      // Package money read: no markup / discount / customer keys anywhere.
      const money = await one<Record<string, unknown>>(FLIGHT, SQL.money, [DEAL]);
      expect(money).toMatchObject({ dealKind: 'package', supplierCostPaise: '2200000', overBudget: false });
      expect(JSON.stringify(money)).not.toMatch(/markupPaise|discountPaise|customerTotalPaise|customerAmountPaise|totalPerPersonPaise/);
      // The batch is append-only.
      await expectDbError(db, () => owner(`update public.flight_batch_fares set basic_paise = 1 where batch_id = $1`, [r.batchId]), {});
    });
  });

  it('flight-only: markup and discount required (0 allowed); Total = supplier + markup - discount; discount over fare refused', async () => {
    await asOwner(db, async () => {
      const s = await setup({ kind: 'flight_only' });
      await refusedHint(FLIGHT, SQL.ticketsConfirm, [DEAL2, confirmAll(s, PKG_FARES), rid()], 'invalid_input', /markupPaise|discountPaise/);
      await refused(FLIGHT, SQL.ticketsConfirm, [DEAL2, confirmAll(s, [fare('adult', { markupPaise: '0', discountPaise: '600001' }),
        { ...CHILD, markupPaise: '0', discountPaise: '0' }]), rid()], 'discount_over_fare', '22023');
      const fares = [fare('adult', { markupPaise: '50000', discountPaise: '20000' }), { ...CHILD, markupPaise: '0', discountPaise: '0' }];
      const r = await one<{ batchId: string }>(FLIGHT, SQL.ticketsConfirm, [DEAL2, confirmAll(s, fares), rid()]);
      // Supplier 3×600,000 + 400,000 = 2,200,000; customer 3×630,000 + 400,000 = 2,290,000.
      expect(await batchRow(r.batchId)).toMatchObject({ deal_kind: 'flight_only', supplier_cost_paise: '2200000', customer_total_paise: '2290000' });
      expect((await fareRows(r.batchId))[0]).toMatchObject({ markup_paise: '50000', discount_paise: '20000', supplier_per_person_paise: '600000',
        total_per_person_paise: '630000' });
      const money = await one<{ customerTotalPaise: string; batches: Array<{ fares: Array<Record<string, unknown>> }> }>(FLIGHT, SQL.money, [DEAL2]);
      expect(money.customerTotalPaise).toBe('2290000');
      expect(money.batches[0]!.fares.find((f) => f.paxType === 'adult')).toMatchObject({ markupPaise: '50000', discountPaise: '20000',
        supplierPerPersonPaise: '600000', totalPerPersonPaise: '630000', paxCount: 3, supplierAmountPaise: '1800000', customerAmountPaise: '1890000' });
    });
  });

  it('preview: the same numbers live, no write', async () => {
    await asOwner(db, async () => {
      const s = await setup({ budget: '2000000' });
      const p = await one<Record<string, unknown>>(FLIGHT, SQL.farePreview, [DEAL, approvalFields(s, PKG_FARES)]);
      expect(p).toMatchObject({ batchSupplierCostPaise: '2200000', batchCustomerTotalPaise: null, dealSupplierCostAfterPaise: '2200000',
        dealBudgetPaise: '2000000', overBudget: true, approval: null, costTaskId: s.task });
      expect(p.fareHash).toMatch(/^[0-9a-f]{64}$/);
      expect(await owner('select count(*)::int as n from public.flight_fare_approvals')).toEqual([{ n: 0 }]);
      for (const actor of [OWNER, PURCHASE, FLIGHT_2]) {
        const r = await h.attempt(actor, SQL.farePreview, [DEAL, approvalFields(s, PKG_FARES)]);
        expect(r.ok ? r.value === null : /not_authorized/.test(r.error), `preview for ${actor.userId}`).toBe(true);
      }
    });
  });
});

describe('over budget: Manager approval for the exact fare set', () => {
  it('refused without approval; Manager approves (not the requester, not the flight assignee); used once', async () => {
    await asOwner(db, async () => {
      const s = await setup({ budget: '2000000' });
      await refused(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmAll(s, PKG_FARES), rid()], 'over_budget', '55000');
      // Within budget: no approval needed.
      await refused(FLIGHT, SQL.fareApprovalRequest, [DEAL, approvalFields(s, [fare('adult')], [1]), rid()], 'not_over_budget', '55000');
      for (const actor of [OWNER, PURCHASE, MANAGER]) {
        await refused(actor, SQL.fareApprovalRequest, [DEAL, approvalFields(s, PKG_FARES), rid()], 'not_authorized', '42501');
      }
      await one(FLIGHT, SQL.fareApprovalRequest, [DEAL, approvalFields(s, PKG_FARES), rid()]);
      const first = (await approvalRow(DEAL))!;
      expect(first).toMatchObject({ status: 'pending', requested_by: U.movedStaff, batch_supplier_cost_paise: '2200000',
        projected_supplier_cost_paise: '2200000', budget_paise: '2000000' });
      expect((await owner<{ i: string[] }>('select authz.flight_money_issues($1) as i', [DEAL]))[0]!.i).toContain('fare_approval_pending');
      // Asking again withdraws the earlier pending one (at most one pending per Deal).
      await one(FLIGHT, SQL.fareApprovalRequest, [DEAL, approvalFields(s, PKG_FARES), rid()]);
      expect(await owner('select status from public.flight_fare_approvals where id = $1', [first.id])).toEqual([{ status: 'withdrawn' }]);
      const a = (await approvalRow(DEAL))!;
      expect(a.status).toBe('pending');
      // Manager list and Home count.
      const list = await one<{ flightFares: Array<{ approvalId: string; canApprove: boolean; batchSupplierCostPaise: string }> }>(MANAGER, SQL.managerApprovals);
      expect(list.flightFares).toEqual([expect.objectContaining({ approvalId: a.id, canApprove: true, batchSupplierCostPaise: '2200000' })]);
      expect(await one<Record<string, number | null>>(MANAGER, SQL.smHomeCounts)).toMatchObject({ flightFaresToApprove: 1 });
      // Deciders: Manager of the branch only.
      for (const actor of [OWNER, ACC, FLIGHT, FLIGHT_2, MANAGER_AMD, PURCHASE]) {
        await refused(actor, SQL.fareApprovalDecide, [a.id, 'approve', null, a.row_version, rid()], '(not_authorized|not_self_approval)');
      }
      await refusedHint(MANAGER, SQL.fareApprovalDecide, [a.id, 'return', 'short', a.row_version, rid()], 'invalid_input');
      await refused(MANAGER, SQL.fareApprovalDecide, [a.id, 'approve', null, a.row_version + 5, rid()], 'version_changed', '40001');
      await one(MANAGER, SQL.fareApprovalDecide, [a.id, 'approve', null, a.row_version, rid()]);
      const approved = (await approvalRow(DEAL))!;
      expect(approved).toMatchObject({ status: 'approved', decided_by: U.managerDelhi });
      await refused(MANAGER, SQL.fareApprovalDecide, [a.id, 'return', RETURN_REASON, approved.row_version, rid()], 'already_decided', '55000');
      // Changed fares do not match the approval.
      await refused(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmAll(s, [fare('adult', { otherPaise: '10001' }), CHILD], { fareApprovalId: a.id }), rid()],
        'fare_approval_mismatch', '55000');
      // Exact fares (PNRs and ticket numbers are not part of the hash): confirmed, approval used.
      const r = await one<{ batchId: string }>(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmAll(s, PKG_FARES, { fareApprovalId: a.id }), rid()]);
      expect(await batchRow(r.batchId)).toMatchObject({ over_budget: true, fare_approval_id: a.id, budget_paise: '2000000' });
      expect((await approvalRow(DEAL))!.status).toBe('used');
      const audit = await owner<{ action: string }>(`select action from public.audit_events where action like 'flight.fare_approval_%' order by id`);
      expect(audit.map((x) => x.action)).toEqual(['flight.fare_approval_requested', 'flight.fare_approval_requested', 'flight.fare_approval_approved']);
    });
  });

  it('the Manager who is the Deal\'s Flight assignee cannot approve; returned needs a reason; withdraw by the requester only', async () => {
    await asOwner(db, async () => {
      await h.addRole(U.managerDelhi, 'flight', 'DEL');
      await h.addFlightPeople();
      const b = await h.packageDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL]), budget: '100000' }]);
      await h.claim(MANAGER);
      const [leg] = await h.sectors(b.flightTasks[0]!);
      const supplierId = await h.flightSupplier(MANAGER);
      const fields = JSON.stringify({ sectorIds: [leg!.id], supplierId, fares: [fare('adult')], travellers: [{ seq: 1 }] });
      await one(MANAGER, SQL.fareApprovalRequest, [DEAL, fields, rid()]);
      const a = (await approvalRow(DEAL))!;
      await refused(MANAGER, SQL.fareApprovalDecide, [a.id, 'approve', null, a.row_version, rid()], 'not_self_approval', '42501');
      await refused(FLIGHT, SQL.fareApprovalWithdraw, [a.id, a.row_version, rid()], 'not_authorized', '42501');
      await one(MANAGER, SQL.fareApprovalWithdraw, [a.id, a.row_version, rid()]);
      expect((await approvalRow(DEAL))!.status).toBe('withdrawn');
    });
    await asOwner(db, async () => {
      const s = await setup({ budget: '2000000' });
      await one(FLIGHT, SQL.fareApprovalRequest, [DEAL, approvalFields(s, PKG_FARES), rid()]);
      const a = (await approvalRow(DEAL))!;
      await one(MANAGER, SQL.fareApprovalDecide, [a.id, 'return', RETURN_REASON, a.row_version, rid()]);
      expect((await approvalRow(DEAL))!.status).toBe('returned');
      await refused(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmAll(s, PKG_FARES, { fareApprovalId: a.id }), rid()], 'fare_approval_mismatch', '55000');
      const [audit] = await owner<{ reason: string }>(`select reason from public.audit_events where action = 'flight.fare_approval_returned'`);
      expect(audit!.reason).toBe(RETURN_REASON);
    });
  });

  it('another batch confirmed after the approval changes the base total: fare_approval_mismatch', async () => {
    await asOwner(db, async () => {
      // Budget 2,000,000: travellers 1-3 (1,800,000) are within; the child's batch alone is too, but together they are over.
      const s = await setup({ budget: '2000000' });
      const adults = JSON.stringify({ sectorIds: all(s), supplierId: s.supplierId, fares: [fare('adult')], travellers: [1, 2, 3].map((seq) => ({ seq })) });
      void adults;
      // The adults' batch alone is within budget, so no approval; instead ask for the child's (projected 400,000, within) -> not over budget.
      await refused(FLIGHT, SQL.fareApprovalRequest, [DEAL, approvalFields(s, [CHILD], [4]), rid()], 'not_over_budget', '55000');
      // Raise the child's fare so the child alone is over budget: approval projected on a Deal total of 0.
      const bigChild = fare('child', { basicPaise: '2000000' }); // 2,100,000 per child
      await one(FLIGHT, SQL.fareApprovalRequest, [DEAL, approvalFields(s, [bigChild], [4]), rid()]);
      const a = (await approvalRow(DEAL))!;
      await one(MANAGER, SQL.fareApprovalDecide, [a.id, 'approve', null, a.row_version, rid()]);
      // Meanwhile the adults are confirmed (within budget on their own).
      await one(FLIGHT, SQL.ticketsConfirm, [DEAL, JSON.stringify({ sectorIds: all(s), supplierId: s.supplierId, fareApprovalId: null,
        fares: [fare('adult')], travellers: [1, 2, 3].map((q) => ticketFor(q)) }), rid()]);
      await refused(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmFields({ sectorIds: all(s), supplierId: s.supplierId, fareApprovalId: a.id,
        fares: [bigChild], travellers: [ticketFor(4)] }), rid()], 'fare_approval_mismatch', '55000');
    });
  });
});

describe('approved budget source (L4)', () => {
  it('typed budget; else the Sales fare estimate × participants; else none (every fare set needs approval)', async () => {
    await asOwner(db, async () => {
      const s = await setup({ budget: '0' });
      const budget = async () => (await owner<{ b: { budget_paise: string | null; source: string } }>(
        'select to_jsonb(x) as b from authz.flight_task_budget($1) x', [s.task]))[0]!.b;
      expect(await budget()).toMatchObject({ budget_paise: null, source: 'none' });
      await refused(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmAll(s, PKG_FARES, { seqs: [1, 2, 3, 4] }), rid()], 'over_budget', '55000');
      // SYNTHETIC FIXTURE: a Sales fare estimate on the accepted version (written as the owner; versions are frozen).
      await owner('set local session_replication_role = replica');
      await owner(`insert into public.service_item_cost_estimates (booking_version_id, service_item_id, legal_entity_id, fare_adult_paise, fare_child_paise, updated_by)
                   select $1, $2, legal_entity_id, 700000, 450000, $3 from public.service_items where id = $2`, [s.b.versionId, s.b.flightItems[0], U.salesDelhiA]);
      await owner('set local session_replication_role = origin');
      // 3 adults × 700,000 + 1 child × 450,000 = 2,550,000.
      expect(await budget()).toMatchObject({ budget_paise: 2550000, source: 'estimate' });
      const money = await one<{ budget: { dealPaise: string | null; tasks: Array<{ source: string }> } }>(FLIGHT, SQL.money, [DEAL]);
      expect(money.budget).toMatchObject({ dealPaise: '2550000', tasks: [expect.objectContaining({ source: 'estimate' })] });
      const r = await one<{ batchId: string }>(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmAll(s, PKG_FARES), rid()]);
      expect(await batchRow(r.batchId)).toMatchObject({ budget_paise: '2550000', over_budget: false });
    });
  });
});
