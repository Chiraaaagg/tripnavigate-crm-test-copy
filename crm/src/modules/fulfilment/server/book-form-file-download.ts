import 'server-only';
import { z } from 'zod';
import { getAppConfig } from '@/lib/config';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { serviceItemFileAuthorizeDownload } from '../b11-commands';
import { asRpcClient } from '../commands';
import { EVIDENCE_SIGNED_URL_SECONDS, type EvidenceMime } from '../contracts';
import { requireStaff } from '@/modules/identity/server/session';

/**
 * GET handler body for /app/deals/[id]/book/files/[fileId] and
 * /app/flight/files/[fileId]: flight screenshot
 * download (booking form, contract ruling 14):
 *   1. requireStaff() (redirects to sign-in / MFA when the session is not valid);
 *   2. service_item_file_authorize_download under the user's own session
 *      (Sales owner/assignee, branch Manager, the Flight assignee of that
 *      item; never Purchase or Accounts; stored files only; audited);
 *   3. only then the privileged client signs a 60 s download URL;
 *   4. 302 to it. The URL is never logged or rendered in a page.
 * A malformed id, a path that does not end in this file id, or any refusal is
 * an indistinguishable 404. GET handlers are dynamic (session cookies); the
 * response is never cached.
 */

const BUCKET = 'service-item-files';
const EXTENSION: Record<EvidenceMime, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0', 'Referrer-Policy': 'no-referrer' };

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8' } });
}

/** `dealId` is checked for shape only (the database authorizes by file); null for the Flight task route. */
export async function serviceFileDownloadResponse(id: string | null, raw: string): Promise<Response> {
  const staff = await requireStaff();
  const fileId = z.uuid().safeParse(raw);
  if (!fileId.success || (id !== null && !z.uuid().safeParse(id).success)) return notFound();

  let file;
  try {
    file = await serviceItemFileAuthorizeDownload(asRpcClient(staff.supabase), fileId.data);
  } catch {
    return notFound();
  }
  const parts = file.objectPath.toLowerCase().split('/');
  if (parts[parts.length - 1] !== fileId.data.toLowerCase()) return notFound();

  let signedUrl: string | null = null;
  try {
    const { data, error } = await createSupabaseAdminClient()
      .storage.from(BUCKET)
      // A neutral name: the stored name may carry a customer's name, and it would sit in the URL and logs.
      .createSignedUrl(file.objectPath, EVIDENCE_SIGNED_URL_SECONDS, { download: `flight-screenshot.${EXTENSION[file.mime]}` });
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
