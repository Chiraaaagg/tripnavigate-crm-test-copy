import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Actor, type TestDb, asOwner, createTestDb, expectDbError, resetActor, setActor } from '../helpers/db';
import { ACCOUNTS, DEAL, FLIGHT, MANAGER, OTHER_ENTITY, OWNER, PURCHASE, SALES_AMD, SALES_B, SUPER, SVC, rid } from './b1-support';
import { DESK, b11Helpers } from './b11-support';
import { priceQuotationVersion } from './b12-quotation-money-support';

/**
 * B1.2 Phase F (migration 20261120000500_b12_itineraries): itinerary
 * documents on a quotation or a Deal, private source files, the facts
 * allowlist (no money), differences against the basis with acknowledgement
 * (Q-F2), render jobs (idempotent, lease, attempts, error codes, QA block on
 * final) and rendered PDFs. Editors only; worker commands service_role only.
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
  create: 'select public.itinerary_document_create($1, $2, $3, $4) as r',
  srcBegin: 'select public.itinerary_source_begin($1, $2, $3, $4, $5) as r',
  srcFinish: 'select public.itinerary_source_finish($1, $2) as r',
  srcRemove: 'select public.itinerary_source_remove($1) as r',
  srcDownload: 'select public.itinerary_source_authorize_download($1) as r',
  facts: 'select public.itinerary_facts_save($1, $2, $3::jsonb, $4) as r',
  diffs: 'select public.itinerary_differences_save($1, $2, $3, $4, $5, $6::jsonb) as r',
  ack: 'select public.itinerary_difference_acknowledge($1, $2) as r',
  ready: 'select public.itinerary_facts_mark_ready($1, $2) as r',
  render: 'select public.itinerary_render_request($1, $2, $3, $4) as r',
  claim: 'select public.itinerary_render_claim($1, $2) as r',
  complete: 'select public.itinerary_render_complete($1, $2, $3, $4, $5::jsonb) as r',
  renderedDownload: 'select public.itinerary_rendered_authorize_download($1) as r',
  list: 'select public.itinerary_document_list($1, $2) as r',
  get: 'select public.itinerary_document_get($1) as r',
};
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const FACTS = {
  destination: 'Synthetic City', startDate: '2026-12-10', endDate: '2026-12-13',
  party: { adults: 3, children: 1, childAges: [8], infants: 0 },
  stays: [{ city: 'Synthetic City', nights: 3, checkIn: '2026-12-10', checkOut: '2026-12-13', hotelName: 'Synthetic Hotel (fixture)', roomType: null, mealPlan: 'Breakfast', rooms: 2 }],
  days: [{ n: 1, date: '2026-12-10', base: 'Synthetic City', title: 'Arrival', story: 'Synthetic arrival day.', highlights: ['Check-in'], meals: null }],
  transfers: [{ date: '2026-12-10', from: 'Airport', to: 'Hotel', mode: 'Sedan' }],
  activities: [{ date: '2026-12-11', city: 'Synthetic City', name: 'Synthetic walk', included: true }],
  flights: [{ date: '2026-12-10', from: 'DEL', to: 'JDH', carrier: null, number: null }],
  inclusions: ['Breakfast'], exclusions: ['Lunch'],
  provenance: { destination: 'quotation', 'stays[1].hotelName': 'manual' },
};

type Doc = { documentId: string; draftId: string; rowVersion: number; created: boolean };
type Basis = { kind: string; id: string | null; hash: string };
type Got = {
  draft: { draftId: string; status: string; rowVersion: number; factsHash: string };
  basis: Basis;
  differences: { runId: string | null; current: boolean; items: Array<{ differenceId: string; path: string; kind: string; acknowledged: boolean }> };
  sources: unknown[]; jobs: Array<{ jobId: string; status: string; attempts: number; lastErrorCode: string | null }>; rendered: Array<{ renderedId: string; kind: string }>;
};

const create = (actor: Actor, kind: 'quotation' | 'deal' = 'deal', subject: string = DEAL) =>
  one<Doc>(actor, SQL.create, [kind, subject, 'Synthetic itinerary', rid()]);
const get = (actor: Actor, documentId: string) => one<Got | null>(actor, SQL.get, [documentId]);

/** Facts saved, differences checked (given list), all acknowledged, ready. Returns the draft row version. */
async function readyDraft(actor: Actor, doc: Doc, differences: Array<{ path: string; kind: string }> = []): Promise<number> {
  const saved = await one<{ rowVersion: number }>(actor, SQL.facts, [doc.draftId, doc.rowVersion, JSON.stringify(FACTS), null]);
  const g = await get(actor, doc.documentId);
  await one(actor, SQL.diffs, [doc.draftId, saved.rowVersion, g!.basis.kind, g!.basis.id, g!.basis.hash, JSON.stringify(differences)]);
  for (const item of (await get(actor, doc.documentId))!.differences.items) await one(actor, SQL.ack, [item.differenceId, null]);
  return (await one<{ rowVersion: number }>(actor, SQL.ready, [doc.draftId, saved.rowVersion])).rowVersion;
}

