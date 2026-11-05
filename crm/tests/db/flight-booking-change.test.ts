import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { TRAVELLERS } from './b1-support';
import {
  DEAL, FLIGHT, LEG_DEL_GOI, LEG_GOI_JDH, LEG_JDH_DEL, OWNER, SQL, changeSector, flightHelpers, rid, screenshotFlight, typedFlight,
} from './flight-support';

/**
 * Flight build, contract D6 and sections 6.1 A3, 8; test plan 12.1 "Booking
 * change": when Sales sends a new booking version the Flight workspace shows
 * "Booking changed" with a diff; Flight applies it explicitly:
 *   - unchanged legs keep their sector rows and tickets (basis updated);
 *   - changed/removed legs become booking_removed (tickets stay in history),
 *     new/changed legs become new booking sectors with every participant;
 *   - removed participants end traveller_removed, added ones join every
 *     active booking sector;
 *   - pending changes of the task become superseded (holds cleared);
 *   - a stale expected basis or target is version_changed;
 *   - every other workspace command refuses booking_changed meanwhile
 *     (ticket correction is allowed).
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = flightHelpers(() => db);
const { one, owner, refused } = h;
const RENAMED = [...TRAVELLERS.slice(0, 3), { fullName: 'Synthetic Replacement Four', type: 'child', seq: 4, ageYears: 8 }];

/** Searches a JSON value for the first property named `key` (diff layout inside the sections is not frozen). */
function find(value: unknown, key: string): unknown {
  if (Array.isArray(value)) {
    for (const v of value) {
      const f = find(v, key);
      if (f !== undefined) return f;
    }
  } else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (key in o) return o[key];
    for (const v of Object.values(o)) {
      const f = find(v, key);
      if (f !== undefined) return f;
    }
  }
  return undefined;
}

/**
 * Package Deal, one typed flight JDH-DEL-GOI for everyone, taken by Flight;
 * tickets confirmed on both legs for travellers 1, 2 and 4; a pending
 * alternative on leg 2 for traveller 3.
 */
async function ticketed() {
  await h.addFlightPeople();
  const b = await h.packageDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL, LEG_DEL_GOI]) }]);
  const task = b.flightTasks[0]!;
  await h.claim();
  const [leg1, leg2] = await h.sectors(task);
  const supplierId = await h.flightSupplier();
  const batch = await h.confirmTickets({ sectorIds: [leg1!.id, leg2!.id], supplierId, seqs: [1, 2, 4] });
  expect(batch.ticketCount).toBe(6);
  const change = await one<{ changeId: string; status: string }>(FLIGHT, SQL.changeSubmit, [task, JSON.stringify({
    kind: 'alternative', fromSectorIds: [leg2!.id], travellerSeqs: [3], remark: 'Synthetic: later flight for traveller three',
    sectors: [changeSector({ from: 'DEL', to: 'GOI', departDate: '2026-12-10', departTime: '18:00', arriveTime: '20:30', flightNo: 'AI 887', airline: 'Air India' })],
  }), rid()]);
  expect(change.status).toBe('pending');
  return { b, task, leg1: leg1!, leg2: leg2!, supplierId, batch, change };
}

