import type { ItineraryRenderInput } from '@/modules/itineraries/server/render-worker';
import type { AdapterResult, PackageDocumentInput } from '../contracts';
import { itineraryToEngine } from '../itinerary-adapter';
import { ItineraryDocumentGetSchema, toItineraryDocumentView } from '../itinerary-view';

type RunningInput = Extract<ItineraryRenderInput, { status: 'running' }>;

/**
 * The engine input of one render job: Atlas's render input through the same
 * view and adapter as the request action (Terra), on the same IST day, so the
 * input hash matches the request. Shared by the render worker (local or
 * online) and the in-app print page, so both print exactly the same input.
 * Throws when the input does not parse.
 */
export function adaptRenderJobInput(jobId: string, input: RunningInput, today: string): AdapterResult<PackageDocumentInput> {
  const get = ItineraryDocumentGetSchema.parse({
    documentId: input.documentId,
    title: input.title,
    // DEC-50: the same branch column as itinerary_document_get, so the input hash matches the request.
    subject: { kind: 'quotation', quotationId: null, dealId: null, branchCode: input.branchCode },
    draft: { draftId: jobId, status: 'ready', rowVersion: 0, facts: input.facts, factsHash: input.factsHash, sourceFileId: null },
    basis: input.basis,
    differences: null,
    // DEC-48: the prices the job was requested with (null when the requester could not read them).
    money: input.money,
  });
  return itineraryToEngine(toItineraryDocumentView(get, { today }));
}

/** The document title the templates print. */
export function renderJobTitle(input: Pick<RunningInput, 'title'>): string {
  return `Itinerary ${input.title}`;
}
