import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, FIXTURE_USERS as U, SYNTHETIC_INTAKE_CONFIG, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { ACCOUNTS, CHECKLIST_SQL, MANAGER, OWNER, PURCHASE, SALES_B, SUPER, rid } from './b1-support';
import { b11Helpers } from './b11-support';

/**
 * B1.2 prefill landing (migration 20261120000600_b12_prefill, freeze part 2
 * section 4): staff copy stored Bitrix values (Nova 0400 snapshot) into a
 * booking draft or quotation version; marks from_bitrix / checked / changed;
 * prefill_unchecked is a warning; Customer Type shown as code only and never
 * fills "booking for"; contacts stay unconfirmed; editors only.
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

const APPLY = 'select public.booking_prefill_apply($1, $2, $3::text[]) as r';
const Q_APPLY = 'select public.quotation_prefill_apply($1, $2, $3::text[]) as r';
const CHECK = 'select public.prefill_mark_checked($1, $2, $3, $4::text[]) as r';
const FORM = 'select public.booking_form_get($1) as r';

type Prefill = {
  available: boolean; issues: string[];
  fields: { bookingNotes: string | null; travellerTotal: number | null; tourStart: string | null; tourEnd: string | null;
    customerType: { code: string | null } | null; contact: { name: string; mobile: string | null; email: string | null } | null;
    company: { name: string } | null };
  marks: Array<{ fieldCode: string; state: string }>;
  unchecked?: string[];
};
type Applied = { rowVersion: number; applied: string[]; skipped: Array<{ field: string; reason: string }> };

const switchOn = (on = true) => owner('update public.integration_intake_config set bitrix_trip_facts_read = $2 where id = $1', [SYNTHETIC_INTAKE_CONFIG, on]);

/** An imported Deal with stored Bitrix trip facts, a linked contact and company, and an open package draft. */
async function dealWithFacts(phone = '+91 98765 00033', start = '2026-12-10', end = '2026-12-14') {
  await h.setSwitch('service_items_enabled', true);
  await switchOn();
  const deal = await h.insertRealDeal('UC_AD0SLH');
  await owner(
    `insert into public.deal_source_trip_facts (deal_id, legal_entity_id, booking_notes, traveller_total, tour_start, tour_end,
       customer_type_enum_id, source_contact_id, source_company_id, source_modified_at)
     select d.id, d.legal_entity_id, 'Synthetic notes: sea view please', 4, $2::date, $3::date, '3045', 501, 601, now()
     from public.deals d where d.id = $1`, [deal, start, end]);
  await owner(
    `insert into public.bitrix_party_snapshots (legal_entity_id, source_portal, party_kind, source_party_id, display_name, phones, emails)
     select d.legal_entity_id, 'SYNTHETIC_MEMBER_0001', k.kind, k.id, k.name, k.phones, k.emails
     from public.deals d,
          (values ('contact', 501::bigint, 'Synthetic Bitrix Contact', array[$2]::text[], array['bitrix.contact@example.test']::text[]),
                  ('company', 601::bigint, 'Synthetic Bitrix Company', array[]::text[], array[]::text[])) as k(kind, id, name, phones, emails)
     where d.id = $1
     on conflict (source_portal, party_kind, source_party_id) do update set phones = excluded.phones`, [deal, phone]);
  const opened = await h.openDraft(OWNER, deal);
  return { deal, versionId: opened.versionId, rowVersion: opened.rowVersion };
}
const form = async (actor: Actor, deal: string) => (await h.run<{ r: Record<string, unknown> | null }>(actor, FORM, [deal]))[0]!.r;

