import 'server-only';
import { z } from 'zod';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { asRpcClient, type RpcClient, type RpcError } from '@/modules/fulfilment/commands';
import { ItineraryFactsSchema, ItineraryMoneySchema } from '../commands';
import { type ItineraryFacts, type ItineraryMoney, RENDER_KINDS, type RenderKind } from '../contracts';

/**
 * Render worker commands (Atlas 0500, review E3-8/E3-13/E5-7): claim a job,
 * read what to render, report the outcome. All three are granted to
 * service_role only, so these run with the privileged client and are for the
 * render worker alone: never call them from a page, a server action or a
 * route that answers a browser, and never pass their replies to a browser.
 * The input read and the outcome report refuse (`task_conflict`, returned
 * here as `conflict`) unless the worker still holds the job's live lease.
 *
 * The input reply carries the customer side of the quotation money only (Mercury's
 * selling-only JSON: no cost, margin or supplier). It is never logged.
 */

export const RENDER_WORKER_NAME_MAX = 60;

export type ItineraryRenderInput =
  | {
      status: 'running';
      jobId: string;
      documentId: string;
      kind: RenderKind;
      templateVersion: string;
      /** The hash the job was requested with (sha256 of the engine input). */
      inputHash: string;
      /** The draft's current facts hash. */
      factsHash: string;
      /** The facts changed since the request (a preview may still render; a final job is failed by the database instead). */
      factsChanged: boolean;
      /** The basis changed since the request (absent on a database before E5-7: read as false). */
      basisChanged: boolean;
      facts: ItineraryFacts;
      title: string;
      basis: { kind: 'quotation_version' | 'booking_version' | 'none'; id: string | null; hash: string };
      /**
       * DEC-48: customer prices (selling side of the quotation or booking
       * basis) when the requester could read them at request time; null
       * otherwise. Never cost, margin or budget.
       */
      money: ItineraryMoney | null;
      /**
       * DEC-50: the document's branch code (`branches.code`, e.g. JDH), the
       * same column itinerary_document_get reads, so the worker and the
       * request print the same company identity line. Null when absent.
       */
      branchCode: string | null;
    }
  /** E5-7: a final job whose facts or basis changed was failed by the database (`input_changed`); stop. */
  | { status: 'failed'; jobId: string; errorCode: 'input_changed' }
  /** The worker does not hold the live lease (task_conflict): drop the job. */
  | { status: 'conflict' };

const hash = z.string().regex(/^[0-9a-f]{64}$/);

const RunningSchema = z.object({
  status: z.literal('running').optional(),
  jobId: z.uuid(),
  documentId: z.uuid(),
  kind: z.enum(RENDER_KINDS),
  templateVersion: z.string().min(1).max(40),
  inputHash: hash,
  factsHash: hash,
  factsChanged: z.boolean(),
  basisChanged: z.boolean().optional(),
  facts: ItineraryFactsSchema,
  title: z.string().min(1).max(200),
  basis: z.object({ kind: z.enum(['quotation_version', 'booking_version', 'none']), id: z.uuid().nullable().optional(), hash }),
  money: ItineraryMoneySchema.nullable().optional(),
  branchCode: z.string().max(16).nullable().optional(),
});
const FailedSchema = z.object({ status: z.literal('failed'), jobId: z.uuid(), errorCode: z.literal('input_changed') });

/**
 * A refusal or reply the worker cannot use. The database message is never
 * kept (it could echo arguments); `hint` is only the refused input key of
 * invalid_input (worker, ok, file, errorCode).
 */
export class RenderWorkerError extends Error {
  override name = 'RenderWorkerError';
  constructor(
    readonly sqlState: string | null,
    readonly command: string = 'itinerary_render_input',
    readonly hint: string | null = null,
  ) {
    super(`${command} failed${sqlState ? ` (${sqlState})` : ''}${hint ? `: ${hint}` : ''}`);
  }
}

function isTaskConflict(error: RpcError): boolean {
  return error.code === '40001' && (error.message ?? '').trim() === 'task_conflict';
}

function workerName(worker: string, command: string): string {
  const w = worker.trim();
  if (w.length === 0 || w.length > RENDER_WORKER_NAME_MAX) throw new RenderWorkerError(null, command, 'worker');
  return w;
}

/** One call; task_conflict comes back as 'conflict', every other refusal throws without database text. */
async function workerCall(client: RpcClient, command: string, args: Record<string, unknown>): Promise<{ conflict: true } | { conflict: false; data: unknown }> {
  let result: { data: unknown; error: RpcError | null };
  try {
    result = await client.rpc(command, args);
  } catch {
    throw new RenderWorkerError(null, command);
  }
  if (result.error) {
    if (isTaskConflict(result.error)) return { conflict: true };
    const hint = result.error.code === '22023' && /^[A-Za-z]{1,20}$/.test((result.error.hint ?? '').trim()) ? result.error.hint!.trim() : null;
    throw new RenderWorkerError(result.error.code ?? null, command, hint);
  }
  return { conflict: false, data: result.data };
}

