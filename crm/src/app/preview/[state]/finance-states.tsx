import type { ReactNode } from 'react';
import { SettingsShell } from './settings-preview-frame';
import { moneyRulesModel } from '@/modules/settings/server/queries';
import { switchStates } from './batch4-settings-fixtures';
import { ACCOUNTS_DEAL_TABS, type AccountsDealTab } from '@/modules/settings/contracts';
import type { DealListItem } from '@/modules/deals/dto';
import type {
  AccountsDealDetail,
  AccountsQueueItem,
  ActionBlock,
  CashBranchView,
  CashOverview,
  CompanyDestinationsPage,
  CompanyDestinationView,
  DestinationOption,
  DestinationVersionDetail,
  DestinationVersionView,
  FinancePolicyPage,
  FinancePolicyView,
  ReceiptAction,
  ReceiptView,
  UnresolvedCashItem,
  UnresolvedCashKind,
} from '@/modules/finance/contracts';
import type { ProcurementActionResult } from '@/modules/procurement/contracts';
import { CashOverviewView, FinancePolicyPageView } from '@/views/finance-cash-views';
import { CompanyDestinationsView } from '@/views/finance-destination-views';
import type { DestinationDetailState, FinanceAction, FinanceActions, FinanceActionState } from '@/views/finance-forms';
import {
  AccountsDealNotFoundView,
  AccountsDealView,
  AccountsQueueView,
  FinanceLoadingView,
  FinanceNoAccessView,
  FinanceUnavailableView,
} from '@/views/finance-views';
import { ConfirmSupplierForm } from '@/views/procurement-forms';
import { DealsListScreen } from '@/views/deals-list-view';
import { previewDealsProps } from './batch1-fixtures';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';

/*
 * Phase 5A Accounts design-review states. Synthetic props only: made-up
 * deals, people, amounts and references (example-style names). The stub
 * action saves nothing and answers with a preview message.
 */

async function previewAction(): Promise<FinanceActionState> {
  'use server';
  return { status: 'error', code: 'environment_unset', message: 'Design preview: nothing is saved. Use the real Accounts page.' };
}

/** Simulates a lost response: the outcome is unknown, so the form must keep its requestId. */
async function previewUnknownOutcomeAction(): Promise<FinanceActionState> {
  'use server';
  throw new Error('Design preview: simulated lost response.');
}

/** Synthetic full details for "Show full details" (made-up values; nothing is read or audited). */
const PREVIEW_DETAILS: Record<string, Omit<DestinationVersionDetail, 'versionId'>> = {
  'c5000000-0000-4000-8000-000000000011': { versionNo: 1, holderName: 'Synthetic Holidays Pvt Ltd', bankName: 'Synthetic Bank', accountNumber: '000123451111', ifsc: 'SYNB0001234', payeeName: null, upiId: null },
  'c5000000-0000-4000-8000-000000000012': { versionNo: 2, holderName: 'Synthetic Holidays Pvt Ltd', bankName: 'Synthetic Bank', accountNumber: '000123456789', ifsc: 'SYNB0001234', payeeName: null, upiId: null },
  'c5000000-0000-4000-8000-000000000013': { versionNo: 3, holderName: 'Synthetic Holidays Pvt Ltd', bankName: 'Synthetic Bank', accountNumber: '000123452222', ifsc: 'SYNB0005678', payeeName: null, upiId: null },
};

/** Simulates the receipt being refused because the chosen account was replaced or retired meanwhile. */
async function previewDestinationChangedAction(): Promise<FinanceActionState> {
  'use server';
  return {
    status: 'error',
    code: 'destination_changed',
    message: 'The company account you chose is no longer the approved current one (it was replaced or retired). Choose the account again.',
  };
}

async function previewDestinationDetail(_prev: DestinationDetailState, formData: FormData): Promise<DestinationDetailState> {
  'use server';
  const versionId = String(formData.get('versionId') ?? '');
  const found = PREVIEW_DETAILS[versionId];
  if (!found) return { status: 'error', message: 'Design preview: no synthetic details for this version. Nothing was read.' };
  return { status: 'ok', detail: { versionId, ...found } };
}

const stub: FinanceAction = previewAction;
export const actions: FinanceActions = {
  saveBillingAction: stub,
  verifyBillingAction: stub,
  returnReviewAction: stub,
  approveReviewAction: stub,
  recordReceiptAction: stub,
  verifyReceiptAction: stub,
  rejectReceiptAction: stub,
  clearChequeAction: stub,
  markChequeAction: stub,
  representChequeAction: stub,
  reverseReceiptAction: stub,
  recordDepositAction: stub,
  verifyDepositAction: stub,
  rejectDepositAction: stub,
  recordReconciliationAction: stub,
  verifyReconciliationAction: stub,
  updatePolicyAction: stub,
  uploadEvidenceAction: stub,
  submitDestinationAction: stub,
  approveDestinationAction: stub,
  returnDestinationAction: stub,
  retireDestinationAction: stub,
  showDestinationDetailAction: previewDestinationDetail,
};

export const accounts: ShellViewer = {
  displayName: 'Synthetic Accounts Jodhpur',
  primaryRole: 'Accounts',
  primaryBranch: 'Jodhpur',
  canAdministerStaff: false,
  canManageGrants: false,
  canUseAccounts: true,
  canCheckCustomers: true,
};
export const accounts2: ShellViewer = { ...accounts, displayName: 'Synthetic Accounts Delhi', primaryBranch: 'Delhi' };
const owner: ShellViewer = {
  displayName: 'Synthetic Super Admin',
  primaryRole: 'Super Admin',
  primaryBranch: 'Jodhpur',
  canAdministerStaff: true,
  canManageGrants: true,
  canManageFinancePolicy: true,
};
const sales: ShellViewer = { ...accounts, displayName: 'Synthetic Sales Delhi A', primaryRole: 'Sales', primaryBranch: 'Delhi', canUseAccounts: false, canCheckCustomers: false };

const ENTITY = 'a0000000-0000-4000-8000-000000000001';
const DEAL = 'd5000000-0000-4000-8000-000000000001';
const BR_DEL = 'b0000000-0000-4000-8000-000000000002';
const BR_JDH = 'b0000000-0000-4000-8000-000000000003';

const policy: FinancePolicyView = {
  versionNo: 1,
  effectiveAt: '2026-11-01T00:00:00Z',
  receiptMaxPaise: '1000000000',
  cashPayerDayCapPaise: '4999900',
  cashTripCapPaise: '4999900',
  cashDepositDays: 1,
  reconciliationRequired: true,
  reason: 'Initial policy from the approved owner decisions (synthetic preview).',
  createdByName: null,
  createdAt: '2026-11-01T00:00:00Z',
};

