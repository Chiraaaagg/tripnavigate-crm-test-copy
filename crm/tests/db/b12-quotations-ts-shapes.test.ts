import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BookingFormSchema } from '@/modules/fulfilment/b11-commands';
import { IntakeChecklistSchema, ISSUE_CODES } from '@/modules/fulfilment/commands';
import { LinkCandidatesSchema, QuotationGetSchema, QuotationListSchema, quotationLinesPayload } from '@/modules/quotations/commands';
import { toQuotationListView, toQuotationVersionView } from '@/modules/quotations/dto';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { CHECKLIST_SQL, DEAL, HOTEL, OWNER, TRANSFER, rid } from './b1-support';
import { b11Helpers } from './b11-support';

/**
 * The quotation TS layer against the real 0200 replies (PGlite, synthetic):
 * every reply the screens read goes through the same zod schemas and DTOs
 * the loaders use (quotation_list, quotation_get at each state, link
 * candidates), and the converted booking draft still parses through the
 * Book now read and the checklist (hotel extras, quote readiness codes).
 * Every case rolled back.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b11Helpers(() => db);
const { one, owner } = h;
const SHA = 'f'.repeat(64);

const SQL = {
  create: 'select public.quotation_create($1, $2, $3, $4) as r',
  save: 'select public.quotation_version_save($1, $2, $3::jsonb) as r',
  tiers: 'select public.quotation_tiers_save($1, $2, $3::jsonb) as r',
  itemAdd: 'select public.quotation_item_add($1, $2, $3, $4, $5::jsonb) as r',
  lines: 'select public.quotation_lines_save($1, $2, $3::jsonb) as r',
  total: 'select public.quotation_total_save($1, $2, $3, $4::bigint, $5) as r',
  contacts: 'select public.quotation_contacts_save($1, $2, $3::jsonb) as r',
  ready: 'select public.quotation_mark_ready($1, $2) as r',
  sent: 'select public.quotation_mark_sent($1, $2, $3, $4) as r',
  evBegin: 'select public.quotation_evidence_begin($1, $2, $3, $4, $5, $6) as r',
  evFinish: 'select public.quotation_evidence_finish($1, $2) as r',
  accept: 'select public.quotation_accept($1, $2, $3, $4, $5) as r',
  convert: 'select public.quotation_convert_to_booking($1, $2, $3) as r',
  list: 'select public.quotation_list($1, $2) as r',
  get: 'select public.quotation_get($1) as r',
  candidates: 'select public.quotation_link_candidates($1) as r',
};

const getView = async (versionId: string) => toQuotationVersionView(QuotationGetSchema.parse(await one(OWNER, SQL.get, [versionId])));

describe('quotation replies parse through the TS schemas and DTOs', () => {
  it('draft → ready → sent → accepted → converted; list; candidates; the converted booking draft still loads', async () => {
    await asOwner(db, async () => {
      await h.setSwitch('service_items_enabled', true);
      const q = await one<{ quotationId: string; versionId: string; rowVersion: number }>(OWNER, SQL.create, ['deal', DEAL, 'Synthetic shapes quotation', rid()]);

      const draft = await getView(q.versionId);
      expect(draft).toMatchObject({ status: 'draft', canEdit: true, canMarkReady: true, canSend: false, contentHash: null, contact: null });
      expect(draft.issues).toEqual(expect.arrayContaining(['trip_missing', 'pax_missing', 'no_items', 'contact_missing']));

      let rv = (
        await one<{ rowVersion: number }>(OWNER, SQL.save, [
          q.versionId,
          q.rowVersion,
          JSON.stringify({
            destination: 'Synthetic City',
            scope: 'domestic',
            start: '2026-12-10',
            end: '2026-12-13',
            adults: 2,
            childrenWithBed: 1,
            content: { days: [{ day: 1, title: 'Arrive' }], includes: ['Breakfast'], excludes: [], terms: ['Synthetic term'] },
          }),
        ])
      ).rowVersion;
      rv = (await one<{ rowVersion: number }>(OWNER, SQL.contacts, [q.versionId, rv, JSON.stringify({ contactName: 'Synthetic Contact', mobile: '9876500033', email: null, companyName: null })])).rowVersion;
      rv = (await one<{ rowVersion: number }>(OWNER, SQL.tiers, [q.versionId, rv, JSON.stringify([{ tierKey: 'quoted', label: 'Deluxe' }, { tierKey: 'upgrade', label: 'Luxury' }])])).rowVersion;
      const quotedHotel = await one<{ itemId: string; rowVersion: number }>(OWNER, SQL.itemAdd, [q.versionId, rv, 'hotel', 'quoted', JSON.stringify(HOTEL)]);
      rv = quotedHotel.rowVersion;
      const upgradeHotel = await one<{ itemId: string; rowVersion: number }>(OWNER, SQL.itemAdd, [
          q.versionId,
          rv,
          'hotel',
          'upgrade',
          JSON.stringify({ ...HOTEL, hotelName: 'Synthetic Luxury Hotel', extraBeds: 1, childrenWithoutBed: 1, bedRemarks: 'Synthetic extra bed' }),
        ]);
      rv = upgradeHotel.rowVersion;
      const transfer = await one<{ itemId: string; rowVersion: number }>(OWNER, SQL.itemAdd, [q.versionId, rv, 'transfer', null, JSON.stringify(TRANSFER)]);
      rv = transfer.rowVersion;

      // Money (Mercury 0300) through the same payload the TS action sends.
      rv = (
        await one<{ rowVersion: number }>(OWNER, SQL.lines, [
          q.versionId,
          rv,
          JSON.stringify(
            quotationLinesPayload([
              { lineNo: 1, optionKey: 'quoted', itemId: quotedHotel.itemId, chargeKind: 'main', categoryKey: 'hotels', description: 'Synthetic hotel', unitKind: 'room_night', units: 1, periods: 3, unitSellPaise: '450000', unitCostPaise: '380050', remark: null },
              { lineNo: 2, optionKey: 'upgrade', itemId: upgradeHotel.itemId, chargeKind: 'main', categoryKey: 'hotels', description: 'Synthetic luxury hotel', unitKind: 'room_night', units: 1, periods: 3, unitSellPaise: '900000', unitCostPaise: null, remark: null },
              { lineNo: 3, optionKey: 'upgrade', itemId: upgradeHotel.itemId, chargeKind: 'extra_bed', categoryKey: 'hotels', description: 'Extra bed', unitKind: 'night', units: 1, periods: 3, unitSellPaise: '100000', unitCostPaise: null, remark: 'Synthetic remark' },
              { lineNo: 4, optionKey: 'common', itemId: transfer.itemId, chargeKind: 'main', categoryKey: 'transfers', description: 'Synthetic transfer', unitKind: 'trip', units: 1, periods: 2, unitSellPaise: '200000', unitCostPaise: '150000', remark: null },
            ]),
          ),
        ])
      ).rowVersion;
      rv = (await one<{ rowVersion: number }>(OWNER, SQL.total, [q.versionId, rv, 'quoted', '1800000', true])).rowVersion;
      rv = (await one<{ rowVersion: number }>(OWNER, SQL.total, [q.versionId, rv, 'upgrade', '3500000', true])).rowVersion;

      const filled = await getView(q.versionId);
      expect(filled).toMatchObject({ travellerCount: 3, content: { days: [{ day: 1, title: 'Arrive', text: null }], includes: ['Breakfast'], notes: null } });
      expect(filled.tiers.map((t) => t.tierKey)).toEqual(['quoted', 'upgrade']);
      expect(filled.items.map((i) => [i.itemNo, i.serviceType, i.tierKey, i.factsValid])).toEqual([
        [1, 'hotel', 'quoted', true],
        [2, 'hotel', 'upgrade', true],
        [3, 'transfer', null, true],
      ]);
      expect(filled.items[1]!.service).toMatchObject({ type: 'hotel', facts: { extraBeds: 1, childrenWithoutBed: 1, bedRemarks: 'Synthetic extra bed' } });
      expect(filled.canEditMoney).toBe(true);
      expect(filled.money!.lines.map((l) => [l.lineNo, l.optionKey, l.unitKind, l.lineSellPaise, l.lineCostPaise])).toEqual([
        [1, 'quoted', 'room_night', '1350000', '1140150'],
        [2, 'upgrade', 'room_night', '2700000', null],
        [3, 'upgrade', 'night', '300000', null],
        [4, 'common', 'trip', '400000', '300000'],
      ]);
      const quotedMoney = filled.money!.tiers.find((t) => t.tierKey === 'quoted')!;
      expect(quotedMoney).toMatchObject({ quotedTotalPaise: '1800000', componentSellPaise: '1750000', componentDifferencePaise: '50000', costTotalPaise: '1440150', payingTravellers: 3, perPersonPaise: '600000' });
      expect(filled.money!.tiers.find((t) => t.tierKey === 'upgrade')).toMatchObject({ quotedTotalPaise: '3500000', componentSellPaise: '3400000', costComplete: false, perPersonPaise: null });
      expect(filled.money!.issues).toEqual(expect.arrayContaining(['component_mismatch']));

      const ready = await one<{ contentHash: string }>(OWNER, SQL.ready, [q.versionId, rv]);
      expect(await getView(q.versionId)).toMatchObject({ status: 'ready', canSend: true, canMarkReady: false, contentHash: ready.contentHash });
      await one(OWNER, SQL.sent, [q.versionId, ready.contentHash, 'whatsapp', rid()]);
      const sent = await getView(q.versionId);
      expect(sent).toMatchObject({ status: 'sent', canEdit: false, canUploadEvidence: true, canAccept: false, canDecline: true, sent: { channel: 'whatsapp' } });

      const ev = await one<{ evidenceId: string; objectPath: string }>(OWNER, SQL.evBegin, [q.versionId, 'acceptance_message', 'acceptance.pdf', 'application/pdf', 2048, SHA]);
      await owner(`insert into storage.objects (bucket_id, name, metadata) values ('quotation-evidence', $1, jsonb_build_object('size', 2048::bigint))`, [ev.objectPath]);
      await one(OWNER, SQL.evFinish, [ev.evidenceId, true]);
      const withProof = await getView(q.versionId);
      expect(withProof).toMatchObject({ canAccept: true, evidence: [{ evidenceId: ev.evidenceId, kind: 'acceptance_message', status: 'stored', downloadHref: `/app/quotations/evidence/${ev.evidenceId}` }] });

      await one(OWNER, SQL.accept, [q.versionId, ready.contentHash, ev.evidenceId, 'upgrade', rid()]);
      expect(await getView(q.versionId)).toMatchObject({ status: 'accepted', accepted: { tierKey: 'upgrade' }, canConvert: true, canLinkDeal: false, canNewVersion: true });

      const conv = await one<{ bookingVersionId: string }>(OWNER, SQL.convert, [q.versionId, ready.contentHash, rid()]);
      const converted = await getView(q.versionId);
      expect(converted.quotationRowVersion).toBeGreaterThanOrEqual(1);
      expect(converted).toMatchObject({ canConvert: false, canNewVersion: false, conversion: { dealId: DEAL, bookingVersionId: conv.bookingVersionId } });

      const rawList = QuotationListSchema.parse(await one(OWNER, SQL.list, ['deal', DEAL]));
      expect(rawList[0]!.versions[0]).toMatchObject({ versionId: q.versionId, acceptedTier: 'upgrade', acceptedAt: expect.any(String) });
      const list = toQuotationListView('deal', DEAL, rawList);
      expect(list.quotations[0]).toMatchObject({ quotationId: q.quotationId, converted: true, bookingVersionId: conv.bookingVersionId, currentVersionId: q.versionId });
      expect(LinkCandidatesSchema.parse(await one(OWNER, SQL.candidates, [q.quotationId]))).toEqual([]); // Deal quotation: nothing to link

      // The converted booking draft still loads through the Book now read and the checklist.
      const form = BookingFormSchema.parse(await h.form(OWNER, DEAL));
      expect(form.sourceQuotation).toMatchObject({ quotationId: q.quotationId, versionId: q.versionId, acceptedTierKey: 'upgrade', acceptanceEvidenceId: ev.evidenceId });
      const hotel = form.items.find((i) => i.serviceType === 'hotel');
      expect(hotel?.facts).toMatchObject({ type: 'hotel', facts: { extraBeds: 1, childrenWithoutBed: 1, bedRemarks: 'Synthetic extra bed' } });
      const checklist = IntakeChecklistSchema.parse(await one(OWNER, CHECKLIST_SQL, [DEAL]));
      expect(checklist.items.length).toBeGreaterThan(0);
      const issues = (await h.readiness(OWNER, conv.bookingVersionId)).issues;
      for (const code of issues) expect(ISSUE_CODES as readonly string[], code).toContain(code);
    });
  });
});
