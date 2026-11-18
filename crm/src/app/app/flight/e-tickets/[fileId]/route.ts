import { eTicketDownloadResponse } from '@/modules/flight/server/evidence';

/**
 * E-ticket download (Flight build, contract A11): authorized and audited under
 * the staff session (Flight, the Deal's Sales owner, the branch Manager,
 * Accounts), then a 60 s signed URL. 404 for every refusal; never cached.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ fileId: string }> }): Promise<Response> {
  const { fileId } = await ctx.params;
  return eTicketDownloadResponse(fileId);
}
