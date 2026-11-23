import type { ReactNode } from 'react';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { ChangeRequestsApprovals, ChangeRequestsApprovalsLoading, ChangeRequestsApprovalsSection, ChangeRequestsTabIntro } from '@/views/booking-changes/approvals';
import { ChangeModeBanner, ChangeModeServiceMark, ChangedField } from '@/views/booking-changes/change-mode';
import { DealChangesCard, DealChangesCardLoading } from '@/views/booking-changes/deal-card';
import { ChangeHistory, ChangeHistoryLoading } from '@/views/booking-changes/history';
import { ReconfirmPanel, ReconfirmPanelLoading } from '@/views/booking-changes/reconfirm-panel';
import type { ChangeRequestActions } from '@/views/booking-changes/request-block';
import type { ChangeModeView, ChangeViewer, DealChangeRequestsView } from '@/views/booking-changes/types';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import { ManagerApprovalsPage } from '@/views/purchase/manager-approvals';
import ApprovalsLoading from '@/app/app/approvals/loading';
import { RateContractApprovalsTab } from '@/views/rate-contracts/approvals';
import type { ManagerApprovalsView } from '@/modules/supplier-money/contracts';
import { INBOX } from './acc-fixtures';
import { accNoticeNoop } from './acc-preview-actions';
import * as F from './acc3-changes-fixtures';
import * as A from './acc3-changes-preview-actions';

/*
 * Accounts phase 3 preview states (acc3-changes-*), track U: the Deal page
 * "Changes after confirmation" card (Sales owner, Manager, Accounts),
 * Approvals › Change requests (with the booked-removal charges table), the
 * booking form's change-mode parts, the Purchase task "Reconfirm with
 * supplier" panel and the History of changes. Synthetic props only;
 * rendered by the design-review gallery only (a 404 outside local preview mode).
 */

const act = (a: unknown) => a as DecisionAction;

const salesViewer: ShellViewer = { displayName: 'Synthetic Sales Jodhpur', primaryRole: 'Sales', primaryBranch: 'Jodhpur', canAdministerStaff: false, canManageGrants: false, canSeeLeads: true, canSeeOwnDues: true };
const managerViewer: ShellViewer = { ...salesViewer, displayName: 'Synthetic Manager Jodhpur', primaryRole: 'Manager', canSeeBranchMoney: true, canSeeApprovals: true, canSeePurchaseTasks: true };
const accountsViewer: ShellViewer = { ...salesViewer, displayName: 'Synthetic Accounts 1', primaryRole: 'Accounts', canSeeLeads: false, canUseAccounts: true, canSeeAccountsDesk: true };
const purchaseViewer: ShellViewer = { ...salesViewer, displayName: 'Synthetic Purchase Jodhpur', primaryRole: 'Purchase', canSeeLeads: false, canSeeOwnDues: false, canSeePurchaseTasks: true };

const NOOP = accNoticeNoop as never;
function shell(viewer: ShellViewer, path: string, body: ReactNode) {
  return (
    <StaffShell viewer={viewer} currentPath={path} notices={{ api: { inbox: NOOP, history: NOOP, mark: NOOP, markAllRead: NOOP, setSound: NOOP }, realtime: null, preview: { inbox: INBOX } }}>
      {body}
    </StaffShell>
  );
}

function withTitle(viewer: ShellViewer, path: string, body: ReactNode) {
  return shell(
    viewer,
    path,
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Deal · SYN-JOD-301" title="Synthetic family trip to Udaipur and Jodhpur" />
      {body}
    </div>,
  );
}

const ACTIONS: ChangeRequestActions = { create: act(A.crCreateOk), createAdd: act(A.crCreateOk), createRemove: act(A.crCreateOk), resubmit: act(A.crReasonOk), withdraw: act(A.crReasonOk), openVersion: act(A.crOpenVersionOk) };
const editHref = (id: string) => `/preview/acc3-changes-mode?cr=${id}`;

