import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Actor,
  FIXTURE_USERS as U,
  type TestDb,
  asOwner,
  createTestDb,
  expectDbError,
  resetActor,
  setActor,
} from '../helpers/db';

/**
 * Accounts phase 3, track A's own database checks for the foundation
 * migration 20261205000100 (contract 5.1, 5.2, A11): the "by the CRM" actor,
 * the timer task registry and tick, the paused scheduler pieces and the timer
 * switch. Track T's acc3-* suites are the independent tests; these are the
 * builder's. Every scenario runs in a rolled-back transaction.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const SUPER: Actor = { userId: U.adminJodhpur };
const SALES: Actor = { userId: U.salesDelhiA };
const SERVICE: Actor = { userId: null, role: 'service_role' };
const REASON = 'Synthetic reason for the timer switch test';

const TABLES = ['timer_settings', 'timer_tasks', 'timer_runs', 'timer_alerts'];

async function asService<T>(fn: () => Promise<T>): Promise<T> {
  await setActor(db, SERVICE);
  try {
    return await fn();
  } finally {
    await resetActor(db);
  }
}

async function tick(): Promise<Record<string, unknown>> {
  return asService(async () => (await db.query<{ r: Record<string, unknown> }>('select public.timer_tick() as r'))[0]!.r);
}

/** Two synthetic task functions: one counts, one fails after writing a row. */
async function addTestTasks(): Promise<void> {
  await db.exec(`
    create table public.acc3a_probe (n integer);
    create function public.tst_ok_task() returns jsonb language sql volatile set search_path = '' as
      $f$ insert into public.acc3a_probe values (1) returning jsonb_build_object('done', 1) $f$;
    create function public.tst_bad_task() returns jsonb language plpgsql volatile set search_path = '' as
      $f$ begin insert into public.acc3a_probe values (2); raise exception 'boom' using errcode = '22012'; end $f$;
    create function public.tst_rule_task() returns jsonb language sql volatile set search_path = '' as
      $f$ select jsonb_build_object('ruleSeen', case when coalesce(current_setting('tripnavigate.system_rule', true), '') = '' then 0 else 1 end) $f$;
    create function public.tst_set_rule_task() returns jsonb language plpgsql volatile set search_path = '' as
      $f$ begin perform authz.system_rule('acc3a.test_rule'); return '{}'::jsonb; end $f$;
  `);
  await db.query(`select authz.timer_task_register('tst_ok_task', 'public.tst_ok_task', 1)`);
  await db.query(`select authz.timer_task_register('tst_bad_task', 'public.tst_bad_task', 1)`);
  // Names sort: tst_a_set_rule runs before tst_b_rule_seen (the tick runs tasks by name).
  await db.query(`select authz.timer_task_register('tst_a_set_rule', 'public.tst_set_rule_task', 1)`);
  await db.query(`select authz.timer_task_register('tst_b_rule_seen', 'public.tst_rule_task', 1)`);
}

/** invalid_input (22023) with the given hint; the transaction stays usable. */
async function expectHint(sql: string, params: unknown[], hint: string): Promise<void> {
  await db.exec('savepoint acc3a_hint');
  let error: { code?: string; message?: string; hint?: string } | null = null;
  try {
    await db.query(sql, params);
  } catch (e) {
    error = e as typeof error;
  }
  await db.exec('rollback to savepoint acc3a_hint');
  expect(error, `${sql} ${JSON.stringify(params)}`).not.toBeNull();
  expect({ code: error!.code, message: error!.message, hint: error!.hint }).toEqual({ code: '22023', message: 'invalid_input', hint });
}

