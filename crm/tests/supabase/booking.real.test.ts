import type { SupabaseClient } from '@supabase/supabase-js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BookingFacts, BookingReadiness, ConfirmBookingResult, OpenDraftResult } from '@/modules/fulfilment/contracts';
import { isRealStackRequired } from '@/lib/config';
import { FIXTURE_EMAILS, FIXTURE_USERS } from '../helpers/db';
import { createRealStack, resolveRealStackEnv, type SignedIn } from '../helpers/real-stack';

/**
 * Phase 3 booking database contract against the REAL local Supabase stack
 * (PostgREST + GoTrue + Postgres + Storage): true parallel confirmations and
 * draft opens (which PGlite cannot run), and RLS with real aal2/aal1/anon
 * sessions (P3-04, P3-07, P3-08, P3-12, P3-13, contract section 7 bucket).
 *
 * Each run creates its own SYNTHETIC deals (random SYN-BKG-* references, owner
 * Synthetic Sales Delhi A) through a direct LOCAL owner connection, and
 * afterAll removes them with their booking rows. Confirmed rows are immutable
 * by trigger, so cleanup disables the booking guard triggers inside its own
 * transaction as the table owner; this is a test-only local operation.
 * audit_events are append-only and stay.
 *
 * Runs only in CI; fails (never skips) when REQUIRE_REAL_STACK=1 and the stack
 * or TEST_DATABASE_URL is missing.
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
  if (!LOCAL_HOSTS.has(new URL(url).hostname)) throw new Error('booking real-stack setup runs only against a local database');
  return url;
}
const dbUrl = env ? databaseUrl() : null;
const enabled = env !== null && dbUrl !== null;

const FACTS: BookingFacts = {
  hotelName: 'Synthetic Hotel (CI fixture)',
  city: 'Synthetic City',
  checkIn: '2026-12-10',
  checkOut: '2026-12-12',
  rooms: 1,
  roomType: null,
  mealPlan: null,
  adults: 2,
  children: 0,
  inclusions: null,
  specialRequests: null,
  purchaseBudgetPaise: '3000000',
};
const SELLING = '7654321';
const runTag = Math.random().toString(36).slice(2, 8).toUpperCase();
const dealIds: string[] = [];
const objectPaths: string[] = [];

async function ownerQuery<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: dbUrl! });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

async function createDeal(suffix: string): Promise<string> {
  const [row] = await ownerQuery<{ id: string }>(
    `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id)
     select b.legal_entity_id, b.id, $1, 'Synthetic booking CI deal', $2
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
     where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL'
     returning id`,
    [`SYN-BKG-${runTag}-${suffix}`, FIXTURE_USERS.salesDelhiA],
  );
  dealIds.push(row!.id);
  return row!.id;
}

async function rpc<T>(client: SupabaseClient, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return data as T;
}

let owner: SignedIn;
let manager: SignedIn;
let purchase: SignedIn;

/** Draft with complete facts, selling total and one proof file really stored in Storage (A4 H2). */
async function readyDraft(dealId: string): Promise<{ versionId: string; hash: string; evidenceId: string }> {
  const opened = await rpc<OpenDraftResult>(owner.client, 'booking_open_draft', { p_deal_id: dealId });
  await rpc(owner.client, 'booking_save_draft', {
    p_version_id: opened.versionId,
    p_expected_row_version: opened.rowVersion,
    p_facts: FACTS,
    p_selling_total_paise: SELLING,
    p_selling_total_provided: true,
  });
  const ev = await rpc<{ evidenceId: string; objectPath: string }>(owner.client, 'booking_begin_evidence', {
    p_version_id: opened.versionId,
    p_kind: 'acceptance_message',
    p_file_name: 'acceptance.pdf',
    p_mime: 'application/pdf',
    p_size_bytes: 1024,
    p_sha256: 'c'.repeat(64),
  });
  // The server uploads with the secret key after DB authorization (synthetic bytes).
  const upload = await stack!
    .admin()
    .storage.from('booking-evidence')
    .upload(ev.objectPath, new Blob([new Uint8Array(1024).fill(37)], { type: 'application/pdf' }), {
      contentType: 'application/pdf',
      upsert: false,
    });
  if (upload.error) throw upload.error;
  objectPaths.push(ev.objectPath);
  const finished = await rpc<{ status: string }>(owner.client, 'booking_finish_evidence', { p_evidence_id: ev.evidenceId, p_ok: true });
  expect(finished.status).toBe('stored');
  const ready = await rpc<BookingReadiness>(owner.client, 'booking_readiness', { p_version_id: opened.versionId });
  expect(ready.ready).toBe(true);
  return { versionId: opened.versionId, hash: ready.contentHash, evidenceId: ev.evidenceId };
}