type CardPreview = Parameters<typeof DealChangesCard>[0]['preview'];
function dealPage(viewer: ShellViewer, who: ChangeViewer, changes: DealChangeRequestsView | 'error', over: { actions?: Partial<ChangeRequestActions> | null; preview?: CardPreview; switches?: boolean } = {}) {
  return shell(
    viewer,
    '/app/deals',
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Deal · SYN-JOD-301" title="Synthetic family trip to Udaipur and Jodhpur" />
      <DealChangesCard changes={changes} viewer={who} actions={over.actions === undefined ? (who === 'accounts' ? null : ACTIONS) : over.actions} editHref={editHref} historyHref="#change-history" preview={over.preview} switches={over.switches ? { setChanges: act(A.crReasonOk), setServiceChanges: act(A.crReasonOk) } : null} />
    </div>,
  );
}

const decide = { decide: act(A.crDecideOk) };
function approvals(viewer: ShellViewer, body: ReactNode) {
  return shell(
    viewer,
    '/app/approvals',
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Approvals" title="Change requests" />
      {body}
    </div>,
  );
}

function taskPage(viewer: ShellViewer, body: ReactNode) {
  return shell(
    viewer,
    '/app/purchase',
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Purchase task · SYN-JOD-301 · Service 1" title="Hotel · Synthetic Lake Palace, Udaipur" />
      {body}
    </div>,
  );
}

const RC_ACTIONS = { record: act(A.rcRecordOk), refuse: act(A.crReasonOk), approveOverBudget: act(A.rcApproveOk) };

function changeMode(view: ChangeModeView, submit: DecisionAction | null, preview?: { open?: boolean; state?: { ok: false; code: string; message: string } }) {
  const services = [
    { id: F.ITEM_IDS.one, title: '1. Hotel · Synthetic Lake Palace, Udaipur' },
    { id: F.ITEM_IDS.two, title: '2. Hotel · Synthetic Fort View, Jodhpur' },
    { id: F.ITEM_IDS.three, title: '3. Transfer · Airport to hotel' },
  ];
  return shell(
    salesViewer,
    '/app/deals',
    <div className="flex flex-col gap-5">
      <ChangeModeBanner view={view} submit={submit} preview={preview} />
      <PageHeader eyebrow="Book now · SYN-JOD-301" title="Booking (change version)" />
      {services.map((s) => {
        const inReq = view.requestItemIds.includes(s.id);
        const changed = view.changedItemIds.includes(s.id);
        return (
          <Card key={s.id}>
            <CardHeader>
              <CardTitle>{s.title}</CardTitle>
              <ChangeModeServiceMark itemId={s.id} view={view} />
            </CardHeader>
            <CardBody className="grid gap-4 sm:grid-cols-2">
              <ChangedField changed={changed && s.id === F.ITEM_IDS.one} before="12 Dec 2026">
                <Field htmlFor={`ci-${s.id}`} label="Check-in">
                  <Input id={`ci-${s.id}`} defaultValue={changed && s.id === F.ITEM_IDS.one ? '13 Dec 2026' : '12 Dec 2026'} readOnly={!inReq} />
                </Field>
              </ChangedField>
              <ChangedField changed={changed} before="1">
                <Field htmlFor={`rooms-${s.id}`} label="Rooms">
                  <Input id={`rooms-${s.id}`} defaultValue={changed ? '2' : '1'} readOnly={!inReq} />
                </Field>
              </ChangedField>
            </CardBody>
          </Card>
        );
      })}
    </div>,
  );
}

const SELF = { ok: false as const, code: 'not_self_approval', message: 'You cannot approve your own request. Another Manager approves it.' };
const STALE = { ok: false as const, code: 'version_changed', message: 'Someone changed this since you opened it. Reload the page and check again.' };
const OUTSIDE = { ok: false as const, code: 'change_outside_request', message: 'Some changed services are not part of the approved request. (Service 3)' };


