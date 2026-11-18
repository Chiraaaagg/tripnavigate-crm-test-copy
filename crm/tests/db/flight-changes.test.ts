import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import {
  ACC, DEAL, DEAL2, FLIGHT, FLIGHT_2, LEG_DEL_GOI, LEG_JDH_DEL, MANAGER, OWNER, PURCHASE, SALES_B, SQL, VISA, changeSector, flightHelpers, rid,
  typedFlight,
} from './flight-support';

/**
 * Flight build, contract D5 and sections 4, 6.1 A6-A9; test plan 12.1
 * "Changes": Flight saves an alternative / added sector / passenger
 * itinerary and chooses which passengers move.
 *   - Package Deal: the Sales owner decides (reject needs a reason; the
 *     passengers return to their previous sector). Without an active Sales
 *     owner the branch Manager decides (L3). Nobody else; never the
 *     requester (not_self_approval).
 *   - Flight-only Deal: "Save and apply" in one step, decided by the Flight
 *     task owner (decider_kind flight_owner, L12).
 *   - added_instead / added_extra follow the same rule.
 *   - An approved change is bound to the basis version; NO booking version
 *     is created.
 *   - Held travellers cannot be ticketed or moved again; duplicate flight,
 *     no difference, already confirmed, withdraw, acknowledge.
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
const REMARK = 'Synthetic: customer asked for the evening flight';
const REJECT = 'Synthetic: the customer prefers the original flight';
const LATER = changeSector({ from: 'JDH', to: 'DEL', departDate: '2026-12-10', departTime: '18:20', arriveTime: '19:35', flightNo: 'AI 472', airline: 'Air India' });

type Change = { changeId: string; changeNo: number; status: string; sectorIds: string[] };
type ChangeRow = { status: string; kind: string; deal_kind: string; decider_kind: string; requested_by: string; decided_by: string | null;
  reject_reason: string | null; basis_version_id: string; row_version: number; flight_seen_at: string | null };
const changeRow = async (id: string) => (await owner<ChangeRow>(
  `select status, kind, deal_kind, decider_kind, requested_by, decided_by, reject_reason, basis_version_id, row_version, flight_seen_at
   from public.flight_changes where id = $1`, [id]))[0]!;
const submit = (task: string, fields: Record<string, unknown>, actor = FLIGHT) =>
  one<Change>(actor, SQL.changeSubmit, [task, JSON.stringify({ remark: REMARK, ...fields }), rid()]);
const decide = async (actor: typeof OWNER, changeId: string, decision: 'approve' | 'reject', reason: string | null = null) =>
  one<Record<string, unknown>>(actor, SQL.changeDecide, [changeId, decision, reason, (await changeRow(changeId)).row_version, rid()]);

/** Package Deal (hotel + one typed flight JDH-DEL-GOI, everyone), taken by Flight. */
async function packageTaken() {
  await h.addFlightPeople();
  const b = await h.packageDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL, LEG_DEL_GOI]) }]);
  await h.claim();
  const [leg1, leg2] = await h.sectors(b.flightTasks[0]!);
  return { b, task: b.flightTasks[0]!, leg1: leg1!, leg2: leg2! };
}

