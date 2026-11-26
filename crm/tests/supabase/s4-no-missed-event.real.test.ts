import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isRealStackRequired } from '@/lib/config';
import { createPostgrestDeps, handleBitrixEventEdge } from '../../supabase/functions/bitrix-events/index';
import { assertDatabaseUrlNotOperational, closeRunManifests, istBusinessDate, openRunManifest } from '../helpers/db';
import { startMockBitrix, syntheticDeal, syntheticEventRequest, type MockBitrix } from '../helpers/mock-bitrix';
import { resolveRealStackEnv } from '../helpers/real-stack';

/**
 * S4 acceptance A3 and A4 on synthetic data (build contract
 * hosting-migration-2026-11-26/10, sections 2.3, 2.4 and 4): no Bitrix event
 * is missed and none is processed twice when the database wakes the worker
 * (event kick) and the safety tick runs as well.
 *
 * Production path for every event: the Edge Function's own handler with the
 * PUBLISHABLE key and a receiver credential -> public.integration_receive_bitrix_event
 * (real PostgREST, role anon), which records the row and, with the kick switch
 * on, queues one pg_net request and one integration_sync_dispatches row of
 * kind 'event'. The worker is the RUNNING app (APP_BASE_URL, next start
 * against the local stack) with an in-process MOCK Bitrix (never the real
 * portal).
 *
 * Kick delivery is relayed by this test: the database container cannot reach
 * the app on the runner's loopback, so the kick's Vault URL points at a
 * closed port and pg_net's own delivery fails harmlessly. For each new 'event'
 * dispatch row the test POSTs exactly the request the kick builds
 * (?task=batch&limit=25&source=event with the worker bearer; the request
 * itself is proved in s4-event-kick.real.test.ts). The tick is
 * POST ?task=sync.
 *
 * Shared-stack hygiene (CI run 45850197025 found two leaks from an earlier
 * version of this file):
 *   - Every worker answer runs the sync-stopped alert check (after()). With
 *     the sync switched on, it would open a committed incident (append and
 *     close only, so it cannot be removed) unless the sync looks running. The
 *     pg_cron job bitrix-sync therefore stays ACTIVE for the run (its ticks go
 *     to the closed port, harmless), and a synthetic ok reconcile heartbeat is
 *     written before every worker call. The last case checks that no incident
 *     was opened.
 *   - A full run (?task=sync) queues the daily full resync when none was queued
 *     in 24 hours; finishing it re-reads every stored Deal the mock does not
 *     list. A superseded guard row stops that for the run; it and any resync
 *     job created during the run are removed afterwards.
 * The schedule, kick switch and job state are restored in afterAll.
 *
 * "Processed twice" is checked per row: integration_claim_inbox adds one to
 * attempts on every claim, so a row claimed by two runs has attempts >= 2.
 *
 * Synthetic values only; FAILS (never skips) when REQUIRE_REAL_STACK=1 and
 * anything is missing. Refuses a stack that already holds Vault values under
 * the scheduler's names.
 */

const MEMBER = 'SYNTHETIC_MEMBER_0001';
const DOMAIN = 'synthetic-portal.example.test';
const SOURCE = 'SYNTHETIC_SRC';
const OWNER_BITRIX_ID = '101';
const LOCAL = new Set(['127.0.0.1', 'localhost']);
const SECRET_NAMES = ['bitrix_sync_url', 'bitrix_sync_bearer', 'vercel_protection_bypass'];
const NOTE = 's4 no-missed-event test';
const FN_URL = 'https://receiver.real-stack.example.test/functions/v1/bitrix-events';
const REASON = 'Synthetic S4 no-missed-event run, owner approval APPROVE';

const env = resolveRealStackEnv();
const required = ['BITRIX_WEBHOOK_BASE_URL', 'INTAKE_WORKER_SECRET', 'TEST_DATABASE_URL'] as const;
const missing = required.filter((n) => !process.env[n]?.trim());
if (env && missing.length > 0 && isRealStackRequired(process.env)) {
  throw new Error(`REQUIRE_REAL_STACK=1 but S4 configuration is missing: ${missing.join(', ')}`);
}
const enabled = env !== null && missing.length === 0;

