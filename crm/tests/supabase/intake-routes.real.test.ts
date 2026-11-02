import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isRealStackRequired } from '@/lib/config';
import type { WorkerRunSummary } from '@/modules/integration/contracts';
import { FIXTURE_EMAILS, FIXTURE_USERS, assertDatabaseUrlNotOperational, closeRunManifests, istBusinessDate, openRunManifest } from '../helpers/db';
import { startMockBitrix, syntheticDeal, type MockBitrix } from '../helpers/mock-bitrix';
import { createRealStack, resolveRealStackEnv, type SignedIn } from '../helpers/real-stack';

/**
 * END-TO-END Phase 2 intake through the RUNNING Next app (APP_BASE_URL, `next
 * start` against the real local Supabase stack) and an in-process MOCK Bitrix
 * server (never the real portal):
 *
 *   POST /api/integrations/bitrix/events  (form body like Bitrix sends)
 *   POST /api/integrations/bitrix/worker  (Bearer INTAKE_WORKER_SECRET)
 *     -> crm.deal.get on the mock -> integration_apply_bitrix_deal
 *   -> deal visible via the Data API to the mapped owner only.
 *
 * Uses agent B's synthetic intake fixture (portal SYNTHETIC_MEMBER_0001 at
 * synthetic-portal.example.test, category 7, stages C7:NEW/C7:PREPARATION,
 * Bitrix user 101 -> Synthetic Sales Delhi A, pilot branch Delhi).
 *
 * The app reads BITRIX_WEBHOOK_BASE_URL (a loopback mock URL; accepted only with
 * APP_ENV=local), BITRIX_EVENT_APPLICATION_TOKEN and INTAKE_WORKER_SECRET from
 * the CI job env; this test starts the mock on that URL's port. All values are
 * synthetic. FAILS (never skips) when REQUIRE_REAL_STACK=1 and anything is missing.
 */

const MEMBER = 'SYNTHETIC_MEMBER_0001';
const DOMAIN = 'synthetic-portal.example.test';
const OWNER_BITRIX_ID = '101';
const LOCAL = new Set(['127.0.0.1', 'localhost']);

const env = resolveRealStackEnv();
const required = ['BITRIX_WEBHOOK_BASE_URL', 'BITRIX_EVENT_APPLICATION_TOKEN', 'INTAKE_WORKER_SECRET', 'TEST_DATABASE_URL'] as const;
const missing = required.filter((n) => !process.env[n]?.trim());
if (env && missing.length > 0 && isRealStackRequired(process.env)) {
  throw new Error(`REQUIRE_REAL_STACK=1 but intake route configuration is missing: ${missing.join(', ')}`);
}
const enabled = env !== null && missing.length === 0;
const stack = env ? createRealStack(env) : null;

const TOKEN = process.env.BITRIX_EVENT_APPLICATION_TOKEN?.trim() ?? '';
const SECRET = process.env.INTAKE_WORKER_SECRET?.trim() ?? '';
const baseUrl = enabled ? new URL(process.env.BITRIX_WEBHOOK_BASE_URL!.trim()) : null;
if (baseUrl && !LOCAL.has(baseUrl.hostname)) throw new Error('intake route test runs only against a loopback mock Bitrix');
const webhook = baseUrl ? /^\/rest\/(\d+)\/([^/]+)\/?$/.exec(baseUrl.pathname) : null;
if (enabled && !webhook) throw new Error('BITRIX_WEBHOOK_BASE_URL must look like http://127.0.0.1:<port>/rest/<user>/<code>/');

const dbUrl = process.env.TEST_DATABASE_URL?.trim() ?? '';
if (enabled && !LOCAL.has(new URL(dbUrl).hostname)) throw new Error('cleanup runs only against a local database');

// Random per run so the suite is re-runnable; distinct from B's 8.0M range.
const base = 9_100_000 + Math.floor(Math.random() * 800_000) * 10;
const ids = { eligible: base + 1, unmapped: base + 2, reconciled: base + 3, ignored: base + 4, outside: base + 5 };
const used = Object.values(ids);
/** Phase 6: the run's Deal manifest (outside is deliberately not in it). */
const SOURCE = 'SYNTHETIC_SRC';
let manifestId = '';
let ts = Math.floor(Date.now() / 1000);

