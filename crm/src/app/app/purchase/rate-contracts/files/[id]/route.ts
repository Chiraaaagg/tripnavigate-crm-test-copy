import { rateContractFileDownloadResponse } from '@/modules/rate-contracts/server/file-download';

/**
 * Rate contract file download (contract 9.1 E5): authorize under the staff
 * session (Purchase, Manager or Accounts of the entity; audited), then 302 to
 * a 60-second signed Storage URL. 404 for every refusal. Dynamic, never cached.
 */

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return rateContractFileDownloadResponse(id);
}
