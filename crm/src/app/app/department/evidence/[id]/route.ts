import { departmentEvidenceDownloadResponse } from '@/modules/fulfilment/server/department-evidence';

/**
 * Department evidence download (fee receipts, direct-payment proof, applicant
 * documents, authority outcomes): authorized under the staff session, then a
 * short-lived signed URL. 404 for every refusal; never cached.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return departmentEvidenceDownloadResponse(id);
}
