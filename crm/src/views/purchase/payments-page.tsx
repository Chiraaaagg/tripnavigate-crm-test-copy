import { HandCoins } from 'lucide-react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Tabs } from '@/components/ui/tabs';
import type { PurchasePaymentRequestView } from '@/modules/supplier-money/contracts';
import { TaskBackLink } from '../department/task-frame';
import { PaymentRequestItem } from './work-tab';

/*
 * Purchase "Payment requests" (prototype #/app/purchase/payments): the
 * viewer's own supplier payment requests, styled like the Accounts
 * "Reported payments" list. Tabs filter the rows already returned. No
 * company funding amount or reason and no payment proof is ever shown.
 */

export type PaymentsShow = 'open' | 'returned' | 'paid' | 'all';

export const PAYMENTS_SHOW_LABEL: Record<PaymentsShow, string> = { open: 'Open', returned: 'Returned', paid: 'Paid', all: 'All' };

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

const EMPTY: Record<PaymentsShow, string> = {
  open: 'No payment request is waiting. Ask for one from a task’s Work tab.',
  returned: 'Nothing was returned to you.',
  paid: 'No payment is recorded yet.',
  all: 'You have not asked for a supplier payment yet. Ask for one from a task’s Work tab.',
};

export function PurchasePaymentsPage({ rows, show, failed = false }: { rows: PurchasePaymentRequestView[]; show: PaymentsShow; failed?: boolean }) {
  const shown = filterPayments(rows, show);
  const shows: PaymentsShow[] = ['open', 'returned', 'paid', 'all'];
  return (
    <div className="font-sans text-base text-copy">
      <TaskBackLink href="/app/purchase">Back to Purchase tasks</TaskBackLink>
      <PageHeader
        eyebrow="Purchase"
        title="Payment requests"
        description="Your supplier payment requests. Accounts approves up to ₹50,000 for a supplier on a Deal; above that, the branch Manager. Approval is not payment: Accounts pays and records it."
      />
      <Tabs
        label="Payment request filters"
        className="mb-4"
        items={shows.map((s) => ({ href: s === 'open' ? '/app/purchase/payments' : `/app/purchase/payments?show=${s}`, label: PAYMENTS_SHOW_LABEL[s], current: s === show, count: filterPayments(rows, s).length }))}
      />
      <Card className="p-4">
        {failed ? (
          <p role="status" className="m-0 text-copy">
            Payment requests could not be loaded just now. Reload the page to try again.
          </p>
        ) : shown.length === 0 ? (
          <div role="status">
            <EmptyState icon={HandCoins} headingLevel={2} title="Nothing here" description={EMPTY[show]} />
          </div>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label={`${PAYMENTS_SHOW_LABEL[show]} payment requests`}>
            {shown.map((r) => (
              <PaymentRequestItem
                key={r.id}
                r={r}
                showService
                footer={
                  <p className="m-0 mt-1.5 text-sm">
                    <Link href={`/app/purchase/${r.taskId}?tab=work`} className={cn('rounded-chip font-semibold text-brand-strong underline-offset-4 hover:underline', focusRing)}>
                      {r.canResubmit ? 'Open the task to change and send again' : 'Open the task'}
                      <span className="sr-only"> ({r.refNo})</span>
                    </Link>
                  </p>
                }
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
