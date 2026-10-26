import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  BookingFacts,
  BookingReadiness,
  ClaimTaskResult,
  ConfirmBookingResult,
  OpenDraftResult,
  SaveDraftResult,
} from '@/modules/fulfilment/contracts';
import {
  type Actor,
  FIXTURE_DEALS as D,
  FIXTURE_USERS as U,
  type TestDb,
  asOwner,
  createTestDb,
  expectDbError,
  resetActor,
  setActor,
} from '../helpers/db';

/**
 * Phase 3 booking -> Purchase task: database contract
 * (docs/implementation/history/phase-3/contract.md sections 3-7, acceptance P3-01..P3-13).
 *
 * Every scenario runs in ONE rolled-back transaction as the database owner and
 * switches to the impersonated request (staff JWT, anon, service_role) only for
 * the statement under test, exactly as PostgREST does.
 *
 * Concurrency (P3-04): PGlite is one in-process connection, so two confirmations
 * cannot run at the same time here. These tests prove the sequential half (the
 * loser of the row lock sees 'confirmed' and gets 'existing'; the unique task
 * key and outbox key refuse a second row even for the table owner). True
 * parallel confirmations run against real Postgres in
 * tests/supabase/booking.real.test.ts.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const OWNER: Actor = { userId: U.salesDelhiA }; // owns SYN-DEL-001 (Delhi)
const ASSIGNEE: Actor = { userId: U.salesDelhiB }; // Sales, made a 'sales' assignee on SYN-DEL-001 per test
const MANAGER: Actor = { userId: U.managerDelhi }; // manager, Delhi branch, deal.read grant on Delhi
const OTHER_MANAGER: Actor = { userId: U.managerAhmedabad }; // manager, Ahmedabad branch
const PURCHASE: Actor = { userId: U.purchaseJodhpur }; // purchase, assigned to SYN-DEL-001
const ADMIN: Actor = { userId: U.adminJodhpur };
const ANON: Actor = { userId: null };
const SVC: Actor = { userId: null, role: 'service_role' };

const FACTS: BookingFacts = {
  hotelName: 'Synthetic Hotel (fixture)',
  city: 'Synthetic City',
  checkIn: '2026-12-10',
  checkOut: '2026-12-13',
  rooms: 2,
  roomType: 'Synthetic Deluxe',
  mealPlan: 'Breakfast',
  adults: 3,
  children: 1,
  inclusions: 'Synthetic airport pickup',
  specialRequests: null,
  purchaseBudgetPaise: '4500000',
};
const SELLING = '9876543';
const SHA = 'a'.repeat(64);

const BOOKING_TABLES = [
  'booking_settings',
  'booking_versions',
  'booking_version_commercials',
  'booking_evidence',
  'fulfilment_tasks',
  'outbox_events',
];

/** One statement as `actor`, then back to the owner. On error the caller's savepoint restores the role. */
async function run<T = Record<string, unknown>>(actor: Actor, sql: string, params: unknown[] = []): Promise<T[]> {
  await setActor(db, actor);
  const rows = await db.query<T>(sql, params);
  await resetActor(db);
  return rows;
}
async function one<T>(actor: Actor, sql: string, params: unknown[] = []): Promise<T> {
  return (await run<{ r: T }>(actor, sql, params))[0]!.r;
}
async function refused(actor: Actor, sql: string, params: unknown[], code: string, token?: string): Promise<void> {
  await expectDbError(db, () => run(actor, sql, params), {
    code,
    ...(token ? { message: new RegExp(`^${token}$`) } : {}),
  });
}

const openDraft = (actor: Actor, deal: string = D.del001) =>
  one<OpenDraftResult>(actor, 'select public.booking_open_draft($1) as r', [deal]);
const OPEN_SQL = 'select public.booking_open_draft($1) as r';
const SAVE_SQL = 'select public.booking_save_draft($1, $2, $3::jsonb, $4::bigint, $5) as r';
/** OMIT = the form had no selling field (p_selling_total_provided false). */
const OMIT = Symbol('omit');
const saveDraft = (
  actor: Actor,
  versionId: string,
  rowVersion: number,
  facts: unknown = FACTS,
  selling: string | null | typeof OMIT = SELLING,
) =>
  one<SaveDraftResult>(actor, SAVE_SQL, [
    versionId,
    rowVersion,
    JSON.stringify(facts),
    selling === OMIT ? null : selling,
    selling !== OMIT,
  ]);
const BEGIN_SQL = 'select public.booking_begin_evidence($1, $2, $3, $4, $5, $6) as r';
const beginEvidence = (
  actor: Actor,
  versionId: string,
  over: Partial<{ kind: string; fileName: string; mime: string; size: number; sha: string }> = {},
) =>
  one<{ evidenceId: string; objectPath: string }>(actor, BEGIN_SQL, [
    versionId,
    over.kind ?? 'acceptance_message',
    over.fileName ?? 'acceptance.pdf',
    over.mime ?? 'application/pdf',
    over.size ?? 2048,
    over.sha ?? SHA,
  ]);
const finishEvidence = (actor: Actor, evidenceId: string, ok: boolean) =>
  one<{ evidenceId: string; status: string }>(actor, 'select public.booking_finish_evidence($1, $2) as r', [evidenceId, ok]);
const readiness = (actor: Actor, versionId: string) =>
  one<BookingReadiness>(actor, 'select public.booking_readiness($1) as r', [versionId]);
const CONFIRM_SQL = 'select public.booking_confirm($1, $2) as r';
// Hotel confirmations always create the Purchase task, so taskId is never null here (B1.1 widened the type).
const confirm = (actor: Actor, versionId: string, hash: string) =>
  one<ConfirmBookingResult & { taskId: string }>(actor, CONFIRM_SQL, [versionId, hash]);
const claim = (actor: Actor, taskId: string) =>
  one<ClaimTaskResult>(actor, 'select public.purchase_task_claim($1) as r', [taskId]);

/** Owner-side setup: make Sales Delhi B an active 'sales' assignee (non-owner) of a deal. */
async function addSalesAssignee(deal: string = D.del001, user: string = U.salesDelhiB): Promise<void> {
  await db.query(
    `insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, assigned_by)
     select id, legal_entity_id, $2, 'sales', $3 from public.deals where id = $1`,
    [deal, user, U.adminJodhpur],
  );
}

/** As the Storage server would after a successful upload (owner privileges). */
async function putObject(objectPath: string, size = 2048): Promise<void> {
  await db.query(
    `insert into storage.objects (bucket_id, name, metadata) values ('booking-evidence', $1, jsonb_build_object('size', $2::bigint))`,
    [objectPath, size],
  );
}

/** Begin + upload + finish(true). */
async function storeEvidence(actor: Actor, versionId: string, over: Parameters<typeof beginEvidence>[2] = {}) {
  const ev = await beginEvidence(actor, versionId, over);
  await putObject(ev.objectPath, over.size ?? 2048);
  expect(await finishEvidence(actor, ev.evidenceId, true)).toEqual({ evidenceId: ev.evidenceId, status: 'stored' });
  return ev;
}

/** Draft with complete facts, selling total and one stored proof file. Returns the hash after storing. */
async function readyDraft(actor: Actor = OWNER, deal: string = D.del001) {
  const opened = await openDraft(actor, deal);
  await saveDraft(actor, opened.versionId, opened.rowVersion);
  const ev = await storeEvidence(actor, opened.versionId);
  const { contentHash } = await readiness(actor, opened.versionId);
  return { versionId: opened.versionId, hash: contentHash, evidenceId: ev.evidenceId };
}

const countTasks = async (versionId: string) =>
  Number(
    (await db.query<{ n: string }>('select count(*)::text as n from public.fulfilment_tasks where booking_version_id = $1', [versionId]))[0]!.n,
  );

/** Test-only Bitrix-sourced (non-synthetic) deal in Delhi owned by Sales Delhi A. Rolled back with the test. */
async function insertRealDeal(verifiedHoursAgo: number): Promise<string> {
  const [inbox] = await db.query<{ id: string }>(
    `insert into public.integration_inbox (portal_member_id, event_type, source_deal_id, source_ts, dedupe_key, status, processed_at)
     values ('SYNTHETIC_MEMBER_0001', 'ONCRMDEALADD', 990001, 1, repeat('b', 64), 'processed', now()) returning id`,
  );
  const [deal] = await db.query<{ id: string }>(
    `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id, is_synthetic,
       source_system, source_portal, source_deal_id, source_stage_id, source_category_id, source_created_at,
       source_modified_at, last_synced_at, last_verified_at, intake_inbox_id, source_assigned_by_id)
     select b.legal_entity_id, b.id, 'BX-990001', 'Synthetic test-only imported deal', $1, false,
       'bitrix', 'SYNTHETIC_MEMBER_0001', 990001, 'C7:NEW', 7, now() - interval '3 days', now() - interval '2 days',
       now(), now() - make_interval(hours => $2), $3, 101
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
     where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL'
     returning id`,
    [U.salesDelhiA, verifiedHoursAgo, inbox!.id],
  );
  return deal!.id;
}

