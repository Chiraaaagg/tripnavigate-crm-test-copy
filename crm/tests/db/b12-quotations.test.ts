import { priceQuotationVersion } from './b12-quotation-money-support';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, type TestDb, asOwner, createTestDb, expectDbError, resetActor, setActor } from '../helpers/db';
import {
  ACCOUNTS,
  ANON,
  CHECKLIST_SQL,
  DEAL,
  FLIGHT,
  HOTEL,
  MANAGER,
  OTHER_ENTITY,
  OWNER,
  PURCHASE,
  SALES_AMD,
  SALES_B,
  SUPER,
  TRANSFER,
  rid,
} from './b1-support';
import { DESK, b11Helpers } from './b11-support';

/**
 * B1.2 Phase E (migration 20261120000200_b12_quotations): quotation header,
 * versions and states, validity and lazy expiry, acceptance with the exact
 * version's written acceptance, supersession, the Lead -> Deal link, the
 * idempotent conversion into the booking draft and its readiness, and the
 * access matrix (editors only). Mercury's money helpers are the 0200 stubs.
 * Synthetic fixtures only; every case rolled back.
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

const SQL = {
  create: 'select public.quotation_create($1, $2, $3, $4) as r',
  save: 'select public.quotation_version_save($1, $2, $3::jsonb) as r',
  tiers: 'select public.quotation_tiers_save($1, $2, $3::jsonb) as r',
  itemAdd: 'select public.quotation_item_add($1, $2, $3, $4, $5::jsonb) as r',
  itemSave: 'select public.quotation_item_save($1, $2, $3, $4, $5::jsonb) as r',
  itemRemove: 'select public.quotation_item_remove($1, $2, $3) as r',
  contacts: 'select public.quotation_contacts_save($1, $2, $3::jsonb) as r',
  ready: 'select public.quotation_mark_ready($1, $2) as r',
  sent: 'select public.quotation_mark_sent($1, $2, $3, $4) as r',
  evBegin: 'select public.quotation_evidence_begin($1, $2, $3, $4, $5, $6) as r',
  evFinish: 'select public.quotation_evidence_finish($1, $2) as r',
  evRemove: 'select public.quotation_evidence_remove($1) as r',
  evDownload: 'select public.quotation_evidence_authorize_download($1) as r',
  accept: 'select public.quotation_accept($1, $2, $3, $4, $5) as r',
  decline: 'select public.quotation_decline($1, $2, $3, $4) as r',
  newVersion: 'select public.quotation_new_version($1, $2, $3) as r',
  discard: 'select public.quotation_discard($1, $2) as r',
  link: 'select public.quotation_link_deal($1, $2, $3) as r',
  convert: 'select public.quotation_convert_to_booking($1, $2, $3) as r',
  list: 'select public.quotation_list($1, $2) as r',
  get: 'select public.quotation_get($1) as r',
  candidates: 'select public.quotation_link_candidates($1) as r',
};

type Created = { quotationId: string; reference: string; versionId: string; versionNo: number; rowVersion: number; created: boolean };
type RV = { rowVersion: number; status?: string };
type Version = { versionId: string; versionNo: number; status: string; rowVersion: number; contentHash: string | null; validUntil: string };
type Got = {
  quotationId: string; version: Version; issues: string[]; items: Array<{ itemId: string; itemNo: number; serviceType: string; tierKey: string | null }>;
  contacts: Record<string, unknown> | null; canEdit: boolean; conversion: { bookingVersionId: string } | null; money?: unknown;
};

const TRIP_FIELDS = { destination: 'Synthetic City', scope: 'domestic', start: '2026-12-10', end: '2026-12-13', adults: 3, childrenWithBed: 1 };
const CONTACT = { contactName: 'Synthetic Quote Contact', mobile: '9876500022', email: null, companyName: null };
const SHA = 'f'.repeat(64);

const get = (actor: Actor, versionId: string) => one<Got | null>(actor, SQL.get, [versionId]);

async function createQuote(actor: Actor = OWNER, kind: 'deal' | 'lead' = 'deal', subject: string = DEAL, title = 'Synthetic quotation') {
  return one<Created>(actor, SQL.create, [kind, subject, title, rid()]);
}

/** A ready version: trip, pax, contact, a hotel on the quoted tier, an upgrade tier with its hotel, a common transfer. */
async function readyVersion(actor: Actor, versionId: string, rowVersion: number, opts: { upgrade?: boolean } = {}) {
  let rv = (await one<RV>(actor, SQL.save, [versionId, rowVersion, JSON.stringify(TRIP_FIELDS)])).rowVersion;
  rv = (await one<RV>(actor, SQL.contacts, [versionId, rv, JSON.stringify(CONTACT)])).rowVersion;
  if (opts.upgrade) {
    rv = (await one<RV>(actor, SQL.tiers, [versionId, rv, JSON.stringify([{ tierKey: 'quoted', label: 'Deluxe' }, { tierKey: 'upgrade', label: 'Luxury' }])])).rowVersion;
  }
  rv = (await one<{ rowVersion: number }>(actor, SQL.itemAdd, [versionId, rv, 'hotel', 'quoted', JSON.stringify(HOTEL)])).rowVersion;
  if (opts.upgrade) {
    rv = (await one<{ rowVersion: number }>(actor, SQL.itemAdd,
      [versionId, rv, 'hotel', 'upgrade', JSON.stringify({ ...HOTEL, hotelName: 'Synthetic Luxury Hotel', extraBeds: 1, bedRemarks: 'Synthetic extra bed' })])).rowVersion;
  }
  rv = (await one<{ rowVersion: number }>(actor, SQL.itemAdd, [versionId, rv, 'transfer', null, JSON.stringify(TRANSFER)])).rowVersion;
  rv = await priceQuotationVersion(one, owner, actor, versionId, rv);
  return one<{ status: string; contentHash: string; rowVersion: number }>(actor, SQL.ready, [versionId, rv]);
}