const NONE: Record<ReceiptAction, ActionBlock> = {
  verify: 'wrong_state',
  reject: 'wrong_state',
  cheque_clear: 'wrong_state',
  cheque_mark: 'wrong_state',
  cheque_represent: 'wrong_state',
  reverse: 'wrong_state',
  correct: 'wrong_state',
};

function receipt(n: number, extra: Partial<ReceiptView>): ReceiptView {
  return {
    receiptId: `r5000000-0000-4000-8000-00000000000${n}`,
    receiptNo: `R-2026-27-00000${n}`,
    mode: 'bank_transfer',
    status: 'recorded',
    amountPaise: '2500000',
    receivedOn: '2026-11-03',
    branchName: 'Delhi',
    collectorName: null,
    payerName: 'Synthetic Payer A',
    payerPanMasked: 'XXXXX1234X',
    payerMobileMasked: null,
    reference: null,
    chequeNumber: null,
    micrCode: null,
    chequeDate: null,
    rejectionKind: null,
    reversalKind: null,
    reason: null,
    correctsReceiptNo: null,
    correctedByReceiptNo: null,
    recordedByName: 'Synthetic Accounts Delhi',
    recordedAt: '2026-11-03T06:30:00Z',
    verifiedByName: null,
    verifiedAt: null,
    outcomeDate: null,
    policyVersionNo: 1,
    evidence: [],
    actions: NONE,
    destination: extra.mode === 'cash' || extra.mode === 'cheque' ? null : { unmapped: true },
    ...extra,
  };
}

const proof = (id: string, kind: 'bank_proof' | 'cheque_image', status: 'stored' | 'failed' = 'stored') => ({
  id: `e5000000-0000-4000-8000-0000000000${id}`,
  kind,
  fileName: `synthetic-${kind.replace('_', '-')}-${id}.pdf`,
  status,
  createdAt: '2026-11-03T06:35:00Z',
});

/** One receipt in every status, as seen by a second Accounts person (no conflicts). */
const allReceipts: ReceiptView[] = [
  receipt(1, {
    reference: 'SYNUTR000111',
    evidence: [proof('01', 'bank_proof')],
    actions: { ...NONE, verify: null, reject: null },
  }),
  receipt(2, {
    mode: 'cash',
    amountPaise: '1500000',
    collectorName: 'Synthetic Accounts Delhi',
    payerMobileMasked: 'XXXXXX3210',
    payerPanMasked: null,
    actions: { ...NONE, verify: null, reject: null },
  }),
  receipt(3, {
    mode: 'upi',
    status: 'verified',
    amountPaise: '1200050',
    reference: 'SYNUPI778899',
    evidence: [proof('03', 'bank_proof')],
    verifiedByName: 'Synthetic Accounts Jodhpur',
    verifiedAt: '2026-11-03T09:00:00Z',
    actions: { ...NONE, reverse: null },
  }),
  receipt(4, {
    mode: 'cheque',
    status: 'pending_clearance',
    amountPaise: '5000000',
    chequeNumber: '004512',
    micrCode: '110002001',
    chequeDate: '2026-11-02',
    evidence: [proof('04', 'cheque_image')],
    verifiedByName: 'Synthetic Accounts Jodhpur',
    verifiedAt: '2026-11-03T09:10:00Z',
    actions: { ...NONE, cheque_clear: 'evidence_required', cheque_mark: null },
  }),
  receipt(5, {
    mode: 'cheque',
    status: 'cleared',
    amountPaise: '3000000',
    chequeNumber: '004513',
    micrCode: '110002001',
    chequeDate: '2026-10-28',
    outcomeDate: '2026-10-31',
    evidence: [proof('05', 'cheque_image'), proof('15', 'bank_proof')],
    actions: { ...NONE, reverse: 'own_clearance' },
  }),
  receipt(6, {
    mode: 'cheque',
    status: 'bounced',
    amountPaise: '2000000',
    chequeNumber: '004514',
    micrCode: '110002001',
    chequeDate: '2026-10-25',
    outcomeDate: '2026-10-29',
    evidence: [proof('06', 'cheque_image'), proof('16', 'bank_proof', 'failed')],
    actions: { ...NONE, cheque_represent: 'mode_not_live' },
  }),
  receipt(7, { mode: 'cheque', status: 'stopped', chequeNumber: '004515', micrCode: '110002001', chequeDate: '2026-10-20', outcomeDate: '2026-10-22' }),
  receipt(8, { mode: 'cheque', status: 'cancelled', chequeNumber: '004516', micrCode: '110002001', chequeDate: '2026-10-20', reason: 'Customer replaced it with a bank transfer.' }),
  receipt(9, {
    status: 'rejected',
    rejectionKind: 'data_error',
    reference: 'SYNUTR000999',
    reason: 'Amount typed as 25,000 instead of 2,500.',
    correctedByReceiptNo: null,
    actions: { ...NONE, correct: null },
  }),
  receipt(10, {
    mode: 'cash',
    status: 'reversed',
    reversalKind: 'not_received',
    amountPaise: '800000',
    collectorName: 'Synthetic Accounts Delhi',
    reason: 'Cash envelope was empty when counted.',
    verifiedByName: 'Synthetic Accounts Jodhpur',
    verifiedAt: '2026-11-01T09:00:00Z',
  }),
  receipt(11, { status: 'rejected', rejectionKind: 'not_received', reference: 'SYNUTR000222', reason: 'No credit on the bank statement.' }),
];

export const detail: AccountsDealDetail = {
  dealId: DEAL,
  dealReference: 'SYN-DEL-001',
  dealTitle: 'Synthetic package A (Delhi)',
  legalEntityId: ENTITY,
  branchId: BR_DEL,
  branchName: 'Delhi',
  isSynthetic: true,
  booking: {
    bookingVersionId: 'bv500000-0000-4000-8000-000000000001',
    versionNo: 2,
    hotelName: 'Synthetic Lakeside Hotel',
    city: 'Udaipur',
    checkIn: '2026-11-14',
    checkOut: '2026-11-17',
    rooms: 2,
    adults: 4,
    children: 1,
    sellingTotalPaise: '12345600',
    confirmedAt: '2026-11-02T07:05:00Z',
    confirmedByName: 'Synthetic Sales Delhi A',
    reviewStatus: 'pending',
    reviewRowVersion: 1,
    returnReason: null,
    reviewedByName: null,
    reviewedAt: null,
    canApprove: true,
    approveBlock: null,
  },
  billing: {
    billingName: 'Synthetic Customer Pvt Ltd',
    addressLine1: '12 Example Road',
    addressLine2: null,
    city: 'New Delhi',
    stateCode: '07',
    postalCode: '110001',
    gstin: null,
    status: 'verified',
    rowVersion: 2,
    updatedByName: 'Synthetic Accounts Delhi',
    updatedAt: '2026-11-02T08:00:00Z',
    verifiedByName: 'Synthetic Accounts Jodhpur',
    verifiedAt: '2026-11-02T08:30:00Z',
  },
  money: { availablePaise: '4200050', awaitingVerificationPaise: '4000000', chequesAwaitingClearancePaise: '5000000' },
  receipts: allReceipts,
  liveModes: { bank_transfer: false, upi: false, cash: false, cheque: false },
  modesAllowed: { bank_transfer: true, upi: true, cash: true, cheque: true },
  branches: [
    { id: BR_DEL, name: 'Delhi' },
    { id: BR_JDH, name: 'Jodhpur' },
  ],
  collectors: [
    { userId: 'u5000000-0000-4000-8000-000000000001', name: 'Synthetic Accounts Delhi' },
    { userId: 'u5000000-0000-4000-8000-000000000002', name: 'Synthetic Accounts Jodhpur' },
  ],
  policy,
};

