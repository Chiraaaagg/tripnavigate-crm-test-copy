import type { Metadata } from 'next';
import { loadItineraryDocumentView } from '@/modules/documents/server/itinerary';
import { requireStaff } from '@/modules/identity/server/session';
import { ItineraryNotAvailableView, ItineraryPreviewPage, ItineraryUnavailableView } from '@/views/b12/itin-views';

export const metadata: Metadata = { title: 'Itinerary preview' };

/** HTML preview of the customer itinerary: Nova's itinerary view in the branded template the PDF uses. */
export default async function ItineraryPreviewRoute({ params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const staff = await requireStaff();
  const load = await loadItineraryDocumentView(staff, documentId).catch(() => ({ status: 'error' as const }));
  if (load.status === 'error') return <ItineraryUnavailableView backHref={`/app/itineraries/${documentId}`} />;
  if (load.status === 'not_found') return <ItineraryNotAvailableView />;
  return <ItineraryPreviewPage documentId={documentId} view={load.view} />;
}