describe('foundation schema and privileges', () => {
  it('timer tables: RLS with the session policy, no API privileges; switch Off; timer_health registered', async () => {
    await asOwner(db, async () => {
      const rows = await db.query<{ relname: string; rls: boolean; policies: string[] }>(
        `select c.relname, c.relrowsecurity as rls,
                coalesce(array_agg(p.policyname::text order by p.policyname) filter (where p.policyname is not null), '{}') as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         left join pg_policies p on p.schemaname = 'public' and p.tablename = c.relname
         where n.nspname = 'public' and c.relname = any($1::text[])
         group by c.relname, c.relrowsecurity order by c.relname`,
        [TABLES],
      );
      expect(rows).toHaveLength(TABLES.length);
      for (const r of rows) {
        expect(r.rls, r.relname).toBe(true);
        expect(r.policies, r.relname).toEqual(['require_valid_session']);
      }
      const privs = await db.query<{ t: string; any: boolean }>(
        `select t, has_table_privilege('anon', 'public.' || t, 'select,insert,update,delete')
                 or has_table_privilege('authenticated', 'public.' || t, 'select,insert,update,delete')
                 or has_table_privilege('service_role', 'public.' || t, 'select,insert,update,delete') as any
         from unnest($1::text[]) t`,
        [TABLES],
      );
      expect(privs.filter((p) => p.any)).toEqual([]);
      const [settings] = await db.query<{ enabled: boolean }>('select enabled from public.timer_settings where id');
      expect(settings).toEqual({ enabled: false });
      const tasks = await db.query<{ name: string; function_name: string; every_minutes: number; enabled: boolean }>(
        `select name, function_name, every_minutes, enabled from public.timer_tasks where name = 'timer_health'`,
      );
      expect(tasks).toEqual([{ name: 'timer_health', function_name: 'authz.timer_health', every_minutes: 5, enabled: true }]);
    });
  });

  it('only timer_tick (service_role) and admin_set_timer_enabled (authenticated) are executable; all definer with empty search_path', async () => {
    const rows = await db.query<{ name: string; anon: boolean; auth: boolean; svc: boolean; secdef: boolean; config: string[] | null }>(
      `select p.oid::regprocedure::text as name,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc,
              p.prosecdef as secdef, p.proconfig as config
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where (n.nspname = 'authz' and p.proname in ('system_rule_ok', 'system_rule', 'write_system_audit',
                'audit_settings_columns', 'timer_settings_touch', 'timer_settings_guard', 'timer_tasks_guard',
                'timer_runs_guard', 'timer_alerts_guard', 'timer_task_register', 'timer_health',
                'dispatch_timer', 'run_scheduled_timer', 'provision_timer_job'))
          or (n.nspname = 'public' and p.proname in ('timer_tick', 'admin_set_timer_enabled'))
       order by 1`,
    );
    expect(rows).toHaveLength(16);
    for (const r of rows) expect(r.config, r.name).toEqual(['search_path=""']);
    expect(rows.filter((r) => r.anon).map((r) => r.name)).toEqual([]);
    expect(rows.filter((r) => r.auth).map((r) => r.name)).toEqual(['admin_set_timer_enabled(boolean,text)']);
    expect(rows.filter((r) => r.svc).map((r) => r.name)).toEqual(['timer_tick()']);
    const definer = new Set(['authz.write_system_audit(text,uuid,uuid,text,uuid,text,jsonb)', 'authz.audit_settings_columns()',
      'authz.timer_settings_guard()', 'authz.timer_tasks_guard()', 'authz.timer_runs_guard()', 'authz.timer_alerts_guard()',
      'authz.timer_task_register(text,text,integer)', 'authz.timer_health()', 'authz.dispatch_timer()',
      'authz.run_scheduled_timer()', 'authz.provision_timer_job()', 'timer_tick()', 'admin_set_timer_enabled(boolean,text)']);
    for (const r of rows) expect(r.secdef, r.name).toBe(definer.has(r.name));
  });

  it('staff cannot call the tick, the actor helpers or the scheduler pieces', async () => {
    await asOwner(db, async () => {
      await setActor(db, SUPER);
      for (const sql of [
        'select public.timer_tick()',
        `select authz.system_rule('acc3a.rule')`,
        `select authz.write_system_audit('messages.sent', null, null, 'x', null, 'acc3a.rule', '{}')`,
        'select authz.run_scheduled_timer()',
        'select authz.dispatch_timer()',
        'select authz.timer_health()',
      ]) {
        await expectDbError(db, () => db.query(sql), { code: '42501' });
      }
    });
  });
});

