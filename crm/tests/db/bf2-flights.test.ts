import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ANON, CHECKLIST_SQL, DEAL, FLIGHT, FLIGHT_CLAIM_SQL, FLIGHT_FACTS, FLIGHT_GET_SQL, OWNER, PURCHASE, SHA, rid } from './b1-support';
import { FILE_BEGIN_SQL, FILE_FINISH_SQL, formHelpers } from './booking-form-support';
import { ACC, SALES_B } from './finance-support';

/**
 * Book now v2, migrations 20261129000100-0120: fare per person on a flight,
 * the typed all-flights totals (booking_flight_fares_save), "Add return
 * flights" (booking_flight_returns_add), the readiness code
 * flight_screenshot_missing, revision copy, the content hash and the reads
 * (booking_form_get, flight task). Synthetic data only.
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

const FARES_SQL = 'select public.booking_flight_fares_save($1, $2, $3::jsonb, $4) as r';
const RETURNS_SQL = 'select public.booking_flight_returns_add($1, $2, $3) as r';
type RV = { rowVersion: number; contentHash: string; outcome?: string };
type Returns = RV & { outcome: string; itemIds: string[]; itemNos: number[] };
const ONWARD = { segments: [{ from: 'DEL', to: 'JDH', date: '2026-12-10', airline: 'Synthetic Air', flightNo: 'SA 101', departTime: '08:00' }],
  passengers: 2, cabin: 'Economy', requestItems: [{ text: 'Window seat', forSeq: 1 }] };
const SCREENSHOT = { segments: [], passengers: 1, entryMode: 'screenshot' };
const rowVersion = async (versionId: string) =>
  (await owner<{ row_version: number }>('select row_version from public.booking_versions where id = $1', [versionId]))[0]!.row_version;

describe('fare per person on a flight', () => {
  it('is stored per type, read back by commercial readers, moves the hash; the older total is accepted only unchanged', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      const before = (await h.readiness(OWNER, r.versionId)).contentHash;
      const f = await h.saveService(OWNER, r.versionId, r.rowVersion, { type: 'flight', facts: FLIGHT_FACTS, participants: [1, 2, 3, 4],
        estimate: { kind: 'flight', fareAdultPaise: '600000', fareChildPaise: '450000', fareInfantPaise: null } });
      expect(await owner(`select fare_adult_paise::text as a, fare_child_paise::text as c, fare_infant_paise as i, fare_total_paise as t
        from public.service_item_cost_estimates where service_item_id = $1`, [f.itemId]))
        .toEqual([{ a: '600000', c: '450000', i: null, t: null }]);
      const form = (await h.form(OWNER))!;
      const item = (form.items as Array<Record<string, unknown>>).find((i) => i.itemId === f.itemId)!;
      expect(item.estimate).toEqual({ kind: 'flight', fareTotalPaise: null, fareAdultPaise: '600000', fareChildPaise: '450000', fareInfantPaise: null });
      // Only the fare changes: the hash moves.
      const h1 = (await h.readiness(OWNER, r.versionId)).contentHash;
      const g = await h.saveService(OWNER, r.versionId, f.rowVersion, { itemId: f.itemId, facts: FLIGHT_FACTS,
        estimate: { fareAdultPaise: '650000', fareChildPaise: '450000' } });
      expect((await h.readiness(OWNER, r.versionId)).contentHash).not.toBe(h1);
      expect(h1).not.toBe(before);
      // fareTotalPaise: only the stored value (null here) is accepted.
      await refusedWithHint(OWNER, 'select public.booking_service_save($1, $2, $3, $4, $5::jsonb, $6::bigint, $7::jsonb, $8::integer[], $9) as r',
        [r.versionId, g.rowVersion, f.itemId, null, JSON.stringify(FLIGHT_FACTS), null, JSON.stringify({ fareTotalPaise: '100' }), null, rid()],
        /^estimate\.fareTotalPaise$/);
      // An item saved before v2 keeps its total when the fare per person is written.
      await owner('update public.service_item_cost_estimates set fare_total_paise = 2000000 where service_item_id = $1', [f.itemId]);
      const k = await h.saveService(OWNER, r.versionId, g.rowVersion, { itemId: f.itemId, facts: FLIGHT_FACTS,
        estimate: { fareTotalPaise: '2000000', fareAdultPaise: '700000' } });
      expect(await owner('select fare_total_paise::text as t, fare_adult_paise::text as a, fare_child_paise as c from public.service_item_cost_estimates where service_item_id = $1',
        [f.itemId])).toEqual([{ t: '2000000', a: '700000', c: null }]);
      expect(k.rowVersion).toBeGreaterThan(g.rowVersion);
    });
  });
});

describe('typed total fare per person, all flights (booking_flight_fares_save)', () => {
  it('commercial readers who edit; exact retry; all null removes it; ids-only audit; read by booking_form_get', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      const req = rid();
      const saved = await one<RV>(OWNER, FARES_SQL, [r.versionId, r.rowVersion, JSON.stringify({ adultPaise: '1400000', childPaise: null }), req]);
      expect(saved.rowVersion).toBe(r.rowVersion + 1);
      expect(await one<RV>(OWNER, FARES_SQL, [r.versionId, r.rowVersion, JSON.stringify({ adultPaise: '1400000', childPaise: null }), req]))
        .toEqual({ ...saved, outcome: 'existing' });
      expect((await h.form(OWNER))!.flightFareTotals).toEqual({ adultPaise: '1400000', childPaise: null, infantPaise: null });
      // Same values again: nothing changes.
      const same = await one<RV>(OWNER, FARES_SQL, [r.versionId, saved.rowVersion, JSON.stringify({ adultPaise: '1400000' }), rid()]);
      expect(same.rowVersion).toBe(saved.rowVersion);
      await refusedWithHint(OWNER, FARES_SQL, [r.versionId, saved.rowVersion, JSON.stringify({ adultPaise: '-1' }), rid()], /^fares\.adultPaise$/);
      await refusedWithHint(OWNER, FARES_SQL, [r.versionId, saved.rowVersion, JSON.stringify({ sellingPaise: '1' }), rid()], /^fares$/);
      await refused(OWNER, FARES_SQL, [r.versionId, saved.rowVersion - 1, JSON.stringify({ adultPaise: '1' }), rid()], '40001', 'version_changed');
      const cleared = await one<RV>(OWNER, FARES_SQL, [r.versionId, saved.rowVersion, JSON.stringify({ adultPaise: null }), rid()]);
      expect(await owner('select count(*)::int as n from public.booking_version_flight_fares where booking_version_id = $1', [r.versionId]))
        .toEqual([{ n: 0 }]);
      expect(cleared.rowVersion).toBe(saved.rowVersion + 1);
      const audit = await owner<{ details: Record<string, unknown> }>(`select details from public.audit_events where action = 'booking.flight_fares_saved'`);
      expect(audit.length).toBe(2);
      expect(JSON.stringify(audit)).not.toMatch(/1400000/);
      // Without price access (assignee whose role loses deal.read_commercial): refused, and not read.
      await h.addSalesAssignee(DEAL, SALES_B.userId!);
      await owner(`delete from public.role_permissions where role_code = 'sales' and permission_code = 'deal.read_commercial'`);
      await refused(SALES_B, FARES_SQL, [r.versionId, cleared.rowVersion, JSON.stringify({ adultPaise: '1' }), rid()], '42501', 'not_authorized');
      expect((await h.form(SALES_B))!).not.toHaveProperty('flightFareTotals');
      for (const actor of [PURCHASE, ACC, ANON]) {
        await refused(actor, FARES_SQL, [r.versionId, cleared.rowVersion, JSON.stringify({ adultPaise: '1' }), rid()], '42501');
      }
      // The table has no Data API privilege.
      expect(await owner(`select has_table_privilege('authenticated', 'public.booking_version_flight_fares', 'select') as s`)).toEqual([{ s: false }]);
    });
  });
});

describe('Add return flights (booking_flight_returns_add)', () => {
  it('reverses every typed onward flight in one transaction; later calls answer already_added; screenshot-only answers no_typed_flights', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      // Screenshot flights only: nothing to reverse.
      const shot = await h.saveService(OWNER, r.versionId, r.rowVersion, { type: 'flight', facts: SCREENSHOT, participants: [1] });
      const none = await one<Returns>(OWNER, RETURNS_SQL, [r.versionId, shot.rowVersion, rid()]);
      expect(none).toMatchObject({ outcome: 'no_typed_flights', itemIds: [], itemNos: [], rowVersion: shot.rowVersion });

      const a = await h.saveService(OWNER, r.versionId, shot.rowVersion, { type: 'flight', facts: ONWARD, participants: [1, 2],
        estimate: { fareAdultPaise: '600000' } });
      const b = await h.saveService(OWNER, r.versionId, a.rowVersion, { type: 'flight', participants: [1, 2],
        facts: { segments: [{ from: 'JDH', to: 'UDR', date: '2026-12-11' }, { from: 'UDR', to: 'BOM', date: '2026-12-11', airline: 'Synthetic Air' }],
          passengers: 2 } });
      const req = rid();
      const added = await one<Returns>(OWNER, RETURNS_SQL, [r.versionId, b.rowVersion, req]);
      expect(added.outcome).toBe('added');
      expect(added.itemIds.length).toBe(2);
      // The latest onward flight comes back first; legs reversed; all dated to the trip end.
      const facts = await owner<{ item_no: number; facts: Record<string, unknown>; seqs: number[] }>(
        `select i.item_no, f.facts, authz.item_participant_seqs(i.id, f.booking_version_id) as seqs
         from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
         where f.booking_version_id = $1 and i.id = any ($2::uuid[]) order by i.item_no`, [r.versionId, added.itemIds]);
      expect(facts.map((x) => x.item_no)).toEqual(added.itemNos);
      expect(facts[0]!.facts).toEqual({ segments: [{ from: 'BOM', to: 'UDR', date: '2026-12-13', airline: 'Synthetic Air' },
        { from: 'UDR', to: 'JDH', date: '2026-12-13' }], passengers: 2, isReturn: true });
      expect(facts[1]!.facts).toEqual({ segments: [{ from: 'JDH', to: 'DEL', date: '2026-12-13', airline: 'Synthetic Air' }], passengers: 2,
        cabin: 'Economy', isReturn: true, requestItems: [{ text: 'Window seat', forSeq: 1 }],
        preferences: 'Window seat (Synthetic Traveller One)' });
      expect(facts.every((x) => JSON.stringify(x.seqs) === '[1,2]')).toBe(true);
      // No fares on the return flights.
      expect(await owner('select count(*)::int as n from public.service_item_cost_estimates where service_item_id = any ($1::uuid[])',
        [added.itemIds])).toEqual([{ n: 0 }]);
      // Exact retry and a later call.
      expect(await one<Returns>(OWNER, RETURNS_SQL, [r.versionId, b.rowVersion, req])).toEqual({ ...added, replayed: true });
      const again = await one<Returns>(OWNER, RETURNS_SQL, [r.versionId, added.rowVersion, rid()]);
      expect(again).toMatchObject({ outcome: 'already_added', itemIds: [] });
      // Editing a return flight keeps the flag.
      await h.saveService(OWNER, r.versionId, again.rowVersion, { itemId: added.itemIds[1]!,
        facts: { segments: [{ from: 'JDH', to: 'DEL', date: '2026-12-13', flightNo: 'SA 202' }], passengers: 2 } });
      expect((await owner<{ facts: Record<string, unknown> }>('select facts from public.service_item_facts where service_item_id = $1',
        [added.itemIds[1]]))[0]!.facts.isReturn).toBe(true);
      // Ids only in the audit row; not for other roles.
      const audit = await owner<{ details: Record<string, unknown> }>(`select details from public.audit_events where action = 'booking.flight_returns_added'`);
      expect(Object.keys(audit[0]!.details).sort()).toEqual(['dealId', 'itemIds', 'itemNos', 'rowVersion', 'versionId']);
      await refused(PURCHASE, RETURNS_SQL, [r.versionId, await rowVersion(r.versionId), rid()], '42501', 'not_authorized');
      await refused(ANON, RETURNS_SQL, [r.versionId, await rowVersion(r.versionId), rid()], '42501');
    });
  });
});

describe('readiness: a screenshot flight needs a stored screenshot', () => {
  it('blocks submit with flight_screenshot_missing (item numbers on the checklist) until a screenshot is stored', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      expect(r.issues).toEqual([]);
      const shot = await h.saveService(OWNER, r.versionId, r.rowVersion, { type: 'flight', facts: SCREENSHOT, participants: [1] });
      expect((await h.readiness(OWNER, r.versionId)).issues).toEqual(['flight_screenshot_missing']);
      const list = await one<{ items: Array<{ code: string; blocking: boolean; itemNos: number[] }>; canConfirm: boolean }>(OWNER, CHECKLIST_SQL, [DEAL]);
      expect(list.items.find((i) => i.code === 'flight_screenshot_missing')).toEqual({ code: 'flight_screenshot_missing', blocking: true,
        owner: 'sales', itemNos: [shot.itemNo] });
      expect(list.canConfirm).toBe(false);
      await refused(OWNER, 'select public.booking_confirm($1, $2) as r', [r.versionId, (await h.readiness(OWNER, r.versionId)).contentHash], '55000', 'not_ready');
      const file = { fileName: 'fare quote.png', mime: 'image/png', sizeBytes: 2048, sha256: SHA };
      const begun = await one<{ fileId: string; objectPath: string }>(OWNER, FILE_BEGIN_SQL, [shot.itemId, r.versionId, 'flight_screenshot', JSON.stringify(file), rid()]);
      expect((await h.readiness(OWNER, r.versionId)).issues).toEqual(['flight_screenshot_missing']);
      await owner(`insert into storage.objects (bucket_id, name, metadata) values ('service-item-files', $1, jsonb_build_object('size', 2048::bigint))`,
        [begun.objectPath]);
      await one(OWNER, FILE_FINISH_SQL, [begun.fileId, true]);
      const ready = await h.readiness(OWNER, r.versionId);
      expect(ready.issues).toEqual([]);

      // The Flight assignee reads the flight, its fare per person and the typed totals; Purchase never.
      await one(OWNER, FARES_SQL, [r.versionId, await rowVersion(r.versionId), JSON.stringify({ adultPaise: '900000' }), rid()]);
      const confirmed = await h.confirm(OWNER, r.versionId, (await h.readiness(OWNER, r.versionId)).contentHash);
      await h.addFlight();
      expect(confirmed.taskIds!.length).toBeGreaterThan(1);
      const tasks = await owner<{ id: string }>(`select id from public.fulfilment_tasks where service_item_id = $1`, [shot.itemId]);
      await one(FLIGHT, FLIGHT_CLAIM_SQL, [tasks[0]!.id]);
      const detail = await one<Record<string, unknown>>(FLIGHT, FLIGHT_GET_SQL, [tasks[0]!.id]);
      expect(detail.itemTitle).toBe('From screenshot');
      expect(detail.fareTotals).toEqual({ adultPaise: '900000', childPaise: null, infantPaise: null });
      expect((detail.files as unknown[]).length).toBe(1);
      const purchaseList = JSON.stringify(await one(PURCHASE, 'select public.purchase_task_list() as r'));
      expect(purchaseList).not.toMatch(/fare|900000/i);
    });
  });
});

describe('budget_missing (owner decision D2)', () => {
  it('no longer warns on a booking-form draft (an activity has no estimate: budget 0 = no budget)', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      const act = await h.saveService(OWNER, r.versionId, r.rowVersion, { type: 'activity',
        facts: { name: 'Synthetic safari', city: 'Synthetic City', date: '2026-12-11', participants: 4 } });
      expect((await owner<{ b: string }>('select purchase_budget_paise::text as b from public.service_item_facts where service_item_id = $1',
        [act.itemId]))[0]!.b).toBe('0');
      const list = await one<{ items: Array<{ code: string }> }>(OWNER, CHECKLIST_SQL, [DEAL]);
      expect(list.items.map((i) => i.code)).not.toContain('budget_missing');
    });
  });
});

describe('revisions copy the v2 values', () => {
  it('fare per person, typed totals and the automatic budget flag', async () => {
    await asOwner(db, async () => {
      const r = await h.readyForm();
      const f = await h.saveService(OWNER, r.versionId, r.rowVersion, { type: 'flight', facts: FLIGHT_FACTS, participants: [1, 2, 3, 4],
        estimate: { fareAdultPaise: '600000', fareChildPaise: '450000' } });
      await one(OWNER, FARES_SQL, [r.versionId, f.rowVersion, JSON.stringify({ infantPaise: '100000' }), rid()]);
      await h.confirm(OWNER, r.versionId, (await h.readiness(OWNER, r.versionId)).contentHash);
      await one(ACC, 'select public.accounts_review_return($1, $2, $3) as r', [r.versionId, 'Synthetic return: change the flight', rid()]);
      const opened = await one<{ versionId: string; rowVersion: number }>(OWNER, 'select public.booking_open_revision($1) as r', [r.versionId]);
      expect(await owner(`select fare_adult_paise::text as a, fare_child_paise::text as c from public.service_item_cost_estimates
        where booking_version_id = $1 and service_item_id = $2`, [opened.versionId, f.itemId])).toEqual([{ a: '600000', c: '450000' }]);
      expect(await owner('select infant_paise::text as i from public.booking_version_flight_fares where booking_version_id = $1', [opened.versionId]))
        .toEqual([{ i: '100000' }]);
      expect(await owner(`select purchase_budget_auto as a from public.service_item_facts where booking_version_id = $1 and service_item_id = $2`,
        [opened.versionId, r.itemIds[0]])).toEqual([{ a: true }]);
      // A fare change in the revision is an internal change.
      const s = await h.saveService(OWNER, opened.versionId, opened.rowVersion, { itemId: f.itemId, facts: FLIGHT_FACTS,
        estimate: { fareAdultPaise: '650000', fareChildPaise: '450000' } });
      const fares = await one<RV>(OWNER, FARES_SQL, [opened.versionId, s.rowVersion, JSON.stringify({ infantPaise: '120000' }), rid()]);
      expect(fares.rowVersion).toBe(s.rowVersion + 1);
      const fields = await owner<{ f: string[] }>('select authz.revision_changed_fields($1) as f', [opened.versionId]);
      expect(fields[0]!.f).toEqual(expect.arrayContaining(['flightFares', `items.${f.itemNo}.estimate`]));
      expect(await owner(`select authz.revision_field_class('flightFares') as c`)).toEqual([{ c: 'internal' }]);
      // Items are fixed in a revision: no return flights there.
      await refused(OWNER, RETURNS_SQL, [opened.versionId, fares.rowVersion, rid()], '55000', 'revision_items_fixed');
    });
  });
});

describe('booking_form_get: the Bitrix Deal link', () => {
  it('null for a Deal not from Bitrix; the Deal page on the configured portal otherwise', async () => {
    await asOwner(db, async () => {
      await h.readyForm();
      expect((await h.form(OWNER))!.bitrixDealHref).toBeNull();
      const imported = await h.insertRealDeal('C7:PREPARATION', 7, 4242);
      expect((await h.form(OWNER, imported))!.bitrixDealHref).toBe('https://synthetic-portal.example.test/crm/deal/details/4242/');
    });
  });
});
