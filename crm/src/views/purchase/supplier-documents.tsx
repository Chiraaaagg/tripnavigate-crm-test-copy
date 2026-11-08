import { CircleCheck, Hourglass, RotateCcw } from 'lucide-react';
import { StatusBadge } from '@/components/ui/badge';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Notice } from '@/components/ui/notice';
import { formatPaise } from '@/modules/deals/dto';
import { DOCUMENT_KIND_LABEL, DOCUMENT_STATUS_LABEL, INVOICE_MISSING_TEXT, type PaymentContextView } from '@/modules/supplier-money/contracts';
import { formatDateOnly } from '../booking-views';
import { formatIst } from '../staff-views';
import type { DecisionAction } from '../accounts/supplier-forms';
import { SupplierDocumentDrawer } from './work-forms';

/*
 * Files tab: supplier invoices and credit notes (prototype item 6). Rows show
 * Accounts' review status (icon + words). "Original invoice missing" when the
 * trip has ended, the task is confirmed and no non-returned invoice exists.
 * Purchase may upload after confirmation too. No payment proof is ever listed.
 */

export function SupplierDocumentsSection({ ctx, documentAction, uploadAction }: { ctx: PaymentContextView | null | 'error'; documentAction: DecisionAction; uploadAction: DecisionAction }) {
  return (
    <Card>
      <section aria-labelledby="task-supplier-docs">
        <CardHeader className="max-sm:flex-col max-sm:items-start">
          <div className="min-w-0">
            <CardTitle id="task-supplier-docs">Supplier invoices and credit notes</CardTitle>
            <CardDescription>Accounts checks each one. Uploading does not pay anyone.</CardDescription>
          </div>
          {ctx && ctx !== 'error' && ctx.canUploadDocuments ? <SupplierDocumentDrawer taskId={ctx.taskId} action={documentAction} uploadAction={uploadAction} /> : null}
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          {ctx === 'error' ? (
            <Notice tone="warning" role="status">
              <p>Supplier invoices could not be loaded just now. Reload the page to try again.</p>
            </Notice>
          ) : !ctx ? (
            <p className="m-0 text-quiet">Not available for this task.</p>
          ) : (
            <>
              {ctx.invoiceMissing ? (
                <Notice tone="warning" title="Original invoice missing">
                  <p>{INVOICE_MISSING_TEXT}</p>
                </Notice>
              ) : null}
              {ctx.documents.length === 0 ? (
                <p className="m-0 text-quiet">No supplier invoice or credit note yet.</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Supplier invoices and credit notes">
                  {ctx.documents.map((d) => (
                    <li key={d.id} className="m-0 flex flex-col gap-1 rounded-control border border-line bg-canvas px-3.5 py-2.5">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <p className="m-0 font-medium wrap-anywhere text-ink">
                          {DOCUMENT_KIND_LABEL[d.kind]} {d.number} · <span className="tabular-nums">{formatPaise(d.totalPaise)}</span>
                          {d.gstIncluded ? ' incl. GST' : ' without GST'}
                        </p>
                        <StatusBadge tone={d.status === 'accepted' ? 'success' : d.status === 'returned' ? 'danger' : 'warning'} icon={d.status === 'accepted' ? CircleCheck : d.status === 'returned' ? RotateCcw : Hourglass} wrap>
                          <span className="sr-only">Accounts check: </span>
                          {DOCUMENT_STATUS_LABEL[d.status]}
                        </StatusBadge>
                      </div>
                      <p className="m-0 text-sm text-quiet">
                        {d.supplierName} · dated {formatDateOnly(d.docDate)} · uploaded {formatIst(d.uploadedAt)}
                        {d.uploadedByName ? ` by ${d.uploadedByName}` : ''}
                      </p>
                      {d.status === 'returned' && d.returnReason ? <p className="m-0 text-sm whitespace-pre-wrap wrap-break-word text-status-danger">Reason: {d.returnReason}</p> : null}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </CardBody>
      </section>
    </Card>
  );
}
