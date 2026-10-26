import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Actor,
  FIXTURE_EMAILS,
  FIXTURE_USERS as U,
  SYNTHETIC_INTAKE_CONFIG,
  type TestDb,
  asOwner,
  createTestDb,
  expectDbError,
  fixtureFiles,
  migrationFiles,
  resetActor,
  setActor,
} from '../helpers/db';

/**
 * Migration 20261114000100_settings_change_audit: the live switches (finance
 * receipt modes, real booking, live supplier confirmation) change through
 * Super Admin commands that require a reason, and every change to those rows
 * or to the Bitrix intake scope (whoever runs it, including direct SQL as the
 * table owner) leaves one audit_events row with the person, the database role
 * and the approval reason.
 *
 * Every scenario runs in one rolled-back transaction as the database owner and
 * switches to the impersonated request only for the statement under test.
 */

/**
 * Hosted Supabase grants every new public table to service_role by default
 * (default privileges), which is how service_role came to hold insert, update,
 * delete and truncate on audit_events. The shared PGlite shim has no such
 * default, so this file builds its own PGlite database with the same default
 * in place before the migrations run: the revokes in 20261114000100 are then
 * proven, not merely absent. A real local Supabase (TEST_DATABASE_URL) already
 * has the defaults.
 */
async function createDbWithServiceRoleDefaults(): Promise<TestDb> {
  if (process.env.TEST_DATABASE_URL) return createTestDb();
  const pg = new PGlite();
  await pg.exec(readFileSync(join(import.meta.dirname, '..', 'helpers', 'supabase-shim.sql'), 'utf8'));
  const users = Object.entries(U)
    .map(([key, id]) => `('${id}', '${FIXTURE_EMAILS[key as keyof typeof U]}')`)
    .join(',\n');
  await pg.exec(`insert into auth.users (id, email) values ${users};`);
  await pg.exec('alter default privileges in schema public grant all on tables to service_role');
  for (const file of migrationFiles()) await pg.exec(readFileSync(file, 'utf8'));
  for (const file of fixtureFiles()) await pg.exec(readFileSync(file, 'utf8'));
  return {
    mode: 'pglite',
    async query(sql, params) {
      return (await pg.query(sql, params)).rows as never;
    },
    async exec(sql) {
      await pg.exec(sql);
    },
    async close() {
      await pg.close();
    },
  };
}

let db: TestDb;
beforeAll(async () => {
  db = await createDbWithServiceRoleDefaults();
});
afterAll(async () => {
  await db?.close();
});

const ADMIN: Actor = { userId: U.adminJodhpur };
const ADMIN_AAL1: Actor = { userId: U.adminJodhpur, aal: 'aal1' };
const ACC: Actor = { userId: U.accountsJodhpur };
const SALES: Actor = { userId: U.salesDelhiA };
const MANAGER: Actor = { userId: U.managerDelhi };
const ANON: Actor = { userId: null };
const SVC: Actor = { userId: null, role: 'service_role' };
const REASON = 'Owner approval "4 YES" in chat, 9 October 2026';

interface AuditRow {
  action: string;
  actor_user_id: string | null;
  legal_entity_id: string | null;
  target_type: string;
  target_id: string | null;
  reason: string | null;
  details: {
    operation: string;
    changes: Record<string, { from: unknown; to: unknown }>;
    via: string;
    command: string | null;
    dbRole: string;
    jwtRole: string | null;
    reasonGiven: boolean;
    transactionId: string;
  };
}

async function run<T = Record<string, unknown>>(actor: Actor, sql: string, params: unknown[] = []): Promise<T[]> {
  await setActor(db, actor);
  const rows = await db.query<T>(sql, params);
  await resetActor(db);
  return rows;
}

const refused = (actor: Actor, sql: string, params: unknown[], code: string) =>
  expectDbError(db, () => run(actor, sql, params), { code });

async function entity(): Promise<string> {
  const [row] = await db.query<{ id: string }>(`select id from public.legal_entities where code = 'HOLIDAY_CHACHA'`);
  return row!.id;
}

async function settingsAudit(): Promise<AuditRow[]> {
  return db.query<AuditRow>(
    `select action, actor_user_id, legal_entity_id, target_type, target_id, reason, details
     from public.audit_events where action like 'settings.%' order by id`,
  );
}