let mock: MockBitrix;
let owner: SignedIn;
let otherSales: SignedIn;

const app = (path: string) => `${env!.appBaseUrl}${path}`;

function eventForm(dealId: number, over: Record<string, string> = {}): string {
  return new URLSearchParams({
    event: 'ONCRMDEALADD',
    event_handler_id: '1',
    'data[FIELDS][ID]': String(dealId),
    ts: String((ts += 1)),
    'auth[domain]': DOMAIN,
    'auth[member_id]': MEMBER,
    'auth[application_token]': TOKEN,
    'auth[client_endpoint]': 'http://127.0.0.1:9/never-fetched/',
    ...over,
  }).toString();
}

const postEvent = (body: string, headers: Record<string, string> = {}) =>
  fetch(app('/api/integrations/bitrix/events'), {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    redirect: 'manual',
  });

const runWorker = (query = '', auth = `Bearer ${SECRET}`) =>
  fetch(app(`/api/integrations/bitrix/worker${query}`), { method: 'POST', headers: { authorization: auth }, redirect: 'manual' });

async function inboxRows(dealId: number) {
  const { data, error } = await stack!
    .admin()
    .from('integration_inbox')
    .select('id, status, reason_code, last_error_code, origin')
    .eq('portal_member_id', MEMBER)
    .eq('source_deal_id', dealId);
  if (error) throw error;
  return data ?? [];
}

/** Inbox statuses no worker changes any more (or not before a back-off). */
const SETTLED = new Set(['processed', 'ignored', 'needs_review', 'failed', 'dead_letter']);

/**
 * Sync completion §1: the events route schedules a bounded live batch with
 * after(), so a recorded row may be processed before this test calls the
 * worker. Bounded poll until `done` holds (or the timeout), then return the rows.
 */
async function waitForInbox(
  dealId: number,
  done: (rows: Awaited<ReturnType<typeof inboxRows>>) => boolean,
  timeoutMs = 20_000,
): Promise<Awaited<ReturnType<typeof inboxRows>>> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const rows = await inboxRows(dealId);
    if (done(rows) || Date.now() > until) return rows;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
const allSettled = (rows: Array<{ status: string }>) => rows.length > 0 && rows.every((r) => SETTLED.has(r.status));

async function dbQuery<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

/** Database clock (recorded_at is set by Postgres). */
async function dbNow(): Promise<Date> {
  return (await dbQuery<{ now: Date }>('select now() as now'))[0]!.now;
}

/** Worker heartbeats (integration_worker_runs.run_trigger, sync completion §7) recorded since `since`. */
async function workerRunsSince(since: Date): Promise<Array<{ trigger: string | null; created: number; outcome: string }>> {
  return dbQuery(
    `select run_trigger as trigger, created, outcome from public.integration_worker_runs
     where kind = 'worker' and recorded_at >= $1 order by recorded_at`,
    [since.toISOString()],
  );
}

async function drainWorker(): Promise<WorkerRunSummary[]> {
  const runs: WorkerRunSummary[] = [];
  for (let i = 0; i < 10; i += 1) {
    const res = await runWorker('?limit=25');
    expect(res.status).toBe(200);
    const summary = (await res.json()) as WorkerRunSummary;
    runs.push(summary);
    if (summary.claimed === 0) break;
  }
  return runs;
}

async function visibleSourceIds(client: SignedIn['client']): Promise<number[]> {
  const { data, error } = await client.from('deals').select('source_deal_id').in('source_deal_id', used);
  if (error) throw error;
  return (data ?? []).map((d) => Number(d.source_deal_id));
}

