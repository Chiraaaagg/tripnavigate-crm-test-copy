import type { SupabaseClient } from '@supabase/supabase-js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isRealStackRequired } from '@/lib/config';
import {
  FIXTURE_EMAILS,
  FIXTURE_USERS as U,
  SYNTHETIC_INTAKE_CONFIG,
  assertDatabaseUrlNotOperational,
  closeRunManifests,
  openRunManifest,
} from '../helpers/db';
import { createRealStack, resolveRealStackEnv, type SignedIn } from '../helpers/real-stack';

/**
 * Phase 6 lead screens (lead-screens-contract.md section 4) against the REAL
 * local Supabase stack: crm_leads visibility and public.intake_scope_status()
 * through PostgREST with real aal2 / aal1 / anon sessions.
 *
 * Synthetic data only. The run opens its own Lead manifest on the synthetic
 * intake config (random ids), records one inbox row and inserts three
 * synthetic Lead headers through a direct LOCAL owner connection. Temporary
 * membership and staff-status changes are reverted in finally blocks.
 * afterAll closes the manifest and removes this run's Leads and inbox rows;
 * audit rows are append-only and stay.
 *
 * Positive reads by a second Sales owner and by another branch's manager use
 * two Auth users created for this run only (synthetic @example.test). Fixture
 * users are shared with suites that change them permanently: session-recovery
 * T02/T06 completes an MFA recovery for salesDelhiB, after which only sessions
 * using that case's re-enrolled factor are valid (authz.recovered_session_allowed),
 * and a later file's fresh factor sees nothing. Every positive assertion also
 * reports the viewer's memberships, staff status, recovery cases and session
 * state on failure.
 *
 * Runs only in CI; fails (never skips) when REQUIRE_REAL_STACK=1 and the stack
 * or TEST_DATABASE_URL is missing.
 */

const env = resolveRealStackEnv();
const stack = env ? createRealStack(env) : null;
const MEMBER = 'SYNTHETIC_MEMBER_0001';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function databaseUrl(): string | null {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    if (env && isRealStackRequired(process.env)) throw new Error('REQUIRE_REAL_STACK=1 but TEST_DATABASE_URL is missing');
    return null;
  }
  if (!LOCAL_HOSTS.has(new URL(url).hostname)) throw new Error('lead screens real-stack setup runs only against a local database');
  return url;
}
const dbUrl = env ? databaseUrl() : null;
const enabled = env !== null && dbUrl !== null;

// Distinct from the intake (20M-110M) and scope-race (300M-400M) suites' ranges.
const base = 500_000_000 + Math.floor(Math.random() * 900_000) * 10;
const IDS = [base, base + 1, base + 2, base + 3];
const REF = { delA: `BXL-${base}`, delB: `BXL-${base + 1}`, amd: `BXL-${base + 2}` };
const manifestIds: string[] = [];
const runTag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
interface RunUser { id: string; email: string }
const runUsers: RunUser[] = [];

async function ownerQuery<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: dbUrl! });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

/** Runs fn with a temporary active membership, then removes exactly that row. */
async function withMembership<T>(user: string, branchCode: string, role: string, fn: () => Promise<T>): Promise<T> {
  const [row] = await ownerQuery<{ id: string }>(
    `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
     select $1, b.legal_entity_id, b.id, $3, 'active' from public.branches b where b.code = $2
     returning id`,
    [user, branchCode, role],
  );
  try {
    return await fn();
  } finally {
    await ownerQuery('delete from public.memberships where id = $1', [row!.id]);
  }
}

const refs = async (client: SupabaseClient): Promise<string[]> => {
  const r = await client.from('crm_leads').select('reference').in('source_lead_id', IDS).order('reference');
  expect(r.error).toBeNull();
  return (r.data ?? []).map((x: { reference: string }) => x.reference);
};
const scope = (client: SupabaseClient) => client.rpc('intake_scope_status');

