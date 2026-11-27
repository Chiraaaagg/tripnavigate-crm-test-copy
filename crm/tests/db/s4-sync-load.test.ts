import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Actor,
  FIXTURE_EMAILS,
  FIXTURE_USERS as U,
  SYNTHETIC_INTAKE_CONFIG as CONFIG,
  type TestDb,
  asOwner,
  createTestDb,
  expectDbError,
  migrationFiles,
  resetActor,
  setActor,
} from '../helpers/db';
import { OWNER } from './b1-support';
import { b11Helpers } from './b11-support';

/**
 * S4 background sync load (build contract hosting-migration-2026-11-26/10,
 * sections 2.5 and 4), migrations 20261208000100 (index, columns),
 * 20261208000110 (event kick, copy trigger, follow-up RPC, kick switch) and
 * 20261208000120 (cadence-aware alert check and status, cadence function).
 * 20261208000130 (prune) is covered by s4-machine-log-prune.test.ts.
 *
 * PGlite has no pg_cron, pg_net or Vault: every kick here answers false and
 * sends nothing; the real sending is proved by tests/supabase/s4-event-kick.real.test.ts.
 * Cases that need the pg_cron job create a stand-in cron.job table inside the
 * rolled-back transaction (as stage6-sync-incidents.test.ts does). On the real
 * CI Postgres (TEST_DATABASE_URL) the same cases run where they can; the
 * definition comparison needs a database built without these migrations and
 * runs on PGlite only.
 */

const root = join(import.meta.dirname, '..', '..');
const S4_VERSIONS = ['20261208000100', '20261208000110', '20261208000120', '20261208000130'];
const version = (f: string) => basename(f).slice(0, 14);
const s4Files = () => migrationFiles().filter((f) => S4_VERSIONS.includes(version(f)));

const stripComments = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .map((l) => l.replace(/\s--\s.*$/, ''))
    .join('\n');

/** Text of one function definition in migration code: from "create ... function <name>(" to its closing "$$;". */
function bodyOf(code: string, name: string): string {
  const start = code.search(new RegExp(`create (or replace )?function ${name.replace('.', '\\.')}\\(`));
  if (start < 0) throw new Error(`${name} not found`);
  const end = code.indexOf('\n$$;', start);
  return code.slice(start, end + 4);
}

const SVC: Actor = { userId: null, role: 'service_role' };
const ANON: Actor = { userId: null };
const ADMIN: Actor = { userId: U.adminJodhpur };
const MEMBER = 'SYNTHETIC_MEMBER_0001';
const DOMAIN = 'synthetic-portal.example.test';
const CREDENTIAL = 'synthetic-s4-receiver-credential-0123456789abcdef';
const REASON = 'Synthetic S4 test run, owner approval APPROVE';

