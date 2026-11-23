import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb, expectDbError } from '../helpers/db';
import {
  ACC, DEAL, DEAL2, FLIGHT, FLIGHT_2, LEG_DEL_GOI, LEG_JDH_DEL, MANAGER, OWNER, PURCHASE, SALES_B, SQL, VISA, confirmFields, fare, flightHelpers,
  nextPnr, nextTicket, rid, ticketFor, typedFlight,
} from './flight-support';

/**
 * Flight build, contract D7, D8 and sections 5.1 (ticket revisions, number
 * registry), 6.1 A10, 6.2 B8; test plan 12.1 "Tickets":
 *   - CRS type one of five; CRS PNR required unless Airline direct (absent
 *     then); PNRs trimmed, upper-cased, 5-8 letters/digits; ticket number
 *     digits and dashes (spaces removed), 6..20 digits.
 *   - The same ticket number only for one passenger's connecting coupons;
 *     otherwise unique across Deals within the entity (other entity allowed).
 *   - Unnamed travellers cannot get a ticket; already confirmed refused.
 *   - Confirmed rows are locked; "Correct ticket" appends a revision with a
 *     reason, by the Flight task owner or the branch Manager only, old value
 *     kept; a corrected-away number stays reserved for that passenger.
 *   - Audit details never carry PNRs or ticket numbers.
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
const REASON = 'Synthetic: the airline reissued the ticket';

/** Package Deal with one typed flight JDH-DEL-GOI for everyone, taken; a flight supplier. */
async function ready() {
  await h.addFlightPeople();
  const b = await h.packageDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL, LEG_DEL_GOI]) }]);
  await h.claim();
  const [leg1, leg2] = await h.sectors(b.flightTasks[0]!);
  const supplierId = await h.flightSupplier();
  return { b, task: b.flightTasks[0]!, leg1: leg1!, leg2: leg2!, supplierId };
}
const adultFare = [fare('adult')];
const confirmOne = (supplierId: string, sectorIds: string[], traveller: Record<string, unknown>, fares = adultFare) =>
  JSON.stringify({ sectorIds, supplierId, fareApprovalId: null, fares, travellers: [traveller] });
type Rev = { revision_no: number; crs_type: string; crs_pnr: string | null; airline_pnr: string; ticket_number: string; ticket_digits: string;
  traveller_name: string; traveller_type: string; reason: string | null; batch_id: string };
const revisions = (sectorId: string, seq: number) => owner<Rev>(
  `select revision_no, crs_type, crs_pnr, airline_pnr, ticket_number, ticket_digits, traveller_name, traveller_type, reason, batch_id::text
   from public.flight_ticket_revisions where sector_id = $1 and traveller_seq = $2 order by revision_no`, [sectorId, seq]);

