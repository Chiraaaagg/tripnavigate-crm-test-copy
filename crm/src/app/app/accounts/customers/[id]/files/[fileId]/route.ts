import { partyFileDownloadResponse } from '@/modules/parties/server/party-file-download';

/**
 * Customer document download (Accounts customer check): authorize under the
 * staff session, then a short-lived signed URL. 404 for every refusal; never cached.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string; fileId: string }> }): Promise<Response> {
  const { id, fileId } = await ctx.params;
  return partyFileDownloadResponse(id, fileId);
}
