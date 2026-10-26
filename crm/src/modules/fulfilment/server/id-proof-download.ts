import 'server-only';
import { z } from 'zod';
import { getAppConfig } from '@/lib/config';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { requireStaff } from '@/modules/identity/server/session';
import { travellerIdProofAuthorizeDownload } from '../b11-commands';
import { asRpcClient } from '../commands';
import { EVIDENCE_SIGNED_URL_SECONDS, type EvidenceMime, ID_PROOF_BUCKET } from '../contracts';

/**
 * GET handler body for /app/id-proofs/[fileId] (route file owned by the UI
 * agent; B1.2 freeze note §2.2, DEC-39/DEC-41). One route for every allowed
 * viewer, outside /book, so department task screens can link it:
 *   1. requireStaff() (redirects to sign-in / MFA when the session is not valid);
 *   2. traveller_id_proof_authorize_download under the user's own session
 *      (staff linked to the Deal's booking: Sales owner/assignee, branch
 *      Manager, Accounts, the assignees of its service tasks; never Super
 *      Admin by role alone; stored files only; audited on every call);
 *   3. only then the privileged client signs a 60 s download URL;
 *   4. 302 to it. The URL is never logged or rendered in a page.
 * A malformed id, a path that does not end in this file id, or any refusal is
 * an indistinguishable 404. Responses are never cached.
 */

const ID_PROOF_EXTENSION: Record<EvidenceMime, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0', 'Referrer-Policy': 'no-referrer' };

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8' } });
}

export async function idProofDownloadResponse(rawFileId: string): Promise<Response> {
  const staff = await requireStaff();
  const fileId = z.uuid().safeParse(rawFileId);
  if (!fileId.success) return notFound();

  let file;
  try {
    file = await travellerIdProofAuthorizeDownload(asRpcClient(staff.supabase), fileId.data);
  } catch {
    return notFound();
  }
  // The object path ends in the file id: anything else is refused like a missing file.
  const parts = file.objectPath.toLowerCase().split('/');
  if (parts[parts.length - 1] !== fileId.data.toLowerCase()) return notFound();

  let signedUrl: string | null = null;
  try {
    const { data, error } = await createSupabaseAdminClient()
      .storage.from(ID_PROOF_BUCKET)
      // A neutral name: the stored name may carry a customer's name, and it would sit in the URL and logs.
      .createSignedUrl(file.objectPath, EVIDENCE_SIGNED_URL_SECONDS, { download: `id-proof.${ID_PROOF_EXTENSION[file.mime]}` });
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
