import type { ReactNode } from 'react';
import type { AccountsGoAheadRow, ManagerCancellationRow as CancellationDetailRow } from '@/modules/procurement/contracts';
import type {
  AccountsSupplierDocumentsView,
  AccountsSupplierPaymentRow,
  CompanyFundingRow,
  ManagerApprovalsView,
} from '@/modules/supplier-money/contracts';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import { AccountsCompanyFundingPage } from '@/views/accounts/supplier-funding';
import { AccountsGoAheadPage } from '@/views/accounts/supplier-go-ahead';
import { AccountsSupplierInvoicesPage } from '@/views/accounts/supplier-invoices';
import { AccountsSupplierPaymentsPage } from '@/views/accounts/supplier-payments';
import { ManagerApprovalsPage } from '@/views/purchase/manager-approvals';
import {
  pmPreviewBookingNotApprovedAction,
  pmPreviewDecideAction,
  pmPreviewRecordAction,
  pmPreviewRecoverAction,
  pmPreviewUploadAction,
  pmPreviewVerifyAction,
} from './pm-preview-actions';

/*
 * Purchase build preview states (pm-): Accounts go-ahead, supplier payments,
 * supplier invoices, company funding and the Manager's Approvals page.
 * Synthetic props only (example names, made-up amounts, SYN- deal
 * references, no real supplier, bank or customer data). Rendered by the
 * design-review gallery, never in production.
 */

const accountsViewer: ShellViewer = {
  displayName: 'Synthetic Accounts Jodhpur',
  primaryRole: 'Accounts',
  primaryBranch: 'Jodhpur',
  canAdministerStaff: false,
  canManageGrants: false,
  canUseAccounts: true,
};
const managerViewer: ShellViewer = {
  displayName: 'Synthetic Manager Jodhpur',
  primaryRole: 'Manager',
  primaryBranch: 'Jodhpur',
  canAdministerStaff: false,
  canManageGrants: false,
  canSeePurchaseTasks: true,
};

const TODAY = '2026-11-02';
const id = (n: number, prefix = 'd') => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ---------------------------------------------------------------------------
// Go-ahead
// ---------------------------------------------------------------------------

const goAheadBase: AccountsGoAheadRow = {
  requestId: id(1),
  status: 'pending',
  current: true,
  dealId: id(11),
  dealReference: 'SYN-DEL-001',
  branchName: 'Jodhpur',
  taskId: id(21),
  itemTitle: 'Synthetic Lakeside Hotel, Udaipur',
  checkIn: '2026-11-14',
  checkOut: '2026-11-17',
  supplierName: 'Synthetic Stays Pvt (example)',
  amountPaise: '4200000',
  costVersionNo: 2,
  requestedAt: '2026-11-01T06:10:00Z',
  requestedByName: 'Synthetic Purchase Jodhpur',
  decidedAt: null,
  decidedByName: null,
  returnReason: null,
  rowVersion: 1,
  bookingReviewStatus: 'approved',
  canDecide: true,
};

export const goAheadRows: AccountsGoAheadRow[] = [
  goAheadBase,
  { ...goAheadBase, requestId: id(2), dealReference: 'SYN-DEL-002', itemTitle: 'Example Desert Camp, Jaisalmer', supplierName: 'Example Dune Partners', amountPaise: '9850000', bookingReviewStatus: 'pending', checkIn: '2026-12-02', checkOut: '2026-12-04' },
  { ...goAheadBase, requestId: id(3), dealReference: 'SYN-DEL-003', itemTitle: 'Example Fort View Hotel, Jodhpur', current: false, canDecide: false, costVersionNo: 1 },
  { ...goAheadBase, requestId: id(4), dealReference: 'SYN-DEL-004', itemTitle: 'Synthetic Garden Resort, Mount Abu', canDecide: false, requestedByName: 'Synthetic Accounts Jodhpur' },
  { ...goAheadBase, requestId: id(5), dealReference: 'SYN-DEL-005', status: 'approved', canDecide: false, decidedAt: '2026-10-30T09:00:00Z', decidedByName: 'Synthetic Accounts Delhi' },
  { ...goAheadBase, requestId: id(6), dealReference: 'SYN-DEL-006', status: 'returned', canDecide: false, decidedAt: '2026-10-29T09:00:00Z', decidedByName: 'Synthetic Accounts Delhi', returnReason: 'The room count does not match the approved booking. Check with Sales and send again.' },
];

