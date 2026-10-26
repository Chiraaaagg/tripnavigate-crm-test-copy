import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_EMAILS as E, FIXTURE_USERS as U, type TestDb, asOwner, createTestDb, expectDbError, resetActor, setActor } from '../helpers/db';

/**
 * Stage 6 (sync completion contract 2026-10-08, sections 4 and 7), migration
 * 20261111000100_sync_completion: sync-stopped incidents and their notices, plus the
 * worker run trigger.
 *
 * public.integration_sync_alert_check() mirrors the admin page rule (autoSyncState):
 * switch off = paused (no incident); otherwise stopped unless the last ok/partial
 * reconcile run finished at most 3 x 30 s ago and the pg_cron job 'bitrix-sync'
 * exists and is active. One open incident per portal; a stopped notice and a
 * recovered notice at most once each (integration_sync_alert_mark_sent).
 *
 * PGlite has no pg_cron: cases that need the job create a stand-in cron.job table
 * inside the rolled-back transaction. now() is the transaction time, so a run that
 * "follows" an incident finishes one second after it.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const SVC: Actor = { userId: null, role: 'service_role' };
const MEMBER = 'SYNTHETIC_MEMBER_0001';

interface Notice {
  incidentId: string;
  kind: 'stopped' | 'recovered';
  openedAt: string;
  recoveredAt: string | null;
  reasonCode: string;
  recipients: string[];
}
interface Check {
  send: Notice[];
  emailRecipientsCount: number;
}
interface Incident {
  id: string;
  portal_member_id: string;
  reason_code: string;
  recovered: boolean;
  open_notified: boolean;
  recovery_notified: boolean;
}

async function run<T = Record<string, unknown>>(actor: Actor, sql: string, params: unknown[] = []): Promise<T[]> {
  await setActor(db, actor);
  const rows = await db.query<T>(sql, params);
  await resetActor(db);
  return rows;
}
const check = async () => (await run<{ r: Check }>(SVC, 'select public.integration_sync_alert_check() as r'))[0]!.r;
const mark = (id: string, kind: string) => run(SVC, 'select public.integration_sync_alert_mark_sent($1, $2)', [id, kind]);
const incidents = () =>
  db.query<Incident>(
    `select id, portal_member_id, reason_code, recovered_at is not null as recovered,
            open_notified_at is not null as open_notified, recovery_notified_at is not null as recovery_notified
     -- now() is the transaction time: a closed incident sorts before the open one opened in the same case.
     from public.integration_sync_incidents order by opened_at, recovered_at is null, id`,
  );

const syncOn = (on = true) => db.query('update public.integration_sync_schedule set enabled = $1 where id', [on]);
async function cronJob(active: boolean | null): Promise<void> {
  await db.exec(`create schema if not exists cron; create table if not exists cron.job (jobid bigint, jobname text, schedule text, active boolean)`);
  await db.exec('delete from cron.job');
  if (active !== null) await db.query(`insert into cron.job values (1, 'bitrix-sync', '30 seconds', $1)`, [active]);
}
/** A heartbeat row finishing `offsetSeconds` from the transaction time (negative = ago). */
const heartbeat = (offsetSeconds: number, outcome = 'ok', kind = 'reconcile') =>
  db.query(
    `insert into public.integration_worker_runs (kind, started_at, finished_at, outcome)
     values ($1, now() + make_interval(secs => $2) - interval '5 seconds', now() + make_interval(secs => $2), $3)`,
    [kind, offsetSeconds, outcome],
  );
const dispatch = (id: number, ok: boolean | null, reason: string | null = null, agoSeconds = 10) =>
  db.query(
    `insert into public.integration_sync_dispatches (request_id, dispatched_at, answered_at, status_code, ok, reason)
     values ($1, now() - make_interval(secs => $2), case when $3::boolean is null then null else now() end,
             case when $3::boolean then 200 when not $3::boolean then 401 end, $3, $4)`,
    [id, agoSeconds, ok, reason],
  );
/** Ends every send lease (as if 2 minutes passed without the notice being marked). */
const expireLeases = () =>
  db.query(
    `update public.integration_sync_incidents
     set open_sending_until = case when open_sending_until is null then null else now() - interval '1 second' end,
         recovery_sending_until = case when recovery_sending_until is null then null else now() - interval '1 second' end`,
  );
const audits = async (action: string) =>
  Number((await db.query<{ n: number }>('select count(*)::int as n from public.audit_events where action = $1', [action]))[0]!.n);

