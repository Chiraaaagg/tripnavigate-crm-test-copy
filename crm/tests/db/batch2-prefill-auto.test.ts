import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, SYNTHETIC_INTAKE_CONFIG, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { priceQuotationVersion } from './b12-quotation-money-support';
import { ACCOUNTS, ANON, CHECKLIST_SQL, FLIGHT, HOTEL, MANAGER, OWNER, PURCHASE, REASON, SALES_B, SUPER, TRANSFER, rid } from './b1-support';
import { b11Helpers } from './b11-support';

/**
 * Direction A Batch 2 (migration 20261122000100_prefill_auto_fill):
 * automatic fill of new drafts behind prefill_auto_fill (off by default),
 * value-free field history (deliberate clearing is never undone), kept marks,
 * the contact tick, "Use it" / "Keep mine", "Fill empty fields from Bitrix",
 * conversion precedence and the switch-off guarantee.
 * contracts.md A.11, F.1.4 and F.2 test lists. Synthetic fixtures only; every
 * case rolled back.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b11Helpers(() => db);
const { one, refused, owner } = h;

const START = 'select public.booking_start_draft($1) as r';
const FILL = 'select public.prefill_fill_empty($1, $2, $3) as r';
const DISMISS = 'select public.prefill_notice_dismiss($1, $2, $3, $4, $5::timestamptz) as r';
const CHECK = 'select public.prefill_mark_checked($1, $2, $3, $4::text[]) as r';
const APPLY = 'select public.booking_prefill_apply($1, $2, $3::text[]) as r';
const Q_APPLY = 'select public.quotation_prefill_apply($1, $2, $3::text[]) as r';
const FORM = 'select public.booking_form_get($1) as r';
const Q = {
  create: 'select public.quotation_create($1, $2, $3, $4) as r',
  save: 'select public.quotation_version_save($1, $2, $3::jsonb) as r',
  contacts: 'select public.quotation_contacts_save($1, $2, $3::jsonb) as r',
  itemAdd: 'select public.quotation_item_add($1, $2, $3, $4, $5::jsonb) as r',
  ready: 'select public.quotation_mark_ready($1, $2) as r',
  sent: 'select public.quotation_mark_sent($1, $2, $3, $4) as r',
  evBegin: 'select public.quotation_evidence_begin($1, $2, $3, $4, $5, $6) as r',
  evFinish: 'select public.quotation_evidence_finish($1, $2) as r',
  accept: 'select public.quotation_accept($1, $2, $3, $4, $5) as r',
  newVersion: 'select public.quotation_new_version($1, $2, $3) as r',
  convert: 'select public.quotation_convert_to_booking($1, $2, $3) as r',
  get: 'select public.quotation_get($1) as r',
};

type Fill = { rowVersion: number; filled: string[]; skipped: Array<{ field: string; reason: string }> };
type Started = Fill & { versionId: string; versionNo: number; created: boolean; autoFill: string };
type QCreated = Fill & { quotationId: string; versionId: string; created: boolean; autoFill: string };
type FieldState = { field: string; state: string | null; filledBy: string | null; staffTouched: boolean; clearedByStaff: boolean;
  notice: { bitrixValue: string; sourceModifiedAt: string; inline: boolean } | null };
type Prefill = { available: boolean; marks: Array<{ fieldCode: string; state: string }>; unchecked?: string[];
  autoFill: { enabled: boolean; run: { mode: string; filled: string[] } | null; canFillEmpty: boolean }; fieldStates: FieldState[] };

const BOOKING_ALL = ['contacts.bookingFor', 'contacts.contactName', 'contacts.email', 'contacts.mobile', 'trip.end', 'trip.start'];
const CONTACT_TYPED = { contactName: 'Synthetic Typed Contact', mobile: '9876500077', email: 'typed@example.test', contactConfirmed: false,
  bookingFor: 'individual', payerDifferent: false, payerName: null };

const autoFill = (on = true) => owner('update public.workflow_settings set prefill_auto_fill = $1 where id', [on]);
const readSwitch = (on = true) => owner('update public.integration_intake_config set bitrix_trip_facts_read = $2 where id = $1', [SYNTHETIC_INTAKE_CONFIG, on]);
const snapshotAt = (deal: string, interval: string) =>
  owner(`update public.deal_source_trip_facts set source_modified_at = now() - $2::interval where deal_id = $1`, [deal, interval]);

let nextDealId = 970001;
/** An imported Deal with a stored Bitrix snapshot (contact, company, Customer Type B2D), read switch on. */
async function dealWithFacts(opts: { phone?: string; start?: string; end?: string; age?: string } = {}) {
  await h.setSwitch('service_items_enabled', true);
  await readSwitch();
  const deal = await h.insertRealDeal('UC_AD0SLH', 0, nextDealId++);
  await owner(
    `insert into public.deal_source_trip_facts (deal_id, legal_entity_id, booking_notes, traveller_total, tour_start, tour_end,
       customer_type_enum_id, source_contact_id, source_company_id, source_modified_at)
     select d.id, d.legal_entity_id, 'Synthetic notes: sea view please', 4, $2::date, $3::date, '3045', 501, 601, now() - $4::interval
     from public.deals d where d.id = $1`, [deal, opts.start ?? '2026-12-10', opts.end ?? '2026-12-14', opts.age ?? '2 days']);
  await owner(
    `insert into public.bitrix_party_snapshots (legal_entity_id, source_portal, party_kind, source_party_id, display_name, phones, emails)
     select d.legal_entity_id, 'SYNTHETIC_MEMBER_0001', k.kind, k.id, k.name, k.phones, k.emails
     from public.deals d,
          (values ('contact', 501::bigint, 'Synthetic Bitrix Contact', array[$2]::text[], array['bitrix.contact@example.test']::text[]),
                  ('company', 601::bigint, 'Synthetic Bitrix Company', array[]::text[], array[]::text[])) as k(kind, id, name, phones, emails)
     where d.id = $1
     on conflict (source_portal, party_kind, source_party_id) do update set phones = excluded.phones, emails = excluded.emails`,
    [deal, opts.phone ?? '+91 98765 00033']);
  return deal;
}
const form = async (actor: Actor, deal: string) => (await h.run<{ r: Record<string, unknown> | null }>(actor, FORM, [deal]))[0]!.r;
const prefillOf = async (deal: string) => (await form(OWNER, deal))!.prefill as Prefill;
const qGet = (versionId: string) => one<{ prefill: Prefill; contacts: Record<string, unknown> | null; requirementsNote: string | null }>(OWNER, Q.get, [versionId]);
const stateOf = (p: Prefill, field: string) => p.fieldStates.find((s) => s.field === field)!;
const markOf = (p: Prefill, field: string) => p.marks.find((m) => m.fieldCode === field)?.state ?? null;
const contactsRow = (versionId: string) =>
  owner<{ contact_name: string; mobile: string | null; email: string | null; contact_confirmed: boolean; confirmed_by: string | null; booking_for: string }>(
    'select contact_name, mobile, email, contact_confirmed, confirmed_by, booking_for from public.booking_version_contacts where booking_version_id = $1', [versionId]);
const rowVersion = async (versionId: string) =>
  (await owner<{ row_version: number }>('select row_version from public.booking_versions where id = $1', [versionId]))[0]!.row_version;
const counts = async () => (await owner<Record<string, string>>(
  `select (select count(*) from public.audit_events)::text as audit, (select count(*) from public.prefill_marks)::text as marks,
          (select count(*) from public.prefill_field_history)::text as hist, (select count(*) from public.prefill_fill_runs)::text as runs,
          (select string_agg(state, ',' order by id) from public.prefill_marks)::text as states,
          (select string_agg(row_version::text, ',' order by id) from public.booking_versions)::text as brv,
          (select string_agg(row_version::text, ',' order by id) from public.quotation_versions)::text as qrv`))[0];

