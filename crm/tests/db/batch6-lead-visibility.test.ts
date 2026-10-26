import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Actor,
  FIXTURE_USERS as U,
  type TestDb,
  amrAt,
  asOwner,
  createTestDb,
  expectDbError,
  resetActor,
  setActor,
} from '../helpers/db';

/**
 * Direction A Batch 6, item 2 (migration 20261127000200_lead_read_policy_set_based):
 * the crm_leads read policy is evaluated once per statement instead of calling
 * authz.can_read_lead(id) for every row. Visibility must never widen or narrow.
 *
 *   - Parity: for every role, the Leads that `select id from crm_leads` returns
 *     are exactly the Leads for which authz.can_read_lead(id) (unchanged,
 *     security definer, so it can be asked about unseen ids) answers true for
 *     the same caller, over every Lead in the table.
 *   - Explicit expectation: the same rows also equal a hand-written list per
 *     role, so the test does not only compare the new rule with the old one.
 *   - Shape: the policy text no longer calls can_read_lead, EXPLAIN shows the
 *     viewer facts as InitPlans, and the two new helpers are security definer,
 *     stable, search_path '' and executable by authenticated only.
 *   - Volume: 10,000 synthetic Leads, the Leads list count and the Lead search
 *     (public.crm_search) for a Manager and a Sales person, old rule (policy
 *     re-created inside the rolled-back transaction) against the new rule.
 *
 * Synthetic world (on top of supabase/fixtures):
 *   entities  HOLIDAY_CHACHA (enabled): JDH, DEL, AMD enabled, DIS6 disabled
 *             SYNTHETIC_B (disabled, fixture): SB1
 *             SYNTHETIC_C6 (enabled): SC1 enabled, SC2 disabled
 *   extra memberships
 *             Sales Delhi A    sales SC1, SC2, DIS6 (active)
 *             Sales Delhi B    sales SC1 (inactive)
 *             Manager Delhi    manager SC2 (disabled branch), SB1 (disabled entity)
 *             Manager Ahmedabad manager SC1 (inactive), JDH (invited)
 *
 * Every scenario runs in one rolled-back transaction (asOwner). Synthetic data only.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const PORTAL = 'synthetic-b6-portal.example.test';
const ENTITY_C = 'e0000000-0000-4000-8000-0000000006c0';
const BRANCH_SC1 = 'b0000000-0000-4000-8000-0000000006c1';
const BRANCH_SC2 = 'b0000000-0000-4000-8000-0000000006c2';
const BRANCH_DIS = 'b0000000-0000-4000-8000-0000000006d1';

const OWNER: Actor = { userId: U.salesDelhiA };
const SALES_B: Actor = { userId: U.salesDelhiB };
const SALES_AMD: Actor = { userId: U.salesAhmedabad };
const MANAGER: Actor = { userId: U.managerDelhi };
const MANAGER_AMD: Actor = { userId: U.managerAhmedabad };
const ACCOUNTS: Actor = { userId: U.accountsJodhpur };
const PURCHASE: Actor = { userId: U.purchaseJodhpur };
const SUPER: Actor = { userId: U.adminJodhpur };
const VISA: Actor = { userId: U.visaJodhpur };
const ENTITY_B_SALES: Actor = { userId: U.salesEntityB };
const MOVED: Actor = { userId: U.movedStaff };
const FORMER: Actor = { userId: U.formerStaff };
const INVITED: Actor = { userId: U.invitedStaff };

async function run<T = Record<string, unknown>>(actor: Actor, sql: string, params: unknown[] = []): Promise<T[]> {
  await setActor(db, actor);
  try {
    return await db.query<T>(sql, params);
  } finally {
    await resetActor(db);
  }
}
const owner = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<T>(sql, params);

type EntityCode = 'HOLIDAY_CHACHA' | 'SYNTHETIC_B' | 'SYNTHETIC_C6';
interface LeadSpec {
  key: string;
  entity: EntityCode;
  branch: string;
  owner: string | null;
}

const HC = 'HOLIDAY_CHACHA';
const WORLD: LeadSpec[] = [
  { key: 'delA', entity: HC, branch: 'DEL', owner: U.salesDelhiA },
  { key: 'delB', entity: HC, branch: 'DEL', owner: U.salesDelhiB },
  { key: 'delNull', entity: HC, branch: 'DEL', owner: null },
  // Owner's Sales membership is in another branch (Ahmedabad).
  { key: 'delOwnerAmdSales', entity: HC, branch: 'DEL', owner: U.salesAhmedabad },
  // Owner's only membership is inactive (moved) / profile inactive (former).
  { key: 'delMoved', entity: HC, branch: 'DEL', owner: U.movedStaff },
  { key: 'delFormer', entity: HC, branch: 'DEL', owner: U.formerStaff },
  // Owner is a Manager, not Sales.
  { key: 'delManager', entity: HC, branch: 'DEL', owner: U.managerDelhi },
  { key: 'amdAmd', entity: HC, branch: 'AMD', owner: U.salesAhmedabad },
  { key: 'amdA', entity: HC, branch: 'AMD', owner: U.salesDelhiA },
  { key: 'amdNull', entity: HC, branch: 'AMD', owner: null },
  { key: 'jdhA', entity: HC, branch: 'JDH', owner: U.salesDelhiA },
  { key: 'jdhNull', entity: HC, branch: 'JDH', owner: null },
  { key: 'disA', entity: HC, branch: 'DIS6', owner: U.salesDelhiA },
  { key: 'disNull', entity: HC, branch: 'DIS6', owner: null },
  { key: 'sbEntityB', entity: 'SYNTHETIC_B', branch: 'SB1', owner: U.salesEntityB },
  { key: 'sbNull', entity: 'SYNTHETIC_B', branch: 'SB1', owner: null },
  { key: 'c1A', entity: 'SYNTHETIC_C6', branch: 'SC1', owner: U.salesDelhiA },
  { key: 'c1B', entity: 'SYNTHETIC_C6', branch: 'SC1', owner: U.salesDelhiB },
  { key: 'c1Null', entity: 'SYNTHETIC_C6', branch: 'SC1', owner: null },
  { key: 'c2A', entity: 'SYNTHETIC_C6', branch: 'SC2', owner: U.salesDelhiA },
  { key: 'c2Null', entity: 'SYNTHETIC_C6', branch: 'SC2', owner: null },
];
const ALL_HC = WORLD.filter((l) => l.entity === HC).map((l) => l.key);

let seq = 0;
async function addMembership(user: string, entity: EntityCode, branch: string, role: string, status = 'active'): Promise<void> {
  const rows = await owner(
    `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
     select $1::uuid, b.legal_entity_id, b.id, $4, $5
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
     where e.code = $2 and b.code = $3
     returning id`,
    [user, entity, branch, role, status],
  );
  expect(rows).toHaveLength(1);
}

/** Imported-style Leads (one processed intake row each, scope mode), as owner. Returns key -> id. */
async function addLeads(specs: LeadSpec[]): Promise<Map<string, string>> {
  const rows = specs.map((s) => ({ ...s, n: 6_100_000 + seq, tag: `b6-lead-${seq++}-${crypto.randomUUID()}` }));
  const out = await owner<{ id: string; n: string }>(
    `with spec as (
       select * from jsonb_to_recordset($1::jsonb) as s (key text, entity text, branch text, owner uuid, n bigint, tag text)
     ), inbox as (
       insert into public.integration_inbox (portal_member_id, event_type, source_deal_id, source_ts, dedupe_key, status,
                                             next_attempt_at, processed_at, origin, source_object)
       select 'SYNTHETIC_MEMBER_0001', 'ONCRMLEADADD', s.n, 1790000000 + s.n, encode(sha256(convert_to(s.tag, 'UTF8')), 'hex'),
              'processed', null, now(), 'event', 'lead'
       from spec s
       returning id, source_deal_id
     )
     insert into public.crm_leads (legal_entity_id, branch_id, reference, title, owner_user_id, source_portal, source_lead_id,
       source_status_id, source_id_code, source_created_at, source_modified_at, last_synced_at, last_verified_at,
       intake_inbox_id, intake_mode)
     select b.legal_entity_id, b.id, 'BXL-' || s.n, 'Synthetic visibility lead ' || s.key, s.owner, $2, s.n, 'NEW', 'WEB',
            now() - interval '1 day', now(), now(), now(), i.id, 'scope'
     from spec s
     join inbox i on i.source_deal_id = s.n
     join public.legal_entities e on e.code = s.entity
     join public.branches b on b.legal_entity_id = e.id and b.code = s.branch
     returning id, source_lead_id::text as n`,
    [JSON.stringify(rows), PORTAL],
  );
  expect(out).toHaveLength(specs.length);
  const byN = new Map(out.map((r) => [Number(r.n), r.id]));
  return new Map(rows.map((r) => [r.key, byN.get(r.n)!]));
}

