import 'server-only';
import { z } from 'zod';
import { deliverFile, isRecordedFileName } from '@/modules/documents/server/file-delivery';
import { requireStaff } from '@/modules/identity/server/session';
import { asRpcClient, authorizeEvidenceDownload } from '../commands';
import { EVIDENCE_BUCKET, EVIDENCE_SIGNED_URL_SECONDS } from '../contracts';
import { isEvidenceMime } from '../evidence';

/**
 * GET /app/bookings/evidence/[id] (contract §7):
 *   1. requireStaff() (redirects to sign-in / MFA when the session is not valid);
 *   2. booking_authorize_evidence_download under the user's own session
 *      (can_read_booking_evidence: never Purchase; stored files only; audited);
 *   3. only then the privileged client signs a 60 s download URL;
 *   4. 302 to it. The URL is never logged or rendered in a page.
 * S11: steps 2 to 4 run in deliverFile (file_view_begin calls the same
 * authorize function; a file kept in Bitrix is read and checked there).
 * Every refusal is an indistinguishable 404. Responses are never cached.
 */

const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0', 'Referrer-Policy': 'no-referrer' };

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8' } });
}

function unavailable(): Response {
  return new Response('This file is not available right now. Please retry.', {
    status: 503,
    headers: { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

export async function evidenceDownloadResponse(rawId: string): Promise<Response> {
  const staff = await requireStaff();
  const id = z.uuid().safeParse(rawId);
  if (!id.success) return notFound();

  const result = await deliverFile({
    staff,
    sourceTable: 'booking_evidence',
    sourceId: id.data,
    bucket: EVIDENCE_BUCKET,
    signedUrlSeconds: EVIDENCE_SIGNED_URL_SECONDS,
    legacyAuthorize: () => authorizeEvidenceDownload(asRpcClient(staff.supabase), id.data),
    // The recorded name, held to the same rule the authorize answer was checked against before.
    downloadName: (file) => (isRecordedFileName(file.fileName) && isEvidenceMime(file.mime) ? file.fileName : null),
    crmUnavailable: unavailable,
  });
  return result.kind === 'response' ? result.response : notFound();
}