describe('package Deal: the Sales owner decides', () => {
  it('alternative with passenger choice: pending, held, approved by the Sales owner only, bound to the basis, no new booking version', async () => {
    await asOwner(db, async () => {
      const { b, task, leg1 } = await packageTaken();
      expect(await h.dealKind(DEAL)).toBe('package');
      const versions = await owner<{ n: number }>('select count(*)::int as n from public.booking_versions where deal_id = $1', [DEAL]);
      const c = await submit(task, { kind: 'alternative', fromSectorIds: [leg1.id], travellerSeqs: [1], sectors: [LATER] });
      expect(c).toMatchObject({ status: 'pending', changeNo: 1 });
      expect(await changeRow(c.changeId)).toMatchObject({ kind: 'alternative', deal_kind: 'package', decider_kind: 'sales_owner',
        requested_by: U.movedStaff, decided_by: null, basis_version_id: b.versionId });
      expect(await h.onSector(leg1.id)).toEqual([
        { traveller_seq: 1, held_by_change_id: c.changeId }, { traveller_seq: 2, held_by_change_id: null },
        { traveller_seq: 3, held_by_change_id: null }, { traveller_seq: 4, held_by_change_id: null }]);
      const [pending] = await owner<{ id: string; status: string; origin: string }>('select id, status, origin from public.flight_sectors where change_id = $1', [c.changeId]);
      expect(pending).toMatchObject({ status: 'pending', origin: 'change' });
      expect(await h.seqsOn(pending!.id)).toEqual([1]);
      // Pending pairs count in required, cannot be confirmed: 8 - 1 held + 1 pending = 8.
      const { c: counts } = (await owner<{ c: { confirmed: number; required: number } }>('select to_jsonb(x) as c from authz.flight_ticket_counts($1) x', [task]))[0]!;
      expect(counts).toEqual({ confirmed: 0, required: 8 });
      // Mark done is blocked while anything waits; the Sales owner sees it to decide.
      expect((await owner<{ i: string[] }>('select authz.flight_done_issues($1) as i', [DEAL]))[0]!.i).toContain('change_pending');
      expect(await one<Record<string, number | null>>(OWNER, SQL.homeCounts)).toMatchObject({ salesFlightChangesToDecide: 1 });
      const summary = await one<{ flights: Array<{ pending: Array<{ changeId: string; canDecide: boolean }> }> }>(OWNER, SQL.dealSummary, [DEAL]);
      expect(summary.flights[0]!.pending).toEqual([expect.objectContaining({ changeId: c.changeId, canDecide: true })]);

      // Nobody else decides.
      for (const actor of [SALES_B, FLIGHT, FLIGHT_2, PURCHASE, VISA, ACC, MANAGER]) {
        await refused(actor, SQL.changeDecide, [c.changeId, 'approve', null, (await changeRow(c.changeId)).row_version, rid()],
          actor === FLIGHT ? '(not_authorized|not_self_approval)' : 'not_authorized');
      }
      await refused(OWNER, SQL.changeDecide, [c.changeId, 'approve', null, 99, rid()], 'version_changed', '40001');
      await refusedHint(OWNER, SQL.changeDecide, [c.changeId, 'maybe', null, (await changeRow(c.changeId)).row_version, rid()], 'invalid_input');

      await decide(OWNER, c.changeId, 'approve');
      expect(await changeRow(c.changeId)).toMatchObject({ status: 'approved', decided_by: U.salesDelhiA, basis_version_id: b.versionId });
      expect(await h.seqsOn(leg1.id)).toEqual([2, 3, 4]);
      expect(await owner(`select ended_reason, ended_by_change_id from public.flight_sector_passengers where sector_id = $1 and traveller_seq = 1`, [leg1.id]))
        .toEqual([{ ended_reason: 'change_approved', ended_by_change_id: c.changeId }]);
      expect(await owner('select status from public.flight_sectors where id = $1', [pending!.id])).toEqual([{ status: 'active' }]);
      expect(await owner('select count(*)::int as n from public.booking_versions where deal_id = $1', [DEAL])).toEqual(versions);
      await refused(OWNER, SQL.changeDecide, [c.changeId, 'reject', REJECT, (await changeRow(c.changeId)).row_version, rid()], 'already_decided', '55000');
      // Flight acknowledges the decision once (Home row clears).
      expect(await one<Record<string, number | null>>(FLIGHT, SQL.homeCounts)).toMatchObject({ flightChangesDecided: 1 });
      await refused(FLIGHT_2, SQL.changeAck, [c.changeId], 'not_authorized', '42501');
      await one(FLIGHT, SQL.changeAck, [c.changeId]);
      expect((await changeRow(c.changeId)).flight_seen_at).not.toBeNull();
      expect(await one(FLIGHT, SQL.changeAck, [c.changeId])).toMatchObject({ outcome: 'existing' });
      expect(await one<Record<string, number | null>>(FLIGHT, SQL.homeCounts)).toMatchObject({ flightChangesDecided: 0 });
      // The Deal page shows the current flight: traveller 1 on the approved flight.
      const after = await one<{ flights: Array<{ current: Array<{ flightNo: string; travellers: string[] }> }> }>(OWNER, SQL.dealSummary, [DEAL]);
      expect(after.flights[0]!.current.find((s) => s.flightNo === 'AI 472')?.travellers).toEqual(['Synthetic Traveller One']);
      // Audit.
      expect((await owner<{ action: string }>(`select action from public.audit_events where action like 'flight.change_%' order by id`)).map((a) => a.action))
        .toEqual(['flight.change_submitted', 'flight.change_approved']);
    });
  });

  it('reject needs a reason; the passengers go back to their previous flight', async () => {
    await asOwner(db, async () => {
      const { task, leg1 } = await packageTaken();
      const c = await submit(task, { kind: 'alternative', fromSectorIds: [leg1.id], travellerSeqs: [2, 3], sectors: [LATER] });
      await refusedHint(OWNER, SQL.changeDecide, [c.changeId, 'reject', null, (await changeRow(c.changeId)).row_version, rid()], 'invalid_input');
      await refusedHint(OWNER, SQL.changeDecide, [c.changeId, 'reject', 'too short', (await changeRow(c.changeId)).row_version, rid()], 'invalid_input');
      await decide(OWNER, c.changeId, 'reject', REJECT);
      expect(await changeRow(c.changeId)).toMatchObject({ status: 'rejected', reject_reason: REJECT, decided_by: U.salesDelhiA });
      expect(await h.onSector(leg1.id)).toEqual([1, 2, 3, 4].map((s) => ({ traveller_seq: s, held_by_change_id: null })));
      expect(await owner('select status from public.flight_sectors where change_id = $1', [c.changeId])).toEqual([{ status: 'rejected' }]);
      expect(await owner(`select distinct ended_reason from public.flight_sector_passengers where added_by_change_id = $1`, [c.changeId]))
        .toEqual([{ ended_reason: 'change_rejected' }]);
      const [audit] = await owner<{ reason: string }>(`select reason from public.audit_events where action = 'flight.change_rejected'`);
      expect(audit!.reason).toBe(REJECT);
    });
  });

  it('validation: passenger choice required, remark required, not on sector, held, no difference, duplicate flight', async () => {
    await asOwner(db, async () => {
      const { task, leg1, leg2 } = await packageTaken();
      const base = { kind: 'alternative', fromSectorIds: [leg1.id], sectors: [LATER] };
      await refusedHint(FLIGHT, SQL.changeSubmit, [task, JSON.stringify({ ...base, travellerSeqs: [], remark: REMARK }), rid()], 'invalid_input', /travellerSeqs/);
      await refusedHint(FLIGHT, SQL.changeSubmit, [task, JSON.stringify({ ...base, travellerSeqs: [1] }), rid()], 'invalid_input', /remark/);
      await refusedHint(FLIGHT, SQL.changeSubmit, [task, JSON.stringify({ ...base, travellerSeqs: [1], remark: 'ok' }), rid()], 'invalid_input', /remark/);
      await refusedHint(FLIGHT, SQL.changeSubmit, [task, JSON.stringify({ ...base, kind: 'reroute', travellerSeqs: [1], remark: REMARK }), rid()], 'invalid_input', /kind/);
      await refusedHint(FLIGHT, SQL.changeSubmit, [task, JSON.stringify({ ...base, travellerSeqs: [1, 1], remark: REMARK }), rid()], 'invalid_input');
      await refused(FLIGHT, SQL.changeSubmit, [task, JSON.stringify({ ...base, travellerSeqs: [7], remark: REMARK }), rid()], 'traveller_not_on_sector', '22023');
      await refused(FLIGHT, SQL.changeSubmit, [task, JSON.stringify({ ...base, fromSectorIds: [rid()], travellerSeqs: [1], remark: REMARK }), rid()], 'not_found', 'P0002');
      // Identical to its from-sector.
      await refused(FLIGHT, SQL.changeSubmit, [task, JSON.stringify({ ...base, travellerSeqs: [1], remark: REMARK, sectors: [changeSector({
        from: 'JDH', to: 'DEL', departDate: '2026-12-10', departTime: '10:35', arriveTime: '11:50', flightNo: 'AI 470', airline: 'Air India' })] }), rid()],
      'no_difference', '22023');
      // Extra journey on exactly an active flight every chosen traveller is already on.
      await refused(FLIGHT, SQL.changeSubmit, [task, JSON.stringify({ kind: 'added_extra', fromSectorIds: [], travellerSeqs: [1, 2], remark: REMARK,
        sectors: [changeSector({ from: 'DEL', to: 'GOI', departDate: '2026-12-10', departTime: '14:00', arriveTime: '16:35', flightNo: 'AI 883', airline: 'Air India' })] }), rid()],
      'duplicate_flight', '22023');
      // Held by a pending change: cannot be moved again.
      await submit(task, { ...base, travellerSeqs: [1] });
      await refused(FLIGHT, SQL.changeSubmit, [task, JSON.stringify({ ...base, travellerSeqs: [1], remark: REMARK,
        sectors: [{ ...LATER, flightNo: 'AI 474' }] }), rid()], 'held_by_change', '55000');
      // Only the Flight assignee submits.
      await refused(FLIGHT_2, SQL.changeSubmit, [task, JSON.stringify({ ...base, travellerSeqs: [2], remark: REMARK }), rid()], 'not_authorized', '42501');
      await refused(OWNER, SQL.changeSubmit, [task, JSON.stringify({ ...base, travellerSeqs: [2], remark: REMARK }), rid()], 'not_authorized', '42501');
      void leg2;
    });
  });

  it('a traveller with a ticket on the from-sector cannot be moved (already_confirmed); a held traveller cannot be ticketed', async () => {
    await asOwner(db, async () => {
      const { task, leg1, leg2 } = await packageTaken();
      const supplierId = await h.flightSupplier();
      await h.confirmTickets({ sectorIds: [leg1.id], supplierId, seqs: [1] });
      await refused(FLIGHT, SQL.changeSubmit, [task, JSON.stringify({ kind: 'alternative', fromSectorIds: [leg1.id], travellerSeqs: [1], remark: REMARK,
        sectors: [LATER] }), rid()], 'already_confirmed', '55000');
      await submit(task, { kind: 'alternative', fromSectorIds: [leg2.id], travellerSeqs: [2],
        sectors: [changeSector({ from: 'DEL', to: 'GOI', departDate: '2026-12-10', departTime: '19:00', arriveTime: '21:20', flightNo: 'AI 889', airline: 'Air India' })] });
      await h.refusedHint(FLIGHT, SQL.ticketsConfirm, [DEAL, JSON.stringify({ sectorIds: [leg2.id], supplierId, fareApprovalId: null,
        fares: [{ paxType: 'adult', basicPaise: '500000', kPaise: '0', yqPaise: '0', yrPaise: '0', otherPaise: '0' }],
        travellers: [{ seq: 2, crsType: 'amadeus', crsPnr: 'HLD001', airlinePnr: 'HLD002', ticketNumber: '098-5555555555' }] }), rid()],
      'traveller_not_on_sector');
    });
  });

  it('added_instead and added_extra need the same Sales owner approval; "Instead of" replaces the from-sectors', async () => {
    await asOwner(db, async () => {
      const { task, leg1, leg2 } = await packageTaken();
      const instead = await submit(task, { kind: 'added_instead', fromSectorIds: [leg1.id, leg2.id], travellerSeqs: [1, 2, 3, 4],
        sectors: [changeSector({ from: 'JDH', to: 'GOI', departDate: '2026-12-10', departTime: '12:00', arriveTime: '14:10', flightNo: '6E 505', airline: 'IndiGo' })] });
      const extra = await submit(task, { kind: 'added_extra', fromSectorIds: [], travellerSeqs: [3],
        sectors: [changeSector({ from: 'GOI', to: 'BOM', departDate: '2026-12-12', departTime: '09:00', arriveTime: '10:10', flightNo: 'UK 840', airline: 'Vistara' })] });
      for (const c of [instead, extra]) {
        expect(c.status).toBe('pending');
        expect(await changeRow(c.changeId)).toMatchObject({ decider_kind: 'sales_owner' });
        await refused(FLIGHT, SQL.changeDecide, [c.changeId, 'approve', null, (await changeRow(c.changeId)).row_version, rid()], '(not_authorized|not_self_approval)');
      }
      await decide(OWNER, instead.changeId, 'approve');
      await decide(OWNER, extra.changeId, 'approve');
      expect(await h.onSector(leg1.id)).toEqual([]);
      expect(await h.onSector(leg2.id)).toEqual([]);
      const ws = await one<{ flights: Array<{ sectors: Array<{ sectorId: string; displayState: string }> }> }>(FLIGHT, SQL.workspace, [DEAL]);
      const states = Object.fromEntries(ws.flights[0]!.sectors.map((s) => [s.sectorId, s.displayState]));
      expect([states[leg1.id], states[leg2.id]]).toEqual(['replaced', 'replaced']);
      const active = await h.sectors(task);
      expect(active.filter((s) => s.origin === 'change').map((s) => s.flight_no).sort()).toEqual(['6E 505', 'UK 840']);
      // The extra journey added traveller 3 without ending anything else.
      const extraSector = active.find((s) => s.flight_no === 'UK 840')!;
      expect(await h.seqsOn(extraSector.id)).toEqual([3]);
    });
  });

  it('fallback: without an active Sales owner the branch Manager decides (and never their own request)', async () => {
    await asOwner(db, async () => {
      const { task, leg1 } = await packageTaken();
      // SYNTHETIC FIXTURE: the Deal owner's Sales membership ends after booking (left the team).
      await owner(`update public.memberships set status = 'inactive', deactivated_at = now() where user_id = $1 and role_code = 'sales'`, [U.salesDelhiA]);
      const c = await submit(task, { kind: 'alternative', fromSectorIds: [leg1.id], travellerSeqs: [4], sectors: [LATER] });
      expect(await changeRow(c.changeId)).toMatchObject({ decider_kind: 'branch_manager' });
      await refused(SALES_B, SQL.changeDecide, [c.changeId, 'approve', null, (await changeRow(c.changeId)).row_version, rid()], 'not_authorized', '42501');
      expect(await one<Record<string, number | null>>(MANAGER, SQL.homeCounts)).toMatchObject({ salesFlightChangesToDecide: 1 });
      await decide(MANAGER, c.changeId, 'approve');
      expect(await changeRow(c.changeId)).toMatchObject({ status: 'approved', decided_by: U.managerDelhi });
    });
    await asOwner(db, async () => {
      // The Manager also holds Flight, took the Deal and submits: deciding their own request is refused.
      await h.addFlightPeople();
      const b = await h.packageDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL]) }]);
      await h.addRole(U.managerDelhi, 'flight', 'DEL');
      await owner(`update public.memberships set status = 'inactive', deactivated_at = now() where user_id = $1 and role_code = 'sales'`, [U.salesDelhiA]);
      await h.claim(MANAGER);
      const [leg] = await h.sectors(b.flightTasks[0]!);
      const c = await submit(b.flightTasks[0]!, { kind: 'alternative', fromSectorIds: [leg!.id], travellerSeqs: [1], sectors: [LATER] }, MANAGER);
      expect(await changeRow(c.changeId)).toMatchObject({ decider_kind: 'branch_manager' });
      await refused(MANAGER, SQL.changeDecide, [c.changeId, 'approve', null, (await changeRow(c.changeId)).row_version, rid()], 'not_self_approval', '42501');
    });
  });

  it('withdraw: pending only, by the Flight assignee; sectors withdrawn, holds cleared', async () => {
    await asOwner(db, async () => {
      const { task, leg1 } = await packageTaken();
      const c = await submit(task, { kind: 'alternative', fromSectorIds: [leg1.id], travellerSeqs: [1, 2], sectors: [LATER] });
      await refused(OWNER, SQL.changeWithdraw, [c.changeId, (await changeRow(c.changeId)).row_version, rid()], 'not_authorized', '42501');
      await one(FLIGHT, SQL.changeWithdraw, [c.changeId, (await changeRow(c.changeId)).row_version, rid()]);
      expect((await changeRow(c.changeId)).status).toBe('withdrawn');
      expect(await owner('select status from public.flight_sectors where change_id = $1', [c.changeId])).toEqual([{ status: 'withdrawn' }]);
      expect(await owner(`select distinct ended_reason from public.flight_sector_passengers where added_by_change_id = $1`, [c.changeId]))
        .toEqual([{ ended_reason: 'change_withdrawn' }]);
      expect(await h.onSector(leg1.id)).toEqual([1, 2, 3, 4].map((s) => ({ traveller_seq: s, held_by_change_id: null })));
      await refused(FLIGHT, SQL.changeWithdraw, [c.changeId, (await changeRow(c.changeId)).row_version, rid()], 'already_decided', '55000');
      expect((await owner(`select action from public.audit_events where action = 'flight.change_withdrawn'`)).length).toBe(1);
    });
  });
});

