import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RpcClient } from '@/modules/fulfilment/commands';
import { itineraryToEngine } from '@/modules/documents/itinerary-adapter';
import { ItineraryDocumentGetSchema, toItineraryDocumentView } from '@/modules/documents/itinerary-view';
import { localItineraryHtmlStep } from '@/modules/documents/render/html';
import { processOneJob, type WorkerDeps } from '@/modules/documents/render/worker-core';
import { istDate } from '@/modules/documents/server/load-quotation-view';
import { stableHash } from '@/modules/itineraries/files';
import {
  itineraryRenderClaimForWorker,
  itineraryRenderCompleteForWorker,
  itineraryRenderInputForWorker,
} from '@/modules/itineraries/server/render-worker';
import { type TestDb, asOwner, createTestDb, resetActor, setActor } from '../helpers/db';
import { DEAL, OWNER, SVC, rid } from './b1-support';
import { b11Helpers } from './b11-support';

/**
 * B1.2 Phase F (Nova): the local render worker's job flow against the real
 * Atlas 0500 worker commands on PGlite, through Terra's service-role
 * wrappers: claim -> render input -> adapter + branded HTML -> (fake PDF) ->
 * upload (a storage.objects row, as the local stack's storage writes) ->
 * complete. Chromium and the real upload run on the local stack only (lead).
 * Synthetic fixtures only; rolled back.
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
const WORKER = 'local-pglite';

const FACTS = {
  destination: 'Synthetic City', startDate: '2026-12-10', endDate: '2026-12-13',
  party: { adults: 3, children: 1, childAges: [8], infants: 0 },
  stays: [{ city: 'Synthetic City', nights: 3, checkIn: '2026-12-10', checkOut: '2026-12-13', hotelName: 'Synthetic Hotel (fixture)', roomType: 'Deluxe', mealPlan: 'Breakfast', rooms: 2 }],
  days: [1, 2, 3, 4].map((n) => ({ n, date: null, base: 'Synthetic City', title: `Synthetic day ${n}`, story: 'A calm synthetic day.', highlights: [], meals: null })),
  transfers: [{ date: '2026-12-10', from: 'Airport', to: 'Hotel', mode: 'Sedan' }],
  activities: [], flights: [], inclusions: ['Breakfast'], exclusions: ['Lunch'], provenance: {},
};

const CAST: Record<string, string> = { p_file: '::jsonb', p_lease_seconds: '::integer', p_ok: '::boolean', p_job_id: '::uuid' };

/** Terra's wrappers take an RpcClient: this one runs the call on PGlite as the service role. */
const serviceRpc: RpcClient = {
  async rpc(fn, args = {}) {
    const keys = Object.keys(args);
    const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}${CAST[k] ?? ''}`).join(', ')}) as r`;
    const params = keys.map((k) => {
      const v = args[k];
      return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
    });
    await db.exec('savepoint svc_rpc');
    try {
      await setActor(db, SVC);
      const rows = await db.query<{ r: unknown }>(sql, params);
      await resetActor(db);
      await db.exec('release savepoint svc_rpc');
      return { data: rows[0]!.r, error: null };
    } catch (e) {
      await db.exec('rollback to savepoint svc_rpc');
      await resetActor(db);
      const err = e as { code?: string; message?: string };
      return { data: null, error: { code: err.code, message: err.message } };
    }
  },
};

async function document(): Promise<{ documentId: string; draftId: string; entity: string; inputHash: string }> {
  await h.setSwitch('service_items_enabled', true);
  const doc = await one<{ documentId: string; draftId: string; rowVersion: number }>(OWNER, 'select public.itinerary_document_create($1, $2, $3, $4) as r',
    ['deal', DEAL, 'Synthetic worker itinerary', rid()]);
  await one(OWNER, 'select public.itinerary_facts_save($1, $2, $3::jsonb, $4) as r', [doc.draftId, doc.rowVersion, JSON.stringify(FACTS), null]);
  // The request action's hash: the same view and adapter, today in IST.
  const get = ItineraryDocumentGetSchema.parse(await one(OWNER, 'select public.itinerary_document_get($1) as r', [doc.documentId]));
  const adapted = itineraryToEngine(toItineraryDocumentView(get, { today: istDate() }));
  if (!adapted.ok) throw new Error('fixture refused');
  const [deal] = await owner<{ legal_entity_id: string }>('select legal_entity_id from public.deals where id = $1', [DEAL]);
  return { documentId: doc.documentId, draftId: doc.draftId, entity: deal!.legal_entity_id, inputHash: stableHash(adapted.input) };
}

