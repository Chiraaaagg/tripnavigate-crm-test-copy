import type { ReactNode } from 'react';
import type { AccountsClaimView, AccountsClaimsPage, AccountsDealDetail, AccountsExpenseRecordsPage, AccountsExpenseFilter, AccountsClaimsFilter } from '@/modules/finance/contracts';
import type { DepartmentCostView, DepartmentEvidenceView, MyWorkCounts, VisaApplicantView, VisaQueueView, VisaTaskView } from '@/modules/fulfilment/contracts';
import type { IntakeEntryRuleView, PruneResult } from '@/modules/integration/won-only';
import { AccountsClaimsListView, type ClaimActions } from '@/views/b11/accounts-claims';
import { AccountsExpensesView, DepartmentCostCard, type CostActions } from '@/views/b11/department-cost';
import { VisaQueueLoading, VisaQueuePage, VisaTaskNotAvailableView, VisaTaskPage, type VisaActions } from '@/views/b11/visa-desk';
import { WonOnlyCard } from '@/views/b11/won-only-card';
import { AccountsDealView } from '@/views/finance-views';
import { FlightTaskPage } from '@/views/flight-views';
import { HomeView, NO_HOME_ROLES as NO_ROLES } from '@/views/home-view';
import { PurchaseTaskPage } from '@/views/purchase-views';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import { FeaturesSettingsView, IdProofCopyAlertsCard } from '@/views/workflow-views';
import { bitrixRows } from '@/modules/settings/rows';
import { SettingsSectionView } from '@/views/settings/setting-rows';
import { SettingsSectionHeading } from '@/views/settings/settings-frame';
import { bitrixSection } from './batch4-settings-fixtures';
import { previewSwitchNotAuthorizedAction, previewSwitchSavedAction } from './batch4-settings-preview-actions';
import { inSettings } from './settings-preview-frame';

/** Settings · Bitrix connection, cut down to the cards a state shows (Batch 4: switches, ID-proof copies, won-only moved here). */
function BitrixPreviewPage({ children }: { children: ReactNode }) {
  return (
    <>
      <SettingsSectionHeading>Bitrix connection</SettingsSectionHeading>
      {children}
    </>
  );
}
import type { B11Action } from '@/views/b11/shapes';
import { previewCopyRetriedAction } from './b12-preview-actions';
import { admin, delhiSales, flight, flightView, purchase, purchaseQueue, purchaseView, featuresPreview } from './b1-states';
import {
  previewB11DocumentsNotCheckedAction,
  previewB11FinanceOkAction,
  previewB11FinanceRefuseAction,
  previewB11OutcomeDocumentAction,
  previewB11OverLimitAction,
  previewB11PruneDryRunAction,
  previewB11WonOnlySavedAction,
  previewB11SavedAction,
  previewB11TaskConflictAction,
} from './b11-preview-actions';
import { accounts, accounts2, actions as financeActions, destinationOptions, detail as financeDetail } from './finance-states';

/*
 * B1.1 preview states (LOCAL DESIGN-REVIEW GALLERY ONLY) for Accounts claims
 * and expense records, the department cost block, the Visa & Passport desk,
 * the workflow switches with Won-only intake, and Home counts. Synthetic
 * views and stand-in actions only.
 */

export const visaDesk: ShellViewer = { ...purchase, displayName: 'Synthetic Visa Desk Jodhpur', primaryRole: 'Visa & Passport desk', canSeePurchaseTasks: false, canSeeVisaDesk: true };

const claimActions: ClaimActions = { record: previewB11FinanceOkAction, link: previewB11FinanceOkAction, notReceived: previewB11FinanceOkAction };
const claimRefuse: ClaimActions = { record: previewB11FinanceRefuseAction, link: previewB11FinanceRefuseAction, notReceived: previewB11FinanceRefuseAction };

function claim(over: Partial<AccountsClaimView> = {}): AccountsClaimView {
  return {
    claimId: 'cl000000-0000-4000-8000-000000000001',
    status: 'reported',
    displayStatus: 'reported',
    amountPaise: '3000000',
    mode: 'bank_transfer',
    reference: 'UTR226700009911',
    chequeNumber: null,
    chequeDate: null,
    paidOn: '2026-11-01',
    payerName: 'Synthetic Customer Pvt Ltd',
    note: 'Customer sent a screenshot on WhatsApp.',
    destination: { label: 'Synthetic Bank •••• 4321', kind: 'bank', versionNo: 1, bankName: 'Synthetic Bank', accountMasked: '•••• 4321', upiMasked: null, isCurrent: true },
    bookingVersionNo: 2,
    reportedByName: 'Synthetic Sales Delhi A',
    reportedAt: '2026-11-02T06:00:00Z',
    linkedReceiptId: null,
    linkedReceiptNo: null,
    linkKind: null,
    linkReason: null,
    linkedByName: null,
    linkedAt: null,
    closedReason: null,
    closedByName: null,
    closedAt: null,
    rowVersion: 1,
    possibleReceiptIds: financeDetail.receipts.slice(0, 2).map((r) => r.receiptId),
    actions: { recordReceipt: null, linkReceipt: null, markNotReceived: null },
    ...over,
  };
}

