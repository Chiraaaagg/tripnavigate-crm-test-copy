import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, type TestDb, asOwner, createTestDb } from '../helpers/db';
import { DEAL, DEAL_AMD, OWNER, SALES_AMD, SVC, rid } from './b1-support';
import { b11Helpers } from './b11-support';

/**
 * B1.2 DEC-50 (migration 20261120000800_b12_document_branch_code): the
 * quotation and itinerary document reads carry the branch code that picks
 * the GSTIN printed on the document. quotation_get subject.branchCode comes
 * from quotations.branch_id; itinerary_document_get subject.branchCode and
 * itinerary_render_input branchCode both come from
 * itinerary_documents.branch_id, so the staff request and the render worker
 * hash the same value. Synthetic fixtures only; every case rolled back.
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

const SQL = {
  quote: 'select public.quotation_create($1, $2, $3, $4) as r',
  quoteGet: 'select public.quotation_get($1) as r',
  create: 'select public.itinerary_document_create($1, $2, $3, $4) as r',
  facts: 'select public.itinerary_facts_save($1, $2, $3::jsonb, $4) as r',
  get: 'select public.itinerary_document_get($1) as r',
  render: 'select public.itinerary_render_request($1, $2, $3, $4) as r',
  claim: 'select public.itinerary_render_claim($1, $2) as r',
  input: 'select public.itinerary_render_input($1, $2) as r',
};
const FACTS = { destination: 'Synthetic City', startDate: '2026-12-10', endDate: '2026-12-13' };
/** A synthetic Jodhpur Deal owned by OWNER, created inside the rolled-back transaction. */
const DEAL_JDH = 'd0000000-0000-4000-8000-0000000000f1';

type Quote = { quotationId: string; versionId: string };
type Doc = { documentId: string; draftId: string; rowVersion: number };

async function addJodhpurDeal(): Promise<void> {
  await owner(
    `insert into public.deals (id, legal_entity_id, branch_id, reference, title, owner_user_id)
     select $1::uuid, b.legal_entity_id, b.id, 'SYN-JDH-001', 'Synthetic package (Jodhpur)', $2::uuid
     from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
     where e.code = 'HOLIDAY_CHACHA' and b.code = 'JDH'`,
    [DEAL_JDH, OWNER.userId],
  );
}

const quoteBranch = async (actor: Actor, deal: string) => {
  const q = await one<Quote>(actor, SQL.quote, ['deal', deal, 'Synthetic quote', rid()]);
  const got = await one<{ subject: { branchCode: string | null } } | null>(actor, SQL.quoteGet, [q.versionId]);
  return { q, branchCode: got!.subject.branchCode };
};

/** The branch code of a new itinerary document as the staff read and the render worker see it. */
async function itineraryBranch(actor: Actor, kind: 'deal' | 'quotation', subject: string) {
  const doc = await one<Doc>(actor, SQL.create, [kind, subject, 'Synthetic itinerary', rid()]);
  const got = await one<{ subject: { branchCode: string | null } }>(actor, SQL.get, [doc.documentId]);
  await one(actor, SQL.facts, [doc.draftId, doc.rowVersion, JSON.stringify(FACTS), null]);
  const job = await one<{ jobId: string }>(actor, SQL.render, [doc.documentId, 'preview', rid().replace(/-/g, '').padEnd(64, '0'), 'v1']);
  const worker = `w-${rid()}`;
  await one(SVC, SQL.claim, [worker, 60]);
  const input = await one<{ jobId: string; status: string; branchCode: string | null }>(SVC, SQL.input, [job.jobId, worker]);
  expect(input).toMatchObject({ jobId: job.jobId, status: 'running' });
  return { staff: got.subject.branchCode, worker: input.branchCode };
}

describe('DEC-50 branch code on document reads', () => {
  it('quotation_get subject.branchCode is the quotation branch (Delhi, Ahmedabad, Jodhpur)', async () => {
    await asOwner(db, async () => {
      expect((await quoteBranch(OWNER, DEAL)).branchCode).toBe('DEL');
      expect((await quoteBranch(SALES_AMD, DEAL_AMD)).branchCode).toBe('AMD');
      await addJodhpurDeal();
      expect((await quoteBranch(OWNER, DEAL_JDH)).branchCode).toBe('JDH');
    });
  });

  it('itinerary_document_get subject.branchCode equals itinerary_render_input branchCode (Deal and quotation itineraries)', async () => {
    await asOwner(db, async () => {
      expect(await itineraryBranch(OWNER, 'deal', DEAL)).toEqual({ staff: 'DEL', worker: 'DEL' });
      expect(await itineraryBranch(SALES_AMD, 'deal', DEAL_AMD)).toEqual({ staff: 'AMD', worker: 'AMD' });
      await addJodhpurDeal();
      const { q } = await quoteBranch(OWNER, DEAL_JDH);
      expect(await itineraryBranch(OWNER, 'quotation', q.quotationId)).toEqual({ staff: 'JDH', worker: 'JDH' });
    });
  });

  it('the three functions keep their security settings and grants', async () => {
    await asOwner(db, async () => {
      const rows = await owner<{ fn: string; definer: boolean; config: string[]; auth: boolean; svc: boolean; anon: boolean }>(
        `select p.oid::regprocedure::text as fn, p.prosecdef as definer, p.proconfig as config,
                has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as svc,
                has_function_privilege('anon', p.oid, 'execute') as anon
         from pg_proc p where p.oid in ('public.quotation_get(uuid)'::regprocedure, 'public.itinerary_document_get(uuid)'::regprocedure,
                                       'public.itinerary_render_input(uuid, text)'::regprocedure)
         order by 1`);
      expect(rows).toEqual([
        { fn: 'itinerary_document_get(uuid)', definer: true, config: ['search_path=""'], auth: true, svc: false, anon: false },
        { fn: 'itinerary_render_input(uuid,text)', definer: true, config: ['search_path=""'], auth: false, svc: true, anon: false },
        { fn: 'quotation_get(uuid)', definer: true, config: ['search_path=""'], auth: true, svc: false, anon: false },
      ]);
    });
  });
});
