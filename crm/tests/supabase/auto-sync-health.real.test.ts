import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isRealStackRequired } from '@/lib/config';
import { FIXTURE_EMAILS, FIXTURE_USERS } from '../helpers/db';
import { createRealStack, resolveRealStackEnv } from '../helpers/real-stack';

/**
 * Migration 20261008000500 on the REAL local stack: every scheduled call is
 * recorded with its HTTP status and a plain reason (from net._http_response),
 * the cron jobs exist, and only admins read the scheduler status.
 * Synthetic net._http_response rows are inserted inside transactions that are
 * rolled back; the real scheduler rows are never touched.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
function databaseUrl(): string | null {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    if (isRealStackRequired(process.env)) throw new Error('REQUIRE_REAL_STACK=1 but TEST_DATABASE_URL is missing');
    return null;
  }
  if (!LOCAL_HOSTS.has(new URL(url).hostname)) throw new Error('local database only');
  return url;
}
const dbUrl = databaseUrl();
const env = resolveRealStackEnv();
const stack = env ? createRealStack(env) : null;

describe.skipIf(!dbUrl)('auto-sync health (real local stack)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    db = new pg.Client({ connectionString: dbUrl! });
    await db.connect();
    // Disposable CI stack: the approved operator sequence (migrations no longer
    // install pg_cron/pg_net or schedule jobs; 20261107000100).
    await db.query('create extension if not exists pg_cron');
    await db.query('create extension if not exists pg_net with schema extensions');
    const provisioned = await db.query('select authz.provision_bitrix_sync_jobs() as jobs');
    expect(provisioned.rows[0].jobs.map((j: { jobname: string }) => j.jobname)).toContain('bitrix-sync');
    await db.query("select cron.alter_job(j.jobid, active := true) from cron.job j where j.jobname like 'bitrix-sync%'");
  });
  afterAll(async () => {
    await stack?.cleanup();
    await db?.end();
  });

  /** Runs fn in a transaction that is always rolled back. */
  async function rolledBack(fn: () => Promise<void>) {
    await db.query('begin');
    try {
      await fn();
    } finally {
      await db.query('rollback');
    }
  }

  it('cron jobs exist with the expected schedule and entry point (they survive db reset)', async () => {
    const { rows } = await db.query(
      `select jobname, schedule, command, active from cron.job
       where jobname in ('bitrix-sync', 'bitrix-sync-dispatch-cleanup') order by jobname`,
    );
    expect(rows).toEqual([
      { jobname: 'bitrix-sync', schedule: '30 seconds', command: 'select authz.run_scheduled_bitrix_sync()', active: true },
      { jobname: 'bitrix-sync-dispatch-cleanup', schedule: '23 3 * * *', command: expect.stringContaining('integration_sync_dispatches'), active: true },
    ]);
    // The scheduler reads its URL and bearer from Vault by name, never from a table.
    const { rows: src } = await db.query(`select prosrc from pg_proc where proname = 'dispatch_bitrix_sync'`);
    expect(src[0].prosrc).toContain('vault.decrypted_secrets');
  });

  it('every call is recorded with its HTTP status and a plain reason (success, 401, 503, timeout, unreachable, no answer)', async () => {
    await rolledBack(async () => {
      const base = 990_000_100;
      const answers: Array<[number, number | null, string | null, boolean, string | null]> = [
        [base + 1, 200, '{"outcome":"ok"}', false, null],
        [base + 2, 401, '{"error":"unauthorized"}', false, null],
        [base + 3, 503, '{"error":"not_configured"}', false, null],
        [base + 4, null, null, true, 'Timeout was reached'],
        [base + 5, null, null, false, "Couldn't connect to server"],
        [base + 6, 500, '{not json', false, null],
      ];
      for (const [id, status, content, timedOut, err] of answers) {
        await db.query(
          `insert into net._http_response (id, status_code, content, timed_out, error_msg, created) values ($1, $2, $3, $4, $5, now())`,
          [id, status, content, timedOut, err],
        );
        await db.query(`insert into public.integration_sync_dispatches (request_id, dispatched_at) values ($1, now() - interval '20 seconds')`, [id]);
      }
      // Dispatched 5 minutes ago, never answered.
      await db.query(`insert into public.integration_sync_dispatches (request_id, dispatched_at) values ($1, now() - interval '5 minutes')`, [base + 7]);
      await db.query('select authz.settle_sync_dispatches()');
      const { rows } = await db.query(
        `select request_id::bigint - $1 as n, status_code, ok, reason from public.integration_sync_dispatches
         where request_id between $2 and $3 order by request_id`,
        [base, base + 1, base + 7],
      );
      expect(rows.map((r) => [Number(r.n), r.status_code, r.ok])).toEqual([
        [1, 200, true],
        [2, 401, false],
        [3, 503, false],
        [4, null, false],
        [5, null, false],
        [6, 500, false],
        [7, null, false],
      ]);
      expect(rows[0].reason).toBeNull();
      expect(rows[1].reason).toMatch(/refused the scheduler's secret \(HTTP 401\)/);
      expect(rows[2].reason).toMatch(/HTTP 503, not_configured/);
      expect(rows[3].reason).toMatch(/did not answer within 90 seconds/);
      expect(rows[4].reason).toMatch(/could not be reached/);
      expect(rows[5].reason).toMatch(/HTTP 500/);
      expect(rows[6].reason).toMatch(/No answer from the CRM within 3 minutes/);
      // No secret or URL in any reason.
      for (const r of rows) expect(String(r.reason ?? '')).not.toMatch(/https?:|Bearer|host\.docker/);
    });
  });

  it('the cron entry point settles earlier calls even while the sync switch is paused', async () => {
    await rolledBack(async () => {
      await db.query('update public.integration_sync_schedule set enabled = false where id');
      await db.query(`insert into net._http_response (id, status_code, content, timed_out, created) values (990000201, 401, '{}', false, now())`);
      await db.query(`insert into public.integration_sync_dispatches (request_id, dispatched_at) values (990000201, now() - interval '20 seconds')`);
      await db.query('select authz.run_scheduled_bitrix_sync()');
      const { rows } = await db.query('select ok, status_code from public.integration_sync_dispatches where request_id = 990000201');
      expect(rows).toEqual([{ ok: false, status_code: 401 }]);
    });
  });

  it.skipIf(!stack)('admins read the scheduler status through the Data API; staff are refused', async () => {
    const admin = await stack!.signInAal2(FIXTURE_EMAILS.adminJodhpur, FIXTURE_USERS.adminJodhpur);
    const sales = await stack!.signInAal2(FIXTURE_EMAILS.salesDelhiA, FIXTURE_USERS.salesDelhiA);
    const ok = await admin.client.rpc('integration_auto_sync_status');
    expect(ok.error).toBeNull();
    expect(ok.data).toMatchObject({ cronInstalled: true, job: { schedule: '30 seconds', active: true } });
    expect(JSON.stringify(ok.data)).not.toMatch(/host\.docker|Bearer/);
    const refused = await sales.client.rpc('integration_auto_sync_status');
    expect(refused.error?.code).toBe('42501');
    expect((await sales.client.from('integration_sync_dispatches').select('request_id')).data).toEqual([]);
  });
});
