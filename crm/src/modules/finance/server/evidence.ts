import 'server-only';
import { z } from 'zod';
import { getAppConfig } from '@/lib/config';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { asRpcClient, type RpcClient } from '@/modules/fulfilment/commands';
import { checkEvidenceFile } from '@/modules/fulfilment/evidence';
import { requireStaff, type StaffContext } from '@/modules/identity/server/session';
import { evidenceAuthorizeDownload, evidenceBegin, evidenceFinish, evidenceRemove, FinanceCommandError } from '../commands';
import {
  FINANCE_EVIDENCE_BUCKET,
  FINANCE_EVIDENCE_MAX_BYTES,
  FINANCE_EVIDENCE_SIGNED_URL_SECONDS,
  type FinanceErrorCode,
  type FinanceEvidenceKind,
} from '../contracts';

/**
 * Finance evidence (contract section 13), following the purchase evidence
 * pattern: the database authorizes the actor and generates the object path
 * (finance_evidence_begin) under the staff session; only then the privileged
 * client touches the private bucket; finance_evidence_finish marks the row
 * stored only when Storage holds the object with the declared size. Downloads
 * are authorized and audited by the database, then signed for 60 seconds.
 * Nothing here logs file contents, amounts or personal data.
 */

type Staff = Pick<StaffContext, 'supabase'>;

export type EvidenceTarget = { targetType: 'receipt' | 'branch'; targetId: string };

export type StoreEvidenceResult =
  | { ok: true; evidenceId: string }
  | { ok: false; code: FinanceErrorCode | 'file_rejected' | 'upload_failed' | 'unknown' };

function codeOf(error: unknown): FinanceErrorCode | 'unknown' {
  return error instanceof FinanceCommandError && error.code && error.code !== 'session' ? error.code : 'unknown';
}

/** Server-side upload: checks the file (size, type, magic bytes, sha256), begin, upload, finish. */
export async function storeFinanceEvidence(
  staff: Staff,
  input: EvidenceTarget & { kind: FinanceEvidenceKind; file: unknown; requestId: string },
): Promise<StoreEvidenceResult> {
  const file = input.file;
  if (!(file instanceof Blob) || file.size === 0 || file.size > FINANCE_EVIDENCE_MAX_BYTES) return { ok: false, code: 'file_rejected' };
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
    begun = await evidenceBegin(rpc, {
      targetType: input.targetType,
      targetId: input.targetId,
      kind: input.kind,
      fileName: check.fileName,
      mime: check.mime,
      sizeBytes: check.sizeBytes,
      sha256: check.sha256,
      requestId: input.requestId,
    });
  } catch (error) {
    return { ok: false, code: codeOf(error) };
  }

  let uploaded = false;
  try {
    const upload = await createSupabaseAdminClient()
      .storage.from(FINANCE_EVIDENCE_BUCKET)
      .upload(begun.objectPath, bytes, { contentType: check.mime, upsert: false });
    // An exact retry of begin returns the same path; an existing object is fine.
    uploaded = !upload.error || (begun.outcome === 'existing' && /exist/i.test(upload.error.message ?? ''));
  } catch {
    uploaded = false;
  }
  if (!uploaded) {
    await evidenceFinish(rpc, begun.id, false).catch(() => undefined);
    return { ok: false, code: 'upload_failed' };
  }
  try {
    const finished = await evidenceFinish(rpc, begun.id, true);
    return finished.status === 'stored' ? { ok: true, evidenceId: begun.id } : { ok: false, code: 'upload_failed' };
  } catch {
    // The finish may have committed; the outcome is unknown. Never delete the object.
    return { ok: false, code: 'unknown' };
  }
}

/** Best-effort removal of a slip or proof that was stored but not used (never throws). */
export async function discardFinanceEvidence(rpc: RpcClient, evidenceId: string): Promise<void> {
  await evidenceRemove(rpc, evidenceId).catch(() => undefined);
}

const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0', 'Referrer-Policy': 'no-referrer' };

/** A minimal readable page with a way back; the same text for every refusal. */
function filePage(status: 404 | 503, title: string, text: string): Response {
  const body = `<!doctype html><html lang="en-IN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${title} · TripNavigate CRM</title></head><body><main><h1>${title}</h1><p>${text}</p>` +
    `<p><a href="/app/accounts">Back to Accounts</a></p></main></body></html>`;
  return new Response(body, { status, headers: { ...NO_STORE, 'Content-Type': 'text/html; charset=utf-8' } });
}

function notFound(): Response {
  return filePage(404, 'File not available', 'This file does not exist or you cannot open it.');
}

function unavailable(): Response {
  return filePage(503, 'File not available right now', 'The file could not be opened right now. Go back and open it again.');
}

/** Refusals (permission, missing, not configured, ended session) look alike; anything else is a temporary failure. */
const REFUSAL_STATES = new Set(['42501', 'P0002', '55000']);

/**
 * GET /app/accounts/files/[id]: authorize under the staff session (Accounts
 * in the file's entity, stored files only, audited), then a 60 s signed URL
 * and a 302. Every refusal is an indistinguishable 404.
 */
export async function financeEvidenceDownloadResponse(rawId: string): Promise<Response> {
  const staff = await requireStaff();
  const id = z.uuid().safeParse(rawId);
  if (!id.success) return notFound();

  let file;
  try {
    file = await evidenceAuthorizeDownload(asRpcClient(staff.supabase), id.data);
  } catch (error) {
    const refused = error instanceof FinanceCommandError
      && (error.code === 'session' || (error.sqlState !== null && REFUSAL_STATES.has(error.sqlState)));
    return refused ? notFound() : unavailable();
  }

  let signedUrl: string | null = null;
  try {
    const { data, error } = await createSupabaseAdminClient()
      .storage.from(FINANCE_EVIDENCE_BUCKET)
      .createSignedUrl(file.objectPath, FINANCE_EVIDENCE_SIGNED_URL_SECONDS, { download: file.fileName });
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