async function addMembership(userId: string, branchCode: string, role: string): Promise<void> {
  await db.query(
    `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
     select $1, b.legal_entity_id, b.id, $3, 'active' from public.branches b where b.code = $2`,
    [userId, branchCode, role],
  );
}

const setFinance = (actor: Actor, e: string, modes: unknown, reason: string | null = REASON) =>
  run<{ r: Record<string, unknown> }>(actor, 'select public.admin_set_finance_live_modes($1, $2::jsonb, $3) as r', [
    e,
    JSON.stringify(modes),
    reason,
  ]);
const setBooking = (actor: Actor, on: boolean | null, reason: string | null = REASON) =>
  run<{ r: Record<string, unknown> }>(actor, 'select public.admin_set_booking_live($1, $2) as r', [on, reason]);
const setSupplier = (actor: Actor, on: boolean | null, reason: string | null = REASON) =>
  run<{ r: Record<string, unknown> }>(actor, 'select public.admin_set_supplier_confirmation_live($1, $2) as r', [on, reason]);

describe('settings change audit: privileges', () => {
  it('only authenticated may execute the commands; no helper is executable through the API', async () => {
    const rows = await db.query<{ name: string; anon: boolean; auth: boolean; svc: boolean }>(
      `select p.oid::regprocedure::text as name,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where (n.nspname = 'public' and p.proname like 'admin_set_%')
          or (n.nspname = 'authz' and p.proname in ('can_switch_live_settings', 'settings_change_reason',
              'audit_settings_change', 'touch_settings_updated_at', 'refuse_settings_truncate',
              'settings_begin_change', 'settings_end_change'))
       order by 1`,
    );
    // 10 from this migration plus admin_set_workflow_setting (B1, 20261118000100).
    expect(rows).toHaveLength(11);
    expect(rows.filter((r) => r.anon || r.svc)).toEqual([]);
    expect(rows.filter((r) => r.auth).map((r) => r.name)).toEqual([
      'admin_set_booking_live(boolean,text)',
      'admin_set_finance_live_modes(uuid,jsonb,text)',
      'admin_set_supplier_confirmation_live(boolean,text)',
      'admin_set_workflow_setting(text,boolean,text)',
    ]);
  });

  it('each of the 10 new functions has the expected SECURITY DEFINER flag and an empty search_path', async () => {
    const expected: Record<string, boolean> = {
      'public.admin_set_finance_live_modes(uuid,jsonb,text)': true,
      'public.admin_set_booking_live(boolean,text)': true,
      'public.admin_set_supplier_confirmation_live(boolean,text)': true,
      'authz.can_switch_live_settings(uuid)': true,
      'authz.audit_settings_change()': true,
      'authz.settings_change_reason(text)': false,
      'authz.touch_settings_updated_at()': false,
      'authz.refuse_settings_truncate()': false,
      'authz.settings_begin_change(text,text)': false,
      'authz.settings_end_change(text[])': false,
    };
    for (const [fn, secdef] of Object.entries(expected)) {
      const [row] = await db.query<{ secdef: boolean; config: string[] | null }>(
        `select p.prosecdef as secdef, p.proconfig as config from pg_proc p where p.oid = $1::regprocedure`,
        [fn],
      );
      expect({ fn, secdef: row!.secdef, config: row!.config }).toEqual({ fn, secdef, config: ['search_path=""'] });
    }
  });

  it('no API role can write the settings tables or audit_events directly; service_role keeps its reads', async () => {
    const rows = await db.query<{ t: string; r: string; write: boolean; sel: boolean }>(
      `select t, r, has_table_privilege(r, 'public.' || t, 'insert,update,delete,truncate') as write,
              has_table_privilege(r, 'public.' || t, 'select') as sel
       from unnest(array['booking_settings', 'finance_live_settings', 'procurement_settings',
                         'integration_intake_config', 'audit_events']) t,
            unnest(array['anon', 'authenticated', 'service_role']) r`,
    );
    expect(rows.filter((x) => x.write)).toEqual([]);
    expect(rows.filter((x) => x.r === 'service_role' && x.sel).map((x) => x.t).sort()).toEqual([
      'audit_events',
      'booking_settings',
      'integration_intake_config',
      'procurement_settings',
    ]);
    await asOwner(db, async () => {
      await refused(SVC, `update public.integration_intake_config set enabled = false`, [], '42501');
      await refused(SVC, `insert into public.audit_events (action, target_type) values ('x.y', 'z')`, [], '42501');
      await refused(SVC, `update public.audit_events set reason = 'x'`, [], '42501');
      await refused(SVC, `delete from public.audit_events`, [], '42501');
      await refused(SVC, `truncate public.audit_events`, [], '42501');
      // Default privileges really were in place: an untouched table still has them.
      const [d] = await db.query<{ w: boolean }>(
        `select has_table_privilege('service_role', 'public.legal_entities', 'insert,update,delete,truncate') as w`,
      );
      if (db.mode === 'pglite') expect(d!.w).toBe(true);
      const [sel] = await run<{ n: number }>(SVC, `select count(*)::int as n from public.audit_events`);
      expect(sel!.n).toBeGreaterThan(0);
      await refused(SVC, `update public.booking_settings set real_booking_enabled = true where id`, [], '42501');
      await refused(ADMIN, `update public.procurement_settings set live_supplier_confirmation_enabled = true`, [], '42501');
    });
  });
});

