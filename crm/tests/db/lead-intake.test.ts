import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClaimedInboxItem } from '@/modules/integration/contracts';
import { type Actor, FIXTURE_USERS as U, type TestDb, amrAt, asOwner, createTestDb, expectDbError, resetActor, setActor } from '../helpers/db';

/**
 * Phase 6 manifest-contained Lead intake and universal intake isolation
 * (docs/implementation/history/phase-6/contract.md sections 1-3), migration
 * 20261007000100_lead_intake_manifest.sql.
 *
 * Synthetic values only. Every scenario runs in a rolled-back transaction as
 * the database owner and switches to the impersonated role only for the call
 * under test. Operational-mode cases use an invented real-format portal domain
 * (acme-travel-portal.co) and never contact any provider.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const SVC: Actor = { userId: null, role: 'service_role' };
const ANON: Actor = { userId: null };
const ADMIN: Actor = { userId: U.adminJodhpur };
const MEMBER = 'SYNTHETIC_MEMBER_0001';
const DOMAIN = 'synthetic-portal.example.test';
const CONFIG = 'c0000000-0000-4000-8000-000000000001';
const REAL_DOMAIN = 'acme-travel-portal.co';
const CREDENTIAL = 'synthetic-receiver-credential-0123456789abcdef';
const OPERATOR = 'synthetic-operator';
const LEAD_IDS = [41001, 41002, 41003];
const FROM = '2026-10-04T00:00:00+05:30';
const TO = '2026-10-05T00:00:00+05:30';

interface LeadSnapshot {
  id: string;
  title: string;
  statusId: string;
  sourceId: string | null;
  assignedById: string;
  dateCreate: string;
  dateModify: string;
}
interface LeadApplyResult {
  outcome: string;
  leadId: string | null;
  reasonCode: string | null;
}
interface ManifestResult {
  manifestId: string;
  status: string;
  expectedCount: number;
}
type Item = ClaimedInboxItem & { sourceObject: 'deal' | 'lead'; sourceId: string };

async function run<T = Record<string, unknown>>(actor: Actor, sql: string, params: unknown[] = []): Promise<T[]> {
  await setActor(db, actor);
  const rows = await db.query<T>(sql, params);
  await resetActor(db);
  return rows;
}
const svc = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => run<T>(SVC, sql, params);
async function one<T>(actor: Actor, sql: string, params: unknown[] = []): Promise<T> {
  return (await run<{ r: T }>(actor, sql, params))[0]!.r;
}

const CREATE_SQL = 'select public.integration_manifest_create($1, $2, $3, $4::date, $5::timestamptz, $6::timestamptz, $7::bigint[], $8) as r';
interface ManifestArgs {
  config?: string;
  object?: string;
  code?: string | null;
  from?: string;
  to?: string;
  ids?: Array<number | null>;
  operator?: string | null;
}
const manifestParams = (a: ManifestArgs = {}) => [
  a.config ?? CONFIG,
  a.object ?? 'lead',
  a.code === undefined ? 'WEBFORM' : a.code,
  '2026-10-04',
  a.from ?? FROM,
  a.to ?? TO,
  a.ids ?? LEAD_IDS,
  a.operator === undefined ? OPERATOR : a.operator,
];
const createManifest = (a: ManifestArgs = {}) => one<ManifestResult>(SVC, CREATE_SQL, manifestParams(a));
const closeManifest = (id: string, operator = OPERATOR) =>
  one<{ manifestId: string; status: string; outcome: string }>(SVC, 'select public.integration_manifest_close($1, $2) as r', [id, operator]);
const dealManifestId = async () =>
  (await db.query<{ id: string }>(`select id from public.intake_manifests where source_object = 'deal' and status = 'active'`))[0]!.id;

let tsCounter = 1_800_000_000;
const record = (id: number, event = 'ONCRMLEADADD', member = MEMBER, ts = (tsCounter += 1)) =>
  one<{ inboxId: string; duplicate: boolean }>(SVC, 'select public.integration_record_bitrix_event($1, $2, $3, $4) as r', [member, event, id, ts]);

async function addCredential() {
  await db.query(
    `insert into public.integration_receiver_credentials (slot, credential_sha256, note) values (1, decode($1, 'hex'), 'synthetic')`,
    [createHash('sha256').update(CREDENTIAL, 'utf8').digest('hex')],
  );
}
const receive = (id: number, event = 'ONCRMLEADADD', domain = DOMAIN) =>
  one<{ inboxId: string; duplicate: boolean }>(ANON, 'select public.integration_receive_bitrix_event($1, $2, $3, $4, $5, $6) as r', [
    CREDENTIAL, MEMBER, domain, event, id, (tsCounter += 1),
  ]);

const claim = async (limit = 100) => (await svc<{ r: Item }>('select r from public.integration_claim_inbox($1, 60) as r', [limit])).map((x) => x.r);
async function claimOne(inboxId: string): Promise<Item> {
  const item = (await claim()).find((c) => c.inboxId === inboxId);
  if (!item) throw new Error('row was not claimed');
  return item;
}
const applyLead = (item: { inboxId: string; lockToken: string }, lead: LeadSnapshot | null) =>
  one<LeadApplyResult>(SVC, 'select public.integration_apply_bitrix_lead($1, $2, $3::jsonb) as r', [
    item.inboxId, item.lockToken, lead === null ? null : JSON.stringify(lead),
  ]);
const applyDeal = (item: { inboxId: string; lockToken: string }, deal: Record<string, unknown>) =>
  one<{ outcome: string; dealId: string | null; reasonCode: string | null }>(SVC, 'select public.integration_apply_bitrix_deal($1, $2, $3::jsonb) as r', [
    item.inboxId, item.lockToken, JSON.stringify(deal),
  ]);

function lead(id: number, overrides: Partial<LeadSnapshot> = {}): LeadSnapshot {
  return {
    id: String(id),
    title: `Synthetic web form lead ${id}`,
    statusId: 'NEW',
    sourceId: 'WEBFORM',
    assignedById: '101',
    dateCreate: '2026-10-04T11:00:00+05:30',
    dateModify: '2026-10-04T11:00:00+05:30',
    ...overrides,
  };
}
const dealSnapshot = (id: number) => ({
  id: String(id), sourceId: 'SYNTHETIC_SRC', title: 'Synthetic deal', stageId: 'C7:NEW', categoryId: '7',
  assignedById: '101', dateCreate: '2026-09-15T10:00:00+05:30', dateModify: '2026-09-15T10:00:00+05:30',
});

/** record -> claim -> apply one lead. */
async function importLead(snapshot: LeadSnapshot, event = 'ONCRMLEADADD') {
  const { inboxId } = await record(Number(snapshot.id), event);
  const item = await claimOne(inboxId);
  return { ...(await applyLead(item, snapshot)), inboxId };
}

const count = async (table: string, where = 'true', params: unknown[] = []) =>
  Number((await db.query<{ n: string }>(`select count(*)::text as n from public.${table} where ${where}`, params))[0]!.n);