describe('S4 migration source', () => {
  const files = s4Files();
  const code = files.map((f) => stripComments(readFileSync(f, 'utf8'))).join('\n');

  it('the four migration files exist in the reserved range', () => {
    expect(files.map((f) => basename(f))).toEqual([
      '20261208000100_s4_sync_dispatch_index.sql',
      '20261208000110_s4_sync_event_kick.sql',
      '20261208000120_s4_sync_cadence.sql',
      '20261208000130_s4_machine_log_prune.sql',
    ]);
  });

  it('each file is one transaction with a 5-second lock timeout', () => {
    for (const f of files) {
      const c = stripComments(readFileSync(f, 'utf8')).trim();
      expect(c.startsWith("begin;\nset local lock_timeout = '5s';"), basename(f)).toBe(true);
      expect(c.endsWith('commit;'), basename(f)).toBe(true);
    }
  });

  it('contains no URL, host, bearer value or secret write, and installs no extension', () => {
    expect(code).not.toMatch(/https?:\/\/[a-z0-9]/i);
    expect(code).not.toMatch(/host\.docker\.internal|vercel\.app|supabase\.co|localhost|127\.0\.0\.1/i);
    expect(code).not.toMatch(/Bearer [A-Za-z0-9]/);
    expect(code).not.toMatch(/vault\.create_secret|vault\.update_secret|insert into vault/i);
    expect(code).not.toMatch(/create extension/i);
  });

  it('schedules or alters a pg_cron job only inside the two operator functions; never on apply', () => {
    const cadence = bodyOf(code, 'authz.set_bitrix_sync_cadence');
    const provision = bodyOf(code, 'authz.provision_machine_log_prune_job');
    const rest = code.replace(cadence, '').replace(provision, '');
    expect(rest).not.toMatch(/cron\.alter_job|cron\.schedule|cron\.unschedule/);
    // The cadence function changes the schedule only (never the active flag).
    expect(cadence.match(/cron\.alter_job/g)).toHaveLength(1);
    expect(cadence).toMatch(/execute 'select cron\.alter_job\(\$1, schedule := \$2\)' using v_job, v_schedule;/);
    expect(cadence).not.toMatch(/cron\.schedule|active :=/);
    // The provisioning step creates the job and pauses it in the same transaction.
    expect(provision.match(/cron\.schedule\(/g)).toHaveLength(1);
    expect(provision.match(/cron\.alter_job/g)).toHaveLength(1);
    expect(provision).toMatch(/execute 'select cron\.alter_job\(\$1, active := false\)' using v_id;/);
  });

  it('deletes no row on apply: the only DELETE statements are inside the prune function; no TRUNCATE or DROP', () => {
    const prune = bodyOf(code, 'authz.prune_machine_logs');
    expect(code.replace(prune, '')).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\btruncate\b|\bdrop\s+(table|function|index|trigger|column|schema|policy)\b/i);
  });

  it('uses no class-40 SQLSTATE', () => {
    expect(code).not.toMatch(/'40[0-9A-Z]{3}'/);
    expect(code).not.toMatch(/serialization_failure|deadlock_detected|transaction_rollback/i);
  });

  it('the kick reads the scheduler Vault names, posts the frozen query and records its kind', () => {
    const kick = bodyOf(code, 'authz.kick_bitrix_sync');
    for (const name of ['bitrix_sync_url', 'bitrix_sync_bearer', 'vercel_protection_bypass']) {
      expect(kick).toContain(`from vault.decrypted_secrets s where s.name = '${name}'`);
    }
    expect(kick).toContain("jsonb_build_object('task', 'batch', 'limit', '25', 'source', 'event')");
    expect(kick).toContain("jsonb_build_object('task', 'sync')");
    expect(kick).toContain('timeout_milliseconds := 90000');
    expect(kick).toContain('insert into public.integration_sync_dispatches (request_id, kind) values (v_id, p_kind)');
    expect(kick).toMatch(/exception when others then\s+return false;/);
    // Plain read of the schedule row: the tick takes it FOR UPDATE SKIP LOCKED.
    expect(kick).not.toMatch(/for update|for share/i);
    // The kick never moves the tick's overlap guard.
    expect(kick).not.toMatch(/last_request_id|last_dispatched_at/);
  });
});