// ---------------------------------------------------------------------------
// Supplier payments
// ---------------------------------------------------------------------------

const bank = { revisionNo: 2, accountHolder: 'Synthetic Stays Pvt', bankName: 'Example Bank', ifsc: 'EXMP0000001', accountLast4: '4321', status: 'approved' as const };

const paymentBase: AccountsSupplierPaymentRow = {
  id: id(31),
  refNo: 'SP-2026-000041',
  dealId: id(11),
  dealReference: 'SYN-DEL-001',
  branchName: 'Jodhpur',
  taskId: id(21),
  serviceTitle: 'Synthetic Lakeside Hotel, Udaipur',
  serviceType: 'hotel',
  supplierId: id(41),
  supplierName: 'Synthetic Stays Pvt (example)',
  part: 'deposit',
  amountPaise: '2100000',
  customerMoneyPaise: '2100000',
  dueDate: '2026-11-05',
  note: '50% deposit to hold the rooms.',
  route: 'accounts',
  status: 'pending',
  costVersionNo: 2,
  agreedCostPaise: '4200000',
  proformaEvidenceId: id(51),
  returnReason: null,
  requestedAt: '2026-11-01T07:00:00Z',
  requestedByName: 'Synthetic Purchase Jodhpur',
  decidedAt: null,
  decidedByName: null,
  paidOn: null,
  paymentMode: null,
  bankReference: null,
  paymentProofEvidenceId: null,
  bankRevisionNo: null,
  recordedAt: null,
  recordedByName: null,
  verifiedAt: null,
  verifiedByName: null,
  bankDetails: bank,
  funding: null,
  onHold: false,
  holdReason: null,
  rowVersion: 1,
  canDecide: true,
  canRecord: false,
  canVerify: false,
};

const toApprove: AccountsSupplierPaymentRow[] = [
  paymentBase,
  {
    ...paymentBase,
    id: id(32),
    refNo: 'SP-2026-000042',
    supplierName: 'Example Dune Partners',
    serviceTitle: 'Example Desert Camp, Jaisalmer',
    dealReference: 'SYN-DEL-002',
    part: 'balance',
    amountPaise: '3000000',
    customerMoneyPaise: '1000000',
    funding: { id: id(61), amountPaise: '2000000', reason: 'Camp releases the tents tomorrow unless paid.', route: 'accounts', status: 'pending' },
    canDecide: true,
    note: null,
  },
  { ...paymentBase, id: id(33), refNo: 'SP-2026-000043', dealReference: 'SYN-DEL-004', canDecide: false, requestedByName: 'Synthetic Accounts Jodhpur' },
];

const toRecord: AccountsSupplierPaymentRow[] = [
  { ...paymentBase, status: 'approved', canDecide: false, canRecord: true, decidedAt: '2026-11-01T09:00:00Z', decidedByName: 'Synthetic Accounts Delhi' },
  {
    ...paymentBase,
    id: id(34),
    refNo: 'SP-2026-000044',
    supplierName: 'Example Coach Partners',
    serviceTitle: 'Example coach, Jodhpur to Jaisalmer',
    serviceType: 'transfer',
    status: 'approved',
    canDecide: false,
    canRecord: true,
    onHold: true,
    holdReason: 'bank_details_on_hold',
    bankDetails: { ...bank, accountHolder: 'Example Coach Partners', revisionNo: 3, status: 'unverified', accountLast4: '8765' },
    decidedAt: '2026-11-01T09:00:00Z',
    decidedByName: 'Synthetic Accounts Delhi',
  },
];