describe('5.1 "by the CRM" actor', () => {
  it('system_rule validates and records the rule for the transaction', async () => {
    await asOwner(db, async () => {
      const [r] = await db.query<{ r: string; s: string }>(
        `select authz.system_rule('inv_on_approval') as r, current_setting('tripnavigate.system_rule', true) as s`,
      );
      expect(r).toEqual({ r: 'inv_on_approval', s: 'inv_on_approval' });
      for (const bad of ['Ab', 'x', '1abc', 'has space', 'a'.repeat(61), null]) {
        await expectDbError(db, () => db.query('select authz.system_rule($1)', [bad]), { code: '22023', message: /^invalid_input$/ });
      }
    });
  });

  it('write_system_audit adds by: crm and the rule; actor is the caller, null on a timer run', async () => {
    await asOwner(db, async () => {
      // A person's step caused it: the JWT subject is the actor.
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: U.accountsJodhpur, role: 'authenticated' })]);
      await db.query(`select authz.write_system_audit('accounts.customer_document.auto_drafted', null, null, 'customer_document',
        '00000000-0000-4000-8000-0000000000aa', 'adv_on_receipt', '{"kind":"advance_invoice"}')`);
      // The timer caused it: no subject.
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'service_role' })]);
      await db.query(`select authz.write_system_audit('messages.sent', null, null, 'customer_message',
        '00000000-0000-4000-8000-0000000000bb', 'customer_message_dispatch', null)`);
      await resetActor(db);
      const rows = await db.query<{ action: string; actor: string | null; reason: string | null; details: Record<string, unknown> }>(
        `select action, actor_user_id as actor, reason, details from public.audit_events
         where target_id in ('00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-0000000000bb') order by id`,
      );
      expect(rows).toEqual([
        { action: 'accounts.customer_document.auto_drafted', actor: U.accountsJodhpur, reason: null,
          details: { kind: 'advance_invoice', by: 'crm', rule: 'adv_on_receipt' } },
        { action: 'messages.sent', actor: null, reason: null, details: { by: 'crm', rule: 'customer_message_dispatch' } },
      ]);
      await expectDbError(db, () => db.query(`select authz.write_system_audit('messages.sent', null, null, 'x', null, 'Bad Rule', '{}')`),
        { code: '22023', message: /^invalid_input$/ });
      await expectDbError(db, () => db.query(`select authz.write_system_audit('messages.sent', null, null, 'x', null, 'ok_rule', '[]')`),
        { code: '22023', message: /^invalid_input$/ });
    });
  });
});

