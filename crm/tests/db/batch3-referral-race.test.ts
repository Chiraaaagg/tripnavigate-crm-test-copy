import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, assertLoopbackDatabaseUrl, claimsFor } from '../helpers/db';

/**
 * Batch 3 (20261123000100) two-session proofs on REAL Postgres only
 * (TEST_DATABASE_URL = a disposable local stack; skipped on PGlite, which is
 * one connection):
 *   - F.3.4-5: the job never waits for, and never closes, a draft another
 *     session holds; a draft not due by committed data is not touched;
 *   - F.3.4-6: reopen and the job in either order: final state open, exactly
 *     one automatic-closure audit row and one reopen row;
 *   - F.3.4-7: a switch change waits for a running job batch; the next run
 *     is a no-op;
 *   - F.3.4-13 (Echo M5): a quotation save and referral_draft_link on the
 *     same draft, both orders: no deadlock, both succeed in turn;
 *   - F.3.4-15: while a batch holds the settings row, the switch command
 *     answers settings_busy within its 5 s lock timeout;
 *   - Echo-A L5: a concurrent duplicate create answers as a replay;
 *   - B.7 / R7: two sessions bind two accepted referral quotations to one
 *     Deal: one wins, the other gets deal_already_linked.
 * Setup is committed (two sessions must see it); afterAll removes every row
 * this file created as the local table owner (triggers suspended in that
 * transaction only) and restores the switches and counters.
 */

const url = process.env.TEST_DATABASE_URL?.trim();
const enabled = Boolean(url);
const OWNER_ACTOR: Actor = { userId: U.salesDelhiA };
const MANAGER_ACTOR: Actor = { userId: U.managerDelhi };
const SUPER_ACTOR: Actor = { userId: U.adminJodhpur };
const SOURCE_IDS = [940001, 940002];
const REASON = 'Synthetic test reason for the switch';

let admin: pg.Client;
let auditStart = '0';
let saved: { referral: boolean; resumed: string | null; service: boolean; real: boolean } | null = null;
let counters: Array<{ legal_entity_id: string; last_no: number; table: string }> = [];
const dealIds: string[] = [];
const draftIds: string[] = [];

async function connect(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url! });
  await c.connect();
  return c;
}
async function q<T extends pg.QueryResultRow>(c: pg.Client, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await c.query<T>(sql, params)).rows;
}
async function beginAs(c: pg.Client, actor: Actor): Promise<void> {
  await c.query('begin');
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claimsFor(actor))]);
  await c.query(actor.role === 'service_role' ? 'set local role service_role' : 'set local role authenticated');
}
async function errorOf(p: Promise<unknown>): Promise<{ code?: string; message?: string } | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e as { code?: string; message?: string };
  }
}
const pause = (ms = 300) => new Promise((r) => setTimeout(r, ms));
/** One committed call as the actor. */
async function as<T>(actor: Actor, sql: string, params: unknown[] = []): Promise<T> {
  const c = await connect();
  try {
    await beginAs(c, actor);
    const r = (await q<{ r: T }>(c, sql, params))[0]!.r;
    await c.query('commit');
    return r;
  } finally {
    await c.end();
  }
}
type Standalone = { referralDraftId: string; quotationId: string; versionId: string; rowVersion: number };
async function newDraft(name: string): Promise<Standalone> {
  const [b] = await q<{ id: string }>(admin, `select b.id from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
    where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL'`);
  const s = await as<Standalone>(OWNER_ACTOR, 'select public.quotation_create_standalone($1, $2::jsonb, $3, $4) as r',
    [b!.id, JSON.stringify({ customerName: name }), 'Synthetic race quote', crypto.randomUUID()]);
  draftIds.push(s.referralDraftId);
  return s;
}
const age = (draft: string, days: number) =>
  q(admin, `update public.referral_drafts set last_activity_at = now() - make_interval(days => $2) where id = $1`, [draft, days]);
const draftRow = async (draft: string) =>
  (await q<{ status: string; row_version: number }>(admin, 'select status, row_version from public.referral_drafts where id = $1', [draft]))[0]!;
const auditCount = async (draft: string, action: string) =>
  Number((await q<{ n: string }>(admin, 'select count(*)::text as n from public.audit_events where target_id = $1 and action = $2', [draft, action]))[0]!.n);