const toVerify: AccountsSupplierPaymentRow[] = [
  {
    ...paymentBase,
    status: 'paid',
    canDecide: false,
    canVerify: true,
    decidedAt: '2026-11-01T09:00:00Z',
    decidedByName: 'Synthetic Accounts Delhi',
    paidOn: '2026-11-02',
    paymentMode: 'bank_transfer',
    bankReference: 'SYNUTR0001',
    paymentProofEvidenceId: id(52),
    bankRevisionNo: 2,
    recordedAt: '2026-11-02T05:00:00Z',
    recordedByName: 'Synthetic Accounts Delhi',
  },
  {
    ...paymentBase,
    id: id(35),
    refNo: 'SP-2026-000045',
    status: 'paid',
    canDecide: false,
    canVerify: false,
    paidOn: '2026-11-02',
    paymentMode: 'upi',
    bankReference: 'SYNUPI0002',
    paymentProofEvidenceId: id(53),
    recordedAt: '2026-11-02T05:30:00Z',
    recordedByName: 'Synthetic Accounts Jodhpur',
  },
];

const allPayments: AccountsSupplierPaymentRow[] = [
  ...toApprove.slice(0, 1),
  ...toRecord.slice(0, 1),
  ...toVerify.slice(0, 1),
  { ...paymentBase, id: id(36), refNo: 'SP-2026-000046', status: 'verified', canDecide: false, paidOn: '2026-10-28', paymentMode: 'cheque', bankReference: '000123', verifiedAt: '2026-10-29T06:00:00Z', verifiedByName: 'Synthetic Accounts Jodhpur', recordedByName: 'Synthetic Accounts Delhi', recordedAt: '2026-10-28T06:00:00Z' },
  { ...paymentBase, id: id(37), refNo: 'SP-2026-000047', status: 'returned', canDecide: false, decidedAt: '2026-10-27T06:00:00Z', decidedByName: 'Synthetic Accounts Delhi', returnReason: 'The proforma is for a different stay date. Ask the supplier for a corrected one.' },
];

// ---------------------------------------------------------------------------
// Supplier invoices
// ---------------------------------------------------------------------------

const docs: AccountsSupplierDocumentsView = {
  documents: [
    {
      id: id(71),
      kind: 'invoice',
      taskId: id(21),
      dealReference: 'SYN-DEL-001',
      serviceTitle: 'Synthetic Lakeside Hotel, Udaipur',
      supplierId: id(41),
      supplierName: 'Synthetic Stays Pvt (example)',
      number: 'SYN-INV-1001',
      docDate: '2026-11-18',
      totalPaise: '4200000',
      gstIncluded: true,
      evidenceId: id(54),
      status: 'uploaded',
      returnReason: null,
      uploadedAt: '2026-11-19T06:00:00Z',
      uploadedByName: 'Synthetic Purchase Jodhpur',
      reviewedAt: null,
      reviewedByName: null,
      rowVersion: 1,
      branchName: 'Jodhpur',
      canReview: true,
    },
    {
      id: id(72),
      kind: 'credit_note',
      taskId: id(22),
      dealReference: 'SYN-DEL-007',
      serviceTitle: 'Example Fort View Hotel, Jodhpur',
      supplierId: id(42),
      supplierName: 'Example Fort Partners',
      number: 'SYN-CN-0007',
      docDate: '2026-10-30',
      totalPaise: '1500000',
      gstIncluded: false,
      evidenceId: id(55),
      status: 'returned',
      returnReason: 'The credit note total does not match the agreed refund. Ask the supplier for a corrected note.',
      uploadedAt: '2026-10-30T06:00:00Z',
      uploadedByName: 'Synthetic Purchase Jodhpur',
      reviewedAt: '2026-10-31T06:00:00Z',
      reviewedByName: 'Synthetic Accounts Delhi',
      rowVersion: 2,
      branchName: 'Jodhpur',
      canReview: false,
    },
  ],
  missingInvoices: [
    { taskId: id(23), dealReference: 'SYN-DEL-008', serviceTitle: 'Example Beach Hotel, Goa', supplierId: id(43), supplierName: 'Example Coast Partners', tripEnd: '2026-10-25', assigneeName: 'Synthetic Purchase Jodhpur' },
  ],
};

