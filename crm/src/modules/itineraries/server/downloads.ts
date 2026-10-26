import 'server-only';
import { z } from 'zod';
import { getAppConfig } from '@/lib/config';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { EVIDENCE_SIGNED_URL_SECONDS } from '@/modules/fulfilment/contracts';
import { requireStaff } from '@/modules/identity/server/session';
import { itineraryRenderedAuthorizeDownload, itinerarySourceAuthorizeDownload } from '../commands';
import { DOCX_MIME, RENDERED_BUCKET, SOURCE_BUCKET, type SourceMime } from '../contracts';

/**
 * GET handler bodies for /app/itineraries/sources/[fileId] and
 * /app/itineraries/rendered/[renderedId] (route files owned by the UI agent):
 * requireStaff(); the database authorizes and audits under the user's own
 * session (editors only); only then the privileged client signs a 60 s URL
 * with a neutral file name; 302. Every refusal, a malformed id or a path
 * that does not end in this id is the same 404; never cached.
 */

const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0', 'Referrer-Policy': 'no-referrer' };
const EXTENSION: Record<SourceMime, string> = { 'application/pdf': 'pdf', [DOCX_MIME]: 'docx', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8' } });
}

async function signed(bucket: string, objectPath: string, downloadName: string): Promise<Response> {
  let signedUrl: string | null = null;
  try {
    const { data, error } = await createSupabaseAdminClient().storage.from(bucket).createSignedUrl(objectPath, EVIDENCE_SIGNED_URL_SECONDS, { download: downloadName });
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

export async function itinerarySourceDownloadResponse(rawFileId: string): Promise<Response> {
  const staff = await requireStaff();
  const id = z.uuid().safeParse(rawFileId);
  if (!id.success) return notFound();
  let file;
  try {
    file = await itinerarySourceAuthorizeDownload(asRpcClient(staff.supabase), id.data);
  } catch {
    return notFound();
  }
  if (file.objectPath.toLowerCase().split('/').pop() !== id.data.toLowerCase()) return notFound();
  return signed(SOURCE_BUCKET, file.objectPath, `itinerary-source.${EXTENSION[file.mime]}`);
}

export async function itineraryRenderedDownloadResponse(rawRenderedId: string): Promise<Response> {
  const staff = await requireStaff();
  const id = z.uuid().safeParse(rawRenderedId);
  if (!id.success) return notFound();
  let file;
  try {
    file = await itineraryRenderedAuthorizeDownload(asRpcClient(staff.supabase), id.data);
  } catch {
    return notFound();
  }
  // The database names the file without customer names (itinerary-<kind>-<date>.pdf).
  return signed(RENDERED_BUCKET, file.objectPath, file.fileName);
}
