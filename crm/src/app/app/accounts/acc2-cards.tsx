import 'server-only';
import type { ReactNode } from 'react';
import { loadDealDues } from '@/modules/accounts-desk/server/queries';
import {
  cancelDocumentAction,
  createDocumentDraftAction,
  discardDocumentAction,
  linkTallyInvoiceAction,
  refreshDocumentAction,
  releaseDocumentAction,
  replaceDocumentAction,
  retryDocumentPdfAction,
} from '@/modules/customer-documents/server/actions';
import { loadDealDocuments, loadDocument } from '@/modules/customer-documents/server/queries';
import { CustomerDocumentTemplate } from '@/modules/documents/render/customer-templates';
import type { StaffContext } from '@/modules/identity/server/session';
import {
  cancelSupplierRefundAction,
  decideRefundAction,
  payOutRefundAction,
  recordSupplierRefundAction,
  requestRefundAction,
  resubmitRefundAction,
  withdrawRefundAction,
} from '@/modules/refunds/server/actions';
import { loadDealRefunds } from '@/modules/refunds/server/queries';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { todayInIndia } from '@/views/accounts/supplier-kit';
import { DealCustomerDocumentsCard, type DocActions } from '@/views/customer-documents/deal-card';
import { DealRefundsCard } from '@/views/refunds/deal-card';
import type { RefundActions } from '@/views/refunds/request-block';

/*
 * Accounts phase 2 (contract 6.9 R-B1, 7.5 R-C1; screens 11.1, 11.3): the
 * Customer documents and Refunds cards, built the same way for the Deal page
 * (Services tab: Sales owner, branch Manager, Accounts who can see the Deal)
 * and the Accounts deal page (/app/accounts/deals/<id>: Accounts of every
 * branch). Every read runs under the staff member's own session; null = not
 * for this viewer (no card); a failed read shows the error card only to
 * people who may read customer money.
 */

export const DOC_ACTIONS: DocActions = {
  createDraft: createDocumentDraftAction as unknown as DecisionAction,
  refresh: refreshDocumentAction as unknown as DecisionAction,
  release: releaseDocumentAction as unknown as DecisionAction,
  discard: discardDocumentAction as unknown as DecisionAction,
  cancel: cancelDocumentAction as unknown as DecisionAction,
  replace: replaceDocumentAction as unknown as DecisionAction,
  linkTally: linkTallyInvoiceAction as unknown as DecisionAction,
  retryPdf: retryDocumentPdfAction as unknown as DecisionAction,
};

export const REFUND_ACTIONS: RefundActions = {
  request: requestRefundAction as unknown as DecisionAction,
  resubmit: resubmitRefundAction as unknown as DecisionAction,
  withdraw: withdrawRefundAction as unknown as DecisionAction,
  decide: decideRefundAction as unknown as DecisionAction,
  payOut: payOutRefundAction as unknown as DecisionAction,
  recordSupplierRefund: recordSupplierRefundAction as unknown as DecisionAction,
  cancelSupplierRefund: cancelSupplierRefundAction as unknown as DecisionAction,
};

type DuesRead = Awaited<ReturnType<typeof loadDealDues>> | 'error' | null;

/** The Customer documents card, or null when the database says this viewer gets none. */
export async function customerDocumentsCard(
  staff: StaffContext,
  dealId: string,
  opts: { moneyReader: boolean; numberPrefix: string | null; dues?: DuesRead },
): Promise<ReactNode> {
  const docs = await loadDealDocuments(staff, dealId).catch(() => 'error' as const);
  if (docs === 'error') return opts.moneyReader ? <DealCustomerDocumentsCard docs="error" dealId={dealId} /> : null;
  if (!docs) return null;
  const accounts = docs.viewer === 'accounts';
  const drafts = accounts ? docs.documents.filter((d) => d.status === 'draft') : [];
  // Draft previews: track B's template rendered here on the server from the frozen content (no zod in the browser).
  const previewEntries = await Promise.all(
    drafts.map(async (d) => {
      const detail = await loadDocument(staff, d.documentId).catch(() => null);
      return [d.documentId, detail ? <CustomerDocumentTemplate key={d.documentId} content={detail.content} /> : null] as const;
    }),
  );
  let dues = opts.dues;
  if (accounts && dues === undefined) dues = await loadDealDues(staff, dealId).catch(() => 'error' as const);
  const tallyInvoices = dues && dues !== 'error' ? dues.tallyInvoices.filter((t) => t.status === 'active').map((t) => ({ id: t.id, invoiceRef: t.invoiceRef, invoiceDate: t.invoiceDate })) : [];
  return (
    <DealCustomerDocumentsCard
      docs={docs}
      dealId={dealId}
      actions={accounts ? DOC_ACTIONS : null}
      previews={Object.fromEntries(previewEntries.filter(([, node]) => node !== null))}
      tallyInvoices={tallyInvoices}
      numberPrefix={opts.numberPrefix}
      billingHref={accounts ? `/app/accounts/deals/${dealId}?tab=review` : undefined}
      // Accounts phase 3 (screen 15.5): the repair link of a bill held as "newer version waiting".
      reviewHref={accounts ? `/app/accounts/deals/${dealId}?tab=review` : undefined}
    />
  );
}

/** The Refunds card, or null when the database says this viewer gets none. */
export async function refundsCard(staff: StaffContext, dealId: string, opts: { moneyReader: boolean }): Promise<ReactNode> {
  const refunds = await loadDealRefunds(staff, dealId).catch(() => 'error' as const);
  if (refunds === 'error') return opts.moneyReader ? <DealRefundsCard refunds="error" actions={null} today={todayInIndia()} /> : null;
  if (!refunds) return null;
  return <DealRefundsCard refunds={refunds} actions={REFUND_ACTIONS} today={todayInIndia()} />;
}