describe('admin_set_finance_live_modes', () => {
  it('Super Admin at aal2 switches modes; one audit row names the person, the reason and before/after', async () => {
    await asOwner(db, async () => {
      const e = await entity();
      await db.query(`update public.finance_live_settings set updated_at = '2026-10-06T13:47:45Z' where legal_entity_id = $1`, [e]);
      const before = (await settingsAudit()).length;
      const [res] = await setFinance(ADMIN, e, { upi: true, cash: true });
      expect(res!.r).toMatchObject({
        legalEntityId: e,
        changed: true,
        before: { bank_transfer: false, upi: false, cash: false, cheque: false },
        after: { bank_transfer: false, upi: true, cash: true, cheque: false },
      });
      const [row] = await db.query<{ upi: boolean; cash: boolean; moved: boolean }>(
        `select upi_live as upi, cash_live as cash, updated_at > '2026-10-07' as moved
         from public.finance_live_settings where legal_entity_id = $1`,
        [e],
      );
      expect(row).toEqual({ upi: true, cash: true, moved: true });

      const audit = (await settingsAudit()).slice(before);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: 'settings.finance_live_changed',
        actor_user_id: U.adminJodhpur,
        legal_entity_id: e,
        target_type: 'finance_live_settings',
        target_id: e,
        reason: REASON,
        details: {
          operation: 'update',
          via: 'command',
          command: 'admin_set_finance_live_modes',
          dbRole: 'authenticated',
          jwtRole: 'authenticated',
          reasonGiven: true,
          changes: { upi_live: { from: false, to: true }, cash_live: { from: false, to: true } },
        },
      });
      expect(Object.keys(audit[0]!.details.changes).sort()).toEqual(['cash_live', 'upi_live']);

      // The command leaves no reason behind for later statements in the transaction.
      const [g] = await db.query<{ c: string | null; r: string | null }>(
        `select current_setting('tripnavigate.change_command', true) as c, current_setting('tripnavigate.change_reason', true) as r`,
      );
      expect([g!.c ?? '', g!.r ?? '']).toEqual(['', '']);
    });
  });

  it('a call that changes nothing writes no audit row', async () => {
    await asOwner(db, async () => {
      const e = await entity();
      const before = (await settingsAudit()).length;
      const [res] = await setFinance(ADMIN, e, { cheque: false });
      expect(res!.r).toMatchObject({ changed: false });
      expect((await settingsAudit()).length).toBe(before);
    });
  });

  it('refuses everyone but a Super Admin of that company at aal2 without Accounts', async () => {
    await asOwner(db, async () => {
      const e = await entity();
      const sql = 'select public.admin_set_finance_live_modes($1, $2::jsonb, $3)';
      const args = [e, JSON.stringify({ upi: true }), REASON];
      for (const actor of [ACC, SALES, MANAGER, ADMIN_AAL1]) await refused(actor, sql, args, '42501');
      for (const actor of [ANON, SVC]) await refused(actor, sql, args, '42501');
      // Another company: the admin is not its Super Admin.
      const [other] = await db.query<{ id: string }>(`select id from public.legal_entities where code <> 'HOLIDAY_CHACHA' limit 1`);
      await refused(ADMIN, sql, [other!.id, args[1], REASON], '42501');
      // Super Admin who also holds Accounts there (same separation as finance policy).
      await addMembership(U.adminJodhpur, 'JDH', 'accounts');
      await refused(ADMIN, sql, args, '42501');
      const [row] = await db.query<{ upi: boolean }>(`select upi_live as upi from public.finance_live_settings where legal_entity_id = $1`, [e]);
      expect(row!.upi).toBe(false);
    });
  });

  it('requires a reason of 10 to 500 characters and valid mode switches', async () => {
    await asOwner(db, async () => {
      const e = await entity();
      const sql = 'select public.admin_set_finance_live_modes($1, $2::jsonb, $3)';
      for (const reason of [null, '', '   ', '\t\t\t\t\t\n\n\n\n\n\r\n', ' \n'.repeat(10), 'too short', 'x'.repeat(501)]) {
        await refused(ADMIN, sql, [e, JSON.stringify({ upi: true }), reason], '22023');
      }
      for (const modes of [null, {}, [], { upi: 'yes' }, { card: true }, { upi: true, wallet: false }, { cash: null }]) {
        await refused(ADMIN, sql, [e, modes === null ? null : JSON.stringify(modes), REASON], '22023');
      }
    });
  });
});

