import { evidenceDownloadResponse } from '@/modules/fulfilment/server/evidence-download';

/**
 * Booking proof download: authorize under the staff session, then 302 to a
 * 60-second signed Storage URL. 404 for every refusal. See the handler for the
 * full sequence. GET handlers are dynamic by default; it reads the session
 * cookies and never caches (Cache-Control: no-store).
 */

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return evidenceDownloadResponse(id);
}
