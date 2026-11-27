'use client';

import { Ban, CircleCheck, Hourglass, Plane, TriangleAlert } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { MoneyInput } from '@/components/ui/money-input';
import { Textarea } from '@/components/ui/textarea';
import { UnavailableAction, type DecisionAction } from '@/views/accounts/supplier-forms';
import { DeskDialog, DeskResultLine, type DeskResult } from '@/views/accounts-desk/desk-kit';
import { cancelledBatches, type CancelledBatch } from '@/views/cancellations/flight-model';
import { paiseToRupees, type FlightBatchCancellation, type FlightBatchCancellationKeys } from '@/views/cancellations/types';
import { inr } from './format';
import type { FlightMoney, MoneyBatch } from './types';

/*
 * Flight task · "Trip cancelled" (Accounts phase 2 contract 7.4 C9, 11 item 6).
 * Per ticket batch: what the airline keeps, the refund expected, the refund
 * the airline reports (Flight's word, not money) and what Accounts verified
 * as received. The branch Manager approves the charges with the
 * cancellation; after approval the tickets show "Tickets cancelled" (they
 * stay as issued) and only the reported refund may change (LD13). No selling
 * price, customer money or customer refund is ever shown here.
 */

/** "Tickets cancelled" label for a batch of an approved cancellation (used on every batch heading). */
export function TicketsCancelledBadge({ batch }: { batch: MoneyBatch }) {
  if (!(batch as MoneyBatch & FlightBatchCancellationKeys).ticketsCancelled) return null;
  return (
    <StatusBadge tone="neutral" icon={Ban} wrap>
      Tickets cancelled
    </StatusBadge>
  );
}

function entered(c: FlightBatchCancellation): boolean {
  return (c.revisionNo ?? 0) > 0;
}

export function FlightTripCancelledCard({
  money,
  dealId,
  action,
  initialOpenBatchId,
  initialState,
  initialTyped,
}: {
  money: FlightMoney | null | 'error';
  /** For the action's page refresh. */
  dealId?: string;
  /** C9 setFlightCancellationChargeAction; null/undefined = read only (e.g. the branch Manager). */
  action?: DecisionAction | null;
  /** Preview gallery only: a batch dialog open on first paint, optionally with a refusal. */
  initialOpenBatchId?: string;
  initialState?: DeskResult | null;
  /** Preview gallery only: what the person typed before the refusal (the open dialog keeps it). */
  initialTyped?: { airlineChargeRupees?: string; refundExpectedRupees?: string };
}) {
  const batches = cancelledBatches(money);
  const base = useId();
  const [result, setResult] = useState<DeskResult | null>(null);
  const resultId = `${base}-result`;
  if (batches.length === 0) return null;
  const approved = batches.every((b) => b.cancellation.state === 'approved');
  const missing = batches.filter((b) => !entered(b.cancellation)).length;
  return (
    <Card id="trip-cancelled" className="border-status-warning-line">
      <section aria-labelledby={`${base}-title`}>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id={`${base}-title`}>Trip cancelled</CardTitle>
            <CardDescription>
              {approved
                ? 'The branch Manager approved the cancellation. Only the refund the airline reports can still be updated.'
                : 'For each ticket batch, enter what the airline keeps and the refund you expect. The branch Manager approves them with the cancellation.'}
            </CardDescription>
          </div>
          {approved ? (
            <StatusBadge tone="success" icon={CircleCheck} wrap>
              <span className="sr-only">Cancellation: </span>
              Approved by the Manager
            </StatusBadge>
          ) : missing > 0 ? (
            <StatusBadge tone="warning" icon={TriangleAlert} wrap>
              <span className="sr-only">Cancellation: </span>
              {missing === 1 ? '1 batch without charges' : `${missing} batches without charges`}
            </StatusBadge>
          ) : (
            <StatusBadge tone="info" icon={Hourglass} wrap>
              <span className="sr-only">Cancellation: </span>
              Waiting for the Manager
            </StatusBadge>
          )}
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          <div id={resultId} tabIndex={-1} className="outline-none empty:hidden">
            {result ? <DeskResultLine state={result} okTitle="Saved" /> : null}
          </div>
          {batches.map((b) => (
            <BatchCharges
              key={b.batchId}
              batch={b}
              dealId={dealId}
              action={action ?? null}
              initialOpen={initialOpenBatchId === b.batchId}
              initialState={initialOpenBatchId === b.batchId ? initialState : undefined}
              initialTyped={initialOpenBatchId === b.batchId ? initialTyped : undefined}
              onDone={(r) => {
                setResult(r);
                window.setTimeout(() => document.getElementById(resultId)?.focus(), 60);
              }}
            />
          ))}
          <p className="m-0 text-sm text-quiet">“Refund reported” is what the airline or supplier says it will return. It is not money until Accounts records and verifies the refund received.</p>
        </CardBody>
      </section>
    </Card>
  );
}