// ---------------------------------------------------------------------------
// Company funding
// ---------------------------------------------------------------------------

const fundingBase: CompanyFundingRow = {
  id: id(61),
  paymentRequestId: id(32),
  paymentRefNo: 'SP-2026-000042',
  paymentStatus: 'pending',
  dealId: id(12),
  dealReference: 'SYN-DEL-002',
  branchName: 'Jodhpur',
  supplierName: 'Example Dune Partners',
  serviceTitle: 'Example Desert Camp, Jaisalmer',
  amountPaise: '2000000',
  reason: 'The camp releases the tents tomorrow unless the balance is paid today.',
  route: 'accounts',
  status: 'pending',
  returnReason: null,
  requestedAt: '2026-11-01T07:10:00Z',
  requestedByName: 'Synthetic Purchase Jodhpur',
  decidedAt: null,
  decidedByName: null,
  recoveredAt: null,
  recoveredByName: null,
  recoveryNote: null,
  rowVersion: 1,
  canDecide: true,
  canMarkRecovered: false,
};

const fundingToApprove: CompanyFundingRow[] = [fundingBase, { ...fundingBase, id: id(62), paymentRefNo: 'SP-2026-000048', dealReference: 'SYN-DEL-009', route: 'manager', amountPaise: '7500000', canDecide: false }];
const fundingToRecover: CompanyFundingRow[] = [
  { ...fundingBase, id: id(63), status: 'approved', paymentStatus: 'paid', canDecide: false, canMarkRecovered: true, decidedAt: '2026-11-01T09:00:00Z', decidedByName: 'Synthetic Accounts Delhi' },
];
const fundingAll: CompanyFundingRow[] = [
  ...fundingToApprove,
  ...fundingToRecover,
  { ...fundingBase, id: id(64), status: 'recovered', paymentStatus: 'verified', canDecide: false, decidedAt: '2026-10-20T09:00:00Z', decidedByName: 'Synthetic Accounts Delhi', recoveredAt: '2026-10-26T09:00:00Z', recoveredByName: 'Synthetic Accounts Jodhpur', recoveryNote: 'Customer payment verified on 26 Oct (synthetic receipt).' },
];

// ---------------------------------------------------------------------------
// Manager approvals
// ---------------------------------------------------------------------------

const approvals: ManagerApprovalsView = {
  costsAboveBudget: [
    { taskId: id(24), dealReference: 'SYN-DEL-010', serviceTitle: 'Example Palace Hotel, Udaipur', supplierName: 'Example Palace Partners', versionNo: 3, amountPaise: '3840000', budgetPaise: '3600000', proposedAt: '2026-11-01T08:00:00Z', proposedByName: 'Synthetic Purchase Colleague', canApprove: true },
  ],
  payments: [{ ...paymentBase, id: id(38), refNo: 'SP-2026-000049', route: 'manager', amountPaise: '11400000', customerMoneyPaise: '11400000', part: 'deposit', dealReference: 'SYN-DEL-011', canDecide: true, agreedCostPaise: '22800000' }],
  funding: [{ ...fundingBase, id: id(65), route: 'manager', amountPaise: '7500000', dealReference: 'SYN-DEL-009', paymentRefNo: 'SP-2026-000048' }],
  bankDetails: [{ supplierId: id(44), supplierName: 'Example Coach Partners', revisionNo: 3, accountHolder: 'Example Coach Partners', bankName: 'Example Bank', ifsc: 'EXMP0000002', accountLast4: '8765', createdAt: '2026-10-31T06:00:00Z', createdByName: 'Synthetic Purchase Jodhpur', canApprove: true }],
  suppliersToVerify: [{ supplierId: id(45), name: 'Synthetic Heritage Stays (example)', city: 'Bikaner', serviceTypes: ['hotel'], rowVersion: 2, updatedAt: '2026-10-30T06:00:00Z', canVerify: true }],
  cancellations: [
    { cancellationId: id(81), dealId: id(13), dealReference: 'SYN-DEL-012', reason: 'The customer cancelled the trip after a family emergency.', status: 'sent_to_manager', sentAt: '2026-11-01T10:00:00Z', sentByName: 'Synthetic Purchase Jodhpur', chargeCount: 2, supplierKeepsPaise: '1200000', supplierRefundPaise: '3300000', rowVersion: 3, canDecide: true },
  ],
};

