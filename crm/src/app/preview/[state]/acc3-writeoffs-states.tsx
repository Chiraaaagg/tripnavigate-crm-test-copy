import type { ReactNode } from 'react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Tabs } from '@/components/ui/tabs';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { DuesWriteOffLine, WriteOffMonthlyView } from '@/views/write-offs/monthly';
import type { WriteOffActions, WriteOffPreviewOpen } from '@/views/write-offs/row-actions';
import { SmallBalancesLoading, SmallBalancesNoAccess, SmallBalancesView, WriteOffApprovalsTab } from '@/views/write-offs/small-balances';
import { WRITE_OFF_REFUSAL } from '@/views/write-offs/labels';
import type { SmallBalanceFilter, SmallBalancePage } from '@/views/write-offs/types';
import { INBOX, INBOX_ACCOUNTS } from './acc-fixtures';
import { accNoticeNoop } from './acc-preview-actions';
import { ACCOUNTS_PAGE, ACCOUNTS_ROWS, DUES_APPROVED, DUES_EXCESS, DUES_PROPOSED, MANAGER_PAGE, MONTHLY, TO_APPROVE_PAGE } from './acc3-writeoffs-fixtures';
import * as A from './acc3-writeoffs-preview-actions';

/*
 * Accounts phase 3 preview states (acc3-writeoffs-*), track U: Accounts ›
 * Small balances (Accounts and Manager), the Manager's Approvals › Write-offs
 * tab, monthly totals and the dues line. Synthetic props only; rendered by
 * the design-review gallery only (a 404 outside local preview mode).
 */

const act = (a: unknown) => a as DecisionAction;

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
const purchaseViewer: ShellViewer = { ...accountsViewer, displayName: 'Synthetic Purchase Jodhpur', primaryRole: 'Purchase', canUseAccounts: false, canSeeAccountsDesk: false, canSeePurchaseTasks: true };
const adminViewer: ShellViewer = { ...accountsViewer, displayName: 'Synthetic Owner Jodhpur', primaryRole: 'Super Admin', canUseAccounts: false, canSeeAccountsDesk: false, canAdministerStaff: true, canManageGrants: true };

const NOOP = accNoticeNoop as never;
function shell(viewer: ShellViewer, path: string, body: ReactNode) {
  return (
    <StaffShell viewer={viewer} currentPath={path} notices={{ api: { inbox: NOOP, history: NOOP, mark: NOOP, markAllRead: NOOP, setSound: NOOP }, realtime: null, preview: { inbox: viewer === accountsViewer ? INBOX_ACCOUNTS : INBOX } }}>
      {body}
    </StaffShell>
  );
}

const ACCOUNTS_ACTIONS: WriteOffActions = { propose: act(A.woProposeOk), withdraw: act(A.woReasonOk) };
const MANAGER_ACTIONS: WriteOffActions = { decide: act(A.woDecideOk), undo: act(A.woReasonOk) };
const ACC = { kind: 'accounts' as const, entityName: 'Holiday Chacha Pvt LTD' };
const MGR = { kind: 'manager' as const, branchNames: ['Jodhpur'] };
const LIMIT = '500000';
const P1 = ACCOUNTS_ROWS[0]!.dealId;
const P4 = ACCOUNTS_ROWS[3]!.dealId;
const P5 = ACCOUNTS_ROWS[4]!.dealId;