/** The recorder's own view: every approval-type action is blocked with a reason. */
const blockedDetail: AccountsDealDetail = {
  ...detail,
  booking: { ...detail.booking!, canApprove: false, approveBlock: 'deal_conflict' },
  billing: { ...detail.billing!, status: 'draft', verifiedAt: null, verifiedByName: null },
  receipts: [
    receipt(1, { reference: 'SYNUTR000111', evidence: [proof('01', 'bank_proof')], actions: { ...NONE, verify: 'own_record', reject: 'own_record' } }),
    receipt(2, { mode: 'upi', reference: 'SYNUPI000333', actions: { ...NONE, verify: 'evidence_required', reject: 'deal_conflict' } }),
    receipt(3, {
      mode: 'upi',
      status: 'verified',
      reference: 'SYNUPI778899',
      evidence: [proof('03', 'bank_proof')],
      verifiedByName: 'Synthetic Accounts Jodhpur',
      verifiedAt: '2026-11-03T09:00:00Z',
      actions: { ...NONE, reverse: 'own_verification' },
    }),
    receipt(4, {
      mode: 'cash',
      status: 'verified',
      collectorName: 'Synthetic Accounts Delhi',
      verifiedByName: 'Synthetic Accounts Jodhpur',
      verifiedAt: '2026-11-03T09:00:00Z',
      actions: { ...NONE, reverse: 'in_unverified_deposit' },
    }),
  ],
};

const notLiveDetail: AccountsDealDetail = {
  ...detail,
  receipts: [],
  money: { availablePaise: '0', awaitingVerificationPaise: '0', chequesAwaitingClearancePaise: '0' },
  modesAllowed: { bank_transfer: false, upi: false, cash: false, cheque: false },
  isSynthetic: false,
};

const partlyLiveDetail: AccountsDealDetail = {
  ...notLiveDetail,
  liveModes: { bank_transfer: true, upi: true, cash: false, cheque: false },
  modesAllowed: { bank_transfer: true, upi: true, cash: false, cheque: false },
};

const noBookingDetail: AccountsDealDetail = {
  ...detail,
  dealReference: 'SYN-DEL-004',
  dealTitle: 'Synthetic package D (no booking yet)',
  booking: null,
  billing: null,
  receipts: [receipt(1, { reference: 'SYNUTR000444', actions: { ...NONE, verify: 'evidence_required', reject: null } })],
  money: { availablePaise: '0', awaitingVerificationPaise: '2500000', chequesAwaitingClearancePaise: '0' },
};

/** Approved after an earlier return: the old reason must not read as current. */
const approvedAfterReturnDetail: AccountsDealDetail = {
  ...detail,
  booking: {
    ...detail.booking!,
    reviewStatus: 'approved',
    returnReason: null,
    reviewedByName: 'Synthetic Accounts Jodhpur',
    reviewedAt: '2026-11-04T10:00:00Z',
    canApprove: false,
    approveBlock: 'wrong_state',
  },
};

/** Defensive: a stale reason arriving with an approved review is still not shown. */
const approvedStaleReasonDetail: AccountsDealDetail = {
  ...approvedAfterReturnDetail,
  booking: { ...approvedAfterReturnDetail.booking!, returnReason: 'Old reason from before the fix (synthetic).' },
};

const returnedDetail: AccountsDealDetail = {
  ...detail,
  booking: {
    ...detail.booking!,
    reviewStatus: 'returned',
    returnReason: 'Hotel name on the booking does not match the voucher; ask Sales to confirm.',
    reviewedByName: 'Synthetic Accounts Jodhpur',
    reviewedAt: '2026-11-03T10:00:00Z',
  },
};

const cashOffDetail: AccountsDealDetail = {
  ...notLiveDetail,
  modesAllowed: { bank_transfer: true, upi: true, cash: true, cheque: true },
  policy: { ...policy, versionNo: 2, cashPayerDayCapPaise: '0', cashTripCapPaise: '0' },
};


// ---------------------------------------------------------------------------
// Stage 2: company accounts (synthetic values only)
// ---------------------------------------------------------------------------

const ME = 'u5000000-0000-4000-8000-000000000002';
const OTHER = 'u5000000-0000-4000-8000-000000000001';

function bankVersion(id: string, n: number, extra: Partial<DestinationVersionView>): DestinationVersionView {
  return {
    versionId: `c5000000-0000-4000-8000-0000000000${id}`,
    versionNo: n,
    status: 'approved',
    predecessorVersionNo: n > 1 ? n - 1 : null,
    holderName: 'Synthetic Holidays Pvt Ltd',
    bankName: 'Synthetic Bank',
    accountMasked: 'XXXX6789',
    ifsc: 'SYNB0001234',
    payeeName: null,
    upiMasked: null,
    makerId: OTHER,
    makerName: 'Synthetic Accounts Delhi',
    createdAt: '2026-11-01T05:00:00Z',
    decidedByName: 'Synthetic Accounts Jodhpur',
    decidedAt: '2026-11-01T06:00:00Z',
    decisionReason: null,
    ...extra,
  };
}

function upiVersion(id: string, n: number, extra: Partial<DestinationVersionView>): DestinationVersionView {
  return bankVersion(id, n, { holderName: null, bankName: null, accountMasked: null, ifsc: null, payeeName: 'Synthetic Holidays', upiMasked: 's***@synbank', ...extra });
}

function destination(n: number, extra: Partial<CompanyDestinationView> & Pick<CompanyDestinationView, 'versions'>): CompanyDestinationView {
  const versions = extra.versions;
  return {
    destinationId: `c4000000-0000-4000-8000-00000000000${n}`,
    kind: 'bank',
    label: `Synthetic account ${n}`,
    rowVersion: 3,
    state: 'approved',
    createdByName: 'Synthetic Accounts Delhi',
    createdAt: '2026-11-01T05:00:00Z',
    retiredAt: null,
    retiredByName: null,
    retireReason: null,
    current: versions.find((v) => v.status === 'approved') ?? null,
    pending: versions.find((v) => v.status === 'submitted') ?? null,
    latestVersionNo: Math.max(...versions.map((v) => v.versionNo)),
    actions: { submit: null, decide: 'wrong_state', retire: null },
    ...extra,
  };
}

