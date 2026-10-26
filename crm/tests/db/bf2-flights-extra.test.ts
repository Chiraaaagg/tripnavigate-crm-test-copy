import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { CHECKLIST_SQL, DEAL, FLIGHT_FACTS, OWNER, SHA, TRAVELLERS, rid } from './b1-support';
import { FILE_BEGIN_SQL, FILE_FINISH_SQL, FILE_REMOVE_SQL, SERVICE_SQL, formHelpers } from './booking-form-support';

/**
 * Book now v2, extra flight checks (Agent D): "Add return flights" with no
 * trip end, a stale version, a retry with another payload and a mix of
 * typed and screenshot flights; a screenshot flight blocks submit again when
 * its only screenshot is removed; a typed flight switched to a screenshot
 * keeps no legs. Synthetic data only.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = formHelpers(() => db);
const { one, owner, refused, refusedWithHint } = h;

const RETURNS_SQL = 'select public.booking_flight_returns_add($1, $2, $3) as r';
type Returns = { outcome: string; itemIds: string[]; itemNos: number[]; rowVersion: number; contentHash: string; replayed?: boolean };
const ONWARD = { segments: [{ from: 'DEL', to: 'JDH', date: '2026-12-10', airline: 'Synthetic Air', flightNo: 'SA 101' }], passengers: 2 };
const SCREENSHOT = { segments: [], passengers: 1, entryMode: 'screenshot' };
const rowVersion = async (versionId: string) =>
  (await owner<{ row_version: number }>('select row_version from public.booking_versions where id = $1', [versionId]))[0]!.row_version;
const factsOf = async (itemId: string, versionId: string) =>
  (await owner<{ facts: Record<string, unknown> }>(
    'select facts from public.service_item_facts where service_item_id = $1 and booking_version_id = $2', [itemId, versionId]))[0]!.facts;
const flightCount = async () =>
  (await owner<{ n: number }>(`select count(*)::int as n from public.service_items where deal_id = $1 and service_type = 'flight'`, [DEAL]))[0]!.n;

describe('Add return flights: refusals and retries', () => {
  it('no trip end: refused naming tripEnd, nothing added', async () => {
    await asOwner(db, async () => {
      await h.setSwitch('service_items_enabled', true);
      const s = await h.start(OWNER, DEAL);
      const rv = (await h.saveTravellers(OWNER, DEAL, s.rowVersion, TRAVELLERS)).rowVersion;
      expect(await owner('select trip_end from public.booking_versions where id = $1', [s.versionId])).toEqual([{ trip_end: null }]);
      const f = await h.saveService(OWNER, s.versionId, rv, { type: 'flight', facts: ONWARD, participants: [1, 2] });
      await refusedWithHint(OWNER, RETURNS_SQL, [s.versionId, f.rowVersion, rid()], /^tripEnd$/);
      expect(await flightCount()).toBe(1);
      expect(await rowVersion(s.versionId)).toBe(f.rowVersion);
    });
  });

  it('a stale version is refused; the same request id with another version is a conflict, not a second set', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      const f = await h.saveService(OWNER, r.versionId, r.rowVersion, { type: 'flight', facts: ONWARD, participants: [1, 2] });
      await refused(OWNER, RETURNS_SQL, [r.versionId, f.rowVersion - 1, rid()], '40001', 'version_changed');
      const req = rid();
      const added = await one<Returns>(OWNER, RETURNS_SQL, [r.versionId, f.rowVersion, req]);
      expect(added.outcome).toBe('added');
      expect(await flightCount()).toBe(2);
      await refused(OWNER, RETURNS_SQL, [r.versionId, added.rowVersion, req], '40001', 'request_conflict');
      // Two quick presses with fresh ids: the second one sees the return flight and adds nothing.
      expect(await one<Returns>(OWNER, RETURNS_SQL, [r.versionId, added.rowVersion, rid()])).toMatchObject({ outcome: 'already_added', itemIds: [] });
      expect(await flightCount()).toBe(2);
    });
  });

  it('with typed and screenshot flights only the typed ones are reversed', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      const shot = await h.saveService(OWNER, r.versionId, r.rowVersion, { type: 'flight', facts: SCREENSHOT, participants: [3] });
      const typed = await h.saveService(OWNER, r.versionId, shot.rowVersion, { type: 'flight', facts: ONWARD, participants: [1, 2] });
      const added = await one<Returns>(OWNER, RETURNS_SQL, [r.versionId, typed.rowVersion, rid()]);
      expect(added).toMatchObject({ outcome: 'added' });
      expect(added.itemIds.length).toBe(1);
      expect(await factsOf(added.itemIds[0]!, r.versionId)).toEqual({ segments: [{ from: 'JDH', to: 'DEL', date: '2026-12-13', airline: 'Synthetic Air' }],
        passengers: 2, isReturn: true });
      expect(await owner('select authz.item_participant_seqs($1, $2) as s', [added.itemIds[0], r.versionId])).toEqual([{ s: [1, 2] }]);
      expect(await flightCount()).toBe(3);
    });
  });
});

describe('screenshot flights and the submit check', () => {
  it('removing the only screenshot blocks submit again; two screenshot flights are both named', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      const a = await h.saveService(OWNER, r.versionId, r.rowVersion, { type: 'flight', facts: SCREENSHOT, participants: [1] });
      const b = await h.saveService(OWNER, r.versionId, a.rowVersion, { type: 'flight', facts: SCREENSHOT, participants: [2] });
      const list = await one<{ items: Array<{ code: string; itemNos?: number[] }>; canConfirm: boolean }>(OWNER, CHECKLIST_SQL, [DEAL]);
      expect(list.items.find((i) => i.code === 'flight_screenshot_missing')?.itemNos).toEqual([a.itemNo, b.itemNo]);
      const store = async (itemId: string) => {
        const begun = await one<{ fileId: string; objectPath: string }>(OWNER, FILE_BEGIN_SQL,
          [itemId, r.versionId, 'flight_screenshot', JSON.stringify({ fileName: 'fare quote.png', mime: 'image/png', sizeBytes: 2048, sha256: SHA }), rid()]);
        await owner(`insert into storage.objects (bucket_id, name, metadata) values ('service-item-files', $1, jsonb_build_object('size', 2048::bigint))`,
          [begun.objectPath]);
        return one<{ fileId: string; rowVersion: number }>(OWNER, FILE_FINISH_SQL, [begun.fileId, true]);
      };
      await store(a.itemId);
      const afterOne = await one<{ items: Array<{ code: string; itemNos?: number[] }> }>(OWNER, CHECKLIST_SQL, [DEAL]);
      expect(afterOne.items.find((i) => i.code === 'flight_screenshot_missing')?.itemNos).toEqual([b.itemNo]);
      const fileB = await store(b.itemId);
      expect((await h.readiness(OWNER, r.versionId)).issues).toEqual([]);
      await one(OWNER, FILE_REMOVE_SQL, [fileB.fileId, fileB.rowVersion]);
      expect((await h.readiness(OWNER, r.versionId)).issues).toEqual(['flight_screenshot_missing']);
      await refused(OWNER, 'select public.booking_confirm($1, $2) as r', [r.versionId, (await h.readiness(OWNER, r.versionId)).contentHash],
        '55000', 'not_ready');
    });
  });

  it('a typed flight switched to a screenshot keeps no legs; back to typed needs a leg again', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      const f = await h.saveService(OWNER, r.versionId, r.rowVersion, { type: 'flight', facts: FLIGHT_FACTS, participants: [1, 2, 3, 4] });
      const s = await h.saveService(OWNER, r.versionId, f.rowVersion, { itemId: f.itemId,
        facts: { segments: [], passengers: 4, entryMode: 'screenshot', cabin: 'Economy' } });
      expect(await factsOf(f.itemId, r.versionId)).toEqual({ segments: [], passengers: 4, entryMode: 'screenshot', cabin: 'Economy' });
      expect((await h.readiness(OWNER, r.versionId)).issues).toEqual(['flight_screenshot_missing']);
      await refusedWithHint(OWNER, SERVICE_SQL, [r.versionId, s.rowVersion, f.itemId, null,
        JSON.stringify({ segments: [], passengers: 4, entryMode: 'typed' }), null, null, null, rid()], /segments/);
    });
  });
});
