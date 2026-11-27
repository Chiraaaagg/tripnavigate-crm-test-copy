import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb, migrationFiles } from '../helpers/db';

/**
 * S4 background sync load (build contract hosting-migration-2026-11-26/10,
 * sections 2.2 D9-D11, 2.5 (j) and 4), migration 20261208000130: the nightly
 * prune of exactly three machine logs (cron.job_run_details,
 * integration_worker_runs, integration_sync_dispatches), in bounded rounds,
 * with the retention read from integration_sync_schedule.log_retention_days.
 *
 * PGlite has no pg_cron: the function must still prune the two public tables
 * and report cronRuns 0. The cron.job_run_details part is proved on the real
 * stack (tests/supabase/s4-event-kick.real.test.ts). Every case runs in a
 * rolled-back transaction with synthetic rows.
 */

const FILE = migrationFiles().find((f) => basename(f) === '20261208000130_s4_machine_log_prune.sql');

const stripComments = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');

function pruneBody(code: string): string {
  const start = code.indexOf('create function authz.prune_machine_logs(');
  return code.slice(start, code.indexOf('\n$$;', start) + 4);
}

const PRUNED = ['public.integration_worker_runs', 'public.integration_sync_dispatches', 'cron.job_run_details'];
const deleteTargets = (body: string) => [...body.matchAll(/\bdelete\s+from\s+([a-z_]+\.[a-z_]+)/gi)].map((m) => m[1]!.toLowerCase());

