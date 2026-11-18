import 'server-only';
import { z } from 'zod';
import { getAppConfig } from '@/lib/config';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { requireStaff } from '@/modules/identity/server/session';
import { fileAuthorizeDownload } from '../commands';
import { RATE_CONTRACT_FILE_BUCKET, RATE_CONTRACT_SIGNED_URL_SECONDS } from '../contracts';

/**
 * GET handler body for a rate contract file (the route is track U's, e.g.
 * /app/purchase/rate-contracts/files/[id]): authorize under the staff session
 * (Purchase, Manager or Accounts of the entity; stored files only; audited
 * purchase.rate_contract_file.downloaded), then the privileged client signs a
 * 60 s URL and the route answers 302. Every refusal is an indistinguishable
 * 404; nothing is cached or logged.
 */

const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0', 'Referrer-Policy': 'no-referrer' };

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8' } });
}

export async function rateContractFileDownloadResponse(rawId: string): Promise<Response> {
  const staff = await requireStaff();
  const id = z.uuid().safeParse(rawId);
  if (!id.success) return notFound();
  let file;
  try {
    file = await fileAuthorizeDownload(asRpcClient(staff.supabase), id.data);
  } catch {
    return notFound();
  }
  let signedUrl: string | null = null;
  try {
    const { data, error } = await createSupabaseAdminClient()
      .storage.from(RATE_CONTRACT_FILE_BUCKET)
      .createSignedUrl(file.objectPath, RATE_CONTRACT_SIGNED_URL_SECONDS, { download: file.fileName });
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
