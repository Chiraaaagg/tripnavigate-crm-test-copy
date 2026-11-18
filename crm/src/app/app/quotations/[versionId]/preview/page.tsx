import type { Metadata } from 'next';
import { loadQuotationDocumentView } from '@/modules/documents/server/load-quotation-view';
import { requireStaff } from '@/modules/identity/server/session';
import { QuotationPreviewPage } from '@/views/b12/quote-page';
import { QuoteNotAvailableView, QuoteUnavailableView } from '@/views/b12/quote-views';

export const metadata: Metadata = { title: 'Quotation preview' };

/**
 * HTML preview of what the customer sees: the customer view (quotation_get
 * and quotation_customer_money under the staff session, the PDF's input) in
 * the branded document template. Same answer for missing and not-yours.
 */
export default async function QuotationPreviewRoute({ params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params;
  const staff = await requireStaff();
  const load = await loadQuotationDocumentView(staff, versionId).catch(() => ({ status: 'error' as const }));
  if (load.status === 'error') return <QuoteUnavailableView backHref={`/app/quotations/${versionId}`} />;
  if (load.status === 'not_found') return <QuoteNotAvailableView />;
  return <QuotationPreviewPage versionId={versionId} view={load.view} moneyVisible={load.moneyVisible} />;
}