describe('flight_tickets_confirm: ticket fields', () => {
  it('validates CRS type, CRS PNR, Airline PNR and ticket number; normalises case and spaces', async () => {
    await asOwner(db, async () => {
      const { leg1, supplierId } = await ready();
      const t = (over: Record<string, unknown>) => confirmOne(supplierId, [leg1.id], { seq: 1, crsType: 'amadeus', crsPnr: 'ABC123', airlinePnr: 'XYZ789',
        ticketNumber: nextTicket(), ...over });
      const cases: Array<[Record<string, unknown>, RegExp]> = [
        [{ crsType: 'worldspan' }, /crsType/],
        [{ crsType: 'Amadeus' }, /crsType/],
        [{ crsPnr: null }, /crsPnr/],
        [{ crsType: 'airline_direct', crsPnr: 'ABC123' }, /crsPnr/],
        [{ airlinePnr: 'AB12' }, /airlinePnr/],
        [{ airlinePnr: 'ABCDE1234' }, /airlinePnr/],
        [{ airlinePnr: 'AB-123' }, /airlinePnr/],
        [{ crsPnr: 'AB 12' }, /crsPnr/],
        [{ ticketNumber: 'ABC1234567' }, /ticketNumber/],
        [{ ticketNumber: '098--2410394501' }, /ticketNumber/],
        [{ ticketNumber: '-0982410394501' }, /ticketNumber/],
        [{ ticketNumber: '0982410394501-' }, /ticketNumber/],
        [{ ticketNumber: '12345' }, /ticketNumber/],
        [{ ticketNumber: '1'.repeat(21) }, /ticketNumber/],
      ];
      for (const [over, hint] of cases) {
        await refusedHint(FLIGHT, SQL.ticketsConfirm, [DEAL, t(over), rid()], 'invalid_input', hint);
      }
      // Normalisation: trimmed, upper case, spaces removed from the ticket number.
      await one(FLIGHT, SQL.ticketsConfirm, [DEAL, t({ crsPnr: ' abc123 ', airlinePnr: 'xyz789', ticketNumber: ' 098 2410 394501 ' }), rid()]);
      expect(await revisions(leg1.id, 1)).toEqual([expect.objectContaining({ revision_no: 1, crs_type: 'amadeus', crs_pnr: 'ABC123',
        airline_pnr: 'XYZ789', ticket_number: '0982410394501', ticket_digits: '0982410394501', reason: null,
        traveller_name: 'Synthetic Traveller One', traveller_type: 'adult' })]);
      // Airline direct: no CRS PNR.
      await one(FLIGHT, SQL.ticketsConfirm, [DEAL, t({ seq: 2, crsType: 'airline_direct', crsPnr: null, airlinePnr: 'DIR001' }), rid()]);
      expect((await revisions(leg1.id, 2))[0]).toMatchObject({ crs_type: 'airline_direct', crs_pnr: null });
      // Every CRS type of the five is accepted.
      for (const [seq, crsType] of [[3, 'galileo'], [4, 'sabre']] as const) {
        const fares = seq === 4 ? [fare('child')] : adultFare;
        await one(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmOne(supplierId, [leg1.id], { seq, crsType, crsPnr: nextPnr(), airlinePnr: nextPnr(),
          ticketNumber: nextTicket() }, fares), rid()]);
      }
      // Audit carries no PNR or ticket number.
      const audit = JSON.stringify(await owner(`select details, reason from public.audit_events where action = 'flight.tickets_confirmed'`));
      expect(audit).not.toMatch(/ABC123|XYZ789|DIR001|0982410394501/);
    });
  });

  it('one ticket number covers one traveller\'s connecting coupons; another traveller, this Deal or another, is refused', async () => {
    await asOwner(db, async () => {
      const { leg1, leg2, supplierId } = await ready();
      const shared = '098-2410394999';
      const batch = await one<{ ticketCount: number; travellersConfirmed: number; stillPending: number }>(FLIGHT, SQL.ticketsConfirm, [DEAL,
        confirmOne(supplierId, [leg1.id, leg2.id], ticketFor(1, { ticketNumber: shared })), rid()]);
      expect(batch).toMatchObject({ ticketCount: 2, travellersConfirmed: 1 });
      expect(batch.stillPending).toBeGreaterThan(0);
      expect((await revisions(leg2.id, 1))[0]!.ticket_number).toBe(shared);
      // Another traveller on this Deal: refused, with or without dashes.
      await refused(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmOne(supplierId, [leg1.id], ticketFor(2, { ticketNumber: '0982410394999' })), rid()],
        'ticket_number_taken', '23505');
      // Two travellers with one number in one batch: refused, nothing stored.
      await refused(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmFields({ sectorIds: [leg1.id], supplierId, fares: adultFare,
        travellers: [ticketFor(2, { ticketNumber: '098-7777777777' }), ticketFor(3, { ticketNumber: '098-7777777777' })] }), rid()],
      'ticket_number_taken', '23505');
      expect(await revisions(leg1.id, 2)).toEqual([]);
      // Another Deal in the same entity.
      const other = await h.flightOnlyDeal([{ type: 'flight', facts: typedFlight([LEG_JDH_DEL]) }], { deal: DEAL2, actor: SALES_B });
      await h.claim(FLIGHT, DEAL2);
      const [otherLeg] = await h.sectors(other.flightTasks[0]!);
      await refused(FLIGHT, SQL.ticketsConfirm, [DEAL2, JSON.stringify({ sectorIds: [otherLeg!.id], supplierId, fareApprovalId: null,
        fares: [fare('adult', { markupPaise: '0', discountPaise: '0' })], travellers: [ticketFor(1, { ticketNumber: shared })] }), rid()],
      'ticket_number_taken', '23505');
      // Another entity holding the same digits does not block this one (registry key is entity + digits).
      const [entityB] = await owner<{ id: string }>(`select id from public.legal_entities where code = 'SYNTHETIC_B'`);
      const { id: rev1 } = (await owner<{ id: string }>('select id from public.flight_ticket_revisions where sector_id = $1 and traveller_seq = 1 limit 1', [leg1.id]))[0]!;
      await owner('set local session_replication_role = replica');
      await owner(`insert into public.flight_ticket_numbers (legal_entity_id, ticket_digits, deal_id, traveller_seq, first_revision_id)
                   values ($1, '0985550001111', $2, 1, $3)`, [entityB!.id, DEAL, rev1]);
      await owner('set local session_replication_role = origin');
      await one(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmOne(supplierId, [leg1.id], ticketFor(2, { ticketNumber: '098-5550001111' })), rid()]);
    });
  });

  it('the same traveller may reuse their number on a later batch; already confirmed pairs are refused', async () => {
    await asOwner(db, async () => {
      const { leg1, leg2, supplierId } = await ready();
      const n = nextTicket();
      await one(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmOne(supplierId, [leg1.id], ticketFor(1, { ticketNumber: n })), rid()]);
      await refused(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmOne(supplierId, [leg1.id], ticketFor(1)), rid()], 'already_confirmed', '55000');
      await one(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmOne(supplierId, [leg2.id], ticketFor(1, { ticketNumber: n })), rid()]);
      expect((await revisions(leg2.id, 1))[0]!.ticket_number).toBe(n);
      // Not on the ticked sectors.
      await refused(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmOne(supplierId, [leg1.id], ticketFor(9)), rid()], 'traveller_not_on_sector', '22023');
      // Only the Flight assignee confirms.
      for (const actor of [FLIGHT_2, OWNER, MANAGER, PURCHASE]) {
        await refused(actor, SQL.ticketsConfirm, [DEAL, confirmOne(supplierId, [leg1.id], ticketFor(2)), rid()], 'not_authorized', '42501');
      }
      // Fares must match the types posted: an adult fare for a child traveller is invalid.
      await refusedHint(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmOne(supplierId, [leg1.id], ticketFor(4)), rid()], 'invalid_input', /fares/);
      // A non-flight supplier is invalid.
      const [entity] = await owner<{ id: string }>(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`);
      const { supplierId: hotelSupplierId } = await one<{ supplierId: string }>(PURCHASE, 'select public.supplier_create($1, $2::jsonb) as r', [entity!.id,
        JSON.stringify({ name: 'Synthetic Stays (hotel only)', serviceTypes: ['hotel'], city: 'Synthetic City', contactName: 'Synthetic Desk',
          contactPhone: '+91 00000 00000', contactEmail: 'desk@example.test', paymentTerms: 'Synthetic' })]);
      const hotelSupplier = { id: hotelSupplierId };
      await refusedHint(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmOne(hotelSupplier.id, [leg1.id], ticketFor(2)), rid()], 'invalid_input', /supplierId/);
    });
  });

  it('confirmed tickets are grouped by Airline PNR in the workspace; ticket rows cannot be updated', async () => {
    await asOwner(db, async () => {
      const { leg1, leg2, supplierId } = await ready();
      const pnr = 'GRP001';
      await one(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmFields({ sectorIds: [leg2.id, leg1.id], supplierId, fares: adultFare,
        travellers: [ticketFor(1, { airlinePnr: pnr }), ticketFor(2, { airlinePnr: pnr })] }), rid()]);
      const ws = await one<{ ticketsByPnr: Array<{ airlinePnr: string; active: boolean; sectors: Array<{ sectorId: string; departTime: string }>;
        travellers: Array<{ seq: number; name: string; ticketNumbers: string[] }> }> }>(FLIGHT, SQL.workspace, [DEAL]);
      const group = ws.ticketsByPnr.filter((g) => g.airlinePnr === pnr);
      expect(group).toHaveLength(1);
      expect(group[0]!.active).toBe(true);
      expect(group[0]!.sectors.map((s) => s.sectorId), 'flights date-sorted').toEqual([leg1.id, leg2.id]);
      expect(group[0]!.travellers.map((t) => [t.seq, t.name])).toEqual([[1, 'Synthetic Traveller One'], [2, 'Synthetic Traveller Two']]);
      // Locked: the table refuses updates even for the owner.
      await expectDbError(db, () => owner(`update public.flight_ticket_revisions set airline_pnr = 'HACK01' where sector_id = $1`, [leg1.id]), {});
      await expectDbError(db, () => owner(`delete from public.flight_ticket_revisions where sector_id = $1`, [leg1.id]), {});
      await expectDbError(db, () => owner(`delete from public.flight_ticket_numbers`), {});
    });
  });
});

describe('unnamed travellers', () => {
  it('"N travellers not named yet": no ticket for them, Sales is told, done is blocked', async () => {
    await asOwner(db, async () => {
      await h.addFlightPeople();
      const b = await h.unnamedDeal();
      const task = b.flightTasks[0]!;
      expect((await owner<{ n: number }>('select authz.flight_unnamed_count($1) as n', [task]))[0]!.n).toBe(1);
      await h.claim();
      await one(FLIGHT, SQL.screenshotSave, [task, (await h.stateRow(task))!.row_version, JSON.stringify([
        { sectorId: null, from: 'GOI', to: 'JDH', departDate: '2026-12-15', departTime: '09:05', arriveDate: null, arriveTime: '11:40', flightNo: '6E 211', airline: 'IndiGo', cabin: 'Economy' },
      ]), rid()]);
      const ws = await one<{ flights: Array<{ unnamedCount: number; travellers: Array<{ seq: number; fullName: string }> }> }>(FLIGHT, SQL.workspace, [DEAL]);
      expect(ws.flights[0]!.unnamedCount).toBe(1);
      // D7: real names are shown to Flight.
      expect(ws.flights[0]!.travellers.map((t) => t.fullName)).toEqual(['Synthetic Traveller One', 'Synthetic Traveller Two', 'Synthetic Traveller Three', 'Synthetic Traveller Four']);
      const [sector] = await h.sectors(task);
      await refused(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmOne(await h.flightSupplier(), [sector!.id], ticketFor(5)), rid()], 'traveller_not_on_sector', '22023');
      expect((await owner<{ i: string[] }>('select authz.flight_done_issues($1) as i', [DEAL]))[0]!.i).toContain('travellers_unnamed');
      expect(await one<Record<string, number | null>>(OWNER, SQL.homeCounts)).toMatchObject({ salesTravellersToName: 1 });
      expect(await one<Record<string, number | null>>(SALES_B, SQL.homeCounts)).toMatchObject({ salesTravellersToName: 0 });
      const q = await one<{ groups: Array<{ dealId: string; chips: { unnamed: number } }> }>(FLIGHT, SQL.queue);
      expect(q.groups.find((g) => g.dealId === DEAL)!.chips.unnamed).toBe(1);
      const summary = await one<{ flights: Array<{ unnamedCount: number }> }>(OWNER, SQL.dealSummary, [DEAL]);
      expect(summary.flights[0]!.unnamedCount).toBe(1);
    });
  });
});

describe('flight_ticket_correct', () => {
  it('appends a revision with a reason (Flight owner or branch Manager only); the old value stays; numbers stay reserved', async () => {
    await asOwner(db, async () => {
      const { leg1, supplierId } = await ready();
      const first = ticketFor(1);
      await one(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmOne(supplierId, [leg1.id], first), rid()]);
      await one(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmOne(supplierId, [leg1.id], ticketFor(2)), rid()]);
      const fields = (over: Record<string, unknown> = {}) => JSON.stringify({ crsType: first.crsType, crsPnr: first.crsPnr, airlinePnr: first.airlinePnr,
        ticketNumber: first.ticketNumber, ...over });
      const fixed = nextTicket();
      for (const actor of [OWNER, SALES_B, FLIGHT_2, PURCHASE, ACC, VISA]) {
        await refused(actor, SQL.ticketCorrect, [leg1.id, 1, 1, fields({ ticketNumber: fixed }), REASON, rid()], 'not_authorized', '42501');
      }
      await refusedHint(FLIGHT, SQL.ticketCorrect, [leg1.id, 1, 1, fields({ ticketNumber: fixed }), 'typo', rid()], 'invalid_input', /reason/);
      await refused(FLIGHT, SQL.ticketCorrect, [leg1.id, 1, 1, fields(), REASON, rid()], 'no_difference', '22023');
      await refused(FLIGHT, SQL.ticketCorrect, [leg1.id, 1, 2, fields({ ticketNumber: fixed }), REASON, rid()], 'version_changed', '40001');
      await refused(FLIGHT, SQL.ticketCorrect, [leg1.id, 3, 1, fields({ ticketNumber: fixed }), REASON, rid()], 'not_found', 'P0002');
      await refusedHint(FLIGHT, SQL.ticketCorrect, [leg1.id, 1, 1, fields({ airlinePnr: 'bad' }), REASON, rid()], 'invalid_input', /airlinePnr/);
      // Traveller 2's number belongs to someone else.
      const [two] = await revisions(leg1.id, 2);
      await refused(FLIGHT, SQL.ticketCorrect, [leg1.id, 1, 1, fields({ ticketNumber: two!.ticket_number }), REASON, rid()], 'ticket_number_taken', '23505');

      await one(FLIGHT, SQL.ticketCorrect, [leg1.id, 1, 1, fields({ ticketNumber: fixed }), REASON, rid()]);
      const revs = await revisions(leg1.id, 1);
      expect(revs.map((r) => [r.revision_no, r.ticket_number.replace(/-/g, ''), r.reason])).toEqual([
        [1, first.ticketNumber.replace(/-/g, ''), null], [2, fixed.replace(/-/g, ''), REASON]]);
      expect(revs[1]!.batch_id).toBe(revs[0]!.batch_id);
      // The branch Manager may correct too.
      await one(MANAGER, SQL.ticketCorrect, [leg1.id, 1, 2, fields({ ticketNumber: fixed, airlinePnr: 'MGR001' }), 'Synthetic: Manager fixed the PNR', rid()]);
      expect((await revisions(leg1.id, 1)).map((r) => r.revision_no)).toEqual([1, 2, 3]);
      // The corrected-away number stays reserved for traveller 1 (never someone else's) ...
      await refused(FLIGHT, SQL.ticketsConfirm, [DEAL, confirmOne(supplierId, [leg1.id], ticketFor(3, { ticketNumber: first.ticketNumber })), rid()],
        'ticket_number_taken', '23505');
      // ... and traveller 1 may take it back.
      await one(FLIGHT, SQL.ticketCorrect, [leg1.id, 1, 3, fields({ airlinePnr: 'MGR001' }), 'Synthetic: the first number was right after all', rid()]);
      // The workspace shows the current ticket and its history; audit has the reason but no number.
      const ws = await one<{ flights: Array<{ sectors: Array<{ sectorId: string; travellers: Array<{ seq: number; ticket: { revisionNo: number;
        history: unknown[]; canCorrect: boolean } | null }> }> }> }>(FLIGHT, SQL.workspace, [DEAL]);
      const t1 = ws.flights[0]!.sectors.find((s) => s.sectorId === leg1.id)!.travellers.find((t) => t.seq === 1)!.ticket!;
      expect(t1.revisionNo).toBe(4);
      expect(t1.history).toHaveLength(4);
      expect(t1.canCorrect).toBe(true);
      const audits = await owner<{ reason: string; details: Record<string, unknown> }>(
        `select reason, details from public.audit_events where action = 'flight.ticket_corrected' order by id`);
      expect(audits).toHaveLength(3); // three corrections: Flight, the Manager, Flight again
      expect(audits[0]!.reason).toBe(REASON);
      expect(audits[0]!.details).toMatchObject({ dealId: DEAL, sectorId: leg1.id, travellerSeq: 1, revisionNo: 2 });
      expect(JSON.stringify(audits)).not.toContain(fixed.replace(/-/g, ''));
      expect(JSON.stringify(audits)).not.toContain('MGR001');
    });
  });
});
