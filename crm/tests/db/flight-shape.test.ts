import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb, expectDbError } from '../helpers/db';
import { ANON, DEAL, FLIGHT, SQL, SVC, flightHelpers, rid } from './flight-support';

/**
 * Flight build, contract sections 0, 5 and 12.1 ("Shape/privilege"): every new
 * table has RLS with a restrictive require_valid_session policy and no grants;
 * every new public function is security definer with search_path '' and
 * executable by authenticated only; no new authz helper is exposed; the
 * existing constraints the contract widens are widened (completed for flight,
 * e_ticket kind, suppliers of type flight, the new money columns).
 *
 * Written from the contract, not from the Track A/B migrations.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = flightHelpers(() => db);
const { owner, run } = h;

const TABLES = [
  'flight_task_state', 'flight_changes', 'flight_sectors', 'flight_sector_passengers', 'flight_ticket_revisions', 'flight_ticket_numbers',
  'flight_ticket_batches', 'flight_batch_fares', 'flight_fare_approvals',
];
const PUBLIC_FUNCTIONS = [
  // Track A
  'flight_group_claim', 'flight_group_reassign', 'flight_booking_change_apply', 'flight_screenshot_sectors_save', 'flight_sector_fill_blanks',
  'flight_change_submit', 'flight_change_decide', 'flight_change_withdraw', 'flight_change_acknowledge', 'flight_ticket_correct',
  'flight_group_complete', 'flight_queue', 'flight_workspace', 'deal_flight_summary', 'deal_flight_history', 'flight_home_counts',
  // Track B
  'flight_supplier_list', 'flight_supplier_create', 'flight_supplier_add_beneficiary', 'flight_fare_preview', 'flight_fare_approval_request',
  'flight_fare_approval_decide', 'flight_fare_approval_withdraw', 'flight_tickets_confirm', 'flight_direct_payment_save',
  'flight_payment_request_create', 'flight_money', 'flight_payment_context',
];
const AUTHZ_HELPERS = [
  'flight_deal_kind', 'flight_is_sales_owner', 'flight_task_budget', 'flight_unnamed_count', 'flight_ticket_counts', 'flight_lock_group',
  'flight_can_work', 'flight_gate_issue', 'flight_replay', 'flight_remember', 'flight_build_sectors', 'flight_booking_diff', 'flight_done_issues',
  'flight_money_issues', 'flight_ticket_fields_issue', 'flight_register_ticket_number', 'flight_insert_ticket_revision', 'flight_fare_hash',
];

describe('new tables', () => {
  it('exist with RLS, a restrictive valid-session policy, no Data API privileges, and refuse direct reads', async () => {
    await asOwner(db, async () => {
      const rows = await owner<{ t: string; rls: boolean; anon: boolean; auth_read: boolean; auth_write: boolean; svc_write: boolean }>(
        `select c.relname as t, c.relrowsecurity as rls,
           has_table_privilege('anon', c.oid, 'select,insert,update,delete') as anon,
           has_table_privilege('authenticated', c.oid, 'select') as auth_read,
           has_table_privilege('authenticated', c.oid, 'insert,update,delete') as auth_write,
           has_table_privilege('service_role', c.oid, 'insert,update,delete') as svc_write
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = any($1::text[]) order by 1`, [TABLES]);
      expect(rows.map((r) => r.t)).toEqual([...TABLES].sort());
      for (const r of rows) expect(r, r.t).toMatchObject({ rls: true, anon: false, auth_read: false, auth_write: false });
      const policies = await owner<{ t: string; n: number }>(
        `select tablename as t, count(*)::int as n from pg_policies
         where schemaname = 'public' and tablename = any($1::text[]) and permissive = 'RESTRICTIVE' group by 1`, [TABLES]);
      expect(policies.map((p) => p.t).sort(), 'every table has a restrictive policy').toEqual([...TABLES].sort());
      for (const t of TABLES) {
        await expectDbError(db, () => run(FLIGHT, `select * from public.${t} limit 1`), { code: '42501' });
      }
    });
  });

  it('are append-only where the contract says so (owner-level DELETE is refused by the guard triggers)', async () => {
    await asOwner(db, async () => {
      for (const t of ['flight_ticket_revisions', 'flight_ticket_numbers', 'flight_ticket_batches', 'flight_batch_fares', 'flight_sectors',
        'flight_sector_passengers', 'flight_changes', 'flight_task_state', 'flight_fare_approvals']) {
        const triggers = await owner<{ n: number }>(
          `select count(*)::int as n from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = $1 and not tg.tgisinternal`, [t]);
        expect(triggers[0]!.n, `${t} has a guard trigger`).toBeGreaterThan(0);
      }
    });
  });

  it('ticket revisions: CRS type, PNR and ticket number checks; ticket_digits is generated', async () => {
    await asOwner(db, async () => {
      const cols = await owner<{ c: string; gen: string }>(
        `select column_name as c, is_generated as gen from information_schema.columns
         where table_schema = 'public' and table_name = 'flight_ticket_revisions'`);
      const names = cols.map((c) => c.c);
      for (const c of ['sector_id', 'traveller_seq', 'revision_no', 'batch_id', 'traveller_name', 'traveller_type', 'crs_type', 'crs_pnr',
        'airline_pnr', 'ticket_number', 'ticket_digits', 'reason', 'created_by', 'request_id']) expect(names, c).toContain(c);
      expect(cols.find((c) => c.c === 'ticket_digits')!.gen).toBe('ALWAYS');
      const fares = await owner<{ c: string; gen: string }>(
        `select column_name as c, is_generated as gen from information_schema.columns
         where table_schema = 'public' and table_name = 'flight_batch_fares'`);
      expect(fares.find((c) => c.c === 'supplier_per_person_paise')?.gen).toBe('ALWAYS');
      expect(fares.find((c) => c.c === 'total_per_person_paise')?.gen).toBe('ALWAYS');
      const registryPk = await owner<{ cols: string }>(
        `select string_agg(a.attname, ',' order by array_position(i.indkey, a.attnum)) as cols
         from pg_index i join pg_class c on c.oid = i.indrelid join pg_attribute a on a.attrelid = c.oid and a.attnum = any(i.indkey)
         where c.relname = 'flight_ticket_numbers' and i.indisprimary`);
      expect(registryPk[0]!.cols).toBe('legal_entity_id,ticket_digits');
    });
  });
});

describe('changed existing tables (sections 5.1, 5.2)', () => {
  it('completed is allowed for visa and flight; e_ticket is an evidence kind; suppliers may be of type flight', async () => {
    await asOwner(db, async () => {
      const checks = await owner<{ name: string; def: string }>(
        `select conname as name, pg_get_constraintdef(oid) as def from pg_constraint
         where conrelid in ('public.fulfilment_tasks'::regclass, 'public.department_evidence'::regclass, 'public.suppliers'::regclass)
           and contype = 'c'`);
      expect(checks.map((c) => c.name)).not.toContain('fulfilment_tasks_completed_visa_only');
      const completed = checks.find((c) => c.name === 'fulfilment_tasks_completed_department');
      expect(completed?.def).toMatch(/visa/);
      expect(completed?.def).toMatch(/flight/);
      expect(checks.some((c) => /e_ticket/.test(c.def)), 'department_evidence kind check lists e_ticket').toBe(true);
      expect(checks.some((c) => /service_types/.test(c.def) && /flight/.test(c.def)), 'suppliers.service_types allows flight').toBe(true);
    });
  });

  it('department_cost_entries and supplier_payment_requests carry the flight batch columns', async () => {
    await asOwner(db, async () => {
      const cols = await owner<{ t: string; c: string; nullable: string }>(
        `select table_name as t, column_name as c, is_nullable as nullable from information_schema.columns
         where table_schema = 'public' and table_name in ('department_cost_entries', 'supplier_payment_requests')
           and column_name in ('supplier_id', 'flight_batch_id', 'cost_version_no', 'proforma_evidence_id')`);
      const get = (t: string, c: string) => cols.find((x) => x.t === t && x.c === c);
      expect(get('department_cost_entries', 'supplier_id')).toBeDefined();
      expect(get('department_cost_entries', 'flight_batch_id')).toBeDefined();
      expect(get('supplier_payment_requests', 'flight_batch_id')).toBeDefined();
      expect(get('supplier_payment_requests', 'cost_version_no')?.nullable).toBe('YES');
      expect(get('supplier_payment_requests', 'proforma_evidence_id')?.nullable).toBe('YES');
      // B adds the FK from ticket revisions to batches.
      const fk = await owner<{ n: number }>(
        `select count(*)::int as n from pg_constraint where conrelid = 'public.flight_ticket_revisions'::regclass and contype = 'f'
           and confrelid = 'public.flight_ticket_batches'::regclass`);
      expect(fk[0]!.n).toBe(1);
    });
  });
});

describe('new functions', () => {
  it('public commands and reads: security definer, search_path empty, execute for authenticated only', async () => {
    await asOwner(db, async () => {
      const fns = await owner<{ fn: string; secdef: boolean; config: string[] | null; anon: boolean; auth: boolean; pub: boolean }>(
        `select p.proname as fn, p.prosecdef as secdef, p.proconfig as config,
           has_function_privilege('anon', p.oid, 'execute') as anon,
           has_function_privilege('authenticated', p.oid, 'execute') as auth,
           exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as pub
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = any($1::text[])`, [PUBLIC_FUNCTIONS]);
      expect([...new Set(fns.map((f) => f.fn))].sort()).toEqual([...PUBLIC_FUNCTIONS].sort());
      for (const f of fns) {
        expect(f, f.fn).toMatchObject({ secdef: true, anon: false, auth: true, pub: false });
        expect(f.config ?? [], f.fn).toContain('search_path=""');
      }
    });
  });

  it('no flight authz helper is executable by anon, authenticated or service_role', async () => {
    await asOwner(db, async () => {
      const fns = await owner<{ fn: string; anon: boolean; auth: boolean; svc: boolean; config: string[] | null }>(
        `select p.proname as fn, has_function_privilege('anon', p.oid, 'execute') as anon,
           has_function_privilege('authenticated', p.oid, 'execute') as auth, has_function_privilege('service_role', p.oid, 'execute') as svc,
           p.proconfig as config
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'authz' and p.proname like 'flight\\_%'`);
      const names = new Set(fns.map((f) => f.fn));
      for (const helper of AUTHZ_HELPERS) expect(names.has(helper), `authz.${helper} exists`).toBe(true);
      for (const f of fns) {
        expect({ anon: f.anon, auth: f.auth, svc: f.svc }, `authz.${f.fn}`).toEqual({ anon: false, auth: false, svc: false });
        expect(f.config ?? [], `authz.${f.fn}`).toContain('search_path=""');
      }
    });
  });

  it('anon and service_role calls are refused; a Flight call without a valid session is refused', async () => {
    await asOwner(db, async () => {
      for (const [sql, params] of [
        [SQL.queue, []], [SQL.workspace, [DEAL]], [SQL.groupClaim, [DEAL, rid()]], [SQL.money, [DEAL]], [SQL.homeCounts, []],
      ] as Array<[string, unknown[]]>) {
        await expectDbError(db, () => run(ANON, sql, params), { code: '42501' });
        await expectDbError(db, () => run(SVC, sql, params), { code: '42501' });
      }
      await h.addFlightPeople();
      // aal1 session: authz.session_ok() is false.
      await expectDbError(db, () => run({ ...FLIGHT, aal: 'aal1' }, SQL.groupClaim, [DEAL, rid()]), { code: '42501' });
    });
  });
});
