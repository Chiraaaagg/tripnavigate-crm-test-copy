import type { ReactNode } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import type { TaskTab } from '@/modules/settings/contracts';
import { toTaskHistoryVM } from '@/views/department/task-history-vm';
import type { DealFlightActions, FlightWorkActions, ManagerFlightActions } from '@/views/flight/actions';
import { DealHistoryTab } from '@/views/deal-workspace/history';
import { DealFlightCard } from '@/views/flight/deal-flight-card';
import { FlightFaresApprovals } from '@/views/flight/manager-fares';
import { FlightQueuePage } from '@/views/flight/queue';
import { FlightWorkspaceLoading, FlightWorkspaceNotFound, FlightWorkspacePage, type FlightWorkspaceProps } from '@/views/flight/workspace';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { HomeView, NO_HOME_ROLES } from '@/views/home-view';
import { ManagerApprovalsPage } from '@/views/purchase/manager-approvals';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import {
  BATCH,
  DEAL,
  ctxDirect,
  ctxOver,
  DEAL_SUMMARY,
  diff,
  FARE_ROWS,
  flight1,
  flight2,
  money,
  PNR_GROUPS,
  PNR_RETURN,
  pendingChange,
  pendingSector,
  progress,
  queueGroups,
  S1,
  S2,
  S3,
  status,
  SUPPLIERS,
  T1,
  ticket,
  ticketedFlight1,
  workspace,
} from './flight-fixtures';
import * as A from './flight-preview-actions';

/*
 * Flight build preview states (fl-): the grouped queue, the Flight workspace
 * in each state, the Confirm tickets popup (within / over / approved budget:
 * open it from the Work tab), payment drawers, the Deal page approval card,
 * Manager Approvals and Home rows. Synthetic props only; rendered by the
 * design-review gallery only.
 */

const flightViewer: ShellViewer = {
  displayName: 'Synthetic Flight Jodhpur',
  primaryRole: 'Flight',
  primaryBranch: 'Jodhpur',
  canAdministerStaff: false,
  canManageGrants: false,
  canSeeFlightTasks: true,
};
const managerViewer: ShellViewer = { ...flightViewer, displayName: 'Synthetic Manager Jodhpur', primaryRole: 'Manager', canSeeApprovals: true, canSeeLeads: true };
const salesViewer: ShellViewer = { ...flightViewer, displayName: 'Synthetic Sales Jodhpur', primaryRole: 'Sales', canSeeFlightTasks: false };

const act = (a: unknown) => a as DecisionAction;

function actions(over: Partial<FlightWorkActions> = {}): FlightWorkActions {
  return {
    claim: act(A.flClaimAction),
    reassign: act(A.flReassignAction),
    applyBookingChange: act(A.flApplyAction),
    saveScreenshotSectors: act(A.flSaveSectorsAction),
    fillBlanks: act(A.flFillAction),
    submitChange: act(A.flSubmitChangeAction),
    withdrawChange: act(A.flWithdrawAction),
    acknowledgeChange: act(A.flAckAction),
    correctTicket: act(A.flCorrectAction),
    uploadFile: act(A.flUploadAction),
    complete: act(A.flCompleteAction),
    farePreview: act(A.flPreviewWithinAction),
    requestFareApproval: act(A.flAskManagerAction),
    withdrawFareApproval: act(A.flWithdrawFaresAction),
    confirmTickets: act(A.flConfirmAction),
    createSupplier: act(A.flCreateSupplierAction),
    saveDirectPayment: act(A.flDirectPaymentAction),
    createPaymentRequest: act(A.flPaymentRequestAction),
    invoices: { uploadSupplierFile: act(A.flInvoiceUploadAction), saveInvoice: act(A.flInvoiceSaveAction) },
    suppliers: { createSupplier: act(A.flCreateSupplierAction), addBeneficiary: act(A.flBeneficiaryAction), updateSupplier: act(A.flUpdateSupplierAction) },
    ...over,
  };
}

const dealActions: DealFlightActions = { decideChange: act(A.flDecideChangeAction) };
const managerActions: ManagerFlightActions = { decideFares: act(A.flDecideFaresAction) };