function accounts(page: SmallBalancePage | 'error', over: { filter?: SmallBalanceFilter; actions?: WriteOffActions; on?: boolean; preview?: WriteOffPreviewOpen; after?: string } = {}) {
  return shell(
    accountsViewer,
    '/app/accounts/small-balances',
    <SmallBalancesView viewer={ACC} filter={over.filter ?? {}} page={page} actions={over.actions ?? ACCOUNTS_ACTIONS} writeOffsOn={over.on ?? true} limitPaise={LIMIT} preview={over.preview} after={over.after} />,
  );
}
function manager(page: SmallBalancePage | 'error', over: { filter?: SmallBalanceFilter; actions?: WriteOffActions; preview?: WriteOffPreviewOpen } = {}) {
  return shell(managerViewer, '/app/accounts/small-balances', <SmallBalancesView viewer={MGR} filter={over.filter ?? {}} page={page} actions={over.actions ?? MANAGER_ACTIONS} writeOffsOn limitPaise={LIMIT} preview={over.preview} />);
}
function approvals(page: SmallBalancePage | 'error', over: { actions?: WriteOffActions; preview?: WriteOffPreviewOpen } = {}) {
  return shell(
    managerViewer,
    '/app/approvals',
    <div className="flex flex-col gap-5">
      <PageHeader title="Approvals" description="Jodhpur · requests waiting for a branch Manager" />
      <Tabs
        label="Approval types"
        items={[
          { href: '/app/approvals?tab=costs', label: 'Costs above budget', count: 1 },
          { href: '/app/approvals?tab=refunds', label: 'Refunds', count: 0 },
          { href: '/app/approvals?tab=write-offs', label: 'Write-offs', current: true, count: page === 'error' ? undefined : page.items.length },
        ]}
      />
      <WriteOffApprovalsTab page={page} actions={over.actions ?? MANAGER_ACTIONS} preview={over.preview} />
    </div>,
  );
}
function duesCard(viewer: ShellViewer, body: ReactNode) {
  return shell(
    viewer,
    '/app/deals',
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Deal · SYN-JOD-305" title="Synthetic family trip to Jaisalmer" />
      <Card>
        <CardHeader>
          <CardTitle>Dues</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <p className="m-0">
            Total ₹1,85,000.00 · Received ₹1,84,700.00 · <strong className="text-ink">Balance ₹0.00</strong>
          </p>
          {body}
        </CardBody>
      </Card>
    </div>,
  );
}

const refusal = (code: keyof typeof WRITE_OFF_REFUSAL) => ({ ok: false as const, code, message: WRITE_OFF_REFUSAL[code] });

