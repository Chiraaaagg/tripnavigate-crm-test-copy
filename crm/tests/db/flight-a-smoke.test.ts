import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_USERS as U, asOwner, createTestDb, type TestDb } from '../helpers/db';
import { ACCOUNTS, DEAL, FLIGHT, MANAGER, OWNER, PURCHASE, SALES_B, allKeys, b1Helpers, rid } from './b1-support';
// R3 scenario: Track D's Book now v2 helper for a booking with one traveller not named yet.
import { FLIGHT as FLIGHT_D, flightHelpers, sectorInput } from './flight-support';

/**
 * Track A smoke checks (Flight build contract, sections 6.1 and 9): group claim
 * through the old per-task command, the workspace read, a package change
 * decided by the Sales owner, group reassignment, e-tickets and the Deal
 * reads. Synthetic data only; every scenario is rolled back.
 */

let db: TestDb;
const h = b1Helpers(() => db);
const fh = flightHelpers(() => db);

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const SECOND_FLIGHT = { userId: U.salesAhmedabad };

async function bookedFlightDeal(): Promise<{ task: string; versionId: string }> {
  await h.addFlight();
  const ready = await h.readyPackage(OWNER, DEAL, ['hotel', 'flight']);
  const confirmed = await h.confirm(OWNER, ready.versionId, ready.hash);
  expect(confirmed.outcome).toBe('created');
  const [task] = await h.owner<{ id: string }>(
    `select id from public.fulfilment_tasks where deal_id = $1 and department = 'flight'`, [DEAL]);
  return { task: task!.id, versionId: ready.versionId };
}

type Sector = { id: string; status: string; origin: string; booking_leg_no: number | null };
const sectorsOf = (task: string) => h.owner<Sector>(
  `select id, status, origin, booking_leg_no from public.flight_sectors where task_id = $1
   order by depart_date, depart_time nulls last, created_at`, [task]);
const seqsOn = async (sector: string) => (await h.owner<{ s: number }>(
  'select traveller_seq as s from public.flight_sector_passengers where sector_id = $1 and ended_at is null order by 1', [sector])).map((r) => r.s);