describe('booking prefill', () => {
  it('shows the Bitrix values (Customer Type as code only); unavailable while the switch is off', async () => {
    await asOwner(db, async () => {
      const d = await dealWithFacts();
      const p = (await form(OWNER, d.deal))!.prefill as Prefill;
      expect(p).toMatchObject({ available: true, marks: [] });
      expect(p.fields).toMatchObject({ bookingNotes: 'Synthetic notes: sea view please', travellerTotal: 4, tourStart: '2026-12-10',
        tourEnd: '2026-12-14', customerType: { code: 'b2d' }, contact: { name: 'Synthetic Bitrix Contact', mobile: '+91 98765 00033' } });
      expect(JSON.stringify(p.fields.customerType)).not.toContain('3045');
      await switchOn(false);
      const off = (await form(OWNER, d.deal))!.prefill as Prefill;
      expect(off.available).toBe(false);
      expect(off.fields.bookingNotes).toBeNull();
      await refused(OWNER, APPLY, [d.versionId, d.rowVersion, ['trip.start']], '55000', 'prefill_unavailable');
    });
  });

  it('applies trip dates and the contact (unconfirmed, booking for untouched by Customer Type); warning until checked; a later edit marks changed', async () => {
    await asOwner(db, async () => {
      const d = await dealWithFacts();
      const r = await one<Applied>(OWNER, APPLY, [d.versionId, d.rowVersion,
        ['trip.start', 'trip.end', 'contacts.contactName', 'contacts.mobile', 'contacts.email']]);
      expect(r.applied.sort()).toEqual(['contacts.contactName', 'contacts.email', 'contacts.mobile', 'trip.end', 'trip.start']);
      expect(r.skipped).toEqual([]);
      expect(r.rowVersion).toBeGreaterThan(d.rowVersion); // booking_trip_save (same rules, review E5-2) and the final bump
      expect(await h.count(`select 1 from public.audit_events where action = 'booking.trip_saved'`)).toBe(1);
      expect(await owner(`select trip_start::text as s, trip_end::text as e from public.booking_versions where id = $1`, [d.versionId]))
        .toEqual([{ s: '2026-12-10', e: '2026-12-14' }]);
      expect(await owner(`select contact_name, mobile, email, contact_confirmed, booking_for from public.booking_version_contacts where booking_version_id = $1`, [d.versionId]))
        .toEqual([{ contact_name: 'Synthetic Bitrix Contact', mobile: '9876500033', email: 'bitrix.contact@example.test', contact_confirmed: false, booking_for: 'individual' }]);
      let list = await one<{ items: Array<{ code: string; blocking: boolean; fields?: string[] }> }>(OWNER, CHECKLIST_SQL, [d.deal]);
      expect(list.items.find((i) => i.code === 'prefill_unchecked')).toMatchObject({ blocking: false, fields: expect.arrayContaining(['trip.start', 'contacts.mobile']) });
      expect(list.items.find((i) => i.code === 'contact_not_confirmed')).toMatchObject({ blocking: true });
      const checked = await one<{ checked: string[] }>(OWNER, CHECK, ['booking_version', d.versionId, r.rowVersion,
        ['trip.start', 'trip.end', 'contacts.contactName', 'contacts.mobile', 'contacts.email']]);
      expect(checked.checked).toHaveLength(5);
      list = await one(OWNER, CHECKLIST_SQL, [d.deal]);
      expect(list.items.map((i) => i.code)).not.toContain('prefill_unchecked');
      await h.saveTrip(OWNER, d.versionId, r.rowVersion, { destination: 'Synthetic City', scope: 'domestic', start: '2026-12-11', end: '2026-12-14' });
      const marks = ((await form(OWNER, d.deal))!.prefill as Prefill).marks;
      expect(marks.find((m) => m.fieldCode === 'trip.start')!.state).toBe('changed');
      expect(marks.find((m) => m.fieldCode === 'trip.end')!.state).toBe('checked');
      const audits = JSON.stringify(await owner(`select details from public.audit_events where action in ('booking.prefill_applied', 'prefill.checked')`));
      expect(audits).not.toMatch(/Synthetic Bitrix|9876500033|bitrix\.contact|sea view/);
    });
  });

  it('skips with reasons: unusable mobile, end before start, no contact name; refuses unknown fields and stale row versions', async () => {
    await asOwner(db, async () => {
      const d = await dealWithFacts('12345', '2026-12-10', '2026-12-14');
      await h.saveTrip(OWNER, d.versionId, d.rowVersion, { destination: 'X', scope: 'domestic', start: '2026-12-20', end: '2026-12-25' });
      const r = await one<Applied>(OWNER, APPLY, [d.versionId, d.rowVersion + 1, ['trip.end', 'contacts.mobile']]);
      expect(r.applied).toEqual([]);
      expect(r.skipped).toEqual(expect.arrayContaining([{ field: 'trip.end', reason: 'date_order' }, { field: 'contacts.mobile', reason: 'mobile_format' }]));
      await refused(OWNER, APPLY, [d.versionId, r.rowVersion, ['bookingFor']], '22023', 'invalid_input');
      await refused(OWNER, APPLY, [d.versionId, 1, ['trip.start']], '40001', 'version_changed');
    });
  });

  it('editors only: Purchase, Accounts, Super Admin and other Sales get nothing; Manager may apply', async () => {
    await asOwner(db, async () => {
      const d = await dealWithFacts();
      for (const actor of [PURCHASE, ACCOUNTS, SUPER, SALES_B]) {
        await refused(actor, APPLY, [d.versionId, d.rowVersion, ['trip.start']], '42501', 'not_authorized');
        await refused(actor, CHECK, ['booking_version', d.versionId, d.rowVersion, ['trip.start']], '42501', 'not_authorized');
        expect(await form(actor, d.deal)).toBeNull();
      }
      expect((await one<Applied>(MANAGER, APPLY, [d.versionId, d.rowVersion, ['trip.start']])).applied).toEqual(['trip.start']);
    });
  });
});

