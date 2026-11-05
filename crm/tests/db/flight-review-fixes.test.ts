import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import {
  DEAL, DEAL2, FLIGHT, FLIGHT_2, LEG_JDH_DEL, OWNER, SALES_B, SQL, allKeys, changeSector, fare, flightHelpers, rid, screenshotFlight, ticketFor,
  typedFlight,
} from './flight-support';

/**
 * Flight build, lead decisions of 5 November 2026 on the independent reviews
 * (contract addenda; migrations 20261201000160..0180 and 0250..0270), tested
 * from their stated rules:
 *   - Flight + Purchase holders see supplier-side fares but never selling-side
 *     values (markup, discount, totals per person, customer amounts); on a
 *     flight-only Deal they may not enter markup/discount (not_authorized,
 *     hint purchase_holder_margin); flight_money.marginsAllowed says who may.
 *   - Old-form flight costs (L18) are linked to the batch at confirmation:
 *     still to pay = supplier cost - linked costs with Accounts; fully covered
 *     batches count as paid; linked costs count in the C1 running total.
 *   - "In progress · flight details not typed yet" when nothing is ticketable.
 *   - flight_queue groups carry hasChangeDecision / readyToFinish matching
 *     flight_home_counts; Sales rows carry the Deal when exactly one feeds them.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = flightHelpers(() => db);
const { one, owner, refusedHint } = h;
const SELL_KEYS = ['markupPaise', 'discountPaise', 'totalPerPersonPaise', 'customerAmountPaise', 'customerTotalPaise'];

describe('Flight + Purchase holders and the selling-side fence', () => {
  it('see supplier-side fares only; cannot enter markup/discount on a flight-only Deal; marginsAllowed says who may', async () => {
    await asOwner(db, async () => {
      await h.addFlightPeople();
      const b = await h.flightOnlyDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL]), budget: '99999999' }], { deal: DEAL2, actor: SALES_B });
      await h.claim(FLIGHT, DEAL2);
      const [leg] = await h.sectors(b.flightTasks[0]!);
      const supplierId = await h.flightSupplier();
      const fo = [fare('adult', { markupPaise: '43219', discountPaise: '12347' })];
      await one(FLIGHT, SQL.ticketsConfirm, [DEAL2, JSON.stringify({ sectorIds: [leg!.id], supplierId, fareApprovalId: null, fares: fo,
        travellers: [ticketFor(1)] }), rid()]);
      // The pure Flight assignee: markup/discount visible and allowed.
      const fa = await one<Record<string, unknown>>(FLIGHT, SQL.money, [DEAL2]);
      expect(fa.marginsAllowed).toBe(true);
      expect(allKeys(fa).has('markupPaise')).toBe(true);
      // Another Flight person who also holds Purchase: supplier side yes, selling side never.
      await h.addRole(U.salesAhmedabad, 'purchase');
      const dual = await one<Record<string, unknown>>(FLIGHT_2, SQL.money, [DEAL2]);
      expect(dual.marginsAllowed).toBe(false);
      expect(allKeys(dual).has('basicPaise')).toBe(true);
      for (const k of SELL_KEYS) expect(allKeys(dual).has(k), `Flight + Purchase key ${k}`).toBe(false);
      expect(JSON.stringify(dual)).not.toMatch(/43219|12347/);
      // The assignee gains Purchase: entering markup/discount is refused before anything is written.
      await h.addRole(U.movedStaff, 'purchase');
      const before = await owner<{ n: number }>('select count(*)::int as n from public.flight_ticket_batches where deal_id = $1', [DEAL2]);
      const fields = JSON.stringify({ sectorIds: [leg!.id], supplierId, fareApprovalId: null, fares: fo, travellers: [ticketFor(2)] });
      await refusedHint(FLIGHT, SQL.ticketsConfirm, [DEAL2, fields, rid()], 'not_authorized', /^purchase_holder_margin$/);
      await refusedHint(FLIGHT, SQL.farePreview, [DEAL2, JSON.stringify({ sectorIds: [leg!.id], supplierId, fares: fo, travellers: [{ seq: 2 }] })],
        'not_authorized', /^purchase_holder_margin$/);
      await refusedHint(FLIGHT, SQL.fareApprovalRequest, [DEAL2, JSON.stringify({ sectorIds: [leg!.id], supplierId, fares: fo, travellers: [{ seq: 2 }] }), rid()],
        'not_authorized', /^purchase_holder_margin$/);
      expect(await owner('select count(*)::int as n from public.flight_ticket_batches where deal_id = $1', [DEAL2])).toEqual(before);
      expect((await one<Record<string, unknown>>(FLIGHT, SQL.money, [DEAL2])).marginsAllowed).toBe(false);
    });
  });

  it('package Deals: marginsAllowed false for everyone; a Flight + Purchase holder still confirms package tickets', async () => {
    await asOwner(db, async () => {
      await h.addFlightPeople();
      await h.addRole(U.movedStaff, 'purchase');
      const b = await h.packageDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL]), budget: '99999999' }]);
      await h.claim();
      const [leg] = await h.sectors(b.flightTasks[0]!);
      const supplierId = await h.flightSupplier();
      await one(FLIGHT, SQL.ticketsConfirm, [DEAL, JSON.stringify({ sectorIds: [leg!.id], supplierId, fareApprovalId: null, fares: [fare('adult')],
        travellers: [ticketFor(1)] }), rid()]);
      expect((await one<Record<string, unknown>>(FLIGHT, SQL.money, [DEAL])).marginsAllowed).toBe(false);
      // Workspace salesFare (Sales estimate) is null for a Purchase holder (lead review fix F5).
      const ws = await one<{ flights: Array<{ salesFare: unknown }> }>(FLIGHT, SQL.workspace, [DEAL]);
      for (const f of ws.flights) expect(f.salesFare).toBeNull();
    });
  });
});

describe('old-form flight costs (L18) linked at confirmation', () => {
  /** SYNTHETIC FIXTURE: a pre-build manual flight cost (draft with its proof, owner insert), then submitted by Flight. */
  async function legacyCost(task: string, amount: number): Promise<string> {
    const proof = await h.evidence(FLIGHT, task, 'direct_payment_proof');
    const [row] = await owner<{ id: string; row_version: number }>(
      `insert into public.department_cost_entries (legal_entity_id, branch_id, deal_id, task_id, department, cost_kind, amount_paise, paid_by,
         payment_mode, paid_on, expense_status, receipt_evidence_id, created_by, request_id)
       select t.legal_entity_id, d.branch_id, t.deal_id, t.id, 'flight', 'fare', $2, 'company', 'card', date '2026-10-10', 'draft', $3,
         t.assignee_user_id, gen_random_uuid()
       from public.fulfilment_tasks t join public.deals d on d.id = t.deal_id where t.id = $1 returning id, row_version`, [task, amount, proof]);
    await one(FLIGHT, SQL.costSubmit, [row!.id, row!.row_version]);
    return row!.id;
  }
  async function setup() {
    await h.addFlightPeople();
    const b = await h.packageDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL]), budget: '99999999' }]);
    await h.claim();
    const [leg] = await h.sectors(b.flightTasks[0]!);
    const supplierId = await h.flightSupplier();
    return { task: b.flightTasks[0]!, leg: leg!, supplierId };
  }
  const batchOf = async (s: Awaited<ReturnType<typeof setup>>) => one<{ batchId: string }>(FLIGHT, SQL.ticketsConfirm, [DEAL, JSON.stringify({
    sectorIds: [s.leg.id], supplierId: s.supplierId, fareApprovalId: null, fares: [fare('adult')], travellers: [ticketFor(1)] }), rid()]);

  it('a partly covered batch: still to pay = supplier cost - old cost; the direct payment is for that amount; C1 counts both', async () => {
    await asOwner(db, async () => {
      const s = await setup();
      await legacyCost(s.task, 200_000);
      const { batchId } = await batchOf(s); // supplier cost 600,000
      const money = await one<{ batches: Array<{ batchId: string; supplierCostPaise: string; legacyPaidPaise: string; duePaise: string }> }>(FLIGHT, SQL.money, [DEAL]);
      expect(money.batches.find((x) => x.batchId === batchId)).toMatchObject({ supplierCostPaise: '600000', legacyPaidPaise: '200000', duePaise: '400000' });
      expect(await one(FLIGHT, SQL.paymentContext, [batchId])).toMatchObject({ amountPaise: '400000', supplierCostPaise: '600000', legacyPaidPaise: '200000' });
      await h.directPay(batchId);
      expect(await owner('select amount_paise::text as a from public.department_cost_entries where flight_batch_id = $1', [batchId])).toEqual([{ a: '400000' }]);
      const total = (await owner<{ t: string }>('select authz.sm_supplier_running_total($1, $2)::text as t', [DEAL, s.supplierId]))[0]!.t;
      expect(total).toBe('600000');
    });
  });

  it('a fully covered batch counts as paid; the done checklist accepts it', async () => {
    await asOwner(db, async () => {
      const s = await setup();
      await legacyCost(s.task, 1_000_000);
      const { batchId } = await batchOf(s);
      const money = await one<{ batches: Array<{ batchId: string; duePaise: string; payment: { state: string } }> }>(FLIGHT, SQL.money, [DEAL]);
      expect(money.batches.find((x) => x.batchId === batchId)).toMatchObject({ duePaise: '0', payment: { state: 'direct_submitted' } });
      expect((await owner<{ i: string[] }>('select authz.flight_money_issues($1) as i', [DEAL]))[0]!.i).not.toContain('payment_missing');
    });
  });
});

