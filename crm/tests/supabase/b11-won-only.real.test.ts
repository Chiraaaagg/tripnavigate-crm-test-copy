import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isRealStackRequired } from '@/lib/config';
import { claimsFor, FIXTURE_EMAILS, FIXTURE_USERS, type Actor } from '../helpers/db';
import { createRealStack, resolveRealStackEnv } from '../helpers/real-stack';

/**
 * B1.1d Won-only Deal intake against the REAL local Supabase stack (migration
 * 20261119000400_b11_won_only_intake; freeze note 3.3; appendix C section 4).
 *
 *   1. Data API grants: Sales is refused (42501); a Super Admin at aal2 reaches
 *      the command (with the switch off the prune answers entry_stages_not_set,
 *      so nothing is written).
 *   2. Race: the real prune and Sales opening a booking draft on the same Deal
 *      in two connections. Either the draft exists and the Deal is kept, or the
 *      prune holds the Deal first and the draft waits for it; never both a
 *      removal and a new draft.
 *
 * Nothing here is committed except the synthetic Deals and booking drafts this
 * suite creates (SYN-B11W-*, removed in afterAll with their rows; audit rows
 * stay). The entry list and every prune run inside transactions that are rolled
 * back, so the local stack's other Deals are never pruned. Local database only;
 * runs when the real-stack configuration and TEST_DATABASE_URL are present and
 * FAILS (never skips) when REQUIRE_REAL_STACK=1 and anything is missing.
 */

const env = resolveRealStackEnv();
const stack = env ? createRealStack(env) : null;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function databaseUrl(): string | null {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    if (env && isRealStackRequired(process.env)) throw new Error('REQUIRE_REAL_STACK=1 but TEST_DATABASE_URL is missing');
    return null;
  }
  if (!LOCAL_HOSTS.has(new URL(url).hostname)) throw new Error('B1.1d real-stack setup runs only against a local database');
  return url;
}
const dbUrl = env ? databaseUrl() : null;
const enabled = env !== null && dbUrl !== null;

const MEMBER = 'SYNTHETIC_MEMBER_0001';
const WON = 'C7:WON';
const REASON = 'b11-won-only.real.test.ts synthetic run';
const ADMIN: Actor = { userId: FIXTURE_USERS.adminJodhpur };
const SALES: Actor = { userId: FIXTURE_USERS.salesDelhiA };
const runTag = Math.random().toString(36).slice(2, 8).toUpperCase();
const dealIds: string[] = [];
const inboxIds: string[] = [];
let nextSourceId = 880_000_000 + Math.floor(Math.random() * 1_000_000);

async function connect(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: dbUrl! });
  await client.connect();
  return client;
}

/**
 * A stored Bitrix Deal of the pilot branch, outside the entry stage, owned by Sales
 * Delhi A. deals_provenance requires every source column of an imported Deal,
 * including intake_inbox_id, so a finished ('processed') inbox row is written first:
 * a pending row would put the Deal in the prune's keptSyncPending bucket, and an
 * ignored not_eligible_* row would be requeued by the entry-list command. Both rows
 * are removed in afterAll (Deal first: it references the inbox row).
 */
