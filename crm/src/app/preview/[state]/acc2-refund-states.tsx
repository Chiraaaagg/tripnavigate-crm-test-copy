import type { ReactNode } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { SectionTabs } from '@/components/ui/section-tabs';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { DealDuesCard } from '@/views/accounts-desk/deal-money';
import { DealRefundsCard } from '@/views/refunds/deal-card';
import { AccountsRefundsPage, ApprovalsRefundsSection, RefundsLoading, RefundsNoAccess, type QueuedRefund } from '@/views/refunds/desk';
import type { RefundActions } from '@/views/refunds/request-block';
import type { DealRefundsView } from '@/views/refunds/types';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import { DEAL_DUES, INBOX, INBOX_ACCOUNTS } from './acc-fixtures';
import { accNoticeNoop } from './acc-preview-actions';
import { DEAL_REFUNDS, LIST_ROW, REQ_APPROVED, REQ_PAID, REQ_REQUESTED, REQ_RETURNED, REQ_WITHDRAWN, SUPPLIER_DUE, SUPPLIER_SOURCES, req } from './acc2-refund-fixtures';
import * as A from './acc2-refund-preview-actions';
import { PreviewTyped } from './preview-typed';

/*
 * Accounts phase 2 preview states (acc2-refund-*), Track E: the Deal page
 * Refunds card (Sales owner, Manager, Accounts), Approvals › Refunds to
 * approve and Accounts › Refunds. Synthetic props only; rendered by the
 * design-review gallery only (a 404 outside local preview mode).
 */

const act = (a: unknown) => a as DecisionAction;
const TODAY = '2026-11-13';

const accountsViewer: ShellViewer = {
  displayName: 'Synthetic Accounts 1',
  primaryRole: 'Accounts',
  primaryBranch: 'Jodhpur',
  canAdministerStaff: false,
  canManageGrants: false,
  canUseAccounts: true,
  canSeeAccountsDesk: true,
};
const managerViewer: ShellViewer = { ...accountsViewer, displayName: 'Synthetic Manager Jodhpur', primaryRole: 'Manager', canUseAccounts: false, canSeeAccountsDesk: false, canSeeBranchMoney: true, canSeeApprovals: true, canSeeLeads: true };
const salesViewer: ShellViewer = { ...accountsViewer, displayName: 'Synthetic Sales Jodhpur', primaryRole: 'Sales', canUseAccounts: false, canSeeAccountsDesk: false, canSeeOwnDues: true, canSeeLeads: true };
const flightViewer: ShellViewer = { ...accountsViewer, displayName: 'Synthetic Flight Jodhpur', primaryRole: 'Flight', canUseAccounts: false, canSeeAccountsDesk: false, canSeeFlightTasks: true };

const NOOP = accNoticeNoop as never;
function shell(viewer: ShellViewer, path: string, body: ReactNode) {
  return (
    <StaffShell viewer={viewer} currentPath={path} notices={{ api: { inbox: NOOP, history: NOOP, mark: NOOP, markAllRead: NOOP, setSound: NOOP }, realtime: null, preview: { inbox: viewer === accountsViewer ? INBOX_ACCOUNTS : INBOX } }}>
      {body}
    </StaffShell>
  );
}

const ACTIONS: RefundActions = {
  request: act(A.rfRequestOk),
  resubmit: act(A.rfOk),
  withdraw: act(A.rfOk),
  decide: act(A.rfOk),
  payOut: act(A.rfOk),
  recordSupplierRefund: act(A.rfOk),
  cancelSupplierRefund: act(A.rfOk),
};

const CAN = { resubmit: false, withdraw: false, approve: false, return: false, payout: false };
const sales = (over: Partial<DealRefundsView> = {}): DealRefundsView => ({ ...DEAL_REFUNDS, ...over });
const manager = (over: Partial<DealRefundsView> = {}): DealRefundsView => ({ ...DEAL_REFUNDS, viewer: 'manager', canRequest: false, supplierRefunds: SUPPLIER_SOURCES, ...over });
const accounts = (over: Partial<DealRefundsView> = {}): DealRefundsView => ({ ...DEAL_REFUNDS, viewer: 'accounts', canRequest: false, supplierRefunds: SUPPLIER_SOURCES, ...over });

