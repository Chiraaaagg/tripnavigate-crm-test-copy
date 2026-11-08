import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_USERS as U, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { TRAVELLERS } from './b1-support';
import {
  ACC, DEAL, FLIGHT, FLIGHT_2, LEG_JDH_DEL, MANAGER, OWNER, SQL, changeSector, fare, flightHelpers, nextTicket, rid, screenshotFlight, sectorInput, ticketFor,
  typedFlight,
} from './flight-support';

/**
 * Flight build, contract D10, D11 and sections 6.1 A4, A12, 7; test plan
 * 12.1 "Done": every checklist token blocks on its own, in the frozen order;
 * success completes every in-progress task of the group with the outbox
 * event; status words Waiting / In progress · x of y tickets / All tickets
 * confirmed / Done · ticket issued; after done, booking revisions are refused
 * (already_committed, L20) while ticket corrections stay allowed (L13).
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
const TOKEN_ORDER = ['booking_changed', 'travellers_unnamed', 'traveller_without_flight', 'change_pending', 'tickets_pending', 'traveller_changed',
  'fare_approval_pending', 'payment_missing', 'payment_returned', 'eticket_missing'];
const issues = async () => (await owner<{ i: string[] }>('select authz.flight_done_issues($1) as i', [DEAL]))[0]!.i;
const status = async (actor = FLIGHT) => (await one<{ status: { code: string; text: string; confirmed: number; required: number } }>(actor, SQL.workspace, [DEAL])).status;
const FARES = [fare('adult'), fare('child', { basicPaise: '300000' })];

function expectOrdered(list: string[]) {
  const positions = list.map((t) => TOKEN_ORDER.indexOf(t));
  expect(positions.every((p) => p >= 0), `known tokens: ${list.join(',')}`).toBe(true);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
}

describe('mark flight done', () => {
  it('each issue blocks; status words follow the tickets; done completes the group; then revisions are refused', async () => {
    await asOwner(db, async () => {
      await h.addFlightPeople();
      await h.addSecondAccounts();
      const b = await h.packageDeal([
        { type: 'flight', facts: typedFlight([LEG_JDH_DEL]), budget: '5000000' },
        { type: 'flight', facts: screenshotFlight(4), budget: '5000000' },
      ]);
      const [onward, ret] = b.flightTasks as [string, string];
      expect(await status(MANAGER)).toMatchObject({ code: 'waiting', text: 'Waiting' });
      await h.claim();
      // A screenshot flight has no sectors yet: nobody is on it, nothing is ticketable there.
      let now = await issues();
      expectOrdered(now);
      expect(now).toEqual(['traveller_without_flight', 'tickets_pending', 'eticket_missing']);
      await refusedHint(FLIGHT, SQL.groupComplete, [DEAL, b.flightTasks, rid()], 'not_ready', /traveller_without_flight/);
      expect(await status()).toMatchObject({ code: 'in_progress', text: 'In progress · 0 of 4 tickets', confirmed: 0, required: 4 });

      // D11: Flight types the screenshot sectors (no approval).
      await refusedHint(FLIGHT, SQL.screenshotSave, [ret, (await h.stateRow(ret))!.row_version, JSON.stringify([sectorInput({ departTime: '' })]), rid()], 'invalid_input');
      await refused(FLIGHT, SQL.screenshotSave, [onward, (await h.stateRow(onward))!.row_version, JSON.stringify([sectorInput()]), rid()], 'not_ready', '55000');
      await one(FLIGHT, SQL.screenshotSave, [ret, (await h.stateRow(ret))!.row_version, JSON.stringify([sectorInput()]), rid()]);
      const [retSector] = await h.sectors(ret);
      expect(retSector).toMatchObject({ origin: 'screenshot', from_place: 'GOI', to_place: 'JDH', flight_no: '6E 211' });
      expect(await h.seqsOn(retSector!.id)).toEqual([1, 2, 3, 4]);
      expect(await issues()).toEqual(['tickets_pending', 'eticket_missing']);
      expect(await status()).toMatchObject({ text: 'In progress · 0 of 8 tickets' });

      // change_pending.
      const [onSector] = await h.sectors(onward);
      const c = await one<{ changeId: string }>(FLIGHT, SQL.changeSubmit, [onward, JSON.stringify({ kind: 'alternative', fromSectorIds: [onSector!.id],
        travellerSeqs: [2], remark: 'Synthetic: earlier flight', sectors: [changeSector({ from: 'JDH', to: 'DEL', departDate: '2026-12-10', departTime: '06:00',
          arriveTime: '07:15', flightNo: 'AI 468', airline: 'Air India' })] }), rid()]);
      expect(await issues()).toContain('change_pending');
      const [cr] = await owner<{ row_version: number }>('select row_version from public.flight_changes where id = $1', [c.changeId]);
      await one(FLIGHT, SQL.changeWithdraw, [c.changeId, cr!.row_version, rid()]);
      expect(await issues()).not.toContain('change_pending');

      // Tickets for the onward flight: x of y, payment_missing appears.
      const supplierId = await h.flightSupplier();
      await h.approvedBank(supplierId);
      const b1 = await h.confirmTickets({ sectorIds: [onSector!.id], supplierId, seqs: [1, 2, 3, 4], fares: FARES });
      expect(await status()).toMatchObject({ text: 'In progress · 4 of 8 tickets', confirmed: 4, required: 8 });
      expect(await issues()).toEqual(['tickets_pending', 'payment_missing', 'eticket_missing']);
      const b2 = await h.confirmTickets({ sectorIds: [retSector!.id], supplierId, seqs: [1, 2, 3, 4], fares: FARES });
      expect(await status()).toMatchObject({ code: 'all_confirmed', text: 'All tickets confirmed', confirmed: 8, required: 8 });
      // Screenshot sectors are read-only once ticketed.
      await refused(FLIGHT, SQL.screenshotSave, [ret, (await h.stateRow(ret))!.row_version,
        JSON.stringify([sectorInput({ sectorId: retSector!.id, departTime: '10:00' })]), rid()], 'already_confirmed', '55000');

      // Payments: direct for both batches (2,200,000 each; 4,400,000 cumulative <= INR 50,000).
      await h.directPay(b1.batchId);
      expect(await issues()).toEqual(['payment_missing', 'eticket_missing']);
      await h.directPay(b2.batchId);
      expect(await issues()).toEqual(['eticket_missing']);
      // payment_returned: Accounts returns one.
      const [entry] = await owner<{ id: string; row_version: number }>('select id, row_version from public.department_cost_entries where flight_batch_id = $1', [b2.batchId]);
      await one(ACC, SQL.expenseReturn, [entry!.id, entry!.row_version, 'Synthetic: wrong proof attached to this payment', rid()]);
      now = await issues();
      expect(now).toContain('payment_returned');
      expectOrdered(now);
      const [again] = await owner<{ row_version: number }>('select row_version from public.department_cost_entries where id = $1', [entry!.id]);
      const { t: b2Task } = (await owner<{ t: string }>('select cost_task_id as t from public.flight_ticket_batches where id = $1', [b2.batchId]))[0]!;
      await one(FLIGHT, SQL.directPayment, [b2.batchId, again!.row_version, JSON.stringify({ paymentMode: 'card', paidOn: h.today(), reference: null,
        proofEvidenceId: await h.evidence(FLIGHT, b2Task!, 'direct_payment_proof') }), rid()]);
      expect(await issues()).toEqual(['eticket_missing']);

      // traveller_changed: Sales renames traveller 4 in a revision; Flight applies; the tickets must be corrected.
      const v2 = await h.revise(b.versionId, async (_v, rv) => (await h.saveTravellers(OWNER, DEAL, rv,
        [...TRAVELLERS.slice(0, 3), { fullName: 'Synthetic Replacement Four', type: 'child', seq: 4, ageYears: 8 }])).rowVersion);
      expect((await issues())[0]).toBe('booking_changed');
      for (const t of b.flightTasks) await one(FLIGHT, SQL.changeApply, [t, b.versionId, v2, rid()]);
      expect(await issues()).toEqual(['traveller_changed', 'eticket_missing']);
      const ws = await one<{ flights: Array<{ sectors: Array<{ travellers: Array<{ seq: number; ticket: { travellerChanged: boolean } | null }> }> }> }>(
        FLIGHT, SQL.workspace, [DEAL]);
      expect(ws.flights.flatMap((f) => f.sectors.flatMap((s) => s.travellers)).filter((t) => t.ticket?.travellerChanged).map((t) => t.seq)).toEqual([4, 4]);
      for (const sector of [onSector!, retSector!]) {
        const [rev] = await owner<{ revision_no: number; crs_type: string; crs_pnr: string | null; airline_pnr: string; ticket_number: string }>(
          `select revision_no, crs_type, crs_pnr, airline_pnr, ticket_number from public.flight_ticket_revisions
           where sector_id = $1 and traveller_seq = 4 order by revision_no desc limit 1`, [sector.id]);
        await one(FLIGHT, SQL.ticketCorrect, [sector.id, 4, rev!.revision_no, JSON.stringify({ crsType: rev!.crs_type, crsPnr: rev!.crs_pnr,
          airlinePnr: rev!.airline_pnr, ticketNumber: nextTicket('176') }),
        'Synthetic: reissued in the corrected name', rid()]);
      }
      expect(await issues()).toEqual(['eticket_missing']);

      // E-ticket: one per Deal group (L19).
      await h.evidence(FLIGHT, onward, 'e_ticket');
      expect(await issues()).toEqual([]);
      expect(await one<{ canComplete: boolean; doneIssues: string[] }>(FLIGHT, SQL.workspace, [DEAL])).toMatchObject({ canComplete: true, doneIssues: [] });
      expect(await one<Record<string, number | null>>(FLIGHT, SQL.homeCounts)).toMatchObject({ flightReadyToFinish: 1 });

      // Complete: expected task set, assignee only.
      await refused(FLIGHT, SQL.groupComplete, [DEAL, [onward], rid()], 'version_changed', '40001');
      for (const actor of [FLIGHT_2, OWNER, MANAGER]) {
        await refused(actor, SQL.groupComplete, [DEAL, b.flightTasks, rid()], 'not_authorized', '42501');
      }
      const req = rid();
      await one(FLIGHT, SQL.groupComplete, [DEAL, b.flightTasks, req]);
      expect(await one(FLIGHT, SQL.groupComplete, [DEAL, b.flightTasks, req])).toMatchObject({ outcome: 'existing' });
      for (const t of b.flightTasks) {
        const row = await owner<{ status: string; completed_by: string; at: boolean }>(
          'select status, completed_by, completed_at is not null as at from public.fulfilment_tasks where id = $1', [t]);
        expect(row).toEqual([{ status: 'completed', completed_by: U.movedStaff, at: true }]);
      }
      expect(await owner(`select count(*)::int as n from public.outbox_events where event_type = 'fulfilment.task_completed' and aggregate_id = any($1::uuid[])`,
        [b.flightTasks])).toEqual([{ n: 2 }]);
      const audits = (await owner<{ action: string }>(`select action from public.audit_events
        where action in ('fulfilment.task_completed', 'flight.group_completed') order by id`)).map((a) => a.action);
      expect(audits.filter((a) => a === 'fulfilment.task_completed')).toHaveLength(2);
      expect(audits.filter((a) => a === 'flight.group_completed')).toHaveLength(1);
      expect(await status()).toMatchObject({ code: 'done', text: 'Done · ticket issued' });
      expect(await status(MANAGER)).toMatchObject({ code: 'done' });
      expect(await one<{ canWork: boolean; canUploadETicket: boolean }>(FLIGHT, SQL.workspace, [DEAL])).toMatchObject({ canUploadETicket: false });

      // L13: ticket identifiers stay correctable after done, without reopening.
      const [rev1] = await owner<{ revision_no: number; crs_type: string; crs_pnr: string | null; airline_pnr: string; ticket_number: string }>(
        `select revision_no, crs_type, crs_pnr, airline_pnr, ticket_number from public.flight_ticket_revisions
         where sector_id = $1 and traveller_seq = 1 order by revision_no desc limit 1`, [onSector!.id]);
      await one(FLIGHT, SQL.ticketCorrect, [onSector!.id, 1, rev1!.revision_no, JSON.stringify({ crsType: rev1!.crs_type, crsPnr: rev1!.crs_pnr,
        airlinePnr: 'AFT001', ticketNumber: rev1!.ticket_number }), 'Synthetic: the airline changed the PNR', rid()]);
      expect((await h.taskRow(onward)).status).toBe('completed');
      // New e-tickets need an open task (existing rule: task closed).
      await refused(FLIGHT, SQL.evBegin, [onward, null, 'e_ticket', 'e-ticket.pdf', 'application/pdf', 2048, 'b'.repeat(64)], '(task_closed|not_authorized)');
      // L20: the Deal is committed; no more booking revisions.
      await one(ACC, SQL.reviewReturn, [v2, 'Synthetic: Accounts returned after done', rid()]);
      await refused(OWNER, SQL.openRevision, [v2], 'already_committed', '55000');
      void ticketFor;
    });
  });

  it('a flight with no sectors cannot be done; a pending fare approval blocks', async () => {
    await asOwner(db, async () => {
      await h.addFlightPeople();
      await h.packageDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL]), budget: '100000' }]);
      await h.claim();
      const [s] = await h.sectors((await owner<{ id: string }>(`select id from public.fulfilment_tasks where deal_id = $1 and department = 'flight'`, [DEAL]))[0]!.id);
      const supplierId = await h.flightSupplier();
      await one(FLIGHT, SQL.fareApprovalRequest, [DEAL, JSON.stringify({ sectorIds: [s!.id], supplierId, fares: [fare('adult')], travellers: [{ seq: 1 }] }), rid()]);
      const list = await issues();
      expect(list).toContain('fare_approval_pending');
      expect(list).toContain('tickets_pending');
      expectOrdered(list);
    });
  });
});