/** Creates an active synthetic staff user for this run with one active membership. */
async function createRunUser(label: string, branchCode: string, role: string): Promise<RunUser> {
  const email = `lead-screens.${label}.${runTag}@example.test`;
  const created = await stack!.admin().auth.admin.createUser({ email, password: env!.fixturePassword, email_confirm: true });
  if (created.error) throw created.error;
  const user = { id: created.data.user!.id, email };
  runUsers.push(user);
  await ownerQuery(
    `insert into public.staff_profiles (user_id, display_name, work_email, status, activated_at)
     values ($1, $2, $3, 'active', now())`,
    [user.id, `Synthetic lead screens ${label}`, email],
  );
  await ownerQuery(
    `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
     select $1, b.legal_entity_id, b.id, $3, 'active'
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
     where e.code = 'HOLIDAY_CHACHA' and b.code = $2`,
    [user.id, branchCode, role],
  );
  return user;
}

/** Viewer prerequisites as the database sees them, for assertion messages. */
async function viewerState(userId: string, client: SupabaseClient): Promise<string> {
  const [row] = await ownerQuery<{ state: unknown }>(
    `select jsonb_build_object(
       'staff', (select p.status from public.staff_profiles p where p.user_id = $1),
       'memberships', (select coalesce(jsonb_agg(jsonb_build_object('entity', e.code, 'branch', b.code, 'role', m.role_code, 'status', m.status)
                         order by e.code, b.code, m.role_code), '[]'::jsonb)
                       from public.memberships m join public.branches b on b.id = m.branch_id
                       join public.legal_entities e on e.id = m.legal_entity_id where m.user_id = $1),
       'recoveryCases', (select coalesce(jsonb_agg(c.status order by c.created_at), '[]'::jsonb)
                         from public.mfa_recovery_cases c where c.user_id = $1),
       'sessionsValidAfter', (select s.sessions_valid_after from public.staff_security_state s where s.user_id = $1)) as state`,
    [userId],
  );
  const session = await client.rpc('my_session_status');
  return JSON.stringify({ ...(row!.state as object), sessionStatus: session.error ? session.error.message : (session.data as { state?: string })?.state });
}

/** Asserts the exact visible references, with the viewer's state in the failure message. */
async function expectRefs(who: string, userId: string, client: SupabaseClient, expected: string[]): Promise<void> {
  const actual = await refs(client);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    expect(actual, `${who}: ${await viewerState(userId, client)}`).toEqual(expected);
  }
}

let salesA: SignedIn;
let salesB: SignedIn;
let manager: SignedIn;
let managerAmd: SignedIn;
let runSalesB: RunUser;
let runManagerAmd: RunUser;
let admin: SignedIn;
let purchase: SignedIn;
let salesAal1: SignedIn;

beforeAll(async () => {
  if (!enabled) return;
  await assertDatabaseUrlNotOperational(dbUrl!);
  manifestIds.push(await openRunManifest(dbUrl!, { object: 'lead', ids: IDS, sourceCode: 'WEBFORM', businessDate: '2026-10-04' }));
  const recorded = await stack!.admin().rpc('integration_record_bitrix_event', {
    p_member_id: MEMBER, p_event_type: 'ONCRMLEADADD', p_deal_id: base, p_source_ts: Math.floor(Date.now() / 1000),
  });
  if (recorded.error) throw recorded.error;
  const inboxId = (recorded.data as { inboxId: string }).inboxId;
  runSalesB = await createRunUser('sales-del', 'DEL', 'sales');
  runManagerAmd = await createRunUser('manager-amd', 'AMD', 'manager');
  await ownerQuery(
    `insert into public.crm_leads (legal_entity_id, branch_id, reference, title, owner_user_id, source_portal, source_lead_id,
       source_status_id, source_id_code, source_created_at, source_modified_at, last_synced_at, last_verified_at, intake_inbox_id, manifest_id)
     select b.legal_entity_id, b.id, 'BXL-' || v.id, 'Synthetic screen lead (CI)', v.owner::uuid, $1, v.id,
            'NEW', 'WEBFORM', now(), now(), now(), now(), $2, $3
     from (values ($4::bigint, 'DEL', $5::text), ($4::bigint + 1, 'DEL', $6::text), ($4::bigint + 2, 'AMD', $7::text)) as v (id, code, owner)
     join public.branches b on b.code = v.code
     join public.legal_entities e on e.id = b.legal_entity_id and e.code = 'HOLIDAY_CHACHA'`,
    [MEMBER, inboxId, manifestIds[0], base, U.salesDelhiA, runSalesB.id, U.salesAhmedabad],
  );
  salesA = await stack!.signInAal2(FIXTURE_EMAILS.salesDelhiA, U.salesDelhiA);
  salesB = await stack!.signInAal2(runSalesB.email, runSalesB.id);
  manager = await stack!.signInAal2(FIXTURE_EMAILS.managerDelhi, U.managerDelhi);
  managerAmd = await stack!.signInAal2(runManagerAmd.email, runManagerAmd.id);
  admin = await stack!.signInAal2(FIXTURE_EMAILS.adminJodhpur, U.adminJodhpur);
  purchase = await stack!.signInAal2(FIXTURE_EMAILS.purchaseJodhpur, U.purchaseJodhpur);
  salesAal1 = await stack!.signIn(FIXTURE_EMAILS.salesDelhiA);
  expect(await stack!.aal(salesAal1.client)).toBe('aal1');
});

