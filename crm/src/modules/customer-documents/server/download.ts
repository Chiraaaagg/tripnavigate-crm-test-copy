import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { requireStaff } from '@/modules/identity/server/session';
import { authorizeDownload, readDocument } from '../commands';

/**
 * GET body of /app/deals/[id]/documents/[documentId]/pdf (contract 6.8):
 * requireStaff(); B10 authorises and audits under the staff member's own
 * session (Accounts, branch Manager, Sales owner; one audit row per
 * download); only then the privileged client reads the private object and
 * streams it as an attachment named <number>.pdf after checking its sha256
 * against the stored one (409 on mismatch, L7 review 10). Every refusal, a malformed
 * id or a document of another Deal is the same 404; never cached; nothing
 * logged.
 */

export const RENDERED_DOCUMENTS_BUCKET = 'rendered-documents';
const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8' } });
}

export async function customerDocumentPdfResponse(rawDealId: string, rawDocumentId: string): Promise<Response> {
  const staff = await requireStaff();
  const dealId = z.uuid().safeParse(rawDealId);
  const documentId = z.uuid().safeParse(rawDocumentId);
  if (!dealId.success || !documentId.success) return notFound();
  const client = asRpcClient(staff.supabase);
  let file;
  try {
    // The document must belong to the Deal in the link (same fence as B10; reading is not audited).
    const doc = await readDocument(client, documentId.data);
    if (!doc || doc.dealId !== dealId.data) return notFound();
    file = await authorizeDownload(client, documentId.data);
  } catch {
    return notFound();
  }
  if (file.objectPath.split('/')[2]?.toLowerCase() !== documentId.data.toLowerCase()) return notFound();
  let body: ArrayBuffer;
  try {
    const { data, error } = await createSupabaseAdminClient().storage.from(RENDERED_DOCUMENTS_BUCKET).download(file.objectPath);
    if (error || !data) throw new Error('download failed');
    body = await data.arrayBuffer();
  } catch {
    return new Response('This file is not available right now. Please retry.', { status: 503, headers: { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  // L7 review 10: the bytes must be the stored PDF (sha256 recorded when the worker completed the job).
  if (createHash('sha256').update(Buffer.from(body)).digest('hex') !== file.sha256) {
    return new Response('The stored PDF failed its check. Ask Accounts to make it again.', { status: 409, headers: { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  const name = file.fileName.replace(/[^A-Za-z0-9._-]/g, '_');
  return new Response(body, {
    status: 200,
    headers: { ...NO_STORE, 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}"`, 'Content-Length': String(body.byteLength) },
  });
}
