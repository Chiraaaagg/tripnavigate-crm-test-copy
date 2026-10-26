import type { ReactNode } from 'react';
import type { PurchaseTaskView } from '@/modules/fulfilment/contracts';
import {
  PROCUREMENT_ERROR_TEXT,
  type ProcurementErrorCode,
  type PurchaseWorkspaceView,
  type SupplierDetailView,
  type SupplierSummary,
} from '@/modules/procurement/contracts';
import { PurchaseWorkSection, SupplierDetailPage, SupplierListPage } from '@/views/procurement-views';
import { PurchaseTaskPage } from '@/views/purchase-views';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import { KeepValuesProbe } from './keep-values-probe';

/*
 * Phase 4 design-review states. Synthetic props only (example.test-style
 * names, made-up amounts, no real supplier, bank or customer data).
 */

const purchase: ShellViewer = {
  displayName: 'Synthetic Purchase Jodhpur',
  primaryRole: 'Purchase',
  primaryBranch: 'Jodhpur',
  canAdministerStaff: false,
  canManageGrants: false,
  canSeePurchaseTasks: true,
};
const manager: ShellViewer = { ...purchase, displayName: 'Synthetic Manager Delhi', primaryRole: 'Manager', primaryBranch: 'Delhi' };
const sales: ShellViewer = { ...purchase, displayName: 'Synthetic Sales Delhi A', primaryRole: 'Sales', primaryBranch: 'Delhi', canSeePurchaseTasks: false };

const TASK_ID = 'f0000000-0000-4000-8000-000000000001';
const S1 = 'c0000000-0000-4000-8000-000000000001';
const S2 = 'c0000000-0000-4000-8000-000000000002';
const Q1 = 'e0000000-0000-4000-8000-000000000001';
const Q2 = 'e0000000-0000-4000-8000-000000000002';

export const task: PurchaseTaskView = {
  taskId: TASK_ID,
  dealReference: 'SYN-DEL-001',
  serviceType: 'hotel',
  itemTitle: 'Synthetic Lakeside Hotel, Udaipur',
  facts: {
    type: 'hotel',
    facts: { hotelName: 'Synthetic Lakeside Hotel', city: 'Udaipur', checkIn: '2026-11-14', checkOut: '2026-11-17', rooms: 2, adults: 4, children: 1, roomType: 'Deluxe double', mealPlan: 'Breakfast only', inclusions: 'Airport pick-up on arrival.', specialRequests: 'Adjoining rooms if possible.' },
  },
  hotelName: 'Synthetic Lakeside Hotel',
  city: 'Udaipur',
  checkIn: '2026-11-14',
  checkOut: '2026-11-17',
  nights: 3,
  rooms: 2,
  travellers: { adults: 4, children: 1 },
  purchaseBudgetPaise: '4500000',
  status: 'in_progress',
  assigneeName: 'Synthetic Purchase Jodhpur',
  assignedToYou: true,
  branchName: 'Delhi',
  createdAt: '2026-10-02T07:05:00Z',
  supplierConfirmedAt: null,
  roomType: 'Deluxe double',
  mealPlan: 'Breakfast only',
  inclusions: 'Airport pick-up on arrival.',
  specialRequests: 'Adjoining rooms if possible.',
  confirmedAt: '2026-10-02T07:05:00Z',
  confirmedByName: 'Synthetic Sales Delhi A',
  versionNo: 1,
  canClaim: false,
};

const choices = [
  { supplierId: S1, name: 'Synthetic Stays Pvt (example)', verificationStatus: 'unverified' as const },
  { supplierId: S2, name: 'Example Lakeview Partners', verificationStatus: 'unverified' as const },
];

const PURCHASE_USER = 'a0000000-0000-4000-8000-000000000003';
const COLLEAGUE_USER = 'a0000000-0000-4000-8000-000000000011';

