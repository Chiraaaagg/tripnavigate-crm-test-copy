import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, asOwner, createTestDb, expectDbError } from '../helpers/db';
import { ANON, CATALOGUE, MANAGER, OWNER, SQL, VISA_A, line, rid, visaHelpers } from './visa-e-support';

/**
 * Visa build, contract sections 0, 5 and 12.1 ("Shape/privilege"): new tables
 * have RLS, a restrictive valid-session policy and no grants; guards forbid
 * DELETE and keep closed rows, removed documents and seen notices fixed; the
 * traveller number changes only under the relink transition; every new
 * public function is security definer with search_path '' and executable by
 * authenticated only; the old desk commands are revoked (C16); the frozen
 * document catalogue; the unique indexes that replace (task_id, traveller_seq).
 *
 * Written from the contract, not from the Track A migrations.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = visaHelpers(() => db);
const { owner, run, one } = h;

const NEW_TABLES = ['visa_application_documents', 'visa_result_notices'];
const DESK_TABLES = ['visa_applications', ...NEW_TABLES];
const PUBLIC_FUNCTIONS = [
  // Commands C1-C15 (section 6)
  'visa_task_claim', 'visa_application_set_row', 'visa_application_document_add', 'visa_application_document_remove', 'visa_applications_apply',
  'visa_application_decide', 'visa_application_set_handover', 'visa_application_mark_delivered', 'visa_application_withdraw',
  'visa_application_reapply', 'visa_document_file_begin', 'visa_fee_send', 'visa_application_confirm_traveller', 'visa_result_notice_ack',
  'department_cost_save', 'department_evidence_begin',
  // Reads (section 9)
  'visa_queue', 'visa_workspace', 'deal_visa_summary', 'deal_visa_history', 'visa_home_counts', 'department_task_history',
];
/** Internal helpers named by the contract (sections 4, 5, 6, 7). */
const AUTHZ_HELPERS = [
  'visa_effective_kind', 'visa_not_ready', 'visa_document_catalogue', 'visa_catalogue_code_ok', 'visa_close', 'visa_replay', 'visa_remember',
  'visa_is_sales_owner', 'visa_applications_guard', 'visa_sync_applications', 'visa_task_complete_if_done', 'visa_application_closed',
  'can_claim_visa_task', 'deal_traveller_seq_high',
];
/** authz helpers a select policy may call (contract 6, "widens the visa_read select policy"). */
const POLICY_HELPERS = new Set(['can_read_visa_task']);