beforeAll(async () => {
  if (!enabled) return;
  await assertDatabaseUrlNotOperational(dbUrl);
  // Mock deals below are created "now": the manifest covers today's business date (IST).
  manifestId = await openRunManifest(dbUrl, {
    object: 'deal', ids: [ids.eligible, ids.unmapped, ids.reconciled, ids.ignored], sourceCode: SOURCE,
    businessDate: istBusinessDate(),
  });
  mock = await startMockBitrix({ port: Number(baseUrl!.port), userId: Number(webhook![1]), webhookCode: webhook![2] });
  const now = new Date().toISOString();
  mock.deals.set(String(ids.eligible), syntheticDeal(ids.eligible, { STAGE_ID: 'C7:NEW', ASSIGNED_BY_ID: OWNER_BITRIX_ID, DATE_CREATE: now, DATE_MODIFY: now, SOURCE_ID: SOURCE }));
  mock.deals.set(String(ids.unmapped), syntheticDeal(ids.unmapped, { STAGE_ID: 'C7:NEW', ASSIGNED_BY_ID: '999999', DATE_CREATE: now, DATE_MODIFY: now, SOURCE_ID: SOURCE }));
  mock.deals.set(String(ids.ignored), syntheticDeal(ids.ignored, { CATEGORY_ID: '0', STAGE_ID: 'NEW', DATE_CREATE: now, DATE_MODIFY: now, SOURCE_ID: SOURCE }));
  owner = await stack!.signInAal2(FIXTURE_EMAILS.salesDelhiA, FIXTURE_USERS.salesDelhiA);
  otherSales = await stack!.signInAal2(FIXTURE_EMAILS.salesDelhiB, FIXTURE_USERS.salesDelhiB);
});