function dealPage(viewer: ShellViewer, card: ReactNode) {
  return shell(
    viewer,
    '/app/deals',
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Deal · SYN-JOD-205" title="Synthetic family trip to Goa (cancelled)" />
      {card}
    </div>,
  );
}

/** List rows as refund_requests_list gives them (20261204000370): row version, can and the bound amounts. */
const queue = (rs: typeof REQ_APPROVED[]): QueuedRefund[] =>
  rs.map((r, i) => {
    const acts = r.can.approve || r.can.return || r.can.payout;
    return {
      ...LIST_ROW(r, i === 0 ? 'SYN-JOD-205' : 'SYN-JOD-188', 'Jodhpur', i + 1),
      rowVersion: r.rowVersion,
      can: { approve: r.can.approve, return: r.can.return, payout: r.can.payout },
      expectedAmountPaise: acts ? r.amountPaise : null,
      expectedChargePaise: acts ? r.customerChargePaise : null,
      payeeKind: r.payeeKind,
      payeeName: r.payeeName,
      payeeReason: r.payeeReason,
      payeeReceiptNo: r.payeeKind === 'original_payer' ? 'R-2026-27-000201' : null,
      reason: r.reason,
      useKeptCredit: r.useKeptCredit,
      warnings: r.warnings,
    };
  });

const ACCOUNTS_ENTITY = 'Holiday Chacha Pvt LTD';
const approvals = (body: ReactNode) => shell(managerViewer, '/app/approvals', <><PageHeader eyebrow="Branch Manager" title="Approvals" />{body}</>);


/** Preview only: the refusal state shows what was typed before it (PreviewTyped fills the fields once). */
function typed(values: Record<string, string>, body: ReactNode, firstOnly = false) {
  return (
    <>
      {body}
      <PreviewTyped values={values} firstOnly={firstOnly} />
    </>
  );
}