describe('booking re-send detection and diff', () => {
  it('a revision is flagged "Booking changed" with a diff; other commands refuse booking_changed; correction still allowed', async () => {
    await asOwner(db, async () => {
      const { b, task, leg1, leg2, supplierId } = await ticketed();
      const v2 = await h.revise(b.versionId, async (v, rv) => {
        rv = await h.saveFlightFacts(OWNER, b.flightItems[0]!, v, rv,
          typedFlight([LEG_JDH_DEL, { ...LEG_DEL_GOI, flightNo: 'AI 885', departTime: '15:10' }, LEG_GOI_JDH]));
        return (await h.saveTravellers(OWNER, DEAL, rv, RENAMED)).rowVersion;
      });
      expect((await h.stateRow(task))?.basis_version_id).toBe(b.versionId);
      // The read and the command use the same diff.
      const { d } = (await owner<{ d: Record<string, unknown> }>('select authz.flight_booking_diff($1) as d', [task]))[0]!;
      const unchanged = find(d, 'unchanged') as Array<{ oldLegNo: number; newLegNo: number }>;
      expect(unchanged).toEqual([expect.objectContaining({ oldLegNo: 1, newLegNo: 1 })]);
      expect(find(d, 'changed')).toHaveLength(1);
      expect(find(d, 'removed')).toBeDefined();
      const renamed = find(d, 'renamed') as Array<{ seq: number; oldName: string; newName: string }>;
      expect(renamed).toEqual([expect.objectContaining({ seq: 4, oldName: 'Synthetic Traveller Four', newName: 'Synthetic Replacement Four' })]);
      expect(find(d, 'pendingChangesSuperseded')).toBe(1);
      expect(find(d, 'ticketsOnRemoved')).toBe(3); // travellers 1, 2, 4 on the changed leg 2
      expect(find(d, 'ticketsRenamed')).toBeGreaterThanOrEqual(1);

      const ws = await one<{ flights: Array<{ taskId: string; bookingChanged: Record<string, unknown> | null; basisVersionNo: number; currentVersionNo: number }> }>(
        FLIGHT, SQL.workspace, [DEAL]);
      const flight = ws.flights.find((f) => f.taskId === task)!;
      expect(flight.bookingChanged).not.toBeNull();
      expect(flight.bookingChanged).toMatchObject({ fromVersionId: b.versionId, toVersionId: v2 });
      expect([flight.basisVersionNo, flight.currentVersionNo]).toEqual([1, 2]);
      const queue = await one<{ groups: Array<{ dealId: string; chips: { bookingChanged: boolean } }> }>(FLIGHT, SQL.queue);
      expect(queue.groups.find((g) => g.dealId === DEAL)!.chips.bookingChanged).toBe(true);
      const { issues } = (await owner<{ issues: string[] }>('select authz.flight_done_issues($1) as issues', [DEAL]))[0]!;
      expect(issues[0]).toBe('booking_changed');

      // Workspace commands refuse until Flight applies.
      await refused(FLIGHT, SQL.changeSubmit, [task, JSON.stringify({ kind: 'added_extra', fromSectorIds: [], travellerSeqs: [1],
        remark: 'Synthetic extra journey', sectors: [changeSector()] }), rid()], 'booking_changed', '55000');
      await refused(FLIGHT, SQL.fillBlanks, [leg1.id, leg1.row_version, JSON.stringify({ airline: 'Air India' }), rid()], 'booking_changed', '55000');
      await refused(FLIGHT, SQL.ticketsConfirm, [DEAL, JSON.stringify({ sectorIds: [leg1.id], supplierId, fareApprovalId: null,
        fares: [{ paxType: 'adult', basicPaise: '500000', kPaise: '0', yqPaise: '0', yrPaise: '0', otherPaise: '0' }],
        travellers: [{ seq: 3, crsType: 'amadeus', crsPnr: 'ABC123', airlinePnr: 'XYZ789', ticketNumber: '098-1111111111' }] }), rid()],
      'booking_changed', '55000');
      // Correction is allowed while the booking changed.
      const [rev] = await owner<{ revision_no: number; crs_pnr: string; airline_pnr: string }>(
        'select revision_no, crs_pnr, airline_pnr from public.flight_ticket_revisions where sector_id = $1 and traveller_seq = 1', [leg1.id]);
      const corrected = await one<{ revisionNo?: number }>(FLIGHT, SQL.ticketCorrect, [leg1.id, 1, rev!.revision_no, JSON.stringify({
        crsType: 'amadeus', crsPnr: rev!.crs_pnr, airlinePnr: rev!.airline_pnr, ticketNumber: '098-9000000001' }),
      'Synthetic: typo in the ticket number', rid()]);
      expect(corrected).toBeTruthy();
      void leg2;
    });
  });
});

