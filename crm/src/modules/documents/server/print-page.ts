import 'server-only';
import { z } from 'zod';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { itineraryRenderInputForWorker } from '@/modules/itineraries/server/render-worker';
import type { PackageDocumentInput } from '../contracts';
import { adaptRenderJobInput } from '../render/job-input';
import { PDF_RENDER_ONLINE_ENV, verifyPrintToken } from '../render/print-token';

/**
 * DEC-49: data of the in-app print page /print/itinerary/<job> (token in the
 * x-tn-print-token request header, review E10-6).
 * Only while PDF_RENDER_ONLINE is "on", only with a genuine unexpired link
 * for this job, and only while the worker named in the link still holds the
 * job's lease (Atlas checks it in itinerary_render_input). Every refusal is
 * null (the page answers 404 without a reason). The input goes through the
 * same adapter and day as the worker, so the page prints exactly what the
 * worker checks. Nothing is logged.
 */
export async function loadPrintJobInput(jobId: string, token: string | null, nowMs: number = Date.now()): Promise<PackageDocumentInput | null> {
  if (process.env[PDF_RENDER_ONLINE_ENV] !== 'on') return null;
  if (!z.uuid().safeParse(jobId).success) return null;
  const link = verifyPrintToken(token, jobId, process.env.RENDER_PRINT_TOKEN_SECRET, nowMs);
  if (!link) return null;
  try {
    const input = await itineraryRenderInputForWorker({ jobId, worker: link.w }, asRpcClient(createSupabaseAdminClient()));
    if (input.status !== 'running') return null;
    const adapted = adaptRenderJobInput(jobId, input, link.d);
    return adapted.ok ? adapted.input : null;
  } catch {
    return null;
  }
}
