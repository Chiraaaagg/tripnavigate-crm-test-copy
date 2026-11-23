import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ACCOUNTS, ANON, MANAGER, OTHER_ENTITY, OWNER, PURCHASE, SUPER } from './b1-support';
import { REASON, SQL, vnHelpers } from './vn-support';

/**
 * Voice-note batch, migration 20261128000120: the hotel catalogue. Type-ahead
 * search for staff of the entity (2+ characters, prefix first, pages of at
 * most 50, active hotels only, never another entity), Super Admin edit with a
 * reason (audited).
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

type Search = { items: Array<{ id: string; name: string; city: string; starCategory: string | null }>; hasMore: boolean };
const search = (actor: Actor, q: string, city: string | null = null, limit = 20, offset = 0) =>
  one<Search>(actor, SQL.hotelSearch, [q, city, limit, offset]);
const save = async (fields: Record<string, unknown>, id: string | null = null, rv = 0) =>
  one<{ id: string; rowVersion: number; outcome: string }>(SUPER, SQL.hotelSave, [await h.entity(), id, rv, JSON.stringify(fields), REASON]);

describe('hotel catalogue', () => {
  it('Super Admin creates and edits with a reason; others are refused; field rules name the keys; audited', async () => {
    await asOwner(db, async () => {
      const entity = await h.entity();
      for (const actor of [OWNER, MANAGER, ACCOUNTS, PURCHASE, OTHER_ENTITY] as Actor[]) {
        await refused(actor, SQL.hotelSave, [entity, null, 0, JSON.stringify({ name: 'X', city: 'Y' }), REASON], '42501', 'not_authorized');
      }
      await refused(ANON, SQL.hotelSave, [entity, null, 0, JSON.stringify({ name: 'X', city: 'Y' }), REASON], '42501');
      await refusedWithHint(SUPER, SQL.hotelSave, [entity, null, 0, JSON.stringify({ name: ' ', starCategory: '9 star', colour: 'red' }), REASON],
        /^city,colour,name,starCategory$/);
      const a = await save({ name: 'Synthetic Palace Jodhpur', city: 'Jodhpur', starCategory: '5 Star', sourceRef: 'H-001' });
      expect(a).toMatchObject({ outcome: 'created', rowVersion: 1 });
      expect(await owner('select star_category, status, verification from public.hotel_catalogue where id = $1', [a.id]))
        .toEqual([{ star_category: '5', status: 'active', verification: 'not_checked' }]);
      await refusedWithHint(SUPER, SQL.hotelSave, [entity, null, 0, JSON.stringify({ name: 'Other', city: 'Jodhpur', sourceRef: 'H-001' }), REASON],
        /^sourceRef$/);
      const b = await save({ verification: 'checked' }, a.id, 1);
      expect(b).toMatchObject({ outcome: 'updated', rowVersion: 2 });
      expect(await save({ verification: 'checked' }, a.id, 2)).toMatchObject({ outcome: 'unchanged' });
      await refused(SUPER, SQL.hotelSave, [entity, a.id, 1, JSON.stringify({ area: 'Old city' }), REASON], '40001', 'version_changed');
      const audit = await h.auditRows('hotel.catalogue_saved');
      expect(audit.map((x) => x.details.changedFields)).toEqual([
        ['name', 'city', 'area', 'address', 'starCategory', 'sourceRef', 'status', 'verification'], ['verification']]);
      expect(audit[0]!.reason).toBe(REASON);
      await refused(SUPER, 'delete from public.hotel_catalogue', [], '42501');
    });
  });

  it('search: 2+ characters, prefix first, pages, active only, entity staff only (never another entity)', async () => {
    await asOwner(db, async () => {
      await save({ name: 'Synthetic Lake Resort', city: 'Udaipur' });
      await save({ name: 'Lake View Synthetic Inn', city: 'Udaipur' });
      await save({ name: 'Lakeside Synthetic Lodge', city: 'Jodhpur' });
      await save({ name: 'Closed Lake Hotel', city: 'Udaipur', status: 'inactive' });
      await save({ name: '100% Synthetic_Stay', city: 'Delhi' });
      expect(await search(OWNER, 'l')).toEqual({ items: [], hasMore: false });
      const r = await search(OWNER, 'lake');
      expect(r.items.map((x) => x.name)).toEqual(['Lake View Synthetic Inn', 'Lakeside Synthetic Lodge', 'Synthetic Lake Resort']);
      expect(r.hasMore).toBe(false);
      expect((await search(OWNER, 'LAKE', 'udaipur')).items.map((x) => x.name)).toEqual(['Lake View Synthetic Inn', 'Synthetic Lake Resort']);
      const p1 = await search(OWNER, 'lake', null, 2, 0);
      expect(p1).toMatchObject({ hasMore: true });
      expect(p1.items).toHaveLength(2);
      expect((await search(OWNER, 'lake', null, 2, 2)).items.map((x) => x.name)).toEqual(['Synthetic Lake Resort']);
      // Wildcards are text, not patterns.
      expect((await search(OWNER, '0%')).items.map((x) => x.name)).toEqual(['100% Synthetic_Stay']);
      expect((await search(OWNER, 'c_s')).items.map((x) => x.name)).toEqual(['100% Synthetic_Stay']);
      expect((await search(OWNER, 'ke_v')).items).toEqual([]);
      for (const actor of [MANAGER, ACCOUNTS, PURCHASE, SUPER] as Actor[]) {
        expect((await search(actor, 'lake')).items.length).toBe(3);
      }
      // Entity B (disabled in the fixtures): its member is refused; once enabled, it sees only its own hotels (none).
      await refused(OTHER_ENTITY, SQL.hotelSearch, ['lake', null, 20, 0], '42501');
      await owner(`update public.legal_entities set status = 'enabled' where code = 'SYNTHETIC_B'`);
      expect((await search(OTHER_ENTITY, 'lake')).items).toEqual([]);
      await refused(ANON, SQL.hotelSearch, ['lake', null, 20, 0], '42501');
    });
  });
});
