import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_USERS as U, type TestDb, asOwner, createTestDb, expectDbError } from '../helpers/db';
import {
  ACC_BOX, ACCOUNTS, ID_BOX, OWNER, REASON, REVERT_FILE, S11_VERSIONS, SQL, SUPER, SVC, bodyOf, s11Files, s11Helpers, stripComments,
} from './s11-support';

/**
 * S11 "files to Bitrix", migration 20261212000100 (tables, constraints,
 * helpers) and the source of all six S11 migrations (contract file 14
 * section 5.2/5.3, file 11 section 4.2 "s11-file-move-schema"):
 *   - no Data API access to any S11 table; functions granted exactly as
 *     intended (worker commands: service_role; staff commands: authenticated;
 *     every authz helper: nobody);
 *   - both safety check constraints (no delete_pending with one observation,
 *     with a second observation before delete_after, with a hold under 15
 *     minutes, or with keep_in_crm), the other row constraints and the guards;
 *   - the trigger that limits the box to the identity box and the configured
 *     Accounts box;
 *   - hold floor 15 minutes, accounts_hold_days at least 90, all three
 *     switches Off by default;
 *   - source scan: no URL, host, bearer value or Vault write; cron.schedule
 *     only inside the provisioning function.
 * Synthetic fixtures; every case rolled back.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const s = s11Helpers(() => db);
const { one, owner, refused } = s;

const TABLES = ['file_bitrix_moves', 'file_move_settings', 'file_move_kick_state', 'file_move_stops', 'file_bitrix_views', 'file_move_box_state'];
const WORKER_FUNCTIONS = [
  'file_move_claim', 'file_move_mark_sending', 'file_move_record_observation', 'file_move_complete', 'file_move_confirm_deleted',
  'file_move_confirm_restored', 'file_move_stop', 'file_move_presence_result', 'file_move_relocated', 'file_move_sweep', 'file_view_resolve',
];
const STAFF_FUNCTIONS = [
  'file_view_begin', 'file_view_finish', 'file_move_settings_get', 'file_move_set_switch', 'file_move_set_hold', 'file_move_set_accounts_box',
  'file_move_set_pilot', 'file_move_acknowledge_stop', 'file_move_alerts', 'file_move_retry', 'file_move_relocate', 'file_move_accept_lost',
];
/** The owner-only helpers named in the builder's notes (every one must exist and be closed to the API roles). */
const AUTHZ_HELPERS = [
  'file_move_deal_lock', 'file_move_try_deal_lock', 'file_move_settings_for', 'file_move_append_in_flight', 'file_move_box_has_sole_copy',
  'file_move_copy_back_before_append', 'file_move_may_check', 'file_move_may_delete', 'file_move_dec43_gate', 'file_move_source',
  'file_move_kind', 'file_move_missing_sources', 'file_move_enqueue_source', 'file_move_cancel_row', 'file_move_open_stop',
  'file_move_delete_off', 'file_move_quarantine', 'kick_file_move', 'file_move_safety_tick', 'file_move_backfill',
  'file_move_request_restore', 'provision_file_move_sweep_job', 'file_move_pilot_make_due',
];