describe('admin_set_booking_live and admin_set_supplier_confirmation_live', () => {
  it('Super Admin switches real booking with a reason; audited with before/after', async () => {
    await asOwner(db, async () => {
      const before = (await settingsAudit()).length;
      const [res] = await setBooking(ADMIN, true);
      expect(res!.r).toMatchObject({ changed: true, before: false, after: true });
      const audit = (await settingsAudit()).slice(before);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: 'settings.booking_changed',
        actor_user_id: U.adminJodhpur,
        legal_entity_id: null,
        target_type: 'booking_settings',
        reason: REASON,
        details: { via: 'command', command: 'admin_set_booking_live', changes: { real_booking_enabled: { from: false, to: true } } },
      });
      const [off] = await setBooking(ADMIN, false, 'Switch off again for the test, synthetic');
      expect(off!.r).toMatchObject({ changed: true, before: true, after: false });
      expect((await settingsAudit()).length).toBe(before + 2);
    });
  });

  it('Super Admin switches live supplier confirmation with a reason; audited', async () => {
    await asOwner(db, async () => {
      const before = (await settingsAudit()).length;
      const [res] = await setSupplier(ADMIN, true);
      expect(res!.r).toMatchObject({ changed: true, before: false, after: true });
      const audit = (await settingsAudit()).slice(before);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: 'settings.procurement_changed',
        actor_user_id: U.adminJodhpur,
        reason: REASON,
        details: {
          command: 'admin_set_supplier_confirmation_live',
          changes: { live_supplier_confirmation_enabled: { from: false, to: true } },
        },
      });
    });
  });

  it('refuses non-admins, aal1, anon and the service role; requires a reason and a value', async () => {
    await asOwner(db, async () => {
      for (const sql of ['select public.admin_set_booking_live($1, $2)', 'select public.admin_set_supplier_confirmation_live($1, $2)']) {
        for (const actor of [ACC, SALES, MANAGER, ADMIN_AAL1, ANON, SVC]) await refused(actor, sql, [true, REASON], '42501');
        await refused(ADMIN, sql, [true, null], '22023');
        await refused(ADMIN, sql, [true, 'short'], '22023');
        await refused(ADMIN, sql, [true, '\t\n\r\n\t\n\r\n\t\n\t\n'], '22023');
        await refused(ADMIN, sql, [null, REASON], '22023');
      }
      const [row] = await db.query<{ b: boolean; p: boolean }>(
        `select (select real_booking_enabled from public.booking_settings where id) as b,
                (select live_supplier_confirmation_enabled from public.procurement_settings where id) as p`,
      );
      expect(row).toEqual({ b: false, p: false });
    });
  });
});

