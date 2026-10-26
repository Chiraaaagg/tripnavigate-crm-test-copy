import { purchaseEvidenceDownloadResponse } from '@/modules/procurement/server/evidence-download';

/**
 * Purchase file download: authorize under the staff session, then 302 to a
 * 60-second signed Storage URL. 404 for every refusal (Sales never receives
 * Purchase files). Dynamic, never cached.
 */

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return purchaseEvidenceDownloadResponse(id);
}