function shell(viewer: ShellViewer, path: string, body: ReactNode) {
  return (
    <StaffShell viewer={viewer} currentPath={path}>
      {body}
    </StaffShell>
  );
}

function ws(tab: TaskTab, p: Partial<FlightWorkspaceProps> & Pick<FlightWorkspaceProps, 'ws'>, viewer: ShellViewer = flightViewer) {
  const props: FlightWorkspaceProps = {
    tabs: { tabs: ['details', 'work', 'files', 'history'], current: tab },
    actions: actions(),
    suppliers: SUPPLIERS,
    money: money({ batches: [] }),
    eTicketBase: '/preview/flight-ws-files#',
    ...p,
  };
  return shell(viewer, '/app/flight', <FlightWorkspacePage {...props} />);
}

/* Workspace variants */
const notTaken = workspace({
  assignee: { name: null, isYou: false },
  assigneeUserId: null,
  canWork: false,
  canTake: true,
  status: status('waiting'),
  progress: progress('take'),
  doneIssues: [],
  canUploadETicket: false,
  flights: [flight1({ status: status('waiting'), sectors: [] }), flight2({ status: status('waiting') })],
});

const withScreenshot = workspace({ doneIssues: ['tickets_pending', 'payment_missing', 'eticket_missing'], flights: [flight1(), flight2({ sectors: [S3], status: status('in_progress', 0, 3) })], status: status('in_progress', 0, 9), progress: progress('tickets', { tickets: '0 of 9' }) });

const pendingPkg = workspace({
  status: status('in_progress', 0, 9),
  progress: progress('approvals', { approvals: 'Waiting', tickets: '0 of 9' }, true),
  doneIssues: ['change_pending', 'tickets_pending', 'eticket_missing'],
  flights: [
    flight1({
      sectors: [{ ...S1, travellers: S1.travellers.map((t) => (t.seq === 2 ? { ...t, held: true, heldByChangeNo: 1 } : t)) }, S2, pendingSector],
      changes: [pendingChange],
    }),
    flight2({ sectors: [S3], status: status('in_progress', 0, 3), unnamedCount: 0 }),
  ],
});

const flightOnly = workspace({
  dealKind: 'flight_only',
  dealReference: 'SYN-JOD-905',
  flights: [
    flight1({
      title: 'JDH → BOM → GOI',
      changes: [{ ...pendingChange, status: 'approved', deciderKind: 'flight_owner', deciderName: 'Synthetic Flight Jodhpur', decidedAt: '2026-11-04T07:10:00Z', decidedByName: 'Synthetic Flight Jodhpur', canWithdraw: false, needsAck: false }],
    }),
  ],
});

const bookingChanged = workspace({
  status: status('in_progress', 0, 9),
  progress: progress('tickets', { tickets: '0 of 9' }),
  doneIssues: ['booking_changed', 'tickets_pending', 'eticket_missing'],
  flights: [flight1({ bookingChanged: diff, currentVersionNo: 3 }), flight2({ sectors: [S3], status: status('in_progress', 0, 3), unnamedCount: 0 })],
});

const ticketed = workspace({
  status: status('in_progress', 6, 9),
  progress: progress('tickets', { tickets: '6 of 9', payment: '0 of 1 batches' }),
  doneIssues: ['tickets_pending', 'traveller_changed', 'payment_missing', 'eticket_missing'],
  flights: [
    ticketedFlight1({
      sectors: ticketedFlight1().sectors.map((s) => ({ ...s, travellers: s.travellers.map((t) => (t.seq === 3 && s.sectorId === S2.sectorId ? { ...t, ticket: ticket(3, { travellerChanged: true, revisionNo: 2, history: [{ revisionNo: 1, crsType: 'amadeus', crsPnr: 'SYNCR1', airlinePnr: 'SYNAI7', ticketNumber: '098-2410000099', reason: null, at: '2026-11-04T08:30:00Z', byName: 'Synthetic Flight Jodhpur' }, { revisionNo: 2, crsType: 'amadeus', crsPnr: 'SYNCR1', airlinePnr: 'SYNAI7', ticketNumber: '098-2410000003', reason: 'Typed the wrong last digits (synthetic).', at: '2026-11-04T09:00:00Z', byName: 'Synthetic Flight Jodhpur' }] }) } : t)) })),
    }),
    flight2({ sectors: [S3], status: status('in_progress', 0, 3), unnamedCount: 0 }),
  ],
  ticketsByPnr: PNR_GROUPS,
});