/* Redesign R3: the whole Manager Approvals page (synthetic rows; the decide actions are preview stubs). */
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const EMPTY_VIEW: ManagerApprovalsView = { costsAboveBudget: [], payments: [], funding: [], bankDetails: [], suppliersToVerify: [], cancellations: [], flightFares: [] };
const MANAGER_VIEW: ManagerApprovalsView = {
  ...EMPTY_VIEW,
  costsAboveBudget: [
    { taskId: UUID(901), dealReference: 'SYN-JOD-301', serviceTitle: 'Synthetic Lake Palace, Udaipur', supplierName: 'Synthetic Lake Partners', versionNo: 3, amountPaise: '3840000', budgetPaise: '3600000', proposedAt: '2026-11-15T08:00:00Z', proposedByName: 'Synthetic Purchase Jodhpur', canApprove: true, contractState: 'none', contractTotalPaise: null, contractDeviationReason: null },
  ],
  bankDetails: [
    { supplierId: UUID(902), supplierName: 'Synthetic Coach Partners', revisionNo: 2, accountHolder: 'Synthetic Coach Partners', bankName: 'Example Bank', ifsc: 'EXMP0000002', accountLast4: '4321', createdAt: '2026-11-14T06:00:00Z', createdByName: 'Synthetic Purchase Jodhpur', canApprove: true },
  ],
};
const MANAGER_VIEW_OWN: ManagerApprovalsView = {
  ...EMPTY_VIEW,
  costsAboveBudget: MANAGER_VIEW.costsAboveBudget.map((c) => ({ ...c, canApprove: false, proposedByName: 'Synthetic Manager Jodhpur' })),
  suppliersToVerify: [{ supplierId: UUID(903), name: 'Synthetic Heritage Stays', city: 'Bikaner', serviceTypes: ['hotel'], rowVersion: 2, updatedAt: '2026-11-14T06:00:00Z', canVerify: false }],
};
const MANAGER_ACTIONS = { decidePayment: act(A.crDecideOk), decideFunding: act(A.crDecideOk), decideCancellation: act(A.crDecideOk) };

function approvalsPage(view: ManagerApprovalsView, extra: { changes: 'rows' | 'own' | 'error' | 'none'; rates: 'rows' | 'error' | 'none' }) {
  const changeItems = extra.changes === 'rows' ? [F.ROW_CHANGE, F.ROW_REMOVE_MISSING] : extra.changes === 'own' ? [F.ROW_SELF] : [];
  const changePage = extra.changes === 'error' ? ('error' as const) : { items: changeItems, nextAfter: null, hasMore: false };
  return shell(
    managerViewer,
    '/app/approvals',
    <ManagerApprovalsPage
      view={view}
      today="2026-11-17"
      actions={MANAGER_ACTIONS}
      extraSections={[
        {
          key: 'changes',
          count: extra.changes === 'error' ? 'unknown' : changeItems.length,
          node: (
            <ChangeRequestsApprovalsSection
              page={changePage}
              charges={{ [F.ROW_REMOVE_MISSING.id]: F.CHARGES_MISSING }}
              reviews={extra.changes === 'rows' ? { [F.ROW_CHANGE.id]: F.REVIEW_CHANGE } : undefined}
              actions={decide}
            />
          ),
        },
        {
          key: 'rateContracts',
          count: extra.rates === 'error' ? 'unknown' : 0,
          node: <RateContractApprovalsTab rows={extra.rates === 'error' ? 'error' : []} enabled visibleHeading />,
        },
      ]}
    />,
  );
}

