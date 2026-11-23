import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ACTIVITY, ADD_SQL, FLIGHT_FACTS, HOTEL, OWNER, PURCHASE, TRANSFER } from './b1-support';
import { PARTICIPATION_SQL, PASSPORT, VISA, b11Helpers, rid } from './b11-support';

/**
 * B1.1a facts and participation (migration 20261119000100): additive fact
 * keys per type (B1 facts stay valid), visa and passport items, relaxed
 * transfer and flight rules, participation per item and version.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b11Helpers(() => db);
const { one, refused, refusedWithHint, owner, addItem, draftWithTravellers, saveParticipation } = h;

describe('facts keys (B1.1)', () => {
  it('accepts the new keys and every B1 fact shape; names invalid new keys', async () => {
    await asOwner(db, async () => {
      const d = await draftWithTravellers();
      let rv = d.rowVersion;
      const valid: Array<[string, unknown]> = [
        ['hotel', HOTEL],
        ['hotel', { ...HOTEL, mode: 'preferences', hotelName: null, preferences: 'Any 4-star near the old city', area: 'Old city', childAges: [7], exclusions: 'No lunch' }],
        ['transfer', TRANSFER],
        ['transfer', { pickup: 'Synthetic airport', drop: 'Synthetic hotel', date: '2026-12-10' }],
        ['activity', { ...ACTIVITY, inclusions: 'Dinner' }],
        ['flight', FLIGHT_FACTS],
        ['flight', { ...FLIGHT_FACTS, tripType: 'return', preferences: 'Aisle', assistance: 'Wheelchair',
          segments: [{ from: 'Jodhpur', to: 'DXB', date: '2026-12-10', flex: '+/- 1 day' }] }],
        ['visa', VISA],
        ['passport', PASSPORT],
      ];
      for (const [type, facts] of valid) rv = (await addItem(OWNER, d.versionId, rv, type, facts)).rowVersion;
      const items = await owner<{ service_type: string; department: string; title: string | null }>(
        `select i.service_type, i.department, authz.service_item_title(i.service_type, f.facts) as title
         from public.service_items i join public.service_item_facts f on f.service_item_id = i.id
         where f.booking_version_id = $1 order by i.item_no`, [d.versionId]);
      expect(items.map((i) => [i.service_type, i.department])).toEqual([
        ['hotel', 'purchase'], ['hotel', 'purchase'], ['transfer', 'purchase'], ['transfer', 'purchase'], ['activity', 'purchase'],
        ['flight', 'flight'], ['flight', 'flight'], ['visa', 'visa'], ['passport', 'visa'],
      ]);
      expect(items[3]!.title).toBe('Synthetic airport to Synthetic hotel');
      expect(items[7]!.title).toBe('United Arab Emirates · Tourism');
      expect(items[8]!.title).toBe('Renewal · Jodhpur');

      const bad: Array<[string, unknown, RegExp]> = [
        ['hotel', { ...HOTEL, mode: 'cheap' }, /^mode$/],
        ['hotel', { ...HOTEL, mode: 'preferences', hotelName: null }, /^preferences$/],
        ['hotel', { ...HOTEL, childAges: [7, 8] }, /^childAges$/],
        ['hotel', { ...HOTEL, childAges: [18] }, /^childAges$/],
        ['transfer', { date: '2026-12-10', pickup: 'Only pickup' }, /^route$/],
        ['flight', { ...FLIGHT_FACTS, tripType: 'circle' }, /^tripType$/],
        ['flight', { ...FLIGHT_FACTS, segments: [{ from: 'DEL', to: 'JDH', date: '2026-12-10', flex: 'f'.repeat(61) }] }, /^segments$/],
        ['visa', { ...VISA, country: null, feePaidBy: 'someone' }, /^country,feePaidBy$/],
        ['visa', { ...VISA, applyBy: '2026-12-11' }, /^applyBy$/],
        ['visa', { ...VISA, fee: 100 }, /^fee$/],
        ['passport', { ...PASSPORT, applicationType: 'express', officeCity: null }, /^applicationType,officeCity$/],
      ];
      for (const [type, facts, hint] of bad) {
        await refusedWithHint(OWNER, ADD_SQL, [d.versionId, rv, type, JSON.stringify(facts), '0', rid()], hint);
      }
      await refused(OWNER, ADD_SQL, [d.versionId, rv, 'train', '{}', '0', rid()], '22023', 'service_on_hold');
    });
  });
});

describe('service_item_travellers_save', () => {
  it('defaults to every traveller, replaces the set, refuses unknown or repeated seqs and a passport for two', async () => {
    await asOwner(db, async () => {
      const d = await draftWithTravellers();
      const hotel = await addItem(OWNER, d.versionId, d.rowVersion, 'hotel', HOTEL);
      const passport = await addItem(OWNER, d.versionId, hotel.rowVersion, 'passport', PASSPORT);
      expect(await owner('select service_item_id, traveller_seq from public.service_item_travellers where booking_version_id = $1 order by service_item_id = $2 desc, traveller_seq',
        [d.versionId, hotel.itemId])).toEqual([
        ...[1, 2, 3, 4].map((s) => ({ service_item_id: hotel.itemId, traveller_seq: s })),
        { service_item_id: passport.itemId, traveller_seq: 1 },
      ]);
      const saved = await saveParticipation(OWNER, hotel.itemId, d.versionId, passport.rowVersion, [2, 3]);
      expect(saved.contentHash).not.toBe(passport.contentHash);
      expect(saved.rowVersion).toBe(passport.rowVersion + 1);
      for (const seqs of [[9], [2, 2], [null as unknown as number]]) {
        await refusedWithHint(OWNER, PARTICIPATION_SQL, [hotel.itemId, d.versionId, saved.rowVersion, seqs], /^travellers$/);
      }
      await refusedWithHint(OWNER, PARTICIPATION_SQL, [passport.itemId, d.versionId, saved.rowVersion, [1, 2]], /^travellers$/);
      await refused(OWNER, PARTICIPATION_SQL, [hotel.itemId, d.versionId, saved.rowVersion - 1, [1]], '40001', 'version_changed');
      await refused(PURCHASE, PARTICIPATION_SQL, [hotel.itemId, d.versionId, saved.rowVersion, [1]], '42501', 'not_authorized');
      await refused(OWNER, PARTICIPATION_SQL, [rid(), d.versionId, saved.rowVersion, [1]], 'P0002', 'not_found');
      // Empty is allowed here (readiness blocks it).
      const empty = await saveParticipation(OWNER, hotel.itemId, d.versionId, saved.rowVersion, []);
      expect((await h.readiness(OWNER, d.versionId)).issues).toContain('participation_missing');
      // Removing the item removes its participation.
      await one(OWNER, 'select public.service_item_remove($1, $2, $3) as r', [passport.itemId, d.versionId, empty.rowVersion]);
      expect(await owner('select count(*)::int as n from public.service_item_travellers where service_item_id = $1', [passport.itemId])).toEqual([{ n: 0 }]);
    });
  });
});