describe('S4 database objects', () => {
  let db: TestDb;
  const h = b11Helpers(() => db);
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db?.close();
  });

  async function run<T = Record<string, unknown>>(actor: Actor, sql: string, params: unknown[] = []): Promise<T[]> {
    await setActor(db, actor);
    const rows = await db.query<T>(sql, params);
    await resetActor(db);
    return rows;
  }
  const one = async <T>(actor: Actor, sql: string, params: unknown[] = []) => (await run<{ r: T }>(actor, sql, params))[0]!.r;
  const kick = async (kind: string | null) =>
    (await db.query<{ r: boolean }>('select authz.kick_bitrix_sync($1) as r', [kind]))[0]!.r;
  const nonTickDispatches = async () =>
    Number((await db.query<{ n: number }>(`select count(*)::int as n from public.integration_sync_dispatches where kind <> 'tick'`))[0]!.n);
  const audits = (action: string) =>
    db.query<{ target_id: string; reason: string; details: Record<string, unknown> }>(
      'select target_id, reason, details from public.audit_events where action = $1 order by id',
      [action],
    );
  const schedule = (set: string, params: unknown[] = []) => db.query(`update public.integration_sync_schedule set ${set} where id`, params);
  let nextRequest = 9_100_000_000;
  const dispatch = (kind: string, ok: boolean | null, agoSeconds: number, reason: string | null = null) =>
    db.query(
      `insert into public.integration_sync_dispatches (request_id, kind, dispatched_at, answered_at, status_code, ok, reason)
       values ($1, $2, now() - make_interval(secs => $3), case when $4::boolean is null then null else now() - make_interval(secs => $3) + interval '1 second' end,
               case when $4::boolean then 200 when not $4::boolean then 503 end, $4, $5)`,
      [(nextRequest += 1), kind, agoSeconds, ok, reason],
    );
  async function cronJob(active: boolean | null, schedule_ = '30 seconds'): Promise<void> {
    await db.exec(`create schema if not exists cron; create table if not exists cron.job (jobid bigint, jobname text, schedule text, active boolean)`);
    await db.exec('delete from cron.job');
    if (active !== null) await db.query(`insert into cron.job values (1, 'bitrix-sync', $1, $2)`, [schedule_, active]);
  }
  const heartbeat = (offsetSeconds: number, outcome = 'ok', kind = 'reconcile') =>
    db.query(
      `insert into public.integration_worker_runs (kind, started_at, finished_at, outcome)
       values ($1, now() + make_interval(secs => $2) - interval '5 seconds', now() + make_interval(secs => $2), $3)`,
      [kind, offsetSeconds, outcome],
    );
  const check = () => one<{ send: Array<{ kind: string; reasonCode: string }> }>(SVC, 'select public.integration_sync_alert_check() as r');

  describe('index and columns', () => {
    it('the partial index holds only unanswered calls', async () => {
      const rows = await db.query<{ def: string }>(
        `select indexdef as def from pg_indexes where schemaname = 'public' and indexname = 'integration_sync_dispatches_unanswered_idx'`,
      );
      expect(rows).toEqual([
        { def: 'CREATE INDEX integration_sync_dispatches_unanswered_idx ON public.integration_sync_dispatches USING btree (dispatched_at) WHERE (answered_at IS NULL)' },
      ]);
    });

    it('kind defaults to tick and accepts only tick, event, copy and chain', async () => {
      await asOwner(db, async () => {
        await db.query('insert into public.integration_sync_dispatches (request_id) values (50000000001)');
        expect(await db.query('select kind from public.integration_sync_dispatches where request_id = 50000000001')).toEqual([{ kind: 'tick' }]);
        for (const [i, kind] of ['event', 'copy', 'chain'].entries()) {
          await db.query('insert into public.integration_sync_dispatches (request_id, kind) values ($1, $2)', [50000000010 + i, kind]);
        }
        await expectDbError(db, () => db.query(`insert into public.integration_sync_dispatches (request_id, kind) values (50000000020, 'push')`), { code: '23514' });
        await expectDbError(db, () => db.query(`insert into public.integration_sync_dispatches (request_id, kind) values (50000000021, null)`), { code: '23502' });
      });
    });

    it('the schedule row starts at 30 seconds, 14 days retention and the kick switch off', async () => {
      expect(await db.query('select interval_seconds, log_retention_days, kick_enabled from public.integration_sync_schedule')).toEqual([
        { interval_seconds: 30, log_retention_days: 14, kick_enabled: false },
      ]);
    });

    it('interval accepts 30 and 300 only; retention 7 to 90 only', async () => {
      await asOwner(db, async () => {
        await schedule('interval_seconds = 300');
        await schedule('interval_seconds = 30');
        for (const bad of [60, 0, 301]) {
          await expectDbError(db, () => schedule('interval_seconds = $1', [bad]), { code: '23514' });
        }
        await schedule('log_retention_days = 7');
        await schedule('log_retention_days = 90');
        for (const bad of [6, 91]) {
          await expectDbError(db, () => schedule('log_retention_days = $1', [bad]), { code: '23514' });
        }
      });
    });

    it('API roles keep their earlier access: authenticated reads the four old columns only', async () => {
      const rows = await db.query<{ col: string; auth: boolean; svc: boolean }>(
        `select c as col, has_column_privilege('authenticated', 'public.integration_sync_schedule', c, 'select') as auth,
                has_column_privilege('service_role', 'public.integration_sync_schedule', c, 'select') as svc
         from unnest(array['enabled', 'interval_seconds', 'log_retention_days', 'kick_enabled']) c`,
      );
      expect(rows).toEqual([
        { col: 'enabled', auth: true, svc: true },
        { col: 'interval_seconds', auth: false, svc: true },
        { col: 'log_retention_days', auth: false, svc: true },
        { col: 'kick_enabled', auth: false, svc: true },
      ]);
    });
  });

  describe('privileges', () => {
    it('no API role can run the kick, the switches, the prune or the provisioning step', async () => {
      const fns = [
        'authz.kick_bitrix_sync(text)',
        'authz.id_proof_copy_jobs_kick()',
        'authz.set_bitrix_sync_kick(boolean, text)',
        'authz.set_bitrix_sync_cadence(integer, text)',
        'authz.prune_machine_logs(integer, integer)',
        'authz.provision_machine_log_prune_job()',
      ];
      const rows = await db.query<{ fn: string; role: string; ok: boolean }>(
        `select f as fn, r as role, has_function_privilege(r, f, 'execute') as ok
         from unnest($1::text[]) f, unnest(array['public', 'anon', 'authenticated', 'service_role']) r`,
        [fns],
      );
      expect(rows.filter((r) => r.ok)).toEqual([]);
      expect(rows).toHaveLength(fns.length * 4);
    });

    it('only the service role can ask for a follow-up run', async () => {
      const rows = await db.query<{ role: string; ok: boolean }>(
        `select r as role, has_function_privilege(r, 'public.integration_sync_request_followup(text)', 'execute') as ok
         from unnest(array['public', 'anon', 'authenticated', 'service_role']) r`,
      );
      expect(rows).toEqual([
        { role: 'public', ok: false },
        { role: 'anon', ok: false },
        { role: 'authenticated', ok: false },
        { role: 'service_role', ok: true },
      ]);
      await asOwner(db, async () => {
        for (const actor of [ANON, { userId: U.adminJodhpur } as Actor]) {
          await expectDbError(db, () => run(actor, 'select public.integration_sync_request_followup()'), { code: '42501' });
        }
      });
    });

    it('the receiver keeps exactly its grants: anon only', async () => {
      const rows = await db.query<{ role: string; ok: boolean }>(
        `select r as role, has_function_privilege(r, 'public.integration_receive_bitrix_event(text, text, text, text, bigint, bigint)', 'execute') as ok
         from unnest(array['public', 'anon', 'authenticated', 'service_role']) r`,
      );
      expect(rows).toEqual([
        { role: 'public', ok: false },
        { role: 'anon', ok: true },
        { role: 'authenticated', ok: false },
        { role: 'service_role', ok: false },
      ]);
    });

    it('every new function is security definer with an empty search_path', async () => {
      const rows = await db.query<{ name: string; secdef: boolean; config: string[] | null }>(
        `select n.nspname || '.' || p.proname as name, p.prosecdef as secdef, p.proconfig as config
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where (n.nspname = 'authz' and p.proname in ('kick_bitrix_sync', 'id_proof_copy_jobs_kick', 'set_bitrix_sync_kick',
                  'set_bitrix_sync_cadence', 'prune_machine_logs', 'provision_machine_log_prune_job'))
            or (n.nspname = 'public' and p.proname in ('integration_sync_request_followup', 'integration_receive_bitrix_event',
                  'integration_sync_alert_check', 'integration_auto_sync_status'))
         order by 1`,
      );
      expect(rows).toHaveLength(10);
      for (const r of rows) expect(r, r.name).toMatchObject({ secdef: true, config: ['search_path=""'] });
    });

    it('the copy trigger fires once per inserted row, after insert', async () => {
      const rows = await db.query<{ name: string; def: string }>(
        `select t.tgname as name, pg_get_triggerdef(t.oid) as def from pg_trigger t
         where t.tgrelid = 'public.bitrix_id_proof_copy_jobs'::regclass and t.tgname = 'bitrix_id_proof_copy_jobs_kick'`,
      );
      expect(rows).toEqual([
        {
          name: 'bitrix_id_proof_copy_jobs_kick',
          def: 'CREATE TRIGGER bitrix_id_proof_copy_jobs_kick AFTER INSERT ON public.bitrix_id_proof_copy_jobs FOR EACH ROW EXECUTE FUNCTION authz.id_proof_copy_jobs_kick()',
        },
      ]);
    });
  });

  describe('the kick without Vault or pg_net, and its switch', () => {
    const digest = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');
    let ts = 1_799_000_000;
    const receive = (dealId: number) =>
      one<{ inboxId: string; duplicate: boolean }>(ANON, 'select public.integration_receive_bitrix_event($1, $2, $3, $4, $5, $6) as r', [
        CREDENTIAL, MEMBER, DOMAIN, 'ONCRMDEALADD', dealId, (ts += 1),
      ]);

    it('unknown or null kinds answer false; with the switch off every kind answers false', async () => {
      await asOwner(db, async () => {
        await schedule('enabled = true');
        for (const kind of [null, '', 'tick', 'sync', 'EVENT', 'batch']) expect(await kick(kind), String(kind)).toBe(false);
        for (const kind of ['event', 'copy', 'chain']) expect(await kick(kind), kind).toBe(false);
        expect(await nonTickDispatches()).toBe(0);
      });
    });

    it('switched on and enabled, with no Vault value or pg_net, the kick answers false, raises nothing and sends nothing', async () => {
      await asOwner(db, async () => {
        await schedule('enabled = true, kick_enabled = true');
        for (const kind of ['event', 'copy', 'chain']) expect(await kick(kind), kind).toBe(false);
        expect(await nonTickDispatches()).toBe(0);
      });
    });

    it('an event recorded through the receiver is stored and answered exactly as before', async () => {
      await asOwner(db, async () => {
        await db.query(`insert into public.integration_receiver_credentials (slot, credential_sha256, note) values (1, decode($1, 'hex'), 's4 synthetic')`, [digest(CREDENTIAL)]);
        await schedule('enabled = true, kick_enabled = true');
        const first = await receive(9401);
        expect(Object.keys(first).sort()).toEqual(['duplicate', 'inboxId']);
        expect(first.duplicate).toBe(false);
        // Coalesced into the pending row: same answer as before S4.
        expect(await receive(9401)).toEqual({ inboxId: first.inboxId, duplicate: true });
        // Outside the manifest: stored ignored, same answer shape.
        const outside = await receive(4401);
        expect(outside.duplicate).toBe(false);
        expect(
          await db.query('select source_deal_id::int as id, status, reason_code from public.integration_inbox where id = any($1::uuid[]) order by 1', [
            [first.inboxId, outside.inboxId],
          ]),
        ).toEqual([
          { id: 4401, status: 'ignored', reason_code: 'not_in_manifest' },
          { id: 9401, status: 'pending', reason_code: null },
        ]);
        expect(await nonTickDispatches()).toBe(0);
        // Refusals are unchanged.
        await expectDbError(db, () => run(ANON, 'select public.integration_receive_bitrix_event($1, $2, $3, $4, $5, $6)', ['wrong-credential-000000000000000000', MEMBER, DOMAIN, 'ONCRMDEALADD', 9402, 1]), { code: '28000' });
      });
    });

    it('a new ID-proof copy job is stored as before (the copy kick answers false here)', async () => {
      await asOwner(db, async () => {
        await schedule('enabled = true, kick_enabled = true');
        await h.owner('update public.integration_intake_config set bitrix_id_proof_copy = true where id = $1', [CONFIG]);
        const deal = await h.insertRealDeal('C7:NEW', 7, 994001);
        await h.draftWithTravellers(OWNER, deal);
        await h.storeIdProof(OWNER, deal, 1);
        expect(await db.query(`select status from public.bitrix_id_proof_copy_jobs where deal_id = $1`, [deal])).toEqual([{ status: 'pending' }]);
        expect(await nonTickDispatches()).toBe(0);
      });
    });

    it('the follow-up answers {"dispatched": false} for every kind here', async () => {
      await asOwner(db, async () => {
        await schedule('enabled = true, kick_enabled = true');
        expect(await one(SVC, 'select public.integration_sync_request_followup() as r')).toEqual({ dispatched: false });
        for (const kind of ['chain', 'copy', 'event', 'tick', 'other', null]) {
          expect(await one(SVC, 'select public.integration_sync_request_followup($1) as r', [kind]), String(kind)).toEqual({ dispatched: false });
        }
      });
    });

    it('set_bitrix_sync_kick flips the switch, audits each change and refuses a bad call', async () => {
      await asOwner(db, async () => {
        expect(await db.query<{ r: unknown }>('select authz.set_bitrix_sync_kick(true, $1) as r', [REASON])).toEqual([{ r: { kickEnabled: true } }]);
        expect(await db.query('select kick_enabled from public.integration_sync_schedule')).toEqual([{ kick_enabled: true }]);
        expect(await db.query<{ r: unknown }>('select authz.set_bitrix_sync_kick(false, $1) as r', [REASON])).toEqual([{ r: { kickEnabled: false } }]);
        expect(await db.query('select kick_enabled from public.integration_sync_schedule')).toEqual([{ kick_enabled: false }]);
        const rows = await audits('integration.sync_kick_changed');
        expect(rows).toEqual([
          { target_id: CONFIG, reason: REASON, details: { fromEnabled: false, toEnabled: true } },
          { target_id: CONFIG, reason: REASON, details: { fromEnabled: true, toEnabled: false } },
        ]);
        await expectDbError(db, () => db.query(`select authz.set_bitrix_sync_kick(true, 'short')`), { code: '22023' });
        await expectDbError(db, () => db.query(`select authz.set_bitrix_sync_kick(true, '          x')`), { code: '22023' });
        await expectDbError(db, () => db.query(`select authz.set_bitrix_sync_kick(true, $1)`, ['x'.repeat(501)]), { code: '22023' });
        await expectDbError(db, () => db.query(`select authz.set_bitrix_sync_kick(null, $1)`, [REASON]), { code: '22023' });
        expect(await audits('integration.sync_kick_changed')).toHaveLength(2);
      });
    });

    it('with no intake config switched on, the change is still audited once (newest config row)', async () => {
      await asOwner(db, async () => {
        await db.query('update public.integration_intake_config set enabled = false');
        await db.query('select authz.set_bitrix_sync_kick(true, $1)', [REASON]);
        const [newest] = await db.query<{ id: string }>('select id from public.integration_intake_config order by created_at desc, id desc limit 1');
        expect((await audits('integration.sync_kick_changed')).map((a) => a.target_id)).toEqual([newest!.id]);
      });
    });
  });

  describe('alert check and status: cadence as data, scheduler calls only (D5, D6, D13)', () => {
    it('at 300 seconds a success 10 minutes old is running and one 16 minutes old is stopped', async () => {
      for (const [ago, stopped] of [[600, false], [890, false], [960, true]] as const) {
        await asOwner(db, async () => {
          await schedule('enabled = true, interval_seconds = 300');
          await cronJob(true, '*/5 * * * *');
          await heartbeat(-ago);
          await dispatch('tick', true, 30);
          const sent = (await check()).send;
          expect(sent.length > 0, `${ago} s`).toBe(stopped);
          if (stopped) expect(sent.map((n) => n.reasonCode)).toEqual(['sync_incomplete']);
        });
      }
    });

    it('at 30 seconds the earlier 90-second rule holds', async () => {
      for (const [ago, stopped] of [[80, false], [91, true]] as const) {
        await asOwner(db, async () => {
          await schedule('enabled = true');
          await cronJob(true);
          await heartbeat(-ago);
          expect((await check()).send.length > 0, `${ago} s`).toBe(stopped);
        });
      }
    });

    it('newer event, copy and chain calls do not change the reason a stopped sync gives', async () => {
      await asOwner(db, async () => {
        await schedule('enabled = true');
        await cronJob(true);
        await heartbeat(-200);
        await dispatch('tick', true, 900);
        await dispatch('tick', false, 60, 'The CRM could not sync (HTTP 503): intake not configured or Bitrix not readable.');
        // Five newer non-tick calls: three answered ok, two still unanswered.
        await dispatch('event', true, 20);
        await dispatch('copy', true, 15);
        await dispatch('chain', true, 12);
        await dispatch('event', null, 8);
        await dispatch('event', null, 5);
        expect((await check()).send.map((n) => n.reasonCode)).toEqual(['call_failed']);
      });
    });

    it('lastCalls, lastOkCallAt and failingSince are computed from scheduler calls only; the status names the cadence and the kick switch', async () => {
      await asOwner(db, async () => {
        await dispatch('tick', true, 900);
        await dispatch('tick', false, 60, 'The CRM could not sync (HTTP 503): intake not configured or Bitrix not readable.');
        await dispatch('event', true, 20);
        await dispatch('chain', true, 12);
        await dispatch('event', null, 5);
        type Status = { lastCalls: Array<{ ok: boolean | null }>; intervalSeconds: number; kickEnabled: boolean };
        const status = await one<Status>(ADMIN, 'select public.integration_auto_sync_status() as r');
        // Compared in SQL as the owner: timestamps keep their microseconds.
        const [facts] = await db.query<{ calls: Status['lastCalls']; ok_match: boolean; failing_match: boolean }>(
          `select $1::jsonb -> 'lastCalls' as calls,
                  ($1::jsonb ->> 'lastOkCallAt')::timestamptz
                    = (select d.dispatched_at from public.integration_sync_dispatches d where d.kind = 'tick' and d.ok) as ok_match,
                  ($1::jsonb ->> 'failingSince')::timestamptz
                    = (select d.dispatched_at from public.integration_sync_dispatches d where d.kind = 'tick' and not d.ok) as failing_match`,
          [JSON.stringify(status)],
        );
        expect(facts!.calls.map((c) => c.ok)).toEqual([false, true]);
        expect(facts).toMatchObject({ ok_match: true, failing_match: true });
        expect(status).toMatchObject({ intervalSeconds: 30, kickEnabled: false });
        await schedule('interval_seconds = 300, kick_enabled = true');
        expect(await one<Status>(ADMIN, 'select public.integration_auto_sync_status() as r')).toMatchObject({ intervalSeconds: 300, kickEnabled: true });
      });
    });
  });

  describe('set_bitrix_sync_cadence refusals', () => {
    it('refuses any value other than 30 or 300 and a reason outside 10 to 500 characters (22023)', async () => {
      await asOwner(db, async () => {
        for (const bad of [60, 0, 299, null]) {
          await expectDbError(db, () => db.query('select authz.set_bitrix_sync_cadence($1, $2)', [bad, REASON]), { code: '22023' });
        }
        await expectDbError(db, () => db.query(`select authz.set_bitrix_sync_cadence(300, 'short')`), { code: '22023' });
        await expectDbError(db, () => db.query('select authz.set_bitrix_sync_cadence(300, null)'), { code: '22023' });
        expect(await db.query('select interval_seconds from public.integration_sync_schedule')).toEqual([{ interval_seconds: 30 }]);
      });
    });

    it('refuses without pg_cron (55000) and changes nothing', async () => {
      if (db.mode !== 'pglite') return; // real stacks: tests/supabase/s4-event-kick.real.test.ts
      await asOwner(db, async () => {
        await expectDbError(db, () => db.query('select authz.set_bitrix_sync_cadence(300, $1)', [REASON]), { code: '55000', message: /pg_cron is not installed/ });
        expect(await db.query('select interval_seconds from public.integration_sync_schedule')).toEqual([{ interval_seconds: 30 }]);
        expect(await audits('integration.sync_cadence_changed')).toEqual([]);
      });
    });
  });
});