const states: Record<string, () => ReactNode> = {
  /* Deal page card — Sales owner */
  'acc3-changes-deal-none': () => dealPage(salesViewer, 'sales', F.DEAL_NONE),
  'acc3-changes-deal-past': () => dealPage(salesViewer, 'sales', F.DEAL_PAST),
  'acc3-changes-deal-ask-open': () => dealPage(salesViewer, 'sales', F.DEAL_PAST, { preview: { ask: { kind: 'change' } } }),
  'acc3-changes-deal-ask-refused': () =>
    dealPage(salesViewer, 'sales', F.DEAL_PAST, { actions: { ...ACTIONS, create: act(A.crCreateOpenExists) }, preview: { ask: { kind: 'change', state: { ok: false, code: 'change_open_exists', message: 'This Deal already has a change in progress. Finish or withdraw it first.' } } } }),
  'acc3-changes-deal-ask-not-supported': () =>
    dealPage(salesViewer, 'sales', F.DEAL_PAST, { actions: { ...ACTIONS, create: act(A.crCreateNotSupported) }, preview: { ask: { kind: 'change', state: { ok: false, code: 'change_not_supported', message: 'This booking cannot be changed here.' } } } }),
  'acc3-changes-deal-add-open': () => dealPage(salesViewer, 'sales', F.DEAL_PAST, { preview: { ask: { kind: 'add_service' } } }),
  'acc3-changes-deal-remove-open': () => dealPage(salesViewer, 'sales', F.DEAL_PAST, { preview: { ask: { kind: 'remove_service' } } }),
  'acc3-changes-deal-requested': () => dealPage(salesViewer, 'sales', F.DEAL_REQUESTED),
  'acc3-changes-deal-returned': () => dealPage(salesViewer, 'sales', F.DEAL_RETURNED),
  'acc3-changes-deal-resubmit-open': () => dealPage(salesViewer, 'sales', F.DEAL_RETURNED, { preview: { open: { requestId: F.REQ_RETURNED.id, dialog: 'resubmit' } } }),
  'acc3-changes-deal-approved': () => dealPage(salesViewer, 'sales', F.DEAL_APPROVED),
  'acc3-changes-deal-editing': () => dealPage(salesViewer, 'sales', F.DEAL_EDITING),
  'acc3-changes-deal-submitted': () => dealPage(salesViewer, 'sales', F.DEAL_SUBMITTED),
  'acc3-changes-deal-withdraw-open': () => dealPage(salesViewer, 'sales', F.DEAL_SUBMITTED, { preview: { open: { requestId: F.REQ_SUBMITTED.id, dialog: 'withdraw' } } }),
  'acc3-changes-deal-remove-booked': () => dealPage(salesViewer, 'sales', F.DEAL_REMOVE_BOOKED),
  'acc3-changes-deal-remove-simple': () => dealPage(salesViewer, 'sales', F.DEAL_REMOVE_SIMPLE),
  'acc3-changes-deal-off': () => dealPage(salesViewer, 'sales', F.DEAL_OFF),
  'acc3-changes-deal-blocked': () => dealPage(salesViewer, 'sales', F.DEAL_BLOCKED),
  'acc3-changes-deal-not-committed': () => dealPage(salesViewer, 'sales', F.DEAL_NOT_COMMITTED),
  'acc3-changes-deal-manager': () => dealPage(managerViewer, 'manager', F.DEAL_MANAGER),
  'acc3-changes-deal-switches': () => dealPage(managerViewer, 'manager', F.DEAL_MANAGER, { switches: true }),
  'acc3-changes-deal-service-blocked': () => dealPage(salesViewer, 'sales', { ...F.DEAL_PAST, serviceBlockedBy: ['not_submitted'] }),
  'acc3-changes-deal-nothing-removable': () => dealPage(salesViewer, 'sales', { ...F.DEAL_PAST, removable: [], addableTypes: [] }),
  'acc3-changes-deal-accounts': () => dealPage(accountsViewer, 'accounts', F.DEAL_ACCOUNTS),
  'acc3-changes-deal-error': () => dealPage(salesViewer, 'sales', 'error'),
  'acc3-changes-deal-loading': () => withTitle(salesViewer, '/app/deals', <DealChangesCardLoading />),

  /* Approvals › Change requests */
  'acc3-changes-approvals': () =>
    approvals(
      managerViewer,
      <>
        <ChangeRequestsTabIntro count={4} />
        <ChangeRequestsApprovals
          viewer="manager"
          page={{ items: [F.ROW_CHANGE, F.ROW_ADD, F.ROW_REMOVE_MISSING, F.ROW_REMOVE_READY, F.ROW_SELF], nextAfter: 'x', hasMore: true }}
          charges={{ [F.ROW_REMOVE_MISSING.id]: F.CHARGES_MISSING, [F.ROW_REMOVE_READY.id]: F.CHARGES_READY }}
          actions={decide}
          nextHref="/preview/acc3-changes-approvals"
        />
      </>,
    ),
  'acc3-changes-approvals-approve-open': () => approvals(managerViewer, <ChangeRequestsApprovals viewer="manager" page={{ items: [F.ROW_CHANGE], nextAfter: null, hasMore: false }} actions={decide} open={{ requestId: F.ROW_CHANGE.id, dialog: 'approve' }} />),
  'acc3-changes-approvals-return-open': () => approvals(managerViewer, <ChangeRequestsApprovals viewer="manager" page={{ items: [F.ROW_CHANGE], nextAfter: null, hasMore: false }} actions={decide} open={{ requestId: F.ROW_CHANGE.id, dialog: 'return' }} />),
  'acc3-changes-approvals-self-refused': () =>
    approvals(managerViewer, <ChangeRequestsApprovals viewer="manager" page={{ items: [F.ROW_CHANGE], nextAfter: null, hasMore: false }} actions={{ decide: act(A.crDecideSelf) }} open={{ requestId: F.ROW_CHANGE.id, dialog: 'approve', state: SELF }} />),
  'acc3-changes-approvals-stale': () =>
    approvals(
      managerViewer,
      <ChangeRequestsApprovals
        viewer="manager"
        page={{ items: [F.ROW_REMOVE_READY], nextAfter: null, hasMore: false }}
        charges={{ [F.ROW_REMOVE_READY.id]: F.CHARGES_READY }}
        actions={{ decide: act(A.crDecideVersionChanged) }}
        open={{ requestId: F.ROW_REMOVE_READY.id, dialog: 'approve', state: STALE }}
      />,
    ),
  'acc3-changes-approvals-empty': () => approvals(managerViewer, <ChangeRequestsApprovals viewer="manager" page={{ items: [], nextAfter: null, hasMore: false }} actions={decide} />),
  'acc3-changes-approvals-sales': () => approvals(salesViewer, <ChangeRequestsApprovals viewer="sales" page={{ items: [{ ...F.ROW_CHANGE, can: { approve: false, return: false } }], nextAfter: null, hasMore: false }} actions={null} />),
  'acc3-changes-approvals-accounts': () =>
    approvals(accountsViewer, <ChangeRequestsApprovals viewer="accounts" page={{ items: [{ ...F.ROW_CHANGE, can: { approve: false, return: false } }, { ...F.ROW_ADD, can: { approve: false, return: false } }], nextAfter: null, hasMore: false }} actions={null} />),
  'acc3-changes-approvals-error': () => approvals(managerViewer, <ChangeRequestsApprovals viewer="manager" page="error" actions={decide} />),
  'acc3-changes-approvals-loading': () => approvals(managerViewer, <ChangeRequestsApprovalsLoading />),

  /* Addendum O2: the Manager approves the filled version, old and new side by side */
  'acc3-changes-review': () =>
    approvals(managerViewer, <ChangeRequestsApprovals viewer="manager" page={{ items: [F.ROW_CHANGE], nextAfter: null, hasMore: false }} reviews={{ [F.ROW_CHANGE.id]: F.REVIEW_CHANGE }} actions={decide} />),
  'acc3-changes-review-approve-open': () =>
    approvals(managerViewer, <ChangeRequestsApprovals viewer="manager" page={{ items: [F.ROW_CHANGE], nextAfter: null, hasMore: false }} reviews={{ [F.ROW_CHANGE.id]: F.REVIEW_CHANGE }} actions={decide} open={{ requestId: F.ROW_CHANGE.id, dialog: 'approve' }} />),
  'acc3-changes-review-return-open': () =>
    approvals(managerViewer, <ChangeRequestsApprovals viewer="manager" page={{ items: [F.ROW_CHANGE], nextAfter: null, hasMore: false }} reviews={{ [F.ROW_CHANGE.id]: F.REVIEW_CHANGE }} actions={decide} open={{ requestId: F.ROW_CHANGE.id, dialog: 'return' }} />),

  /* Redesign R3 (DM-5 to DM-8): the whole Approvals page, summary chips, only sections with something waiting */
  'acc3-changes-approvals-page': () => approvalsPage(MANAGER_VIEW, { changes: 'rows', rates: 'rows' }),
  'acc3-changes-approvals-page-own': () => approvalsPage(MANAGER_VIEW_OWN, { changes: 'own', rates: 'none' }),
  'acc3-changes-approvals-page-unknown': () => approvalsPage(MANAGER_VIEW, { changes: 'error', rates: 'error' }),
  'acc3-changes-approvals-page-empty': () => approvalsPage(EMPTY_VIEW, { changes: 'none', rates: 'none' }),
  'acc3-changes-approvals-page-loading': () => shell(managerViewer, '/app/approvals', <ApprovalsLoading />),
  'acc3-changes-review-stale': () =>
    approvals(managerViewer, <ChangeRequestsApprovals viewer="manager" page={{ items: [F.ROW_CHANGE], nextAfter: null, hasMore: false }} reviews={{ [F.ROW_CHANGE.id]: F.REVIEW_STALE }} actions={decide} />),
  'acc3-changes-review-not-filled': () =>
    approvals(managerViewer, <ChangeRequestsApprovals viewer="manager" page={{ items: [F.ROW_CHANGE], nextAfter: null, hasMore: false }} reviews={{ [F.ROW_CHANGE.id]: F.REVIEW_NOT_FILLED }} actions={decide} />),
  'acc3-changes-review-remove': () =>
    approvals(
      managerViewer,
      <ChangeRequestsApprovals
        viewer="manager"
        page={{ items: [F.ROW_REMOVE_READY], nextAfter: null, hasMore: false }}
        charges={{ [F.ROW_REMOVE_READY.id]: F.CHARGES_READY }}
        reviews={{ [F.ROW_REMOVE_READY.id]: F.REVIEW_REMOVE }}
        actions={decide}
      />,
    ),
  'acc3-changes-review-error': () =>
    approvals(managerViewer, <ChangeRequestsApprovals viewer="manager" page={{ items: [F.ROW_CHANGE], nextAfter: null, hasMore: false }} reviews={{ [F.ROW_CHANGE.id]: 'error' }} actions={decide} />),

  /* Booking form in change mode */
  'acc3-changes-mode': () => changeMode(F.CHANGE_MODE, act(A.crSubmitOk)),
  'acc3-changes-mode-send-open': () => changeMode(F.CHANGE_MODE, act(A.crSubmitOk), { open: true }),
  'acc3-changes-mode-outside': () => changeMode(F.CHANGE_MODE_OUTSIDE, act(A.crSubmitOutside)),
  'acc3-changes-mode-refused': () => changeMode(F.CHANGE_MODE, act(A.crSubmitOutside), { open: true, state: OUTSIDE }),
  'acc3-changes-mode-nothing': () => changeMode(F.CHANGE_MODE_NOTHING, act(A.crSubmitOk)),

  /* Purchase task › Reconfirm with supplier */
  'acc3-changes-reconfirm': () => taskPage(purchaseViewer, <ReconfirmPanel view={F.RECONFIRM_PENDING} proofs={F.PROOFS} actions={RC_ACTIONS} viewer="purchase" />),
  'acc3-changes-reconfirm-record-open': () => taskPage(purchaseViewer, <ReconfirmPanel view={F.RECONFIRM_PENDING} proofs={F.PROOFS} actions={RC_ACTIONS} viewer="purchase" preview={{ open: 'record' }} />),
  'acc3-changes-reconfirm-record-refused': () =>
    taskPage(
      purchaseViewer,
      <ReconfirmPanel
        view={F.RECONFIRM_PENDING}
        proofs={F.PROOFS}
        actions={{ ...RC_ACTIONS, record: act(A.rcRecordPaymentInProgress) }}
        viewer="purchase"
        preview={{ open: 'record', state: { ok: false, code: 'payment_in_progress', message: 'A supplier payment for this task is in progress. Finish or withdraw it first.' }, defaults: { newRateRupees: '49000', supplierFeeRupees: '2500', newReference: 'SYN-HTL-88412-B', evidenceId: F.PROOFS[0]!.evidenceId } }}
      />,
    ),
  'acc3-changes-reconfirm-no-proof': () => taskPage(purchaseViewer, <ReconfirmPanel view={F.RECONFIRM_PENDING} proofs={[]} actions={RC_ACTIONS} viewer="purchase" />),
  // Review finding 1: the proof is uploaded inside the panel (the confirmed task's own upload is closed).
  'acc3-changes-reconfirm-upload': () =>
    taskPage(purchaseViewer, <ReconfirmPanel view={F.RECONFIRM_PENDING_UPLOAD} proofs={[]} actions={RC_ACTIONS} viewer="purchase" roles={{ isManager: false, worksTask: true }} proofUpload={<PreviewProofUpload />} />),
  // Review finding 8: a Manager who is not an Approver for this cost sees the real cause.
  'acc3-changes-reconfirm-over-budget-blocked-manager': () =>
    taskPage(managerViewer, <ReconfirmPanel view={F.RECONFIRM_RECORDED_OVER} proofs={F.PROOFS} actions={RC_ACTIONS} viewer="manager" roles={{ isManager: true, worksTask: false }} />),
  'acc3-changes-reconfirm-refuse-open': () => taskPage(purchaseViewer, <ReconfirmPanel view={F.RECONFIRM_PENDING} proofs={F.PROOFS} actions={RC_ACTIONS} viewer="purchase" preview={{ open: 'refuse' }} />),
  'acc3-changes-reconfirm-over-budget': () => taskPage(purchaseViewer, <ReconfirmPanel view={F.RECONFIRM_RECORDED_OVER} proofs={F.PROOFS} actions={RC_ACTIONS} viewer="purchase" />),
  'acc3-changes-reconfirm-manager': () => taskPage(managerViewer, <ReconfirmPanel view={F.RECONFIRM_MANAGER} proofs={F.PROOFS} actions={RC_ACTIONS} viewer="manager" />),
  'acc3-changes-reconfirm-recorded': () => taskPage(purchaseViewer, <ReconfirmPanel view={F.RECONFIRM_RECORDED} proofs={F.PROOFS} actions={RC_ACTIONS} viewer="purchase" />),
  'acc3-changes-reconfirm-refused': () => taskPage(purchaseViewer, <ReconfirmPanel view={F.RECONFIRM_REFUSED} proofs={F.PROOFS} actions={RC_ACTIONS} viewer="purchase" />),
  // Addendum L10: the refuser also handles other services of the change; notice 56 is not sent to them.
  'acc3-changes-reconfirm-refused-voided': () =>
    taskPage(
      purchaseViewer,
      <ReconfirmPanel
        view={F.RECONFIRM_REFUSED}
        proofs={F.PROOFS}
        actions={RC_ACTIONS}
        viewer="purchase"
        voided={[
          { taskId: 'a0005911-0000-4000-8000-000000005911', serviceTitle: 'Synthetic Lake Palace, Udaipur', href: '#reconfirm' },
          { taskId: 'a0005912-0000-4000-8000-000000005912', serviceTitle: 'Transfer · Airport to hotel', href: '#reconfirm' },
        ]}
      />,
    ),
  'acc3-changes-reconfirm-void': () => taskPage(purchaseViewer, <ReconfirmPanel view={F.RECONFIRM_VOID} proofs={F.PROOFS} actions={RC_ACTIONS} viewer="purchase" />),
  'acc3-changes-reconfirm-error': () => taskPage(purchaseViewer, <ReconfirmPanel view="error" proofs={[]} actions={RC_ACTIONS} viewer="purchase" />),
  'acc3-changes-reconfirm-loading': () => taskPage(purchaseViewer, <ReconfirmPanelLoading />),

  /* History of changes */
  'acc3-changes-history-manager': () => withTitle(managerViewer, '/app/deals', <ChangeHistory history={F.HISTORY_MANAGER} viewer="manager" />),
  'acc3-changes-history-sales': () => withTitle(salesViewer, '/app/deals', <ChangeHistory history={F.HISTORY_SALES} viewer="sales" />),
  'acc3-changes-history-purchase': () => withTitle(purchaseViewer, '/app/purchase', <ChangeHistory history={F.HISTORY_PURCHASE} viewer="purchase" />),
  'acc3-changes-history-empty': () => withTitle(salesViewer, '/app/deals', <ChangeHistory history={{ versions: [], confirmations: [] }} viewer="sales" />),
  'acc3-changes-history-error': () => withTitle(salesViewer, '/app/deals', <ChangeHistory history="error" viewer="sales" />),
  'acc3-changes-history-loading': () => withTitle(salesViewer, '/app/deals', <ChangeHistoryLoading />),
};

export const ACC3_CHANGES_STATES = Object.keys(states);

export function renderAcc3ChangesState(state: string): ReactNode | null {
  return states[state]?.() ?? null;
}

/** Preview stand-in for the real Purchase upload form (which posts to the real server action). */
function PreviewProofUpload() {
  return (
    <div className="flex flex-col gap-2">
      <Field htmlFor="pv-proof-file" label="Supplier’s new confirmation" hint="PDF, JPEG, PNG or WebP, up to 4 MB. Synthetic preview: nothing is uploaded.">
        <Input id="pv-proof-file" type="file" aria-describedby="pv-proof-file-hint" />
      </Field>
    </div>
  );
}