/** Pretend the target was created before history started and has no history (F.1.2). */
async function makeOlder(targetId: string): Promise<void> {
  await db.exec('alter table public.prefill_field_history disable trigger prefill_field_history_a_guard');
  await owner('delete from public.prefill_field_history where target_id = $1', [targetId]);
  await db.exec('alter table public.prefill_field_history enable trigger prefill_field_history_a_guard');
  await owner(`update public.prefill_history_settings set started_at = now() + interval '1 hour' where id`);
}

async function startDraft(deal: string, actor: Actor = OWNER) {
  return one<Started>(actor, START, [deal]);
}

// ---------------------------------------------------------------------------
// Quotation flow helpers (as in b12-quotations.test.ts)
// ---------------------------------------------------------------------------
const TRIP_FIELDS = { destination: 'Synthetic City', scope: 'domestic', start: '2026-12-20', end: '2026-12-23', adults: 2 };
const Q_CONTACT = { contactName: 'Synthetic Quote Contact', mobile: '9876500022', email: null, companyName: null };
/** Trip, contact, two items, prices, ready and sent (staff saves). */
/** Trip, contact, two items, prices and "mark ready" (staff saves). */
async function readyVersion(versionId: string, rowVersion: number) {
  let rv = (await one<{ rowVersion: number }>(OWNER, Q.save, [versionId, rowVersion, JSON.stringify(TRIP_FIELDS)])).rowVersion;
  rv = (await one<{ rowVersion: number }>(OWNER, Q.contacts, [versionId, rv, JSON.stringify(Q_CONTACT)])).rowVersion;
  rv = (await one<{ rowVersion: number }>(OWNER, Q.itemAdd, [versionId, rv, 'hotel', 'quoted', JSON.stringify(HOTEL)])).rowVersion;
  rv = (await one<{ rowVersion: number }>(OWNER, Q.itemAdd, [versionId, rv, 'transfer', null, JSON.stringify(TRANSFER)])).rowVersion;
  rv = await priceQuotationVersion(one, owner, OWNER, versionId, rv);
  return one<{ contentHash: string; rowVersion: number; status: string }>(OWNER, Q.ready, [versionId, rv]);
}
async function sendVersion(versionId: string, rowVersion: number) {
  const ready = await readyVersion(versionId, rowVersion);
  await one(OWNER, Q.sent, [versionId, ready.contentHash, 'whatsapp', rid()]);
  return ready;
}
async function acceptedQuote(deal: string) {
  const q = await one<QCreated>(OWNER, Q.create, ['deal', deal, 'Synthetic quotation', rid()]);
  const ready = await sendVersion(q.versionId, q.rowVersion);
  const ev = await one<{ evidenceId: string; objectPath: string }>(OWNER, Q.evBegin, [q.versionId, 'acceptance_message', 'acceptance.pdf', 'application/pdf', 2048, 'f'.repeat(64)]);
  await owner(`insert into storage.objects (bucket_id, name, metadata) values ('quotation-evidence', $1, jsonb_build_object('size', 2048::bigint))`, [ev.objectPath]);
  await one(OWNER, Q.evFinish, [ev.evidenceId, true]);
  await one(OWNER, Q.accept, [q.versionId, ready.contentHash, ev.evidenceId, 'quoted', rid()]);
  return { ...q, hash: ready.contentHash };
}

// ===========================================================================
describe('switch and settings', () => {
  it('prefill_auto_fill is off by default, audited, settable by the switch command and read by workflow_settings_get', async () => {
    await asOwner(db, async () => {
      expect(await owner('select prefill_auto_fill from public.workflow_settings')).toEqual([{ prefill_auto_fill: false }]);
      expect(await one(SUPER, 'select public.workflow_settings_get() as r')).toMatchObject({ prefillAutoFill: false });
      const r = await one(SUPER, 'select public.admin_set_workflow_setting($1, $2, $3) as r', ['prefill_auto_fill', true, REASON]);
      expect(r).toMatchObject({ key: 'prefill_auto_fill', changed: true, before: false, after: true });
      expect(await one(OWNER, 'select public.workflow_settings_get() as r')).toMatchObject({ prefillAutoFill: true });
      const audit = await owner<{ details: { changes?: Record<string, unknown> } }>(
        `select details from public.audit_events where action = 'settings.workflow_changed' order by id desc limit 1`);
      expect(JSON.stringify(audit[0]!.details)).toContain('prefill_auto_fill');
      // Every column audited before is still audited (F.6 N1).
      for (const key of ['intake_prompt_enabled', 'service_items_enabled', 'visa_passport_tasks_enabled']) {
        await owner(`update public.workflow_settings set ${key} = not ${key} where id`);
        const [row] = await owner<{ details: unknown }>(`select details from public.audit_events where action = 'settings.workflow_changed' order by id desc limit 1`);
        expect(JSON.stringify(row!.details), key).toContain(key);
      }
      await refused(OWNER, 'select public.admin_set_workflow_setting($1, $2, $3) as r', ['prefill_auto_fill', false, REASON], '42501', 'not_authorized');
      await refused(SUPER, 'select public.admin_set_workflow_setting($1, $2, $3) as r', ['prefill_auto_fil', false, REASON], '22023', 'invalid_input');
    });
  });

  it('internal helpers, the history and run tables are not reachable through the API; new commands are for authenticated only', async () => {
    await asOwner(db, async () => {
      for (const t of ['prefill_field_history', 'prefill_fill_runs', 'prefill_notice_dismissals', 'prefill_history_settings']) {
        const [r] = await owner<{ rls: boolean; auth: boolean; svc: boolean }>(
          `select c.relrowsecurity as rls, has_table_privilege('authenticated', c.oid, 'select') as auth,
                  has_table_privilege('service_role', c.oid, 'select') as svc from pg_class c where c.oid = ('public.' || $1)::regclass`, [t]);
        expect(r, t).toEqual({ rls: true, auth: false, svc: false });
      }
      for (const fn of ['authz.prefill_fill(text, uuid, text)', 'authz.prefill_field_untouched(text, uuid, text)',
        'authz.prefill_field_block(text, uuid, text, boolean)', 'authz.prefill_fill_on_create(text, uuid)',
        'authz.prefill_history_note(uuid, text, uuid, text, text, text, boolean)', 'authz.prefill_mark_kept(text, uuid, text[])']) {
        const [r] = await owner<{ a: boolean; n: boolean; s: boolean }>(
          `select has_function_privilege('authenticated', $1, 'execute') as a, has_function_privilege('anon', $1, 'execute') as n,
                  has_function_privilege('service_role', $1, 'execute') as s`, [fn]);
        expect(r, fn).toEqual({ a: false, n: false, s: false });
      }
      for (const fn of ['public.booking_start_draft(uuid)', 'public.prefill_fill_empty(text, uuid, integer)',
        'public.prefill_notice_dismiss(text, uuid, integer, text, timestamp with time zone)']) {
        const [r] = await owner<{ a: boolean; n: boolean }>(
          `select has_function_privilege('authenticated', $1, 'execute') as a, has_function_privilege('anon', $1, 'execute') as n`, [fn]);
        expect(r, fn).toEqual({ a: true, n: false });
      }
      // F.1.4 test 9: no value-bearing column.
      const cols = (await owner<{ c: string }>(
        `select column_name as c from information_schema.columns where table_schema = 'public'
           and table_name in ('prefill_field_history', 'prefill_fill_runs', 'prefill_notice_dismissals')`)).map((r) => r.c);
      expect(cols.filter((c) => /value|hash|name|mobile|email|note/.test(c))).toEqual([]);
    });
  });
});

