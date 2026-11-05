import type { SupabaseClient } from '@supabase/supabase-js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ApplyResult,
  BitrixDealSnapshot,
  ClaimedInboxItem,
  RecordEventResult,
} from '@/modules/integration/contracts';
import { isRealStackRequired } from '@/lib/config';
import { FIXTURE_EMAILS, FIXTURE_USERS, assertDatabaseUrlNotOperational, closeRunManifests, openRunManifest } from '../helpers/db';
import { createRealStack, resolveRealStackEnv, type SignedIn } from '../helpers/real-stack';

/**
 * Phase 2 intake database contract against the REAL local Supabase stack
 * (PostgREST + GoTrue + Postgres): the commands through the Data API with the
 * secret key, true parallel claims/applies (which PGlite cannot run), and RLS
 * with real user sessions (P2-03, P2-04, P2-05, P2-08, P2-09, P2-10, P2-14).
 *
 * Uses the SYNTHETIC intake fixture (portal SYNTHETIC_MEMBER_0001, pilot branch
 * Delhi, Bitrix user 101 -> Synthetic Sales Delhi A). Deal ids are random per
 * run so the suite is re-runnable. afterAll removes this run's inbox rows and
 * imported deals through a direct LOCAL database connection so the fixture
 * deal lists asserted by the other real-stack suites stay unchanged. Audit
 * events are append-only and stay.
 *
 * Runs only in CI; fails (never skips) when REQUIRE_REAL_STACK=1 and the stack
 * or TEST_DATABASE_URL is missing.
 */

const env = resolveRealStackEnv();
const stack = env ? createRealStack(env) : null;
const MEMBER = 'SYNTHETIC_MEMBER_0001';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function databaseUrl(): string | null {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    if (env && isRealStackRequired(process.env)) throw new Error('REQUIRE_REAL_STACK=1 but TEST_DATABASE_URL is missing');
    return null;
  }
  if (!LOCAL_HOSTS.has(new URL(url).hostname)) throw new Error('intake real-stack cleanup runs only against a local database');
  return url;
}
const dbUrl = env ? databaseUrl() : null;
const enabled = env !== null && dbUrl !== null;

// Distinct from the receiver (7.0M-16M) and route (9.1M-17.1M) suites' ranges.
const base = 20_000_000 + Math.floor(Math.random() * 900_000) * 100;
const usedDealIds = new Set<number>();
const dealId = (offset: number) => {
  usedDealIds.add(base + offset);
  return base + offset;
};
let ts = Math.floor(Date.now() / 1000);
const runIds: string[] = [];
/** Phase 6: this run's manifests (deal ids base..base+99, lead ids leadBase..leadBase+49). */
const manifestIds: string[] = [];
const leadBase = base + 50;
const usedLeadIds = new Set<number>();
const leadId = (offset: number) => {
  usedLeadIds.add(leadBase + offset);
  return leadBase + offset;
};
const RUN_SOURCE = 'SYNTHETIC_SRC';

const svc = () => stack!.admin();

async function rpc<T>(client: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return data as T;
}

const record = (id: number, event = 'ONCRMDEALUPDATE', member = MEMBER) =>
  rpc<RecordEventResult>(svc(), 'integration_record_bitrix_event', {
    p_member_id: member,
    p_event_type: event,
    p_deal_id: id,
    p_source_ts: (ts += 1),
  });
const claim = (limit = 50) =>
  rpc<ClaimedInboxItem[]>(svc(), 'integration_claim_inbox', { p_limit: limit, p_lease_seconds: 120 });
const apply = (item: ClaimedInboxItem, deal: DealSnapshot | null) =>
  rpc<ApplyResult>(svc(), 'integration_apply_bitrix_deal', {
    p_inbox_id: item.inboxId,
    p_lock_token: item.lockToken,
    p_deal: deal,
  });

type DealSnapshot = BitrixDealSnapshot & { sourceId?: string | null };
function snapshot(id: number, overrides: Partial<DealSnapshot> = {}): DealSnapshot {
  return {
    id: String(id),
    sourceId: RUN_SOURCE,
    title: 'Synthetic Bitrix deal (CI fixture)',
    stageId: 'C7:NEW',
    categoryId: '7',
    assignedById: '101',
    dateCreate: '2026-09-15T10:00:00+05:30',
    dateModify: '2026-09-15T10:00:00+05:30',
    ...overrides,
  };
}