function withClaims(claims: AccountsClaimView[], booking: Partial<NonNullable<AccountsDealDetail['booking']>> = {}): AccountsDealDetail {
  return {
    ...financeDetail,
    claims,
    claimsReportedPaise: claims.filter((c) => c.status === 'reported' || c.status === 'linked').reduce((s, c) => s + Number(c.amountPaise), 0).toString(),
    booking: { ...financeDetail.booking!, ...booking },
  };
}

const packageBooking = {
  serviceType: 'package' as const,
  hotelName: null,
  city: null,
  checkIn: null,
  checkOut: null,
  rooms: null,
  adults: null,
  children: null,
  listPricePaise: '13000000',
  discountPaise: '655400',
  services: [
    { itemNo: 1, serviceType: 'hotel' },
    { itemNo: 2, serviceType: 'flight' },
    { itemNo: 3, serviceType: 'visa' },
  ],
  contact: { name: 'Synthetic Customer A', mobile: '9876500012', email: null, bookingFor: 'business' as const, payerName: 'Synthetic Customer Pvt Ltd' },
  paymentPlan: {
    instalments: [
      { seq: 1, label: 'Advance', amountPaise: '3000000', dueDate: '2026-11-03' },
      { seq: 2, label: 'Balance', amountPaise: '9345600', dueDate: '2026-11-12' },
    ],
    totalPaise: '12345600',
    matchesSellingTotal: true,
  },
};

const claimsPage = (filter: AccountsClaimsFilter, empty = false): AccountsClaimsPage => ({
  items: empty
    ? []
    : [
        { claimId: 'cl1', dealId: 'd5000000-0000-4000-8000-000000000001', dealReference: 'SYN-DEL-001', dealTitle: 'Synthetic package A (Delhi)', branchName: 'Delhi', amountPaise: '3000000', mode: 'bank_transfer', paidOn: '2026-11-01', payerName: 'Synthetic Customer Pvt Ltd', reference: 'UTR226700009911', chequeNumber: null, status: 'reported', displayStatus: 'reported', reportedByName: 'Synthetic Sales Delhi A', reportedAt: '2026-11-02T06:00:00Z', linkedReceiptNo: null },
        { claimId: 'cl2', dealId: 'd5000000-0000-4000-8000-000000000002', dealReference: 'SYN-JOD-012', dealTitle: 'Synthetic family trip to Udaipur', branchName: 'Jodhpur', amountPaise: '500000', mode: 'cheque', paidOn: '2026-11-01', payerName: 'Synthetic Customer B', reference: null, chequeNumber: '004512', status: 'reported', displayStatus: 'reported', reportedByName: 'Synthetic Sales Jodhpur', reportedAt: '2026-11-02T07:00:00Z', linkedReceiptNo: null },
      ],
  hasMore: false,
  nextAfter: null,
  totalCount: empty ? 0 : 2,
});
const claimHrefs = Object.fromEntries((['reported', 'linked', 'closed', 'all'] as const).map((f) => [f, `/preview/b11-accounts-claims-list?filter=${f}`])) as Record<AccountsClaimsFilter, string>;

const expensePage = (status: 'submitted' | 'returned', own = false): AccountsExpenseRecordsPage => ({
  items: [
    {
      entryId: 'ce1',
      dealId: 'd5000000-0000-4000-8000-000000000002',
      dealReference: 'SYN-JOD-012',
      department: 'visa',
      serviceType: 'visa',
      kind: 'government_fee',
      amountPaise: '650000',
      paidBy: 'company',
      paymentMode: 'card',
      paidOn: '2026-11-04',
      reference: 'SYN-FEE-0042',
      status,
      submittedByName: 'Synthetic Visa Desk Jodhpur',
      submittedAt: '2026-11-04T09:00:00Z',
      reviewedByName: status === 'returned' ? 'Synthetic Accounts Delhi' : null,
      reviewedAt: status === 'returned' ? '2026-11-04T12:00:00Z' : null,
      returnReason: status === 'returned' ? 'The receipt shows a different amount (₹6,000). Please check and resend.' : null,
      rowVersion: 2,
      evidence: [{ id: 'de1', kind: 'fee_receipt', fileName: 'synthetic-fee-receipt.pdf', status: 'stored', createdAt: '2026-11-04T08:55:00Z' }],
      actions: own ? { accept: 'own_submission', return: 'own_submission' } : status === 'submitted' ? { accept: null, return: null } : { accept: 'wrong_state', return: 'wrong_state' },
    },
  ],
  hasMore: false,
  nextAfter: null,
  totalCount: 1,
});
const expenseHrefs = Object.fromEntries((['submitted', 'returned', 'accepted', 'all'] as const).map((f) => [f, `/preview/b11-accounts-expenses?filter=${f}`])) as Record<AccountsExpenseFilter, string>;

