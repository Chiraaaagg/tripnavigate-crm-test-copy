import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { factsPayload, ItineraryGetSchema } from '@/modules/itineraries/commands';
import { EMPTY_ITINERARY_FACTS, ITINERARY_TEXT, type ItineraryFacts } from '@/modules/itineraries/contracts';
import { type TestDb, asOwner, createTestDb } from '../helpers/db';
import { DEAL, OWNER, rid } from './b1-support';
import { b11Helpers } from './b11-support';
import { staffAs } from './b12-ts-support';

/**
 * "Use quotation value" end to end on the real database (PGlite, synthetic):
 * the action runs under a session-like RPC client for the owner, Nova's
 * compute reads the real quotation_get / itinerary_document_get replies, the
 * value lands in the facts through itinerary_facts_save with the path marked
 * as coming from the quotation, and the stored difference run no longer holds
 * that path. Everything rolled back.
 */

const requireStaff = vi.fn();
vi.mock('@/modules/identity/server/session', () => ({ requireStaff: () => requireStaff() }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => {
    throw new Error('The privileged client is not used by this action.');
  },
}));

const { useItineraryBasisValueAction } = await import('@/modules/itineraries/server/actions');

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
  qCreate: 'select public.quotation_create($1, $2, $3, $4) as r',
  qSave: 'select public.quotation_version_save($1, $2, $3::jsonb) as r',
  create: 'select public.itinerary_document_create($1, $2, $3, $4) as r',
  facts: 'select public.itinerary_facts_save($1, $2, $3::jsonb, $4) as r',
  get: 'select public.itinerary_document_get($1) as r',
};

const FACTS: ItineraryFacts = {
  ...EMPTY_ITINERARY_FACTS,
  destination: 'Synthetic City',
  startDate: '2026-12-11', // the quotation says 10 December
  endDate: '2026-12-13',
  party: { adults: 2, children: 1, childAges: [], infants: null },
  provenance: { destination: 'manual' },
};

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function quotationItinerary() {
  await h.setSwitch('service_items_enabled', true);
  const q = await one<{ quotationId: string; versionId: string; rowVersion: number }>(OWNER, SQL.qCreate, ['deal', DEAL, 'Synthetic quotation', rid()]);
  await one(OWNER, SQL.qSave, [q.versionId, q.rowVersion, JSON.stringify({ destination: 'Synthetic City', scope: 'domestic', start: '2026-12-10', end: '2026-12-13', adults: 2, childrenWithBed: 1 })]);
  const doc = await one<{ documentId: string; draftId: string; rowVersion: number }>(OWNER, SQL.create, ['quotation', q.quotationId, 'Synthetic itinerary', rid()]);
  await one(OWNER, SQL.facts, [doc.draftId, doc.rowVersion, JSON.stringify(factsPayload(FACTS)), null]);
  return doc;
}

describe('use the quotation value on the real database', () => {
  it('copies the quotation start date into the facts, marks it from the quotation, and re-checks', async () => {
    await asOwner(db, async () => {
      requireStaff.mockResolvedValue(staffAs(() => db, OWNER));
      const doc = await quotationItinerary();

      const result = await useItineraryBasisValueAction(null, form({ documentId: doc.documentId, path: 'startDate', differenceKind: 'different' }));
      expect(result).toMatchObject({ ok: true, message: ITINERARY_TEXT.basisValueUsed });

      const after = ItineraryGetSchema.parse(await one(OWNER, SQL.get, [doc.documentId]));
      expect(after.draft.facts.startDate).toBe('2026-12-10');
      expect(after.draft.facts.provenance).toMatchObject({ startDate: 'quotation', destination: 'manual' });
      expect(after.draft.facts.endDate).toBe('2026-12-13');
      expect(after.differences.current).toBe(true);
      expect(after.differences.items.map((d) => d.path)).not.toContain('startDate');
      // The re-check stored Nova's differences with both value hashes (E3-9), never values.
      const stored = await h.owner<{ facts_value_hash: string | null; basis_value_hash: string | null }>(
        'select facts_value_hash, basis_value_hash from public.itinerary_fact_differences where run_id = $1',
        [after.differences.runId],
      );
      expect(stored.length).toBe(after.differences.items.length);
      for (const row of stored) {
        expect(row.facts_value_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(row.basis_value_hash).toMatch(/^[0-9a-f]{64}$/);
      }
    });
  });

  it('refuses a path that is not a current difference and leaves the facts alone', async () => {
    await asOwner(db, async () => {
      requireStaff.mockResolvedValue(staffAs(() => db, OWNER));
      const doc = await quotationItinerary();
      const before = ItineraryGetSchema.parse(await one(OWNER, SQL.get, [doc.documentId]));

      const result = await useItineraryBasisValueAction(null, form({ documentId: doc.documentId, path: 'endDate', differenceKind: 'different' }));
      expect(result).toMatchObject({ ok: false, code: 'basis_value_unavailable' });

      const after = ItineraryGetSchema.parse(await one(OWNER, SQL.get, [doc.documentId]));
      expect(after.draft.rowVersion).toBe(before.draft.rowVersion);
      expect(after.draft.facts).toEqual(before.draft.facts);
    });
  });
});
