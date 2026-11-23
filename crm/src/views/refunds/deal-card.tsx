import { Undo2 } from 'lucide-react';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Notice } from '@/components/ui/notice';
import { DialogAction } from '@/views/accounts-desk/acc2-kit';
import type { DeskResult } from '@/views/accounts-desk/desk-kit';
import { inr } from '@/views/accounts-desk/labels';
import { RefundRequestFields } from './fields';
import { RefundRequestBlock, type RefundActions, type RefundPreviewOpen } from './request-block';
import { SupplierRefundsList, type SupplierRefundLine } from './supplier-refunds';
import type { DealRefundsView } from './types';

/*
 * Deal page "Refunds" card (contract 7.2, 7.5 R-C1, screen 11.3): money held
 * (verified, net of refunds), charges kept (one combined figure, LD11), the
 * maximum refund now, the request form for the Sales owner (or the branch
 * Manager when the Deal has no Sales owner), the requests with their
 * timeline and actions, and for Accounts and the Manager the supplier
 * refunds expected. Purchase, Flight and Visa get null from the database and
 * the route renders nothing.
 */

export function DealRefundsCard({
  refunds,
  actions,
  today,
  preview,
}: {
  refunds: DealRefundsView | 'error';
  actions: Partial<RefundActions> | null;
  today: string;
  preview?: { requestOpen?: boolean; requestState?: DeskResult | null; open?: RefundPreviewOpen; supplierOpen?: { key: string; dialog: 'record' | 'cancel'; state?: DeskResult | null } };
}) {
  if (refunds === 'error') {
    return (
      <Card id="refunds">
        <section aria-labelledby="refunds-heading">
          <CardHeader>
            <CardTitle id="refunds-heading">Refunds</CardTitle>
          </CardHeader>
          <CardBody>
            <Notice tone="warning" role="status">
              <p>The refunds could not be loaded just now. Nothing was changed. Reload the page.</p>
            </Notice>
          </CardBody>
        </section>
      </Card>
    );
  }
  const r = refunds;
  const live = r.requests.find((q) => q.status === 'requested' || q.status === 'returned' || (q.status === 'approved' && q.outcome === 'payout'));
  const cancelled = r.cancellation?.status === 'approved';
  const off = r.enabled ? null : 'Refunds are not switched on yet.';
  const requestBlock = off ?? (live ? `Refund ${live.refNo} is in progress. Finish or withdraw it first.` : !r.canRequest ? null : BigInt(r.maxRefundPaise) <= 0n && !cancelled ? 'No money to refund: nothing is held above the booking total.' : null);
  const supplierLines: SupplierRefundLine[] = (r.supplierRefunds ?? []).map((s) => ({
    key: `${s.sourceKind}:${s.sourceId}`,
    cancellationId: s.cancellationId,
    dealId: r.dealId,
    sourceKind: s.sourceKind,
    sourceId: s.sourceId,
    supplierName: s.supplierName,
    expectedPaise: s.expectedPaise,
    receivedPaise: s.receivedPaise,
    canRecord: s.canRecord,
    receipts: s.receipts,
  }));
  const status = live ? `Refund ${live.refNo} in progress` : r.cancellation ? (cancelled ? 'Trip cancellation approved' : 'Trip cancellation open') : r.requests.length ? `${r.requests.length} past ${r.requests.length === 1 ? 'request' : 'requests'}` : 'No refunds';
  return (
    <Card id="refunds">
      <section aria-labelledby="refunds-heading">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id="refunds-heading">Refunds</CardTitle>
            <CardDescription>{status}</CardDescription>
          </div>
          <Undo2 aria-hidden="true" className="size-4 text-faint" />
        </CardHeader>
        <CardBody className="flex flex-col gap-5">
          {!r.enabled ? (
            <Notice tone="info" title="Refunds are not switched on yet">
              <p>Refund requests start once a Super Admin switches refunds on in Settings · Accounts.</p>
            </Notice>
          ) : null}
          {r.cancellation && !cancelled ? (
            <Notice tone="info" title="Trip cancellation not approved yet">
              <p>A cancellation refund can be asked for once the branch Manager approves the trip cancellation.</p>
            </Notice>
          ) : null}
          {BigInt(r.heldPaise) < 0n ? (
            <Notice tone="warning" title="Customer owes after a reversed payment">
              <p>A verified payment was reversed after money went back to the customer, so the money held is below zero. No refund can be asked for until the customer pays the difference.</p>
            </Notice>
          ) : null}
          <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
            <Fig label="Money held (verified)" value={inr(r.heldPaise)} />
            {r.basisTotalPaise !== null ? <Fig label={cancelled ? 'Booking total before cancellation' : 'Booking total'} value={inr(r.basisTotalPaise)} /> : null}
            {r.chargesKeptPaise !== null ? <Fig label="Supplier and airline charges kept" value={inr(r.chargesKeptPaise)} /> : null}
            <Fig label={cancelled ? 'Most that can be refunded, before the customer charge' : 'Most that can be refunded now'} value={inr(r.maxRefundPaise)} strong />
          </dl>

          {r.canRequest ? (
            <div className="flex flex-col gap-1">
              <DialogAction
                buttonLabel="Ask for a refund"
                buttonVariant="primary"
                blockedReason={requestBlock}
                title="Ask for a refund"
                description="The branch Manager approves the exact amounts first. Accounts then pay it out (or it stays as customer credit)."
                primaryLabel="Send to the Manager"
                pendingLabel="Sending…"
                action={actions?.request}
                fields={{ dealId: r.dealId }}
                okTitle="Sent"
                initialOpen={preview?.requestOpen}
                initialState={preview?.requestState}
              >
                <RefundRequestFields keptCreditUnusedPaise={r.keptCreditUnusedPaise} approvedChargePaise={r.approvedChargePaise} heldPaise={r.heldPaise} basisTotalPaise={r.basisTotalPaise} cancellationApproved={cancelled} payers={r.payers} />
              </DialogAction>
            </div>
          ) : null}

          <section aria-labelledby="refunds-requests" className="flex flex-col gap-3">
            <h3 id="refunds-requests" className="m-0 text-base font-semibold text-ink">
              Refund requests
            </h3>
            {r.requests.length === 0 ? (
              <p className="m-0 text-copy">{r.canRequest ? 'No refund asked for yet.' : 'No refund asked for yet. The Sales owner asks; the branch Manager approves; Accounts pay out.'}</p>
            ) : (
              r.requests.map((q) => <RefundRequestBlock key={q.id} r={q} deal={r} dealId={r.dealId} actions={actions} today={today} open={preview?.open} viewer={r.viewer} />)
            )}
          </section>

          {r.supplierRefunds && (r.viewer === 'accounts' || r.viewer === 'manager') ? (
            <section aria-labelledby="refunds-supplier" className="flex flex-col gap-3">
              <h3 id="refunds-supplier" className="m-0 text-base font-semibold text-ink">
                Refunds expected from suppliers
              </h3>
              {supplierLines.length === 0 ? (
                <p className="m-0 text-copy">No supplier, airline or visa-fee refund is expected.</p>
              ) : (
                <SupplierRefundsList
                  lines={supplierLines}
                  actions={r.viewer === 'accounts' && actions?.recordSupplierRefund && actions.cancelSupplierRefund ? { record: actions.recordSupplierRefund, cancel: actions.cancelSupplierRefund } : null}
                  today={today}
                  enabled={r.enabled}
                  open={preview?.supplierOpen}
                />
              )}
              <p className="m-0 text-sm text-quiet">Supplier refunds never change what the customer owes.</p>
            </section>
          ) : null}
        </CardBody>
      </section>
    </Card>
  );
}

function Fig({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-sm text-quiet">{label}</dt>
      <dd className={`m-0 tabular-nums ${strong ? 'text-lg font-semibold text-ink' : 'text-ink'}`}>{value}</dd>
    </div>
  );
}
