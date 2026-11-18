import type { ReactNode } from 'react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { Acc3DailyCheckItems, type Acc3DailyCheckExtra } from '@/views/accounts-desk/acc3-daily-check';
import { Acc3AccountsSettings, type Acc3AccountsSettingsActions, type Acc3AccountsSettingsEntity, type Acc3RowKey } from '@/views/accounts-desk/acc3-settings';
import type { ActionRowPreview } from '@/views/settings/setting-switch-form';
import { DealCustomerDocumentsCard, type DocActions } from '@/views/customer-documents/deal-card';
import { DocumentsListView, DocumentsNoAccess } from '@/views/customer-documents/list';
import type { DealDocs, DocsFilter, DocListPage } from '@/views/customer-documents/types';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import { INBOX, INBOX_ACCOUNTS } from './acc-fixtures';
import { accNoticeNoop } from './acc-preview-actions';
import {
  DAILY_EXTRA,
  DAILY_EXTRA_LATE,
  DAILY_EXTRA_QUIET,
  DEAL_AUTO,
  DEAL_AUTO_MANY,
  DEAL_AUTO_READY,
  DEAL_AUTO_READY_RELEASE_ON,
  DEAL_ID,
  LIST_AUTO_ROWS,
  MANAGER_AUTO,
  SALES_AUTO,
  SETTINGS_DOCS_OFF,
  SETTINGS_ENTITY,
  SETTINGS_ON,
  SETTINGS_UNKNOWN,
  TO_CHECK_ROWS,
} from './acc3-bills-fixtures';
import * as A from './acc3-bills-preview-actions';
import { inSettings, settingsOwner } from './settings-preview-frame';

/*
 * Accounts phase 3 preview states (acc3-bills-*), track U: automatic bills on
 * the Deal page Customer documents card, Accounts › Bills to check, the
 * Settings › Accounts additions (automatic bills, write-offs, Tally file) and
 * the daily check additions. Synthetic props only; rendered by the
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
const purchaseViewer: ShellViewer = { ...accountsViewer, displayName: 'Synthetic Purchase Jodhpur', primaryRole: 'Purchase', canUseAccounts: false, canSeeAccountsDesk: false, canSeePurchaseTasks: true };

const NOOP = accNoticeNoop as never;
function shell(viewer: ShellViewer, path: string, body: ReactNode) {
  return (
    <StaffShell viewer={viewer} currentPath={path} notices={{ api: { inbox: NOOP, history: NOOP, mark: NOOP, markAllRead: NOOP, setSound: NOOP }, realtime: null, preview: { inbox: viewer === accountsViewer ? INBOX_ACCOUNTS : INBOX } }}>
      {body}
    </StaffShell>
  );
}

const DOC_ACTIONS: DocActions = {
  createDraft: act(A.docOk),
  refresh: act(A.docOk),
  release: act(A.docReleaseOk),
  discard: act(A.docOk),
  cancel: act(A.docOk),
  replace: act(A.docOk),
  linkTally: act(A.docOk),
  retryPdf: act(A.docOk),
};

function dealPage(viewer: ShellViewer, docs: DealDocs | 'error') {
  return shell(
    viewer,
    '/app/deals',
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Deal · SYN-JOD-101" title="Synthetic family trip to Udaipur" />
      <DealCustomerDocumentsCard
        docs={docs}
        dealId={DEAL_ID}
        actions={viewer === accountsViewer ? DOC_ACTIONS : null}
        numberPrefix="10101"
        billingHref={`/app/accounts/deals/${DEAL_ID}?tab=billing`}
        reviewHref={`/app/accounts/deals/${DEAL_ID}?tab=review`}
      />
    </div>,
  );
}

const ACCOUNTS = { kind: 'accounts' as const, entityName: 'Holiday Chacha Pvt LTD' };
const BRANCHES = [
  { id: 'a0000011-0000-4000-8000-000000000011', name: 'Jodhpur' },
  { id: 'a0000012-0000-4000-8000-000000000012', name: 'Delhi' },
  { id: 'a0000013-0000-4000-8000-000000000013', name: 'Ahmedabad' },
];
function list(viewer: ShellViewer, filter: DocsFilter, page: DocListPage | 'error', autoBills: boolean | undefined = true) {
  return shell(viewer, '/app/accounts/documents', <DocumentsListView viewer={viewer === managerViewer ? { kind: 'manager', branchNames: ['Jodhpur'] } : ACCOUNTS} filter={filter} page={page} branches={BRANCHES} autoBills={autoBills} />);
}

const SETTINGS_ACTIONS: Acc3AccountsSettingsActions = { setAutoBills: act(A.autoBillsOk), setWriteOff: act(A.writeOffOk), setTallyXml: act(A.tallyXmlOk) };
function settings(entities: Acc3AccountsSettingsEntity[], actions: Acc3AccountsSettingsActions = SETTINGS_ACTIONS, initial?: Partial<Record<Acc3RowKey, ActionRowPreview>>) {
  return inSettings(
    settingsOwner,
    '/app/admin/accounts',
    <Acc3AccountsSettings entities={entities} actions={actions} initial={initial} />,
  );
}

/** Stand-in for the Phase 2 daily check card: the slot shows only the phase 3 tiles. */
function daily(extra: Acc3DailyCheckExtra | null) {
  return shell(
    accountsViewer,
    '/app/accounts/records',
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Accounts" title="Money records" />
      <Card>
        <section aria-labelledby="daily-heading">
          <CardHeader>
            <CardTitle id="daily-heading">Daily check</CardTitle>
          </CardHeader>
          <CardBody>
            {extra ? (
              <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0 lg:grid-cols-3" aria-label="Daily check counts">
                <Acc3DailyCheckItems extra={extra} />
              </ul>
            ) : (
              <p className="m-0 text-copy">The database does not send the phase 3 counts yet: the card shows only its Phase 2 counts.</p>
            )}
          </CardBody>
        </section>
      </Card>
    </div>,
  );
}