// ===========================================================================
describe('switch off: today\'s behaviour (lead ruling 20 Oct)', () => {
  it('Start booking fills nothing; saves write no kept; the contact tick leaves marks; today\'s apply refills a cleared field', async () => {
    await asOwner(db, async () => {
      const deal = await dealWithFacts();
      const s = await startDraft(deal);
      expect(s).toMatchObject({ created: true, autoFill: 'off', filled: [], skipped: [] });
      expect(await h.count(`select 1 from public.prefill_marks where target_id = $1`, [s.versionId])).toBe(0);
      expect(await h.count(`select 1 from public.audit_events where action = 'booking.prefill_auto_filled'`)).toBe(0);
      // Today's "Use Bitrix values", then the staff clear the e-mail, then "Use Bitrix value" again: refilled as today.
      let r = await one<Fill & { applied: string[] }>(OWNER, APPLY, [s.versionId, s.rowVersion, ['contacts.contactName', 'contacts.mobile', 'contacts.email']]);
      let rv = (await h.saveContacts(OWNER, s.versionId, r.rowVersion, { ...CONTACT_TYPED, contactName: 'Synthetic Bitrix Contact', mobile: '9876500033', email: null })).rowVersion;
      expect(markOf(await prefillOf(deal), 'contacts.contactName')).toBe('from_bitrix'); // no kept while off
      expect(markOf(await prefillOf(deal), 'contacts.email')).toBe('changed');
      r = await one(OWNER, APPLY, [s.versionId, rv, ['contacts.email']]);
      expect(r.applied).toEqual(['contacts.email']);
      expect(r.skipped).toEqual([]);
      expect((await contactsRow(s.versionId))[0]!.email).toBe('bitrix.contact@example.test');
      // The contact tick does not touch marks while off.
      rv = (await h.saveContacts(OWNER, s.versionId, r.rowVersion, { ...CONTACT_TYPED, contactName: 'Synthetic Bitrix Contact', mobile: '9876500033',
        email: 'bitrix.contact@example.test', contactConfirmed: true })).rowVersion;
      const p = await prefillOf(deal);
      expect(markOf(p, 'contacts.mobile')).toBe('from_bitrix');
      expect(p.autoFill).toMatchObject({ enabled: false, run: null });
      // "Use it" on the name keeps today's rule while off: confirmation cleared.
      await one(OWNER, APPLY, [s.versionId, rv, ['contacts.contactName']]);
      expect((await contactsRow(s.versionId))[0]!.contact_confirmed).toBe(false);
      // quotation_create fills nothing while off.
      const q = await one<QCreated>(OWNER, Q.create, ['deal', deal, 'Synthetic off quote', rid()]);
      expect(q).toMatchObject({ created: true, autoFill: 'off', filled: [] });
      // Lead ruling Q2: "Fill empty fields from Bitrix" does not exist while off (after authorization and the version check).
      const rvNow = await rowVersion(s.versionId);
      await refused(PURCHASE, FILL, ['booking_version', s.versionId, rvNow], '42501', 'not_authorized');
      await refused(OWNER, FILL, ['booking_version', s.versionId, 1], '40001', 'version_changed');
      await refused(OWNER, FILL, ['booking_version', s.versionId, rvNow], '55000', 'switch_off');
      await refused(OWNER, FILL, ['quotation_version', q.versionId, q.rowVersion], '55000', 'switch_off');
      expect((await prefillOf(deal)).autoFill.canFillEmpty).toBe(false);
      expect(await rowVersion(s.versionId)).toBe(rvNow);
    });
  });
});

// ===========================================================================
describe('creation fill (C1, C2)', () => {
  it('A.11-1: Start booking fills dates, contact and booking-for once; contact unconfirmed; marks auto_fill; one audit row with codes only', async () => {
    await asOwner(db, async () => {
      await autoFill();
      const deal = await dealWithFacts();
      const s = await startDraft(deal);
      expect(s).toMatchObject({ created: true, autoFill: 'filled', skipped: [] });
      expect(s.filled).toEqual(BOOKING_ALL);
      expect(s.rowVersion).toBe(await rowVersion(s.versionId));
      expect(await owner('select trip_start::text as s, trip_end::text as e from public.booking_versions where id = $1', [s.versionId]))
        .toEqual([{ s: '2026-12-10', e: '2026-12-14' }]);
      expect((await contactsRow(s.versionId))[0]).toMatchObject({ contact_name: 'Synthetic Bitrix Contact', mobile: '9876500033',
        email: 'bitrix.contact@example.test', contact_confirmed: false, confirmed_by: null, booking_for: 'business' });
      const p = await prefillOf(deal);
      expect(p.marks.map((m) => m.state)).toEqual(Array(6).fill('from_bitrix'));
      expect(p.fieldStates.every((f) => f.filledBy === 'auto_fill' && !f.staffTouched && f.notice === null)).toBe(true);
      expect(p.autoFill).toMatchObject({ enabled: true, run: { mode: 'create', filled: BOOKING_ALL }, canFillEmpty: false });
      const audits = await owner<{ details: Record<string, unknown> }>(`select details from public.audit_events where action = 'booking.prefill_auto_filled'`);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.details).toMatchObject({ versionId: s.versionId, fields: BOOKING_ALL });
      expect(JSON.stringify(audits)).not.toMatch(/Synthetic Bitrix|9876500033|bitrix\.contact|sea view|2026-12-1/);
      // No staff history: the fill is not a staff write.
      expect(await h.count('select 1 from public.prefill_field_history where target_id = $1', [s.versionId])).toBe(0);
      const list = await one<{ items: Array<{ code: string; blocking: boolean; fields?: string[] }> }>(OWNER, CHECKLIST_SQL, [deal]);
      expect(list.items.find((i) => i.code === 'contact_not_confirmed')).toMatchObject({ blocking: true });
      expect(list.items.find((i) => i.code === 'prefill_unchecked')).toMatchObject({ blocking: false });
      expect(list.items.find((i) => i.code === 'billing_missing')).toMatchObject({ blocking: true }); // billing never filled
      expect(await h.count('select 1 from public.customer_billing_profiles where deal_id = $1', [deal])).toBe(0);
    });
  });

  it('A.11-2/3/4: read switch off or no snapshot fills nothing; reopening fills nothing; an accepted quotation blocks the fill', async () => {
    await asOwner(db, async () => {
      await autoFill();
      const deal = await dealWithFacts();
      await readSwitch(false);
      const s = await startDraft(deal);
      expect(s).toMatchObject({ autoFill: 'unavailable', filled: [] });
      expect(await h.count(`select 1 from public.prefill_fill_runs`)).toBe(0);
      expect(await h.count(`select 1 from public.audit_events where action = 'booking.prefill_auto_filled'`)).toBe(0);
      await readSwitch(true);
      const again = await startDraft(deal);
      expect(again).toMatchObject({ versionId: s.versionId, created: false, autoFill: 'existing_draft', filled: [] });
      expect(await h.count(`select 1 from public.prefill_marks where target_id = $1`, [s.versionId])).toBe(0);
    });
    await asOwner(db, async () => {
      await autoFill();
      const deal = await dealWithFacts();
      await acceptedQuote(deal);
      const s = await startDraft(deal);
      expect(s).toMatchObject({ created: true, autoFill: 'accepted_quotation', filled: [] });
    });
  });

  it('A.11-6: quotation_create fills a Deal quotation (notes for price scope) and a Lead quotation (no dates or notes); a replay fills nothing', async () => {
    await asOwner(db, async () => {
      await autoFill();
      const deal = await dealWithFacts();
      const reqId = rid();
      const q = await one<QCreated>(OWNER, Q.create, ['deal', deal, 'Synthetic auto quote', reqId]);
      expect(q.autoFill).toBe('filled');
      expect(q.filled).toEqual(['contacts.bookingFor', 'contacts.companyName', 'contacts.contactName', 'contacts.email', 'contacts.mobile',
        'requirementsNote', 'trip.end', 'trip.start']);
      const got = await qGet(q.versionId);
      expect(got.requirementsNote).toBe('Synthetic notes: sea view please');
      expect(got.contacts).toMatchObject({ contactName: 'Synthetic Bitrix Contact', companyName: 'Synthetic Bitrix Company', bookingFor: 'business' });
      expect(got.prefill.unchecked).toHaveLength(8);
      const replay = await one<QCreated>(OWNER, Q.create, ['deal', deal, 'Synthetic auto quote', reqId]);
      expect(replay).toMatchObject({ created: false, autoFill: 'existing_draft', filled: [] });
      expect(await h.count(`select 1 from public.audit_events where action = 'quotation.prefill_auto_filled'`)).toBe(1);
      // Without price scope the notes are skipped not_allowed (E5-3 / lead decision A2).
      await owner(`delete from public.role_permissions where role_code = 'sales' and permission_code = 'deal.read_commercial'`);
      const q2 = await one<QCreated>(OWNER, Q.create, ['deal', deal, 'Synthetic auto quote 2', rid()]);
      expect(q2.skipped).toEqual(expect.arrayContaining([{ field: 'requirementsNote', reason: 'not_allowed' }]));
    });
    await asOwner(db, async () => {
      await autoFill();
      await readSwitch();
      const [inbox] = await owner<{ id: string }>(
        `insert into public.integration_inbox (portal_member_id, event_type, source_deal_id, source_ts, dedupe_key, status, processed_at)
         values ('SYNTHETIC_MEMBER_0001', 'ONCRMDEALADD', 880101, 1, repeat('e', 58) || '880101', 'processed', now()) returning id`);
      const [lead] = await owner<{ id: string }>(
        `insert into public.crm_leads (legal_entity_id, branch_id, reference, title, owner_user_id, source_portal, source_lead_id,
           source_status_id, source_id_code, source_created_at, source_modified_at, last_synced_at, last_verified_at, intake_inbox_id,
           manifest_id, intake_mode)
         select b.legal_entity_id, b.id, 'BXL-880101', 'Synthetic lead', $1, 'SYNTHETIC_MEMBER_0001', 880101, 'NEW', 'WEBFORM',
                now(), now(), now(), now(), $2, null, 'scope'
         from public.branches b join public.legal_entities e on e.id = b.legal_entity_id where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL'
         returning id`, [U.salesDelhiA, inbox!.id]);
      await owner(
        `insert into public.bitrix_party_snapshots (legal_entity_id, source_portal, party_kind, source_party_id, display_name, phones, emails)
         select l.legal_entity_id, 'SYNTHETIC_MEMBER_0001', 'contact', 502, 'Synthetic Lead Contact', array['9876500044'], array[]::text[]
         from public.crm_leads l where l.id = $1 on conflict do nothing`, [lead!.id]);
      await owner(`insert into public.lead_source_facts (lead_id, legal_entity_id, customer_type_enum_id, company_title, source_contact_id, source_modified_at)
                   select l.id, l.legal_entity_id, '5053', 'Synthetic Lead Company', 502, now() from public.crm_leads l where l.id = $1`, [lead!.id]);
      const q = await one<QCreated>(OWNER, Q.create, ['lead', lead!.id, 'Synthetic lead quote', rid()]);
      expect(q.filled).toEqual(['contacts.bookingFor', 'contacts.companyName', 'contacts.contactName', 'contacts.mobile']);
      expect(q.skipped).toEqual(expect.arrayContaining([{ field: 'trip.start', reason: 'no_value' }, { field: 'trip.end', reason: 'no_value' },
        { field: 'requirementsNote', reason: 'no_value' }, { field: 'contacts.email', reason: 'no_value' }]));
    });
  });

  it('A.11-12: unusable values are skipped with reasons; the traveller total fills nothing', async () => {
    await asOwner(db, async () => {
      await autoFill();
      const deal = await dealWithFacts({ phone: '12345', start: '2026-12-20', end: '2026-12-14' });
      const s = await startDraft(deal);
      expect(s.skipped).toEqual(expect.arrayContaining([{ field: 'contacts.mobile', reason: 'mobile_format' },
        { field: 'trip.start', reason: 'date_order' }, { field: 'trip.end', reason: 'date_order' }]));
      expect(s.filled).toEqual(['contacts.bookingFor', 'contacts.contactName', 'contacts.email']);
      expect(await h.count('select 1 from public.deal_travellers where deal_id = $1', [deal])).toBe(0);
    });
  });

  it('A.11-8 / F.2-10: reads never write (booking_form_get, intake_checklist, quotation_get)', async () => {
    await asOwner(db, async () => {
      await autoFill();
      const deal = await dealWithFacts();
      const s = await startDraft(deal);
      const q = await one<QCreated>(OWNER, Q.create, ['deal', deal, 'Synthetic quote', rid()]);
      await snapshotAt(deal, '1 hour'); // a newer snapshot: notices computed on read only
      const before = await counts();
      for (let i = 0; i < 2; i++) {
        await form(OWNER, deal);
        await one(OWNER, CHECKLIST_SQL, [deal]);
        await qGet(q.versionId);
      }
      expect(await counts()).toEqual(before);
      expect(s.versionId).toBeTruthy();
    });
  });
});

