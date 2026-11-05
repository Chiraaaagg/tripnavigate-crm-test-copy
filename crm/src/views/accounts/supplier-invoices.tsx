import { CircleCheck, CircleX, FileWarning, Hourglass, ReceiptText } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DOCUMENT_KIND_LABEL,
  DOCUMENT_STATUS_LABEL,
  SM_FIELD,
  type AccountsDocumentTab,
  type AccountsSupplierDocumentsView,
  type SupplierDocumentStatus,
} from '@/modules/supplier-money/contracts';
import { DecisionForm, type DecisionAction } from './supplier-forms';
import { departmentWord, supplierMoneyFileHref } from './supplier-payments';
import { AmountAside, byText, dateText, DecisionPanel, Facts, FileLink, ItemCard, ItemList, ListEmpty, ListTabs, Status, whenText } from './supplier-kit';

/*
 * Accounts · Supplier invoices and credit notes (Purchase build). Purchase
 * uploads the supplier's original invoice or credit note on the task; a
 * different Accounts person accepts or returns it. "Missing" lists confirmed
 * services whose trip has ended with no invoice uploaded.
 */

export const DOCUMENT_TABS: readonly AccountsDocumentTab[] = ['to_review', 'missing', 'all'];
const TAB_LABEL: Record<AccountsDocumentTab, string> = { to_review: 'To check', missing: 'Missing invoices', all: 'All' };

export function parseDocumentTab(raw: string | string[] | undefined): AccountsDocumentTab {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return (DOCUMENT_TABS as readonly string[]).includes(v ?? '') ? (v as AccountsDocumentTab) : 'to_review';
}

const LOOK: Record<SupplierDocumentStatus, { tone: 'warning' | 'success' | 'danger'; icon: typeof Hourglass }> = {
  uploaded: { tone: 'warning', icon: Hourglass },
  accepted: { tone: 'success', icon: CircleCheck },
  returned: { tone: 'danger', icon: CircleX },
};

export function AccountsSupplierInvoicesPage({ view, tab, reviewAction }: { view: AccountsSupplierDocumentsView; tab: AccountsDocumentTab; reviewAction: DecisionAction }) {
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
                      ]}
                    />
                    {d.canReview ? (
                      <DecisionPanel title="Accept or return">
                        <DecisionForm
                          action={reviewAction}
                          label={`Check ${DOCUMENT_KIND_LABEL[d.kind].toLowerCase()} ${d.number}`}
                          fields={{ [SM_FIELD.documentId]: d.id, [SM_FIELD.expectedRowVersion]: d.rowVersion }}
                          decisionField={SM_FIELD.decision}
                          reasonField={SM_FIELD.reason}
                          requestIdField={SM_FIELD.requestId}
                          approveLabel="Accept document"
                          approveValue="accept"
                          returnLabel="Return to Purchase"
                          approveHelp="Accept when the number, date, total and GST match the file."
                        />
                      </DecisionPanel>
                    ) : d.status === 'uploaded' ? (
                      <p className="m-0 text-sm text-quiet">Another Accounts colleague checks this. Nobody checks their own upload.</p>
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
