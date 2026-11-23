import type { Metadata } from 'next';
import { SectionTabs } from '@/components/ui/section-tabs';
import { releaseDocumentAction } from '@/modules/customer-documents/server/actions';
import { loadDocumentList } from '@/modules/customer-documents/server/queries';
import { requireStaff } from '@/modules/identity/server/session';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { DOCS_PATH, parseDocFilter } from '@/views/customer-documents/filter';
import { DocumentsListView, DocumentsNoAccess } from '@/views/customer-documents/list';
import { branchChoices, deskViewerOf } from '../records/desk-glue';
import { accountsSectionViewer } from '../section-viewer';

export const metadata: Metadata = { title: 'Customer documents' };

/**
 * Accounts › Customer documents (Accounts phase 2 contract 6.9 R-B3, screen
 * 11.2). customer_documents_list decides who reads: Accounts of the company
 * (every document) and a branch Manager (own branches, read only); everyone
 * else gets null. Filters and the keyset cursor live in the address.
 * UX redesign R4: "Release" on ready rows uses the Deal page's release
 * command (customer_document_release re-checks every rule).
 */
export default async function CustomerDocumentsRoute({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff();
  const { filter, after } = parseDocFilter(await searchParams);
  const [page, sectionViewer] = await Promise.all([loadDocumentList(staff, filter, after).catch(() => 'error' as const), accountsSectionViewer(staff)]);
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
      releaseAction={mode === 'accounts' ? (releaseDocumentAction as unknown as DecisionAction) : null}
      sectionTabs={<SectionTabs section="money-in" currentHref={DOCS_PATH} viewer={sectionViewer} />}
    />
  );
}