describe('S11 migration source', () => {
  const files = s11Files();
  const code = files.map((f) => stripComments(readFileSync(f, 'utf8'))).join('\n');

  it('the six migration files exist in the reserved range, in order', () => {
    expect(files.map((f) => basename(f))).toEqual([
      '20261212000100_s11_file_move_schema.sql',
      '20261212000110_s11_file_move_enqueue.sql',
      '20261212000120_s11_file_move_commands.sql',
      '20261212000130_s11_file_move_staff.sql',
      '20261212000140_s11_dec43_two_way.sql',
      '20261212000150_s11_file_move_ops.sql',
    ]);
    expect(files.map((f) => basename(f).slice(0, 14))).toEqual(S11_VERSIONS);
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
    expect(code).not.toMatch(/host\.docker\.internal|vercel\.app|supabase\.co|bitrix24\.|localhost|127\.0\.0\.1|\.example\.test/i);
    expect(code).not.toMatch(/Bearer [A-Za-z0-9]/);
    expect(code).not.toMatch(/vault\.create_secret|vault\.update_secret|insert into vault|update vault/i);
    expect(code).not.toMatch(/create extension/i);
    // The only outbound call is the kick, which reads the three existing Vault names.
    const kick = bodyOf(code, 'authz.kick_file_move');
    expect(code.replace(kick, '')).not.toMatch(/net\.http_|vault\./);
    for (const name of ['bitrix_sync_url', 'bitrix_sync_bearer', 'vercel_protection_bypass']) {
      expect(kick).toContain(`from vault.decrypted_secrets s where s.name = '${name}'`);
    }
    expect(kick).toContain("params := jsonb_build_object('task', 'files')");
    expect(kick).toMatch(/exception when others then\s+return false;/);
    // The kick never writes the S4 scheduler rows or the settings.
    expect(kick).not.toMatch(/integration_sync_dispatches|integration_sync_schedule|file_move_settings s set|update public\.file_move_settings/);
  });

  it('schedules a pg_cron job only inside the provisioning function, paused; never on apply', () => {
    const provision = bodyOf(code, 'authz.provision_file_move_sweep_job');
    expect(code.replace(provision, '')).not.toMatch(/cron\.schedule|cron\.alter_job|cron\.unschedule/);
    expect(provision.match(/cron\.schedule\(/g)).toHaveLength(1);
    expect(provision.match(/cron\.alter_job/g)).toHaveLength(1);
    expect(provision).toMatch(/execute 'select cron\.alter_job\(\$1, active := false\)' using v_id;/);
    expect(provision).toContain("'file-move-sweep', '*/10 * * * *', 'select authz.file_move_safety_tick()'");
  });

  it('deletes and drops nothing on apply', () => {
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\btruncate\s+(table\s+)?[a-z_]+\./i);
    expect(code).not.toMatch(/\bdrop\s+(table|function|index|trigger|column|schema|policy|constraint)\b/i);
  });

  it('the prepared revert file is not a migration', () => {
    expect(files.map((f) => basename(f))).not.toContain(basename(REVERT_FILE));
    expect(readFileSync(REVERT_FILE, 'utf8')).toMatch(/NOT A MIGRATION/);
  });
});

describe('S11 privileges', () => {
  it('no API role can touch an S11 table; RLS is on with the restrictive session policy', async () => {
    await asOwner(db, async () => {
      for (const t of TABLES) {
        const [row] = await owner<{ any: boolean; rls: boolean; policy: boolean }>(
          `select (has_table_privilege('anon', 'public.' || $1, 'select,insert,update,delete')
                   or has_table_privilege('authenticated', 'public.' || $1, 'select,insert,update,delete')
                   or has_table_privilege('service_role', 'public.' || $1, 'select,insert,update,delete')) as any,
                  (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'public' and c.relname = $1) as rls,
                  exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = $1
                          and p.policyname = 'require_valid_session' and p.permissive = 'RESTRICTIVE') as policy`,
          [t],
        );
        expect(row, t).toEqual({ any: false, rls: true, policy: true });
      }
      for (const actor of [OWNER, SUPER, SVC]) {
        for (const t of TABLES) await refused(actor, `select * from public.${t}`, [], '42501');
      }
    });
  });

  it('public functions: worker commands for service_role only, staff commands for authenticated only, nothing else', async () => {
    await asOwner(db, async () => {
      const rows = await owner<{ name: string; anon: boolean; auth: boolean; svc: boolean; secdef: boolean; path: string[] | null }>(
        `select p.proname as name, has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as svc,
                p.prosecdef as secdef, p.proconfig as path
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and (p.proname like 'file\\_move\\_%' or p.proname like 'file\\_view\\_%')
         order by 1`,
      );
      expect(rows.map((r) => r.name).sort()).toEqual([...WORKER_FUNCTIONS, ...STAFF_FUNCTIONS].sort());
      for (const r of rows) {
        const worker = WORKER_FUNCTIONS.includes(r.name);
        expect({ name: r.name, anon: r.anon, auth: r.auth, svc: r.svc }).toEqual({ name: r.name, anon: false, auth: !worker, svc: worker });
        expect(r.secdef, r.name).toBe(true);
        expect(r.path, r.name).toEqual(['search_path=""']);
      }
    });
  });

  it('every S11 authz helper is closed to anon, authenticated and service_role', async () => {
    await asOwner(db, async () => {
      const rows = await owner<{ name: string; open: boolean }>(
        `select p.proname as name,
                (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
                 or has_function_privilege('service_role', p.oid, 'execute')) as open
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'authz' and (p.proname like 'file\\_move%' or p.proname like 'file\\_view%'
                                        or p.proname in ('kick_file_move', 'provision_file_move_sweep_job'))`,
      );
      const names = rows.map((r) => r.name);
      for (const helper of AUTHZ_HELPERS) expect(names, helper).toContain(helper);
      expect(rows.filter((r) => r.open)).toEqual([]);
    });
  });

  it('the three restated DEC-43 functions stay service_role only', async () => {
    await asOwner(db, async () => {
      for (const sig of ['bitrix_id_proof_copy_claim(integer, integer)', 'bitrix_id_proof_copy_mark_sending(uuid, uuid, bigint[])',
        'bitrix_id_proof_copy_complete(uuid, uuid, text, text, bigint)']) {
        const [r] = await owner<{ anon: boolean; auth: boolean; svc: boolean }>(
          `select has_function_privilege('anon', $1, 'execute') as anon, has_function_privilege('authenticated', $1, 'execute') as auth,
                  has_function_privilege('service_role', $1, 'execute') as svc`,
          [`public.${sig}`],
        );
        expect(r, sig).toEqual({ anon: false, auth: false, svc: true });
      }
    });
  });

  it('worker commands refuse authenticated callers; staff commands refuse the service role', async () => {
    await asOwner(db, async () => {
      for (const actor of [OWNER, SUPER]) {
        await refused(actor, SQL.claim, [1, 180], '42501');
        await refused(actor, SQL.sweep, [], '42501');
        await refused(actor, SQL.viewResolve, [crypto.randomUUID()], '42501');
      }
      await refused(SVC, SQL.settingsGet, [], '42501');
      await refused(SVC, SQL.viewBegin, ['traveller_id_proofs', crypto.randomUUID()], '42501');
      await refused(SVC, SQL.setSwitch, ['check_id_proof_copies', true, REASON], '42501');
    });
  });
});