// ---------------------------------------------------------------------------
// itinerary_render_claim: the oldest queued job (or a running one whose lease
// expired), now running under this worker's lease. null = nothing to do.
// ---------------------------------------------------------------------------

export const RENDER_LEASE_SECONDS = { min: 10, max: 600 } as const;
/** Private bucket for rendered PDFs (application/pdf, at most 15 MiB). */
export const RENDERED_BUCKET = 'rendered-documents';
export const RENDERED_MAX_BYTES = 15 * 1024 * 1024;

export interface ItineraryRenderClaim {
  jobId: string;
  documentId: string;
  kind: RenderKind;
  inputHash: string;
  templateVersion: string;
  factsHash: string;
  /** This attempt's number (1-based; at most 3 attempts). */
  attempts: number;
  /**
   * Where the PDF must be uploaded in RENDERED_BUCKET:
   * `<legal entity id>/<document id>/<job id>.pdf`. null while the claim
   * reply does not carry the legal entity (see renderedObjectPath).
   */
  objectPath: string | null;
}

/** The only object path itinerary_render_complete accepts for a job. */
export function renderedObjectPath(legalEntityId: string, documentId: string, jobId: string): string {
  return `${legalEntityId}/${documentId}/${jobId}.pdf`;
}

const ClaimSchema = z.object({
  jobId: z.uuid(),
  documentId: z.uuid(),
  kind: z.enum(RENDER_KINDS),
  inputHash: hash,
  templateVersion: z.string().min(1).max(40),
  factsHash: hash,
  attempts: z.number().int().min(1).max(10),
  legalEntityId: z.uuid().nullable().optional(),
  objectPath: z.string().regex(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.pdf$/).nullable().optional(),
});

export async function itineraryRenderClaimForWorker(
  input: { worker: string; leaseSeconds: number },
  client: RpcClient = asRpcClient(createSupabaseAdminClient()),
): Promise<ItineraryRenderClaim | null> {
  const command = 'itinerary_render_claim';
  const worker = workerName(input.worker, command);
  if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < RENDER_LEASE_SECONDS.min || input.leaseSeconds > RENDER_LEASE_SECONDS.max) {
    throw new RenderWorkerError(null, command, 'leaseSeconds');
  }
  const reply = await workerCall(client, command, { p_worker: worker, p_lease_seconds: input.leaseSeconds });
  if (reply.conflict) throw new RenderWorkerError('40001', command);
  if (reply.data === null || reply.data === undefined) return null;
  const parsed = ClaimSchema.safeParse(reply.data);
  if (!parsed.success) throw new RenderWorkerError(null, command);
  const c = parsed.data;
  return {
    jobId: c.jobId,
    documentId: c.documentId,
    kind: c.kind,
    inputHash: c.inputHash,
    templateVersion: c.templateVersion,
    factsHash: c.factsHash,
    attempts: c.attempts,
    objectPath: c.objectPath ?? (c.legalEntityId ? renderedObjectPath(c.legalEntityId, c.documentId, c.jobId) : null),
  };
}

// ---------------------------------------------------------------------------
// itinerary_render_complete: report the job's outcome. Success needs the PDF
// already uploaded at the job's object path with the same size; a final with
// placeholders, layout issues or safety hits fails qa_blocked; a failure is
// retried (queued) until the third attempt.
// ---------------------------------------------------------------------------

/** Failure codes the worker may report (database allowlist). */
export const RENDER_FAILURE_CODES = [
  'render_timeout',
  'browser_failed',
  'asset_missing',
  'input_invalid',
  'upload_failed',
  'internal',
  'content_safety',
  'layout_overflow',
  'placeholders_present',
  'text_clipped',
  'qa_blocked',
] as const;
/**
 * Failures that end the job at once (the same input fails the same way);
 * the others go back to the queue while attempts remain (Atlas 5d321b3).
 */
export const RENDER_DETERMINISTIC_FAILURES = ['placeholders_present', 'content_safety', 'input_invalid', 'layout_overflow', 'text_clipped', 'qa_blocked', 'asset_missing'] as const satisfies readonly RenderFailureCode[];
export type RenderFailureCode = (typeof RENDER_FAILURE_CODES)[number];
/** Codes a job can end with: the worker's, plus the database's own. */
export const RENDER_JOB_ERROR_CODES = [...RENDER_FAILURE_CODES, 'input_changed', 'lease_expired'] as const;
export type RenderJobErrorCode = (typeof RENDER_JOB_ERROR_CODES)[number];

export interface RenderedFileReport {
  objectPath: string;
  sha256: string;
  sizeBytes: number;
  pageCount: number;
  qa: {
    /** Placeholders still in the document (a final needs 0). */
    placeholders: number;
    /** Lower-case codes only, never text from the document. */
    layoutIssues: string[];
    safetyHits: string[];
  };
}