async function insertDeal(sourceDealId: number): Promise<string> {
  const [inbox] = await q<{ id: string }>(admin,
    `insert into public.integration_inbox (portal_member_id, event_type, source_deal_id, source_ts, dedupe_key, status, processed_at)
     values ('SYNTHETIC_MEMBER_0001', 'ONCRMDEALADD', $1::bigint, 1, repeat('e', 58) || lpad($1::text, 6, '0'), 'processed', now()) returning id`,
    [sourceDealId]);
  const [deal] = await q<{ id: string }>(admin,
    `insert into public.deals (legal_entity_id, branch_id, reference, title, owner_user_id, is_synthetic,
       source_system, source_portal, source_deal_id, source_stage_id, source_category_id, source_created_at,
       source_modified_at, last_synced_at, last_verified_at, intake_inbox_id, source_assigned_by_id)
     select b.legal_entity_id, b.id, 'BX-' || $2::text, 'Synthetic race deal', $1, false, 'bitrix', 'SYNTHETIC_MEMBER_0001', $2::bigint,
       'UC_AD0SLH', 0, now() - interval '3 days', now() - interval '2 days', now(), now(), $3, 101
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
     where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL' returning id`, [U.salesDelhiA, sourceDealId, inbox!.id]);
  dealIds.push(deal!.id);
  return deal!.id;
}
/** Test fixture only: marks version 1 accepted with a stored acceptance row (the acceptance path itself is covered on PGlite). */
async function markAccepted(s: Standalone): Promise<void> {
  await admin.query('begin');
  await admin.query('set local session_replication_role = replica');
  const [ev] = await q<{ id: string }>(admin,
    `insert into public.quotation_evidence (id, quotation_version_id, quotation_id, legal_entity_id, kind, object_path, file_name, mime,
       size_bytes, sha256, status, uploaded_by, stored_at)
     select i.id, v.id, v.quotation_id, v.legal_entity_id, 'acceptance_message',
            v.legal_entity_id::text || '/' || v.quotation_id::text || '/' || v.id::text || '/' || i.id::text,
            'acceptance.pdf', 'application/pdf', 10, repeat('a', 64), 'stored', $2, now()
     from public.quotation_versions v cross join (select gen_random_uuid() as id) i where v.id = $1 returning id`, [s.versionId, U.salesDelhiA]);
  await q(admin, `update public.quotation_versions set status = 'accepted', content_hash = repeat('b', 64), sent_at = now(), sent_by = $2,
    sent_channel = 'whatsapp', accepted_at = now(), accepted_by = $2, accepted_tier = 'quoted', acceptance_evidence_id = $3 where id = $1`,
    [s.versionId, U.salesDelhiA, ev!.id]);
  await q(admin, 'update public.quotations set accepted_version_id = $2 where id = $1', [s.quotationId, s.versionId]);
  await admin.query('commit');
}
async function link(actor: Actor, draft: string, deal: string): Promise<void> {
  const rv = (await draftRow(draft)).row_version;
  await as(actor, 'select public.referral_draft_link($1, $2, $3, $4, $5) as r', [draft, rv, 'deal', deal, null]);
}
const JOB = 'select public.referral_drafts_close_inactive($1) as r';
const SVC: Actor = { userId: null, role: 'service_role' };