export const costActions: CostActions = { save: previewB11SavedAction, submit: previewB11SavedAction, upload: previewB11SavedAction };

export function cost(over: Partial<DepartmentCostView> = {}): DepartmentCostView {
  return { entryId: 'ce1', taskId: 'task-3', department: 'flight', costKind: 'fare', amountPaise: '4200000', paidBy: 'company', paymentMode: 'card', paidOn: '2026-11-04', reference: 'SYN-PNR-7Q2', expenseStatus: 'draft', returnReason: null, rowVersion: 1, canEdit: true, canSubmit: true, receiptEvidenceId: null, submittedAt: null, reviewedAt: null, ...over };
}

export const proof: DepartmentEvidenceView = { id: 'de2', kind: 'direct_payment_proof', applicationId: null, fileName: 'synthetic-card-slip.pdf', sizeLabel: '180 KB', status: 'stored', uploadedByYou: true, uploadedAt: '2026-11-04T09:30:00Z' };

const flightWithTravellers = {
  ...flightView,
  participants: [
    { seq: 1, fullName: 'Sample Traveller A', type: 'adult' as const, ageYears: null, specialNeeds: null },
    { seq: 2, fullName: 'Sample Traveller B', type: 'adult' as const, ageYears: null, specialNeeds: 'Wheelchair at the airport' },
  ],
};

const flightInternational = {
  ...flightView,
  tripScope: 'international' as const,
  participants: [
    { seq: 1, fullName: 'Sample Traveller A', type: 'adult' as const, ageYears: null, specialNeeds: null, identity: { dateOfBirth: '1988-04-12', nationality: 'Indian', passportNumber: 'Z1234567', passportExpiry: '2031-02-01', rowVersion: 1 } },
    { seq: 2, fullName: 'Sample Traveller B', type: 'adult' as const, ageYears: null, specialNeeds: null, identity: null },
  ],
};

// --- Visa desk ----------------------------------------------------------------

export const docs = (statuses: Array<'missing' | 'received' | 'checked'>) =>
  ['passport_copy', 'photo', 'bank_statement'].map((code, i) => ({ code, label: ['Passport copy', 'Photo', 'Bank statement (6 months)'][i]!, status: statuses[i]! }));

export function applicant(over: Partial<VisaApplicantView> = {}): VisaApplicantView {
  return {
    applicationId: 'va000000-0000-4000-8000-000000000001',
    travellerSeq: 1,
    fullName: 'Sample Traveller A',
    type: 'adult',
    ageYears: null,
    identity: { dateOfBirth: '1988-04-12', nationality: 'Indian', passportNumber: 'Z1234567', passportExpiry: '2031-02-01', rowVersion: 1 },
    documents: docs(['checked', 'received', 'missing']),
    state: 'docs_pending',
    reference: null,
    appointmentAt: null,
    appointmentPlace: null,
    submittedAt: null,
    outcomeAt: null,
    customerInformedAt: null,
    documentsReturnedAt: null,
    documentsReturnedByName: null,
    closed: false,
    rowVersion: 3,
    ...over,
  };
}

export function visaTask(over: Partial<VisaTaskView> = {}): VisaTaskView {
  return {
    taskId: 'vt000000-0000-4000-8000-000000000001',
    dealReference: 'SYN-JOD-012',
    serviceType: 'visa',
    itemTitle: 'United Arab Emirates · Tourism',
    facts: { country: 'United Arab Emirates', purpose: 'Tourism', travelDate: '2026-11-18', applyBy: '2026-11-05', feePaidBy: 'company' },
    status: 'in_progress',
    assigneeName: 'Synthetic Visa Desk Jodhpur',
    assignedToYou: true,
    branchName: 'Jodhpur',
    createdAt: '2026-11-02T09:00:00Z',
    completedAt: null,
    versionNo: 1,
    confirmedAt: '2026-11-02T08:55:00Z',
    canClaim: false,
    canWork: true,
    applicantCount: 2,
    applicants: [applicant(), applicant({ applicationId: 'va2', travellerSeq: 2, fullName: 'Sample Traveller B', identity: { dateOfBirth: '1990-06-01', nationality: 'Indian', passportNumber: null, passportExpiry: null, rowVersion: 1 }, documents: docs(['missing', 'missing', 'missing']) })],
    evidence: [],
    costs: [],
    ...over,
  };
}

const notTaken: VisaApplicantView[] = [1, 2].map((seq) => ({
  ...applicant({ travellerSeq: seq, fullName: `Sample Traveller ${seq === 1 ? 'A' : 'B'}`, identity: null, documents: [] }),
  applicationId: null,
  state: null,
  rowVersion: null,
}));

