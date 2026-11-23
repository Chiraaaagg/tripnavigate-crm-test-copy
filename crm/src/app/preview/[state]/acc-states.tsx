import type { ReactNode } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { SectionTabs } from '@/components/ui/section-tabs';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { DealDuesCard } from '@/views/accounts-desk/deal-money';
import { DuesLoading, DuesNoAccess, DuesPageView } from '@/views/accounts-desk/dues';
import { DESK_REFUSAL_TEXT } from '@/views/accounts-desk/labels';
import type { DeskResult } from '@/views/accounts-desk/desk-kit';
import { RecordsLoading, RecordsNoAccess, RecordsWorkspace } from '@/views/accounts-desk/records';
import type { LoadMoreAction } from '@/views/accounts-desk/records-table';
import type { DeskRowActions } from '@/views/accounts-desk/row-actions';
import { AccountsSettingsView } from '@/views/accounts-desk/settings';
import { TallyLoading, TallyNoAccess, TallyPage, type TallyCsvView } from '@/views/accounts-desk/tally';
import type { TallyMethod } from '@/views/accounts-desk/r4-address';
import { TravellerIdProofsCard } from '@/views/b11/id-proofs-list';
import { HomeView, NO_HOME_ROLES } from '@/views/home-view';
import type { NoticeInbox, NoticesConfig } from '@/views/notices/types';
import { BookingChangeBanner } from '@/views/purchase/booking-change-banner';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import { BOOKING_CHANGE, BRANCHES, DAILY, DAILY_NO_OWNER, DEAL_DUES, DEAL_DUES_NO_PLAN, DEAL_DUES_PROVISIONAL, DUES_ROWS, HISTORY, INBOX, INBOX_ACCOUNTS, INBOX_EMPTY, MANAGER_PAGE, PAGE, ROWS, SEARCH_PAGE, SUPPLIERS, TALLY_VIEW, TOTALS } from './acc-fixtures';
import * as A from './acc-preview-actions';

/*
 * Accounts phase preview states (acc-): Documents and money, Dues, Tally,
 * the Deal "Customer dues" card, the notification bell and its states, the
 * Purchase "Booking changed" banner, the Home row, Settings · Accounts and
 * the flight-only ID proof wording. Synthetic props only; rendered by the
 * design-review gallery only (a 404 outside local preview mode).
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
const purchaseViewer: ShellViewer = { ...accountsViewer, displayName: 'Synthetic Purchase Jodhpur', primaryRole: 'Purchase', canUseAccounts: false, canSeeAccountsDesk: false, canSeePurchaseTasks: true, canSeePurchasePayments: true };
const adminViewer: ShellViewer = { ...accountsViewer, displayName: 'Synthetic Owner Jodhpur', primaryRole: 'Super Admin', canUseAccounts: false, canSeeAccountsDesk: false, canManageFinancePolicy: true, canAdministerStaff: true };

const NOOP = A.accNoticeNoop as never;
function notices(inbox: NoticeInbox, preview: Omit<NonNullable<NoticesConfig['preview']>, 'inbox'> = {}): NoticesConfig {
  return { api: { inbox: NOOP, history: NOOP, mark: NOOP, markAllRead: NOOP, setSound: NOOP }, realtime: null, preview: { inbox, history: HISTORY, ...preview } };
}

function shell(viewer: ShellViewer, path: string, body: ReactNode, n?: NoticesConfig) {
  return (
    <StaffShell viewer={viewer} currentPath={path} notices={n ?? notices(viewer === accountsViewer ? INBOX_ACCOUNTS : INBOX)}>
      {body}
    </StaffShell>
  );
}

const ROW_ACTIONS: DeskRowActions = { match: act(A.accMatchOk), exception: act(A.accExceptionOk), reopen: act(A.accReopenOk), linkTask: act(A.accLinkOk) };
const LOAD_MORE = A.accLoadMore as unknown as LoadMoreAction;
const LINK_OPTIONS = { [ROWS[3]!.rowId]: [{ taskId: 'a0000451-0000-4000-8000-000000000451', label: 'SYN-JOD-110 · Hotel 1 · Sample Lake Palace Hotel' }, { taskId: 'a0000452-0000-4000-8000-000000000452', label: 'SYN-JOD-112 · Hotel 2 · Sample Lake Palace Hotel' }] };

function records(over: Partial<Parameters<typeof RecordsWorkspace>[0]> = {}) {
  return (
    <RecordsWorkspace
      viewer={{ kind: 'accounts', entityName: 'Holiday Chacha Pvt LTD' }}
      filter={{}}
      page={PAGE}
      daily={DAILY}
      suppliers={SUPPLIERS}
      branches={BRANCHES}
      actions={ROW_ACTIONS}
      loadMore={LOAD_MORE}
      linkOptions={LINK_OPTIONS}
      {...over}
    />
  );
}

function dealPage(viewer: ShellViewer, card: ReactNode) {
  return shell(
    viewer,
    '/app/deals',
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Deal · SYN-JOD-101" title="Synthetic family trip to Udaipur" />
      {card}
    </div>,
  );
}

/* Tally (R4, D11): the CSV method; the Tally file method's states are in acc3-tally-states.tsx. */
const TALLY_CSV: TallyCsvView = { exportEnabled: TALLY_VIEW.exportEnabled, entities: TALLY_VIEW.entities, branches: TALLY_VIEW.branches, exports: TALLY_VIEW.exports, daily: TALLY_VIEW.daily };
function tally(over: { view?: Partial<TallyCsvView>; method?: TallyMethod | null; action?: unknown; initial?: DeskResult | null } = {}) {
  const view = { ...TALLY_CSV, ...over.view };
  return shell(
    accountsViewer,
    '/app/accounts/tally',
    <TallyPage view={view} method={over.method === undefined ? 'csv' : over.method} fileOn={false} exportAction={act(over.action ?? A.accExportOk)} exportInitialState={over.initial} />,
  );
}

