import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isRealStackRequired } from '@/lib/config';
import { sleep } from '../helpers/real-stack';

/**
 * Migration 20261006000100 on the REAL local stack: the pg_cron job, the
 * Realtime publication, and a real pg_net dispatch whose URL and bearer come
 * from Vault (test-named secrets, removed afterwards; the real
 * bitrix_sync_* values are never read or changed).
 *
 * Delivery from the Supabase containers to this machine uses
 * host.docker.internal (Docker Desktop). On Linux runners it is only attempted
 * with AUTO_SYNC_DELIVERY_TEST=1.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
function databaseUrl(): string | null {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    if (isRealStackRequired(process.env)) throw new Error('REQUIRE_REAL_STACK=1 but TEST_DATABASE_URL is missing');
    return null;
  }
  if (!LOCAL_HOSTS.has(new URL(url).hostname)) throw new Error('auto-sync real-stack test runs only against a local database');
  return url;
}
const dbUrl = databaseUrl();
const delivery = process.platform !== 'linux' || process.env.AUTO_SYNC_DELIVERY_TEST === '1';

const suffix = randomBytes(4).toString('hex');
const URL_NAME = `test_sync_url_${suffix}`;
const BEARER_NAME = `test_sync_bearer_${suffix}`;
const BYPASS_NAME = `test_sync_bypass_${suffix}`;
const bearer = randomBytes(24).toString('hex');

describe.skipIf(!dbUrl)('auto-sync migration (real local stack)', () => {
  let db: pg.Client;
  let server: Server;
  const received: Array<{ url: string; method: string; headers: IncomingMessage['headers'] }> = [];

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
    server = createServer((req, res) => {
      received.push({ url: req.url ?? '', method: req.method ?? '', headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', () => resolve()));
  });

  afterAll(async () => {
    await db?.query('delete from vault.secrets where name = any($1)', [[URL_NAME, BEARER_NAME, BYPASS_NAME]]).catch(() => undefined);
    await db?.end();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it('pg_cron runs bitrix-sync every 30 seconds through the paused-aware entry point', async () => {
    const { rows } = await db.query(
      "select schedule, command, active from cron.job where jobname in ('bitrix-sync', 'bitrix-sync-heartbeat-cleanup') order by jobname",
    );
    expect(rows).toEqual([
      { schedule: '30 seconds', command: 'select authz.run_scheduled_bitrix_sync()', active: true },
      { schedule: '17 3 * * *', command: expect.stringContaining('integration_worker_runs'), active: true },
    ]);
  });

  it('deals, deal_assignments and the deal_list_changes signal are published to Realtime; deal_commercials is not', async () => {
    const { rows } = await db.query(
      "select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename like 'deal%' order by 1",
    );
    expect(rows.map((r) => r.tablename)).toEqual(['deal_assignments', 'deal_list_changes', 'deals']);
  });

  it('nothing is sent when a Vault value is missing', async () => {
    const { rows } = await db.query('select authz.dispatch_bitrix_sync($1, $2, $3) as id', [URL_NAME, BEARER_NAME, BYPASS_NAME]);
    expect(rows[0].id).toBeNull();
  });

  it.skipIf(!delivery)('sends POST ?task=sync with the Bearer and bypass header read from Vault', async () => {
    const port = (server.address() as AddressInfo).port;
    await db.query('select vault.create_secret($1, $2)', [`http://host.docker.internal:${port}/api/integrations/bitrix/worker`, URL_NAME]);
    await db.query('select vault.create_secret($1, $2)', [bearer, BEARER_NAME]);
    await db.query('select vault.create_secret($1, $2)', ['bypass-' + bearer.slice(0, 8), BYPASS_NAME]);

    const { rows } = await db.query('select authz.dispatch_bitrix_sync($1, $2, $3) as id', [URL_NAME, BEARER_NAME, BYPASS_NAME]);
    expect(rows[0].id).not.toBeNull();
    for (let i = 0; i < 40 && received.length === 0; i += 1) await sleep(250);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ method: 'POST', url: '/api/integrations/bitrix/worker?task=sync' });
    expect(received[0]!.headers.authorization).toBe(`Bearer ${bearer}`);
    expect(received[0]!.headers['x-vercel-protection-bypass']).toBe('bypass-' + bearer.slice(0, 8));
  });
});