export const visaActions: VisaActions = {
  claim: previewB11SavedAction,
  setDocument: previewB11SavedAction,
  recordSubmission: previewB11SavedAction,
  decisionPending: previewB11SavedAction,
  recordOutcome: previewB11SavedAction,
  withdraw: previewB11SavedAction,
  documentsReturned: previewB11SavedAction,
  customerInformed: previewB11SavedAction,
  upload: previewB11SavedAction,
  cost: costActions,
};

export const outcomeDoc: DepartmentEvidenceView = { id: 'de3', kind: 'authority_outcome', applicationId: 'va000000-0000-4000-8000-000000000001', fileName: 'synthetic-visa-grant.pdf', sizeLabel: '320 KB', status: 'stored', uploadedByYou: true, uploadedAt: '2026-11-09T10:00:00Z' };

const visaQueue = (launched: boolean, empty = false): VisaQueueView => ({
  launch: launched ? 'on' : 'off',
  waitingCount: launched ? null : 3,
  tasks: empty || !launched ? [] : [visaTask(), { ...visaTask({ taskId: 'vt2', serviceType: 'passport', itemTitle: 'Renewal · Jaipur', facts: { applicationType: 'renewal', officeCity: 'Jaipur', neededBy: '2026-11-01' }, status: 'not_started', assigneeName: null, assignedToYou: false }) }],
});

// --- Admin -----------------------------------------------------------------

const ruleOff: IntakeEntryRuleView = { wonOnly: false, entryStageIds: [], entryStages: [], tickedStageIds: ['NEW', 'PREPARATION', 'UC_AD0SLH'] };
const ruleOn: IntakeEntryRuleView = { wonOnly: true, entryStageIds: ['UC_AD0SLH'], entryStages: [{ id: 'UC_AD0SLH', label: 'Won - Payment Received', pipelineName: 'General' }], tickedStageIds: ['NEW', 'PREPARATION', 'UC_AD0SLH'] };
const stageOptions = [
  { id: 'NEW', label: 'New', pipelineName: 'General' },
  { id: 'PREPARATION', label: 'Quotation sent', pipelineName: 'General' },
  { id: 'UC_AD0SLH', label: 'Won - Payment Received', pipelineName: 'General' },
];
const dryRun: PruneResult = {
  dryRun: true,
  entryStageIds: ['UC_AD0SLH'],
  storedActive: 31,
  atEntryStage: 4,
  pruned: { count: 24, deals: [{ id: '00000000-0000-4000-8000-000000000101', reference: 'SYN-DEL-101', stageId: 'NEW' }] },
  keptWithWork: { count: 2, byKind: { booking_version: ['00000000-0000-4000-8000-000000000102'] }, deals: [{ id: '00000000-0000-4000-8000-000000000102', reference: 'SYN-JOD-102', stageId: 'PREPARATION', work: ['booking_version', 'claim'] }] },
  keptSyncPending: { count: 1, deals: [{ id: '00000000-0000-4000-8000-000000000103', reference: 'SYN-AHM-103', stageId: 'NEW' }] },
  truncated: false,
};
const wonAction = previewB11WonOnlySavedAction;
const pruneAction = previewB11PruneDryRunAction;

const visaCounts: MyWorkCounts = { waitingForMe: 2, returnedToMe: 0, missingDetails: 0, intakeNeeded: 0, receiptsToVerify: null, requestsToApprove: null, visaTasksWaiting: 2, claimsToProcess: null, expensesToReview: null };
const accountsCounts: MyWorkCounts = { waitingForMe: 6, returnedToMe: 0, missingDetails: 0, intakeNeeded: 0, receiptsToVerify: 2, requestsToApprove: null, claimsToProcess: 3, expensesToReview: 1, visaTasksWaiting: null };

