import { HandCoins, SearchX } from 'lucide-react';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { PageHeader } from '@/components/ui/page-header';
import { QueueToolbar } from '@/components/ui/queue-toolbar';
import { StateBlock } from '@/components/ui/state-block';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { dayText } from '@/lib/format';
import { formatPaise } from '@/modules/deals/dto';
import { HOLD_REASON_TEXT, PAYMENT_PART_LABEL, type PurchasePaymentRequestView } from '@/modules/supplier-money/contracts';
import { matchesSearch, parseQueueSearch } from '../department/queue-show';
import { QueueShowTabs } from '../department/task-frame';
import { PaymentStatusBadge } from './work-tab';

/*
 * Purchase "Payment requests" (prototype #/app/purchase/payments; R3 C1,
 * DM-19): a tab beside the Purchase task lists. The viewer's own supplier
 * payment requests in the queue pattern (design plan 1.2): Open · Returned ·
 * Paid · All as chips (the `?show=` values of before), one search field and a
 * sort, one row per request. Everything works on the rows already returned.
 * No company funding amount or reason and no payment proof is ever shown.
 */

export type PaymentsShow = 'open' | 'returned' | 'paid' | 'all';

export const PAYMENTS_SHOW_LABEL: Record<PaymentsShow, string> = { open: 'Open', returned: 'Returned', paid: 'Paid', all: 'All' };
const SHOWS: PaymentsShow[] = ['open', 'returned', 'paid', 'all'];

export function parsePaymentsShow(raw: string | string[] | undefined): PaymentsShow {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === 'returned' || v === 'paid' || v === 'all' ? v : 'open';
}

export function filterPayments(rows: PurchasePaymentRequestView[], show: PaymentsShow): PurchasePaymentRequestView[] {
  if (show === 'open') return rows.filter((r) => r.status === 'pending' || r.status === 'approved');
  if (show === 'returned') return rows.filter((r) => r.status === 'returned');
  if (show === 'paid') return rows.filter((r) => r.status === 'paid' || r.status === 'verified');
  return rows;
}

export type PaymentsSort = 'due' | 'newest';
export const PAYMENTS_SORT_OPTIONS: { value: PaymentsSort; label: string }[] = [
  { value: 'due', label: 'Due soonest first' },
  { value: 'newest', label: 'Newest request first' },
];

export interface PaymentsQuery {
  q: string;
  sort: PaymentsSort;
}

/** Server allowlist for `?q=&sort=` (unknown values fall back, never an error). */
export function parsePaymentsQuery(raw: { q?: string | string[]; sort?: string | string[] }): PaymentsQuery {
  const sort = Array.isArray(raw.sort) ? raw.sort[0] : raw.sort;
  return { q: parseQueueSearch(raw.q), sort: sort === 'newest' ? 'newest' : 'due' };
}

/** Search (reference, supplier, service, part, Deal) and sort over the rows of one chip. Rows without a due date go last. */
export function paymentsRows(rows: PurchasePaymentRequestView[], query: PaymentsQuery): PurchasePaymentRequestView[] {
  const found = rows.filter((r) => matchesSearch(query.q, [r.refNo, r.supplierName, r.serviceTitle, r.dealReference, PAYMENT_PART_LABEL[r.part]]));
  return found
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      if (query.sort === 'newest') return b.r.requestedAt.localeCompare(a.r.requestedAt) || a.i - b.i;
      const x = a.r.dueDate;
      const y = b.r.dueDate;
      if (x !== y) {
        if (!x) return 1;
        if (!y) return -1;
        return x < y ? -1 : 1;
      }
      return a.r.requestedAt.localeCompare(b.r.requestedAt) || a.i - b.i;
    })
    .map((x) => x.r);
}