describe('review E5', () => {
  it('E5-1: no value or value hash is stored; a write outside the apply marks the field changed', async () => {
    await asOwner(db, async () => {
      const cols = (await owner<{ c: string }>(`select column_name as c from information_schema.columns where table_schema = 'public' and table_name = 'prefill_marks'`)).map((r) => r.c);
      expect(cols.filter((c) => /value|hash/.test(c))).toEqual([]);
      const d = await dealWithFacts();
      const r = await one<Applied>(OWNER, APPLY, [d.versionId, d.rowVersion, ['contacts.contactName', 'contacts.mobile']]);
      await one(OWNER, 'select public.booking_contacts_save($1, $2, $3::jsonb) as r', [d.versionId, r.rowVersion, JSON.stringify({
        contactName: 'Synthetic Bitrix Contact', mobile: '9876500099', email: null, contactConfirmed: false, bookingFor: 'individual',
        payerDifferent: false, payerName: null })]);
      const marks = ((await form(OWNER, d.deal))!.prefill as Prefill).marks;
      expect(marks).toEqual([expect.objectContaining({ fieldCode: 'contacts.contactName', state: 'from_bitrix' }),
        expect.objectContaining({ fieldCode: 'contacts.mobile', state: 'changed' })]);
    });
  });

  it('E5-3: Booking Notes only with commercial scope (form and quotation copy)', async () => {
    await asOwner(db, async () => {
      const d = await dealWithFacts();
      const q = await one<{ versionId: string; rowVersion: number }>(OWNER, 'select public.quotation_create($1, $2, $3, $4) as r',
        ['deal', d.deal, 'Synthetic quote', rid()]);
      await owner(`delete from public.role_permissions where role_code = 'sales' and permission_code = 'deal.read_commercial'`);
      const p = (await form(OWNER, d.deal))!.prefill as Prefill & { notesHidden: boolean };
      expect(p).toMatchObject({ available: true, notesHidden: true });
      expect(p.fields.bookingNotes).toBeNull();
      const r = await one<Applied>(OWNER, Q_APPLY, [q.versionId, q.rowVersion, ['requirementsNote']]);
      expect(r.skipped).toEqual([{ field: 'requirementsNote', reason: 'not_allowed' }]);
    });
  });

  it('E5-2: the contact goes through the same validation as the screen (b11_contacts_write)', async () => {
    await asOwner(db, async () => {
      const d = await dealWithFacts();
      await owner(`update public.bitrix_party_snapshots set display_name = $1 where party_kind = 'contact'`, ['x'.repeat(200)]);
      const r = await one<Applied>(OWNER, APPLY, [d.versionId, d.rowVersion, ['contacts.contactName', 'contacts.email']]);
      expect(r.applied).toEqual(['contacts.contactName', 'contacts.email']); // name trimmed to the 120-character rule
      expect(await owner(`select length(contact_name) as n, contact_confirmed from public.booking_version_contacts where booking_version_id = $1`, [d.versionId]))
        .toEqual([{ n: 120, contact_confirmed: false }]);
      expect(await h.count(`select 1 from public.audit_events where action = 'booking.contacts_saved'`)).toBe(0); // b11_contacts_write has no own audit
    });
  });
});