const states: Record<string, () => ReactNode> = {
  /* Deal page card: Sales owner */
  'acc2-refund-deal-sales': () => dealPage(salesViewer, <DealRefundsCard refunds={sales()} actions={ACTIONS} today={TODAY} />),
  'acc2-refund-deal-sales-form': () => dealPage(salesViewer, <DealRefundsCard refunds={sales()} actions={ACTIONS} today={TODAY} preview={{ requestOpen: true }} />),
  'acc2-refund-deal-sales-kept-credit': () =>
    dealPage(salesViewer, <DealRefundsCard refunds={sales({ keptCreditUnusedPaise: '1000000', approvedChargePaise: '2000000', requests: [{ ...REQ_APPROVED, outcome: 'keep_credit', amountPaise: '1000000', warnings: ['charge_below_costs_kept'] }] })} actions={ACTIONS} today={TODAY} preview={{ requestOpen: true }} />),
  'acc2-refund-deal-sales-refused': () =>
    dealPage(salesViewer, <DealRefundsCard refunds={sales()} actions={{ ...ACTIONS, request: act(A.rfExceeds) }} today={TODAY} preview={{ requestOpen: true, requestState: { ok: false, code: 'refund_exceeds_money', message: 'The refund is more than the verified money held minus the customer charge.', field: 'amountPaise' } as never }} />),
  'acc2-refund-deal-sales-requested': () => dealPage(salesViewer, <DealRefundsCard refunds={sales({ requests: [{ ...REQ_REQUESTED, can: { ...CAN, withdraw: true } }, REQ_WITHDRAWN] })} actions={ACTIONS} today={TODAY} />),
  'acc2-refund-deal-sales-returned': () => dealPage(salesViewer, <DealRefundsCard refunds={sales({ requests: [{ ...REQ_RETURNED, can: { ...CAN, resubmit: true, withdraw: true } }] })} actions={ACTIONS} today={TODAY} />),
  'acc2-refund-deal-sales-resubmit': () =>
    dealPage(salesViewer, <DealRefundsCard refunds={sales({ requests: [{ ...REQ_RETURNED, can: { ...CAN, resubmit: true, withdraw: true } }] })} actions={ACTIONS} today={TODAY} preview={{ open: { requestId: REQ_RETURNED.id, dialog: 'resubmit' } }} />),
  'acc2-refund-deal-sales-paid': () => dealPage(salesViewer, <DealRefundsCard refunds={sales({ heldPaise: '2000000', maxRefundPaise: '0', requests: [{ ...REQ_PAID, payout: { ...REQ_PAID.payout!, reference: null, evidenceId: null } }, REQ_WITHDRAWN] })} actions={ACTIONS} today={TODAY} />),
  'acc2-refund-deal-cancellation-open': () => dealPage(salesViewer, <DealRefundsCard refunds={sales({ cancellation: { id: 'a0003102-0000-4000-8000-000000003102', status: 'sent_to_manager' }, chargesKeptPaise: null, maxRefundPaise: '0' })} actions={ACTIONS} today={TODAY} />),
  'acc2-refund-deal-none': () => dealPage(salesViewer, <DealRefundsCard refunds={sales({ cancellation: null, chargesKeptPaise: null, heldPaise: '21500000', maxRefundPaise: '0' })} actions={ACTIONS} today={TODAY} />),
  'acc2-refund-deal-off': () => dealPage(salesViewer, <DealRefundsCard refunds={sales({ enabled: false })} actions={ACTIONS} today={TODAY} />),
  'acc2-refund-deal-shortfall': () =>
    dealPage(
      salesViewer,
      <>
        <DealDuesCard dues={{ ...DEAL_DUES, viewer: 'sales', supplierPayables: null, refunds: { live: null, paidPaise: '5500000', keptAsCreditPaise: '0', shortfallPaise: '1500000' } }} viewer="sales" />
        <DealRefundsCard refunds={sales({ heldPaise: '-1500000', maxRefundPaise: '0', canRequest: false, requests: [REQ_PAID] })} actions={ACTIONS} today={TODAY} />
      </>,
    ),
  'acc2-refund-deal-error': () => dealPage(salesViewer, <DealRefundsCard refunds="error" actions={null} today={TODAY} />),

  /* Deal page card: Manager and Accounts */
  'acc2-refund-deal-manager': () => dealPage(managerViewer, <DealRefundsCard refunds={manager({ requests: [{ ...REQ_REQUESTED, can: { ...CAN, approve: true, return: true } }] })} actions={ACTIONS} today={TODAY} />),
  'acc2-refund-deal-manager-requests': () =>
    dealPage(managerViewer, <DealRefundsCard refunds={manager({ canRequest: true, requests: [{ ...REQ_REQUESTED, requestedAs: 'manager', requestedByName: 'Synthetic Manager Jodhpur', can: { ...CAN, withdraw: true } }] })} actions={ACTIONS} today={TODAY} />),
  'acc2-refund-deal-accounts': () => dealPage(accountsViewer, <DealRefundsCard refunds={accounts({ requests: [{ ...REQ_APPROVED, can: { ...CAN, payout: true } }] })} actions={ACTIONS} today={TODAY} />),
  'acc2-refund-deal-payout-open': () =>
    dealPage(accountsViewer, <DealRefundsCard refunds={accounts({ requests: [{ ...REQ_APPROVED, can: { ...CAN, payout: true } }] })} actions={ACTIONS} today={TODAY} preview={{ open: { requestId: REQ_APPROVED.id, dialog: 'payout' } }} />),
  'acc2-refund-deal-payout-refused': () =>
    typed({ paidOn: '2026-11-12', reference: 'SYN-UTR-000123' }, dealPage(accountsViewer, <DealRefundsCard refunds={accounts({ requests: [{ ...REQ_APPROVED, can: { ...CAN, payout: true } }] })} actions={{ ...ACTIONS, payOut: act(A.rfEvidence) }} today={TODAY} preview={{ open: { requestId: REQ_APPROVED.id, dialog: 'payout', state: { ok: false, code: 'evidence_missing', message: 'Upload the payment proof first.', field: 'file' } as never } }} />)),
  'acc2-refund-deal-supplier-record': () =>
    dealPage(accountsViewer, <DealRefundsCard refunds={accounts({ requests: [REQ_PAID] })} actions={ACTIONS} today={TODAY} preview={{ supplierOpen: { key: `flight_charge:${SUPPLIER_SOURCES[1]!.sourceId}`, dialog: 'record' } }} />),
  'acc2-refund-deal-flight-none': () => dealPage(flightViewer, <p className="m-0 text-copy">Flight, Purchase and Visa never see customer refunds: the database returns nothing and the card is not shown.</p>),

  /* Approvals › Refunds to approve */
  'acc2-refund-approvals': () => approvals(<ApprovalsRefundsSection queue={queue([{ ...REQ_REQUESTED, can: { ...CAN, approve: true, return: true } }, req(6, { kind: 'overpayment', outcome: 'keep_credit', customerChargePaise: '0', amountPaise: '250000', payeeKind: null, payeeName: null, payeeReceiptId: null, can: { ...CAN, approve: true, return: true }, reason: 'Customer paid the last instalment twice by mistake.' })])} actions={ACTIONS} today={TODAY} />),
  'acc2-refund-approvals-other-payee': () =>
    approvals(<ApprovalsRefundsSection queue={queue([{ ...REQ_REQUESTED, payeeKind: 'other', payeeName: 'Sample Relative', payeeReason: 'The payer has closed that bank account; the customer asked to pay the spouse.', payeeReceiptId: null, warnings: ['charge_below_costs_kept'], can: { ...CAN, approve: true, return: true } }])} actions={ACTIONS} today={TODAY} />),
  'acc2-refund-approvals-approve-open': () =>
    approvals(<ApprovalsRefundsSection queue={queue([{ ...REQ_REQUESTED, can: { ...CAN, approve: true, return: true } }])} actions={ACTIONS} today={TODAY} open={{ requestId: REQ_REQUESTED.id, dialog: 'approve' }} />),
  'acc2-refund-approvals-approve-changed': () =>
    approvals(
      <ApprovalsRefundsSection
        queue={queue([{ ...REQ_REQUESTED, can: { ...CAN, approve: true, return: true } }])}
        actions={{ ...ACTIONS, decide: act(A.rfVersion) }}
        today={TODAY}
        open={{ requestId: REQ_REQUESTED.id, dialog: 'approve', state: { ok: false, code: 'version_changed', message: 'Someone changed this meanwhile. Reload and try again.' } }}
      />,
    ),
  'acc2-refund-approvals-return-open': () => approvals(<ApprovalsRefundsSection queue={queue([{ ...REQ_REQUESTED, can: { ...CAN, approve: true, return: true } }])} actions={ACTIONS} today={TODAY} open={{ requestId: REQ_REQUESTED.id, dialog: 'return' }} />),
  'acc2-refund-approvals-own': () => approvals(<ApprovalsRefundsSection queue={queue([{ ...REQ_REQUESTED, requestedAs: 'manager', requestedByName: 'Synthetic Manager Jodhpur', can: { ...CAN, withdraw: true } }])} actions={ACTIONS} today={TODAY} />),
  'acc2-refund-approvals-detail-missing': () => approvals(<ApprovalsRefundsSection queue={[{ ...LIST_ROW(REQ_REQUESTED), can: { approve: true, return: true, payout: false } }]} actions={ACTIONS} today={TODAY} />),
  'acc2-refund-approvals-empty': () => approvals(<ApprovalsRefundsSection queue={[]} actions={ACTIONS} today={TODAY} />),
  'acc2-refund-approvals-error': () => approvals(<ApprovalsRefundsSection queue="error" actions={ACTIONS} today={TODAY} />),

  /* Accounts › Refunds */
  'acc2-refund-desk': () =>
    shell(
      accountsViewer,
      '/app/accounts/refunds',
      <AccountsRefundsPage
        entityName={ACCOUNTS_ENTITY}
        payouts={queue([{ ...REQ_APPROVED, can: { ...CAN, payout: true } }])}
        supplierDue={SUPPLIER_DUE}
        actions={ACTIONS}
        today={TODAY}
        // UX redesign R4 (D5): the Money in tab strip under the header.
        sectionTabs={<SectionTabs section="money-in" currentHref="/app/accounts/refunds" viewer={accountsViewer} />}
      />,
    ),
  'acc2-refund-desk-self': () =>
    shell(accountsViewer, '/app/accounts/refunds', <AccountsRefundsPage entityName={ACCOUNTS_ENTITY} payouts={queue([{ ...REQ_APPROVED, can: { ...CAN, payout: true } }])} supplierDue={[]} actions={{ ...ACTIONS, payOut: act(A.rfSelf) }} today={TODAY} open={{ requestId: REQ_APPROVED.id, dialog: 'payout', state: { ok: false, code: 'not_self_approval', message: 'You cannot approve or pay out something you asked for or approved.' } }} />),
  'acc2-refund-desk-over-expected': () =>
    shell(
      accountsViewer,
      '/app/accounts/refunds',
      <AccountsRefundsPage
        entityName={ACCOUNTS_ENTITY}
        payouts={[]}
        supplierDue={SUPPLIER_DUE}
        actions={{ ...ACTIONS, recordSupplierRefund: act(A.rfOver) }}
        today={TODAY}
        supplierOpen={{ key: `purchase_charge:${SUPPLIER_DUE[0]!.sourceId}`, dialog: 'record', state: { ok: false, code: 'over_expected', message: 'This is more than the refund expected. Give a reason.', field: 'overExpectedReason' } as never }}
      />,
    ),
  'acc2-refund-desk-cancel-open': () =>
    shell(accountsViewer, '/app/accounts/refunds', <AccountsRefundsPage entityName={ACCOUNTS_ENTITY} payouts={[]} supplierDue={SUPPLIER_DUE} actions={ACTIONS} today={TODAY} supplierOpen={{ key: SUPPLIER_DUE[0]!.receipts[0]!.id, dialog: 'cancel' }} />),
  'acc2-refund-desk-not-yours': () =>
    shell(accountsViewer, '/app/accounts/refunds', <AccountsRefundsPage entityName={ACCOUNTS_ENTITY} payouts={queue([{ ...REQ_APPROVED, can: CAN }])} supplierDue={[]} actions={ACTIONS} today={TODAY} />),
  'acc2-refund-desk-off': () => shell(accountsViewer, '/app/accounts/refunds', <AccountsRefundsPage entityName={ACCOUNTS_ENTITY} payouts={[]} supplierDue={[]} actions={ACTIONS} today={TODAY} enabled={false} />),
  'acc2-refund-desk-empty': () => shell(accountsViewer, '/app/accounts/refunds', <AccountsRefundsPage entityName={ACCOUNTS_ENTITY} payouts={[]} supplierDue={[]} actions={ACTIONS} today={TODAY} />),
  'acc2-refund-desk-error': () => shell(accountsViewer, '/app/accounts/refunds', <AccountsRefundsPage entityName={ACCOUNTS_ENTITY} payouts="error" supplierDue="error" actions={ACTIONS} today={TODAY} />),
  'acc2-refund-desk-loading': () => shell(accountsViewer, '/app/accounts/refunds', <RefundsLoading />),
  'acc2-refund-desk-no-access': () => shell(salesViewer, '/app/accounts/refunds', <RefundsNoAccess />),
};

export const ACC2_REFUND_STATES = Object.keys(states);

export function renderAcc2RefundState(state: string): ReactNode | null {
  return states[state]?.() ?? null;
}