function BatchCharges({
  batch,
  dealId,
  action,
  initialOpen,
  initialState,
  initialTyped,
  onDone,
}: {
  batch: CancelledBatch;
  dealId?: string;
  action: DecisionAction | null;
  initialOpen?: boolean;
  initialState?: DeskResult | null;
  initialTyped?: { airlineChargeRupees?: string; refundExpectedRupees?: string };
  onDone: (r: DeskResult) => void;
}) {
  const c = batch.cancellation;
  const id = useId();
  const [open, setOpen] = useState(!!initialOpen);
  const opener = useRef<HTMLButtonElement>(null);
  const after = c.state === 'approved';
  const has = entered(c);
  const label = after ? 'Update refund reported' : has ? 'Change airline charges' : 'Enter airline charges';
  return (
    <section aria-labelledby={`${id}-h`} className="flex flex-col gap-3 rounded-control border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${id}-h`} className="m-0 flex min-w-0 items-center gap-2 text-base font-semibold text-ink">
          <Plane aria-hidden="true" className="size-4 shrink-0 text-faint" />
          <span className="wrap-anywhere">
            Batch {batch.batchNo} · {batch.supplierName}
          </span>
        </h3>
        <div className="flex flex-wrap gap-2">
          <TicketsCancelledBadge batch={batch} />
          {has ? (
            <StatusBadge tone="info" icon={CircleCheck} wrap>
              Charges entered · revision {c.revisionNo}
            </StatusBadge>
          ) : (
            <StatusBadge tone="warning" icon={TriangleAlert} wrap>
              Charges not entered yet
            </StatusBadge>
          )}
        </div>
      </div>
      <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-1.5 text-sm min-[420px]:grid-cols-2 lg:grid-cols-5">
        <Fig label="Supplier cost" value={inr(batch.supplierCostPaise)} />
        <Fig label="Airline keeps" value={has ? inr(c.airlineChargePaise) : 'Not entered'} />
        <Fig label="Refund expected" value={has ? inr(c.refundExpectedPaise) : 'Not entered'} />
        <Fig label="Refund reported" value={c.refundReportedPaise ? inr(c.refundReportedPaise) : 'Not reported yet'} />
        <Fig label="Refund received (verified)" value={inr(c.supplierRefundReceivedPaise, '₹0.00')} />
      </dl>
      {c.note ? (
        <p className="m-0 text-sm text-copy">
          <span className="font-semibold text-ink">Note: </span>
          <span className="whitespace-pre-wrap">{c.note}</span>
        </p>
      ) : null}
      {action && c.canEnter ? (
        <div>
          <Button ref={opener} type="button" variant="secondary" onClick={() => setOpen(true)} aria-label={`${label} for batch ${batch.batchNo}`}>
            {label}
          </Button>
          {open ? (
            <DeskDialog
              open={open}
              onOpenChange={setOpen}
              title={`${label} · batch ${batch.batchNo}`}
              description={
                after
                  ? 'The cancellation is approved, so the airline charge and the refund expected stay as approved. Update what the airline now says it will refund.'
                  : 'Amounts in rupees. A change after the charges were sent puts the cancellation back with Purchase and Flight before the Manager decides.'
              }
              primaryLabel={after ? 'Save refund reported' : 'Save charges'}
              pendingLabel="Saving…"
              action={action}
              initialState={initialState}
              returnFocus={opener}
              onDone={(r) => {
                setOpen(false);
                onDone(r);
              }}
            >
              {({ requestId }) => (
                <>
                  <input type="hidden" name="batchId" value={batch.batchId} />
                  {dealId ? <input type="hidden" name="dealId" value={dealId} /> : null}
                  <input type="hidden" name="expectedRevision" value={String(c.revisionNo ?? 0)} />
                  <input type="hidden" name="requestId" value={requestId} />
                  {after ? (
                    <>
                      <input type="hidden" name="airlineChargeRupees" value={paiseToRupees(c.airlineChargePaise)} />
                      <input type="hidden" name="refundExpectedRupees" value={paiseToRupees(c.refundExpectedPaise)} />
                      <dl className="m-0 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
                        <Fig label="Airline keeps (approved)" value={inr(c.airlineChargePaise)} />
                        <Fig label="Refund expected (approved)" value={inr(c.refundExpectedPaise)} />
                      </dl>
                    </>
                  ) : (
                    <>
                      <Field htmlFor={`${id}-charge`} label="What the airline keeps (₹)" hint={`Supplier cost of this batch: ${inr(batch.supplierCostPaise)}.`}>
                        <MoneyInput id={`${id}-charge`} name="airlineChargeRupees" defaultValue={initialTyped?.airlineChargeRupees ?? paiseToRupees(c.airlineChargePaise)} aria-describedby={`${id}-charge-hint`} />
                      </Field>
                      <Field htmlFor={`${id}-expected`} label="Refund expected (₹)" hint="What you expect the airline or supplier to return.">
                        <MoneyInput id={`${id}-expected`} name="refundExpectedRupees" defaultValue={initialTyped?.refundExpectedRupees ?? paiseToRupees(c.refundExpectedPaise)} aria-describedby={`${id}-expected-hint`} />
                      </Field>
                    </>
                  )}
                  <Field htmlFor={`${id}-reported`} label="Refund reported by the airline (₹)" optional hint="Leave blank until the airline or supplier says what it returns. Not money until Accounts records it.">
                    <MoneyInput id={`${id}-reported`} name="refundReportedRupees" defaultValue={paiseToRupees(c.refundReportedPaise)} aria-describedby={`${id}-reported-hint`} />
                  </Field>
                  <Field htmlFor={`${id}-note`} label="Note" hint="1 to 500 characters, for example the airline's cancellation rule. No passenger names, PNRs or ticket numbers.">
                    <Textarea id={`${id}-note`} name="note" rows={3} maxLength={500} defaultValue={c.note ?? ''} aria-describedby={`${id}-note-hint`} />
                  </Field>
                </>
              )}
            </DeskDialog>
          ) : null}
        </div>
      ) : !c.canEnter && !after ? (
        <UnavailableAction label="Enter airline charges" reason="Only the Flight person on these tickets enters the airline charges." />
      ) : null}
    </section>
  );
}

function Fig({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-quiet">{label}</dt>
      <dd className="m-0 font-medium tabular-nums text-ink">{value}</dd>
    </div>
  );
}
