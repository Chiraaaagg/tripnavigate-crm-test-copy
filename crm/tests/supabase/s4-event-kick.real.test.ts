import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isRealStackRequired } from '@/lib/config';
import { SYNTHETIC_INTAKE_CONFIG as CONFIG, assertDatabaseUrlNotOperational } from '../helpers/db';

/**
 * S4 background sync load (build contract hosting-migration-2026-11-26/10,
 * sections 2.5, 3.1 and 4) on the REAL local stack: pg_cron, pg_net and Vault.
 *
 * Every case runs in ONE transaction that is always rolled back. Inside it the
 * three Vault values are created under the scheduler's own names
 * (bitrix_sync_url, bitrix_sync_bearer, vercel_protection_bypass) with
 * synthetic values and an unroutable .test host, so the kick can build its
 * request. pg_net only picks a request up after the caller commits; the
 * rollback therefore sends nothing, and the request the kick queued is read
 * from net.http_request_queue inside the transaction: method, URL with its
 * query string, headers and timeout are exactly what pg_net would POST.
 * (Delivery from the database container to a listener needs Docker Desktop;
 * tests/supabase/auto-sync.real.test.ts covers delivery itself.)
 * cron.alter_job is transactional, so the cadence, provisioning and reverse
 * script cases leave the jobs exactly as they were.
 *
 * Refuses to run when the stack already holds Vault values under the
 * scheduler's names (a developer stack wired to a real worker).
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
function databaseUrl(): string | null {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    if (isRealStackRequired(process.env)) throw new Error('REQUIRE_REAL_STACK=1 but TEST_DATABASE_URL is missing');
    return null;
  }
  if (!LOCAL_HOSTS.has(new URL(url).hostname)) throw new Error('S4 kick real-stack test runs only against a local database');
  return url;
}
const dbUrl = databaseUrl();

const root = join(import.meta.dirname, '..', '..');
const reverse = (file: string) => readFileSync(join(root, 'supabase', 's4-sync-load', file), 'utf8');

const MEMBER = 'SYNTHETIC_MEMBER_0001';
const DOMAIN = 'synthetic-portal.example.test';
const SECRET_NAMES = ['bitrix_sync_url', 'bitrix_sync_bearer', 'vercel_protection_bypass'];
const WORKER_URL = 'https://s4-worker.example.test/api/integrations/bitrix/worker';
const bearer = randomBytes(24).toString('hex');
const bypass = `bypass-${randomBytes(6).toString('hex')}`;
const credential = randomBytes(32).toString('base64url');
const REASON = 'Synthetic S4 real-stack test, owner approval APPROVE';
const base = 31_000_000 + Math.floor(Math.random() * 900_000) * 10;
let ts = Math.floor(Date.now() / 1000);

interface Queued {
  id: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  timeout_milliseconds: number;
}

describe.skipIf(!dbUrl)('S4 event kick, cadence, prune job and reverse scripts (real local stack)', () => {
  let db: pg.Client;
  const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    (await db.query<T>(sql, params)).rows;

  /** Runs fn in a transaction that is always rolled back. */
  async function rolledBack(fn: () => Promise<void>): Promise<void> {
    await q('begin');
    try {
      await fn();
    } finally {
      await q('rollback');
    }
  }
  /** Inside rolledBack: expects `run` to fail with `code`, keeping the transaction usable. */
  async function refused(run: () => Promise<unknown>, code: string): Promise<void> {
    await q('savepoint s4_refused');
    let error: { code?: string } | null = null;
    try {
      await run();
    } catch (e) {
      error = e as { code?: string };
    }
    await q('rollback to savepoint s4_refused');
    expect(error, 'expected a database error').not.toBeNull();
    expect(error!.code).toBe(code);
  }

  /** Inside rolledBack: Vault values, a receiver credential, a manifest for base+0..99, switches. */
  async function arm(opts: { enabled?: boolean; kick?: boolean } = {}): Promise<void> {
    await q('select vault.create_secret($1, $2)', [WORKER_URL, 'bitrix_sync_url']);
    await q('select vault.create_secret($1, $2)', [bearer, 'bitrix_sync_bearer']);
    await q('select vault.create_secret($1, $2)', [bypass, 'vercel_protection_bypass']);
    await q(`update public.integration_receiver_credentials set active = false, revoked_at = now() where slot = 2 and active`);
    await q(`insert into public.integration_receiver_credentials (slot, credential_sha256, note) values (2, decode($1, 'hex'), 's4 kick test')`, [
      createHash('sha256').update(credential, 'utf8').digest('hex'),
    ]);
    await q(
      `select public.integration_manifest_close(m.id, 's4-kick-test') from public.intake_manifests m
       where m.config_id = $1 and m.source_object = 'deal' and m.status = 'active'`,
      [CONFIG],
    );
    await q(
      `select public.integration_manifest_create($1, 'deal', 'SYNTHETIC_SRC', date '2026-09-15',
         timestamptz '2026-09-15T00:00:00+05:30', timestamptz '2026-09-16T00:00:00+05:30', $2::bigint[], 's4-kick-test')`,
      [CONFIG, Array.from({ length: 100 }, (_, i) => base + i)],
    );
    // A clean breaker: no other non-tick call in the windows (rolled back afterwards).
    await q(`delete from public.integration_sync_dispatches where kind <> 'tick'`);
    await q('update public.integration_sync_schedule set enabled = $1, kick_enabled = $2, last_request_id = null where id', [
      opts.enabled ?? true,
      opts.kick ?? true,
    ]);
  }

  /** The receiver as the Edge Function calls it: role anon. */
  async function receive(dealId: number, event = 'ONCRMDEALADD', sourceTs = (ts += 1)): Promise<{ inboxId: string; duplicate: boolean }> {
    await q('set local role anon');
    try {
      const [row] = await q<{ r: { inboxId: string; duplicate: boolean } }>(
        'select public.integration_receive_bitrix_event($1, $2, $3, $4, $5, $6) as r',
        [credential, MEMBER, DOMAIN, event, dealId, sourceTs],
      );
      return row!.r;
    } finally {
      await q('reset role');
    }
  }
  const dispatches = (kind?: string) =>
    q<{ request_id: string; kind: string }>(
      `select request_id::text, kind from public.integration_sync_dispatches where ($1::text is null or kind = $1) and kind <> 'tick' order by dispatched_at, request_id`,
      [kind ?? null],
    );
  const queued = (ids: string[]) =>
    q<Queued>(
      `select id::text, method, url, headers, timeout_milliseconds from net.http_request_queue where id = any($1::bigint[]) order by id`,
      [ids],
    );
  const expectRequest = (r: Queued, query: Record<string, string>) => {
    expect(r.method).toBe('POST');
    const u = new URL(r.url);
    expect(`${u.origin}${u.pathname}`).toBe(WORKER_URL);
    expect(Object.fromEntries(u.searchParams)).toEqual(query);
    expect(r.headers.Authorization).toBe(`Bearer ${bearer}`);
    expect(r.headers['x-vercel-protection-bypass']).toBe(bypass);
    expect(r.timeout_milliseconds).toBe(90_000);
  };
  let nextFake = 9_300_000_000;
  const fakeDispatches = (n: number, kind: string, agoSeconds: number) => {
    const first = nextFake + 1;
    nextFake += n;
    return q(
      `insert into public.integration_sync_dispatches (request_id, kind, dispatched_at)
       select $1::bigint + g, $2, now() - make_interval(secs => $3) from generate_series(0, $4 - 1) g`,
      [first, kind, agoSeconds, n],
    );
  };
  const followup = async (kind?: string) => {
    await q('set local role service_role');
    try {
      const sql = kind === undefined ? 'select public.integration_sync_request_followup() as r' : 'select public.integration_sync_request_followup($1) as r';
      return (await q<{ r: { dispatched: boolean } }>(sql, kind === undefined ? [] : [kind]))[0]!.r;
    } finally {
      await q('reset role');
    }
  };
  const job = async (name: string) =>
    (await q<{ schedule: string; active: boolean; command: string }>('select schedule, active, command from cron.job where jobname = $1', [name]))[0];
  const interval = async () => (await q<{ s: number }>('select interval_seconds as s from public.integration_sync_schedule'))[0]!.s;

  beforeAll(async () => {
    await assertDatabaseUrlNotOperational(dbUrl!);
    db = new pg.Client({ connectionString: dbUrl! });
    await db.connect();
    // Disposable CI stack: the approved operator sequence (as auto-sync.real.test.ts).
    await q('create extension if not exists pg_cron');
    await q('create extension if not exists pg_net with schema extensions');
    await q('select authz.provision_bitrix_sync_jobs()');
    const existing = await q<{ n: number }>('select count(*)::int as n from vault.secrets where name = any($1)', [SECRET_NAMES]);
    if (existing[0]!.n > 0) {
      throw new Error('refusing to run: this stack already holds Vault values under the scheduler names (bitrix_sync_*)');
    }
    if ((await q(`select to_regclass('net.http_request_queue') as t`))[0]!.t === null) {
      throw new Error('pg_net request queue (net.http_request_queue) not found');
    }
  });
  afterAll(async () => {
    await db?.end();
  });

  describe('event kick', () => {
    it('a new pending event queues exactly one POST ?task=batch&limit=25&source=event with the bearer and bypass header, recorded as kind event', async () => {
      await rolledBack(async () => {
        await arm();
        const first = await receive(base + 1);
        expect(first).toEqual({ inboxId: expect.any(String), duplicate: false });
        const rows = await dispatches();
        expect(rows.map((r) => r.kind)).toEqual(['event']);
        const [request] = await queued(rows.map((r) => r.request_id));
        expectRequest(request!, { task: 'batch', limit: '25', source: 'event' });
        expect(new URL(request!.url).search).toBe('?task=batch&limit=25&source=event');
        // A coalesced duplicate (row still pending) asks again; the breaker bounds it.
        expect(await receive(base + 1, 'ONCRMDEALUPDATE')).toEqual({ inboxId: first.inboxId, duplicate: true });
        expect((await dispatches('event')).length).toBe(2);
        // The kick never moves the tick's overlap guard.
        expect(await q('select last_request_id from public.integration_sync_schedule')).toEqual([{ last_request_id: null }]);
      });
    });

    it('an ignored (not in manifest) event and a redelivered finished event queue nothing', async () => {
      await rolledBack(async () => {
        await arm();
        const outside = await receive(base + 500);
        expect(await q('select status, reason_code from public.integration_inbox where id = $1', [outside.inboxId])).toEqual([
          { status: 'ignored', reason_code: 'not_in_manifest' },
        ]);
        expect(await dispatches()).toEqual([]);

        const stamp = (ts += 1);
        const done = await receive(base + 2, 'ONCRMDEALADD', stamp);
        await q(`delete from public.integration_sync_dispatches where kind <> 'tick'`);
        await q(`update public.integration_inbox set status = 'processed', processed_at = now(), next_attempt_at = null where id = $1`, [done.inboxId]);
        expect(await receive(base + 2, 'ONCRMDEALADD', stamp)).toEqual({ inboxId: done.inboxId, duplicate: true });
        expect(await dispatches()).toEqual([]);
      });
    });

    it('paused sync or kick switch off: the event is recorded and nothing is queued; switching on by the audited function kicks again', async () => {
      await rolledBack(async () => {
        await arm({ enabled: false });
        const paused = await receive(base + 3);
        expect(await q('select status from public.integration_inbox where id = $1', [paused.inboxId])).toEqual([{ status: 'pending' }]);
        expect(await dispatches()).toEqual([]);

        await q('update public.integration_sync_schedule set enabled = true, kick_enabled = false where id');
        const off = await receive(base + 4);
        expect(await q('select status from public.integration_inbox where id = $1', [off.inboxId])).toEqual([{ status: 'pending' }]);
        expect(await dispatches()).toEqual([]);

        expect((await q<{ r: unknown }>('select authz.set_bitrix_sync_kick(true, $1) as r', [REASON]))[0]!.r).toEqual({ kickEnabled: true });
        await receive(base + 5);
        expect((await dispatches('event')).length).toBe(1);
      });
    });

    it('three ID-proof copy jobs for one Deal queue three full runs; an insert that inserts nothing queues none; the copy follow-up queues one more', async () => {
      await rolledBack(async () => {
        await arm();
        // Synthetic jobs without their parent rows: the foreign keys are dropped inside this rolled-back transaction only.
        await q(`do $$
          declare c record;
          begin
            for c in select conname from pg_constraint
                     where conrelid = 'public.bitrix_id_proof_copy_jobs'::regclass and contype = 'f'
                       and pg_get_constraintdef(oid) not like '%legal_entities%'
            loop
              execute format('alter table public.bitrix_id_proof_copy_jobs drop constraint %I', c.conname);
            end loop;
          end $$`);
        const deal = (await q<{ id: string }>('select gen_random_uuid()::text as id'))[0]!.id;
        const insert = (traveller: string, sha: string) =>
          q(
            `insert into public.bitrix_id_proof_copy_jobs (legal_entity_id, deal_id, traveller_id, id_proof_id, file_sha256, source_portal, source_deal_id)
             select c.pilot_legal_entity_id, $1, $2, gen_random_uuid(), $3, c.portal_member_id, $4
             from public.integration_intake_config c where c.id = $5
             on conflict on constraint bitrix_id_proof_copy_jobs_unique do nothing`,
            [deal, traveller, sha, base + 6, CONFIG],
          );
        const travellers = (await q<{ id: string }>('select gen_random_uuid()::text as id from generate_series(1, 3)')).map((r) => r.id);
        for (const [i, t] of travellers.entries()) await insert(t, String(i + 1).repeat(64));
        let rows = await dispatches('copy');
        expect(rows).toHaveLength(3);
        for (const r of await queued(rows.map((x) => x.request_id))) expectRequest(r, { task: 'sync' });

        await insert(travellers[0]!, '1'.repeat(64)); // conflicts: no row inserted
        expect(await dispatches('copy')).toHaveLength(3);

        expect(await followup('copy')).toEqual({ dispatched: true });
        rows = await dispatches('copy');
        expect(rows).toHaveLength(4);
        const [last] = await queued([rows[3]!.request_id]);
        expectRequest(last!, { task: 'sync' });
      });
    });

    it('breaker: at 20 non-tick calls in the last minute the event is recorded but not kicked; the next tick sends the full run', async () => {
      await rolledBack(async () => {
        await arm();
        await fakeDispatches(19, 'event', 5);
        await receive(base + 7);
        expect((await dispatches()).length).toBe(20); // the 20th still went out
        const stopped = await receive(base + 8);
        expect((await dispatches()).length).toBe(20);
        expect(await q('select status from public.integration_inbox where id = $1', [stopped.inboxId])).toEqual([{ status: 'pending' }]);
        expect(await followup('chain')).toEqual({ dispatched: false });
        expect(await followup('copy')).toEqual({ dispatched: false });

        await q('select authz.run_scheduled_bitrix_sync()');
        const [tick] = await q<{ request_id: string }>(
          `select request_id::text from public.integration_sync_dispatches where kind = 'tick' order by dispatched_at desc, request_id desc limit 1`,
        );
        const [request] = await queued([tick!.request_id]);
        expectRequest(request!, { task: 'sync' });
      });
    });

    it('chain cap: 10 chain calls in 10 minutes refuse another chain; 9 allow one', async () => {
      await rolledBack(async () => {
        await arm();
        await fakeDispatches(9, 'chain', 300);
        expect(await followup()).toEqual({ dispatched: true });
        expect(await followup()).toEqual({ dispatched: false });
        expect(await followup('chain')).toEqual({ dispatched: false });
        // Copy follow-ups are not bound by the chain cap.
        expect(await followup('copy')).toEqual({ dispatched: true });
        expect(await followup('event')).toEqual({ dispatched: false });
      });
    });
  });

  it('the two settle statements read the partial index, not the whole table (40,000 answered rows)', async () => {
    await rolledBack(async () => {
      await q(
        `insert into public.integration_sync_dispatches (request_id, dispatched_at, answered_at, status_code, ok)
         select 54000000000 + g, now() - make_interval(secs => g * 30), now() - make_interval(secs => g * 30) + interval '1 second', 200, true
         from generate_series(1, 40000) g`,
      );
      await q(`insert into public.integration_sync_dispatches (request_id, dispatched_at) values (53999999999, now() - interval '10 seconds')`);
      await q('analyze public.integration_sync_dispatches');
      const plan = async (sql: string) => (await q<{ 'QUERY PLAN': string }>(`explain ${sql}`)).map((r) => r['QUERY PLAN']).join('\n');
      const joined = await plan(`
        update public.integration_sync_dispatches d
        set answered_at = r.created,
            status_code = r.status_code,
            ok = coalesce(r.status_code between 200 and 299, false) and not coalesce(r.timed_out, false),
            reason = authz.sync_dispatch_reason(r.status_code, coalesce(r.timed_out, false), r.error_msg,
              authz.response_error_code(r.content))
        from net._http_response r
        where r.id = d.request_id and d.answered_at is null`);
      const timedOut = await plan(`
        update public.integration_sync_dispatches d
        set answered_at = now(), ok = false, reason = 'No answer from the CRM within 3 minutes.'
        where d.answered_at is null and d.dispatched_at < now() - interval '3 minutes'`);
      for (const p of [joined, timedOut]) expect(p).not.toMatch(/Seq Scan on integration_sync_dispatches/);
      expect(timedOut).toMatch(/integration_sync_dispatches_unanswered_idx/);
      // The join may also enter through the primary key when net._http_response is nearly empty;
      // either way no full scan of the dispatch table remains.
      expect(joined).toMatch(/integration_sync_dispatches_unanswered_idx|integration_sync_dispatches_pkey/);
    });
  });

  describe('cadence', () => {
    it('set_bitrix_sync_cadence(300) moves the job to */5 * * * *, sets 300 and audits; (30) restores 30 seconds; active never changes', async () => {
      await rolledBack(async () => {
        const before = await job('bitrix-sync');
        const audits = async () =>
          q<{ details: Record<string, unknown> }>(`select details from public.audit_events where action = 'integration.sync_cadence_changed' order by id`);
        const auditsBefore = (await audits()).length;
        expect((await q<{ r: unknown }>('select authz.set_bitrix_sync_cadence(300, $1) as r', [REASON]))[0]!.r).toEqual({
          jobname: 'bitrix-sync', schedule: '*/5 * * * *', active: before!.active, intervalSeconds: 300,
        });
        expect(await job('bitrix-sync')).toEqual({ ...before, schedule: '*/5 * * * *' });
        expect(await interval()).toBe(300);
        expect((await audits()).slice(auditsBefore).map((a) => a.details)).toEqual([{ fromSeconds: 30, toSeconds: 300 }]);
        await q('select authz.set_bitrix_sync_cadence(30, $1)', [REASON]);
        expect(await job('bitrix-sync')).toEqual(before);
        expect(await interval()).toBe(30);
      });
    });

    it('refuses 60, a short reason, and a missing bitrix-sync job', async () => {
      await rolledBack(async () => {
        await refused(() => q('select authz.set_bitrix_sync_cadence(60, $1)', [REASON]), '22023');
        await refused(() => q(`select authz.set_bitrix_sync_cadence(300, 'short')`), '22023');
        await q(`select cron.unschedule('bitrix-sync')`);
        await refused(() => q('select authz.set_bitrix_sync_cadence(300, $1)', [REASON]), '55000');
      });
    });
  });

  describe('machine-log prune job and pg_cron history', () => {
    it('provision_machine_log_prune_job creates the job paused and leaves an existing one as it is', async () => {
      await rolledBack(async () => {
        const jobs = (await q<{ r: Array<{ jobname: string; schedule: string; active: boolean }> }>('select authz.provision_machine_log_prune_job() as r'))[0]!.r;
        expect(jobs).toContainEqual({ jobname: 'machine-log-prune', schedule: '30 20 * * *', active: false });
        expect(jobs.map((j) => j.jobname)).toContain('bitrix-sync');
        expect(await job('machine-log-prune')).toEqual({ schedule: '30 20 * * *', active: false, command: 'select authz.prune_machine_logs()' });
        await q(`select cron.alter_job(jobid, active := true) from cron.job where jobname = 'machine-log-prune'`);
        await q('select authz.provision_machine_log_prune_job()');
        expect(await job('machine-log-prune')).toMatchObject({ active: true });
        expect((await q<{ n: number }>(`select count(*)::int as n from cron.job where jobname = 'machine-log-prune'`))[0]!.n).toBe(1);
      });
    });

    it('prune_machine_logs removes old pg_cron run history (end time, or start time when it never ended) and keeps recent runs', async () => {
      await rolledBack(async () => {
        // runid is given explicitly: postgres may insert into the table but has no USAGE on
        // pg_cron's cron.runid_seq on the Supabase stack (CI run 45850197025).
        const insert = (start: string, end: string | null, message: string) =>
          q(
            `insert into cron.job_run_details (jobid, runid, job_pid, database, username, command, status, return_message, start_time, end_time)
             select 0, coalesce(max(d.runid), 0) + 1000000, 0, current_database(), current_user, 'select 1', 'succeeded', $1,
                    now() - $2::interval, now() - $3::interval
             from cron.job_run_details d`,
            [message, start, end],
          );
        await insert('20 days', '20 days', 's4 synthetic old');
        await insert('21 days', null, 's4 synthetic never ended');
        await insert('1 hour', '1 hour', 's4 synthetic recent');
        const [{ n: old }] = (await q<{ n: number }>(
          `select count(*)::int as n from cron.job_run_details where coalesce(end_time, start_time) < now() - interval '14 days'`,
        )) as [{ n: number }];
        const r = (await q<{ r: { status: string; cronRuns: number } }>('select authz.prune_machine_logs() as r'))[0]!.r;
        expect(r).toMatchObject({ status: 'ok', cronRuns: old });
        expect(old).toBeGreaterThanOrEqual(2);
        expect((await q<{ m: string }>(`select return_message as m from cron.job_run_details where return_message like 's4 synthetic%'`)).map((x) => x.m)).toEqual([
          's4 synthetic recent',
        ]);
      });
    });
  });

  describe('reverse scripts, run verbatim', () => {
    it('R1 restores 30 seconds through the audited function', async () => {
      await rolledBack(async () => {
        const before = await job('bitrix-sync');
        await q('select authz.set_bitrix_sync_cadence(300, $1)', [REASON]);
        await db.query(reverse('r1-cadence-30-seconds.sql'));
        expect(await job('bitrix-sync')).toEqual({ ...before, schedule: '30 seconds' });
        expect(await interval()).toBe(30);
        const [last] = await q<{ reason: string; details: Record<string, unknown> }>(
          `select reason, details from public.audit_events where action = 'integration.sync_cadence_changed' order by id desc limit 1`,
        );
        expect(last).toEqual({ reason: 'Rollback of S4 schedule change: restore 30-second sync', details: { fromSeconds: 300, toSeconds: 30 } });
      });
    });

    it('R1b restores 30 seconds directly', async () => {
      await rolledBack(async () => {
        const before = await job('bitrix-sync');
        await q('select authz.set_bitrix_sync_cadence(300, $1)', [REASON]);
        await db.query(reverse('r1b-cadence-30-seconds-direct.sql'));
        expect(await job('bitrix-sync')).toEqual({ ...before, schedule: '30 seconds' });
        expect(await interval()).toBe(30);
      });
    });

    it('R2 pauses machine-log-prune and reactivates the two old clean-ups', async () => {
      await rolledBack(async () => {
        await q('select authz.provision_machine_log_prune_job()');
        // Step 3 as the operator would leave it.
        await q(`select cron.alter_job(jobid, active := true) from cron.job where jobname = 'machine-log-prune'`);
        await q(`select cron.alter_job(jobid, active := false) from cron.job where jobname in ('bitrix-sync-heartbeat-cleanup', 'bitrix-sync-dispatch-cleanup')`);
        await db.query(reverse('r2-prune-off.sql'));
        expect(
          await q(`select jobname, active from cron.job where jobname in ('machine-log-prune', 'bitrix-sync-heartbeat-cleanup', 'bitrix-sync-dispatch-cleanup') order by jobname`),
        ).toEqual([
          { jobname: 'bitrix-sync-dispatch-cleanup', active: true },
          { jobname: 'bitrix-sync-heartbeat-cleanup', active: true },
          { jobname: 'machine-log-prune', active: false },
        ]);
      });
    });

    it('R3 switches every kick off with one audit row, and the next event queues nothing', async () => {
      await rolledBack(async () => {
        await arm();
        await db.query(reverse('r3-kick-off.sql'));
        expect(await q('select kick_enabled from public.integration_sync_schedule')).toEqual([{ kick_enabled: false }]);
        const [last] = await q<{ reason: string; details: Record<string, unknown> }>(
          `select reason, details from public.audit_events where action = 'integration.sync_kick_changed' order by id desc limit 1`,
        );
        expect(last).toEqual({ reason: 'Rollback of S4 event kick: back to tick-only sync', details: { fromEnabled: true, toEnabled: false } });
        await receive(base + 9);
        expect(await followup('chain')).toEqual({ dispatched: false });
        expect(await followup('copy')).toEqual({ dispatched: false });
        expect(await dispatches()).toEqual([]);
      });
    });
  });
});