const cancellationDetails: CancellationDetailRow[] = [
  {
    cancellationId: id(81),
    dealId: id(13),
    dealReference: 'SYN-DEL-012',
    branchName: 'Jodhpur',
    status: 'sent_to_manager',
    reason: 'The customer cancelled the trip after a family emergency.',
    openedAt: '2026-10-31T06:00:00Z',
    openedByName: 'Synthetic Manager Jodhpur',
    sentAt: '2026-11-01T10:00:00Z',
    sentByName: 'Synthetic Purchase Jodhpur',
    decidedAt: null,
    decidedByName: null,
    returnReason: null,
    rowVersion: 3,
    charges: [
      { taskId: id(25), itemTitle: 'Example Lake Hotel, Udaipur', revisionNo: 1, supplierId: id(46), supplierName: 'Example Lake Partners', committedCostPaise: '3000000', supplierKeepsPaise: '900000', supplierRefundPaise: '2100000', note: null, creditNoteEvidenceId: null, enteredAt: '2026-11-01T09:00:00Z', enteredByName: 'Synthetic Purchase Jodhpur' },
      { taskId: id(26), itemTitle: 'Example city tour, Udaipur', revisionNo: 1, supplierId: id(47), supplierName: 'Example Tours (example)', committedCostPaise: '1500000', supplierKeepsPaise: '300000', supplierRefundPaise: '1200000', note: null, creditNoteEvidenceId: null, enteredAt: '2026-11-01T09:10:00Z', enteredByName: 'Synthetic Purchase Jodhpur' },
    ],
    totalKeepsPaise: '1200000',
    totalRefundPaise: '3300000',
    canDecide: true,
  },
];

const emptyApprovals: ManagerApprovalsView = { costsAboveBudget: [], payments: [], funding: [], bankDetails: [], suppliersToVerify: [], cancellations: [] };

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

const paymentActions = { decide: pmPreviewDecideAction, record: pmPreviewRecordAction, upload: pmPreviewUploadAction, verify: pmPreviewVerifyAction };
const fundingActions = { decide: pmPreviewDecideAction, recover: pmPreviewRecoverAction };
const managerActions = { decidePayment: pmPreviewDecideAction, decideFunding: pmPreviewDecideAction, decideCancellation: pmPreviewDecideAction };

function accounts(path: string, body: ReactNode) {
  return (
    <StaffShell viewer={accountsViewer} currentPath={path}>
      {body}
    </StaffShell>
  );
}

function manager(body: ReactNode) {
  return (
    <StaffShell viewer={managerViewer} currentPath="/app/approvals">
      {body}
    </StaffShell>
  );
}