const ready = workspace({
  status: status('all_confirmed', 9, 9),
  progress: progress('done', { tickets: '9 of 9', payment: '1 of 1 batches' }),
  doneIssues: [],
  canComplete: true,
  flights: [
    ticketedFlight1(),
    flight2({
      unnamedCount: 0,
      status: status('all_confirmed', 3, 3),
      sectors: [{ ...S3, canEditScreenshot: false, canAlternate: false, travellers: S3.travellers.map((t) => ({ ...t, ticket: ticket(10 + t.seq, { crsType: 'airline_direct', crsPnr: null, airlinePnr: 'SYN6E9', ticketNumber: `312-24100000${String(10 + t.seq).padStart(2, '0')}`, batchNo: 2 }) })) }],
    }),
  ],
  ticketsByPnr: [...PNR_GROUPS, PNR_RETURN],
  eTickets: [{ evidenceId: 'e0000000-0000-4000-8000-000000000551', taskId: T1, fileName: 'synthetic-e-ticket.pdf', mime: 'application/pdf', sizeBytes: 182000, storedAt: '2026-11-04T09:30:00Z', uploadedByName: 'Synthetic Flight Jodhpur' }],
});

const done = workspace({
  ...ready,
  canWork: false,
  canComplete: false,
  canUploadETicket: false,
  status: status('done'),
  progress: progress('done').map((s) => ({ ...s, state: 'done' as const })),
  completedAt: '2026-11-04T10:00:00Z',
  completedByName: 'Synthetic Flight Jodhpur',
  flights: ready.flights.map((f) => ({ ...f, status: status('done') })),
});

const managerView = workspace({
  ...ticketed,
  assignee: { name: 'Synthetic Flight Jodhpur', isYou: false },
  canWork: false,
  canReassign: true,
  reassignCandidates: [{ userId: 'e0000000-0000-4000-8000-000000000012', name: 'Synthetic Flight Colleague' }],
  doneIssues: [],
  canUploadETicket: false,
});

const HISTORY = toTaskHistoryVM(
  {
    taskId: T1,
    department: 'flight',
    truncated: false,
    events: [
      { kind: 'reassigned', at: '2026-11-04T08:40:00Z', byYou: false, byName: 'Synthetic Manager Jodhpur', toYou: true, toName: null, note: 'Leave cover for the week (synthetic).', applicantSeq: null, state: null },
      { kind: 'taken', at: '2026-11-04T06:00:00Z', byYou: true, byName: null, toYou: false, toName: null, note: null, applicantSeq: null, state: null },
      { kind: 'created', at: '2026-11-03T12:00:00Z', byYou: false, byName: null, toYou: false, toName: null, note: null, applicantSeq: null, state: null },
    ],
  } as never,
  'flight',
);

const queue = { groups: queueGroups() };

/** As the server sends it above ₹50,000 for the supplier: no direct payment, a request routed to the Manager. */
function overLimit(m: ReturnType<typeof money>) {
  return { ...m, batches: m.batches.map((b) => ({ ...b, canPayDirect: false, canRequest: true, routePreview: 'manager' as const })) };
}

function nameFillState(slots: Array<{ seq: number; type: 'adult' | 'child' | 'infant' | null }>, fillName: DecisionAction = act(A.flFillNameAction), initial?: import('@/views/accounts/supplier-forms').UiResult) {
  return shell(
    salesViewer,
    '/app/deals',
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Deal · SYN-JOD-901" title="Synthetic family trip to Goa" />
      <DealFlightCard
        dealId={DEAL}
        summary={{
          ...DEAL_SUMMARY,
          nameFill: { versionId: 'b0000000-0000-4000-8000-000000000002', slots },
          flights: DEAL_SUMMARY.flights.map((f) => ({ ...f, pending: [], unnamedCount: slots.length })),
        }}
        actions={{ decideChange: act(A.flDecideChangeAction), fillName }}
        viewerIsSalesOwner
        nameFillInitialState={initial}
      />
    </div>,
  );
}

