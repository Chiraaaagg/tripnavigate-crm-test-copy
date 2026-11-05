import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import {
  DEAL, DEAL2, FLIGHT, FLIGHT_2, LEG_BLANK, LEG_DEL_GOI, LEG_JDH_DEL, MANAGER, MANAGER_AMD, OWNER, PURCHASE, SALES_B, SQL, VISA,
  flightHelpers, rid, screenshotFlight, typedFlight,
} from './flight-support';

/**
 * Flight build, contract D1 and section 6.1 A1, A2, A13, 9.1; test plan 12.1
 * "Group claim" and "Reassign":
 *   - The Flight queue has ONE row per Deal; taking takes every open flight
 *     task of the Deal (one Flight person per Deal); flight_task_claim(task)
 *     claims the whole group.
 *   - Claim builds the working itinerary from the accepted booking: one
 *     booking sector per typed leg (fields copied, flight number upper case),
 *     every participant on every booking sector; a screenshot flight gets no
 *     sectors; participant subsets are respected; a Deal assignment of kind
 *     flight is recorded.
 *   - A second Flight person gets task_conflict.
 *   - The branch Manager reassigns the group together (completed tasks keep
 *     their assignee); nobody else may; purchase_task_reassign refuses flight
 *     tasks.
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
const REASON = 'Synthetic: Flight colleague on leave this week';

/** Package Deal: onward typed (2 legs, everyone), return from a screenshot (travellers 1 and 2). */
async function twoFlights() {
  await h.addFlightPeople();
  return h.packageDeal([
    { type: 'flight', facts: typedFlight([LEG_JDH_DEL, { ...LEG_DEL_GOI, flightNo: 'ai  883' }]) },
    { type: 'flight', facts: screenshotFlight(2), participants: [1, 2] },
  ]);
}