async function recordAndClaim(id: number): Promise<ClaimedInboxItem> {
  const { inboxId } = await record(id);
  const item = (await claim()).find((c) => c.inboxId === inboxId);
  if (!item) throw new Error('recorded event was not claimed');
  return item;
}

async function ownerQuery<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: dbUrl! });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

let owner: SignedIn;
let purchase: SignedIn;
let admin: SignedIn;
let importedRef = '';
let reviewInboxId = '';

beforeAll(async () => {
  if (!enabled) return;
  await assertDatabaseUrlNotOperational(dbUrl!);
  manifestIds.push(
    await openRunManifest(dbUrl!, {
      // Deal snapshots below are created on 2026-09-15 (IST).
      object: 'deal', ids: Array.from({ length: 50 }, (_, i) => base + i), sourceCode: RUN_SOURCE, businessDate: '2026-09-15',
    }),
    await openRunManifest(dbUrl!, {
      object: 'lead', ids: Array.from({ length: 40 }, (_, i) => leadBase + i), sourceCode: 'WEBFORM', businessDate: '2026-10-04',
    }),
  );
  owner = await stack!.signInAal2(FIXTURE_EMAILS.salesDelhiA, FIXTURE_USERS.salesDelhiA);
  purchase = await stack!.signInAal2(FIXTURE_EMAILS.purchaseJodhpur, FIXTURE_USERS.purchaseJodhpur);
  admin = await stack!.signInAal2(FIXTURE_EMAILS.adminJodhpur, FIXTURE_USERS.adminJodhpur);
});

