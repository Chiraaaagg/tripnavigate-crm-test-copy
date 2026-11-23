import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listVisibleDeals, loadDealsPage, PAGE_SIZE } from '@/modules/deals/server/queries';
import { FIXTURE_DEALS, FIXTURE_EMAILS, FIXTURE_USERS } from '../helpers/db';
import { createRealStack, resolveRealStackEnv, type SignedIn } from '../helpers/real-stack';

/**
 * Speed plan C3 on the REAL Data API: the Deals list reads each deal's active
 * assignments and the owner's display name as embedded resources of one
 * request (PostgREST resource embedding, same RLS as separate reads). Signed in
 * as a Sales user (aal2): own deal shows the owner name, a deal assigned to the
 * viewer shows as "assigned", and an ended assignment is not returned.
 *
 * The viewer is Sales Delhi A. session-recovery.real.test.ts completes an MFA
 * recovery for Sales Delhi B; after that only sessions on B's recovered factor
 * are valid, so B cannot sign in again with a fresh factor in the same run.
 */

const env = resolveRealStackEnv();
const stack = env ? createRealStack(env) : null;
const dbUrl = process.env.TEST_DATABASE_URL?.trim() ?? '';

describe.skipIf(!stack || !dbUrl)('Deals list embed (real stack, speed plan C3)', () => {
  let db: pg.Client;
  let sales: SignedIn;
  const VIEWER = FIXTURE_USERS.salesDelhiA;
  const added: string[] = [];

  beforeAll(async () => {
    if (!['localhost', '127.0.0.1'].includes(new URL(dbUrl).hostname)) throw new Error('local database only');
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    // SYNTHETIC FIXTURE: Sales Delhi A gets an active and an ended assignment on Sales Delhi B's deal.
    const { rows } = await db.query<{ id: string }>(
      `insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, ended_at)
       select d.id, d.legal_entity_id, $2, k.kind, k.ended
       from public.deals d, (values ('sales', null::timestamptz), ('visa', now())) as k(kind, ended)
       where d.id = $1 returning id`,
      [FIXTURE_DEALS.del002, VIEWER],
    );
    added.push(...rows.map((r) => r.id));
    sales = await stack!.signInAal2(FIXTURE_EMAILS.salesDelhiA, VIEWER);
  }, 120_000);

  afterAll(async () => {
    await stack?.cleanup();
    if (db && added.length) await db.query('delete from public.deal_assignments where id = any($1)', [added]);
    await db?.end();
  });

  function staffFor(signedIn: SignedIn) {
    return {
      userId: VIEWER,
      access: { userId: VIEWER, memberships: [], rolePermissions: [], grants: [] },
      supabase: signedIn.client,
    } as never;
  }

  it('loads owner names and active assignments through PostgREST embedding', async () => {
    const [own] = (await db.query<{ display_name: string }>('select display_name from public.staff_profiles where user_id = $1', [VIEWER])).rows;
    // Other real-stack suites add deals in parallel, so the fixture deals may sit
    // beyond page 1: read every page instead of assuming their position.
    const items = [];
    for (let n = 1; n <= 40; n += 1) {
      const page = await listVisibleDeals(staffFor(sales), n);
      items.push(...page.items);
      if (page.items.length < PAGE_SIZE) break;
    }
    const owned = items.find((d) => d.id === FIXTURE_DEALS.del001);
    expect(owned, 'own deal visible').toBeDefined();
    expect(owned).toMatchObject({ relation: 'owner', ownerName: own!.display_name });

    const assigned = items.find((d) => d.id === FIXTURE_DEALS.del002);
    expect(assigned, 'assigned deal visible').toMatchObject({ relation: 'assigned' });
    // DEC-52 (B1-4): the owner of a deal the viewer can read is named through record_staff_names,
    // although staff_profiles RLS still hides that profile from a direct read by the same session.
    const direct = await sales.client.from('staff_profiles').select('display_name').eq('user_id', FIXTURE_USERS.salesDelhiB).maybeSingle();
    expect(direct.error).toBeNull();
    expect(direct.data, 'profile RLS unchanged: a colleague profile stays unreadable directly').toBeNull();
    const [ownerB] = (await db.query<{ display_name: string }>('select display_name from public.staff_profiles where user_id = $1', [FIXTURE_USERS.salesDelhiB])).rows;
    expect(assigned!.ownerName).toBe(ownerB!.display_name);

    // Raw request: only the active assignment is embedded; the ended one is filtered out.
    const raw = await sales.client
      .from('deals')
      .select('id, deal_assignments(user_id, assignment_kind), owner:staff_profiles!deals_owner_user_id_fkey(display_name)')
      .is('deal_assignments.ended_at', null)
      .eq('id', FIXTURE_DEALS.del002)
      .single();
    expect(raw.error).toBeNull();
    expect(raw.data!.deal_assignments.filter((a) => a.user_id === VIEWER)).toEqual([{ user_id: VIEWER, assignment_kind: 'sales' }]);

    // Read both at the same moment so parallel inserts cannot shift page 1 between them.
    const [{ total, list }, firstPage] = await Promise.all([loadDealsPage(staffFor(sales), 1), listVisibleDeals(staffFor(sales), 1)]);
    expect(total).toBeGreaterThanOrEqual(2);
    expect(list.items.map((d) => d.id)).toEqual(firstPage.items.map((d) => d.id));
  });
});
