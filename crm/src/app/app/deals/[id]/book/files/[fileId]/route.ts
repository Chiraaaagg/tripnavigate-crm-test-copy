import { serviceFileDownloadResponse } from '@/modules/fulfilment/server/book-form-file-download';

/**
 * Flight screenshot download (booking form): authorize under the staff
 * session, then a short-lived signed URL. 404 for every refusal; never cached.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string; fileId: string }> }): Promise<Response> {
  const { id, fileId } = await ctx.params;
  return serviceFileDownloadResponse(id, fileId);
}
