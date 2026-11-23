import { Info, CalendarClock } from 'lucide-react';
import { StatusBadge } from '@/components/ui/badge';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Notice } from '@/components/ui/notice';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { DuesFlags } from './dues';
import { AddTallyInvoice, WithdrawTallyInvoice } from './deal-money-forms';
import { basisText, dayText, DUES_LABEL, DUES_TONE, INSTALMENT_LABEL, INSTALMENT_TONE, inr, PROVISIONAL_TEXT, REPORTED_TEXT, TALLY_LABEL, TALLY_TONE } from './labels';
import type { DealDues, DuesViewer } from './types';
import { DuesWriteOffLine } from '@/views/write-offs/monthly';

/*
 * Deal page "Customer dues" card (contract 4.4, 8.3 deal_dues, 11.4): the
 * dues summary, the instalments (oldest due first, covered from verified
 * money), "Reported, not yet money", the Tally GST invoice references with
 * their Tally status, and for Accounts and the branch Manager the supplier
 * payables side by side (no difference column, H10). Accounts add and
 * withdraw GST references; everyone else reads. Provisional dues (booking
 * not yet approved by Accounts) say so in words.
 */

export interface DealMoneyActions {
  addTallyInvoice: DecisionAction;
  withdrawTallyInvoice: DecisionAction;
}