// ===========================================================================
describe('clearing is never undone (F.1)', () => {
  it('A.11-7 / F.1.4-4: an automatic e-mail cleared by staff stays empty through reads, C3, a replay and a newer snapshot; Use it skips it', async () => {
    await asOwner(db, async () => {
      await autoFill();
      const deal = await dealWithFacts();
      const s = await startDraft(deal);
      let rv = (await h.saveContacts(OWNER, s.versionId, s.rowVersion, { ...CONTACT_TYPED, contactName: 'Synthetic Bitrix Contact', mobile: '9876500033', email: null,
        bookingFor: 'business' })).rowVersion;
      await form(OWNER, deal);
      const fill = await one<Fill>(OWNER, FILL, ['booking_version', s.versionId, rv]);
      expect(fill.filled).toEqual([]);
      expect(fill.skipped).toEqual([{ field: 'contacts.email', reason: 'cleared_by_staff' }]);
      rv = fill.rowVersion;
      await startDraft(deal);
      await snapshotAt(deal, '1 minute');
      const p = await prefillOf(deal);
      expect(stateOf(p, 'contacts.email')).toMatchObject({ clearedByStaff: true, notice: null, state: 'changed' });
      const use = await one<Fill & { applied: string[] }>(OWNER, APPLY, [s.versionId, rv, ['contacts.email']]);
      expect(use.applied).toEqual([]);
      expect(use.skipped).toEqual([{ field: 'contacts.email', reason: 'cleared_by_staff' }]);
      expect((await contactsRow(s.versionId))[0]!.email).toBeNull();
    });
  });

  it('F.1.4-5/13: a typed-then-cleared mobile with no mark is skipped; rewriting an unchanged value writes no history', async () => {
    await asOwner(db, async () => {
      await autoFill();
      const deal = await dealWithFacts();
      const s = await startDraft(deal);
      // Remove the automatic contact first: staff type their own contact, then clear the mobile.
      let rv = (await h.saveContacts(OWNER, s.versionId, s.rowVersion, CONTACT_TYPED)).rowVersion;
      const hist1 = await h.count('select 1 from public.prefill_field_history where target_id = $1', [s.versionId]);
      rv = (await h.saveContacts(OWNER, s.versionId, rv, CONTACT_TYPED)).rowVersion; // unchanged rewrite
      expect(await h.count('select 1 from public.prefill_field_history where target_id = $1', [s.versionId])).toBe(hist1);
      rv = (await h.saveContacts(OWNER, s.versionId, rv, { ...CONTACT_TYPED, mobile: null })).rowVersion;
      await owner(`delete from public.prefill_marks where target_id = $1 and field_code = 'contacts.mobile'`, [s.versionId]);
      const fill = await one<Fill>(OWNER, FILL, ['booking_version', s.versionId, rv]);
      expect(fill.skipped).toEqual([{ field: 'contacts.mobile', reason: 'cleared_by_staff' }]);
      expect((await contactsRow(s.versionId))[0]!.mobile).toBeNull();
    });
  });

  it('F.1.4-1/2: older booking draft: manual-then-cleared e-mail is not provable; untouched contacts are filled; a saved trip group is skipped', async () => {
    await asOwner(db, async () => {
      const deal = await dealWithFacts();
      const opened = await h.openDraft(OWNER, deal);
      let rv = (await h.saveContacts(OWNER, opened.versionId, opened.rowVersion, CONTACT_TYPED)).rowVersion;
      rv = (await h.saveContacts(OWNER, opened.versionId, rv, { ...CONTACT_TYPED, email: null })).rowVersion;
      await makeOlder(opened.versionId);
      await autoFill();
      const fill = await one<Fill>(OWNER, FILL, ['booking_version', opened.versionId, rv]);
      expect(fill.skipped).toEqual([{ field: 'contacts.email', reason: 'not_provable' }]);
      expect(fill.filled).toEqual(['trip.end', 'trip.start']); // trip never saved: proved untouched
      await form(OWNER, deal);
      await snapshotAt(deal, '1 minute');
      const again = await one<Fill>(OWNER, FILL, ['booking_version', opened.versionId, fill.rowVersion]);
      expect(again.skipped).toEqual([{ field: 'contacts.email', reason: 'not_provable' }]);
      expect((await contactsRow(opened.versionId))[0]!.email).toBeNull();
    });
    await asOwner(db, async () => {
      const deal = await dealWithFacts();
      const opened = await h.openDraft(OWNER, deal);
      const rv = (await h.saveTrip(OWNER, opened.versionId, opened.rowVersion, { destination: 'X', scope: 'domestic', start: null, end: null })).rowVersion;
      await makeOlder(opened.versionId);
      await autoFill();
      const fill = await one<Fill>(OWNER, FILL, ['booking_version', opened.versionId, rv]);
      expect(fill.filled).toEqual(['contacts.bookingFor', 'contacts.contactName', 'contacts.email', 'contacts.mobile']);
      expect(fill.skipped).toEqual(expect.arrayContaining([{ field: 'trip.start', reason: 'not_provable' }, { field: 'trip.end', reason: 'not_provable' }]));
      expect((await contactsRow(opened.versionId))[0]!.contact_confirmed).toBe(false);
    });
  });

  it('F.1.4-3: older quotation version through the real quotation_version_save: start not provable, end filled; a contacts save excludes all contacts', async () => {
    await asOwner(db, async () => {
      const deal = await dealWithFacts();
      const q = await one<QCreated>(OWNER, Q.create, ['deal', deal, 'Synthetic older quote', rid()]);
      let rv = (await one<{ rowVersion: number }>(OWNER, Q.save, [q.versionId, q.rowVersion, JSON.stringify({ start: '2026-12-01' })])).rowVersion;
      rv = (await one<{ rowVersion: number }>(OWNER, Q.save, [q.versionId, rv, JSON.stringify({ start: null })])).rowVersion;
      rv = (await one<{ rowVersion: number }>(OWNER, Q.contacts, [q.versionId, rv, JSON.stringify(Q_CONTACT)])).rowVersion;
      await makeOlder(q.versionId);
      await autoFill();
      const fill = await one<Fill>(OWNER, FILL, ['quotation_version', q.versionId, rv]);
      expect(fill.filled).toEqual(['requirementsNote', 'trip.end']);
      expect(fill.skipped).toEqual(expect.arrayContaining([{ field: 'trip.start', reason: 'not_provable' },
        { field: 'contacts.email', reason: 'not_provable' }, { field: 'contacts.bookingFor', reason: 'not_provable' }]));
    });
  });

  it('F.1.4-7: a new quotation version inherits the value-free history; C3 skips the field cleared in the earlier version', async () => {
    await asOwner(db, async () => {
      await autoFill();
      const deal = await dealWithFacts();
      const q = await one<QCreated>(OWNER, Q.create, ['deal', deal, 'Synthetic v1', rid()]);
      expect(q.filled).toContain('requirementsNote');
      const rv = (await one<{ rowVersion: number }>(OWNER, Q.save, [q.versionId, q.rowVersion, JSON.stringify({ requirementsNote: null })])).rowVersion;
      const s = await sendVersion(q.versionId, rv);
      expect(s.contentHash).toBeTruthy();
      const nv = await one<{ versionId: string; rowVersion: number; created: boolean }>(OWNER, Q.newVersion, [q.quotationId, q.versionId, rid()]);
      expect(nv.created).toBe(true);
      expect(await h.count(`select 1 from public.prefill_field_history where target_id = $1 and field_code = 'requirementsNote' and cleared_at is not null`,
        [nv.versionId])).toBe(1);
      expect(await h.count(`select 1 from public.prefill_field_history where target_id = $1 and field_code = 'trip.start' and last_staff_write_at is not null`,
        [nv.versionId])).toBe(1); // copied non-empty values are staff writes
      const fill = await one<Fill>(OWNER, FILL, ['quotation_version', nv.versionId, nv.rowVersion]);
      expect(fill.filled).toEqual([]);
      // The e-mail and company were cleared by the staff contact save in version 1 too.
      expect([...fill.skipped].sort((x, y) => x.field.localeCompare(y.field))).toEqual([{ field: 'contacts.companyName', reason: 'cleared_by_staff' },
        { field: 'contacts.email', reason: 'cleared_by_staff' }, { field: 'requirementsNote', reason: 'cleared_by_staff' }]);
      const use = await one<Fill & { applied: string[] }>(OWNER, Q_APPLY, [nv.versionId, fill.rowVersion, ['requirementsNote', 'contacts.mobile']]);
      expect(use.applied).toEqual(['contacts.mobile']);
      expect(use.skipped).toEqual([{ field: 'requirementsNote', reason: 'cleared_by_staff' }]);
    });
  });
});