describe('flight track A smoke', () => {
  it('claim, workspace, package change decided by the Sales owner, reassignment, e-tickets and Deal reads', async () => {
    await asOwner(db, async () => {
      const { task } = await bookedFlightDeal();

      // Queue before anyone takes the Deal.
      const queue = await h.one<{ groups: Array<{ dealId: string; canTake: boolean; status: { code: string; required: number }; flights: unknown[] }> }>(
        FLIGHT, 'select public.flight_queue() as r');
      const group = queue.groups.find((g) => g.dealId === DEAL)!;
      expect(group).toMatchObject({ canTake: true, status: { code: 'waiting', required: 8 } });
      expect(group.flights).toHaveLength(1);

      // The old per-task command claims the group and builds the booking sectors.
      const claim = await h.one<{ alreadyYours: boolean; taskIds: string[] }>(FLIGHT, 'select public.flight_task_claim($1) as r', [task]);
      expect(claim).toMatchObject({ alreadyYours: false, taskIds: [task] });
      const sectors = await sectorsOf(task);
      expect(sectors.map((s) => [s.origin, s.booking_leg_no, s.status])).toEqual([['booking', 1, 'active'], ['booking', 2, 'active']]);
      expect(await seqsOn(sectors[0]!.id)).toEqual([1, 2, 3, 4]);
      await h.refused(SECOND_FLIGHT, 'select public.flight_group_claim($1, $2) as r', [DEAL, rid()], '42501');

      // Workspace: canWork, words, and no money key at all.
      const ws = await h.one<Record<string, unknown> & { canWork: boolean; status: { text: string }; flights: Array<{ sectors: unknown[] }> }>(
        FLIGHT, 'select public.flight_workspace($1) as r', [DEAL]);
      expect(ws).toMatchObject({ canWork: true, status: { text: 'In progress · 0 of 8 tickets' } });
      expect(ws.flights[0]!.sectors).toHaveLength(2);
      expect([...allKeys(ws)].filter((k) => /paise|selling|margin|markup|discount/i.test(k))).toEqual([]);
      expect(ws).toMatchObject({ assigneeUserId: null });
      expect(await h.one(MANAGER, 'select public.flight_workspace($1) as r', [DEAL])).toMatchObject({ canReassign: true, assigneeUserId: U.visaJodhpur });
      expect(await h.one(PURCHASE, 'select public.flight_workspace($1) as r', [DEAL])).toBeNull();

      // Package change: alternative for traveller 1 on leg 1, decided by the Sales owner.
      const alt = { from: 'DEL', to: 'JDH', departDate: '2026-12-10', departTime: '18:05', arriveTime: '19:20', flightNo: 'ai 475', cabin: 'economy' };
      const change = await h.one<{ changeId: string; status: string; deciderKind: string; rowVersion: number }>(
        FLIGHT, 'select public.flight_change_submit($1, $2::jsonb, $3) as r',
        [task, JSON.stringify({ kind: 'alternative', fromSectorIds: [sectors[0]!.id], travellerSeqs: [1], remark: 'Synthetic later flight', sectors: [alt] }), rid()]);
      expect(change).toMatchObject({ status: 'pending', deciderKind: 'sales_owner' });
      const summary = await h.one<{ flights: Array<{ pending: Array<{ changeId: string; canDecide: boolean }> }> }>(
        OWNER, 'select public.deal_flight_summary($1) as r', [DEAL]);
      expect(summary.flights[0]!.pending).toEqual([expect.objectContaining({ changeId: change.changeId, canDecide: true })]);
      // 0180: one Deal feeds the Sales row, so Home links straight to it.
      expect(await h.one(OWNER, 'select public.flight_home_counts() as r')).toMatchObject({
        salesFlightChangesToDecide: 1, salesFlightChangesToDecideDealId: DEAL, salesTravellersToNameDealId: null });
      expect(await h.one(PURCHASE, 'select public.deal_flight_summary($1) as r', [DEAL])).toBeNull();
      await h.refused(SALES_B, 'select public.flight_change_decide($1, $2, $3, $4, $5) as r', [change.changeId, 'approve', null, change.rowVersion, rid()], '42501');
      await h.one(OWNER, 'select public.flight_change_decide($1, $2, $3, $4, $5) as r', [change.changeId, 'approve', null, change.rowVersion, rid()]);
      expect(await seqsOn(sectors[0]!.id)).toEqual([2, 3, 4]);
      const [altSector] = await h.owner<{ id: string; flight_no: string; cabin: string }>(
        `select id, flight_no, cabin from public.flight_sectors where change_id = $1 and status = 'active'`, [change.changeId]);
      expect(altSector).toMatchObject({ flight_no: 'AI 475', cabin: 'Economy' });
      expect(await seqsOn(altSector!.id)).toEqual([1]);
      expect(await h.one(FLIGHT, 'select public.flight_home_counts() as r')).toMatchObject({ flightChangesDecided: 1, flightDealsMine: 1 });
      const rowOf = async () => (await h.one<{ groups: Array<{ dealId: string; hasChangeDecision: boolean; readyToFinish: boolean }> }>(
        FLIGHT, 'select public.flight_queue() as r')).groups.find((g) => g.dealId === DEAL)!;
      expect(await rowOf()).toMatchObject({ hasChangeDecision: true, readyToFinish: false });
      expect(await h.one(OWNER, 'select public.flight_home_counts() as r')).toMatchObject({
        salesFlightChangesToDecide: 0, salesFlightChangesToDecideDealId: null });
      await h.one(FLIGHT, 'select public.flight_change_acknowledge($1) as r', [change.changeId]);
      expect(await h.one(FLIGHT, 'select public.flight_home_counts() as r')).toMatchObject({ flightChangesDecided: 0 });
      expect(await rowOf()).toMatchObject({ hasChangeDecision: false });

      // Reassignment: never per task through Purchase; the Manager moves the group.
      await h.refused(MANAGER, 'select public.purchase_task_reassign($1, $2, $3) as r', [task, U.visaJodhpur, U.salesAhmedabad], '42501');
      await h.addFlight(U.salesAhmedabad);
      const moved = await h.one<{ taskIds: string[]; outcome: string }>(MANAGER, 'select public.flight_group_reassign($1, $2, $3, $4, $5) as r',
        [DEAL, U.visaJodhpur, U.salesAhmedabad, 'Synthetic: first Flight person is on leave', rid()]);
      expect(moved).toMatchObject({ taskIds: [task], outcome: 'updated' });
      expect(await h.one<{ canWork: boolean }>(FLIGHT, 'select public.flight_workspace($1) as r', [DEAL])).toMatchObject({ canWork: false });

      // E-ticket: stored by the new assignee; the Sales owner, Accounts and the Manager may open it; Purchase and other Sales not.
      const ev = await h.one<{ evidenceId: string; objectPath: string }>(SECOND_FLIGHT,
        'select public.department_evidence_begin($1, $2, $3, $4, $5, $6, $7) as r', [task, null, 'e_ticket', 'e-ticket.pdf', 'application/pdf', 2048, 'e'.repeat(64)]);
      await h.owner(`insert into storage.objects (bucket_id, name, metadata) values ('department-evidence', $1, jsonb_build_object('size', 2048::bigint))`, [ev.objectPath]);
      await h.one(SECOND_FLIGHT, 'select public.department_evidence_finish($1, true) as r', [ev.evidenceId]);
      for (const actor of [OWNER, ACCOUNTS, MANAGER]) {
        expect(await h.one<{ fileName: string }>(actor, 'select public.department_evidence_authorize_download($1) as r', [ev.evidenceId]))
          .toMatchObject({ fileName: 'e-ticket.pdf' });
      }
      for (const actor of [PURCHASE, SALES_B]) {
        await h.refused(actor, 'select public.department_evidence_authorize_download($1) as r', [ev.evidenceId], '42501');
      }

      // Deal History (Sales owner) and task History (branch Manager) carry the flight events.
      const history = await h.one<{ events: Array<{ kind: string; changeNo: number | null }> }>(OWNER, 'select public.deal_flight_history($1) as r', [DEAL]);
      const kinds = history.events.map((e) => e.kind);
      for (const k of ['taken', 'change_submitted', 'change_approved', 'reassigned', 'file_added']) expect(kinds).toContain(k);
      expect(kinds.filter((k) => k === 'taken')).toHaveLength(1);
      expect(history.events.find((e) => e.kind === 'change_approved')!.changeNo).toBe(1);
      expect(await h.one(PURCHASE, 'select public.deal_flight_history($1) as r', [DEAL])).toBeNull();
      const taskHistory = await h.one<{ events: Array<{ kind: string }> }>(MANAGER, 'select public.department_task_history($1) as r', [task]);
      expect(taskHistory.events.map((e) => e.kind)).toEqual(expect.arrayContaining(['taken', 'change_submitted', 'change_approved', 'reassigned']));
      expect(JSON.stringify(history)).not.toMatch(/AI 475|paise/i);
    });
  });

  it('fill blanks once, screenshot rules, done issues and no diff while the booking is unchanged', async () => {
    await asOwner(db, async () => {
      const { task } = await bookedFlightDeal();
      await h.one(FLIGHT, 'select public.flight_group_claim($1, $2) as r', [DEAL, rid()]);
      const [leg1] = await sectorsOf(task);
      const [row] = await h.owner<{ row_version: number }>('select row_version from public.flight_sectors where id = $1', [leg1!.id]);
      await h.one(FLIGHT, 'select public.flight_sector_fill_blanks($1, $2, $3::jsonb, $4) as r',
        [leg1!.id, row!.row_version, JSON.stringify({ flightNo: '6e  211', departTime: '07:05' }), rid()]);
      expect(await h.owner('select flight_no, depart_time from public.flight_sectors where id = $1', [leg1!.id]))
        .toEqual([{ flight_no: '6E 211', depart_time: '07:05' }]);
      await h.refusedWithHint(FLIGHT, 'select public.flight_sector_fill_blanks($1, $2, $3::jsonb, $4) as r',
        [leg1!.id, row!.row_version + 1, JSON.stringify({ flightNo: '6E 212' }), rid()], /flightNo_already_set/);
      // A typed flight has no screenshot sectors.
      const [state] = await h.owner<{ row_version: number }>('select row_version from public.flight_task_state where task_id = $1', [task]);
      await h.refused(FLIGHT, 'select public.flight_screenshot_sectors_save($1, $2, $3::jsonb, $4) as r', [task, state!.row_version,
        JSON.stringify([{ from: 'DEL', to: 'BOM', departDate: '2026-12-10', departTime: '10:00', arriveTime: '12:00', flightNo: 'AI 1', cabin: 'Economy' }]), rid()],
      '55000', 'not_ready');
      // Sales fare estimate per flight (round 2): the flight's own estimate per type, with participants per type.
      const [ver] = await h.owner<{ v: string }>('select authz.task_current_version($1) as v', [task]);
      const [item] = await h.owner<{ s: string }>('select service_item_id as s from public.fulfilment_tasks where id = $1', [task]);
      // SYNTHETIC FIXTURE: the estimate is written straight into the confirmed version (guards off inside this rolled-back transaction).
      await h.owner('alter table public.service_item_cost_estimates disable trigger user');
      await h.owner(`insert into public.service_item_cost_estimates (booking_version_id, service_item_id, legal_entity_id, fare_adult_paise,
          fare_child_paise, updated_by) select $1, $2, i.legal_entity_id, 650000, 480000, $3 from public.service_items i where i.id = $2
        on conflict (booking_version_id, service_item_id) do update set fare_adult_paise = 650000, fare_child_paise = 480000`,
      [ver!.v, item!.s, U.salesDelhiA]);
      await h.owner('alter table public.service_item_cost_estimates enable trigger user');
      const withFare = await h.one<{ flights: Array<{ salesFare: unknown }> }>(FLIGHT, 'select public.flight_workspace($1) as r', [DEAL]);
      expect(withFare.flights[0]!.salesFare).toEqual({ source: 'item', adultPaise: '650000', childPaise: '480000', infantPaise: null,
        adults: 3, children: 1, infants: 0 });
      // Fence: only Flight people of the entity and the branch Manager read the workspace (and so salesFare).
      expect(await h.one<{ flights: Array<{ salesFare: unknown }> }>(MANAGER, 'select public.flight_workspace($1) as r', [DEAL]))
        .toMatchObject({ flights: [{ salesFare: { source: 'item' } }] });
      for (const actor of [PURCHASE, SALES_B, OWNER, ACCOUNTS]) {
        expect(await h.one(actor, 'select public.flight_workspace($1) as r', [DEAL])).toBeNull();
      }
      // Review fix 1: dual roles. Flight + Purchase keeps the supplier-side budget but no Sales fare;
      // a branch Manager who also holds Purchase gets no amount at all.
      await h.addFlight(U.purchaseJodhpur);
      const dual = await h.one<{ flights: Array<{ salesFare: unknown }> }>(PURCHASE, 'select public.flight_workspace($1) as r', [DEAL]);
      expect(dual.flights[0]!.salesFare).toBeNull();
      const dualQueue = await h.one<{ groups: Array<{ dealId: string; budgetPaise: string | null }> }>(PURCHASE, 'select public.flight_queue() as r');
      expect(dualQueue.groups.find((g) => g.dealId === DEAL)!.budgetPaise).toBe('2800000');
      await h.owner(`insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
                     select $1, b.legal_entity_id, b.id, 'purchase', 'active' from public.branches b
                     join public.legal_entities e on e.id = b.legal_entity_id where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL'`, [U.managerDelhi]);
      const mgrWs = await h.one<{ flights: Array<{ salesFare: unknown }> }>(MANAGER, 'select public.flight_workspace($1) as r', [DEAL]);
      expect(mgrWs.flights[0]!.salesFare).toBeNull();
      const mgrQueue = await h.one<{ groups: Array<{ dealId: string; budgetPaise: string | null }> }>(MANAGER, 'select public.flight_queue() as r');
      expect(mgrQueue.groups.find((g) => g.dealId === DEAL)!.budgetPaise).toBeNull();
      // 0170: nothing ticketable yet (screenshot flight without typed sectors) is never "0 of 0 tickets".
      expect(await h.owner(`select authz.flight_status_text('in_progress', 0, 0) as a, authz.flight_status_text('in_progress', 2, 8) as b`))
        .toEqual([{ a: 'In progress · flight details not typed yet', b: 'In progress · 2 of 8 tickets' }]);
      const [issues] = await h.owner<{ i: string[] }>('select authz.flight_done_issues($1) as i', [DEAL]);
      expect(issues!.i).toEqual(['tickets_pending', 'eticket_missing']);
      expect((await h.owner<{ d: unknown }>('select authz.flight_booking_diff($1) as d', [task]))[0]!.d).toBeNull();
      await h.refused(FLIGHT, 'select public.flight_group_complete($1, $2, $3) as r', [DEAL, [task], rid()], '55000', 'not_ready');
    });
  });

  it('review fixes: decider at decision time, queue leaves out removed Deals, a repeated request returns the stored result', async () => {
    await asOwner(db, async () => {
      const { task } = await bookedFlightDeal();
      const claimReq = rid();
      await h.one(FLIGHT, 'select public.flight_group_claim($1, $2) as r', [DEAL, claimReq]);
      expect(await h.one(FLIGHT, 'select public.flight_group_claim($1, $2) as r', [DEAL, claimReq])).toMatchObject({ outcome: 'existing' });
      const [leg1, leg2] = await sectorsOf(task);
      const submit = (sector: string, seq: number, flightNo: string) => h.one<{ changeId: string; deciderKind: string; rowVersion: number }>(
        FLIGHT, 'select public.flight_change_submit($1, $2::jsonb, $3) as r',
        [task, JSON.stringify({ kind: 'alternative', fromSectorIds: [sector], travellerSeqs: [seq], remark: 'Synthetic later flight',
          sectors: [{ from: sector === leg1!.id ? 'DEL' : 'JDH', to: sector === leg1!.id ? 'JDH' : 'DEL',
            departDate: sector === leg1!.id ? '2026-12-10' : '2026-12-13', departTime: '18:05', arriveTime: '19:20', flightNo, cabin: 'Economy' }] }), rid()]);
      const decide = (actor: typeof OWNER, c: { changeId: string; rowVersion: number }) =>
        h.one(actor, 'select public.flight_change_decide($1, $2, $3, $4, $5) as r', [c.changeId, 'approve', null, c.rowVersion, rid()]);
      // Sent while the owner is an active Sales owner; the owner then also holds Flight: the branch Manager decides now.
      const first = await submit(leg1!.id, 1, 'AI 475');
      expect(first.deciderKind).toBe('sales_owner');
      await h.addFlight(U.salesDelhiA, 'DEL');
      await h.refused(OWNER, 'select public.flight_change_decide($1, $2, $3, $4, $5) as r', [first.changeId, 'approve', null, first.rowVersion, rid()], '42501');
      await decide(MANAGER, first);
      // Submitted while the owner holds Sales + Flight: stored for the branch Manager.
      const second = await submit(leg2!.id, 2, 'AI 476');
      expect(second.deciderKind).toBe('branch_manager');
      await decide(MANAGER, second);
      // 0910: batches count as paid by Track B's rule (zero-cost batch; old-form cost covering the batch); an unpaid one does not.
      // SYNTHETIC FIXTURE: batches and an old-form cost entry written straight as the owner (rolled back).
      const [supplier] = await h.owner<{ id: string }>(
        `insert into public.suppliers (legal_entity_id, name, service_types, created_by, updated_by)
         select legal_entity_id, 'Synthetic Air Smoke', '{flight}', $2, $2 from public.deals where id = $1 returning id`, [DEAL, U.adminJodhpur]);
      const batch = async (no: number, cost: number) => (await h.owner<{ id: string }>(
        `insert into public.flight_ticket_batches (legal_entity_id, branch_id, deal_id, batch_no, cost_task_id, supplier_id, deal_kind,
           sector_ids, supplier_cost_paise, over_budget, confirmed_by, request_id)
         select t.legal_entity_id, t.branch_id, t.deal_id, $2, t.id, $3, 'package', array[$4::uuid], $5, false, $6, gen_random_uuid()
         from public.fulfilment_tasks t where t.id = $1 returning id`, [task, no, supplier!.id, leg1!.id, cost, U.visaJodhpur]))[0]!.id;
      await batch(1, 0);
      const legacy = await batch(2, 100000);
      await batch(3, 50000);
      const [entry] = await h.owner<{ id: string }>(
        `insert into public.department_cost_entries (task_id, deal_id, legal_entity_id, branch_id, department, cost_kind, amount_paise,
           paid_by, payment_mode, paid_on, expense_status, submitted_by, submitted_at, request_id, created_by)
         select t.id, t.deal_id, t.legal_entity_id, t.branch_id, 'flight', 'fare', 100000, 'company', 'card', date '2026-11-01',
           'submitted', $2, now(), gen_random_uuid(), $2 from public.fulfilment_tasks t where t.id = $1 returning id`, [task, U.visaJodhpur]);
      await h.owner(`insert into public.flight_batch_legacy_costs (entry_id, batch_id, legal_entity_id, deal_id, linked_by)
                     select $1, $2, legal_entity_id, id, $3 from public.deals where id = $4`, [entry!.id, legacy, U.visaJodhpur, DEAL]);
      expect(await h.owner('select paid, total from authz.flight_batch_payment_counts($1)', [DEAL])).toEqual([{ paid: 2, total: 3 }]);
      const progress = (await h.one<{ progress: Array<{ key: string; sub: string | null }> }>(FLIGHT, 'select public.flight_workspace($1) as r', [DEAL])).progress;
      expect(progress.find((p) => p.key === 'payment')!.sub).toBe('2 of 3 batches');
      // Removed Deals leave the queue.
      expect((await h.one<{ groups: Array<{ dealId: string }> }>(FLIGHT, 'select public.flight_queue() as r')).groups.map((g) => g.dealId)).toContain(DEAL);
      // SYNTHETIC FIXTURE: the synthetic Deal marked as removed by the sync (only imported Deals can be, so that
      // check is lifted inside this rolled-back transaction).
      await h.owner('alter table public.deals drop constraint deals_removed_imported_only');
      await h.owner(`update public.deals set removed_at = now(), removed_reason = 'stage_not_eligible' where id = $1`, [DEAL]);
      expect((await h.one<{ groups: Array<{ dealId: string }> }>(FLIGHT, 'select public.flight_queue() as r')).groups.map((g) => g.dealId)).not.toContain(DEAL);
    });
  });
});