const empty: PurchaseWorkspaceView = {
  task,
  canWork: true,
  canRelease: true,
  canReassign: false,
  canApproveOverBudget: false,
  assigneeUserId: PURCHASE_USER,
  reassignCandidates: [],
  gateIssue: null,
  issues: ['missing_quote', 'missing_cost', 'missing_supplier_confirmation_proof'],
  supplierReference: null,
  selectedQuoteId: null,
  supplierConfirmedByName: null,
  quotes: [],
  costVersions: [],
  evidence: [],
  supplierChoices: choices,
};

const quotes: PurchaseWorkspaceView['quotes'] = [
  {
    quoteId: Q1,
    supplierId: S1,
    supplierName: 'Synthetic Stays Pvt (example)',
    supplierVerification: 'unverified',
    hotelName: 'Synthetic Lakeside Hotel',
    roomType: 'Deluxe double',
    mealPlan: 'Breakfast',
    quotedCostPaise: '4200000',
    holdUntil: '2026-10-20',
    cancellationTerms: 'Free cancellation until 7 days before arrival.',
    status: 'open',
    createdAt: '2026-10-03T05:10:00Z',
    createdByName: 'Synthetic Purchase Jodhpur',
  },
  {
    quoteId: Q2,
    supplierId: S2,
    supplierName: 'Example Lakeview Partners',
    supplierVerification: 'unverified',
    hotelName: 'Synthetic Lakeside Hotel',
    roomType: 'Deluxe double',
    mealPlan: 'Room only',
    quotedCostPaise: '4700000',
    holdUntil: null,
    cancellationTerms: null,
    status: 'withdrawn',
    createdAt: '2026-10-03T05:12:00Z',
    createdByName: 'Synthetic Purchase Jodhpur',
  },
];

const costs: PurchaseWorkspaceView['costVersions'] = [
  { versionNo: 2, quoteId: Q1, stage: 'proposed', amountPaise: '4050000', dueDate: '2026-11-01', note: 'Negotiated a lower supplier rate (synthetic).', payableStatus: 'not_requested', createdAt: '2026-10-03T06:00:00Z', createdByName: 'Synthetic Purchase Jodhpur', overBudgetApprovedAt: null, overBudgetApprovedByName: null },
  { versionNo: 1, quoteId: Q1, stage: 'proposed', amountPaise: '4200000', dueDate: null, note: null, payableStatus: 'not_requested', createdAt: '2026-10-03T05:20:00Z', createdByName: 'Synthetic Purchase Jodhpur', overBudgetApprovedAt: null, overBudgetApprovedByName: null },
];

export const inProgress: PurchaseWorkspaceView = {
  ...empty,
  issues: ['missing_supplier_confirmation_proof'],
  quotes,
  costVersions: costs,
  evidence: [
    { id: 'a1000000-0000-4000-8000-000000000001', kind: 'quote', fileName: 'synthetic-quote.pdf', mime: 'application/pdf', sizeBytes: 182000, status: 'stored', createdAt: '2026-10-03T05:11:00Z', uploadedByName: 'Synthetic Purchase Jodhpur' },
    { id: 'a1000000-0000-4000-8000-000000000002', kind: 'supplier_confirmation', fileName: 'synthetic-confirmation.pdf', mime: 'application/pdf', sizeBytes: 96000, status: 'failed', createdAt: '2026-10-03T06:05:00Z', uploadedByName: 'Synthetic Purchase Jodhpur' },
  ],
};

const ready: PurchaseWorkspaceView = {
  ...inProgress,
  issues: [],
  evidence: [
    inProgress.evidence[0]!,
    { ...inProgress.evidence[1]!, id: 'a1000000-0000-4000-8000-000000000003', status: 'stored' },
  ],
};

