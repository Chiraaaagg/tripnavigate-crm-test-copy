import 'server-only';
import { z } from 'zod';
import { getAppConfig } from '@/lib/config';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { requireStaff } from '@/modules/identity/server/session';
import { departmentEvidenceAuthorizeDownload } from '../b11-commands';
import { asRpcClient } from '../commands';
import { DEPARTMENT_EVIDENCE_BUCKET, EVIDENCE_SIGNED_URL_SECONDS } from '../contracts';

/**
 * GET handler body for a department file (route owned by the UI agent):
 *   1. requireStaff();
 *   2. department_evidence_authorize_download under the user's own session
 *      (task worker, branch Manager, Accounts only for fee receipts and
 *      direct-payment proofs of a submitted cost; applicant documents never
 *      to Accounts, Purchase or Flight; audited);
 *   3. only then the privileged client signs a 60 s URL; 302 to it.
 * Every refusal is an indistinguishable 404; never cached.
 */

const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0', 'Referrer-Policy': 'no-referrer' };

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8' } });
}

export async function departmentEvidenceDownloadResponse(rawId: string): Promise<Response> {
  const staff = await requireStaff();
  const id = z.uuid().safeParse(rawId);
  if (!id.success) return notFound();
  let file;
  try {
    file = await departmentEvidenceAuthorizeDownload(asRpcClient(staff.supabase), id.data);
  } catch {
    return notFound();
  }
  let signedUrl: string | null = null;
  try {
    const { data, error } = await createSupabaseAdminClient()
      .storage.from(DEPARTMENT_EVIDENCE_BUCKET)
      .createSignedUrl(file.objectPath, EVIDENCE_SIGNED_URL_SECONDS, { download: file.fileName });
    signedUrl = error ? null : (data?.signedUrl ?? null);
  } catch {
    signedUrl = null;
  }
  const expectedOrigin = new URL(getAppConfig().supabaseUrl).origin;
  if (!signedUrl || new URL(signedUrl, expectedOrigin).origin !== expectedOrigin) {
    return new Response('This file is not available right now. Please retry.', {
      status: 503,
      headers: { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  return new Response(null, { status: 302, headers: { ...NO_STORE, Location: new URL(signedUrl, expectedOrigin).toString() } });
}