const SECRET = process.env.INTAKE_WORKER_SECRET?.trim() ?? '';
const baseUrl = enabled ? new URL(process.env.BITRIX_WEBHOOK_BASE_URL!.trim()) : null;
if (baseUrl && !LOCAL.has(baseUrl.hostname)) throw new Error('S4 no-missed-event test runs only against a loopback mock Bitrix');
const webhook = baseUrl ? /^\/rest\/(\d+)\/([^/]+)\/?$/.exec(baseUrl.pathname) : null;
if (enabled && !webhook) throw new Error('BITRIX_WEBHOOK_BASE_URL must look like http://127.0.0.1:<port>/rest/<user>/<code>/');
const dbUrl = process.env.TEST_DATABASE_URL?.trim() ?? '';
if (enabled && !LOCAL.has(new URL(dbUrl).hostname)) throw new Error('S4 no-missed-event test runs only against a local database');

// Bitrix application token for this run (synthetic, random).
const TOKEN = randomBytes(16).toString('hex');
const credential = randomBytes(32).toString('base64url');
// Random per run; distinct from the other suites' ranges.
const base = 41_000_000 + Math.floor(Math.random() * 900_000) * 10;
const ids = {
  bursts: Array.from({ length: 150 }, (_, i) => base + i),
  overlap: Array.from({ length: 60 }, (_, i) => base + 200 + i),
  suppressed: Array.from({ length: 10 }, (_, i) => base + 300 + i),
  pulled: base + 400,
};
const used = [...ids.bursts, ...ids.overlap, ...ids.suppressed, ids.pulled];

let mock: MockBitrix;
let manifestId = '';
let startedAt: Date;
let saved: { enabled: boolean; kick: boolean; jobActive: boolean | null } | null = null;
let secretsCreated = false;
const heartbeats: string[] = [];
const delivered = new Set<string>();

async function dbQuery<T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

const nowTs = () => String(Math.floor(Date.now() / 1000));
const send = (dealId: number, event = 'ONCRMDEALADD') =>
  handleBitrixEventEdge(
    syntheticEventRequest(FN_URL, { applicationToken: TOKEN, memberId: MEMBER, domain: DOMAIN, ts: nowTs(), dealId: String(dealId), event }),
    { applicationToken: TOKEN, ...createPostgrestDeps({ supabaseUrl: env!.url, publishableKey: env!.publishableKey, receiverCredential: credential }) },
  );

/** A fresh ok reconcile heartbeat: the alert check after each worker answer sees the sync running. */
async function keepRunning(): Promise<void> {
  const [row] = await dbQuery<{ id: string }>(
    `insert into public.integration_worker_runs (kind, started_at, finished_at, outcome)
     values ('reconcile', now() - interval '1 second', now(), 'ok') returning id`,
  );
  heartbeats.push(row!.id);
}

const worker = async (query: string) => {
  await keepRunning();
  const res = await fetch(`${env!.appBaseUrl}/api/integrations/bitrix/worker${query}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SECRET}` },
    redirect: 'manual',
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
};
/** The request a kick of kind 'event' builds (frozen: task=batch&limit=25&source=event). */
const eventRun = () => worker('?task=batch&limit=25&source=event');
/** The safety tick's request. */
const tick = () => worker('?task=sync');

/** Relays every 'event' kick queued since the start that was not relayed yet (pg_net sends them concurrently). */
async function deliverKicks(): Promise<number> {
  const rows = await dbQuery<{ id: string }>(
    `select request_id::text as id from public.integration_sync_dispatches where kind = 'event' and dispatched_at >= $1 order by dispatched_at`,
    [startedAt.toISOString()],
  );
  const fresh = rows.map((r) => r.id).filter((id) => !delivered.has(id));
  for (const id of fresh) delivered.add(id);
  const answers = await Promise.all(fresh.map(() => eventRun()));
  for (const a of answers) expect(a.status).toBe(200);
  return fresh.length;
}

const rowsFor = (dealIds: number[]) =>
  dbQuery<{ id: string; deal: string; status: string; reason_code: string | null; attempts: number }>(
    `select id, source_deal_id::text as deal, status, reason_code, attempts from public.integration_inbox
     where portal_member_id = $1 and source_deal_id = any($2::bigint[]) order by received_at, id`,
    [MEMBER, dealIds],
  );
const FINISHED = (r: { status: string; reason_code: string | null }) =>
  r.status === 'processed' || (r.status === 'ignored' && r.reason_code === 'stale_ignored');