afterAll(async () => {
  if (!enabled) return;
  try {
    await closeRunManifests(dbUrl!, manifestIds);
    const client = new pg.Client({ connectionString: dbUrl! });
    await client.connect();
    try {
      await client.query('begin');
      await client.query(`delete from public.crm_leads where source_portal = $1 and source_lead_id = any($2::bigint[])`, [MEMBER, IDS]);
      await client.query(
        `delete from public.integration_inbox where portal_member_id = $1 and source_object = 'lead' and source_deal_id = any($2::bigint[])`,
        [MEMBER, IDS],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  } finally {
    try {
      await stack!.cleanup();
    } finally {
      // Run users: profile rows first (auth.users is ON DELETE RESTRICT), then Auth.
      for (const user of runUsers) {
        await ownerQuery('delete from public.memberships where user_id = $1', [user.id]);
        await ownerQuery('delete from public.staff_security_state where user_id = $1', [user.id]);
        await ownerQuery('delete from public.staff_profiles where user_id = $1', [user.id]);
        const removed = await stack!.admin().auth.admin.deleteUser(user.id);
        if (removed.error) throw removed.error;
      }
    }
  }
});

describe.skipIf(!enabled)('Phase 6 lead screens through PostgREST', () => {
  it('owner sees own lead; other Sales owner and other branch do not', async () => {
    await expectRefs('owner', U.salesDelhiA, salesA.client, [REF.delA]);
    await expectRefs('other Sales owner', runSalesB.id, salesB.client, [REF.delB]);
    // Neither Delhi owner sees the Ahmedabad lead; the Ahmedabad manager sees only it.
    await expectRefs('other branch manager', runManagerAmd.id, managerAmd.client, [REF.amd]);
  });

  it('branch manager of the lead branch sees it, another branch manager does not, integration admin sees all', async () => {
    await expectRefs('Delhi manager', U.managerDelhi, manager.client, [REF.delA, REF.delB]);
    await expectRefs('Ahmedabad manager', runManagerAmd.id, managerAmd.client, [REF.amd]);
    await expectRefs('integration admin', U.adminJodhpur, admin.client, [REF.delA, REF.delB, REF.amd]);
  });

  it('aal1, inactive staff and a deactivated membership see nothing; anon is refused', async () => {
    expect(await refs(salesAal1.client)).toEqual([]);
    const anon = await stack!.anon().from('crm_leads').select('reference').in('source_lead_id', IDS);
    expect(anon.error?.code).toBe('42501');

    const [profile] = await ownerQuery<{ status: string; deactivated_at: string | null; deactivation_reason: string | null }>(
      'select status, deactivated_at, deactivation_reason from public.staff_profiles where user_id = $1', [U.salesDelhiA],
    );
    try {
      await ownerQuery(
        `update public.staff_profiles set status = 'inactive', deactivated_at = now(), deactivation_reason = 'SYNTHETIC CI lead screens'
         where user_id = $1`, [U.salesDelhiA],
      );
      expect(await refs(salesA.client)).toEqual([]);
    } finally {
      await ownerQuery(
        'update public.staff_profiles set status = $2, deactivated_at = $3, deactivation_reason = $4 where user_id = $1',
        [U.salesDelhiA, profile!.status, profile!.deactivated_at, profile!.deactivation_reason],
      );
    }
    await expectRefs('owner (restored)', U.salesDelhiA, salesA.client, [REF.delA]);

    const before = await ownerQuery<{ id: string; status: string; deactivated_at: string | null }>(
      `select id, status, deactivated_at from public.memberships where user_id = $1 and role_code = 'manager'`, [U.managerDelhi],
    );
    try {
      await ownerQuery(
        `update public.memberships set status = 'inactive', deactivated_at = now() where user_id = $1 and role_code = 'manager'`,
        [U.managerDelhi],
      );
      expect(await refs(manager.client)).toEqual([]);
    } finally {
      for (const m of before) {
        await ownerQuery('update public.memberships set status = $2, deactivated_at = $3 where id = $1', [m.id, m.status, m.deactivated_at]);
      }
    }
    await expectRefs('Delhi manager (restored)', U.managerDelhi, manager.client, [REF.delA, REF.delB]);
  });

  it('Purchase sees nothing: Purchase-only, Purchase+Sales owner in the entity, and Purchase in another entity', async () => {
    expect(await refs(purchase.client)).toEqual([]);
    expect((await scope(purchase.client)).error?.code).toBe('42501');
    await withMembership(U.purchaseJodhpur, 'DEL', 'sales', async () => {
      const [lead] = await ownerQuery<{ owner_user_id: string }>(
        'select owner_user_id from public.crm_leads where reference = $1', [REF.delB],
      );
      try {
        await ownerQuery('update public.crm_leads set owner_user_id = $2 where reference = $1', [REF.delB, U.purchaseJodhpur]);
        expect(await refs(purchase.client)).toEqual([]);
        const r = await scope(purchase.client);
        expect(r.error?.code).toBe('42501');
        expect(r.data).toBeNull();
      } finally {
        await ownerQuery('update public.crm_leads set owner_user_id = $2 where reference = $1', [REF.delB, lead!.owner_user_id]);
      }
    });
    await withMembership(U.salesDelhiA, 'SB1', 'purchase', async () => {
      expect(await refs(salesA.client)).toEqual([]);
    });
    await expectRefs('owner (restored)', U.salesDelhiA, salesA.client, [REF.delA]);
  });

  it('intake_scope_status returns the exact scope shape to the admin and refuses everyone else', async () => {
    const r = await scope(admin.client);
    expect(r.error).toBeNull();
    const view = r.data as { manifest: Record<string, unknown> | null; lastSuccessfulSyncAt: string | null };
    expect(Object.keys(view).sort()).toEqual(['lastSuccessfulSyncAt', 'manifest']);
    expect(view.lastSuccessfulSyncAt === null || /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(view.lastSuccessfulSyncAt)).toBe(true);
    expect(view.manifest).toStrictEqual({
      status: 'active',
      sourceObject: 'lead',
      sourceCode: 'WEBFORM',
      sourceCodeLabel: null,
      businessDate: '2026-10-04',
      intervalFrom: '2026-10-03T18:30:00.000Z',
      intervalTo: '2026-10-04T18:30:00.000Z',
      expectedCount: IDS.length,
      createdByOperator: 'real-stack-suite',
      createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
      closedAt: null,
      counts: { imported: 3, heldForReview: 0, failed: 0, excluded: 0 },
    });
    const text = JSON.stringify(view);
    for (const secret of [manifestIds[0]!, SYNTHETIC_INTAKE_CONFIG, MEMBER, String(base), 'Synthetic', '@']) {
      expect(text, secret).not.toContain(secret);
    }

    for (const [who, client] of [
      ['owner', salesA.client], ['manager', manager.client], ['purchase', purchase.client], ['aal1', salesAal1.client],
    ] as const) {
      const denied = await scope(client);
      expect(denied.error?.code, who).toBe('42501');
      expect(denied.data, who).toBeNull();
    }
    // An integration.manage admin holding Purchase in any entity is refused.
    await withMembership(U.adminJodhpur, 'SB1', 'purchase', async () => {
      const denied = await scope(admin.client);
      expect(denied.error?.code).toBe('42501');
      expect(denied.data).toBeNull();
    });
    expect((await scope(admin.client)).error).toBeNull();
    const anon = await scope(stack!.anon());
    expect(anon.error).not.toBeNull();
    expect(anon.data).toBeNull();
  });
});
