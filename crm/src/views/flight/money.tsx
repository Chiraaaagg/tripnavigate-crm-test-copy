import { HandCoins } from 'lucide-react';
import { FLIGHT_PURCHASE_HOLDER_TEXT } from '@/modules/flight/money-contracts';
import { StatusBadge } from '@/components/ui/badge';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Notice } from '@/components/ui/notice';
import { budgetText } from '../department/task-frame';
import { formatIst } from '../deal-labels';
import type { FlightWorkActions } from './actions';
import { PaymentBadge } from './bits';
import { inr } from './format';
import { PAX_LABEL } from './labels';
import { FlightInvoicesSection } from './invoices';
import { DirectPaymentDrawer, PaymentRequestDrawer } from './payment-forms';
import { UnavailableAction } from '@/views/accounts/supplier-forms';
import type { FlightMoney, FlightPaymentContext, MoneyBatch } from './types';

/*
 * Cost and payment (contract 11.1, replaces the dead prototype costCard
 * FV:954): budget against supplier cost, then per ticket batch its fare
 * breakup (only the keys the server sent this viewer: the money fence is
 * built by the database per role) and its payment state. The Flight assignee
 * gets the two payment drawers; everyone else reads.
 */

/**
 * Lead decision (5 Nov 2026): on a flight-only Deal a Flight person who also
 * works in Purchase may not enter or see markup and discount. The money read
 * says so explicitly (marginsAllowed false on a flight-only Deal).
 */
export function marginsBlocked(money: FlightMoney | null): boolean {
  return !!money && money.dealKind === 'flight_only' && money.marginsAllowed === false;
}

export const MARGINS_BLOCKED_TEXT = FLIGHT_PURCHASE_HOLDER_TEXT;