// ---------------------------------------------------------------------------

describe('schema, catalogue and storage', () => {
  it('creates the booking tables with RLS, the restrictive session policy and no anon grant', async () => {
    await asOwner(db, async () => {
      const rows = await db.query<{ relname: string; rls: boolean; policies: string[] }>(
        `select c.relname, c.relrowsecurity as rls,
                coalesce(array_agg(p.policyname::text order by p.policyname) filter (where p.policyname is not null), '{}') as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         left join pg_policies p on p.schemaname = 'public' and p.tablename = c.relname
         where n.nspname = 'public' and c.relname = any($1::text[])
         group by c.relname, c.relrowsecurity order by c.relname`,
        [BOOKING_TABLES],
      );
      expect(rows).toHaveLength(BOOKING_TABLES.length);
      for (const r of rows) {
        expect(r.rls, r.relname).toBe(true);
        expect(r.policies, r.relname).toContain('require_valid_session');
      }
      expect(rows.find((r) => r.relname === 'outbox_events')!.policies).toEqual(['require_valid_session']);
      const privs = await db.query<{ t: string; anon: boolean; auth_select: boolean; auth_write: boolean; svc_write: boolean }>(
        `select t,
           has_table_privilege('anon', 'public.' || t, 'select') as anon,
           has_table_privilege('authenticated', 'public.' || t, 'select') as auth_select,
           has_table_privilege('authenticated', 'public.' || t, 'insert,update,delete') as auth_write,
           has_table_privilege('service_role', 'public.' || t, 'insert,update,delete') as svc_write
         from unnest($1::text[]) t`,
        [BOOKING_TABLES],
      );
      for (const p of privs) {
        expect(p.anon, p.t).toBe(false);
        expect(p.auth_write, p.t).toBe(false);
        expect(p.svc_write, p.t).toBe(false);
        // booking_versions has a column grant only (commercial_revision excluded, A4 H1).
        // fulfilment_tasks has a column grant only since Phase 4 (supplier reference hidden from Sales, P4-D6).
        expect(p.auth_select, p.t).toBe(p.t !== 'outbox_events' && p.t !== 'booking_versions' && p.t !== 'fulfilment_tasks');
      }
      const [cols] = await db.query<{ any: boolean; rev: boolean; svc_rev: boolean; hash: boolean }>(
        `select has_any_column_privilege('authenticated', 'public.booking_versions', 'select') as any,
                has_column_privilege('authenticated', 'public.booking_versions', 'commercial_revision', 'select') as rev,
                has_column_privilege('service_role', 'public.booking_versions', 'commercial_revision', 'select') as svc_rev,
                has_column_privilege('authenticated', 'public.booking_versions', 'content_hash', 'select') as hash`,
      );
      expect(cols).toEqual({ any: true, rev: false, svc_rev: false, hash: true });
    });
  });

  it('fulfilment_tasks and outbox_events carry no commercial columns', async () => {
    const cols = await asOwner(db, () =>
      db.query<{ table_name: string; column_name: string }>(
        `select table_name, column_name from information_schema.columns
         where table_schema = 'public' and table_name in ('fulfilment_tasks', 'outbox_events')`,
      ),
    );
    expect(cols.length).toBeGreaterThan(10);
    expect(cols.filter((c) => /sell|margin|price|amount|paise|budget/.test(c.column_name))).toEqual([]);
  });

  it('booking_settings is a single row, gate off by default, staff-readable, never API-writable', async () => {
    await asOwner(db, async () => {
      expect(await db.query('select id, real_booking_enabled, evidence_max_bytes from public.booking_settings')).toEqual([
        { id: true, real_booking_enabled: false, evidence_max_bytes: 4194304 },
      ]);
      await expectDbError(db, () => db.query('insert into public.booking_settings (id) values (false)'), { code: '23514' });
      expect(await run(OWNER, 'select real_booking_enabled from public.booking_settings')).toEqual([
        { real_booking_enabled: false },
      ]);
      await refused(ADMIN, 'update public.booking_settings set real_booking_enabled = true', [], '42501');
      await refused(SVC, 'update public.booking_settings set real_booking_enabled = true', [], '42501');
    });
  });

  it('adds role-derived, non-grantable permissions with a policy_status', async () => {
    const rows = await asOwner(db, () =>
      db.query<{ role_code: string; permission_code: string; scope: string; policy_status: string; is_grantable: boolean }>(
        `select rp.role_code, rp.permission_code, rp.scope, rp.policy_status, p.is_grantable
         from public.role_permissions rp join public.permissions p on p.code = rp.permission_code
         where rp.permission_code in ('booking.manage_draft', 'booking.confirm', 'purchase_task.read')
         order by rp.permission_code, rp.role_code`,
      ),
    );
    expect(rows).toEqual([
      { role_code: 'manager', permission_code: 'booking.confirm', scope: 'own', policy_status: 'confirmed', is_grantable: false },
      { role_code: 'sales', permission_code: 'booking.confirm', scope: 'own', policy_status: 'confirmed', is_grantable: false },
      { role_code: 'manager', permission_code: 'booking.manage_draft', scope: 'own', policy_status: 'confirmed', is_grantable: false },
      { role_code: 'sales', permission_code: 'booking.manage_draft', scope: 'own', policy_status: 'confirmed', is_grantable: false },
      { role_code: 'purchase', permission_code: 'purchase_task.read', scope: 'entity', policy_status: 'confirmed', is_grantable: false },
    ]);
  });

  it('creates the private booking-evidence bucket and no storage.objects policy', async () => {
    await asOwner(db, async () => {
      expect(
        await db.query(`select public, file_size_limit::int as limit, allowed_mime_types from storage.buckets where id = 'booking-evidence'`),
      ).toEqual([
        { public: false, limit: 4194304, allowed_mime_types: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] },
      ]);
      expect(
        await db.query(`select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects'`),
      ).toEqual([]);
    });
  });
});