describe('flight_group_claim', () => {
  it('takes every flight task of the Deal at once and builds the itinerary from the accepted booking', async () => {
    await asOwner(db, async () => {
      const b = await twoFlights();
      expect(b.flightTasks).toHaveLength(2);
      const req = rid();
      const r = await h.claim(FLIGHT, DEAL, req);
      expect(r.dealId).toBe(DEAL);
      expect([...r.taskIds].sort()).toEqual([...b.flightTasks].sort());
      expect([...r.claimedTaskIds].sort()).toEqual([...b.flightTasks].sort());
      for (const t of b.flightTasks) expect(await h.taskRow(t)).toMatchObject({ status: 'in_progress', assignee_user_id: U.movedStaff });
      // Purchase's hotel task is untouched.
      const hotelTask = b.allTasks.find((t) => !b.flightTasks.includes(t))!;
      expect(await h.taskRow(hotelTask)).toMatchObject({ status: 'not_started', assignee_user_id: null });

      // State rows: basis = the accepted version.
      for (const t of b.flightTasks) expect((await h.stateRow(t))?.basis_version_id).toBe(b.versionId);
      // Typed onward flight: one booking sector per leg, fields copied, flight number normalised.
      const onward = await h.sectors(b.flightTasks[0]!);
      expect(onward.map((s) => [s.origin, s.booking_leg_no, s.from_place, s.to_place, s.depart_date, s.depart_time, s.arrive_time, s.flight_no]))
        .toEqual([
          ['booking', 1, 'JDH', 'DEL', '2026-12-10', '10:35', '11:50', 'AI 470'],
          ['booking', 2, 'DEL', 'GOI', '2026-12-10', '14:00', '16:35', 'AI 883'],
        ]);
      for (const s of onward) {
        expect(s.basis_version_id).toBe(b.versionId);
        expect(await h.seqsOn(s.id)).toEqual([1, 2, 3, 4]);
      }
      const [cabin] = await owner<{ cabin: string; arrive_date: string | null }>('select cabin, arrive_date from public.flight_sectors where id = $1', [onward[0]!.id]);
      expect(cabin).toEqual({ cabin: 'Economy', arrive_date: null });
      // Screenshot flight: no sectors until Flight types them.
      expect(await h.sectors(b.flightTasks[1]!, null)).toEqual([]);
      // Deal assignment of kind flight.
      expect(await owner(`select assignment_kind from public.deal_assignments where deal_id = $1 and user_id = $2 and ended_at is null`,
        [DEAL, U.movedStaff])).toEqual([{ assignment_kind: 'flight' }]);
      // Audit: task_claimed per task (group:true) and one group_claimed.
      const audits = await owner<{ action: string; target_id: string; details: Record<string, unknown> }>(
        `select action, target_id::text, details from public.audit_events
         where action in ('fulfilment.task_claimed', 'flight.group_claimed') and target_id = any($1::uuid[]) order by id`, [b.flightTasks]);
      expect(audits.filter((a) => a.action === 'fulfilment.task_claimed')).toHaveLength(2);
      for (const a of audits.filter((x) => x.action === 'fulfilment.task_claimed')) {
        expect(a.details).toMatchObject({ dealId: DEAL, versionId: b.versionId, department: 'flight', group: true });
      }
      const group = audits.filter((a) => a.action === 'flight.group_claimed');
      expect(group).toHaveLength(1);
      expect(group[0]!.details).toMatchObject({ dealId: DEAL });

      // Same request id again: the stored result, outcome existing; a new id: existing (already the caller's).
      expect(await h.claim(FLIGHT, DEAL, req)).toMatchObject({ outcome: 'existing', dealId: DEAL });
      expect(await h.claim(FLIGHT, DEAL)).toMatchObject({ outcome: 'existing' });
      expect(await h.sectors(b.flightTasks[0]!)).toHaveLength(2);
      // A second Flight person is refused.
      await refused(FLIGHT_2, SQL.groupClaim, [DEAL, rid()], 'task_conflict', '40001');
    });
  });

  it('flight_task_claim(task) claims the whole group; non-Flight callers are refused; participant subsets respected', async () => {
    await asOwner(db, async () => {
      const b = await twoFlights();
      for (const actor of [OWNER, SALES_B, PURCHASE, VISA, MANAGER]) {
        await refused(actor, SQL.groupClaim, [DEAL, rid()], 'not_authorized', '42501');
      }
      const r = await one<{ taskIds?: string[] }>(FLIGHT, SQL.taskClaim, [b.flightTasks[1]]);
      expect([...(r.taskIds ?? [])].sort()).toEqual([...b.flightTasks].sort());
      for (const t of b.flightTasks) expect(await h.taskRow(t)).toMatchObject({ status: 'in_progress', assignee_user_id: U.movedStaff });
      // The legacy single-task claim by another Flight person is a conflict too.
      await refused(FLIGHT_2, SQL.taskClaim, [b.flightTasks[0]], 'task_conflict', '40001');
    });
  });

  it('a typed flight with a participant subset puts only those travellers on its sectors', async () => {
    await asOwner(db, async () => {
      await h.addFlightPeople();
      const b = await h.packageDeal([{ type: 'flight', facts: typedFlight([LEG_BLANK], 2), participants: [2, 4] }]);
      await h.claim();
      const [s] = await h.sectors(b.flightTasks[0]!);
      expect(s).toMatchObject({ from_place: 'DEL', to_place: 'BOM', flight_no: null, airline: null, depart_time: null });
      expect(await h.seqsOn(s!.id)).toEqual([2, 4]);
    });
  });

  it('the queue shows one row per Deal with its flights; canTake for Flight only; Manager reads its branch', async () => {
    await asOwner(db, async () => {
      const b = await twoFlights();
      type Q = { groups: Array<{ dealId: string; status: { code: string; confirmed: number; required: number }; canTake: boolean;
        assignedToYou: boolean; assigneeName: string | null; flights: Array<{ taskId: string; route: string; entryMode: string }> }> };
      const q = await one<Q>(FLIGHT, SQL.queue);
      const row = q.groups.filter((g) => g.dealId === DEAL);
      expect(row, 'one row per Deal').toHaveLength(1);
      expect(row[0]).toMatchObject({ canTake: true, assignedToYou: false, assigneeName: null, status: { code: 'waiting' } });
      expect(row[0]!.flights.map((f) => f.taskId)).toEqual(b.flightTasks);
      expect(row[0]!.flights[0]!.route).toBe('JDH → DEL → GOI');
      expect(row[0]!.flights[1]).toMatchObject({ route: 'From screenshot', entryMode: 'screenshot' });
      // Not taken: required = booking legs × participants (2 × 4 + 0) = 8, confirmed 0.
      expect(row[0]!.status).toMatchObject({ confirmed: 0, required: 8 });
      const forManager = await one<Q>(MANAGER, SQL.queue);
      expect(forManager.groups.find((g) => g.dealId === DEAL)).toMatchObject({ canTake: false });
      const amd = await one<Q | null>(MANAGER_AMD, SQL.queue);
      expect((amd?.groups ?? []).find((g) => g.dealId === DEAL), 'other branch Manager does not see Delhi Deals').toBeUndefined();
      for (const actor of [OWNER, SALES_B, PURCHASE, VISA]) {
        const other = await h.attempt<Q | null>(actor, SQL.queue);
        expect(((other.ok ? other.value : null)?.groups ?? []).find((g) => g.dealId === DEAL), 'not a Flight or Manager reader').toBeUndefined();
      }
      await h.claim();
      const mine = await one<Q>(FLIGHT, SQL.queue);
      expect(mine.groups.find((g) => g.dealId === DEAL)).toMatchObject({ canTake: false, assignedToYou: true, status: { code: 'in_progress' } });
      const theirs = await one<Q>(FLIGHT_2, SQL.queue);
      expect(theirs.groups.find((g) => g.dealId === DEAL)).toMatchObject({ canTake: false, assignedToYou: false });
    });
  });
});