/**
 * Restated functions (contract section 4): each one is compared before and
 * after the S4 migrations with the S4 changes put back, by the method of
 * br-conflict-code.test.ts. Every other function must be unchanged, and the
 * new functions are exactly the seven of section 2.5.
 */
const url = process.env.TEST_DATABASE_URL;

type Row = {
  sig: string; def: string; src: string; secdef: boolean; config: string[] | null; volatile: string; strict: boolean;
  leakproof: boolean; parallel: string; lang: string; rettype: string; acl: string | null; owner: string; comment: string | null;
};
const SNAPSHOT_SQL = `
  select n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as sig,
         pg_get_functiondef(p.oid) as def, p.prosrc as src,
         p.prosecdef as secdef, p.proconfig as config, p.provolatile::text as volatile, p.proisstrict as strict,
         p.proleakproof as leakproof, p.proparallel::text as parallel, l.lanname as lang, p.prorettype::regtype::text as rettype,
         p.proacl::text as acl, pg_get_userbyid(p.proowner) as owner, obj_description(p.oid, 'pg_proc') as comment
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language l on l.oid = p.prolang
  where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%' and p.prokind in ('f', 'p')`;
const attrs = (r: Row) => ({
  secdef: r.secdef, config: r.config, volatile: r.volatile, strict: r.strict, leakproof: r.leakproof, parallel: r.parallel,
  lang: r.lang, rettype: r.rettype, acl: r.acl, owner: r.owner, comment: r.comment,
});