/** Every panel state, as seen by the second Accounts person (who did not make the open versions). */
const destinationList: CompanyDestinationView[] = [
  destination(1, {
    label: 'Main current account',
    state: 'approved',
    versions: [
      bankVersion('11', 1, { status: 'superseded', accountMasked: 'XXXX1111' }),
      bankVersion('12', 2, { createdAt: '2026-11-02T05:00:00Z', decidedAt: '2026-11-02T06:00:00Z' }),
    ],
  }),
  destination(2, {
    label: 'Main current account replacement',
    state: 'submitted',
    versions: [
      bankVersion('21', 1, { accountMasked: 'XXXX4321' }),
      bankVersion('22', 2, { status: 'submitted', accountMasked: 'XXXX2222', ifsc: 'SYNB0005678', decidedByName: null, decidedAt: null, createdAt: '2026-11-03T05:00:00Z' }),
    ],
    actions: { submit: 'wrong_state', decide: null, retire: null },
  }),
  destination(3, {
    label: 'New collections account',
    state: 'submitted',
    versions: [bankVersion('13', 1, { versionId: 'c5000000-0000-4000-8000-000000000013', status: 'submitted', accountMasked: 'XXXX2222', ifsc: 'SYNB0005678', decidedByName: null, decidedAt: null })],
    actions: { submit: 'wrong_state', decide: null, retire: null },
  }),
  destination(4, {
    kind: 'upi',
    label: 'Office UPI',
    state: 'returned',
    versions: [
      upiVersion('41', 1, {
        status: 'returned',
        decisionReason: 'Payee name does not match the company name on the bank letter.',
        decidedAt: '2026-11-02T07:00:00Z',
      }),
    ],
    actions: { submit: null, decide: 'wrong_state', retire: null },
  }),
  destination(5, {
    kind: 'upi',
    label: 'Counter UPI',
    state: 'approved',
    versions: [upiVersion('51', 1, { upiMasked: 'c***@synpay', payeeName: 'Synthetic Holidays Counter' })],
  }),
  destination(6, {
    label: 'Old branch account',
    state: 'retired',
    retiredAt: '2026-11-04T09:00:00Z',
    retiredByName: 'Synthetic Accounts Jodhpur',
    retireReason: 'Account closed by the bank at the company’s request.',
    versions: [bankVersion('61', 1, { accountMasked: 'XXXX0606' })],
    actions: { submit: 'wrong_state', decide: 'wrong_state', retire: 'wrong_state' },
  }),
  destination(7, {
    label: 'Retired with a late version',
    state: 'retired',
    retiredAt: '2026-11-04T10:00:00Z',
    retiredByName: 'Synthetic Accounts Jodhpur',
    retireReason: 'Replaced by the main current account.',
    versions: [
      bankVersion('71', 1, { accountMasked: 'XXXX0707' }),
      bankVersion('72', 2, { status: 'submitted', accountMasked: 'XXXX0772', decidedByName: null, decidedAt: null, createdAt: '2026-11-04T09:30:00Z' }),
    ],
    actions: { submit: 'wrong_state', decide: null, retire: 'wrong_state' },
  }),
];

const destinationsPage: CompanyDestinationsPage = { entityId: ENTITY, destinations: destinationList };

/** The maker's own view: the open versions are theirs, so approve and return are unavailable with the reason. */
const ownDestinationsPage: CompanyDestinationsPage = {
  entityId: ENTITY,
  destinations: destinationList.map((d) =>
    d.pending
      ? { ...d, pending: { ...d.pending, makerId: ME, makerName: 'Synthetic Accounts Jodhpur' }, actions: { ...d.actions, decide: 'own_record' } }
      : d,
  ),
};

export const destinationOptions: DestinationOption[] = [
  { versionId: 'c5000000-0000-4000-8000-000000000012', destinationId: 'c4000000-0000-4000-8000-000000000001', kind: 'bank', label: 'Main current account', versionNo: 2, bankName: 'Synthetic Bank', accountMasked: 'XXXX6789', payeeName: null, upiMasked: null },
  { versionId: 'c5000000-0000-4000-8000-000000000021', destinationId: 'c4000000-0000-4000-8000-000000000002', kind: 'bank', label: 'Main current account replacement', versionNo: 1, bankName: 'Synthetic Bank', accountMasked: 'XXXX4321', payeeName: null, upiMasked: null },
  { versionId: 'c5000000-0000-4000-8000-000000000051', destinationId: 'c4000000-0000-4000-8000-000000000005', kind: 'upi', label: 'Counter UPI', versionNo: 1, bankName: null, accountMasked: null, payeeName: 'Synthetic Holidays Counter', upiMasked: 'c***@synpay' },
];

const mappedReceiptsDetail: AccountsDealDetail = {
  ...detail,
  receipts: [
    receipt(1, {
      reference: 'SYNUTR000111',
      evidence: [proof('01', 'bank_proof')],
      destination: { unmapped: false, label: 'Main current account', kind: 'bank', versionNo: 2, bankName: 'Synthetic Bank', accountMasked: 'XXXX6789', upiMasked: null },
      actions: { ...NONE, verify: null, reject: null },
    }),
    receipt(2, {
      mode: 'upi',
      reference: 'SYNUPI000222',
      destination: { unmapped: false, label: 'Counter UPI', kind: 'upi', versionNo: 1, bankName: null, accountMasked: null, upiMasked: 'c***@synpay' },
    }),
    receipt(3, { reference: 'SYNUTR000333', status: 'verified', verifiedByName: 'Synthetic Accounts Jodhpur', verifiedAt: '2026-11-01T09:00:00Z' }),
    receipt(4, { mode: 'cash', collectorName: 'Synthetic Accounts Delhi', payerPanMasked: null, payerMobileMasked: 'XXXXXX3210' }),
  ],
};