// ===========================================================================
describe('"Use it" and "Keep mine" (A.5, F.1.3, F.6 N3/N4)', () => {
  it('A.11-9: a newer snapshot shows one inline notice; Keep mine hides it until the next change; Use it applies with version protection', async () => {
    await asOwner(db, async () => {
      await autoFill();
      const deal = await dealWithFacts({ age: '3 days' });
      const s = await startDraft(deal);
      await owner(`update public.deal_source_trip_facts set tour_end = '2026-12-16', source_modified_at = now() - interval '1 day' where deal_id = $1`, [deal]);
      let p = await prefillOf(deal);
      expect(p.fieldStates.filter((f) => f.notice).map((f) => f.field)).toEqual(['trip.end']);
      const n = stateOf(p, 'trip.end').notice!;
      expect(n).toMatchObject({ bitrixValue: '2026-12-16', inline: true });
      expect(await owner('select trip_end::text as e from public.booking_versions where id = $1', [s.versionId])).toEqual([{ e: '2026-12-14' }]);
      await one(OWNER, DISMISS, ['booking_version', s.versionId, s.rowVersion, 'trip.end', n.sourceModifiedAt]);
      expect(stateOf(await prefillOf(deal), 'trip.end').notice).toBeNull();
      expect(await rowVersion(s.versionId)).toBe(s.rowVersion); // no bump
      await owner(`update public.deal_source_trip_facts set tour_end = '2026-12-17', source_modified_at = now() - interval '1 hour' where deal_id = $1`, [deal]);
      p = await prefillOf(deal);
      expect(stateOf(p, 'trip.end').notice).toMatchObject({ bitrixValue: '2026-12-17' });
      await refused(OWNER, APPLY, [s.versionId, s.rowVersion - 1, ['trip.end']], '40001', 'version_changed');
      const use = await one<Fill & { applied: string[] }>(OWNER, APPLY, [s.versionId, s.rowVersion, ['trip.end']]);
      expect(use.applied).toEqual(['trip.end']);
      p = await prefillOf(deal);
      expect(stateOf(p, 'trip.end')).toMatchObject({ state: 'from_bitrix', notice: null });
      await refused(OWNER, DISMISS, ['booking_version', s.versionId, use.rowVersion, 'contacts.companyName', n.sourceModifiedAt], '22023', 'invalid_input');
      for (const actor of [PURCHASE, ACCOUNTS, FLIGHT, SUPER, SALES_B]) {
        await refused(actor, DISMISS, ['booking_version', s.versionId, use.rowVersion, 'trip.end', n.sourceModifiedAt], '42501', 'not_authorized');
      }
    });
  });

  it('F.1.4-12 / F.2-9: Use it after checked and after changed re-arms from_bitrix; type-clear-type-clear then refused; re-typed works', async () => {
    await asOwner(db, async () => {
      await autoFill();
      const deal = await dealWithFacts();
      const s = await startDraft(deal);
      await one(OWNER, CHECK, ['booking_version', s.versionId, s.rowVersion, ['trip.start']]);
      let r = await one<Fill & { applied: string[] }>(OWNER, APPLY, [s.versionId, s.rowVersion, ['trip.start']]);
      expect(r.applied).toEqual(['trip.start']);
      expect(markOf(await prefillOf(deal), 'trip.start')).toBe('from_bitrix');
      let rv = (await h.saveTrip(OWNER, s.versionId, r.rowVersion, { destination: null, scope: null, start: '2026-12-11', end: '2026-12-14' })).rowVersion;
      expect(markOf(await prefillOf(deal), 'trip.start')).toBe('changed');
      r = await one(OWNER, APPLY, [s.versionId, rv, ['trip.start']]);
      expect(r.applied).toEqual(['trip.start']);
      rv = r.rowVersion;
      for (const start of [null, '2026-12-09', null]) {
        rv = (await h.saveTrip(OWNER, s.versionId, rv, { destination: null, scope: null, start, end: '2026-12-14' })).rowVersion;
      }
      r = await one(OWNER, APPLY, [s.versionId, rv, ['trip.start']]);
      expect(r.skipped).toEqual([{ field: 'trip.start', reason: 'cleared_by_staff' }]);
      rv = (await h.saveTrip(OWNER, s.versionId, r.rowVersion, { destination: null, scope: null, start: '2026-12-08', end: '2026-12-14' })).rowVersion;
      r = await one(OWNER, APPLY, [s.versionId, rv, ['trip.start']]);
      expect(r.applied).toEqual(['trip.start']);
    });
  });

  it('BC-A5 / A.11-10: Use it on the name or booking-for keeps a confirmation; on the mobile or e-mail clears it (switch on)', async () => {
    await asOwner(db, async () => {
      await autoFill();
      const deal = await dealWithFacts();
      const s = await startDraft(deal);
      let rv = (await h.saveContacts(OWNER, s.versionId, s.rowVersion, { ...CONTACT_TYPED, contactName: 'Synthetic Other Name', mobile: '9876500033',
        email: 'bitrix.contact@example.test', bookingFor: 'business', contactConfirmed: true })).rowVersion;
      const confirmedBy = (await contactsRow(s.versionId))[0]!.confirmed_by;
      let r = await one<Fill & { applied: string[] }>(MANAGER, APPLY, [s.versionId, rv, ['contacts.contactName', 'contacts.bookingFor']]);
      expect(r.applied).toEqual(['contacts.bookingFor', 'contacts.contactName']);
      expect((await contactsRow(s.versionId))[0]).toMatchObject({ contact_confirmed: true, confirmed_by: confirmedBy });
      r = await one(OWNER, APPLY, [s.versionId, r.rowVersion, ['contacts.mobile']]);
      expect((await contactsRow(s.versionId))[0]).toMatchObject({ contact_confirmed: false, confirmed_by: null });
      rv = r.rowVersion;
      expect(rv).toBeGreaterThan(0);
    });
  });

  it('F.6 N4: Use it on a value replaced by the accepted quotation is refused accepted_quotation and shows no notice', async () => {
    await asOwner(db, async () => {
      await autoFill();
      const deal = await dealWithFacts();
      const s = await startDraft(deal);
      const acc = await acceptedQuote(deal);
      const conv = await one<{ outcome: string; bookingVersionId: string }>(OWNER, Q.convert, [acc.versionId, acc.hash, rid()]);
      expect(conv).toMatchObject({ outcome: 'created', bookingVersionId: s.versionId });
      await snapshotAt(deal, '1 minute');
      const p = await prefillOf(deal);
      expect(stateOf(p, 'trip.start')).toMatchObject({ state: 'replaced_by_quotation', notice: null });
      const rv = await rowVersion(s.versionId);
      const r = await one<Fill & { applied: string[] }>(OWNER, APPLY, [s.versionId, rv, ['trip.start', 'contacts.mobile']]);
      expect(r.applied).toEqual([]);
      expect(r.skipped).toEqual([{ field: 'contacts.mobile', reason: 'accepted_quotation' }, { field: 'trip.start', reason: 'accepted_quotation' }]);
      await refused(OWNER, FILL, ['booking_version', s.versionId, r.rowVersion], '55000', 'wrong_state');
      await db.exec('savepoint copy_hint');
      let hint: string | undefined;
      try {
        await h.run(OWNER, FILL, ['booking_version', s.versionId, r.rowVersion]);
      } catch (e) {
        hint = (e as { hint?: string }).hint;
        await db.exec('rollback to savepoint copy_hint');
      }
      expect(hint).toBe('copy');
    });
  });
});

