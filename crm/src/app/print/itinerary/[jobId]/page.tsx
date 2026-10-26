import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { BrandedItineraryTemplate } from '@/modules/documents/render/branded-templates';
import { PRINT_DOCUMENT_ELEMENT_ID, PRINT_TOKEN_HEADER } from '@/modules/documents/render/print-token';
import { loadPrintJobInput } from '@/modules/documents/server/print-page';

/**
 * DEC-49 print page for the online PDF maker: one render job's branded
 * itinerary, opened by headless Chromium with a two-minute signed token in a
 * request header (never in the URL, so request logs do not record it).
 * Not a staff page (no session; the link and the worker's lease are the
 * access check) and 404 for every refusal, including while the online maker
 * is switched off. Never indexed.
 */
export const metadata: Metadata = { title: 'Itinerary', robots: { index: false, follow: false } };

export default async function PrintItineraryPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const token = (await headers()).get(PRINT_TOKEN_HEADER);
  const input = await loadPrintJobInput(jobId, token);
  if (!input) notFound();
  return (
    <main id="main" className="tn-print">
      <BrandedItineraryTemplate input={input} id={PRINT_DOCUMENT_ELEMENT_ID} />
    </main>
  );
}