const inboxRow = async (id: string) =>
  (await db.query<{ status: string; reason_code: string | null; attempts: number; source_object: string; processed_lead_id: string | null; processed_deal_id: string | null }>(
    `select status, reason_code, attempts, source_object, processed_lead_id, processed_deal_id from public.integration_inbox where id = $1`,
    [id],
  ))[0]!;

/** Operational needs zero synthetic deals (L8) and, per L2, a real-format portal. */
async function goOperational(domain = REAL_DOMAIN) {
  await db.exec(`delete from public.deal_commercials; delete from public.deal_assignments; delete from public.deals where is_synthetic;`);
  await db.exec(`update public.deployment_settings set environment = 'operational'`);
  await db.query(`update public.integration_intake_config set portal_domain = $1 where id = $2`, [domain, CONFIG]);
}

// ---------------------------------------------------------------------------

describe('manifest operator commands', () => {
  it('create is active, holds exactly the ids, is audited without ids; close is audited once and repeat is existing', async () => {
    await asOwner(db, async () => {
      const m = await createManifest();
      expect(m).toEqual({ manifestId: expect.any(String), status: 'active', expectedCount: 3 });
      const [row] = await db.query<Record<string, unknown>>(
        `select source_object, source_code, business_date::text, expected_count, status, created_by_operator
         from public.intake_manifests where id = $1`,
        [m.manifestId],
      );
      expect(row).toEqual({
        source_object: 'lead', source_code: 'WEBFORM', business_date: '2026-10-04', expected_count: 3, status: 'active',
        created_by_operator: OPERATOR,
      });
      expect(
        (await db.query<{ id: string }>(`select source_id::text as id from public.intake_manifest_items where manifest_id = $1 order by 1`, [m.manifestId])).map((r) => r.id),
      ).toEqual(LEAD_IDS.map(String));
      const created = await db.query<{ details: Record<string, unknown>; actor_user_id: string | null }>(
        `select details, actor_user_id from public.audit_events where action = 'integration.manifest_created' and target_id = $1`,
        [m.manifestId],
      );
      expect(created).toHaveLength(1);
      expect(created[0]!.details).toMatchObject({ expectedCount: 3, sourceObject: 'lead', sourceCode: 'WEBFORM', operator: OPERATOR });
      expect(JSON.stringify(created[0]!.details)).not.toContain('41001');

      expect(await closeManifest(m.manifestId, 'synthetic-closer')).toEqual({ manifestId: m.manifestId, status: 'closed', outcome: 'closed' });
      expect(await closeManifest(m.manifestId)).toEqual({ manifestId: m.manifestId, status: 'closed', outcome: 'existing' });
      expect(await count('audit_events', `action = 'integration.manifest_closed' and target_id = $1`, [m.manifestId])).toBe(1);
      const [closed] = await db.query<{ closed_by_operator: string; closed: boolean }>(
        `select closed_by_operator, closed_at is not null as closed from public.intake_manifests where id = $1`,
        [m.manifestId],
      );
      expect(closed).toEqual({ closed_by_operator: 'synthetic-closer', closed: true });
    });
  });

  it.each([
    ['duplicate ids', { ids: [41001, 41001] }],
    ['empty id list', { ids: [] }],
    ['null id', { ids: [41001, null] }],
    ['non-positive id', { ids: [0] }],
    ['more than 10000 ids', { ids: Array.from({ length: 10001 }, (_, i) => i + 1) }],
    ['unknown object', { object: 'contact' }],
    ['invalid source code', { code: 'WEB FORM' }],
    ['missing source code', { code: null }],
    ['empty interval', { to: FROM }],
    ['invalid operator', { operator: '' }],
    ['operator label with an email address (L5)', { operator: 'ops@example.com' }],
    ['interval at UTC midnight, not IST (L3)', { from: '2026-10-04T00:00:00Z', to: '2026-10-05T00:00:00Z' }],
    ['interval longer than the business day (L3)', { to: '2026-10-06T00:00:00+05:30' }],
    ['interval shorter than the business day (L3)', { to: '2026-10-04T23:00:00+05:30' }],
    ['interval of another date (L3)', { from: '2026-10-05T00:00:00+05:30', to: '2026-10-06T00:00:00+05:30' }],
    ['unknown config', { config: 'c0000000-0000-4000-8000-0000000000ff' }],
  ] as Array<[string, ManifestArgs]>)('refuses %s (22023), nothing written', async (_label, args) => {
    await asOwner(db, async () => {
      await expectDbError(db, () => createManifest(args), { code: '22023' });
      expect(await count('intake_manifests', `source_object = 'lead'`)).toBe(0);
    });
  });

  it('at most one active manifest per config and object; widening is a new manifest after close', async () => {
    await asOwner(db, async () => {
      const first = await createManifest();
      await expectDbError(db, () => createManifest({ ids: [...LEAD_IDS, 41004] }), { code: '55000', message: /^manifest already active$/ });
      // A deal manifest is independent of the lead manifest (fixture deal manifest stays active).
      expect(await count('intake_manifests', `status = 'active'`)).toBe(2);
      await closeManifest(first.manifestId);
      const wider = await createManifest({ ids: [...LEAD_IDS, 41004] });
      expect(wider.expectedCount).toBe(4);
      expect(await count('audit_events', `action = 'integration.manifest_created'`)).toBeGreaterThanOrEqual(2);
    });
  });

  it('items are immutable, a manifest can only be closed, never deleted, and the count is enforced at commit', async () => {
    await asOwner(db, async () => {
      const m = await createManifest();
      await expectDbError(db, () => db.query(`update public.intake_manifest_items set source_id = 41009 where manifest_id = $1`, [m.manifestId]), { code: '23514' });
      await expectDbError(db, () => db.query(`delete from public.intake_manifest_items where manifest_id = $1`, [m.manifestId]), { code: '23514' });
      await expectDbError(db, () => db.query(`update public.intake_manifests set expected_count = 4 where id = $1`, [m.manifestId]), { code: '23514' });
      await expectDbError(db, () => db.query(`update public.intake_manifests set interval_to = interval_to + interval '1 day' where id = $1`, [m.manifestId]), { code: '23514' });
      await expectDbError(db, () => db.query(`delete from public.intake_manifests where id = $1`, [m.manifestId]), { code: '23514' });
      await closeManifest(m.manifestId);
      await expectDbError(db, () => db.query(`update public.intake_manifests set status = 'active', closed_at = null, closed_by_operator = null where id = $1`, [m.manifestId]), { code: '23514' });
      // Extending a manifest behind the commands breaks count = expected_count (deferred check).
      await db.query(`insert into public.intake_manifest_items (manifest_id, source_object, source_id) values ($1, 'lead', 41999)`, [m.manifestId]);
      await expectDbError(db, () => db.exec('set constraints all immediate'), { code: '23514', message: /expected_count/ });
    });
  });

  it('only the service role runs the operator commands; nobody else reads or writes manifests', async () => {
    await asOwner(db, async () => {
      const m = await createManifest();
      for (const actor of [ANON, ADMIN, { userId: U.salesDelhiA } as Actor]) {
        await expectDbError(db, () => run(actor, CREATE_SQL, manifestParams({ ids: [41010] })), { code: '42501' });
        await expectDbError(db, () => run(actor, 'select public.integration_manifest_close($1, $2)', [m.manifestId, OPERATOR]), { code: '42501' });
        await expectDbError(db, () => run(actor, 'select public.integration_active_manifest($1, $2)', [MEMBER, 'lead']), { code: '42501' });
        await expectDbError(db, () => run(actor, `select public.integration_apply_bitrix_lead(gen_random_uuid(), gen_random_uuid(), '{}'::jsonb)`), { code: '42501' });
        await expectDbError(db, () => run(actor, 'select public.integration_enqueue_reconcile_lead($1, 1, 1)', [MEMBER]), { code: '42501' });
        for (const table of ['intake_manifests', 'intake_manifest_items']) {
          await expectDbError(db, () => run(actor, `select * from public.${table}`), { code: '42501' });
        }
      }
      // The secret key reads but never writes manifests directly.
      expect(await svc(`select id from public.intake_manifests where id = $1`, [m.manifestId])).toHaveLength(1);
      await expectDbError(db, () => svc(`update public.intake_manifests set status = 'closed' where id = $1`, [m.manifestId]), { code: '42501' });
      await expectDbError(db, () => svc(`insert into public.intake_manifest_items (manifest_id, source_object, source_id) values ($1, 'lead', 41998)`, [m.manifestId]), { code: '42501' });
    });
  });

  it('every new command and helper is security definer with an empty search_path', async () => {
    const rows = await db.query<{ name: string; secdef: boolean; config: string[] | null }>(
      `select n.nspname || '.' || p.proname as name, p.prosecdef as secdef, p.proconfig as config
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where (n.nspname = 'public' and p.proname in ('integration_apply_bitrix_lead', 'integration_enqueue_reconcile_lead',
              'integration_manifest_create', 'integration_manifest_close', 'integration_active_manifest',
              'integration_record_bitrix_event', 'integration_receive_bitrix_event', 'integration_apply_bitrix_deal',
              'integration_enqueue_reconcile', 'integration_claim_inbox'))
          or (n.nspname = 'authz' and p.proname in ('intake_portal_allowed', 'intake_manifest_allows', 'require_intake_portal',
              'require_intake_environment', 'can_read_lead'))`,
    );
    expect(rows).toHaveLength(15);
    for (const r of rows) {
      expect(r.secdef, r.name).toBe(true);
      expect(r.config, r.name).toEqual(['search_path=""']);
    }
  });

  it('existing RPC signatures are unchanged (no overloads added)', async () => {
    const rows = await db.query<{ name: string; args: string }>(
      `select p.proname as name, pg_get_function_identity_arguments(p.oid) as args
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('integration_record_bitrix_event', 'integration_receive_bitrix_event',
         'integration_apply_bitrix_deal', 'integration_enqueue_reconcile', 'integration_claim_inbox')
       order by 1`,
    );
    expect(rows).toEqual([
      { name: 'integration_apply_bitrix_deal', args: 'p_inbox_id uuid, p_lock_token uuid, p_deal jsonb' },
      { name: 'integration_claim_inbox', args: 'p_limit integer, p_lease_seconds integer' },
      { name: 'integration_enqueue_reconcile', args: 'p_member_id text, p_deal_id bigint, p_source_modified bigint' },
      { name: 'integration_receive_bitrix_event', args: 'p_credential text, p_member_id text, p_domain text, p_event_type text, p_deal_id bigint, p_source_ts bigint' },
      { name: 'integration_record_bitrix_event', args: 'p_member_id text, p_event_type text, p_deal_id bigint, p_source_ts bigint' },
    ]);
  });
});