const STATES: Record<string, () => ReactNode> = {
  // Accounts claims (deal page)
  'b11-accounts-claim-reported': () => <AccountsDealView tabParam="money" detail={withClaims([claim()])} actions={financeActions} destinationOptions={destinationOptions} claimActions={claimActions} />,
  'b11-accounts-claim-record-open': () => <AccountsDealView tabParam="money" detail={withClaims([claim()])} actions={financeActions} destinationOptions={destinationOptions} claimActions={claimActions} openClaimId="cl000000-0000-4000-8000-000000000001" />,
  'b11-accounts-claim-refused': () => <AccountsDealView tabParam="money" detail={withClaims([claim()])} actions={financeActions} destinationOptions={destinationOptions} claimActions={claimRefuse} openClaimId="cl000000-0000-4000-8000-000000000001" />,
  'b11-accounts-claim-own-record': () => (
    <AccountsDealView tabParam="money" detail={withClaims([claim({ actions: { recordReceipt: 'own_record', linkReceipt: 'own_record', markNotReceived: 'own_record' } })])} actions={financeActions} destinationOptions={destinationOptions} claimActions={claimActions} />
  ),
  'b11-accounts-claim-linked': () => (
    <AccountsDealView tabParam="money"
      detail={withClaims([claim({ status: 'linked', displayStatus: 'recorded', linkedReceiptId: financeDetail.receipts[0]!.receiptId, linkedReceiptNo: financeDetail.receipts[0]!.receiptNo, linkKind: 'linked_existing', linkReason: 'Customer paid ₹50 bank charges on top.', linkedByName: 'Synthetic Accounts Delhi', linkedAt: '2026-11-02T08:00:00Z', actions: { recordReceipt: 'wrong_state', linkReceipt: 'wrong_state', markNotReceived: 'wrong_state' } })])}
      actions={financeActions}
      destinationOptions={destinationOptions}
      claimActions={claimActions}
    />
  ),
  'b11-accounts-claim-cheque-pending': () => (
    <AccountsDealView tabParam="money" detail={withClaims([claim({ mode: 'cheque', reference: null, chequeNumber: '004512', chequeDate: '2026-11-01', destination: null, status: 'linked', displayStatus: 'pending_clearance', linkedReceiptNo: 'R-2026-11-000004', linkKind: 'recorded_from_claim', actions: { recordReceipt: 'wrong_state', linkReceipt: 'wrong_state', markNotReceived: 'wrong_state' } })])} actions={financeActions} destinationOptions={destinationOptions} claimActions={claimActions} />
  ),
  'b11-accounts-claim-not-received': () => (
    <AccountsDealView tabParam="money" detail={withClaims([claim({ status: 'not_received', displayStatus: 'not_received', closedReason: 'No credit with this reference on the statement for 1 to 3 November.', closedByName: 'Synthetic Accounts Delhi', closedAt: '2026-11-03T10:00:00Z', actions: { recordReceipt: 'wrong_state', linkReceipt: 'wrong_state', markNotReceived: 'wrong_state' } })])} actions={financeActions} destinationOptions={destinationOptions} claimActions={claimActions} />
  ),
  'b11-accounts-review-plan': () => <AccountsDealView tabParam="review" detail={withClaims([], packageBooking)} actions={financeActions} destinationOptions={destinationOptions} claimActions={claimActions} />,
  'b11-accounts-review-revision': () => (
    <AccountsDealView tabParam="review"
      detail={withClaims([], { ...packageBooking, versionNo: 3, revision: { revisesVersionNo: 2, changeClass: 'customer_material', changedFields: ['items.1.checkOut', 'sellingTotal', 'plan'], sellingDeltaPaise: '500000' }, earlierVersions: [{ versionNo: 2, reviewStatus: 'returned', returnReason: 'Check-out date differs from the acceptance.' }] })}
      actions={financeActions}
      destinationOptions={destinationOptions}
      claimActions={claimActions}
    />
  ),
  'b11-accounts-claims-list': () => <AccountsClaimsListView page={claimsPage('reported')} filter="reported" hrefs={claimHrefs} moreHref={null} />,
  'b11-accounts-claims-empty': () => <AccountsClaimsListView page={claimsPage('reported', true)} filter="reported" hrefs={claimHrefs} moreHref={null} />,
  'b11-accounts-expenses': () => <AccountsExpensesView page={expensePage('submitted')} filter="submitted" hrefs={expenseHrefs} moreHref={null} acceptAction={previewB11FinanceOkAction} returnAction={previewB11FinanceOkAction} />,
  'b11-accounts-expense-own': () => <AccountsExpensesView page={expensePage('submitted', true)} filter="submitted" hrefs={expenseHrefs} moreHref={null} acceptAction={previewB11FinanceOkAction} returnAction={previewB11FinanceOkAction} />,
  'b11-accounts-expense-returned': () => <AccountsExpensesView page={expensePage('returned')} filter="returned" hrefs={expenseHrefs} moreHref={null} acceptAction={previewB11FinanceOkAction} returnAction={previewB11FinanceOkAction} />,
};