/** What happens next on one request, in plain words, and the row's one button. */
export function paymentNext(r: PurchasePaymentRequestView): { text: string; button: { label: string; href: string } } {
  const href = `/app/purchase/${r.taskId}?tab=work`;
  const open = { label: 'Open the task', href };
  if (r.status === 'returned' && r.canResubmit) return { text: 'Change it and send it again, or leave it.', button: { label: 'Change and send again', href } };
  if (r.status === 'returned') return { text: r.resubmittedAs ? `Sent again as ${r.resubmittedAs}.` : 'Nothing more to do.', button: open };
  if (r.status === 'pending') return { text: r.route === 'manager' ? 'The branch Manager approves or returns it.' : 'Accounts approves or returns it.', button: open };
  if (r.status === 'approved') return { text: r.onHold ? 'On hold until the Manager approves the supplier’s latest bank details.' : 'Accounts pays the supplier.', button: open };
  if (r.status === 'paid') return { text: 'Another Accounts person checks the payment.', button: open };
  return { text: 'Nothing waiting.', button: open };
}

const EMPTY: Record<PaymentsShow, string> = {
  open: 'No payment request is waiting. Ask for one from a task’s Work tab.',
  returned: 'Nothing was returned to you.',
  paid: 'No payment is recorded yet.',
  all: 'You have not asked for a supplier payment yet. Ask for one from a task’s Work tab.',
};

const BASE = '/app/purchase/payments';
const rowLink = cn('rounded-chip font-semibold text-brand-strong underline-offset-4 hover:text-brand-deep hover:underline', focusRing);
const rowButtonClass = cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'max-sm:w-full');

/** The one plain fact beside the status badge (never a second badge). */
function secondFact(r: PurchasePaymentRequestView): string | null {
  if (r.paidOn) return `Paid on ${dayText(r.paidOn)}${r.bankReference ? ` · reference ${r.bankReference}` : ''}`;
  if (r.status === 'returned') return `Returned${r.decidedByName ? ` by ${r.decidedByName}` : ''}${r.decidedAt ? ` on ${dayText(r.decidedAt)}` : ''}`;
  // Review F1: only the bank-details hold reaches Purchase; funding is never mentioned.
  if (r.onHold && r.holdReason === 'bank_details_on_hold') return HOLD_REASON_TEXT.bank_details_on_hold;
  return null;
}

function paymentsHref(params: Record<string, string | null>): string {
  const qs = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();
  return qs ? `${BASE}?${qs}` : BASE;
}

