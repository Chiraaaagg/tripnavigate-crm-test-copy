import type { Metadata } from 'next';
import { requireStaff } from '@/modules/identity/server/session';
import { ITINERARIES_NOT_INSTALLED, loadItineraryEditor } from '@/modules/itineraries/server/queries';
import { itineraryBackLink } from '@/modules/quotations/subject-links';
import { ItineraryNotAvailableView, ItineraryNotInstalledView, ItineraryScreen, ItineraryUnavailableView } from '@/views/b12/itin-views';
import { ITINERARY_ACTIONS } from '../itinerary-actions';

export const metadata: Metadata = { title: 'Itinerary' };

export default async function ItineraryPage({ params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const staff = await requireStaff();
  const editor = await loadItineraryEditor(staff, documentId).catch(() => 'failed' as const);
  if (editor === 'failed') return <ItineraryUnavailableView backHref="/app" />;
  if (editor === ITINERARIES_NOT_INSTALLED) return <ItineraryNotInstalledView />;
  // Same answer for "does not exist" and "not yours" (and for every role that does not prepare the trip).
  if (!editor) return <ItineraryNotAvailableView />;
  const back = itineraryBackLink(editor);
  return <ItineraryScreen editor={editor} actions={ITINERARY_ACTIONS} backHref={back.href} backLabel={back.label} />;
}