// ===========================================================================
describe('kept and checked (F.2, BC-A8, BC-A8b)', () => {
  it('F.2-1..4/7: save unchanged -> kept (warning stays, keptFields); section check -> checked with fromKept; never downgraded; changed not upgraded', async () => {
    await asOwner(db, async () => {
      await autoFill();
      const deal = await dealWithFacts();
      const s = await startDraft(deal);
      let rv = (await h.saveTrip(OWNER, s.versionId, s.rowVersion, { destination: 'Synthetic City', scope: 'domestic', start: '2026-12-10', end: '2026-12-14' })).rowVersion;
      let p = await prefillOf(deal);
      expect([markOf(p, 'trip.start'), markOf(p, 'trip.end'), markOf(p, 'contacts.mobile')]).toEqual(['kept', 'kept', 'from_bitrix']);
      const [audit] = await owner<{ details: { keptFields: string[] } }>(`select details from public.audit_events where action = 'booking.trip_saved' order by id desc limit 1`);
      expect(audit!.details.keptFields).toEqual(['trip.end', 'trip.start']);
      let list = await one<{ items: Array<{ code: string; fields?: string[] }> }>(OWNER, CHECKLIST_SQL, [deal]);
      expect(list.items.find((i) => i.code === 'prefill_unchecked')!.fields).toEqual(expect.arrayContaining(['trip.start', 'trip.end']));
      const c = await one<{ checked: string[]; notChecked: unknown[] }>(OWNER, CHECK, ['booking_version', s.versionId, rv, ['trip.start', 'trip.end']]);
      expect(c).toEqual({ checked: ['trip.end', 'trip.start'], notChecked: [] });
      const [chk] = await owner<{ details: { fromKept: string[] } }>(`select details from public.audit_events where action = 'prefill.checked' order by id desc limit 1`);
      expect(chk!.details.fromKept).toEqual(['trip.end', 'trip.start']);
      list = await one(OWNER, CHECKLIST_SQL, [deal]);
      expect(list.items.find((i) => i.code === 'prefill_unchecked')!.fields).not.toContain('trip.start');
      rv = (await h.saveTrip(OWNER, s.versionId, rv, { destination: 'Synthetic City', scope: 'domestic', start: '2026-12-10', end: '2026-12-15' })).rowVersion;
      p = await prefillOf(deal);
      expect([markOf(p, 'trip.start'), markOf(p, 'trip.end')]).toEqual(['checked', 'changed']);
      const again = await one<{ checked: string[]; notChecked: Array<{ field: string; state: string | null }> }>(OWNER, CHECK,
        ['booking_version', s.versionId, rv, ['trip.end', 'trip.start']]);
      expect(again).toEqual({ checked: [], notChecked: [{ field: 'trip.end', state: 'changed' }, { field: 'trip.start', state: 'checked' }] });
    });
  });

  it('F.2-5/6 BC-A8b: the tick checks mobile and e-mail; in the same save a changed mobile stays changed; name kept; trip untouched', async () => {
    await asOwner(db, async () => {
      await autoFill();
      const deal = await dealWithFacts();
      const s = await startDraft(deal);
      const rv = (await h.saveContacts(OWNER, s.versionId, s.rowVersion, { contactName: 'Synthetic Bitrix Contact', mobile: '9876500099',
        email: 'bitrix.contact@example.test', contactConfirmed: true, bookingFor: 'business', payerDifferent: false, payerName: null })).rowVersion;
      const p = await prefillOf(deal);
      expect([markOf(p, 'contacts.mobile'), markOf(p, 'contacts.email'), markOf(p, 'contacts.contactName'), markOf(p, 'contacts.bookingFor'),
        markOf(p, 'trip.start')]).toEqual(['changed', 'checked', 'kept', 'kept', 'from_bitrix']);
      const [audit] = await owner<{ details: { via: string; fields: string[] } }>(
        `select details from public.audit_events where action = 'prefill.checked' order by id desc limit 1`);
      expect(audit!.details).toMatchObject({ via: 'contact_confirmation', fields: ['contacts.email'] });
      expect(rv).toBeGreaterThan(s.rowVersion);
    });
    await asOwner(db, async () => {
      await autoFill();
      const deal = await dealWithFacts();
      const s = await startDraft(deal);
      await one(OWNER, 'select public.booking_customer_save($1, $2, $3::jsonb, null, null, null) as r', [s.versionId, s.rowVersion,
        JSON.stringify({ contactName: 'Synthetic Bitrix Contact', mobile: '9876500033', email: 'bitrix.contact@example.test', contactConfirmed: true,
          bookingFor: 'business', payerDifferent: false, payerName: null })]);
      const p = await prefillOf(deal);
      expect([markOf(p, 'contacts.mobile'), markOf(p, 'contacts.email'), markOf(p, 'contacts.contactName'), markOf(p, 'trip.end')])
        .toEqual(['checked', 'checked', 'kept', 'from_bitrix']);
    });
  });

  it('F.2-8: refusals unchanged for prefill_mark_checked and the new commands', async () => {
    await asOwner(db, async () => {
      await autoFill();
      const deal = await dealWithFacts();
      const s = await startDraft(deal);
      for (const actor of [PURCHASE, ACCOUNTS, FLIGHT, SUPER, SALES_B]) {
        await refused(actor, CHECK, ['booking_version', s.versionId, s.rowVersion, ['trip.start']], '42501', 'not_authorized');
        await refused(actor, FILL, ['booking_version', s.versionId, s.rowVersion], '42501', 'not_authorized');
        await refused(actor, START, [deal], '42501', 'not_authorized');
        expect(await form(actor, deal)).toBeNull();
      }
      await refused(ANON, START, [deal], '42501');
      await refused(OWNER, CHECK, ['booking_version', s.versionId, 1, ['trip.start']], '40001', 'version_changed');
      await refused(OWNER, FILL, ['booking_version', s.versionId, 1], '40001', 'version_changed');
      await refused(OWNER, CHECK, ['booking_version', s.versionId, s.rowVersion, []], '22023', 'invalid_input');
      await refused(OWNER, FILL, ['deal', s.versionId, s.rowVersion], '22023', 'invalid_input');
      await readSwitch(false);
      await refused(OWNER, FILL, ['booking_version', s.versionId, s.rowVersion], '55000', 'prefill_unavailable');
      // Sent quotation: wrong_state for check, fill and dismiss.
      await readSwitch(true);
      const acc = await acceptedQuote(deal);
      const [qv] = await owner<{ row_version: number }>('select row_version from public.quotation_versions where id = $1', [acc.versionId]);
      await refused(OWNER, CHECK, ['quotation_version', acc.versionId, qv!.row_version, ['trip.start']], '55000', 'wrong_state');
      await refused(OWNER, FILL, ['quotation_version', acc.versionId, qv!.row_version], '55000', 'wrong_state');
      await refused(OWNER, DISMISS, ['quotation_version', acc.versionId, qv!.row_version, 'trip.start', new Date().toISOString()], '55000', 'wrong_state');
    });
  });
});