const states: Record<string, () => ReactNode> = {
  /* Accounts › Small balances */
  'acc3-writeoffs-list': () => accounts(ACCOUNTS_PAGE),
  'acc3-writeoffs-list-to-propose': () => accounts({ items: ACCOUNTS_ROWS.slice(0, 3), nextAfter: null, hasMore: false }, { filter: { preset: 'to_propose' } }),
  'acc3-writeoffs-list-needs-review': () => accounts({ items: [ACCOUNTS_ROWS[5]!], nextAfter: null, hasMore: false }, { filter: { preset: 'needs_review' } }),
  'acc3-writeoffs-list-next-page': () => accounts({ items: ACCOUNTS_ROWS.slice(4), nextAfter: null, hasMore: false }, { after: '2026-09-30|x' }),
  'acc3-writeoffs-list-empty': () => accounts({ items: [], nextAfter: null, hasMore: false }),
  'acc3-writeoffs-list-preset-empty': () => accounts({ items: [], nextAfter: null, hasMore: false }, { filter: { preset: 'to_approve' } }),
  'acc3-writeoffs-list-off': () => accounts({ items: ACCOUNTS_ROWS.slice(0, 2).map((r) => ({ ...r, blockedBy: ['write_off_off'] })), nextAfter: null, hasMore: false }, { on: false }),
  'acc3-writeoffs-list-error': () => accounts('error'),
  'acc3-writeoffs-list-loading': () => shell(accountsViewer, '/app/accounts/small-balances', <SmallBalancesLoading />),
  'acc3-writeoffs-no-access': () => shell(purchaseViewer, '/app/accounts/small-balances', <SmallBalancesNoAccess />),
  'acc3-writeoffs-propose-open': () => accounts(ACCOUNTS_PAGE, { preview: { dealId: P1, dialog: 'propose' } }),
  'acc3-writeoffs-propose-not-balance': () => accounts(ACCOUNTS_PAGE, { actions: { ...ACCOUNTS_ACTIONS, propose: act(A.woProposeNotBalance) }, preview: { dealId: P1, dialog: 'propose', state: refusal('write_off_not_balance') } }),
  'acc3-writeoffs-propose-over-limit': () => accounts(ACCOUNTS_PAGE, { actions: { ...ACCOUNTS_ACTIONS, propose: act(A.woProposeOverLimit) }, preview: { dealId: P1, dialog: 'propose', state: refusal('write_off_over_limit') } }),
  'acc3-writeoffs-propose-exists': () => accounts(ACCOUNTS_PAGE, { actions: { ...ACCOUNTS_ACTIONS, propose: act(A.woProposeExists) }, preview: { dealId: P1, dialog: 'propose', state: refusal('write_off_open_exists') } }),
  'acc3-writeoffs-propose-off': () => accounts(ACCOUNTS_PAGE, { actions: { ...ACCOUNTS_ACTIONS, propose: act(A.woProposeOff) }, preview: { dealId: P1, dialog: 'propose', state: refusal('write_off_off') } }),
  'acc3-writeoffs-propose-reason-short': () =>
    accounts(ACCOUNTS_PAGE, { actions: { ...ACCOUNTS_ACTIONS, propose: act(A.woProposeShortReason) }, preview: { dealId: P1, dialog: 'propose', state: { ok: false, code: 'invalid_input', message: 'Check the highlighted field.', field: 'reason' } as never } }),
  'acc3-writeoffs-withdraw-open': () => accounts(ACCOUNTS_PAGE, { preview: { dealId: P4, dialog: 'withdraw' } }),

  /* Manager */
  'acc3-writeoffs-manager': () => manager(MANAGER_PAGE),
  'acc3-writeoffs-approve-open': () => manager(MANAGER_PAGE, { preview: { dealId: P4, dialog: 'approve' } }),
  'acc3-writeoffs-approve-self': () => manager(MANAGER_PAGE, { actions: { ...MANAGER_ACTIONS, decide: act(A.woDecideSelf) }, preview: { dealId: P4, dialog: 'approve', state: refusal('not_self_approval') } }),
  'acc3-writeoffs-approve-changed': () => manager(MANAGER_PAGE, { actions: { ...MANAGER_ACTIONS, decide: act(A.woDecideChanged) }, preview: { dealId: P4, dialog: 'approve', state: refusal('version_changed') } }),
  'acc3-writeoffs-return-open': () => manager(MANAGER_PAGE, { preview: { dealId: P4, dialog: 'return' } }),
  'acc3-writeoffs-undo-open': () => manager(MANAGER_PAGE, { preview: { dealId: P5, dialog: 'undo' } }),

  /* Approvals › Write-offs */
  'acc3-writeoffs-approvals': () => approvals(TO_APPROVE_PAGE),
  'acc3-writeoffs-approvals-empty': () => approvals({ items: [], nextAfter: null, hasMore: false }),
  'acc3-writeoffs-approvals-error': () => approvals('error'),

  /* Monthly totals */
  'acc3-writeoffs-monthly': () => shell(managerViewer, '/app/accounts/small-balances', <WriteOffMonthlyView data={MONTHLY} />),
  'acc3-writeoffs-monthly-admin': () => shell(adminViewer, '/app/accounts/small-balances', <WriteOffMonthlyView data={MONTHLY} canSeeList={false} />),
  'acc3-writeoffs-monthly-empty': () => shell(managerViewer, '/app/accounts/small-balances', <WriteOffMonthlyView data={{ month: '2026-10-01', branches: [] }} />),
  'acc3-writeoffs-monthly-error': () => shell(managerViewer, '/app/accounts/small-balances', <WriteOffMonthlyView data="error" />),

  /* Dues line */
  'acc3-writeoffs-dues-line': () => duesCard(salesViewer, <DuesWriteOffLine writeOff={DUES_APPROVED} needsReview={false} />),
  'acc3-writeoffs-dues-line-excess': () => duesCard(managerViewer, <DuesWriteOffLine writeOff={DUES_EXCESS} needsReview={false} />),
  'acc3-writeoffs-dues-line-proposed': () => duesCard(accountsViewer, <DuesWriteOffLine writeOff={DUES_PROPOSED} needsReview={false} />),
  'acc3-writeoffs-dues-line-review': () => duesCard(accountsViewer, <DuesWriteOffLine writeOff={DUES_APPROVED} needsReview />),
};

export const ACC3_WRITEOFF_STATES = Object.keys(states);

export function renderAcc3WriteoffState(state: string): ReactNode | null {
  return states[state]?.() ?? null;
}