describe.skipIf(!enabled)('Batch 3 referral drafts: two sessions (real Postgres)', () => {
  beforeAll(async () => {
    assertLoopbackDatabaseUrl(url!);
    admin = await connect();
    auditStart = (await q<{ m: string }>(admin, 'select coalesce(max(id), 0)::text as m from public.audit_events'))[0]!.m;
    const [s] = await q<{ referral: boolean; resumed: string | null; service: boolean }>(admin,
      'select referral_drafts as referral, referral_auto_close_resumed_at::text as resumed, service_items_enabled as service from public.workflow_settings where id');
    const [b] = await q<{ real: boolean }>(admin, 'select real_booking_enabled as real from public.booking_settings where id');
    saved = { referral: s!.referral, resumed: s!.resumed, service: s!.service, real: b!.real };
    counters = [
      ...(await q<{ legal_entity_id: string; last_no: number }>(admin, 'select legal_entity_id, last_no from public.referral_draft_counters'))
        .map((r) => ({ ...r, table: 'referral_draft_counters' })),
      ...(await q<{ legal_entity_id: string; last_no: number }>(admin, 'select legal_entity_id, last_no from public.quotation_counters'))
        .map((r) => ({ ...r, table: 'quotation_counters' })),
    ];
    await q(admin, 'update public.workflow_settings set referral_drafts = true, service_items_enabled = true where id');
    await q(admin, `update public.workflow_settings set referral_auto_close_resumed_at = now() - interval '400 days' where id`);
    await q(admin, 'update public.booking_settings set real_booking_enabled = true where id');
  });

  afterAll(async () => {
    if (!admin) return;
    try {
      await admin.query('rollback').catch(() => undefined);
      await admin.query('begin');
      await admin.query('set local session_replication_role = replica');
      const versions = `select v.id from public.quotation_versions v join public.quotations q on q.id = v.quotation_id
                        where q.referral_draft_id = any ($1::uuid[])`;
      await admin.query(`delete from public.prefill_field_history where target_id in (${versions})`, [draftIds]);
      await admin.query(`delete from public.prefill_marks where target_id in (${versions})`, [draftIds]);
      for (const t of ['quotation_version_tiers', 'quotation_version_contacts', 'quotation_version_items']) {
        await admin.query(`delete from public.${t} where quotation_version_id in (${versions})`, [draftIds]);
      }
      // Foreign keys are triggers, suspended by the replica role in this transaction only.
      await admin.query(`delete from public.quotation_evidence where quotation_version_id in (${versions})`, [draftIds]);
      await admin.query(`delete from public.quotation_versions where id in (${versions})`, [draftIds]);
      await admin.query(`delete from public.quotations where referral_draft_id = any ($1::uuid[])`, [draftIds]);
      await admin.query(`delete from public.referral_draft_links where referral_draft_id = any ($1::uuid[])`, [draftIds]);
      await admin.query(`delete from public.referral_drafts where id = any ($1::uuid[])`, [draftIds]);
      await admin.query(`delete from public.deals where id = any ($1::uuid[])`, [dealIds]);
      await admin.query(`delete from public.integration_inbox where source_deal_id = any ($1::bigint[]) and dedupe_key like 'eeee%'`, [SOURCE_IDS]);
      await admin.query('delete from public.referral_draft_counters');
      for (const c of counters) {
        await admin.query(`insert into public.${c.table} (legal_entity_id, last_no) values ($1, $2)
                           on conflict (legal_entity_id) do update set last_no = excluded.last_no`, [c.legal_entity_id, c.last_no]);
      }
      if (saved) {
        await admin.query('update public.workflow_settings set referral_drafts = $1, referral_auto_close_resumed_at = $2::timestamptz, service_items_enabled = $3 where id',
          [saved.referral, saved.resumed, saved.service]);
        await admin.query('update public.booking_settings set real_booking_enabled = $1 where id', [saved.real]);
      }
      await admin.query('delete from public.audit_events where id > $1::bigint', [auditStart]);
      await admin.query('commit');
    } finally {
      await admin.end();
    }
  });

  it('F.3.4-5: the job skips a draft another session holds and leaves a not-due draft alone', async () => {
    const held = await newDraft('Synthetic Held');
    const fresh = await newDraft('Synthetic Fresh');
    await age(held.referralDraftId, 120);
    await age(fresh.referralDraftId, 80);
    const holder = await connect();
    const job = await connect();
    try {
      await holder.query('begin');
      await holder.query('select 1 from public.referral_drafts where id = $1 for update', [held.referralDraftId]);
      // A save on the not-due draft holds its row too.
      const saver = await connect();
      await beginAs(saver, OWNER_ACTOR);
      await q(saver, 'select public.quotation_version_save($1, $2, $3::jsonb) as r', [fresh.versionId, fresh.rowVersion, JSON.stringify({ adults: 2 })]);
      await beginAs(job, SVC);
      const started = Date.now();
      const r = (await q<{ r: { closed: number } }>(job, JOB, [200]))[0]!.r;
      expect(Date.now() - started).toBeLessThan(3000);
      await job.query('commit');
      expect(r.closed).toBe(0);
      await saver.query('commit');
      await saver.end();
      await holder.query('rollback');
      expect((await draftRow(held.referralDraftId)).status).toBe('open');
      expect((await draftRow(fresh.referralDraftId)).status).toBe('open');
      // Now the held draft is free: the next run closes it, once.
      expect((await as<{ closed: number }>(SVC, JOB, [200])).closed).toBe(1);
      expect((await as<{ closed: number }>(SVC, JOB, [200])).closed).toBe(0);
      expect(await auditCount(held.referralDraftId, 'referral.draft_closed')).toBe(1);
    } finally {
      await holder.end();
      await job.end();
    }
  });

  it('F.3.4-6: reopen and the job in either order: open, one closure row and one reopen row', async () => {
    for (const reopenFirst of [true, false]) {
      const d = await newDraft(`Synthetic Reopen ${reopenFirst}`);
      await age(d.referralDraftId, 120);
      const a = await connect();
      const b = await connect();
      try {
        await beginAs(a, reopenFirst ? OWNER_ACTOR : SVC);
        await beginAs(b, reopenFirst ? SVC : OWNER_ACTOR);
        const reopen = (c: pg.Client) => q<{ r: { closedAutomatically: boolean } }>(c, 'select public.referral_draft_reopen($1, $2, $3) as r',
          [d.referralDraftId, 1, null]);
        if (reopenFirst) {
          const r = (await reopen(a))[0]!.r;
          expect(r.closedAutomatically).toBe(true);
          const j = (await q<{ r: { closed: number } }>(b, JOB, [200]))[0]!.r;  // skips the locked row at once
          expect(j.closed).toBe(0);
          await a.query('commit');
          await b.query('commit');
        } else {
          const j = (await q<{ r: { closed: number } }>(a, JOB, [200]))[0]!.r;
          expect(j.closed).toBeGreaterThanOrEqual(1);
          // The reopen waits for the job's lock; the row version moved, so it refuses until re-read.
          const waiting = errorOf(reopen(b));
          await pause();
          await a.query('commit');
          const err = await waiting;
          expect(err).toMatchObject({ code: '40001', message: 'version_changed' });
          await b.query('rollback');
          const rv = (await draftRow(d.referralDraftId)).row_version;
          const r = await as<{ closedAutomatically: boolean }>(OWNER_ACTOR, 'select public.referral_draft_reopen($1, $2, $3) as r',
            [d.referralDraftId, rv, null]);
          expect(r.closedAutomatically).toBe(true);
        }
        expect((await draftRow(d.referralDraftId)).status).toBe('open');
        expect(await auditCount(d.referralDraftId, 'referral.draft_closed')).toBe(1);
        expect(await auditCount(d.referralDraftId, 'referral.draft_reopened')).toBe(1);
      } finally {
        await a.end();
        await b.end();
      }
    }
  });

  it('F.3.4-7 and 15: a switch change waits for a running batch (settings_busy after 5 s); the next run is a no-op', async () => {
    const job = await connect();
    const caller = await connect();
    try {
      await beginAs(job, SVC);
      await q(job, JOB, [200]);
      await beginAs(caller, SUPER_ACTOR);
      const started = Date.now();
      const busy = await errorOf(q(caller, 'select public.admin_set_workflow_setting($1, $2, $3) as r', ['referral_drafts', false, REASON]));
      const waited = Date.now() - started;
      await caller.query('rollback');
      expect(busy).toMatchObject({ code: '55P03', message: 'settings_busy' });
      expect(waited).toBeGreaterThanOrEqual(4000);
      expect(waited).toBeLessThan(15000);
      // Within the timeout the change waits for the batch and then applies.
      await beginAs(caller, SUPER_ACTOR);
      const pending = q<{ r: { after: boolean } }>(caller, 'select public.admin_set_workflow_setting($1, $2, $3) as r', ['referral_drafts', false, REASON]);
      await pause(500);
      await job.query('commit');
      expect((await pending)[0]!.r.after).toBe(false);
      await caller.query('commit');
      expect(await as(SVC, JOB, [200])).toEqual({ closed: 0, skipped: 'switch_off' });
      await q(admin, `update public.workflow_settings set referral_drafts = true where id`);
      await q(admin, `update public.workflow_settings set referral_auto_close_resumed_at = now() - interval '400 days' where id`);
    } finally {
      await job.query('rollback').catch(() => undefined);
      await job.end();
      await caller.end();
    }
  });

  it('F.3.4-13: a quotation save and referral_draft_link on one draft, both orders: no deadlock, both succeed', async () => {
    for (const saveFirst of [true, false]) {
      const d = await newDraft(`Synthetic Link Race ${saveFirst}`);
      const deal = await insertDeal(SOURCE_IDS[saveFirst ? 0 : 1]!);
      const a = await connect();
      const b = await connect();
      try {
        await beginAs(a, OWNER_ACTOR);
        await beginAs(b, MANAGER_ACTOR);
        const save = (c: pg.Client) => q(c, 'select public.quotation_version_save($1, $2, $3::jsonb) as r', [d.versionId, d.rowVersion,
          JSON.stringify({ adults: 3 })]);
        const doLink = (c: pg.Client) => q(c, 'select public.referral_draft_link($1, $2, $3, $4, $5) as r', [d.referralDraftId, 1, 'deal', deal, null]);
        await (saveFirst ? save(a) : doLink(b));
        const second = errorOf(saveFirst ? doLink(b) : save(a));
        await pause();
        await (saveFirst ? a : b).query('commit');
        expect(await second).toBeNull();
        await (saveFirst ? b : a).query('commit');
        expect(await q(admin, 'select count(*)::int as n from public.referral_draft_links where referral_draft_id = $1', [d.referralDraftId]))
          .toEqual([{ n: 1 }]);
        expect(await q(admin, 'select adults from public.quotation_versions where id = $1', [d.versionId])).toEqual([{ adults: 3 }]);
      } finally {
        await a.query('rollback').catch(() => undefined);
        await b.query('rollback').catch(() => undefined);
        await a.end();
        await b.end();
      }
    }
  });

  it('Echo-A L5: two creates with the same request id at once: one draft, the second answers as its replay', async () => {
    const [b] = await q<{ id: string }>(admin, `select b.id from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
      where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL'`);
    const req = crypto.randomUUID();
    const args = [b!.id, JSON.stringify({ customerName: 'Synthetic Same Request' }), 'Synthetic race quote', req];
    const sql = 'select public.quotation_create_standalone($1, $2::jsonb, $3, $4) as r';
    const a = await connect();
    const c = await connect();
    try {
      await beginAs(a, OWNER_ACTOR);
      await beginAs(c, OWNER_ACTOR);
      const first = (await q<{ r: Standalone & { created: boolean } }>(a, sql, args))[0]!.r;
      draftIds.push(first.referralDraftId);
      const secondP = q<{ r: Standalone & { created: boolean } }>(c, sql, args);
      await pause();
      await a.query('commit');
      const second = (await secondP)[0]!.r;
      await c.query('commit');
      expect(first.created).toBe(true);
      expect(second).toMatchObject({ created: false, referralDraftId: first.referralDraftId, quotationId: first.quotationId });
      expect(await q(admin, 'select count(*)::int as n from public.referral_drafts where request_id = $1', [req])).toEqual([{ n: 1 }]);
    } finally {
      await a.query('rollback').catch(() => undefined);
      await c.query('rollback').catch(() => undefined);
      await a.end();
      await c.end();
    }
  });

  it('B.7 / R7: two sessions bind two accepted referral quotations to one Deal: one wins, the other gets deal_already_linked', async () => {
    const deal = (await q<{ id: string }>(admin, 'select id from public.deals where id = $1', [dealIds[0]]))[0]!.id;
    // The first deal already carries a link from the previous case; use fresh drafts on it.
    const one = await newDraft('Synthetic Bind One');
    const two = await newDraft('Synthetic Bind Two');
    await markAccepted(one);
    await markAccepted(two);
    await link(OWNER_ACTOR, one.referralDraftId, deal);
    await link(OWNER_ACTOR, two.referralDraftId, deal);
    const rv = async (qid: string) => (await q<{ row_version: number }>(admin, 'select row_version from public.quotations where id = $1', [qid]))[0]!.row_version;
    const a = await connect();
    const b = await connect();
    try {
      await beginAs(a, OWNER_ACTOR);
      await beginAs(b, OWNER_ACTOR);
      await q(a, 'select public.quotation_link_deal($1, $2, $3) as r', [one.quotationId, deal, await rv(one.quotationId)]);
      const loser = errorOf(q(b, 'select public.quotation_link_deal($1, $2, $3) as r', [two.quotationId, deal, await rv(two.quotationId)]));
      await pause();
      await a.query('commit');
      expect(await loser).toMatchObject({ code: '55000', message: 'deal_already_linked' });
      await b.query('rollback');
      expect(await q(admin, 'select count(*)::int as n from public.quotations where linked_deal_id = $1', [deal])).toEqual([{ n: 1 }]);
    } finally {
      await a.end();
      await b.end();
    }
  });
});