describe('Lead intake inside the manifest (contract section 3)', () => {
  it('every manifest record is imported exactly once; repeat delivery creates no duplicate', async () => {
    await asOwner(db, async () => {
      const deals = await count('deals');
      const m = await createManifest();
      for (const id of LEAD_IDS) {
        const first = await record(id, 'ONCRMLEADADD', MEMBER, 1_800_500_000 + id);
        expect(await record(id, 'ONCRMLEADADD', MEMBER, 1_800_500_000 + id)).toEqual({ inboxId: first.inboxId, duplicate: true });
        const item = await claimOne(first.inboxId);
        expect(item).toMatchObject({ sourceObject: 'lead', sourceId: String(id), eventType: 'ONCRMLEADADD', portalMemberId: MEMBER });
        expect(await applyLead(item, lead(id))).toEqual({ outcome: 'created', leadId: expect.any(String), reasonCode: null });
        expect(await inboxRow(first.inboxId)).toMatchObject({ status: 'processed', source_object: 'lead', processed_deal_id: null });
      }
      // Later events re-read the same version: no change, no duplicate row.
      for (const id of LEAD_IDS) {
        expect((await importLead(lead(id), 'ONCRMLEADUPDATE')).outcome).toBe('stale_ignored');
      }
      const rows = await db.query<Record<string, unknown>>(
        `select reference, source_lead_id::text as id, source_id_code, source_status_id, owner_user_id, manifest_id
         from public.crm_leads order by source_lead_id`,
      );
      expect(rows).toEqual(
        LEAD_IDS.map((id) => ({
          reference: `BXL-${id}`, id: String(id), source_id_code: 'WEBFORM', source_status_id: 'NEW',
          owner_user_id: U.salesDelhiA, manifest_id: m.manifestId,
        })),
      );
      expect(await count('deals')).toBe(deals);
      expect(await count('audit_events', `action = 'integration.lead_created'`)).toBe(3);
      // Header only: no contact, phone, email, comment, amount or file column.
      const cols = (await db.query<{ c: string }>(
        `select column_name as c from information_schema.columns where table_schema = 'public' and table_name = 'crm_leads'`,
      )).map((r) => r.c);
      expect(cols.filter((c) => /contact|phone|email|comment|amount|opportunity|file|name/.test(c))).toEqual([]);
    });
  });

  it('a newer Bitrix version updates the header; an older one is stale_ignored', async () => {
    await asOwner(db, async () => {
      await createManifest();
      const created = await importLead(lead(41001));
      const updated = await importLead(lead(41001, { title: 'Renamed', statusId: 'IN_PROCESS', assignedById: '102', dateModify: '2026-10-04T12:00:00+05:30' }), 'ONCRMLEADUPDATE');
      expect(updated).toMatchObject({ outcome: 'updated', leadId: created.leadId });
      expect((await importLead(lead(41001, { title: 'Old', dateModify: '2026-10-04T11:30:00+05:30' }), 'ONCRMLEADUPDATE')).outcome).toBe('stale_ignored');
      expect(await db.query(`select title, source_status_id, owner_user_id from public.crm_leads where source_lead_id = 41001`)).toEqual([
        { title: 'Renamed', source_status_id: 'IN_PROCESS', owner_user_id: U.salesDelhiB },
      ]);
    });
  });

  it('a record outside the manifest is acknowledged with the same shape, stored ignored/not_in_manifest, never claimed', async () => {
    await asOwner(db, async () => {
      await createManifest();
      const outside = await record(41999, 'ONCRMLEADADD', MEMBER, 1_800_600_000);
      expect(outside).toEqual({ inboxId: expect.any(String), duplicate: false });
      expect(await inboxRow(outside.inboxId)).toMatchObject({ status: 'ignored', reason_code: 'not_in_manifest', attempts: 0, source_object: 'lead' });
      // Dedupe still applies.
      expect(await record(41999, 'ONCRMLEADADD', MEMBER, 1_800_600_000)).toEqual({ inboxId: outside.inboxId, duplicate: true });
      expect((await claim()).map((c) => c.inboxId)).not.toContain(outside.inboxId);
      // An ignored row cannot be applied or retried into the queue.
      await expectDbError(db, () => applyLead({ inboxId: outside.inboxId, lockToken: crypto.randomUUID() }, lead(41999)), { code: '55P03' });
      await expectDbError(db, () => run(ADMIN, 'select public.integration_retry_inbox($1)', [outside.inboxId]), { code: '22023' });
      expect(await count('crm_leads')).toBe(0);
    });
  });

  it.each([
    ['another source code', { sourceId: 'CALL' }],
    ['no source code', { sourceId: null }],
    ['created before the interval', { dateCreate: '2026-10-03T23:59:59+05:30' }],
    ['created at the interval end (half-open)', { dateCreate: '2026-10-05T00:00:00+05:30', dateModify: '2026-10-05T00:00:00+05:30' }],
  ] as Array<[string, Partial<LeadSnapshot>]>)('%s -> needs_review/outside_manifest_scope, no CRM row', async (_label, over) => {
    await asOwner(db, async () => {
      await createManifest();
      expect(await importLead(lead(41002, over))).toMatchObject({ outcome: 'needs_review', leadId: null, reasonCode: 'outside_manifest_scope' });
      expect(await count('crm_leads')).toBe(0);
    });
  });

  it('no active Lead manifest imports nothing: events ignored, reconcile ignored, scope null', async () => {
    await asOwner(db, async () => {
      const before = await count('integration_inbox');
      const r = await record(41001);
      expect(await inboxRow(r.inboxId)).toMatchObject({ status: 'ignored', reason_code: 'not_in_manifest' });
      expect(await one(SVC, 'select public.integration_enqueue_reconcile_lead($1, $2, $3) as r', [MEMBER, 41001, 1_800_000_000])).toEqual({
        inboxId: null, duplicate: false, upToDate: false, ignored: true, reasonCode: 'not_in_manifest',
      });
      expect(await one(SVC, 'select public.integration_active_manifest($1, $2) as r', [MEMBER, 'lead'])).toBeNull();
      expect(await count('integration_inbox')).toBe(before + 1);
      expect(await claim()).toEqual([]);
      expect(await count('crm_leads')).toBe(0);
    });
  });

  it('closing the manifest or disabling the config stops further CRM writes, even for claimed rows', async () => {
    await asOwner(db, async () => {
      const m = await createManifest();
      await importLead(lead(41001));
      const a = await claimOne((await record(41001, 'ONCRMLEADUPDATE')).inboxId);
      const b = await claimOne((await record(41002)).inboxId);
      await closeManifest(m.manifestId);
      expect(await applyLead(a, lead(41001, { title: 'After close', dateModify: '2026-10-04T13:00:00+05:30' }))).toEqual({
        outcome: 'ignored', leadId: null, reasonCode: 'not_in_manifest',
      });
      expect(await applyLead(b, lead(41002))).toMatchObject({ outcome: 'ignored', reasonCode: 'not_in_manifest' });
      expect(await db.query(`select title from public.crm_leads`)).toEqual([{ title: 'Synthetic web form lead 41001' }]);
      // New events after close are ignored.
      expect(await inboxRow((await record(41003)).inboxId)).toMatchObject({ status: 'ignored', reason_code: 'not_in_manifest' });

      await createManifest();
      const c = await claimOne((await record(41003)).inboxId);
      await db.exec(`update public.integration_intake_config set enabled = false`);
      expect(await applyLead(c, lead(41003))).toEqual({ outcome: 'needs_review', leadId: null, reasonCode: 'not_configured' });
      await expectDbError(db, () => record(41003), { code: '55000', message: /^not_configured$/ });
      expect(await count('crm_leads')).toBe(1);
    });
  });

  it('unmapped owner -> needs_review/unmapped_owner; owner outside the pilot branch -> owner_not_in_pilot_branch', async () => {
    await asOwner(db, async () => {
      await createManifest();
      expect(await importLead(lead(41001, { assignedById: '999' }))).toMatchObject({ outcome: 'needs_review', leadId: null, reasonCode: 'unmapped_owner' });
      expect(await importLead(lead(41002, { assignedById: '104' }))).toMatchObject({ outcome: 'needs_review', leadId: null, reasonCode: 'owner_not_in_pilot_branch' });
      expect(await importLead(lead(41003, { title: 'x'.repeat(201) }))).toMatchObject({ outcome: 'needs_review', leadId: null, reasonCode: 'invalid_source_data' });
      expect(await count('crm_leads')).toBe(0);
      expect(await count('audit_events', `action = 'integration.lead_needs_review'`)).toBe(3);
    });
  });

  it('a Lead is never stored as a Deal and a Deal never as a Lead', async () => {
    await asOwner(db, async () => {
      await createManifest({ ids: [...LEAD_IDS, 6001, 6003] });
      const deals = await count('deals');
      // Lead row into the Deal command and the reverse: refused before any write.
      const leadItem = await claimOne((await record(41001)).inboxId);
      await expectDbError(db, () => applyDeal(leadItem, dealSnapshot(41001)), { code: '22023', message: /source object mismatch/ });
      const dealItem = await claimOne((await record(6001, 'ONCRMDEALADD')).inboxId);
      await expectDbError(db, () => applyLead(dealItem, lead(6001)), { code: '22023', message: /source object mismatch/ });
      expect(await count('deals')).toBe(deals);
      expect(await count('crm_leads')).toBe(0);

      // The same Bitrix id as Deal and as Lead stays two identities.
      expect((await applyDeal(dealItem, dealSnapshot(6001))).outcome).toBe('created');
      expect((await importLead(lead(6001))).outcome).toBe('created');
      expect(await db.query(`select reference from public.deals where source_deal_id = 6001`)).toEqual([{ reference: 'BX-6001' }]);
      expect(await db.query(`select reference from public.crm_leads where source_lead_id = 6001`)).toEqual([{ reference: 'BXL-6001' }]);
      // A lead id only in the Lead manifest is not a Deal; a deal id only in the Deal manifest is not a Lead.
      expect(await inboxRow((await record(41002, 'ONCRMDEALADD')).inboxId)).toMatchObject({ status: 'ignored', reason_code: 'not_in_manifest', source_object: 'deal' });
      expect(await inboxRow((await record(6002, 'ONCRMLEADADD')).inboxId)).toMatchObject({ status: 'ignored', reason_code: 'not_in_manifest', source_object: 'lead' });
      // The dedupe key includes the object: reconcile rows for the same id and version do not collide.
      const d = await one<{ inboxId: string }>(SVC, 'select public.integration_enqueue_reconcile($1, $2, $3) as r', [MEMBER, 6003, 1_800_700_000]);
      const l = await one<{ inboxId: string }>(SVC, 'select public.integration_enqueue_reconcile_lead($1, $2, $3) as r', [MEMBER, 6003, 1_800_700_000]);
      expect(d.inboxId).toEqual(expect.any(String));
      expect(l.inboxId).toEqual(expect.any(String));
      expect(l.inboxId).not.toBe(d.inboxId);
      expect((await inboxRow(d.inboxId)).source_object).toBe('deal');
      expect((await inboxRow(l.inboxId)).source_object).toBe('lead');
      // Inbox rows cannot mix event type and object.
      await expectDbError(db, () => db.query(
        `insert into public.integration_inbox (portal_member_id, source_object, event_type, source_deal_id, source_ts, dedupe_key)
         values ($1, 'lead', 'ONCRMDEALADD', 1, 1, repeat('a', 64))`, [MEMBER]), { code: '23514' });
    });
  });

  it('reconcile touches only manifest items; the scope lists exactly the manifest ids', async () => {
    await asOwner(db, async () => {
      const m = await createManifest({ ids: [41003, 41001, 41002] });
      expect(await one(SVC, 'select public.integration_active_manifest($1, $2) as r', [MEMBER, 'lead'])).toEqual({
        portalDomain: DOMAIN, memberId: MEMBER, configId: CONFIG,
        manifestId: m.manifestId, sourceObject: 'lead', sourceCode: 'WEBFORM', businessDate: '2026-10-04',
        intervalFrom: expect.any(String), intervalTo: expect.any(String), expectedCount: 3, ids: ['41001', '41002', '41003'],
      });
      const enqueue = (id: number, modified: number) =>
        one<Record<string, unknown>>(SVC, 'select public.integration_enqueue_reconcile_lead($1, $2, $3) as r', [MEMBER, id, modified]);
      const before = await count('integration_inbox');
      expect(await enqueue(41999, 1_800_000_000)).toEqual({ inboxId: null, duplicate: false, upToDate: false, ignored: true, reasonCode: 'not_in_manifest' });
      expect(await count('integration_inbox')).toBe(before);
      const modified = Date.parse('2026-10-04T05:30:00Z') / 1000;
      const first = await enqueue(41001, modified);
      expect(first).toMatchObject({ duplicate: false, upToDate: false, ignored: false });
      expect(await enqueue(41001, modified)).toEqual({ inboxId: first.inboxId, duplicate: true, upToDate: false, ignored: false });
      const item = await claimOne(first.inboxId as string);
      expect(item).toMatchObject({ sourceObject: 'lead', eventType: 'RECONCILE', origin: 'reconcile' });
      expect((await applyLead(item, lead(41001))).outcome).toBe('created');
      expect(await enqueue(41001, modified)).toEqual({ inboxId: null, duplicate: true, upToDate: true, ignored: false });
      // Deal reconcile outside the Deal manifest writes nothing either.
      expect(await one(SVC, 'select public.integration_enqueue_reconcile($1, $2, $3) as r', [MEMBER, 41001, modified])).toMatchObject({ ignored: true, inboxId: null });
      expect(await one(SVC, 'select public.integration_active_manifest($1, $2) as r', [MEMBER, 'deal'])).toMatchObject({ expectedCount: 5000 });
    });
  });

  it('cross-portal identity: a manifest authorizes only its own portal; mappings never cross portals', async () => {
    await asOwner(db, async () => {
      await createManifest();
      await db.exec(`insert into public.integration_intake_config
          (id, portal_domain, portal_member_id, category_id, eligible_stage_ids, cutoff_at, pilot_legal_entity_id, pilot_branch_id, enabled)
        select 'c0000000-0000-4000-8000-000000000002', 'second-portal.example.test', 'SYNTHETIC_MEMBER_0002', 7, array['C7:NEW'], now(),
               pilot_legal_entity_id, pilot_branch_id, true
        from public.integration_intake_config where id = '${CONFIG}'`);
      await createManifest({ config: 'c0000000-0000-4000-8000-000000000002', ids: [42001] });
      // Portal 1 does not get portal 2's id, and the reverse.
      expect(await inboxRow((await record(42001)).inboxId)).toMatchObject({ status: 'ignored', reason_code: 'not_in_manifest' });
      expect(await inboxRow((await record(41001, 'ONCRMLEADADD', 'SYNTHETIC_MEMBER_0002')).inboxId)).toMatchObject({ status: 'ignored' });
      // Portal 2's own id is queued, but its owner mapping does not borrow portal 1's map.
      const r = await record(42001, 'ONCRMLEADADD', 'SYNTHETIC_MEMBER_0002');
      expect(await applyLead(await claimOne(r.inboxId), lead(42001))).toEqual({ outcome: 'needs_review', leadId: null, reasonCode: 'unmapped_owner' });
      // Unknown portal member.
      await expectDbError(db, () => record(41001, 'ONCRMLEADADD', 'OTHER_PORTAL'), { code: '42501' });
      expect(await count('crm_leads')).toBe(0);
    });
  });

  it('legacy service-role paths cannot bypass the gate or write CRM rows directly', async () => {
    await asOwner(db, async () => {
      await expectDbError(db, () => svc(
        `insert into public.crm_leads (legal_entity_id, branch_id, reference, title, owner_user_id, source_portal, source_lead_id,
           source_status_id, source_id_code, source_created_at, source_modified_at, last_synced_at, last_verified_at, intake_inbox_id, manifest_id)
         values (gen_random_uuid(), gen_random_uuid(), 'BXL-1', 't', $1, $2, 1, 'NEW', 'WEBFORM', now(), now(), now(), now(),
                 gen_random_uuid(), gen_random_uuid())`, [U.salesDelhiA, MEMBER]), { code: '42501' });
      await expectDbError(db, () => svc(
        `insert into public.integration_inbox (portal_member_id, source_object, event_type, source_deal_id, source_ts, dedupe_key)
         values ($1, 'lead', 'ONCRMLEADADD', 41001, 1, repeat('b', 64))`, [MEMBER]), { code: '42501' });
      await expectDbError(db, () => svc(`update public.integration_inbox set status = 'pending'`), { code: '42501' });
      // Legacy deal record with the fixture Deal manifest closed: ignored, nothing claimable.
      await closeManifest(await dealManifestId());
      const r = await record(6001, 'ONCRMDEALADD');
      expect(await inboxRow(r.inboxId)).toMatchObject({ status: 'ignored', reason_code: 'not_in_manifest', source_object: 'deal' });
      expect(await claim()).toEqual([]);
      expect(await one(SVC, 'select public.integration_enqueue_reconcile($1, $2, $3) as r', [MEMBER, 6001, 1_800_000_000])).toMatchObject({ ignored: true });
    });
  });
});

