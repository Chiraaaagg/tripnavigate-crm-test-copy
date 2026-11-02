import type { ReactNode } from 'react';
import type { PurchaseTaskSummary, PurchaseTaskView } from '@/modules/fulfilment/contracts';
import type { PurchaseQueueFlags, PurchaseWorkspaceView, QuoteView, SupplierEmailView } from '@/modules/procurement/contracts';
import type { DepartmentTaskTabsVM, TaskTab } from '@/modules/settings/contracts';
import type { PaymentContextView, PurchasePaymentRequestView, SupplierDocumentView } from '@/modules/supplier-money/contracts';
import { toTaskHistoryVM } from '@/views/department/task-history-vm';
import { PurchasePaymentsPage, type PaymentsShow } from '@/views/purchase/payments-page';
import { SupplierDocumentsSection } from '@/views/purchase/supplier-documents';
import { purchaseNextText, PurchaseWorkTab } from '@/views/purchase/work-tab';
import { PurchaseQueuePage, PurchaseTaskPage } from '@/views/purchase-views';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import { TripCancellationCard } from '@/views/purchase/trip-cancellation';
import { HomeView, NO_HOME_ROLES } from '@/views/home-view';
import type { SupplierMoneyHomeCounts } from '@/modules/supplier-money/contracts';
import { PB_ACTIONS, PB_DOCUMENT_ACTION, PB_TRIP_CANCEL_ACTION, PB_UPLOAD_ACTION } from './pb-actions';
import { PageHeader } from '@/components/ui/page-header';

/*
 * Purchase build preview states (pb-): queue with the go-ahead badges, the
 * task's Details ("What Sales booked"), Work (rate negotiation, booking
 * request, go-ahead, confirmation, supplier payments, trip cancellation),
 * Files (supplier invoices and credit notes), History and the Purchase
 * "Payment requests" page. Synthetic props only (example names, made-up
 * amounts, SYN- deal references); no real supplier, bank or customer data.
 * Rendered by the design-review gallery only.
 */

const purchase: ShellViewer = {
  displayName: 'Synthetic Purchase Jodhpur',
  primaryRole: 'Purchase',
  primaryBranch: 'Jodhpur',
  canAdministerStaff: false,
  canManageGrants: false,
  canSeePurchaseTasks: true,
  canSeePurchasePayments: true,
};
const manager: ShellViewer = { ...purchase, displayName: 'Synthetic Manager Jodhpur', primaryRole: 'Manager', canSeePurchasePayments: false, canSeeApprovals: true, canSeeLeads: true };