async function sentVersion(actor: Actor = OWNER, subject: { kind?: 'deal' | 'lead'; id?: string } = {}, opts: { upgrade?: boolean } = {}) {
  const q = await createQuote(actor, subject.kind ?? 'deal', subject.id ?? DEAL);
  const ready = await readyVersion(actor, q.versionId, q.rowVersion, opts);
  await one(actor, SQL.sent, [q.versionId, ready.contentHash, 'whatsapp', rid()]);
  return { ...q, hash: ready.contentHash };
}

async function storeAcceptance(actor: Actor, versionId: string, kind = 'acceptance_message'): Promise<string> {
  const ev = await one<{ evidenceId: string; objectPath: string }>(actor, SQL.evBegin, [versionId, kind, 'acceptance.pdf', 'application/pdf', 2048, SHA]);
  await owner(`insert into storage.objects (bucket_id, name, metadata) values ('quotation-evidence', $1, jsonb_build_object('size', 2048::bigint))`, [ev.objectPath]);
  expect((await one<{ status: string }>(actor, SQL.evFinish, [ev.evidenceId, true])).status).toBe('stored');
  return ev.evidenceId;
}

async function acceptedQuote(actor: Actor = OWNER, subject: { kind?: 'deal' | 'lead'; id?: string } = {}, tier = 'quoted', opts: { upgrade?: boolean } = {}) {
  const s = await sentVersion(actor, subject, opts);
  const evidenceId = await storeAcceptance(actor, s.versionId);
  await one(actor, SQL.accept, [s.versionId, s.hash, evidenceId, tier, rid()]);
  return { ...s, evidenceId };
}

/** A synthetic imported Lead (scope intake) in the given branch, owned by the given user. */
async function insertLead(sourceLeadId: number, branch = 'DEL', ownerUser: string = U.salesDelhiA): Promise<string> {
  const [inbox] = await owner<{ id: string }>(
    `insert into public.integration_inbox (portal_member_id, event_type, source_deal_id, source_ts, dedupe_key, status, processed_at)
     values ('SYNTHETIC_MEMBER_0001', 'ONCRMDEALADD', $1::bigint, 1, repeat('c', 58) || lpad($2::text, 6, '0'), 'processed', now()) returning id`,
    [sourceLeadId, String(sourceLeadId)],
  );
  const [lead] = await owner<{ id: string }>(
    `insert into public.crm_leads (legal_entity_id, branch_id, reference, title, owner_user_id, source_portal, source_lead_id,
       source_status_id, source_id_code, source_created_at, source_modified_at, last_synced_at, last_verified_at, intake_inbox_id,
       manifest_id, intake_mode)
     select b.legal_entity_id, b.id, 'BXL-' || $1::text, 'Synthetic quotation lead', $2, 'SYNTHETIC_MEMBER_0001', $1::bigint,
            'NEW', 'WEBFORM', now(), now(), now(), now(), $3, null, 'scope'
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
     where e.code = 'HOLIDAY_CHACHA' and b.code = $4
     returning id`,
    [sourceLeadId, ownerUser, inbox!.id, branch],
  );
  return lead!.id;
}

async function addRole(user: string, role: string, branch: string): Promise<void> {
  await owner(
    `insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
     select $1, b.legal_entity_id, b.id, $2, 'active'
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
     where e.code = 'HOLIDAY_CHACHA' and b.code = $3`,
    [user, role, branch],
  );
}

async function backdateValidity(versionId: string, days: number): Promise<void> {
  await db.exec('alter table public.quotation_versions disable trigger quotation_versions_a_guard');
  await owner(`update public.quotation_versions set valid_until = authz.finance_today() - $2::integer where id = $1`, [versionId, days]);
  await db.exec('alter table public.quotation_versions enable trigger quotation_versions_a_guard');
}

async function expectHint(actor: Actor, sql: string, params: unknown[], code: string, message: string, hint: RegExp): Promise<void> {
  await db.exec('savepoint q_hint');
  let error: { code?: string; message?: string; hint?: string } | undefined;
  try {
    await h.run(actor, sql, params);
  } catch (e) {
    error = e as typeof error;
    await db.exec('rollback to savepoint q_hint');
  }
  expect(error?.code).toBe(code);
  expect(error?.message).toBe(message);
  expect(error?.hint ?? '').toMatch(hint);
}

describe('schema, privileges and Mercury stubs', () => {
  it('every quotation table is RLS-protected with no API privilege; the bucket is private; stub names and parameters are frozen', async () => {
    await asOwner(db, async () => {
      const tables = ['quotation_counters', 'quotations', 'quotation_versions', 'quotation_version_tiers', 'quotation_version_items',
        'quotation_version_contacts', 'quotation_evidence', 'quotation_conversions', 'quotation_conversion_items'];
      for (const t of tables) {
        const [r] = await owner<{ rls: boolean; auth: boolean; svc: boolean }>(
          `select c.relrowsecurity as rls, has_table_privilege('authenticated', c.oid, 'select') as auth,
                  has_table_privilege('service_role', c.oid, 'select') as svc
           from pg_class c where c.oid = ('public.' || $1)::regclass`, [t]);
        expect(r, t).toEqual({ rls: true, auth: false, svc: false });
        expect(await owner(`select policyname, permissive from pg_policies where schemaname = 'public' and tablename = $1`, [t]))
          .toEqual([{ policyname: 'require_valid_session', permissive: 'RESTRICTIVE' }]);
      }
      expect(await owner(`select public, file_size_limit::text as size from storage.buckets where id = 'quotation-evidence'`))
        .toEqual([{ public: false, size: '4194304' }]);
      const stubs = await owner<{ proname: string; args: string }>(
        `select p.proname, pg_get_function_identity_arguments(p.oid) as args from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'authz' and p.proname like 'quotation_money%' or (n.nspname = 'authz' and p.proname = 'quotation_copy_lines')
         order by p.proname`);
      expect(stubs).toEqual([
        { proname: 'quotation_copy_lines', args: 'p_from_version uuid, p_to_version uuid' },
        { proname: 'quotation_money_can_edit', args: 'p_quotation uuid' },
        { proname: 'quotation_money_can_read', args: 'p_quotation uuid' },
        { proname: 'quotation_money_check', args: 'p_version uuid' },
        { proname: 'quotation_money_hash', args: 'p_version uuid' },
        { proname: 'quotation_money_json', args: 'p_version uuid' },
        { proname: 'quotation_money_to_booking', args: 'p_quotation_version uuid, p_booking_version uuid, p_tier_key text' },
      ]);
      const [fn] = await owner<Record<string, boolean>>(
        `select has_function_privilege('authenticated', 'public.quotation_get(uuid)', 'execute') as get,
                has_function_privilege('anon', 'public.quotation_create(text, uuid, text, uuid)', 'execute') as anon,
                has_function_privilege('authenticated', 'authz.quotation_can_edit(uuid)', 'execute') as helper`);
      expect(fn).toEqual({ get: true, anon: false, helper: false });
    });
  });
});

