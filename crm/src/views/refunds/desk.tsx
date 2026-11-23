import { CircleCheck, Undo2 } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { CountBadge, StatusBadge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { BlockedButton, DialogAction, ReasonField } from '@/views/accounts-desk/acc2-kit';
import { inr, whenText } from '@/views/accounts-desk/labels';
import { PayoutFields } from './fields';
import { OUTCOME_WORD, REFUND_KIND_WORD, STATUS_TONE, statusWord } from './labels';
import type { RefundActions, RefundPreviewOpen } from './request-block';
import { SupplierRefundsList, type SupplierRefundLine } from './supplier-refunds';
import type { RefundListRow, SupplierRefundDueRow } from './types';

/*
 * Approvals › Refunds to approve (screen 11.4, R-C2 preset to_approve) and
 * Accounts › Refunds (screen 11.5: R-C2 preset payout_due and R-C3 supplier
 * refunds due). Each queued request is shown from its list row alone
 * (20261204000370: row version, `can` and the exact amounts a decision or
 * payout binds). The payee and the reason are on the Deal page; each row
 * links there ("Open the full request").
 */

/** A queued request: one R-C2 row (payee and reasons for Accounts and the branch Manager only, 20261204000390). */
export type QueuedRefund = RefundListRow;

function payeeText(row: QueuedRefund): string | null {
  if (row.outcome !== 'payout' || !row.payeeName) return null;
  return `${row.payeeName}${row.payeeKind === 'original_payer' ? ` (the person who paid${row.payeeReceiptNo ? `, ${row.payeeReceiptNo}` : ''})` : row.payeeKind === 'other' ? ' (someone else)' : ''}`;
}

function QueueItem({ row, actions, today, open, mode }: { row: QueuedRefund; actions: Partial<RefundActions> | null; today: string; open?: RefundPreviewOpen; mode: 'approve' | 'payout' }) {
  const can = row.can ?? { approve: false, return: false, payout: false };
  const payee = payeeText(row);
  const whoWhy = (
    <>
      {payee ? ` Pay to: ${payee}.` : ''}
      {row.payeeKind === 'other' && row.payeeReason ? ` Why someone else: ${row.payeeReason}.` : ''}
      {row.reason ? ` Reason: ${row.reason}` : ''}
    </>
  );
  const bound = row.rowVersion !== undefined && row.expectedAmountPaise != null && row.expectedChargePaise != null;
  const missing = bound ? null : 'Open the Deal page to act on it: this row did not carry its amounts.';
  const base = { refundRequestId: row.id, expectedRowVersion: row.rowVersion, dealId: row.dealId };
  const amount = row.expectedAmountPaise ?? row.amountPaise;
  const charge = row.expectedChargePaise ?? row.customerChargePaise;
  const o = (d: RefundPreviewOpen['dialog']) => (open?.requestId === row.id && open.dialog === d ? open : undefined);
  // Accounts work on the Accounts deal page (Deals of every branch), on its Refunds tab (R4: ?tab=money opens Receipts);
  // the Manager on the Deal page.
  const dealHref = mode === 'payout' ? `/app/accounts/deals/${row.dealId}?tab=refunds#refunds` : `/app/deals/${row.dealId}?tab=money#refunds`;
  return (
    <li className="m-0">
      <article aria-labelledby={`rq-${row.id}`} className="flex flex-col gap-3 rounded-control border border-line bg-canvas p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={`rq-${row.id}`} className="m-0 text-base font-semibold text-ink">
            Refund {row.refNo}
            {' · '}
            <Link href={dealHref} className="text-brand-strong underline-offset-4 hover:underline">
              {row.dealReference}
            </Link>
          </h3>
          <StatusBadge tone={STATUS_TONE[row.status]} wrap>
            <span className="sr-only">Status: </span>
            {statusWord(row.status, row.outcome)}
          </StatusBadge>
        </div>
        <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
          <Fig label="For" value={REFUND_KIND_WORD[row.kind]} />
          <Fig label="Outcome" value={OUTCOME_WORD[row.outcome]} />
          {row.kind === 'cancellation' ? <Fig label="Customer charge" value={inr(row.customerChargePaise)} num /> : null}
          {row.outcome !== 'charge_only' ? <Fig label={row.outcome === 'keep_credit' ? 'Kept as credit' : 'To pay back'} value={inr(row.amountPaise)} num strong /> : null}
          {payee ? <Fig label="Pay to" value={payee} /> : null}
        </dl>
        {row.payeeKind === 'other' && row.payeeReason ? (
          <p className="m-0 text-sm text-copy">
            <span className="font-semibold text-ink">Why someone else: </span>
            {row.payeeReason}
          </p>
        ) : null}
        {row.useKeptCredit ? <p className="m-0 text-sm text-copy">Paid from the customer credit kept earlier on this Deal.</p> : null}
        {(row.warnings ?? []).includes('charge_below_costs_kept') ? (
          <p className="m-0 text-sm font-medium text-ink">
            <span className="font-semibold">Check: </span>The customer charge is below what suppliers and airlines kept.
          </p>
        ) : null}
        {row.reason ? (
          <p className="m-0 text-sm text-copy">
            <span className="font-semibold text-ink">Reason: </span>
            {row.reason}
          </p>
        ) : null}
        <p className="m-0 text-sm text-quiet">
          Asked {whenText(row.requestedAt)}
          {row.requestedByName ? ` by ${row.requestedByName}` : ''} · {row.branchName} · waiting {row.ageWorkingDays} working {row.ageWorkingDays === 1 ? 'day' : 'days'}
        </p>
        <div className="flex flex-wrap items-start gap-2">
          {can.approve ? (
            <DialogAction
              buttonLabel={row.outcome === 'charge_only' ? `Approve charge ${inr(charge)}` : `Approve ${inr(amount)} ${row.outcome === 'keep_credit' ? 'credit' : 'refund'}${row.kind === 'cancellation' ? ` (charge ${inr(charge)})` : ''}`}
              buttonVariant="primary"
              blockedReason={missing}
              title={`Approve refund ${row.refNo}?`}
              description={
                <>
                  You approve exactly: {row.outcome === 'charge_only' ? `charge ${inr(charge)}` : `${inr(amount)}${row.kind === 'cancellation' ? ` (charge ${inr(charge)})` : ''}`}, {OUTCOME_WORD[row.outcome].toLowerCase()}.{whoWhy}
                  {payee || row.reason ? '' : ' Check who gets the money and why on the Deal page first.'} If the amounts change meanwhile, nothing is approved.
                </>
              }
              primaryLabel="Approve"
              pendingLabel="Approving…"
              action={actions?.decide}
              fields={{ ...base, decision: 'approve', expectedAmountPaise: amount, expectedChargePaise: charge }}
              okTitle="Approved"
              initialOpen={!!o('approve')}
              initialState={o('approve')?.state}
            />
          ) : null}
          {can.return ? (
            <DialogAction
              buttonLabel="Return with reason"
              ariaLabel={`Return with reason refund ${row.refNo}`}
              blockedReason={missing}
              title={`Return refund ${row.refNo} to the requester?`}
              description="The requester can change it and send it again, or withdraw it."
              primaryLabel="Return it"
              pendingLabel="Returning…"
              action={actions?.decide}
              fields={{ ...base, decision: 'return', expectedAmountPaise: amount, expectedChargePaise: charge }}
              okTitle="Returned"
              initialOpen={!!o('return')}
              initialState={o('return')?.state}
            >
              <ReasonField id={`return-${row.id}`} label="What needs to change" />
            </DialogAction>
          ) : null}
          {can.payout ? (
            <DialogAction
              buttonLabel={`Pay out and verify ${row.refNo}`}
              buttonVariant="primary"
              blockedReason={missing}
              title={`Pay out and verify ${row.refNo}`}
              description={`Record the ${inr(amount)} paid to ${payee ?? 'the payee named on the Deal page'}. You record and verify it in one step; the journal entry is posted at once. You cannot pay out a refund you asked for or approved.`}
              primaryLabel={`Pay out and verify ${inr(amount)}`}
              pendingLabel="Recording…"
              action={actions?.payOut}
              fields={base}
              okTitle="Paid out"
              initialOpen={!!o('payout')}
              initialState={o('payout')?.state}
            >
              <PayoutFields today={today} approvedOn={null} />
            </DialogAction>
          ) : null}
          {mode === 'approve' && !can.approve && !can.return && row.status === 'requested' ? (
            <BlockedButton label="Approve" reason="You asked for this refund; another Manager approves it." variant="primary" ariaLabel={`Approve refund ${row.refNo}`} />
          ) : null}
          {mode === 'payout' && !can.payout && row.status === 'approved' ? (
            <BlockedButton label={`Pay out and verify ${row.refNo}`} reason="You asked for or approved this refund; another Accounts person pays it out." variant="primary" />
          ) : null}
          <Link href={dealHref} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            Open the full request<span className="sr-only"> {row.refNo} on {row.dealReference}</span>
          </Link>
        </div>
      </article>
    </li>
  );
}

function Fig({ label, value, num, strong }: { label: string; value: string; num?: boolean; strong?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-sm text-quiet">{label}</dt>
      <dd className={`m-0 wrap-anywhere ${num ? 'tabular-nums' : ''} ${strong ? 'font-semibold text-ink' : 'text-ink'}`}>{value}</dd>
    </div>
  );
}

function Section({ id, title, description, count, children }: { id: string; title: string; description: string; count: number; children: ReactNode }) {
  return (
    <Card>
      <section aria-labelledby={id}>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id={id}>
              {title} <CountBadge aria-label={`${count} waiting`}>{count}</CountBadge>
            </CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
        </CardHeader>
        <CardBody>{children}</CardBody>
      </section>
    </Card>
  );
}

/** Manager · Approvals › "Refunds to approve" section. */
export function ApprovalsRefundsSection({ queue, actions, today, open }: { queue: QueuedRefund[] | 'error'; actions: Partial<RefundActions> | null; today: string; open?: RefundPreviewOpen }) {
  const count = queue === 'error' ? 0 : queue.length;
  return (
    <Section id="ap-refunds" title="Refunds to approve" description="Customer refunds asked for by Sales. Approving binds the exact refund and charge shown; Accounts then pay it out." count={count}>
      {queue === 'error' ? (
        <Notice tone="warning" role="status">
          <p>The refunds waiting for you did not load. Nothing was changed. Reload the page.</p>
        </Notice>
      ) : queue.length === 0 ? (
        <p className="m-0 text-quiet">Nothing waiting.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-4 p-0" aria-label="Refunds to approve">
          {queue.map((q) => (
            <QueueItem key={q.id} row={q} actions={actions} today={today} open={open} mode="approve" />
          ))}
        </ul>
      )}
    </Section>
  );
}

function toLines(rows: SupplierRefundDueRow[]): SupplierRefundLine[] {
  return rows.map((s) => ({
    key: `${s.sourceKind}:${s.sourceId}`,
    cancellationId: s.cancellationId,
    changeRequestId: s.changeRequestId,
    changeRefNo: s.changeRefNo,
    dealId: s.dealId,
    dealReference: s.dealReference,
    branchName: s.branchName,
    sourceKind: s.sourceKind,
    sourceId: s.sourceId,
    supplierName: s.supplierName,
    expectedPaise: s.expectedPaise,
    receivedPaise: s.receivedPaise,
    canRecord: BigInt(s.outstandingPaise) > 0n,
    receipts: s.receipts.map((r) => ({ ...r, canCancel: r.status === 'verified' })),
  }));
}

/** Accounts › Refunds. */
export function AccountsRefundsPage({
  entityName,
  payouts,
  supplierDue,
  actions,
  today,
  enabled = true,
  supplierNextHref,
  open,
  supplierOpen,
  sectionTabs,
}: {
  /** UX redesign R4 (D5): the Money in tab strip, rendered under the header. */
  sectionTabs?: ReactNode;
  entityName: string;
  payouts: QueuedRefund[] | 'error';
  supplierDue: SupplierRefundDueRow[] | 'error';
  actions: Partial<RefundActions> | null;
  today: string;
  /** refunds_enabled for the company (false: every command refuses "refunds_off"). */
  enabled?: boolean;
  supplierNextHref?: string | null;
  open?: RefundPreviewOpen;
  supplierOpen?: { key: string; dialog: 'record' | 'cancel'; state?: import('@/views/accounts-desk/desk-kit').DeskResult | null };
}) {
  const payoutCount = payouts === 'error' ? 0 : payouts.length;
  const supplierCount = supplierDue === 'error' ? 0 : supplierDue.length;
  return (
    <div className="flex flex-col gap-5 font-sans">
      <PageHeader
        eyebrow="Accounts"
        title="Refunds"
        description={`Customer refunds approved by a Manager and waiting for payout, and refunds expected from suppliers, airlines and visa fees for ${entityName}.`}
      />
      {sectionTabs}
      {!enabled ? (
        <Notice tone="info" title="Refunds are not switched on yet">
          <p>Nothing can be paid out or recorded here until a Super Admin switches refunds on in Settings · Accounts.</p>
        </Notice>
      ) : null}
      {payouts !== 'error' && supplierDue !== 'error' && payoutCount === 0 && supplierCount === 0 ? (
        <Card role="status">
          <EmptyState icon={CircleCheck} headingLevel={2} title="Nothing to pay out or record" description="Approved customer refunds and expected supplier refunds appear here." />
        </Card>
      ) : (
        <>
          <Section id="rf-payouts" title="Customer refunds to pay out" description="Pay out and verify in one step with the proof. You cannot pay out a refund you asked for or approved." count={payoutCount}>
            {payouts === 'error' ? (
              <Notice tone="warning" role="status">
                <p>The payout queue did not load. Nothing was changed. Reload the page.</p>
              </Notice>
            ) : payouts.length === 0 ? (
              <p className="m-0 text-quiet">Nothing waiting for payout.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-4 p-0" aria-label="Customer refunds to pay out">
                {payouts.map((q) => (
                  <QueueItem key={q.id} row={q} actions={actions} today={today} open={open} mode="payout" />
                ))}
              </ul>
            )}
          </Section>
          <Section id="rf-supplier" title="Refunds expected from suppliers" description="On approved trip cancellations. Record what reached our account; it never changes customer dues." count={supplierCount}>
            {supplierDue === 'error' ? (
              <Notice tone="warning" role="status">
                <p>The supplier refunds did not load. Nothing was changed. Reload the page.</p>
              </Notice>
            ) : supplierDue.length === 0 ? (
              <p className="m-0 text-quiet">No supplier refund is expected.</p>
            ) : (
              <>
                <SupplierRefundsList
                  lines={toLines(supplierDue)}
                  actions={actions?.recordSupplierRefund && actions.cancelSupplierRefund ? { record: actions.recordSupplierRefund, cancel: actions.cancelSupplierRefund } : null}
                  today={today}
                  showDeal
                  enabled={enabled}
                  open={supplierOpen}
                />
                {supplierNextHref ? (
                  <Link href={supplierNextHref} className={buttonVariants({ variant: 'secondary' }) + ' mt-3'}>
                    Next page
                  </Link>
                ) : null}
              </>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

export function RefundsLoading() {
  return (
    <div className="flex flex-col gap-4 font-sans">
      <h1 className="sr-only">Refunds</h1>
      <p role="status" aria-live="polite" className="m-0 text-sm font-medium text-quiet">
        Loading refunds…
      </p>
      <div aria-busy="true" className="flex flex-col gap-3">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    </div>
  );
}

export function RefundsNoAccess() {
  return (
    <div className="font-sans">
      <PageHeader title="Refunds" />
      <Card>
        <CardBody className="flex items-start gap-3">
          <Undo2 aria-hidden="true" className="mt-0.5 size-4 text-faint" />
          <p className="m-0">Refund payouts are for Accounts. Managers approve refunds on the Approvals page; Sales ask for them on the Deal page.</p>
        </CardBody>
      </Card>
    </div>
  );
}