const states: Record<string, () => ReactNode> = {
  'flight-queue': () => shell(flightViewer, '/app/flight', <FlightQueuePage queue={queue} canTakeTasks show="not_taken" />),
  'flight-queue-mine': () => shell(flightViewer, '/app/flight', <FlightQueuePage queue={queue} canTakeTasks show="mine" />),
  'flight-queue-mine-ready': () => shell(flightViewer, '/app/flight', <FlightQueuePage queue={queue} canTakeTasks show="mine" only="ready" />),
  'flight-queue-mine-decisions': () => shell(flightViewer, '/app/flight', <FlightQueuePage queue={queue} canTakeTasks show="mine" only="change_decision" />),
  'flight-queue-all': () => shell(flightViewer, '/app/flight', <FlightQueuePage queue={queue} canTakeTasks show="all" />),
  'flight-queue-empty': () => shell(flightViewer, '/app/flight', <FlightQueuePage queue={{ groups: [] }} canTakeTasks show="not_taken" />),
  'flight-queue-manager': () => shell(managerViewer, '/app/flight', <FlightQueuePage queue={queue} canTakeTasks={false} show="all" />),
  'flight-ws-loading': () => shell(flightViewer, '/app/flight', <FlightWorkspaceLoading />),
  'flight-ws-not-found': () => shell(flightViewer, '/app/flight', <FlightWorkspaceNotFound />),
  'flight-ws-not-taken': () => ws('details', { ws: notTaken, money: null }),
  'flight-ws-claim-conflict': () => ws('details', { ws: notTaken, money: null, actions: actions({ claim: act(A.flClaimConflictAction) }) }),
  'flight-ws-details': () => ws('details', { ws: withScreenshot, money: money({ batches: [] }) }),
  'flight-ws-details-identity': () =>
    ws('details', {
      ws: workspace({
        tripScope: 'international',
        flights: [
          flight1({
            travellers: [
              { seq: 1, fullName: 'Example Traveller One', type: 'adult', ageYears: 41, specialNeeds: null, identity: { dateOfBirth: '1985-02-11', nationality: 'Indian', passportNumber: 'S0000001', passportExpiry: '2031-05-01' } },
            ],
          }),
        ],
      }),
      money: money({ batches: [] }),
    }),
  'flight-ws-work': () => ws('work', { ws: workspace() }),
  'flight-ws-screenshot': () => ws('work', { ws: withScreenshot }),
  'flight-ws-pending-package': () => ws('work', { ws: pendingPkg }),
  'flight-ws-change-refused': () => ws('work', { ws: workspace(), actions: actions({ submitChange: act(A.flSubmitChangeRefusedAction) }) }),
  'flight-ws-flight-only': () => ws('work', { ws: flightOnly, money: money({ dealKind: 'flight_only', batches: [] }) }),
  'flight-ws-booking-changed': () => ws('work', { ws: bookingChanged }),
  'flight-ws-popup-within': () => ws('work', { ws: withScreenshot }),
  'flight-ws-popup-over': () => ws('work', { ws: withScreenshot, actions: actions({ farePreview: act(A.flPreviewOverAction) }) }),
  'flight-ws-popup-approved': () =>
    ws('work', {
      ws: withScreenshot,
      actions: actions({ farePreview: act(A.flPreviewApprovedAction) }),
      approvalSets: [
        {
          approvalId: 'a0000000-0000-4000-8000-0000000000a1',
          approvalNo: 1,
          status: 'approved',
          rowVersion: 2,
          fareHash: 'a'.repeat(64),
          supplierId: SUPPLIERS[0]!.supplierId,
          supplierName: SUPPLIERS[0]!.name,
          sectorIds: [S1.sectorId, S2.sectorId],
          travellers: [
            { seq: 1, type: 'adult' },
            { seq: 2, type: 'adult' },
            { seq: 3, type: 'child' },
          ],
          fares: [
            { paxType: 'adult', basicPaise: '1500000', kPaise: '50000', yqPaise: '120000', yrPaise: '20000', otherPaise: '10000', markupPaise: null, discountPaise: null, paxCount: 2 },
            { paxType: 'child', basicPaise: '1200000', kPaise: '50000', yqPaise: '120000', yrPaise: '20000', otherPaise: '10000', markupPaise: null, discountPaise: null, paxCount: 1 },
          ],
        },
      ],
      money: money({ batches: [], approvals: [{ approvalId: 'a0000000-0000-4000-8000-0000000000a1', approvalNo: 1, status: 'approved', batchSupplierCostPaise: '5040000', projectedSupplierCostPaise: '5040000', budgetPaise: '4200000', requestedAt: '2026-11-04T08:05:00Z', requestedByName: 'Synthetic Flight Jodhpur', decidedAt: '2026-11-04T08:20:00Z', decidedByName: 'Synthetic Manager Jodhpur', returnReason: null, rowVersion: 2, canDecide: false, canWithdraw: false }] }),
    }),
  'flight-ws-popup-refused': () => ws('work', { ws: withScreenshot, actions: actions({ confirmTickets: act(A.flConfirmRefusedAction) }) }),
  'flight-ws-tickets': () => ws('work', { ws: ticketed, money: money(), paymentContexts: { [BATCH]: ctxDirect } }),
  'flight-ws-legacy-paid': () =>
    ws('work', {
      ws: ticketed,
      money: (() => {
        const m = money();
        m.batches = m.batches.map((b) => ({ ...b, legacyPaidPaise: '1200000', duePaise: '2160000' }));
        return m;
      })(),
      paymentContexts: { [BATCH]: { ...ctxDirect, amountPaise: '2160000', supplierCostPaise: '3360000', legacyPaidPaise: '1200000' } },
    }),
  'flight-ws-flight-only-margins': () =>
    ws('work', {
      ws: { ...ticketed, dealKind: 'flight_only' },
      money: (() => {
        const m = money({ dealKind: 'flight_only', customerTotalPaise: '3660000' });
        m.batches = m.batches.map((b) => ({
          ...b,
          customerTotalPaise: '3660000',
          fares: b.fares!.map((f) => ({ ...f, markupPaise: '50000', discountPaise: '0', totalPerPersonPaise: String(BigInt(f.supplierPerPersonPaise) + 50000n), customerAmountPaise: String((BigInt(f.supplierPerPersonPaise) + 50000n) * BigInt(f.paxCount)) })),
        }));
        return m;
      })(),
      paymentContexts: { [BATCH]: ctxDirect },
    }),
  'flight-ws-flight-only-purchase-holder': () => ws('work', { ws: { ...withScreenshot, dealKind: 'flight_only' }, money: money({ dealKind: 'flight_only', batches: [], marginsAllowed: false }) }),
  'flight-ws-flight-only-no-margins': () =>
    ws('work', { ws: { ...ticketed, dealKind: 'flight_only' }, money: money({ dealKind: 'flight_only' }), paymentContexts: { [BATCH]: ctxDirect } }),
  'flight-ws-payment-over': () => ws('work', { ws: ticketed, money: overLimit(money({}, { state: 'unpaid', route: null })), paymentContexts: { [BATCH]: ctxOver } }),
  'flight-ws-payment-over-flight-only': () =>
    ws('work', { ws: { ...ticketed, dealKind: 'flight_only' }, money: overLimit(money({ dealKind: 'flight_only', marginsAllowed: true }, { state: 'unpaid', route: null })), paymentContexts: { [BATCH]: ctxOver } }),
  'flight-ws-payment-returned': () =>
    ws('work', { ws: ticketed, money: money({}, { state: 'direct_returned', route: 'direct', returnReason: 'The bank slip is unreadable. Upload a clearer copy (synthetic).', entryRowVersion: 2 }), paymentContexts: { [BATCH]: { ...ctxDirect, proofs: [{ evidenceId: 'e0000000-0000-4000-8000-000000000561', fileName: 'synthetic-bank-slip.pdf' }] } } }),
  'flight-ws-ready': () => ws('work', { ws: ready, money: money({}, { state: 'direct_submitted', route: 'direct' }), actions: actions({ complete: act(A.flCompleteOkAction) }) }),
  'flight-ws-done': () => ws('work', { ws: done, money: money({}, { state: 'direct_accepted', route: 'direct' }) }),
  'flight-ws-invoice-missing': () =>
    ws('work', { ws: done, money: money({ invoiceMissing: true, invoices: [] }, { state: 'direct_accepted', route: 'direct' }) }),
  'flight-ws-invoices': () =>
    ws('work', {
      ws: done,
      money: money(
        {
          invoiceMissing: false,
          invoices: [
            { documentId: 'd0000000-0000-4000-8000-000000000771', supplierId: SUPPLIERS[0]!.supplierId, number: 'SYN-INV-1042', docDate: '2026-11-20', totalPaise: '3360000', status: 'returned' },
            { documentId: 'd0000000-0000-4000-8000-000000000772', supplierId: SUPPLIERS[0]!.supplierId, number: 'SYN-INV-1043', docDate: '2026-11-21', totalPaise: '3360000', status: 'uploaded' },
          ],
        },
        { state: 'direct_accepted', route: 'direct' },
      ),
    }),
  'flight-ws-suppliers': () => ws('work', { ws: ticketed, money: money(), paymentContexts: { [BATCH]: ctxDirect } }),
  'flight-ws-bank-refused': () =>
    ws('work', { ws: ticketed, money: money(), paymentContexts: { [BATCH]: ctxDirect }, actions: actions({ suppliers: { createSupplier: act(A.flCreateSupplierAction), addBeneficiary: act(A.flBeneficiaryRefusedAction) } }) }),
  'flight-ws-files': () => ws('files', { ws: ready, money: money({ invoiceMissing: true }, { state: 'direct_submitted', route: 'direct' }), files: { flight: [{ fileId: 'b0000000-0000-4000-8000-000000000501', kind: 'flight_screenshot', fileName: 'synthetic-fare-quote.png', sizeLabel: '240 KB', uploadedAt: '2026-11-03T12:00:00Z', uploadedByYou: false, downloadHref: '/preview/flight-ws-files' }] as never } }),
  'flight-ws-history': () => ws('history', { ws: pendingPkg, history: HISTORY }),
  'flight-ws-manager': () => ws('work', { ws: managerView, money: money() }, managerViewer),
  'flight-deal-approval': () =>
    shell(
      salesViewer,
      '/app/deals',
      <div className="flex flex-col gap-5">
        <PageHeader eyebrow="Deal · SYN-JOD-901" title="Synthetic family trip to Goa" />
        <DealFlightCard summary={DEAL_SUMMARY} actions={dealActions} viewerIsSalesOwner eTicketBase="/preview/flight-deal-approval#" />
      </div>,
    ),
  'flight-deal-name-fill': () => nameFillState([{ seq: 4, type: 'adult' }, { seq: 5, type: 'child' }]),
  'flight-deal-name-fill-type-unknown': () => nameFillState([{ seq: 4, type: null }]),
  'flight-deal-name-fill-refused': () =>
    nameFillState([{ seq: 4, type: 'adult' }], act(A.flFillNameRefusedAction), { ok: false, code: 'name_already_set', message: 'This traveller already has a name. Reload the page to see it.' }),
  'flight-deal-name-fill-success': () => nameFillState([{ seq: 4, type: 'adult' }], act(A.flFillNameAction), { ok: true, message: 'Name saved. The Flight team can now book this traveller.' }),
  'flight-deal-flights': () =>
    shell(
      salesViewer,
      '/app/deals',
      <div className="flex flex-col gap-5">
        <PageHeader eyebrow="Deal · SYN-JOD-901" title="Synthetic family trip to Goa" />
        <DealFlightCard summary={{ ...DEAL_SUMMARY, flights: DEAL_SUMMARY.flights.map((f) => ({ ...f, pending: [] })) }} />
      </div>,
    ),
  'flight-deal-history': () =>
    shell(
      salesViewer,
      '/app/deals',
      <div className="flex flex-col gap-5">
        <PageHeader eyebrow="Deal · SYN-JOD-901" title="Synthetic family trip to Goa" />
        <DealHistoryTab
          history={{
            state: 'ok',
            events: [
              { kind: 'booking_version', id: 'bv-2', at: '2026-11-03T12:00:00Z', versionNo: 2, statusText: 'Submitted', changeClass: null },
              { kind: 'flight_event', id: 'fe-2', at: '2026-11-04T07:30:00Z', flightKind: 'change_rejected', taskId: T1, flightTitle: 'JDH → BOM → GOI', byName: null, byYou: true, note: 'The customer wants the morning flight (synthetic).', changeNo: 1 },
              { kind: 'flight_event', id: 'fe-1', at: '2026-11-04T06:00:00Z', flightKind: 'taken', taskId: T1, flightTitle: 'JDH → BOM → GOI', byName: 'Synthetic Flight Jodhpur', byYou: false, note: null, changeNo: null },
            ],
          }}
        />
      </div>,
    ),
  'flight-deal-history-unavailable': () =>
    shell(
      salesViewer,
      '/app/deals',
      <div className="flex flex-col gap-5">
        <PageHeader eyebrow="Deal · SYN-JOD-901" title="Synthetic family trip to Goa" />
        <DealHistoryTab history={{ state: 'ok', events: [{ kind: 'booking_version', id: 'bv-2', at: '2026-11-03T12:00:00Z', versionNo: 2, statusText: 'Submitted', changeClass: null }], flightUnavailable: true }} />
      </div>,
    ),
  'flight-deal-history-unavailable-only': () =>
    shell(
      salesViewer,
      '/app/deals',
      <div className="flex flex-col gap-5">
        <PageHeader eyebrow="Deal · SYN-JOD-901" title="Synthetic family trip to Goa" />
        <DealHistoryTab history={{ state: 'ok', events: [], flightUnavailable: true }} />
      </div>,
    ),
  'flight-approvals': () =>
    shell(
      managerViewer,
      '/app/approvals',
      <ManagerApprovalsPage
        view={{
          costsAboveBudget: [],
          payments: [],
          funding: [],
          bankDetails: [
            { supplierId: SUPPLIERS[1]!.supplierId, supplierName: SUPPLIERS[1]!.name, revisionNo: 1, accountHolder: 'Synthetic Airline Direct', bankName: 'Example Bank', ifsc: 'EXMP0000002', accountLast4: '9876', createdAt: '2026-11-04T08:00:00Z', createdByName: 'Synthetic Flight Jodhpur', canApprove: true },
          ],
          suppliersToVerify: [{ supplierId: SUPPLIERS[1]!.supplierId, name: SUPPLIERS[1]!.name, city: null, serviceTypes: ['flight'], rowVersion: 1, updatedAt: '2026-11-04T08:00:00Z', canVerify: true }],
          cancellations: [],
          flightFares: FARE_ROWS as never,
        }}
        today="2026-11-04"
        actions={{ decidePayment: act(A.flDecideFaresAction), decideFunding: act(A.flDecideFaresAction), decideCancellation: act(A.flDecideFaresAction) } as never}
        flightSection={<FlightFaresApprovals rows={FARE_ROWS} actions={managerActions} />}
      />,
    ),
  'flight-approvals-empty': () =>
    shell(
      managerViewer,
      '/app/approvals',
      <ManagerApprovalsPage
        view={{ costsAboveBudget: [], payments: [], funding: [], bankDetails: [], suppliersToVerify: [], cancellations: [], flightFares: [] }}
        today="2026-11-04"
        actions={{ decidePayment: act(A.flDecideFaresAction), decideFunding: act(A.flDecideFaresAction), decideCancellation: act(A.flDecideFaresAction) } as never}
      />,
    ),
  'flight-home-flight': () =>
    shell(
      flightViewer,
      '/app',
      <HomeView
        displayName="Synthetic Flight Jodhpur"
        counts={{ visible: 4, owned: 0, assigned: 2 }}
        roles={{ ...NO_HOME_ROLES, flight: true }}
        myWork={{ waitingForMe: 3 } as never}
        flight={{ flightDealsNotTaken: 2, flightDealsMine: 1, flightBookingChanged: 1, flightChangesDecided: 1, flightReadyToFinish: 0, salesFlightChangesToDecide: null, salesTravellersToName: null, flightTravellersNamed: 2 }}
        supplierMoney={{ flightPaymentsReturned: 1, flightPaymentsMissing: 1 } as never}
      />,
    ),
  'flight-home-multi': () =>
    shell(
      { ...flightViewer, canSeePurchaseTasks: true },
      '/app',
      <HomeView
        displayName="Synthetic Flight and Purchase"
        counts={{ visible: 6, owned: 0, assigned: 3 }}
        roles={{ ...NO_HOME_ROLES, flight: true, purchase: true }}
        myWork={{ waitingForMe: 5 } as never}
        flight={{ flightDealsNotTaken: 2, flightDealsMine: 1, flightBookingChanged: 0, flightChangesDecided: 0, flightReadyToFinish: 1, salesFlightChangesToDecide: null, salesTravellersToName: null }}
      />,
    ),
  'flight-home-sales': () =>
    shell(
      salesViewer,
      '/app',
      <HomeView
        displayName="Synthetic Sales Jodhpur"
        counts={{ visible: 12, owned: 9, assigned: 0 }}
        roles={{ ...NO_HOME_ROLES, bookings: true }}
        myWork={{ waitingForMe: 0, draftsToContinue: 0, returnedToMe: 0, missingDetails: 0, intakeNeeded: 1 } as never}
        flight={{ flightDealsNotTaken: null, flightDealsMine: null, flightBookingChanged: null, flightChangesDecided: null, flightReadyToFinish: null, salesFlightChangesToDecide: 1, salesTravellersToName: 2, salesFlightChangesToDecideDealId: 'd0000000-0000-4000-8000-000000000900', salesTravellersToNameDealId: null }}
      />,
    ),
};

