import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb, expectDbError } from '../helpers/db';
import {
  ACTIVITY, ADD_SQL, ANON, BUDGETS, DEAL, DEAL2, FLIGHT_FACTS, HOTEL, MANAGER, OWNER, PURCHASE, REMOVE_SQL, SALES_B,
  SAVE_ITEM_SQL, SELLING, SVC, TRANSFER, TRAVELLERS, TRAVELLERS_SQL, b1Helpers, rid,
} from './b1-support';

/**
 * B1 service items (migration 20261118000100_b1_service_items): the intake
 * commands service_item_add / save / remove and deal_travellers_save, their
 * validation (contract section 8), exact-retry replay, row_version conflicts,
 * locks, audit rows and the content hash of 'package' versions.
 *
 * Every scenario runs in ONE rolled-back owner transaction and switches to the
 * impersonated request only for the statement under test.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b1Helpers(() => db);
const { one, refused, refusedWithHint, owner, setSwitch, openDraft, addItem, saveTravellers, readiness, confirm, readyPackage, run } = h;

const B1_TABLES = ['workflow_settings', 'service_items', 'service_item_facts', 'deal_travellers', 'booking_version_travellers'];

describe('schema and catalogue', () => {
  it('creates the B1 tables with RLS, the restrictive session policy, a select-only grant and no anon access', async () => {
    await asOwner(db, async () => {
      const rows = await owner<{ relname: string; rls: boolean; policies: string[] }>(
        `select c.relname, c.relrowsecurity as rls,
                coalesce(array_agg(p.policyname::text order by p.policyname) filter (where p.policyname is not null), '{}') as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         left join pg_policies p on p.schemaname = 'public' and p.tablename = c.relname
         where n.nspname = 'public' and c.relname = any($1::text[])
         group by c.relname, c.relrowsecurity order by c.relname`,
        [B1_TABLES],
      );
      expect(rows.map((r) => r.relname)).toEqual([...B1_TABLES].sort());
      for (const r of rows) {
        expect(r.rls, r.relname).toBe(true);
        expect(r.policies, r.relname).toContain('require_valid_session');
      }
      const privs = await owner<{ t: string; anon: boolean; auth_select: boolean; auth_write: boolean; svc_write: boolean }>(
        `select t,
           has_table_privilege('anon', 'public.' || t, 'select') as anon,
           has_table_privilege('authenticated', 'public.' || t, 'select') as auth_select,
           has_table_privilege('authenticated', 'public.' || t, 'insert,update,delete') as auth_write,
           has_table_privilege('service_role', 'public.' || t, 'insert,update,delete') as svc_write
         from unnest($1::text[]) t`,
        [B1_TABLES],
      );
      for (const p of privs) expect(p, p.t).toMatchObject({ anon: false, auth_select: true, auth_write: false, svc_write: false });
      // The private stage table is readable by nobody through the API.
      const [stages] = await owner<{ auth: boolean; svc: boolean; rows: { category_id: number; stage_id: string }[] }>(
        `select has_table_privilege('authenticated', 'authz.task_trigger_stages', 'select') as auth,
                has_table_privilege('service_role', 'authz.task_trigger_stages', 'select,insert,update,delete') as svc,
                (select jsonb_agg(jsonb_build_object('category_id', s.category_id, 'stage_id', s.stage_id)) from authz.task_trigger_stages s) as rows`,
      );
      expect(stages).toEqual({ auth: false, svc: false, rows: [{ category_id: 0, stage_id: 'UC_AD0SLH' }] });
    });
  });

  it('service tables carry no commercial columns and the task table keeps none', async () => {
    const cols = await asOwner(db, () =>
      owner<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name in ('service_items', 'service_item_facts', 'fulfilment_tasks', 'outbox_events')`,
      ),
    );
    expect(cols.filter((c) => /sell|margin|price|amount/.test(c.column_name))).toEqual([]);
  });

  it('workflow_settings is a single row, both switches off, staff-readable, never API-writable', async () => {
    await asOwner(db, async () => {
      expect(await owner('select id, intake_prompt_enabled, service_items_enabled from public.workflow_settings')).toEqual([
        { id: true, intake_prompt_enabled: false, service_items_enabled: false },
      ]);
      await expectDbError(db, () => owner('insert into public.workflow_settings (id) values (false)'), { code: '23514' });
      expect(await run(OWNER, 'select service_items_enabled from public.workflow_settings')).toEqual([{ service_items_enabled: false }]);
      await refused(PURCHASE, 'update public.workflow_settings set service_items_enabled = true', [], '42501');
      await refused(SVC, 'update public.workflow_settings set service_items_enabled = true', [], '42501');
    });
  });

  it('adds the B1 role-derived, non-grantable permissions', async () => {
    const rows = await asOwner(db, () =>
      owner<{ role_code: string; permission_code: string; scope: string; is_grantable: boolean }>(
        `select rp.role_code, rp.permission_code, rp.scope, p.is_grantable
         from public.role_permissions rp join public.permissions p on p.code = rp.permission_code
         where rp.permission_code in ('deal.intake_edit', 'flight_task.read', 'flight_task.claim')
         order by rp.permission_code, rp.role_code`,
      ),
    );
    expect(rows).toEqual([
      { role_code: 'manager', permission_code: 'deal.intake_edit', scope: 'own', is_grantable: false },
      { role_code: 'sales', permission_code: 'deal.intake_edit', scope: 'own', is_grantable: false },
      { role_code: 'flight', permission_code: 'flight_task.claim', scope: 'own', is_grantable: false },
      { role_code: 'flight', permission_code: 'flight_task.read', scope: 'entity', is_grantable: false },
    ]);
  });

  it('fulfilment_tasks: service_item_id is NOT NULL, both task_key forms are accepted, (item, purpose) is unique', async () => {
    await asOwner(db, async () => {
      const [col] = await owner<{ is_nullable: string }>(
        `select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'fulfilment_tasks' and column_name = 'service_item_id'`,
      );
      expect(col).toEqual({ is_nullable: 'NO' });
      const cons = await owner<{ def: string }>(
        `select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.fulfilment_tasks'::regclass and contype in ('u', 'c') order by 1`,
      );
      const defs = cons.map((c) => c.def);
      expect(defs).toContain('UNIQUE (service_item_id, service_purpose)');
      expect(defs).toContain('UNIQUE (booking_version_id, service_item_id)');
      expect(defs).not.toContain('UNIQUE (booking_version_id, service_purpose)');
      expect(defs.some((d) => d.includes("'item:'") && d.includes("'booking:'"))).toBe(true);
    });
  });
});

describe('switch off: exactly as today', () => {
  it('opens a hotel version and refuses every intake command with service_items_disabled', async () => {
    await asOwner(db, async () => {
      await setSwitch('service_items_enabled', false);
      const opened = await openDraft();
      const [v] = await owner<{ service_type: string }>('select service_type from public.booking_versions where id = $1', [opened.versionId]);
      expect(v).toEqual({ service_type: 'hotel' });
      await refused(OWNER, ADD_SQL, [opened.versionId, 1, 'hotel', JSON.stringify(HOTEL), BUDGETS.hotel, rid()], '55000', 'service_items_disabled');
      await refused(OWNER, SAVE_ITEM_SQL, [rid(), opened.versionId, 1, JSON.stringify(HOTEL), BUDGETS.hotel], '55000', 'service_items_disabled');
      await refused(OWNER, REMOVE_SQL, [rid(), opened.versionId, 1], '55000', 'service_items_disabled');
      await refused(OWNER, TRAVELLERS_SQL, [DEAL, 1, JSON.stringify(TRAVELLERS)], '55000', 'service_items_disabled');
      // Non-editors still get not_authorized first (nothing about the switch leaks).
      await refused(PURCHASE, ADD_SQL, [opened.versionId, 1, 'hotel', JSON.stringify(HOTEL), BUDGETS.hotel, rid()], '42501', 'not_authorized');
      await refused(ANON, ADD_SQL, [opened.versionId, 1, 'hotel', JSON.stringify(HOTEL), BUDGETS.hotel, rid()], '42501');
      expect(await owner('select 1 from public.service_items where deal_id = $1', [DEAL])).toEqual([]);
    });
  });

  it('a hotel version opened before the switch refuses intake commands with invalid_input afterwards', async () => {
    await asOwner(db, async () => {
      await setSwitch('service_items_enabled', false);
      const opened = await openDraft();
      await setSwitch('service_items_enabled', true);
      await refusedWithHint(OWNER, ADD_SQL, [opened.versionId, 1, 'hotel', JSON.stringify(HOTEL), BUDGETS.hotel, rid()], /^version$/);
      await refusedWithHint(OWNER, TRAVELLERS_SQL, [DEAL, 1, JSON.stringify(TRAVELLERS)], /^version$/);
    });
  });
});

describe('service_item_add', () => {
  it('opens a package draft, adds one item per sold service and audits ids only', async () => {
    await asOwner(db, async () => {
      await setSwitch('service_items_enabled', true);
      const opened = await openDraft();
      const [v] = await owner<{ service_type: string; hotel_name: string | null }>(
        'select service_type, hotel_name from public.booking_versions where id = $1', [opened.versionId],
      );
      expect(v).toEqual({ service_type: 'package', hotel_name: null });
      const h1 = await addItem(OWNER, opened.versionId, opened.rowVersion, 'hotel', HOTEL);
      expect(h1).toMatchObject({ itemNo: 1, rowVersion: 2 });
      expect(h1.contentHash).toMatch(/^[0-9a-f]{64}$/);
      const t1 = await addItem(OWNER, opened.versionId, h1.rowVersion, 'transfer', TRANSFER);
      const a1 = await addItem(MANAGER, opened.versionId, t1.rowVersion, 'activity', ACTIVITY);
      const f1 = await addItem(OWNER, opened.versionId, a1.rowVersion, 'flight', FLIGHT_FACTS);
      expect([t1.itemNo, a1.itemNo, f1.itemNo]).toEqual([2, 3, 4]);
      expect(f1.rowVersion).toBe(5);
      expect(new Set([h1.contentHash, t1.contentHash, a1.contentHash, f1.contentHash]).size).toBe(4);

      const items = await owner<{ item_no: number; service_type: string; department: string; state: string; facts: Record<string, unknown>; budget: string }>(
        `select i.item_no, i.service_type, i.department, i.state, f.facts, f.purchase_budget_paise::text as budget
         from public.service_items i join public.service_item_facts f on f.service_item_id = i.id
         where i.deal_id = $1 and f.booking_version_id = $2 order by i.item_no`,
        [DEAL, opened.versionId],
      );
      expect(items.map((i) => [i.item_no, i.service_type, i.department, i.state, i.budget])).toEqual([
        [1, 'hotel', 'purchase', 'planned', BUDGETS.hotel],
        [2, 'transfer', 'purchase', 'planned', BUDGETS.transfer],
        [3, 'activity', 'purchase', 'planned', BUDGETS.activity],
        [4, 'flight', 'flight', 'planned', BUDGETS.flight],
      ]);
      // Stored facts: null optionals dropped, strings trimmed; never a selling key.
      expect(items[0]!.facts).toEqual({
        hotelName: HOTEL.hotelName, city: HOTEL.city, checkIn: HOTEL.checkIn, checkOut: HOTEL.checkOut, rooms: 2, adults: 3,
        roomType: 'Synthetic Deluxe', mealPlan: 'Breakfast', children: 1,
      });
      expect(items[3]!.facts).toEqual({ segments: FLIGHT_FACTS.segments, passengers: 4, cabin: 'Economy' });

      const audit = await owner<{ action: string; details: Record<string, unknown>; actor_user_id: string }>(
        `select action, details, actor_user_id from public.audit_events where action like 'booking.service_item_%' order by id`,
      );
      expect(audit.map((a) => a.action)).toEqual(Array(4).fill('booking.service_item_added'));
      expect(audit.map((a) => a.details.itemNo)).toEqual([1, 2, 3, 4]);
      expect(audit[2]!.actor_user_id).toBe(MANAGER.userId);
      expect(JSON.stringify(audit)).not.toMatch(new RegExp(`${BUDGETS.hotel}|${BUDGETS.flight}|Synthetic Hotel|DEL`));
    });
  });

  it('replays an exact retry (same version and request id, old expected row version) without a second row', async () => {
    await asOwner(db, async () => {
      await setSwitch('service_items_enabled', true);
      const opened = await openDraft();
      const requestId = rid();
      const first = await addItem(OWNER, opened.versionId, opened.rowVersion, 'transfer', TRANSFER, BUDGETS.transfer, requestId);
      const again = await addItem(OWNER, opened.versionId, opened.rowVersion, 'transfer', TRANSFER, BUDGETS.transfer, requestId);
      expect(again).toEqual(first);
      // A later retry still answers the same item even after the draft moved on.
      const second = await addItem(OWNER, opened.versionId, first.rowVersion, 'activity', ACTIVITY);
      const late = await addItem(OWNER, opened.versionId, opened.rowVersion, 'transfer', TRANSFER, BUDGETS.transfer, requestId);
      expect(late).toEqual({ ...first, rowVersion: second.rowVersion, contentHash: second.contentHash });
      expect(await owner('select item_no from public.service_items where deal_id = $1 order by item_no', [DEAL])).toEqual([
        { item_no: 1 }, { item_no: 2 },
      ]);
      await refused(OWNER, ADD_SQL, [opened.versionId, second.rowVersion, 'hotel', JSON.stringify(HOTEL), BUDGETS.hotel, null], '22023', 'invalid_input');
    });
  });

  it('refuses stale row versions, on-hold services, unknown types, bad budgets and more than 20 items', async () => {
    await asOwner(db, async () => {
      await setSwitch('service_items_enabled', true);
      const opened = await openDraft();
      await refused(OWNER, ADD_SQL, [opened.versionId, 7, 'hotel', JSON.stringify(HOTEL), BUDGETS.hotel, rid()], '40001', 'version_changed');
      await refused(OWNER, ADD_SQL, [opened.versionId, null, 'hotel', JSON.stringify(HOTEL), BUDGETS.hotel, rid()], '40001', 'version_changed');
      // B1.1 (20261119000100): visa and passport are sold now; only train stays on hold.
      await refused(OWNER, ADD_SQL, [opened.versionId, 1, 'train', '{}', '0', rid()], '22023', 'service_on_hold');
      await refusedWithHint(OWNER, ADD_SQL, [opened.versionId, 1, 'cruise', '{}', '0', rid()], /^serviceType$/);
      await refusedWithHint(OWNER, ADD_SQL, [opened.versionId, 1, 'hotel', JSON.stringify(HOTEL), '-1', rid()], /^purchaseBudgetPaise$/);
      await refusedWithHint(OWNER, ADD_SQL, [opened.versionId, 1, 'hotel', JSON.stringify(HOTEL), null, rid()], /^purchaseBudgetPaise$/);
      let rowVersion = opened.rowVersion;
      for (let i = 0; i < 20; i += 1) {
        rowVersion = (await addItem(OWNER, opened.versionId, rowVersion, 'activity', { ...ACTIVITY, name: `Synthetic activity ${i + 1}` })).rowVersion;
      }
      await refused(OWNER, ADD_SQL, [opened.versionId, rowVersion, 'activity', JSON.stringify(ACTIVITY), '0', rid()], '22023', 'too_many_items');
      expect(await owner('select count(*)::int as n from public.service_items where deal_id = $1', [DEAL])).toEqual([{ n: 20 }]);
    });
  });

  it('validates facts per service type and names the invalid fields (never a selling value under a new key)', async () => {
    await asOwner(db, async () => {
      await setSwitch('service_items_enabled', true);
      const opened = await openDraft();
      const cases: Array<[string, unknown, RegExp]> = [
        ['hotel', { ...HOTEL, sellingTotal: 5 }, /^sellingTotal$/],
        ['hotel', { ...HOTEL, city: null }, /^city$/],
        ['hotel', { ...HOTEL, checkOut: '2026-12-10' }, /^checkOut$/],
        ['hotel', { ...HOTEL, checkIn: '2026-02-30' }, /checkIn/],
        ['hotel', { ...HOTEL, rooms: 0, adults: 101 }, /^rooms,adults$/],
        ['hotel', { ...HOTEL, children: '1' }, /^children$/],
        ['hotel', { ...HOTEL, roomType: 'x'.repeat(121) }, /^roomType$/],
        ['transfer', { ...TRANSFER, route: '' }, /^route$/],
        ['transfer', { ...TRANSFER, pickupTime: '9:30' }, /^pickupTime$/],
        ['transfer', { ...TRANSFER, passengers: 0, notes: 'n'.repeat(2001) }, /^passengers,notes$/],
        ['activity', { ...ACTIVITY, name: null, participants: null }, /^name,participants$/],
        ['activity', { ...ACTIVITY, time: '24:00' }, /^time$/],
        ['flight', { ...FLIGHT_FACTS, segments: [] }, /^segments$/],
        // B1.1: an IATA code or a place name; digits are neither.
        ['flight', { ...FLIGHT_FACTS, segments: [{ from: '12', to: 'JDH', date: '2026-12-10' }] }, /^segments$/],
        ['flight', { ...FLIGHT_FACTS, segments: [{ from: 'DEL', to: 'JDH', date: '2026-12-13' }, { from: 'JDH', to: 'DEL', date: '2026-12-10' }] }, /^segments$/],
        ['flight', { ...FLIGHT_FACTS, segments: [{ from: 'DEL', to: 'JDH', date: '2026-12-10', price: 1 }] }, /^segments$/],
        ['flight', { ...FLIGHT_FACTS, cabin: 'c'.repeat(41) }, /^cabin$/],
        ['flight', null, /passengers/],
        ['flight', [1], /facts|segments/],
      ];
      for (const [type, facts, hint] of cases) {
        await refusedWithHint(OWNER, ADD_SQL, [opened.versionId, opened.rowVersion, type, facts === null ? null : JSON.stringify(facts), '0', rid()], hint);
      }
      // Optional keys sent as null (what the form sends) are accepted.
      const ok = await addItem(OWNER, opened.versionId, opened.rowVersion, 'activity', { ...ACTIVITY, time: null, notes: null });
      expect(ok.itemNo).toBe(1);
      expect(await owner('select count(*)::int as n from public.service_items where deal_id = $1', [DEAL])).toEqual([{ n: 1 }]);
    });
  });

  it('only booking editors may add; the Deal owner cannot add on another Deal', async () => {
    await asOwner(db, async () => {
      await setSwitch('service_items_enabled', true);
      const opened = await openDraft(SALES_B, DEAL2);
      for (const actor of [OWNER, PURCHASE, { userId: SALES_B.userId, aal: 'aal1' as const }]) {
        await refused(actor, ADD_SQL, [opened.versionId, 1, 'hotel', JSON.stringify(HOTEL), BUDGETS.hotel, rid()], '42501', 'not_authorized');
      }
      // The branch manager may.
      expect((await addItem(MANAGER, opened.versionId, 1, 'hotel', HOTEL)).itemNo).toBe(1);
    });
  });
});

describe('service_item_save and service_item_remove', () => {
  it('replaces facts in full, moves the hash and the row version, refuses stale versions and unknown items', async () => {
    await asOwner(db, async () => {
      await setSwitch('service_items_enabled', true);
      const opened = await openDraft();
      const added = await addItem(OWNER, opened.versionId, opened.rowVersion, 'hotel', HOTEL);
      const saved = await one<{ rowVersion: number; contentHash: string }>(OWNER, SAVE_ITEM_SQL, [
        added.itemId, opened.versionId, added.rowVersion, JSON.stringify({ ...HOTEL, roomType: null, rooms: 3 }), '5000000',
      ]);
      expect(saved.rowVersion).toBe(added.rowVersion + 1);
      expect(saved.contentHash).not.toBe(added.contentHash);
      const [f] = await owner<{ facts: Record<string, unknown>; budget: string; hash: string; expected: string }>(
        `select f.facts, f.purchase_budget_paise::text as budget, f.facts_hash as hash,
                encode(sha256(convert_to(f.facts::text || ':' || f.purchase_budget_paise::text, 'UTF8')), 'hex') as expected
         from public.service_item_facts f where f.service_item_id = $1`, [added.itemId],
      );
      expect(f!.facts).toMatchObject({ rooms: 3 });
      expect(f!.facts).not.toHaveProperty('roomType');
      expect(f!.budget).toBe('5000000');
      expect(f!.hash).toBe(f!.expected);
      await refused(OWNER, SAVE_ITEM_SQL, [added.itemId, opened.versionId, added.rowVersion, JSON.stringify(HOTEL), '1'], '40001', 'version_changed');
      await refused(OWNER, SAVE_ITEM_SQL, [rid(), opened.versionId, saved.rowVersion, JSON.stringify(HOTEL), '1'], 'P0002', 'not_found');
      await refusedWithHint(OWNER, SAVE_ITEM_SQL, [added.itemId, opened.versionId, saved.rowVersion, JSON.stringify({ ...HOTEL, margin: 1 }), '1'], /^margin$/);
      await refused(SALES_B, SAVE_ITEM_SQL, [added.itemId, opened.versionId, saved.rowVersion, JSON.stringify(HOTEL), '1'], '42501', 'not_authorized');
      const audit = await owner<{ action: string }>(`select action from public.audit_events where target_id = $1 order by id`, [added.itemId]);
      expect(audit.map((a) => a.action)).toEqual(['booking.service_item_added', 'booking.service_item_saved']);
    });
  });

  it('removes a planned item (later items keep their numbers) and locks an item that was confirmed', async () => {
    await asOwner(db, async () => {
      await setSwitch('service_items_enabled', true);
      const opened = await openDraft();
      const a = await addItem(OWNER, opened.versionId, opened.rowVersion, 'transfer', TRANSFER);
      const b = await addItem(OWNER, opened.versionId, a.rowVersion, 'activity', ACTIVITY);
      const removed = await one<{ removed: boolean; rowVersion: number; contentHash: string }>(OWNER, REMOVE_SQL, [a.itemId, opened.versionId, b.rowVersion]);
      expect(removed).toMatchObject({ removed: true, rowVersion: b.rowVersion + 1 });
      expect(await owner('select item_no from public.service_items where deal_id = $1', [DEAL])).toEqual([{ item_no: 2 }]);
      expect(await owner('select 1 from public.service_item_facts where service_item_id = $1', [a.itemId])).toEqual([]);
      await refused(OWNER, REMOVE_SQL, [a.itemId, opened.versionId, removed.rowVersion], 'P0002', 'not_found');
      // A new item takes the next number, never a freed one.
      expect((await addItem(OWNER, opened.versionId, removed.rowVersion, 'transfer', TRANSFER)).itemNo).toBe(3);
      // Nobody deletes an item directly, not even the table owner.
      await expectDbError(db, () => owner('delete from public.service_items where id = $1', [b.itemId]), { code: '42501' });
      await expectDbError(db, () => owner('update public.service_items set item_no = 9 where id = $1', [b.itemId]), { code: '42501' });
      await expectDbError(db, () => owner(`update public.service_items set state = 'cancelled' where id = $1`, [b.itemId]), { code: '42501' });
      await refused(OWNER, 'delete from public.service_items where id = $1', [b.itemId], '42501');
      await refused(OWNER, `insert into public.service_items (deal_id, legal_entity_id, branch_id, item_no, service_type, department, created_by)
        select id, legal_entity_id, branch_id, 50, 'hotel', 'purchase', owner_user_id from public.deals where id = $1`, [DEAL], '42501');
    });
  });

  it('item_locked after confirmation; facts of a confirmed version are immutable for everyone', async () => {
    await asOwner(db, async () => {
      const ready = await readyPackage(OWNER, DEAL, ['hotel', 'flight']);
      await confirm(OWNER, ready.versionId, ready.hash);
      await refused(OWNER, REMOVE_SQL, [ready.items.hotel!.itemId, ready.versionId, ready.rowVersion], '55000', 'already_confirmed');
      await expectDbError(db, () => owner(`update public.service_item_facts set purchase_budget_paise = 1 where service_item_id = $1`, [ready.items.hotel!.itemId]), { code: '42501' });
      await expectDbError(db, () => owner(`delete from public.service_item_facts where service_item_id = $1`, [ready.items.hotel!.itemId]), { code: '42501' });
      await expectDbError(db, () => owner(`delete from public.booking_version_travellers where booking_version_id = $1`, [ready.versionId]), { code: '42501' });
      // The item itself: active, so a direct delete is refused and the remove command says item_locked
      // once a later draft exists (Stage 3); here the version is confirmed, so already_confirmed answers first.
      await owner(`select set_config('tripnavigate.service_item_remove', $1, true)`, [ready.items.hotel!.itemId]);
      await expectDbError(db, () => owner('delete from public.service_items where id = $1', [ready.items.hotel!.itemId]), { code: '42501' });
    });
  });
});

describe('deal_travellers_save', () => {
  it('replaces the set, bumps the draft row version, audits a count only and validates every row', async () => {
    await asOwner(db, async () => {
      await setSwitch('service_items_enabled', true);
      const opened = await openDraft();
      const saved = await saveTravellers(OWNER, DEAL, opened.rowVersion);
      expect(saved.rowVersion).toBe(opened.rowVersion + 1);
      const again = await saveTravellers(MANAGER, DEAL, saved.rowVersion, [{ fullName: '  Synthetic Solo  ', type: 'infant', seq: 1 }]);
      expect(again.contentHash).not.toBe(saved.contentHash);
      expect(await owner('select seq, full_name, traveller_type from public.deal_travellers where deal_id = $1 order by seq', [DEAL])).toEqual([
        { seq: 1, full_name: 'Synthetic Solo', traveller_type: 'infant' },
      ]);
      await refused(OWNER, TRAVELLERS_SQL, [DEAL, saved.rowVersion, JSON.stringify(TRAVELLERS)], '40001', 'version_changed');
      const bad: unknown[] = [
        [{ fullName: '', type: 'adult', seq: 1 }],
        [{ fullName: 'Synthetic', type: 'pet', seq: 1 }],
        [{ fullName: 'Synthetic', type: 'adult', seq: 0 }],
        [{ fullName: 'Synthetic', type: 'adult', seq: 1, passport: 'x' }],
        [{ fullName: 'Synthetic A', type: 'adult', seq: 1 }, { fullName: 'Synthetic B', type: 'adult', seq: 1 }],
        Array.from({ length: 101 }, (_, i) => ({ fullName: `Synthetic ${i}`, type: 'adult', seq: i + 1 })),
        { fullName: 'Synthetic', type: 'adult', seq: 1 },
      ];
      for (const travellers of bad) {
        await refused(OWNER, TRAVELLERS_SQL, [DEAL, again.rowVersion, JSON.stringify(travellers)], '22023', 'invalid_input');
      }
      await refused(SALES_B, TRAVELLERS_SQL, [DEAL, again.rowVersion, JSON.stringify(TRAVELLERS)], '42501', 'not_authorized');
      await refused(OWNER, TRAVELLERS_SQL, [DEAL2, 1, JSON.stringify(TRAVELLERS)], '42501', 'not_authorized');
      // No draft package version on the Deal: not_found.
      await refused(SALES_B, TRAVELLERS_SQL, [DEAL2, 1, JSON.stringify(TRAVELLERS)], 'P0002', 'not_found');
      const audit = await owner<{ details: Record<string, unknown> }>(`select details from public.audit_events where action = 'booking.travellers_saved' order by id`);
      expect(audit.map((a) => a.details.travellerCount)).toEqual([4, 1]);
      expect(JSON.stringify(audit)).not.toMatch(/Synthetic (Traveller|Solo)/);
    });
  });

  it('traveller names frozen in a confirmed version cannot change (traveller_identity_locked)', async () => {
    await asOwner(db, async () => {
      const ready = await readyPackage(OWNER, DEAL, ['transfer']);
      await confirm(OWNER, ready.versionId, ready.hash);
      // Stage 3 opens later drafts; today the confirmed Deal has no draft, so the
      // command answers not_found before any name check. Simulate a later draft
      // package version as the owner to prove the lock itself.
      const [draft] = await owner<{ id: string; row_version: number }>(
        `insert into public.booking_versions (deal_id, legal_entity_id, branch_id, version_no, created_by, service_type)
         select deal_id, legal_entity_id, branch_id, 2, created_by, 'package' from public.booking_versions where id = $1
         returning id, row_version`, [ready.versionId],
      );
      await refused(OWNER, TRAVELLERS_SQL, [DEAL, draft!.row_version, JSON.stringify([{ ...TRAVELLERS[0], fullName: 'Synthetic Renamed' }, ...TRAVELLERS.slice(1)])], '55000', 'traveller_identity_locked');
      await refused(OWNER, TRAVELLERS_SQL, [DEAL, draft!.row_version, JSON.stringify(TRAVELLERS.slice(0, 3))], '55000', 'traveller_identity_locked');
      // The same names (plus one more) are fine.
      const ok = await saveTravellers(OWNER, DEAL, draft!.row_version, [...TRAVELLERS, { fullName: 'Synthetic Traveller Five', type: 'adult', seq: 5 }]);
      expect(ok.rowVersion).toBe(draft!.row_version + 1);
    });
  });
});

describe('package content hash', () => {
  it('covers items, travellers, the commercial revision and stored evidence; hotel versions keep the hotel hash', async () => {
    await asOwner(db, async () => {
      await setSwitch('service_items_enabled', true);
      const opened = await openDraft();
      const h1 = await addItem(OWNER, opened.versionId, opened.rowVersion, 'hotel', HOTEL);
      const [row] = await owner<{ content_hash: string; expected: string }>(
        `select v.content_hash,
           -- B1.1 (20261119000100) schema 2 body; schema 3 adds party, labels, estimates.
           encode(sha256(convert_to((jsonb_build_object(
             'schema', 2,
             'items', (select jsonb_agg(jsonb_build_array(i.item_no, i.service_type, f.facts, f.purchase_budget_paise, '[]'::jsonb) order by i.item_no)
                       from public.service_item_facts f join public.service_items i on i.id = f.service_item_id where f.booking_version_id = v.id),
             'travellers', '[]'::jsonb,
             'identities', '[]'::jsonb,
             'trip', jsonb_build_array(null, null, null, null),
             'contacts', null,
             'commercial_revision', v.commercial_revision,
             'stored_evidence', '[]'::jsonb)
             -- Booking form (20261124000100): new drafts use hash_schema 3.
             || jsonb_build_object('schema', 3, 'party', jsonb_build_array(null, null, null), 'contactLabels', null,
                  'estimates', '[]'::jsonb)
             -- Voice-note batch (20261128000110): new drafts use hash_schema 4 (special request codes).
             || jsonb_build_object('schema', 4, 'specialRequests', '[]'::jsonb))::text, 'UTF8')), 'hex') as expected
         from public.booking_versions v where v.id = $1`, [opened.versionId],
      );
      expect(row!.content_hash).toBe(row!.expected);
      expect(h1.contentHash).toBe(row!.expected);
      const t = await saveTravellers(OWNER, DEAL, h1.rowVersion);
      expect(t.contentHash).not.toBe(h1.contentHash);
      const s = await h.saveSelling(OWNER, opened.versionId, t.rowVersion, SELLING);
      expect(s.contentHash).not.toBe(t.contentHash);
      await h.storeEvidence(OWNER, opened.versionId);
      const after = await readiness(OWNER, opened.versionId);
      expect(after.contentHash).not.toBe(s.contentHash);
      // Confirming against a stale hash is refused.
      await refused(OWNER, 'select public.booking_confirm($1, $2) as r', [opened.versionId, s.contentHash], '40001', 'version_changed');
      // The hotel hash function still ignores items (legacy versions are untouched).
      const [hotel] = await owner<{ same: boolean }>(
        `select authz.booking_hash(null, null, null, null, null, null, null, null, null, null, null, null, v.commercial_revision, '[]'::jsonb)
                = authz.booking_hash(null, null, null, null, null, null, null, null, null, null, null, null, v.commercial_revision, '[]'::jsonb) as same
         from public.booking_versions v where v.id = $1`, [opened.versionId],
      );
      expect(hotel).toEqual({ same: true });
    });
  });
});
