import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, SYNTHETIC_INTAKE_CONFIG, assertLoopbackDatabaseUrl, claimsFor } from '../helpers/db';

/**
 * Batch 2 (20261122000100) two-session proofs on REAL Postgres only
 * (TEST_DATABASE_URL = a disposable local stack; skipped on PGlite, which is
 * one connection):
 *   - F.1.4 test 10: "Fill empty fields from Bitrix" and a staff save of the
 *     same draft from two sessions: one wins, the other gets version_changed;
 *     marks and history agree with the winner (both orders);
 *   - two "Start booking" at once: one draft, one creation fill, one run row;
 *   - Echo L11 / F.6 N5: while another session holds the settings row,
 *     admin_set_workflow_setting answers settings_busy (55P03) within its
 *     5 s lock timeout instead of hanging.
 * Setup is committed (two sessions must see it) with run-unique synthetic
 * ids; afterAll removes every row this file created as the local table owner
 * (triggers suspended in that transaction only) and restores the switches.
 */

const url = process.env.TEST_DATABASE_URL?.trim();
const enabled = Boolean(url);
const OWNER_ACTOR: Actor = { userId: U.salesDelhiA };
const SUPER_ACTOR: Actor = { userId: U.adminJodhpur };
const SOURCE_IDS = [930001, 930002, 930003];

let admin: pg.Client;
let auditStart = '0';
let saved: { service: boolean; auto: boolean; real: boolean; read: boolean } | null = null;
const dealIds: string[] = [];

async function connect(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url! });
  await c.connect();
  return c;
}
async function q<T extends pg.QueryResultRow>(c: pg.Client, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await c.query<T>(sql, params)).rows;
}
/** Opens a transaction impersonating the actor (as PostgREST would). */
async function beginAs(c: pg.Client, actor: Actor): Promise<void> {
  await c.query('begin');
  await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claimsFor(actor))]);
  await c.query('set local role authenticated');
}
async function errorOf(p: Promise<unknown>): Promise<{ code?: string; message?: string } | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e as { code?: string; message?: string };
  }
}

