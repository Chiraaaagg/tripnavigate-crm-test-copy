import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYNTHETIC_INTAKE_CONFIG, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { OWNER, rid } from './b1-support';
import { B3, batch3Helpers } from './batch3-support';

/**
 * Contract F.1.4 case 6 (owner handoff 19 Oct, condition A) on a referral
 * draft (migration 20261123000100 with Batch 2's value-free history): a
 * referral quotation created with a mobile; staff clear the mobile and type
 * then clear a trip start; the draft is linked to a Deal with a Bitrix
 * snapshot; "Fill empty fields from Bitrix" fills only fields never written
 * and skips both cleared fields; "Use it" on a cleared field is refused;
 * linking itself writes no field. Synthetic data; rolled back.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = batch3Helpers(() => db);
const { one, refused, owner } = h;
const FILL = 'select public.prefill_fill_empty($1, $2, $3) as r';
const Q_APPLY = 'select public.quotation_prefill_apply($1, $2, $3::text[]) as r';

type Fill = { rowVersion: number; filled: string[]; skipped: Array<{ field: string; reason: string }> };

async function dealWithFacts(sourceDealId: number): Promise<string> {
  await h.setSwitch('service_items_enabled', true);
  await owner('update public.integration_intake_config set bitrix_trip_facts_read = true where id = $1', [SYNTHETIC_INTAKE_CONFIG]);
  const deal = await h.insertRealDeal('UC_AD0SLH', 0, sourceDealId);
  await owner(
    `insert into public.deal_source_trip_facts (deal_id, legal_entity_id, booking_notes, traveller_total, tour_start, tour_end,
       customer_type_enum_id, source_contact_id, source_company_id, source_modified_at)
     select d.id, d.legal_entity_id, 'Synthetic notes: sea view please', 4, '2026-12-10'::date, '2026-12-14'::date, '3045', 501, 601,
            now() - interval '2 days'
     from public.deals d where d.id = $1`, [deal]);
  await owner(
    `insert into public.bitrix_party_snapshots (legal_entity_id, source_portal, party_kind, source_party_id, display_name, phones, emails)
     select d.legal_entity_id, 'SYNTHETIC_MEMBER_0001', k.kind, k.id, k.name, k.phones, k.emails
     from public.deals d,
          (values ('contact', 501::bigint, 'Synthetic Bitrix Contact', array['+91 98765 00033']::text[], array['bitrix.contact@example.test']::text[]),
                  ('company', 601::bigint, 'Synthetic Bitrix Company', array[]::text[], array[]::text[])) as k(kind, id, name, phones, emails)
     where d.id = $1
     on conflict (source_portal, party_kind, source_party_id) do update set phones = excluded.phones, emails = excluded.emails`, [deal]);
  return deal;
}

describe('F.1.4 case 6: deliberate clearing on a referral draft quotation is never undone', () => {
  it('only never-written fields fill after linking; both cleared fields stay empty', async () => {
    await asOwner(db, async () => {
      await h.referralSwitch(true);
      await owner('update public.workflow_settings set prefill_auto_fill = true where id');
      const s = await h.standalone(OWNER, { customerName: 'Synthetic Referral Customer', mobile: '9876500101' });
      // Staff clear the mobile (an e-mail is required instead) and type, then clear, a trip start.
      let rv = (await one<{ rowVersion: number }>(OWNER, B3.qContacts, [s.versionId, s.rowVersion, JSON.stringify(
        { contactName: 'Synthetic Referral Customer', mobile: null, email: 'typed@example.test', companyName: null })])).rowVersion;
      rv = (await one<{ rowVersion: number }>(OWNER, B3.qSave, [s.versionId, rv, JSON.stringify({ start: '2026-12-01' })])).rowVersion;
      rv = (await one<{ rowVersion: number }>(OWNER, B3.qSave, [s.versionId, rv, JSON.stringify({ start: null })])).rowVersion;
      // Not linked yet: there is no Bitrix record to fill from.
      await refused(OWNER, FILL, ['quotation_version', s.versionId, rv], '55000', 'prefill_unavailable');
      const unlinked = await one<{ prefill: unknown }>(OWNER, B3.qGet, [s.versionId]);
      expect(unlinked.prefill).toBeNull();

      const deal = await dealWithFacts(975001);
      const before = await owner('select count(*)::int as n from public.prefill_marks where target_id = $1', [s.versionId]);
      await h.linkDeal(OWNER, s.referralDraftId, deal);
      // Linking writes no field and no mark (F.1.3).
      expect(await owner('select count(*)::int as n from public.prefill_marks where target_id = $1', [s.versionId])).toEqual(before);
      const [qv] = await owner<{ row_version: number; trip_start: string | null }>(
        'select row_version, trip_start::text from public.quotation_versions where id = $1', [s.versionId]);
      expect(qv).toEqual({ row_version: rv, trip_start: null });

      const fill = await one<Fill>(OWNER, FILL, ['quotation_version', s.versionId, rv]);
      expect(fill.filled.sort()).toEqual(['contacts.bookingFor', 'contacts.companyName', 'requirementsNote', 'trip.end']);
      const skipped = Object.fromEntries(fill.skipped.map((x) => [x.field, x.reason]));
      expect(skipped).toEqual({ 'trip.start': 'cleared_by_staff', 'contacts.mobile': 'cleared_by_staff' });
      const [after] = await owner<{ trip_start: string | null; trip_end: string | null; mobile: string | null; email: string | null; company_name: string | null }>(
        `select v.trip_start::text, v.trip_end::text, c.mobile, c.email, c.company_name
         from public.quotation_versions v join public.quotation_version_contacts c on c.quotation_version_id = v.id where v.id = $1`, [s.versionId]);
      expect(after).toEqual({ trip_start: null, trip_end: '2026-12-14', mobile: null, email: 'typed@example.test',
        company_name: 'Synthetic Bitrix Company' });
      // "Use it" on a cleared, still empty field is refused cleared_by_staff (F.1.3, Echo M1).
      const apply = await one<{ applied: string[]; skipped: Array<{ field: string; reason: string }> }>(OWNER, Q_APPLY,
        [s.versionId, fill.rowVersion, ['contacts.mobile', 'trip.start']]);
      expect(apply.skipped).toEqual(expect.arrayContaining([{ field: 'contacts.mobile', reason: 'cleared_by_staff' },
        { field: 'trip.start', reason: 'cleared_by_staff' }]));
      // A second Fill and a read change nothing more.
      const again = await one<Fill>(OWNER, FILL, ['quotation_version', s.versionId,
        (await owner<{ row_version: number }>('select row_version from public.quotation_versions where id = $1', [s.versionId]))[0]!.row_version]);
      expect(again.filled).toEqual([]);
      const read = await one<{ prefill: { available: boolean } | null }>(OWNER, B3.qGet, [s.versionId]);
      expect(read.prefill).toMatchObject({ available: true });
      void rid;
    });
  });
});