describe('Deal quotation: create, edit, ready, sent, accept, convert', () => {
  it('walks the happy path; numbers per entity; idempotent create; audits carry no values', async () => {
    await asOwner(db, async () => {
      await h.setSwitch('service_items_enabled', true);
      const q = await createQuote();
      expect(q).toMatchObject({ versionNo: 1, rowVersion: 1, created: true });
      expect(q.reference).toMatch(/^TQ-[0-9]+$/);
      const again = await one<Created>(OWNER, SQL.create, ['deal', DEAL, 'Synthetic quotation 2', rid()]);
      expect(Number(again.reference.slice(3))).toBe(Number(q.reference.slice(3)) + 1);
      const requestId = rid();
      const first = await one<Created>(OWNER, SQL.create, ['deal', DEAL, 'Synthetic replay', requestId]);
      expect(await one<Created>(OWNER, SQL.create, ['deal', DEAL, 'Synthetic replay', requestId])).toMatchObject({ quotationId: first.quotationId, created: false });
      await refused(OWNER, SQL.create, ['deal', DEAL, 'Other title', requestId], '40001', 'request_conflict');

      const draft = await get(OWNER, q.versionId);
      expect(draft!.version).toMatchObject({ status: 'draft', validUntil: expect.any(String) });
      expect(draft!.issues).toEqual(expect.arrayContaining(['trip_missing', 'pax_missing', 'no_items', 'contact_missing']));
      const [today] = await owner<{ d: string }>(`select to_char(authz.finance_today() + 7, 'YYYY-MM-DD') as d`);
      expect(draft!.version.validUntil).toBe(today!.d);

      const ready = await readyVersion(OWNER, q.versionId, q.rowVersion, { upgrade: true });
      expect(ready).toMatchObject({ status: 'ready', contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
      const sent = await one<{ status: string; supersededVersionId: string | null }>(OWNER, SQL.sent, [q.versionId, ready.contentHash, 'email', rid()]);
      expect(sent).toMatchObject({ status: 'sent', supersededVersionId: null });
      const evidenceId = await storeAcceptance(OWNER, q.versionId);
      const accepted = await one<{ status: string; acceptedTier: string }>(OWNER, SQL.accept, [q.versionId, ready.contentHash, evidenceId, 'upgrade', rid()]);
      expect(accepted).toMatchObject({ status: 'accepted', acceptedTier: 'upgrade' });

      const conv = await one<{ outcome: string; bookingVersionId: string; dealId: string; itemsCreated: number }>(OWNER, SQL.convert, [q.versionId, ready.contentHash, rid()]);
      expect(conv).toMatchObject({ outcome: 'created', dealId: DEAL, itemsCreated: 2 }); // upgrade hotel + common transfer
      expect(await one(OWNER, SQL.convert, [q.versionId, ready.contentHash, rid()])).toMatchObject({ outcome: 'existing', bookingVersionId: conv.bookingVersionId });
      const [booking] = await owner<Record<string, unknown>>(
        `select v.status, v.trip_destination, v.trip_start::text as start, v.source_quotation_version_id, v.source_quotation_hash, v.source_accepted_tier,
                c.contact_name, c.contact_confirmed, c.booking_for
         from public.booking_versions v left join public.booking_version_contacts c on c.booking_version_id = v.id where v.id = $1`, [conv.bookingVersionId]);
      expect(booking).toMatchObject({ status: 'draft', trip_destination: 'Synthetic City', start: '2026-12-10', source_quotation_version_id: q.versionId,
        source_quotation_hash: ready.contentHash, source_accepted_tier: 'upgrade', contact_name: CONTACT.contactName, contact_confirmed: false, booking_for: 'individual' });
      const items = await owner<{ service_type: string; hotel: string | null; extra: string | null }>(
        `select i.service_type, f.facts ->> 'hotelName' as hotel, f.facts ->> 'extraBeds' as extra
         from public.service_items i join public.service_item_facts f on f.service_item_id = i.id where f.booking_version_id = $1 order by i.item_no`,
        [conv.bookingVersionId]);
      expect(items).toEqual([{ service_type: 'hotel', hotel: 'Synthetic Luxury Hotel', extra: '1' }, { service_type: 'transfer', hotel: null, extra: null }]);
      expect(await h.count('select 1 from public.deal_travellers where deal_id = $1', [DEAL])).toBe(0); // names never invented
      expect(await h.count('select 1 from public.quotation_conversion_items')).toBe(2);
      // Book now shows where the draft came from (one read).
      const form = await h.form(OWNER);
      expect(form!.sourceQuotation).toEqual({ quotationId: q.quotationId, reference: q.reference, versionId: q.versionId, versionNo: 1,
        acceptedAt: expect.any(String), acceptedTierKey: 'upgrade', acceptanceEvidenceId: evidenceId });
      const [header] = await owner<{ row_version: number }>('select row_version from public.quotations where id = $1', [q.quotationId]);
      expect((await one<{ rowVersion: number }>(OWNER, SQL.get, [q.versionId])).rowVersion).toBe(header!.row_version);
      expect((await one<Array<{ quotationId: string; rowVersion: number }>>(OWNER, SQL.list, ['deal', DEAL]))
        .find((x) => x.quotationId === q.quotationId)!.rowVersion).toBe(header!.row_version);
      // The quotation acceptance stands in for the booking's acceptance message.
      expect((await h.readiness(OWNER, conv.bookingVersionId)).issues).not.toContain('missing_acceptance_proof');
      // After conversion: no new version, no change.
      await refused(OWNER, SQL.newVersion, [q.quotationId, q.versionId, rid()], '55000', 'quotation_converted');

      const audits = await owner<{ action: string; details: unknown }>(
        `select action, details from public.audit_events where action like 'quotation.%' order by occurred_at, action`);
      expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['quotation.created', 'quotation.version_saved', 'quotation.item_added',
        'quotation.contacts_saved', 'quotation.marked_ready', 'quotation.marked_sent', 'quotation.evidence_started', 'quotation.evidence_stored',
        'quotation.accepted', 'quotation.converted']));
      expect(JSON.stringify(audits)).not.toMatch(/Synthetic City|Synthetic Quote Contact|9876500022|Synthetic Luxury Hotel|acceptance\.pdf/);
    });
  });

  it('refuses bad input with field hints; editing a ready version returns it to draft', async () => {
    await asOwner(db, async () => {
      const q = await createQuote();
      await expectHint(OWNER, SQL.save, [q.versionId, q.rowVersion, JSON.stringify({ adults: -1, colour: 'x', scope: 'space', content: { price: 1 } })],
        '22023', 'invalid_input', /adults/);
      await refused(OWNER, SQL.save, [q.versionId, q.rowVersion, JSON.stringify({ validUntil: '2020-01-01' })], '22023', 'valid_until_past');
      await refused(OWNER, SQL.save, [q.versionId, q.rowVersion + 5, JSON.stringify({ adults: 2 })], '40001', 'version_changed');
      await expectHint(OWNER, SQL.save, [q.versionId, q.rowVersion, JSON.stringify({ start: '2026-12-10', end: '2026-12-01' })], '22023', 'invalid_input', /end/);
      await expectHint(OWNER, SQL.itemAdd, [q.versionId, q.rowVersion, 'hotel', null, JSON.stringify({ ...HOTEL, extraBeds: 30 })], '22023', 'invalid_input', /extraBeds/);
      await expectHint(OWNER, SQL.itemAdd, [q.versionId, q.rowVersion, 'hotel', 'upgrade', JSON.stringify(HOTEL)], '22023', 'invalid_input', /tierKey/);
      await refused(OWNER, SQL.itemAdd, [q.versionId, q.rowVersion, 'train', null, '{}'], '22023', 'service_on_hold');
      await expectHint(OWNER, SQL.tiers, [q.versionId, q.rowVersion, JSON.stringify([{ tierKey: 'upgrade' }])], '22023', 'invalid_input', /tiers/);
      await expectHint(OWNER, SQL.contacts, [q.versionId, q.rowVersion, JSON.stringify({ contactName: 'X', mobile: '123', email: null, companyName: null })],
        '22023', 'invalid_input', /mobile/);
      await expectHint(OWNER, SQL.ready, [q.versionId, q.rowVersion], '55000', 'not_ready', /trip_missing.*pax_missing.*no_items.*contact_missing/);
      const ready = await readyVersion(OWNER, q.versionId, q.rowVersion);
      const edited = await one<RV>(OWNER, SQL.save, [q.versionId, ready.rowVersion, JSON.stringify({ paxRemarks: 'Synthetic remark' })]);
      expect(edited.status).toBe('draft');
      expect((await get(OWNER, q.versionId))!.version.contentHash).toBeNull();
      await refused(OWNER, SQL.sent, [q.versionId, ready.contentHash, 'email', rid()], '55000', 'wrong_state');
    });
  });

  it('a sent version never changes; a change makes a new version; sending it supersedes the old one', async () => {
    await asOwner(db, async () => {
      const s = await sentVersion();
      await refused(OWNER, SQL.save, [s.versionId, 3, JSON.stringify({ adults: 2 })], '55000', 'wrong_state');
      await expectDbError(db, () => owner(`update public.quotation_versions set adults = 9 where id = $1`, [s.versionId]), { code: '42501' });
      await expectDbError(db, () => owner(`delete from public.quotation_versions where id = $1`, [s.versionId]), { code: '42501' });
      const v2 = await one<{ versionId: string; versionNo: number; rowVersion: number; created: boolean }>(OWNER, SQL.newVersion, [s.quotationId, s.versionId, rid()]);
      expect(v2).toMatchObject({ versionNo: 2, created: true });
      expect(await one(OWNER, SQL.newVersion, [s.quotationId, s.versionId, rid()])).toMatchObject({ versionId: v2.versionId, created: false });
      const copied = await get(OWNER, v2.versionId);
      expect(copied!.items.map((i) => i.serviceType)).toEqual(['hotel', 'transfer']);
      expect(copied!.contacts).toMatchObject({ contactName: CONTACT.contactName });
      const rv = (await one<RV>(OWNER, SQL.save, [v2.versionId, v2.rowVersion, JSON.stringify({ adults: 2 })])).rowVersion;
      const r2 = await one<{ contentHash: string }>(OWNER, SQL.ready, [v2.versionId, rv]);
      expect(r2.contentHash).not.toBe(s.hash);
      const sent2 = await one<{ supersededVersionId: string }>(OWNER, SQL.sent, [v2.versionId, r2.contentHash, 'phone', rid()]);
      expect(sent2.supersededVersionId).toBe(s.versionId);
      expect((await get(OWNER, s.versionId))!.version.status).toBe('superseded');
      const ev = await storeAcceptance(OWNER, v2.versionId);
      await refused(OWNER, SQL.accept, [s.versionId, s.hash, ev, 'quoted', rid()], '55000', 'version_superseded');
    });
  });

  it('expiry: computed on read (IST), refused on accept, persisted by the next command', async () => {
    await asOwner(db, async () => {
      const s = await sentVersion();
      await backdateValidity(s.versionId, 1);
      expect((await get(OWNER, s.versionId))!.version.status).toBe('expired');
      const [stored] = await owner<{ status: string }>('select status from public.quotation_versions where id = $1', [s.versionId]);
      expect(stored!.status).toBe('sent');
      await refused(OWNER, SQL.evBegin, [s.versionId, 'acceptance_message', 'a.pdf', 'application/pdf', 10, SHA], '55000', 'quotation_expired');
      await refused(OWNER, SQL.accept, [s.versionId, s.hash, crypto.randomUUID(), 'quoted', rid()], '55000', 'quotation_expired');
      await one(OWNER, SQL.newVersion, [s.quotationId, s.versionId, rid()]);
      expect(await owner('select status, expired_at is not null as at from public.quotation_versions where id = $1', [s.versionId]))
        .toEqual([{ status: 'expired', at: true }]);
      expect(await h.count(`select 1 from public.audit_events where action = 'quotation.expired' and target_id = $1`, [s.versionId])).toBe(1);
    });
  });
});

