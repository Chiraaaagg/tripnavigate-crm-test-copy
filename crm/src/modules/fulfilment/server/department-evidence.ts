import 'server-only';
import { z } from 'zod';
import { deliverFile, isRecordedFileName, objectPathIsIds } from '@/modules/documents/server/file-delivery';
import { requireStaff } from '@/modules/identity/server/session';
import { departmentEvidenceAuthorizeDownload } from '../b11-commands';
import { asRpcClient } from '../commands';
import { DEPARTMENT_EVIDENCE_BUCKET, EVIDENCE_SIGNED_URL_SECONDS } from '../contracts';
import { isEvidenceMime } from '../evidence';

/**
 * GET handler body for a department file (route owned by the UI agent):
 *   1. requireStaff();
 *   2. department_evidence_authorize_download under the user's own session
 *      (task worker, branch Manager, Accounts only for fee receipts and
 *      direct-payment proofs of a submitted cost; applicant documents never
 *      to Accounts, Purchase or Flight; audited);
 *   3. only then the privileged client signs a 60 s URL; 302 to it.
 * S11: the authorize-and-sign steps run in deliverFile (file_view_begin calls
 * the same authorize function; a file kept in Bitrix is read and checked there).
 * Every refusal is an indistinguishable 404; never cached.
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

export async function departmentEvidenceDownloadResponse(rawId: string): Promise<Response> {
  const staff = await requireStaff();
  const id = z.uuid().safeParse(rawId);
  if (!id.success) return notFound();
  const result = await deliverFile({
    staff,
    sourceTable: 'department_evidence',
    sourceId: id.data,
    bucket: DEPARTMENT_EVIDENCE_BUCKET,
    signedUrlSeconds: EVIDENCE_SIGNED_URL_SECONDS,
    legacyAuthorize: () => departmentEvidenceAuthorizeDownload(asRpcClient(staff.supabase), id.data),
    // <entity>/<task>/<evidence id>, as the authorize answer was checked before.
    accept: (file) => objectPathIsIds(file.objectPath, 3),
    // The recorded name, held to the same rule the authorize answer was checked against before.
    downloadName: (file) => (isRecordedFileName(file.fileName) && isEvidenceMime(file.mime) ? file.fileName : null),
    crmUnavailable: unavailable,
  });
  return result.kind === 'response' ? result.response : notFound();
}
