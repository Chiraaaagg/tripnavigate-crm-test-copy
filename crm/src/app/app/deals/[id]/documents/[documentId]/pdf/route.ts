import { customerDocumentPdfResponse } from '@/modules/customer-documents/server/download';

/**
 * A released customer document's PDF (contract 6.8, B10): authorised and
 * audited under the staff session (Accounts, branch Manager, Sales owner;
 * one audit row per download), then streamed as an attachment; 404 for every
 * refusal; never cached.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string; documentId: string }> }): Promise<Response> {
  const { id, documentId } = await ctx.params;
  return customerDocumentPdfResponse(id, documentId);
}