describe('5.2 timer registry and tick', () => {
  it('registration refuses bad functions, a taken name and bad intervals; re-registering changes the interval', async () => {
    await asOwner(db, async () => {
      await addTestTasks();
      await db.exec(`create function public.tst_args(p integer) returns jsonb language sql as $f$ select '{}'::jsonb $f$;
                     create function public.tst_text() returns text language sql as $f$ select 'x' $f$;`);
      const refuse = (args: unknown[], hint: string) => expectHint('select authz.timer_task_register($1, $2, $3)', args, hint);
      await refuse(['tst_x', 'public.tst_args', 5], 'function_name');
      await refuse(['tst_x', 'public.tst_text', 5], 'function_name');
      await refuse(['tst_x', 'public.tst_missing', 5], 'function_name');
      await refuse(['tst_x', 'other.tst_ok_task', 5], 'function_name');
      await refuse(['tst_x', 'public.tst_ok_task', 0], 'every_minutes');
      await refuse(['tst_x', 'public.tst_ok_task', 1441], 'every_minutes');
      await refuse(['X1', 'public.tst_ok_task', 5], 'name');
      await refuse(['tst_ok_task', 'public.tst_bad_task', 5], 'name');
      await db.query(`select authz.timer_task_register('tst_ok_task', 'public.tst_ok_task', 10)`);
      const [t] = await db.query<{ every_minutes: number }>(`select every_minutes from public.timer_tasks where name = 'tst_ok_task'`);
      expect(t!.every_minutes).toBe(10);
      // No delete, name and function fixed.
      await expectDbError(db, () => db.query(`delete from public.timer_tasks where name = 'tst_ok_task'`), { code: '42501' });
      await expectDbError(db, () => db.query(`update public.timer_tasks set function_name = 'public.tst_bad_task' where name = 'tst_ok_task'`), { code: '42501' });
    });
  });

  it('runs each due task in isolation, records results and codes, sets last_ok_at, and skips tasks not yet due', async () => {
    await asOwner(db, async () => {
      // A real stack may have run the timer before: start from "never ran".
      await db.query('update public.timer_settings set last_ok_at = null where id');
      await db.query(`update public.timer_tasks set enabled = false where name not in ('timer_health')`);
      await addTestTasks();
      const first = await tick();
      expect(first).toMatchObject({ status: 'ok', failed: 1 });
      const tasks = first.tasks as Record<string, unknown>;
      expect(tasks.tst_ok_task).toEqual({ done: 1 });
      expect(tasks.tst_bad_task).toEqual({ errorCode: '22012' });
      expect(tasks.timer_health).toEqual({ alerts: 0 });
      // A rule recorded by an earlier task does not leak into the next one.
      expect(tasks.tst_b_rule_seen).toEqual({ ruleSeen: 0 });
      // The failing task's own write is rolled back; the good task's stays.
      const probe = await db.query<{ n: number }>('select n from public.acc3a_probe order by n');
      expect(probe).toEqual([{ n: 1 }]);
      const reg = await db.query<{ name: string; last_error_code: string | null; last_result: unknown; ran: boolean }>(
        `select name, last_error_code, last_result, last_run_at is not null as ran from public.timer_tasks
         where name in ('tst_ok_task', 'tst_bad_task') order by name`,
      );
      expect(reg).toEqual([
        { name: 'tst_bad_task', last_error_code: '22012', last_result: null, ran: true },
        { name: 'tst_ok_task', last_error_code: null, last_result: { done: 1 }, ran: true },
      ]);
      const runs = await db.query<{ error_code: string | null; finished: boolean; results: Record<string, unknown> }>(
        'select error_code, finished_at is not null as finished, results from public.timer_runs where started_at >= now() order by id',
      );
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ error_code: 'task_failed', finished: true });
      const [s] = await db.query<{ ok: boolean }>('select last_ok_at is not null as ok from public.timer_settings where id');
      expect(s!.ok).toBe(true);

      // Same transaction (same now()): nothing is due again.
      const second = await tick();
      expect(second).toMatchObject({ status: 'ok', ran: 0, failed: 0, tasks: {} });

      // A disabled task never runs; an overdue one runs again.
      await db.query(`update public.timer_tasks set enabled = false where name = 'tst_bad_task'`);
      await db.query(`update public.timer_tasks set last_run_at = now() - interval '2 minutes' where name like 'tst%'`);
      const third = await tick();
      expect(Object.keys(third.tasks as object).filter((k) => k.startsWith('tst')).sort()).toEqual(['tst_a_set_rule', 'tst_b_rule_seen', 'tst_ok_task']);
      expect(third.failed).toBe(0);
    });
  });

  it('a task whose function disappeared or returns a non-object is recorded, not fatal', async () => {
    await asOwner(db, async () => {
      await db.exec(`create function public.tst_array() returns jsonb language sql as $f$ select '[1]'::jsonb $f$;
                     create function public.tst_gone() returns jsonb language sql as $f$ select '{}'::jsonb $f$;`);
      await db.query(`select authz.timer_task_register('tst_array', 'public.tst_array', 1)`);
      await db.query(`select authz.timer_task_register('tst_gone', 'public.tst_gone', 1)`);
      await db.exec('drop function public.tst_gone()');
      const r = await tick();
      expect((r.tasks as Record<string, unknown>).tst_array).toEqual({ errorCode: 'bad_result' });
      expect((r.tasks as Record<string, unknown>).tst_gone).toEqual({ errorCode: 'missing_function' });
    });
  });

  it('timer runs older than 14 days are pruned by the tick; newer ones cannot be removed or changed', async () => {
    await asOwner(db, async () => {
      await db.query(`insert into public.timer_runs (started_at, finished_at) values (now() - interval '15 days', now() - interval '15 days'),
                      (now() - interval '1 day', now() - interval '1 day')`);
      await expectDbError(db, () => db.query(`delete from public.timer_runs where started_at > now() - interval '2 days'`), { code: '42501' });
      await expectDbError(db, () => db.query(`update public.timer_runs set error_code = 'x'`), { code: '42501' });
      const r = await tick();
      expect(r.pruned).toBe(1);
      const [n] = await db.query<{ n: number }>(`select count(*)::int as n from public.timer_runs where started_at < now() - interval '14 days'`);
      expect(n!.n).toBe(0);
    });
  });

  it('timer_health writes one timer_late alert per hour when the last good tick is over 15 minutes old', async () => {
    await asOwner(db, async () => {
      await db.query(`update public.timer_settings set last_ok_at = now() - interval '40 minutes' where id`);
      const [a] = await db.query<{ r: { alerts: number } }>('select authz.timer_health() as r');
      expect(a!.r.alerts).toBe(1);
      const [b] = await db.query<{ r: { alerts: number } }>('select authz.timer_health() as r');
      expect(b!.r.alerts).toBe(0);
      const rows = await db.query<{ kind: string; oldest_minutes: number; hour_key: string }>('select kind, oldest_minutes, hour_key from public.timer_alerts');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'timer_late', oldest_minutes: 40 });
      expect(rows[0]!.hour_key).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}$/);
      await expectDbError(db, () => db.query('delete from public.timer_alerts'), { code: '42501' });
      // A fresh tick is not late.
      await db.query(`update public.timer_settings set last_ok_at = now() where id`);
      const [c] = await db.query<{ r: { alerts: number } }>('select authz.timer_health() as r');
      expect(c!.r.alerts).toBe(0);
    });
  });
});