/* Dues (R4, A9): the bare address shows Overdue plus Due today, under the Money in tab strip. */
const MONEY_IN_TABS = (path: string, viewer: ShellViewer) => <SectionTabs section="money-in" currentHref={path} viewer={viewer} />;

const MONEY_ACTIONS = { addTallyInvoice: act(A.accInvoiceAddOk), withdrawTallyInvoice: act(A.accInvoiceWithdrawOk) };

const states: Record<string, () => ReactNode> = {
  /* Documents and money */
  'acc-records': () => shell(accountsViewer, '/app/accounts/records', records()),
  'acc-records-manager': () => shell(managerViewer, '/app/accounts/records', records({ viewer: { kind: 'manager', branchNames: ['Jodhpur'] }, page: MANAGER_PAGE, daily: null, actions: null, branches: [BRANCHES[0]!] })),
  'acc-records-filtered': () => shell(accountsViewer, '/app/accounts/records', records({ filter: { kinds: ['supplier_payment', 'supplier_invoice'], tallyStatus: 'exported', changedSinceExport: true, from: '2026-11-01' }, page: { scope: { mode: 'accounts', readOnly: false }, items: [ROWS[2]!], nextAfter: null, hasMore: false } })),
  'acc-records-search': () => shell(accountsViewer, '/app/accounts/records', records({ filter: { q: 'SYNAB1' }, page: SEARCH_PAGE })),
  'acc-records-search-none': () => shell(accountsViewer, '/app/accounts/records', records({ filter: { q: 'R-2026-27-999999' }, page: { scope: { mode: 'accounts', readOnly: false }, items: [], nextAfter: null, hasMore: false } })),
  'acc-records-filter-none': () => shell(accountsViewer, '/app/accounts/records', records({ filter: { kinds: ['receipt_reversal'], branchId: BRANCHES[1]!.id }, page: { scope: { mode: 'accounts', readOnly: false }, items: [], nextAfter: null, hasMore: false } })),
  'acc-records-empty': () => shell(accountsViewer, '/app/accounts/records', records({ page: { scope: { mode: 'accounts', readOnly: false }, items: [], nextAfter: null, hasMore: false }, daily: DAILY_NO_OWNER })),
  'acc-records-totals': () => shell(accountsViewer, '/app/accounts/records', records({ totals: TOTALS })),
  'acc-records-totals-error': () => shell(accountsViewer, '/app/accounts/records', records({ totals: 'error' })),
  'acc-records-missing-originals': () => shell(accountsViewer, '/app/accounts/records', records({ filter: { kinds: ['original'], originals: 'missing' }, page: { scope: { mode: 'accounts', readOnly: false }, items: [ROWS[1]!, ROWS[4]!], nextAfter: null, hasMore: false } })),
  // R4 (A5): nothing waiting, so the daily check is one closed line.
  'acc-records-daily-clear': () =>
    shell(
      accountsViewer,
      '/app/accounts/records',
      records({
        daily: {
          ...DAILY,
          exceptionsOpen: { count: 0, oldestAt: null },
          changedAfterExport: 0,
          originalsMissing: 0,
          receiptsAwaitingVerificationOverOneWorkingDay: 0,
          paymentsApprovedNotRecordedOverOneWorkingDay: 0,
          urgentNoticesUnopenedOverOneWorkingDay: [],
          documentsToRelease: 0,
          pdfFailed: 0,
          refundPayoutsDueOverOneWorkingDay: 0,
          supplierRefundsDue: 0,
        },
      }),
    ),
  'acc-records-error': () => shell(accountsViewer, '/app/accounts/records', records({ page: 'error', daily: 'error' })),
  'acc-records-loading': () => shell(accountsViewer, '/app/accounts/records', <RecordsLoading />),
  'acc-records-no-access': () => shell(purchaseViewer, '/app/accounts/records', <RecordsNoAccess />),
  'acc-records-more-fails': () => shell(accountsViewer, '/app/accounts/records', records({ loadMore: A.accLoadMoreFail as unknown as LoadMoreAction })),
  'acc-records-match-open': () => shell(accountsViewer, '/app/accounts/records', records({ previewOpen: { rowId: ROWS[2]!.rowId, dialog: 'match' } })),
  'acc-records-match-refused': () =>
    shell(accountsViewer, '/app/accounts/records', records({ previewOpen: { rowId: ROWS[2]!.rowId, dialog: 'match', state: { ok: false, code: 'version_changed', message: DESK_REFUSAL_TEXT.version_changed } } })),
  'acc-records-exception-open': () => shell(accountsViewer, '/app/accounts/records', records({ previewOpen: { rowId: ROWS[0]!.rowId, dialog: 'exception' } })),
  'acc-records-reopen-refused': () =>
    shell(accountsViewer, '/app/accounts/records', records({ previewOpen: { rowId: ROWS[4]!.rowId, dialog: 'reopen', state: { ok: false, code: 'wrong_state', message: DESK_REFUSAL_TEXT.wrong_state } } })),
  'acc-records-link-open': () => shell(accountsViewer, '/app/accounts/records', records({ previewOpen: { rowId: ROWS[3]!.rowId, dialog: 'link' } })),
  'acc-records-link-refused': () =>
    shell(accountsViewer, '/app/accounts/records', records({ previewOpen: { rowId: ROWS[3]!.rowId, dialog: 'link', state: { ok: false, code: 'link_not_allowed', message: DESK_REFUSAL_TEXT.link_not_allowed, field: 'taskId' } as DeskResult } })),

  /* Dues */
  'acc-dues': () => shell(accountsViewer, '/app/accounts/dues', <DuesPageView viewer={{ kind: 'accounts', entityName: 'Holiday Chacha Pvt LTD' }} filter={{}} page={{ scope: { mode: 'accounts', readOnly: false }, items: DUES_ROWS, nextAfter: 'x', hasMore: true }} branches={BRANCHES} owners={[{ id: 'a0000981-0000-4000-8000-000000000981', name: 'Synthetic Sales Jodhpur' }, { id: 'a0000982-0000-4000-8000-000000000982', name: 'Synthetic Sales Delhi A' }]} />),
  'acc-dues-default': () =>
    shell(
      accountsViewer,
      '/app/accounts/dues',
      <DuesPageView viewer={{ kind: 'accounts', entityName: 'Holiday Chacha Pvt LTD' }} filter={{ status: ['overdue', 'due_now'] }} defaulted page={{ scope: { mode: 'accounts', readOnly: false }, items: DUES_ROWS.slice(0, 2), nextAfter: null, hasMore: false }} branches={BRANCHES} sectionTabs={MONEY_IN_TABS('/app/accounts/dues', accountsViewer)} />,
    ),
  'acc-dues-default-none': () =>
    shell(
      managerViewer,
      '/app/accounts/dues',
      <DuesPageView viewer={{ kind: 'manager', branchNames: ['Jodhpur'] }} filter={{ status: ['overdue', 'due_now'] }} defaulted page={{ scope: { mode: 'accounts', readOnly: false }, items: [], nextAfter: null, hasMore: false }} branches={[BRANCHES[0]!]} sectionTabs={MONEY_IN_TABS('/app/accounts/dues', managerViewer)} />,
    ),
  'acc-dues-overdue': () => shell(accountsViewer, '/app/accounts/dues', <DuesPageView viewer={{ kind: 'accounts', entityName: 'Holiday Chacha Pvt LTD' }} filter={{ status: ['overdue', 'due_now'] }} page={{ scope: { mode: 'accounts', readOnly: false }, items: DUES_ROWS.slice(0, 2), nextAfter: null, hasMore: false }} branches={BRANCHES} />),
  'acc-dues-manager': () => shell(managerViewer, '/app/accounts/dues', <DuesPageView viewer={{ kind: 'manager', branchNames: ['Jodhpur'] }} filter={{}} page={{ scope: { mode: 'accounts', readOnly: false }, items: DUES_ROWS.slice(0, 5), nextAfter: null, hasMore: false }} branches={[BRANCHES[0]!]} />),
  'acc-dues-sales': () => shell(salesViewer, '/app/accounts/dues', <DuesPageView viewer={{ kind: 'sales' }} filter={{}} page={{ scope: { mode: 'accounts', readOnly: false }, items: DUES_ROWS.slice(0, 3), nextAfter: null, hasMore: false }} branches={[]} />),
  'acc-dues-empty': () => shell(salesViewer, '/app/accounts/dues', <DuesPageView viewer={{ kind: 'sales' }} filter={{ reported: true }} page={{ scope: { mode: 'accounts', readOnly: false }, items: [], nextAfter: null, hasMore: false }} branches={[]} />),
  'acc-dues-error': () => shell(accountsViewer, '/app/accounts/dues', <DuesPageView viewer={{ kind: 'accounts', entityName: 'Holiday Chacha Pvt LTD' }} filter={{}} page="error" branches={BRANCHES} />),
  'acc-dues-loading': () => shell(accountsViewer, '/app/accounts/dues', <DuesLoading />),
  'acc-dues-no-access': () => shell(purchaseViewer, '/app/accounts/dues', <DuesNoAccess />),

  /* Deal page card */
  'acc-deal-dues-accounts': () => dealPage(accountsViewer, <DealDuesCard dues={DEAL_DUES} viewer="accounts" actions={MONEY_ACTIONS} />),
  'acc-deal-dues-manager': () => dealPage(managerViewer, <DealDuesCard dues={DEAL_DUES} viewer="manager" />),
  'acc-deal-dues-sales': () => dealPage(salesViewer, <DealDuesCard dues={{ ...DEAL_DUES, supplierPayables: null }} viewer="sales" />),
  'acc-deal-dues-provisional': () => dealPage(salesViewer, <DealDuesCard dues={DEAL_DUES_PROVISIONAL} viewer="sales" />),
  'acc-deal-dues-newer-pending': () => dealPage(accountsViewer, <DealDuesCard dues={{ ...DEAL_DUES, basis: { versionNo: 3, kind: 'approved', newerVersionPending: true, provisional: false, lastApprovedAt: '2026-10-28T10:00:00Z' } }} viewer="accounts" actions={MONEY_ACTIONS} />),
  'acc-deal-dues-no-plan': () => dealPage(accountsViewer, <DealDuesCard dues={DEAL_DUES_NO_PLAN} viewer="accounts" actions={MONEY_ACTIONS} />),
  'acc-deal-dues-credit': () => dealPage(accountsViewer, <DealDuesCard dues={{ ...DEAL_DUES, ...DUES_ROWS[4]!, instalments: DEAL_DUES.instalments.map((i) => ({ ...i, coveredPaise: i.amountPaise, openPaise: '0', status: 'paid' as const })) }} viewer="accounts" actions={MONEY_ACTIONS} />),
  'acc-deal-dues-add-open': () => dealPage(accountsViewer, <DealDuesCard dues={DEAL_DUES} viewer="accounts" actions={MONEY_ACTIONS} preview={{ addOpen: true }} />),
  'acc-deal-dues-add-duplicate': () =>
    dealPage(accountsViewer, <DealDuesCard dues={DEAL_DUES} viewer="accounts" actions={{ ...MONEY_ACTIONS, addTallyInvoice: act(A.accInvoiceAddDuplicate) }} preview={{ addOpen: true, addState: { ok: false, code: 'duplicate_tally_invoice', message: DESK_REFUSAL_TEXT.duplicate_tally_invoice, field: 'invoiceRef' } as DeskResult }} />),
  'acc-deal-dues-error': () => dealPage(accountsViewer, <DealDuesCard dues="error" viewer="accounts" />),

  /* Tally */
  'acc-tally': () => tally(),
  'acc-tally-result': () =>
    tally({ initial: { ok: true, message: 'Export TE-2026-000012: 340 rows (12 exported before).', data: { exportId: 'a0000853-0000-4000-8000-000000000853', exportNo: 'TE-2026-000012', rowCount: 340, alreadyExportedCount: 12, skippedCount: 0 } } as DeskResult }),
  'acc-tally-too-large': () => tally({ action: A.accExportTooLarge, initial: { ok: false, code: 'export_too_large', message: DESK_REFUSAL_TEXT.export_too_large } }),
  'acc-tally-nothing': () => tally({ view: { exports: [], daily: { ...DAILY, exceptionsOpen: { count: 0, oldestAt: null } } }, action: A.accExportNothing }),
  // Both methods switched off: says so; the earlier CSV exports stay in the closed fold.
  'acc-tally-off': () => tally({ view: { exportEnabled: false, daily: { ...DAILY, exceptionOwner: { userId: null, name: null, isYou: false, set: false } } }, method: null }),
  'acc-tally-off-no-daily': () => tally({ view: { exportEnabled: false, daily: null }, method: null }),
  'acc-tally-loading': () => shell(accountsViewer, '/app/accounts/tally', <TallyLoading />),
  'acc-tally-no-access': () => shell(managerViewer, '/app/accounts/tally', <TallyNoAccess />),

  /* Bell */
  'acc-bell': () => shell(purchaseViewer, '/app/purchase', <PageHeader title="Purchase tasks" description="The bell sits in the menu column (desktop) and the top bar (phone)." />),
  'acc-bell-open': () => shell(purchaseViewer, '/app/purchase', <PageHeader title="Purchase tasks" />, notices(INBOX, { open: true })),
  'acc-bell-accounts-open': () => shell(accountsViewer, '/app/accounts', <PageHeader title="To check" />, notices(INBOX_ACCOUNTS, { open: true })),
  'acc-bell-empty': () => shell(purchaseViewer, '/app/purchase', <PageHeader title="Purchase tasks" />, notices(INBOX_EMPTY, { open: true })),
  'acc-bell-out-of-date': () => shell(purchaseViewer, '/app/purchase', <PageHeader title="Purchase tasks" />, notices(INBOX, { open: true, outOfDate: true })),
  'acc-bell-history': () => shell(purchaseViewer, '/app/purchase', <PageHeader title="Purchase tasks" />, notices(INBOX, { open: true, view: 'history' })),
  'acc-bell-sound': () => shell(purchaseViewer, '/app/purchase', <PageHeader title="Purchase tasks" />, notices(INBOX, { open: true, view: 'settings' })),
  'acc-bell-audio-locked': () => shell(accountsViewer, '/app/accounts', <PageHeader title="To check" />, notices(INBOX_ACCOUNTS, { open: true, audioLocked: true })),
  'acc-bell-off': () => shell(purchaseViewer, '/app/purchase', <PageHeader title="Purchase tasks" description="Notices switched off: no bell." />, notices({ ...INBOX, enabled: false })),

  /* Purchase banner */
  'acc-purchase-changed': () => shell(purchaseViewer, '/app/purchase', <><BookingChangeBanner change={BOOKING_CHANGE} action={act(A.accAckOk)} /><PageHeader eyebrow="Purchase task · SYN-JOD-110" title="Hotel · Sample Lake Palace Hotel" /></>),
  'acc-purchase-changed-stale': () => shell(purchaseViewer, '/app/purchase', <><BookingChangeBanner change={BOOKING_CHANGE} action={act(A.accAckStale)} initialState={{ ok: false, code: 'version_changed', message: DESK_REFUSAL_TEXT.version_changed }} /><PageHeader eyebrow="Purchase task · SYN-JOD-110" title="Hotel · Sample Lake Palace Hotel" /></>),
  'acc-purchase-changed-manager': () => shell(managerViewer, '/app/purchase', <><BookingChangeBanner change={{ ...BOOKING_CHANGE, canAck: false }} action={null} /><PageHeader eyebrow="Purchase task · SYN-JOD-110" title="Hotel · Sample Lake Palace Hotel" /></>),
  'acc-home-purchase': () =>
    shell(
      purchaseViewer,
      '/app',
      <HomeView
        displayName="Synthetic Purchase Jodhpur"
        counts={{ visible: 12, owned: 0, assigned: 4 }}
        roles={{ ...NO_HOME_ROLES, purchase: true }}
        myWork={{ waitingForMe: 3, returnedToMe: 0, missingDetails: 0, intakeNeeded: 0, receiptsToVerify: null, requestsToApprove: null, claimsToProcess: null, expensesToReview: null, visaTasksWaiting: null }}
        purchaseChanges={{ purchaseBookingChanged: 2, purchaseBookingChangedTaskId: BOOKING_CHANGE.taskId }}
      />,
    ),

  /* Settings */
  'acc-settings': () =>
    shell(
      adminViewer,
      '/app/admin/accounts',
      <>
        <PageHeader title="Accounts settings" description="Staff notices, Tally export and the Tally exception owner." />
        <AccountsSettingsView
          model={{
            noticesEnabled: false,
            canSetNotices: true,
            entities: [{ entityId: 'a0000001-0000-4000-8000-000000000001', entityName: 'Holiday Chacha Pvt LTD', tallyExportEnabled: null, exceptionOwnerUserId: null, accountsPeople: [{ userId: 'a0000990-0000-4000-8000-000000000990', name: 'Synthetic Accounts 2' }, { userId: 'a0000991-0000-4000-8000-000000000991', name: 'Synthetic Accounts 1' }] }],
          }}
          actions={{ setNotices: act(A.accSettingOk), setTallyExport: act(A.accSettingOk), setExceptionOwner: act(A.accSettingRefused) }}
        />
      </>,
    ),

  /* Phase 0: task ID proofs on a flight-only booking */
  'acc-id-proofs-flight-only': () =>
    shell(
      { ...purchaseViewer, displayName: 'Synthetic Flight Jodhpur', primaryRole: 'Flight', canSeePurchaseTasks: false, canSeeFlightTasks: true },
      '/app/flight',
      <TravellerIdProofsCard state={{ taskId: 'task-1', idProofRequired: false, travellers: [{ seq: 1, fullName: 'Sample Traveller A', type: 'adult', idProofs: [] }, { seq: 2, fullName: 'Sample Traveller B', type: 'adult', idProofs: [] }] }} />,
    ),
};

export const ACC_PREVIEW_STATES = Object.keys(states);

export function renderAccState(state: string): ReactNode | null {
  return states[state]?.() ?? null;
}