describe('review fixes (L1-L5)', () => {
  it.each(['lead', 'deal'] as const)('changing the pilot legal entity holds an existing %s for review', async (object) => {
    await asOwner(db, async () => {
      await createManifest();
      const id = object === 'lead' ? 41001 : 6001;
      const first = await claimOne((await record(id, object === 'lead' ? 'ONCRMLEADADD' : 'ONCRMDEALADD')).inboxId);
      const created = object === 'lead' ? await applyLead(first, lead(id)) : await applyDeal(first, dealSnapshot(id));
      expect(created.outcome).toBe('created');
      await db.query(
        `update public.integration_intake_config c set pilot_legal_entity_id = b.legal_entity_id, pilot_branch_id = b.id
         from public.branches b where c.id = $1 and b.code = 'SB1'`, [CONFIG],
      );
      const next = await claimOne((await record(id, object === 'lead' ? 'ONCRMLEADUPDATE' : 'ONCRMDEALUPDATE')).inboxId);
      const snapshot = object === 'lead'
        ? lead(id, { title: 'Synthetic second-entity content', dateModify: '2026-10-04T12:00:00+05:30' })
        : { ...dealSnapshot(id), title: 'Synthetic second-entity content', dateModify: '2026-09-15T12:00:00+05:30' };
      const changed = object === 'lead' ? await applyLead(next, snapshot as LeadSnapshot) : await applyDeal(next, { ...snapshot });
      expect(changed).toMatchObject({ outcome: 'needs_review', reasonCode: 'scope_changed' });
      const table = object === 'lead' ? 'crm_leads' : 'deals';
      expect(await count(table, `title = 'Synthetic second-entity content'`)).toBe(0);
      expect(await count('audit_events', `action = $1`, [`integration.${object}_updated`])).toBe(0);
    });
  });

  it('reconcile locks each active manifest before freshness writes or enqueue', async () => {
    const defs = await db.query<{ name: string; def: string }>(
      `select p.proname as name, pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('integration_enqueue_reconcile', 'integration_enqueue_reconcile_lead')`,
    );
    expect(defs).toHaveLength(2);
    for (const d of defs) {
      const norm = d.def.replace(/\s+/g, ' ');
      expect(norm, d.name).toMatch(/from public\.intake_manifests m where m\.config_id = v_config and m\.source_object = '(deal|lead)' and m\.status = 'active' for share/);
      expect(norm.indexOf('from public.intake_manifests')).toBeLessThan(norm.indexOf('set last_verified_at'));
    }
  });

  it('closing a manifest prevents reconcile freshness writes for already imported Leads and Deals', async () => {
    await asOwner(db, async () => {
      const manifest = await createManifest();
      const importedLead = await importLead(lead(41001));
      const dealItem = await claimOne((await record(6001, 'ONCRMDEALADD')).inboxId);
      const importedDeal = await applyDeal(dealItem, dealSnapshot(6001));
      expect(importedDeal.outcome).toBe('created');
      await db.query(`update public.crm_leads set last_verified_at = timestamptz '2026-01-01' where id = $1`, [importedLead.leadId]);
      await db.query(`update public.deals set last_verified_at = timestamptz '2026-01-01' where id = $1`, [importedDeal.dealId]);
      await closeManifest(manifest.manifestId);
      await closeManifest(await dealManifestId());
      const modified = Date.parse('2026-10-04T05:30:00Z') / 1000;
      expect(await one(SVC, 'select public.integration_enqueue_reconcile_lead($1, 41001, $2) as r', [MEMBER, modified])).toMatchObject({ ignored: true, upToDate: false });
      expect(await one(SVC, 'select public.integration_enqueue_reconcile($1, 6001, $2) as r', [MEMBER, modified])).toMatchObject({ ignored: true, upToDate: false });
      expect(await db.query(`select last_verified_at = timestamptz '2026-01-01' as unchanged from public.crm_leads where id = $1`, [importedLead.leadId])).toEqual([{ unchanged: true }]);
      expect(await db.query(`select last_verified_at = timestamptz '2026-01-01' as unchanged from public.deals where id = $1`, [importedDeal.dealId])).toEqual([{ unchanged: true }]);
    });
  });

  it('changing the pilot branch does not overwrite an existing Deal or mark it fresh', async () => {
    await asOwner(db, async () => {
      const first = await applyDeal(await claimOne((await record(6001, 'ONCRMDEALADD')).inboxId), dealSnapshot(6001));
      expect(first.outcome).toBe('created');
      await db.query(`update public.deals set last_verified_at = timestamptz '2026-01-01' where id = $1`, [first.dealId]);
      await db.query(
        `update public.integration_intake_config c set pilot_branch_id = b.id
         from public.branches b where c.id = $1 and b.code = 'AMD'
           and b.legal_entity_id = c.pilot_legal_entity_id`, [CONFIG],
      );
      const modified = Date.parse('2026-09-15T04:30:00Z') / 1000;
      expect(await one(SVC, 'select public.integration_enqueue_reconcile($1, 6001, $2) as r', [MEMBER, modified])).toMatchObject({ upToDate: false });
      const queued = (await claim()).find((item) => item.sourceObject === 'deal' && item.sourceId === '6001')!;
      const changed = await applyDeal(queued, { ...dealSnapshot(6001), title: 'Synthetic Ahmedabad-only update', assignedById: '104', dateModify: '2026-09-15T12:00:00+05:30' });
      expect(changed).toEqual({ outcome: 'needs_review', dealId: null, reasonCode: 'scope_changed' });
      expect(await db.query(`select title, owner_user_id, last_verified_at = timestamptz '2026-01-01' as unchanged from public.deals where id = $1`, [first.dealId])).toEqual([
        { title: 'Synthetic deal', owner_user_id: U.salesDelhiA, unchanged: true },
      ]);
      expect(await count('audit_events', `action = 'integration.deal_updated'`)).toBe(0);
    });
  });

  it('L1: both apply commands lock the active manifest FOR SHARE; close locks it FOR UPDATE', async () => {
    const defs = await db.query<{ name: string; def: string }>(
      `select p.proname as name, pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('integration_apply_bitrix_deal', 'integration_apply_bitrix_lead', 'integration_manifest_close')`,
    );
    expect(defs).toHaveLength(3);
    for (const d of defs) {
      const norm = d.def.replace(/\s+/g, ' ');
      if (d.name === 'integration_manifest_close') {
        expect(norm, d.name).toMatch(/from public\.intake_manifests m where m\.id = p_manifest_id for update/);
      } else {
        expect(norm, d.name).toMatch(/from public\.intake_manifests m where m\.config_id = v_cfg\.id and m\.source_object = '(deal|lead)' and m\.status = 'active' for share/);
      }
    }
  });

  it('L1: a close committed after the claim but before the apply (sequential simulation) writes nothing', async () => {
    await asOwner(db, async () => {
      const m = await createManifest();
      const l = await claimOne((await record(41001)).inboxId);
      const d = await claimOne((await record(6001, 'ONCRMDEALADD')).inboxId);
      const deals = await count('deals');
      await closeManifest(m.manifestId);
      await closeManifest(await dealManifestId());
      expect(await applyLead(l, lead(41001))).toEqual({ outcome: 'ignored', leadId: null, reasonCode: 'not_in_manifest' });
      expect(await applyDeal(d, dealSnapshot(6001))).toEqual({ outcome: 'ignored', dealId: null, reasonCode: 'not_in_manifest' });
      expect(await count('crm_leads')).toBe(0);
      expect(await count('deals')).toBe(deals);
      expect(await inboxRow(l.inboxId)).toMatchObject({ status: 'ignored', reason_code: 'not_in_manifest' });
    });
  });

  it('L2: a Lead owner needs an active Sales membership in the pilot branch (manager membership is not enough)', async () => {
    await asOwner(db, async () => {
      await createManifest();
      await db.query(
        `insert into public.bitrix_user_mappings (portal_member_id, bitrix_user_id, staff_user_id, active) values ($1, 105, $2, true)`,
        [MEMBER, U.managerDelhi],
      );
      expect(await importLead(lead(41001, { assignedById: '105' }))).toMatchObject({
        outcome: 'needs_review', leadId: null, reasonCode: 'owner_not_in_pilot_branch',
      });
      // An inactive Sales membership is refused too.
      await db.query(`update public.memberships set status = 'inactive' where user_id = $1 and role_code = 'sales'`, [U.salesDelhiB]);
      expect(await importLead(lead(41002, { assignedById: '102' }))).toMatchObject({ outcome: 'needs_review', reasonCode: 'owner_not_in_pilot_branch' });
      expect(await importLead(lead(41003))).toMatchObject({ outcome: 'created' });
      expect(await count('crm_leads')).toBe(1);
    });
  });

  it('L3: a manifest interval is exactly the business date in Asia/Kolkata', async () => {
    await asOwner(db, async () => {
      const m = await createManifest();
      const [row] = await db.query<{ from_ok: boolean; to_ok: boolean }>(
        `select interval_from = timestamptz '2026-10-04T00:00:00+05:30' as from_ok,
                interval_to = timestamptz '2026-10-05T00:00:00+05:30' as to_ok
         from public.intake_manifests where id = $1`,
        [m.manifestId],
      );
      expect(row).toEqual({ from_ok: true, to_ok: true });
    });
  });

  it.each([
    ['unset', 'environment_unset', null],
    ['staging', 'not_configured', null],
    ['operational with a reserved .test portal', 'not_configured', 'operational-test'],
    ['test with a real-format portal', 'not_configured', 'test-real'],
  ] as const)('L4: request_reconcile in %s refuses 55000 %s before any audit or cooldown write', async (label, message, mode) => {
    await asOwner(db, async () => {
      if (mode === 'operational-test') await goOperational(DOMAIN);
      else if (mode === 'test-real') await db.query(`update public.integration_intake_config set portal_domain = $1 where id = $2`, [REAL_DOMAIN, CONFIG]);
      else await db.query(`update public.deployment_settings set environment = $1`, [label]);
      const audits = await count('audit_events', `action = 'integration.reconcile_requested'`);
      await expectDbError(db, () => run(ADMIN, 'select public.integration_request_reconcile()'), {
        code: '55000', message: new RegExp(`^${message}$`),
      });
      expect(await count('audit_events', `action = 'integration.reconcile_requested'`)).toBe(audits);
      expect(await db.query(`select last_reconcile_requested_at from public.integration_intake_config where id = $1`, [CONFIG])).toEqual([
        { last_reconcile_requested_at: null },
      ]);
    });
  });

  it('L4: request_reconcile still works in test with the reserved portal and in operational with a real-format portal', async () => {
    await asOwner(db, async () => {
      expect(await one(ADMIN, 'select public.integration_request_reconcile() as r')).toMatchObject({ portalMemberId: MEMBER, allowed: true });
      await db.exec(`update public.integration_intake_config set last_reconcile_requested_at = null`);
      await goOperational();
      expect(await one(ADMIN, 'select public.integration_request_reconcile() as r')).toMatchObject({ portalMemberId: MEMBER, allowed: true });
    });
  });

  it('L5: operator labels never hold an email address (create and close)', async () => {
    await asOwner(db, async () => {
      const m = await createManifest();
      await expectDbError(db, () => closeManifest(m.manifestId, 'owner@example.test'), { code: '22023', message: /invalid operator/ });
      await expectDbError(db, () => db.query(`update public.intake_manifests set status = 'closed', closed_at = now(), closed_by_operator = 'a@b' where id = $1`, [m.manifestId]), { code: '23514' });
      expect((await closeManifest(m.manifestId, 'owner-ops.1')).outcome).toBe('closed');
    });
  });
});