describe('flight_booking_change_apply', () => {
  it('keeps unchanged legs and their tickets, retires changed legs (tickets kept), adds new legs, supersedes pending changes', async () => {
    await asOwner(db, async () => {
      const { b, task, leg1, leg2, change } = await ticketed();
      const ticketsBefore = await owner<{ n: number }>('select count(*)::int as n from public.flight_ticket_revisions where task_id = $1', [task]);
      const v2 = await h.revise(b.versionId, async (v, rv) => h.saveFlightFacts(OWNER, b.flightItems[0]!, v, rv,
        typedFlight([LEG_JDH_DEL, { ...LEG_DEL_GOI, flightNo: 'AI 885', departTime: '15:10' }, LEG_GOI_JDH])));
      // Stale expected basis or target.
      await refused(FLIGHT, SQL.changeApply, [task, v2, v2, rid()], 'version_changed', '40001');
      await refused(FLIGHT, SQL.changeApply, [task, b.versionId, b.versionId, rid()], 'version_changed', '40001');
      // Only the Flight assignee applies.
      await refused(OWNER, SQL.changeApply, [task, b.versionId, v2, rid()], 'not_authorized', '42501');
      const req = rid();
      const applied = await one<{ taskId: string; fromVersionNo: number; toVersionNo: number; keptSectors: number; removedSectors: number;
        addedSectors: number; flaggedTickets: number }>(FLIGHT, SQL.changeApply, [task, b.versionId, v2, req]);
      expect(applied).toMatchObject({ taskId: task, fromVersionNo: 1, toVersionNo: 2, keptSectors: 1, removedSectors: 1, addedSectors: 2, flaggedTickets: 3 });
      expect(await one(FLIGHT, SQL.changeApply, [task, b.versionId, v2, req])).toMatchObject({ taskId: task });
      expect((await h.stateRow(task))?.basis_version_id).toBe(v2);

      // Unchanged leg: same row, new basis, tickets intact.
      const active = await h.sectors(task);
      expect(active.map((s) => [s.from_place, s.to_place, s.flight_no, s.booking_leg_no])).toEqual([
        ['JDH', 'DEL', 'AI 470', 1], ['DEL', 'GOI', 'AI 885', 2], ['GOI', 'JDH', '6E 211', 3]]);
      expect(active[0]!.id).toBe(leg1.id);
      expect(active[0]!.basis_version_id).toBe(v2);
      for (const s of active) expect(await h.seqsOn(s.id)).toEqual([1, 2, 3, 4]);
      // Changed leg: booking_removed, assignments ended booking_changed, tickets kept.
      const [old2] = await owner<{ status: string }>('select status from public.flight_sectors where id = $1', [leg2.id]);
      expect(old2!.status).toBe('booking_removed');
      expect(await h.onSector(leg2.id)).toEqual([]);
      expect(await owner(`select distinct ended_reason from public.flight_sector_passengers where sector_id = $1`, [leg2.id]))
        .toEqual([{ ended_reason: 'booking_changed' }]);
      expect(await owner<{ n: number }>('select count(*)::int as n from public.flight_ticket_revisions where task_id = $1', [task])).toEqual(ticketsBefore);
      // The pending alternative is superseded, its sector too, the hold cleared.
      expect(await owner('select status from public.flight_changes where id = $1', [change.changeId])).toEqual([{ status: 'superseded' }]);
      expect(await owner(`select status from public.flight_sectors where change_id = $1`, [change.changeId])).toEqual([{ status: 'superseded' }]);
      expect(await owner(`select count(*)::int as n from public.flight_sector_passengers where held_by_change_id = $1 and ended_at is null`,
        [change.changeId])).toEqual([{ n: 0 }]);
      // Counts: 3 active legs × 4 travellers = 12 required; confirmed = travellers 1, 2 and 4 on the kept leg 1 = 3.
      const { c } = (await owner<{ c: { confirmed: number; required: number } }>(
        'select to_jsonb(x) as c from authz.flight_ticket_counts($1) x', [task]))[0]!;
      expect(c).toEqual({ confirmed: 3, required: 12 });
      // Confirmed tickets on the removed leg stay listed as "No longer active".
      const ws = await one<{ ticketsByPnr: Array<{ active: boolean; sectors: Array<{ sectorId: string }> }> }>(FLIGHT, SQL.workspace, [DEAL]);
      expect(ws.ticketsByPnr.some((g) => !g.active && g.sectors.some((s) => s.sectorId === leg2.id))).toBe(true);
      // No new booking version was created by Flight.
      expect(await owner('select count(*)::int as n from public.booking_versions where deal_id = $1', [DEAL])).toEqual([{ n: 2 }]);
      // Audit.
      const [audit] = await owner<{ details: Record<string, unknown> }>(
        `select details from public.audit_events where action = 'flight.booking_change_applied' and target_id = $1`, [task]);
      expect(audit!.details).toMatchObject({ dealId: DEAL, fromVersionId: b.versionId, toVersionId: v2, keptSectors: 1, removedSectors: 1, addedSectors: 2 });
      expect(audit!.details.supersededChangeIds).toEqual([change.changeId]);
      // Nothing to apply any more.
      await refused(FLIGHT, SQL.changeApply, [task, v2, v2, rid()], 'not_ready', '55000');
    });
  });

  it('removed participants end traveller_removed; added participants join every active booking sector', async () => {
    await asOwner(db, async () => {
      await h.addFlightPeople();
      const b = await h.packageDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL, LEG_DEL_GOI], 3), participants: [1, 2, 3] }]);
      const task = b.flightTasks[0]!;
      await h.claim();
      const v2 = await h.revise(b.versionId, async (v, rv) =>
        (await one<{ rowVersion: number }>(OWNER, SQL.participants, [b.flightItems[0], v, rv, [1, 2, 4]])).rowVersion);
      const { d } = (await owner<{ d: Record<string, unknown> }>('select authz.flight_booking_diff($1) as d', [task]))[0]!;
      expect(JSON.stringify(find(d, 'passengers') ?? d)).toMatch(/"seq":4/);
      await one(FLIGHT, SQL.changeApply, [task, b.versionId, v2, rid()]);
      for (const s of await h.sectors(task)) expect(await h.seqsOn(s.id)).toEqual([1, 2, 4]);
      expect(await owner(`select distinct ended_reason from public.flight_sector_passengers where task_id = $1 and traveller_seq = 3`, [task]))
        .toEqual([{ ended_reason: 'traveller_removed' }]);
    });
  });

  it('screenshot to typed: every new leg is added; a task taken after the revision starts on the new version', async () => {
    await asOwner(db, async () => {
      await h.addFlightPeople();
      const b = await h.packageDeal([{ type: 'flight', facts: screenshotFlight(4) }, { type: 'flight', facts: typedFlight([LEG_JDH_DEL]) }]);
      const [shotTask, typedTask] = b.flightTasks as [string, string];
      await h.claim();
      expect(await h.sectors(shotTask)).toEqual([]);
      const v2 = await h.revise(b.versionId, async (v, rv) => h.saveFlightFacts(OWNER, b.flightItems[0]!, v, rv, typedFlight([LEG_GOI_JDH])));
      const { d } = (await owner<{ d: Record<string, unknown> }>('select authz.flight_booking_diff($1) as d', [shotTask]))[0]!;
      expect(find(d, 'added')).toBeDefined();
      const applied = await one<{ addedSectors: number; keptSectors: number }>(FLIGHT, SQL.changeApply, [shotTask, b.versionId, v2, rid()]);
      expect(applied).toMatchObject({ addedSectors: 1, keptSectors: 0 });
      expect((await h.sectors(shotTask)).map((s) => [s.origin, s.from_place, s.to_place])).toEqual([['booking', 'GOI', 'JDH']]);
      // The untouched typed flight's basis also lags (the version changed), with nothing to change in its legs.
      const typedDiff = (await owner<{ d: Record<string, unknown> }>('select authz.flight_booking_diff($1) as d', [typedTask]))[0]!.d;
      expect(find(typedDiff, 'unchanged')).toEqual([expect.objectContaining({ oldLegNo: 1, newLegNo: 1 })]);
    });
    await asOwner(db, async () => {
      await h.addFlightPeople();
      const b = await h.packageDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL]) }]);
      const v2 = await h.revise(b.versionId, async (v, rv) => h.saveFlightFacts(OWNER, b.flightItems[0]!, v, rv, typedFlight([LEG_GOI_JDH])));
      await h.claim();
      expect((await h.stateRow(b.flightTasks[0]!))?.basis_version_id).toBe(v2);
      expect((await h.sectors(b.flightTasks[0]!)).map((s) => s.from_place)).toEqual(['GOI']);
      const ws = await one<{ flights: Array<{ bookingChanged: unknown }> }>(FLIGHT, SQL.workspace, [DEAL]);
      expect(ws.flights[0]!.bookingChanged).toBeNull();
    });
  });
});