export const queueItems: AccountsQueueItem[] = [
  {
    dealId: DEAL,
    dealReference: 'SYN-DEL-001',
    dealTitle: 'Synthetic package A (Delhi)',
    branchName: 'Delhi',
    hasConfirmedBooking: true,
    billingStatus: 'verified',
    reviewStatus: 'pending',
    money: detail.money,
    updatedAt: '2026-11-03T09:10:00Z',
  },
  {
    dealId: 'd5000000-0000-4000-8000-000000000002',
    dealReference: 'SYN-DEL-002',
    dealTitle: 'Synthetic package B (Delhi)',
    branchName: 'Delhi',
    hasConfirmedBooking: true,
    billingStatus: 'draft',
    reviewStatus: 'returned',
    money: { availablePaise: '0', awaitingVerificationPaise: '0', chequesAwaitingClearancePaise: '0' },
    updatedAt: '2026-11-03T08:00:00Z',
  },
  {
    dealId: 'd5000000-0000-4000-8000-000000000004',
    dealReference: 'SYN-DEL-004',
    dealTitle: 'Synthetic package D (no booking yet)',
    branchName: 'Jodhpur',
    hasConfirmedBooking: false,
    billingStatus: null,
    reviewStatus: null,
    money: noBookingDetail.money,
    updatedAt: '2026-11-03T07:00:00Z',
  },
  {
    dealId: 'd5000000-0000-4000-8000-000000000005',
    dealReference: 'SYN-AMD-005',
    dealTitle: 'Synthetic package E (approved)',
    branchName: 'Ahmedabad',
    hasConfirmedBooking: true,
    billingStatus: 'verified',
    reviewStatus: 'approved',
    money: { availablePaise: '10000000000', awaitingVerificationPaise: '0', chequesAwaitingClearancePaise: '25000000' },
    updatedAt: '2026-11-02T07:00:00Z',
  },
];

const ZERO_TOTALS: Record<UnresolvedCashKind, number> = {
  deposit_overdue: 0,
  verification_overdue: 0,
  reversed_undeposited: 0,
  reconciliation_missing: 0,
  reconciliation_awaiting_verification: 0,
  reconciliation_stale: 0,
};

/** Complete totals and oldest dates derived from a fully listed set of items (no truncation). */
function listedTotals(items: UnresolvedCashItem[]): Pick<CashBranchView, 'unresolvedTotals' | 'oldestUnresolvedDate' | 'unresolvedTruncated'> {
  const unresolvedTotals = { ...ZERO_TOTALS };
  const oldestUnresolvedDate: Partial<Record<UnresolvedCashKind, string>> = {};
  for (const u of items) {
    unresolvedTotals[u.kind] += 1;
    const old = oldestUnresolvedDate[u.kind];
    if (u.businessDate && (!old || u.businessDate < old)) oldestUnresolvedDate[u.kind] = u.businessDate;
  }
  return { unresolvedTotals, oldestUnresolvedDate, unresolvedTruncated: false };
}

const delhiUnresolved: UnresolvedCashItem[] = [
  { kind: 'deposit_overdue', receiptId: 'r5000000-0000-4000-8000-000000000021', receiptNo: 'R-2026-27-000021', businessDate: '2026-11-01', amountPaise: '1500000' },
  { kind: 'verification_overdue', receiptId: 'r5000000-0000-4000-8000-000000000023', receiptNo: 'R-2026-27-000023', businessDate: '2026-10-31', amountPaise: '1500000' },
  { kind: 'reversed_undeposited', receiptId: 'r5000000-0000-4000-8000-000000000010', receiptNo: 'R-2026-27-000010', businessDate: '2026-11-01', amountPaise: '800000' },
  { kind: 'reconciliation_missing', receiptId: null, receiptNo: null, businessDate: '2026-11-02', amountPaise: null },
  { kind: 'reconciliation_awaiting_verification', receiptId: null, receiptNo: null, businessDate: '2026-11-01', amountPaise: null },
  { kind: 'reconciliation_stale', receiptId: null, receiptNo: null, businessDate: '2026-10-30', amountPaise: null },
];

const cash: CashOverview = {
  legalEntityId: ENTITY,
  policy,
  branches: [
    {
      branchId: BR_DEL,
      branchName: 'Delhi',
      cashInHandPaise: '2300000',
      recordedUnverifiedCashPaise: '1500000',
      undepositedVerified: [
        { receiptId: 'r5000000-0000-4000-8000-000000000021', receiptNo: 'R-2026-27-000021', amountPaise: '1500000', receivedOn: '2026-11-01', dealReference: 'SYN-DEL-001' },
        { receiptId: 'r5000000-0000-4000-8000-000000000022', receiptNo: 'R-2026-27-000022', amountPaise: '800000', receivedOn: '2026-11-03', dealReference: 'SYN-DEL-002' },
      ],
      unresolved: delhiUnresolved,
      ...listedTotals(delhiUnresolved),
      deposits: [
        {
          depositId: 'p5000000-0000-4000-8000-000000000001',
          depositedOn: '2026-11-02',
          bankReference: 'SYN-DEP-0007',
          totalPaise: '1000000',
          status: 'recorded',
          receiptNos: ['R-2026-27-000018', 'R-2026-27-000019'],
          recordedByName: 'Synthetic Accounts Delhi',
          verifiedByName: null,
          rejectReason: null,
          evidence: [proof('31', 'bank_proof')],
          actions: { verify: null, reject: null },
        },
        {
          depositId: 'p5000000-0000-4000-8000-000000000002',
          depositedOn: '2026-10-31',
          bankReference: 'SYN-DEP-0006',
          totalPaise: '600000',
          status: 'recorded',
          receiptNos: ['R-2026-27-000015'],
          recordedByName: 'Synthetic Accounts Jodhpur',
          verifiedByName: null,
          rejectReason: null,
          evidence: [proof('32', 'bank_proof')],
          actions: { verify: 'own_record', reject: 'own_record' },
        },
        {
          depositId: 'p5000000-0000-4000-8000-000000000003',
          depositedOn: '2026-10-29',
          bankReference: 'SYN-DEP-0005',
          totalPaise: '450000',
          status: 'verified',
          receiptNos: ['R-2026-27-000011'],
          recordedByName: 'Synthetic Accounts Delhi',
          verifiedByName: 'Synthetic Accounts Jodhpur',
          rejectReason: null,
          evidence: [proof('33', 'bank_proof')],
          actions: { verify: 'wrong_state', reject: 'wrong_state' },
        },
      ],
      reconciliations: [
        {
          reconciliationId: 'c5000000-0000-4000-8000-000000000001',
          businessDate: '2026-11-01',
          countedPaise: '2290000',
          expectedPaise: '2300000',
          differencePaise: '-10000',
          unverifiedCashPaise: '1500000',
          note: 'Short by ₹100; checking with the branch.',
          status: 'recorded',
          stale: false,
          recordedByName: 'Synthetic Accounts Delhi',
          verifiedByName: null,
          actions: { verify: null },
        },
        {
          reconciliationId: 'c5000000-0000-4000-8000-000000000002',
          businessDate: '2026-10-30',
          countedPaise: '450000',
          expectedPaise: '450000',
          differencePaise: '0',
          unverifiedCashPaise: '0',
          note: null,
          status: 'verified',
          stale: true,
          recordedByName: 'Synthetic Accounts Delhi',
          verifiedByName: 'Synthetic Accounts Jodhpur',
          actions: { verify: 'wrong_state' },
        },
      ],
    },
    {
      branchId: BR_JDH,
      branchName: 'Jodhpur',
      cashInHandPaise: '0',
      recordedUnverifiedCashPaise: '0',
      undepositedVerified: [],
      unresolved: [],
      ...listedTotals([]),
      deposits: [],
      reconciliations: [],
    },
  ],
};