describe('Lead visibility (RLS)', () => {
  const refs = async (actor: Actor) =>
    (await run<{ reference: string }>(actor, 'select reference from public.crm_leads order by reference')).map((r) => r.reference);

  it('changing the pilot branch does not overwrite an existing Lead in the former branch', async () => {
    await asOwner(db, async () => {
      await createManifest();
      const first = await importLead(lead(41001));
      expect(first.outcome).toBe('created');
      await db.query(
        `update public.integration_intake_config c set pilot_branch_id = b.id
         from public.branches b where c.id = $1 and b.code = 'AMD'
           and b.legal_entity_id = c.pilot_legal_entity_id`, [CONFIG],
      );
      const changed = await importLead(lead(41001, {
        assignedById: '104', title: 'Synthetic Ahmedabad-only update', dateModify: '2026-10-04T12:00:00+05:30',
      }), 'ONCRMLEADUPDATE');
      expect(changed).toMatchObject({ outcome: 'needs_review', leadId: null, reasonCode: 'scope_changed' });
      expect(await db.query(`select title, owner_user_id from public.crm_leads where id = $1`, [first.leadId])).toEqual([
        { title: 'Synthetic web form lead 41001', owner_user_id: U.salesDelhiA },
      ]);
      expect(await refs({ userId: U.salesDelhiA })).toEqual(['BXL-41001']);
      expect(await refs({ userId: U.salesAhmedabad })).toEqual([]);
      expect(await count('audit_events', `action = 'integration.lead_updated'`)).toBe(0);
    });
  });

  it('the mapped owner with Sales in the branch, the branch manager and integration admins read leads; Purchase never', async () => {
    await asOwner(db, async () => {
      await createManifest();
      await importLead(lead(41001));
      expect(await refs({ userId: U.salesDelhiA })).toEqual(['BXL-41001']);
      expect(await refs({ userId: U.managerDelhi })).toEqual(['BXL-41001']);
      expect(await refs(ADMIN)).toEqual(['BXL-41001']);
      for (const actor of [
        { userId: U.salesDelhiB }, { userId: U.salesAhmedabad }, { userId: U.managerAhmedabad }, { userId: U.accountsJodhpur },
        { userId: U.purchaseJodhpur }, { userId: U.salesEntityB }, { userId: U.salesDelhiA, aal: 'aal1' as const },
        { userId: U.adminJodhpur, amr: amrAt(13 * 3600) },
      ] as Actor[]) {
        expect(await refs(actor), JSON.stringify(actor)).toEqual([]);
      }
      await expectDbError(db, () => run(ANON, 'select * from public.crm_leads'), { code: '42501' });

      // A Purchase role holder is refused even as the branch manager.
      await db.query(
        `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
         select $1, b.legal_entity_id, b.id, 'manager', 'active' from public.branches b where b.code = 'DEL'`,
        [U.purchaseJodhpur],
      );
      expect(await refs({ userId: U.purchaseJodhpur })).toEqual([]);
      // The owner without an active Sales membership in the branch loses access.
      await db.query(`update public.memberships set status = 'inactive' where user_id = $1`, [U.salesDelhiA]);
      expect(await refs({ userId: U.salesDelhiA })).toEqual([]);
    });
  });

  it('no API role writes leads directly', async () => {
    await asOwner(db, async () => {
      await createManifest();
      await importLead(lead(41001));
      for (const actor of [{ userId: U.salesDelhiA }, ADMIN, ANON, SVC] as Actor[]) {
        await expectDbError(db, () => run(actor, `update public.crm_leads set title = 'x'`), { code: '42501' });
        await expectDbError(db, () => run(actor, `delete from public.crm_leads`), { code: '42501' });
      }
      expect(await db.query(`select title from public.crm_leads`)).toEqual([{ title: 'Synthetic web form lead 41001' }]);
    });
  });
});