describe('new tables (5.1-5.3)', () => {
  it('have RLS, a restrictive policy, no Data API privileges; reads through the Data API are refused', async () => {
    await asOwner(db, async () => {
      const rows = await owner<{ t: string; rls: boolean; anon: boolean; auth: boolean; svc: boolean; pub: boolean }>(
        `select c.relname as t, c.relrowsecurity as rls,
           has_table_privilege('anon', c.oid, 'select,insert,update,delete') as anon,
           has_table_privilege('authenticated', c.oid, 'select,insert,update,delete') as auth,
           has_table_privilege('service_role', c.oid, 'select,insert,update,delete') as svc,
           exists (select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a where a.grantee = 0) as pub
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = any($1::text[]) order by 1`, [NEW_TABLES]);
      expect(rows.map((r) => r.t)).toEqual([...NEW_TABLES].sort());
      for (const r of rows) expect(r, r.t).toMatchObject({ rls: true, anon: false, auth: false, svc: false, pub: false });
      const policies = await owner<{ t: string }>(
        `select distinct tablename as t from pg_policies where schemaname = 'public' and tablename = any($1::text[]) and permissive = 'RESTRICTIVE'`,
        [NEW_TABLES]);
      expect(policies.map((p) => p.t).sort(), 'every new table has a restrictive policy').toEqual([...NEW_TABLES].sort());
      for (const actor of [VISA_A, MANAGER, OWNER]) {
        for (const t of DESK_TABLES) await expectDbError(db, () => run(actor, `select * from public.${t} limit 1`), { code: '42501' });
      }
    });
  });

  it('visa_applications has the 5.1 columns; the old unique (task_id, traveller_seq) is replaced by the partial indexes', async () => {
    await asOwner(db, async () => {
      const cols = (await owner<{ c: string }>(
        `select column_name as c from information_schema.columns where table_schema = 'public' and table_name = 'visa_applications'`)).map((r) => r.c);
      for (const c of ['appointment_date', 'appointment_time', 'remark', 'visa_kind', 'jurisdiction_required', 'jurisdiction_place', 'passport_taken_at',
        'passport_taken_by', 'applied_on', 'applied_remark', 'club_id', 'club_size', 'decision_remark', 'refusal_reason', 'decided_by',
        'evisa_recipient_email', 'evisa_sent_at', 'evisa_sent_by', 'handover_method', 'courier_number', 'handover_set_at', 'handover_set_by',
        'handover_remark', 'delivered_on', 'delivered_at', 'delivered_by', 'delivery_remark', 'withdraw_reason', 'closed_at', 'closed_by',
        'closed_reason', 'removed_at', 'removed_version_id', 'traveller_name_snapshot', 'traveller_type_snapshot', 'reapplication_of_id',
        'superseded_at', 'superseded_by_id']) expect(cols, c).toContain(c);
      // Frozen legacy columns stay (5.1 "Existing columns kept").
      for (const c of ['documents', 'appointment_at', 'appointment_place', 'submitted_at', 'customer_informed_at', 'documents_returned_at']) expect(cols, c).toContain(c);
      const uniques = await owner<{ def: string }>(
        `select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.visa_applications'::regclass and contype = 'u'`);
      expect(uniques.map((u) => u.def)).not.toContain('UNIQUE (task_id, traveller_seq)');
      const idx = await owner<{ name: string; def: string }>(
        `select indexname as name, indexdef as def from pg_indexes where schemaname = 'public' and tablename = 'visa_applications'`);
      const current = idx.find((i) => i.name === 'visa_applications_current_seq_key');
      expect(current?.def).toMatch(/UNIQUE INDEX/);
      expect(current?.def).toMatch(/\(task_id, traveller_seq\)/);
      expect(current?.def).toMatch(/WHERE \(superseded_at IS NULL\)/);
      const reference = idx.find((i) => i.name === 'visa_applications_reference_key');
      expect(reference?.def).toMatch(/UNIQUE INDEX/);
      expect(reference?.def).toMatch(/lower\(reference\)/);
      expect(reference?.def).not.toMatch(/superseded_at/); // superseded rows count (QB10, VL10)
    });
  });

  it('every new FK column has an index (5.1, 5.2, 5.4)', async () => {
    await asOwner(db, async () => {
      const lead = await owner<{ t: string; c: string }>(
        `select c.relname as t, a.attname as c from pg_index i join pg_class c on c.oid = i.indrelid
         join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid and a.attnum = i.indkey[0]
         where n.nspname = 'public'`);
      const has = (t: string, c: string) => lead.some((r) => r.t === t && r.c === c);
      for (const c of ['passport_taken_by', 'decided_by', 'evisa_sent_by', 'handover_set_by', 'delivered_by', 'closed_by', 'removed_version_id',
        'reapplication_of_id', 'superseded_by_id']) expect(has('visa_applications', c), `visa_applications.${c}`).toBe(true);
      expect(has('visa_application_documents', 'application_id')).toBe(true);
      expect(has('visa_application_documents', 'task_id')).toBe(true);
      expect(has('department_cost_entries', 'application_id')).toBe(true);
      expect(has('department_evidence', 'visa_document_id')).toBe(true);
    });
  });
});

