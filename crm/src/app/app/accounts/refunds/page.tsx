import type { Metadata } from 'next';
import { requireStaff } from '@/modules/identity/server/session';
import {
  cancelSupplierRefundAction,
  decideRefundAction,
  payOutRefundAction,
  recordSupplierRefundAction,
  requestRefundAction,
  resubmitRefundAction,
  withdrawRefundAction,
} from '@/modules/refunds/server/actions';
import { loadRefundRequests, loadSupplierRefundsDue } from '@/modules/refunds/server/queries';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { todayInIndia } from '@/views/accounts/supplier-kit';
import { AccountsRefundsPage, RefundsNoAccess, type QueuedRefund } from '@/views/refunds/desk';
import type { RefundActions } from '@/views/refunds/request-block';
import { deskViewerOf } from '../records/desk-glue';

export const metadata: Metadata = { title: 'Refunds' };

const ACTIONS: RefundActions = {
  request: requestRefundAction as unknown as DecisionAction,
  resubmit: resubmitRefundAction as unknown as DecisionAction,
  withdraw: withdrawRefundAction as unknown as DecisionAction,
  decide: decideRefundAction as unknown as DecisionAction,
  payOut: payOutRefundAction as unknown as DecisionAction,
  recordSupplierRefund: recordSupplierRefundAction as unknown as DecisionAction,
  cancelSupplierRefund: cancelSupplierRefundAction as unknown as DecisionAction,
};

/**
 * Accounts › Refunds (Accounts phase 2 contract 7.5 R-C2 preset payout_due,
 * R-C3; screen 11.5). Accounts only: refund_requests_list and
 * supplier_refunds_due return null for everyone else. Each queued refund is
 * shown from its list row (row version, can, the exact amount bound); the
 * payout command re-checks every rule.
 */
export default async function AccountsRefundsRoute({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff();
  if (!staff.memberships.some((m) => m.roleCode === 'accounts')) return <RefundsNoAccess />;
  const sp = await searchParams;
  const rawAfter = typeof sp.supplierAfter === 'string' && sp.supplierAfter.length <= 120 ? sp.supplierAfter : null;
  const [payoutRes, supplierRes] = await Promise.all([
    loadRefundRequests(staff, { preset: 'payout_due' }, null).catch(() => ({ ok: false as const, invalid: null })),
    loadSupplierRefundsDue(staff, { state: 'open' }, rawAfter).catch(() => ({ ok: false as const, invalid: null })),
  ]);
  if (payoutRes.ok && payoutRes.data === null && supplierRes.ok && supplierRes.data === null) return <RefundsNoAccess />;
  const payouts: QueuedRefund[] | 'error' = payoutRes.ok && payoutRes.data ? payoutRes.data.items : 'error';
  const supplierDue = supplierRes.ok && supplierRes.data ? supplierRes.data.items : 'error';
  const supplierNext = supplierRes.ok && supplierRes.data?.nextAfter ? `/app/accounts/refunds?supplierAfter=${encodeURIComponent(supplierRes.data.nextAfter)}` : null;
  const viewer = deskViewerOf(staff, 'accounts');
  return (
    <AccountsRefundsPage
      entityName={viewer.kind === 'accounts' ? viewer.entityName : 'your company'}
      payouts={payouts}
      supplierDue={supplierDue}
      actions={ACTIONS}
      today={todayInIndia()}
      supplierNextHref={supplierNext}
    />
  );
}