beforeAll(async () => {
  if (!enabled) return;
  owner = await stack!.signInAal2(FIXTURE_EMAILS.salesDelhiA, FIXTURE_USERS.salesDelhiA);
  manager = await stack!.signInAal2(FIXTURE_EMAILS.managerDelhi, FIXTURE_USERS.managerDelhi);
  purchase = await stack!.signInAal2(FIXTURE_EMAILS.purchaseJodhpur, FIXTURE_USERS.purchaseJodhpur);
});

afterAll(async () => {
  if (enabled && objectPaths.length > 0) {
    await stack!.admin().storage.from('booking-evidence').remove(objectPaths);
  }
  if (enabled && dealIds.length > 0) {
    const client = new pg.Client({ connectionString: dbUrl! });
    await client.connect();
    try {
      await client.query('begin');
      const guards: [string, string][] = [
        ['booking_versions', 'booking_versions_a_guard'],
        ['booking_version_commercials', 'booking_commercials_a_guard'],
        ['booking_version_commercials', 'booking_commercials_b_rehash'],
        ['booking_evidence', 'booking_evidence_a_guard'],
        ['fulfilment_tasks', 'fulfilment_tasks_a_guard'],
        // B1 (20261118000100): guards on the rows the hotel confirmation now creates.
        ['service_items', 'service_items_a_guard'],
        ['service_item_facts', 'service_item_facts_a_guard'],
        ['service_item_facts', 'service_item_facts_b_rehash'],
        ['booking_version_travellers', 'booking_version_travellers_a_guard'],
      ];
      for (const [table, trigger] of guards) await client.query(`alter table public.${table} disable trigger ${trigger}`);
      await client.query(
        `delete from public.outbox_events where aggregate_id in (
           select id from public.booking_versions where deal_id = any($1::uuid[])
           union select id from public.fulfilment_tasks where deal_id = any($1::uuid[]))`,
        [dealIds],
      );
      await client.query('delete from public.fulfilment_tasks where deal_id = any($1::uuid[])', [dealIds]);
      // B1 (20261118000100): the hotel confirmation also created the Deal's service item, its facts and the traveller snapshot.
      await client.query('delete from public.service_item_facts where service_item_id in (select id from public.service_items where deal_id = any($1::uuid[]))', [dealIds]);
      await client.query('delete from public.service_items where deal_id = any($1::uuid[])', [dealIds]);
      await client.query('delete from public.booking_version_travellers where booking_version_id in (select id from public.booking_versions where deal_id = any($1::uuid[]))', [dealIds]);
      await client.query('delete from public.deal_travellers where deal_id = any($1::uuid[])', [dealIds]);
      await client.query('delete from public.booking_evidence where deal_id = any($1::uuid[])', [dealIds]);
      await client.query(
        'delete from public.booking_version_commercials where version_id in (select id from public.booking_versions where deal_id = any($1::uuid[]))',
        [dealIds],
      );
      await client.query('delete from public.booking_versions where deal_id = any($1::uuid[])', [dealIds]);
      await client.query('delete from public.deal_assignments where deal_id = any($1::uuid[])', [dealIds]);
      await client.query('delete from public.deals where id = any($1::uuid[])', [dealIds]);
      for (const [table, trigger] of guards) await client.query(`alter table public.${table} enable trigger ${trigger}`);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
  await stack?.cleanup();
});

describe.skipIf(!enabled)('Phase 3 booking against the real stack', () => {
  let taskId = '';
  let versionId = '';
  let evidenceId = '';
  let confDealId = '';

  it('parallel draft opens create exactly one draft', async () => {
    const dealId = await createDeal('OPEN');
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => rpc<OpenDraftResult>(i % 2 ? manager.client : owner.client, 'booking_open_draft', { p_deal_id: dealId })),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.versionId)).size).toBe(1);
  });

  it('P3-04 / P3-12: N concurrent confirmations create one task and one pair of outbox rows', async () => {
    const dealId = await createDeal('CONF');
    confDealId = dealId;
    const ready = await readyDraft(dealId);
    versionId = ready.versionId;
    evidenceId = ready.evidenceId;
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        rpc<ConfirmBookingResult>(i % 2 ? manager.client : owner.client, 'booking_confirm', {
          p_version_id: ready.versionId,
          p_expected_content_hash: ready.hash,
        }),
      ),
    );
    expect(results.filter((r) => r.outcome === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'existing')).toHaveLength(7);
    expect(new Set(results.map((r) => r.taskId)).size).toBe(1);
    // Hotel confirmation always creates the task (B1.1 widened taskId to nullable).
    taskId = results[0]!.taskId!;
    expect(await ownerQuery('select id from public.fulfilment_tasks where deal_id = $1', [dealId])).toEqual([{ id: taskId }]);
    const outbox = await ownerQuery<{ event_type: string; payload: unknown }>(
      'select event_type, payload from public.outbox_events where aggregate_id in ($1, $2) order by event_type',
      [ready.versionId, taskId],
    );
    expect(outbox.map((o) => o.event_type)).toEqual(['booking.version_confirmed', 'fulfilment.task_created']);
    expect(JSON.stringify(outbox)).not.toMatch(new RegExp(`${SELLING}|3000000`));
  });

  it('P3-05: the confirmed version cannot be changed through the Data API', async () => {
    const write = await owner.client.from('booking_versions').update({ hotel_name: 'x' }).eq('id', versionId).select();
    expect(write.error?.code).toBe('42501');
    const save = await owner.client.rpc('booking_save_draft', {
      p_version_id: versionId,
      p_expected_row_version: 2,
      p_facts: FACTS,
      p_selling_total_paise: SELLING,
      p_selling_total_provided: true,
    });
    expect(save.error).toMatchObject({ code: '55000', message: 'already_confirmed' });
  });

  it('P3-07: Purchase reads no booking, commercial or evidence row; the task view carries only the budget', async () => {
    for (const table of ['booking_versions', 'booking_version_commercials', 'booking_evidence', 'deal_commercials']) {
      // booking_versions has a column grant (commercial_revision excluded), so name a column.
      const r = await purchase.client.from(table).select(table === 'deal_commercials' ? 'deal_id' : table === 'booking_version_commercials' ? 'version_id' : 'id');
      expect(r.error, table).toBeNull();
      expect(r.data ?? [], table).toEqual([]);
    }
    const star = await owner.client.from('booking_versions').select('*');
    expect(star.error?.code).toBe('42501');
    const rev = await owner.client.from('booking_versions').select('commercial_revision');
    expect(rev.error?.code).toBe('42501');
    const outbox = await purchase.client.from('outbox_events').select('*');
    expect(outbox.error?.code).toBe('42501');
    const detail = await rpc<Record<string, unknown>>(purchase.client, 'purchase_task_get', { p_task_id: taskId });
    expect(detail).toMatchObject({ taskId, purchaseBudgetPaise: '3000000', canClaim: true });
    expect(JSON.stringify(detail)).not.toMatch(new RegExp(`${SELLING}|selling|evidence`, 'i'));
    const dl = await purchase.client.rpc('booking_authorize_evidence_download', { p_evidence_id: evidenceId });
    expect(dl.error).toMatchObject({ code: '42501', message: 'not_authorized' });
    // The owner sees the selling total in the panel.
    const panel = await rpc<{ version: { sellingTotalPaise?: string } }>(owner.client, 'booking_panel', {
      p_deal_id: confDealId,
    });
    expect(panel.version.sellingTotalPaise).toBe(SELLING);
  });

  it('A4 H2: finish(true) with nothing in Storage records failed, not stored', async () => {
    const dealId = await createDeal('NOOBJ');
    const opened = await rpc<OpenDraftResult>(owner.client, 'booking_open_draft', { p_deal_id: dealId });
    const ev = await rpc<{ evidenceId: string }>(owner.client, 'booking_begin_evidence', {
      p_version_id: opened.versionId,
      p_kind: 'ticket',
      p_file_name: 'ticket.pdf',
      p_mime: 'application/pdf',
      p_size_bytes: 1024,
      p_sha256: 'e'.repeat(64),
    });
    const finished = await rpc<{ status: string }>(owner.client, 'booking_finish_evidence', { p_evidence_id: ev.evidenceId, p_ok: true });
    expect(finished.status).toBe('failed');
    const ready = await rpc<BookingReadiness>(owner.client, 'booking_readiness', { p_version_id: opened.versionId });
    expect(ready.issues).toContain('missing_acceptance_proof');
  });

  it('P3-13: Purchase claim is idempotent and creates the purchase assignment', async () => {
    const first = await rpc(purchase.client, 'purchase_task_claim', { p_task_id: taskId });
    expect(first).toEqual({ taskId, status: 'in_progress', assignedToYou: true, alreadyYours: false });
    const again = await rpc(purchase.client, 'purchase_task_claim', { p_task_id: taskId });
    expect(again).toMatchObject({ alreadyYours: true });
    const sales = await owner.client.rpc('purchase_task_claim', { p_task_id: taskId });
    expect(sales.error).toMatchObject({ code: '42501', message: 'not_authorized' });
    expect(
      await ownerQuery(
        `select assignment_kind from public.deal_assignments where deal_id = $1 and user_id = $2 and ended_at is null`,
        [confDealId, FIXTURE_USERS.purchaseJodhpur],
      ),
    ).toEqual([{ assignment_kind: 'purchase' }]);
  });

  it('P3-08: anon is refused every booking table and command; aal1 reads nothing', async () => {
    const tables = ['booking_settings', 'booking_versions', 'booking_version_commercials', 'booking_evidence', 'fulfilment_tasks', 'outbox_events'];
    for (const table of tables) {
      const anon = await stack!.anon().from(table).select(table === 'booking_version_commercials' ? 'version_id' : 'id');
      expect(anon.error?.code, table).toBe('42501');
    }
    const anonCall = await stack!.anon().rpc('booking_confirm', { p_version_id: versionId, p_expected_content_hash: 'a'.repeat(64) });
    expect(anonCall.error?.code).toBe('42501');
    const aal1 = await stack!.signIn(FIXTURE_EMAILS.salesDelhiA);
    for (const table of tables.filter((t) => t !== 'outbox_events')) {
      const r = await aal1.client.from(table).select(table === 'booking_version_commercials' ? 'version_id' : 'id');
      expect(r.data ?? [], table).toEqual([]);
    }
    const aal1Call = await aal1.client.rpc('booking_panel', { p_deal_id: confDealId });
    expect(aal1Call.error).toMatchObject({ code: '42501', message: 'not_authorized' });
  });

  it('section 7: the booking-evidence bucket is private and has no object policy', async () => {
    expect(
      await ownerQuery(`select public, file_size_limit::int as limit from storage.buckets where id = 'booking-evidence'`),
    ).toEqual([{ public: false, limit: 4194304 }]);
    const policies = await ownerQuery<{ policyname: string }>(
      `select policyname from pg_policies
       where schemaname = 'storage' and tablename = 'objects'
         and (coalesce(qual, '') like '%booking-evidence%' or coalesce(with_check, '') like '%booking-evidence%')`,
    );
    expect(policies).toEqual([]);
    const list = await owner.client.storage.from('booking-evidence').list(`${confDealId}`);
    expect(list.data ?? []).toEqual([]);
  });
});