async function dealWithFacts(sourceDealId: number): Promise<string> {
  const [inbox] = await q<{ id: string }>(admin,
    `insert into public.integration_inbox (portal_member_id, event_type, source_deal_id, source_ts, dedupe_key, status, processed_at)
     values ('SYNTHETIC_MEMBER_0001', 'ONCRMDEALADD', $1::bigint, 1, repeat('f', 58) || lpad($1::text, 6, '0'), 'processed', now()) returning id`,
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
  await q(admin,
    `insert into public.deal_source_trip_facts (deal_id, legal_entity_id, tour_start, tour_end, customer_type_enum_id, source_contact_id,
       source_modified_at)
     select d.id, d.legal_entity_id, '2026-12-10'::date, '2026-12-14'::date, '3045', $2, now() - interval '1 day'
     from public.deals d where d.id = $1`, [deal!.id, sourceDealId]);
  await q(admin,
    `insert into public.bitrix_party_snapshots (legal_entity_id, source_portal, party_kind, source_party_id, display_name, phones, emails)
     select d.legal_entity_id, 'SYNTHETIC_MEMBER_0001', 'contact', $2, 'Synthetic Race Contact', array['9876500055'], array['race@example.test']
     from public.deals d where d.id = $1`, [deal!.id, sourceDealId]);
  return deal!.id;
}

describe.skipIf(!enabled)('Batch 2 automatic fill: two sessions (real Postgres)', () => {
  beforeAll(async () => {
    assertLoopbackDatabaseUrl(url!);
    admin = await connect();
    auditStart = (await q<{ m: string }>(admin, 'select coalesce(max(id), 0)::text as m from public.audit_events'))[0]!.m;
    const [s] = await q<{ service: boolean; auto: boolean }>(admin,
      'select service_items_enabled as service, prefill_auto_fill as auto from public.workflow_settings where id');
    const [b] = await q<{ real: boolean }>(admin, 'select real_booking_enabled as real from public.booking_settings where id');
    const [r] = await q<{ read: boolean }>(admin, 'select bitrix_trip_facts_read as read from public.integration_intake_config where id = $1',
      [SYNTHETIC_INTAKE_CONFIG]);
    saved = { service: s!.service, auto: s!.auto, real: b!.real, read: r!.read };
    await q(admin, 'update public.workflow_settings set service_items_enabled = true, prefill_auto_fill = true where id');
    await q(admin, 'update public.booking_settings set real_booking_enabled = true where id');
    await q(admin, 'update public.integration_intake_config set bitrix_trip_facts_read = true where id = $1', [SYNTHETIC_INTAKE_CONFIG]);
  });

  afterAll(async () => {
    if (!admin) return;
    try {
      await admin.query('begin');
      await admin.query(`set local session_replication_role = replica`);
      const targets = `select id from public.booking_versions where deal_id = any ($1::uuid[])`;
      for (const t of ['prefill_marks', 'prefill_field_history', 'prefill_fill_runs', 'prefill_notice_dismissals']) {
        await admin.query(`delete from public.${t} where target_id in (${targets})`, [dealIds]);
      }
      await admin.query(`delete from public.booking_version_contacts where deal_id = any ($1::uuid[])`, [dealIds]);
      await admin.query(`delete from public.booking_versions where deal_id = any ($1::uuid[])`, [dealIds]);
      await admin.query(`delete from public.deal_source_trip_facts where deal_id = any ($1::uuid[])`, [dealIds]);
      await admin.query(`delete from public.bitrix_party_snapshots where source_portal = 'SYNTHETIC_MEMBER_0001' and party_kind = 'contact'
                         and source_party_id = any ($1::bigint[])`, [SOURCE_IDS]);
      await admin.query(`delete from public.deals where id = any ($1::uuid[])`, [dealIds]);
      await admin.query(`delete from public.integration_inbox where source_deal_id = any ($1::bigint[]) and dedupe_key like 'ffff%'`, [SOURCE_IDS]);
      if (saved) {
        await admin.query('update public.workflow_settings set service_items_enabled = $1, prefill_auto_fill = $2 where id', [saved.service, saved.auto]);
        await admin.query('update public.booking_settings set real_booking_enabled = $1 where id', [saved.real]);
        await admin.query('update public.integration_intake_config set bitrix_trip_facts_read = $2 where id = $1', [SYNTHETIC_INTAKE_CONFIG, saved.read]);
      }
      await admin.query('delete from public.audit_events where id > $1::bigint', [auditStart]);
      await admin.query('commit');
    } finally {
      await admin.end();
    }
  });

  it('two Start booking calls at once: one draft, one creation fill, one run row', async () => {
    const deal = await dealWithFacts(SOURCE_IDS[0]!);
    const a = await connect();
    const b = await connect();
    try {
      await beginAs(a, OWNER_ACTOR);
      await beginAs(b, OWNER_ACTOR);
      const first = (await q<{ r: { created: boolean; autoFill: string; versionId: string } }>(a, 'select public.booking_start_draft($1) as r', [deal]))[0]!.r;
      const secondP = q<{ r: { created: boolean; autoFill: string; versionId: string } }>(b, 'select public.booking_start_draft($1) as r', [deal]);
      await new Promise((r) => setTimeout(r, 300));
      await a.query('commit');
      const second = (await secondP)[0]!.r;
      await b.query('commit');
      expect(first).toMatchObject({ created: true, autoFill: 'filled' });
      expect(second).toMatchObject({ created: false, autoFill: 'existing_draft', versionId: first.versionId });
      expect(await q(admin, 'select count(*)::int as n from public.prefill_fill_runs where target_id = $1', [first.versionId])).toEqual([{ n: 1 }]);
      expect(await q(admin, `select count(*)::int as n from public.booking_versions where deal_id = $1`, [deal])).toEqual([{ n: 1 }]);
    } finally {
      await a.end();
      await b.end();
    }
  });

  it('F.1.4-10: Fill empty and a staff save of the same draft: the later one gets version_changed; marks and history follow the winner', async () => {
    for (const [i, fillFirst] of [[1, true], [2, false]] as const) {
      await q(admin, 'update public.workflow_settings set prefill_auto_fill = false where id');
      const deal = await dealWithFacts(SOURCE_IDS[i]!);
      const opened = (await (async () => {
        const c = await connect();
        try {
          await beginAs(c, OWNER_ACTOR);
          const r = (await q<{ r: { versionId: string; rowVersion: number } }>(c, 'select public.booking_start_draft($1) as r', [deal]))[0]!.r;
          await c.query('commit');
          return r;
        } finally {
          await c.end();
        }
      })());
      await q(admin, 'update public.workflow_settings set prefill_auto_fill = true where id');
      const a = await connect();
      const b = await connect();
      try {
        await beginAs(a, OWNER_ACTOR);
        await beginAs(b, OWNER_ACTOR);
        const fill = (c: pg.Client) => q(c, 'select public.prefill_fill_empty($1, $2, $3) as r', ['booking_version', opened.versionId, opened.rowVersion]);
        const save = (c: pg.Client) => q(c, 'select public.booking_contacts_save($1, $2, $3::jsonb) as r', [opened.versionId, opened.rowVersion,
          JSON.stringify({ contactName: 'Synthetic Staff Contact', mobile: '9876500066', email: null, contactConfirmed: false, bookingFor: 'individual',
            payerDifferent: false, payerName: null })]);
        await (fillFirst ? fill(a) : save(a));
        const loserP = errorOf(fillFirst ? save(b) : fill(b));
        await new Promise((r) => setTimeout(r, 300));
        await a.query('commit');
        const loser = await loserP;
        await b.query('rollback');
        expect(loser).toMatchObject({ code: '40001', message: 'version_changed' });
        const marks = await q<{ field_code: string; state: string }>(admin,
          'select field_code, state from public.prefill_marks where target_id = $1 order by field_code', [opened.versionId]);
        const hist = await q<{ field_code: string }>(admin,
          'select field_code from public.prefill_field_history where target_id = $1 order by field_code', [opened.versionId]);
        const [contact] = await q<{ contact_name: string; mobile: string }>(admin,
          'select contact_name, mobile from public.booking_version_contacts where booking_version_id = $1', [opened.versionId]);
        if (fillFirst) {
          expect(contact).toMatchObject({ contact_name: 'Synthetic Race Contact', mobile: '9876500055' });
          expect(marks.map((m) => m.state)).toEqual(Array(6).fill('from_bitrix'));
          expect(hist).toEqual([]);
        } else {
          expect(contact).toMatchObject({ contact_name: 'Synthetic Staff Contact', mobile: '9876500066' });
          expect(marks).toEqual([]);
          expect(hist.map((x) => x.field_code)).toEqual(['contacts.bookingFor', 'contacts.contactName', 'contacts.mobile']);
        }
      } finally {
        await a.end();
        await b.end();
      }
    }
  });

  it('Echo L11 / F.6 N5: a held settings row makes the switch command answer settings_busy within its timeout', async () => {
    const holder = await connect();
    const caller = await connect();
    try {
      await holder.query('begin');
      await holder.query('select 1 from public.workflow_settings where id for share');
      await beginAs(caller, SUPER_ACTOR);
      const started = Date.now();
      const err = await errorOf(q(caller, 'select public.admin_set_workflow_setting($1, $2, $3) as r',
        ['prefill_auto_fill', false, 'Synthetic test reason for the switch']));
      const waited = Date.now() - started;
      await caller.query('rollback');
      expect(err).toMatchObject({ code: '55P03', message: 'settings_busy' });
      expect(waited).toBeGreaterThanOrEqual(4000);
      expect(waited).toBeLessThan(15000);
    } finally {
      await holder.query('rollback');
      await holder.end();
      await caller.end();
    }
  });
});
