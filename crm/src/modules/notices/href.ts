import type { NoticeDepartment, NoticeItemDTO } from './contracts';

/**
 * Link kind -> existing route (contract 9.1 "Link" column). Pure. The target
 * page applies its own access rules again; a notice never carries more than
 * the id the route needs. Returns null when the notice has no openable
 * target (the bell then shows the text without "Open").
 */

const TASK_ROUTE: Record<NoticeDepartment, string> = {
  purchase: '/app/purchase',
  flight: '/app/flight',
  visa: '/app/visa',
};

function dealRef(item: { dealReference: string | null }): string {
  return item.dealReference ? `?dealReference=${encodeURIComponent(item.dealReference)}` : '';
}

export function noticeHref(
  item: Pick<NoticeItemDTO, 'link' | 'department' | 'dealReference'> & Partial<Pick<NoticeItemDTO, 'kind' | 'dealId'>>,
): string | null {
  const link = item.link;
  if (!link) return null;
  const id = encodeURIComponent(link.id);
  switch (link.kind) {
    case 'task':
      return item.department ? `${TASK_ROUTE[item.department]}/${id}` : null;
    case 'deal':
      return `/app/deals/${id}`;
    case 'accounts_deal':
      return `/app/accounts/deals/${id}`;
    case 'claim':
      return '/app/accounts/claims';
    case 'supplier_payment':
      return '/app/accounts/supplier-payments';
    case 'funding':
      return '/app/accounts/funding';
    case 'approvals':
      return '/app/approvals';
    case 'go_ahead':
      return '/app/accounts/go-ahead';
    case 'flight_deal':
      return `/app/flight/deals/${id}`;
    case 'workspace_row':
      return item.dealReference ? `/app/accounts/records?q=${encodeURIComponent(item.dealReference)}` : '/app/accounts/records';
    // Accounts phase 2 (8.6). Refund requests: the Manager's Approvals tab, the Accounts payout queue, else the
    // Deal page refund card (UX redesign R2: on the Money tab).
    case 'refund':
      if (item.kind === 'refund_to_approve') return '/app/approvals?tab=refunds';
      if (item.kind === 'refund_payout_due') return '/app/accounts/refunds';
      return item.dealId ? `/app/deals/${encodeURIComponent(item.dealId)}?tab=money#refunds` : null;
    case 'customer_document':
      return `/app/accounts/documents${dealRef(item)}`;
    case 'supplier_refund':
      return '/app/accounts/refunds';
    case 'cancellation':
      if (item.kind === 'cancellation_to_approve') return '/app/approvals';
      return item.dealId ? `/app/deals/${encodeURIComponent(item.dealId)}` : null;
    // Accounts phase 3 (8.6): 40 the Deal documents card (Documents tab since UX redesign R2), 43 / 44 the
    // Deal messages card (Messages tab since R2), 41 / 42 small balances, 46 Settings > Customer messages
    // (timer state). The older ?tab=services#... addresses still land on a "Moved to their own tabs" link.
    case 'deal_documents':
      return `/app/deals/${id}?tab=documents#customer-documents`;
    case 'deal_messages':
      return `/app/deals/${id}?tab=messages#customer-messages`;
    case 'small_balances':
      return item.kind === 'write_off_to_approve' ? '/app/accounts/small-balances?preset=to_approve' : '/app/accounts/small-balances';
    case 'timer':
      // UX redesign R1: the timer is on the Set-up sub-tab of Customer messages.
      return '/app/admin/customer-messages?tab=setup';
    // Accounts phase 3, Release B (12): 51 / 54 (and 3 for Accounts) the Deal's changes card (Services tab);
    // 59 / 60 the rate contract.
    case 'deal_changes':
      return `/app/deals/${id}?tab=services#changes`;
    case 'rate_contract':
      return `/app/purchase/rate-contracts/${id}`;
  }
}