afterAll(async () => {
  if (enabled) {
    await closeRunManifests(dbUrl, manifestId ? [manifestId] : []);
    const client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
    try {
      await client.query('begin');
      await client.query(
        `update public.integration_inbox set processed_deal_id = null where portal_member_id = $1 and source_deal_id = any($2::bigint[])`,
        [MEMBER, used],
      );
      // Owner 'sales' assignments are created by the import (20261007000100).
      await client.query(
        `delete from public.deal_assignments where deal_id in (
           select id from public.deals where source_system = 'bitrix' and source_portal = $1 and source_deal_id = any($2::bigint[]))`,
        [MEMBER, used],
      );
      await client.query(
        `delete from public.deals where source_system = 'bitrix' and source_portal = $1 and source_deal_id = any($2::bigint[])`,
        [MEMBER, used],
      );
      await client.query(`delete from public.integration_inbox where portal_member_id = $1 and source_deal_id = any($2::bigint[])`, [MEMBER, used]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
    await mock?.close();
  }
  await stack?.cleanup();
});

describe.skipIf(!enabled)('Phase 2 intake routes through the running app (mock Bitrix)', () => {
  it('P2-01: wrong token, wrong portal, missing auth -> 401 and nothing stored; proxy does not redirect', async () => {
    const cases: Array<Record<string, string>> = [
      { 'auth[application_token]': 'synthetic-wrong-token' },
      { 'auth[member_id]': 'OTHER_MEMBER' },
      { 'auth[domain]': 'other.example.test' },
      { 'auth[application_token]': '' },
    ];
    for (const over of cases) {
      const res = await postEvent(eventForm(ids.eligible, over));
      expect(res.status).toBe(401);
      const text = await res.text();
      expect(text).not.toContain(TOKEN);
    }
    expect(await inboxRows(ids.eligible)).toHaveLength(0);
  });

  it('P2-02: oversized and malformed bodies -> 413/400, nothing stored', async () => {
    expect((await postEvent(`${eventForm(ids.eligible)}&pad=${'a'.repeat(17 * 1024)}`)).status).toBe(413);
    expect((await postEvent(eventForm(ids.eligible, { 'data[FIELDS][ID]': 'abc' }))).status).toBe(400);
    expect((await postEvent(eventForm(ids.eligible), { 'content-type': 'application/json' })).status).toBe(400);
    expect(await inboxRows(ids.eligible)).toHaveLength(0);
  });

  it('P2-03: same delivery twice -> one inbox row; the live batch (or the worker) creates one deal visible only to the mapped owner', async () => {
    const since = await dbNow();
    const body = eventForm(ids.eligible);
    const first = await postEvent(body);
    const second = await postEvent(body);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await first.json()).toEqual({ ok: true });
    expect(await inboxRows(ids.eligible)).toHaveLength(1);

    expect((await postEvent(eventForm(ids.unmapped))).status).toBe(200);
    expect((await postEvent(eventForm(ids.ignored))).status).toBe(200);

    // Sync completion §1: each pending row gets a live batch after the 200; wait for
    // them to settle, then drain whatever is left (usually nothing).
    for (const id of [ids.eligible, ids.unmapped, ids.ignored]) await waitForInbox(id, allSettled);
    await drainWorker();
    const runs = await workerRunsSince(since);
    // The creation is counted by whichever run did it (live 'event' batch or the worker).
    expect(runs.reduce((n, r) => n + r.created, 0)).toBeGreaterThanOrEqual(1);
    expect(runs.every((r) => r.trigger === 'event' || r.trigger === 'manual' || r.trigger === 'cron')).toBe(true);
    expect(runs.some((r) => r.trigger === 'event')).toBe(true);
    expect(
      await dbQuery(`select id from public.deals where source_portal = $1 and source_deal_id = $2`, [MEMBER, ids.eligible]),
    ).toHaveLength(1);
    expect(mock.requests.every((r) => r.authorized)).toBe(true);
    expect(mock.requests.some((r) => r.path.includes('never-fetched'))).toBe(false);

    expect(await inboxRows(ids.eligible)).toEqual([expect.objectContaining({ status: 'processed' })]);
    // main's intake guards (20261009001000): an unmapped owner is held for review, never stored ownerless.
    expect(await inboxRows(ids.unmapped)).toEqual([expect.objectContaining({ status: 'needs_review', reason_code: 'unmapped_owner' })]);
    expect(await inboxRows(ids.ignored)).toEqual([expect.objectContaining({ status: 'ignored', reason_code: 'not_eligible_category' })]);

    expect(await visibleSourceIds(owner.client)).toEqual([ids.eligible]);
    expect(await visibleSourceIds(otherSales.client)).toEqual([]);
    const { data } = await owner.client.from('deals').select('title, source_stage_id').eq('source_deal_id', ids.eligible).single();
    expect(data).toEqual({ title: `Synthetic trip ${ids.eligible}`, source_stage_id: 'C7:NEW' });
  });

  it('P2-11: reconcile finds a deal whose event was missed and imports it once', async () => {
    // The unmapped deal already sits in review; keep it out of this listing so the
    // counts below concern only the missed deal.
    mock.deals.delete(String(ids.unmapped));
    const now = new Date().toISOString();
    mock.deals.set(String(ids.reconciled), syntheticDeal(ids.reconciled, { STAGE_ID: 'C7:PREPARATION', ASSIGNED_BY_ID: OWNER_BITRIX_ID, DATE_CREATE: now, DATE_MODIFY: now, SOURCE_ID: SOURCE }));
    const res = await runWorker('?task=reconcile');
    expect(res.status).toBe(200);
    const summary = (await res.json()) as { enqueued: number; alreadyCurrent: number };
    // Phase 6: reconcile enumerates the manifest ids; the category-0 id may also be re-checked.
    expect(summary.enqueued).toBeGreaterThanOrEqual(1);
    expect(summary.alreadyCurrent).toBeGreaterThanOrEqual(1); // the imported eligible deal
    expect(await inboxRows(ids.reconciled)).toEqual([expect.objectContaining({ status: 'pending', origin: 'reconcile' })]);
    // Already-imported eligible deal is up to date, so it is not re-enqueued.
    expect((await inboxRows(ids.eligible)).length).toBe(1);

    await drainWorker();
    const again = (await (await runWorker('?task=reconcile')).json()) as { enqueued: number };
    expect(await inboxRows(ids.reconciled)).toHaveLength(1);
    expect(again.enqueued).toBe(0);
    expect((await visibleSourceIds(owner.client)).sort()).toEqual([ids.eligible, ids.reconciled].sort());
  });

  it('Phase 6: an event outside the active manifest is acknowledged (200), stored ignored and never imported', async () => {
    const now = new Date().toISOString();
    mock.deals.set(String(ids.outside), syntheticDeal(ids.outside, { STAGE_ID: 'C7:NEW', ASSIGNED_BY_ID: OWNER_BITRIX_ID, DATE_CREATE: now, DATE_MODIFY: now, SOURCE_ID: SOURCE }));
    const res = await postEvent(eventForm(ids.outside));
    expect(res.status).toBe(200);
    expect(await inboxRows(ids.outside)).toEqual([expect.objectContaining({ status: 'ignored', reason_code: 'not_in_manifest' })]);
    await drainWorker();
    expect(await inboxRows(ids.outside)).toEqual([expect.objectContaining({ status: 'ignored', reason_code: 'not_in_manifest' })]);
    expect(await visibleSourceIds(owner.client)).not.toContain(ids.outside);
    mock.deals.delete(String(ids.outside));
  });

  it('P2-07: provider outage -> failed with provider_unavailable, retried later', async () => {
    const since = await dbNow();
    // Armed before delivery: the live batch scheduled by the events route makes the read.
    mock.failNext('crm.deal.get', { status: 500, body: { error: 'INTERNAL_SERVER_ERROR', error_description: 'synthetic outage' } });
    const res = await postEvent(eventForm(ids.eligible, { event: 'ONCRMDEALUPDATE' }));
    expect(res.status).toBe(200);
    const failedRow = (rows: Awaited<ReturnType<typeof inboxRows>>) =>
      rows.find((r) => r.status === 'failed' && r.last_error_code === 'provider_unavailable');
    const rows = await waitForInbox(ids.eligible, (r) => failedRow(r) !== undefined);
    const failed = failedRow(rows);
    expect(failed).toBeDefined();
    expect((await workerRunsSince(since)).some((r) => r.trigger === 'event' && r.outcome === 'provider_error')).toBe(true);

    // Retried later: end the back-off (as time passing would), then the worker succeeds.
    await dbQuery(`update public.integration_inbox set next_attempt_at = now() where id = $1 and status = 'failed'`, [failed!.id]);
    const summary = (await (await runWorker('?limit=25')).json()) as WorkerRunSummary;
    expect(summary.claimed).toBeGreaterThanOrEqual(1);
    const after = (await inboxRows(ids.eligible)).find((r) => r.id === failed!.id);
    expect(after?.status === 'processed' || after?.status === 'ignored').toBe(true);
  });

  it('M2: worker and reconcile runs leave a durable heartbeat', async () => {
    const count = async () => {
      const { count: n, error } = await stack!.admin().from('integration_worker_runs').select('*', { count: 'exact', head: true });
      if (error) throw error;
      return n ?? 0;
    };
    // Live batches (trigger 'event') from the events posted above may still finish
    // meanwhile; this run is the only 'manual' one.
    const manual = async () =>
      Number((await dbQuery<{ n: string }>(`select count(*) as n from public.integration_worker_runs where run_trigger = 'manual'`))[0]!.n);
    const before = await count();
    const manualBefore = await manual();
    expect((await runWorker()).status).toBe(200);
    expect(await manual()).toBe(manualBefore + 1);
    expect(await count()).toBeGreaterThanOrEqual(before + 1);
    expect(
      Number((await dbQuery<{ n: string }>(`select count(*) as n from public.integration_worker_runs where run_trigger = 'event'`))[0]!.n),
    ).toBeGreaterThanOrEqual(1);
  });

  it('worker route requires the bearer secret', async () => {
    expect((await runWorker('', 'Bearer synthetic-wrong-secret')).status).toBe(401);
    expect((await runWorker('', '')).status).toBe(401);
  });

  it('P2-13: no route response contains the token, worker secret or webhook code', async () => {
    const bodies = [
      await (await postEvent(eventForm(ids.eligible, { 'auth[application_token]': 'x' }))).text(),
      await (await runWorker('', 'Bearer x')).text(),
      await (await runWorker()).text(),
    ];
    for (const body of bodies) {
      expect(body).not.toContain(TOKEN);
      expect(body).not.toContain(SECRET);
      expect(body).not.toContain(webhook![2]!);
    }
  });
});