async function createdAudits(dealIds: number[]): Promise<Map<string, number>> {
  const rows = await dbQuery<{ deal: string; n: number }>(
    `select d.source_deal_id::text as deal, count(a.id)::int as n
     from public.deals d left join public.audit_events a on a.target_id = d.id and a.action = 'integration.deal_created'
     where d.source_system = 'bitrix' and d.source_portal = $1 and d.source_deal_id = any($2::bigint[])
     group by 1`,
    [MEMBER, dealIds],
  );
  return new Map(rows.map((r) => [r.deal, r.n]));
}
const eventDispatchesSince = async (since: Date) =>
  Number((await dbQuery<{ n: number }>(
    `select count(*)::int as n from public.integration_sync_dispatches where kind = 'event' and dispatched_at >= $1`,
    [since.toISOString()],
  ))[0]!.n);
const dbNow = async () => (await dbQuery<{ now: Date }>('select now() as now'))[0]!.now;
const putDeal = (id: number, overrides: Record<string, string> = {}) => {
  const now = new Date().toISOString();
  mock.deals.set(String(id), syntheticDeal(id, {
    STAGE_ID: 'C7:NEW', ASSIGNED_BY_ID: OWNER_BITRIX_ID, DATE_CREATE: now, DATE_MODIFY: now, SOURCE_ID: SOURCE, ...overrides,
  }));
};

beforeAll(async () => {
  if (!enabled) return;
  await assertDatabaseUrlNotOperational(dbUrl);
  startedAt = await dbNow();
  // Disposable CI stack: the approved operator sequence (as auto-sync.real.test.ts).
  await dbQuery('create extension if not exists pg_cron');
  await dbQuery('create extension if not exists pg_net with schema extensions');
  await dbQuery('select authz.provision_bitrix_sync_jobs()');
  const existing = await dbQuery<{ n: number }>('select count(*)::int as n from vault.secrets where name = any($1)', [SECRET_NAMES]);
  if (existing[0]!.n > 0) throw new Error('refusing to run: this stack already holds Vault values under the scheduler names (bitrix_sync_*)');

  const [schedule] = await dbQuery<{ enabled: boolean; kick: boolean }>('select enabled, kick_enabled as kick from public.integration_sync_schedule');
  const [job] = await dbQuery<{ active: boolean }>(`select active from cron.job where jobname = 'bitrix-sync'`);
  saved = { enabled: schedule!.enabled, kick: schedule!.kick, jobActive: job?.active ?? null };
  // Active job + fresh heartbeat = "running" for the alert check (see the header).
  await dbQuery(`select cron.alter_job(jobid, active := true) from cron.job where jobname = 'bitrix-sync'`);
  await keepRunning();
  // No daily full resync during the run (see the header).
  const open = await dbQuery<{ n: number }>(
    `select count(*)::int as n from public.integration_resync_jobs where portal_member_id = $1 and status in ('queued', 'running')`,
    [MEMBER],
  );
  if (open[0]!.n > 0) throw new Error('refusing to run: a full resync is open on this stack');
  await dbQuery(
    `insert into public.integration_resync_jobs (portal_member_id, reason, status, cutoff_at, category_ids, stage_ids)
     select c.portal_member_id, 'manual', 'superseded', c.cutoff_at, array[c.category_id]::bigint[], c.eligible_stage_ids
     from public.integration_intake_config c where c.portal_member_id = $1`,
    [MEMBER],
  );

  // The kick's Vault values: synthetic, pointing at a closed port inside the database container.
  await dbQuery('select vault.create_secret($1, $2)', ['http://127.0.0.1:9/api/integrations/bitrix/worker', 'bitrix_sync_url']);
  await dbQuery('select vault.create_secret($1, $2)', [randomBytes(24).toString('hex'), 'bitrix_sync_bearer']);
  secretsCreated = true;

  await dbQuery('delete from public.integration_receiver_credentials where note = $1', [NOTE]);
  await dbQuery(`insert into public.integration_receiver_credentials (slot, credential_sha256, note) values (2, decode($1, 'hex'), $2)`, [
    createHash('sha256').update(credential, 'utf8').digest('hex'),
    NOTE,
  ]);
  // Mock deals are created "now": the manifest covers today's business date (IST).
  manifestId = await openRunManifest(dbUrl, { object: 'deal', ids: used, sourceCode: SOURCE, businessDate: istBusinessDate() });
  mock = await startMockBitrix({ port: Number(baseUrl!.port), userId: Number(webhook![1]), webhookCode: webhook![2] });
  // Each case adds its own records to the mock just before it runs, so an earlier
  // tick's pull never sees a later case's records.
  for (const id of ids.bursts) putDeal(id);

  await dbQuery('update public.integration_sync_schedule set enabled = true, updated_at = now() where id');
  await dbQuery('select authz.set_bitrix_sync_kick(true, $1)', [REASON]);
}, 120_000);

