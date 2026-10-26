import { financeEvidenceDownloadResponse } from '@/modules/finance/server/evidence';

/**
 * Finance evidence download: authorize under the staff session (Accounts in
 * the file's entity, audited), then 302 to a 60-second signed Storage URL.
 * 404 for every refusal. Dynamic, never cached.
 */

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return financeEvidenceDownloadResponse(id);
}