const id = (n: number, p = 'f') => `${p}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TASK = id(101);
const S1 = id(1, 'c');
const S2 = id(2, 'c');
const ME = 'Synthetic Purchase Jodhpur';

function tabsOf(current: TaskTab): DepartmentTaskTabsVM {
  return { tabs: ['details', 'work', 'files', 'history'], current };
}

const hotelTask: PurchaseTaskView = {
  taskId: TASK,
  dealReference: 'SYN-JOD-547',
  serviceType: 'hotel',
  itemTitle: 'Synthetic Fort Retreat, Jaisalmer',
  facts: {
    type: 'hotel',
    facts: { hotelName: 'Synthetic Fort Retreat', city: 'Jaisalmer', checkIn: '2026-11-06', checkOut: '2026-11-08', rooms: 4, adults: 8, children: 1, roomType: 'Deluxe twin room', mealPlan: 'All meals', extraBeds: 1, childrenWithoutBed: 0 },
  },
  hotelName: 'Synthetic Fort Retreat',
  city: 'Jaisalmer',
  checkIn: '2026-11-06',
  checkOut: '2026-11-08',
  nights: 2,
  rooms: 4,
  travellers: { adults: 8, children: 1 },
  purchaseBudgetPaise: '11000000',
  status: 'in_progress',
  assigneeName: ME,
  assignedToYou: true,
  branchName: 'Jodhpur',
  createdAt: '2026-10-22T07:05:00Z',
  supplierConfirmedAt: null,
  roomType: 'Deluxe twin room',
  mealPlan: 'All meals',
  inclusions: 'Conference hall half day on 7 Nov (synthetic).',
  specialRequests: 'Company offsite: one bill to the example company (synthetic).',
  confirmedAt: '2026-10-22T07:05:00Z',
  confirmedByName: 'Synthetic Sales Jodhpur',
  versionNo: 2,
  canClaim: false,
  // 4 rooms × ₹13,000 + 1 extra bed × ₹3,000, × 2 nights = ₹1,10,000 (equals the budget).
  estimate: { estimate: { kind: 'hotel', roomRatePaise: '1300000', extraBedRatePaise: '300000', noBedRatePaise: null }, totalPaise: '11000000' },
};

const quote = (n: number, over: Partial<QuoteView>): QuoteView => ({
  quoteId: id(n, 'e'),
  supplierId: S1,
  supplierName: 'Synthetic Fort Retreat (example)',
  supplierVerification: 'verified',
  hotelName: 'Synthetic Fort Retreat',
  roomType: null,
  mealPlan: null,
  quotedCostPaise: '11200000',
  holdUntil: null,
  cancellationTerms: null,
  status: 'open',
  createdAt: `2026-10-23T0${n}:10:00Z`,
  createdByName: ME,
  perRoomNightPaise: null,
  note: null,
  ...over,
});

const quotes: QuoteView[] = [
  quote(5, {}),
  quote(6, { quotedCostPaise: '10800000', note: 'Revised after our call.' }),
  quote(7, { quotedCostPaise: '10400000', perRoomNightPaise: '1300000', note: 'Best rate after negotiation.' }),
  quote(8, { supplierId: S2, supplierName: 'Example Desert Stays', supplierVerification: 'unverified', quotedCostPaise: '11900000', status: 'withdrawn' }),
];

const choices = [
  { supplierId: S1, name: 'Synthetic Fort Retreat (example)', verificationStatus: 'verified' as const, email: 'reservations@fort-retreat.example' },
  { supplierId: S2, name: 'Example Desert Stays', verificationStatus: 'unverified' as const, email: null },
];

const finalCost = { versionNo: 1, quoteId: quotes[2]!.quoteId, stage: 'proposed' as const, amountPaise: '10400000', dueDate: null, note: null, payableStatus: 'not_requested' as const, createdAt: '2026-10-23T07:30:00Z', createdByName: ME, overBudgetApprovedAt: null, overBudgetApprovedByName: null };

const noGoAhead = { state: 'not_requested' as const, requestId: null, costVersionNo: null, requestedAt: null, requestedByName: null, decidedAt: null, decidedByName: null, returnReason: null };

const bookingEmail: SupplierEmailView = {
  emailId: id(31, 'a'),
  kind: 'booking_request',
  supplierId: S1,
  supplierName: 'Synthetic Fort Retreat (example)',
  toEmail: 'reservations@fort-retreat.example',
  ccEmails: [],
  subject: 'Booking request · SYN-JOD-547 · Synthetic Fort Retreat · 6–8 Nov 2026',
  body: 'Dear Synthetic Fort Retreat (example) team,\n\nPlease book the following and confirm (synthetic preview).',
  status: 'marked_sent',
  costVersionNo: 1,
  sentAt: '2026-10-23T08:00:00Z',
  sentByName: ME,
  failed: false,
};
const rateEmail: SupplierEmailView = { ...bookingEmail, emailId: id(30, 'a'), kind: 'rate_request', subject: 'Rate request · SYN-JOD-547 · Synthetic Fort Retreat · 6–8 Nov 2026', costVersionNo: null, sentAt: '2026-10-23T04:00:00Z' };

const base: PurchaseWorkspaceView = {
  task: hotelTask,
  canWork: true,
  canRelease: true,
  canReassign: false,
  canApproveOverBudget: false,
  assigneeUserId: id(3, 'a'),
  reassignCandidates: [],
  gateIssue: null,
  issues: [],
  supplierReference: null,
  selectedQuoteId: null,
  supplierConfirmedByName: null,
  quotes: [],
  costVersions: [],
  evidence: [],
  supplierChoices: choices,
  goAhead: noGoAhead,
  emails: [],
  cancellation: null,
  emailSendingEnabled: false,
};

const noRates: PurchaseWorkspaceView = { ...base, issues: ['missing_quote', 'missing_cost', 'booking_request_not_sent', 'go_ahead_missing', 'missing_supplier_confirmation_proof'] };
const finalChosen: PurchaseWorkspaceView = {
  ...base,
  quotes,
  costVersions: [finalCost],
  emails: [rateEmail],
  issues: ['booking_request_not_sent', 'go_ahead_missing', 'missing_supplier_confirmation_proof'],
};
const waitingGoAhead: PurchaseWorkspaceView = {
  ...finalChosen,
  emails: [bookingEmail, rateEmail],
  issues: ['go_ahead_missing', 'missing_supplier_confirmation_proof'],
  goAhead: { ...noGoAhead, state: 'pending', requestId: id(41, 'a'), costVersionNo: 1, requestedAt: '2026-10-23T08:00:00Z', requestedByName: ME },
};
const goAheadGiven: PurchaseWorkspaceView = {
  ...waitingGoAhead,
  issues: [],
  evidence: [{ id: id(51, 'a'), kind: 'supplier_confirmation', fileName: 'synthetic-confirmation.pdf', mime: 'application/pdf', sizeBytes: 96000, status: 'stored', createdAt: '2026-10-24T05:00:00Z', uploadedByName: ME }],
  goAhead: { ...waitingGoAhead.goAhead, state: 'approved', decidedAt: '2026-10-23T10:00:00Z', decidedByName: 'Synthetic Accounts Jodhpur' },
};
const goAheadReturned: PurchaseWorkspaceView = {
  ...waitingGoAhead,
  issues: ['go_ahead_missing'],
  goAhead: { ...waitingGoAhead.goAhead, state: 'returned', decidedAt: '2026-10-23T10:00:00Z', decidedByName: 'Synthetic Accounts Jodhpur', returnReason: 'The booking review of version 2 is not approved yet. Send it again after Sales fixes the traveller count (synthetic).' },
};
const overBudget: PurchaseWorkspaceView = {
  ...base,
  quotes: [quote(5, {})],
  costVersions: [{ ...finalCost, quoteId: quote(5, {}).quoteId, amountPaise: '11200000' }],
  issues: ['over_budget', 'booking_request_not_sent', 'go_ahead_missing', 'missing_supplier_confirmation_proof'],
};
const overBudgetManager: PurchaseWorkspaceView = {
  ...overBudget,
  task: { ...hotelTask, assignedToYou: false },
  canWork: false,
  canRelease: false,
  canReassign: true,
  canApproveOverBudget: true,
  reassignCandidates: [{ userId: id(4, 'a'), name: 'Synthetic Purchase Colleague' }],
  supplierChoices: [],
};
const confirmedWs: PurchaseWorkspaceView = {
  ...goAheadGiven,
  task: { ...hotelTask, status: 'supplier_confirmed', supplierConfirmedAt: '2026-10-24T06:00:00Z' },
  canWork: false,
  canRelease: false,
  supplierReference: 'SYN-CONF-5471',
  selectedQuoteId: quotes[2]!.quoteId,
  supplierConfirmedByName: ME,
  quotes: quotes.map((q) => (q.quoteId === quotes[2]!.quoteId ? { ...q, status: 'selected' as const } : q)),
  costVersions: [{ ...finalCost, versionNo: 2, stage: 'committed', createdAt: '2026-10-24T06:00:00Z' }, finalCost],
};
const cancelled: PurchaseWorkspaceView = {
  ...goAheadGiven,
  issues: ['trip_cancelled'],
  cancellation: {
    cancellationId: id(61, 'a'),
    status: 'charges_entered',
    reason: 'The example company postponed its offsite to next year (synthetic).',
    openedAt: '2026-10-25T05:00:00Z',
    openedByName: 'Synthetic Manager Jodhpur',
    rowVersion: 2,
    returnReason: null,
    myCharge: {
      taskId: TASK,
      revisionNo: 1,
      supplierId: S1,
      supplierName: 'Synthetic Fort Retreat (example)',
      committedCostPaise: '10400000',
      supplierKeepsPaise: '2600000',
      supplierRefundPaise: '7800000',
      note: 'One night retained as per the hold terms (synthetic).',
      creditNoteEvidenceId: null,
      enteredAt: '2026-10-25T07:00:00Z',
      enteredByName: ME,
    },
    canEnter: true,
    canSend: false,
    chargesMissing: 1,
  },
};

const transferTask: PurchaseTaskView = {
  ...hotelTask,
  taskId: id(102),
  serviceType: 'transfer',
  itemTitle: 'Jodhpur to Jaisalmer coach (synthetic)',
  facts: { type: 'transfer', facts: { route: 'Jodhpur to Jaisalmer', date: '2026-11-06', vehicleType: 'Coach', passengers: 9, pickupTime: '07:00' } },
  hotelName: null,
  city: null,
  checkIn: null,
  checkOut: null,
  nights: 0,
  rooms: 0,
  purchaseBudgetPaise: '3500000',
  roomType: null,
  mealPlan: null,
  inclusions: null,
  specialRequests: null,
  estimate: undefined,
};
const transferWs: PurchaseWorkspaceView = {
  ...base,
  task: transferTask,
  goAhead: { ...noGoAhead, state: 'not_needed' },
  quotes: [quote(5, { quotedCostPaise: '3200000', supplierName: 'Example Coaches (synthetic)', hotelName: 'Jodhpur to Jaisalmer coach' })],
  costVersions: [{ ...finalCost, quoteId: quote(5, {}).quoteId, amountPaise: '3200000' }],
  emails: [{ ...bookingEmail, subject: 'Booking request · SYN-JOD-547 · Jodhpur to Jaisalmer coach · 6 Nov 2026' }],
  supplierChoices: [{ supplierId: S1, name: 'Example Coaches (synthetic)', verificationStatus: 'verified', email: 'desk@coaches.example' }],
};

// ---------------------------------------------------------------------------
// Supplier money (Track B shapes)
// ---------------------------------------------------------------------------

const payment = (n: number, over: Partial<PurchasePaymentRequestView>): PurchasePaymentRequestView => ({
  id: id(n, 'b'),
  refNo: `SP-2026-0000${n}`,
  dealId: id(200, 'd'),
  dealReference: 'SYN-JOD-547',
  taskId: TASK,
  serviceTitle: 'Synthetic Fort Retreat, Jaisalmer',
  serviceType: 'hotel',
  supplierId: S1,
  supplierName: 'Synthetic Fort Retreat (example)',
  part: 'deposit',
  amountPaise: '3000000',
  dueDate: '2026-10-29',
  note: null,
  route: 'accounts',
  status: 'pending',
  costVersionNo: 1,
  proformaEvidenceId: id(n, 'a'),
  returnReason: null,
  requestedAt: '2026-10-24T06:30:00Z',
  requestedByName: ME,
  decidedAt: null,
  decidedByName: null,
  paidOn: null,
  paymentMode: null,
  bankReference: null,
  verifiedAt: null,
  companyFundingAsked: false,
  onHold: false,
  holdReason: null,
  resubmittedAs: null,
  resubmitsRefNo: null,
  canCancel: true,
  canResubmit: false,
  rowVersion: 1,
  ...over,
});

const payments: PurchasePaymentRequestView[] = [
  payment(1, {}),
  payment(2, { part: 'balance', amountPaise: '7400000', route: 'manager', status: 'returned', returnReason: 'Attach the supplier’s final proforma with the GST number (synthetic).', decidedAt: '2026-10-25T09:00:00Z', decidedByName: 'Synthetic Manager Jodhpur', canCancel: false, canResubmit: true }),
  payment(3, { status: 'approved', onHold: true, holdReason: 'bank_details_on_hold', canCancel: false, decidedAt: '2026-10-25T09:00:00Z', decidedByName: 'Synthetic Accounts Jodhpur' }),
  payment(4, { status: 'verified', canCancel: false, paidOn: '2026-10-26', paymentMode: 'bank_transfer', bankReference: 'SYNUTR0001', verifiedAt: '2026-10-27T05:00:00Z' }),
];

const docs: SupplierDocumentView[] = [
  { id: id(71, 'b'), kind: 'invoice', taskId: TASK, dealReference: 'SYN-JOD-547', serviceTitle: 'Synthetic Fort Retreat, Jaisalmer', supplierId: S1, supplierName: 'Synthetic Fort Retreat (example)', number: 'SYN-INV-77', docDate: '2026-11-08', totalPaise: '10400000', gstIncluded: true, evidenceId: id(72, 'b'), status: 'returned', returnReason: 'The invoice total does not match the agreed cost (synthetic).', uploadedAt: '2026-11-09T05:00:00Z', uploadedByName: ME, reviewedAt: '2026-11-09T07:00:00Z', reviewedByName: 'Synthetic Accounts Jodhpur', rowVersion: 2 },
];

const ctx = (over: Partial<PaymentContextView>): PaymentContextView => ({
  taskId: TASK,
  dealId: id(200, 'd'),
  dealReference: 'SYN-JOD-547',
  serviceType: 'hotel',
  serviceTitle: 'Synthetic Fort Retreat, Jaisalmer',
  taskStatus: 'in_progress',
  supplierId: S1,
  supplierName: 'Synthetic Fort Retreat (example)',
  costVersionNo: 1,
  agreedCostPaise: '10400000',
  requestedPaise: '0',
  remainingPaise: '10400000',
  goAheadState: 'approved',
  goAheadNeeded: true,
  goAheadValid: true,
  allowedParts: ['deposit'],
  blockers: [],
  canRequest: true,
  canUploadDocuments: true,
  customerMoneyShort: false,
  routeRunningTotalPaise: '0',
  approvalLimitPaise: '5000000',
  bankDetailsApproved: true,
  invoiceMissing: false,
  requests: [],
  documents: [],
  files: [],
  ...over,
});

const shell = (viewer: ShellViewer, path: string, content: ReactNode) => (
  <StaffShell viewer={viewer} currentPath={path}>
    {content}
  </StaffShell>
);

function workPage(viewer: ShellViewer, ws: PurchaseWorkspaceView, pay: PaymentContextView | null, managerReadOnly = false): ReactNode {
  return shell(
    viewer,
    '/app/purchase',
    <PurchaseTaskPage
      task={ws.task}
      tabs={tabsOf('work')}
      managerReadOnly={managerReadOnly}
      goAheadState={ws.goAhead.state}
      nextText={purchaseNextText(ws)}
      work={<PurchaseWorkTab ws={ws} payments={pay} actions={PB_ACTIONS} senderName={ME} />}
    />,
  );
}

const queueTasks: PurchaseTaskSummary[] = [
  { ...hotelTask },
  { ...hotelTask, taskId: id(103), itemTitle: 'Example Lake Palace, Udaipur', hotelName: 'Example Lake Palace', dealReference: 'SYN-JOD-390', status: 'not_started', assigneeName: null, assignedToYou: false },
  { ...transferTask },
  { ...hotelTask, taskId: id(104), itemTitle: 'Example Beach Resort, Goa', dealReference: 'SYN-JOD-198', purchaseBudgetPaise: '4530000' },
  { ...hotelTask, taskId: id(105), itemTitle: 'Example Hill Lodge, Manali', dealReference: 'SYN-JOD-264', status: 'supplier_confirmed', supplierConfirmedAt: '2026-10-20T05:00:00Z' },
];
const queueFlags: Record<string, PurchaseQueueFlags> = {
  [TASK]: { goAheadState: 'pending', tripCancelled: false },
  [id(103)]: { goAheadState: 'not_requested', tripCancelled: false },
  [id(102)]: { goAheadState: 'not_needed', tripCancelled: false },
  [id(104)]: { goAheadState: 'returned', tripCancelled: true },
  [id(105)]: { goAheadState: 'approved', tripCancelled: false },
};

const history = toTaskHistoryVM(
  {
    taskId: TASK,
    department: 'purchase',
    truncated: false,
    events: [
      { at: '2026-10-23T10:00:00Z', kind: 'go_ahead_returned', byName: 'Synthetic Accounts Jodhpur', byYou: false, toName: null, toYou: false, applicantSeq: null, state: null, note: 'The booking review is not approved yet (synthetic).' },
      { at: '2026-10-23T08:00:00Z', kind: 'go_ahead_requested', byName: null, byYou: true, toName: null, toYou: false, applicantSeq: null, state: null, note: null },
      { at: '2026-10-23T08:00:00Z', kind: 'booking_request_sent', byName: null, byYou: true, toName: null, toYou: false, applicantSeq: null, state: null, note: null },
      { at: '2026-10-23T07:30:00Z', kind: 'cost_recorded', byName: null, byYou: true, toName: null, toYou: false, applicantSeq: null, state: null, note: null },
      { at: '2026-10-23T04:00:00Z', kind: 'rate_request_sent', byName: null, byYou: true, toName: null, toYou: false, applicantSeq: null, state: null, note: null },
      { at: '2026-10-22T07:05:00Z', kind: 'created', byName: null, byYou: false, toName: null, toYou: false, applicantSeq: null, state: null, note: null },
    ],
  },
  'purchase',
);

const paymentsPage = (show: PaymentsShow, rows = payments) => shell(purchase, '/app/purchase/payments', <PurchasePaymentsPage rows={rows} show={show} />);

const NO_SM: SupplierMoneyHomeCounts = {
  requestsToApprove: null,
  purchaseTasksNotTaken: null,
  purchaseWaitingForGoAhead: null,
  purchaseCostsWaitingForManager: null,
  paymentRequestsReturned: null,
  supplierInvoicesMissing: null,
  goAheadToApprove: null,
  supplierPaymentsToApprove: null,
  supplierPaymentsToRecord: null,
  supplierPaymentsToVerify: null,
  supplierDocumentsToReview: null,
  fundingToApprove: null,
  fundingToRecover: null,
  managerApprovals: null,
};
const accountsViewer: ShellViewer = { ...purchase, displayName: 'Synthetic Accounts Jodhpur', primaryRole: 'Accounts', canSeePurchaseTasks: false, canSeePurchasePayments: false, canUseAccounts: true };
const deals = { visible: 12, owned: 0, assigned: 3 };

const states: Record<string, () => ReactNode> = {
  'pb-home-purchase': () =>
    shell(
      purchase,
      '/app',
      <HomeView displayName={ME} counts={deals} roles={{ ...NO_HOME_ROLES, purchase: true }} supplierMoney={{ ...NO_SM, purchaseTasksNotTaken: 2, purchaseWaitingForGoAhead: 1, purchaseCostsWaitingForManager: 1, paymentRequestsReturned: 1, supplierInvoicesMissing: 1 }} />,
    ),
  'pb-home-accounts': () =>
    shell(
      accountsViewer,
      '/app',
      <HomeView
        displayName="Synthetic Accounts Jodhpur"
        counts={deals}
        roles={{ ...NO_HOME_ROLES, accounts: true }}
        supplierMoney={{ ...NO_SM, requestsToApprove: 4, goAheadToApprove: 2, supplierPaymentsToApprove: 1, supplierPaymentsToRecord: 1, supplierPaymentsToVerify: 0, supplierDocumentsToReview: 1, fundingToApprove: 1, fundingToRecover: 0 }}
      />,
    ),
  'pb-home-manager': () =>
    shell(manager, '/app', <HomeView displayName="Synthetic Manager Jodhpur" counts={deals} roles={{ ...NO_HOME_ROLES, branchManager: true }} supplierMoney={{ ...NO_SM, requestsToApprove: 5, managerApprovals: 5 }} />),
  'pb-queue': () => shell(purchase, '/app/purchase', <PurchaseQueuePage queue={{ tasks: queueTasks }} canTakeTasks show="all" flags={queueFlags} />),
  'pb-queue-mine': () => shell(purchase, '/app/purchase', <PurchaseQueuePage queue={{ tasks: queueTasks }} canTakeTasks show="mine" flags={queueFlags} />),
  'pb-task-details': () =>
    shell(purchase, '/app/purchase', <PurchaseTaskPage task={hotelTask} tabs={tabsOf('details')} goAheadState="pending" nextText={purchaseNextText(waitingGoAhead)} />),
  'pb-task-details-no-breakup': () =>
    shell(purchase, '/app/purchase', <PurchaseTaskPage task={{ ...hotelTask, estimate: undefined, specialRequests: null }} tabs={tabsOf('details')} goAheadState="not_requested" />),
  'pb-task-details-transfer': () => shell(purchase, '/app/purchase', <PurchaseTaskPage task={transferTask} tabs={tabsOf('details')} goAheadState="not_needed" />),
  'pb-task-work-no-rates': () => workPage(purchase, noRates, ctx({ agreedCostPaise: null, costVersionNo: null, supplierId: null, supplierName: null, remainingPaise: '0', blockers: ['not_ready'] })),
  'pb-task-work-final-rate': () => workPage(purchase, finalChosen, ctx({ goAheadState: 'not_requested', goAheadValid: false, blockers: ['booking_request_not_sent', 'go_ahead_missing'] })),
  'pb-task-work-waiting-go-ahead': () => workPage(purchase, waitingGoAhead, ctx({ goAheadState: 'pending', goAheadValid: false, blockers: ['go_ahead_missing'] })),
  'pb-task-work-go-ahead-given': () => workPage(purchase, goAheadGiven, ctx({ requests: [payments[0]!], requestedPaise: '3000000', remainingPaise: '7400000', routeRunningTotalPaise: '3000000' })),
  'pb-task-work-go-ahead-returned': () => workPage(purchase, goAheadReturned, ctx({ goAheadState: 'returned', goAheadValid: false, blockers: ['go_ahead_missing'] })),
  'pb-task-work-over-budget': () => workPage(purchase, overBudget, null),
  'pb-task-work-over-budget-manager': () => workPage(manager, overBudgetManager, null, true),
  'pb-task-work-transfer': () => workPage(purchase, transferWs, ctx({ taskId: transferTask.taskId, serviceType: 'transfer', goAheadState: 'not_needed', goAheadNeeded: false, agreedCostPaise: '3200000', remainingPaise: '3200000' })),
  'pb-task-work-cancelled': () => workPage(purchase, cancelled, ctx({ blockers: ['trip_cancelled'] })),
  'pb-task-work-confirmed': () =>
    workPage(
      purchase,
      confirmedWs,
      ctx({ taskStatus: 'supplier_confirmed', allowedParts: ['balance', 'full'], requests: payments, requestedPaise: '10400000', remainingPaise: '0', bankDetailsApproved: false, blockers: ['over_agreed_cost'] }),
    ),
  // After confirmation: canWork is false, but the assignee may still ask for the balance (ctx.canRequest).
  'pb-task-work-confirmed-pay': () =>
    workPage(purchase, confirmedWs, ctx({ taskStatus: 'supplier_confirmed', allowedParts: ['balance', 'full'], requests: [payments[3]!], requestedPaise: '3000000', remainingPaise: '7400000', routeRunningTotalPaise: '3000000' })),
  'pb-task-files': () =>
    shell(
      purchase,
      '/app/purchase',
      <PurchaseTaskPage
        task={confirmedWs.task}
        tabs={tabsOf('files')}
        files={{ purchase: goAheadGiven.evidence }}
        filesExtra={<SupplierDocumentsSection ctx={ctx({ taskStatus: 'supplier_confirmed', documents: docs, invoiceMissing: true })} documentAction={PB_DOCUMENT_ACTION} uploadAction={PB_UPLOAD_ACTION} />}
      />,
    ),
  'pb-task-files-error': () =>
    shell(purchase, '/app/purchase', <PurchaseTaskPage task={hotelTask} tabs={tabsOf('files')} files={{ purchase: [] }} filesExtra={<SupplierDocumentsSection ctx="error" documentAction={PB_DOCUMENT_ACTION} uploadAction={PB_UPLOAD_ACTION} />} />),
  'pb-task-history': () => shell(purchase, '/app/purchase', <PurchaseTaskPage task={hotelTask} tabs={tabsOf('history')} goAheadState="returned" history={history} />),
  'pb-deal-trip-cancel': () =>
    shell(
      manager,
      '/app/deals',
      <>
        <PageHeader eyebrow="Deal SYN-JOD-547" title="Synthetic offsite trip" />
        <TripCancellationCard dealId={id(200, 'd')} summary={{ canOpen: true, cancellation: null }} action={PB_TRIP_CANCEL_ACTION} />
      </>,
    ),
  'pb-deal-trip-cancelled': () =>
    shell(
      manager,
      '/app/deals',
      <>
        <PageHeader eyebrow="Deal SYN-JOD-547" title="Synthetic offsite trip" />
        <TripCancellationCard
          dealId={id(200, 'd')}
          summary={{ canOpen: false, cancellation: { cancellationId: id(61, 'a'), status: 'sent_to_manager', reason: 'The example company postponed its offsite (synthetic).', openedAt: '2026-10-25T05:00:00Z', openedByName: 'Synthetic Manager Jodhpur', decidedAt: null } }}
          action={PB_TRIP_CANCEL_ACTION}
        />
      </>,
    ),
  'pb-payments': () => paymentsPage('open'),
  'pb-payments-returned': () => paymentsPage('returned'),
  'pb-payments-all': () => paymentsPage('all'),
  'pb-payments-empty': () => paymentsPage('open', []),
};

export const PB_PREVIEW_STATES = Object.keys(states);

export function renderPbState(state: string): ReactNode | null {
  return states[state]?.() ?? null;
}