describe('acceptance (DEC-35)', () => {
  it('needs a stored acceptance message of THIS version, the exact hash and an existing tier', async () => {
    await asOwner(db, async () => {
      const s = await sentVersion();
      await refused(OWNER, SQL.accept, [s.versionId, s.hash, crypto.randomUUID(), 'quoted', rid()], '55000', 'acceptance_proof_required');
      const other = await storeAcceptance(OWNER, s.versionId, 'other');
      await refused(OWNER, SQL.accept, [s.versionId, s.hash, other, 'quoted', rid()], '55000', 'acceptance_proof_required');
      const pending = await one<{ evidenceId: string }>(OWNER, SQL.evBegin, [s.versionId, 'acceptance_message', 'a.pdf', 'application/pdf', 10, SHA]);
      await refused(OWNER, SQL.accept, [s.versionId, s.hash, pending.evidenceId, 'quoted', rid()], '55000', 'acceptance_proof_required');
      const ev = await storeAcceptance(OWNER, s.versionId);
      await refused(OWNER, SQL.accept, [s.versionId, 'a'.repeat(64), ev, 'quoted', rid()], '40001', 'version_changed');
      await expectHint(OWNER, SQL.accept, [s.versionId, s.hash, ev, 'upgrade', rid()], '22023', 'invalid_input', /tierKey/);
      const requestId = rid();
      const ok = await one<{ status: string }>(OWNER, SQL.accept, [s.versionId, s.hash, ev, 'quoted', requestId]);
      expect(ok.status).toBe('accepted');
      expect(await one(OWNER, SQL.accept, [s.versionId, s.hash, ev, 'quoted', requestId])).toMatchObject({ status: 'accepted', outcome: 'existing' });
      // Evidence of an accepted version is fixed.
      await refused(OWNER, SQL.evRemove, [ev], '55000', 'wrong_state');
      await expectDbError(db, () => owner(`update public.quotation_evidence set status = 'removed' where id = $1`, [ev]), { code: '42501' });
    });
  });

  it('accepting discards the open draft; one accepted quotation per Deal; decline is final', async () => {
    await asOwner(db, async () => {
      const s = await sentVersion();
      const draft = await one<{ versionId: string }>(OWNER, SQL.newVersion, [s.quotationId, s.versionId, rid()]);
      const ev = await storeAcceptance(OWNER, s.versionId);
      const acc = await one<{ discardedVersionId: string }>(OWNER, SQL.accept, [s.versionId, s.hash, ev, 'quoted', rid()]);
      expect(acc.discardedVersionId).toBe(draft.versionId);
      expect((await get(OWNER, draft.versionId))!.version.status).toBe('discarded');
      const second = await sentVersion();
      const ev2 = await storeAcceptance(OWNER, second.versionId);
      await refused(OWNER, SQL.accept, [second.versionId, second.hash, ev2, 'quoted', rid()], '55000', 'quotation_already_accepted');
      const third = await sentVersion();
      const [row] = await owner<{ row_version: number }>('select row_version from public.quotation_versions where id = $1', [third.versionId]);
      expect(await one(OWNER, SQL.decline, [third.versionId, row!.row_version, 'price', rid()])).toMatchObject({ status: 'declined' });
      const ev3 = await storeAcceptance(OWNER, second.versionId);
      await refused(OWNER, SQL.evBegin, [third.versionId, 'acceptance_message', 'a.pdf', 'application/pdf', 10, SHA], '55000', 'wrong_state');
      await refused(OWNER, SQL.accept, [third.versionId, third.hash, ev3, 'quoted', rid()], '55000', 'wrong_state');
      const [srow] = await owner<{ row_version: number }>('select row_version from public.quotation_versions where id = $1', [second.versionId]);
      await expectHint(OWNER, SQL.decline, [second.versionId, srow!.row_version, 'bored', rid()], '22023', 'invalid_input', /reason/);
    });
  });
});