describe('safety net: direct SQL is audited too', () => {
  it('owner SQL with an approval reason leaves an audit row naming it (no person, direct_sql)', async () => {
    await asOwner(db, async () => {
      const e = await entity();
      const before = (await settingsAudit()).length;
      await db.query(`select set_config('tripnavigate.change_reason', $1, true)`, [REASON]);
      await db.query(`update public.booking_settings set real_booking_enabled = true, updated_at = now() where id`);
      await db.query(
        `update public.finance_live_settings f set bank_transfer_live = true, upi_live = true, cash_live = true, cheque_live = true
         from public.legal_entities le where le.id = f.legal_entity_id and le.code = 'HOLIDAY_CHACHA'`,
      );
      const audit = (await settingsAudit()).slice(before);
      expect(audit.map((a) => a.action)).toEqual(['settings.booking_changed', 'settings.finance_live_changed']);
      for (const a of audit) {
        expect(a).toMatchObject({ actor_user_id: null, reason: REASON, details: { via: 'direct_sql', command: null, reasonGiven: true } });
        expect(a.details.dbRole).toBeTruthy();
        expect(a.details.dbRole).not.toBe('authenticated');
      }
      expect(Object.keys(audit[1]!.details.changes).sort()).toEqual(['bank_transfer_live', 'cash_live', 'cheque_live', 'upi_live']);
      // Same transaction: both rows carry one transaction id.
      expect(audit[0]!.details.transactionId).toBe(audit[1]!.details.transactionId);
      // updated_at follows the change even though the statement did not set it.
      const [row] = await db.query<{ fresh: boolean }>(
        `select updated_at = now() as fresh from public.finance_live_settings where legal_entity_id = $1`,
        [e],
      );
      expect(row!.fresh).toBe(true);
    });
  });

  it('owner SQL without a reason is still audited, marked reasonGiven false', async () => {
    await asOwner(db, async () => {
      const before = (await settingsAudit()).length;
      await db.query(`update public.procurement_settings set live_supplier_confirmation_enabled = true where id`);
      const audit = (await settingsAudit()).slice(before);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ action: 'settings.procurement_changed', reason: null, details: { reasonGiven: false } });
    });
  });

  it('an update that changes no watched column writes nothing', async () => {
    await asOwner(db, async () => {
      const before = (await settingsAudit()).length;
      await db.query(`update public.booking_settings set updated_at = now() where id`);
      await db.query(`update public.finance_live_settings set cash_live = cash_live`);
      await db.query(
        `update public.integration_intake_config set last_reconciled_at = now(), lead_reconciled_at = now(),
           last_reconcile_requested_at = now(), updated_at = now() where id = $1`,
        [SYNTHETIC_INTAKE_CONFIG],
      );
      expect((await settingsAudit()).length).toBe(before);
    });
  });

  it('a sync scope change by operator SQL is audited with old and new values', async () => {
    await asOwner(db, async () => {
      const before = (await settingsAudit()).length;
      const [cfg] = await db.query<{ cutoff: string; entity: string }>(
        `select cutoff_at::text as cutoff, pilot_legal_entity_id as entity from public.integration_intake_config where id = $1`,
        [SYNTHETIC_INTAKE_CONFIG],
      );
      await db.query(`select set_config('tripnavigate.change_reason', 'Owner chose start date 1 September 2026 (reply "2")', true)`);
      await db.query(
        `update public.integration_intake_config set cutoff_at = '2026-09-01T00:00:00+05:30', lead_intake_mode = 'scope',
           lead_reconciled_at = null where id = $1`,
        [SYNTHETIC_INTAKE_CONFIG],
      );
      const audit = (await settingsAudit()).slice(before);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: 'settings.intake_config_changed',
        legal_entity_id: cfg!.entity,
        target_type: 'integration_intake_config',
        target_id: SYNTHETIC_INTAKE_CONFIG,
        reason: 'Owner chose start date 1 September 2026 (reply "2")',
        details: { via: 'direct_sql', changes: { lead_intake_mode: { from: 'manifest', to: 'scope' } } },
      });
      expect(Object.keys(audit[0]!.details.changes).sort()).toEqual(['cutoff_at', 'lead_intake_mode']);
    });
  });

  it('a new intake configuration row is audited as an insert', async () => {
    await asOwner(db, async () => {
      const before = (await settingsAudit()).length;
      await db.query(
        `insert into public.integration_intake_config (portal_domain, portal_member_id, category_id, eligible_stage_ids, cutoff_at,
           pilot_legal_entity_id, pilot_branch_id, enabled)
         select 'second-portal.example.test', 'SYNTHETIC_MEMBER_AUDIT', 0, array['NEW'], now() - interval '1 day',
           b.legal_entity_id, b.id, false from public.branches b where b.code = 'DEL'`,
      );
      const audit = (await settingsAudit()).slice(before);
      expect(audit).toHaveLength(1);
      expect(audit[0]!.details.operation).toBe('insert');
      expect(audit[0]!.details.changes.portal_member_id).toEqual({ from: null, to: 'SYNTHETIC_MEMBER_AUDIT' });
    });
  });

  it('refuses TRUNCATE on the settings tables and on audit_events, even for the owner', async () => {
    await asOwner(db, async () => {
      for (const t of ['booking_settings', 'finance_live_settings', 'procurement_settings', 'integration_intake_config', 'audit_events']) {
        await expectDbError(db, () => db.query(`truncate public.${t} cascade`), { code: '42501' });
      }
    });
  });
});