// R1: the refusals as the confirm dialog shows them (open, typed reason kept, the named field marked).
const LIMIT_REFUSED: ActionRowPreview = { open: true, reason: 'Owner approved a higher limit (synthetic).', result: { ok: false, message: 'The limit must be between ₹1 and ₹5,000.', fields: ['limitRupees'] } };
const NAME_REFUSED: ActionRowPreview = { open: true, result: { ok: false, message: 'Type the company name exactly as Tally shows it before switching the Tally file on.', fields: ['companyName'] } };

const states: Record<string, () => ReactNode> = {
  /* Deal page › Customer documents card */
  'acc3-bills-deal-held': () => dealPage(accountsViewer, DEAL_AUTO),
  'acc3-bills-deal-held-many': () => dealPage(accountsViewer, DEAL_AUTO_MANY),
  'acc3-bills-deal-ready-release-off': () => dealPage(accountsViewer, DEAL_AUTO_READY),
  'acc3-bills-deal-ready-release-on': () => dealPage(accountsViewer, DEAL_AUTO_READY_RELEASE_ON),
  'acc3-bills-deal-auto-docs-off': () => dealPage(accountsViewer, { ...DEAL_AUTO, enabled: false }),
  'acc3-bills-deal-manager': () => dealPage(managerViewer, MANAGER_AUTO),
  'acc3-bills-deal-sales': () => dealPage(salesViewer, SALES_AUTO),
  'acc3-bills-deal-error': () => dealPage(accountsViewer, 'error'),

  /* Accounts › Bills to check */
  'acc3-bills-to-check': () => list(accountsViewer, { preset: 'toCheck' }, { items: TO_CHECK_ROWS, nextAfter: null, hasMore: false }),
  'acc3-bills-to-check-empty': () => list(accountsViewer, { preset: 'toCheck' }, { items: [], nextAfter: null, hasMore: false }),
  'acc3-bills-to-check-error': () => list(accountsViewer, { preset: 'toCheck' }, 'error'),
  'acc3-bills-list-auto': () => list(accountsViewer, {}, { items: LIST_AUTO_ROWS, nextAfter: null, hasMore: false }),
  'acc3-bills-list-auto-held': () => list(accountsViewer, { autoState: 'held' }, { items: TO_CHECK_ROWS.slice(0, 2), nextAfter: null, hasMore: false }),
  'acc3-bills-list-auto-off': () => list(accountsViewer, {}, { items: LIST_AUTO_ROWS.slice(2), nextAfter: null, hasMore: false }, false),
  'acc3-bills-list-manager': () => list(managerViewer, {}, { items: LIST_AUTO_ROWS.filter((r) => r.status !== 'draft' && r.branchName === 'Jodhpur'), nextAfter: null, hasMore: false }),
  'acc3-bills-list-no-access': () => shell(purchaseViewer, '/app/accounts/documents', <DocumentsNoAccess />),

  /* Settings › Accounts additions */
  'acc3-bills-settings': () => settings([SETTINGS_ENTITY]),
  'acc3-bills-settings-on': () => settings([SETTINGS_ON]),
  'acc3-bills-settings-docs-off': () => settings([SETTINGS_DOCS_OFF]),
  'acc3-bills-settings-unknown': () => settings([SETTINGS_UNKNOWN]),
  'acc3-bills-settings-saved': () => settings([SETTINGS_ON], SETTINGS_ACTIONS, { autoDrafts: { result: { ok: true, message: 'Synthetic preview: automatic bills saved with your reason.' } } }),
  'acc3-bills-settings-limit-refused': () => settings([SETTINGS_ON], { ...SETTINGS_ACTIONS, setWriteOff: act(A.writeOffLimitRefused) }, { writeOff: LIMIT_REFUSED }),
  'acc3-bills-settings-tally-refused': () => settings([SETTINGS_ENTITY], { ...SETTINGS_ACTIONS, setTallyXml: act(A.tallyXmlNoName) }, { tallyXml: NAME_REFUSED }),

  /* Daily check additions */
  'acc3-bills-daily': () => daily(DAILY_EXTRA),
  'acc3-bills-daily-late': () => daily(DAILY_EXTRA_LATE),
  'acc3-bills-daily-quiet': () => daily(DAILY_EXTRA_QUIET),
  'acc3-bills-daily-absent': () => daily(null),
};

export const ACC3_BILLS_STATES = Object.keys(states);

export function renderAcc3BillsState(state: string): ReactNode | null {
  return states[state]?.() ?? null;
}