describe('file_bitrix_moves constraints and guards', () => {
  /** A waiting identity row on a test-only Bitrix Deal (traveller proof stored, Storage row present). */
  async function identityRow(sourceDealId: number) {
    const deal = await s.bitrixDeal(sourceDealId);
    const proof = await s.storeProof(deal, 1, { object: true });
    const id = await s.moveIdOf('traveller_id_proofs', proof.fileId);
    return { deal, proof, id };
  }
  const violates = (sets: string, id: string, re: RegExp, code = '23514') =>
    expectDbError(db, () => s.setMove(id, sets), { code, message: re });
  const CHECKED = `bitrix_file_id = 501, verified_sha256 = m.sha256, verified_size_bytes = m.size_bytes,
    verified_at = now() - interval '40 minutes', delete_after = now() - interval '25 minutes'`;
  const RECHECKED = `reverified_sha256 = m.sha256, reverified_size_bytes = m.size_bytes, reverified_at = now() - interval '20 minutes',
    reverified_after_append_at = now() - interval '21 minutes'`;

  it('first check: verified needs a matching observation, a Bitrix id and a hold of at least 15 minutes', async () => {
    await asOwner(db, async () => {
      const { id } = await identityRow(993101);
      await violates(`state = 'verified'`, id, /file_bitrix_moves_first_check/);
      await violates(`state = 'verified', ${CHECKED}, verified_sha256 = repeat('0', 64)`, id, /file_bitrix_moves_first_check/);
      await violates(`state = 'verified', ${CHECKED}, verified_size_bytes = m.size_bytes + 1`, id, /file_bitrix_moves_first_check/);
      await violates(`state = 'verified', ${CHECKED}, bitrix_file_id = null`, id, /file_bitrix_moves_first_check/);
      // A hold of 14 minutes is refused by the constraint itself (15 is hard coded).
      await violates(`state = 'verified', ${CHECKED}, delete_after = now() - interval '26 minutes'`, id, /file_bitrix_moves_first_check/);
      await s.setMove(id, `state = 'verified', ${CHECKED}`);
      expect((await s.move(id)).state).toBe('verified');
    });
  });

  it('second check: delete_pending needs a second matching observation at or after the hold, after the last append, never keep_in_crm', async () => {
    await asOwner(db, async () => {
      const { id } = await identityRow(993102);
      // One observation only.
      await violates(`state = 'delete_pending', ${CHECKED}, reverified_after_append_at = now()`, id, /file_bitrix_moves_second_check/);
      // The second observation before delete_after.
      await violates(`state = 'delete_pending', ${CHECKED}, ${RECHECKED}, reverified_at = now() - interval '26 minutes'`, id,
        /file_bitrix_moves_second_check/);
      // A different hash at the second observation.
      await violates(`state = 'delete_pending', ${CHECKED}, ${RECHECKED}, reverified_sha256 = repeat('1', 64)`, id,
        /file_bitrix_moves_second_check/);
      // Pinned in the CRM.
      await violates(`state = 'delete_pending', ${CHECKED}, ${RECHECKED}, keep_in_crm = true`, id, /file_bitrix_moves_second_check/);
      // Not proved later than the last append.
      await violates(`state = 'delete_pending', ${CHECKED}, ${RECHECKED}, reverified_after_append_at = null`, id,
        /file_bitrix_moves_after_append_check/);
      await s.setMove(id, `state = 'delete_pending', ${CHECKED}, ${RECHECKED}`);
      expect((await s.move(id)).state).toBe('delete_pending');
    });
  });

  it('deleted needs deleted_at and no CRM copy; the CRM copy fact changes only under the confirm functions\' flag', async () => {
    await asOwner(db, async () => {
      const { id } = await identityRow(993103);
      await s.setMove(id, `state = 'delete_pending', ${CHECKED}, ${RECHECKED}`);
      await violates(`state = 'deleted', deleted_at = now()`, id, /file_bitrix_moves_deleted_check/);
      // Direct change of crm_copy_present is refused by the guard (42501).
      await violates(`crm_copy_present = false, deleted_at = now()`, id, /crm_copy_present is written only by/, '42501');
      // With the flag (what the two confirm functions set), and only consistently.
      await expectDbError(db, () => s.setMoveAsCopyWriter(id, `crm_copy_present = false`), { code: '23514', message: /file_bitrix_moves_copy_fact_check/ });
      await s.setMoveAsCopyWriter(id, `state = 'deleted', crm_copy_present = false, deleted_at = now()`);
      expect(await s.move(id)).toMatchObject({ state: 'deleted', crm_copy_present: false, deleted_at_set: true });
      // The flag is not left on: a later direct change is refused again.
      await violates(`crm_copy_present = true`, id, /crm_copy_present is written only by/, '42501');
    });
  });

  it('the file of a row never changes; a row starts with the CRM copy present; one row per source file; lease columns move together', async () => {
    await asOwner(db, async () => {
      const { id, proof } = await identityRow(993104);
      await violates(`sha256 = repeat('0', 64)`, id, /the file of a move row never changes/);
      await violates(`object_path = 'elsewhere'`, id, /the file of a move row never changes/);
      await violates(`size_bytes = 1`, id, /the file of a move row never changes/);
      await violates(`lease_token = gen_random_uuid()`, id, /file_bitrix_moves_lease/);
      const insert = (copy: boolean, source: string) =>
        owner(
          `insert into public.file_bitrix_moves (legal_entity_id, source_table, source_id, file_class, kind_code, bucket_id, object_path,
             mime, size_bytes, sha256, stored_at, state, crm_copy_present)
           select m.legal_entity_id, m.source_table, $2::uuid, m.file_class, m.kind_code, m.bucket_id, m.object_path, m.mime, m.size_bytes,
             m.sha256, m.stored_at, 'no_target', $3::boolean from public.file_bitrix_moves m where m.id = $1`,
          [id, source, copy],
        );
      await expectDbError(db, () => insert(false, crypto.randomUUID()), { code: '23514', message: /starts with the CRM copy present/ });
      await expectDbError(db, () => insert(true, proof.fileId), { code: '23505', message: /file_bitrix_moves_source_unique/ });
      await expectDbError(db, () => s.setMove(id, `source_table = 'other_table'`), { code: '23514' });
    });
  });

  it('the box is the identity box for class A and the configured Accounts box for class B, nothing else', async () => {
    await asOwner(db, async () => {
      const { deal, id } = await identityRow(993105);
      expect((await s.move(id)).bitrix_field).toBe(ID_BOX);
      await violates(`bitrix_field = '${ACC_BOX}'`, id, /bitrix_field must be the identity box/);
      await violates(`bitrix_field = 'not a key'`, id, /file_bitrix_moves_bitrix_field_check/);
      // Class B: no box configured yet.
      const refund = await s.refundFile(deal, { storedDaysAgo: 1 });
      const acc = await s.moveIdOf('refund_evidence', refund.id);
      expect(await s.move(acc)).toMatchObject({ file_class: 'accounts', kind_code: 'rfd', state: 'waiting', bitrix_field: null });
      await violates(`bitrix_field = '${ACC_BOX}'`, acc, /bitrix_field must be the configured Accounts box/);
      await s.settings({ box: ACC_BOX });
      await violates(`bitrix_field = '${ID_BOX}'`, acc, /bitrix_field must be the configured Accounts box/);
      await violates(`bitrix_field = 'ufCrm_SomeOtherBox'`, acc, /bitrix_field must be the configured Accounts box/);
      await s.setMove(acc, `bitrix_field = '${ACC_BOX}'`);
      expect((await s.move(acc)).bitrix_field).toBe(ACC_BOX);
      // The settings refuse the identity box (or a malformed key) as the Accounts box.
      await expectDbError(db, () => s.settings({ box: ID_BOX }), { code: '23514', message: /file_move_settings_accounts_bitrix_field_check/ });
      await expectDbError(db, () => s.settings({ box: 'Accounts papers' }), { code: '23514', message: /file_move_settings_accounts_bitrix_field_check/ });
    });
  });

  it('stops are append and acknowledge once; views are never deleted and resolve and finish once', async () => {
    await asOwner(db, async () => {
      const { id } = await identityRow(993106);
      const entity = await s.entityId();
      const [stop] = await owner<{ id: string }>(
        `insert into public.file_move_stops (legal_entity_id, move_id, source_deal_id, reason_code) values ($1, $2, 993106, 'copy_mismatch') returning id`,
        [entity, id],
      );
      await expectDbError(db, () => owner('delete from public.file_move_stops where id = $1', [stop!.id]), { code: '23514' });
      await expectDbError(db, () => owner(`update public.file_move_stops set reason_code = 'deal_not_found' where id = $1`, [stop!.id]), { code: '23514' });
      await owner(`update public.file_move_stops set acknowledged_at = now(), acknowledged_by = $2, acknowledge_reason = $3 where id = $1`,
        [stop!.id, U.adminJodhpur, REASON]);
      await expectDbError(db, () => owner(`update public.file_move_stops set acknowledge_reason = 'Another synthetic reason' where id = $1`, [stop!.id]),
        { code: '23514' });

      const [view] = await owner<{ id: string }>(
        `insert into public.file_bitrix_views (legal_entity_id, actor_user_id, move_id) values ($1, $2, $3) returning id`,
        [entity, '00000000-0000-4000-8000-0000000000aa', id],
      );
      await expectDbError(db, () => owner('delete from public.file_bitrix_views where id = $1', [view!.id]), { code: '23514' });
      await expectDbError(db, () => owner(`update public.file_bitrix_views set started_at = now() - interval '1 hour' where id = $1`, [view!.id]),
        { code: '23514' });
      await owner('update public.file_bitrix_views set resolved_at = now() where id = $1', [view!.id]);
      await expectDbError(db, () => owner(`update public.file_bitrix_views set resolved_at = now() + interval '1 second' where id = $1`, [view!.id]),
        { code: '23514' });
      await owner(`update public.file_bitrix_views set outcome = 'served', finished_at = now() where id = $1`, [view!.id]);
      await expectDbError(db, () => owner(`update public.file_bitrix_views set outcome = 'mismatch' where id = $1`, [view!.id]), { code: '23514' });
    });
  });
});