describe('Lead quotations and the Lead -> Deal link', () => {
  it('Lead owner and branch Manager edit; conversion waits for the link; the link needs the stored Lead id and the same branch', async () => {
    await asOwner(db, async () => {
      await h.setSwitch('service_items_enabled', true);
      const lead = await insertLead(7001);
      await refused(SALES_B, SQL.create, ['lead', lead, 'X', rid()], '42501', 'not_authorized');
      await refused(PURCHASE, SQL.create, ['lead', lead, 'X', rid()], '42501', 'not_authorized');
      expect(await one(MANAGER, SQL.list, ['lead', lead])).toEqual([]);
      const acc = await acceptedQuote(OWNER, { kind: 'lead', id: lead });
      await refused(OWNER, SQL.convert, [acc.versionId, acc.hash, rid()], '55000', 'deal_link_required');

      const wrong = await h.insertRealDeal('UC_AD0SLH', 0, 990101);
      await owner('update public.deals set source_lead_id = 7999 where id = $1', [wrong]);
      const right = await h.insertRealDeal('UC_AD0SLH', 0, 990102);
      await owner('update public.deals set source_lead_id = 7001 where id = $1', [right]);
      const candidates = await one<Array<{ dealId: string; linkable: boolean; sameBranch: boolean }>>(OWNER, SQL.candidates, [acc.quotationId]);
      expect(candidates.map((c) => [c.dealId, c.linkable, c.sameBranch])).toEqual([[right, true, true]]);
      const [q] = await owner<{ row_version: number }>('select row_version from public.quotations where id = $1', [acc.quotationId]);
      await refused(OWNER, SQL.link, [acc.quotationId, wrong, q!.row_version], '22023', 'deal_not_from_lead');
      const linked = await one<{ linkedDealId: string; rowVersion: number }>(OWNER, SQL.link, [acc.quotationId, right, q!.row_version]);
      expect(linked.linkedDealId).toBe(right);
      expect(await one(OWNER, SQL.link, [acc.quotationId, right, 999])).toMatchObject({ linkedDealId: right });
      // The Deal page lists the linked Lead quotation.
      expect((await one<Array<{ quotationId: string }>>(OWNER, SQL.list, ['deal', right])).map((x) => x.quotationId)).toEqual([acc.quotationId]);
      const conv = await one<{ outcome: string; dealId: string }>(OWNER, SQL.convert, [acc.versionId, acc.hash, rid()]);
      expect(conv).toMatchObject({ outcome: 'created', dealId: right });
    });
  });

  it('branch_mismatch when the Deal is in another branch; a Deal with an accepted quotation cannot be linked', async () => {
    await asOwner(db, async () => {
      await addRole(U.managerDelhi, 'manager', 'AMD');
      const lead = await insertLead(7002, 'AMD', U.salesAhmedabad);
      // Pricing needs commercial scope (0300): the Manager gets a branch grant for Ahmedabad.
      await owner(`insert into public.access_grants (user_id, legal_entity_id, branch_id, permission_code, granted_by, reason)
                   select $1, l.legal_entity_id, l.branch_id, 'deal.read_commercial', $2, 'Synthetic branch grant for the test'
                   from public.crm_leads l where l.id = $3`, [U.managerDelhi, U.adminJodhpur, lead]);
      const acc = await acceptedQuote(MANAGER, { kind: 'lead', id: lead });
      const deal = await h.insertRealDeal('UC_AD0SLH', 0, 990103);
      await owner('update public.deals set source_lead_id = 7002 where id = $1', [deal]);
      const [q] = await owner<{ row_version: number }>('select row_version from public.quotations where id = $1', [acc.quotationId]);
      await refused(MANAGER, SQL.link, [acc.quotationId, deal, q!.row_version], '22023', 'branch_mismatch');
      // Same branch, but the Deal already has an accepted quotation of its own.
      const lead2 = await insertLead(7003);
      const acc2 = await acceptedQuote(OWNER, { kind: 'lead', id: lead2 });
      await owner('update public.deals set source_lead_id = 7003 where id = $1', [deal]);
      await acceptedQuote(OWNER, { kind: 'deal', id: deal });
      const [q2] = await owner<{ row_version: number }>('select row_version from public.quotations where id = $1', [acc2.quotationId]);
      await refused(OWNER, SQL.link, [acc2.quotationId, deal, q2!.row_version], '55000', 'deal_already_linked');
    });
  });
});