describe('passenger itinerary', () => {
  it('one traveller, all their current sectors; pending is reflected in x of y; approval replaces their sectors', async () => {
    await asOwner(db, async () => {
      const { task, leg1, leg2 } = await packageTaken();
      await refusedHint(FLIGHT, SQL.changeSubmit, [task, JSON.stringify({ kind: 'passenger_itinerary', fromSectorIds: [leg1.id, leg2.id],
        travellerSeqs: [2, 3], remark: REMARK, sectors: [LATER] }), rid()], 'invalid_input', /travellerSeqs/);
      const c = await submit(task, { kind: 'passenger_itinerary', fromSectorIds: [leg1.id, leg2.id], travellerSeqs: [3], sectors: [
        changeSector({ from: 'JDH', to: 'BOM', departDate: '2026-12-10', departTime: '07:05', arriveTime: '08:45', flightNo: 'AI 645', airline: 'Air India' }),
        changeSector({ from: 'BOM', to: 'GOI', departDate: '2026-12-10', departTime: '11:00', arriveTime: '12:15', flightNo: 'AI 663', airline: 'Air India' }),
      ] });
      expect(c.sectorIds).toHaveLength(2);
      // Required: 8 booking pairs - 2 held + 2 pending = 8; the workspace status shows x of y with the pending pairs.
      const { c: counts } = (await owner<{ c: { confirmed: number; required: number } }>('select to_jsonb(x) as c from authz.flight_ticket_counts($1) x', [task]))[0]!;
      expect(counts).toEqual({ confirmed: 0, required: 8 });
      const ws = await one<{ status: { code: string; text: string; required: number }; progress: Array<{ key: string; state: string }> }>(FLIGHT, SQL.workspace, [DEAL]);
      expect(ws.status).toMatchObject({ code: 'in_progress', required: 8 });
      expect(ws.status.text).toBe('In progress · 0 of 8 tickets');
      expect(ws.progress.map((p) => p.key)).toEqual(['take', 'approvals', 'tickets', 'payment', 'etickets', 'done']);
      expect(ws.progress.find((p) => p.key === 'approvals')).toMatchObject({ state: 'current' });
      await decide(OWNER, c.changeId, 'approve');
      for (const s of [leg1, leg2]) expect(await h.seqsOn(s.id)).toEqual([1, 2, 4]);
      for (const id of c.sectorIds) expect(await h.seqsOn(id)).toEqual([3]);
    });
  });
});