afterAll(async () => {
  if (!enabled) return;
  try {
    if (saved) {
      await dbQuery('select authz.set_bitrix_sync_kick($1, $2)', [saved.kick, REASON]);
      await dbQuery('update public.integration_sync_schedule set enabled = $1, updated_at = now() where id', [saved.enabled]);
      if (saved.jobActive !== null) {
        await dbQuery(`select cron.alter_job(jobid, active := $1) from cron.job where jobname = 'bitrix-sync'`, [saved.jobActive]);
      }
    }
    if (secretsCreated) await dbQuery('delete from vault.secrets where name = any($1)', [SECRET_NAMES]);
    await dbQuery('delete from public.integration_receiver_credentials where note = $1', [NOTE]);
    await closeRunManifests(dbUrl, manifestId ? [manifestId] : []);
    const client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
    try {
      await client.query('begin');
      await client.query(
        `update public.integration_inbox set processed_deal_id = null where portal_member_id = $1 and source_deal_id = any($2::bigint[])`,
        [MEMBER, used],
      );
      await client.query(
        `delete from public.deal_assignments where deal_id in (
           select id from public.deals where source_system = 'bitrix' and source_portal = $1 and source_deal_id = any($2::bigint[]))`,
        [MEMBER, used],
      );
      await client.query(`delete from public.deals where source_system = 'bitrix' and source_portal = $1 and source_deal_id = any($2::bigint[])`, [MEMBER, used]);
      await client.query(`delete from public.integration_inbox where portal_member_id = $1 and source_deal_id = any($2::bigint[])`, [MEMBER, used]);
      // This run's scheduler, event and follow-up calls and synthetic heartbeats (machine log rows of the disposable stack).
      await client.query(`delete from public.integration_sync_dispatches where dispatched_at >= $1`, [startedAt.toISOString()]);
      await client.query('delete from public.integration_worker_runs where id = any($1::uuid[])', [heartbeats]);
      // The resync guard row and any resync job a full run created.
      await client.query(
        `delete from public.integration_resync_seen where job_id in (
           select id from public.integration_resync_jobs where portal_member_id = $1 and created_at >= $2)`,
        [MEMBER, startedAt.toISOString()],
      );
      await client.query(`delete from public.integration_resync_jobs where portal_member_id = $1 and created_at >= $2`, [MEMBER, startedAt.toISOString()]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  } finally {
    await mock?.close();
  }
}, 120_000);

describe.skipIf(!enabled)('S4: no missed and no doubled Bitrix event (event kick + safety tick, running app, mock Bitrix)', () => {
  it('200 events in bursts, kicks relayed, then one tick: every row finished, every record created once, no row claimed twice', async () => {
    const since = await dbNow();
    const events: Array<[number, string]> = [
      ...ids.bursts.map((id) => [id, 'ONCRMDEALADD'] as [number, string]),
      ...ids.bursts.slice(0, 50).map((id) => [id, 'ONCRMDEALUPDATE'] as [number, string]),
    ];
    expect(events).toHaveLength(200);
    for (let i = 0; i < events.length; i += 20) {
      const burst = events.slice(i, i + 20);
      const answers = await Promise.all(burst.map(([id, event]) => send(id, event)));
      for (const a of answers) expect(a.status).toBe(200);
      await deliverKicks();
    }
    const kicks = await eventDispatchesSince(since);
    // The breaker (20 non-tick calls a minute) held some kicks back; their rows wait for a run.
    expect(kicks).toBeGreaterThan(0);
    expect(kicks).toBeLessThan(events.length);

    // Whatever an event run left (time budget, breaker), the safety tick drains.
    expect((await tick()).status).toBe(200);
    const rows = await rowsFor(ids.bursts);
    expect(rows.length).toBeGreaterThanOrEqual(150);
    expect(rows.filter((r) => !FINISHED(r))).toEqual([]);
    expect(rows.filter((r) => r.attempts !== 1)).toEqual([]);
    const created = await createdAudits(ids.bursts);
    expect(created.size).toBe(150);
    expect([...created.values()].every((n) => n === 1)).toBe(true);
    // Every record appears; nothing outside the run's records was imported by these runs.
    expect([...created.keys()].sort()).toEqual(ids.bursts.map(String).sort());
  }, 300_000);

  it('two event runs at the same moment and an event run overlapping a full run never take the same row', async () => {
    for (const id of ids.overlap) putDeal(id);
    for (const id of ids.overlap) expect((await send(id)).status).toBe(200);
    const answers = await Promise.all([eventRun(), eventRun(), tick(), eventRun()]);
    for (const a of answers) expect(a.status).toBe(200);
    // Drain anything still waiting (an older app runs one batch per event call).
    for (let i = 0; i < 5; i += 1) {
      const left = (await rowsFor(ids.overlap)).filter((r) => r.status === 'pending' || r.status === 'processing');
      if (left.length === 0) break;
      expect((await eventRun()).status).toBe(200);
    }
    const rows = await rowsFor(ids.overlap);
    expect(rows.filter((r) => !FINISHED(r))).toEqual([]);
    expect(rows.filter((r) => r.attempts !== 1)).toEqual([]);
    const created = await createdAudits(ids.overlap);
    expect(created.size).toBe(60);
    expect([...created.values()].every((n) => n === 1)).toBe(true);
  }, 300_000);

  it('kicks held back by the breaker: the events are recorded, nothing is sent, and one tick leaves zero rows pending', async () => {
    // Trip the breaker deterministically: 20 synthetic non-tick calls in the last minute.
    const fakes = Array.from({ length: 20 }, (_, i) => 9_500_000_000 + base + i);
    await dbQuery(`insert into public.integration_sync_dispatches (request_id, kind, dispatched_at) select x, 'event', now() from unnest($1::bigint[]) x`, [fakes]);
    try {
      for (const id of ids.suppressed) putDeal(id);
      const since = await dbNow();
      for (const id of ids.suppressed) expect((await send(id)).status).toBe(200);
      expect(await eventDispatchesSince(since)).toBe(0);
      expect((await rowsFor(ids.suppressed)).map((r) => r.status)).toEqual(ids.suppressed.map(() => 'pending'));
      expect((await tick()).status).toBe(200);
      const rows = await rowsFor(ids.suppressed);
      expect(rows.filter((r) => r.status === 'pending')).toEqual([]);
      expect(rows.filter((r) => !FINISHED(r))).toEqual([]);
      expect((await createdAudits(ids.suppressed)).size).toBe(10);
    } finally {
      await dbQuery('delete from public.integration_sync_dispatches where request_id = any($1::bigint[])', [fakes]);
    }
  }, 300_000);

  it('a record changed in Bitrix with no event at all is picked up by the tick\'s pull', async () => {
    putDeal(ids.pulled);
    expect(await rowsFor([ids.pulled])).toEqual([]);
    expect((await tick()).status).toBe(200);
    // The pull enqueues and the same full run drains; a second tick finishes anything left.
    if ((await createdAudits([ids.pulled])).size === 0) expect((await tick()).status).toBe(200);
    expect(await createdAudits([ids.pulled])).toEqual(new Map([[String(ids.pulled), 1]]));
    const rows = await rowsFor([ids.pulled]);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.filter((r) => !FINISHED(r))).toEqual([]);
  }, 300_000);

  it('the run opened no sync-stopped incident and queued no daily resync on the shared stack', async () => {
    expect(
      await dbQuery(`select id from public.integration_sync_incidents where portal_member_id = $1 and opened_at >= $2`, [MEMBER, startedAt.toISOString()]),
    ).toEqual([]);
    expect(
      await dbQuery(
        `select status from public.integration_resync_jobs where portal_member_id = $1 and created_at >= $2 and status <> 'superseded'`,
        [MEMBER, startedAt.toISOString()],
      ),
    ).toEqual([]);
  });
});
