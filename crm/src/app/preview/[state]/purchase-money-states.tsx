import type { ReactNode } from 'react';
import type { ManagerCancellationRow as CancellationDetailRow } from '@/modules/procurement/contracts';
import type { ManagerApprovalsView } from '@/modules/supplier-money/contracts';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import { ManagerApprovalsPage } from '@/views/purchase/manager-approvals';
import { ACC_MONEY_OUT_STATES, fundingBase, paymentBase } from './acc-money-out-states';
import { pmPreviewDecideAction } from './pm-preview-actions';

/*
 * Purchase build preview states (pm-): the Manager's Approvals page, plus the
 * Accounts go-ahead, supplier payments, supplier invoices and company funding
 * states, which live in acc-money-out-states.tsx (redesign R4) and are spread
 * in below under their pm-accounts- names. Synthetic props only (example names, made-up amounts, SYN- deal
 * references, no real supplier, bank or customer data). Rendered by the
 * design-review gallery, never in production.
 */

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
// Manager approvals
// ---------------------------------------------------------------------------

const approvals: ManagerApprovalsView = {
  flightFares: [],
  costsAboveBudget: [
    { taskId: id(24), dealReference: 'SYN-DEL-010', serviceTitle: 'Example Palace Hotel, Udaipur', supplierName: 'Example Palace Partners', versionNo: 3, amountPaise: '3840000', budgetPaise: '3600000', proposedAt: '2026-11-01T08:00:00Z', proposedByName: 'Synthetic Purchase Colleague', canApprove: true, contractState: 'differs', contractTotalPaise: '3520000', contractDeviationReason: 'Festival week: the hotel added a surcharge not in the contract.' },
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

const emptyApprovals: ManagerApprovalsView = { costsAboveBudget: [], payments: [], funding: [], bankDetails: [], suppliersToVerify: [], cancellations: [], flightFares: [] };

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

const managerActions = { decidePayment: pmPreviewDecideAction, decideFunding: pmPreviewDecideAction, decideCancellation: pmPreviewDecideAction };

function manager(body: ReactNode) {
  return (
    <StaffShell viewer={managerViewer} currentPath="/app/approvals">
      {body}
    </StaffShell>
  );
}

const STATES: Record<string, () => ReactNode> = {
  ...ACC_MONEY_OUT_STATES,
  'pm-manager-approvals': () => manager(<ManagerApprovalsPage view={approvals} actions={managerActions} today={TODAY} cancellationDetails={cancellationDetails} />),
  'pm-manager-approvals-empty': () => manager(<ManagerApprovalsPage view={emptyApprovals} actions={managerActions} today={TODAY} />),
};

export const PURCHASE_MONEY_STATES = Object.keys(STATES);

export function renderPurchaseMoneyState(state: string): ReactNode | null {
  const render = STATES[state];
  return render ? render() : null;
}