describe('drafts', () => {
  it('opens one draft per deal (idempotent) and audits without amounts', async () => {
    await asOwner(db, async () => {
      const first = await openDraft(OWNER);
      expect(first).toMatchObject({ versionNo: 1, rowVersion: 1, created: true });
      expect(await openDraft(OWNER)).toEqual({ ...first, created: false });
      const saved = await saveDraft(OWNER, first.versionId, 1);
      expect(saved).toMatchObject({ versionId: first.versionId, rowVersion: 2 });
      expect(saved.contentHash).toMatch(/^[0-9a-f]{64}$/);
      const audit = await db.query<{ action: string; details: unknown; actor_user_id: string }>(
        `select action, details, actor_user_id from public.audit_events where target_id = $1 order by id`,
        [first.versionId],
      );
      expect(audit.map((a) => a.action)).toEqual(['booking.draft_opened', 'booking.draft_saved']);
      expect(audit.every((a) => a.actor_user_id === U.salesDelhiA)).toBe(true);
      expect(JSON.stringify(audit)).not.toMatch(new RegExp(`${SELLING}|4500000|Synthetic Hotel`));
    });
  });

  it('stores trimmed facts and the canonical content hash (contract 3.1 / A4 H1)', async () => {
    await asOwner(db, async () => {
      const { versionId, rowVersion } = await openDraft(OWNER);
      const saved = await saveDraft(OWNER, versionId, rowVersion, { ...FACTS, hotelName: '  Synthetic Hotel (fixture)  ', specialRequests: '   ' });
      const ev = await storeEvidence(OWNER, versionId);
      const [row] = await db.query<{ hotel_name: string; special_requests: string | null; content_hash: string; expected: string }>(
        `select v.hotel_name, v.special_requests, v.content_hash,
           encode(sha256(convert_to(jsonb_build_object(
             'hotel_name', v.hotel_name, 'city', v.city, 'check_in', v.check_in, 'check_out', v.check_out,
             'rooms', v.rooms, 'room_type', v.room_type, 'meal_plan', v.meal_plan, 'adults', v.adults,
             'children', v.children, 'inclusions', v.inclusions, 'special_requests', v.special_requests,
             'purchase_budget_paise', v.purchase_budget_paise, 'commercial_revision', v.commercial_revision,
             'stored_evidence', jsonb_build_array(jsonb_build_array($2::uuid, $3::text))
           )::text, 'UTF8')), 'hex') as expected
         from public.booking_versions v where v.id = $1`,
        [versionId, ev.evidenceId, SHA],
      );
      expect(row).toMatchObject({ hotel_name: 'Synthetic Hotel (fixture)', special_requests: null });
      expect(row!.content_hash).toBe(row!.expected);
      expect(saved.contentHash).not.toBe(row!.expected); // storing evidence changed it
      expect((await readiness(OWNER, versionId)).contentHash).toBe(row!.expected);
    });
  });

  it('A4 H1: the hash moves with the selling total but cannot be reproduced from visible fields', async () => {
    await asOwner(db, async () => {
      const { versionId, rowVersion } = await openDraft(OWNER);
      const s1 = await saveDraft(OWNER, versionId, rowVersion, FACTS, '100');
      const s2 = await saveDraft(OWNER, versionId, s1.rowVersion, FACTS, '200');
      const s3 = await saveDraft(OWNER, versionId, s2.rowVersion, FACTS, '100');
      expect(s2.contentHash).not.toBe(s1.contentHash);
      // Back to the same amount: a fresh revision, so the hash is NOT a function of the amount.
      expect(s3.contentHash).not.toBe(s1.contentHash);
      // Saving the same amount again keeps the revision (no spurious version_changed).
      const s4 = await saveDraft(OWNER, versionId, s3.rowVersion, FACTS, '100');
      expect(s4.contentHash).toBe(s3.contentHash);

      // A non-commercial reader (Manager Delhi) sees facts and the hash but cannot read the revision.
      await refused(MANAGER, 'select commercial_revision from public.booking_versions', [], '42501');
      await refused(MANAGER, 'select * from public.booking_versions', [], '42501');
      const panel = await one<{ version: { facts: BookingFacts; contentHash: string } }>(MANAGER, 'select public.booking_panel($1) as r', [D.del001]);
      const [rev] = await db.query<{ r: string }>('select commercial_revision::text as r from public.booking_versions where id = $1', [versionId]);
      expect(JSON.stringify(panel)).not.toContain(rev!.r);
      // Brute force over guessed selling totals with the visible facts (old and new canonical forms) never matches.
      const [guess] = await db.query<{ hits: number }>(
        `with v as (select * from public.booking_versions where id = $1)
         select count(*)::int as hits
         from v, generate_series(0, 300) g
         where encode(sha256(convert_to(jsonb_build_object(
                 'hotel_name', v.hotel_name, 'city', v.city, 'check_in', v.check_in, 'check_out', v.check_out,
                 'rooms', v.rooms, 'room_type', v.room_type, 'meal_plan', v.meal_plan, 'adults', v.adults,
                 'children', v.children, 'inclusions', v.inclusions, 'special_requests', v.special_requests,
                 'purchase_budget_paise', v.purchase_budget_paise, 'selling_total_paise', g)::text, 'UTF8')), 'hex') = $2
            or authz.booking_hash(v.hotel_name, v.city, v.check_in, v.check_out, v.rooms, v.room_type, v.meal_plan,
                 v.adults, v.children, v.inclusions, v.special_requests, v.purchase_budget_paise, null, '[]'::jsonb) = $2`,
        [versionId, panel.version.contentHash],
      );
      expect(guess!.hits).toBe(0);
      expect(panel.version.contentHash).toBe(s4.contentHash);
    });
  });

  it('A4 H1 / L1: the hash changes when the stored evidence set changes', async () => {
    await asOwner(db, async () => {
      const { versionId, rowVersion } = await openDraft(OWNER);
      const saved = await saveDraft(OWNER, versionId, rowVersion);
      const pending = await beginEvidence(OWNER, versionId);
      // A pending upload is not part of the stored set.
      expect((await readiness(OWNER, versionId)).contentHash).toBe(saved.contentHash);
      await putObject(pending.objectPath);
      await finishEvidence(OWNER, pending.evidenceId, true);
      const withOne = (await readiness(OWNER, versionId)).contentHash;
      expect(withOne).not.toBe(saved.contentHash);
      const second = await storeEvidence(OWNER, versionId, { kind: 'bill', sha: 'd'.repeat(64) });
      const withTwo = (await readiness(OWNER, versionId)).contentHash;
      expect(withTwo).not.toBe(withOne);
      await one(OWNER, 'select public.booking_remove_evidence($1) as r', [second.evidenceId]);
      expect((await readiness(OWNER, versionId)).contentHash).toBe(withOne);
      // Confirming against the pre-evidence hash is refused.
      await refused(OWNER, CONFIRM_SQL, [versionId, saved.contentHash], '40001', 'version_changed');
    });
  });

  it('refuses stale row versions, unknown/missing keys and invalid values', async () => {
    await asOwner(db, async () => {
      const { versionId } = await openDraft(OWNER);
      await refused(OWNER, SAVE_SQL, [versionId, 7, JSON.stringify(FACTS), SELLING, true], '40001', 'version_changed');
      const bad: unknown[] = [
        { ...FACTS, price: 1 },
        Object.fromEntries(Object.entries(FACTS).filter(([k]) => k !== 'city')),
        { ...FACTS, rooms: 0 },
        { ...FACTS, rooms: 51 },
        { ...FACTS, rooms: 1.5 },
        { ...FACTS, rooms: '2' },
        { ...FACTS, adults: 0 },
        { ...FACTS, children: -1 },
        { ...FACTS, checkIn: '2026-02-30' },
        { ...FACTS, checkIn: '10/12/2026' },
        { ...FACTS, hotelName: 'x'.repeat(201) },
        { ...FACTS, mealPlan: 'x'.repeat(61) },
        { ...FACTS, hotelName: 'line\nbreak' },
        { ...FACTS, purchaseBudgetPaise: '-1' },
        { ...FACTS, purchaseBudgetPaise: '12.5' },
        [FACTS],
      ];
      for (const facts of bad) {
        await refused(OWNER, SAVE_SQL, [versionId, 1, JSON.stringify(facts), SELLING, true], '22023', 'invalid_input');
      }
      await refused(OWNER, SAVE_SQL, [versionId, 1, JSON.stringify(FACTS), '-5', true], '22023', 'invalid_input');
      // Multi-line text is fine where the form allows it; nulls are fine while draft.
      const ok = await saveDraft(OWNER, versionId, 1, { ...FACTS, inclusions: 'Line one\nLine two', rooms: null }, null);
      expect(ok.rowVersion).toBe(2);
      expect(
        await db.query('select version_id from public.booking_version_commercials where version_id = $1', [versionId]),
      ).toEqual([]);
    });
  });

  it('A4 M3: selling total is untouched unless provided; providing it needs commercial scope', async () => {
    await asOwner(db, async () => {
      const { versionId, rowVersion } = await openDraft(OWNER);
      const ownerSaved = await saveDraft(OWNER, versionId, rowVersion, FACTS, SELLING);
      expect(await one(MANAGER, 'select authz.can_read_deal_commercial($1) as r', [D.del001])).toBe(false);
      // Not provided: the commercial row and the hash stay as they are.
      const mgr = await saveDraft(MANAGER, versionId, ownerSaved.rowVersion, FACTS, OMIT);
      expect(mgr.contentHash).toBe(ownerSaved.contentHash);
      const sellingOf = () =>
        db.query('select selling_total_paise::text as v from public.booking_version_commercials where version_id = $1', [versionId]);
      expect(await sellingOf()).toEqual([{ v: SELLING }]);
      // Provided by a caller without commercial scope: refused, for a value and for a clear.
      await refused(MANAGER, SAVE_SQL, [versionId, mgr.rowVersion, JSON.stringify(FACTS), '1', true], '42501', 'not_authorized');
      await refused(MANAGER, SAVE_SQL, [versionId, mgr.rowVersion, JSON.stringify(FACTS), null, true], '42501', 'not_authorized');
      await refused(OWNER, SAVE_SQL, [versionId, mgr.rowVersion, JSON.stringify(FACTS), SELLING, null], '22023', 'invalid_input');
      expect(await sellingOf()).toEqual([{ v: SELLING }]);
      // The owner's "not provided" also leaves it; "provided null" clears it.
      const kept = await saveDraft(OWNER, versionId, mgr.rowVersion, FACTS, OMIT);
      expect(await sellingOf()).toEqual([{ v: SELLING }]);
      const cleared = await saveDraft(OWNER, versionId, kept.rowVersion, FACTS, null);
      expect(await sellingOf()).toEqual([]);
      expect(cleared.contentHash).not.toBe(kept.contentHash);
      // Only one signature exists (no 4-argument overload).
      expect(
        await db.query(`select pg_get_function_identity_arguments(oid) as args from pg_proc where proname = 'booking_save_draft'`),
      ).toEqual([{ args: 'p_version_id uuid, p_expected_row_version integer, p_facts jsonb, p_selling_total_paise bigint, p_selling_total_provided boolean' }]);
    });
  });

  it('A4 L4: readers without commercial scope see missing_selling_total_ask_owner', async () => {
    await asOwner(db, async () => {
      const { versionId, rowVersion } = await openDraft(OWNER);
      await saveDraft(OWNER, versionId, rowVersion, FACTS, null);
      await storeEvidence(OWNER, versionId);
      expect((await readiness(OWNER, versionId)).issues).toEqual(['missing_selling_total']);
      const r = await readiness(MANAGER, versionId);
      expect(r.issues).toEqual(['missing_selling_total_ask_owner']);
      const panel = await one<{ readiness: BookingReadiness }>(MANAGER, 'select public.booking_panel($1) as r', [D.del001]);
      expect(panel.readiness.issues).toEqual(['missing_selling_total_ask_owner']);
      // The confirm gate still uses the real check.
      await refused(MANAGER, CONFIRM_SQL, [versionId, r.contentHash], '55000', 'not_ready');
    });
  });

  it('open_draft refuses while the environment is unset', async () => {
    await asOwner(db, async () => {
      await db.query(`update public.deployment_settings set environment = 'unset' where id`);
      await refused(OWNER, OPEN_SQL, [D.del001], '55000', 'environment_unset');
    });
  });
});

