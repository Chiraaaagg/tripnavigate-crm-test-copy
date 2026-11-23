import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { HOTEL, OWNER, PURCHASE, PURCHASE_CLAIM_SQL, PURCHASE_GET_SQL, TRANSFER } from './b1-support';
import { formHelpers } from './booking-form-support';

/**
 * Book now v2, owner decision D2 (26 October 2026, option a): when the form
 * posts no Purchase budget, a hotel, car or activity's budget is set from its
 * "Our cost" estimate on every save while staff never typed one (no estimate
 * = 0 = no budget). A typed budget stays as stored. Migration 20261129000110.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = formHelpers(() => db);
const { one, owner } = h;

const budgetOf = async (itemId: string, versionId: string) =>
  (await owner<{ b: string; auto: boolean }>(
    'select purchase_budget_paise::text as b, purchase_budget_auto as auto from public.service_item_facts where service_item_id = $1 and booking_version_id = $2',
    [itemId, versionId]))[0]!;

describe('Purchase budget from the estimate', () => {
  it('follows the hotel estimate while never typed; a typed budget stays; ids-only audit; Purchase sees that budget', async () => {
    await asOwner(db, async () => {
      // readyForm adds the hotel with no budget and a room rate of ₹4,500: 3 nights × 2 rooms.
      const r = await h.readyForm();
      const hotelId = r.itemIds[0]!;
      expect(await budgetOf(hotelId, r.versionId)).toEqual({ b: '2700000', auto: true });
      // The estimate changes: the budget follows (3 × (2 × ₹5,000 + 1 × ₹1,000)).
      const s1 = await h.saveService(OWNER, r.versionId, r.rowVersion, { itemId: hotelId, facts: { ...HOTEL, extraBeds: 1 },
        estimate: { roomRatePaise: '500000', extraBedRatePaise: '100000', noBedRatePaise: null } });
      expect(await budgetOf(hotelId, r.versionId)).toEqual({ b: '3300000', auto: true });
      // A missing rate (extra bed with no rate): no estimate, so no budget.
      const s2 = await h.saveService(OWNER, r.versionId, s1.rowVersion, { itemId: hotelId, facts: { ...HOTEL, extraBeds: 1 },
        estimate: { roomRatePaise: '500000', extraBedRatePaise: null, noBedRatePaise: null } });
      expect(await budgetOf(hotelId, r.versionId)).toEqual({ b: '0', auto: true });
      const audit = await owner<{ details: Record<string, unknown> }>(
        `select details from public.audit_events where action = 'booking.purchase_budget_from_estimate' order by occurred_at`);
      expect(audit.length).toBeGreaterThanOrEqual(2);
      expect(Object.keys(audit[0]!.details).sort()).toEqual(['dealId', 'itemNo', 'rowVersion', 'versionId']);
      // A typed budget (an older screen) is kept, also when the estimate changes later.
      const s3 = await h.saveService(OWNER, r.versionId, s2.rowVersion, { itemId: hotelId, facts: HOTEL, budget: '4000000' });
      expect(await budgetOf(hotelId, r.versionId)).toEqual({ b: '4000000', auto: false });
      const s4 = await h.saveService(OWNER, r.versionId, s3.rowVersion, { itemId: hotelId, facts: HOTEL,
        estimate: { roomRatePaise: '900000', extraBedRatePaise: null, noBedRatePaise: null } });
      expect(await budgetOf(hotelId, r.versionId)).toEqual({ b: '4000000', auto: false });

      // Car: vehicles × rate per vehicle.
      const car = await h.saveService(OWNER, r.versionId, s4.rowVersion, { type: 'transfer', facts: { ...TRANSFER, quantity: 2 },
        estimate: { vehicleRatePaise: '250000' } });
      expect(await budgetOf(car.itemId, r.versionId)).toEqual({ b: '500000', auto: true });

      // After submission the Purchase task carries the budget (the manager approval rule is unchanged).
      const confirmed = await h.confirm(OWNER, r.versionId, (await h.readiness(OWNER, r.versionId)).contentHash);
      expect(confirmed.taskIds!.length).toBe(2);
      const task = (await owner<{ id: string }>('select id from public.fulfilment_tasks where service_item_id = $1', [car.itemId]))[0]!.id;
      await one(PURCHASE, PURCHASE_CLAIM_SQL, [task]);
      const detail = await one<{ purchaseBudgetPaise: string }>(PURCHASE, PURCHASE_GET_SQL, [task]);
      expect(detail.purchaseBudgetPaise).toBe('500000');
    });
  });

  it('an item saved earlier with budget 0 (never typed) starts following its estimate; flights keep today\'s rule', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      const hotelId = r.itemIds[0]!;
      await owner('update public.service_item_facts set purchase_budget_paise = 0, purchase_budget_auto = false where service_item_id = $1', [hotelId]);
      const s = await h.saveService(OWNER, r.versionId, await rowVersion(r.versionId), { itemId: hotelId, facts: HOTEL });
      expect(await budgetOf(hotelId, r.versionId)).toEqual({ b: '2700000', auto: true });
      const flight = await h.saveService(OWNER, r.versionId, s.rowVersion, { type: 'flight',
        facts: { segments: [{ from: 'DEL', to: 'JDH', date: '2026-12-10' }], passengers: 1 }, participants: [1],
        estimate: { fareAdultPaise: '600000' } });
      expect(await budgetOf(flight.itemId, r.versionId)).toEqual({ b: '0', auto: false });
    });
  });
});

async function rowVersion(versionId: string): Promise<number> {
  return (await db.query<{ row_version: number }>('select row_version from public.booking_versions where id = $1', [versionId]))[0]!.row_version;
}