const policyPage: FinancePolicyPage = {
  legalEntityId: ENTITY,
  legalEntityName: 'Holiday Chacha Pvt LTD',
  current: { ...policy, versionNo: 2, effectiveAt: '2026-11-05T00:00:00Z', cashDepositDays: 2, reason: 'Branches deposit every other day (synthetic preview).', createdByName: 'Synthetic Super Admin', createdAt: '2026-11-04T10:00:00Z' },
  scheduled: [
    {
      ...policy,
      versionNo: 3,
      effectiveAt: '2026-12-01T00:00:00Z',
      cashPayerDayCapPaise: '0',
      cashTripCapPaise: '0',
      cashDepositDays: 2,
      reason: 'Cash switched off from December pending CA advice (synthetic preview).',
      createdByName: 'Synthetic Super Admin',
      createdAt: '2026-11-06T10:00:00Z',
    },
  ],
  history: [policy],
  ceilings: { cashCapCeilingPaise: '19999900', receiptMaxCeilingPaise: '10000000000' },
  canEdit: true,
};

/** 63 missing daily counts from 3 Aug 2026 (older than 60 days); the database lists the 50 oldest. */
function missingDates(count: number): UnresolvedCashItem[] {
  const start = Date.UTC(2026, 7, 3);
  return Array.from({ length: count }, (_, i) => ({
    kind: 'reconciliation_missing' as const,
    receiptId: null,
    receiptNo: null,
    businessDate: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    amountPaise: null,
  }));
}

const jodhpurQuiet: CashBranchView = cash.branches[1]!;

const truncatedCash: CashOverview = {
  ...cash,
  branches: [
    {
      ...jodhpurQuiet,
      cashInHandPaise: '1200000',
      unresolved: [...missingDates(50), { kind: 'reconciliation_awaiting_verification', receiptId: null, receiptNo: null, businessDate: '2026-10-05', amountPaise: null }],
      unresolvedTotals: { ...ZERO_TOTALS, reconciliation_missing: 63, reconciliation_awaiting_verification: 1 },
      oldestUnresolvedDate: { reconciliation_missing: '2026-08-03', reconciliation_awaiting_verification: '2026-10-05' },
      unresolvedTruncated: true,
    },
  ],
};

/** A count was recorded but not verified: the date is not cleared and the branch is not "up to date". */
const awaitingCash: CashOverview = {
  ...cash,
  branches: [
    {
      ...jodhpurQuiet,
      unresolved: [{ kind: 'reconciliation_awaiting_verification', receiptId: null, receiptNo: null, businessDate: '2026-11-02', amountPaise: null }],
      ...listedTotals([{ kind: 'reconciliation_awaiting_verification', receiptId: null, receiptNo: null, businessDate: '2026-11-02', amountPaise: null }]),
      reconciliations: [
        {
          reconciliationId: 'c5000000-0000-4000-8000-000000000011',
          businessDate: '2026-11-02',
          countedPaise: '0',
          expectedPaise: '0',
          differencePaise: '0',
          unverifiedCashPaise: '0',
          note: null,
          status: 'recorded',
          stale: false,
          recordedByName: 'Synthetic Accounts Delhi',
          verifiedByName: null,
          actions: { verify: null },
        },
      ],
    },
  ],
};

/** Queue page cursor in the accounts_queue format (deal id, then reference). */
const QUEUE_NEXT = 'd5000000-0000-4000-8000-000000000005:SYN-AMD-005';

const salesViewer: ShellViewer = { ...accounts, displayName: 'Synthetic Sales Delhi A', primaryRole: 'Sales', primaryBranch: 'Delhi', canUseAccounts: false, canCheckCustomers: false };

function pageOfDeals(from: number, count: number): DealListItem[] {
  return Array.from({ length: count }, (_, i) => {
    const n = String(from + i).padStart(4, '0');
    return {
      id: `d6000000-0000-4000-8000-00000000${n}`,
      reference: `SYN-DEL-${n}`,
      title: `Synthetic package ${n}`,
      branchName: 'Delhi',
      relation: i % 3 === 0 ? 'owner' : i % 3 === 1 ? 'assigned' : 'scope',
      createdOn: '2026-11-01',
    };
  });
}

/** Synthetic stand-in for confirmSupplierAction: refuses unless the reference ends in -OK. Saves nothing. */
async function previewSupplierConfirm(_prev: unknown, formData: FormData): Promise<ProcurementActionResult<{ outcome: 'created' | 'existing' }>> {
  'use server';
  const reference = String(formData.get('reference') ?? '').trim();
  if (!reference.endsWith('-OK')) {
    return { ok: false, code: 'version_changed', message: 'Someone changed this after you opened it. Nothing was saved. Review the latest details and try again.' };
  }
  return { ok: true, data: { outcome: 'created' }, message: 'Design preview: the supplier confirmation would be recorded now. Nothing was saved.' };
}

/** Synthetic stand-in that loses its response, like a dropped connection. */
async function previewSupplierConfirmLost(): Promise<ProcurementActionResult<{ outcome: 'created' | 'existing' }>> {
  'use server';
  throw new Error('Design preview: simulated lost response.');
}

/**
 * Batch 4: the Accounts deal page has tabs (DA-15). Each deal state also
 * renders as "{state}--{tab}" (money, review, receipts, documents); the tab
 * links point at those preview states.
 */
function dealTab(name: string, tab: AccountsDealTab | undefined) {
  return { tabParam: tab, tabHref: (t: AccountsDealTab) => `/preview/${name}--${t}` };
}

