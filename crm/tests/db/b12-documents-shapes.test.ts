import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ItineraryFactsDraft } from '@/modules/documents/contracts';
import { compareTripFacts, compareTripFactsDetailed, DIFFERENCE_PATH } from '@/modules/documents/facts-diff';
import { toSaveableDifferences } from '@/modules/documents/value-hash';
import { basisFactsFromQuotation, ItineraryDocumentGetSchema, toAtlasFactsJson, toItineraryDocumentView, toItineraryFactsDraft } from '@/modules/documents/itinerary-view';
import { forbiddenKeyPaths } from '@/modules/documents/guard';
import { quotationToEngineQuote } from '@/modules/documents/quotation-adapter';
import { CustomerMoneySchema, QuotationGetSchema, toQuotationDocumentView } from '@/modules/documents/quotation-view';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { DEAL, HOTEL, OWNER, PURCHASE, TRANSFER, rid } from './b1-support';
import { b11Helpers } from './b11-support';
import { priceQuotationVersion } from './b12-quotation-money-support';

/**
 * B1.2 Phase F (Nova): the documents module's TypeScript shapes against the
 * real commands of 20261120000200 (quotation_get), 20261120000300
 * (quotation_customer_money) and 20261120000500 (itinerary_document_get,
 * itinerary_facts_save, itinerary_differences_save) on PGlite: the answers
 * parse, the view adapts, the facts round-trip and every difference path is
 * accepted and stored as computed. Synthetic fixtures only; rolled back.
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
type RV = { rowVersion: number };

async function pricedQuotation() {
  await h.setSwitch('service_items_enabled', true);
  const q = await one<{ quotationId: string; versionId: string; rowVersion: number }>(OWNER, 'select public.quotation_create($1, $2, $3, $4) as r',
    ['deal', DEAL, 'Synthetic shapes quote', rid()]);
  let rv = (await one<RV>(OWNER, 'select public.quotation_version_save($1, $2, $3::jsonb) as r', [q.versionId, q.rowVersion, JSON.stringify({
    destination: 'Synthetic City', scope: 'domestic', start: '2026-12-10', end: '2026-12-13', adults: 3, childrenWithBed: 1,
    content: { days: [], includes: ['Breakfast'], excludes: ['Lunch'] },
  })])).rowVersion;
  rv = (await one<RV>(OWNER, 'select public.quotation_contacts_save($1, $2, $3::jsonb) as r',
    [q.versionId, rv, JSON.stringify({ contactName: 'Synthetic Quote Contact', mobile: '9876500022', email: null, companyName: null })])).rowVersion;
  rv = (await one<RV>(OWNER, 'select public.quotation_item_add($1, $2, $3, $4, $5::jsonb) as r', [q.versionId, rv, 'hotel', 'quoted', JSON.stringify(HOTEL)])).rowVersion;
  rv = (await one<RV>(OWNER, 'select public.quotation_item_add($1, $2, $3, $4, $5::jsonb) as r', [q.versionId, rv, 'transfer', null, JSON.stringify(TRANSFER)])).rowVersion;
  rv = await priceQuotationVersion(one, owner, OWNER, q.versionId, rv);
  return { ...q, rowVersion: rv };
}

describe('quotation shapes', () => {
  it('DEC-48: a priced quotation basis prints its customer prices on the itinerary view (selling side only)', async () => {
    await asOwner(db, async () => {
      const q = await pricedQuotation();
      const doc = await one<{ documentId: string }>(OWNER, 'select public.itinerary_document_create($1, $2, $3, $4) as r',
        ['quotation', q.quotationId, 'Synthetic priced itinerary', rid()]);
      const got = ItineraryDocumentGetSchema.parse(await one(OWNER, 'select public.itinerary_document_get($1) as r', [doc.documentId]));
      const money = CustomerMoneySchema.parse(await one(OWNER, 'select public.quotation_customer_money($1) as r', [q.versionId]));
      const view = toItineraryDocumentView(got, { today: '2026-10-12' });
      const priced = money.tiers.filter((t) => t.quotedTotalPaise !== null);
      expect(priced.length).toBeGreaterThan(0);
      expect(view.prices!.map((t) => [t.tierKey, t.quotedTotalPaise])).toEqual(priced.map((t) => [t.tierKey, t.quotedTotalPaise]));
      expect(forbiddenKeyPaths(view)).toEqual([]);
    });
  });

  it('quotation_get and quotation_customer_money parse, map to a customer view and adapt', async () => {
    await asOwner(db, async () => {
      const q = await pricedQuotation();
      const get = QuotationGetSchema.parse(await one(OWNER, 'select public.quotation_get($1) as r', [q.versionId]));
      const money = CustomerMoneySchema.parse(await one(OWNER, 'select public.quotation_customer_money($1) as r', [q.versionId]));
      const view = toQuotationDocumentView(get, money, { preparedBy: { name: 'Synthetic', role: 'Travel consultant', phone: null }, today: '2026-10-12' });
      expect(view.tiers).toHaveLength(1);
      expect(view.tiers[0]).toMatchObject({ tierKey: 'quoted', quotedTotalPaise: '200000', payingTravellers: 4, breakdownHasAmounts: true });
      expect(view.stays).toEqual([expect.objectContaining({ city: 'Synthetic City', checkIn: '2026-12-10', checkOut: '2026-12-13', hotelName: 'Synthetic Hotel (fixture)' })]);
      const r = quotationToEngineQuote(view);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.input.price).toMatchObject({ total: 2000, perPerson: 500, paxCount: 4 });
      // Not an editor: both reads answer null.
      expect(await one(PURCHASE, 'select public.quotation_get($1) as r', [q.versionId])).toBeNull();
      expect(await one(PURCHASE, 'select public.quotation_customer_money($1) as r', [q.versionId])).toBeNull();
    });
  });
});

describe('itinerary shapes', () => {
  it('facts round-trip through itinerary_facts_save / itinerary_document_get; every computed difference is stored as is', async () => {
    await asOwner(db, async () => {
      const q = await pricedQuotation();
      const doc = await one<{ documentId: string; draftId: string; rowVersion: number }>(OWNER, 'select public.itinerary_document_create($1, $2, $3, $4) as r',
        ['quotation', q.quotationId, 'Synthetic shapes itinerary', rid()]);
      const basis = basisFactsFromQuotation(QuotationGetSchema.parse(await one(OWNER, 'select public.quotation_get($1) as r', [q.versionId])));

      // The itinerary as typed from an old document: a different hotel, a dropped inclusion, an extra activity, a later transfer.
      const draft: ItineraryFactsDraft = {
        ...basis,
        draftId: doc.draftId,
        sourceFileId: null,
        stays: basis.stays.map((s) => ({ ...s, hotelName: 'Another synthetic hotel', mealPlan: null })),
        transfers: basis.transfers.map((t) => ({ ...t, date: '2026-12-11' })),
        activities: [{ date: '2026-12-11', city: 'Synthetic City', name: 'Synthetic fort walk (sunset)', included: true }],
        inclusions: [],
        exclusions: ['Lunch', 'Breakfast'],
        days: [{ n: 1, date: '2026-12-10', base: 'Synthetic City', title: 'Arrival', story: 'Synthetic arrival day.', highlights: ['Check-in'], meals: null }],
        provenance: { 'stays[0].hotelName': 'manual', destination: 'quotation' },
      };
      const saved = await one<{ rowVersion: number; factsHash: string }>(OWNER, 'select public.itinerary_facts_save($1, $2, $3::jsonb, $4) as r',
        [doc.draftId, doc.rowVersion, JSON.stringify(toAtlasFactsJson(draft)), null]);

      const got = ItineraryDocumentGetSchema.parse(await one(OWNER, 'select public.itinerary_document_get($1) as r', [doc.documentId]));
      const back = toItineraryFactsDraft(got.draft);
      expect(back).toEqual(draft);
      expect(got.basis).toMatchObject({ kind: 'quotation_version', id: q.versionId });

      const differences = compareTripFacts(basis, back);
      expect(differences).toEqual([
        { path: 'stays[0].hotelName', kind: 'different' },
        { path: 'stays[0].mealPlan', kind: 'missing' },
        { path: 'transfers[0].date', kind: 'different' },
        { path: 'activities[0]', kind: 'extra' },
        { path: 'exclusions[1]', kind: 'different' },
      ]);
      for (const d of differences) expect(d.path).toMatch(DIFFERENCE_PATH);
      const run = await one<{ differenceCount: number; openCount: number; outcome: string }>(OWNER,
        'select public.itinerary_differences_save($1, $2, $3, $4, $5, $6::jsonb) as r',
        [doc.draftId, saved.rowVersion, got.basis.kind, got.basis.id, got.basis.hash, JSON.stringify(differences)]);
      expect(run).toMatchObject({ differenceCount: differences.length, openCount: differences.length, outcome: 'created' });
      const stored = ItineraryDocumentGetSchema.parse(await one(OWNER, 'select public.itinerary_document_get($1) as r', [doc.documentId]));
      expect(stored.differences!.items.map((d) => ({ path: d.path, kind: d.kind })).sort((a, b) => a.path.localeCompare(b.path)))
        .toEqual([...differences].sort((a, b) => a.path.localeCompare(b.path)));
    });
  });

  it('value hashes let an acknowledgement carry over only while both sides are unchanged (Atlas E3-9)', async () => {
    await asOwner(db, async () => {
      const q = await pricedQuotation();
      const doc = await one<{ documentId: string; draftId: string; rowVersion: number }>(OWNER, 'select public.itinerary_document_create($1, $2, $3, $4) as r',
        ['quotation', q.quotationId, 'Synthetic carry-over itinerary', rid()]);
      const basis = basisFactsFromQuotation(QuotationGetSchema.parse(await one(OWNER, 'select public.quotation_get($1) as r', [q.versionId])));
      const base: ItineraryFactsDraft = { ...basis, inclusions: basis.inclusions ?? [], exclusions: basis.exclusions ?? [], draftId: doc.draftId, sourceFileId: null, days: [], provenance: {} };

      async function check(draft: ItineraryFactsDraft, rowVersion: number) {
        const saved = await one<{ rowVersion: number }>(OWNER, 'select public.itinerary_facts_save($1, $2, $3::jsonb, $4) as r',
          [doc.draftId, rowVersion, JSON.stringify(toAtlasFactsJson(draft)), null]);
        const got = ItineraryDocumentGetSchema.parse(await one(OWNER, 'select public.itinerary_document_get($1) as r', [doc.documentId]));
        const items = toSaveableDifferences(compareTripFactsDetailed(basis, toItineraryFactsDraft(got.draft)));
        await one(OWNER, 'select public.itinerary_differences_save($1, $2, $3, $4, $5, $6::jsonb) as r',
          [doc.draftId, saved.rowVersion, got.basis.kind, got.basis.id, got.basis.hash, JSON.stringify(items)]);
        const after = ItineraryDocumentGetSchema.parse(await one(OWNER, 'select public.itinerary_document_get($1) as r', [doc.documentId]));
        return { rowVersion: saved.rowVersion, items: after.differences!.items };
      }

      // Run 1: a different hotel and a later transfer; acknowledge the hotel.
      const v1: ItineraryFactsDraft = {
        ...base,
        stays: base.stays.map((x) => ({ ...x, hotelName: 'Another synthetic hotel' })),
        transfers: base.transfers.map((t) => ({ ...t, date: '2026-12-11' })),
      };
      const r1 = await check(v1, doc.rowVersion);
      const hotel = r1.items.find((d) => d.path === 'stays[0].hotelName')!;
      await one(OWNER, 'select public.itinerary_difference_acknowledge($1, $2) as r', [hotel.differenceId, 'Synthetic: kept']);

      // Run 2: only the transfer changes again; the hotel acknowledgement carries over.
      const v2: ItineraryFactsDraft = { ...v1, transfers: base.transfers.map((t) => ({ ...t, date: '2026-12-12' })) };
      const r2 = await check(v2, r1.rowVersion);
      expect(r2.items.find((d) => d.path === 'stays[0].hotelName')).toMatchObject({ acknowledged: true });
      expect(r2.items.find((d) => d.path === 'transfers[0].date')).toMatchObject({ acknowledged: false });

      // Run 3: the hotel value changes again; the acknowledgement does not carry over.
      const v3: ItineraryFactsDraft = { ...v2, stays: base.stays.map((x) => ({ ...x, hotelName: 'A third synthetic hotel' })) };
      const r3 = await check(v3, r2.rowVersion);
      expect(r3.items.find((d) => d.path === 'stays[0].hotelName')).toMatchObject({ acknowledged: false });
    });
  });

  it('the optional narrative copy round-trips through the real 0500 facts allowlist (Atlas 5d321b3)', async () => {
    await asOwner(db, async () => {
      const q = await pricedQuotation();
      const doc = await one<{ documentId: string; draftId: string; rowVersion: number }>(OWNER, 'select public.itinerary_document_create($1, $2, $3, $4) as r',
        ['quotation', q.quotationId, 'Synthetic narrative itinerary', rid()]);
      const basis = basisFactsFromQuotation(QuotationGetSchema.parse(await one(OWNER, 'select public.quotation_get($1) as r', [q.versionId])));
      const draft: ItineraryFactsDraft = {
        ...basis, inclusions: basis.inclusions ?? [], exclusions: basis.exclusions ?? [], draftId: doc.draftId, sourceFileId: null, days: [], provenance: {},
        narrative: {
          coverWord: 'Synthetic', country: 'India', category: 'Family', roomBasis: 'Double sharing',
          introduction: ['A calm synthetic week.', 'Second synthetic paragraph.'], reasons: ['One base', 'Short drives'],
          handledByUs: ['Every transfer'], youBring: ['Photo ID'],
        },
      };
      await one(OWNER, 'select public.itinerary_facts_save($1, $2, $3::jsonb, $4) as r', [doc.draftId, doc.rowVersion, JSON.stringify(toAtlasFactsJson(draft)), null]);
      const got = ItineraryDocumentGetSchema.parse(await one(OWNER, 'select public.itinerary_document_get($1) as r', [doc.documentId]));
      expect(toItineraryFactsDraft(got.draft)).toEqual(draft);
    });
  });
});
