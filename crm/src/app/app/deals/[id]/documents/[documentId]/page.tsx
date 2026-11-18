import type { Metadata } from 'next';
import { loadDocument } from '@/modules/customer-documents/server/queries';
import { CustomerDocumentTemplate } from '@/modules/documents/render/customer-templates';
import { requireStaff } from '@/modules/identity/server/session';
import { CustomerDocumentPrintView } from '@/views/customer-documents/print-view';
import { DealNotFoundView } from '@/views/staff-views';

export const metadata: Metadata = { title: 'Print view', robots: { index: false, follow: false } };

/**
 * Staff print view of one customer document (Accounts phase 2 contract 6.8):
 * the frozen released content through track B's template, for Accounts, the
 * branch Manager and the Sales owner (customer_document_get fences it; null
 * for everyone else, the same answer as "does not exist"). Drafts are never
 * shown here (their preview lives on the Deal page for Accounts).
 */
export default async function CustomerDocumentPrintViewRoute({ params }: { params: Promise<{ id: string; documentId: string }> }) {
  const { id, documentId } = await params;
  const staff = await requireStaff();
  const doc = await loadDocument(staff, documentId).catch(() => null);
  if (!doc || doc.dealId !== id || !doc.can.printView || doc.status === 'draft' || doc.status === 'discarded') return <DealNotFoundView />;
  return (
    <CustomerDocumentPrintView
      doc={doc}
      dealHref={doc.viewer === 'accounts' ? `/app/accounts/deals/${id}?tab=documents` : `/app/deals/${id}?tab=services#customer-documents`}
      document={<CustomerDocumentTemplate content={doc.content} id="customer-document" />}
    />
  );
}