describe('guards (5.1-5.4)', () => {
  it('no DELETE; a closed application changes only its supersession and version; seq only under relink; closed_at and superseded_at set once', async () => {
    await asOwner(db, async () => {
      const { taskId } = await h.stickerTask();
      // Seq 1 approved, passport not with us: closed at once (section 7).
      const a1 = await h.makeReady(taskId, 1);
      await h.apply(taskId, [line(a1)]);
      const decided = await h.decide(taskId, await h.app(taskId, 1), 'approved', { handover: { method: 'not_with_us' } });
      expect(decided.closed).toBe(true);
      const closedId = a1.applicationId;
      for (const t of DESK_TABLES) {
        await expectDbError(db, () => owner(`delete from public.${t} where true`), {});
      }
      await expectDbError(db, () => owner('update public.visa_applications set remark = $2 where id = $1', [closedId, 'Synthetic late remark']), {});
      await expectDbError(db, () => owner(`update public.visa_applications set closed_at = closed_at + interval '1 day' where id = $1`, [closedId]), {});
      await expectDbError(db, () => owner(`update public.visa_applications set closed_reason = 'delivered' where id = $1`, [closedId]), {});
      await owner('update public.visa_applications set row_version = row_version + 1, updated_at = now() where id = $1', [closedId]);
      // Seq 2: the traveller number changes only under authz.visa_transition = 'relink'.
      const a2 = await h.app(taskId, 2);
      await expectDbError(db, () => owner('update public.visa_applications set traveller_seq = 99 where id = $1', [a2.applicationId]), {});
      await expectDbError(db, () => owner('update public.visa_applications set task_id = gen_random_uuid() where id = $1', [a2.applicationId]), {});
      await owner(`select set_config('authz.visa_transition', 'relink', true)`);
      await owner('update public.visa_applications set traveller_seq = 99 where id = $1', [a2.applicationId]);
      await owner(`select set_config('authz.visa_transition', '', true)`);
      // Seq 3: rejected, applied again; the old one is superseded once and for all.
      const a3 = await h.makeReady(taskId, 3);
      await h.apply(taskId, [line(a3)]);
      await h.decide(taskId, await h.app(taskId, 3), 'rejected');
      const r3 = await h.app(taskId, 3);
      await one(VISA_A, SQL.reapply, [r3.applicationId, r3.rowVersion, rid()]);
      expect(await owner('select superseded_at is not null as s, closed_reason from public.visa_applications where id = $1', [r3.applicationId]))
        .toEqual([{ s: true, closed_reason: 'reapplied' }]);
      await expectDbError(db, () => owner(`update public.visa_applications set superseded_at = superseded_at + interval '1 day' where id = $1`, [r3.applicationId]), {});
    });
  });

  it('documents: removed rows are immutable, no DELETE; notices: only seen_at/seen_by, once; a cost entry keeps its applicant', async () => {
    await asOwner(db, async () => {
      const { taskId } = await h.stickerTask();
      const a = await h.app(taskId, 1);
      const added = await one<{ documentId: string; rowVersion: number }>(VISA_A, SQL.docAdd,
        [a.applicationId, a.rowVersion, JSON.stringify({ catalogueCode: 'travel_insurance', received: false, remark: null }), rid()]);
      await one(VISA_A, SQL.docRemove, [added.documentId, added.rowVersion, rid()]);
      await expectDbError(db, () => owner('update public.visa_application_documents set remark = $2 where id = $1', [added.documentId, 'Synthetic']), {});
      await expectDbError(db, () => owner(`update public.visa_application_documents set status = 'received', received_at = now() where id = $1`, [added.documentId]), {});
      await expectDbError(db, () => owner('delete from public.visa_application_documents where id = $1', [added.documentId]), {});
      // Applied alone, approved: one notice and one government fee entry linked to the application.
      const ready = await h.makeReady(taskId, 1);
      await h.apply(taskId, [line(ready)]);
      await h.decide(taskId, await h.app(taskId, 1), 'approved');
      const [notice] = await owner<{ id: string }>('select id from public.visa_result_notices where application_id = $1', [a.applicationId]);
      expect(notice).toBeDefined();
      await expectDbError(db, () => owner(`update public.visa_result_notices set outcome = 'rejected' where id = $1`, [notice!.id]), {});
      await owner('update public.visa_result_notices set seen_at = now(), seen_by = $2 where id = $1', [notice!.id, OWNER.userId]);
      await expectDbError(db, () => owner(`update public.visa_result_notices set seen_at = now() + interval '1 minute' where id = $1`, [notice!.id]), {});
      await expectDbError(db, () => owner('delete from public.visa_result_notices where id = $1', [notice!.id]), {});
      const [entry] = await owner<{ id: string }>('select id from public.department_cost_entries where application_id = $1', [a.applicationId]);
      expect(entry).toBeDefined();
      await expectDbError(db, () => owner('update public.department_cost_entries set application_id = null where id = $1', [entry!.id]), {});
      // department = 'visa' only (5.4 check).
      const checks = await owner<{ def: string }>(
        `select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.department_cost_entries'::regclass and contype = 'c'`);
      expect(checks.some((c) => /application_id IS NULL/.test(c.def) && /visa/.test(c.def))).toBe(true);
    });
  });
});