function deps(entity: string, uploads: string[]): WorkerDeps {
  return {
    worker: WORKER,
    claim: () => itineraryRenderClaimForWorker({ worker: WORKER, leaseSeconds: 60 }, serviceRpc),
    input: (jobId) => itineraryRenderInputForWorker({ jobId, worker: WORKER }, serviceRpc),
    // The claim reply names the upload path (Atlas 0500, claim objectPath).
    objectPathFor: (job) => job.objectPath,
    renderPdf: async () => ({ pdf: new Uint8Array(4096), sha256: 'c'.repeat(64), sizeBytes: 4096, pageCount: 3, layoutIssues: [], blockedRequests: 0, ms: 1 }),
    upload: async (path, pdf) => {
      uploads.push(path);
      await owner(`insert into storage.objects (bucket_id, name, metadata) values ('rendered-documents', $1, jsonb_build_object('size', $2::bigint))`, [path, pdf.byteLength]);
    },
    complete: (jobId, ok, errorCode, file) =>
      itineraryRenderCompleteForWorker({ jobId, worker: WORKER, outcome: ok && file ? { ok: true, file } : { ok: false, errorCode: errorCode ?? 'internal' } }, serviceRpc),
    today: () => istDate(),
    renderHtml: localItineraryHtmlStep('.tn-doc{}'),
  };
}

describe('render worker against the real 0500 commands', () => {
  it('a preview job is claimed, rendered, uploaded and stored with its QA codes; the input hash matches the request', async () => {
    await asOwner(db, async () => {
      const d = await document();
      const req = await one<{ jobId: string; status: string }>(OWNER, 'select public.itinerary_render_request($1, $2, $3, $4) as r',
        [d.documentId, 'preview', d.inputHash, 'itinerary-2']);
      expect(req.status).toBe('queued');
      const uploads: string[] = [];
      const r = await processOneJob(deps(d.entity, uploads));
      expect(r).toMatchObject({ outcome: 'completed', jobId: req.jobId, kind: 'preview', status: 'succeeded', notes: [] });
      expect(uploads).toEqual([`${d.entity}/${d.documentId}/${req.jobId}.pdf`]);
      const got = await one<{ rendered: Array<{ kind: string; pageCount: number; qa: { placeholders: number } }>; jobs: Array<{ status: string }> }>(
        OWNER, 'select public.itinerary_document_get($1) as r', [d.documentId]);
      expect(got.jobs[0]).toMatchObject({ status: 'succeeded' });
      expect(ItineraryDocumentGetSchema.parse(got).subject.branchCode).toBe('DEL');
      // DEC-50: the fixture Deal is in Delhi, whose GSTIN is not given yet: the preview carries exactly that one placeholder.
      expect(got.rendered).toEqual([expect.objectContaining({ kind: 'preview', pageCount: 3, qa: { placeholders: 1, layoutIssues: [], safetyHits: [] } })]);
      // Nothing left to do.
      expect(await processOneJob(deps(d.entity, uploads))).toEqual({ outcome: 'idle' });
    });
  });

  it('a missing upload ends upload_failed in the database (queued for a retry)', async () => {
    await asOwner(db, async () => {
      const d = await document();
      await one(OWNER, 'select public.itinerary_render_request($1, $2, $3, $4) as r', [d.documentId, 'preview', d.inputHash, 'itinerary-2']);
      const noUpload = { ...deps(d.entity, []), upload: async () => undefined };
      expect(await processOneJob(noUpload)).toMatchObject({ status: 'queued', errorCode: 'upload_failed' });
    });
  });

  it('a job the worker does not hold is a conflict; another worker cannot complete it', async () => {
    await asOwner(db, async () => {
      const d = await document();
      const req = await one<{ jobId: string }>(OWNER, 'select public.itinerary_render_request($1, $2, $3, $4) as r', [d.documentId, 'preview', d.inputHash, 'itinerary-2']);
      const claim = await itineraryRenderClaimForWorker({ worker: WORKER, leaseSeconds: 60 }, serviceRpc);
      expect(claim).toMatchObject({ jobId: req.jobId, kind: 'preview', attempts: 1, objectPath: `${d.entity}/${d.documentId}/${req.jobId}.pdf` });
      expect(await itineraryRenderInputForWorker({ jobId: req.jobId, worker: 'another-worker' }, serviceRpc)).toEqual({ status: 'conflict' });
    });
  });
});
