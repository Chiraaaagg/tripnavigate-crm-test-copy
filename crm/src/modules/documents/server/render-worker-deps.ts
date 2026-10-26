import 'server-only';
import { readFileSync } from 'node:fs';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { asRpcClient } from '@/modules/fulfilment/commands';
import {
  RENDERED_BUCKET,
  itineraryRenderClaimForWorker,
  itineraryRenderCompleteForWorker,
  itineraryRenderInputForWorker,
} from '@/modules/itineraries/server/render-worker';
import { localItineraryHtmlStep } from '../render/html';
import { renderPdf, type PdfBrowser } from '../render/pdf';
import type { WorkerDeps } from '../render/worker-core';
import { istDate } from './load-quotation-view';

/**
 * Supabase side of the LOCAL render worker: Terra's service-role wrappers
 * (claim, render input, complete; Atlas 0500 worker commands are granted to
 * service_role only) and the private upload. Used only by
 * crm/scripts/render-worker.mjs after its environment guard; never from a
 * page, action or route. Replies are never logged.
 */

export const LEASE_SECONDS = 120;

/** The stylesheet the branded templates use (inlined into every page). */
export function documentCss(): string {
  return readFileSync(new URL('../render/document.css', import.meta.url), 'utf8');
}

export class UploadError extends Error {
  override name = 'UploadError';
}

export function createLocalWorkerDeps(options: { worker: string; browser: PdfBrowser; css?: string }): WorkerDeps {
  const admin = createSupabaseAdminClient();
  const css = options.css ?? documentCss();
  const rpc = asRpcClient(admin);
  return {
    worker: options.worker,
    claim: () => itineraryRenderClaimForWorker({ worker: options.worker, leaseSeconds: LEASE_SECONDS }, rpc),
    input: (jobId) => itineraryRenderInputForWorker({ jobId, worker: options.worker }, rpc),
    objectPathFor: (job) => job.objectPath,
    // The Node render seam (react-dom/server; this file never loads in the Next.js server layer).
    renderHtml: localItineraryHtmlStep(css),
    renderPdf: (html) => renderPdf(options.browser, html),
    upload: async (objectPath, pdf) => {
      const { error } = await admin.storage.from(RENDERED_BUCKET).upload(objectPath, pdf, { contentType: 'application/pdf', upsert: true });
      if (error) throw new UploadError('upload failed');
    },
    complete: (jobId, ok, errorCode, file) =>
      itineraryRenderCompleteForWorker(
        { jobId, worker: options.worker, outcome: ok && file ? { ok: true, file } : { ok: false, errorCode: errorCode ?? 'internal' } },
        rpc,
      ),
    today: () => istDate(),
  };
}