describe('R3: a blank traveller name filled on the accepted booking (Addendum 2)', () => {
  const FILL = 'select public.deal_traveller_name_fill($1, $2, $3, $4, $5, $6) as r';
  const SUMMARY = 'select public.deal_flight_summary($1) as r';

  it('the Sales owner fills the blank, also on a committed Deal; Flight gets the traveller on its sectors; refusals', async () => {
    await asOwner(db, async () => {
      await fh.addFlightPeople();
      const b = await fh.unnamedDeal();
      const task = b.flightTasks[0]!;
      await fh.claim();
      await fh.one(FLIGHT_D, 'select public.flight_screenshot_sectors_save($1, $2, $3::jsonb, $4) as r',
        [task, (await fh.stateRow(task))!.row_version, JSON.stringify([sectorInput()]), rid()]);
      const [sector] = await fh.sectors(task);
      expect(await fh.seqsOn(sector!.id)).toEqual([1, 2, 3, 4]);

      // Only the Sales owner may fill; the slot is the next free seq with the missing type.
      const summary = await h.one<{ nameFill: { versionId: string; slots: Array<{ seq: number; type: string | null }> } | null }>(OWNER, SUMMARY, [DEAL]);
      expect(summary.nameFill).toEqual({ versionId: b.versionId, slots: [{ seq: 5, type: 'adult' }] });
      for (const actor of [SALES_B, MANAGER, ACCOUNTS]) {
        expect((await h.one<{ nameFill: unknown } | null>(actor, SUMMARY, [DEAL]))?.nameFill ?? null).toBeNull();
      }

      // SYNTHETIC FIXTURE: the Deal becomes committed (a supplier-confirmed hotel task), written with triggers off.
      await h.owner('set local session_replication_role = replica');
      const [item] = await h.owner<{ id: string }>(
        `insert into public.service_items (deal_id, legal_entity_id, branch_id, item_no, service_type, department, created_by)
         select id, legal_entity_id, branch_id, 19, 'hotel', 'purchase', owner_user_id from public.deals where id = $1 returning id`, [DEAL]);
      await h.owner(
        `insert into public.fulfilment_tasks (deal_id, legal_entity_id, branch_id, booking_version_id, service_purpose, task_key, status,
           assignee_user_id, created_by, service_item_id, department, supplier_confirmed_by, supplier_confirmed_at, selected_quote_id,
           supplier_reference)
         select d.id, d.legal_entity_id, d.branch_id, $2::uuid, 'hotel', 'item:' || $3::text || ':hotel', 'supplier_confirmed', $4::uuid, $4::uuid,
           $3::uuid, 'purchase', $4::uuid, now(), gen_random_uuid(), 'SYN-CONF-R3'
         from public.deals d where d.id = $1`, [DEAL, b.versionId, item!.id, U.purchaseJodhpur]);
      await h.owner('set local session_replication_role = origin');
      expect(await h.owner('select authz.deal_committed($1) as c', [DEAL])).toEqual([{ c: true }]);

      // Refusals.
      for (const actor of [SALES_B, MANAGER, PURCHASE, FLIGHT_D]) {
        await h.refused(actor, FILL, [DEAL, b.versionId, 5, 'Synthetic Traveller Five', 'adult', rid()], '42501');
      }
      await h.refusedWithHint(OWNER, FILL, [DEAL, b.versionId, 5, '   ', 'adult', rid()], /fullName/);
      await h.refusedWithHint(OWNER, FILL, [DEAL, b.versionId, 5, 'Synthetic Traveller Five', 'child', rid()], /type/);
      await h.refusedWithHint(OWNER, FILL, [DEAL, b.versionId, 7, 'Synthetic Traveller Five', 'adult', rid()], /seq/);
      await h.refused(OWNER, FILL, [DEAL, b.versionId, 3, 'Synthetic Traveller Five', 'adult', rid()], '55000', 'name_already_set');
      await h.refused(OWNER, FILL, [DEAL, rid(), 5, 'Synthetic Traveller Five', 'adult', rid()], '40001', 'version_changed');

      // Fill: no new booking version; the traveller is on the flight's sectors; the block clears.
      const versionsBefore = await fh.count('select 1 from public.booking_versions where deal_id = $1', [DEAL]);
      const req = rid();
      expect(await h.one(OWNER, FILL, [DEAL, b.versionId, 5, ' Synthetic Traveller Five ', 'adult', req]))
        .toMatchObject({ seq: 5, type: 'adult', outcome: 'created' });
      expect(await h.one(OWNER, FILL, [DEAL, b.versionId, 5, ' Synthetic Traveller Five ', 'adult', req])).toMatchObject({ outcome: 'existing' });
      expect(await fh.count('select 1 from public.booking_versions where deal_id = $1', [DEAL])).toBe(versionsBefore);
      expect(await h.owner('select full_name from public.booking_version_travellers where booking_version_id = $1 and seq = 5', [b.versionId]))
        .toEqual([{ full_name: 'Synthetic Traveller Five' }]);
      expect(await h.owner('select full_name from public.deal_travellers where deal_id = $1 and seq = 5', [DEAL]))
        .toEqual([{ full_name: 'Synthetic Traveller Five' }]);
      expect(await fh.seqsOn(sector!.id)).toEqual([1, 2, 3, 4, 5]);
      expect(await h.owner('select authz.flight_unnamed_count($1) as n', [task])).toEqual([{ n: 0 }]);
      expect((await h.owner<{ i: string[] }>('select authz.flight_done_issues($1) as i', [DEAL]))[0]!.i).not.toContain('travellers_unnamed');
      expect(await h.one(FLIGHT_D, 'select public.flight_home_counts() as r')).toMatchObject({ flightTravellersNamed: 1 });
      expect(await h.one(OWNER, 'select public.flight_home_counts() as r')).toMatchObject({ salesTravellersToName: 0 });
      const [audit] = await h.owner<{ details: Record<string, unknown>; target_id: string }>(
        `select details, target_id from public.audit_events where action = 'booking.traveller_name_filled'`);
      expect(audit).toMatchObject({ target_id: b.versionId, details: { dealId: DEAL, seq: 5, type: 'adult' } });
      expect(JSON.stringify(audit)).not.toMatch(/Synthetic Traveller Five/);
      // The guard bypass is not reachable from an API role, even with the flag set by hand.
      await h.run(OWNER, `select set_config('authz.traveller_fill', 'fill:' || txid_current()::text, true)`);
      await h.refused(OWNER, `insert into public.service_item_travellers (booking_version_id, service_item_id, legal_entity_id, traveller_seq)
          select booking_version_id, service_item_id, legal_entity_id, 9 from public.service_item_facts where booking_version_id = $1
          returning 1 as r`, [b.versionId], '42501');
      await h.owner(`select set_config('authz.traveller_fill', '', true)`);
      // Nothing left to fill.
      expect((await h.one<{ nameFill: { slots: unknown[] } }>(OWNER, SUMMARY, [DEAL])).nameFill.slots).toEqual([]);
      await h.refused(OWNER, FILL, [DEAL, b.versionId, 6, 'Synthetic Traveller Six', 'adult', rid()], '55000', 'name_already_set');
    });
  });
});
