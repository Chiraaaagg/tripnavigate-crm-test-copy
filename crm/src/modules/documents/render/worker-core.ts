import 'server-only';
import { RENDER_FAILURE_CODES } from '@/modules/itineraries/server/render-worker';
import type {
  ItineraryRenderClaim,
  ItineraryRenderCompleteResult,
  ItineraryRenderInput,
  RenderFailureCode,
  RenderedFileReport,
} from '@/modules/itineraries/server/render-worker';
import { stableHash } from '@/modules/itineraries/files';
import type { PackageDocumentInput } from '../contracts';
import type { RenderedDocument } from './checks';
import { adaptRenderJobInput, renderJobTitle } from './job-input';
import type { PdfResult } from './pdf';

/**
 * One render job, start to finish (B1.2 Phase F; local worker only while the
 * rendering location is PENDING the owner). Every side effect is injected, so
 * this is unit-tested with fakes and run for real by crm/scripts/render-worker.mjs.
 *
 *   claim -> render input (lease checked; final with changed input = stop)
 *   -> adapter (same function and day as the request, so the input hash
 *      matches) -> branded HTML -> page checks (content safety, placeholders)
 *   -> PDF (Chromium, no network) -> layout checks -> private upload
 *   -> complete with QA codes.
 *
 * DEC-49: the HTML step is injected (renderHtml), so this module never
 * imports react-dom/server and also runs inside the Next.js server layer (the
 * online PDF maker). The local worker renders the HTML string with the Node
 * render seam; the online maker reads the in-app print page in Chromium.
 *
 * Failure classes (Atlas 5d321b3): placeholders_present, content_safety,
 * input_invalid, layout_overflow, text_clipped and asset_missing fail the job
 * at once; render_timeout, browser_failed, upload_failed and internal are
 * retried while attempts remain. A missing stylesheet or a page that asked
 * for an outside asset is asset_missing.
 *
 * A FINAL job never uploads a PDF that would fail QA (placeholders, unsafe
 * words, layout issues): it completes with the matching error code instead.
 * A PREVIEW is stored with its QA codes. Nothing here logs; the result is
 * codes, ids, sizes and timings only.
 */

export type ClaimedJob = ItineraryRenderClaim;
export type RenderErrorCode = RenderFailureCode;
export type CompleteFile = RenderedFileReport;

/** A render step that already knows its failure code (e.g. asset_missing). */
export class RenderStepError extends Error {
  override name = 'RenderStepError';
  constructor(readonly code: RenderFailureCode) {
    super(`render step failed: ${code}`);
  }
}

export interface WorkerDeps {
  worker: string;
  claim(): Promise<ClaimedJob | null>;
  input(jobId: string): Promise<ItineraryRenderInput>;
  /**
   * The storage path the complete command expects (`<entity>/<document>/<jobId>.pdf`):
   * the claim's objectPath. null = unknown (the claim reply does not carry the
   * legal entity yet): the job then fails `internal`.
   */
  objectPathFor(job: ClaimedJob): string | null;
  /**
   * The branded document for the adapted input, with the page checks run on
   * the template's own markup. Throws RenderStepError for a known failure
   * (a missing stylesheet: asset_missing), anything else = input_invalid.
   */
  renderHtml(job: ClaimedJob, input: PackageDocumentInput, title: string): Promise<RenderedDocument>;
  renderPdf(html: string): Promise<PdfResult>;
  upload(objectPath: string, pdf: Uint8Array): Promise<void>;
  complete(jobId: string, ok: boolean, errorCode: RenderErrorCode | null, file: CompleteFile | null): Promise<ItineraryRenderCompleteResult>;
  /** IST calendar day (YYYY-MM-DD), as the request action uses for the document date. */
  today(): string;
}

export type JobOutcome =
  | { outcome: 'idle' }
  | { outcome: 'conflict'; jobId: string }
  | { outcome: 'input_changed'; jobId: string }
  | {
      outcome: 'completed';
      jobId: string;
      kind: 'preview' | 'final';
      status: string;
      errorCode: string | null;
      /** Local diagnostic codes (never values). */
      notes: string[];
      placeholders: number;
      pdf: { sizeBytes: number; pageCount: number; renderMs: number } | null;
    };

/**
 * The failure code for a final document's layout issues: text_clipped (Atlas
 * 5d321b3 allowlists it) once the worker wrappers accept it, else
 * layout_overflow. Both fail the job at once (deterministic).
 */
export function layoutFailureCode(issues: string[]): RenderErrorCode {
  const clippedOnly = issues.length > 0 && issues.every((c) => c === 'text_clipped');
  const accepted = (RENDER_FAILURE_CODES as readonly string[]).includes('text_clipped');
  return (clippedOnly && accepted ? 'text_clipped' : 'layout_overflow') as RenderErrorCode;
}

