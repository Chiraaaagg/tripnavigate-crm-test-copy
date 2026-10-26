import { quotationEvidenceDownloadResponse } from '@/modules/quotations/server/evidence-download';

/**
 * The customer's written acceptance of a quotation version: authorized and
 * audited under the staff session, then a short-lived signed address (Terra,
 * evidence-download). 404 for every refusal; never cached.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ evidenceId: string }> }): Promise<Response> {
  const { evidenceId } = await ctx.params;
  return quotationEvidenceDownloadResponse(evidenceId);
}
