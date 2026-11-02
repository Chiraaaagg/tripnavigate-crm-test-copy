import { itineraryRenderedDownloadResponse } from '@/modules/itineraries/server/downloads';

/** A made itinerary document (PDF): authorized and audited under the staff session (Terra); 404 for every refusal. */
export async function GET(_request: Request, ctx: { params: Promise<{ renderedId: string }> }): Promise<Response> {
  const { renderedId } = await ctx.params;
  return itineraryRenderedDownloadResponse(renderedId);
}