describe('flight_group_reassign', () => {
  it('the branch Manager moves every in-progress task together; completed tasks keep their assignee', async () => {
    await asOwner(db, async () => {
      const b = await twoFlights();
      await h.claim();
      for (const actor of [OWNER, FLIGHT, FLIGHT_2, PURCHASE, MANAGER_AMD]) {
        await refused(actor, SQL.groupReassign, [DEAL, U.movedStaff, U.salesAhmedabad, REASON, rid()], 'not_authorized', '42501');
      }
      await refused(MANAGER, SQL.groupReassign, [DEAL, U.salesAhmedabad, U.salesAhmedabad, REASON, rid()], 'task_conflict', '40001');
      await refusedHint(MANAGER, SQL.groupReassign, [DEAL, U.movedStaff, U.purchaseJodhpur, REASON, rid()], 'invalid_input');
      await refusedHint(MANAGER, SQL.groupReassign, [DEAL, U.movedStaff, U.salesAhmedabad, 'short', rid()], 'invalid_input');

      // SYNTHETIC FIXTURE: the return flight is marked completed as the owner (same assignee; the state
      // guard allows in_progress -> completed for flight once the constraint is widened).
      await owner(`update public.fulfilment_tasks set status = 'completed', completed_at = now(), completed_by = assignee_user_id where id = $1`,
        [b.flightTasks[1]]);
      const r = await one<Record<string, unknown>>(MANAGER, SQL.groupReassign, [DEAL, U.movedStaff, U.salesAhmedabad, REASON, rid()]);
      expect(r).toBeTruthy();
      expect(await h.taskRow(b.flightTasks[0]!)).toMatchObject({ status: 'in_progress', assignee_user_id: U.salesAhmedabad });
      expect(await h.taskRow(b.flightTasks[1]!)).toMatchObject({ status: 'completed', assignee_user_id: U.movedStaff });
      const assignments = await owner<{ user_id: string; ended: boolean }>(
        `select user_id, ended_at is not null as ended from public.deal_assignments where deal_id = $1 and assignment_kind = 'flight' `, [DEAL]);
      expect(assignments.sort((a, b) => Number(b.ended) - Number(a.ended)))
        .toEqual([{ user_id: U.movedStaff, ended: true }, { user_id: U.salesAhmedabad, ended: false }]);
      const audit = await owner<{ action: string; reason: string | null; details: Record<string, unknown> }>(
        `select action, reason, details from public.audit_events where action in ('fulfilment.task_reassigned', 'flight.group_reassigned') order by id`);
      expect(audit.filter((a) => a.action === 'fulfilment.task_reassigned').map((a) => a.details)).toEqual([
        expect.objectContaining({ dealId: DEAL, fromUserId: U.movedStaff, toUserId: U.salesAhmedabad })]);
      expect(audit.find((a) => a.action === 'flight.group_reassigned')?.reason).toBe(REASON);
      // The old Flight person can no longer work; the new one can.
      expect(await one<{ canWork: boolean }>(FLIGHT, SQL.workspace, [DEAL])).toMatchObject({ canWork: false });
      expect(await one<{ canWork: boolean }>(FLIGHT_2, SQL.workspace, [DEAL])).toMatchObject({ canWork: true });
    });
  });

  it('not_ready without an in-progress task; purchase_task_reassign refuses flight tasks', async () => {
    await asOwner(db, async () => {
      const b = await twoFlights();
      await refused(MANAGER, SQL.groupReassign, [DEAL, U.movedStaff, U.salesAhmedabad, REASON, rid()], 'not_ready', '55000');
      await h.claim();
      await refused(MANAGER, SQL.purchaseReassign, [b.flightTasks[0], U.movedStaff, U.salesAhmedabad], 'not_authorized', '42501');
      for (const t of b.flightTasks) expect(await h.taskRow(t)).toMatchObject({ assignee_user_id: U.movedStaff });
    });
  });

  it('one Flight person per Deal: another Deal may be taken by someone else', async () => {
    await asOwner(db, async () => {
      await twoFlights();
      await h.flightOnlyDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL]) }], { deal: DEAL2, actor: SALES_B });
      await h.claim(FLIGHT, DEAL);
      expect(await h.claim(FLIGHT_2, DEAL2)).toMatchObject({ dealId: DEAL2 });
    });
  });
});
