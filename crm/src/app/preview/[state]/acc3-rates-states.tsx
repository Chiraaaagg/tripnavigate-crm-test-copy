import type { ReactNode } from 'react';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Tabs } from '@/components/ui/tabs';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { RateContractApprovalsTab } from '@/views/rate-contracts/approvals';
import { RateContractLoading, RateContractNotFound, RateContractPageView, type RateContractActions, type RateContractPreview } from '@/views/rate-contracts/contract-page';
import { RateSheetColumns, RateSheetImportDetails } from '@/views/rate-contracts/import-details';
import { RateContractsListView, RateContractsLoading, RateContractsNoAccess } from '@/views/rate-contracts/list';
import { ContractRateBlockFrame } from '@/views/rate-contracts/offer-block';
import type { RateContractDetail, RateContractFilter, RateContractLookup, RateContractPage, RateContractViewer } from '@/views/rate-contracts/types';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import { INBOX } from './acc-fixtures';
import { accNoticeNoop } from './acc-preview-actions';
import { ACTIVE, DETAIL, DRAFT, DRAFT_WITH_LINES, ENDED, LOOKUP_BLACKOUT, LOOKUP_ENDED, LOOKUP_NONE, LOOKUP_OK, LOOKUP_PARTIAL, RETURNED, ROOM_TYPES, ROWS, SHEET, STAY, SUPPLIERS } from './acc3-rates-fixtures';
import * as A from './acc3-rates-preview-actions';
import { PreviewTyped } from './preview-typed';

/*
 * Accounts phase 3 preview states (acc3-rates-*), track U: Suppliers › Rate
 * contracts (list and contract page), Approvals › Rate contracts, Settings ›
 * Imports › Rate sheet and the Purchase offer form contract block. Synthetic
 * props only; rendered by the design-review gallery only (a 404 outside local
 * preview mode).
 */

const act = (a: unknown) => a as DecisionAction;

const purchaseViewer: ShellViewer = {
  displayName: 'Synthetic Purchase Jodhpur',
  primaryRole: 'Purchase',
  primaryBranch: 'Jodhpur',
  canAdministerStaff: false,
  canManageGrants: false,
  canSeePurchaseTasks: true,
};
const managerViewer: ShellViewer = { ...purchaseViewer, displayName: 'Synthetic Manager Jodhpur', primaryRole: 'Manager', canSeePurchaseTasks: true, canSeeApprovals: true, canSeeBranchMoney: true, canSeeLeads: true };
const accountsViewer: ShellViewer = { ...purchaseViewer, displayName: 'Synthetic Accounts 1', primaryRole: 'Accounts', canSeePurchaseTasks: false, canUseAccounts: true, canSeeAccountsDesk: true };
const salesViewer: ShellViewer = { ...purchaseViewer, displayName: 'Synthetic Sales Jodhpur', primaryRole: 'Sales', canSeePurchaseTasks: false, canSeeLeads: true };
const SHELL: Record<RateContractViewer, ShellViewer> = { purchase: purchaseViewer, manager: managerViewer, accounts: accountsViewer };

const NOOP = accNoticeNoop as never;
function shell(viewer: ShellViewer, path: string, body: ReactNode) {
  return (
    <StaffShell viewer={viewer} currentPath={path} notices={{ api: { inbox: NOOP, history: NOOP, mark: NOOP, markAllRead: NOOP, setSound: NOOP }, realtime: null, preview: { inbox: INBOX } }}>
      {body}
    </StaffShell>
  );
}

const BASE = '/app/purchase/rate-contracts';
const page = (items = ROWS, more = false): RateContractPage => ({ items, nextAfter: more ? '2026-11-01|a0003506-0000-4000-8000-000000003506' : null, hasMore: more });

function list(viewer: RateContractViewer, opts: { filter?: RateContractFilter; page?: RateContractPage | 'error'; enabled?: boolean; createState?: Parameters<typeof RateContractsListView>[0]['createInitialState']; createAction?: DecisionAction } = {}) {
  return shell(
    SHELL[viewer],
    BASE,
    <RateContractsListView
      viewer={viewer}
      enabled={opts.enabled ?? true}
      filter={opts.filter ?? {}}
      page={opts.page ?? page()}
      counts={{ toApprove: 1, endingSoon: 2 }}
      suppliers={viewer === 'purchase' ? SUPPLIERS : []}
      createAction={viewer === 'purchase' ? (opts.createAction ?? act(A.rcCreateOk)) : null}
      createInitialState={opts.createState}
      importHref={viewer === 'purchase' ? '/app/settings/imports?kind=rate_sheet' : null}
    />,
  );
}