async function createBitrixDeal(owner: pg.Client, suffix: string): Promise<string> {
  const id = (nextSourceId += 1);
  const inbox = await owner.query<{ id: string }>(
    `insert into public.integration_inbox
       (portal_member_id, source_object, event_type, source_deal_id, source_ts, dedupe_key, status, processed_at, next_attempt_at, origin)
     values ($1, 'deal', 'RECONCILE', $2, extract(epoch from now())::bigint,
             authz.intake_dedupe_key($1, 'B11W:' || $3, $2, 0), 'processed', now(), null, 'reconcile')
     returning id`,
    [MEMBER, id, runTag],
  );
  inboxIds.push(inbox.rows[0]!.id);
  const { rows } = await owner.query<{ id: string }>(
    `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id, is_synthetic,
       source_system, source_portal, source_deal_id, source_stage_id, source_category_id,
       source_created_at, source_modified_at, last_synced_at, last_verified_at, source_assigned_by_id, intake_inbox_id)
     select c.pilot_legal_entity_id, c.pilot_branch_id, $1, 'Synthetic B1.1d CI deal', $2, false,
       'bitrix', c.portal_member_id, $3, 'C7:NEW', 7, now() - interval '1 day', now() - interval '1 hour', now(), now(), 101, $5
     from public.integration_intake_config c where c.portal_member_id = $4
     returning id`,
    [`SYN-B11W-${runTag}-${suffix}`, FIXTURE_USERS.salesDelhiA, id, MEMBER, inbox.rows[0]!.id],
  );
  if (!rows[0]) throw new Error('synthetic intake config missing');
  dealIds.push(rows[0].id);
  return rows[0].id;
}

/** Impersonates a Data API request inside the open transaction (claims + SET LOCAL ROLE). */
async function actAs(client: pg.Client, actor: Actor): Promise<void> {
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claimsFor(actor))]);
  await client.query('set local role authenticated');
}

