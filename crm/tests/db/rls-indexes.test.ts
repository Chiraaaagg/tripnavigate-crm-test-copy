import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb } from '../helpers/db';

/*
 * Columns used in RLS predicates on every read need an index whose FIRST
 * column is that column, or each policy check scans the table (AUDIT-030):
 *   deals.owner_user_id             deals scoped_read (owner path)
 *   fulfilment_tasks.assignee_user_id  can_work_purchase_task
 *   booking_evidence.deal_id        can_read_booking_evidence(deal_id)
 *   traveller_id_proofs.deal_id     id_proof_viewer_role(deal_id), replay (B1.2)
 *   traveller_id_proofs.traveller_id  per-traveller lists, cap and detachment (B1.2)
 *   quotations / quotation_versions / quotation_evidence / quotation_conversions  B1.2 quotation reads
 */
let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

async function leadingIndexes(table: string, column: string): Promise<string[]> {
  const rows = await db.query<{ indexname: string }>(
    `select i.relname as indexname
       from pg_index x
       join pg_class i on i.oid = x.indexrelid
       join pg_class t on t.oid = x.indrelid
       join pg_namespace n on n.oid = t.relnamespace
       join pg_attribute a on a.attrelid = t.oid and a.attnum = x.indkey[0]
      where n.nspname = 'public' and t.relname = $1 and a.attname = $2`,
    [table, column],
  );
  return rows.map((r) => r.indexname);
}

describe('indexes for RLS predicate columns', () => {
  it.each([
    ['deals', 'owner_user_id'],
    ['fulfilment_tasks', 'assignee_user_id'],
    ['booking_evidence', 'deal_id'],
    ['traveller_id_proofs', 'deal_id'],
    ['traveller_id_proofs', 'traveller_id'],
    // B1.2 quotations (20261120000200): subject and version lookups of the definer reads.
    ['quotations', 'deal_id'],
    ['quotations', 'lead_id'],
    ['quotations', 'linked_deal_id'],
    ['quotation_versions', 'quotation_id'],
    ['quotation_evidence', 'quotation_version_id'],
    ['quotation_conversions', 'booking_version_id'],
    // B1.2 itineraries (20261120000500): subject and document lookups of the definer reads.
    ['itinerary_documents', 'quotation_id'],
    ['itinerary_documents', 'deal_id'],
    ['itinerary_fact_drafts', 'document_id'],
    ['itinerary_source_files', 'document_id'],
    ['itinerary_render_jobs', 'document_id'],
    ['itinerary_rendered_documents', 'document_id'],
  ])('%s.%s leads an index', async (table, column) => {
    expect(await leadingIndexes(table, column)).not.toEqual([]);
  });
});
