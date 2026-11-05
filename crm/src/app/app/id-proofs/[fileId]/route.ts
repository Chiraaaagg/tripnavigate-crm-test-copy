import { idProofDownloadResponse } from '@/modules/fulfilment/server/id-proof-download';

/**
 * Traveller identity-proof download (B1.2 freeze note §2.2, DEC-39/DEC-41):
 * one route for every allowed viewer (booking editors, Accounts and the
 * Deal's task assignees). Authorized and audited under the staff session,
 * then a short-lived signed URL. 404 for every refusal; never cached.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ fileId: string }> }): Promise<Response> {
  const { fileId } = await ctx.params;
  return idProofDownloadResponse(fileId);
}
