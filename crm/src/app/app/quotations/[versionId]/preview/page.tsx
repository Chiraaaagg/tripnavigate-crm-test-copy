import type { Metadata } from 'next';
import { loadQuotationDocumentView } from '@/modules/documents/server/load-quotation-view';
import { requireStaff } from '@/modules/identity/server/session';
import { loadQuotation, QUOTATIONS_NOT_INSTALLED } from '@/modules/quotations/server/queries';
import { QuotationPreviewPage } from '@/views/b12/quote-page';
import { QuoteNotAvailableView, QuoteUnavailableView } from '@/views/b12/quote-views';
import { QUOTE_ACTIONS } from '../../quote-actions';

export const metadata: Metadata = { title: 'Quotation preview' };

/**
 * HTML preview of what the customer sees: the customer view (quotation_get
 * and quotation_customer_money under the staff session, the PDF's input) in
 * the branded document template. Same answer for missing and not-yours.
 *
 * UX redesign R2 (D1): once the customer view loaded, the version's send
 * state is read with the editor's own loader (quotation_get under the same
 * session, editors only) for the existing "Mark as shared" action. A failed
 * read hides only that action, never the document. Nothing more is read for
 * someone the customer view refused.
 */
export default async function QuotationPreviewRoute({ params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params;
  const staff = await requireStaff();
  const load = await loadQuotationDocumentView(staff, versionId).catch(() => ({ status: 'error' as const }));
  if (load.status === 'error') return <QuoteUnavailableView backHref={`/app/quotations/${versionId}`} />;
  if (load.status === 'not_found') return <QuoteNotAvailableView />;
  const version = await loadQuotation(staff, versionId).catch(() => null);
  const share = { version: version && version !== QUOTATIONS_NOT_INSTALLED ? version : null, action: QUOTE_ACTIONS.markSent };
  return <QuotationPreviewPage versionId={versionId} view={load.view} moneyVisible={load.moneyVisible} share={share} />;
}