describe('5.2 scheduler pieces (paused, guarded)', () => {
  it('nothing is scheduled by a migration; without Vault / pg_net nothing is sent; the switch Off stops the scheduled call', async () => {
    await asOwner(db, async () => {
      const [cron] = await db.query<{ has: boolean }>(`select to_regclass('cron.job') is not null as has`);
      if (cron!.has) {
        const jobs = await db.query(`select jobname from cron.job where jobname = 'crm-timer'`);
        expect(jobs).toEqual([]);
      } else {
        await expectDbError(db, () => db.query('select authz.provision_timer_job()'), { code: '55000', message: /pg_cron is not installed/ });
      }
      // Switch Off: no dispatch bookkeeping at all.
      await db.query('select authz.run_scheduled_timer()');
      let [s] = await db.query<{ id: string | null }>('select last_request_id as id from public.timer_settings where id');
      expect(s!.id).toBeNull();
      // Switch On, but no Vault values saved: nothing is sent.
      await db.query('update public.timer_settings set enabled = true where id');
      const [d] = await db.query<{ id: string | null }>('select authz.dispatch_timer() as id');
      expect(d!.id).toBeNull();
      await db.query('select authz.run_scheduled_timer()');
      [s] = await db.query<{ id: string | null }>('select last_request_id as id from public.timer_settings where id');
      expect(s!.id).toBeNull();
    });
  });
});

describe('A11 admin_set_timer_enabled', () => {
  it('Super Admin with a reason; audit settings.timer_changed names the column and never the value', async () => {
    await asOwner(db, async () => {
      await setActor(db, SUPER);
      const [r] = await db.query<{ r: Record<string, unknown> }>('select public.admin_set_timer_enabled(true, $1) as r', [REASON]);
      expect(r!.r).toMatchObject({ changed: true, before: false, after: true });
      const [again] = await db.query<{ r: Record<string, unknown> }>('select public.admin_set_timer_enabled(true, $1) as r', [REASON]);
      expect(again!.r).toMatchObject({ changed: false });
      await resetActor(db);
      // Minute bookkeeping is not a settings change.
      await db.query('update public.timer_settings set last_ok_at = now(), last_request_id = 7, last_dispatched_at = now() where id');
      const audits = await db.query<{ actor: string; reason: string; details: Record<string, unknown>; target_type: string }>(
        `select actor_user_id as actor, reason, details, target_type from public.audit_events where action = 'settings.timer_changed' order by id`,
      );
      expect(audits).toHaveLength(1);
      expect(audits[0]).toEqual({ actor: U.adminJodhpur, reason: REASON, target_type: 'timer_settings',
        details: { operation: 'update', columns: ['enabled'], via: 'command', command: 'admin_set_timer_enabled', reasonGiven: true } });
      const [row] = await db.query<{ enabled: boolean; updated_by: string }>('select enabled, updated_by from public.timer_settings where id');
      expect(row).toEqual({ enabled: true, updated_by: U.adminJodhpur });
    });
  });

  it('refuses non Super Admin, a short reason and a null switch', async () => {
    await asOwner(db, async () => {
      await setActor(db, SALES);
      await expectDbError(db, () => db.query('select public.admin_set_timer_enabled(true, $1)', [REASON]), { code: '42501', message: /^not_authorized$/ });
      await setActor(db, SUPER);
      await expectDbError(db, () => db.query('select public.admin_set_timer_enabled(true, $1)', ['too short']), { code: '22023', message: /^invalid_input$/ });
      await expectDbError(db, () => db.query('select public.admin_set_timer_enabled(null, $1)', [REASON]), { code: '22023', message: /^invalid_input$/ });
      await resetActor(db);
      await expectDbError(db, () => db.query('delete from public.timer_settings'), { code: '42501' });
    });
  });
});