/** The synthetic world above. Returns key -> Lead id. */
async function buildWorld(): Promise<Map<string, string>> {
  await owner(
    `insert into public.legal_entities (id, code, legal_name, status, is_synthetic)
     values ($1, 'SYNTHETIC_C6', 'Synthetic Test Entity C (not a real company)', 'enabled', true)`,
    [ENTITY_C],
  );
  await owner(
    `insert into public.branches (id, legal_entity_id, code, name, state_name, status)
     select v.id::uuid, v.entity::uuid, v.code, v.name, 'Not applicable (synthetic)', v.status
     from (values
       ($1, $4, 'SC1', 'Synthetic Branch C1', 'enabled'),
       ($2, $4, 'SC2', 'Synthetic Branch C2 (disabled)', 'disabled'),
       ($3, (select id::text from public.legal_entities where code = 'HOLIDAY_CHACHA'), 'DIS6', 'Synthetic disabled branch', 'disabled')
     ) as v (id, entity, code, name, status)`,
    [BRANCH_SC1, BRANCH_SC2, BRANCH_DIS, ENTITY_C],
  );
  await addMembership(U.salesDelhiA, 'SYNTHETIC_C6', 'SC1', 'sales');
  await addMembership(U.salesDelhiA, 'SYNTHETIC_C6', 'SC2', 'sales');
  await addMembership(U.salesDelhiA, HC, 'DIS6', 'sales');
  await addMembership(U.salesDelhiB, 'SYNTHETIC_C6', 'SC1', 'sales', 'inactive');
  await addMembership(U.managerDelhi, 'SYNTHETIC_C6', 'SC2', 'manager');
  await addMembership(U.managerDelhi, 'SYNTHETIC_B', 'SB1', 'manager');
  await addMembership(U.managerAhmedabad, 'SYNTHETIC_C6', 'SC1', 'manager', 'inactive');
  await addMembership(U.managerAhmedabad, HC, 'JDH', 'manager', 'invited');
  return addLeads(WORLD);
}