const RECEIVE = 'public.integration_receive_bitrix_event(text, text, text, text, bigint, bigint)';
const ALERT = 'public.integration_sync_alert_check()';
const STATUS = 'public.integration_auto_sync_status()';

const RECEIVE_BLOCK = `  -- S4: wake the worker when the recorded row is waiting. Never raises.
  if exists (
    select 1 from public.integration_inbox i
    where i.id = (v_result ->> 'inboxId')::uuid and i.status = 'pending'
  ) then
    perform authz.kick_bitrix_sync('event');
  end if;
`;
const ALERT_BLOCK = `  -- S4: the cadence is data (30 or 300 seconds); stopped stays 3 intervals.
  select make_interval(secs => s.interval_seconds) into v_interval
  from public.integration_sync_schedule s where s.id;
  v_interval := coalesce(v_interval, interval '30 seconds');
`;
const STATUS_BLOCK = `    -- S4: the cadence and the kick switch.
    'intervalSeconds', (select s.interval_seconds from public.integration_sync_schedule s where s.id),
    'kickEnabled', (select s.kick_enabled from public.integration_sync_schedule s where s.id),
`;

function cut(text: string, block: string): string {
  expect(text.split(block).length - 1, 'the S4 block appears exactly once').toBe(1);
  return text.replace(block, '');
}
function swap(text: string, from: string, to: string, times: number): string {
  expect(text.split(from).length - 1, from).toBe(times);
  return text.replaceAll(from, to);
}
const undo: Record<string, (t: string) => string> = {
  [RECEIVE]: (t) => cut(t, RECEIVE_BLOCK),
  [ALERT]: (t) => {
    let s = cut(t, ALERT_BLOCK);
    s = swap(s, '  v_interval interval;\n', "  v_interval constant interval := interval '30 seconds';\n", 1);
    s = swap(s, "integration_sync_dispatches d where d.kind = 'tick' order by", 'integration_sync_dispatches d order by', 1);
    s = swap(s, "integration_sync_dispatches where kind = 'tick' order by", 'integration_sync_dispatches order by', 2);
    return s;
  },
  [STATUS]: (t) => {
    let s = cut(t, STATUS_BLOCK);
    s = swap(s, "integration_sync_dispatches where kind = 'tick' order by", 'integration_sync_dispatches order by', 1);
    s = swap(s, "where d.kind = 'tick' and d.ok", 'where d.ok', 2);
    s = swap(s, "where x.kind = 'tick' and x.ok", 'where x.ok', 1);
    return s;
  },
};
const NEW_FUNCTIONS = [
  'authz.id_proof_copy_jobs_kick()',
  'authz.kick_bitrix_sync(text)',
  'authz.provision_machine_log_prune_job()',
  'authz.prune_machine_logs(integer, integer)',
  'authz.set_bitrix_sync_cadence(integer, text)',
  'authz.set_bitrix_sync_kick(boolean, text)',
  'public.integration_sync_request_followup(text)',
];