const STATES: Record<string, () => ReactNode> = {
  'pm-accounts-go-ahead': () => accounts('/app/accounts/go-ahead', <AccountsGoAheadPage rows={goAheadRows} tab="to_check" decideAction={pmPreviewDecideAction} />),
  'pm-accounts-go-ahead-all': () => accounts('/app/accounts/go-ahead', <AccountsGoAheadPage rows={goAheadRows} tab="all" decideAction={pmPreviewDecideAction} />),
  'pm-accounts-go-ahead-refused': () => accounts('/app/accounts/go-ahead', <AccountsGoAheadPage rows={goAheadRows.slice(0, 1)} tab="to_check" decideAction={pmPreviewBookingNotApprovedAction} />),
  'pm-accounts-go-ahead-empty': () => accounts('/app/accounts/go-ahead', <AccountsGoAheadPage rows={[]} tab="to_check" decideAction={pmPreviewDecideAction} />),
  'pm-accounts-supplier-payments-to-approve': () => accounts('/app/accounts/supplier-payments', <AccountsSupplierPaymentsPage rows={toApprove} tab="to_approve" actions={paymentActions} today={TODAY} />),
  'pm-accounts-supplier-payments-to-record': () => accounts('/app/accounts/supplier-payments', <AccountsSupplierPaymentsPage rows={toRecord} tab="to_record" actions={paymentActions} today={TODAY} />),
  'pm-accounts-supplier-payments-to-verify': () => accounts('/app/accounts/supplier-payments', <AccountsSupplierPaymentsPage rows={toVerify} tab="to_verify" actions={paymentActions} today={TODAY} />),
  'pm-accounts-supplier-payments-all': () => accounts('/app/accounts/supplier-payments', <AccountsSupplierPaymentsPage rows={allPayments} tab="all" actions={paymentActions} today={TODAY} />),
  'pm-accounts-supplier-payments-empty': () => accounts('/app/accounts/supplier-payments', <AccountsSupplierPaymentsPage rows={[]} tab="to_approve" actions={paymentActions} today={TODAY} />),
  'pm-accounts-supplier-invoices': () => accounts('/app/accounts/supplier-invoices', <AccountsSupplierInvoicesPage view={{ documents: docs.documents.slice(0, 1), missingInvoices: [] }} tab="to_review" reviewAction={pmPreviewDecideAction} />),
  'pm-accounts-supplier-invoices-missing': () => accounts('/app/accounts/supplier-invoices', <AccountsSupplierInvoicesPage view={{ documents: [], missingInvoices: docs.missingInvoices }} tab="missing" reviewAction={pmPreviewDecideAction} />),
  'pm-accounts-supplier-invoices-all': () => accounts('/app/accounts/supplier-invoices', <AccountsSupplierInvoicesPage view={docs} tab="all" reviewAction={pmPreviewDecideAction} />),
  'pm-accounts-supplier-invoices-empty': () => accounts('/app/accounts/supplier-invoices', <AccountsSupplierInvoicesPage view={{ documents: [], missingInvoices: [] }} tab="to_review" reviewAction={pmPreviewDecideAction} />),
  'pm-accounts-funding': () => accounts('/app/accounts/funding', <AccountsCompanyFundingPage rows={fundingToApprove} tab="to_approve" actions={fundingActions} />),
  'pm-accounts-funding-to-recover': () => accounts('/app/accounts/funding', <AccountsCompanyFundingPage rows={fundingToRecover} tab="to_recover" actions={fundingActions} />),
  'pm-accounts-funding-all': () => accounts('/app/accounts/funding', <AccountsCompanyFundingPage rows={fundingAll} tab="all" actions={fundingActions} />),
  'pm-accounts-funding-empty': () => accounts('/app/accounts/funding', <AccountsCompanyFundingPage rows={[]} tab="to_approve" actions={fundingActions} />),
  'pm-manager-approvals': () => manager(<ManagerApprovalsPage view={approvals} actions={managerActions} today={TODAY} cancellationDetails={cancellationDetails} />),
  'pm-manager-approvals-empty': () => manager(<ManagerApprovalsPage view={emptyApprovals} actions={managerActions} today={TODAY} />),
};

export const PURCHASE_MONEY_STATES = Object.keys(STATES);

export function renderPurchaseMoneyState(state: string): ReactNode | null {
  const render = STATES[state];
  return render ? render() : null;
}