describe('stopped, paused and running follow the admin page rule', () => {
  it('paused (switch off): no incident, nothing to send, even with no job and no runs', async () => {
    await asOwner(db, async () => {
      expect(await check()).toEqual({ send: [], emailRecipientsCount: 1 });
      expect(await incidents()).toEqual([]);
    });
  });

  it('running (recent ok or partial reconcile run, job active): no incident', async () => {
    await asOwner(db, async () => {
      await syncOn();
      await cronJob(true);
      await heartbeat(-80, 'partial');
      expect((await check()).send).toEqual([]);
      expect(await incidents()).toEqual([]);
    });
  });

  it('reason codes in the admin page order', async () => {
    const cases: Array<[string, () => Promise<unknown>]> = [
      ['job_missing', async () => {}],
      ['job_missing', () => cronJob(null)],
      ['job_inactive', () => cronJob(false)],
      ['no_scheduler_calls', () => cronJob(true)],
      ['call_failed', async () => { await cronJob(true); await dispatch(1, false, 'The CRM refused the scheduler secret (HTTP 401).'); }],
      ['sync_incomplete', async () => { await cronJob(true); await dispatch(1, true); }],
      ['waiting_for_answer', async () => { await cronJob(true); await dispatch(1, null); }],
      // The newest answered call decides: an older failure after a newer success is not the reason.
      ['sync_incomplete', async () => { await cronJob(true); await dispatch(1, false, 'old failure', 60); await dispatch(2, true, null, 20); }],
    ];
    for (const [reason, setup] of cases) {
      await asOwner(db, async () => {
        await syncOn();
        await setup();
        await heartbeat(-91); // the last success is more than 3 intervals old
        await heartbeat(-5, 'ok', 'worker'); // worker batches do not count (same as the admin page)
        await heartbeat(-5, 'provider_error'); // failed reconcile runs do not count
        const r = await check();
        expect(r.send.map((n) => [n.kind, n.reasonCode]), reason).toEqual([['stopped', reason]]);
        expect((await incidents()).map((i) => i.reason_code)).toEqual([reason]);
      });
    }
  });

  it('a recent success with the job missing or switched off is still stopped', async () => {
    await asOwner(db, async () => {
      await syncOn();
      await heartbeat(-10);
      expect((await check()).send.map((n) => n.reasonCode)).toEqual(['job_missing']);
    });
  });

  it('a portal with intake switched off gets no incident', async () => {
    await asOwner(db, async () => {
      await syncOn();
      await db.query('update public.integration_intake_config set enabled = false');
      expect(await check()).toEqual({ send: [], emailRecipientsCount: 1 });
      expect(await incidents()).toEqual([]);
    });
  });
});