describe.skipIf(!!url)('S4 restated functions: definition diff (PGlite)', () => {
  let pg: PGlite;
  let before: Map<string, Row>;
  let after: Map<string, Row>;
  const snapshot = async () => new Map((await pg.query<Row>(SNAPSHOT_SQL)).rows.map((r) => [r.sig, r]));

  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(readFileSync(join(root, 'tests', 'helpers', 'supabase-shim.sql'), 'utf8'));
    const users = Object.entries(U).map(([k, id]) => `('${id}', '${FIXTURE_EMAILS[k as keyof typeof U]}')`).join(',\n');
    await pg.exec(`insert into auth.users (id, email) values ${users};`);
    for (const f of migrationFiles().filter((f) => version(f) < S4_VERSIONS[0]!)) await pg.exec(readFileSync(f, 'utf8'));
    before = await snapshot();
    for (const f of s4Files()) await pg.exec(readFileSync(f, 'utf8'));
    after = await snapshot();
  }, 300_000);
  afterAll(async () => {
    await pg?.close();
  });

  it('adds exactly the seven new functions and removes none', () => {
    const added = [...after.keys()].filter((k) => !before.has(k)).sort();
    expect(added).toEqual([...NEW_FUNCTIONS].sort());
    expect([...before.keys()].filter((k) => !after.has(k))).toEqual([]);
    for (const sig of NEW_FUNCTIONS) {
      expect(after.get(sig), sig).toMatchObject({ secdef: true, config: ['search_path=""'], owner: after.get(RECEIVE)!.owner });
    }
  });

  it('changes only the three restated functions', () => {
    const changed = [...before.keys()].filter((k) => JSON.stringify(before.get(k)) !== JSON.stringify(after.get(k))).sort();
    expect(changed).toEqual([ALERT, STATUS, RECEIVE].sort());
  });

  it.each([RECEIVE, ALERT, STATUS])('%s: identical to its earlier definition once the S4 changes are put back; attributes, grants and owner unchanged', (sig) => {
    const b = before.get(sig)!;
    const a = after.get(sig)!;
    expect(a.def).not.toBe(b.def);
    expect(undo[sig]!(a.src)).toBe(b.src);
    expect(undo[sig]!(a.def)).toBe(b.def);
    expect(attrs(a)).toEqual(attrs(b));
  });
});
