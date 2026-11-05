import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { factsPayload, ItineraryGetSchema, ItineraryListSchema } from '@/modules/itineraries/commands';
import { EMPTY_ITINERARY_FACTS, ITINERARY_FACT_LIMITS, type ItineraryFacts } from '@/modules/itineraries/contracts';
import { toItineraryEditorView, toItineraryListView } from '@/modules/itineraries/dto';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { DEAL, OWNER, rid } from './b1-support';
import { b11Helpers } from './b11-support';

/**
 * The itinerary TS layer against the real 0500 replies (PGlite, synthetic):
 * documents on a Deal and on a quotation, the facts payload the TS action
 * sends, the editor read through the loader's schema and DTO at each step
 * (facts saved, differences checked and settled, ready, render requested),
 * and the list. Every case rolled back.
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const h = b11Helpers(() => db);
const { one } = h;

const SQL = {
  create: 'select public.itinerary_document_create($1, $2, $3, $4) as r',
  facts: 'select public.itinerary_facts_save($1, $2, $3::jsonb, $4) as r',
  diffs: 'select public.itinerary_differences_save($1, $2, $3, $4, $5, $6::jsonb) as r',
  ack: 'select public.itinerary_difference_acknowledge($1, $2) as r',
  ready: 'select public.itinerary_facts_mark_ready($1, $2) as r',
  render: 'select public.itinerary_render_request($1, $2, $3, $4) as r',
  list: 'select public.itinerary_document_list($1, $2) as r',
  get: 'select public.itinerary_document_get($1) as r',
  qCreate: 'select public.quotation_create($1, $2, $3, $4) as r',
};

const FACTS: ItineraryFacts = {
  ...EMPTY_ITINERARY_FACTS,
  destination: 'Synthetic City',
  startDate: '2026-12-10',
  endDate: '2026-12-13',
  party: { adults: 2, children: 1, childAges: [9], infants: null },
  stays: [{ city: 'Synthetic City', nights: 3, checkIn: '2026-12-10', checkOut: '2026-12-13', hotelName: 'Synthetic Sea View', roomType: null, mealPlan: 'Breakfast', rooms: 1 }],
  days: [
    { n: 1, date: '2026-12-10', base: 'Synthetic City', title: 'Arrive', story: 'Check in and rest.', highlights: ['Sunset walk'], meals: null },
    { n: 2, date: '2026-12-11', base: null, title: 'Beach day', story: null, highlights: [], meals: null },
  ],
  activities: [{ date: '2026-12-11', city: 'Synthetic City', name: 'Boat ride', included: true }],
  inclusions: ['Breakfast'],
  provenance: { destination: 'manual' },
};

const getView = async (documentId: string) => toItineraryEditorView(ItineraryGetSchema.parse(await one(OWNER, SQL.get, [documentId])));

describe('itinerary replies parse through the TS schemas and DTOs', () => {
  it('Deal document: facts → differences (none to compare) → ready → render request; list', async () => {
    await asOwner(db, async () => {
      const created = await one<{ documentId: string; draftId: string; rowVersion: number }>(OWNER, SQL.create, ['deal', DEAL, 'Synthetic itinerary', rid()]);
      const empty = await getView(created.documentId);
      expect(empty).toMatchObject({ status: 'draft', facts: EMPTY_ITINERARY_FACTS, canMarkReady: false, differences: { current: false, openCount: 0 } });

      const saved = await one<{ rowVersion: number; factsHash: string }>(OWNER, SQL.facts, [created.draftId, created.rowVersion, JSON.stringify(factsPayload(FACTS)), null]);
      const filled = await getView(created.documentId);
      expect(filled.facts).toEqual(FACTS);
      expect(filled.factsHash).toBe(saved.factsHash);

      const basis = filled.basis;
      const run = await one<{ runId: string; openCount: number }>(OWNER, SQL.diffs, [created.draftId, saved.rowVersion, basis.kind, basis.id, basis.hash, JSON.stringify([])]);
      expect(run.openCount).toBe(0);
      const checked = await getView(created.documentId);
      expect(checked).toMatchObject({ canMarkReady: true, differences: { current: true, runId: run.runId } });

      const ready = await one<{ rowVersion: number }>(OWNER, SQL.ready, [created.draftId, checked.rowVersion]);
      const readyView = await getView(created.documentId);
      expect(readyView).toMatchObject({ status: 'ready', rowVersion: ready.rowVersion, canRequestFinal: true });

      await one(OWNER, SQL.render, [created.documentId, 'final', 'b'.repeat(64), 'itinerary-2']);
      const rendered = await getView(created.documentId);
      expect(rendered.jobs[0]).toMatchObject({ kind: 'final', status: 'queued', statusText: 'Waiting for the PDF maker. Nothing is sent to the customer.' });

      const list = toItineraryListView('deal', DEAL, ItineraryListSchema.parse(await one(OWNER, SQL.list, ['deal', DEAL])));
      expect(list.documents[0]).toMatchObject({ documentId: created.documentId, draftStatus: 'ready', latestFinal: null });
    });
  });

  it('quotation document: the basis is the quotation; differences with paths and acknowledgements parse', async () => {
    await asOwner(db, async () => {
      await h.setSwitch('service_items_enabled', true);
      const q = await one<{ quotationId: string }>(OWNER, SQL.qCreate, ['deal', DEAL, 'Synthetic quotation', rid()]);
      const created = await one<{ documentId: string; draftId: string; rowVersion: number }>(OWNER, SQL.create, ['quotation', q.quotationId, 'Synthetic quotation itinerary', rid()]);
      const saved = await one<{ rowVersion: number }>(OWNER, SQL.facts, [created.draftId, created.rowVersion, JSON.stringify(factsPayload(FACTS)), null]);
      const view = await getView(created.documentId);
      expect(view.basis.kind).toBe('quotation_version');
      expect(view.subject).toMatchObject({ kind: 'quotation', quotationId: q.quotationId, dealId: DEAL });

      await one(OWNER, SQL.diffs, [
        created.draftId,
        saved.rowVersion,
        view.basis.kind,
        view.basis.id,
        view.basis.hash,
        JSON.stringify([
          { path: 'stays[1].hotelName', kind: 'extra' },
          { path: 'startDate', kind: 'different' },
        ]),
      ]);
      const open = await getView(created.documentId);
      expect(open.differences.items.map((d) => [d.path, d.kind, d.label])).toEqual([
        ['startDate', 'different', 'Start date'],
        ['stays[1].hotelName', 'extra', 'Stay 2 · hotel'],
      ]);
      expect(open).toMatchObject({ canMarkReady: false, differences: { openCount: 2 } });
      await one(OWNER, SQL.ack, [open.differences.items[0]!.differenceId, 'Itinerary value kept on purpose.']);
      const one_open = await getView(created.documentId);
      expect(one_open.differences.items[0]).toMatchObject({ acknowledged: true, note: 'Itinerary value kept on purpose.', acknowledgedByName: expect.any(String) });
      expect(one_open.differences.openCount).toBe(1);
    });
  });

  it('narrative facts (cover word, country, category, room basis, introduction, points) round-trip through the payload and schema; over-limit refused', async () => {
    await asOwner(db, async () => {
      const created = await one<{ documentId: string; draftId: string; rowVersion: number }>(OWNER, SQL.create, ['deal', DEAL, 'Synthetic narrative', rid()]);
      const narrative: ItineraryFacts = {
        ...FACTS,
        coverWord: 'Synthetic',
        country: 'India',
        category: 'Family holiday',
        roomBasis: 'Twin sharing',
        introduction: 'Welcome.\nSlow days by the sea.',
        reasons: Array.from({ length: ITINERARY_FACT_LIMITS.reasons }, (_, i) => `Reason ${i + 1}`),
        handledByUs: ['Airport transfers'],
        youBring: ['Passport', 'y'.repeat(ITINERARY_FACT_LIMITS.point)],
      };
      await one(OWNER, SQL.facts, [created.draftId, created.rowVersion, JSON.stringify(factsPayload(narrative)), null]);
      expect((await getView(created.documentId)).facts).toEqual(narrative);
      const view = await getView(created.documentId);
      await h.refused(OWNER, SQL.facts, [created.draftId, view.rowVersion, JSON.stringify(factsPayload({ ...narrative, reasons: [...narrative.reasons, 'One too many'] })), null], '22023', 'invalid_input');
      await h.refused(OWNER, SQL.facts, [created.draftId, view.rowVersion, JSON.stringify(factsPayload({ ...narrative, coverWord: 'c'.repeat(ITINERARY_FACT_LIMITS.coverWord + 1) })), null], '22023', 'invalid_input');
    });
  });

  it('DEC-48: prices of the basis parse (booking selling total and plan; quotation customer money); none without commercial scope', async () => {
    await asOwner(db, async () => {
      const ready = await h.readyPackage(OWNER, DEAL, ['hotel']);
      const created = await one<{ documentId: string; draftId: string; rowVersion: number }>(OWNER, SQL.create, ['deal', DEAL, 'Synthetic priced', rid()]);
      const record = ItineraryGetSchema.parse(await one(OWNER, SQL.get, [created.documentId]));
      expect(record.money).toEqual({ source: 'booking_version', versionId: ready.versionId, sellingTotalPaise: '9876543', plan: [expect.objectContaining({ seq: 1, amountPaise: '9876543' })] });
      expect(toItineraryEditorView(record).pricesIncluded).toBe(true);

      await h.setSwitch('service_items_enabled', true);
      const q = await one<{ quotationId: string; versionId: string }>(OWNER, SQL.qCreate, ['deal', DEAL, 'Synthetic quotation', rid()]);
      const qDoc = await one<{ documentId: string }>(OWNER, SQL.create, ['quotation', q.quotationId, 'Synthetic quotation itinerary', rid()]);
      expect(ItineraryGetSchema.parse(await one(OWNER, SQL.get, [qDoc.documentId])).money).toMatchObject({ source: 'quotation_version', versionId: q.versionId, acceptedTier: null, tiers: expect.any(Array) });

      await h.owner(`delete from public.role_permissions where role_code = 'sales' and permission_code = 'deal.read_commercial'`);
      const hidden = ItineraryGetSchema.parse(await one(OWNER, SQL.get, [created.documentId]));
      expect(hidden.money).toBeNull();
      expect(toItineraryEditorView(hidden).pricesIncluded).toBe(false);
    });
  });
});