function FareTable({ batch, flightOnly: flightOnlyDeal }: { batch: MoneyBatch; flightOnly: boolean }) {
  if (!batch.fares?.length) return null;
  // Markup, discount and customer amounts only when the server sent them for this viewer (never shown as ₹0 or blank).
  const flightOnly = flightOnlyDeal && batch.fares.some((f) => typeof f.markupPaise === 'string' || typeof f.customerAmountPaise === 'string');
  const heads = ['Type', 'Basic', 'K', 'YQ', 'YR', 'Other', 'Supplier / person', ...(flightOnly ? ['Markup', 'Discount', 'Total / person'] : []), 'Count', 'Supplier amount', ...(flightOnly ? ['Customer amount'] : [])];
  return (
    <div className="min-w-0 overflow-x-auto rounded-control border border-line" role="region" aria-label={`Fares of batch ${batch.batchNo}`} tabIndex={0}>
      <table className="w-full border-collapse text-sm max-sm:block">
        <thead className="bg-wash text-left text-xs font-semibold text-quiet max-sm:sr-only">
          <tr>
            {heads.map((h) => (
              <th key={h} scope="col" className="px-2 py-1.5 align-bottom">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="max-sm:block">
          {batch.fares.map((f) => {
            const cells: Array<[string, string]> = [
              ['Type', PAX_LABEL[f.paxType]],
              ['Basic', inr(f.basicPaise)],
              ['K', inr(f.kPaise)],
              ['YQ', inr(f.yqPaise)],
              ['YR', inr(f.yrPaise)],
              ['Other', inr(f.otherPaise)],
              ['Supplier / person', inr(f.supplierPerPersonPaise)],
              ...(flightOnly
                ? ([
                    ['Markup', inr(f.markupPaise)],
                    ['Discount', inr(f.discountPaise)],
                    ['Total / person', inr(f.totalPerPersonPaise)],
                  ] as Array<[string, string]>)
                : []),
              ['Count', String(f.paxCount)],
              ['Supplier amount', inr(f.supplierAmountPaise)],
              ...(flightOnly ? ([['Customer amount', inr(f.customerAmountPaise)]] as Array<[string, string]>) : []),
            ];
            return (
              <tr key={f.paxType} className="border-t border-line max-sm:grid max-sm:grid-cols-2 max-sm:gap-x-3 max-sm:px-3 max-sm:py-2">
                {cells.map(([label, value]) => (
                  <td key={label} className="px-2 py-1.5 tabular-nums max-sm:p-0">
                    <span aria-hidden="true" className="block text-xs text-quiet sm:hidden">
                      {label}
                    </span>
                    {value}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Why "Record direct payment" cannot be used for this batch now. */
function directBlockedReason(b: MoneyBatch, ctx: FlightPaymentContext | null): string {
  if (ctx?.directAllowed === false || b.routePreview === 'manager' || ctx?.routePreview === 'manager') return 'Above ₹50,000 for this supplier on this Deal: raise a payment request.';
  return 'A direct payment is not possible for these tickets now. Raise a payment request instead.';
}

export function CostAndPaymentCard({
  money,
  canWork,
  canUploadInvoice,
  dealId,
  paymentContexts,
  actions,
}: {
  money: FlightMoney | null | 'error';
  canWork: boolean;
  /** The Deal's Flight colleague, also after "done" (decision 10). */
  canUploadInvoice: boolean;
  dealId: string;
  paymentContexts: Record<string, FlightPaymentContext>;
  actions: FlightWorkActions;
}) {
  return (
    <Card id="cost-payment">
      <section aria-labelledby="cost-heading">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id="cost-heading">Cost and payment</CardTitle>
            <CardDescription>The fares confirmed with the tickets are the flight cost. Pay the supplier directly (within ₹50,000 for this supplier on this Deal) or raise a payment request.</CardDescription>
          </div>
          <HandCoins aria-hidden="true" className="size-4 text-faint" />
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          {money === 'error' ? (
            <Notice tone="warning" role="status">
              <p>The cost and payment details did not load. Nothing was changed. Reload the page.</p>
            </Notice>
          ) : money === null ? (
            <p className="m-0 text-quiet">Cost and payment are shown to the Flight team, the branch Manager and Accounts.</p>
          ) : (
            <>
              <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(8rem,12rem)_1fr]">
                <dt className="text-sm font-medium text-quiet">Approved budget</dt>
                <dd className="m-0 tabular-nums text-ink">{budgetText(money.budget.dealPaise)}</dd>
                {money.batches.length > 0 ? (
                  <>
                    <dt className="text-sm font-medium text-quiet">Supplier cost so far</dt>
                    <dd className="m-0 flex flex-wrap items-center gap-2 tabular-nums text-ink">
                      {inr(money.supplierCostPaise)}
                      {money.overBudget ? (
                        <StatusBadge tone="warning" wrap>
                          Above budget
                        </StatusBadge>
                      ) : null}
                    </dd>
                  </>
                ) : null}
                {money.dealKind === 'flight_only' && typeof money.customerTotalPaise === 'string' ? (
                  <>
                    <dt className="text-sm font-medium text-quiet">Customer total (flight-only)</dt>
                    <dd className="m-0 tabular-nums text-ink">{inr(money.customerTotalPaise)}</dd>
                  </>
                ) : null}
              </dl>
              {money.batches.length === 0 ? <p className="m-0 text-copy">No ticket batch yet. The cost appears here after Confirm tickets.</p> : null}
              {money.batches.map((b) => {
                const ctx = paymentContexts[b.batchId] ?? null;
                const actionable = canWork && (b.canPayDirect || b.canRequest);
                return (
                  <section key={b.batchId} aria-labelledby={`batch-${b.batchId}`} className="flex flex-col gap-2 rounded-control border border-line p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 id={`batch-${b.batchId}`} className="m-0 text-base font-semibold text-ink">
                        Batch {b.batchNo} · {b.supplierName}
                      </h3>
                      <PaymentBadge state={b.payment.state} />
                    </div>
                    <p className="m-0 text-sm text-quiet">
                      Confirmed {formatIst(b.confirmedAt)}
                      {b.confirmedByName ? ` by ${b.confirmedByName}` : ''}
                      {b.supplierCostPaise ? ` · supplier cost ${inr(b.supplierCostPaise)}` : ''}
                      {typeof b.customerTotalPaise === 'string' ? ` · customer total ${inr(b.customerTotalPaise)}` : ''}
                      {b.payment.refNo ? ` · ${b.payment.refNo}` : ''}
                    </p>
                    {b.legacyPaidPaise && BigInt(b.legacyPaidPaise) > 0n ? (
                      <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-0.5 text-sm sm:grid-cols-[minmax(10rem,14rem)_1fr]">
                        <dt className="font-medium text-quiet">Paid earlier (old fare record)</dt>
                        <dd className="m-0 tabular-nums">{inr(b.legacyPaidPaise)}</dd>
                        <dt className="font-medium text-quiet">Still to pay</dt>
                        <dd className="m-0 font-semibold tabular-nums text-ink">{inr(b.duePaise)}</dd>
                      </dl>
                    ) : null}
                    <FareTable batch={b} flightOnly={money.dealKind === 'flight_only'} />
                    {b.payment.returnReason && (b.payment.state === 'direct_returned' || b.payment.state === 'request_returned') ? (
                      <Notice tone="danger" title="Returned">
                        <p>{b.payment.returnReason}</p>
                      </Notice>
                    ) : null}
                    {b.payment.onHold ? (
                      <Notice tone="warning" title="On hold">
                        <p>{b.payment.holdReason ?? 'Accounts put this payment on hold.'}</p>
                      </Notice>
                    ) : null}
                    {actionable ? (
                      <div className="flex flex-wrap items-start gap-2">
                        {b.canPayDirect ? (
                          <DirectPaymentDrawer batch={b} ctx={ctx} actions={actions} />
                        ) : (
                          // Contract 11.1: stays visible, unavailable, with the reason (never silently missing).
                          <UnavailableAction label="Record direct payment" reason={directBlockedReason(b, ctx)} />
                        )}
                        {b.canRequest ? <PaymentRequestDrawer batch={b} ctx={ctx} actions={actions} /> : null}
                      </div>
                    ) : null}
                  </section>
                );
              })}
              <FlightInvoicesSection money={money} canUpload={canUploadInvoice} actions={actions.invoices} dealId={dealId} />
            </>
          )}
        </CardBody>
      </section>
    </Card>
  );
}
