import 'server-only';
import { z } from 'zod';
import { getAppConfig } from '@/lib/config';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { EVIDENCE_SIGNED_URL_SECONDS, type EvidenceMime } from '@/modules/fulfilment/contracts';
import { requireStaff } from '@/modules/identity/server/session';
import { quotationEvidenceAuthorizeDownload } from '../commands';
import { QUOTATION_EVIDENCE_BUCKET } from '../contracts';

/**
 * GET handler body for /app/quotations/evidence/[evidenceId] (route file
 * owned by the UI agent):
 *   1. requireStaff();
 *   2. quotation_evidence_authorize_download under the user's own session
 *      (quotation editors only; stored files only; audited on every call);
 *   3. only then the privileged client signs a 60 s URL with a neutral
 *      download name (the stored name may carry a customer's name);
 *   4. 302 to it. Every refusal, a malformed id or a path that does not end
 *      in this evidence id is the same 404; never cached.
 */

const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0', 'Referrer-Policy': 'no-referrer' };
const EXTENSION: Record<EvidenceMime, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8' } });
}

export async function quotationEvidenceDownloadResponse(rawEvidenceId: string): Promise<Response> {
  const staff = await requireStaff();
  const id = z.uuid().safeParse(rawEvidenceId);
  if (!id.success) return notFound();
  let file;
  try {
    file = await quotationEvidenceAuthorizeDownload(asRpcClient(staff.supabase), id.data);
  } catch {
    return notFound();
  }
  const parts = file.objectPath.toLowerCase().split('/');
  if (parts[parts.length - 1] !== id.data.toLowerCase()) return notFound();
  let signedUrl: string | null = null;
  try {
    const { data, error } = await createSupabaseAdminClient()
      .storage.from(QUOTATION_EVIDENCE_BUCKET)
      .createSignedUrl(file.objectPath, EVIDENCE_SIGNED_URL_SECONDS, { download: `quotation-file.${EXTENSION[file.mime]}` });
    signedUrl = error ? null : (data?.signedUrl ?? null);
  } catch {
    signedUrl = null;
  }
  const expectedOrigin = new URL(getAppConfig().supabaseUrl).origin;
  if (!signedUrl || new URL(signedUrl, expectedOrigin).origin !== expectedOrigin) {
    return new Response('This file is not available right now. Please retry.', { status: 503, headers: { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  return new Response(null, { status: 302, headers: { ...NO_STORE, Location: new URL(signedUrl, expectedOrigin).toString() } });
}
