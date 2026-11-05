import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { DEAL, FLIGHT_FACTS, HOTEL, OWNER, TRANSFER, rid } from './b1-support';
import { PASSPORT, VISA } from './b11-support';
import { SERVICE_SQL, formHelpers } from './booking-form-support';

/**
 * Book now v2, migration 20261129000110 (booking_service_save and the facts
 * rule): screenshot-only flights, requests "for whom", car type, hotel
 * adults from the chosen people (D4) and keys the v2 drawers no longer post.
 * Synthetic data only; every scenario runs in a rolled-back owner transaction.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = formHelpers(() => db);
const { owner, refusedWithHint } = h;

const factsOf = async (itemId: string, versionId: string) =>
  (await owner<{ facts: Record<string, unknown> }>(
    'select facts from public.service_item_facts where service_item_id = $1 and booking_version_id = $2', [itemId, versionId]))[0]!.facts;
const title = async (itemId: string, versionId: string) =>
  (await owner<{ t: string }>(`select authz.service_item_title(i.service_type, f.facts) as t from public.service_item_facts f
     join public.service_items i on i.id = f.service_item_id where f.service_item_id = $1 and f.booking_version_id = $2`,
  [itemId, versionId]))[0]!.t;
const SCREENSHOT = { segments: [], passengers: 1, entryMode: 'screenshot', screenshotNote: 'Book the 08:00 option' };

describe('flights added from a screenshot', () => {
  it('save without legs; passengers follow the participants; title "From screenshot"; typed flights still need a leg', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      const saved = await h.saveService(OWNER, r.versionId, r.rowVersion, { type: 'flight', facts: SCREENSHOT, participants: [1, 2] });
      expect(await factsOf(saved.itemId, r.versionId)).toEqual({ segments: [], passengers: 2, entryMode: 'screenshot',
        screenshotNote: 'Book the 08:00 option' });
      expect(await title(saved.itemId, r.versionId)).toBe('From screenshot');
      // Absent segments read as none in screenshot mode.
      const noSegs = await h.saveService(OWNER, r.versionId, saved.rowVersion, { type: 'flight',
        facts: { passengers: 1, entryMode: 'screenshot' }, participants: [3] });
      expect(await factsOf(noSegs.itemId, r.versionId)).toEqual({ segments: [], passengers: 1, entryMode: 'screenshot' });
      // Typed details: at least one leg; a note is for screenshot flights only; unknown modes are refused.
      await refusedWithHint(OWNER, SERVICE_SQL, [r.versionId, noSegs.rowVersion, null, 'flight',
        JSON.stringify({ ...FLIGHT_FACTS, segments: [] }), null, null, null, rid()], /segments/);
      await refusedWithHint(OWNER, SERVICE_SQL, [r.versionId, noSegs.rowVersion, null, 'flight',
        JSON.stringify({ ...FLIGHT_FACTS, screenshotNote: 'Synthetic note' }), null, null, null, rid()], /screenshotNote/);
      await refusedWithHint(OWNER, SERVICE_SQL, [r.versionId, noSegs.rowVersion, null, 'flight',
        JSON.stringify({ ...SCREENSHOT, entryMode: 'photo' }), null, null, null, rid()], /entryMode/);
      // A typed flight saved over a screenshot one drops the note.
      const typed = await h.saveService(OWNER, r.versionId, noSegs.rowVersion, { itemId: saved.itemId,
        facts: { ...FLIGHT_FACTS, entryMode: 'typed' } });
      expect(await factsOf(saved.itemId, r.versionId)).not.toHaveProperty('screenshotNote');
      expect(typed.rowVersion).toBeGreaterThan(noSegs.rowVersion);
    });
  });
});

describe('requests "for whom"', () => {
  it('render the readable text; forSeq must be a participant; shape and length are checked', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      const hotelId = r.itemIds[0]!;
      const items = [{ text: 'Baby cot', forSeq: 4 }, { text: 'Early check-in', forSeq: null }];
      const saved = await h.saveService(OWNER, r.versionId, r.rowVersion, { itemId: hotelId,
        facts: { ...HOTEL, requestItems: items }, participants: [1, 2, 3, 4] });
      const facts = await factsOf(hotelId, r.versionId);
      expect(facts.specialRequests).toBe('Baby cot (Synthetic Traveller Four), Early check-in');
      expect(facts.requestItems).toEqual(items);
      // Flight preferences use the same rule.
      const flight = await h.saveService(OWNER, r.versionId, saved.rowVersion, { type: 'flight',
        facts: { ...FLIGHT_FACTS, requestItems: [{ text: 'Wheelchair help', forSeq: 2 }, { text: 'Vegetarian meal', forSeq: null }] },
        participants: [1, 2] });
      expect((await factsOf(flight.itemId, r.versionId)).preferences).toBe('Wheelchair help (Synthetic Traveller Two), Vegetarian meal');
      // Not a participant of this flight.
      await refusedWithHint(OWNER, SERVICE_SQL, [r.versionId, flight.rowVersion, flight.itemId, null,
        JSON.stringify({ ...FLIGHT_FACTS, requestItems: [{ text: 'Aisle seat', forSeq: 3 }] }), null, null, null, rid()], /^requestItems$/);
      // Duplicates (ignoring case), untrimmed text, too long, more than 20, unknown keys.
      for (const bad of [
        [{ text: 'Window seat', forSeq: null }, { text: 'window seat', forSeq: null }],
        [{ text: ' Window seat', forSeq: null }],
        [{ text: 'x'.repeat(81), forSeq: null }],
        Array.from({ length: 21 }, (_, i) => ({ text: `Request ${i}`, forSeq: null })),
        [{ text: 'Window seat', forSeq: null, note: 'x' }],
      ]) {
        await refusedWithHint(OWNER, SERVICE_SQL, [r.versionId, flight.rowVersion, flight.itemId, null,
          JSON.stringify({ ...FLIGHT_FACTS, requestItems: bad }), null, null, null, rid()], /requestItems/);
      }
      // An empty list clears both the items and the text.
      await h.saveService(OWNER, r.versionId, flight.rowVersion, { itemId: hotelId, facts: { ...HOTEL, requestItems: [] } });
      const cleared = await factsOf(hotelId, r.versionId);
      expect(cleared).not.toHaveProperty('requestItems');
      expect(cleared).not.toHaveProperty('specialRequests');
    });
  });
});

describe('keys the v2 drawers no longer show', () => {
  it('stay as stored when the post leaves them out; a key posted as null clears it', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      const hotelId = r.itemIds[0]!;
      const OLD = { ...HOTEL, area: 'Synthetic old town', exclusions: 'Synthetic exclusions', bedRemarks: 'Synthetic remark',
        specialRequests: 'Synthetic free-text request' };
      let rv = (await h.saveService(OWNER, r.versionId, r.rowVersion, { itemId: hotelId, facts: OLD })).rowVersion;
      // A v2 post: none of those keys, no requests at all.
      const { specialRequests: _s, ...v2 } = HOTEL;
      void _s;
      rv = (await h.saveService(OWNER, r.versionId, rv, { itemId: hotelId, facts: { ...v2, mealPlan: 'Half board' } })).rowVersion;
      expect(await factsOf(hotelId, r.versionId)).toMatchObject({ area: 'Synthetic old town', exclusions: 'Synthetic exclusions',
        bedRemarks: 'Synthetic remark', specialRequests: 'Synthetic free-text request', mealPlan: 'Half board' });
      rv = (await h.saveService(OWNER, r.versionId, rv, { itemId: hotelId, facts: { ...v2, area: null } })).rowVersion;
      expect(await factsOf(hotelId, r.versionId)).not.toHaveProperty('area');

      // Car: included kilometres and vendor stay; car type and the flight it meets are stored.
      const car = await h.saveService(OWNER, r.versionId, rv, { type: 'transfer',
        facts: { ...TRANSFER, includedKms: 300, vendor: 'Synthetic Cabs' } });
      const flightId = (await h.saveService(OWNER, r.versionId, car.rowVersion, { type: 'flight', facts: FLIGHT_FACTS })).itemId;
      const rv2 = (await owner<{ row_version: number }>('select row_version from public.booking_versions where id = $1', [r.versionId]))[0]!.row_version;
      const carSaved = await h.saveService(OWNER, r.versionId, rv2, { itemId: car.itemId,
        facts: { ...TRANSFER, carKind: 'airport_pickup', flightItemId: flightId } });
      expect(await factsOf(car.itemId, r.versionId)).toMatchObject({ includedKms: 300, vendor: 'Synthetic Cabs', carKind: 'airport_pickup',
        flightItemId: flightId });
      await refusedWithHint(OWNER, SERVICE_SQL, [r.versionId, carSaved.rowVersion, car.itemId, null,
        JSON.stringify({ ...TRANSFER, carKind: 'helicopter' }), null, null, null, rid()], /^carKind$/);
      await refusedWithHint(OWNER, SERVICE_SQL, [r.versionId, carSaved.rowVersion, car.itemId, null,
        JSON.stringify({ ...TRANSFER, flightItemId: 'not-a-uuid' }), null, null, null, rid()], /^flightItemId$/);

      // Flight (D7): a typed post with one leg keeps the stored later legs; assistance and trip type stay.
      let rv3 = (await h.saveService(OWNER, r.versionId, carSaved.rowVersion, { itemId: flightId,
        facts: { ...FLIGHT_FACTS, assistance: 'Synthetic assistance', tripType: 'return' } })).rowVersion;
      rv3 = (await h.saveService(OWNER, r.versionId, rv3, { itemId: flightId,
        facts: { ...FLIGHT_FACTS, segments: [{ from: 'DEL', to: 'JDH', date: '2026-12-11', flightNo: '6E 123' }] } })).rowVersion;
      expect(await factsOf(flightId, r.versionId)).toMatchObject({
        segments: [{ from: 'DEL', to: 'JDH', date: '2026-12-11', flightNo: '6E 123' }, { from: 'JDH', to: 'DEL', date: '2026-12-13' }],
        assistance: 'Synthetic assistance', tripType: 'return' });

      // Visa "apply by" and passport "required date".
      const visa = await h.saveService(OWNER, r.versionId, rv3, { type: 'visa', facts: { ...VISA, applyBy: '2026-11-20' } });
      const { applyBy: _a, ...visaV2 } = VISA;
      void _a;
      const visaSaved = await h.saveService(OWNER, r.versionId, visa.rowVersion, { itemId: visa.itemId, facts: { ...visaV2, notes: 'Synthetic' } });
      expect((await factsOf(visa.itemId, r.versionId)).applyBy).toBe('2026-11-20');
      const passport = await h.saveService(OWNER, r.versionId, visaSaved.rowVersion, { type: 'passport', facts: PASSPORT, participants: [1] });
      const { neededBy: _n, ...passportV2 } = PASSPORT;
      void _n;
      await h.saveService(OWNER, r.versionId, passport.rowVersion, { itemId: passport.itemId, facts: passportV2 });
      expect((await factsOf(passport.itemId, r.versionId)).neededBy).toBe(PASSPORT.neededBy);
    });
  });
});

describe('hotel adults and children follow the chosen people (D4)', () => {
  it('a hotel posted without adults takes the chosen adults and children; no adult chosen = the booking adults', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      const { adults: _a, children: _c, ...noCounts } = HOTEL;
      void [_a, _c];
      const saved = await h.saveService(OWNER, r.versionId, r.rowVersion, { itemId: r.itemIds[0]!, facts: noCounts, participants: [1, 4] });
      expect(await factsOf(r.itemIds[0]!, r.versionId)).toMatchObject({ adults: 1, children: 1 });
      expect((await owner<{ a: boolean }>('select adults_from_booking as a from public.service_item_facts where service_item_id = $1',
        [r.itemIds[0]]))[0]!.a).toBe(false);
      await h.saveService(OWNER, r.versionId, saved.rowVersion, { itemId: r.itemIds[0]!, facts: noCounts, participants: [4] });
      // Only a child chosen: the booking adults (3), as before; no children key from the participants.
      expect((await factsOf(r.itemIds[0]!, r.versionId)).adults).toBe(3);
    });
  });
});

describe('the same request twice', () => {
  it('gives one item (change 4 guard on the server)', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      const req = rid();
      const first = await h.saveService(OWNER, r.versionId, r.rowVersion, { type: 'flight', facts: SCREENSHOT, participants: [1], requestId: req });
      const again = await h.saveService(OWNER, r.versionId, r.rowVersion, { type: 'flight', facts: SCREENSHOT, participants: [1], requestId: req });
      expect(again).toEqual({ ...first, outcome: 'existing' });
      expect(await owner('select count(*)::int as n from public.service_items where deal_id = $1 and service_type = $2', [DEAL, 'flight']))
        .toEqual([{ n: 1 }]);
    });
  });
});
