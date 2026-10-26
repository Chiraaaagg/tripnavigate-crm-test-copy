import type { Metadata } from 'next';
import { istToday } from '@/modules/finance/forms';
import { toPrefillUi } from '@/modules/fulfilment/prefill-ui';
import { requireStaff } from '@/modules/identity/server/session';
import { ITINERARIES_NOT_INSTALLED, loadItinerariesForQuotation } from '@/modules/itineraries/server/queries';
import { QUOTATIONS_NOT_INSTALLED } from '@/modules/quotations/server/queries';
import { ItinerariesCard } from '@/views/b12/itin-views';
import { QuotationPage } from '@/views/b12/quote-page';
import { QuoteNotAvailableView, QuoteNotInstalledView, QuoteUnavailableView } from '@/views/b12/quote-views';
import { ITINERARY_ACTIONS } from '../../itineraries/itinerary-actions';
import { loadQuoteScreen } from '../load-screen';
import { QUOTE_ACTIONS } from '../quote-actions';

export const metadata: Metadata = { title: 'Quotation' };

export default async function QuotationVersionPage({ params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params;
  const staff = await requireStaff();
  const data = await loadQuoteScreen(staff, versionId).catch(() => 'failed' as const);
  if (data === 'failed') return <QuoteUnavailableView backHref="/app" />;
  if (data === QUOTATIONS_NOT_INSTALLED) return <QuoteNotInstalledView />;
  // Same answer for "does not exist" and "not yours" (and for every department role), so ids cannot be probed.
  if (!data) return <QuoteNotAvailableView />;
  // Branded itineraries of this quotation (editors only; a failed read hides the card, never the quotation).
  const itineraries = await loadItinerariesForQuotation(staff, data.version.quotationId).catch(() => null);
  const related =
    itineraries && itineraries !== ITINERARIES_NOT_INSTALLED ? <ItinerariesCard list={itineraries} defaultTitle={data.version.title} createAction={ITINERARY_ACTIONS.create} /> : null;
  // Batch 2 (lead ruling D1): today's panel while the switch is off or unknown; the inline screen when it is on.
  const prefillUi = data.version.prefill ? toPrefillUi(data.version.prefill, { target: 'quotation', editable: data.version.canEdit }) : null;
  return <QuotationPage data={data} actions={QUOTE_ACTIONS} today={istToday()} related={related} prefillUi={prefillUi} />;
}
