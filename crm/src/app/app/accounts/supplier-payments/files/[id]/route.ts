import { supplierMoneyEvidenceDownloadResponse } from '@/modules/supplier-money/server/evidence';

/**
 * Supplier money file download (proforma, payment proof, invoice, credit
 * note): authorize under the staff session, then 302 to a 60-second signed
 * Storage URL. 404 for every refusal (Purchase never receives a payment
 * proof). Dynamic, never cached.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return supplierMoneyEvidenceDownloadResponse(id);
}
