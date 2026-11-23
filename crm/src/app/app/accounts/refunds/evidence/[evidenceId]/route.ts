import { refundEvidenceDownloadResponse } from '@/modules/refunds/server/evidence';

/**
 * Refund proof download (contract 7.3 C5): authorize under the staff session
 * (Accounts of the entity or the Deal's branch Manager, audited), then 302 to
 * a 60-second signed Storage URL. 404 for every refusal. Dynamic, never cached.
 */

export async function GET(_request: Request, ctx: { params: Promise<{ evidenceId: string }> }): Promise<Response> {
  const { evidenceId } = await ctx.params;
  return refundEvidenceDownloadResponse(evidenceId);
}
