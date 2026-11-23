import type { ReactNode } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { CustomerDocumentTemplate } from '@/modules/documents/render/customer-templates';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { DealCustomerDocumentsCard, type DocActions, type DocCardPreview } from '@/views/customer-documents/deal-card';
import { DocumentsListLoading, DocumentsListView, DocumentsNoAccess } from '@/views/customer-documents/list';
import { CustomerDocumentPrintView } from '@/views/customer-documents/print-view';
import type { DealDocs } from '@/views/customer-documents/types';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import { INBOX, INBOX_ACCOUNTS } from './acc-fixtures';
import { accNoticeNoop } from './acc-preview-actions';
import {
  ADV_DRAFT,
  CONTENT_ADV,
  CONTENT_INVOICE,
  CN_CANCELLED,
  DEAL_DOCS,
  DEAL_DOCS_FRESH,
  DEAL_ID,
  DETAIL_CANCELLED,
  DETAIL_RELEASED,
  INV_DRAFT,
  INV_RELEASED,
  LIST_ROWS,
  MANAGER_DOCS,
  SALES_DOCS,
  TALLY_INVOICES,
} from './acc2-docs-fixtures';
import * as A from './acc2-docs-preview-actions';
import { PreviewTyped } from './preview-typed';

/*
 * Accounts phase 2 preview states (acc2-docs-*), Track E: the Deal page
 * Customer documents card (Accounts, Manager, Sales owner), Accounts ›
 * Customer documents and the staff print view. Synthetic props only;
 * rendered by the design-review gallery only (a 404 outside local preview mode).
 */

const act = (a: unknown) => a as DecisionAction;

const accountsViewer: ShellViewer = {
  displayName: 'Synthetic Accounts 1',
  primaryRole: 'Accounts',
  primaryBranch: 'Jodhpur',
  canAdministerStaff: false,
  canManageGrants: false,
  canUseAccounts: true,
  canSeeAccountsDesk: true,
};
const managerViewer: ShellViewer = { ...accountsViewer, displayName: 'Synthetic Manager Jodhpur', primaryRole: 'Manager', canUseAccounts: false, canSeeAccountsDesk: false, canSeeBranchMoney: true, canSeeApprovals: true, canSeeLeads: true };
const salesViewer: ShellViewer = { ...accountsViewer, displayName: 'Synthetic Sales Jodhpur', primaryRole: 'Sales', canUseAccounts: false, canSeeAccountsDesk: false, canSeeOwnDues: true, canSeeLeads: true };
const purchaseViewer: ShellViewer = { ...accountsViewer, displayName: 'Synthetic Purchase Jodhpur', primaryRole: 'Purchase', canUseAccounts: false, canSeeAccountsDesk: false, canSeePurchaseTasks: true };

const NOOP = accNoticeNoop as never;
function shell(viewer: ShellViewer, path: string, body: ReactNode) {
  return (
    <StaffShell viewer={viewer} currentPath={path} notices={{ api: { inbox: NOOP, history: NOOP, mark: NOOP, markAllRead: NOOP, setSound: NOOP }, realtime: null, preview: { inbox: viewer === accountsViewer ? INBOX_ACCOUNTS : INBOX } }}>
      {body}
    </StaffShell>
  );
}

const ACTIONS: DocActions = {
  createDraft: act(A.docDraftOk),
  refresh: act(A.docRefreshOk),
  release: act(A.docReleaseOk),
  discard: act(A.docReasonOk),
  cancel: act(A.docReasonOk),
  replace: act(A.docReasonOk),
  linkTally: act(A.docLinkOk),
  retryPdf: act(A.docRetryOk),
};

const PREVIEWS = {
  [INV_DRAFT.documentId]: <CustomerDocumentTemplate content={CONTENT_INVOICE} />,
  [ADV_DRAFT.documentId]: <CustomerDocumentTemplate content={CONTENT_ADV} />,
};

function dealPage(viewer: ShellViewer, docs: DealDocs | 'error', over: { actions?: DocActions | null; preview?: DocCardPreview } = {}) {
  return shell(
    viewer,
    '/app/deals',
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Deal · SYN-JOD-101" title="Synthetic family trip to Udaipur" />
      <DealCustomerDocumentsCard
        docs={docs}
        dealId={DEAL_ID}
        actions={over.actions === undefined ? (viewer === accountsViewer ? ACTIONS : null) : over.actions}
        previews={PREVIEWS}
        tallyInvoices={TALLY_INVOICES}
        numberPrefix="10101"
        billingHref={`/app/accounts/deals/${DEAL_ID}`}
        preview={over.preview}
      />
    </div>,
  );
}

