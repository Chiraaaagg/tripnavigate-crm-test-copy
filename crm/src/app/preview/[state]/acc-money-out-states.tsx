import type { ReactNode } from 'react';
import type { AccountsGoAheadRow } from '@/modules/procurement/contracts';
import type { AccountsSupplierDocumentsView, AccountsSupplierPaymentRow, CompanyFundingRow } from '@/modules/supplier-money/contracts';
import type { AccountsSectionViewer } from '@/views/accounts-desk/sections';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import { AccountsCompanyFundingPage } from '@/views/accounts/supplier-funding';
import { AccountsGoAheadPage } from '@/views/accounts/supplier-go-ahead';
import { AccountsSupplierInvoicesPage } from '@/views/accounts/supplier-invoices';
import { AccountsSupplierPaymentsPage } from '@/views/accounts/supplier-payments';
import {
  pmPreviewBookingNotApprovedAction,
  pmPreviewDecideAction,
  pmPreviewRecordAction,
  pmPreviewRecoverAction,
  pmPreviewUploadAction,
  pmPreviewVerifyAction,
} from './pm-preview-actions';

/*
 * Accounts · Money out preview states (redesign R4, helper A2): Hotel
 * go-ahead, Supplier payments, Supplier invoices and Company funding. Moved
 * here from purchase-money-states.tsx, which spreads them into its own list
 * so every state keeps its pm-accounts- name (the gallery index and
 * tests/e2e/pb-screens.e2e.ts find them by that prefix). New R4 states that
 * open a dialog on load use the amo- prefix (tests/e2e/acc-money-out.e2e.ts). Synthetic props only
 * (example names, made-up amounts, SYN- deal references, no real supplier,
 * bank or customer data). Rendered by the design-review gallery, never in
 * production.
 */

const accountsViewer: ShellViewer = {
  displayName: 'Synthetic Accounts Jodhpur',
  primaryRole: 'Accounts',
  primaryBranch: 'Jodhpur',
  canAdministerStaff: false,
  canManageGrants: false,
  canUseAccounts: true,
};
/** The Money out tab strip's flags for the same person (Money out tabs need canUseAccounts only). */
const sectionViewer: AccountsSectionViewer = { canUseAccounts: true, canCheckCustomers: false, canSeeAccountsDesk: false, canSeeBranchMoney: false, canSeeOwnDues: false };

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

const goAheadRows: AccountsGoAheadRow[] = [
  { ...goAheadBase, contractState: 'differs', contractTotalPaise: '3960000', contractDeviationReason: 'Festival week: the hotel added a surcharge not in the contract.' },
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

export const paymentBase: AccountsSupplierPaymentRow = {
  department: 'purchase',
  flightBatchNo: null,
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
  // Above ₹50,000 for this supplier on this Deal: routed to the branch Manager, so Accounts may not decide it.
  {
    ...paymentBase,
    id: id(39),
    refNo: 'SP-2026-000050',
    dealReference: 'SYN-DEL-012',
    supplierName: 'Example Palace Partners',
    serviceTitle: 'Example Palace Hotel, Udaipur',
    amountPaise: '7500000',
    customerMoneyPaise: '7500000',
    agreedCostPaise: '15000000',
    route: 'manager',
    canDecide: false,
    note: null,
  },
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
      department: 'purchase',
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
      department: 'purchase',
    },
  ],
  missingInvoices: [
    { taskId: id(23), dealReference: 'SYN-DEL-008', serviceTitle: 'Example Beach Hotel, Goa', supplierId: id(43), supplierName: 'Example Coast Partners', tripEnd: '2026-10-25', assigneeName: 'Synthetic Purchase Jodhpur', department: 'purchase' },
  ],
};

// ---------------------------------------------------------------------------
// Company funding
// ---------------------------------------------------------------------------