export const confirmed: PurchaseWorkspaceView = {
  ...ready,
  task: { ...task, status: 'supplier_confirmed', supplierConfirmedAt: '2026-10-03T06:30:00Z' },
  canWork: false,
  canRelease: false,
  supplierReference: 'SYN-CONF-0001',
  selectedQuoteId: Q1,
  supplierConfirmedByName: 'Synthetic Purchase Jodhpur',
  quotes: [{ ...quotes[0]!, status: 'selected' }, quotes[1]!],
  costVersions: [{ ...costs[0]!, versionNo: 3, stage: 'committed', createdAt: '2026-10-03T06:30:00Z' }, ...costs],
  supplierChoices: [],
};

const err = (code: ProcurementErrorCode) => ({ ok: false as const, code, message: PROCUREMENT_ERROR_TEXT[code] });

const supplierList: SupplierSummary[] = [
  { supplierId: S2, name: 'Example Lakeview Partners', serviceTypes: ['hotel', 'transfer'], city: 'Udaipur', verificationStatus: 'unverified', status: 'active' },
  { supplierId: S1, name: 'Synthetic Stays Pvt (example)', serviceTypes: ['hotel'], city: null, verificationStatus: 'unverified', status: 'active' },
];

const supplierDetail: SupplierDetailView = {
  ...supplierList[1]!,
  city: 'Udaipur',
  contactName: 'Synthetic Reservations Desk',
  contactPhone: '+91 00000 00000',
  contactEmail: 'desk@example.test',
  paymentTerms: '50% at confirmation, rest 7 days before arrival (synthetic).',
  rowVersion: 2,
  updatedAt: '2026-10-03T05:00:00Z',
  verifiedAt: null,
  verifiedByName: null,
  canEdit: true,
  canVerify: false,
  beneficiaries: [
    { revisionNo: 2, accountHolder: 'Synthetic Stays Pvt', bankName: 'Example Bank', ifsc: 'EXMP0000002', accountLast4: '0042', status: 'unverified', createdAt: '2026-10-03T05:30:00Z', createdByName: 'Synthetic Purchase Jodhpur', approvedAt: null, approvedByName: null, canApprove: false },
    { revisionNo: 1, accountHolder: 'Synthetic Stays Pvt', bankName: 'Example Bank', ifsc: 'EXMP0000001', accountLast4: '0007', status: 'unverified', createdAt: '2026-10-02T09:00:00Z', createdByName: 'Synthetic Purchase Jodhpur', approvedAt: null, approvedByName: null, canApprove: false },
  ],
};

const overCosts: PurchaseWorkspaceView['costVersions'] = [{ ...costs[0]!, versionNo: 3, amountPaise: '4800000' }, ...costs];
export const managerView: PurchaseWorkspaceView = {
  ...ready,
  canWork: false,
  canRelease: false,
  canReassign: true,
  canApproveOverBudget: true,
  issues: ['over_budget'],
  costVersions: overCosts,
  reassignCandidates: [{ userId: COLLEAGUE_USER, name: 'Synthetic Purchase Colleague' }],
  supplierChoices: [],
  task: { ...task, assignedToYou: false },
};

const ENTITIES = [{ id: 'e1000000-0000-4000-8000-000000000001', name: 'Holiday Chacha Pvt LTD' }];

function workPage(viewer: ShellViewer, ws: PurchaseWorkspaceView, confirmState?: Parameters<typeof PurchaseWorkSection>[0]['confirmState']): ReactNode {
  return (
    <StaffShell viewer={viewer} currentPath="/app/purchase">
      <PurchaseTaskPage task={ws.task} work={<PurchaseWorkSection ws={ws} confirmState={confirmState} />} />
    </StaffShell>
  );
}

