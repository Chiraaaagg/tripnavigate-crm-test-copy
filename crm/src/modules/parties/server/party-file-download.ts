import 'server-only';
import { z } from 'zod';
import { getAppConfig } from '@/lib/config';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { EVIDENCE_SIGNED_URL_SECONDS, type EvidenceMime } from '@/modules/fulfilment/contracts';
import { accountsRoleEntityIds } from '@/modules/parties/import-access';
import { requireStaff } from '@/modules/identity/server/session';
import { partyDocumentAuthorizeDownload } from './parties-db';

/**
 * GET handler body for /app/accounts/customers/[id]/files/[fileId]: one
 * customer document (ID proof, GST certificate, other).
 *   1. requireStaff();
 *   1a. Accounts only (the Accounts check screen is the only place that links here);
 *   2. customer_party_document_authorize_download under the user's own
 *      session (customer readers only; never Purchase; stored files only;
 *      audited);
 *   3. only then the privileged client signs a short-lived URL with a
 *      neutral file name (the stored name may carry a person's name);
 *   4. 302 to it. The URL is never logged or rendered in a page.
 * A malformed id, a path that does not end in this file id, or any refusal
 * is the same 404. Never cached.
 */

const BUCKET = 'customer-party-documents';
const EXTENSION: Record<EvidenceMime, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0', 'Referrer-Policy': 'no-referrer' };

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8' } });
}

export async function partyFileDownloadResponse(partyId: string, raw: string): Promise<Response> {
  const staff = await requireStaff();
  // Echo-A L12: customer documents open from the Accounts check screen only (Accounts of some company; never Purchase there).
  if (accountsRoleEntityIds(staff.access).length === 0) return notFound();
  const fileId = z.uuid().safeParse(raw);
  if (!fileId.success || !z.uuid().safeParse(partyId).success) return notFound();
  let file;
  try {
    file = await partyDocumentAuthorizeDownload(asRpcClient(staff.supabase), fileId.data);
  } catch {
    return notFound();
  }
  if (!file) return notFound();
  const parts = file.objectPath.toLowerCase().split('/');
  if (parts[parts.length - 1] !== fileId.data.toLowerCase()) return notFound();
  const ext = EXTENSION[file.mime as EvidenceMime];
  if (!ext) return notFound();
  let signedUrl: string | null = null;
  try {
    const { data, error } = await createSupabaseAdminClient().storage.from(BUCKET).createSignedUrl(file.objectPath, EVIDENCE_SIGNED_URL_SECONDS, { download: `customer-document.${ext}` });
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