describe('incident lifecycle: open once, notify once, recover once', () => {
  it('opens one incident; the stopped notice is leased, offered again after the lease until marked, then never again', async () => {
    await asOwner(db, async () => {
      await syncOn();
      const first = await check();
      expect(first.emailRecipientsCount).toBe(1);
      expect(first.send).toHaveLength(1);
      const notice = first.send[0]!;
      expect(notice).toMatchObject({ kind: 'stopped', reasonCode: 'job_missing', recoveredAt: null, recipients: [E.adminJodhpur] });
      expect(typeof notice.openedAt).toBe('string');
      // Review L1: the notice is leased for 2 minutes; an overlapping check gets nothing.
      expect(Date.parse((notice as Notice & { sendingUntil: string }).sendingUntil) - Date.parse(notice.openedAt)).toBe(120_000);
      expect((await check()).send).toEqual([]);
      expect(await incidents()).toHaveLength(1);
      // Not marked when the lease ends (send failed): offered again, once.
      await expireLeases();
      const again = (await check()).send;
      expect(again.map((n) => [n.incidentId, n.kind])).toEqual([[notice.incidentId, 'stopped']]);
      expect((await check()).send).toEqual([]);
      await mark(notice.incidentId, 'stopped');
      expect((await check()).send).toEqual([]);
      // Idempotent: marking again changes nothing.
      const [{ at }] = (await db.query<{ at: string }>('select open_notified_at::text as at from public.integration_sync_incidents')) as [{ at: string }];
      await mark(notice.incidentId, 'stopped');
      expect(await db.query('select open_notified_at::text as at from public.integration_sync_incidents')).toEqual([{ at }]);
      expect(await audits('integration.sync_incident_opened')).toBe(1);
    });
  });

  it('a successful run after the incident closes it; the recovered notice is sent once; a new stop opens a new incident', async () => {
    await asOwner(db, async () => {
      await syncOn();
      const [stopped] = (await check()).send;
      await mark(stopped!.incidentId, 'stopped');

      await cronJob(true);
      // The job is back but no run has followed the incident yet: still open, nothing to send.
      await heartbeat(-30);
      expect((await check()).send).toEqual([]);
      expect((await incidents())[0]).toMatchObject({ recovered: false });

      await heartbeat(1);
      const recovered = (await check()).send;
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({ incidentId: stopped!.incidentId, kind: 'recovered', reasonCode: 'job_missing', recipients: [E.adminJodhpur] });
      expect(recovered[0]!.recoveredAt).not.toBeNull();
      // Leased: an overlapping check gets nothing; marking clears the lease.
      expect((await check()).send).toEqual([]);
      await mark(stopped!.incidentId, 'recovered');
      expect(await db.query('select open_sending_until, recovery_sending_until from public.integration_sync_incidents')).toEqual([
        { open_sending_until: null, recovery_sending_until: null },
      ]);
      await mark(stopped!.incidentId, 'recovered');
      expect((await check()).send).toEqual([]);
      expect(await incidents()).toEqual([
        expect.objectContaining({ recovered: true, open_notified: true, recovery_notified: true }),
      ]);
      expect(await audits('integration.sync_incident_recovered')).toBe(1);

      // Stops again: a second incident (the closed one is kept).
      await db.exec(`update cron.job set active = false`);
      expect((await check()).send.map((n) => [n.kind, n.reasonCode])).toEqual([['stopped', 'job_inactive']]);
      expect((await incidents()).map((i) => i.recovered)).toEqual([true, false]);
    });
  });

  it('an incident that recovers before anyone was told sends nothing', async () => {
    await asOwner(db, async () => {
      await syncOn();
      const [stopped] = (await check()).send;
      await cronJob(true);
      await heartbeat(1);
      expect((await check()).send).toEqual([]);
      expect(await incidents()).toEqual([expect.objectContaining({ id: stopped!.incidentId, recovered: true, open_notified: false })]);
      await expectDbError(db, () => mark(stopped!.incidentId, 'recovered'), { code: '22023' });
    });
  });

  it('pausing keeps an open incident open (no recovered notice without a successful run)', async () => {
    await asOwner(db, async () => {
      await syncOn();
      const [stopped] = (await check()).send;
      await mark(stopped!.incidentId, 'stopped');
      await syncOn(false);
      expect((await check()).send).toEqual([]);
      expect((await incidents())[0]).toMatchObject({ recovered: false });
    });
  });

  it('mark_sent refuses an unknown kind, an unknown incident and a recovery notice for an open incident', async () => {
    await asOwner(db, async () => {
      await syncOn();
      const [stopped] = (await check()).send;
      await expectDbError(db, () => mark(stopped!.incidentId, 'resolved'), { code: '22023' });
      await expectDbError(db, () => mark('00000000-0000-4000-8000-000000000000', 'stopped'), { code: '22023' });
      await expectDbError(db, () => mark(stopped!.incidentId, 'recovered'), { code: '22023' });
    });
  });
});

describe('recipients: active staff with an active Super Admin membership', () => {
  it('adds another active Super Admin; ignores invited staff and invited memberships', async () => {
    await asOwner(db, async () => {
      const superAdmin = (user: string, status: string) =>
        db.query(
          `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
           select $1, b.legal_entity_id, b.id, 'super_admin', $2 from public.branches b where b.code = 'JDH'`,
          [user, status],
        );
      await superAdmin(U.salesDelhiB, 'active');
      await superAdmin(U.managerDelhi, 'invited');
      await superAdmin(U.invitedStaff, 'invited');
      await syncOn();
      const r = await check();
      expect(r.emailRecipientsCount).toBe(2);
      expect(r.send[0]!.recipients).toEqual([E.adminJodhpur, E.salesDelhiB].sort());
      // A deactivated membership drops out at the next check.
      await db.query(`update public.memberships set status = 'inactive', deactivated_at = now() where user_id = $1 and role_code = 'super_admin'`, [U.salesDelhiB]);
      await expireLeases();
      expect((await check()).send[0]!.recipients).toEqual([E.adminJodhpur]);
    });
  });
});

