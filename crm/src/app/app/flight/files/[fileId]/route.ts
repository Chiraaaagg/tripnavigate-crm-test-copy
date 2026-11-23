import { serviceFileDownloadResponse } from '@/modules/fulfilment/server/book-form-file-download';

/**
 * Flight screenshot download from a Flight task (booking form, contract
 * ruling 14): the Flight assignee of that item, Sales owner/assignee and the
 * branch Manager; never Purchase or Accounts. Authorized and audited under
 * the staff session, then a short-lived signed URL. 404 for every refusal;
 * never cached.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ fileId: string }> }): Promise<Response> {
  const { fileId } = await ctx.params;
  return serviceFileDownloadResponse(null, fileId);
}