/*
 * Older flight state names (B1, Batch 4, B1.1) now render the Flight build
 * screens: the retired per-task screens ("Take this task", "Confirmed by
 * supplier", "Traveller names are not shown", the manual flight cost card)
 * are no longer shown anywhere in the gallery.
 */
const LEGACY_ALIASES: Record<string, string> = {
  'flight-task-open': 'flight-ws-not-taken',
  'flight-task-mine': 'flight-ws-work',
  'flight-task-claim-conflict': 'flight-ws-claim-conflict',
  'flight-task-issued': 'flight-ws-done',
  'flight-task-not-found': 'flight-ws-not-found',
  'b4-flight-queue': 'flight-queue',
  'b4-flight-queue-mine': 'flight-queue-mine',
  'b4-flight-queue-all': 'flight-queue-all',
  'b4-flight-task-details': 'flight-ws-details',
  'b4-flight-task-work': 'flight-ws-work',
  'b4-flight-task-files': 'flight-ws-files',
  'b4-flight-task-history': 'flight-ws-history',
  'b4-flight-task-not-taken': 'flight-ws-not-taken',
  'b11-flight-task-cost-empty': 'flight-ws-tickets',
  'b11-flight-task-identity': 'flight-ws-details-identity',
  'b11-flight-task-cost-filled': 'flight-ws-payment-returned',
  'b11-flight-task-cost-over-limit': 'flight-ws-payment-over',
  'b11-flight-task-cost-sent': 'flight-ws-ready',
};
for (const [from, to] of Object.entries(LEGACY_ALIASES)) states[from] = states[to]!;

export const FLIGHT_PREVIEW_STATES = Object.keys(states).filter((s) => !(s in LEGACY_ALIASES));

export function renderFlightState(state: string): ReactNode | null {
  return states[state]?.() ?? null;
}