const PURCHASE_ACTIONS: RateContractActions = {
  save: act(A.rcSaveOk),
  linesSet: act(A.rcLinesOk),
  submit: act(A.rcSubmitOk),
  roomTypeSave: act(A.rcRoomTypeOk),
  roomTypeRemove: act(A.rcRoomTypeOk),
  fileUpload: act(A.rcFileOk),
};
const MANAGER_ACTIONS: RateContractActions = { decide: act(A.rcDecideOk), end: act(A.rcEndOk) };

function contract(viewer: RateContractViewer | 'sales', c: RateContractDetail | 'error', opts: { enabled?: boolean; actions?: RateContractActions; preview?: RateContractPreview } = {}) {
  const v = viewer === 'sales' ? 'accounts' : viewer;
  return shell(
    viewer === 'sales' ? salesViewer : SHELL[viewer],
    BASE,
    <RateContractPageView
      viewer={v}
      enabled={opts.enabled ?? true}
      contract={c}
      roomTypes={v === 'purchase' ? ROOM_TYPES : null}
      actions={opts.actions ?? (v === 'purchase' ? PURCHASE_ACTIONS : v === 'manager' ? MANAGER_ACTIONS : {})}
      fileHref={(fileId) => `/app/purchase/rate-contracts/files/${fileId}`}
      preview={opts.preview}
    />,
  );
}

function approvals(rows: Parameters<typeof RateContractApprovalsTab>[0]['rows'], extra: { enabled?: boolean; own?: string[] } = {}) {
  return shell(
    managerViewer,
    '/app/approvals',
    <div className="flex flex-col gap-4">
      <PageHeader eyebrow="Manager" title="Approvals" description="Everything waiting for your decision." className="mb-[0]" />
      <Tabs
        label="Approval lists"
        items={[
          { href: '/app/approvals', label: 'Costs and payments' },
          { href: '/app/approvals?tab=rate-contracts', label: 'Rate contracts', current: true, count: rows === 'error' ? undefined : rows.length },
        ]}
      />
      <RateContractApprovalsTab rows={rows} enabled={extra.enabled ?? true} viewerEnteredIds={extra.own} />
    </div>,
  );
}

function sheet(withResult: boolean) {
  return shell(
    purchaseViewer,
    '/app/settings',
    <div className="flex flex-col gap-4">
      <PageHeader eyebrow="Settings › Imports" title="Import a rate sheet" description="Check a supplier’s rate sheet, then apply it to make draft contracts." className="mb-[0]" />
      <Card>
        <CardBody className="flex flex-col gap-5">
          {withResult ? <RateSheetImportDetails sheet={SHEET} /> : null}
          <RateSheetColumns />
        </CardBody>
      </Card>
    </div>,
  );
}

function offer(initial: { roomTypeId?: string; mealPlanCode?: string; result?: RateContractLookup | null } | undefined, over: { quoted?: string; enabled?: boolean; hotelName?: string | null; supplierChosen?: boolean; reasonError?: string } = {}) {
  return shell(
    purchaseViewer,
    '/app/purchase',
    <div className="flex flex-col gap-4">
      <PageHeader eyebrow="Purchase task · SYN-JOD-201 · Hotel" title="Add an offer" description="Only the contract rate part of the offer form is shown here." className="mb-[0]" />
      <Card>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>Offer from Synthetic Lakeside Stays Pvt Ltd</CardTitle>
            <CardDescription>The rest of the offer form (supplier, quote file, notes) stays as it is today.</CardDescription>
          </div>
        </CardHeader>
        <CardBody>
          <ContractRateBlockFrame
            enabled={over.enabled ?? true}
            hotelName={over.hotelName === undefined ? 'Synthetic Lake Palace Udaipur' : over.hotelName}
            supplierChosen={over.supplierChosen ?? true}
            stay={STAY}
            roomTypes={ROOM_TYPES.map(({ roomTypeId, name }) => ({ roomTypeId, name }))}
            initial={initial}
            lookup={A.rcLookup}
            quotedRupees={over.quoted}
            reasonError={over.reasonError}
          />
        </CardBody>
      </Card>
    </div>,
  );
}