describe('evidence', () => {
  it('A4 H2: finish(true) without the Storage object (or with the wrong size) marks the row failed', async () => {
    await asOwner(db, async () => {
      const { versionId, rowVersion } = await openDraft(OWNER);
      await saveDraft(OWNER, versionId, rowVersion);
      const missing = await beginEvidence(OWNER, versionId);
      expect(await finishEvidence(OWNER, missing.evidenceId, true)).toEqual({ evidenceId: missing.evidenceId, status: 'failed' });
      expect((await readiness(OWNER, versionId)).issues).toEqual(['missing_acceptance_proof']);
      // A later finish(true) does not resurrect it, even once an object appears.
      await putObject(missing.objectPath);
      expect(await finishEvidence(OWNER, missing.evidenceId, true)).toEqual({ evidenceId: missing.evidenceId, status: 'failed' });

      const wrongSize = await beginEvidence(OWNER, versionId, { size: 2048 });
      await putObject(wrongSize.objectPath, 2047);
      expect((await finishEvidence(OWNER, wrongSize.evidenceId, true)).status).toBe('failed');
      // Another bucket or another path does not count.
      const elsewhere = await beginEvidence(OWNER, versionId);
      await db.query(`insert into storage.buckets (id, name, public) values ('other', 'other', false)`);
      await db.query(`insert into storage.objects (bucket_id, name, metadata) values ('other', $1, '{"size": 2048}')`, [elsewhere.objectPath]);
      await putObject(`${elsewhere.objectPath}-x`);
      expect((await finishEvidence(OWNER, elsewhere.evidenceId, true)).status).toBe('failed');

      expect(
        await db.query(`select id from public.booking_evidence where version_id = $1 and status = 'stored'`, [versionId]),
      ).toEqual([]);
      const audit = await db.query<{ details: { objectMissing: boolean } }>(
        `select details from public.audit_events where target_id = $1 and action = 'booking.evidence_failed'`,
        [missing.evidenceId],
      );
      expect(audit.map((a) => a.details.objectMissing)).toEqual([true]);
    });
  });

  it('A4 M2: deal readers who cannot edit or confirm (Visa assignee, Accounts reader) see no evidence', async () => {
    await asOwner(db, async () => {
      const { versionId, evidenceId } = await readyDraft();
      await db.query(
        `insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, assigned_by)
         select id, legal_entity_id, $2, 'visa', $3 from public.deals where id = $1`,
        [D.del001, U.visaJodhpur, U.adminJodhpur],
      );
      for (const actor of [{ userId: U.visaJodhpur }, { userId: U.accountsJodhpur }] as Actor[]) {
        expect(await one(actor, 'select authz.can_read_deal($1) as r', [D.del001])).toBe(true);
        expect(await run(actor, 'select id from public.booking_evidence')).toEqual([]);
        await refused(actor, 'select public.booking_authorize_evidence_download($1) as r', [evidenceId], '42501', 'not_authorized');
        const panel = await one<{ evidence: unknown[]; version: { versionId: string }; canEdit: boolean; canConfirm: boolean }>(
          actor,
          'select public.booking_panel($1) as r',
          [D.del001],
        );
        expect(panel).toMatchObject({ evidence: [], evidenceVisible: false, canEdit: false, canConfirm: false, version: { versionId } });
        // They still read the booking facts row (non-Purchase deal readers).
        expect(await run(actor, 'select id from public.booking_versions')).toEqual([{ id: versionId }]);
      }
      // Owner and branch manager still list it.
      expect(await run(OWNER, 'select id from public.booking_evidence')).toEqual([{ id: evidenceId }]);
      expect(await run(MANAGER, 'select id from public.booking_evidence')).toEqual([{ id: evidenceId }]);
    });
  });

  it('server-generates the object path, sanitizes the name and finishes only for the uploader', async () => {
    await asOwner(db, async () => {
      const { versionId } = await openDraft(OWNER);
      const ev = await beginEvidence(OWNER, versionId, { fileName: '../../etc/pass wd<script>.pdf', sha: 'A'.repeat(64) });
      const [row] = await db.query<{ legal_entity_id: string; file_name: string; status: string; sha256: string }>(
        'select legal_entity_id, file_name, status, sha256 from public.booking_evidence where id = $1',
        [ev.evidenceId],
      );
      expect(ev.objectPath).toBe(`${row!.legal_entity_id}/${D.del001}/${versionId}/${ev.evidenceId}`);
      expect(row).toMatchObject({ file_name: '.._.._etc_pass wd_script_.pdf', status: 'pending_upload', sha256: 'a'.repeat(64) });

      await addSalesAssignee();
      await refused(ASSIGNEE, 'select public.booking_finish_evidence($1, true) as r', [ev.evidenceId], '42501', 'not_authorized');
      await refused(PURCHASE, 'select public.booking_finish_evidence($1, true) as r', [ev.evidenceId], '42501', 'not_authorized');
      await putObject(ev.objectPath);
      expect(await finishEvidence(OWNER, ev.evidenceId, true)).toEqual({ evidenceId: ev.evidenceId, status: 'stored' });
      // Idempotent repeat; contradicting result refused.
      expect(await finishEvidence(OWNER, ev.evidenceId, true)).toEqual({ evidenceId: ev.evidenceId, status: 'stored' });
      await refused(OWNER, 'select public.booking_finish_evidence($1, false) as r', [ev.evidenceId], '22023', 'invalid_input');
    });
  });

  it('P3-14 (database half): bad mime/size/hash/kind are rejected; a failed upload leaves no stored row', async () => {
    await asOwner(db, async () => {
      const { versionId } = await openDraft(OWNER);
      const cases: [Partial<{ kind: string; fileName: string; mime: string; size: number; sha: string }>, string][] = [
        [{ mime: 'text/html' }, 'evidence_rejected'],
        [{ mime: 'image/svg+xml' }, 'evidence_rejected'],
        [{ size: 0 }, 'evidence_rejected'],
        [{ size: 4194305 }, 'evidence_rejected'],
        [{ sha: 'xyz' }, 'evidence_rejected'],
        [{ fileName: '   ' }, 'evidence_rejected'],
        [{ fileName: '..' }, 'evidence_rejected'],
        [{ kind: 'passport' }, 'invalid_input'],
      ];
      for (const [over, token] of cases) {
        await refused(
          OWNER,
          BEGIN_SQL,
          [versionId, over.kind ?? 'bill', over.fileName ?? 'bill.pdf', over.mime ?? 'application/pdf', over.size ?? 10, over.sha ?? SHA],
          '22023',
          token,
        );
      }
      // A lower per-deployment limit applies.
      await db.query('update public.booking_settings set evidence_max_bytes = 1000 where id');
      await refused(OWNER, BEGIN_SQL, [versionId, 'bill', 'bill.pdf', 'application/pdf', 1001, SHA], '22023', 'evidence_rejected');
      await db.query('update public.booking_settings set evidence_max_bytes = 4194304 where id');

      const failed = await beginEvidence(OWNER, versionId);
      expect(await finishEvidence(OWNER, failed.evidenceId, false)).toMatchObject({ status: 'failed' });
      expect(
        await db.query(`select id from public.booking_evidence where version_id = $1 and status = 'stored'`, [versionId]),
      ).toEqual([]);
      // Download is only for stored files.
      await refused(OWNER, 'select public.booking_authorize_evidence_download($1) as r', [failed.evidenceId], 'P0002', 'not_found');
      expect((await readiness(OWNER, versionId)).issues).toContain('missing_acceptance_proof');
    });
  });

  it('allows at most 10 non-removed evidence rows per version', async () => {
    await asOwner(db, async () => {
      const { versionId } = await openDraft(OWNER);
      const ids: string[] = [];
      for (let i = 0; i < 10; i += 1) ids.push((await beginEvidence(OWNER, versionId)).evidenceId);
      await refused(OWNER, BEGIN_SQL, [versionId, 'bill', 'b.pdf', 'application/pdf', 10, SHA], '22023', 'evidence_rejected');
      expect(await one(OWNER, 'select public.booking_remove_evidence($1) as r', [ids[0]])).toEqual({ evidenceId: ids[0], status: 'removed' });
      expect((await beginEvidence(OWNER, versionId)).evidenceId).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  it('a pending upload blocks readiness until finished or removed', async () => {
    await asOwner(db, async () => {
      const { versionId, evidenceId } = await readyDraft();
      expect((await readiness(OWNER, versionId)).ready).toBe(true);
      const pending = await beginEvidence(OWNER, versionId, { kind: 'bill' });
      expect((await readiness(OWNER, versionId)).issues).toEqual(['evidence_upload_incomplete']);
      await one(OWNER, 'select public.booking_remove_evidence($1) as r', [pending.evidenceId]);
      expect((await readiness(OWNER, versionId)).ready).toBe(true);
      await one(OWNER, 'select public.booking_remove_evidence($1) as r', [evidenceId]);
      expect((await readiness(OWNER, versionId)).issues).toEqual(['missing_acceptance_proof']);
    });
  });

  it('download authorization: deal readers who are not Purchase; audited booking.evidence_viewed', async () => {
    await asOwner(db, async () => {
      const { evidenceId } = await readyDraft();
      const out = await one<{ objectPath: string; fileName: string; mime: string }>(
        MANAGER,
        'select public.booking_authorize_evidence_download($1) as r',
        [evidenceId],
      );
      expect(out).toMatchObject({ fileName: 'acceptance.pdf', mime: 'application/pdf' });
      expect(out.objectPath.endsWith(`/${evidenceId}`)).toBe(true);
      const audit = await db.query<{ action: string; actor_user_id: string }>(
        `select action, actor_user_id from public.audit_events where target_id = $1 and action = 'booking.evidence_viewed'`,
        [evidenceId],
      );
      expect(audit).toEqual([{ action: 'booking.evidence_viewed', actor_user_id: U.managerDelhi }]);
      for (const actor of [PURCHASE, OTHER_MANAGER, { userId: U.salesAhmedabad }, ADMIN] as Actor[]) {
        await refused(actor, 'select public.booking_authorize_evidence_download($1) as r', [evidenceId], '42501', 'not_authorized');
      }
      await refused(OWNER, 'select public.booking_authorize_evidence_download($1) as r', [crypto.randomUUID()], '42501', 'not_authorized');
    });
  });
});

describe('P3-01 missing proof', () => {
  it('readiness lists missing_acceptance_proof; confirm is not_ready; no task', async () => {
    await asOwner(db, async () => {
      const { versionId, rowVersion } = await openDraft(OWNER);
      const saved = await saveDraft(OWNER, versionId, rowVersion);
      const r = await readiness(OWNER, versionId);
      expect(r).toEqual({ ready: false, issues: ['missing_acceptance_proof'], contentHash: saved.contentHash });
      await refused(OWNER, CONFIRM_SQL, [versionId, saved.contentHash], '55000', 'not_ready');
      expect(await countTasks(versionId)).toBe(0);
    });
  });

  it('an empty draft lists every repair item in contract order', async () => {
    await asOwner(db, async () => {
      const { versionId } = await openDraft(OWNER);
      expect((await readiness(OWNER, versionId)).issues).toEqual([
        'missing_hotel_name',
        'missing_city',
        'missing_dates',
        'missing_rooms',
        'missing_travellers',
        'missing_purchase_budget',
        'missing_selling_total',
        'missing_acceptance_proof',
      ]);
      const saved = await saveDraft(OWNER, versionId, 1, { ...FACTS, checkOut: FACTS.checkIn });
      expect((await readiness(OWNER, versionId)).issues).toEqual(['check_out_not_after_check_in', 'missing_acceptance_proof']);
      expect(saved.rowVersion).toBe(2);
    });
  });
});

describe('P3-02 hash changed after review', () => {
  it('version_changed; nothing confirmed; no task', async () => {
    await asOwner(db, async () => {
      const { versionId, hash } = await readyDraft();
      await addSalesAssignee();
      // Someone else edits after the confirmer reviewed `hash`.
      await saveDraft(ASSIGNEE, versionId, 2, { ...FACTS, rooms: 3 });
      await refused(OWNER, CONFIRM_SQL, [versionId, hash], '40001', 'version_changed');
      await refused(OWNER, CONFIRM_SQL, [versionId, null], '40001', 'version_changed');
      expect(await countTasks(versionId)).toBe(0);
      expect(await db.query(`select status from public.booking_versions where id = $1`, [versionId])).toEqual([{ status: 'draft' }]);
    });
  });
});

describe('P3-03 / P3-04 / P3-12 confirmation, repeat, uniqueness and outbox', () => {
  it('creates exactly one task and two id-only outbox rows; repeats return existing', async () => {
    await asOwner(db, async () => {
      const { versionId, hash } = await readyDraft();
      const created = await confirm(OWNER, versionId, hash);
      expect(created).toMatchObject({ outcome: 'created', versionId });

      // P3-03 repeat (same and a stale hash: the loser of a race sees 'confirmed').
      expect(await confirm(OWNER, versionId, hash)).toEqual({ ...created, outcome: 'existing' });
      expect(await confirm(MANAGER, versionId, 'f'.repeat(64))).toEqual({ ...created, outcome: 'existing' });

      const [task] = await db.query<Record<string, unknown>>('select * from public.fulfilment_tasks where booking_version_id = $1', [versionId]);
      expect(task).toMatchObject({
        id: created.taskId,
        deal_id: D.del001,
        service_purpose: 'hotel',
        task_key: `booking:${versionId}:hotel`,
        status: 'not_started',
        assignee_user_id: null,
        created_by: U.salesDelhiA,
      });
      const [ver] = await db.query<Record<string, unknown>>(
        'select status, confirmed_by, confirmed_at is not null as at, confirmed_deal_source_modified_at from public.booking_versions where id = $1',
        [versionId],
      );
      expect(ver).toEqual({ status: 'confirmed', confirmed_by: U.salesDelhiA, at: true, confirmed_deal_source_modified_at: null });

      // P3-12 outbox: exactly two rows, ids only.
      const outbox = await db.query<{ event_type: string; aggregate_type: string; aggregate_id: string; payload: Record<string, unknown>; status: string; attempts: number }>(
        `select event_type, aggregate_type, aggregate_id, payload, status, attempts from public.outbox_events
         where aggregate_id in ($1, $2) order by event_type`,
        [versionId, created.taskId],
      );
      expect(outbox).toHaveLength(2);
      expect(outbox.map((o) => [o.event_type, o.aggregate_type, o.aggregate_id])).toEqual([
        ['booking.version_confirmed', 'booking_version', versionId],
        ['fulfilment.task_created', 'fulfilment_task', created.taskId],
      ]);
      for (const o of outbox) {
        expect(o).toMatchObject({ status: 'pending', attempts: 0 });
        expect(Object.keys(o.payload).sort()).toEqual(['deal_id', 'service_purpose', 'task_id', 'version_id', 'version_no']);
      }
      const everything = JSON.stringify(
        await db.query(
          `select payload from public.outbox_events
           union all select details from public.audit_events where target_id in ($1, $2)`,
          [versionId, created.taskId],
        ),
      );
      expect(everything).not.toMatch(new RegExp(`${SELLING}|4500000|paise|selling|budget`, 'i'));
      const actions = await db.query<{ action: string }>(
        `select action from public.audit_events where target_id in ($1, $2) and action in ('booking.version_confirmed', 'fulfilment.task_created') order by id`,
        [versionId, created.taskId],
      );
      expect(actions.map((a) => a.action)).toEqual(['booking.version_confirmed', 'fulfilment.task_created']);

      // P3-04 / P3-12 uniqueness holds even for the table owner.
      await expectDbError(
        db,
        () =>
          db.query(
            `insert into public.fulfilment_tasks (deal_id, legal_entity_id, branch_id, booking_version_id, task_key, created_by)
             select deal_id, legal_entity_id, branch_id, id, 'booking:' || id || ':hotel', $2 from public.booking_versions where id = $1`,
            [versionId, U.salesDelhiA],
          ),
        { code: '23505' },
      );
      await expectDbError(
        db,
        () =>
          db.query(
            `insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
             select legal_entity_id, 'booking_version', id, 'booking.version_confirmed', '{}'::jsonb from public.booking_versions where id = $1`,
            [versionId],
          ),
        { code: '23505' },
      );
      // Amount keys are refused by the payload check.
      await expectDbError(
        db,
        () =>
          db.query(
            `insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
             select legal_entity_id, 'booking_version', gen_random_uuid(), 'booking.version_confirmed',
                    '{"selling_total_paise": 1}'::jsonb from public.booking_versions where id = $1`,
            [versionId],
          ),
        { code: '23514' },
      );
      expect(Number((await db.query<{ n: string }>('select count(*)::text as n from public.outbox_events'))[0]!.n)).toBe(2);
    });
  });

  it('the confirm command locks the version row before anything else (FOR UPDATE)', async () => {
    const [src] = await asOwner(db, () =>
      db.query<{ src: string }>(`select prosrc as src from pg_proc where proname = 'booking_confirm'`),
    );
    const body = src!.src;
    expect(body).toMatch(/from public\.booking_versions v where v\.id = p_version_id for update/);
    expect(body.indexOf('for update')).toBeLessThan(body.indexOf("'existing'"));
    expect(body).toMatch(/on conflict \(task_key\) do nothing/);
  });
});

describe('P3-05 immutability after confirmation', () => {
  it('version, commercials and evidence refuse UPDATE/DELETE/INSERT even for the table owner; commands refuse', async () => {
    await asOwner(db, async () => {
      const { versionId, hash, evidenceId } = await readyDraft();
      await confirm(OWNER, versionId, hash);
      const ownerRefusals = [
        `update public.booking_versions set hotel_name = 'changed' where id = $1`,
        `update public.booking_versions set status = 'draft', confirmed_at = null, confirmed_by = null where id = $1`,
        `delete from public.booking_versions where id = $1`,
        `update public.booking_version_commercials set selling_total_paise = 1 where version_id = $1`,
        `delete from public.booking_version_commercials where version_id = $1`,
        `update public.booking_evidence set status = 'removed' where version_id = $1`,
        `delete from public.booking_evidence where version_id = $1`,
        `insert into public.booking_evidence (id, version_id, deal_id, legal_entity_id, kind, object_path, file_name, mime, size_bytes, sha256, uploaded_by)
         select x.id, v.id, v.deal_id, v.legal_entity_id, 'bill',
                v.legal_entity_id || '/' || v.deal_id || '/' || v.id || '/' || x.id, 'late.pdf', 'application/pdf', 1, repeat('c', 64), v.created_by
         from public.booking_versions v cross join (select gen_random_uuid() as id) x where v.id = $1`,
      ];
      for (const sql of ownerRefusals) {
        await expectDbError(db, () => db.query(sql, [versionId]), { code: '42501' });
      }
      await refused(OWNER, SAVE_SQL, [versionId, 2, JSON.stringify(FACTS), SELLING, true], '55000', 'already_confirmed');
      await refused(OWNER, BEGIN_SQL, [versionId, 'bill', 'b.pdf', 'application/pdf', 10, SHA], '55000', 'already_confirmed');
      await refused(OWNER, 'select public.booking_remove_evidence($1) as r', [evidenceId], '55000', 'already_confirmed');
      await refused(OWNER, OPEN_SQL, [D.del001], '55000', 'already_confirmed');
      // Tasks are never deleted, and their identity never changes.
      await expectDbError(db, () => db.query('delete from public.fulfilment_tasks where booking_version_id = $1', [versionId]), { code: '42501' });
      await expectDbError(
        db,
        () => db.query(`update public.fulfilment_tasks set task_key = 'x' where booking_version_id = $1`, [versionId]),
        { code: '42501' },
      );
    });
  });
});

describe('P3-06 who may confirm', () => {
  it('assignee edits but cannot confirm; owner can', async () => {
    await asOwner(db, async () => {
      await addSalesAssignee();
      const opened = await openDraft(ASSIGNEE);
      await saveDraft(ASSIGNEE, opened.versionId, opened.rowVersion);
      await storeEvidence(ASSIGNEE, opened.versionId);
      const ready = await readiness(ASSIGNEE, opened.versionId);
      expect(ready.ready).toBe(true);
      await refused(ASSIGNEE, CONFIRM_SQL, [opened.versionId, ready.contentHash], '42501', 'not_authorized');
      expect((await confirm(OWNER, opened.versionId, ready.contentHash)).outcome).toBe('created');
    });
  });

  it('the branch Sales Manager can confirm', async () => {
    await asOwner(db, async () => {
      const { versionId } = await readyDraft();
      // The manager reviews through the panel (no commercial scope) and confirms that hash.
      const { contentHash: hash } = await readiness(MANAGER, versionId);
      expect((await confirm(MANAGER, versionId, hash)).outcome).toBe('created');
      expect(await db.query('select confirmed_by from public.booking_versions where id = $1', [versionId])).toEqual([
        { confirmed_by: U.managerDelhi },
      ]);
    });
  });

  it('a manager in another branch cannot, even with a read grant on the deal; Purchase cannot', async () => {
    await asOwner(db, async () => {
      const { versionId, hash } = await readyDraft();
      await db.query(
        `insert into public.access_grants (user_id, permission_code, legal_entity_id, branch_id, reason, granted_by)
         select $1, 'deal.read', b.legal_entity_id, b.id, 'SYNTHETIC FIXTURE: test-only Delhi read', $2
         from public.branches b where b.code = 'DEL'`,
        [U.managerAhmedabad, U.adminJodhpur],
      );
      expect(await one(OTHER_MANAGER, 'select authz.can_read_deal($1) as r', [D.del001])).toBe(true);
      for (const actor of [OTHER_MANAGER, PURCHASE, { userId: U.salesDelhiB }, ADMIN] as Actor[]) {
        await refused(actor, CONFIRM_SQL, [versionId, hash], '42501', 'not_authorized');
        await refused(actor, OPEN_SQL, [D.del001], '42501', 'not_authorized');
        await refused(actor, SAVE_SQL, [versionId, 2, JSON.stringify(FACTS), SELLING, true], '42501', 'not_authorized');
        await refused(actor, 'select public.booking_readiness($1) as r', [versionId], '42501', 'not_authorized');
      }
      expect(await countTasks(versionId)).toBe(0);
    });
  });

  it('an unknown version id is not_authorized (existence not revealed)', async () => {
    await asOwner(db, async () => {
      await refused(OWNER, CONFIRM_SQL, [crypto.randomUUID(), 'a'.repeat(64)], '42501', 'not_authorized');
      await refused(OWNER, SAVE_SQL, [crypto.randomUUID(), 1, JSON.stringify(FACTS), SELLING, true], '42501', 'not_authorized');
    });
  });
});

describe('P3-07 Purchase sees scope and budget only', () => {
  it('no booking/commercial/evidence rows via the API; task DTO has the budget and no selling price', async () => {
    await asOwner(db, async () => {
      const { versionId, hash, evidenceId } = await readyDraft();
      const { taskId } = await confirm(OWNER, versionId, hash);

      for (const t of ['booking_versions', 'booking_version_commercials', 'booking_evidence', 'deal_commercials']) {
        expect(await run(PURCHASE, `select 1 as x from public.${t}`), t).toEqual([]);
      }
      await refused(PURCHASE, 'select * from public.outbox_events', [], '42501');
      // The task row itself is visible to Purchase (no commercial columns).
      expect(await run(PURCHASE, 'select id from public.fulfilment_tasks')).toEqual([{ id: taskId }]);

      const list = await one<Record<string, unknown>[]>(PURCHASE, 'select public.purchase_task_list() as r');
      expect(list).toHaveLength(1);
      expect(list[0]).toEqual({
        taskId,
        dealReference: 'SYN-DEL-001',
        hotelName: FACTS.hotelName,
        city: FACTS.city,
        checkIn: '2026-12-10',
        checkOut: '2026-12-13',
        nights: 3,
        rooms: 2,
        adults: 3,
        children: 1,
        purchaseBudgetPaise: '4500000',
        status: 'not_started',
        assigneeName: null,
        assignedToYou: false,
        branchName: 'Delhi',
        createdAt: expect.any(String),
        // Phase 4: Sales and Purchase may see when the supplier confirmed (P4-D6); null until then.
        supplierConfirmedAt: null,
        // B1 (20261118000100): the sold service behind the task; hotel facts mirror the version columns.
        serviceType: 'hotel',
        department: 'purchase',
        itemTitle: `${FACTS.hotelName} · ${FACTS.city}`,
        facts: {
          type: 'hotel',
          facts: { hotelName: FACTS.hotelName, city: FACTS.city, checkIn: '2026-12-10', checkOut: '2026-12-13', rooms: 2, adults: 3,
            roomType: FACTS.roomType, mealPlan: FACTS.mealPlan, children: 1, inclusions: FACTS.inclusions },
        },
      });
      const detail = await one<Record<string, unknown>>(PURCHASE, 'select public.purchase_task_get($1) as r', [taskId]);
      expect(detail).toMatchObject({
        taskId,
        roomType: FACTS.roomType,
        mealPlan: FACTS.mealPlan,
        inclusions: FACTS.inclusions,
        specialRequests: null,
        confirmedByName: 'Synthetic Sales Delhi A',
        versionNo: 1,
        canClaim: true,
      });
      const text = JSON.stringify([list, detail]);
      expect(text).not.toContain(SELLING);
      expect(text).not.toMatch(/selling|margin|evidence|objectPath|acceptance/i);

      await refused(PURCHASE, 'select public.booking_authorize_evidence_download($1) as r', [evidenceId], '42501', 'not_authorized');
      expect(await one(PURCHASE, 'select public.booking_panel($1) as r', [D.del001])).toBeNull();
      await refused(PURCHASE, 'select public.booking_readiness($1) as r', [versionId], '42501', 'not_authorized');
    });
  });

  it('Purchase sees every task in its entity, including deals it is not assigned to (P3-D4)', async () => {
    await asOwner(db, async () => {
      const { versionId, hash } = await readyDraft({ userId: U.salesDelhiB }, D.del002);
      const { taskId } = await confirm({ userId: U.salesDelhiB }, versionId, hash);
      expect(await one(PURCHASE, 'select authz.can_read_deal($1) as r', [D.del002])).toBe(false);
      const list = await one<{ taskId: string }[]>(PURCHASE, 'select public.purchase_task_list() as r');
      expect(list.map((t) => t.taskId)).toEqual([taskId]);
      // Sales of another deal does not see it; the deal owner sees its status.
      expect(await one(OWNER, 'select public.purchase_task_list() as r')).toEqual([]);
      expect((await one<{ taskId: string }[]>({ userId: U.salesDelhiB }, 'select public.purchase_task_list() as r')).map((t) => t.taskId)).toEqual([
        taskId,
      ]);
      expect(await one(OWNER, 'select public.purchase_task_get($1) as r', [taskId])).toBeNull();
    });
  });
});

describe('P3-08 cross-entity / cross-branch, anon and aal1', () => {
  it('Sales in another branch or entity is refused every command', async () => {
    await asOwner(db, async () => {
      const { versionId, hash, evidenceId } = await readyDraft();
      for (const actor of [{ userId: U.salesAhmedabad }, { userId: U.salesEntityB }] as Actor[]) {
        await refused(actor, OPEN_SQL, [D.del001], '42501', 'not_authorized');
        await refused(actor, CONFIRM_SQL, [versionId, hash], '42501', 'not_authorized');
        await refused(actor, BEGIN_SQL, [versionId, 'bill', 'b.pdf', 'application/pdf', 10, SHA], '42501', 'not_authorized');
        await refused(actor, 'select public.booking_remove_evidence($1) as r', [evidenceId], '42501', 'not_authorized');
        expect(await one(actor, 'select public.booking_panel($1) as r', [D.del001])).toBeNull();
        for (const t of BOOKING_TABLES.filter((x) => x !== 'outbox_events' && x !== 'booking_settings')) {
          expect(await run(actor, `select 1 as x from public.${t}`), t).toEqual([]);
        }
      }
      const { taskId } = await confirm(OWNER, versionId, hash);
      // Entity B Sales and a Purchase user of another entity see no task.
      expect(await one({ userId: U.salesEntityB }, 'select public.purchase_task_list() as r')).toEqual([]);
      await db.query(
        `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
         values ($1, 'e0000000-0000-4000-8000-0000000000b0', 'b0000000-0000-4000-8000-0000000000b1', 'purchase', 'active')`,
        [U.salesEntityB],
      );
      await refused({ userId: U.salesEntityB }, 'select public.purchase_task_claim($1) as r', [taskId], '42501', 'not_authorized');
      expect(await one({ userId: U.salesEntityB }, 'select public.purchase_task_get($1) as r', [taskId])).toBeNull();
    });
  });

  it('anon has no table privilege and no command; aal1 reads nothing and is not_authorized', async () => {
    await asOwner(db, async () => {
      const { versionId, hash, evidenceId } = await readyDraft();
      const { taskId } = await confirm(OWNER, versionId, hash);
      const commands: [string, unknown[]][] = [
        [OPEN_SQL, [D.del001]],
        [SAVE_SQL, [versionId, 2, JSON.stringify(FACTS), SELLING, true]],
        [BEGIN_SQL, [versionId, 'bill', 'b.pdf', 'application/pdf', 10, SHA]],
        ['select public.booking_finish_evidence($1, true) as r', [evidenceId]],
        ['select public.booking_remove_evidence($1) as r', [evidenceId]],
        ['select public.booking_authorize_evidence_download($1) as r', [evidenceId]],
        ['select public.booking_readiness($1) as r', [versionId]],
        [CONFIRM_SQL, [versionId, hash]],
        ['select public.purchase_task_claim($1) as r', [taskId]],
        ['select public.booking_panel($1) as r', [D.del001]],
        ['select public.purchase_task_list() as r', []],
        ['select public.purchase_task_get($1) as r', [taskId]],
        ['select public.booking_health() as r', []],
      ];
      for (const t of BOOKING_TABLES) {
        await refused(ANON, `select 1 as x from public.${t}`, [], '42501');
      }
      for (const [sql, params] of commands) {
        await refused(ANON, sql, params, '42501');
      }
      for (const actor of [
        { userId: U.salesDelhiA, aal: 'aal1' },
        { userId: U.purchaseJodhpur, aal: 'aal1' },
        { userId: U.adminJodhpur, aal: 'aal1' },
      ] as Actor[]) {
        for (const t of BOOKING_TABLES.filter((x) => x !== 'outbox_events')) {
          expect(await run(actor, `select 1 as x from public.${t}`), t).toEqual([]);
        }
        for (const [sql, params] of commands) {
          await refused(actor, sql, params, '42501', 'not_authorized');
        }
      }
      // Direct writes are refused for every API role.
      for (const actor of [OWNER, PURCHASE, ANON, SVC]) {
        await refused(actor, `update public.fulfilment_tasks set status = 'in_progress' where id = $1`, [taskId], '42501');
        await refused(actor, `insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload) values ($1, 'booking_version', $1, 'booking.version_confirmed', '{}')`, [crypto.randomUUID()], '42501');
      }
    });
  });
});

describe('P3-09 / P3-11 gate and source freshness', () => {
  it('synthetic deals confirm only in test; unset refuses', async () => {
    await asOwner(db, async () => {
      const { versionId, hash } = await readyDraft();
      for (const env of ['staging', 'operational']) {
        // operational is refused while synthetic deals exist; emulate the check by staging only.
        if (env === 'operational') continue;
        await db.query(`update public.deployment_settings set environment = $1 where id`, [env]);
        await refused(OWNER, CONFIRM_SQL, [versionId, hash], '55000', 'booking_disabled');
        expect((await readiness(OWNER, versionId)).issues).toEqual(['booking_disabled']);
      }
      await db.query(`update public.deployment_settings set environment = 'unset' where id`);
      await refused(OWNER, CONFIRM_SQL, [versionId, hash], '55000', 'environment_unset');
      expect((await readiness(OWNER, versionId)).issues).toEqual(['environment_unset']);
      expect(await countTasks(versionId)).toBe(0);
    });
  });

  it('a real deal needs real_booking_enabled and a verification within 24 h', async () => {
    await asOwner(db, async () => {
      const fresh = await insertRealDeal(1);
      const { versionId, hash } = await readyDraft(OWNER, fresh);
      await refused(OWNER, CONFIRM_SQL, [versionId, hash], '55000', 'booking_disabled');
      expect((await readiness(OWNER, versionId)).issues).toEqual(['booking_disabled']);
      await db.query('update public.booking_settings set real_booking_enabled = true where id');
      expect((await readiness(OWNER, versionId)).ready).toBe(true);

      // P3-11: last verified 25 h ago.
      await db.query(`update public.deals set last_verified_at = now() - interval '25 hours' where id = $1`, [fresh]);
      expect((await readiness(OWNER, versionId)).issues).toEqual(['source_not_recently_verified']);
      await refused(OWNER, CONFIRM_SQL, [versionId, hash], '55000', 'not_ready');

      await db.query(`update public.deals set last_verified_at = now() where id = $1`, [fresh]);
      const created = await confirm(OWNER, versionId, hash);
      expect(created.outcome).toBe('created');
      const [v] = await db.query<{ ok: boolean }>(
        `select v.confirmed_deal_source_modified_at = d.source_modified_at as ok
         from public.booking_versions v join public.deals d on d.id = v.deal_id where v.id = $1`,
        [versionId],
      );
      expect(v!.ok).toBe(true);
    });
  });
});

describe('P3-10 unknown or inactive staff', () => {
  it('is not_authorized for every command', async () => {
    await asOwner(db, async () => {
      const { versionId, hash } = await readyDraft();
      for (const actor of [
        { userId: U.formerStaff },
        { userId: U.movedStaff },
        { userId: U.invitedStaff },
        { userId: crypto.randomUUID() },
      ] as Actor[]) {
        await refused(actor, OPEN_SQL, [D.del003], '42501', 'not_authorized');
        await refused(actor, CONFIRM_SQL, [versionId, hash], '42501', 'not_authorized');
        if (actor.userId === U.movedStaff) {
          // Active profile without any membership: a valid session that sees nothing.
          expect(await one(actor, 'select public.purchase_task_list() as r')).toEqual([]);
          expect(await one(actor, 'select public.booking_panel($1) as r', [D.del003])).toBeNull();
        } else {
          await refused(actor, 'select public.purchase_task_list() as r', [], '42501', 'not_authorized');
          await refused(actor, 'select public.booking_panel($1) as r', [D.del003], '42501', 'not_authorized');
        }
      }
      // The owner deactivated mid-flight loses confirmation at once.
      await db.query(
        `update public.staff_profiles set status = 'inactive', deactivated_at = now(), deactivation_reason = 'SYNTHETIC FIXTURE test' where user_id = $1`,
        [U.salesDelhiA],
      );
      await refused(OWNER, CONFIRM_SQL, [versionId, hash], '42501', 'not_authorized');
    });
  });
});

describe('P3-13 Purchase claim', () => {
  it('is idempotent for self, task_conflict for another Purchase user, and creates a purchase assignment', async () => {
    await asOwner(db, async () => {
      const sales2: Actor = { userId: U.salesDelhiB };
      const { versionId, hash } = await readyDraft(sales2, D.del002);
      const { taskId } = await confirm(sales2, versionId, hash);
      expect(
        await db.query(`select id from public.deal_assignments where deal_id = $1 and user_id = $2 and ended_at is null`, [D.del002, U.purchaseJodhpur]),
      ).toEqual([]);

      await refused(sales2, 'select public.purchase_task_claim($1) as r', [taskId], '42501', 'not_authorized');
      await refused(MANAGER, 'select public.purchase_task_claim($1) as r', [taskId], '42501', 'not_authorized');

      expect(await claim(PURCHASE, taskId)).toEqual({ taskId, status: 'in_progress', assignedToYou: true, alreadyYours: false });
      expect(await claim(PURCHASE, taskId)).toEqual({ taskId, status: 'in_progress', assignedToYou: true, alreadyYours: true });
      expect(
        await db.query(
          `select assignment_kind, assigned_by from public.deal_assignments where deal_id = $1 and user_id = $2 and ended_at is null`,
          [D.del002, U.purchaseJodhpur],
        ),
      ).toEqual([{ assignment_kind: 'purchase', assigned_by: U.purchaseJodhpur }]);
      const audit = await db.query<{ action: string }>(
        `select action from public.audit_events where target_id = $1 and action = 'fulfilment.task_claimed'`,
        [taskId],
      );
      expect(audit).toHaveLength(1);

      // A second Purchase colleague (Visa Jodhpur gains the purchase role for this test).
      await db.query(
        `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
         select $1, b.legal_entity_id, b.id, 'purchase', 'active' from public.branches b where b.code = 'JDH'`,
        [U.visaJodhpur],
      );
      await refused({ userId: U.visaJodhpur }, 'select public.purchase_task_claim($1) as r', [taskId], '40001', 'task_conflict');
      const detail = await one<{ assigneeName: string; assignedToYou: boolean; canClaim: boolean; status: string }>(
        { userId: U.visaJodhpur },
        'select public.purchase_task_get($1) as r',
        [taskId],
      );
      expect(detail).toMatchObject({ assigneeName: 'Synthetic Purchase Jodhpur', assignedToYou: false, canClaim: false, status: 'in_progress' });
      // Even Purchase still cannot read the deal's commercials or the booking rows after claiming.
      expect(await run(PURCHASE, 'select * from public.deal_commercials where deal_id = $1', [D.del002])).toEqual([]);
      expect(await run(PURCHASE, 'select id from public.booking_versions')).toEqual([]);
    });
  });
});

describe('read functions for Sales and admins', () => {
  it('booking_panel shows the selling total only with deal.read_commercial', async () => {
    await asOwner(db, async () => {
      const none = await one<Record<string, unknown>>(OWNER, 'select public.booking_panel($1) as r', [D.del001]);
      expect(none).toEqual({
        dealId: D.del001,
        canEdit: true,
        canConfirm: false,
        gate: { realBookingEnabled: false, environment: 'test' },
        version: null,
        readiness: null,
        evidence: [],
        evidenceVisible: true,
        task: null,
        dealNotActive: false,
        // B1 (20261118000100): services, progress and the switch.
        services: [],
        progress: { total: 0, byState: { planned: 0, waitingForLaunch: 0, notStarted: 0, inProgress: 0, supplierConfirmed: 0, completed: 0 }, fulfilled: false, staleCount: 0, needs: [] },
        serviceItemsEnabled: false,
        // B1.1 revision (20261119000300): review state, open revision, "Fix this booking".
        accountsReview: null,
        revision: null,
        canRevise: false,
      });
      const { versionId, hash, evidenceId } = await readyDraft();
      const own = await one<{ version: Record<string, unknown>; readiness: BookingReadiness; evidence: Record<string, unknown>[]; canConfirm: boolean }>(
        OWNER,
        'select public.booking_panel($1) as r',
        [D.del001],
      );
      expect(own.canConfirm).toBe(true);
      expect(own.version).toMatchObject({ versionId, versionNo: 1, status: 'draft', contentHash: hash, sellingTotalPaise: SELLING, facts: FACTS });
      expect(own.readiness).toEqual({ ready: true, issues: [], contentHash: hash });
      expect(own.evidence).toEqual([
        expect.objectContaining({ id: evidenceId, kind: 'acceptance_message', fileName: 'acceptance.pdf', status: 'stored', uploadedByYou: true, sizeBytes: 2048 }),
      ]);

      // Manager Delhi reads the deal by grant but has no commercial scope: key absent.
      const mgr = await one<{ version: Record<string, unknown>; canEdit: boolean; canConfirm: boolean; evidence: { uploadedByYou: boolean }[] }>(
        MANAGER,
        'select public.booking_panel($1) as r',
        [D.del001],
      );
      expect(mgr).toMatchObject({ canEdit: true, canConfirm: true });
      expect('sellingTotalPaise' in mgr.version).toBe(false);
      expect(JSON.stringify(mgr)).not.toContain(SELLING);
      expect(mgr.evidence[0]!.uploadedByYou).toBe(false);

      const { taskId } = await confirm(OWNER, versionId, hash);
      await claim(PURCHASE, taskId);
      const after = await one<{ canEdit: boolean; canConfirm: boolean; readiness: unknown; task: unknown; version: Record<string, unknown> }>(
        OWNER,
        'select public.booking_panel($1) as r',
        [D.del001],
      );
      expect(after).toMatchObject({ canEdit: false, canConfirm: false, readiness: null });
      expect(after.task).toEqual({ taskId, status: 'in_progress', assigneeName: 'Synthetic Purchase Jodhpur' });
      expect(after.version).toMatchObject({ status: 'confirmed', confirmedByName: 'Synthetic Sales Delhi A' });
    });
  });

  it('booking_health is for integration.manage only and counts drafts, repairs, tasks and outbox', async () => {
    await asOwner(db, async () => {
      await openDraft({ userId: U.salesDelhiB }, D.del002); // empty draft: needs repair
      const { versionId, hash } = await readyDraft();
      const { taskId } = await confirm(OWNER, versionId, hash);
      await openDraft({ userId: U.salesAhmedabad }, D.amd001);
      const health = await one(ADMIN, 'select public.booking_health() as r');
      expect(health).toEqual({
        realBookingEnabled: false,
        environment: 'test',
        drafts: 2,
        draftsNeedingRepair: 2,
        confirmed: 1,
        tasksNotStarted: 1,
        tasksInProgress: 0,
        pendingOutboxEvents: 2,
        // B1 (20261118000100): open tasks per service type and the service-items switch.
        tasksByServiceType: { hotel: 1, transfer: 0, activity: 0, flight: 0, visa: 0, passport: 0 },
        serviceItemsEnabled: false,
        // B1.1c (20261119000500)
        visaPassportTasksEnabled: false,
      });
      await claim(PURCHASE, taskId);
      expect(await one(ADMIN, 'select public.booking_health() as r')).toMatchObject({ tasksNotStarted: 0, tasksInProgress: 1 });
      for (const actor of [OWNER, MANAGER, PURCHASE, { userId: U.accountsJodhpur }] as Actor[]) {
        await refused(actor, 'select public.booking_health() as r', [], '42501', 'not_authorized');
      }
    });
  });

  it('Sales and managers see their deal task row directly; service_role reads but cannot write', async () => {
    await asOwner(db, async () => {
      const { versionId, hash } = await readyDraft();
      const { taskId } = await confirm(OWNER, versionId, hash);
      expect(await run(OWNER, 'select id, status from public.fulfilment_tasks')).toEqual([{ id: taskId, status: 'not_started' }]);
      expect(await run(MANAGER, 'select id from public.fulfilment_tasks')).toEqual([{ id: taskId }]);
      expect(await run(OTHER_MANAGER, 'select id from public.fulfilment_tasks')).toEqual([]);
      expect(await run(SVC, 'select count(*)::int as n from public.outbox_events')).toEqual([{ n: 2 }]);
      await refused(SVC, CONFIRM_SQL, [versionId, hash], '42501');
    });
  });
});