export type RenderOutcome = { ok: true; file: RenderedFileReport } | { ok: false; errorCode: RenderFailureCode };

export type ItineraryRenderCompleteResult =
  | { status: 'succeeded'; jobId: string; renderedId: string }
  /** queued = retried later; failed = final (attempts used up, qa_blocked, input_changed, or upload not found → upload_failed). */
  | { status: 'queued' | 'failed'; jobId: string; errorCode: RenderJobErrorCode }
  /** The worker no longer holds the job: drop it. */
  | { status: 'conflict' };

const QA_CODE = /^[a-z_]{1,60}$/;

function fileOk(f: RenderedFileReport): boolean {
  return (
    /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.pdf$/.test(f.objectPath) &&
    /^[0-9a-f]{64}$/.test(f.sha256) &&
    Number.isInteger(f.sizeBytes) && f.sizeBytes >= 1 && f.sizeBytes <= RENDERED_MAX_BYTES &&
    Number.isInteger(f.pageCount) && f.pageCount >= 1 && f.pageCount <= 200 &&
    Number.isInteger(f.qa.placeholders) && f.qa.placeholders >= 0 && f.qa.placeholders <= 1000 &&
    f.qa.layoutIssues.length <= 100 && f.qa.layoutIssues.every((c) => QA_CODE.test(c)) &&
    f.qa.safetyHits.length <= 100 && f.qa.safetyHits.every((c) => QA_CODE.test(c))
  );
}

const CompleteSchema = z.union([
  z.object({ jobId: z.uuid(), status: z.literal('succeeded'), renderedId: z.uuid() }),
  z.object({ jobId: z.uuid(), status: z.enum(['queued', 'failed']), errorCode: z.enum(RENDER_JOB_ERROR_CODES) }),
]);

export async function itineraryRenderCompleteForWorker(
  input: { jobId: string; worker: string; outcome: RenderOutcome },
  client: RpcClient = asRpcClient(createSupabaseAdminClient()),
): Promise<ItineraryRenderCompleteResult> {
  const command = 'itinerary_render_complete';
  if (!z.uuid().safeParse(input.jobId).success) throw new RenderWorkerError(null, command, 'jobId');
  const worker = workerName(input.worker, command);
  const o = input.outcome;
  if (o.ok && !fileOk(o.file)) throw new RenderWorkerError(null, command, 'file');
  if (!o.ok && !(RENDER_FAILURE_CODES as readonly string[]).includes(o.errorCode)) throw new RenderWorkerError(null, command, 'errorCode');
  const reply = await workerCall(client, command, {
    p_job_id: input.jobId,
    p_worker: worker,
    p_ok: o.ok,
    p_error_code: o.ok ? null : o.errorCode,
    p_file: o.ok
      ? { objectPath: o.file.objectPath, sha256: o.file.sha256, sizeBytes: o.file.sizeBytes, pageCount: o.file.pageCount, qa: { placeholders: o.file.qa.placeholders, layoutIssues: [...o.file.qa.layoutIssues], safetyHits: [...o.file.qa.safetyHits] } }
      : null,
  });
  if (reply.conflict) return { status: 'conflict' };
  const parsed = CompleteSchema.safeParse(reply.data);
  if (!parsed.success) throw new RenderWorkerError(null, command);
  return parsed.data;
}

/**
 * Reads the render input of a job the worker holds. `client` defaults to the
 * privileged (service-role) client; tests pass their own.
 */
export async function itineraryRenderInputForWorker(
  input: { jobId: string; worker: string },
  client: RpcClient = asRpcClient(createSupabaseAdminClient()),
): Promise<ItineraryRenderInput> {
  const command = 'itinerary_render_input';
  if (!z.uuid().safeParse(input.jobId).success) throw new RenderWorkerError(null, command, 'jobId');
  const worker = workerName(input.worker, command);
  const reply = await workerCall(client, command, { p_job_id: input.jobId, p_worker: worker });
  if (reply.conflict) return { status: 'conflict' };
  const failed = FailedSchema.safeParse(reply.data);
  if (failed.success) return failed.data;
  const running = RunningSchema.safeParse(reply.data);
  if (!running.success) throw new RenderWorkerError(null, command);
  const r = running.data;
  return {
    status: 'running',
    jobId: r.jobId,
    documentId: r.documentId,
    kind: r.kind,
    templateVersion: r.templateVersion,
    inputHash: r.inputHash,
    factsHash: r.factsHash,
    factsChanged: r.factsChanged,
    basisChanged: r.basisChanged ?? false,
    facts: r.facts,
    title: r.title,
    basis: { kind: r.basis.kind, id: r.basis.id ?? null, hash: r.basis.hash },
    money: r.money ?? null,
    branchCode: r.branchCode ?? null,
  };
}