const sorted = (xs: Iterable<string>) => [...xs].sort();

/**
 * (a) RLS rows == every Lead in the table filtered by authz.can_read_lead as the
 * same caller; (b) RLS rows inside the world == the explicit expected keys.
 */
async function expectVisibility(label: string, actor: Actor, ids: Map<string, string>, expectedKeys: string[]): Promise<void> {
  const all = (await owner<{ id: string }>('select id from public.crm_leads')).map((r) => r.id);
  const seen = sorted((await run<{ id: string }>(actor, 'select id from public.crm_leads')).map((r) => r.id));
  const byFunction = sorted(
    (await run<{ id: string }>(actor, 'select x.id from unnest($1::uuid[]) as x (id) where authz.can_read_lead(x.id)', [all])).map((r) => r.id),
  );
  expect(seen, `${label}: policy rows vs authz.can_read_lead`).toEqual(byFunction);
  const keyOf = new Map([...ids].map(([k, v]) => [v, k]));
  const seenKeys = sorted(seen.filter((id) => keyOf.has(id)).map((id) => keyOf.get(id)!));
  expect(seenKeys, `${label}: explicit expected Leads`).toEqual(sorted(expectedKeys));
}

describe('helpers and policy shape', () => {
  it('the two helpers are security definer, stable, search_path empty, executable by authenticated only', async () => {
    const rows = await owner<{
      proname: string; prosecdef: boolean; provolatile: string; proconfig: string[] | null;
      auth: boolean; anon: boolean; svc: boolean; pub: boolean;
    }>(
      `select p.proname, p.prosecdef, p.provolatile, p.proconfig,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('service_role', p.oid, 'execute') as svc,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as pub
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'authz' and p.proname in ('my_purchase_anywhere', 'my_active_role_branches')
       order by p.proname`,
    );
    expect(rows.map((r) => r.proname)).toEqual(['my_active_role_branches', 'my_purchase_anywhere']);
    for (const r of rows) {
      expect(r, r.proname).toMatchObject({ prosecdef: true, provolatile: 's', auth: true, anon: false, svc: false, pub: false });
      expect(r.proconfig, r.proname).toEqual(['search_path=""']);
    }
  });

  it('authz.can_read_lead is still there (definer, granted to authenticated) for the commands that call it', async () => {
    const [r] = await owner<{ prosecdef: boolean; auth: boolean; anon: boolean }>(
      `select p.prosecdef, has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('anon', p.oid, 'execute') as anon
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'authz' and p.proname = 'can_read_lead'`,
    );
    expect(r).toEqual({ prosecdef: true, auth: true, anon: false });
  });

  it('crm_leads keeps the restrictive session policy; scoped_read no longer calls can_read_lead', async () => {
    const rows = await owner<{ policyname: string; permissive: string; cmd: string; roles: string[] | string; qual: string }>(
      `select policyname, permissive, cmd, roles, qual from pg_policies
       where schemaname = 'public' and tablename = 'crm_leads' order by policyname`,
    );
    expect(rows.map((r) => [r.policyname, r.permissive, r.cmd])).toEqual([
      ['require_valid_session', 'RESTRICTIVE', 'ALL'],
      ['scoped_read', 'PERMISSIVE', 'SELECT'],
    ]);
    const read = rows.find((r) => r.policyname === 'scoped_read')!;
    expect(String(read.roles)).toMatch(/authenticated/);
    expect(read.qual).not.toMatch(/can_read_lead/);
    for (const part of ['session_ok', 'my_purchase_anywhere', "my_active_role_branches('sales'", "my_active_role_branches('manager'", "my_permission_entities('integration.manage'", 'owner_user_id', 'branch_id', 'legal_entity_id']) {
      expect(read.qual, part).toContain(part);
    }
    expect(rows.find((r) => r.policyname === 'require_valid_session')!.qual).toMatch(/session_valid/);
  });

  it('EXPLAIN: the viewer facts are InitPlans, no per-row can_read_lead', async () => {
    await asOwner(db, async () => {
      await buildWorld();
      for (const actor of [MANAGER, OWNER]) {
        const plan = (await run<{ 'QUERY PLAN': string }>(actor, 'explain (verbose, costs off) select id from public.crm_leads'))
          .map((r) => r['QUERY PLAN'])
          .join('\n');
        expect(plan).not.toMatch(/can_read_lead/);
        expect(plan).toMatch(/InitPlan/);
        expect(plan).toMatch(/my_active_role_branches\('sales'/);
        expect(plan).toMatch(/my_active_role_branches\('manager'/);
        expect(plan).toMatch(/my_purchase_anywhere\(\)/);
        expect(plan).toMatch(/my_permission_entities\('integration\.manage'/);
      }
    });
  });
});

describe('parity per role (policy rows == authz.can_read_lead == expected list)', () => {
  it('every role in the synthetic world', async () => {
    await asOwner(db, async () => {
      const ids = await buildWorld();
      const cases: Array<[string, Actor, string[]]> = [
        // Own Lead in an enabled branch of an enabled entity only (not AMD/JDH without
        // membership, not the disabled DIS6/SC2 branches although she is Sales there).
        ['Sales own', OWNER, ['delA', 'c1A']],
        // Same branch, another owner's Leads are hidden; inactive SC1 membership hides c1B.
        ['other Sales same branch', SALES_B, ['delB']],
        // Own Lead in Delhi is hidden: the Sales membership is in Ahmedabad.
        ['Sales other branch', SALES_AMD, ['amdAmd']],
        // Every Delhi Lead (any owner, null owner); not SC2 (disabled branch), not SB1 (disabled entity).
        ['Manager own branch', MANAGER, ['delA', 'delB', 'delNull', 'delOwnerAmdSales', 'delMoved', 'delFormer', 'delManager']],
        // Ahmedabad only; inactive SC1 and invited JDH memberships give nothing.
        ['Manager other branch', MANAGER_AMD, ['amdAmd', 'amdA', 'amdNull']],
        ['Accounts', ACCOUNTS, []],
        ['Purchase', PURCHASE, []],
        ['Visa', VISA, []],
        // integration.manage (Super Admin): every Lead of the entity, disabled branch included.
        ['Super Admin (integration.manage)', SUPER, ALL_HC],
        ['Sales of a disabled entity', ENTITY_B_SALES, []],
        ['inactive membership (moved staff)', MOVED, []],
        ['inactive profile (former staff)', FORMER, []],
        ['invited profile', INVITED, []],
        ['Super Admin without second factor (aal1)', { userId: U.adminJodhpur, aal: 'aal1' }, []],
        ['Manager without second factor (aal1)', { userId: U.managerDelhi, aal: 'aal1' }, []],
        ['Sales without second factor (aal1)', { userId: U.salesDelhiA, aal: 'aal1' }, []],
        ['session older than the policy allows', { userId: U.managerDelhi, amr: amrAt(7 * 86400) }, []],
      ];
      for (const [label, actor, expected] of cases) {
        await expectVisibility(label, actor, ids, expected);
      }
    });
  });

  it('anonymous requests cannot read crm_leads at all', async () => {
    await asOwner(db, async () => {
      await buildWorld();
      await expectDbError(
        db,
        async () => {
          await setActor(db, { userId: null });
          await db.query('select id from public.crm_leads');
        },
        { code: '42501' },
      );
      await resetActor(db);
    });
  });

  it('Purchase combinations hide every Lead; inactive or invited Purchase does not', async () => {
    await asOwner(db, async () => {
      const ids = await buildWorld();
      await addMembership(U.salesDelhiB, HC, 'JDH', 'purchase');
      await addMembership(U.managerDelhi, HC, 'DEL', 'purchase');
      await addMembership(U.adminJodhpur, HC, 'JDH', 'purchase');
      // Purchase in a disabled entity still hides everything (any entity, any status of it).
      await addMembership(U.salesAhmedabad, 'SYNTHETIC_B', 'SB1', 'purchase');
      await addMembership(U.salesDelhiA, HC, 'JDH', 'purchase', 'inactive');
      await addMembership(U.salesDelhiA, HC, 'AMD', 'purchase', 'invited');
      await addMembership(U.managerAhmedabad, HC, 'AMD', 'purchase', 'inactive');
      await expectVisibility('Purchase + Sales', SALES_B, ids, []);
      await expectVisibility('Purchase + Manager', MANAGER, ids, []);
      await expectVisibility('Purchase + Super Admin', SUPER, ids, []);
      await expectVisibility('Purchase in a disabled entity + Sales', SALES_AMD, ids, []);
      await expectVisibility('inactive and invited Purchase + Sales', OWNER, ids, ['delA', 'c1A']);
      await expectVisibility('inactive Purchase + Manager', MANAGER_AMD, ids, ['amdAmd', 'amdA', 'amdNull']);
    });
  });

  it('integration.manage held through another role: entity scope shows the entity, own scope shows nothing', async () => {
    await asOwner(db, async () => {
      const ids = await buildWorld();
      await owner(
        `insert into public.role_permissions (role_code, permission_code, scope, policy_status, note) values
           ('accounts', 'integration.manage', 'entity', 'proposed', 'SYNTHETIC TEST: Batch 6 parity'),
           ('visa', 'integration.manage', 'own', 'proposed', 'SYNTHETIC TEST: Batch 6 parity')`,
      );
      await expectVisibility('Accounts with integration.manage (entity)', ACCOUNTS, ids, ALL_HC);
      await expectVisibility('Visa with integration.manage (own scope only)', VISA, ids, []);
      // An integration.manage admin membership in a disabled entity grants nothing there.
      await addMembership(U.adminJodhpur, 'SYNTHETIC_B', 'SB1', 'super_admin');
      await expectVisibility('Super Admin also in a disabled entity', SUPER, ids, ALL_HC);
      // ... and in enabled entity C through an enabled branch it grants the whole entity C,
      // disabled SC2 branch Leads included.
      await addMembership(U.adminJodhpur, 'SYNTHETIC_C6', 'SC1', 'super_admin');
      await expectVisibility('Super Admin in two entities', SUPER, ids, [...ALL_HC, 'c1A', 'c1B', 'c1Null', 'c2A', 'c2Null']);
    });
  });

  it('an integration.manage access grant (not a role permission) gives no Lead, as in authz.can_read_lead', async () => {
    await asOwner(db, async () => {
      const ids = await buildWorld();
      // Entity-wide and branch grants, live, for Accounts and for Sales Delhi B.
      await owner(
        `insert into public.access_grants (user_id, permission_code, legal_entity_id, branch_id, reason, granted_by, starts_at)
         select g.user_id::uuid, 'integration.manage', e.id, b.id, 'SYNTHETIC TEST: Batch 6 grant parity', $1::uuid, now() - interval '1 day'
         from (values ($2, null), ($3, 'DEL')) as g (user_id, branch_code)
         join public.legal_entities e on e.code = 'HOLIDAY_CHACHA'
         left join public.branches b on b.legal_entity_id = e.id and b.code = g.branch_code`,
        [U.adminJodhpur, U.accountsJodhpur, U.salesDelhiB],
      );
      await expectVisibility('Accounts with an entity-wide integration.manage grant', ACCOUNTS, ids, []);
      await expectVisibility('Sales B with a Delhi integration.manage grant', SALES_B, ids, ['delB']);
    });
  });

  it('switching an entity or branch off (or on) changes visibility exactly as the function says', async () => {
    await asOwner(db, async () => {
      const ids = await buildWorld();
      await owner(`update public.legal_entities set status = 'disabled' where id = $1`, [ENTITY_C]);
      await owner(`update public.branches set status = 'enabled' where id = $1`, [BRANCH_DIS]);
      await expectVisibility('Sales own, entity C off, DIS6 on', OWNER, ids, ['delA', 'disA']);
      await owner(
        `update public.branches set status = 'disabled'
         where code = 'DEL' and legal_entity_id = (select id from public.legal_entities where code = 'HOLIDAY_CHACHA')`,
      );
      await expectVisibility('Sales own, Delhi off', OWNER, ids, ['disA']);
      await expectVisibility('Manager, Delhi off', MANAGER, ids, []);
      // The admin's own branch (JDH) is still enabled: the whole entity stays visible.
      await expectVisibility('Super Admin, Delhi off', SUPER, ids, ALL_HC);
      await owner(`update public.legal_entities set status = 'enabled' where id = (select legal_entity_id from public.branches where id = $1)`, ['b0000000-0000-4000-8000-0000000000b1']);
      await expectVisibility('Manager, entity B on', MANAGER, ids, ['sbEntityB', 'sbNull']);
      await expectVisibility('Sales of entity B, entity B on', ENTITY_B_SALES, ids, ['sbEntityB']);
    });
  });

  it('owner changes: a Lead given to nobody or to another person moves exactly as the function says', async () => {
    await asOwner(db, async () => {
      const ids = await buildWorld();
      await owner('update public.crm_leads set owner_user_id = null where id = $1', [ids.get('delA')]);
      await owner('update public.crm_leads set owner_user_id = $2 where id = $1', [ids.get('delB'), U.salesDelhiA]);
      await expectVisibility('Sales own after the change', OWNER, ids, ['delB', 'c1A']);
      await expectVisibility('Sales B after the change', SALES_B, ids, []);
      await expectVisibility('Manager after the change', MANAGER, ids, ['delA', 'delB', 'delNull', 'delOwnerAmdSales', 'delMoved', 'delFormer', 'delManager']);
    });
  });
});

// ===========================================================================
// Volume: 10,000 synthetic Leads, old rule vs new rule
// ===========================================================================

const SEARCH_SQL = 'select public.crm_search($1, $2, null, 20) as r';
const OLD_POLICY = 'create policy scoped_read on public.crm_leads for select to authenticated using (authz.can_read_lead(id))';
// Generous: the new rule must not be slower than the old one (expected: many times faster).
const NOT_SLOWER_FACTOR = 1.2;
const NOT_SLOWER_SLACK_MS = 50;

function p95(samples: number[]): number {
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]!;
}
function median(samples: number[]): number {
  return [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
}

describe('volume', () => {
  it('10,000 Leads: list count and Lead search, old rule vs new rule, same rows', { timeout: 900_000 }, async () => {
    await asOwner(db, async () => {
      // 40% Sales Delhi A, 40% Sales Delhi B, 10% Ahmedabad (Sales Ahmedabad), 10% Delhi without owner.
      await owner(
        `with spec as (
           select g as n, gen_random_uuid() as inbox_id from generate_series(1, 10000) g
         ), inbox as (
           insert into public.integration_inbox (id, portal_member_id, event_type, source_deal_id, source_ts, dedupe_key, status,
                                                 next_attempt_at, processed_at, origin, source_object)
           select inbox_id, 'SYNTHETIC_MEMBER_0001', 'ONCRMLEADADD', 7000000 + n, 1790000000 + n,
                  encode(sha256(convert_to('b6-volume-lead-' || n || '-' || gen_random_uuid(), 'UTF8')), 'hex'), 'processed', null, now(), 'event', 'lead'
           from spec returning id
         )
         insert into public.crm_leads (legal_entity_id, branch_id, reference, title, owner_user_id, source_portal, source_lead_id,
           source_status_id, source_id_code, source_created_at, source_modified_at, last_synced_at, last_verified_at, intake_inbox_id, intake_mode)
         select b.legal_entity_id, b.id, 'BXL-' || (7000000 + s.n), 'Synthetic volume lead ' || s.n,
                case when s.n % 10 < 4 then $1::uuid when s.n % 10 < 8 then $2::uuid when s.n % 10 = 8 then $3::uuid end,
                $4, 7000000 + s.n, 'NEW', 'WEB', now() - interval '1 day', now(), now(), now(), s.inbox_id, 'scope'
         from spec s
         join public.legal_entities e on e.code = 'HOLIDAY_CHACHA'
         join public.branches b on b.legal_entity_id = e.id and b.code = case when s.n % 10 = 8 then 'AMD' else 'DEL' end
         where exists (select 1 from inbox i where i.id = s.inbox_id)`,
        [U.salesDelhiA, U.salesDelhiB, U.salesAhmedabad, PORTAL],
      );
      await owner('analyze public.crm_leads, public.memberships, public.branches, public.legal_entities, public.integration_inbox');
      const [volume] = await owner<{ n: number }>('select count(*)::int as n from public.crm_leads where source_portal = $1', [PORTAL]);
      expect(Number(volume!.n)).toBe(10000);

      const actors: Array<[string, Actor]> = [['Manager', MANAGER], ['Sales own', OWNER]];
      const queries = ['BXL-70012', 'nomatchzz'];
      type Timing = { count: number[]; search: Record<string, number[]> };
      /**
       * Times the list count and each search `samples` times per actor and keeps
       * the first search page of each query (compared between the rules below).
       * The old rule costs about 1-2 s per call on PGlite, so it runs the minimum
       * that still gives a median (3) and no separate warm-up (its row read runs first).
       */
      const measure = async (samples: number, warmUp: boolean) => {
        const times: Record<string, Timing> = {};
        const pages: Record<string, unknown> = {};
        for (const [label, actor] of actors) {
          const t: Timing = { count: [], search: Object.fromEntries(queries.map((q) => [q, [] as number[]])) };
          if (warmUp) await run(actor, 'select count(*) from public.crm_leads');
          for (let i = 0; i < samples; i++) {
            let t0 = performance.now();
            await run(actor, 'select count(*) from public.crm_leads');
            t.count.push(performance.now() - t0);
            for (const q of queries) {
              t0 = performance.now();
              const [row] = await run<{ r: unknown }>(actor, SEARCH_SQL, [q, 'lead']);
              t.search[q]!.push(performance.now() - t0);
              if (i === 0) pages[`${label} ${q}`] = row!.r;
            }
          }
          times[label] = t;
        }
        return { times, pages };
      };
      const rowsOf = async () => {
        const out: Record<string, string[]> = {};
        for (const [label, actor] of actors) {
          out[label] = sorted((await run<{ id: string }>(actor, 'select id from public.crm_leads')).map((r) => r.id));
        }
        return out;
      };

      const newRows = await rowsOf();
      expect(newRows.Manager).toHaveLength(9000 + (await owner<{ n: number }>(
        `select count(*)::int as n from public.crm_leads l join public.branches b on b.id = l.branch_id
         where b.code = 'DEL' and l.source_portal <> $1`, [PORTAL]))[0]!.n);
      expect(newRows['Sales own']).toHaveLength(4000 + (await owner<{ n: number }>(
        `select count(*)::int as n from public.crm_leads l join public.branches b on b.id = l.branch_id
         where b.code = 'DEL' and l.owner_user_id = $2 and l.source_portal <> $1`, [PORTAL, U.salesDelhiA]))[0]!.n);
      const { times: newTimes, pages: newSearch } = await measure(7, true);

      // The old rule, re-created inside this rolled-back transaction.
      await owner('drop policy scoped_read on public.crm_leads');
      await owner(OLD_POLICY);
      const oldRows = await rowsOf();
      const { times: oldTimes, pages: oldSearch } = await measure(3, false);

      expect(newRows, 'same Leads under the old and the new rule').toEqual(oldRows);
      expect(newSearch, 'same search pages under the old and the new rule').toEqual(oldSearch);

      const report: string[] = [];
      for (const [label] of actors) {
        const o = oldTimes[label]!;
        const w = newTimes[label]!;
        report.push(`${db.mode} ${label} Leads list count: old median ${median(o.count).toFixed(1)} ms p95 ${p95(o.count).toFixed(1)} ms; ` +
          `new median ${median(w.count).toFixed(1)} ms p95 ${p95(w.count).toFixed(1)} ms`);
        expect(median(w.count), `${label} count`).toBeLessThan(median(o.count) * NOT_SLOWER_FACTOR + NOT_SLOWER_SLACK_MS);
        for (const q of queries) {
          report.push(`${db.mode} ${label} Lead search "${q}": old median ${median(o.search[q]!).toFixed(1)} ms p95 ${p95(o.search[q]!).toFixed(1)} ms; ` +
            `new median ${median(w.search[q]!).toFixed(1)} ms p95 ${p95(w.search[q]!).toFixed(1)} ms`);
          expect(median(w.search[q]!), `${label} search ${q}`).toBeLessThan(median(o.search[q]!) * NOT_SLOWER_FACTOR + NOT_SLOWER_SLACK_MS);
        }
      }
      console.info(`[batch6-lead-visibility volume]\n${report.join('\n')}`);
    });
  });
});
