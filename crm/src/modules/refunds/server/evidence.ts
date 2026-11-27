import 'server-only';
import { z } from 'zod';
import { getAppConfig } from '@/lib/config';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { checkEvidenceFile } from '@/modules/fulfilment/evidence';
import { requireStaff, type StaffContext } from '@/modules/identity/server/session';
import { RefundCommandError, refundEvidenceAuthorizeDownload, refundEvidenceBegin, refundEvidenceFinish } from '../commands';
import {
  REFUND_EVIDENCE_BUCKET,
  REFUND_EVIDENCE_MAX_BYTES,
  REFUND_EVIDENCE_SIGNED_URL_SECONDS,
  type RefundErrorCode,
  type RefundEvidenceSubject,
} from '../contracts';

/**
 * Refund proof files (contract 7.1 refund_evidence, C5), following the
 * finance evidence pattern: the database authorizes the Accounts person and
 * generates the object path (refund_evidence_begin) under the staff session;
 * only then the privileged client writes to the private finance-evidence
 * bucket; refund_evidence_finish marks the row stored only when Storage holds
 * the object with the declared size. Downloads are authorized and audited by
 * the database (Accounts, the Deal's branch Manager), then signed for 60
 * seconds. Nothing here logs file contents, amounts or personal data.
 */

type Staff = Pick<StaffContext, 'supabase'>;

export type StoreRefundEvidenceResult =
  | { ok: true; evidenceId: string }
  | { ok: false; code: RefundErrorCode | 'file_rejected' | 'upload_failed' | 'unknown'; field?: string };

function codeOf(error: unknown): { code: RefundErrorCode | 'unknown'; field?: string } {
  if (error instanceof RefundCommandError && error.code && error.code !== 'session') {
    return { code: error.code, ...(error.code === 'invalid_input' && error.hint ? { field: error.hint } : {}) };
  }
  return { code: 'unknown' };
}

/** Server-side upload: checks the file (size, type, magic bytes, sha256), begin, upload, finish. */
export async function storeRefundEvidence(
  staff: Staff,
  input: { subjectKind: RefundEvidenceSubject; subjectId: string; file: unknown; requestId: string },
): Promise<StoreRefundEvidenceResult> {
  const file = input.file;
  if (!(file instanceof Blob) || file.size === 0 || file.size > REFUND_EVIDENCE_MAX_BYTES) return { ok: false, code: 'file_rejected' };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkEvidenceFile({
    bytes,
    declaredMime: file.type,
    fileName: 'name' in file && typeof file.name === 'string' ? file.name : '',
  });
  if (!check.ok) return { ok: false, code: 'file_rejected' };

  const rpc = asRpcClient(staff.supabase);
  let begun;
  try {
    begun = await refundEvidenceBegin(rpc, {
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      fileName: check.fileName,
      mime: check.mime,
      sizeBytes: check.sizeBytes,
      sha256: check.sha256,
      requestId: input.requestId,
    });
  } catch (error) {
    return { ok: false, ...codeOf(error) };
  }

  let uploaded = false;
  try {
    const upload = await createSupabaseAdminClient()
      .storage.from(REFUND_EVIDENCE_BUCKET)
      .upload(begun.objectPath, bytes, { contentType: check.mime, upsert: false });
    // An exact retry of begin returns the same path; an existing object is fine.
    uploaded = !upload.error || (begun.outcome === 'existing' && /exist/i.test(upload.error.message ?? ''));
  } catch {
    uploaded = false;
  }
  if (!uploaded) {
    await refundEvidenceFinish(rpc, begun.evidenceId, false).catch(() => undefined);
    return { ok: false, code: 'upload_failed' };
  }
  try {
    const finished = await refundEvidenceFinish(rpc, begun.evidenceId, true);
    return finished.status === 'stored' ? { ok: true, evidenceId: begun.evidenceId } : { ok: false, code: 'upload_failed' };
  } catch {
    // The finish may have committed; the outcome is unknown. Never delete the object.
    return { ok: false, code: 'unknown' };
  }
}

const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0', 'Referrer-Policy': 'no-referrer' };

function filePage(status: 404 | 503, title: string, text: string): Response {
  const body = `<!doctype html><html lang="en-IN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${title} · TripNavigate CRM</title></head><body><main><h1>${title}</h1><p>${text}</p>` +
    `<p><a href="/app/accounts/refunds">Back to Refunds</a></p></main></body></html>`;
  return new Response(body, { status, headers: { ...NO_STORE, 'Content-Type': 'text/html; charset=utf-8' } });
}

const notFound = () => filePage(404, 'File not available', 'This file does not exist or you cannot open it.');
const unavailable = () => filePage(503, 'File not available right now', 'The file could not be opened right now. Go back and open it again.');

const REFUSAL_STATES = new Set(['42501', 'P0002', '55000']);

/**
 * GET /app/accounts/refunds/evidence/[evidenceId]: authorize under the staff
 * session (Accounts of the entity or the Deal's branch Manager, stored files
 * only, audited), then a 60 s signed URL and a 302. Every refusal is an
 * indistinguishable 404.
 */
export async function refundEvidenceDownloadResponse(rawId: string): Promise<Response> {
  const staff = await requireStaff();
  const id = z.uuid().safeParse(rawId);
  if (!id.success) return notFound();

  let file;
  try {
    file = await refundEvidenceAuthorizeDownload(asRpcClient(staff.supabase), id.data);
  } catch (error) {
    const refused = error instanceof RefundCommandError
      && (error.code === 'session' || (error.sqlState !== null && REFUSAL_STATES.has(error.sqlState)));
    return refused ? notFound() : unavailable();
  }

  let signedUrl: string | null = null;
  try {
    const { data, error } = await createSupabaseAdminClient()
      .storage.from(REFUND_EVIDENCE_BUCKET)
      .createSignedUrl(file.objectPath, REFUND_EVIDENCE_SIGNED_URL_SECONDS, { download: file.fileName });
    signedUrl = error ? null : (data?.signedUrl ?? null);
  } catch {
    signedUrl = null;
  }
  const expectedOrigin = new URL(getAppConfig().supabaseUrl).origin;
  if (!signedUrl || new URL(signedUrl, expectedOrigin).origin !== expectedOrigin) {
    return unavailable();
  }
  return new Response(null, { status: 302, headers: { ...NO_STORE, Location: new URL(signedUrl, expectedOrigin).toString() } });
}
