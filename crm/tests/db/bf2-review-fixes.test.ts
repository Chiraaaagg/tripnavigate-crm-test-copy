import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { DEAL, FLIGHT_FACTS, HOTEL, OWNER, SAVE_ITEM_SQL, TRANSFER, rid } from './b1-support';
import { SERVICE_SQL, formHelpers } from './booking-form-support';
import { ACC, SALES_B } from './finance-support';

/**
 * Book now v2, review round 1 rulings (contract.md): hotel children kept
 * without chosen travellers, D2 only on a first draft, the budget for
 * commercial readers only, the older item save clears the automatic flag,
 * quotations refuse the v2-only keys, kept requests re-checked, a car meets
 * a flight of the same version, revision classes, idProofCopyApplies.
 * Migrations 20261129000110-0130. Synthetic data only.
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
const rowVersion = async (versionId: string) =>
  (await owner<{ row_version: number }>('select row_version from public.booking_versions where id = $1', [versionId]))[0]!.row_version;
const { adults: _a, children: _c, ...HOTEL_V2 } = HOTEL;
void [_a, _c];

describe('hotel children (blocker)', () => {
  it('an older hotel with children 2 saved through the v2 path without chosen travellers keeps its children and ages', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      const hotelId = r.itemIds[0]!;
      const rv = (await h.saveService(OWNER, r.versionId, r.rowVersion, { itemId: hotelId,
        facts: { ...HOTEL, children: 2, childAges: [4, 9] } })).rowVersion;
      await h.saveService(OWNER, r.versionId, rv, { itemId: hotelId, facts: { ...HOTEL_V2, mealPlan: 'Half board' } });
      expect(await factsOf(hotelId, r.versionId)).toMatchObject({ children: 2, childAges: [4, 9], mealPlan: 'Half board' });
      // Chosen travellers recount them (D4): one adult and one child.
      await h.saveService(OWNER, r.versionId, await rowVersion(r.versionId), { itemId: hotelId, facts: HOTEL_V2, participants: [1, 4] });
      const recounted = await factsOf(hotelId, r.versionId);
      expect(recounted).toMatchObject({ adults: 1, children: 1 });
      expect(recounted).not.toHaveProperty('childAges');
    });
  });
});

describe('D2 in a revision', () => {
  it('a revision draft keeps the copied budget when the estimate changes', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      const hotelId = r.itemIds[0]!;
      expect(await budgetOf(hotelId, r.versionId)).toEqual({ b: '2700000', auto: true });
      await h.confirm(OWNER, r.versionId, r.hash);
      await one(ACC, 'select public.accounts_review_return($1, $2, $3) as r', [r.versionId, 'Synthetic return: the hotel rate changes', rid()]);
      const opened = await one<{ versionId: string; rowVersion: number }>(OWNER, 'select public.booking_open_revision($1) as r', [r.versionId]);
      await h.saveService(OWNER, opened.versionId, opened.rowVersion, { itemId: hotelId, facts: HOTEL,
        estimate: { roomRatePaise: '900000', extraBedRatePaise: null, noBedRatePaise: null } });
      expect(await budgetOf(hotelId, opened.versionId)).toEqual({ b: '2700000', auto: true });
    });
  });
});

describe('budget visibility and the older item save', () => {
  it('a Sales editor without deal.read_commercial gets no budget; service_item_save with a new budget clears the automatic flag', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      const hotelId = r.itemIds[0]!;
      const full = (await h.form(OWNER))!;
      expect((full.items as Array<Record<string, unknown>>)[0]!.purchaseBudgetPaise).toBe('2700000');
      // The older item save: the same budget keeps the flag, a new one is typed.
      const same = await one<{ rowVersion: number }>(OWNER, SAVE_ITEM_SQL, [hotelId, r.versionId, r.rowVersion, JSON.stringify(HOTEL), '2700000']);
      expect(await budgetOf(hotelId, r.versionId)).toEqual({ b: '2700000', auto: true });
      await one(OWNER, SAVE_ITEM_SQL, [hotelId, r.versionId, same.rowVersion, JSON.stringify(HOTEL), '3000000']);
      expect(await budgetOf(hotelId, r.versionId)).toEqual({ b: '3000000', auto: false });
      await h.addSalesAssignee(DEAL, SALES_B.userId!);
      await owner(`delete from public.role_permissions where role_code = 'sales' and permission_code = 'deal.read_commercial'`);
      const limited = (await h.form(SALES_B))!;
      expect((limited.items as Array<Record<string, unknown>>).every((i) => !('purchaseBudgetPaise' in i))).toBe(true);
    });
  });
});

describe('quotations refuse the v2-only keys', () => {
  it('flight entryMode / requestItems, hotel requestItems and car flightItemId', async () => {
    await asOwner(db, async () => {
      await h.setSwitch('service_items_enabled', true);
      const q = await one<{ versionId: string; rowVersion: number }>(OWNER, 'select public.quotation_create($1, $2, $3, $4) as r',
        ['deal', DEAL, 'Synthetic v2 keys quote', rid()]);
      const add = 'select public.quotation_item_add($1, $2, $3, $4, $5::jsonb) as r';
      await refusedWithHint(OWNER, add, [q.versionId, q.rowVersion, 'flight', null, JSON.stringify({ ...FLIGHT_FACTS, entryMode: 'typed' })], /entryMode/);
      await refusedWithHint(OWNER, add, [q.versionId, q.rowVersion, 'flight', null,
        JSON.stringify({ ...FLIGHT_FACTS, requestItems: [{ text: 'Window seat', forSeq: null }] })], /requestItems/);
      await refusedWithHint(OWNER, add, [q.versionId, q.rowVersion, 'hotel', null,
        JSON.stringify({ ...HOTEL, requestItems: [{ text: 'Baby cot', forSeq: null }] })], /requestItems/);
      await refusedWithHint(OWNER, add, [q.versionId, q.rowVersion, 'transfer', null,
        JSON.stringify({ ...TRANSFER, flightItemId: crypto.randomUUID() })], /flightItemId/);
      // Plain facts still save.
      expect((await one<{ itemNo: number }>(OWNER, add, [q.versionId, q.rowVersion, 'flight', null, JSON.stringify(FLIGHT_FACTS)])).itemNo).toBe(1);
    });
  });
});

describe('kept requests, car flight link and revision classes', () => {
  it('a request for someone no longer on the item becomes for everyone and its text is written again', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      const f = await h.saveService(OWNER, r.versionId, r.rowVersion, { type: 'flight', participants: [1, 2],
        facts: { ...FLIGHT_FACTS, requestItems: [{ text: 'Wheelchair help', forSeq: 2 }, { text: 'Window seat', forSeq: 1 }] } });
      // Traveller 2 leaves the flight; the drawer does not post the requests.
      const { requestItems: _r, ...plain } = { ...FLIGHT_FACTS, requestItems: null };
      void _r;
      const s = await h.saveService(OWNER, r.versionId, f.rowVersion, { itemId: f.itemId, facts: plain, participants: [1] });
      expect(await factsOf(f.itemId, r.versionId)).toMatchObject({
        requestItems: [{ text: 'Wheelchair help', forSeq: null }, { text: 'Window seat', forSeq: 1 }],
        preferences: 'Wheelchair help, Window seat (Synthetic Traveller One)' });
      // A rename shows on the next save.
      await owner(`update public.deal_travellers set full_name = 'Synthetic Renamed One' where deal_id = $1 and seq = 1`, [DEAL]);
      await h.saveService(OWNER, r.versionId, await rowVersion(r.versionId), { itemId: f.itemId, facts: plain });
      expect((await factsOf(f.itemId, r.versionId)).preferences).toBe('Wheelchair help, Window seat (Synthetic Renamed One)');
      expect(s.rowVersion).toBeGreaterThan(f.rowVersion);
    });
  });

  it('flightItemId must be a flight of the same booking version; car keys and entryMode are choice changes', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      const flight = await h.saveService(OWNER, r.versionId, r.rowVersion, { type: 'flight', facts: FLIGHT_FACTS });
      await refusedWithHint(OWNER, SERVICE_SQL, [r.versionId, flight.rowVersion, null, 'transfer',
        JSON.stringify({ ...TRANSFER, flightItemId: r.itemIds[0] }), null, null, null, rid()], /^flightItemId$/);
      await refusedWithHint(OWNER, SERVICE_SQL, [r.versionId, flight.rowVersion, null, 'transfer',
        JSON.stringify({ ...TRANSFER, flightItemId: crypto.randomUUID() }), null, null, null, rid()], /^flightItemId$/);
      const car = await h.saveService(OWNER, r.versionId, flight.rowVersion, { type: 'transfer',
        facts: { ...TRANSFER, carKind: 'airport_pickup', flightItemId: flight.itemId } });
      expect((await factsOf(car.itemId, r.versionId)).flightItemId).toBe(flight.itemId);
      expect(await owner(`select authz.revision_field_class('items.3.carKind') as a, authz.revision_field_class('items.3.flightItemId') as b,
        authz.revision_field_class('items.2.entryMode') as c`)).toEqual([{ a: 'choice', b: 'choice', c: 'choice' }]);
    });
  });
});

describe('idProofCopyApplies', () => {
  it('true only when the copy switch is on and the Deal came from Bitrix', async () => {
    await asOwner(db, async () => {
      await h.readyForm();
      expect((await h.form(OWNER))!.idProofCopyApplies).toBe(false);
      const imported = await h.insertRealDeal('C7:PREPARATION', 7, 5151);
      expect((await h.form(OWNER, imported))!.idProofCopyApplies).toBe(false);
      await owner(`update public.integration_intake_config set bitrix_id_proof_copy = true where portal_member_id = 'SYNTHETIC_MEMBER_0001'`);
      expect((await h.form(OWNER, imported))!.idProofCopyApplies).toBe(true);
      expect((await h.form(OWNER))!.idProofCopyApplies).toBe(false);
    });
  });
});