describe('functions', () => {
  it('public commands and reads: security definer, search_path empty, execute for authenticated only', async () => {
    await asOwner(db, async () => {
      const fns = await owner<{ fn: string; secdef: boolean; config: string[] | null; anon: boolean; auth: boolean; svc: boolean; pub: boolean }>(
        `select p.proname as fn, p.prosecdef as secdef, p.proconfig as config,
           has_function_privilege('anon', p.oid, 'execute') as anon,
           has_function_privilege('authenticated', p.oid, 'execute') as auth,
           has_function_privilege('service_role', p.oid, 'execute') as svc,
           exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as pub
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = any($1::text[])`, [PUBLIC_FUNCTIONS]);
      expect([...new Set(fns.map((f) => f.fn))].sort()).toEqual([...PUBLIC_FUNCTIONS].sort());
      for (const f of fns) {
        expect(f, f.fn).toMatchObject({ secdef: true, anon: false, auth: true, svc: false, pub: false });
        expect(f.config ?? [], f.fn).toContain('search_path=""');
      }
    });
  });

  it('visa authz helpers exist, pin search_path and are not callable by anon, authenticated or service_role (except a policy helper)', async () => {
    await asOwner(db, async () => {
      const fns = await owner<{ fn: string; anon: boolean; auth: boolean; svc: boolean; config: string[] | null }>(
        `select p.proname as fn, has_function_privilege('anon', p.oid, 'execute') as anon,
           has_function_privilege('authenticated', p.oid, 'execute') as auth, has_function_privilege('service_role', p.oid, 'execute') as svc,
           p.proconfig as config
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'authz' and (p.proname like 'visa\\_%' or p.proname = any($1::text[]))`, [AUTHZ_HELPERS]);
      const names = new Set(fns.map((f) => f.fn));
      for (const helper of AUTHZ_HELPERS) expect(names.has(helper), `authz.${helper} exists`).toBe(true);
      for (const f of fns) {
        expect(f.anon, `authz.${f.fn} anon`).toBe(false);
        expect(f.svc, `authz.${f.fn} service_role`).toBe(false);
        if (!POLICY_HELPERS.has(f.fn)) expect(f.auth, `authz.${f.fn} authenticated`).toBe(false);
        expect(f.config ?? [], `authz.${f.fn}`).toContain('search_path=""');
      }
    });
  });

  it('C16: the old desk commands are no longer executable; the old reads stay', async () => {
    await asOwner(db, async () => {
      const rows = await owner<{ fn: string; auth: boolean }>(
        `select p.proname as fn, has_function_privilege('authenticated', p.oid, 'execute') as auth
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname in ('visa_application_update', 'visa_application_set_state', 'visa_task_list', 'visa_task_get', 'department_work_form')
         order by 1`);
      expect(rows).toEqual([
        { fn: 'department_work_form', auth: true }, { fn: 'visa_application_set_state', auth: false },
        { fn: 'visa_application_update', auth: false }, { fn: 'visa_task_get', auth: true }, { fn: 'visa_task_list', auth: true },
      ]);
      const { taskId } = await h.stickerTask();
      const a = await h.app(taskId, 1);
      await expectDbError(db, () => run(VISA_A, SQL.oldUpdate, [a.applicationId, a.rowVersion, JSON.stringify({ reference: 'SYN-OLD' })]), { code: '42501' });
      await expectDbError(db, () => run(VISA_A, SQL.oldSetState, [a.applicationId, a.rowVersion, 'withdrawn', null]), { code: '42501' });
    });
  });

  it('anon calls are refused; an aal1 session is refused', async () => {
    await asOwner(db, async () => {
      const id = rid();
      for (const [sql, params] of [[SQL.queue, []], [SQL.workspace, [id]], [SQL.claim, [id]], [SQL.homeCounts, []], [SQL.dealSummary, [id]]] as Array<[string, unknown[]]>) {
        await expectDbError(db, () => run(ANON, sql, params), { code: '42501' });
      }
      await expectDbError(db, () => run({ ...VISA_A, aal: 'aal1' }, SQL.queue, []), {});
    });
  });

  it('the document catalogue is the frozen 25 (section 4); codes are checked by visa_catalogue_code_ok', async () => {
    const rows = await db.query<{ code: string; label: string; ord: number }>('select code, label, ord from authz.visa_document_catalogue() order by ord');
    expect(rows.map((r) => [r.code, r.label])).toEqual(CATALOGUE);
    expect(rows.map((r) => r.ord)).toEqual([...rows.map((r) => r.ord)].sort((x, y) => x - y));
    expect(await db.query(`select authz.visa_catalogue_code_ok('photo') as a, authz.visa_catalogue_code_ok('not_a_code') as b`))
      .toEqual([{ a: true, b: false }]);
  });
});

