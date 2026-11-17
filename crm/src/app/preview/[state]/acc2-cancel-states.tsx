import type { ReactNode } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import type { DeskResult } from '@/views/accounts-desk/desk-kit';
import type { FlightWorkActions } from '@/views/flight/actions';
import { FlightTripCancelledCard } from '@/views/flight/trip-cancelled';
import { FlightWorkspaceLoading, FlightWorkspacePage, type FlightWorkspaceProps } from '@/views/flight/workspace';
import { ManagerApprovalsPage } from '@/views/purchase/manager-approvals';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import type { VisaWorkActions } from '@/views/visa/actions';
import { VisaTripCancelledPanel } from '@/views/visa/trip-cancelled';
import type { VisaWorkspace } from '@/views/visa/types';
import { VisaTaskPage } from '@/views/visa/workspace';
import { APPROVED, BATCH, BATCH2, cancelMoney, EMPTY_APPROVALS, ENTERED, flightWs, MANAGER_CANCELLATIONS, MANAGER_DETAILS, VISA_APPROVED, VISA_OPEN, visaApplicantsDecided, visaApplicantsToDecide, visaCancelWs } from './acc2-cancel-fixtures';
import * as X from './acc2-cancel-preview-actions';
import { SUPPLIERS } from './flight-fixtures';
import * as F from './flight-preview-actions';
import * as V from './visa-preview-actions';

/*
 * Accounts phase 2 preview states (acc2-cancel-*), Track E: contract 11 items
 * 6–8. The Flight task "Trip cancelled" panel per ticket batch (open, entered,
 * dialog, refusal, approved with "Tickets cancelled", read-only), the Visa
 * task banner and panel (choices, refund expected, refusals, read-only), and
 * the Manager cancellation review with the Flight charges table and the
 * Visa-only case. Synthetic props only; rendered by the design-review
 * gallery only (a 404 outside local preview mode).
 */

const act = (a: unknown) => a as DecisionAction;

const flightViewer: ShellViewer = { displayName: 'Synthetic Flight Jodhpur', primaryRole: 'Flight', primaryBranch: 'Jodhpur', canAdministerStaff: false, canManageGrants: false, canSeeFlightTasks: true };
const visaViewer: ShellViewer = { displayName: 'Synthetic Visa Jodhpur', primaryRole: 'Visa', primaryBranch: 'Jodhpur', canAdministerStaff: false, canManageGrants: false, canSeeVisaDesk: true };
const managerViewer: ShellViewer = { displayName: 'Synthetic Manager Jodhpur', primaryRole: 'Manager', primaryBranch: 'Jodhpur', canAdministerStaff: false, canManageGrants: false, canSeeApprovals: true, canSeeLeads: true, canSeePurchaseTasks: true, canSeeFlightTasks: true, canSeeVisaDesk: true };

function shell(viewer: ShellViewer, path: string, body: ReactNode) {
  return (
    <StaffShell viewer={viewer} currentPath={path}>
      {body}
    </StaffShell>
  );
}

function flightActions(over: Partial<FlightWorkActions> = {}): FlightWorkActions {
  return {
    claim: act(F.flClaimAction),
    reassign: act(F.flReassignAction),
    applyBookingChange: act(F.flApplyAction),
    saveScreenshotSectors: act(F.flSaveSectorsAction),
    fillBlanks: act(F.flFillAction),
    submitChange: act(F.flSubmitChangeAction),
    withdrawChange: act(F.flWithdrawAction),
    acknowledgeChange: act(F.flAckAction),
    correctTicket: act(F.flCorrectAction),
    uploadFile: act(F.flUploadAction),
    complete: act(F.flCompleteAction),
    farePreview: act(F.flPreviewWithinAction),
    requestFareApproval: act(F.flAskManagerAction),
    withdrawFareApproval: act(F.flWithdrawFaresAction),
    confirmTickets: act(F.flConfirmAction),
    createSupplier: act(F.flCreateSupplierAction),
    saveDirectPayment: act(F.flDirectPaymentAction),
    createPaymentRequest: act(F.flPaymentRequestAction),
    setCancellationCharge: act(X.cxChargeOk),
    ...over,
  };
}

