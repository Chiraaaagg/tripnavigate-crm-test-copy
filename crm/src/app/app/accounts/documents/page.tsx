import type { Metadata } from 'next';
import { loadDocumentList } from '@/modules/customer-documents/server/queries';
import { requireStaff } from '@/modules/identity/server/session';
import { parseDocFilter } from '@/views/customer-documents/filter';
import { DocumentsListView, DocumentsNoAccess } from '@/views/customer-documents/list';
import { branchChoices, deskViewerOf } from '../records/desk-glue';

export const metadata: Metadata = { title: 'Customer documents' };

/**
 * Accounts › Customer documents (Accounts phase 2 contract 6.9 R-B3, screen
 * 11.2). customer_documents_list decides who reads: Accounts of the company
 * (every document) and a branch Manager (own branches, read only); everyone
 * else gets null. Filters and the keyset cursor live in the address.
 */
export default async function CustomerDocumentsRoute({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff();
  const { filter, after } = parseDocFilter(await searchParams);
  const page = await loadDocumentList(staff, filter, after).catch(() => 'error' as const);
  if (page === null) return <DocumentsNoAccess />;
  const mode = staff.memberships.some((m) => m.roleCode === 'accounts') ? 'accounts' : 'manager';
  return (
    <DocumentsListView
      viewer={deskViewerOf(staff, mode)}
      filter={filter}
      after={after}
      page={page === 'error' ? 'error' : { items: page.items, nextAfter: page.nextAfter, hasMore: page.hasMore }}
      branches={branchChoices(staff, mode)}
      // Accounts phase 3 (contract 6.5): the "Bills to check" preset shows while automatic drafts are on.
      autoBills={page === 'error' ? undefined : page.autoBills?.drafts}
    />
  );
}
