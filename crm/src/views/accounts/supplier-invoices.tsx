import { CircleCheck, CircleX, FileWarning, Hourglass, ReceiptText } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { parseTab } from '@/lib/parse-tab';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DOCUMENT_KIND_LABEL,
  DOCUMENT_STATUS_LABEL,
  SM_FIELD,
  type AccountsDocumentTab,
  type AccountsSupplierDocumentsView,
  type SupplierDocumentStatus,
} from '@/modules/supplier-money/contracts';
import type { DecisionAction } from './supplier-forms';
import type { AccountsSectionViewer } from '@/views/accounts-desk/sections';
import { CreditLinkButton } from '../accounts-desk/credit-link';
import { RowDecision } from '../department/row-decision';
import { formatPaise } from '@/modules/deals/dto';
import { departmentWord, supplierMoneyFileHref } from './supplier-payments';
import { AmountAside, byText, dateText, Facts, FileLink, ItemCard, ItemList, ListEmpty, ListTabs, Status, whenText } from './supplier-kit';
import { MoneyOutTabs } from './money-out-tabs';

/*
 * Accounts · Supplier invoices and credit notes (Purchase build). Purchase
 * uploads the supplier's original invoice or credit note on the task; a
 * different Accounts person accepts or returns it. "Missing" lists confirmed
 * services whose trip has ended with no invoice uploaded.
 *
 * Redesign R4 (A7): Money out tab strip under the header; one decision row
 * per document ("Accept document", then "Return with reason" opening the
 * shared reason dialog). Same action, fields and words.
 */

export const DOCUMENT_TABS: readonly AccountsDocumentTab[] = ['to_review', 'missing', 'all'];
const TAB_LABEL: Record<AccountsDocumentTab, string> = { to_review: 'To check', missing: 'Missing invoices', all: 'All' };

export function parseDocumentTab(raw: string | string[] | undefined): AccountsDocumentTab {
  return parseTab(raw, DOCUMENT_TABS, 'to_review');
}

const LOOK: Record<SupplierDocumentStatus, { tone: 'warning' | 'success' | 'danger'; icon: typeof Hourglass }> = {
  uploaded: { tone: 'warning', icon: Hourglass },
  accepted: { tone: 'success', icon: CircleCheck },
  returned: { tone: 'danger', icon: CircleX },
};