describe('DEC-45: Customer Type fills "booking for: business"', () => {
  it('booking: a known type fills business (marked); an unknown type fills nothing', async () => {
    await asOwner(db, async () => {
      const d = await dealWithFacts();
      const r = await one<Applied>(OWNER, APPLY, [d.versionId, d.rowVersion, ['contacts.contactName', 'contacts.mobile', 'contacts.bookingFor']]);
      expect(r.applied).toEqual(expect.arrayContaining(['contacts.bookingFor']));
      expect(await owner('select booking_for, contact_confirmed from public.booking_version_contacts where booking_version_id = $1', [d.versionId]))
        .toEqual([{ booking_for: 'business', contact_confirmed: false }]);
      const marks = ((await form(OWNER, d.deal))!.prefill as Prefill).marks;
      expect(marks.find((m) => m.fieldCode === 'contacts.bookingFor')!.state).toBe('from_bitrix');
      await owner(`update public.deal_source_trip_facts set customer_type_enum_id = '9999' where deal_id = $1`, [d.deal]);
      const again = await one<Applied>(OWNER, APPLY, [d.versionId, r.rowVersion, ['contacts.bookingFor']]);
      expect(again.skipped).toEqual([{ field: 'contacts.bookingFor', reason: 'no_value' }]);
    });
  });

  it('quotation: business is stored on the quotation contact and kept by a later contact save', async () => {
    await asOwner(db, async () => {
      const d = await dealWithFacts();
      const q = await one<{ versionId: string; rowVersion: number }>(OWNER, 'select public.quotation_create($1, $2, $3, $4) as r',
        ['deal', d.deal, 'Synthetic quote', rid()]);
      const r = await one<Applied>(OWNER, Q_APPLY, [q.versionId, q.rowVersion, ['contacts.contactName', 'contacts.mobile', 'contacts.bookingFor']]);
      expect(r.applied).toEqual(expect.arrayContaining(['contacts.bookingFor']));
      const got = await one<{ contacts: Record<string, unknown> }>(OWNER, 'select public.quotation_get($1) as r', [q.versionId]);
      expect(got.contacts).toMatchObject({ bookingFor: 'business' });
      // A later contact save without bookingFor keeps it.
      await one(OWNER, 'select public.quotation_contacts_save($1, $2, $3::jsonb) as r', [q.versionId, r.rowVersion,
        JSON.stringify({ contactName: 'Synthetic Bitrix Contact', mobile: '9876500033', email: null, companyName: null })]);
      expect((await one<{ contacts: Record<string, unknown> }>(OWNER, 'select public.quotation_get($1) as r', [q.versionId])).contacts)
        .toMatchObject({ bookingFor: 'business' });
    });
  });
});

