import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { DEAL, HOTEL, OWNER, rid } from './b1-support';
import { SERVICE_SQL, formHelpers } from './booking-form-support';

/**
 * Book now v2 change 4 (UX-004): reproduction of the "duplicate hotel" on a
 * disposable PGlite database (Agent D). It replays, at the database, the
 * three ways a double press of "Save hotel" can reach booking_service_save.
 * Write-up: docs/implementation/booking-form-v2-2026-10-26/duplicate-hotel-repro.md.
 * Synthetic data only.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = formHelpers(() => db);
const { refused } = h;

const NEW_HOTEL = { ...HOTEL, hotelName: 'Synthetic Second Hotel', specialRequests: null };
const hotels = async () =>
  (await h.owner<{ n: number }>(`select count(*)::int as n from public.service_items where deal_id = $1 and service_type = 'hotel'`, [DEAL]))[0]!.n;
const post = (versionId: string, rowVersion: number, requestId: string, facts: unknown = NEW_HOTEL) =>
  [versionId, rowVersion, null, 'hotel', JSON.stringify(facts), null, null, [1, 2], requestId];

describe('double "Save hotel" on a new hotel', () => {
  it('same request id and the same post: one hotel, the second answer is the first one replayed', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      expect(await hotels()).toBe(1);
      const req = rid();
      const first = await h.saveService(OWNER, r.versionId, r.rowVersion, { type: 'hotel', facts: NEW_HOTEL, participants: [1, 2], requestId: req });
      const second = await h.saveService(OWNER, r.versionId, r.rowVersion, { type: 'hotel', facts: NEW_HOTEL, participants: [1, 2], requestId: req });
      expect(second).toEqual({ ...first, outcome: 'existing' });
      expect(await hotels()).toBe(2);
    });
  });

  it('same request id, the post changed in between: refused as a conflict, one hotel', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      const req = rid();
      await h.saveService(OWNER, r.versionId, r.rowVersion, { type: 'hotel', facts: NEW_HOTEL, participants: [1, 2], requestId: req });
      await refused(OWNER, SERVICE_SQL, post(r.versionId, r.rowVersion, req, { ...NEW_HOTEL, mealPlan: 'Half board' }), '40001', 'request_conflict');
      expect(await hotels()).toBe(2);
    });
  });

  it('a new request id with the version the press was made on: refused (version changed), one hotel', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      await h.saveService(OWNER, r.versionId, r.rowVersion, { type: 'hotel', facts: NEW_HOTEL, participants: [1, 2] });
      await refused(OWNER, SERVICE_SQL, post(r.versionId, r.rowVersion, rid()), '40001', 'version_changed');
      expect(await hotels()).toBe(2);
    });
  });

  it('REPRODUCED: a new request id with the version the first save returned adds a second, identical hotel', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      // This is what the live form's queued second press sends (src/views/b11/draft-sync.tsx useSectionForm:
      // run() waits for the first answer, then send() posts the returned row version with a fresh request id).
      const first = await h.saveService(OWNER, r.versionId, r.rowVersion, { type: 'hotel', facts: NEW_HOTEL, participants: [1, 2] });
      const second = await h.saveService(OWNER, r.versionId, first.rowVersion, { type: 'hotel', facts: NEW_HOTEL, participants: [1, 2] });
      expect(second.itemId).not.toBe(first.itemId);
      expect(second.itemNo).toBe(first.itemNo + 1);
      expect(await hotels()).toBe(3);
      const facts = await h.owner<{ facts: Record<string, unknown> }>(
        'select facts from public.service_item_facts where booking_version_id = $1 and service_item_id = any ($2::uuid[]) order by service_item_id',
        [r.versionId, [first.itemId, second.itemId]]);
      expect(facts[0]!.facts).toEqual(facts[1]!.facts);
    });
  });
});