describe('status words, queue booleans and Home links', () => {
  it('"In progress · flight details not typed yet" while a screenshot flight has no sectors', async () => {
    await asOwner(db, async () => {
      await h.addFlightPeople();
      await h.packageDeal([{ type: 'flight', facts: screenshotFlight(4) }]);
      await h.claim();
      const ws = await one<{ status: { text: string; required: number } }>(FLIGHT, SQL.workspace, [DEAL]);
      expect(ws.status).toMatchObject({ text: 'In progress · flight details not typed yet', required: 0 });
      const q = await one<{ groups: Array<{ dealId: string; status: { text: string } }> }>(FLIGHT, SQL.queue);
      expect(q.groups.find((g) => g.dealId === DEAL)!.status.text).toBe('In progress · flight details not typed yet');
    });
  });

  it('hasChangeDecision / readyToFinish match flight_home_counts; the Sales row names its one Deal', async () => {
    await asOwner(db, async () => {
      await h.addFlightPeople();
      const b = await h.packageDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL]) }]);
      await h.claim();
      const [leg] = await h.sectors(b.flightTasks[0]!);
      const c = await one<{ changeId: string }>(FLIGHT, SQL.changeSubmit, [b.flightTasks[0], JSON.stringify({ kind: 'alternative', fromSectorIds: [leg!.id],
        travellerSeqs: [1], remark: 'Synthetic: evening flight', sectors: [changeSector({ from: 'JDH', to: 'DEL', departDate: '2026-12-10',
          departTime: '18:20', arriveTime: '19:35', flightNo: 'AI 472', airline: 'Air India' })] }), rid()]);
      expect(await one<Record<string, unknown>>(OWNER, SQL.homeCounts)).toMatchObject({ salesFlightChangesToDecide: 1, salesFlightChangesToDecideDealId: DEAL });
      const [row] = await owner<{ row_version: number }>('select row_version from public.flight_changes where id = $1', [c.changeId]);
      await one(OWNER, SQL.changeDecide, [c.changeId, 'approve', null, row!.row_version, rid()]);
      expect(await one<Record<string, unknown>>(OWNER, SQL.homeCounts)).toMatchObject({ salesFlightChangesToDecide: 0, salesFlightChangesToDecideDealId: null });
      type Q = { groups: Array<{ dealId: string; hasChangeDecision: boolean; readyToFinish: boolean }> };
      const group = async () => (await one<Q>(FLIGHT, SQL.queue)).groups.find((g) => g.dealId === DEAL)!;
      const counts = await one<Record<string, number>>(FLIGHT, SQL.homeCounts);
      expect(counts.flightChangesDecided).toBe(1);
      expect(await group()).toMatchObject({ hasChangeDecision: true, readyToFinish: false });
      expect(counts.flightReadyToFinish).toBe(0);
      await one(FLIGHT, SQL.changeAck, [c.changeId]);
      expect(await group()).toMatchObject({ hasChangeDecision: false });
      // Another Flight person's queue never flags someone else's decisions.
      expect((await one<Q>(FLIGHT_2, SQL.queue)).groups.find((g) => g.dealId === DEAL)).toMatchObject({ hasChangeDecision: false, readyToFinish: false });
    });
  });
});
