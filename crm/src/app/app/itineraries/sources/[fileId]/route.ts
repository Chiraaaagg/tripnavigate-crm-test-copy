import { itinerarySourceDownloadResponse } from '@/modules/itineraries/server/downloads';

/** A private itinerary source file: authorized and audited under the staff session (Terra); 404 for every refusal. */
export async function GET(_request: Request, ctx: { params: Promise<{ fileId: string }> }): Promise<Response> {
  const { fileId } = await ctx.params;
  return itinerarySourceDownloadResponse(fileId);
}
