import 'server-only';
import { z } from 'zod';
import { getAppConfig } from '@/lib/config';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { requireStaff } from '@/modules/identity/server/session';
import { asRpcClient, authorizeEvidenceDownload } from '../commands';
import { EVIDENCE_BUCKET, EVIDENCE_SIGNED_URL_SECONDS } from '../contracts';

/**
 * GET /app/bookings/evidence/[id] (contract §7):
 *   1. requireStaff() (redirects to sign-in / MFA when the session is not valid);
 *   2. booking_authorize_evidence_download under the user's own session
 *      (can_read_booking_evidence: never Purchase; stored files only; audited);
 *   3. only then the privileged client signs a 60 s download URL;
 *   4. 302 to it. The URL is never logged or rendered in a page.
 * Every refusal is an indistinguishable 404. Responses are never cached.
 */

const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0', 'Referrer-Policy': 'no-referrer' };

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8' } });
}

export async function evidenceDownloadResponse(rawId: string): Promise<Response> {
  const staff = await requireStaff();
  const id = z.uuid().safeParse(rawId);
  if (!id.success) return notFound();

  let file;
  try {
    file = await authorizeEvidenceDownload(asRpcClient(staff.supabase), id.data);
  } catch {
    return notFound();
  }

  let signedUrl: string | null = null;
  try {
    const { data, error } = await createSupabaseAdminClient()
      .storage.from(EVIDENCE_BUCKET)
      .createSignedUrl(file.objectPath, EVIDENCE_SIGNED_URL_SECONDS, { download: file.fileName });
    signedUrl = error ? null : (data?.signedUrl ?? null);
  } catch {
    signedUrl = null;
  }
  // Redirect only to the configured Supabase origin (never to an arbitrary host).
  const expectedOrigin = new URL(getAppConfig().supabaseUrl).origin;
  if (!signedUrl || new URL(signedUrl, expectedOrigin).origin !== expectedOrigin) {
    return new Response('This file is not available right now. Please retry.', {
      status: 503,
      headers: { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  return new Response(null, {
    status: 302,
    headers: { ...NO_STORE, Location: new URL(signedUrl, expectedOrigin).toString() },
  });
}