const DEPT: Record<string, { viewer: ShellViewer; path: string; render: () => ReactNode }> = {
  'b11-purchase-task-no-price': {
    viewer: purchase,
    path: '/app/purchase',
    render: () => <PurchaseTaskPage task={purchaseView(purchaseQueue[0]!)} work={<DepartmentCostCard taskId="task-1" department="purchase" costs={[]} canRecord={false} readOnlyReason={null} />} />,
  },
  'b11-flight-task-cost-empty': { viewer: flight, path: '/app/flight', render: () => <FlightTaskPage task={flightWithTravellers} claimAction={previewB11SavedAction} workForm={<DepartmentCostCard taskId="task-3" department="flight" costs={[]} canRecord readOnlyReason={null} actions={costActions} />} /> },
  'b11-flight-task-identity': {
    viewer: flight,
    path: '/app/flight',
    render: () => <FlightTaskPage task={flightInternational} claimAction={previewB11SavedAction} />,
  },
  'b11-flight-task-cost-filled': {
    viewer: flight,
    path: '/app/flight',
    render: () => <FlightTaskPage task={flightWithTravellers} claimAction={previewB11SavedAction} workForm={<DepartmentCostCard taskId="task-3" department="flight" costs={[cost({ receiptEvidenceId: proof.id })]} evidence={[proof]} canRecord readOnlyReason={null} actions={costActions} />} />,
  },
  'b11-flight-task-cost-over-limit': {
    viewer: flight,
    path: '/app/flight',
    render: () => (
      <FlightTaskPage
        task={flightWithTravellers}
        claimAction={previewB11SavedAction}
        workForm={<DepartmentCostCard taskId="task-3" department="flight" costs={[]} canRecord readOnlyReason={null} actions={{ ...costActions, save: previewB11OverLimitAction }} startOpen initialState={{ ok: false, code: 'direct_payment_over_limit', message: '', fields: ['amountRupees'] }} />}
      />
    ),
  },
  'b11-flight-task-cost-sent': {
    viewer: flight,
    path: '/app/flight',
    render: () => <FlightTaskPage task={flightWithTravellers} claimAction={previewB11SavedAction} workForm={<DepartmentCostCard taskId="task-3" department="flight" costs={[cost({ expenseStatus: 'submitted', canEdit: false, canSubmit: false })]} evidence={[proof]} canRecord readOnlyReason={null} actions={costActions} />} />,
  },
  'b11-visa-queue': { viewer: visaDesk, path: '/app/visa', render: () => <VisaQueuePage queue={visaQueue(true)} /> },
  'b11-visa-queue-empty': { viewer: visaDesk, path: '/app/visa', render: () => <VisaQueuePage queue={visaQueue(true, true)} /> },
  'b11-visa-queue-not-launched': { viewer: visaDesk, path: '/app/visa', render: () => <VisaQueuePage queue={visaQueue(false)} /> },
  'b11-visa-queue-loading': { viewer: visaDesk, path: '/app/visa', render: () => <VisaQueueLoading /> },
  'b11-visa-task-new': {
    viewer: visaDesk,
    path: '/app/visa',
    render: () => <VisaTaskPage task={visaTask({ status: 'not_started', assigneeName: null, assignedToYou: false, canClaim: true, canWork: false, applicants: notTaken })} actions={visaActions} />,
  },
  'b11-visa-task-claim-conflict': {
    viewer: visaDesk,
    path: '/app/visa',
    render: () => <VisaTaskPage task={visaTask({ status: 'not_started', assigneeName: null, assignedToYou: false, canClaim: true, canWork: false, applicants: [] })} actions={{ ...visaActions, claim: previewB11TaskConflictAction }} preview={{ claimState: { ok: false, code: 'task_conflict', message: 'Another desk colleague has already taken this task.' } }} />,
  },
  'b11-visa-task-docs-pending': { viewer: visaDesk, path: '/app/visa', render: () => <VisaTaskPage task={visaTask()} actions={visaActions} /> },
  'b11-visa-task-submit-refused': {
    viewer: visaDesk,
    path: '/app/visa',
    render: () => <VisaTaskPage task={visaTask()} actions={{ ...visaActions, recordSubmission: previewB11DocumentsNotCheckedAction }} preview={{ submitState: { ok: false, code: 'documents_not_checked', message: '' } }} />,
  },
  'b11-visa-task-submitted': {
    viewer: visaDesk,
    path: '/app/visa',
    render: () => <VisaTaskPage task={visaTask({ applicants: [applicant({ state: 'submitted', documents: docs(['checked', 'checked', 'checked']), reference: 'SYN-VFS-55120', submittedAt: '2026-11-05T06:00:00Z', appointmentAt: '2026-11-05T05:00:00Z', appointmentPlace: 'Synthetic visa centre, Jaipur' })] })} actions={visaActions} />,
  },
  'b11-visa-task-outcome-refused': {
    viewer: visaDesk,
    path: '/app/visa',
    render: () => (
      <VisaTaskPage
        task={visaTask({ applicants: [applicant({ state: 'decision_pending', documents: docs(['checked', 'checked', 'checked']), reference: 'SYN-VFS-55120', submittedAt: '2026-11-05T06:00:00Z' })] })}
        actions={{ ...visaActions, recordOutcome: previewB11OutcomeDocumentAction }}
        preview={{ outcomeState: { ok: false, code: 'outcome_document_required', message: '' } }}
      />
    ),
  },
  'b11-visa-task-issued': {
    viewer: visaDesk,
    path: '/app/visa',
    render: () => <VisaTaskPage task={visaTask({ evidence: [outcomeDoc], applicants: [applicant({ state: 'issued', documents: docs(['checked', 'checked', 'checked']), reference: 'SYN-VFS-55120', submittedAt: '2026-11-05T06:00:00Z', outcomeAt: '2026-11-09T10:00:00Z' })] })} actions={visaActions} />,
  },
  'b11-visa-task-refused': {
    viewer: visaDesk,
    path: '/app/visa',
    render: () => <VisaTaskPage task={visaTask({ evidence: [outcomeDoc], applicants: [applicant({ state: 'refused', documents: docs(['checked', 'checked', 'checked']), reference: 'SYN-VFS-55120', outcomeAt: '2026-11-09T10:00:00Z' })] })} actions={visaActions} />,
  },
  'b11-visa-task-returned': {
    viewer: visaDesk,
    path: '/app/visa',
    render: () => (
      <VisaTaskPage
        task={visaTask({ status: 'completed', completedAt: '2026-11-10T10:00:00Z', canWork: false, evidence: [outcomeDoc], applicants: [applicant({ state: 'issued', closed: true, documents: docs(['checked', 'checked', 'checked']), reference: 'SYN-VFS-55120', outcomeAt: '2026-11-09T10:00:00Z', documentsReturnedAt: '2026-11-10T10:00:00Z', documentsReturnedByName: 'Synthetic Visa Desk Jodhpur' })] })}
        actions={visaActions}
      />
    ),
  },
  'b11-visa-task-passport': {
    viewer: visaDesk,
    path: '/app/visa',
    render: () => <VisaTaskPage task={visaTask({ serviceType: 'passport', itemTitle: 'Renewal · Jaipur', facts: { applicationType: 'renewal', officeCity: 'Jaipur', neededBy: '2026-11-01' }, applicants: [applicant({ documents: docs(['received', 'missing', 'missing']) })] })} actions={visaActions} />,
  },
  'b11-visa-task-fee-expense': {
    viewer: visaDesk,
    path: '/app/visa',
    render: () => (
      <VisaTaskPage
        task={visaTask({ evidence: [{ ...proof, id: 'de4', kind: 'fee_receipt', fileName: 'synthetic-fee-receipt.pdf' }], costs: [cost({ department: 'visa', costKind: 'government_fee', amountPaise: '650000', taskId: 'vt000000-0000-4000-8000-000000000001', expenseStatus: 'submitted', canEdit: false, canSubmit: false, reference: 'SYN-FEE-0042' })] })}
        actions={visaActions}
      />
    ),
  },
  'b11-visa-task-manager': {
    viewer: { ...admin, displayName: 'Synthetic Manager Jodhpur', primaryRole: 'Manager', canAdministerStaff: false, canManageGrants: false, canManageIntegration: false },
    path: '/app/deals',
    render: () => <VisaTaskPage task={visaTask({ assignedToYou: false, canWork: false, applicants: [applicant({ identity: null })] })} actions={visaActions} />,
  },
  'b11-visa-task-not-visible': { viewer: purchase, path: '/app/purchase', render: () => <VisaTaskNotAvailableView /> },
  'b11-home-visa': {
    viewer: visaDesk,
    path: '/app',
    render: () => <HomeView displayName={visaDesk.displayName} memberships={[{ ...delhiSales[0]!, roleName: 'Visa & Passport desk', branchName: 'Jodhpur' }]} counts={{ visible: 0, owned: 0, assigned: 0 }} roles={{ ...NO_ROLES, visa: true }} myWork={visaCounts} />,
  },
  'b11-home-accounts-claims': {
    viewer: accounts,
    path: '/app',
    render: () => <HomeView displayName={accounts.displayName} memberships={[{ ...delhiSales[0]!, roleName: 'Accounts', branchName: 'Jodhpur', isHeadOffice: true }]} counts={{ visible: 0, owned: 0, assigned: 0 }} canUseAccounts roles={{ ...NO_ROLES, accounts: true }} myWork={accountsCounts} />,
  },
  'b11-admin-workflow-b11': {
    viewer: admin,
    path: '/app/admin/workflow',
    render: () => <FeaturesSettingsView model={featuresPreview({ service_items_enabled: 'off', intake_prompt_enabled: 'off', visa_passport_tasks_enabled: 'off', prefill_auto_fill: 'off', referral_drafts: 'off' })} actions={{ change: previewSwitchSavedAction }} bitrixHref="/app/admin/integration" />,
  },
  'b11-admin-won-only-off': {
    viewer: admin,
    path: '/app/admin/integration',
    render: () => (
      <BitrixPreviewPage>
        <WonOnlyCard rule={ruleOff} stageOptions={stageOptions} setAction={wonAction} dryRunAction={pruneAction} runAction={pruneAction} />
      </BitrixPreviewPage>
    ),
  },
  'b12-admin-switches': {
    viewer: admin,
    path: '/app/admin/integration',
    render: () => (
      <BitrixPreviewPage>
        <SettingsSectionView id="bitrix-switches" title="Bitrix switches" section={bitrixRows(bitrixSection({ copy: 'off' }), { openStops: 2 })} actions={{ change: previewSwitchSavedAction }} hideKeys={['bitrix_name_read']} />
      </BitrixPreviewPage>
    ),
  },
  'b12-admin-switches-read-only': {
    viewer: admin,
    path: '/app/admin/integration',
    render: () => (
      <BitrixPreviewPage>
        <SettingsSectionView id="bitrix-switches" title="Bitrix switches" section={bitrixRows(bitrixSection({ canSwitch: false, copy: 'unknown' }))} actions={{ change: previewSwitchNotAuthorizedAction }} hideKeys={['bitrix_name_read']} />
      </BitrixPreviewPage>
    ),
  },
  'b12-admin-copy-alerts': {
    viewer: admin,
    path: '/app/admin/integration',
    render: () => (
      <BitrixPreviewPage>
        <IdProofCopyAlertsCard
          retryAction={previewCopyRetriedAction as unknown as B11Action}
          alerts={{
            manualChecks: [{ jobId: 'cj000000-0000-4000-8000-000000000009', bitrixDealId: '50402', reasonText: null, readBackAttempts: 2, updatedAt: '2026-10-12T09:40:00.000Z', statusText: 'Check the Bitrix deal by hand: the CRM could not tell whether the file arrived.' }],
            stops: [
            { stopId: 's1', jobId: 'j1', bitrixDealId: '50417', reasonText: 'Files that were on the Bitrix deal before are gone. Copying stopped for safety; the Super Admin must check Bitrix first.', openedAt: '2026-10-12T09:30:00.000Z', acknowledgedAt: null, open: true },
            { stopId: 's0', jobId: 'j0', bitrixDealId: '50391', reasonText: 'Files that were on the Bitrix deal before are gone. Copying stopped for safety; the Super Admin must check Bitrix first.', openedAt: '2026-10-10T07:00:00.000Z', acknowledgedAt: '2026-10-10T11:00:00.000Z', open: false },
            ],
          }}
        />
      </BitrixPreviewPage>
    ),
  },
  'b12-admin-copy-alerts-none': {
    viewer: admin,
    path: '/app/admin/integration',
    render: () => (
      <BitrixPreviewPage>
        <IdProofCopyAlertsCard alerts={{ stops: [], manualChecks: [] }} />
      </BitrixPreviewPage>
    ),
  },
  'b12-admin-copy-alerts-unknown': {
    viewer: admin,
    path: '/app/admin/integration',
    render: () => (
      <BitrixPreviewPage>
        <IdProofCopyAlertsCard alerts="error" />
      </BitrixPreviewPage>
    ),
  },
  'b11-admin-won-only-dry-run': {
    viewer: admin,
    path: '/app/admin/integration',
    render: () => (
      <BitrixPreviewPage>
        <WonOnlyCard rule={ruleOn} stageOptions={stageOptions} setAction={wonAction} dryRunAction={pruneAction} runAction={pruneAction} initial={{ dryRun: { status: 'success', message: 'Dry run only, nothing changed: 24 Deals would be removed, 2 Deals kept because they have CRM work, 1 Deal kept while a sync is waiting.', result: dryRun, values: { reason: 'Owner approved Won-only intake on 12 Oct (synthetic).', stageIds: [] } } }} />
      </BitrixPreviewPage>
    ),
  },
  'b11-admin-won-only-unknown': {
    viewer: admin,
    path: '/app/admin/integration',
    render: () => (
      <BitrixPreviewPage>
        <WonOnlyCard rule={null} stageOptions={[]} setAction={wonAction} dryRunAction={pruneAction} runAction={pruneAction} />
      </BitrixPreviewPage>
    ),
  },
};

export const B11_WORK_STATES = [...Object.keys(STATES), ...Object.keys(DEPT)];

export function renderB11WorkState(state: string): ReactNode | null {
  const s = STATES[state];
  if (s) {
    return (
      <StaffShell viewer={state === 'b11-accounts-claim-own-record' ? accounts2 : accounts} currentPath={state.startsWith('b11-accounts-claims') ? '/app/accounts/claims' : state.startsWith('b11-accounts-expense') ? '/app/accounts/expenses' : '/app/accounts'}>
        {s()}
      </StaffShell>
    );
  }
  const d = DEPT[state];
  if (d) {
    if (d.path.startsWith('/app/admin')) return inSettings(d.viewer, d.path, d.render());
    return (
      <StaffShell viewer={d.viewer} currentPath={d.path}>
        {d.render()}
      </StaffShell>
    );
  }
  return null;
}
