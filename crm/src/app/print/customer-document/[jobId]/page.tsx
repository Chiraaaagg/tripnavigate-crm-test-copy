import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { CustomerDocumentTemplate } from '@/modules/documents/render/customer-templates';
import { CUSTOMER_PRINT_ELEMENT_ID, CUSTOMER_PRINT_TOKEN_HEADER, loadCustomerPrintContent } from '@/modules/documents/server/customer-print-page';

/**
 * Accounts phase 2 (contract 6.8, screen 14): print page of one customer
 * document render job (Advance Invoice, Invoice, Credit Note) for the online
 * PDF maker. Same rule as the itinerary print page: no staff session; the
 * two-minute signed token in a request header (never in the URL) and the
 * worker's lease are the access check (track B's loader). 404 for every
 * refusal, including while the online maker is switched off. Renders the
 * frozen released content through track B's template only. Never indexed.
 */
export const metadata: Metadata = { title: 'Customer document', robots: { index: false, follow: false } };

export default async function PrintCustomerDocumentPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const token = (await headers()).get(CUSTOMER_PRINT_TOKEN_HEADER);
  const content = await loadCustomerPrintContent(jobId, token);
  if (!content) notFound();
  return (
    <main id="main" className="tn-print">
      <CustomerDocumentTemplate content={content} id={CUSTOMER_PRINT_ELEMENT_ID} />
    </main>
  );
}