async function putRendered(path: string, size = 5000): Promise<void> {
  await owner(`insert into storage.objects (bucket_id, name, metadata) values ('rendered-documents', $1, jsonb_build_object('size', $2::bigint))`, [path, size]);
}

async function expectHint(actor: Actor, sql: string, params: unknown[], code: string, message: string, hint: RegExp): Promise<void> {
  await db.exec('savepoint i_hint');
  let error: { code?: string; message?: string; hint?: string } | undefined;
  try {
    await h.run(actor, sql, params);
  } catch (e) {
    error = e as typeof error;
    await db.exec('rollback to savepoint i_hint');
  }
  expect(error?.code).toBe(code);
  expect(error?.message).toBe(message);
  expect(error?.hint ?? '').toMatch(hint);
}

describe('schema and privileges', () => {
  it('RLS on, no API privilege; private buckets; worker commands only for service_role', async () => {
    await asOwner(db, async () => {
      for (const t of ['itinerary_documents', 'itinerary_source_files', 'itinerary_fact_drafts', 'itinerary_difference_runs',
        'itinerary_fact_differences', 'itinerary_render_jobs', 'itinerary_rendered_documents']) {
        const [r] = await owner<Record<string, boolean>>(
          `select c.relrowsecurity as rls, has_table_privilege('authenticated', c.oid, 'select') as auth,
                  has_table_privilege('service_role', c.oid, 'select') as svc from pg_class c where c.oid = ('public.' || $1)::regclass`, [t]);
        expect(r, t).toEqual({ rls: true, auth: false, svc: false });
      }
      expect(await owner(`select id, public, file_size_limit::text as size from storage.buckets where id in ('itinerary-sources', 'rendered-documents') order by id`))
        .toEqual([{ id: 'itinerary-sources', public: false, size: '4194304' }, { id: 'rendered-documents', public: false, size: '15728640' }]);
      const [fn] = await owner<Record<string, boolean>>(
        `select has_function_privilege('authenticated', 'public.itinerary_render_claim(text, integer)', 'execute') as auth_claim,
                has_function_privilege('service_role', 'public.itinerary_render_claim(text, integer)', 'execute') as svc_claim,
                has_function_privilege('authenticated', 'public.itinerary_render_complete(uuid, text, boolean, text, jsonb)', 'execute') as auth_complete,
                has_function_privilege('authenticated', 'public.itinerary_document_get(uuid)', 'execute') as auth_get,
                has_function_privilege('anon', 'public.itinerary_document_create(text, uuid, text, uuid)', 'execute') as anon_create`);
      expect(fn).toEqual({ auth_claim: false, svc_claim: true, auth_complete: false, auth_get: true, anon_create: false });
    });
  });
});