const states: Record<string, () => ReactNode> = {
  'procurement-empty': () => workPage(purchase, empty),
  'procurement-in-progress': () => workPage(purchase, inProgress),
  'procurement-ready': () => workPage(purchase, ready),
  'procurement-over-budget': () => workPage(purchase, { ...ready, issues: ['over_budget'], costVersions: overCosts }),
  'procurement-over-budget-approved': () =>
    workPage(purchase, {
      ...ready,
      costVersions: [{ ...overCosts[0]!, overBudgetApprovedAt: '2026-10-03T06:20:00Z', overBudgetApprovedByName: 'Synthetic Manager Delhi' }, ...costs],
    }),
  'procurement-manager-view': () => workPage(manager, managerView),
  'procurement-released': () =>
    workPage(purchase, {
      ...ready,
      canWork: false,
      canRelease: false,
      assigneeUserId: null,
      supplierChoices: [],
      task: { ...task, status: 'not_started', assigneeName: null, assignedToYou: false, canClaim: true },
    }),
  'procurement-confirm-not-ready': () => workPage(purchase, inProgress, err('not_ready')),
  'procurement-confirm-version-changed': () => workPage(purchase, ready, err('version_changed')),
  'procurement-gate-off': () => workPage(purchase, { ...ready, gateIssue: 'procurement_disabled', issues: ['procurement_disabled'] }),
  'procurement-supplier-confirmed': () => workPage(purchase, confirmed),
  'procurement-colleague-view': () =>
    workPage(purchase, { ...inProgress, canWork: false, canRelease: false, assigneeUserId: COLLEAGUE_USER, supplierChoices: [], task: { ...task, assignedToYou: false, assigneeName: 'Synthetic Purchase Colleague' } }),
  'procurement-sales-view': () => (
    <StaffShell viewer={sales} currentPath="/app/purchase">
      <PurchaseTaskPage task={{ ...confirmed.task, assignedToYou: false }} />
    </StaffShell>
  ),
  'suppliers-list': () => (
    <StaffShell viewer={purchase} currentPath="/app/purchase/suppliers">
      <SupplierListPage suppliers={supplierList} entities={ENTITIES} />
    </StaffShell>
  ),
  'suppliers-empty': () => (
    <StaffShell viewer={purchase} currentPath="/app/purchase/suppliers">
      <SupplierListPage suppliers={[]} entities={ENTITIES} />
    </StaffShell>
  ),
  'supplier-detail': () => (
    <StaffShell viewer={purchase} currentPath="/app/purchase/suppliers">
      <SupplierDetailPage supplier={supplierDetail} />
    </StaffShell>
  ),
  'supplier-detail-manager': () => (
    <StaffShell viewer={manager} currentPath="/app/purchase/suppliers">
      <SupplierDetailPage
        supplier={{
          ...supplierDetail,
          canEdit: false,
          canVerify: true,
          beneficiaries: [{ ...supplierDetail.beneficiaries[0]!, canApprove: true }, supplierDetail.beneficiaries[1]!],
        }}
      />
    </StaffShell>
  ),
  'supplier-detail-verified': () => (
    <StaffShell viewer={purchase} currentPath="/app/purchase/suppliers">
      <SupplierDetailPage
        supplier={{
          ...supplierDetail,
          verificationStatus: 'verified',
          verifiedAt: '2026-10-03T07:00:00Z',
          verifiedByName: 'Synthetic Manager Delhi',
          beneficiaries: [
            { ...supplierDetail.beneficiaries[0]!, status: 'approved', approvedAt: '2026-10-03T07:05:00Z', approvedByName: 'Synthetic Manager Delhi' },
            supplierDetail.beneficiaries[1]!,
          ],
        }}
      />
    </StaffShell>
  ),
  // AUDIT-017 browser check: typed fields survive a refused submit (not a design state).
  'procurement-form-keeps-values': () => <KeepValuesProbe />,
  'supplier-detail-created': () => (
    <StaffShell viewer={purchase} currentPath="/app/purchase/suppliers">
      <SupplierDetailPage supplier={{ ...supplierDetail, beneficiaries: [] }} justCreated />
    </StaffShell>
  ),
};

export const PROCUREMENT_PREVIEW_STATES = Object.keys(states);

export function renderProcurementState(state: string): ReactNode | null {
  return states[state]?.() ?? null;
}