describe('quotation prefill', () => {
  it('copies Booking Notes into the requirements note on request, the contact and the company; unchecked list on quotation_get', async () => {
    await asOwner(db, async () => {
      const d = await dealWithFacts();
      const q = await one<{ quotationId: string; versionId: string; rowVersion: number }>(OWNER, 'select public.quotation_create($1, $2, $3, $4) as r',
        ['deal', d.deal, 'Synthetic quote', rid()]);
      const r = await one<Applied>(OWNER, Q_APPLY, [q.versionId, q.rowVersion,
        ['requirementsNote', 'trip.start', 'trip.end', 'contacts.contactName', 'contacts.mobile', 'contacts.companyName']]);
      expect(r.applied.sort()).toEqual(['contacts.companyName', 'contacts.contactName', 'contacts.mobile', 'requirementsNote', 'trip.end', 'trip.start']);
      const got = await one<{ requirementsNote: string; contacts: Record<string, unknown>; prefill: Prefill }>(OWNER, 'select public.quotation_get($1) as r', [q.versionId]);
      expect(got.requirementsNote).toBe('Synthetic notes: sea view please');
      expect(got.contacts).toMatchObject({ contactName: 'Synthetic Bitrix Contact', mobile: '9876500033', companyName: 'Synthetic Bitrix Company' });
      expect(got.prefill.unchecked).toHaveLength(6);
      expect(got.prefill.fields.customerType).toEqual({ code: 'b2d' });
      await one(OWNER, CHECK, ['quotation_version', q.versionId, r.rowVersion, ['requirementsNote']]);
      expect((await one<{ prefill: Prefill }>(OWNER, 'select public.quotation_get($1) as r', [q.versionId])).prefill.unchecked).toHaveLength(5);
      await refused(PURCHASE, Q_APPLY, [q.versionId, r.rowVersion, ['trip.start']], '42501', 'not_authorized');
    });
  });

  it('a Lead quotation has no trip facts in Bitrix: dates and notes are skipped no_value', async () => {
    await asOwner(db, async () => {
      await switchOn();
      const [inbox] = await owner<{ id: string }>(
        `insert into public.integration_inbox (portal_member_id, event_type, source_deal_id, source_ts, dedupe_key, status, processed_at)
         values ('SYNTHETIC_MEMBER_0001', 'ONCRMDEALADD', 880001, 1, repeat('d', 58) || '880001', 'processed', now()) returning id`);
      const [lead] = await owner<{ id: string }>(
        `insert into public.crm_leads (legal_entity_id, branch_id, reference, title, owner_user_id, source_portal, source_lead_id,
           source_status_id, source_id_code, source_created_at, source_modified_at, last_synced_at, last_verified_at, intake_inbox_id,
           manifest_id, intake_mode)
         select b.legal_entity_id, b.id, 'BXL-880001', 'Synthetic lead', $1, 'SYNTHETIC_MEMBER_0001', 880001, 'NEW', 'WEBFORM',
                now(), now(), now(), now(), $2, null, 'scope'
         from public.branches b join public.legal_entities e on e.id = b.legal_entity_id where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL'
         returning id`, [U.salesDelhiA, inbox!.id]);
      await owner(`insert into public.lead_source_facts (lead_id, legal_entity_id, customer_type_enum_id, company_title, source_modified_at)
                   select l.id, l.legal_entity_id, '5053', 'Synthetic Lead Company', now() from public.crm_leads l where l.id = $1`, [lead!.id]);
      const q = await one<{ versionId: string; rowVersion: number }>(OWNER, 'select public.quotation_create($1, $2, $3, $4) as r',
        ['lead', lead!.id, 'Synthetic lead quote', rid()]);
      const r = await one<Applied>(OWNER, Q_APPLY, [q.versionId, q.rowVersion, ['trip.start', 'requirementsNote', 'contacts.companyName']]);
      expect(r.applied).toEqual([]);
      expect(r.skipped).toEqual(expect.arrayContaining([{ field: 'trip.start', reason: 'no_value' }, { field: 'requirementsNote', reason: 'no_value' },
        { field: 'contacts.companyName', reason: 'contact_name_missing' }]));
      const got = await one<{ prefill: Prefill }>(OWNER, 'select public.quotation_get($1) as r', [q.versionId]);
      expect(got.prefill.fields.customerType).toEqual({ code: 'corporate' });
    });
  });
});