describe('conversion refusals and readiness of the converted draft', () => {
  it('wrong_state before acceptance; draft_not_empty when Sales already started; already_confirmed after a booking', async () => {
    await asOwner(db, async () => {
      await h.setSwitch('service_items_enabled', true);
      const s = await sentVersion();
      await refused(OWNER, SQL.convert, [s.versionId, s.hash, rid()], '55000', 'wrong_state');
      const ev = await storeAcceptance(OWNER, s.versionId);
      await one(OWNER, SQL.accept, [s.versionId, s.hash, ev, 'quoted', rid()]);
      await refused(OWNER, SQL.convert, [s.versionId, 'b'.repeat(64), rid()], '40001', 'version_changed');
      const opened = await h.openDraft(OWNER, DEAL);
      await h.saveTrip(OWNER, opened.versionId, opened.rowVersion);
      await refused(OWNER, SQL.convert, [s.versionId, s.hash, rid()], '55000', 'draft_not_empty');
      await h.setSwitch('service_items_enabled', false);
      await refused(OWNER, SQL.convert, [s.versionId, s.hash, rid()], '55000', 'service_items_disabled');
    });
    await asOwner(db, async () => {
      const ready = await h.readyPackage(OWNER, DEAL, ['hotel']);
      await h.confirm(OWNER, ready.versionId, ready.hash);
      const acc = await acceptedQuote();
      await refused(OWNER, SQL.convert, [acc.versionId, acc.hash, rid()], '55000', 'already_confirmed');
    });
  });

  it('quote_acceptance_stale after a material change without a new acceptance; quote_details_changed for a meal plan', async () => {
    await asOwner(db, async () => {
      await h.setSwitch('service_items_enabled', true);
      const acc = await acceptedQuote();
      const conv = await one<{ bookingVersionId: string }>(OWNER, SQL.convert, [acc.versionId, acc.hash, rid()]);
      const issues = async () => (await h.readiness(OWNER, conv.bookingVersionId)).issues;
      expect(await issues()).not.toContain('quote_acceptance_stale');
      const [hotel] = await owner<{ id: string }>(
        `select i.id from public.service_items i join public.service_item_facts f on f.service_item_id = i.id
         where f.booking_version_id = $1 and i.service_type = 'hotel'`, [conv.bookingVersionId]);
      const [ver] = await owner<{ row_version: number }>('select row_version from public.booking_versions where id = $1', [conv.bookingVersionId]);
      let rv = (await one<{ rowVersion: number }>(OWNER, 'select public.service_item_save($1, $2, $3, $4::jsonb, $5::bigint) as r',
        [hotel!.id, conv.bookingVersionId, ver!.row_version, JSON.stringify({ ...HOTEL, mealPlan: 'All meals' }), '0'])).rowVersion;
      expect(await issues()).not.toContain('quote_acceptance_stale');
      let list = await one<{ items: Array<{ code: string; blocking: boolean }> }>(OWNER, CHECKLIST_SQL, [DEAL]);
      expect(list.items.find((i) => i.code === 'quote_details_changed')).toMatchObject({ blocking: false });
      rv = (await one<{ rowVersion: number }>(OWNER, 'select public.service_item_save($1, $2, $3, $4::jsonb, $5::bigint) as r',
        [hotel!.id, conv.bookingVersionId, rv, JSON.stringify({ ...HOTEL, mealPlan: 'All meals', checkOut: '2026-12-14' }), '0'])).rowVersion;
      expect(await issues()).toContain('quote_acceptance_stale');
      list = await one(OWNER, CHECKLIST_SQL, [DEAL]);
      expect(list.items.find((i) => i.code === 'quote_acceptance_stale')).toMatchObject({ blocking: true });
      await h.storeEvidence(OWNER, conv.bookingVersionId);
      expect(await issues()).not.toContain('quote_acceptance_stale');
      expect(rv).toBeGreaterThan(0);
    });
  });
});

