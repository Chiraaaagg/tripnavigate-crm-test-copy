import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ACCOUNTS, ANON, DEAL, HOTEL, MANAGER, OWNER, PURCHASE, SUPER, TRAVELLERS, TRIP } from './b1-support';
import { IDENTITY_SQL, b11Helpers } from './b11-support';
import { PARTY } from './booking-form-support';
import { ACC } from './finance-support';
import { REASON, SQL, rid, vnHelpers } from './vn-support';

/**
 * Voice-note batch, migration 20261128000110: the count rule, travellers by
 * type, Bitrix trip facts as the server's values (behind the new switch), the
 * hotel adults default, special request codes and extra passenger phones.
 * Older versions (no adults recorded) keep today's rules.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = vnHelpers(() => db);
const { one, owner, refused, refusedWithHint } = h;

type RV = { rowVersion: number; contentHash: string; bitrixFields?: string[] };
type TripFacts = { enabled: boolean; factsEnabled: boolean; countsConsistent: boolean | null; issues: string[];
  fields: Record<string, Record<string, unknown>> };
const trip = (versionId: string, rv: number, fields: unknown) => one<RV>(OWNER, SQL.trip, [versionId, rv, JSON.stringify(fields)]);
const version = (id: string) => owner<Record<string, unknown>>(
  `select trip_destination, trip_scope, trip_start::text, trip_end::text, pax_total, adults_count, children_count, infants_count
   from public.booking_versions where id = $1`, [id]).then((r) => r[0]!);
const travellerRows = () => owner<{ seq: number; traveller_type: string; special_requests: string[] }>(
  'select seq, traveller_type, special_requests from public.deal_travellers where deal_id = $1 order by seq', [DEAL]);
const hotelFacts = (versionId: string) => owner<{ facts: Record<string, unknown>; adults_from_booking: boolean }>(
  `select f.facts, f.adults_from_booking from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
   where f.booking_version_id = $1 and i.service_type = 'hotel' order by i.item_no`, [versionId]);
const { adults: _drop, ...HOTEL_NO_ADULTS } = HOTEL;
void _drop;

describe('count rule (adults + children + infants = total)', () => {
  it('refuses an inconsistent party once adults are recorded; consistent counts are stored', async () => {
    await asOwner(db, async () => {
      const d = await h.draft(OWNER);
      await refused(OWNER, SQL.trip, [d.versionId, d.rowVersion, JSON.stringify({ ...TRIP, ...PARTY, adults: 2 })], '22023',
        'party_count_mismatch');
      await refused(OWNER, SQL.trip, [d.versionId, d.rowVersion, JSON.stringify({ ...TRIP, adults: 2 })], '22023',
        'party_count_mismatch');
      const r = await trip(d.versionId, d.rowVersion, { ...TRIP, ...PARTY, adults: 3 });
      expect(r.bitrixFields).toBeUndefined();
      expect(await version(d.versionId)).toMatchObject({ pax_total: 4, adults_count: 3, children_count: 1, infants_count: 0 });
      // An older caller (no adults key) keeps the stored adults, so the rule still applies to this version.
      await refused(OWNER, SQL.trip, [d.versionId, r.rowVersion, JSON.stringify({ ...TRIP, paxTotal: 5, children: 1, infants: 0 })],
        '22023', 'party_count_mismatch');
      const form = (await h.form(OWNER))!;
      expect(form.party).toEqual({ total: 4, adults: 3, children: 1, infants: 0 });
    });
  });

  it('a version without recorded adults keeps the earlier rules (legacy callers unchanged)', async () => {
    await asOwner(db, async () => {
      const d = await h.draft(OWNER);
      const r = await trip(d.versionId, d.rowVersion, { ...TRIP, ...PARTY });
      expect(await version(d.versionId)).toMatchObject({ pax_total: 4, adults_count: null });
      // More named travellers than the declared total: saved as before (readiness reports it).
      const saved = await h.saveTravellers(OWNER, DEAL, r.rowVersion, [...TRAVELLERS,
        { fullName: 'Synthetic Traveller Five', type: 'adult', seq: 5 }]);
      expect(saved.rowVersion).toBeGreaterThan(r.rowVersion);
      expect((await travellerRows()).length).toBe(5);
    });
  });
});

describe('travellers never exceed the declared count of their type', () => {
  it('refuses extra rows on save and refuses lowering a count below the named travellers; nothing is deleted', async () => {
    await asOwner(db, async () => {
      const d = await h.draft(OWNER);
      let rv = (await trip(d.versionId, d.rowVersion, { ...TRIP, ...PARTY, adults: 3 })).rowVersion;
      rv = (await h.saveTravellers(OWNER, DEAL, rv, TRAVELLERS)).rowVersion;
      await refused(OWNER, 'select public.deal_travellers_save($1, $2, $3::jsonb) as r', [DEAL, rv, JSON.stringify([...TRAVELLERS,
        { fullName: 'Synthetic Traveller Five', type: 'adult', seq: 5 }])], '22023', 'traveller_count_exceeded');
      await refused(OWNER, SQL.trip, [d.versionId, rv, JSON.stringify({ ...TRIP, paxTotal: 4, adults: 2, children: 2, infants: 0 })],
        '22023', 'traveller_count_exceeded');
      expect((await travellerRows()).map((t) => t.traveller_type)).toEqual(['adult', 'adult', 'adult', 'child']);
      // Raising a count is fine; the hint names the type that is over.
      rv = (await trip(d.versionId, rv, { ...TRIP, paxTotal: 5, adults: 4, children: 1, infants: 0 })).rowVersion;
      rv = (await h.saveTravellers(OWNER, DEAL, rv, [...TRAVELLERS, { fullName: 'Synthetic Traveller Five', type: 'adult', seq: 5 }]))
        .rowVersion;
      expect((await travellerRows()).length).toBe(5);
      await db.exec('savepoint hint');
      try {
        await one(OWNER, 'select public.deal_travellers_save($1, $2, $3::jsonb) as r', [DEAL, rv, JSON.stringify([...TRAVELLERS,
          { fullName: 'Synthetic Infant', type: 'infant', seq: 6 }])]);
        throw new Error('expected a refusal');
      } catch (e) {
        await db.exec('rollback to savepoint hint');
        expect((e as { message: string; hint?: string }).message).toBe('traveller_count_exceeded');
        expect((e as { hint?: string }).hint).toBe('infant');
      }
    });
  });
});

describe('Bitrix trip facts are the server values (new switch on)', () => {
  it('replaces typed values with the Bitrix ones, reports bitrixFields and the per-field source', async () => {
    await asOwner(db, async () => {
      await h.switches(true, true);
      await h.storeOption('101', 'Synthetic Dubai');
      await h.storeFacts(DEAL, { start: '2026-12-01', end: '2026-12-05', total: 4, adults: 3, children: 1, infants: 0, option: '101' });
      const d = await h.draft(OWNER);
      const r = await trip(d.versionId, d.rowVersion, { destination: 'Typed place', scope: 'international', start: '2026-12-10',
        end: '2026-12-13', paxTotal: 2, children: 0, infants: 0, adults: 2 });
      expect(r.bitrixFields).toEqual(['adults', 'children', 'destination', 'end', 'infants', 'paxTotal', 'start']);
      // Scope stays the staff choice while the option is not classified (never guessed).
      expect(await version(d.versionId)).toEqual({ trip_destination: 'Synthetic Dubai', trip_scope: 'international',
        trip_start: '2026-12-01', trip_end: '2026-12-05', pax_total: 4, adults_count: 3, children_count: 1, infants_count: 0 });
      const facts = await one<TripFacts>(OWNER, SQL.tripFacts, [DEAL]);
      expect(facts).toMatchObject({ enabled: true, factsEnabled: true, countsConsistent: true, issues: [] });
      expect(facts.fields.destination).toEqual({ bitrix: { listId: 'DEAL_DESTINATION', optionId: '101', label: 'Synthetic Dubai' },
        booking: 'Synthetic Dubai', source: 'bitrix', differs: false });
      expect(facts.fields.scope).toEqual({ bitrix: null, booking: 'international', source: 'booking', differs: false, classified: false });
      expect(facts.fields.total).toEqual({ bitrix: 4, booking: 4, source: 'bitrix', differs: false });
      expect((await h.form(OWNER))!.tripFacts).toEqual(facts);

      // Classified once by the Super Admin: the server uses it.
      await one(SUPER, SQL.scopeSet, ['DEAL_DESTINATION', '101', 'domestic', 0, REASON]);
      await trip(d.versionId, r.rowVersion, { destination: null, scope: 'international' });
      expect(await version(d.versionId)).toMatchObject({ trip_destination: 'Synthetic Dubai', trip_scope: 'domestic' });
      const audit = await h.auditRows('booking.trip_saved');
      expect(audit.at(-1)!.details.bitrixFields).toEqual(['adults', 'children', 'destination', 'end', 'infants', 'paxTotal', 'scope', 'start']);
    });
  });

  it('inconsistent Bitrix counts are not used (staff enter the split); unreadable dates are not used', async () => {
    await asOwner(db, async () => {
      await h.switches(true, true);
      await h.storeFacts(DEAL, { start: '2026-12-05', end: '2026-12-01', total: 4, adults: 3, children: 1, infants: 1 });
      const d = await h.draft(OWNER);
      const facts = await one<TripFacts>(OWNER, SQL.tripFacts, [DEAL]);
      expect(facts.countsConsistent).toBe(false);
      expect(facts.fields.adults).toMatchObject({ bitrix: 3, source: 'missing' });
      expect(facts.fields.start).toMatchObject({ bitrix: '2026-12-05', source: 'missing' });
      const r = await trip(d.versionId, d.rowVersion, { ...TRIP, paxTotal: 9, adults: 3, children: 1, infants: 0 });
      expect(r.bitrixFields).toEqual(['paxTotal']);
      expect(await version(d.versionId)).toMatchObject({ trip_start: TRIP.start, pax_total: 4, adults_count: 3 });
    });
  });

  it('with only the older switch on, Bitrix dates stay suggestions (typed values are saved as before)', async () => {
    await asOwner(db, async () => {
      await h.switches(true, false);
      await h.storeFacts(DEAL, { start: '2026-12-01', end: '2026-12-05', total: 4 });
      const d = await h.draft(OWNER);
      const r = await trip(d.versionId, d.rowVersion, TRIP);
      expect(r.bitrixFields).toBeUndefined();
      expect(await version(d.versionId)).toMatchObject({ trip_start: TRIP.start, trip_end: TRIP.end });
      expect(await one<TripFacts>(OWNER, SQL.tripFacts, [DEAL])).toMatchObject({ enabled: false, factsEnabled: true });
    });
  });

  it('reads: booking editors and acceptors only; Purchase and Accounts get null; anonymous is refused', async () => {
    await asOwner(db, async () => {
      await h.draft(OWNER);
      expect(await one(MANAGER, SQL.tripFacts, [DEAL])).not.toBeNull();
      expect(await one(PURCHASE, SQL.tripFacts, [DEAL])).toBeNull();
      expect(await one(ACCOUNTS, SQL.tripFacts, [DEAL])).toBeNull();
      await refused(ANON, SQL.tripFacts, [DEAL], '42501');
    });
  });
});

describe('hotel adults default', () => {
  it('fills absent hotel adults from the booking and keeps them in step; explicit adults stay', async () => {
    await asOwner(db, async () => {
      const d = await h.draft(OWNER);
      let rv = (await trip(d.versionId, d.rowVersion, { ...TRIP, ...PARTY, adults: 3 })).rowVersion;
      const a = await h.saveService(OWNER, d.versionId, rv, { type: 'hotel', facts: HOTEL_NO_ADULTS });
      const b = await h.saveService(OWNER, d.versionId, a.rowVersion, { type: 'hotel', facts: { ...HOTEL, adults: 5 } });
      rv = b.rowVersion;
      expect((await hotelFacts(d.versionId)).map((f) => [f.facts.adults, f.adults_from_booking])).toEqual([[3, true], [5, false]]);
      rv = (await trip(d.versionId, rv, { ...TRIP, paxTotal: 4, adults: 2, children: 2, infants: 0 })).rowVersion;
      expect((await hotelFacts(d.versionId)).map((f) => f.facts.adults)).toEqual([2, 5]);
      // Saving the hotel with explicit adults stops following the booking.
      await h.saveService(OWNER, d.versionId, rv, { itemId: a.itemId, facts: { ...HOTEL, adults: 1 } });
      expect((await hotelFacts(d.versionId))[0]).toMatchObject({ facts: { adults: 1 }, adults_from_booking: false });
    });
  });

  it('a hotel without adults is valid; with no party yet the adults come from the adult travellers', async () => {
    await asOwner(db, async () => {
      const d = await h.draft(OWNER);
      const rv = (await h.saveTravellers(OWNER, DEAL, d.rowVersion, TRAVELLERS)).rowVersion;
      await h.saveService(OWNER, d.versionId, rv, { type: 'hotel', facts: HOTEL_NO_ADULTS });
      expect((await hotelFacts(d.versionId))[0]!.facts.adults).toBe(3);
      expect(await owner<{ v: string[] }>(`select authz.validate_service_facts('hotel', $1::jsonb) as v`,
        [JSON.stringify(HOTEL_NO_ADULTS)])).toEqual([{ v: [] }]);
      expect(await owner<{ v: string[] }>(`select authz.validate_service_facts('hotel', $1::jsonb) as v`,
        [JSON.stringify({ ...HOTEL, adults: 0, catalogueHotelId: 'not-a-uuid' })])).toEqual([{ v: ['adults', 'catalogueHotelId'] }]);
    });
  });
});

describe('passengers: special request codes and extra phones', () => {
  it('stores fixed codes next to the free text; absent keeps; unknown codes are refused', async () => {
    await asOwner(db, async () => {
      const d = await h.draft(OWNER);
      let rv = (await h.saveTravellers(OWNER, DEAL, d.rowVersion, [
        { ...TRAVELLERS[0], specialRequests: ['jain_meals', 'baby_cot'], specialNeeds: 'Synthetic free text' },
        ...TRAVELLERS.slice(1)])).rowVersion;
      expect((await travellerRows())[0]!.special_requests).toEqual(['baby_cot', 'jain_meals']);
      rv = (await h.saveTravellers(OWNER, DEAL, rv, TRAVELLERS)).rowVersion;
      expect((await travellerRows())[0]!.special_requests).toEqual(['baby_cot', 'jain_meals']);
      await refusedWithHint(OWNER, 'select public.deal_travellers_save($1, $2, $3::jsonb) as r',
        [DEAL, rv, JSON.stringify([{ ...TRAVELLERS[0], specialRequests: ['free_upgrade'] }])], /^travellers\[1\]$/);
      const form = (await h.form(OWNER))!;
      expect((form.travellers as Array<Record<string, unknown>>)[0]!.specialRequests).toEqual(['baby_cot', 'jain_meals']);
      rv = (await h.saveTravellers(OWNER, DEAL, rv, [{ ...TRAVELLERS[0], specialRequests: [] }, ...TRAVELLERS.slice(1)])).rowVersion;
      expect((await travellerRows())[0]!.special_requests).toEqual([]);
    });
  });

  it('keeps up to three extra phones (identity phone rule); private with the identity', async () => {
    await asOwner(db, async () => {
      const d = await h.draft(OWNER);
      await h.saveTravellers(OWNER, DEAL, d.rowVersion, TRAVELLERS);
      const r = await one<{ rowVersion: number }>(OWNER, IDENTITY_SQL, [DEAL, 1, 0, JSON.stringify({ extraPhones: ['98765 00031', '+971501234567'] })]);
      expect(await owner('select extra_phones from public.traveller_identities')).toEqual([{ extra_phones: ['9876500031', '+971501234567'] }]);
      await refusedWithHint(OWNER, IDENTITY_SQL, [DEAL, 1, r.rowVersion, JSON.stringify({ extraPhones: ['9876500031', '9876500032', '9876500033', '9876500034'] })], /^extraPhones$/);
      await refusedWithHint(OWNER, IDENTITY_SQL, [DEAL, 1, r.rowVersion, JSON.stringify({ extraPhones: ['12345'] })], /^extraPhones$/);
      const r2 = await one<{ rowVersion: number }>(OWNER, IDENTITY_SQL, [DEAL, 1, r.rowVersion, JSON.stringify({ phone: '9876500041' })]);
      expect(await owner('select phone, extra_phones from public.traveller_identities')).toEqual([{ phone: '9876500041', extra_phones: ['9876500031', '+971501234567'] }]);
      const form = (await h.form(OWNER))!;
      const identity = (form.travellers as Array<{ identity: { extraPhones: string[] } }>)[0]!.identity;
      expect(identity.extraPhones).toEqual(['9876500031', '+971501234567']);
      const audit = await h.auditRows('booking.traveller_identity_saved');
      expect(audit[0]!.details.changedFields).toEqual(['extraPhones']);
      expect(JSON.stringify(audit)).not.toContain('9876500031');
      // Clearing every value removes the identity row as before.
      await one(OWNER, IDENTITY_SQL, [DEAL, 1, r2.rowVersion, JSON.stringify({ phone: null, extraPhones: null })]);
      expect(await owner('select * from public.traveller_identities')).toEqual([]);
    });
  });
});

describe('legacy and new drafts stay ready as before', () => {
  it('a complete new-form draft without recorded adults has no new readiness codes', async () => {
    await asOwner(db, async () => {
      const ready = await h.readyForm();
      expect(ready.issues).toEqual([]);
      expect(await version(ready.versionId)).toMatchObject({ adults_count: null });
    });
  });
});

describe('lead rulings of 24 October', () => {
  it('Q1: new versions hash and freeze the special request codes; a schema-3 hash ignores them', async () => {
    await asOwner(db, async () => {
      const ready = await h.readyForm();
      expect(await owner('select hash_schema from public.booking_versions where id = $1', [ready.versionId])).toEqual([{ hash_schema: 4 }]);
      const schema3 = () => owner<{ h: string }>(
        `select authz.booking_package_hash_row(jsonb_populate_record(v, '{"hash_schema": 3}')) as h
         from public.booking_versions v where v.id = $1`, [ready.versionId]).then((r) => r[0]!.h);
      const before3 = await schema3();
      const saved = await h.saveTravellers(OWNER, DEAL, ready.rowVersion,
        [{ ...TRAVELLERS[0], specialRequests: ['wheelchair_help'] }, ...TRAVELLERS.slice(1)]);
      expect(saved.contentHash).not.toBe(ready.hash);
      expect(await schema3()).toBe(before3);
      const r = await h.readiness(OWNER, ready.versionId);
      expect(r.issues).toEqual([]);
      await h.confirm(OWNER, ready.versionId, r.contentHash);
      expect(await owner('select seq, special_requests from public.booking_version_travellers where booking_version_id = $1 order by seq',
        [ready.versionId])).toEqual([
        { seq: 1, special_requests: ['wheelchair_help'] }, { seq: 2, special_requests: [] }, { seq: 3, special_requests: [] },
        { seq: 4, special_requests: [] }]);
      // The confirmed hash reads the snapshot, so it equals the hash that was accepted.
      expect(await owner<{ same: boolean }>('select content_hash = authz.booking_content_hash(id) as same from public.booking_versions where id = $1',
        [ready.versionId])).toEqual([{ same: true }]);
    });
  });

  it('Q5: any save path fills missing hotel adults; traveller saves keep following hotels in step; a hand edit stops it', async () => {
    await asOwner(db, async () => {
      const d = await h.draft(OWNER);
      // Legacy add command, no party and no travellers yet: no adults known, so it is refused
      // (amended 25 October: a hotel is never stored without adults; every reader requires them).
      await refusedWithHint(OWNER, 'select public.service_item_add($1, $2, $3, $4::jsonb, 0, $5) as r',
        [d.versionId, d.rowVersion, 'hotel', JSON.stringify(HOTEL_NO_ADULTS), rid()], /^adults$/);
      expect(await hotelFacts(d.versionId)).toEqual([]);
      // One adult passenger: the legacy add takes the adults from the booking and follows it.
      const one1 = await h.saveTravellers(OWNER, DEAL, d.rowVersion, TRAVELLERS.slice(0, 1));
      const added = await h.addItem(OWNER, d.versionId, one1.rowVersion, 'hotel', HOTEL_NO_ADULTS);
      expect((await hotelFacts(d.versionId))[0]).toMatchObject({ facts: { adults: 1 }, adults_from_booking: true });
      const t = await h.saveTravellers(OWNER, DEAL, added.rowVersion, TRAVELLERS);
      expect((await hotelFacts(d.versionId))[0]!.facts.adults).toBe(3);
      // Legacy save with adults typed by hand: no longer follows the booking.
      await one(OWNER, 'select public.service_item_save($1, $2, $3, $4::jsonb, $5::bigint) as r',
        [added.itemId, d.versionId, t.rowVersion, JSON.stringify({ ...HOTEL, adults: 2 }), '4500000']);
      expect((await hotelFacts(d.versionId))[0]).toMatchObject({ facts: { adults: 2 }, adults_from_booking: false });
    });
  });
});

describe('revisions (lead ruling)', () => {
  it('special request codes join the change list as a choice field; a revision copy keeps following the booking adults', async () => {
    await asOwner(db, async () => {
      const b11 = b11Helpers(() => db);
      const base = await b11.readyDraft(OWNER, DEAL, [['hotel', HOTEL_NO_ADULTS]]);
      expect(base.issues).toEqual([]);
      expect((await hotelFacts(base.versionId))[0]).toMatchObject({ facts: { adults: 3 }, adults_from_booking: true });
      await h.confirm(OWNER, base.versionId, base.hash);
      await one(ACC, 'select public.accounts_review_return($1, $2, $3) as r', [base.versionId, 'Synthetic return: please recheck', rid()]);
      const opened = await one<{ versionId: string; rowVersion: number }>(OWNER, 'select public.booking_open_revision($1) as r', [base.versionId]);
      expect((await hotelFacts(opened.versionId))[0]).toMatchObject({ facts: { adults: 3 }, adults_from_booking: true });
      // The copy follows the revision's party; the confirmed base never changes.
      const rv = (await trip(opened.versionId, opened.rowVersion, { ...TRIP, paxTotal: 5, adults: 4, children: 1, infants: 0 })).rowVersion;
      expect((await hotelFacts(opened.versionId))[0]!.facts.adults).toBe(4);
      expect((await hotelFacts(base.versionId))[0]!.facts.adults).toBe(3);
      // Only the special request codes change: listed and classified like special needs.
      await h.saveTravellers(OWNER, DEAL, rv, [{ ...TRAVELLERS[0], specialRequests: ['baby_cot'] }, ...TRAVELLERS.slice(1)]);
      expect(await owner<{ f: string[] }>('select authz.revision_changed_fields($1) as f', [opened.versionId]))
        .toEqual([{ f: expect.arrayContaining(['travellers.specialRequests']) }]);
      expect(await owner<{ c: string }>(`select authz.revision_field_class('travellers.specialRequests') as c`)).toEqual([{ c: 'choice' }]);
      expect(await owner<{ c: string }>(`select authz.revision_field_class('travellers.specialNeeds') as c`)).toEqual([{ c: 'choice' }]);
    });
  });
});