afterAll(async () => {
  try {
    if (enabled && (dealIds.length > 0 || inboxIds.length > 0)) {
      const client = await connect();
      try {
        await client.query('begin');
        // The guard trigger is disabled only inside this transaction (re-enabled before commit).
        await client.query('alter table public.booking_versions disable trigger booking_versions_a_guard');
        await client.query(
          `delete from public.outbox_events where aggregate_id in (select id from public.booking_versions where deal_id = any($1::uuid[]))`,
          [dealIds],
        );
        await client.query('delete from public.booking_version_commercials where version_id in (select id from public.booking_versions where deal_id = any($1::uuid[]))', [dealIds]);
        await client.query('delete from public.booking_versions where deal_id = any($1::uuid[])', [dealIds]);
        await client.query('alter table public.booking_versions enable trigger booking_versions_a_guard');
        await client.query('delete from public.deal_assignments where deal_id = any($1::uuid[])', [dealIds]);
        // Any later inbox row of these Deals (none expected) is removed with them.
        await client.query('update public.integration_inbox set processed_deal_id = null where processed_deal_id = any($1::uuid[])', [dealIds]);
        await client.query('delete from public.deals where id = any($1::uuid[])', [dealIds]);
        await client.query('delete from public.integration_inbox where id = any($1::uuid[])', [inboxIds]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        await client.end();
      }
    }
  } finally {
    // MFA factors and sessions of the signed-in users are always removed, even after a failed cleanup above.
    await stack?.cleanup();
  }
});

describe.skipIf(!enabled)('B1.1d Won-only intake against the real stack', () => {
  let owner: pg.Client;
  beforeAll(async () => {
    owner = await connect();
  });
  afterAll(async () => {
    await owner?.end();
  });

  it.skipIf(!stack)('Data API: Sales is refused; a Super Admin reaches the command, which writes nothing while the switch is off', async () => {
    const config = await owner.query<{ l: string[] | null }>('select deal_entry_stage_ids l from public.integration_intake_config where portal_member_id = $1', [MEMBER]);
    expect(config.rows).toEqual([{ l: null }]);
    const sales = await stack!.signInAal2(FIXTURE_EMAILS.salesDelhiA, FIXTURE_USERS.salesDelhiA);
    for (const [fn, args] of [
      ['integration_set_deal_entry_stages', { p_stage_ids: [WON], p_reason: REASON }],
      ['integration_prune_deals_outside_entry_stages', { p_reason: REASON, p_dry_run: true }],
    ] as const) {
      const res = await sales.client.rpc(fn, args);
      expect(res.error?.code).toBe('42501');
      expect(res.data).toBeNull();
    }
    const admin = await stack!.signInAal2(FIXTURE_EMAILS.adminJodhpur, FIXTURE_USERS.adminJodhpur);
    const dry = await admin.client.rpc('integration_prune_deals_outside_entry_stages', { p_reason: REASON, p_dry_run: true });
    expect(dry.error).toMatchObject({ code: '55000', message: 'entry_stages_not_set' });
    const before = (await owner.query(`select count(*)::int n from public.audit_events where action like 'integration.deals_prune%'`)).rows[0];
    const again = await admin.client.rpc('integration_prune_deals_outside_entry_stages', { p_reason: REASON, p_dry_run: true });
    expect(again.error?.code).toBe('55000');
    expect((await owner.query(`select count(*)::int n from public.audit_events where action like 'integration.deals_prune%'`)).rows[0]).toEqual(before);
  });

  it('a booking draft committed first keeps the Deal: the waiting prune sees the CRM work', async () => {
    const dealId = await createBitrixDeal(owner, 'DRAFT');
    const sales = await connect();
    const admin = await connect();
    try {
      await sales.query('begin');
      await actAs(sales, SALES);
      await sales.query('select public.booking_open_draft($1)', [dealId]);

      await admin.query('begin');
      await admin.query(`set local lock_timeout = '20s'`);
      await actAs(admin, ADMIN);
      await admin.query('select public.integration_set_deal_entry_stages($1::text[], $2)', [[WON], REASON]);
      // The real prune blocks on the Deal row the draft holds.
      const pruning = admin.query<{ r: { pruned: { deals: Array<{ id: string }> }; keptWithWork: { deals: Array<{ id: string; work: string[] }> } } }>(
        'select public.integration_prune_deals_outside_entry_stages($1, false) as r',
        [REASON],
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await sales.query('commit');
      const { r } = (await pruning).rows[0]!;
      expect(r.pruned.deals.map((d) => d.id)).not.toContain(dealId);
      expect(r.keptWithWork.deals.find((d) => d.id === dealId)?.work).toContain('booking_version');
      // Read the Deal row inside the same open transaction as the table owner: a Super
      // Admin has no Deal read under RLS, so the authenticated role would see no row.
      await admin.query('reset role');
      const [state] = (await admin.query<{ removed_at: string | null }>('select removed_at from public.deals where id = $1', [dealId])).rows;
      expect(state!.removed_at).toBeNull();
    } finally {
      // Never commit a prune on the shared local stack.
      await admin.query('rollback').catch(() => undefined);
      await sales.query('rollback').catch(() => undefined);
      await admin.end();
      await sales.end();
    }
  });

  it('a prune that holds the Deal first makes the booking draft wait until it finishes', async () => {
    const dealId = await createBitrixDeal(owner, 'PRUNE');
    const sales = await connect();
    const admin = await connect();
    try {
      await admin.query('begin');
      await actAs(admin, ADMIN);
      await admin.query('select public.integration_set_deal_entry_stages($1::text[], $2)', [[WON], REASON]);
      const { r } = (await admin.query<{ r: { pruned: { deals: Array<{ id: string }> } } }>(
        'select public.integration_prune_deals_outside_entry_stages($1, false) as r',
        [REASON],
      )).rows[0]!;
      expect(r.pruned.deals.map((d) => d.id)).toContain(dealId);

      await sales.query('begin');
      await sales.query(`set local lock_timeout = '20s'`);
      await actAs(sales, SALES);
      let finished = false;
      const opening = sales.query('select public.booking_open_draft($1)', [dealId]).then(
        () => { finished = true; return 'opened' as const; },
        (error: { message?: string }) => { finished = true; return error.message ?? 'refused'; },
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(finished).toBe(false);
      // The prune is rolled back (never committed on the shared stack), so the draft then opens.
      await admin.query('rollback');
      expect(await opening).toBe('opened');
    } finally {
      await sales.query('rollback').catch(() => undefined);
      await admin.query('rollback').catch(() => undefined);
      await admin.end();
      await sales.end();
    }
  });
});
