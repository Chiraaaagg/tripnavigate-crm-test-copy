import 'server-only';
import { z } from 'zod';
import { deliverFile } from '@/modules/documents/server/file-delivery';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { requireStaff } from '@/modules/identity/server/session';
import { evidenceAuthorizeDownload } from '../commands';
import { SUPPLIER_MONEY_BUCKET, SUPPLIER_MONEY_SIGNED_URL_SECONDS } from '../contracts';

/**
 * Route helper for GET <route>/[id] (the UI owner mounts it, for example
 * /app/supplier-money/files/[id]): authorize under the staff session
 * (payment proofs: Accounts only; other files: Purchase of the entity, the
 * branch Manager or Accounts; stored files only; audited), then the
 * privileged client signs a 60 s download URL and the route answers 302.
 * S11: the authorize-and-sign steps run in deliverFile (file_view_begin calls
 * the same authorize function; a file kept in Bitrix is read and checked there).
 * Every refusal is an indistinguishable 404; nothing is cached or logged.
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

export async function supplierMoneyEvidenceDownloadResponse(rawId: string): Promise<Response> {
  const staff = await requireStaff();
  const id = z.uuid().safeParse(rawId);
  if (!id.success) return notFound();

  const result = await deliverFile({
    staff,
    sourceTable: 'supplier_money_evidence',
    sourceId: id.data,
    bucket: SUPPLIER_MONEY_BUCKET,
    signedUrlSeconds: SUPPLIER_MONEY_SIGNED_URL_SECONDS,
    legacyAuthorize: () => evidenceAuthorizeDownload(asRpcClient(staff.supabase), id.data),
    downloadName: (file) => file.fileName,
    crmUnavailable: unavailable,
  });
  return result.kind === 'response' ? result.response : notFound();
}