describe('append and close only; service role only', () => {
  it('incidents are never deleted and their facts never rewritten', async () => {
    await asOwner(db, async () => {
      await syncOn();
      const [stopped] = (await check()).send;
      await expectDbError(db, () => db.query('delete from public.integration_sync_incidents'), { code: '23514' });
      await expectDbError(db, () => db.query(`update public.integration_sync_incidents set reason_code = 'job_inactive'`), { code: '23514' });
      await expectDbError(db, () => db.query(`update public.integration_sync_incidents set opened_at = now() - interval '1 day'`), { code: '23514' });
      await mark(stopped!.incidentId, 'stopped');
      await expectDbError(db, () => db.query(`update public.integration_sync_incidents set open_notified_at = null`), { code: '23514' });
      // One open incident per portal.
      await expectDbError(db, () => db.query(`insert into public.integration_sync_incidents (portal_member_id, reason_code) values ($1, 'job_missing')`, [MEMBER]), {
        code: '23505',
      });
    });
  });

  it('only the service role runs the commands; no API role reads the table; RLS is on', async () => {
    const rows = await db.query<{ role: string; check: boolean; mark: boolean; sel: boolean }>(`
      select r as role,
        has_function_privilege(r, 'public.integration_sync_alert_check()', 'execute') as check,
        has_function_privilege(r, 'public.integration_sync_alert_mark_sent(uuid, text)', 'execute') as mark,
        has_table_privilege(r, 'public.integration_sync_incidents', 'select') as sel
      from unnest(array['anon', 'authenticated', 'service_role']) r`);
    expect(rows).toEqual([
      { role: 'anon', check: false, mark: false, sel: false },
      { role: 'authenticated', check: false, mark: false, sel: false },
      { role: 'service_role', check: true, mark: true, sel: false },
    ]);
    const defs = await db.query<{ name: string; secdef: boolean; config: string[]; pub: boolean }>(
      `select p.proname as name, p.prosecdef as secdef, p.proconfig as config, has_function_privilege('public', p.oid, 'execute') as pub
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where (n.nspname = 'public' and p.proname in ('integration_sync_alert_check', 'integration_sync_alert_mark_sent'))
          or (n.nspname = 'authz' and p.proname = 'integration_sync_incident_guard')
       order by 1`,
    );
    expect(defs).toHaveLength(3);
    for (const d of defs) expect(d, d.name).toMatchObject({ secdef: true, config: ['search_path=""'], pub: false });
    const [{ rls }] = (await db.query<{ rls: boolean }>(
      `select relrowsecurity as rls from pg_class where oid = 'public.integration_sync_incidents'::regclass`,
    )) as [{ rls: boolean }];
    expect(rls).toBe(true);
    await asOwner(db, async () => {
      await expectDbError(db, () => run({ userId: U.adminJodhpur }, 'select public.integration_sync_alert_check()'), { code: '42501' });
      await expectDbError(db, () => run({ userId: U.adminJodhpur }, 'select id from public.integration_sync_incidents'), { code: '42501' });
    });
  });
});

describe('worker run trigger (integration_record_worker_run)', () => {
  const record = (extra: Record<string, unknown>) =>
    run<{ r: { runId: string } }>(SVC, 'select public.integration_record_worker_run($1::jsonb) as r', [
      JSON.stringify({ kind: 'worker', startedAt: new Date(Date.now() - 2000).toISOString(), finishedAt: new Date().toISOString(), outcome: 'ok', claimed: 1, ...extra }),
    ]).then((rows) => rows[0]!.r.runId);
  const triggerOf = async (id: string) =>
    (await db.query<{ t: string | null }>('select run_trigger as t from public.integration_worker_runs where id = $1', [id]))[0]!.t;

  it('stores event, cron and manual; absent or null stays null; anything else is refused', async () => {
    await asOwner(db, async () => {
      expect(await triggerOf(await record({ trigger: 'event' }))).toBe('event');
      expect(await triggerOf(await record({ trigger: 'cron' }))).toBe('cron');
      expect(await triggerOf(await record({ trigger: 'manual' }))).toBe('manual');
      expect(await triggerOf(await record({}))).toBeNull();
      expect(await triggerOf(await record({ trigger: null }))).toBeNull();
      await expectDbError(db, () => record({ trigger: 'push' }), { code: '22023', message: /invalid run trigger/ });
      await expectDbError(db, () => record({ trigger: 1 }), { code: '22023', message: /invalid run trigger/ });
      // Other unknown keys are still refused.
      await expectDbError(db, () => record({ source: 'event' }), { code: '22023', message: /unknown run field/ });
    });
  });
});