export const fundingBase: CompanyFundingRow = {
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
// States
// ---------------------------------------------------------------------------

const paymentActions = { decide: pmPreviewDecideAction, record: pmPreviewRecordAction, upload: pmPreviewUploadAction, verify: pmPreviewVerifyAction };
const fundingActions = { decide: pmPreviewDecideAction, recover: pmPreviewRecoverAction };

function accounts(path: string, body: ReactNode) {
  return (
    <StaffShell viewer={accountsViewer} currentPath={path}>
      {body}
    </StaffShell>
  );
}

const payments = (rows: AccountsSupplierPaymentRow[], tab: 'to_approve' | 'to_record' | 'to_verify' | 'all', previewReturnOpen?: string) =>
  accounts('/app/accounts/supplier-payments', <AccountsSupplierPaymentsPage rows={rows} tab={tab} actions={paymentActions} today={TODAY} sectionViewer={sectionViewer} previewReturnOpen={previewReturnOpen} />);
const invoices = (view: AccountsSupplierDocumentsView, tab: 'to_review' | 'missing' | 'all') =>
  accounts('/app/accounts/supplier-invoices', <AccountsSupplierInvoicesPage view={view} tab={tab} reviewAction={pmPreviewDecideAction} sectionViewer={sectionViewer} />);
const funding = (rows: CompanyFundingRow[], tab: 'to_approve' | 'to_recover' | 'all') =>
  accounts('/app/accounts/funding', <AccountsCompanyFundingPage rows={rows} tab={tab} actions={fundingActions} sectionViewer={sectionViewer} />);
const goAhead = (rows: AccountsGoAheadRow[], tab: 'to_check' | 'all', decideAction = pmPreviewDecideAction) =>
  accounts('/app/accounts/go-ahead', <AccountsGoAheadPage rows={rows} tab={tab} decideAction={decideAction} sectionViewer={sectionViewer} />);

const STATES: Record<string, () => ReactNode> = {
  'pm-accounts-go-ahead': () => goAhead(goAheadRows, 'to_check'),
  'pm-accounts-go-ahead-all': () => goAhead(goAheadRows, 'all'),
  'pm-accounts-go-ahead-refused': () => goAhead(goAheadRows.slice(0, 1), 'to_check', pmPreviewBookingNotApprovedAction),
  'pm-accounts-go-ahead-empty': () => goAhead([], 'to_check'),
  // Includes the own request (both buttons disabled with the reason) and a request above ₹50,000 ("Needs the branch Manager", no Approve).
  'pm-accounts-supplier-payments-to-approve': () => payments(toApprove, 'to_approve'),
  // R4: the shared return dialog open on the first request (reason required, 10 to 500 characters). Not pm-:
  // a modal hides the rest of the page from assistive technology, so pb-screens' one-h1 loop cannot read it;
  // tests/e2e/acc-money-out.e2e.ts checks it instead.
  'amo-supplier-payments-return-open': () => payments(toApprove, 'to_approve', paymentBase.id),
  'pm-accounts-supplier-payments-to-record': () => payments(toRecord, 'to_record'),
  'pm-accounts-supplier-payments-to-verify': () => payments(toVerify, 'to_verify'),
  'pm-accounts-supplier-payments-all': () => payments(allPayments, 'all'),
  'pm-accounts-supplier-payments-empty': () => payments([], 'to_approve'),
  'pm-accounts-supplier-invoices': () => invoices({ documents: docs.documents.slice(0, 1), missingInvoices: [] }, 'to_review'),
  // R4: an upload by this person: Accept and Return disabled with the reason.
  'pm-accounts-supplier-invoices-own': () => invoices({ documents: [{ ...docs.documents[0]!, canReview: false, uploadedByName: 'Synthetic Accounts Jodhpur' }], missingInvoices: [] }, 'to_review'),
  'pm-accounts-supplier-invoices-missing': () => invoices({ documents: [], missingInvoices: docs.missingInvoices }, 'missing'),
  'pm-accounts-supplier-invoices-all': () => invoices(docs, 'all'),
  'pm-accounts-supplier-invoices-empty': () => invoices({ documents: [], missingInvoices: [] }, 'to_review'),
  // Includes a request above ₹50,000 ("Needs the branch Manager", no Approve).
  'pm-accounts-funding': () => funding(fundingToApprove, 'to_approve'),
  'pm-accounts-funding-to-recover': () => funding(fundingToRecover, 'to_recover'),
  'pm-accounts-funding-all': () => funding(fundingAll, 'all'),
  'pm-accounts-funding-empty': () => funding([], 'to_approve'),
};

/** The Accounts money-out states; purchase-money-states.tsx spreads them into the pm- list. */
export const ACC_MONEY_OUT_STATES: Readonly<Record<string, () => ReactNode>> = STATES;