describe('flight-only Deal: Save and apply by the Flight task owner', () => {
  it('applies at once, decided by the requester (decider flight_owner); audits submitted and approved', async () => {
    await asOwner(db, async () => {
      await h.addFlightPeople();
      const b = await h.flightOnlyDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL]) }], { deal: DEAL2, actor: SALES_B });
      expect(await h.dealKind(DEAL2)).toBe('flight_only');
      await h.claim(FLIGHT, DEAL2);
      const [leg] = await h.sectors(b.flightTasks[0]!);
      const c = await submit(b.flightTasks[0]!, { kind: 'alternative', fromSectorIds: [leg!.id], travellerSeqs: [1, 2], sectors: [LATER] });
      expect(c.status).toBe('approved');
      expect(await changeRow(c.changeId)).toMatchObject({ deal_kind: 'flight_only', decider_kind: 'flight_owner', requested_by: U.movedStaff,
        decided_by: U.movedStaff });
      expect(await h.seqsOn(leg!.id)).toEqual([3, 4]);
      expect(await owner('select status from public.flight_sectors where change_id = $1', [c.changeId])).toEqual([{ status: 'active' }]);
      expect((await owner<{ action: string }>(`select action from public.audit_events where action like 'flight.change_%' order by id`)).map((a) => a.action))
        .toEqual(['flight.change_submitted', 'flight.change_approved']);
      // The Sales owner of a flight-only Deal has nothing to decide.
      expect(await one<Record<string, number | null>>(SALES_B, SQL.homeCounts)).toMatchObject({ salesFlightChangesToDecide: 0 });
      expect((await owner<{ i: string[] }>('select authz.flight_done_issues($1) as i', [DEAL2]))[0]!.i).not.toContain('change_pending');
    });
  });
});