function flight(money: FlightWorkspaceProps['money'], over: Partial<FlightWorkspaceProps> = {}, viewer: ShellViewer = flightViewer) {
  const props: FlightWorkspaceProps = { ws: flightWs, tabs: { tabs: ['details', 'work', 'files', 'history'], current: 'work' }, actions: flightActions(), suppliers: SUPPLIERS, money, ...over };
  return shell(viewer, '/app/flight', <FlightWorkspacePage {...props} />);
}

/** Only the panel, under a task-like header (dialog and refusal states). */
function flightPanel(money: ReturnType<typeof cancelMoney>, action: DecisionAction, openBatch?: string, state?: DeskResult | null, typed?: { airlineChargeRupees?: string; refundExpectedRupees?: string }) {
  return shell(
    flightViewer,
    '/app/flight',
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Flight task · SYN-JOD-101" title="Jodhpur to Goa and back" />
      <FlightTripCancelledCard money={money} action={action} initialOpenBatchId={openBatch} initialState={state} initialTyped={typed} />
    </div>,
  );
}

function visaActions(over: Partial<VisaWorkActions> = {}): VisaWorkActions {
  return {
    claim: act(V.vsClaim),
    saveRow: act(V.vsRowSaved),
    addDocument: act(V.vsDocAdded),
    removeDocument: act(V.vsDocRemoved),
    apply: act(V.vsApplied),
    decide: act(V.vsDecided),
    setHandover: act(V.vsHandover),
    markDelivered: act(V.vsDelivered),
    withdraw: act(V.vsWithdrawn),
    reapply: act(V.vsReapplied),
    sendFee: act(V.vsFeeSent),
    saveOtherCost: act(V.vsOtherCost),
    confirmTraveller: act(V.vsConfirmed),
    uploadDocument: act(V.vsUploaded),
    uploadEvidence: act(V.vsEvidence),
    chooseCancellation: act(X.cxChoiceOk),
    setCancellationFee: act(X.cxFeeOk),
    ...over,
  };
}

function visa(ws: VisaWorkspace, viewer: ShellViewer = visaViewer, over: Partial<VisaWorkActions> = {}) {
  return shell(viewer, '/app/visa', <VisaTaskPage ws={ws} tabs={{ tabs: ['details', 'work', 'files', 'history'], current: 'work' }} actions={visaActions(over)} />);
}

function visaPanel(ws: VisaWorkspace, preview: Parameters<typeof VisaTripCancelledPanel>[0]['preview'], over: Partial<VisaWorkActions> = {}) {
  const a = visaActions(over);
  return shell(
    visaViewer,
    '/app/visa',
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Visa task · SYN-JOD-701" title="France · Tourism" />
      <VisaTripCancelledPanel ws={ws} actions={{ chooseCancellation: a.chooseCancellation, setCancellationFee: a.setCancellationFee }} preview={preview} />
    </div>,
  );
}

const visaApprovedWs = visaCancelWs(VISA_APPROVED, visaApplicantsToDecide);
const firstApp = visaApplicantsToDecide[0]!;

function manager(view = { ...EMPTY_APPROVALS, cancellations: MANAGER_CANCELLATIONS }, details = MANAGER_DETAILS) {
  return shell(
    managerViewer,
    '/app/approvals',
    <ManagerApprovalsPage view={view} cancellationDetails={details} today="2026-11-11" actions={{ decidePayment: act(X.cxDecideOk), decideFunding: act(X.cxDecideOk), decideCancellation: act(X.cxDecideOk) }} />,
  );
}