describe('prune source', () => {
  it('the migration exists', () => {
    expect(FILE).toBeDefined();
  });

  it('the function deletes from exactly the three machine logs, once each; no TRUNCATE or DROP', () => {
    const body = pruneBody(stripComments(readFileSync(FILE!, 'utf8')));
    expect(deleteTargets(body)).toEqual(PRUNED);
    expect(body).not.toMatch(/\btruncate\b|\bdrop\b/i);
    // Only by primary key, in bounded rounds.
    expect(body).toMatch(/where w\.id in \(\s*select x\.id from public\.integration_worker_runs x/);
    expect(body).toMatch(/where d\.request_id in \(\s*select x\.request_id from public\.integration_sync_dispatches x/);
    expect(body).toMatch(/x\.answered_at is not null/);
    expect(body).toMatch(/coalesce\(x\.end_time, x\.start_time\) < \$1 order by x\.runid limit \$2/);
  });
});

describe('prune in the database', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db?.close();
  });

  type Result = {
    status: string; retentionDays?: number; cutoff?: string; workerRuns?: number; dispatches?: number; cronRuns?: number; more?: boolean;
  };
  const prune = async (batch?: number | null, rounds?: number | null): Promise<Result> => {
    const sql =
      batch === undefined ? 'select authz.prune_machine_logs() as r'
        : rounds === undefined ? 'select authz.prune_machine_logs($1) as r'
          : 'select authz.prune_machine_logs($1, $2) as r';
    const params = batch === undefined ? [] : rounds === undefined ? [batch] : [batch, rounds];
    return (await db.query<{ r: Result }>(sql, params))[0]!.r;
  };
  const count = async (table: string, where = 'true') =>
    Number((await db.query<{ n: number }>(`select count(*)::int as n from ${table} where ${where}`))[0]!.n);
  const runsAgedDays = (n: number, days: number) =>
    db.query(
      `insert into public.integration_worker_runs (kind, started_at, finished_at, outcome)
       select 'worker', now() - make_interval(days => $2) - make_interval(secs => g + 5), now() - make_interval(days => $2) - make_interval(secs => g), 'ok'
       from generate_series(1, $1) g`,
      [n, days],
    );
  let nextRequest = 9_200_000_000;
  const dispatchesAgedDays = async (n: number, days: number, answered = true) => {
    const first = nextRequest + 1;
    nextRequest += n;
    await db.query(
      `insert into public.integration_sync_dispatches (request_id, dispatched_at, answered_at, status_code, ok)
       select $1::bigint + g, now() - make_interval(days => $2) - make_interval(secs => g),
              case when $3 then now() - make_interval(days => $2) - make_interval(secs => g) + interval '1 second' end,
              case when $3 then 200 end, case when $3 then true end
       from generate_series(0, $4 - 1) g`,
      [first, days, answered, n],
    );
  };
  const cronAbsent = async () =>
    (await db.query<{ absent: boolean }>(`select to_regclass('cron.job_run_details') is null as absent`))[0]!.absent;

  it('deletes rows older than 14 days and keeps newer ones and unanswered calls', async () => {
    await asOwner(db, async () => {
      const runsBefore = await count('public.integration_worker_runs');
      const dispatchesBefore = await count('public.integration_sync_dispatches');
      await runsAgedDays(30, 15);
      await runsAgedDays(20, 13);
      await dispatchesAgedDays(40, 15);
      await dispatchesAgedDays(3, 20, false);
      await dispatchesAgedDays(25, 13);
      const r = await prune();
      expect(r).toMatchObject({ status: 'ok', retentionDays: 14, workerRuns: 30, dispatches: 40, more: false });
      expect(typeof r.cutoff).toBe('string');
      if (await cronAbsent()) expect(r.cronRuns).toBe(0);
      expect(await count('public.integration_worker_runs')).toBe(runsBefore + 20);
      expect(await count('public.integration_sync_dispatches')).toBe(dispatchesBefore + 25 + 3);
      // The unanswered old calls stay for the settle step.
      expect(await count('public.integration_sync_dispatches', `answered_at is null and dispatched_at < now() - interval '14 days'`)).toBe(3);
      // A second call finds nothing more.
      expect(await prune()).toMatchObject({ workerRuns: 0, dispatches: 0, more: false });
    });
  });

  it('p_batch bounds each round and more reports the round limit; the oldest calls go first', async () => {
    await asOwner(db, async () => {
      await runsAgedDays(250, 15);
      await dispatchesAgedDays(150, 15);
      expect(await prune(100, 1)).toMatchObject({ workerRuns: 100, dispatches: 100, more: true });
      // The 50 dispatch rows left are the newest of the old ones.
      const [left] = await db.query<{ n: number; newest: boolean }>(
        `select count(*)::int as n,
                min(dispatched_at) > (select max(d.dispatched_at) - interval '51 seconds' from public.integration_sync_dispatches d
                                      where d.dispatched_at < now() - interval '14 days') as newest
         from public.integration_sync_dispatches where dispatched_at < now() - interval '14 days'`,
      );
      expect(left).toEqual({ n: 50, newest: true });
      expect(await prune(100, 2)).toMatchObject({ workerRuns: 150, dispatches: 50, more: false });
    });
  });

  it('clamps p_batch to 100..10,000 and p_rounds to 1..10', async () => {
    await asOwner(db, async () => {
      await runsAgedDays(150, 15);
      expect(await prune(1, 1)).toMatchObject({ workerRuns: 100, more: true });
      expect(await prune(null, null)).toMatchObject({ workerRuns: 50, more: false });
    });
    await asOwner(db, async () => {
      await runsAgedDays(12_000, 15);
      expect(await prune(1_000_000, 0)).toMatchObject({ workerRuns: 10_000, more: true });
      expect(await prune(1_000_000, 0)).toMatchObject({ workerRuns: 2_000, more: false });
    });
  });

  it('with the defaults one call removes 12,000 old rows in three rounds; with p_rounds = 1 it removes 5,000 and reports more', async () => {
    await asOwner(db, async () => {
      await runsAgedDays(12_000, 15);
      expect(await prune()).toMatchObject({ workerRuns: 12_000, more: false });
      expect(await count('public.integration_worker_runs', `finished_at < now() - interval '14 days'`)).toBe(0);
    });
    await asOwner(db, async () => {
      await runsAgedDays(12_000, 15);
      expect(await prune(5000, 1)).toMatchObject({ workerRuns: 5_000, more: true });
      expect(await count('public.integration_worker_runs', `finished_at < now() - interval '14 days'`)).toBe(7_000);
    });
  });

  it('retention 30 keeps a 20-day-old row and removes a 31-day-old one', async () => {
    await asOwner(db, async () => {
      await db.query('update public.integration_sync_schedule set log_retention_days = 30 where id');
      await runsAgedDays(1, 20);
      await runsAgedDays(1, 31);
      await dispatchesAgedDays(1, 20);
      await dispatchesAgedDays(1, 31);
      expect(await prune()).toMatchObject({ retentionDays: 30, workerRuns: 1, dispatches: 1 });
      expect(await count('public.integration_worker_runs', `finished_at < now() - interval '19 days'`)).toBe(1);
    });
  });

  it('no schedule row: no_policy and nothing deleted', async () => {
    await asOwner(db, async () => {
      await runsAgedDays(10, 40);
      await dispatchesAgedDays(10, 40);
      const runs = await count('public.integration_worker_runs');
      const dispatches = await count('public.integration_sync_dispatches');
      await db.query('delete from public.integration_sync_schedule');
      expect(await prune()).toEqual({ status: 'no_policy' });
      expect(await count('public.integration_worker_runs')).toBe(runs);
      expect(await count('public.integration_sync_dispatches')).toBe(dispatches);
    });
  });

  it('business and audit tables are untouched', async () => {
    await asOwner(db, async () => {
      const tables = [
        'public.audit_events',
        'public.integration_inbox',
        'public.integration_sync_incidents',
        'public.integration_resync_jobs',
        'public.bitrix_id_proof_copy_jobs',
        'public.outbox_events',
      ];
      // An old inbox row must survive too (integration_inbox is not pruned).
      await db.query(
        `insert into public.integration_inbox (portal_member_id, event_type, source_deal_id, source_ts, dedupe_key, origin, received_at)
         values ('SYNTHETIC_MEMBER_0001', 'ONCRMDEALUPDATE', 9301, 1700000000, encode(sha256(convert_to('s4-prune-synthetic-old-row', 'UTF8')), 'hex'), 'event', now() - interval '60 days')`,
      );
      await runsAgedDays(20, 30);
      await dispatchesAgedDays(20, 30);
      const before = await Promise.all(tables.map((t) => count(t)));
      const r = await prune();
      expect(r).toMatchObject({ workerRuns: 20, dispatches: 20 });
      expect(await Promise.all(tables.map((t) => count(t)))).toEqual(before);
    });
  });
});