describe('S11 settings: switches Off, hold floor, 90-day floor', () => {
  it('with no settings row the Super Admin sees every switch Off, a 15-minute hold, 90 days and listing on', async () => {
    await asOwner(db, async () => {
      expect(await owner('select 1 from public.file_move_settings s join public.legal_entities e on e.id = s.legal_entity_id where e.code = $1',
        ['HOLIDAY_CHACHA'])).toEqual([]);
      expect(await one(SUPER, SQL.settingsGet, [])).toEqual({
        checkIdProofCopies: false, moveAccountsFiles: false, deleteAfterHold: false, deleteHoldMinutes: 15, accountsHoldDays: 90,
        accountsBox: null, pilotBitrixDealId: null, deleteEverOn: false, enqueueEnabled: true, openStops: 0, updatedAt: null,
      });
      for (const actor of [OWNER, ACCOUNTS]) expect(await one(actor, SQL.settingsGet, [])).toBeNull();
    });
  });

  it('a new settings row has all three switches Off', async () => {
    await asOwner(db, async () => {
      const entity = await s.entityId();
      const [row] = await owner<Record<string, unknown>>(
        `insert into public.file_move_settings (legal_entity_id) values ($1)
         returning check_id_proof_copies, move_accounts_files, delete_after_hold, delete_ever_on, delete_hold_minutes, accounts_hold_days,
           enqueue_enabled, accounts_bitrix_field, pilot_source_deal_id`,
        [entity],
      );
      expect(row).toEqual({
        check_id_proof_copies: false, move_accounts_files: false, delete_after_hold: false, delete_ever_on: false, delete_hold_minutes: 15,
        accounts_hold_days: 90, enqueue_enabled: true, accounts_bitrix_field: null, pilot_source_deal_id: null,
      });
      // The settings row is audited by its trigger.
      const [audit] = await owner<{ n: number }>(`select count(*)::int as n from public.audit_events where action = 'settings.file_move_changed'`);
      expect(audit!.n).toBeGreaterThanOrEqual(1);
    });
  });

  it('the hold is never under 15 minutes (constraint and command)', async () => {
    await asOwner(db, async () => {
      await expectDbError(db, () => s.settings({ hold: 14 }), { code: '23514', message: /delete_hold_minutes/ });
      await expectDbError(db, () => s.settings({ hold: 43201 }), { code: '23514', message: /delete_hold_minutes/ });
      await s.refusedWith(SUPER, SQL.setHold, [14, REASON], '22023', 'invalid_input', 'minutes');
      await s.refusedWith(SUPER, SQL.setHold, [43201, REASON], '22023', 'invalid_input', 'minutes');
      expect(await one(SUPER, SQL.setHold, [15, REASON])).toEqual({ changed: false, deleteHoldMinutes: 15 });
      expect(await one(SUPER, SQL.setHold, [30, REASON])).toEqual({ changed: true, deleteHoldMinutes: 30 });
      await s.refusedWith(OWNER, SQL.setHold, [30, REASON], '42501');
      await s.refusedWith(SUPER, SQL.setHold, [45, 'short'], '22023');
    });
  });

  it('accounts_hold_days is at least 90 and has no staff setter', async () => {
    await asOwner(db, async () => {
      await expectDbError(db, () => s.settings({ holdDays: 89 }), { code: '23514', message: /accounts_hold_days/ });
      await expectDbError(db, () => s.settings({ holdDays: 3651 }), { code: '23514', message: /accounts_hold_days/ });
      await s.settings({ holdDays: 120 });
      const staff = stripComments(readFileSync(s11Files()[3]!, 'utf8'));
      expect(staff).not.toMatch(/accounts_hold_days\s*=/);
    });
  });

  it('the delete switch cannot be on unless it has been turned on through the pilot rule', async () => {
    await asOwner(db, async () => {
      await expectDbError(db, () => s.settings({ del: true, everOn: false }), { code: '23514', message: /file_move_settings/ });
    });
  });

  it('one kick-state row; the kick answers false when there is nothing to do', async () => {
    await asOwner(db, async () => {
      const [row] = await owner<{ n: number; installed: boolean }>(
        'select count(*)::int as n, bool_and(installed_at is not null) as installed from public.file_move_kick_state');
      expect(row).toEqual({ n: 1, installed: true });
      expect((await owner<{ k: boolean }>('select authz.kick_file_move() as k'))[0]!.k).toBe(false);
      if (db.mode === 'pglite') {
        // PGlite has no Vault or pg_net: even with work to do nothing is sent.
        await s.settings({ check: true });
        expect((await owner<{ k: boolean }>('select authz.kick_file_move() as k'))[0]!.k).toBe(false);
      }
    });
  });
});