const states: Record<string, () => ReactNode> = {
  /* Flight task (contract 11 item 6) */
  'acc2-cancel-flight-open': () => flight(cancelMoney()),
  'acc2-cancel-flight-entered': () => flight(cancelMoney(ENTERED, { ...ENTERED, airlineChargePaise: '1440000', refundExpectedPaise: '0' })),
  'acc2-cancel-flight-dialog': () => flightPanel(cancelMoney(ENTERED), act(X.cxChargeOk), BATCH),
  'acc2-cancel-flight-refused': () =>
    flightPanel(cancelMoney(), act(X.cxChargeTooHigh), BATCH2, { ok: false, code: 'invalid_input', message: 'Check the highlighted field: the airline charge cannot be more than the supplier cost.', field: 'airlineChargePaise' } as DeskResult, { airlineChargeRupees: '15000', refundExpectedRupees: '0' }),
  'acc2-cancel-flight-version-changed': () => flightPanel(cancelMoney(ENTERED), act(X.cxChargeVersionChanged), BATCH, { ok: false, code: 'version_changed', message: 'Someone changed this meanwhile. Reload and try again.' }),
  'acc2-cancel-flight-approved': () => flight(cancelMoney(APPROVED, { ...APPROVED, airlineChargePaise: '1440000', refundExpectedPaise: '0', refundReportedPaise: null, supplierRefundReceivedPaise: '0' }, true)),
  'acc2-cancel-flight-approved-dialog': () => flightPanel(cancelMoney(APPROVED, { ...APPROVED }, true), act(X.cxChargeOk), BATCH),
  'acc2-cancel-flight-not-yours': () =>
    flight(cancelMoney({ ...ENTERED, canEnter: false }, { canEnter: false }), { ws: { ...flightWs, canWork: false, assignee: { ...flightWs.assignee, isYou: false, name: 'Synthetic Flight Delhi' } }, actions: flightActions({ setCancellationCharge: undefined }) }),
  'acc2-cancel-flight-manager': () =>
    flight(cancelMoney({ ...ENTERED, canEnter: false }, { ...ENTERED, canEnter: false }), { ws: { ...flightWs, canWork: false, assignee: { ...flightWs.assignee, isYou: false } }, actions: flightActions({ setCancellationCharge: undefined }) }, managerViewer),
  'acc2-cancel-flight-error': () => flight('error'),
  'acc2-cancel-flight-loading': () => shell(flightViewer, '/app/flight', <FlightWorkspaceLoading />),

  /* Visa task (contract 11 item 7) */
  'acc2-cancel-visa-open': () => visa(visaCancelWs(VISA_OPEN, visaApplicantsToDecide)),
  'acc2-cancel-visa-approved': () => visa(visaApprovedWs),
  'acc2-cancel-visa-choice-dialog': () => visaPanel(visaApprovedWs, { choiceFor: firstApp.applicationId }),
  'acc2-cancel-visa-choice-refused': () =>
    visaPanel(visaApprovedWs, { choiceFor: firstApp.applicationId, state: { ok: false, code: 'invalid_input', message: 'Check the highlighted field: write 10 to 300 characters.', field: 'reason' } as DeskResult }, { chooseCancellation: act(X.cxChoiceReason) }),
  'acc2-cancel-visa-fee-dialog': () => visaPanel(visaApprovedWs, { feeFor: firstApp.fees[1]!.entryId }),
  'acc2-cancel-visa-fee-refused': () =>
    visaPanel(visaApprovedWs, { feeFor: firstApp.fees[0]!.entryId, state: { ok: false, code: 'version_changed', message: 'Someone changed this meanwhile. Reload and try again.' } }, { setCancellationFee: act(X.cxFeeVersionChanged) }),
  'acc2-cancel-visa-decided': () => visa(visaCancelWs(VISA_APPROVED, visaApplicantsDecided)),
  'acc2-cancel-visa-nothing': () => visa(visaCancelWs(VISA_APPROVED, [visaApplicantsToDecide[3]!])),
  'acc2-cancel-visa-manager': () =>
    visa(
      visaCancelWs(
        VISA_APPROVED,
        visaApplicantsToDecide.map((a) => ({ ...a, canChooseCancellation: false })),
        { canWork: false, isManagerView: true, canManageFees: false, assignee: { name: 'Synthetic Visa Jodhpur', isYou: false, takenAt: '2026-11-03T05:30:00Z' } },
        false,
      ),
      managerViewer,
    ),

  /* Manager cancellation review (contract 11 item 8) */
  'acc2-cancel-manager-review': () => manager(),
  'acc2-cancel-manager-not-decider': () =>
    manager({ ...EMPTY_APPROVALS, cancellations: [{ ...MANAGER_CANCELLATIONS[0]!, canDecide: false }] }, [{ ...MANAGER_DETAILS[0]!, canDecide: false }]),
  'acc2-cancel-manager-empty': () => manager(EMPTY_APPROVALS, []),
};

export const ACC2_CANCEL_STATES = Object.keys(states);

export function renderAcc2CancelState(state: string): ReactNode | null {
  return states[state]?.() ?? null;
}