describe('review E2 rules', () => {
  it('E2-3: after acceptance (not converted) a newer version can be sent; it supersedes the accepted one and the customer accepts again', async () => {
    await asOwner(db, async () => {
      const acc = await acceptedQuote();
      const v2 = await one<{ versionId: string; rowVersion: number }>(OWNER, SQL.newVersion, [acc.quotationId, acc.versionId, rid()]);
      const rv = (await one<RV>(OWNER, SQL.save, [v2.versionId, v2.rowVersion, JSON.stringify({ paxRemarks: 'Synthetic change' })])).rowVersion;
      const r2 = await one<{ contentHash: string }>(OWNER, SQL.ready, [v2.versionId, rv]);
      const sent = await one<{ supersededVersionId: string }>(OWNER, SQL.sent, [v2.versionId, r2.contentHash, 'email', rid()]);
      expect(sent.supersededVersionId).toBe(acc.versionId);
      expect((await get(OWNER, acc.versionId))!.version.status).toBe('superseded');
      expect(await owner('select accepted_version_id from public.quotations where id = $1', [acc.quotationId])).toEqual([{ accepted_version_id: null }]);
      await refused(OWNER, SQL.convert, [acc.versionId, acc.hash, rid()], '55000', 'wrong_state');
      const ev = await storeAcceptance(OWNER, v2.versionId);
      expect(await one(OWNER, SQL.accept, [v2.versionId, r2.contentHash, ev, 'quoted', rid()])).toMatchObject({ status: 'accepted' });
    });
  });

  it('E2-7: accept and convert recompute the content hash (a tampered sent version is version_changed)', async () => {
    await asOwner(db, async () => {
      const s = await sentVersion();
      const ev = await storeAcceptance(OWNER, s.versionId);
      await db.exec('alter table public.quotation_versions disable trigger quotation_versions_a_guard');
      await owner('update public.quotation_versions set adults = 9 where id = $1', [s.versionId]);
      await db.exec('alter table public.quotation_versions enable trigger quotation_versions_a_guard');
      await refused(OWNER, SQL.accept, [s.versionId, s.hash, ev, 'quoted', rid()], '40001', 'version_changed');
    });
  });

  it('E2-1: named travellers by type that differ from the accepted party make the converted draft stale', async () => {
    await asOwner(db, async () => {
      await h.setSwitch('service_items_enabled', true);
      const acc = await acceptedQuote(); // 3 adults + 1 child with a bed
      const conv = await one<{ bookingVersionId: string }>(OWNER, SQL.convert, [acc.versionId, acc.hash, rid()]);
      const issues = async () => (await h.readiness(OWNER, conv.bookingVersionId)).issues;
      expect(await issues()).not.toContain('quote_acceptance_stale'); // no names yet: nothing to compare
      const [ver] = await owner<{ row_version: number }>('select row_version from public.booking_versions where id = $1', [conv.bookingVersionId]);
      // Review E5-6: a party that differs in either direction (here 2 of 4 typed) warns on the
      // checklist while typing and blocks readiness.
      const partial = await h.saveTravellers(OWNER, DEAL, ver!.row_version, [
        { fullName: 'Synthetic Adult One', type: 'adult', seq: 1 }, { fullName: 'Synthetic Adult Two', type: 'adult', seq: 2 }]);
      expect(await issues()).toContain('quote_acceptance_stale');
      const warn = await one<{ items: Array<{ code: string; blocking: boolean }> }>(OWNER, CHECKLIST_SQL, [DEAL]);
      expect(warn.items.find((i) => i.code === 'quote_party_differs')).toMatchObject({ blocking: false });
      expect(warn.items.map((i) => i.code)).not.toContain('quote_acceptance_stale');
      const saved = await h.saveTravellers(OWNER, DEAL, partial.rowVersion); // 3 adults + 1 child
      expect(await issues()).not.toContain('quote_acceptance_stale');
      // Voice-note batch (20261128000110, lead ruling Q4): the converted draft records the accepted
      // adults, so more named children than the accepted party is refused at save (nothing changes).
      await h.refused(OWNER, 'select public.deal_travellers_save($1, $2, $3::jsonb) as r', [DEAL, saved.rowVersion, JSON.stringify([
        { fullName: 'Synthetic Adult One', type: 'adult', seq: 1 }, { fullName: 'Synthetic Adult Two', type: 'adult', seq: 2 },
        { fullName: 'Synthetic Child One', type: 'child', seq: 3, ageYears: 8 }, { fullName: 'Synthetic Child Two', type: 'child', seq: 4, ageYears: 6 },
      ])], '22023', 'traveller_count_exceeded');
      expect(await issues()).not.toContain('quote_acceptance_stale');
      // Fewer named travellers of a type than accepted still makes the draft stale.
      await h.saveTravellers(OWNER, DEAL, saved.rowVersion, [
        { fullName: 'Synthetic Adult One', type: 'adult', seq: 1 }, { fullName: 'Synthetic Adult Two', type: 'adult', seq: 2 },
        { fullName: 'Synthetic Child One', type: 'child', seq: 3, ageYears: 8 },
      ]);
      expect(await issues()).toContain('quote_acceptance_stale');
    });
  });

  it('E2-5: a sync-removed Deal hides quotation reads and refuses the acceptance download', async () => {
    await asOwner(db, async () => {
      const acc = await acceptedQuote();
      await owner('alter table public.deals drop constraint deals_removed_imported_only');
      await owner(`update public.deals set removed_at = now(), removed_reason = 'stage_not_eligible' where id = $1`, [DEAL]);
      await refused(OWNER, SQL.evDownload, [acc.evidenceId], '55000', 'deal_removed');
      expect(await one(MANAGER, SQL.get, [acc.versionId])).toBeNull();
      expect(await one(MANAGER, SQL.list, ['deal', DEAL])).toBeNull();
    });
  });

  it('E2-6: the conversion item map never changes', async () => {
    await asOwner(db, async () => {
      await h.setSwitch('service_items_enabled', true);
      const acc = await acceptedQuote();
      await one(OWNER, SQL.convert, [acc.versionId, acc.hash, rid()]);
      await expectDbError(db, () => owner('delete from public.quotation_conversion_items'), { code: '42501' });
      await expectDbError(db, () => owner('update public.quotation_conversion_items set quotation_item_id = quotation_item_id'), { code: '42501' });
    });
  });
});

