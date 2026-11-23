import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { HOTEL, OWNER, TRANSFER, rid } from './b1-support';
import { SERVICE_SQL, formHelpers } from './booking-form-support';
import { ACC } from './finance-support';

/**
 * Book now v2, extra checks (Agent D) on booking_service_save: requests "for
 * whom" against the item's participants, keys the v2 drawers no longer post,
 * and the automatic Purchase budget (owner decision D2) in a revision and
 * after a typed budget. Synthetic data only.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = formHelpers(() => db);
const { one, owner, refusedWithHint } = h;

const factsOf = async (itemId: string, versionId: string) =>
  (await owner<{ facts: Record<string, unknown> }>(
    'select facts from public.service_item_facts where service_item_id = $1 and booking_version_id = $2', [itemId, versionId]))[0]!.facts;
const budgetOf = async (itemId: string, versionId: string) =>
  (await owner<{ b: string; auto: boolean }>(
    'select purchase_budget_paise::text as b, purchase_budget_auto as auto from public.service_item_facts where service_item_id = $1 and booking_version_id = $2',
    [itemId, versionId]))[0]!;
const save = (versionId: string, rowVersion: number, itemId: string | null, type: string | null, facts: unknown, participants: number[] | null) =>
  [versionId, rowVersion, itemId, type, JSON.stringify(facts), null, null, participants, rid()];
const { specialRequests: _sr, ...HOTEL_V2 } = HOTEL;
void _sr;

describe('requests "for whom" must name a participant of the item', () => {
  it('on an add, on an edit that narrows the people in the same post, and for a seq not on the Deal', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      // Add: only travellers 1 and 2 stay here.
      await refusedWithHint(OWNER, SERVICE_SQL, save(r.versionId, r.rowVersion, null, 'hotel',
        { ...HOTEL_V2, requestItems: [{ text: 'Baby cot', forSeq: 4 }] }, [1, 2]), /^requestItems$/);
      // Not a traveller of this Deal at all.
      await refusedWithHint(OWNER, SERVICE_SQL, save(r.versionId, r.rowVersion, r.itemIds[0]!, null,
        { ...HOTEL_V2, requestItems: [{ text: 'Baby cot', forSeq: 9 }] }, null), /^requestItems$/);
      // Edit: the stored people (all four) count when no people are posted.
      const ok = await h.saveService(OWNER, r.versionId, r.rowVersion, { itemId: r.itemIds[0]!,
        facts: { ...HOTEL_V2, requestItems: [{ text: 'Baby cot', forSeq: 4 }] } });
      expect((await factsOf(r.itemIds[0]!, r.versionId)).specialRequests).toBe('Baby cot (Synthetic Traveller Four)');
      // Edit that leaves traveller 4 out in the same post while still naming them.
      await refusedWithHint(OWNER, SERVICE_SQL, save(r.versionId, ok.rowVersion, r.itemIds[0]!, null,
        { ...HOTEL_V2, requestItems: [{ text: 'Baby cot', forSeq: 4 }] }, [1, 2]), /^requestItems$/);
      // Cars have no requests "for whom".
      await refusedWithHint(OWNER, SERVICE_SQL, save(r.versionId, ok.rowVersion, null, 'transfer',
        { ...TRANSFER, requestItems: [{ text: 'Baby seat', forSeq: null }] }, null), /requestItems/);
    });
  });
});

describe('keys the v2 drawers no longer post (more cases)', () => {
  it('a preference-mode hotel stays one until a hotel name is posted; its preferences text stays after that', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      const { hotelName: _n, ...noName } = HOTEL_V2;
      void _n;
      const pref = await h.saveService(OWNER, r.versionId, r.rowVersion, { type: 'hotel', participants: [1, 2],
        facts: { ...noName, mode: 'preferences', preferences: 'Synthetic: any 4-star near the lake' } });
      // v2 post without mode, hotel name or preferences: still a preference hotel.
      const kept = await h.saveService(OWNER, r.versionId, pref.rowVersion, { itemId: pref.itemId, facts: { ...noName, mealPlan: 'Half board' } });
      expect(await factsOf(pref.itemId, r.versionId)).toMatchObject({ mode: 'preferences', preferences: 'Synthetic: any 4-star near the lake',
        mealPlan: 'Half board' });
      // A hotel name is posted: a specific hotel from now on; the stored preferences text stays.
      await h.saveService(OWNER, r.versionId, kept.rowVersion, { itemId: pref.itemId, facts: { ...noName, hotelName: 'Synthetic Lake Hotel' } });
      const named = await factsOf(pref.itemId, r.versionId);
      expect(named).not.toHaveProperty('mode');
      expect(named).toMatchObject({ hotelName: 'Synthetic Lake Hotel', preferences: 'Synthetic: any 4-star near the lake' });
    });
  });

  it('child ages stay while the children count matches and are dropped when it changes; a car key posted as null is cleared', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      const hotelId = r.itemIds[0]!;
      const a = await h.saveService(OWNER, r.versionId, r.rowVersion, { itemId: hotelId, facts: { ...HOTEL_V2, childAges: [9] } });
      const b = await h.saveService(OWNER, r.versionId, a.rowVersion, { itemId: hotelId, facts: { ...HOTEL_V2, roomType: 'Synthetic Suite' } });
      expect(await factsOf(hotelId, r.versionId)).toMatchObject({ childAges: [9], roomType: 'Synthetic Suite' });
      const c = await h.saveService(OWNER, r.versionId, b.rowVersion, { itemId: hotelId, facts: { ...HOTEL_V2, children: 0 } });
      expect(await factsOf(hotelId, r.versionId)).not.toHaveProperty('childAges');

      const car = await h.saveService(OWNER, r.versionId, c.rowVersion, { type: 'transfer', facts: { ...TRANSFER, includedKms: 300, vendor: 'Synthetic Cabs' } });
      await h.saveService(OWNER, r.versionId, car.rowVersion, { itemId: car.itemId, facts: { ...TRANSFER, includedKms: null } });
      const carFacts = await factsOf(car.itemId, r.versionId);
      expect(carFacts).not.toHaveProperty('includedKms');
      expect(carFacts.vendor).toBe('Synthetic Cabs');
    });
  });
});

describe('automatic Purchase budget (D2), more cases', () => {
  it('an explicitly typed 0 counts as never typed on the next v2 save', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      const hotelId = r.itemIds[0]!;
      const typed = await h.saveService(OWNER, r.versionId, r.rowVersion, { itemId: hotelId, facts: HOTEL_V2, budget: '0' });
      expect(await budgetOf(hotelId, r.versionId)).toEqual({ b: '0', auto: false });
      await h.saveService(OWNER, r.versionId, typed.rowVersion, { itemId: hotelId, facts: HOTEL_V2 });
      expect(await budgetOf(hotelId, r.versionId)).toEqual({ b: '2700000', auto: true });
    });
  });

  it('a revision draft keeps the copied budget; only a typed budget changes it (review round 1 ruling)', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      const hotelId = r.itemIds[0]!;
      await h.confirm(OWNER, r.versionId, (await h.readiness(OWNER, r.versionId)).contentHash);
      await one(ACC, 'select public.accounts_review_return($1, $2, $3) as r', [r.versionId, 'Synthetic return: change the hotel rate', rid()]);
      const opened = await one<{ versionId: string; rowVersion: number }>(OWNER, 'select public.booking_open_revision($1) as r', [r.versionId]);
      expect(await budgetOf(hotelId, opened.versionId)).toEqual({ b: '2700000', auto: true });
      const s1 = await h.saveService(OWNER, opened.versionId, opened.rowVersion, { itemId: hotelId, facts: HOTEL_V2,
        estimate: { roomRatePaise: '500000', extraBedRatePaise: null, noBedRatePaise: null } });
      // Lead ruling (review round 1): no automatic recalculation inside a revision draft.
      expect(await budgetOf(hotelId, opened.versionId)).toEqual({ b: '2700000', auto: true });
      // The submitted version is untouched.
      expect(await budgetOf(hotelId, r.versionId)).toEqual({ b: '2700000', auto: true });
      const s2 = await h.saveService(OWNER, opened.versionId, s1.rowVersion, { itemId: hotelId, facts: HOTEL_V2, budget: '3500000' });
      await h.saveService(OWNER, opened.versionId, s2.rowVersion, { itemId: hotelId, facts: HOTEL_V2,
        estimate: { roomRatePaise: '600000', extraBedRatePaise: null, noBedRatePaise: null } });
      expect(await budgetOf(hotelId, opened.versionId)).toEqual({ b: '3500000', auto: false });
    });
  });
});
