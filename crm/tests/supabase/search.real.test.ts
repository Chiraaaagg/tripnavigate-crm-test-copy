import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeSearchAfter, runCrmSearch } from '@/modules/search/server/crm-search';
import { FIXTURE_EMAILS, FIXTURE_USERS } from '../helpers/db';
import { createRealStack, resolveRealStackEnv, type SignedIn } from '../helpers/real-stack';

/**
 * Batch 5 search through the REAL Data API (PostgREST + row-level security +
 * aal2 sessions), migration 20261126000100_crm_search, called by the Atlas
 * wrapper exactly as the server action does (the person's own client, rpc as
 * POST). Policy coverage per role lives in tests/db/batch5-search.test.ts; this
 * file proves the wiring: grants, invoker scope, literal matching, cursors and
 * the not-installed / not-authorized mapping on a real stack.
 *
 * Synthetic Leads 6990001-6990004 are added and removed again (throwaway stack).
 */

const env = resolveRealStackEnv();
const stack = env ? createRealStack(env) : null;
const dbUrl = process.env.TEST_DATABASE_URL?.trim() ?? '';
const BASE = 6_990_000;

describe.skipIf(!stack || !dbUrl)('crm_search through the Data API (real stack)', () => {
  let db: pg.Client;
  let manager: SignedIn;
  let sales: SignedIn;
  let purchase: SignedIn;

  beforeAll(async () => {
    if (!['localhost', '127.0.0.1'].includes(new URL(dbUrl).hostname)) throw new Error('local database only');
    db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    const spec = [
      { n: BASE + 1, title: 'Realsearch 100% honeymoon', owner: FIXTURE_USERS.salesDelhiA },
      { n: BASE + 2, title: 'Realsearch 1000 honeymoon', owner: FIXTURE_USERS.salesDelhiA },
      { n: BASE + 3, title: 'Realsearch colleague lead', owner: FIXTURE_USERS.salesDelhiB },
      { n: BASE + 4, title: 'Realsearch fourth lead', owner: FIXTURE_USERS.salesDelhiA },
    ];
    await db.query(
      `with spec as (
         select * from jsonb_to_recordset($1::jsonb) as s (n bigint, title text, owner uuid)
       ), inbox as (
         insert into public.integration_inbox (portal_member_id, event_type, source_deal_id, source_ts, dedupe_key, status,
                                               next_attempt_at, processed_at, origin, source_object)
         select 'SYNTHETIC_MEMBER_0001', 'ONCRMLEADADD', s.n, 1790000000 + s.n,
                encode(sha256(convert_to('b5-real-' || s.n || '-' || gen_random_uuid(), 'UTF8')), 'hex'), 'processed', null, now(), 'event', 'lead'
         from spec s returning id, source_deal_id
       )
       insert into public.crm_leads (legal_entity_id, branch_id, reference, title, owner_user_id, source_portal, source_lead_id,
         source_status_id, source_id_code, source_created_at, source_modified_at, last_synced_at, last_verified_at, intake_inbox_id, intake_mode)
       select b.legal_entity_id, b.id, 'BXL-' || s.n, s.title, s.owner, 'synthetic-portal.example.test', s.n, 'NEW', 'WEB',
              now() - interval '1 day', now(), now(), now(), i.id, 'scope'
       from spec s join inbox i on i.source_deal_id = s.n
       join public.legal_entities e on e.code = 'HOLIDAY_CHACHA'
       join public.branches b on b.legal_entity_id = e.id and b.code = 'DEL'`,
      [JSON.stringify(spec)],
    );
    manager = await stack!.signInAal2(FIXTURE_EMAILS.managerDelhi, FIXTURE_USERS.managerDelhi);
    sales = await stack!.signInAal2(FIXTURE_EMAILS.salesDelhiA, FIXTURE_USERS.salesDelhiA);
    purchase = await stack!.signInAal2(FIXTURE_EMAILS.purchaseJodhpur, FIXTURE_USERS.purchaseJodhpur);
  });

  afterAll(async () => {
    await stack?.cleanup();
    if (!db) return;
    await db.query(`delete from public.crm_leads where source_portal = 'synthetic-portal.example.test' and source_lead_id between $1 and $2`, [BASE + 1, BASE + 4]);
    await db.query(`delete from public.integration_inbox where source_object = 'lead' and source_deal_id between $1 and $2`, [BASE + 1, BASE + 4]);
    await db.end();
  });

  const as = (s: SignedIn) => ({ supabase: s.client as never });

  it('hits are exactly the matching rows of the person list (Manager, Sales own), in list order', async () => {
    const mgr = await runCrmSearch(as(manager), 'lead', 'Realsearch', null);
    if (!mgr.ok) throw new Error(`manager search failed: ${mgr.code}`);
    expect(mgr.page.hits.map((h) => h.reference)).toEqual([`BXL-${BASE + 4}`, `BXL-${BASE + 3}`, `BXL-${BASE + 2}`, `BXL-${BASE + 1}`]);
    const own = await runCrmSearch(as(sales), 'lead', 'Realsearch', null);
    if (!own.ok) throw new Error(`sales search failed: ${own.code}`);
    const listed = await sales.client.from('crm_leads').select('id').in('id', own.page.hits.map((h) => h.id));
    expect(listed.error).toBeNull();
    expect(new Set((listed.data ?? []).map((r) => r.id))).toEqual(new Set(own.page.hits.map((h) => h.id)));
    expect(own.page.hits.map((h) => h.reference)).not.toContain(`BXL-${BASE + 3}`);
    // Deals: every hit is readable by the person through the list read.
    const deals = await runCrmSearch(as(sales), 'deal', 'SYN-DEL', null);
    if (!deals.ok) throw new Error(`deal search failed: ${deals.code}`);
    const readable = await sales.client.from('deals').select('id').in('id', deals.page.hits.map((h) => h.id));
    expect((readable.data ?? []).length).toBe(deals.page.hits.length);
  });

  it('% matches literally; Purchase finds no Lead; a cursor round-trips; anon is refused; under 2 characters never calls', async () => {
    const literal = await runCrmSearch(as(manager), 'lead', '100%', null);
    expect(literal.ok && literal.page.hits.map((h) => h.reference)).toEqual([`BXL-${BASE + 1}`]);
    const none = await runCrmSearch(as(purchase), 'lead', 'Realsearch', null);
    expect(none).toMatchObject({ ok: true, page: { hits: [], nextAfter: null } });
    const anon = await runCrmSearch({ supabase: stack!.anon() as never }, 'deal', 'SYN-DEL', null);
    expect(anon).toEqual({ ok: false, query: 'SYN-DEL', code: 'not_authorized' });
    expect(await runCrmSearch(as(manager), 'lead', ' R ', null)).toEqual({ ok: false, query: 'R', code: 'too_short' });
    // A page of 1 through the database read itself, then the wrapper's opaque cursor.
    const first = await manager.client.rpc('crm_search', { p_query: 'Realsearch', p_kind: 'lead', p_after: null, p_limit: 1 });
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({ hasMore: true, next: { n: String(BASE + 4) } });
    const next = (first.data as { next: { n: string | null; id: string } }).next;
    const rest = await runCrmSearch(as(manager), 'lead', 'Realsearch', encodeSearchAfter(next));
    expect(rest.ok && rest.page.hits.map((h) => h.reference)).toEqual([`BXL-${BASE + 3}`, `BXL-${BASE + 2}`, `BXL-${BASE + 1}`]);
    const tampered = await runCrmSearch(as(manager), 'lead', 'Realsearch', 'bm90LWEtY3Vyc29y');
    expect(tampered).toEqual({ ok: false, query: 'Realsearch', code: 'unexpected' });
  });
});