// ===========================================================================
describe('conversion precedence (BC-A3, F.1.4-8/14)', () => {
  it('converts onto a draft holding only untouched automatic values (contacts row updated); marks become replaced_by_quotation', async () => {
    await asOwner(db, async () => {
      await autoFill();
      const deal = await dealWithFacts();
      const s = await startDraft(deal);
      const acc = await acceptedQuote(deal);
      const conv = await one<{ outcome: string; bookingVersionId: string }>(OWNER, Q.convert, [acc.versionId, acc.hash, rid()]);
      expect(conv.bookingVersionId).toBe(s.versionId);
      expect(await owner('select trip_start::text as s, trip_end::text as e from public.booking_versions where id = $1', [s.versionId]))
        .toEqual([{ s: '2026-12-20', e: '2026-12-23' }]);
      expect((await contactsRow(s.versionId))[0]).toMatchObject({ contact_name: 'Synthetic Quote Contact', mobile: '9876500022', email: null,
        contact_confirmed: false });
      const p = await prefillOf(deal);
      expect(new Set(p.marks.map((m) => m.state))).toEqual(new Set(['replaced_by_quotation']));
      expect(p.unchecked ?? []).toEqual([]);
      const list = await one<{ items: Array<{ code: string }> }>(OWNER, CHECKLIST_SQL, [deal]);
      expect(list.items.map((i) => i.code)).not.toContain('prefill_unchecked');
      const c = await one<{ checked: string[]; notChecked: Array<{ state: string }> }>(OWNER, CHECK, ['booking_version', s.versionId, await rowVersion(s.versionId), ['trip.start']]);
      expect(c).toEqual({ checked: [], notChecked: [{ field: 'trip.start', state: 'replaced_by_quotation' }] });
    });
  });

  it('only defaults in the contacts row (no Customer Type) still convert; any staff edit (even a clearing) refuses draft_not_empty', async () => {
    await asOwner(db, async () => {
      await autoFill();
      const deal = await dealWithFacts();
      await owner(`update public.deal_source_trip_facts set customer_type_enum_id = null where deal_id = $1`, [deal]);
      const s = await startDraft(deal);
      expect(s.filled).not.toContain('contacts.bookingFor');
      expect((await contactsRow(s.versionId))[0]!.booking_for).toBe('individual');
      const acc = await acceptedQuote(deal);
      expect(await one(OWNER, Q.convert, [acc.versionId, acc.hash, rid()])).toMatchObject({ outcome: 'created', bookingVersionId: s.versionId });
    });
    await asOwner(db, async () => {
      await autoFill();
      const deal = await dealWithFacts();
      const s = await startDraft(deal);
      await h.saveContacts(OWNER, s.versionId, s.rowVersion, { contactName: 'Synthetic Bitrix Contact', mobile: '9876500033', email: null,
        contactConfirmed: false, bookingFor: 'business', payerDifferent: false, payerName: null });
      const acc = await acceptedQuote(deal);
      await refused(OWNER, Q.convert, [acc.versionId, acc.hash, rid()], '55000', 'draft_not_empty');
    });
    await asOwner(db, async () => {
      await autoFill();
      const deal = await dealWithFacts();
      const s = await startDraft(deal);
      await h.saveTrip(OWNER, s.versionId, s.rowVersion, { destination: null, scope: null, start: '2026-12-10', end: '2026-12-14' }); // kept only, no history
      const acc = await acceptedQuote(deal);
      await refused(OWNER, Q.convert, [acc.versionId, acc.hash, rid()], '55000', 'draft_not_empty'); // kept = staff saved it
    });
  });

  it('F.1.4-15: no fill ever confirms a contact (C1, C3 and Use it on mobile/e-mail)', async () => {
    await asOwner(db, async () => {
      await autoFill();
      const deal = await dealWithFacts();
      const s = await startDraft(deal);
      expect((await contactsRow(s.versionId))[0]).toMatchObject({ contact_confirmed: false, confirmed_by: null });
      const r = await one<Fill & { applied: string[] }>(OWNER, APPLY, [s.versionId, s.rowVersion, ['contacts.mobile', 'contacts.email']]);
      expect(r.applied).toEqual(['contacts.mobile', 'contacts.email']);
      expect((await contactsRow(s.versionId))[0]).toMatchObject({ contact_confirmed: false, confirmed_by: null });
    });
  });
});