describe('environment isolation on every intake path (L1, L2)', () => {
  /** Every intake entry point; each must refuse with the same SQLSTATE and exact message. */
  const paths = (domain: string): Array<[string, () => Promise<unknown>]> => [
    ['record deal', () => record(6001, 'ONCRMDEALADD')],
    ['record lead', () => record(41001)],
    ['receive', () => receive(41001, 'ONCRMLEADADD', domain)],
    ['enqueue deal', () => one(SVC, 'select public.integration_enqueue_reconcile($1, 6001, 1) as r', [MEMBER])],
    ['enqueue lead', () => one(SVC, 'select public.integration_enqueue_reconcile_lead($1, 41001, 1) as r', [MEMBER])],
    ['active manifest', () => one(SVC, 'select public.integration_active_manifest($1, $2) as r', [MEMBER, 'lead'])],
    ['manifest create', () => createManifest({ ids: [41050] })],
  ];

  it.each([
    ['unset', 'environment_unset', null],
    ['staging', 'not_configured', null],
    ['test with a real-format portal', 'not_configured', 'test-real'],
    ['operational with a reserved .test portal', 'not_configured', 'operational-test'],
  ] as const)('%s: every path refuses 55000 %s and no inbox row is written', async (_label, message, mode) => {
    await asOwner(db, async () => {
      await addCredential();
      await createManifest();
      await record(41001);
      if (mode === 'operational-test') {
        await goOperational(DOMAIN);
      } else if (mode === 'test-real') {
        await db.query(`update public.integration_intake_config set portal_domain = $1 where id = $2`, [REAL_DOMAIN, CONFIG]);
      } else {
        await db.query(`update public.deployment_settings set environment = $1`, [_label]);
      }
      // A row queued before the switch: the worker must not lease it afterwards.
      const before = await count('integration_inbox');
      const manifests = await count('intake_manifests');
      const domain = mode === 'test-real' ? REAL_DOMAIN : DOMAIN;
      if (mode === null) {
        await expectDbError(db, () => claim(), { code: '55000', message: new RegExp(`^${message}$`) });
      } else {
        expect(await claim()).toEqual([]);
      }
      for (const [name, call] of paths(domain)) {
        await expectDbError(db, call, { code: '55000', message: new RegExp(`^${message}$`) }).catch((e: Error) => {
          throw new Error(`${name}: ${e.message}`);
        });
      }
      expect(await count('integration_inbox')).toBe(before);
      expect(await count('intake_manifests')).toBe(manifests);
    });
  });

  it('claimed rows are not written when the environment closes afterwards (apply deal and lead)', async () => {
    await asOwner(db, async () => {
      await createManifest();
      const l = await claimOne((await record(41001)).inboxId);
      const d = await claimOne((await record(6001, 'ONCRMDEALADD')).inboxId);
      const deals = await count('deals');
      await db.exec(`update public.deployment_settings set environment = 'staging'`);
      expect(await applyLead(l, lead(41001))).toEqual({ outcome: 'needs_review', leadId: null, reasonCode: 'not_configured' });
      expect(await applyDeal(d, dealSnapshot(6001))).toEqual({ outcome: 'needs_review', dealId: null, reasonCode: 'not_configured' });
      expect(await count('crm_leads')).toBe(0);
      expect(await count('deals')).toBe(deals);
    });
  });

  it('a wrong receiver credential is refused before the environment is read (credential first)', async () => {
    await asOwner(db, async () => {
      await addCredential();
      await db.exec(`update public.deployment_settings set environment = 'unset'`);
      await expectDbError(db, () => run(ANON, 'select public.integration_receive_bitrix_event($1, $2, $3, $4, 1, 1)', [
        'synthetic-receiver-credential-WRONG-000000000', MEMBER, DOMAIN, 'ONCRMLEADADD',
      ]), { code: '28000' });
    });
  });

  it('operational with a real-format portal imports a manifest Lead end to end (receiver, rolled back)', async () => {
    await asOwner(db, async () => {
      await addCredential();
      await goOperational();
      await createManifest();
      const r = await receive(41001, 'ONCRMLEADADD', REAL_DOMAIN);
      expect(r.duplicate).toBe(false);
      expect(await applyLead(await claimOne(r.inboxId), lead(41001))).toMatchObject({ outcome: 'created' });
      // Outside the manifest the receiver still answers the same shape and stores an ignored row.
      const outside = await receive(41999, 'ONCRMLEADADD', REAL_DOMAIN);
      expect(Object.keys(outside).sort()).toEqual(['duplicate', 'inboxId']);
      expect(await inboxRow(outside.inboxId)).toMatchObject({ status: 'ignored', reason_code: 'not_in_manifest' });
      expect(await count('crm_leads')).toBe(1);
    });
  });
});