function safetyCodes(hits: Array<{ kind: string }>): string[] {
  return [...new Set(hits.map((h) => h.kind))].sort();
}

export async function processOneJob(deps: WorkerDeps): Promise<JobOutcome> {
  const job = await deps.claim();
  if (!job) return { outcome: 'idle' };
  const notes: string[] = [];
  const done = async (ok: boolean, code: RenderErrorCode | null, file: CompleteFile | null, extra: { placeholders?: number; pdf?: PdfResult | null } = {}) => {
    const r = await deps.complete(job.jobId, ok, code, file);
    return {
      outcome: 'completed' as const,
      jobId: job.jobId,
      kind: job.kind,
      status: r.status,
      errorCode: 'errorCode' in r ? r.errorCode : code,
      notes,
      placeholders: extra.placeholders ?? 0,
      pdf: extra.pdf ? { sizeBytes: extra.pdf.sizeBytes, pageCount: extra.pdf.pageCount, renderMs: extra.pdf.ms } : null,
    };
  };

  let input: ItineraryRenderInput;
  try {
    input = await deps.input(job.jobId);
  } catch {
    return done(false, 'internal', null);
  }
  if (input.status === 'conflict') return { outcome: 'conflict', jobId: job.jobId };
  if (input.status === 'failed') return { outcome: 'input_changed', jobId: job.jobId };
  if (input.factsChanged || input.basisChanged) notes.push('input_changed_since_request');

  // The same view and adapter as the request action (Terra), so the input hash matches.
  let html: string;
  let placeholders: string[];
  let safety: string[];
  let adaptedInput: PackageDocumentInput;
  try {
    const adapted = adaptRenderJobInput(job.jobId, input, deps.today());
    if (!adapted.ok) return done(false, 'input_invalid', null);
    adaptedInput = adapted.input;
  } catch {
    return done(false, 'input_invalid', null);
  }
  if (stableHash(adaptedInput) !== job.inputHash) {
    notes.push('input_hash_differs');
    // Review E6-3: a FINAL document must be exactly what was requested and checked.
    // input_invalid (deterministic, fails at once; the complete command does not take
    // input_changed): staff request it again. A preview still renders with the note.
    if (job.kind === 'final') return done(false, 'input_invalid', null);
  }
  try {
    const doc = await deps.renderHtml(job, adaptedInput, renderJobTitle(input));
    html = doc.html;
    placeholders = doc.placeholders;
    safety = [...new Set([...safetyCodes(doc.safetyHits), ...(doc.pageIssues ?? [])])].sort();
  } catch (error) {
    if (error instanceof RenderStepError) return done(false, error.code, null);
    const timeout = error instanceof Error && /timeout/i.test(error.name + error.message);
    return done(false, timeout ? 'render_timeout' : 'input_invalid', null);
  }

  // A final document is never made with placeholders or unsafe words.
  if (job.kind === 'final' && safety.length) return done(false, 'content_safety', null, { placeholders: placeholders.length });
  if (job.kind === 'final' && placeholders.length) return done(false, 'placeholders_present', null, { placeholders: placeholders.length });

  const objectPath = deps.objectPathFor(job);
  if (!objectPath) {
    notes.push('object_path_unknown');
    return done(false, 'internal', null, { placeholders: placeholders.length });
  }

  let pdf: PdfResult;
  try {
    pdf = await deps.renderPdf(html);
  } catch (error) {
    const timeout = error instanceof Error && /timeout/i.test(error.name + error.message);
    return done(false, timeout ? 'render_timeout' : 'browser_failed', null, { placeholders: placeholders.length });
  }
  if (job.kind === 'final' && pdf.layoutIssues.length) return done(false, layoutFailureCode(pdf.layoutIssues), null, { placeholders: placeholders.length, pdf });
  // The page asked for something outside itself (an asset the PDF cannot have): a final document fails at once.
  if (pdf.blockedRequests > 0) {
    notes.push('network_requests_blocked');
    if (job.kind === 'final') return done(false, 'asset_missing', null, { placeholders: placeholders.length, pdf });
  }

  try {
    await deps.upload(objectPath, pdf.pdf);
  } catch {
    return done(false, 'upload_failed', null, { placeholders: placeholders.length, pdf });
  }
  return done(
    true,
    null,
    {
      objectPath,
      sha256: pdf.sha256,
      sizeBytes: pdf.sizeBytes,
      pageCount: pdf.pageCount,
      qa: { placeholders: placeholders.length, layoutIssues: pdf.layoutIssues, safetyHits: safety },
    },
    { placeholders: placeholders.length, pdf },
  );
}
