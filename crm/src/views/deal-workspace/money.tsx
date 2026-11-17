import { Info } from 'lucide-react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { NotEntered, SummaryList, SummaryRow } from '@/components/ui/summary-list';
import type { DealMoneyVM } from '@/modules/deals/workspace-contract';
import { ClaimStatusPill } from '../b11/book-claims';
import { dateText, RECEIPT_MODE_TEXT } from '../b11/book-fields';

/*
 * Money tab (DE-02, FP-020, FP-026; money-privacy P6). Rendered only when the
 * route built a DealMoneyVM (price readers) and the Money tab is open. Shows
 * exactly today's Sales figures, already formatted on the server: deal value,
 * final selling total, payment plan, the reported-payments summary and the
 * viewer's own reported payments. No receipt list, cheque amounts or states,
 * company accounts or other Accounts figures (Accounts work stays on the
 * Accounts deal page). Look: sean0205 29356 summary list idea (register §10).
 */

/** An amount is one unit: it never breaks across lines. */
function Amount({ value }: { value: string }) {
  return <span className="font-semibold whitespace-nowrap tabular-nums">{value}</span>;
}

function SubHeading({ id, children }: { id: string; children: string }) {
  return (
    <h3 id={id} className="m-0 text-base font-semibold text-ink">
      {children}
    </h3>
  );
}

export function DealMoneyTab({ money }: { money: DealMoneyVM }) {
  const { dealValue, booking, claims, versionTotals } = money;
  return (
    <Card>
      <section aria-labelledby="deal-money-heading">
        <CardHeader>
          <CardTitle id="deal-money-heading">Money</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-6">
          {/* DA-118: deal_commercials holds test rows only, so the block shows only when a value is recorded. */}
          {dealValue.state === 'shown' ? (
            <section aria-labelledby="money-deal-value" className="flex flex-col gap-2">
              <SubHeading id="money-deal-value">Deal value (test record only)</SubHeading>
              <SummaryList>
                <SummaryRow label="Deal value" numeric>
                  <Amount value={dealValue.sellingTotal} />
                </SummaryRow>
                <SummaryRow label="Estimated margin" numeric>
                  <Amount value={dealValue.estimatedMargin} />
                </SummaryRow>
              </SummaryList>
              <p className="m-0 flex gap-2 text-sm text-quiet">
                <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-status-info" />
                <span>Test figures. No tax is calculated here.</span>
              </p>
            </section>
          ) : null}

          {/* DA-121 */}
          {dealValue.state !== 'shown' && !booking && !claims && !(versionTotals && versionTotals.length > 0) ? (
            <p className="m-0 text-copy">No money recorded on this deal yet. The selling total shows here once the booking has a price.</p>
          ) : null}

          {booking ? (
            <section aria-labelledby="money-booking" className="flex flex-col gap-2">
              <SubHeading id="money-booking">Booking</SubHeading>
              <SummaryList>
                <SummaryRow label="Final selling total" numeric>
                  {booking.finalSellingTotal ? <Amount value={booking.finalSellingTotal} /> : <NotEntered />}
                </SummaryRow>
                <SummaryRow label="Payment plan">
                  {booking.plan === null || booking.plan.length === 0 ? (
                    <NotEntered />
                  ) : (
                    <ul className="m-0 flex list-none flex-col gap-1 p-0">
                      {booking.plan.map((part, i) => (
                        <li key={`${part.label}-${i}`} className="m-0 flex flex-wrap justify-between gap-x-3">
                          <span>
                            {part.label}
                            <span className="text-sm text-quiet"> · {part.dueDate ? `due ${dateText(part.dueDate)}` : 'due date not entered'}</span>
                          </span>
                          <Amount value={part.amount} />
                        </li>
                      ))}
                    </ul>
                  )}
                </SummaryRow>
              </SummaryList>
            </section>
          ) : null}

          {claims ? (
            <section aria-labelledby="money-claims" className="flex flex-col gap-2">
              <SubHeading id="money-claims">Payments the customer told you about</SubHeading>
              <SummaryList>
                <SummaryRow label="Reported, not checked (not money)" numeric>
                  <Amount value={claims.reported} />
                </SummaryRow>
                <SummaryRow label="Checked by Accounts" numeric>
                  <Amount value={claims.confirmed} />
                </SummaryRow>
                <SummaryRow label="Still to pay (based on checked money)" numeric total>
                  {claims.balance ? <Amount value={claims.balance} /> : <NotEntered>Not known until the total is entered</NotEntered>}
                </SummaryRow>
              </SummaryList>
              <h4 className="m-0 mt-2.5 text-sm font-semibold text-ink">Reported payments on this deal</h4>
              {claims.own.length === 0 ? (
                <p className="m-0 text-quiet">No payment reported on this deal yet.</p>
              ) : (
                <ul className="m-0 flex list-none flex-col divide-y divide-line p-0" aria-label="Reported payments on this deal">
                  {claims.own.map((c) => (
                    <li key={c.claimId} className="m-0 flex flex-wrap items-center justify-between gap-2 py-2">
                      <span>
                        <Amount value={c.amount} />
                        <span className="text-sm text-quiet">
                          {' '}
                          · {RECEIPT_MODE_TEXT[c.mode]} · paid {dateText(c.paidOn) ?? c.paidOn}
                        </span>
                      </span>
                      <ClaimStatusPill status={c.status} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}

          {versionTotals && versionTotals.length > 0 ? (
            <section aria-labelledby="money-versions" className="flex flex-col gap-2">
              <SubHeading id="money-versions">Selling total by booking version</SubHeading>
              <SummaryList>
                {versionTotals.map((v) => (
                  <SummaryRow key={v.versionNo} label={`Version ${v.versionNo}`} numeric>
                    {v.sellingTotal ? <Amount value={v.sellingTotal} /> : <NotEntered />}
                    {v.sellingTotalDelta ? <span className="block text-sm text-quiet">Change: {v.sellingTotalDelta}</span> : null}
                  </SummaryRow>
                ))}
              </SummaryList>
            </section>
          ) : null}

          <p className="m-0 text-sm text-quiet">Receipts and cheques are handled by Accounts and are not listed here.</p>
        </CardBody>
      </section>
    </Card>
  );
}