const ACCOUNTS = { kind: 'accounts' as const, entityName: 'Holiday Chacha Pvt LTD' };
const BRANCHES = [
  { id: 'a0000011-0000-4000-8000-000000000011', name: 'Jodhpur' },
  { id: 'a0000012-0000-4000-8000-000000000012', name: 'Delhi' },
  { id: 'a0000013-0000-4000-8000-000000000013', name: 'Ahmedabad' },
];
const list = (viewer: ShellViewer, body: ReactNode) => shell(viewer, '/app/accounts/documents', body);
const STALE = 'The booking or money changed since this draft was made. Refresh the draft first.';
const HAS_CN = 'A released credit note refers to this document. It cannot be cancelled.';


/** Preview only: the refusal state shows what was typed before it (PreviewTyped fills the fields once). */
function typed(values: Record<string, string>, body: ReactNode, firstOnly = false) {
  return (
    <>
      {body}
      <PreviewTyped values={values} firstOnly={firstOnly} />
    </>
  );
}

const states: Record<string, () => ReactNode> = {
  /* Deal page card */
  'acc2-docs-deal-accounts': () => dealPage(accountsViewer, DEAL_DOCS),
  'acc2-docs-deal-ready': () => dealPage(accountsViewer, DEAL_DOCS_FRESH),
  'acc2-docs-deal-adv-draft': () => dealPage(accountsViewer, { ...DEAL_DOCS_FRESH, candidates: { ...DEAL_DOCS_FRESH.candidates!, advances: DEAL_DOCS_FRESH.candidates!.advances.slice(1) }, documents: [ADV_DRAFT] }),
  'acc2-docs-deal-stale': () => dealPage(accountsViewer, { ...DEAL_DOCS, documents: [{ ...INV_DRAFT, stale: true, warnings: ['flight_total_differs'] }, INV_RELEASED] }),
  'acc2-docs-deal-billing-missing': () => dealPage(accountsViewer, { ...DEAL_DOCS, billing: { verified: false, missing: true } }),
  'acc2-docs-deal-off': () => dealPage(accountsViewer, { ...DEAL_DOCS_FRESH, enabled: false }),
  'acc2-docs-deal-empty': () => dealPage(accountsViewer, { ...DEAL_DOCS, candidates: { advances: [], invoice: null, creditNotes: [] }, documents: [] }),
  'acc2-docs-deal-release-open': () => dealPage(accountsViewer, DEAL_DOCS, { preview: { open: { documentId: INV_DRAFT.documentId, dialog: 'release' } } }),
  'acc2-docs-deal-release-refused': () =>
    dealPage(accountsViewer, DEAL_DOCS, { actions: { ...ACTIONS, release: act(A.docReleaseStale) }, preview: { open: { documentId: INV_DRAFT.documentId, dialog: 'release', state: { ok: false, code: 'document_stale', message: STALE } } } }),
  'acc2-docs-deal-discard-refused': () =>
    typed({ reason: 'Draft' }, dealPage(accountsViewer, DEAL_DOCS, { actions: { ...ACTIONS, discard: act(A.docReasonShort) }, preview: { open: { documentId: INV_DRAFT.documentId, dialog: 'discard', state: { ok: false, code: 'invalid_input', message: 'Check the highlighted field.', field: 'reason' } as never } } })),
  'acc2-docs-deal-replace-open': () => dealPage(accountsViewer, DEAL_DOCS, { preview: { open: { documentId: INV_RELEASED.documentId, dialog: 'replace' } } }),
  'acc2-docs-deal-cancel-refused': () =>
    typed({ reason: 'Customer cancelled the whole trip; cancel this invoice.' }, dealPage(accountsViewer, DEAL_DOCS, { actions: { ...ACTIONS, cancel: act(A.docCancelHasCn) }, preview: { open: { documentId: INV_RELEASED.documentId, dialog: 'cancel', state: { ok: false, code: 'has_credit_notes', message: HAS_CN } } } })),
  'acc2-docs-deal-link-open': () => dealPage(accountsViewer, DEAL_DOCS, { preview: { open: { documentId: INV_DRAFT.documentId, dialog: 'link' } } }),
  'acc2-docs-deal-flags': () =>
    dealPage(accountsViewer, { ...DEAL_DOCS, candidates: { advances: [], invoice: null, creditNotes: [] }, documents: [{ ...INV_RELEASED, bookingChangedSinceRelease: true }, { ...DEAL_DOCS.documents[3]!, paymentReversed: true }, CN_CANCELLED] }),
  'acc2-docs-deal-manager': () => dealPage(managerViewer, MANAGER_DOCS),
  'acc2-docs-deal-sales': () => dealPage(salesViewer, SALES_DOCS),
  'acc2-docs-deal-sales-empty': () => dealPage(salesViewer, { ...SALES_DOCS, documents: [] }),
  'acc2-docs-deal-error': () => dealPage(accountsViewer, 'error'),

  /* Accounts › Customer documents */
  'acc2-docs-list': () => list(accountsViewer, <DocumentsListView viewer={ACCOUNTS} filter={{}} page={{ items: LIST_ROWS, nextAfter: '2026-11-06T10:00:00Z|a0002202-0000-4000-8000-000000002202', hasMore: true }} branches={BRANCHES} />),
  'acc2-docs-list-to-release': () => list(accountsViewer, <DocumentsListView viewer={ACCOUNTS} filter={{ toRelease: true }} page={{ items: LIST_ROWS.slice(0, 2), nextAfter: null, hasMore: false }} branches={BRANCHES} />),
  'acc2-docs-list-filtered': () =>
    list(accountsViewer, <DocumentsListView viewer={ACCOUNTS} filter={{ kind: ['invoice'], tallyLinked: false, from: '2026-11-01', branchId: BRANCHES[2]!.id }} page={{ items: [LIST_ROWS[4]!], nextAfter: null, hasMore: false }} branches={BRANCHES} />),
  'acc2-docs-list-next-page': () =>
    list(accountsViewer, <DocumentsListView viewer={ACCOUNTS} filter={{}} after="2026-11-06T10:00:00Z|a0002202-0000-4000-8000-000000002202" page={{ items: LIST_ROWS.slice(5), nextAfter: null, hasMore: false }} branches={BRANCHES} />),
  'acc2-docs-list-none': () => list(accountsViewer, <DocumentsListView viewer={ACCOUNTS} filter={{ paymentReversed: true }} page={{ items: [], nextAfter: null, hasMore: false }} branches={BRANCHES} />),
  'acc2-docs-list-nothing-to-release': () => list(accountsViewer, <DocumentsListView viewer={ACCOUNTS} filter={{ toRelease: true }} page={{ items: [], nextAfter: null, hasMore: false }} branches={BRANCHES} />),
  'acc2-docs-list-empty': () => list(accountsViewer, <DocumentsListView viewer={ACCOUNTS} filter={{}} page={{ items: [], nextAfter: null, hasMore: false }} branches={BRANCHES} />),
  'acc2-docs-list-manager': () =>
    list(managerViewer, <DocumentsListView viewer={{ kind: 'manager', branchNames: ['Jodhpur'] }} filter={{}} page={{ items: LIST_ROWS.filter((r) => r.status !== 'draft' && r.branchName === 'Jodhpur'), nextAfter: null, hasMore: false }} />),
  'acc2-docs-list-error': () => list(accountsViewer, <DocumentsListView viewer={ACCOUNTS} filter={{}} page="error" branches={BRANCHES} />),
  'acc2-docs-list-loading': () => list(accountsViewer, <DocumentsListLoading />),
  'acc2-docs-list-no-access': () => list(purchaseViewer, <DocumentsNoAccess />),

  /* Print view */
  'acc2-docs-print': () => shell(salesViewer, '/app/deals', <CustomerDocumentPrintView doc={DETAIL_RELEASED} dealHref={`/app/deals/${DEAL_ID}?tab=documents#customer-documents`} document={<CustomerDocumentTemplate content={DETAIL_RELEASED.content} />} />),
  'acc2-docs-print-cancelled': () => shell(managerViewer, '/app/deals', <CustomerDocumentPrintView doc={DETAIL_CANCELLED} dealHref={`/app/deals/${DEAL_ID}?tab=documents#customer-documents`} document={<CustomerDocumentTemplate content={DETAIL_CANCELLED.content} />} />),
};

export const ACC2_DOCS_STATES = Object.keys(states);

export function renderAcc2DocsState(state: string): ReactNode | null {
  return states[state]?.() ?? null;
}
