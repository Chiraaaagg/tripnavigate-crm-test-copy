import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import {
  ACC, DEAL, FLIGHT, FLIGHT_2, LEG_DEL_GOI, LEG_JDH_DEL, MANAGER, OWNER, PURCHASE, SALES_B, SQL, SUPER, VISA, changeSector, flightHelpers, rid,
  typedFlight,
} from './flight-support';

/**
 * Flight build, contract D9, D12 and sections 9.4, 9.5; test plan 12.1 "Home
 * counts and history kinds" and 12.3 "queue counts match Home counts":
 *   - flight_home_counts(): each key for its role, null for others.
 *   - department_task_history(flight task) carries the new kinds (and the
 *     branch Manager may read it); deal_flight_history for the Sales owner,
 *     the Manager and Accounts only; no amounts, PNRs or ticket numbers.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = flightHelpers(() => db);
const { one, owner } = h;
const REJECT = 'Synthetic: the customer keeps the original flight';
type Counts = Record<string, number | null>;
const FLIGHT_KEYS = ['flightDealsNotTaken', 'flightDealsMine', 'flightBookingChanged', 'flightChangesDecided', 'flightReadyToFinish'];
const SALES_KEYS = ['salesFlightChangesToDecide', 'salesTravellersToName'];

describe('flight_home_counts', () => {
  it('Flight keys for Flight people, Sales keys for the Sales owner / Manager, null for everyone else; equal to the queue', async () => {
    await asOwner(db, async () => {
      await h.addFlightPeople();
      const b = await h.packageDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL, LEG_DEL_GOI]) }]);
      const f = await one<Counts>(FLIGHT, SQL.homeCounts);
      for (const k of FLIGHT_KEYS) expect(typeof f[k], k).toBe('number');
      for (const k of SALES_KEYS) expect(f[k], k).toBeNull();
      expect(f).toMatchObject({ flightDealsNotTaken: 1, flightDealsMine: 0 });
      const s = await one<Counts>(OWNER, SQL.homeCounts);
      for (const k of FLIGHT_KEYS) expect(s[k], k).toBeNull();
      for (const k of SALES_KEYS) expect(typeof s[k], k).toBe('number');
      for (const actor of [PURCHASE, VISA, ACC, SUPER]) {
        const r = await h.attempt<Counts | null>(actor, SQL.homeCounts);
        const c = r.ok ? r.value : null;
        for (const k of [...FLIGHT_KEYS, ...SALES_KEYS]) expect(c?.[k] ?? null, `${actor.userId} ${k}`).toBeNull();
      }
      // Queue tabs and Home rows agree.
      type Q = { groups: Array<{ assigneeName: string | null; assignedToYou: boolean; status: { code: string } }> };
      const q = await one<Q>(FLIGHT, SQL.queue);
      expect(q.groups.filter((g) => g.assigneeName === null).length).toBe(f.flightDealsNotTaken);
      await h.claim();
      const after = await one<Counts>(FLIGHT, SQL.homeCounts);
      const q2 = await one<Q>(FLIGHT, SQL.queue);
      expect(after).toMatchObject({ flightDealsNotTaken: q2.groups.filter((g) => g.assigneeName === null).length,
        flightDealsMine: q2.groups.filter((g) => g.assignedToYou && g.status.code !== 'done').length, flightReadyToFinish: 0 });
      expect(after.flightDealsMine).toBe(1);
      expect(await one<Counts>(FLIGHT_2, SQL.homeCounts)).toMatchObject({ flightDealsNotTaken: 0, flightDealsMine: 0 });
      void b;
    });
  });
});

describe('history', () => {
  it('task history shows flight kinds; Deal history for Sales owner, Manager and Accounts; no amounts, PNRs or numbers', async () => {
    await asOwner(db, async () => {
      await h.addFlightPeople();
      const b = await h.packageDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL, LEG_DEL_GOI]) }]);
      const task = b.flightTasks[0]!;
      await h.claim();
      const [leg1, leg2] = await h.sectors(task);
      const c = await one<{ changeId: string }>(FLIGHT, SQL.changeSubmit, [task, JSON.stringify({ kind: 'alternative', fromSectorIds: [leg2!.id],
        travellerSeqs: [1], remark: 'Synthetic: later connection', sectors: [changeSector({ from: 'DEL', to: 'GOI', departDate: '2026-12-10',
          departTime: '19:00', arriveTime: '21:20', flightNo: 'AI 889', airline: 'Air India' })] }), rid()]);
      const [cr] = await owner<{ row_version: number }>('select row_version from public.flight_changes where id = $1', [c.changeId]);
      await one(OWNER, SQL.changeDecide, [c.changeId, 'reject', REJECT, cr!.row_version, rid()]);
      const supplierId = await h.flightSupplier();
      const pnr = 'HST001';
      const ticket = '098-6060606060';
      await h.confirmTickets({ sectorIds: [leg1!.id], supplierId, seqs: [1], tickets: { 1: { airlinePnr: pnr, ticketNumber: ticket } } });

      const taskHistory = await one<{ events?: Array<{ kind: string }>; items?: Array<{ kind: string }> } | Array<{ kind: string }>>(FLIGHT, SQL.taskHistory, [task]);
      const events = (Array.isArray(taskHistory) ? taskHistory : taskHistory.events ?? taskHistory.items ?? []) as Array<{ kind: string }>;
      const kinds = events.map((e) => e.kind);
      for (const k of ['taken', 'change_submitted', 'change_rejected', 'tickets_confirmed']) expect(kinds, k).toContain(k);
      const managerTask = await h.attempt(MANAGER, SQL.taskHistory, [task]);
      expect(managerTask.ok && managerTask.value !== null, 'branch Manager reads flight task history').toBe(true);
      const purchaseTask = await h.attempt(PURCHASE, SQL.taskHistory, [task]);
      expect(purchaseTask.ok && purchaseTask.value !== null).toBe(false);

      type DH = { events: Array<{ at: string; kind: string; note: string | null; changeNo: number | null; byYou: boolean }>; truncated: boolean };
      for (const actor of [OWNER, MANAGER, ACC]) {
        const dh = await one<DH>(actor, SQL.dealHistory, [DEAL]);
        expect(dh.truncated).toBe(false);
        expect(dh.events.map((e) => e.kind)).toEqual(expect.arrayContaining(['taken', 'change_submitted', 'change_rejected', 'tickets_confirmed']));
        expect(dh.events.find((e) => e.kind === 'change_rejected')).toMatchObject({ note: REJECT, changeNo: 1 });
        const text = JSON.stringify(dh);
        expect(text).not.toContain(pnr);
        expect(text).not.toContain(ticket.replace('-', ''));
        expect(text).not.toContain(ticket);
        expect(text).not.toMatch(/Paise|"amount/);
      }
      for (const actor of [PURCHASE, VISA, SALES_B]) {
        const r = await h.attempt<DH | null>(actor, SQL.dealHistory, [DEAL]);
        expect(r.ok ? r.value : null, `deal history for ${actor.userId}`).toBeNull();
      }
      // Newest first.
      const dh = await one<DH>(OWNER, SQL.dealHistory, [DEAL]);
      const ats = dh.events.map((e) => e.at);
      expect([...ats].sort().reverse()).toEqual(ats);
      // Audit details of every flight action: no PNR, ticket number or paise.
      const audits = JSON.stringify(await owner(`select details, reason from public.audit_events where action like 'flight.%'`));
      expect(audits).not.toContain(pnr);
      expect(audits).not.toContain('6060606060');
      expect(audits).not.toMatch(/[Pp]aise/);
    });
  });
});