// ===========================================================================
describe('Echo-A review fixes (echo-redesign-batch2-data.md)', () => {
  it('M1: with an accepted, unconverted quotation no fill path writes; Fill empty skips everything; conversion still works', async () => {
    await asOwner(db, async () => {
      await autoFill();
      const deal = await dealWithFacts();
      const acc = await acceptedQuote(deal);
      const s = await startDraft(deal);
      expect(s).toMatchObject({ created: true, autoFill: 'accepted_quotation', filled: [] });
      expect((await prefillOf(deal)).autoFill.canFillEmpty).toBe(false);
      const fill = await one<Fill>(OWNER, FILL, ['booking_version', s.versionId, s.rowVersion]);
      expect(fill.filled).toEqual([]);
      expect(fill.skipped.map((x) => x.reason)).toEqual(Array(6).fill('accepted_quotation'));
      expect(await h.count('select 1 from public.prefill_marks where target_id = $1', [s.versionId])).toBe(0);
      expect(await one(OWNER, Q.convert, [acc.versionId, acc.hash, rid()])).toMatchObject({ outcome: 'created', bookingVersionId: s.versionId });
    });
  });

  it('L2: a clearing never moves cleared_at backwards (no failed save after a clock step back)', async () => {
    await asOwner(db, async () => {
      await autoFill();
      const deal = await dealWithFacts();
      const s = await startDraft(deal);
      let rv = (await h.saveContacts(OWNER, s.versionId, s.rowVersion, { ...CONTACT_TYPED, contactName: 'Synthetic Bitrix Contact', email: null })).rowVersion;
      await owner(`update public.prefill_field_history set cleared_at = now() + interval '1 day'
                   where target_id = $1 and field_code = 'contacts.email'`, [s.versionId]);
      rv = (await h.saveContacts(OWNER, s.versionId, rv, { ...CONTACT_TYPED, contactName: 'Synthetic Bitrix Contact' })).rowVersion;
      rv = (await h.saveContacts(OWNER, s.versionId, rv, { ...CONTACT_TYPED, contactName: 'Synthetic Bitrix Contact', email: null })).rowVersion;
      const [hist] = await owner<{ later: boolean }>(`select cleared_at > now() + interval '23 hours' as later from public.prefill_field_history
                                                   where target_id = $1 and field_code = 'contacts.email'`, [s.versionId]);
      expect(hist).toEqual({ later: true });
      expect(rv).toBeGreaterThan(s.rowVersion);
    });
  });

  it('L3: staff clearing both automatic trip dates makes conversion refuse; a draft without a creation fill keeps today\'s rule', async () => {
    await asOwner(db, async () => {
      await autoFill();
      const deal = await dealWithFacts();
      const s = await startDraft(deal);
      await h.saveTrip(OWNER, s.versionId, s.rowVersion, { destination: null, scope: null, start: null, end: null });
      await owner('delete from public.booking_version_contacts where booking_version_id = $1', [s.versionId]); // isolate the trip rule
      const acc = await acceptedQuote(deal);
      await refused(OWNER, Q.convert, [acc.versionId, acc.hash, rid()], '55000', 'draft_not_empty');
    });
    await asOwner(db, async () => {
      const deal = await dealWithFacts();
      const opened = await h.openDraft(OWNER, deal);
      const rv = (await h.saveTrip(OWNER, opened.versionId, opened.rowVersion, { destination: null, scope: null, start: '2026-12-01', end: null })).rowVersion;
      await h.saveTrip(OWNER, opened.versionId, rv, { destination: null, scope: null, start: null, end: null });
      const acc = await acceptedQuote(deal);
      expect(await one(OWNER, Q.convert, [acc.versionId, acc.hash, rid()])).toMatchObject({ outcome: 'created', bookingVersionId: opened.versionId });
    });
  });

  it('L4: Fill empty on a ready quotation: nothing to fill keeps it ready; a fill returns it to draft with a bump and audit', async () => {
    await asOwner(db, async () => {
      const deal = await dealWithFacts();
      const q = await one<QCreated>(OWNER, Q.create, ['deal', deal, 'Synthetic ready quote', rid()]); // switch off: no creation fill
      let ready = await readyVersion(q.versionId, q.rowVersion);
      await autoFill();
      const fill = await one<Fill>(OWNER, FILL, ['quotation_version', q.versionId, ready.rowVersion]);
      expect(fill.filled).toEqual(['contacts.bookingFor', 'contacts.companyName', 'contacts.email', 'requirementsNote']);
      expect(fill.rowVersion).toBe(ready.rowVersion + 1);
      expect(await owner('select status, content_hash from public.quotation_versions where id = $1', [q.versionId]))
        .toEqual([{ status: 'draft', content_hash: null }]);
      const [audit] = await owner<{ details: Record<string, unknown> }>(
        `select details from public.audit_events where action = 'quotation.prefill_filled_empty' order by id desc limit 1`);
      expect(audit!.details).toMatchObject({ returnedToDraft: true, rowVersion: fill.rowVersion });
      ready = await one(OWNER, Q.ready, [q.versionId, fill.rowVersion]);
      const nothing = await one<Fill>(OWNER, FILL, ['quotation_version', q.versionId, ready.rowVersion]);
      expect(nothing.filled).toEqual([]);
      expect(nothing.rowVersion).toBe(ready.rowVersion);
      expect(await owner('select status, content_hash from public.quotation_versions where id = $1', [q.versionId]))
        .toEqual([{ status: 'ready', content_hash: ready.contentHash }]);
    });
  });

  it('L5: Keep mine refuses a snapshot time later than the current snapshot', async () => {
    await asOwner(db, async () => {
      await autoFill();
      const deal = await dealWithFacts();
      const s = await startDraft(deal);
      const [snap] = await owner<{ t: string; later: string }>(
        `select source_modified_at::text as t, (source_modified_at + interval '1 second')::text as later from public.deal_source_trip_facts where deal_id = $1`, [deal]);
      await refused(OWNER, DISMISS, ['booking_version', s.versionId, s.rowVersion, 'trip.end', snap!.later], '22023', 'invalid_input');
      expect(await one(OWNER, DISMISS, ['booking_version', s.versionId, s.rowVersion, 'trip.end', snap!.t])).toMatchObject({ dismissed: true });
      await readSwitch(false); // nothing readable: every time is later than "no snapshot"
      await refused(OWNER, DISMISS, ['booking_version', s.versionId, s.rowVersion, 'trip.start', snap!.t], '22023', 'invalid_input');
    });
  });

  it('L6: a creation-fill failure never blocks Start booking and leaves one audit row with the SQLSTATE only', async () => {
    await asOwner(db, async () => {
      await autoFill();
      const deal = await dealWithFacts();
      await db.exec(`create function public.test_refuse_run() returns trigger language plpgsql as $f$ begin
                       raise exception 'synthetic failure' using errcode = 'P0001'; end $f$`);
      await db.exec('create trigger test_refuse_run before insert on public.prefill_fill_runs for each row execute function public.test_refuse_run()');
      const s = await startDraft(deal);
      expect(s).toMatchObject({ created: true, autoFill: 'failed', filled: [] });
      expect(s.skipped.every((x) => x.reason === 'fill_failed')).toBe(true);
      expect(await h.count('select 1 from public.prefill_marks where target_id = $1', [s.versionId])).toBe(0);
      expect(await owner('select trip_start from public.booking_versions where id = $1', [s.versionId])).toEqual([{ trip_start: null }]);
      const audits = await owner<{ details: Record<string, unknown> }>(
        `select details from public.audit_events where action = 'booking.prefill_auto_fill_failed'`);
      expect(audits).toEqual([{ details: { versionId: s.versionId, sqlState: 'P0001' } }]);
      expect(JSON.stringify(audits)).not.toMatch(/synthetic failure|Synthetic Bitrix|9876500033/);
    });
  });
});