const picked = (result: RateContractLookup) => ({ roomTypeId: ROOM_TYPES[0]!.roomTypeId, mealPlanCode: 'CP', result });


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
  /* Suppliers › Rate contracts */
  'acc3-rates-list-purchase': () => list('purchase'),
  'acc3-rates-list-manager': () => list('manager'),
  'acc3-rates-list-accounts': () => list('accounts'),
  'acc3-rates-list-to-approve': () => list('manager', { filter: { preset: 'to_approve' }, page: page([ROWS[0]!]) }),
  'acc3-rates-list-ending-soon': () => list('purchase', { filter: { preset: 'ending_soon' }, page: page([ROWS[1]!, ROWS[5]!]) }),
  'acc3-rates-list-filtered': () => list('purchase', { filter: { q: 'lake', status: ['active'] }, page: page([ROWS[4]!]) }),
  'acc3-rates-list-more': () => list('purchase', { page: page(ROWS, true) }),
  'acc3-rates-list-none': () => list('purchase', { filter: { q: 'zzz' }, page: page([]) }),
  'acc3-rates-list-empty': () => list('purchase', { page: page([]) }),
  'acc3-rates-list-nothing-to-approve': () => list('manager', { filter: { preset: 'to_approve' }, page: page([]) }),
  'acc3-rates-list-off': () => list('purchase', { enabled: false }),
  'acc3-rates-list-error': () => list('purchase', { page: 'error' }),
  'acc3-rates-list-create-refused': () => typed({ validFrom: '2026-12-01', validTo: '2027-03-31' }, list('purchase', { createAction: act(A.rcLinkNotAllowed), createState: { ok: false, code: 'link_not_allowed', message: 'This supplier is not linked to this hotel, or does not sell hotels.' } })),
  'acc3-rates-list-loading': () => shell(purchaseViewer, BASE, <RateContractsLoading />),
  'acc3-rates-list-no-access': () => shell(salesViewer, BASE, <RateContractsNoAccess />),

  /* One contract */
  'acc3-rates-contract-draft-new': () => contract('purchase', DRAFT),
  'acc3-rates-contract-draft': () => contract('purchase', DRAFT_WITH_LINES),
  'acc3-rates-contract-lines-overlap': () =>
    contract('purchase', DRAFT_WITH_LINES, { actions: { ...PURCHASE_ACTIONS, linesSet: act(A.rcLinesOverlap) }, preview: { linesState: { ok: false, code: 'lines_overlap', message: 'Two rate lines for the same room and meal plan overlap in dates.', field: 'lines[3].seasonFrom' } as never } }),
  'acc3-rates-contract-lines-invalid': () =>
    contract('purchase', DRAFT_WITH_LINES, { actions: { ...PURCHASE_ACTIONS, linesSet: act(A.rcLinesInvalid) }, preview: { linesState: { ok: false, code: 'invalid_input', message: 'Check the highlighted field.', field: 'lines[1].ratePaise' } as never } }),
  'acc3-rates-contract-version-changed': () =>
    contract('purchase', DRAFT_WITH_LINES, { actions: { ...PURCHASE_ACTIONS, save: act(A.rcVersionChanged) }, preview: { detailsState: { ok: false, code: 'version_changed', message: 'Someone changed this contract while you were working. Reload the page to see the latest version.' } } }),
  'acc3-rates-contract-submit-off': () => contract('purchase', DRAFT_WITH_LINES, { actions: { ...PURCHASE_ACTIONS, submit: act(A.rcOff) }, preview: { submitState: { ok: false, code: 'rate_contracts_off', message: 'Rate contracts are not switched on yet.' } } }),
  'acc3-rates-contract-returned': () => contract('purchase', RETURNED),
  'acc3-rates-contract-pending-purchase': () => contract('purchase', { ...DETAIL, can: { edit: false, submit: false, approve: false, return: false, end: false } }),
  'acc3-rates-contract-pending-manager': () => contract('manager', DETAIL),
  'acc3-rates-contract-approve-open': () => contract('manager', DETAIL, { preview: { open: 'approve' } }),
  'acc3-rates-contract-approve-refused': () =>
    contract('manager', DETAIL, { actions: { ...MANAGER_ACTIONS, decide: act(A.rcNotSelf) }, preview: { open: 'approve', state: { ok: false, code: 'not_self_approval', message: 'You cannot approve a contract you entered. Ask another Manager.' } } }),
  'acc3-rates-contract-return-open': () => contract('manager', DETAIL, { preview: { open: 'return' } }),
  'acc3-rates-contract-return-refused': () =>
    typed({ reason: 'Rates' }, contract('manager', DETAIL, { actions: { ...MANAGER_ACTIONS, decide: act(A.rcReasonShort) }, preview: { open: 'return', state: { ok: false, code: 'invalid_input', message: 'Write at least 10 characters.', field: 'reason' } as never } })),
  'acc3-rates-contract-own-manager': () => contract('manager', { ...DETAIL, isMine: true, can: { edit: false, submit: false, approve: false, return: false, end: false } }),
  'acc3-rates-contract-active-manager': () => contract('manager', ACTIVE),
  'acc3-rates-contract-end-open': () => contract('manager', ACTIVE, { preview: { open: 'end' } }),
  'acc3-rates-contract-active-purchase': () => contract('purchase', { ...ACTIVE, can: { edit: false, submit: false, approve: false, return: false, end: false } }),
  'acc3-rates-contract-room-type-in-use': () =>
    contract('purchase', DRAFT_WITH_LINES, { actions: { ...PURCHASE_ACTIONS, roomTypeRemove: act(A.rcInUse) }, preview: { open: 'removeRoomType', state: { ok: false, code: 'in_use', message: 'This is used by an active contract.' } } }),
  'acc3-rates-contract-accounts': () => contract('accounts', ACTIVE),
  'acc3-rates-contract-ended': () => contract('accounts', ENDED),
  'acc3-rates-contract-off': () => contract('purchase', DRAFT_WITH_LINES, { enabled: false }),
  'acc3-rates-contract-error': () => contract('purchase', 'error'),
  'acc3-rates-contract-loading': () => shell(purchaseViewer, BASE, <RateContractLoading />),
  'acc3-rates-contract-no-access': () => shell(salesViewer, BASE, <RateContractNotFound />),

  /* Approvals › Rate contracts */
  'acc3-rates-approvals': () => approvals([ROWS[0]!, { ...ROWS[3]!, status: 'pending_approval', contractId: 'a0003599-0000-4000-8000-000000003599' }], { own: ['a0003599-0000-4000-8000-000000003599'] }),
  // Migration 0570: rows carry isMine / canApprove.
  'acc3-rates-approvals-is-mine': () => approvals([{ ...ROWS[0]!, canApprove: true }, { ...ROWS[3]!, status: 'pending_approval', contractId: 'a0003598-0000-4000-8000-000000003598', isMine: true, canApprove: false }]),
  'acc3-rates-approvals-empty': () => approvals([]),
  'acc3-rates-approvals-off': () => approvals([ROWS[0]!], { enabled: false }),
  'acc3-rates-approvals-error': () => approvals('error'),

  /* Settings › Imports › Rate sheet */
  'acc3-rates-import-columns': () => sheet(false),
  'acc3-rates-import-checked': () => sheet(true),

  /* Purchase offer form › contract rate */
  'acc3-rates-offer-pick': () => offer(undefined, { quoted: '' }),
  'acc3-rates-offer-matches': () => offer(picked(LOOKUP_OK), { quoted: '43000' }),
  'acc3-rates-offer-differs': () => offer(picked(LOOKUP_OK), { quoted: '45000' }),
  'acc3-rates-offer-differs-refused': () => offer(picked(LOOKUP_OK), { quoted: '45000', reasonError: 'Write why the offer differs from the contract (10 to 300 characters).' }),
  'acc3-rates-offer-no-contract': () => offer(picked(LOOKUP_NONE), { quoted: '40000' }),
  'acc3-rates-offer-partial': () => offer(picked(LOOKUP_PARTIAL), { quoted: '40000' }),
  'acc3-rates-offer-blackout': () => offer(picked(LOOKUP_BLACKOUT), { quoted: '40000' }),
  'acc3-rates-offer-ended': () => offer(picked(LOOKUP_ENDED), { quoted: '40000' }),
  'acc3-rates-offer-no-supplier': () => offer(undefined, { supplierChosen: false }),
  'acc3-rates-offer-typed-hotel': () => offer(undefined, { hotelName: null }),
};

export const ACC3_RATES_STATES = Object.keys(states);

export function renderAcc3RatesState(state: string): ReactNode | null {
  return states[state]?.() ?? null;
}