export function AccountsSupplierInvoicesPage({
  view,
  tab,
  reviewAction,
  creditLinkAction,
  sectionViewer,
}: {
  view: AccountsSupplierDocumentsView;
  tab: AccountsDocumentTab;
  reviewAction: DecisionAction;
  /** Accounts phase (contract 7.3 S3): link a credit note to its invoice; absent = not offered. */
  creditLinkAction?: DecisionAction;
  /** The menu flags (Money out tab strip); absent: no strip. */
  sectionViewer?: AccountsSectionViewer;
}) {
  const docs = tab === 'missing' ? [] : view.documents;
  const missing = tab === 'to_review' ? [] : view.missingInvoices;
  const nothing = docs.length === 0 && missing.length === 0;
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader
        eyebrow="Accounts"
        title="Supplier invoices"
        description="Original supplier invoices and credit notes that Purchase uploaded. Check the number, date and total against the file, then accept or return it."
      />
      <MoneyOutTabs viewer={sectionViewer} currentHref="/app/accounts/supplier-invoices" />
      <ListTabs label="Supplier invoice filters" basePath="/app/accounts/supplier-invoices" current={tab} defaultTab="to_review" tabs={DOCUMENT_TABS.map((key) => ({ key, label: TAB_LABEL[key] }))} />
      {nothing ? (
        <ListEmpty
          icon={ReceiptText}
          title={tab === 'to_review' ? 'Nothing to check' : tab === 'missing' ? 'No invoices missing' : 'No supplier invoices yet'}
          description={
            tab === 'to_review'
              ? 'No uploaded invoice or credit note is waiting for Accounts.'
              : tab === 'missing'
                ? 'Every confirmed service whose trip has ended has an invoice uploaded.'
                : 'Purchase uploads invoices and credit notes on a task’s Files tab.'
          }
        />
      ) : (
        <div className="flex flex-col gap-5">
          {missing.length > 0 ? (
            <Card>
              <section aria-labelledby="missing-invoices">
                <CardHeader>
                  <CardTitle id="missing-invoices">Original invoice missing</CardTitle>
                </CardHeader>
                <CardBody>
                  <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Services with no supplier invoice">
                    {missing.map((m) => (
                      <li key={m.taskId} className="m-0 flex gap-2">
                        <FileWarning aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-warning" />
                        <span className="min-w-0 wrap-break-word">
                          <span className="font-semibold text-ink">{m.serviceTitle}</span> · {m.dealReference} · {m.supplierName ?? 'Supplier not recorded'} · trip ended {dateText(m.tripEnd)} · {departmentWord(m.department)}: {m.assigneeName ?? 'not taken'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </CardBody>
              </section>
            </Card>
          ) : null}
          {docs.length > 0 ? (
            <ItemList label="Supplier invoices and credit notes, newest first">
              {docs.map((d) => {
                const look = LOOK[d.status];
                return (
                  <ItemCard
                    key={d.id}
                    id={`doc-${d.id}`}
                    eyebrow={
                      <>
                        <span className="whitespace-nowrap">{d.dealReference}</span> · {d.branchName} · {departmentWord(d.department)}
                      </>
                    }
                    title={
                      <>
                        {DOCUMENT_KIND_LABEL[d.kind]} {d.number}
                        <span className="block text-base font-normal text-copy">
                          {d.supplierName} · {d.serviceTitle}
                        </span>
                      </>
                    }
                    status={
                      <Status tone={look.tone} icon={look.icon} label="Document">
                        {DOCUMENT_STATUS_LABEL[d.status]}
                      </Status>
                    }
                    aside={<AmountAside label="Total" paise={d.totalPaise} note={d.gstIncluded ? 'GST included' : 'GST not included'} />}
                  >
                    <Facts
                      rows={[
                        ['Document date', dateText(d.docDate)],
                        ['File', <FileLink key="f" href={supplierMoneyFileHref(d.evidenceId)}>Open {DOCUMENT_KIND_LABEL[d.kind].toLowerCase()}</FileLink>],
                        ['Uploaded', `${whenText(d.uploadedAt)} ${byText(d.uploadedByName)}`],
                        !!d.reviewedAt && ['Checked', `${whenText(d.reviewedAt)} ${byText(d.reviewedByName)}`],
                        !!d.returnReason && ['Reason given', <span key="r" className="whitespace-pre-wrap">{d.returnReason}</span>],
                        // Accounts phase (contract 6.2.3, H11): one bill on several tasks; credit note -> invoice.
                        !!d.linkedTaskCount && ['Also linked to', `${d.linkedTaskCount} other ${d.linkedTaskCount === 1 ? 'task' : 'tasks'}`],
                        d.kind === 'credit_note' && !!d.creditsDocumentNumber && ['Credit note for', `Invoice ${d.creditsDocumentNumber}`],
                      ]}
                    />
                    {d.kind === 'credit_note' && !d.creditsDocumentId && d.status !== 'returned' && creditLinkAction ? (
                      <CreditLinkButton
                        documentId={d.id}
                        number={d.number}
                        action={creditLinkAction}
                        invoices={view.documents
                          .filter((x) => x.kind === 'invoice' && x.status !== 'returned' && x.supplierId === d.supplierId)
                          .map((x) => ({ id: x.id, label: `${x.number} · ${formatPaise(x.totalPaise)} · ${x.dealReference}` }))}
                      />
                    ) : null}
                    {d.canReview || d.status === 'uploaded' ? (
                      <RowDecision
                        recordName={`${DOCUMENT_KIND_LABEL[d.kind].toLowerCase()} ${d.number}`}
                        action={reviewAction}
                        fields={{ [SM_FIELD.documentId]: d.id, [SM_FIELD.expectedRowVersion]: d.rowVersion }}
                        decisionField={SM_FIELD.decision}
                        reasonField={SM_FIELD.reason}
                        requestIdField={SM_FIELD.requestId}
                        approveLabel="Accept document"
                        approveValue="accept"
                        help="Accept when the number, date, total and GST match the file."
                        ret={{
                          title: `Return ${DOCUMENT_KIND_LABEL[d.kind].toLowerCase()} ${d.number} to ${departmentWord(d.department)}?`,
                          effect: `It goes back to ${d.uploadedByName ?? 'the colleague who uploaded it'} with your reason, to upload a corrected one.`,
                          confirmLabel: `Return to ${departmentWord(d.department)}`,
                        }}
                        disabledReason={d.canReview ? undefined : 'Another Accounts colleague checks this. Nobody checks their own upload.'}
                      />
                    ) : null}
                  </ItemCard>
                );
              })}
            </ItemList>
          ) : null}
        </div>
      )}
    </div>
  );
}