const states: Record<string, (tab?: AccountsDealTab) => ReactNode> = {
  'finance-queue': () => (
    <StaffShell viewer={accounts} currentPath="/app/accounts">
      <AccountsQueueView items={queueItems} filter="all" />
    </StaffShell>
  ),
  'finance-loading': () => (
    <StaffShell viewer={accounts} currentPath="/app/accounts">
      <FinanceLoadingView />
    </StaffShell>
  ),
  'finance-queue-truncated': () => (
    <StaffShell viewer={accounts} currentPath="/app/accounts">
      <AccountsQueueView items={queueItems} filter="all" paging={{ totalCount: 137, hasMore: true, nextAfter: QUEUE_NEXT, laterPage: false }} />
    </StaffShell>
  ),
  'finance-queue-later-page': () => (
    <StaffShell viewer={accounts} currentPath="/app/accounts">
      <AccountsQueueView items={queueItems.slice(0, 2)} filter="needs_review" paging={{ totalCount: 52, hasMore: false, nextAfter: null, laterPage: true }} />
    </StaffShell>
  ),
  'finance-queue-end': () => (
    <StaffShell viewer={accounts} currentPath="/app/accounts">
      <AccountsQueueView items={[]} filter="all" paging={{ totalCount: 50, hasMore: false, nextAfter: null, laterPage: true }} />
    </StaffShell>
  ),
  'finance-queue-empty': () => (
    <StaffShell viewer={accounts} currentPath="/app/accounts">
      <AccountsQueueView items={[]} filter="all" />
    </StaffShell>
  ),
  'finance-queue-filter-empty': () => (
    <StaffShell viewer={accounts} currentPath="/app/accounts">
      <AccountsQueueView items={[]} filter="cheques_pending" />
    </StaffShell>
  ),
  'finance-queue-lookup-found': () => (
    <StaffShell viewer={accounts} currentPath="/app/accounts">
      <AccountsQueueView
        items={queueItems.slice(0, 2)}
        filter="needs_review"
        lookup={{
          reference: 'SYN-JDH-009',
          result: { dealId: 'd5000000-0000-4000-8000-000000000009', dealReference: 'SYN-JDH-009', dealTitle: 'Synthetic package J (Jodhpur)', branchName: 'Jodhpur', hasConfirmedBooking: false },
        }}
      />
    </StaffShell>
  ),
  'finance-queue-lookup-missing': () => (
    <StaffShell viewer={accounts} currentPath="/app/accounts">
      <AccountsQueueView items={queueItems} filter="all" lookup={{ reference: 'SYN-XXX-404', result: null }} />
    </StaffShell>
  ),
  'finance-deal-detail': (tab?: AccountsDealTab) => (
    <StaffShell viewer={accounts} currentPath="/app/accounts">
      <AccountsDealView {...dealTab('finance-deal-detail', tab)} detail={detail} actions={actions} destinationOptions={destinationOptions} />
    </StaffShell>
  ),
  'finance-deal-blocked': (tab?: AccountsDealTab) => (
    <StaffShell viewer={accounts2} currentPath="/app/accounts">
      <AccountsDealView {...dealTab('finance-deal-blocked', tab)} detail={blockedDetail} actions={actions} />
    </StaffShell>
  ),
  'finance-deal-not-live': (tab?: AccountsDealTab) => (
    <StaffShell viewer={accounts} currentPath="/app/accounts">
      <AccountsDealView {...dealTab('finance-deal-not-live', tab)} detail={notLiveDetail} actions={actions} />
    </StaffShell>
  ),
  'finance-deal-partly-live': (tab?: AccountsDealTab) => (
    <StaffShell viewer={accounts} currentPath="/app/accounts">
      <AccountsDealView {...dealTab('finance-deal-partly-live', tab)} detail={partlyLiveDetail} actions={actions} destinationOptions={destinationOptions} />
    </StaffShell>
  ),
  'finance-deal-cash-off': (tab?: AccountsDealTab) => (
    <StaffShell viewer={accounts} currentPath="/app/accounts">
      <AccountsDealView {...dealTab('finance-deal-cash-off', tab)} detail={cashOffDetail} actions={actions} />
    </StaffShell>
  ),
  'finance-deal-no-booking': (tab?: AccountsDealTab) => (
    <StaffShell viewer={accounts} currentPath="/app/accounts">
      <AccountsDealView {...dealTab('finance-deal-no-booking', tab)} detail={noBookingDetail} actions={actions} />
    </StaffShell>
  ),
  'finance-deal-approved-after-return': (tab?: AccountsDealTab) => (
    <StaffShell viewer={accounts} currentPath="/app/accounts">
      <AccountsDealView {...dealTab('finance-deal-approved-after-return', tab)} detail={approvedStaleReasonDetail} actions={actions} />
    </StaffShell>
  ),
  'finance-deal-unknown-outcome': (tab?: AccountsDealTab) => (
    <StaffShell viewer={accounts} currentPath="/app/accounts">
      <AccountsDealView {...dealTab('finance-deal-unknown-outcome', tab)} detail={partlyLiveDetail} actions={{ ...actions, recordReceiptAction: previewUnknownOutcomeAction }} destinationOptions={destinationOptions} />
    </StaffShell>
  ),
  'finance-deal-returned': (tab?: AccountsDealTab) => (
    <StaffShell viewer={accounts} currentPath="/app/accounts">
      <AccountsDealView {...dealTab('finance-deal-returned', tab)} detail={returnedDetail} actions={actions} />
    </StaffShell>
  ),
  'finance-deal-not-found': () => (
    <StaffShell viewer={accounts} currentPath="/app/accounts">
      <AccountsDealNotFoundView />
    </StaffShell>
  ),
  'finance-cash': () => (
    <StaffShell viewer={accounts} currentPath="/app/accounts/cash">
      <CashOverviewView overview={cash} actions={actions} />
    </StaffShell>
  ),
  'finance-cash-truncated': () => (
    <StaffShell viewer={accounts} currentPath="/app/accounts/cash">
      <CashOverviewView overview={truncatedCash} actions={actions} />
    </StaffShell>
  ),
  'finance-cash-awaiting-verification': () => (
    <StaffShell viewer={accounts} currentPath="/app/accounts/cash">
      <CashOverviewView overview={awaitingCash} actions={actions} />
    </StaffShell>
  ),
  'finance-cash-unavailable': () => (
    <StaffShell viewer={accounts} currentPath="/app/accounts/cash">
      <FinanceUnavailableView code="environment_unset" title="Branch cash" />
    </StaffShell>
  ),
  'finance-cash-empty': () => (
    <StaffShell viewer={accounts} currentPath="/app/accounts/cash">
      <CashOverviewView overview={{ ...cash, branches: [] }} actions={actions} />
    </StaffShell>
  ),
  'finance-policy': () => (
    <SettingsShell viewer={owner} currentPath="/app/admin/finance-policy">
      <FinancePolicyPageView page={policyPage} actions={actions} paymentModes={moneyRulesModel(switchStates())} companyAccountsHref="/app/accounts/destinations" />
    </SettingsShell>
  ),
  'finance-policy-error': () => (
    <SettingsShell viewer={owner} currentPath="/app/admin/finance-policy">
      <FinancePolicyPageView
        page={policyPage}
        actions={actions}
        editInitialState={{
          status: 'error',
          message: 'Some details are missing or not in the expected format. Check the highlighted fields.',
          fieldErrors: { cashTripCapRupees: 'Must be at most ₹1,99,999.00 (the legal ceiling).', reason: 'Write 10 to 500 characters.' },
        }}
      />
    </SettingsShell>
  ),
  'finance-policy-readonly': () => (
    <SettingsShell viewer={owner} currentPath="/app/admin/finance-policy">
      <FinancePolicyPageView page={{ ...policyPage, canEdit: false, scheduled: [] }} actions={actions} />
    </SettingsShell>
  ),
  'finance-no-access': () => (
    <StaffShell viewer={sales} currentPath="/app/accounts">
      <FinanceNoAccessView area="accounts" />
    </StaffShell>
  ),
  'finance-policy-no-access': () => (
    <SettingsShell viewer={accounts} currentPath="/app/admin/finance-policy">
      <FinanceNoAccessView area="policy" />
    </SettingsShell>
  ),
  // Milestone A §4: deal list pages (Sales viewer; no finance data).
  'deals-list-more': () => (
    <StaffShell viewer={salesViewer} currentPath="/app/deals">
      <DealsListScreen {...previewDealsProps({ items: pageOfDeals(1, 50), total: 107 })} />
    </StaffShell>
  ),
  'deals-list-later-page': () => (
    <StaffShell viewer={salesViewer} currentPath="/app/deals">
      <DealsListScreen {...previewDealsProps({ items: pageOfDeals(101, 7), total: 107, page: 3 })} />
    </StaffShell>
  ),
  'deals-list-end': () => (
    <StaffShell viewer={salesViewer} currentPath="/app/deals">
      <DealsListScreen {...previewDealsProps({ items: [], total: 0 })} />
    </StaffShell>
  ),
  // Milestone A §7: supplier confirmation reference keeps its value after a refusal.
  'procurement-confirm-reference': () => (
    <StaffShell viewer={salesViewer} currentPath="/app/purchase">
      <h1>Supplier confirmation reference</h1>
      <p>Synthetic stub: a reference ending in “-OK” succeeds; any other reference is refused. Nothing is saved.</p>
      <ConfirmSupplierForm taskId="t5000000-0000-4000-8000-000000000001" latestVersionNo={2} issues={[]} action={previewSupplierConfirm} />
    </StaffShell>
  ),
  'procurement-confirm-reference-lost': () => (
    <StaffShell viewer={salesViewer} currentPath="/app/purchase">
      <h1>Supplier confirmation reference</h1>
      <p>Synthetic stub: every submit loses its response. Nothing is saved.</p>
      <ConfirmSupplierForm taskId="t5000000-0000-4000-8000-000000000001" latestVersionNo={2} issues={[]} action={previewSupplierConfirmLost} />
    </StaffShell>
  ),
  // Stage 2: company accounts and the receipt destination.
  'finance-destinations': () => (
    <StaffShell viewer={accounts} currentPath="/app/accounts/destinations">
      <CompanyDestinationsView page={destinationsPage} actions={actions} />
    </StaffShell>
  ),
  'finance-destinations-own': () => (
    <StaffShell viewer={accounts} currentPath="/app/accounts/destinations">
      <CompanyDestinationsView page={ownDestinationsPage} actions={actions} />
    </StaffShell>
  ),
  'finance-destinations-empty': () => (
    <StaffShell viewer={accounts} currentPath="/app/accounts/destinations">
      <CompanyDestinationsView page={{ entityId: ENTITY, destinations: [] }} actions={actions} />
    </StaffShell>
  ),
  'finance-destinations-add-error': () => (
    <StaffShell viewer={accounts} currentPath="/app/accounts/destinations">
      <CompanyDestinationsView
        page={{ entityId: ENTITY, destinations: [] }}
        actions={actions}
        addInitialState={{
          status: 'error',
          code: 'invalid_input',
          message: 'Some details are missing or not in the expected format. Check the highlighted fields.',
          fieldErrors: {
            destinationKind: 'Choose bank account or UPI ID.',
            label: 'Enter a short name of up to 80 characters, without account numbers or UPI IDs.',
          },
        }}
      />
    </StaffShell>
  ),
  'finance-destinations-unavailable': () => (
    <StaffShell viewer={accounts} currentPath="/app/accounts/destinations">
      <FinanceUnavailableView code="environment_unset" title="Company accounts" />
    </StaffShell>
  ),
  'finance-deal-destinations': (tab?: AccountsDealTab) => (
    <StaffShell viewer={accounts} currentPath="/app/accounts">
      <AccountsDealView {...dealTab('finance-deal-destinations', tab)} detail={mappedReceiptsDetail} actions={actions} destinationOptions={destinationOptions} />
    </StaffShell>
  ),
  'finance-deal-no-destination': (tab?: AccountsDealTab) => (
    <StaffShell viewer={accounts} currentPath="/app/accounts">
      <AccountsDealView {...dealTab('finance-deal-no-destination', tab)} detail={partlyLiveDetail} actions={actions} destinationOptions={[]} />
    </StaffShell>
  ),
  'finance-deal-destinations-unavailable': (tab?: AccountsDealTab) => (
    <StaffShell viewer={accounts} currentPath="/app/accounts">
      <AccountsDealView {...dealTab('finance-deal-destinations-unavailable', tab)} detail={partlyLiveDetail} actions={actions} destinationOptions={[]} destinationOptionsUnavailable />
    </StaffShell>
  ),
  'finance-deal-destination-changed': (tab?: AccountsDealTab) => (
    <StaffShell viewer={accounts} currentPath="/app/accounts">
      <AccountsDealView {...dealTab('finance-deal-destination-changed', tab)} detail={partlyLiveDetail} actions={{ ...actions, recordReceiptAction: previewDestinationChangedAction }} destinationOptions={destinationOptions} />
    </StaffShell>
  ),
  'finance-not-configured': () => (
    <StaffShell viewer={accounts} currentPath="/app/accounts">
      <FinanceUnavailableView code="not_configured" title="To check" />
    </StaffShell>
  ),
};


const DEAL_TAB_STATES = ['finance-deal-detail', 'finance-deal-blocked', 'finance-deal-not-live', 'finance-deal-partly-live', 'finance-deal-cash-off', 'finance-deal-no-booking', 'finance-deal-approved-after-return', 'finance-deal-unknown-outcome', 'finance-deal-returned', 'finance-deal-destinations', 'finance-deal-no-destination', 'finance-deal-destinations-unavailable', 'finance-deal-destination-changed'];
for (const name of DEAL_TAB_STATES) {
  for (const tab of ACCOUNTS_DEAL_TABS) states[`${name}--${tab}`] = () => states[name]!(tab);
}

export const FINANCE_PREVIEW_STATES = Object.keys(states);

export function renderFinanceState(state: string): ReactNode | null {
  return states[state]?.() ?? null;
}
