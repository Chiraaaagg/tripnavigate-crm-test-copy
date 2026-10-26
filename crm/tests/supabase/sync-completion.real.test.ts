import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isRealStackRequired } from '@/lib/config';
import { FIXTURE_EMAILS, FIXTURE_USERS } from '../helpers/db';
import { createRealStack, resolveRealStackEnv } from '../helpers/real-stack';

/**
 * Migration 20261111000100_sync_completion on the REAL local stack (sync completion
 * contract 2026-10-08, sections 4, 6 and 7): a stop and its recovery each produce
 * exactly one notice record, with the real pg_cron job table. Every case runs in a
 * transaction that is rolled back; the scheduler is switched off and on only inside
 * it (cron.alter_job is transactional). The app may run its own checks against the
 * same database, so assertions are about the incident this case opens or reuses.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
function databaseUrl(): string | null {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    if (isRealStackRequired(process.env)) throw new Error('REQUIRE_REAL_STACK=1 but TEST_DATABASE_URL is missing');
    return null;
  }
  if (!LOCAL_HOSTS.has(new URL(url).hostname)) throw new Error('local database only');
  return url;
}
const dbUrl = databaseUrl();
const env = resolveRealStackEnv();
const stack = env ? createRealStack(env) : null;
const MEMBER = 'SYNTHETIC_MEMBER_0001';

interface Notice {
  incidentId: string;
  kind: 'stopped' | 'recovered';
  reasonCode: string;
  recipients: string[];
}

describe.skipIf(!dbUrl)('sync-stopped incidents (real local stack)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    db = new pg.Client({ connectionString: dbUrl! });
    await db.connect();
    // Disposable CI stack: the approved operator sequence (as auto-sync-health.real.test.ts).
    await db.query('create extension if not exists pg_cron');
    await db.query('create extension if not exists pg_net with schema extensions');
    await db.query('select authz.provision_bitrix_sync_jobs()');
  });
  afterAll(async () => {
    await stack?.cleanup();
    await db?.end();
  });

  async function rolledBack(fn: () => Promise<void>) {
    await db.query('begin');
    try {
      await fn();
    } finally {
      await db.query('rollback');
    }
  }
  async function asService<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    await db.query('set local role service_role');
    try {
      return (await db.query(sql, params)).rows as T[];
    } finally {
      await db.query('reset role');
    }
  }
  const check = async () => (await asService<{ r: { send: Notice[]; emailRecipientsCount: number } }>('select public.integration_sync_alert_check() as r'))[0]!.r;
  const mark = (id: string, kind: string) => asService('select public.integration_sync_alert_mark_sent($1, $2)', [id, kind]);
  const openIncident = async () =>
    (await db.query<{ id: string }>(`select id from public.integration_sync_incidents where portal_member_id = $1 and recovered_at is null`, [MEMBER])).rows;
  const setJob = (active: boolean) =>
    db.query(`select cron.alter_job(j.jobid, active := $1) from cron.job j where j.jobname = 'bitrix-sync'`, [active]);

  it('a stop and its recovery each produce exactly one notice record', async () => {
    await rolledBack(async () => {
      await db.query('update public.integration_sync_schedule set enabled = true where id');
      await setJob(false);

      const first = await check();
      const open = await openIncident();
      expect(open).toHaveLength(1);
      const id = open[0]!.id;
      const stopped = first.send.filter((n) => n.incidentId === id && n.kind === 'stopped');
      expect(first.emailRecipientsCount).toBeGreaterThanOrEqual(1);
      expect(stopped).toHaveLength(1);
      expect(stopped[0]!.recipients).toContain(FIXTURE_EMAILS.adminJodhpur);
      // A second check opens nothing new; the notice is leased (review L1), so it is not handed out twice.
      expect((await check()).send.filter((n) => n.incidentId === id)).toEqual([]);
      expect(await openIncident()).toEqual([{ id }]);
      await mark(id, 'stopped');
      await mark(id, 'stopped');
      expect((await check()).send.filter((n) => n.incidentId === id)).toEqual([]);

      // Recovery: the job is back and a successful run follows the incident.
      await setJob(true);
      await db.query(
        `insert into public.integration_worker_runs (kind, started_at, finished_at, outcome)
         values ('reconcile', now(), now() + interval '1 second', 'ok')`,
      );
      const recovered = (await check()).send.filter((n) => n.incidentId === id);
      expect(recovered.map((n) => n.kind)).toEqual(['recovered']);
      expect((await check()).send.filter((n) => n.incidentId === id)).toEqual([]);
      await mark(id, 'recovered');
      expect((await check()).send.filter((n) => n.incidentId === id)).toEqual([]);
      expect(await openIncident()).toEqual([]);
      const { rows } = await db.query(
        `select open_notified_at is not null as o, recovery_notified_at is not null as r from public.integration_sync_incidents where id = $1`,
        [id],
      );
      expect(rows).toEqual([{ o: true, r: true }]);
    });
  });

  it.skipIf(!stack)('the Data API refuses signed-in staff, admins included', async () => {
    const admin = await stack!.signInAal2(FIXTURE_EMAILS.adminJodhpur, FIXTURE_USERS.adminJodhpur);
    const res = await admin.client.rpc('integration_sync_alert_check');
    expect(res.error).not.toBeNull();
    expect(res.data).toBeNull();
    const read = await admin.client.from('integration_sync_incidents').select('id');
    expect(read.error).not.toBeNull();
  });
});

/**
 * Sync completion §1/§6 (review L3): in Deal scope mode (no manifest), a
 * duplicate delivery and an out-of-order event for the same Deal produce one
 * Deal carrying the newest Bitrix data. Commands run as service_role on the
 * real database inside a transaction that is rolled back, so the fixture
 * config and other suites' rows are untouched.
 */