describe('documents, sources and facts', () => {
  it('creates on a Deal (idempotent) and on a quotation; facts allowlist with path hints; no money keys', async () => {
    await asOwner(db, async () => {
      const requestId = rid();
      const doc = await one<Doc>(OWNER, SQL.create, ['deal', DEAL, 'Synthetic itinerary', requestId]);
      expect(doc).toMatchObject({ rowVersion: 1, created: true });
      expect(await one(OWNER, SQL.create, ['deal', DEAL, 'Synthetic itinerary', requestId])).toMatchObject({ documentId: doc.documentId, created: false });
      await refused(OWNER, SQL.create, ['deal', DEAL, 'Other', requestId], '40001', 'request_conflict');
      const q = await one<{ quotationId: string }>(OWNER, 'select public.quotation_create($1, $2, $3, $4) as r', ['deal', DEAL, 'Synthetic quote', rid()]);
      expect((await create(OWNER, 'quotation', q.quotationId)).created).toBe(true);

      const saved = await one<{ rowVersion: number; factsHash: string; status: string }>(OWNER, SQL.facts, [doc.draftId, doc.rowVersion, JSON.stringify(FACTS), null]);
      expect(saved).toMatchObject({ rowVersion: 2, status: 'draft', factsHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
      await expectHint(OWNER, SQL.facts, [doc.draftId, saved.rowVersion,
        JSON.stringify({ ...FACTS, price: 5000, party: { adults: -1 }, stays: [{ city: 'X', nights: 0 }], provenance: { destination: 'guess' } }), null],
        '22023', 'invalid_input', /price.*party\.adults.*stays\[1\]\.nights.*provenance\.destination|price/);
      await expectHint(OWNER, SQL.facts, [doc.draftId, saved.rowVersion, JSON.stringify({ stays: [{ city: 'X', nights: 0, sellingPaise: '1' }] }), null],
        '22023', 'invalid_input', /stays\[1\]\.nights,stays\[1\]\.sellingPaise|stays\[1\]\.sellingPaise/);
      await refused(OWNER, SQL.facts, [doc.draftId, 1, JSON.stringify(FACTS), null], '40001', 'version_changed');
      await expectHint(OWNER, SQL.facts, [doc.draftId, saved.rowVersion, JSON.stringify(FACTS), crypto.randomUUID()], '22023', 'invalid_input', /sourceFileId/);
    });
  });

  it('source files: pdf/docx/images up to 4 MiB, storage checked, download audited, soft removal; audits carry no file names', async () => {
    await asOwner(db, async () => {
      const doc = await create(OWNER);
      const b = await one<{ fileId: string; objectPath: string }>(OWNER, SQL.srcBegin, [doc.documentId, 'Old Itinerary Ramesh.docx', DOCX, 3000, 'c'.repeat(64)]);
      const [d] = await owner<{ legal_entity_id: string }>('select legal_entity_id from public.itinerary_documents where id = $1', [doc.documentId]);
      expect(b.objectPath).toBe(`${d!.legal_entity_id}/${doc.documentId}/${b.fileId}`);
      expect((await one<{ status: string }>(OWNER, SQL.srcFinish, [b.fileId, true])).status).toBe('failed'); // no object
      const c = await one<{ fileId: string; objectPath: string }>(OWNER, SQL.srcBegin, [doc.documentId, 'source.pdf', 'application/pdf', 3000, 'c'.repeat(64)]);
      await owner(`insert into storage.objects (bucket_id, name, metadata) values ('itinerary-sources', $1, jsonb_build_object('size', 3000::bigint))`, [c.objectPath]);
      expect((await one<{ status: string }>(OWNER, SQL.srcFinish, [c.fileId, true])).status).toBe('stored');
      for (const [mime, size] of [['text/plain', 10], ['application/msword', 10], ['application/pdf', 4194305]] as const) {
        await refused(OWNER, SQL.srcBegin, [doc.documentId, 'x.bin', mime, size, 'c'.repeat(64)], '22023', 'evidence_rejected');
      }
      expect((await one<{ fileName: string }>(MANAGER, SQL.srcDownload, [c.fileId])).fileName).toBe('source.pdf');
      const saved = await one<{ rowVersion: number }>(OWNER, SQL.facts, [doc.draftId, doc.rowVersion, JSON.stringify(FACTS), c.fileId]);
      expect(saved.rowVersion).toBe(2);
      expect(await one(OWNER, SQL.srcRemove, [c.fileId])).toEqual({ fileId: c.fileId, status: 'removed' });
      await refused(OWNER, SQL.srcDownload, [c.fileId], 'P0002', 'not_found');
      const audits = JSON.stringify(await owner(`select action, details from public.audit_events where action like 'itinerary.%'`));
      expect(audits).toContain('itinerary.source_viewed');
      expect(audits).not.toMatch(/Ramesh|source\.pdf|Synthetic City/);
      await expectDbError(db, () => owner('delete from public.itinerary_source_files where id = $1', [c.fileId]), { code: '42501' });
    });
  });
});

describe('differences block ready and final (Q-F2)', () => {
  it('not checked → refused; open → refused; acknowledged → ready; a facts change needs a new check; acknowledgements carry over', async () => {
    await asOwner(db, async () => {
      const doc = await create(OWNER);
      let rv = (await one<{ rowVersion: number }>(OWNER, SQL.facts, [doc.draftId, doc.rowVersion, JSON.stringify(FACTS), null])).rowVersion;
      await refused(OWNER, SQL.ready, [doc.draftId, rv], '55000', 'differences_not_checked');
      const basis = (await get(OWNER, doc.documentId))!.basis;
      expect(basis).toEqual({ kind: 'none', id: null, hash: '0'.repeat(64) }); // no quotation, no booking yet
      await refused(OWNER, SQL.diffs, [doc.draftId, rv, 'none', null, HASH_A, '[]'], '40001', 'basis_changed');
      await expectHint(OWNER, SQL.diffs, [doc.draftId, rv, basis.kind, basis.id, basis.hash, JSON.stringify([{ path: '1bad', kind: 'missing' }])],
        '22023', 'invalid_input', /differences\[1\]/);
      const H = (c: string) => c.repeat(32);
      const diffs = [{ path: 'startDate', kind: 'different', factsValueHash: H('1'), basisValueHash: H('2') },
        { path: 'stays[1].hotelName', kind: 'different', factsValueHash: H('3'), basisValueHash: H('4') }];
      const run = await one<{ runId: string; differenceCount: number; openCount: number; outcome: string }>(OWNER, SQL.diffs,
        [doc.draftId, rv, basis.kind, basis.id, basis.hash, JSON.stringify(diffs)]);
      expect(run).toMatchObject({ differenceCount: 2, openCount: 2, outcome: 'created' });
      expect(await one(OWNER, SQL.diffs, [doc.draftId, rv, basis.kind, basis.id, basis.hash, JSON.stringify(diffs)])).toMatchObject({ runId: run.runId, outcome: 'existing' });
      await refused(OWNER, SQL.diffs, [doc.draftId, rv, basis.kind, basis.id, basis.hash, '[]'], '40001', 'request_conflict');
      await refused(OWNER, SQL.ready, [doc.draftId, rv], '55000', 'differences_open');
      const items = (await get(OWNER, doc.documentId))!.differences.items;
      await one(OWNER, SQL.ack, [items[0]!.differenceId, 'Synthetic reason']);
      expect(await one(OWNER, SQL.ack, [items[0]!.differenceId, null])).toEqual({ differenceId: items[0]!.differenceId, acknowledged: true });
      await refused(OWNER, SQL.ready, [doc.draftId, rv], '55000', 'differences_open');
      await one(OWNER, SQL.ack, [items[1]!.differenceId, null]);
      rv = (await one<{ rowVersion: number; status: string }>(OWNER, SQL.ready, [doc.draftId, rv])).rowVersion;
      expect((await get(OWNER, doc.documentId))!.draft.status).toBe('ready');
      // A facts change: back to draft; the same differences again keep their acknowledgements.
      rv = (await one<{ rowVersion: number }>(OWNER, SQL.facts, [doc.draftId, rv, JSON.stringify({ ...FACTS, inclusions: ['Breakfast', 'Dinner'] }), null])).rowVersion;
      await refused(OWNER, SQL.ready, [doc.draftId, rv], '55000', 'differences_not_checked');
      // Review E3-9: carried over only when both value hashes are unchanged (startDate's draft value changed here).
      const run2 = await one<{ openCount: number }>(OWNER, SQL.diffs, [doc.draftId, rv, basis.kind, basis.id, basis.hash,
        JSON.stringify([{ ...diffs[0]!, factsValueHash: H('9') }, diffs[1], { path: 'inclusions', kind: 'extra' }])]);
      expect(run2.openCount).toBe(2);
      const open = (await get(OWNER, doc.documentId))!.differences.items.filter((i) => !i.acknowledged).map((i) => i.path).sort();
      expect(open).toEqual(['inclusions', 'startDate']);
      const audits = JSON.stringify(await owner(`select details from public.audit_events where action = 'itinerary.difference_acknowledged'`));
      expect(audits).not.toContain('Synthetic reason');
    });
  });

  it('the basis follows the quotation (draft → sent → accepted): a changed basis makes the check stale', async () => {
    await asOwner(db, async () => {
      const q = await one<{ quotationId: string; versionId: string; rowVersion: number }>(OWNER, 'select public.quotation_create($1, $2, $3, $4) as r',
        ['deal', DEAL, 'Synthetic quote', rid()]);
      const doc = await create(OWNER, 'quotation', q.quotationId);
      const b1 = (await get(OWNER, doc.documentId))!.basis;
      expect(b1).toMatchObject({ kind: 'quotation_version', id: q.versionId });
      const rv = await readyDraft(OWNER, doc);
      expect(rv).toBeGreaterThan(1);
      expect((await one<{ status: string }>(OWNER, SQL.render, [doc.documentId, 'final', HASH_A, 'v1'])).status).toBe('queued');
      // The quotation changes: the basis hash changes; a new final needs a new check.
      await one(OWNER, 'select public.quotation_version_save($1, $2, $3::jsonb) as r', [q.versionId, q.rowVersion, JSON.stringify({ adults: 2 })]);
      expect((await get(OWNER, doc.documentId))!.basis.hash).not.toBe(b1.hash);
      expect((await get(OWNER, doc.documentId))!.differences.current).toBe(false);
      await refused(OWNER, SQL.render, [doc.documentId, 'final', HASH_B, 'v1'], '55000', 'differences_not_checked');
    });
  });

  it('a Deal itinerary compares with the working booking version when there is no quotation', async () => {
    await asOwner(db, async () => {
      const d = await h.draftWithTravellers();
      const doc = await create(OWNER);
      expect((await get(OWNER, doc.documentId))!.basis).toMatchObject({ kind: 'booking_version', id: d.versionId });
    });
  });
});

describe('render jobs and rendered documents', () => {
  it('preview on a draft; final only when ready; idempotent by input hash; worker lease, success and download', async () => {
    await asOwner(db, async () => {
      const doc = await create(OWNER);
      await one(OWNER, SQL.facts, [doc.draftId, doc.rowVersion, JSON.stringify(FACTS), null]);
      const preview = await one<{ jobId: string; outcome: string }>(OWNER, SQL.render, [doc.documentId, 'preview', HASH_A, 'v1']);
      expect(preview.outcome).toBe('created');
      expect(await one(OWNER, SQL.render, [doc.documentId, 'preview', HASH_A, 'v1'])).toMatchObject({ jobId: preview.jobId, outcome: 'existing' });
      await expectHint(OWNER, SQL.render, [doc.documentId, 'final', HASH_A, 'v1'], '55000', 'not_ready', /draft/);
      await expectHint(OWNER, SQL.render, [doc.documentId, 'preview', 'xyz', 'v1'], '22023', 'invalid_input', /inputHash/);
      // Only the server's privileged client claims and completes.
      await expectDbError(db, () => h.run(OWNER, SQL.claim, ['worker-1', 60]), { code: '42501' });
      const job = await one<{ jobId: string; kind: string; attempts: number; legalEntityId: string; objectPath: string }>(SVC, SQL.claim, ['worker-1', 60]);
      expect(job).toMatchObject({ jobId: preview.jobId, kind: 'preview', attempts: 1 });
      expect(await one(SVC, SQL.claim, ['worker-2', 60])).toBeNull();
      const [d] = await owner<{ legal_entity_id: string }>('select legal_entity_id from public.itinerary_documents where id = $1', [doc.documentId]);
      const path = `${d!.legal_entity_id}/${doc.documentId}/${preview.jobId}.pdf`;
      // The claim names the exact upload path render_complete expects.
      expect(job).toMatchObject({ legalEntityId: d!.legal_entity_id, objectPath: path });
      const file = { objectPath: path, sha256: 'd'.repeat(64), sizeBytes: 5000, pageCount: 18, qa: { placeholders: 2, layoutIssues: [], safetyHits: [] } };
      await refused(SVC, SQL.complete, [preview.jobId, 'worker-2', true, null, JSON.stringify(file)], '40001', 'task_conflict');
      await putRendered(path);
      const done = await one<{ status: string; renderedId: string }>(SVC, SQL.complete, [preview.jobId, 'worker-1', true, null, JSON.stringify(file)]);
      expect(done.status).toBe('succeeded'); // a preview keeps its placeholders (shown to staff)
      expect(await one<{ mime: string; fileName: string }>(MANAGER, SQL.renderedDownload, [done.renderedId]))
        .toMatchObject({ objectPath: path, mime: 'application/pdf', fileName: expect.stringMatching(/^itinerary-preview-\d{8}\.pdf$/) });
      expect(await h.count(`select 1 from public.audit_events where action = 'itinerary.rendered_viewed'`)).toBe(1);
      await expectDbError(db, () => owner('update public.itinerary_rendered_documents set page_count = 1'), { code: '42501' });
    });
  });

  it('a final with placeholders, layout or safety findings is blocked (qa_blocked); failures retry up to 3 attempts', async () => {
    await asOwner(db, async () => {
      const doc = await create(OWNER);
      await readyDraft(OWNER, doc);
      const fin = await one<{ jobId: string }>(OWNER, SQL.render, [doc.documentId, 'final', HASH_A, 'v1']);
      await one(SVC, SQL.claim, ['w', 60]);
      const [d] = await owner<{ legal_entity_id: string }>('select legal_entity_id from public.itinerary_documents where id = $1', [doc.documentId]);
      const path = `${d!.legal_entity_id}/${doc.documentId}/${fin.jobId}.pdf`;
      await putRendered(path);
      const blocked = await one<{ status: string; errorCode: string }>(SVC, SQL.complete, [fin.jobId, 'w', true, null,
        JSON.stringify({ objectPath: path, sha256: 'd'.repeat(64), sizeBytes: 5000, pageCount: 3, qa: { placeholders: 0, layoutIssues: [], safetyHits: ['internal_rate_word'] } })]);
      expect(blocked).toMatchObject({ status: 'failed', errorCode: 'qa_blocked' });
      expect(await h.count('select 1 from public.itinerary_rendered_documents')).toBe(0);

      const again = await one<{ jobId: string; outcome: string }>(OWNER, SQL.render, [doc.documentId, 'final', HASH_A, 'v1']);
      expect(again.outcome).toBe('created'); // a failed job does not hold the input hash
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await owner(`update public.itinerary_render_jobs set available_at = now() - interval '1 minute' where id = $1`, [again.jobId]);
        expect(await one<{ attempts: number }>(SVC, SQL.claim, ['w', 60])).toMatchObject({ jobId: again.jobId, attempts: attempt });
        const r = await one<{ status: string }>(SVC, SQL.complete, [again.jobId, 'w', false, 'browser_failed', null]);
        expect(r.status).toBe(attempt < 3 ? 'queued' : 'failed');
      }
      await expectHint(SVC, SQL.complete, [again.jobId, 'w', false, 'oops', null], '40001', 'task_conflict', /.*/);
      const got = await get(OWNER, doc.documentId);
      expect(got!.jobs.find((j) => j.jobId === again.jobId)).toMatchObject({ status: 'failed', attempts: 3, lastErrorCode: 'browser_failed' });
    });
  });
});

describe('review E3', () => {
  it('E3-8: a running job whose lease expired on its last attempt fails lease_expired and frees its input hash', async () => {
    await asOwner(db, async () => {
      const doc = await create(OWNER);
      await one(OWNER, SQL.facts, [doc.draftId, doc.rowVersion, JSON.stringify(FACTS), null]);
      const job = await one<{ jobId: string }>(OWNER, SQL.render, [doc.documentId, 'preview', HASH_A, 'v1']);
      await one(SVC, SQL.claim, ['w', 60]);
      await owner(`update public.itinerary_render_jobs set attempts = 3, lease_until = now() - interval '1 minute' where id = $1`, [job.jobId]);
      expect(await one(SVC, SQL.claim, ['w2', 60])).toBeNull();
      expect(await owner('select status, last_error_code from public.itinerary_render_jobs where id = $1', [job.jobId]))
        .toEqual([{ status: 'failed', last_error_code: 'lease_expired' }]);
      expect(await one(OWNER, SQL.render, [doc.documentId, 'preview', HASH_A, 'v1'])).toMatchObject({ outcome: 'created' });
    });
  });

  it('E3-13: the worker reads the render input of the job it holds (facts, basis, customer money only)', async () => {
    await asOwner(db, async () => {
      const doc = await create(OWNER);
      await one(OWNER, SQL.facts, [doc.draftId, doc.rowVersion, JSON.stringify(FACTS), null]);
      const job = await one<{ jobId: string }>(OWNER, SQL.render, [doc.documentId, 'preview', HASH_A, 'v1']);
      await refused(SVC, 'select public.itinerary_render_input($1, $2) as r', [job.jobId, 'w'], '40001', 'task_conflict');
      await one(SVC, SQL.claim, ['w', 60]);
      const input = await one<Record<string, unknown>>(SVC, 'select public.itinerary_render_input($1, $2) as r', [job.jobId, 'w']);
      expect(input).toMatchObject({ jobId: job.jobId, kind: 'preview', templateVersion: 'v1', factsChanged: false, facts: FACTS,
        basis: { kind: 'none' }, money: null });
      await refused(SVC, 'select public.itinerary_render_input($1, $2) as r', [job.jobId, 'other'], '40001', 'task_conflict');
      await expectDbError(db, () => h.run(OWNER, 'select public.itinerary_render_input($1, $2) as r', [job.jobId, 'w']), { code: '42501' });
    });
  });

  it('E5-7: a final job whose facts or basis changed after the request fails input_changed (input read and complete)', async () => {
    await asOwner(db, async () => {
      const doc = await create(OWNER);
      const rv = await readyDraft(OWNER, doc);
      const fin = await one<{ jobId: string }>(OWNER, SQL.render, [doc.documentId, 'final', HASH_A, 'v1']);
      await one(SVC, SQL.claim, ['w', 60]);
      expect(await one(SVC, 'select public.itinerary_render_input($1, $2) as r', [fin.jobId, 'w'])).toMatchObject({ status: 'running', basisChanged: false });
      await one(OWNER, SQL.facts, [doc.draftId, rv, JSON.stringify({ ...FACTS, destination: 'Synthetic Elsewhere' }), null]);
      expect(await one(SVC, 'select public.itinerary_render_input($1, $2) as r', [fin.jobId, 'w']))
        .toEqual({ jobId: fin.jobId, status: 'failed', errorCode: 'input_changed' });
      expect(await owner('select status, last_error_code from public.itinerary_render_jobs where id = $1', [fin.jobId]))
        .toEqual([{ status: 'failed', last_error_code: 'input_changed' }]);
      // Same rule on complete for another final job (basis moved: a booking draft appeared).
      const doc2 = await create(OWNER);
      await readyDraft(OWNER, doc2);
      const fin2 = await one<{ jobId: string }>(OWNER, SQL.render, [doc2.documentId, 'final', HASH_B, 'v1']);
      await one(SVC, SQL.claim, ['w', 60]);
      await h.draftWithTravellers();
      expect(await one(SVC, SQL.complete, [fin2.jobId, 'w', true, null, '{}'])).toMatchObject({ status: 'failed', errorCode: 'input_changed' });
    });
  });

  it('narrative keys are allowed with text limits and enter the facts hash', async () => {
    await asOwner(db, async () => {
      const doc = await create(OWNER);
      const narrative = { coverWord: 'Synthetic', country: 'India', category: 'Family', roomBasis: 'Double sharing',
        introduction: 'Synthetic introduction.', reasons: ['One', 'Two'], handledByUs: ['Transfers'], youBring: ['Passport copy'] };
      const a = await one<{ rowVersion: number; factsHash: string }>(OWNER, SQL.facts, [doc.draftId, doc.rowVersion, JSON.stringify(FACTS), null]);
      const b = await one<{ rowVersion: number; factsHash: string }>(OWNER, SQL.facts,
        [doc.draftId, a.rowVersion, JSON.stringify({ ...FACTS, ...narrative }), null]);
      expect(b.factsHash).not.toBe(a.factsHash);
      await expectHint(OWNER, SQL.facts, [doc.draftId, b.rowVersion,
        JSON.stringify({ ...FACTS, reasons: ['1', '2', '3', '4', '5', '6', '7'], coverWord: 'x'.repeat(61), youBring: [''] }), null],
        '22023', 'invalid_input', /coverWord.*reasons.*youBring|reasons/);
    });
  });

  it('deterministic failures end the job at once; transient ones retry', async () => {
    await asOwner(db, async () => {
      const doc = await create(OWNER);
      await one(OWNER, SQL.facts, [doc.draftId, doc.rowVersion, JSON.stringify(FACTS), null]);
      for (const [code, hash] of [['content_safety', HASH_A], ['text_clipped', HASH_B]] as const) {
        const job = await one<{ jobId: string }>(OWNER, SQL.render, [doc.documentId, 'preview', hash, 'v1']);
        await owner(`update public.itinerary_render_jobs set available_at = now() - interval '1 minute' where id = $1`, [job.jobId]);
        await one(SVC, SQL.claim, ['w', 60]);
        expect(await one(SVC, SQL.complete, [job.jobId, 'w', false, code, null])).toMatchObject({ status: 'failed', errorCode: code });
        expect(await owner('select attempts, status from public.itinerary_render_jobs where id = $1', [job.jobId])).toEqual([{ attempts: 1, status: 'failed' }]);
      }
      const t = await one<{ jobId: string }>(OWNER, SQL.render, [doc.documentId, 'preview', 'e'.repeat(64), 'v1']);
      await one(SVC, SQL.claim, ['w', 60]);
      expect(await one(SVC, SQL.complete, [t.jobId, 'w', false, 'upload_failed', null])).toMatchObject({ status: 'queued' });
    });
  });

  it('DEC-48: the itinerary carries the selling-side prices of its basis, only for commercial readers', async () => {
    await asOwner(db, async () => {
      // Booking basis: selling total and plan of the working booking version.
      const ready = await h.readyPackage(OWNER, DEAL, ['hotel']);
      const doc = await create(OWNER);
      const money = (await one<{ money: Record<string, unknown> }>(OWNER, SQL.get, [doc.documentId])).money;
      expect(money).toMatchObject({ source: 'booking_version', versionId: ready.versionId, sellingTotalPaise: '9876543',
        plan: [expect.objectContaining({ seq: 1, amountPaise: '9876543' })] });
      expect(JSON.stringify(money)).not.toMatch(/cost|margin|budget/i);
      await one(OWNER, SQL.facts, [doc.draftId, doc.rowVersion, JSON.stringify(FACTS), null]);
      const job = await one<{ jobId: string }>(OWNER, SQL.render, [doc.documentId, 'preview', HASH_A, 'v1']);
      await one(SVC, SQL.claim, ['w', 60]);
      expect((await one<{ money: unknown }>(SVC, 'select public.itinerary_render_input($1, $2) as r', [job.jobId, 'w'])).money)
        .toMatchObject({ source: 'booking_version', sellingTotalPaise: '9876543' });
      // A requester without commercial scope: no prices in the read or in the render input.
      await owner(`delete from public.role_permissions where role_code = 'sales' and permission_code = 'deal.read_commercial'`);
      expect((await one<{ money: unknown }>(OWNER, SQL.get, [doc.documentId])).money).toBeNull();
      const job2 = await one<{ jobId: string }>(OWNER, SQL.render, [doc.documentId, 'preview', HASH_B, 'v1']);
      await owner(`update public.itinerary_render_jobs set status = 'cancelled', lease_owner = null, lease_until = null, finished_at = now() where id = $1`, [job.jobId]);
      await one(SVC, SQL.claim, ['w2', 60]);
      expect((await one<{ jobId: string; money: unknown }>(SVC, 'select public.itinerary_render_input($1, $2) as r', [job2.jobId, 'w2'])).money).toBeNull();
    });
  });

  it('DEC-48: an itinerary on an accepted quotation carries its customer prices and the accepted tier', async () => {
    await asOwner(db, async () => {
      const q = await one<{ quotationId: string; versionId: string; rowVersion: number }>(OWNER, 'select public.quotation_create($1, $2, $3, $4) as r',
        ['deal', DEAL, 'Synthetic quote', rid()]);
      const doc = await create(OWNER, 'quotation', q.quotationId);
      const money = (await one<{ money: Record<string, unknown> }>(OWNER, SQL.get, [doc.documentId])).money;
      expect(money).toMatchObject({ source: 'quotation_version', versionId: q.versionId, acceptedTier: null });
      expect(JSON.stringify(money)).not.toMatch(/cost|margin/i);
    });
  });

  it('E3-12: list and get return nothing for a Deal removed by the sync', async () => {
    await asOwner(db, async () => {
      const doc = await create(OWNER);
      await owner('alter table public.deals drop constraint deals_removed_imported_only');
      await owner(`update public.deals set removed_at = now(), removed_reason = 'stage_not_eligible' where id = $1`, [DEAL]);
      expect(await one(MANAGER, SQL.get, [doc.documentId])).toBeNull();
      expect(await one(MANAGER, SQL.list, ['deal', DEAL])).toBeNull();
    });
  });
});

describe('access', () => {
  it('Purchase, Flight, the desk, Accounts, Super Admin, other branch, other entity, unassigned Sales: nothing', async () => {
    await asOwner(db, async () => {
      await h.addFlight();
      const doc = await create(OWNER);
      for (const actor of [PURCHASE, FLIGHT, DESK, ACCOUNTS, SUPER, SALES_AMD, OTHER_ENTITY, SALES_B]) {
        await refused(actor, SQL.create, ['deal', DEAL, 'X', rid()], '42501', 'not_authorized');
        expect(await one(actor, SQL.get, [doc.documentId])).toBeNull();
        expect(await one(actor, SQL.list, ['deal', DEAL])).toBeNull();
        await refused(actor, SQL.facts, [doc.draftId, 1, '{}', null], '42501', 'not_authorized');
        await refused(actor, SQL.render, [doc.documentId, 'preview', HASH_A, 'v1'], '42501', 'not_authorized');
        await expectDbError(db, async () => {
          await setActor(db, actor);
          await db.query('select * from public.itinerary_documents');
        }, { code: '42501' });
        await resetActor(db);
      }
      expect(await one(MANAGER, SQL.get, [doc.documentId])).not.toBeNull();
      expect((await one<unknown[]>(MANAGER, SQL.list, ['deal', DEAL])).length).toBe(1);
    });
  });

  it('a Deal removed by the sync refuses itinerary work', async () => {
    await asOwner(db, async () => {
      const doc = await create(OWNER);
      await owner('alter table public.deals drop constraint deals_removed_imported_only');
      await owner(`update public.deals set removed_at = now(), removed_reason = 'stage_not_eligible' where id = $1`, [DEAL]);
      await refused(OWNER, SQL.create, ['deal', DEAL, 'X', rid()], '55000', 'deal_removed');
      await refused(OWNER, SQL.facts, [doc.draftId, doc.rowVersion, '{}', null], '55000', 'deal_removed');
    });
  });

  it('a quotation itinerary uses the quotation editors (Lead owner and branch Manager)', async () => {
    await asOwner(db, async () => {
      const q = await one<{ quotationId: string; versionId: string; rowVersion: number }>(OWNER, 'select public.quotation_create($1, $2, $3, $4) as r',
        ['deal', DEAL, 'Synthetic quote', rid()]);
      expect(await priceQuotationVersion(one, owner, OWNER, q.versionId, q.rowVersion)).toBeGreaterThan(q.rowVersion);
      const doc = await create(MANAGER, 'quotation', q.quotationId);
      expect(await one(OWNER, SQL.get, [doc.documentId])).not.toBeNull();
      await refused(SALES_B, SQL.create, ['quotation', q.quotationId, 'X', rid()], '42501', 'not_authorized');
    });
  });
});