describe('DEC-45 on conversion', () => {
  it('a quotation contact marked business converts into a business booking contact', async () => {
    await asOwner(db, async () => {
      await h.setSwitch('service_items_enabled', true);
      const q = await createQuote();
      const rv = (await one<RV>(OWNER, SQL.contacts, [q.versionId, q.rowVersion, JSON.stringify({ ...CONTACT, bookingFor: 'business' })])).rowVersion;
      const ready = await readyVersion(OWNER, q.versionId, rv); // re-saves the contact without bookingFor: kept
      await one(OWNER, SQL.sent, [q.versionId, ready.contentHash, 'email', rid()]);
      const ev = await storeAcceptance(OWNER, q.versionId);
      await one(OWNER, SQL.accept, [q.versionId, ready.contentHash, ev, 'quoted', rid()]);
      const conv = await one<{ bookingVersionId: string }>(OWNER, SQL.convert, [q.versionId, ready.contentHash, rid()]);
      expect(await owner('select booking_for, contact_confirmed from public.booking_version_contacts where booking_version_id = $1', [conv.bookingVersionId]))
        .toEqual([{ booking_for: 'business', contact_confirmed: false }]);
    });
  });
});

describe('access (freeze 2.1): editors only', () => {
  it('Purchase, Flight, the desk, Accounts, Super Admin, other branch and other entity read and change nothing', async () => {
    await asOwner(db, async () => {
      await h.addFlight();
      const s = await sentVersion();
      const ev = await storeAcceptance(OWNER, s.versionId);
      for (const actor of [PURCHASE, FLIGHT, DESK, ACCOUNTS, SUPER, SALES_AMD, OTHER_ENTITY, SALES_B]) {
        await refused(actor, SQL.create, ['deal', DEAL, 'X', rid()], '42501', 'not_authorized');
        expect(await one(actor, SQL.get, [s.versionId])).toBeNull();
        expect(await one(actor, SQL.list, ['deal', DEAL])).toBeNull();
        expect(await one(actor, SQL.candidates, [s.quotationId])).toBeNull();
        await refused(actor, SQL.accept, [s.versionId, s.hash, ev, 'quoted', rid()], '42501', 'not_authorized');
        await refused(actor, SQL.evDownload, [ev], '42501', 'not_authorized');
        await refused(actor, SQL.newVersion, [s.quotationId, s.versionId, rid()], '42501', 'not_authorized');
        await expectDbError(db, async () => {
          await setActor(db, actor);
          await db.query('select * from public.quotations');
        }, { code: '42501' });
        await resetActor(db);
      }
      await expectDbError(db, () => h.run(ANON, SQL.get, [s.versionId]), { code: '42501' });
      // The branch Manager and a sales assignee are editors.
      expect(await one(MANAGER, SQL.get, [s.versionId])).not.toBeNull();
      await h.addSalesAssignee(DEAL, U.salesDelhiB);
      expect(await one(SALES_B, SQL.get, [s.versionId])).not.toBeNull();
      expect((await one<{ mime: string }>(MANAGER, SQL.evDownload, [ev])).mime).toBe('application/pdf');
      expect(await h.count(`select 1 from public.audit_events where action = 'quotation.evidence_viewed'`)).toBe(1);
    });
  });

  it('a removed Deal refuses quotation work; a lost Deal refuses new quotations', async () => {
    await asOwner(db, async () => {
      const s = await sentVersion();
      await owner('alter table public.deals drop constraint deals_removed_imported_only');
      await owner(`update public.deals set removed_at = now(), removed_reason = 'stage_not_eligible' where id = $1`, [DEAL]);
      await refused(OWNER, SQL.create, ['deal', DEAL, 'X', rid()], '55000', 'deal_removed');
      await refused(OWNER, SQL.newVersion, [s.quotationId, s.versionId, rid()], '55000', 'deal_removed');
    });
    await asOwner(db, async () => {
      const lost = await h.insertRealDeal('LOSE');
      await refused(OWNER, SQL.create, ['deal', lost, 'X', rid()], '55000', 'deal_not_active');
    });
  });
});

describe('hotel extra beds on booking items (freeze part 2 section 1)', () => {
  it('booking hotel items accept extraBeds, childrenWithoutBed and bedRemarks; bedRemarks is a choice field in revisions', async () => {
    await asOwner(db, async () => {
      const d = await h.draftWithTravellers();
      const added = await h.addItem(OWNER, d.versionId, d.rowVersion, 'hotel', { ...HOTEL, extraBeds: 1, childrenWithoutBed: 1, bedRemarks: 'Synthetic' });
      expect(added.itemId).toBeDefined();
      await expectHint(OWNER, 'select public.service_item_add($1, $2, $3, $4::jsonb, $5::bigint, $6) as r',
        [d.versionId, added.rowVersion, 'hotel', JSON.stringify({ ...HOTEL, childrenWithoutBed: -1 }), '0', rid()], '22023', 'invalid_input', /childrenWithoutBed/);
      expect(await owner(`select authz.revision_field_class('items.1.bedRemarks') as a, authz.revision_field_class('items.1.extraBeds') as b`))
        .toEqual([{ a: 'choice', b: 'material' }]);
    });
  });
});