export function PurchasePaymentsPage({
  rows,
  show,
  failed = false,
  query = { q: '', sort: 'due' },
}: {
  rows: PurchasePaymentRequestView[];
  show: PaymentsShow;
  failed?: boolean;
  /** R3: `?q=&sort=` (parsePaymentsQuery). Omitted = no search, due soonest first. */
  query?: PaymentsQuery;
}) {
  const showParam = show === 'open' ? null : show;
  const sortParam = query.sort === 'due' ? null : query.sort;
  const searchedFor = (s: PaymentsShow) => paymentsRows(filterPayments(rows, s), query);
  const shown = searchedFor(show);
  const chipTotal = filterPayments(rows, show).length;
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader
        eyebrow="Purchase"
        title="Payment requests"
        description="Your supplier payment requests. Accounts approves up to ₹50,000 for a supplier on a Deal; above that, the branch Manager. Approval is not payment: Accounts pays and records it."
      />
      {/* DM-19: the same tab strip as Purchase tasks, with Payment requests open. This page reads no tasks, so no tab carries a count. */}
      <QueueShowTabs basePath="/app/purchase" show={null} canTakeTasks label="Purchase task filters" variant="pill" extra={[{ href: BASE, label: 'Payment requests', current: true }]} />
      {failed ? (
        <StateBlock kind="error" title="Payment requests could not be loaded just now" text="Reload the page to try again. Nothing was changed." />
      ) : (
        <>
          {rows.length > 0 ? (
            <QueueToolbar
              action={BASE}
              label="Search and filter payment requests"
              chipsLabel="Filter by state"
              keep={showParam ? { show: showParam } : undefined}
              search={{ name: 'q', value: query.q, placeholder: 'Request, supplier, service or Deal', label: 'Search payment requests' }}
              chips={SHOWS.map((s) => ({
                href: paymentsHref({ show: s === 'open' ? null : s, q: query.q || null, sort: sortParam }),
                label: PAYMENTS_SHOW_LABEL[s],
                count: searchedFor(s).length,
                current: s === show,
              }))}
              sort={{ name: 'sort', value: query.sort, options: PAYMENTS_SORT_OPTIONS }}
            />
          ) : null}
          {shown.length === 0 && query.q && chipTotal > 0 ? (
            <div role="status">
              <StateBlock
                kind="empty"
                icon={SearchX}
                headingLevel={2}
                title="Nothing matches"
                text="No payment request here matches the search. Clear it to see them all."
                action={
                  <Link href={paymentsHref({ show: showParam })} className={buttonVariants({ variant: 'secondary' })}>
                    Clear search
                  </Link>
                }
              />
            </div>
          ) : shown.length === 0 ? (
            <div role="status">
              <StateBlock kind="empty" icon={HandCoins} headingLevel={2} title="Nothing here" text={EMPTY[show]} />
            </div>
          ) : (
            <Card>
              <Table stackOnMobile label="Payment requests table" wrapperClassName="rounded-card">
                <TableCaption className="caption-top border-b border-line py-3 font-medium text-copy max-sm:block">
                  {shown.length} {shown.length === 1 ? 'request' : 'requests'}
                  {query.q ? <span className="font-normal text-quiet"> of {chipTotal}</span> : null}
                </TableCaption>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="px-3">Request</TableHead>
                    <TableHead className="px-3">Due by</TableHead>
                    <TableHead className="px-3" numeric>
                      Amount
                    </TableHead>
                    <TableHead className="min-w-40 px-3">Status</TableHead>
                    <TableHead className="px-3">Next step</TableHead>
                    <TableHead className="px-3">Deal</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((r) => {
                    const fact = secondFact(r);
                    const next = paymentNext(r);
                    return (
                      <TableRow key={r.id} className="align-top">
                        <TableCell label="Request" className="px-3 align-top">
                          <span className="flex flex-col items-start gap-0.5 max-sm:items-end">
                            <Link href={`/app/purchase/${r.taskId}?tab=work`} className={rowLink}>
                              <span className="whitespace-nowrap">{r.refNo}</span>
                              <span className="sr-only"> — open the task</span>
                            </Link>
                            <span className="text-sm text-copy">{r.supplierName}</span>
                            <span className="text-sm text-quiet">
                              {r.serviceTitle} · {PAYMENT_PART_LABEL[r.part]}
                            </span>
                          </span>
                        </TableCell>
                        <TableCell label="Due by" className="px-3 align-top">
                          <span className="block whitespace-nowrap">{r.dueDate ? dayText(r.dueDate) : 'No due date'}</span>
                          <span className="block text-sm whitespace-nowrap text-quiet">Asked {dayText(r.requestedAt)}</span>
                        </TableCell>
                        <TableCell label="Amount" numeric className="px-3 align-top whitespace-nowrap">
                          {formatPaise(r.amountPaise)}
                        </TableCell>
                        <TableCell label="Status" className="min-w-40 px-3 align-top">
                          <span className="flex flex-col items-start gap-1 max-sm:items-end">
                            <PaymentStatusBadge r={r} />
                            {fact ? <span className="text-sm text-copy">{fact}</span> : null}
                          </span>
                        </TableCell>
                        <TableCell label="Next step" className="px-3 align-top">
                          <span className="flex flex-col items-start gap-2 max-sm:items-end">
                            <span className="text-sm text-copy">{next.text}</span>
                            {r.status === 'returned' && r.returnReason ? (
                              <span className="text-sm wrap-break-word whitespace-pre-wrap text-quiet">Reason: {r.returnReason}</span>
                            ) : null}
                            <Link href={next.button.href} className={rowButtonClass}>
                              {next.button.label}
                              <span className="sr-only"> ({r.refNo})</span>
                            </Link>
                          </span>
                        </TableCell>
                        <TableCell label="Deal" className="px-3 align-top text-sm whitespace-nowrap">
                          {r.dealReference}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