export function DealDuesCard({
  dues,
  viewer,
  actions,
  preview,
}: {
  dues: DealDues | 'error';
  viewer: DuesViewer;
  /** Accounts only. */
  actions?: DealMoneyActions | null;
  preview?: { addOpen?: boolean; addState?: Parameters<typeof AddTallyInvoice>[0]['initialState'] };
}) {
  if (dues === 'error') {
    return (
      <Card id="dues">
        <section aria-labelledby="dues-heading">
          <CardHeader>
            <CardTitle id="dues-heading">Customer dues</CardTitle>
          </CardHeader>
          <CardBody>
            <Notice tone="warning" role="status">
              <p>The dues could not be loaded just now. Nothing was changed. Reload the page.</p>
            </Notice>
          </CardBody>
        </section>
      </Card>
    );
  }
  const d = dues;
  const provisional = d.basis.kind === 'awaiting_review';
  const canEdit = viewer === 'accounts' && !!actions;
  // viewer comes from deal_dues.viewer (the database's reading mode); the route passes it through.
  return (
    <Card id="dues">
      <section aria-labelledby="dues-heading">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id="dues-heading">Customer dues</CardTitle>
            {/* The provisional words show once, in the notice below. */}
            {provisional ? null : <CardDescription>{basisText(d.basis)}</CardDescription>}
          </div>
          <CalendarClock aria-hidden="true" className="size-4 text-faint" />
        </CardHeader>
        <CardBody className="flex flex-col gap-5">
          {provisional ? (
            <Notice tone="warning" title={PROVISIONAL_TEXT}>
              <p>These dues follow the booking as Sales sent it. They can change when Accounts reviews it.</p>
            </Notice>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={DUES_TONE[d.status]} wrap>
              <span className="sr-only">Dues status: </span>
              {DUES_LABEL[d.status]}
              {d.status === 'credit' ? ` ${inr(d.creditPaise)}` : ''}
            </StatusBadge>
            <DuesFlags row={d} hideProvisional hideReported />
          </div>
          {/* Accounts phase 3 (contract 6.6): "Written off ₹X by <Manager> on <date> — reason", and the needs-review flag. */}
          <DuesWriteOffLine writeOff={d.writeOff ?? null} needsReview={!!d.writeOffNeedsReview} />
          <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
            <Fig label="Booking total" value={inr(d.totalPaise)} />
            <Fig label="Received (verified)" value={inr(d.verifiedPaise)} />
            <Fig label="Still to pay" value={inr(d.balancePaise)} strong />
            <Fig label="Next due" value={d.nextDue ? `${inr(d.nextDue.openPaise)} on ${dayText(d.nextDue.date)}` : 'Nothing due'} />
            {BigInt(d.overduePaise) > 0n ? <Fig label="Overdue" value={inr(d.overduePaise)} danger /> : null}
            {BigInt(d.dueNowPaise) > 0n ? <Fig label="Due today" value={inr(d.dueNowPaise)} /> : null}
            {BigInt(d.reportedPaise) > 0n ? <Fig label={REPORTED_TEXT} value={inr(d.reportedPaise)} /> : null}
            {BigInt(d.awaitingVerificationPaise) > 0n ? <Fig label="Recorded, waiting to be verified" value={inr(d.awaitingVerificationPaise)} /> : null}
            {/* Accounts phase 2 (contract 7.2 deal_dues.refunds; Addendum L6). */}
            {d.refunds?.shortfallPaise && BigInt(d.refunds.shortfallPaise) > 0n ? <Fig label="Customer owes after a reversed payment" value={inr(d.refunds.shortfallPaise)} danger /> : null}
            {d.refunds && BigInt(d.refunds.paidPaise) > 0n ? <Fig label="Refunded to the customer" value={inr(d.refunds.paidPaise)} /> : null}
            {d.refunds && BigInt(d.refunds.keptAsCreditPaise) > 0n ? <Fig label="Kept as customer credit (not used yet)" value={inr(d.refunds.keptAsCreditPaise)} /> : null}
            {d.refunds?.live ? <Fig label={`Refund ${d.refunds.live.refNo} in progress`} value={inr(d.refunds.live.amountPaise)} /> : null}
          </dl>

          <section aria-labelledby="dues-plan" className="flex flex-col gap-2">
            <h3 id="dues-plan" className="m-0 text-base font-semibold text-ink">
              Payment plan
            </h3>
            {d.instalments.length === 0 ? (
              <p className="m-0 text-copy">{d.status === 'unallocated' ? 'Money was received, but this booking has no payment plan to set it against.' : 'This booking has no payment plan. The whole total is due.'}</p>
            ) : (
              <Table label="Payment plan instalments" stackOnMobile wrapperClassName="rounded-control border border-line">
                <TableHeader>
                  <TableRow>
                    <TableHead>Instalment</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead numeric>Amount</TableHead>
                    <TableHead numeric>Covered</TableHead>
                    <TableHead numeric>Open</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.instalments.map((i) => (
                    <TableRow key={i.seq}>
                      <TableCell label="Instalment">{i.label}</TableCell>
                      <TableCell label="Due">
                        <span className="whitespace-nowrap">{dayText(i.dueDate)}</span>
                      </TableCell>
                      <TableCell label="Amount" numeric>
                        {inr(i.amountPaise)}
                      </TableCell>
                      <TableCell label="Covered" numeric>
                        {inr(i.coveredPaise)}
                      </TableCell>
                      <TableCell label="Open" numeric>
                        {inr(i.openPaise)}
                      </TableCell>
                      <TableCell label="Status">
                        <StatusBadge tone={INSTALMENT_TONE[i.status]} wrap>
                          {INSTALMENT_LABEL[i.status]}
                          {i.partlyPaid ? ' · partly paid' : ''}
                        </StatusBadge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <p className="m-0 flex gap-2 text-sm text-quiet">
              <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-status-info" />
              <span>Verified money covers the oldest instalment first. Supplier payments never change customer dues.</span>
            </p>
          </section>

          <section aria-labelledby="dues-gst" className="flex flex-col gap-2">
            <h3 id="dues-gst" className="m-0 text-base font-semibold text-ink">
              Tally GST invoice references
            </h3>
            {d.tallyInvoices.filter((t) => t.status === 'active').length === 0 ? (
              <p className="m-0 text-copy">No GST invoice reference recorded yet. Accounts add it after raising the invoice in Tally.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {d.tallyInvoices.filter((t) => t.status === 'active').map((t) => (
                  <li key={t.id} className="m-0 flex flex-wrap items-center gap-2 rounded-control border border-line bg-canvas px-3 py-2">
                    <span className="font-semibold wrap-anywhere text-ink">{t.invoiceRef}</span>
                    <span className="text-sm text-quiet">{dayText(t.invoiceDate)}</span>
                    <StatusBadge tone={TALLY_TONE[t.tallyStatus]} wrap>
                      <span className="sr-only">Tally: </span>
                      {TALLY_LABEL[t.tallyStatus]}
                    </StatusBadge>
                    {canEdit ? (
                      <span className="ml-auto">
                        <WithdrawTallyInvoice id={t.id} dealId={d.dealId} invoiceRef={t.invoiceRef} rowVersion={t.rowVersion} action={actions!.withdrawTallyInvoice} />
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {canEdit && d.canAddTallyInvoice ? <AddTallyInvoice dealId={d.dealId} action={actions!.addTallyInvoice} initialOpen={preview?.addOpen} initialState={preview?.addState} /> : null}
          </section>

          {d.supplierPayables && viewer !== 'sales' ? (
            <section aria-labelledby="dues-payables" className="flex flex-col gap-2">
              <h3 id="dues-payables" className="m-0 text-base font-semibold text-ink">
                Supplier side
              </h3>
              {d.supplierPayables.length === 0 ? (
                <p className="m-0 text-copy">No supplier payments or bills on this deal yet.</p>
              ) : (
                <Table label="Supplier payments and bills" stackOnMobile wrapperClassName="rounded-control border border-line">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Supplier</TableHead>
                      <TableHead numeric>Requested, not paid</TableHead>
                      <TableHead numeric>Paid</TableHead>
                      <TableHead numeric>Paid and verified</TableHead>
                      <TableHead numeric>Bills accepted</TableHead>
                      <TableHead numeric>Credit notes accepted</TableHead>
                      <TableHead numeric>Bills uploaded</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {d.supplierPayables.map((s) => (
                      <TableRow key={s.supplierId}>
                        <TableCell label="Supplier">{s.supplierName}</TableCell>
                        <TableCell label="Requested, not paid" numeric>
                          {inr(s.requestedLivePaise)}
                        </TableCell>
                        <TableCell label="Paid" numeric>
                          {inr(s.paidPaise)}
                        </TableCell>
                        <TableCell label="Paid and verified" numeric>
                          {inr(s.verifiedPaise)}
                        </TableCell>
                        <TableCell label="Bills accepted" numeric>
                          {inr(s.invoicedAcceptedPaise)}
                        </TableCell>
                        <TableCell label="Credit notes accepted" numeric>
                          {inr(s.creditNotesAcceptedPaise)}
                        </TableCell>
                        <TableCell label="Bills uploaded" numeric>
                          {inr(s.invoicesUploadedPaise)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              <p className="m-0 text-sm text-quiet">Paid and billed are shown side by side. TDS and bank charges are not worked out here.</p>
            </section>
          ) : null}
        </CardBody>
      </section>
    </Card>
  );
}

function Fig({ label, value, strong, danger }: { label: string; value: string; strong?: boolean; danger?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-sm text-quiet">{label}</dt>
      <dd className={`m-0 tabular-nums ${danger ? 'font-semibold text-status-danger' : strong ? 'text-lg font-semibold text-ink' : 'text-ink'}`}>{value}</dd>
    </div>
  );
}
