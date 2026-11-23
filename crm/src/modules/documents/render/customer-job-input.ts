import { z } from 'zod';
import { checkContent, contentTitle, type ContentCheck, type CustomerDocumentContent } from '@/modules/customer-documents/content';

/**
 * Customer document render jobs (contract 6.7 worker commands, 6.8): the
 * claim and render-input replies (service-role wrappers parse them here) and
 * the content -> template input step shared by the local worker, the online
 * PDF maker and the in-app print page, so all three print exactly the frozen
 * content the database holds. Pure.
 */

const sha = z.string().regex(/^[0-9a-f]{64}$/);
const objectPath = z.string().regex(/^[0-9a-f-]{36}\/customer-documents\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.pdf$/);

export const CustomerRenderClaimSchema = z
  .object({
    jobId: z.uuid(),
    documentId: z.uuid(),
    contentSha256: sha,
    templateVersion: z.string().regex(/^[a-z0-9._-]{1,40}$/),
    attempts: z.number().int().min(1).max(3),
    legalEntityId: z.uuid(),
    objectPath,
  })
  .strict();
export type CustomerRenderClaim = z.infer<typeof CustomerRenderClaimSchema>;

export const CustomerRenderInputSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('running'),
      jobId: z.uuid(),
      documentId: z.uuid(),
      templateVersion: z.string(),
      contentSha256: sha,
      content: z.unknown(),
      objectPath,
    })
    .strict(),
  z.object({ status: z.literal('failed'), jobId: z.uuid(), errorCode: z.literal('content_changed') }).strict(),
]);
export type CustomerRenderInput = z.infer<typeof CustomerRenderInputSchema>;

export const CustomerRenderCompleteSchema = z
  .object({
    jobId: z.uuid(),
    status: z.enum(['queued', 'running', 'succeeded', 'failed']),
    fileId: z.uuid().nullable(),
    errorCode: z.string().optional(),
  })
  .strict();
export type CustomerRenderComplete = z.infer<typeof CustomerRenderCompleteSchema>;

/** The file the complete command stores (contract 6.2 customer_document_files). */
export interface CustomerRenderedFile {
  objectPath: string;
  sha256: string;
  sizeBytes: number;
  pageCount: number;
}

/** The template input of one running job: the frozen content, checked (shape, forbidden keys, safety scan). */
export function customerJobContent(input: Extract<CustomerRenderInput, { status: 'running' }>): ContentCheck {
  return checkContent(input.content);
}

/** The PDF / print title ("Invoice 10101-INV-1"). */
export function customerJobTitle(content: CustomerDocumentContent): string {
  return contentTitle(content);
}

// ---------------------------------------------------------------------------
// Service-role wrappers (the worker commands are granted to service_role only)
// ---------------------------------------------------------------------------

/** Minimal RPC surface (the Supabase client under the secret key). */
export interface CustomerRenderRpc {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string; message?: string; hint?: string | null } | null }>;
}

/** Same name and fields as the itinerary wrapper's error, so crm/scripts/render-worker.mjs prints codes only. */
export class CustomerRenderWorkerError extends Error {
  override name = 'RenderWorkerError';
  constructor(
    readonly sqlState: string | null,
    readonly command: string,
    readonly hint: string | null = null,
  ) {
    super(`${command} failed${sqlState ? ` (${sqlState})` : ''}${hint ? `: ${hint}` : ''}`);
  }
}

const WORKER_NAME = /^[a-z0-9][a-z0-9._-]{0,59}$/;

async function call(client: CustomerRenderRpc, command: string, args: Record<string, unknown>): Promise<{ data: unknown; conflict: boolean }> {
  let reply: Awaited<ReturnType<CustomerRenderRpc['rpc']>>;
  try {
    reply = await client.rpc(command, args);
  } catch {
    throw new CustomerRenderWorkerError(null, command);
  }
  if (reply.error) {
    if (reply.error.code === '40001' && (reply.error.message ?? '').trim() === 'task_conflict') return { data: null, conflict: true };
    throw new CustomerRenderWorkerError(reply.error.code ?? null, command, reply.error.hint ?? null);
  }
  return { data: reply.data, conflict: false };
}

function checkWorker(worker: string, command: string): void {
  if (!WORKER_NAME.test(worker)) throw new CustomerRenderWorkerError(null, command, 'worker');
}

export async function customerRenderClaim(client: CustomerRenderRpc, worker: string, leaseSeconds: number): Promise<CustomerRenderClaim | null> {
  const command = 'customer_document_render_claim';
  checkWorker(worker, command);
  const reply = await call(client, command, { p_worker: worker, p_lease_seconds: leaseSeconds });
  if (reply.conflict) throw new CustomerRenderWorkerError('40001', command);
  if (reply.data === null || reply.data === undefined) return null;
  const parsed = CustomerRenderClaimSchema.safeParse(reply.data);
  if (!parsed.success) throw new CustomerRenderWorkerError(null, command);
  return parsed.data;
}

/** The job's frozen content while `worker` holds the lease; { status: 'conflict' } without it. */
export async function customerRenderInput(client: CustomerRenderRpc, jobId: string, worker: string): Promise<CustomerRenderInput | { status: 'conflict' }> {
  const command = 'customer_document_render_input';
  checkWorker(worker, command);
  const reply = await call(client, command, { p_job_id: jobId, p_worker: worker });
  if (reply.conflict) return { status: 'conflict' };
  const parsed = CustomerRenderInputSchema.safeParse(reply.data);
  if (!parsed.success) throw new CustomerRenderWorkerError(null, command);
  return parsed.data;
}

export async function customerRenderComplete(
  client: CustomerRenderRpc,
  jobId: string,
  worker: string,
  outcome: { ok: true; file: CustomerRenderedFile } | { ok: false; errorCode: string },
): Promise<CustomerRenderComplete> {
  const command = 'customer_document_render_complete';
  checkWorker(worker, command);
  const reply = await call(client, command, {
    p_job_id: jobId,
    p_worker: worker,
    p_ok: outcome.ok,
    p_error_code: outcome.ok ? null : outcome.errorCode,
    p_file: outcome.ok ? outcome.file : null,
  });
  if (reply.conflict) throw new CustomerRenderWorkerError('40001', command);
  const parsed = CustomerRenderCompleteSchema.safeParse(reply.data);
  if (!parsed.success) throw new CustomerRenderWorkerError(null, command);
  return parsed.data;
}