afterAll(async () => {
  if (enabled) await closeRunManifests(dbUrl!, manifestIds);
  if (enabled && usedLeadIds.size > 0) {
    const ids = [...usedLeadIds];
    const client = new pg.Client({ connectionString: dbUrl! });
    await client.connect();
    try {
      await client.query('begin');
      await client.query(
        `update public.integration_inbox set processed_lead_id = null
         where portal_member_id = $1 and source_object = 'lead' and source_deal_id = any($2::bigint[])`,
        [MEMBER, ids],
      );
      await client.query(`delete from public.crm_leads where source_portal = $1 and source_lead_id = any($2::bigint[])`, [MEMBER, ids]);
      await client.query(
        `delete from public.integration_inbox where portal_member_id = $1 and source_object = 'lead' and source_deal_id = any($2::bigint[])`,
        [MEMBER, ids],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
  if (enabled && usedDealIds.size > 0) {
    const ids = [...usedDealIds];
    const client = new pg.Client({ connectionString: dbUrl! });
    await client.connect();
    try {
      await client.query('begin');
      await client.query(
        `update public.integration_inbox set processed_deal_id = null
         where portal_member_id = $1 and source_deal_id = any($2::bigint[])`,
        [MEMBER, ids],
      );
      // Owner 'sales' assignments are created by the import (20261007000100).
      await client.query(
        `delete from public.deal_assignments where deal_id in (
           select id from public.deals where source_system = 'bitrix' and source_portal = $1 and source_deal_id = any($2::bigint[]))`,
        [MEMBER, ids],
      );
      await client.query(
        `delete from public.deals where source_system = 'bitrix' and source_portal = $1 and source_deal_id = any($2::bigint[])`,
        [MEMBER, ids],
      );
      await client.query(`delete from public.integration_inbox where portal_member_id = $1 and source_deal_id = any($2::bigint[])`, [
        MEMBER,
        ids,
      ]);
      if (runIds.length > 0) {
        await client.query(`delete from public.integration_worker_runs where id = any($1::uuid[])`, [runIds]);
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
  await stack?.cleanup();
});

describe.skipIf(!enabled)('Phase 2 intake against the real stack', () => {
  it('P2-03: duplicate delivery stores one inbox row; processing creates one deal', async () => {
    const id = dealId(1);
    const args = { p_member_id: MEMBER, p_event_type: 'ONCRMDEALADD', p_deal_id: id, p_source_ts: (ts += 1) };
    const first = await rpc<RecordEventResult>(svc(), 'integration_record_bitrix_event', args);
    const second = await rpc<RecordEventResult>(svc(), 'integration_record_bitrix_event', args);
    expect(first.duplicate).toBe(false);
    expect(second).toEqual({ inboxId: first.inboxId, duplicate: true });
    const item = (await claim()).find((c) => c.inboxId === first.inboxId)!;
    const result = await apply(item, snapshot(id));
    expect(result.outcome).toBe('created');
    importedRef = `BX-${id}`;
    const rows = await ownerQuery(`select id from public.deals where source_portal = $1 and source_deal_id = $2`, [MEMBER, id]);
    expect(rows).toHaveLength(1);
  });

  it('P2-05: parallel claims never lease the same row twice', async () => {
    const ids = await Promise.all([2, 3, 4, 5, 6, 7].map(async (n) => (await record(dealId(n))).inboxId));
    const [a, b] = await Promise.all([claim(3), claim(3)]);
    const mine = [...a!, ...b!].filter((c) => ids.includes(c.inboxId));
    expect(new Set(mine.map((c) => c.inboxId)).size).toBe(mine.length);
    expect(new Set(mine.map((c) => c.inboxId))).toEqual(new Set(ids));
    expect(await claim()).toEqual([]);
  });

  it('P2-05: parallel applies for one deal create exactly one deal', async () => {
    const id = dealId(8);
    // Claim the first row before the second event arrives (a pending row would coalesce, L6).
    const x = await record(id, 'ONCRMDEALADD');
    const firstClaim = await claim();
    const y = await record(id, 'ONCRMDEALUPDATE');
    expect(y.duplicate).toBe(false);
    const items = [...firstClaim, ...(await claim())];
    const [r1, r2] = await Promise.all([
      apply(items.find((c) => c.inboxId === x.inboxId)!, snapshot(id)),
      apply(items.find((c) => c.inboxId === y.inboxId)!, snapshot(id)),
    ]);
    expect([r1!.outcome, r2!.outcome].sort()).toEqual(['created', 'stale_ignored']);
    expect(r1!.dealId).toBe(r2!.dealId);
    const rows = await ownerQuery(`select id from public.deals where source_portal = $1 and source_deal_id = $2`, [MEMBER, id]);
    expect(rows).toHaveLength(1);
  });

  it('L6 / L1 / M2: coalescing, lease release and the worker heartbeat', async () => {
    const id = dealId(14);
    const first = await record(id, 'ONCRMDEALADD');
    expect(await record(id, 'ONCRMDEALUPDATE')).toEqual({ inboxId: first.inboxId, duplicate: true });
    const item = (await claim()).find((c) => c.inboxId === first.inboxId)!;
    const released = await rpc<{ status: string; attempts: number }>(svc(), 'integration_release_inbox', {
      p_inbox_id: item.inboxId,
      p_lock_token: item.lockToken,
    });
    expect(released).toMatchObject({ status: 'pending', attempts: 0 });
    const again = (await claim()).find((c) => c.inboxId === first.inboxId)!;
    expect(again.attempts).toBe(1);
    expect((await apply(again, snapshot(id))).outcome).toBe('created');

    const now = Date.now();
    const runResult = await rpc<{ runId: string }>(svc(), 'integration_record_worker_run', {
      p_run: {
        kind: 'worker',
        startedAt: new Date(now - 2_000).toISOString(),
        finishedAt: new Date(now - 1_000).toISOString(),
        outcome: 'ok',
        claimed: 1,
        created: 1,
      },
    });
    runIds.push(runResult.runId);
    const staffCall = await admin.client.rpc('integration_record_worker_run', { p_run: {} });
    expect(staffCall.error?.code).toBe('42501');
  });

  it('P2-04: an older DATE_MODIFY never overwrites a newer one', async () => {
    const id = dealId(9);
    expect((await apply(await recordAndClaim(id), snapshot(id, { title: 'v2', dateModify: '2026-09-20T00:00:00Z' }))).outcome).toBe(
      'created',
    );
    expect((await apply(await recordAndClaim(id), snapshot(id, { title: 'v1', dateModify: '2026-09-19T00:00:00Z' }))).outcome).toBe(
      'stale_ignored',
    );
    const [deal] = await ownerQuery<{ title: string }>(`select title from public.deals where source_portal = $1 and source_deal_id = $2`, [
      MEMBER,
      id,
    ]);
    expect(deal!.title).toBe('v2');
  });

  // main's intake guards (20261009001000, PR #13 review fix 1): no guessed or missing owner.
  it('P2-08 / P2-09: unmapped owner needs review, other category is ignored, no deal', async () => {
    const review = await recordAndClaim(dealId(10));
    expect(await apply(review, snapshot(base + 10, { assignedById: '555' }))).toEqual({
      outcome: 'needs_review',
      dealId: null,
      reasonCode: 'unmapped_owner',
    });
    reviewInboxId = review.inboxId;
    const ignored = await recordAndClaim(dealId(11));
    expect((await apply(ignored, snapshot(base + 11, { categoryId: '8' }))).outcome).toBe('ignored');
    const rows = await ownerQuery(`select id from public.deals where source_portal = $1 and source_deal_id = any($2::bigint[])`, [
      MEMBER,
      [base + 10, base + 11],
    ]);
    expect(rows).toEqual([]);
    const audit = await ownerQuery<{ details: unknown }>(`select details from public.audit_events where target_id = $1`, [
      review.inboxId,
    ]);
    expect(JSON.stringify(audit)).not.toMatch(/Synthetic Bitrix deal/);
  });

  it('P2-10: a wrong portal is refused with 42501 and nothing is stored', async () => {
    const id = dealId(12);
    await expect(record(id, 'ONCRMDEALADD', 'OTHER_PORTAL')).rejects.toMatchObject({ code: '42501' });
    expect(await ownerQuery(`select id from public.integration_inbox where source_deal_id = $1`, [id])).toEqual([]);
  });

  it('P2-14: the imported deal is visible to the mapped owner only; Purchase gets no commercial row', async () => {
    const own = await owner.client.from('deals').select('reference, source_system, source_stage_id').order('reference');
    expect(own.error).toBeNull();
    expect((own.data ?? []).map((d) => d.reference)).toContain(importedRef);
    expect(own.data!.find((d) => d.reference === importedRef)).toMatchObject({ source_system: 'bitrix', source_stage_id: 'C7:NEW' });
    const p = await purchase.client.from('deals').select('reference');
    expect((p.data ?? []).map((d) => d.reference)).not.toContain(importedRef);
    // Super Admin reads no deal (access matrix; 20261009001000).
    const a = await admin.client.from('deals').select('reference');
    expect(a.data ?? []).toEqual([]);
    const [deal] = await ownerQuery<{ id: string }>(`select id from public.deals where reference = $1`, [importedRef]);
    for (const client of [owner.client, purchase.client, admin.client]) {
      const commercials = await client.from('deal_commercials').select('deal_id').eq('deal_id', deal!.id);
      expect(commercials.error).toBeNull();
      expect(commercials.data ?? []).toEqual([]);
    }
    expect(await ownerQuery(`select deal_id from public.deal_commercials where deal_id = $1`, [deal!.id])).toEqual([]);
  });

  it('P2-14: intake tables are readable only by an aal2 integration.manage session', async () => {
    for (const table of [
      'integration_inbox',
      'integration_intake_config',
      'bitrix_user_mappings',
      'deployment_settings',
      'integration_worker_runs',
    ]) {
      const asAdmin = await admin.client.from(table).select('*').limit(5);
      expect(asAdmin.error, table).toBeNull();
      expect((asAdmin.data ?? []).length, table).toBeGreaterThan(0);
      const asOwner = await owner.client.from(table).select('*');
      expect(asOwner.data ?? [], table).toEqual([]);
      const anon = await stack!.anon().from(table).select('*');
      expect(anon.data ?? [], table).toEqual([]);
      expect(anon.error?.code, table).toBe('42501');
    }
    const aal1 = await stack!.signIn(FIXTURE_EMAILS.adminJodhpur);
    const denied = await aal1.client.from('integration_inbox').select('*');
    expect(denied.data ?? []).toEqual([]);
    const write = await admin.client.from('integration_inbox').update({ status: 'pending' }).eq('id', reviewInboxId).select();
    expect(write.error?.code).toBe('42501');
  });

  it('P2-14: service-only commands are refused to staff; retry needs integration.manage and is audited', async () => {
    for (const client of [admin.client, owner.client, stack!.anon()]) {
      const { error } = await client.rpc('integration_claim_inbox', { p_limit: 1, p_lease_seconds: 60 });
      expect(error?.code).toBe('42501');
      const rec = await client.rpc('integration_record_bitrix_event', {
        p_member_id: MEMBER,
        p_event_type: 'ONCRMDEALADD',
        p_deal_id: base + 13,
        p_source_ts: 1,
      });
      expect(rec.error?.code).toBe('42501');
    }
    const bySales = await owner.client.rpc('integration_retry_inbox', { p_inbox_id: reviewInboxId });
    expect(bySales.error?.code).toBe('42501');
    const byAdmin = await admin.client.rpc('integration_retry_inbox', { p_inbox_id: reviewInboxId });
    expect(byAdmin.error).toBeNull();
    expect(byAdmin.data).toMatchObject({ status: 'pending', previousStatus: 'needs_review' });
    const audit = await ownerQuery<{ action: string; actor_user_id: string }>(
      `select action, actor_user_id from public.audit_events where target_id = $1 and action = 'integration.inbox_retried'`,
      [reviewInboxId],
    );
    expect(audit).toEqual([{ action: 'integration.inbox_retried', actor_user_id: FIXTURE_USERS.adminJodhpur }]);
  });

  it('L5: request_reconcile is admin-only, audited and cooled down', async () => {
    const bySales = await owner.client.rpc('integration_request_reconcile');
    expect(bySales.error?.code).toBe('42501');
    const bySvc = await svc().rpc('integration_request_reconcile');
    expect(bySvc.error?.code).toBe('42501');
    const first = await admin.client.rpc('integration_request_reconcile');
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({ portalMemberId: MEMBER });
    const second = await admin.client.rpc('integration_request_reconcile');
    expect(second.error).toBeNull();
    expect(second.data).toMatchObject({ portalMemberId: MEMBER, allowed: false });
    expect((second.data as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
    expect((second.data as { retryAfterSeconds: number }).retryAfterSeconds).toBeLessThanOrEqual(300);
    const audit = await ownerQuery<{ n: string }>(
      `select count(*)::text as n from public.audit_events
       where action = 'integration.reconcile_requested' and actor_user_id = $1`,
      [FIXTURE_USERS.adminJodhpur],
    );
    expect(Number(audit[0]!.n)).toBeGreaterThanOrEqual(2);
  });

  it('Phase 6: Lead events inside the run manifest import once even with parallel applies; outside are ignored', async () => {
    const id = leadId(1);
    const recordLead = (event: string) =>
      rpc<RecordEventResult>(svc(), 'integration_record_bitrix_event', {
        p_member_id: MEMBER, p_event_type: event, p_deal_id: id, p_source_ts: (ts += 1),
      });
    const x = await recordLead('ONCRMLEADADD');
    const firstClaim = await claim();
    const y = await recordLead('ONCRMLEADUPDATE');
    const items = [...firstClaim, ...(await claim())] as Array<ClaimedInboxItem & { sourceObject?: string }>;
    const ix = items.find((c) => c.inboxId === x.inboxId)!;
    const iy = items.find((c) => c.inboxId === y.inboxId)!;
    expect([ix.sourceObject, iy.sourceObject]).toEqual(['lead', 'lead']);
    const leadSnap = {
      id: String(id), title: 'Synthetic web form lead (CI)', statusId: 'NEW', sourceId: 'WEBFORM', assignedById: '101',
      dateCreate: '2026-10-04T11:00:00+05:30', dateModify: '2026-10-04T11:00:00+05:30',
    };
    const applyLead = (item: ClaimedInboxItem) =>
      rpc<{ outcome: string; leadId: string | null }>(svc(), 'integration_apply_bitrix_lead', {
        p_inbox_id: item.inboxId, p_lock_token: item.lockToken, p_lead: leadSnap,
      });
    const [r1, r2] = await Promise.all([applyLead(ix), applyLead(iy)]);
    expect([r1.outcome, r2.outcome].sort()).toEqual(['created', 'stale_ignored']);
    expect(r1.leadId).toBe(r2.leadId);
    expect(await ownerQuery(`select reference from public.crm_leads where source_portal = $1 and source_lead_id = $2`, [MEMBER, id])).toEqual([
      { reference: `BXL-${id}` },
    ]);
    expect(await ownerQuery(`select id from public.deals where source_portal = $1 and source_deal_id = $2`, [MEMBER, id])).toEqual([]);

    // Outside the manifest: same response shape, ignored row, never claimed, no CRM row.
    const outside = leadId(45);
    const o = await rpc<RecordEventResult>(svc(), 'integration_record_bitrix_event', {
      p_member_id: MEMBER, p_event_type: 'ONCRMLEADADD', p_deal_id: outside, p_source_ts: (ts += 1),
    });
    expect(Object.keys(o).sort()).toEqual(['duplicate', 'inboxId']);
    expect(await ownerQuery(`select status, reason_code, attempts from public.integration_inbox where id = $1`, [o.inboxId])).toEqual([
      { status: 'ignored', reason_code: 'not_in_manifest', attempts: 0 },
    ]);
    expect((await claim()).map((c) => c.inboxId)).not.toContain(o.inboxId);
    const enq = await rpc<{ ignored: boolean; inboxId: string | null }>(svc(), 'integration_enqueue_reconcile_lead', {
      p_member_id: MEMBER, p_lead_id: outside, p_source_modified: ts,
    });
    expect(enq).toMatchObject({ ignored: true, inboxId: null });
  });

  it('Phase 6: Lead RLS through PostgREST: owner, branch manager and admin read; Purchase never; nobody writes', async () => {
    const ref = `BXL-${leadBase + 1}`;
    const manager = await stack!.signInAal2(FIXTURE_EMAILS.managerDelhi, FIXTURE_USERS.managerDelhi);
    const salesB = await stack!.signInAal2(FIXTURE_EMAILS.salesDelhiB, FIXTURE_USERS.salesDelhiB);
    for (const [who, client, visible] of [
      ['owner', owner.client, true], ['manager', manager.client, true], ['admin', admin.client, true],
      ['purchase', purchase.client, false], ['other sales', salesB.client, false],
    ] as const) {
      const r = await client.from('crm_leads').select('reference').eq('reference', ref);
      expect(r.error, who).toBeNull();
      expect((r.data ?? []).map((x) => x.reference), who).toEqual(visible ? [ref] : []);
    }
    const anon = await stack!.anon().from('crm_leads').select('reference');
    expect(anon.error?.code).toBe('42501');
    const write = await owner.client.from('crm_leads').update({ title: 'x' }).eq('reference', ref).select();
    expect(write.error?.code).toBe('42501');
    for (const client of [owner.client, admin.client, stack!.anon()]) {
      const m = await client.from('intake_manifests').select('id');
      expect(m.data ?? []).toEqual([]);
      const create = await client.rpc('integration_manifest_create', {
        p_config_id: 'c0000000-0000-4000-8000-000000000001', p_source_object: 'lead', p_source_code: 'WEBFORM',
        p_business_date: '2026-10-04', p_interval_from: '2026-10-04T00:00:00+05:30', p_interval_to: '2026-10-05T00:00:00+05:30',
        p_ids: [leadBase + 2], p_operator: 'not-allowed',
      });
      expect(create.error?.code).toBe('42501');
      const close = await client.rpc('integration_manifest_close', { p_manifest_id: manifestIds[1], p_operator: 'not-allowed' });
      expect(close.error?.code).toBe('42501');
    }
  });

  it('Phase 6: concurrent manifest creation for one config and object: exactly one becomes active', async () => {
    const closed = await rpc<{ outcome: string }>(svc(), 'integration_manifest_close', { p_manifest_id: manifestIds[1], p_operator: 'real-stack-suite' });
    expect(closed.outcome).toBe('closed');
    const args = (n: number) => ({
      p_config_id: 'c0000000-0000-4000-8000-000000000001', p_source_object: 'lead', p_source_code: 'WEBFORM',
      p_business_date: '2026-10-04', p_interval_from: '2026-10-04T00:00:00+05:30', p_interval_to: '2026-10-05T00:00:00+05:30',
      p_ids: [leadBase + n], p_operator: 'real-stack-suite',
    });
    const results = await Promise.allSettled([3, 4, 5].map((n) => rpc<{ manifestId: string }>(svc(), 'integration_manifest_create', args(n))));
    const ok = results.filter((r): r is PromiseFulfilledResult<{ manifestId: string }> => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    manifestIds.push(ok[0]!.value.manifestId);
    for (const r of results.filter((x) => x.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: '55000', message: 'manifest already active' });
    }
    const active = await ownerQuery<{ n: string }>(
      `select count(*)::text as n from public.intake_manifests where config_id = 'c0000000-0000-4000-8000-000000000001'
         and source_object = 'lead' and status = 'active'`,
    );
    expect(active[0]!.n).toBe('1');
  });
});