describe.skipIf(!dbUrl)('Deal scope mode: duplicate and out-of-order events (real local stack)', () => {
  let db: pg.Client;
  beforeAll(async () => {
    db = new pg.Client({ connectionString: dbUrl! });
    await db.connect();
  });
  afterAll(async () => {
    await db?.end();
  });

  async function asService<T>(sql: string, params: unknown[] = []): Promise<T> {
    await db.query('set local role service_role');
    try {
      return (await db.query<{ r: T }>(sql, params)).rows[0]!.r;
    } finally {
      await db.query('reset role');
    }
  }
  const record = (id: number, ts: number) =>
    asService<{ inboxId: string; duplicate: boolean }>('select public.integration_record_bitrix_event($1, $2, $3, $4) as r', [
      MEMBER,
      'ONCRMDEALUPDATE',
      id,
      ts,
    ]);
  async function claimRow(inboxId: string): Promise<{ inboxId: string; lockToken: string }> {
    // integration_claim_inbox returns setof jsonb: one row per claimed item.
    await db.query('set local role service_role');
    let rows: Array<{ inboxId: string; lockToken: string }>;
    try {
      rows = (await db.query<{ r: { inboxId: string; lockToken: string } }>('select r from public.integration_claim_inbox($1, $2) as r', [100, 120])).rows.map((x) => x.r);
    } finally {
      await db.query('reset role');
    }
    const row = rows.find((c) => c.inboxId === inboxId);
    if (!row) throw new Error('recorded event was not claimed');
    return row;
  }
  const apply = (item: { inboxId: string; lockToken: string }, deal: Record<string, unknown>) =>
    asService<{ outcome: string; dealId: string | null }>('select public.integration_apply_bitrix_deal($1, $2, $3::jsonb) as r', [
      item.inboxId,
      item.lockToken,
      JSON.stringify(deal),
    ]);
  const snapshot = (id: number, title: string, dateModify: string, leadId: string) => ({
    id: String(id),
    sourceId: 'SYNTHETIC_SRC',
    title,
    stageId: 'C7:NEW',
    categoryId: '7',
    assignedById: '101',
    dateCreate: '2026-09-15T10:00:00+05:30',
    dateModify,
    leadId,
  });

  it('one Deal with the newest data', async () => {
    // Outside the other real-stack suites' Deal ID ranges; never in a manifest.
    const id = 40_000_000 + Math.floor(Math.random() * 900_000);
    const ts = Math.floor(Date.now() / 1000);
    await db.query('begin');
    try {
      await db.query(`update public.integration_intake_config set deal_intake_mode = 'scope' where portal_member_id = $1`, [MEMBER]);

      const first = await record(id, ts);
      expect(first.duplicate).toBe(false);
      // Exact redelivery of the same event: the same inbox row, nothing new.
      expect(await record(id, ts)).toMatchObject({ inboxId: first.inboxId, duplicate: true });
      const created = await apply(await claimRow(first.inboxId), snapshot(id, 'Newest title', '2026-09-20T00:00:00Z', '501'));
      expect(created.outcome).toBe('created');

      // An older event delivered late, whose read returns older data.
      const late = await record(id, ts - 600);
      expect(late.duplicate).toBe(false);
      const stale = await apply(await claimRow(late.inboxId), snapshot(id, 'Older title', '2026-09-19T00:00:00Z', ''));
      expect(stale.outcome).toBe('stale_ignored');
      expect(stale.dealId ?? created.dealId).toBe(created.dealId);

      const { rows } = await db.query<{ id: string; title: string; source_lead_id: string | null }>(
        `select id, title, source_lead_id::text from public.deals where source_portal = $1 and source_deal_id = $2`,
        [MEMBER, id],
      );
      expect(rows).toEqual([{ id: created.dealId, title: 'Newest title', source_lead_id: '501' }]);
    } finally {
      await db.query('rollback');
    }
  });
});