describe('review fixes', () => {
  it('a missing singleton row is refused (55000), not a silent success', async () => {
    await asOwner(db, async () => {
      await db.query('delete from public.booking_settings');
      await db.query('delete from public.procurement_settings');
      await refused(ADMIN, 'select public.admin_set_booking_live($1, $2)', [true, REASON], '55000');
      await refused(ADMIN, 'select public.admin_set_supplier_confirmation_live($1, $2)', [true, REASON], '55000');
    });
  });

  it('a reason setting made only of spaces, tabs and line breaks counts as no reason', async () => {
    await asOwner(db, async () => {
      const before = (await settingsAudit()).length;
      await db.query(`select set_config('tripnavigate.change_reason', $1, true)`, [' \t\r\n\t ']);
      await db.query(`select set_config('tripnavigate.change_command', $1, true)`, ['\t\n']);
      await db.query(`update public.procurement_settings set live_supplier_confirmation_enabled = true where id`);
      const audit = (await settingsAudit()).slice(before);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ reason: null, details: { reasonGiven: false, command: null, via: 'direct_sql' } });
    });
  });

  it('a write by another definer command during an API request is labelled api, with the person', async () => {
    await asOwner(db, async () => {
      // Batch 4: every product command now labels its change (the sync settings
      // save goes through integration_apply_sync_settings). A temporary definer
      // function owned by the test's owner role stands in for an unlabelled
      // command, so the api branch of the trigger stays proven.
      await db.query(
        `create function pg_temp.batch4_unlabelled_write() returns void language sql security definer set search_path = '' as
         $f$ update public.integration_intake_config set lead_intake_mode = 'scope' $f$`,
      );
      const before = (await settingsAudit()).length;
      await run(ADMIN, 'select pg_temp.batch4_unlabelled_write()');
      const audit = (await settingsAudit()).slice(before);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: 'settings.intake_config_changed',
        actor_user_id: U.adminJodhpur,
        reason: null,
        details: { via: 'api', command: null, dbRole: 'authenticated', jwtRole: 'authenticated' },
      });
    });
  });

  it('a sync settings save (preview, then apply with a reason) is labelled command, with the person and the reason', async () => {
    await asOwner(db, async () => {
      const before = (await settingsAudit()).length;
      await run(
        ADMIN,
        `select public.integration_apply_sync_settings((public.integration_preview_sync_settings(array[7]::bigint[], array['C7:NEW'], '2026-09-01T00:00:00+05:30', true, 'scope') ->> 'previewId')::uuid, $1)`,
        [REASON],
      );
      const audit = (await settingsAudit()).slice(before);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: 'settings.intake_config_changed',
        actor_user_id: U.adminJodhpur,
        reason: REASON,
        details: { via: 'command', command: 'integration_apply_sync_settings', dbRole: 'authenticated', jwtRole: 'authenticated' },
      });
      // The existing semantic row is still written next to it, now with the reason.
      const [n] = await db.query<{ n: number }>(
        `select count(*)::int as n from public.audit_events
         where action = 'integration.settings_updated' and actor_user_id = $1 and reason = $2`,
        [U.adminJodhpur, REASON],
      );
      expect(n!.n).toBe(1);
    });
  });

  it('Super Admins read the company-less settings rows; nobody else does, and other company-less rows stay hidden', async () => {
    await asOwner(db, async () => {
      await setBooking(ADMIN, true);
      await setSupplier(ADMIN, true);
      await db.query(
        `insert into public.audit_events (action, target_type, details) values ('staff.email_failed', 'staff_invitation', '{}')`,
      );
      const read = (actor: Actor) =>
        run<{ action: string }>(actor, `select action from public.audit_events where legal_entity_id is null order by id`);
      expect((await read(ADMIN)).map((r) => r.action)).toEqual(['settings.booking_changed', 'settings.procurement_changed']);
      for (const actor of [ACC, SALES, MANAGER, ADMIN_AAL1]) {
        const rows = await read(actor).catch((e: { code?: string }) => {
          if (e.code === '42501') return [];
          throw e;
        });
        expect(rows).toEqual([]);
      }
    });
  });
});
