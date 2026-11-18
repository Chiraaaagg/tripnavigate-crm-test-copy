import type { ReactNode } from 'react';
import type { AccountsDealDetail } from '@/modules/finance/contracts';
import type { AccountsDealTab } from '@/modules/settings/contracts';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import { AccountsDealIdProofs } from '@/views/b11/id-proofs-list';
import { AccountsDealView, AccountsQueueView, FinanceNoAccessView } from '@/views/finance-views';
import { idProof } from './b11-fixtures';
import { accounts, actions, destinationOptions, detail, queueItems } from './finance-states';

/*
 * Batch 4 preview states: Luna accounts track (To check tabs, Accounts deal
 * page tabs, the approve confirmation, billing saved after approval, the
 * Documents tab, Purchase refused). Synthetic props only; rendered by the
 * design-review gallery (page.tsx), never in production.
 */

const purchase: ShellViewer = { ...accounts, displayName: 'Synthetic Purchase Delhi', primaryRole: 'Purchase', primaryBranch: 'Delhi', canUseAccounts: false, canCheckCustomers: false, canSeePurchaseTasks: true };

/** Billing saved again after an approval: billing back to "saved, not verified" and the review back to waiting (M28). */
const billingAfterApproval: AccountsDealDetail = {
  ...detail,
  receipts: detail.receipts.filter((r) => r.status !== 'recorded'),
  money: { ...detail.money, awaitingVerificationPaise: '0' },
  booking: { ...detail.booking!, reviewStatus: 'pending', reviewRowVersion: 3, reviewedAt: '2026-11-03T06:00:00Z', reviewedByName: 'Synthetic Accounts Jodhpur', canApprove: false, approveBlock: 'billing_not_verified' },
  billing: { ...detail.billing!, status: 'draft', rowVersion: 3, updatedAt: '2026-11-03T07:10:00Z', verifiedAt: null, verifiedByName: null },
};

/** Nothing waiting: billing checked, booking approved, no receipt waiting. */
const allDone: AccountsDealDetail = {
  ...detail,
  receipts: detail.receipts.filter((r) => r.status !== 'recorded'),
  money: { ...detail.money, awaitingVerificationPaise: '0' },
  booking: { ...detail.booking!, reviewStatus: 'approved', reviewedAt: '2026-11-03T06:00:00Z', reviewedByName: 'Synthetic Accounts Jodhpur', canApprove: false, approveBlock: 'wrong_state' },
};

const idProofs = (
  <AccountsDealIdProofs
    state={{
      dealId: detail.dealId,
      travellers: [
        { seq: 1, fullName: 'Sample Traveller A', type: 'adult', idProofs: [idProof(1), idProof(2)].map((f) => ({ fileId: f.fileId, fileName: f.fileName, mime: f.mime, sizeLabel: f.sizeLabel, storedAt: f.storedAt!, downloadHref: '/preview/b4-accounts-deal-documents' })) },
        { seq: 2, fullName: 'Sample Traveller B', type: 'adult', idProofs: [] },
      ],
    }}
  />
);

function deal(name: string, d: AccountsDealDetail, tab?: AccountsDealTab, extra: { documents?: ReactNode } = {}) {
  return (
    <StaffShell viewer={accounts} currentPath="/app/accounts">
      <AccountsDealView detail={d} actions={actions} destinationOptions={destinationOptions} tabParam={tab} tabHref={(t) => `/preview/${name}--${t}`} documents={extra.documents} />
    </StaffShell>
  );
}

const DEAL_STATES: Record<string, (tab?: AccountsDealTab) => ReactNode> = {
  'b4-accounts-deal-billing-after-approval': (tab) => deal('b4-accounts-deal-billing-after-approval', billingAfterApproval, tab ?? 'review'),
  'b4-accounts-deal-nothing-waiting': (tab) => deal('b4-accounts-deal-nothing-waiting', allDone, tab),
  'b4-accounts-deal-documents': (tab) => deal('b4-accounts-deal-documents', detail, tab ?? 'documents', { documents: idProofs }),
};

const STATES: Record<string, () => ReactNode> = {
  'b4-accounts-to-check': () => (
    <StaffShell viewer={accounts} currentPath="/app/accounts">
      <AccountsQueueView items={queueItems.slice(0, 3)} filter="needs_review" paging={{ totalCount: 3, hasMore: false, nextAfter: null, laterPage: false }} />
    </StaffShell>
  ),
  'b4-accounts-to-check-receipts': () => (
    <StaffShell viewer={accounts} currentPath="/app/accounts">
      <AccountsQueueView items={queueItems.slice(1, 3)} filter="awaiting_verification" paging={{ totalCount: 2, hasMore: false, nextAfter: null, laterPage: false }} />
    </StaffShell>
  ),
  'b4-accounts-to-check-returned': () => (
    <StaffShell viewer={accounts} currentPath="/app/accounts">
      <AccountsQueueView items={[]} filter="returned" paging={{ totalCount: 0, hasMore: false, nextAfter: null, laterPage: false }} />
    </StaffShell>
  ),
  'b4-accounts-to-check-receipts-empty': () => (
    <StaffShell viewer={accounts} currentPath="/app/accounts">
      <AccountsQueueView items={[]} filter="awaiting_verification" paging={{ totalCount: 0, hasMore: false, nextAfter: null, laterPage: false }} />
    </StaffShell>
  ),
  // T-B4-11: a Purchase holder opening any Accounts address gets the same refusal, no amounts.
  'b4-accounts-purchase-refused': () => (
    <StaffShell viewer={purchase} currentPath="/app/accounts">
      <FinanceNoAccessView area="accounts" />
    </StaffShell>
  ),
};

for (const [name, render] of Object.entries(DEAL_STATES)) {
  STATES[name] = () => render();
  for (const t of ['money', 'review', 'receipts', 'documents'] as const) STATES[`${name}--${t}`] = () => render(t);
}

export const BATCH4_ACCOUNTS_STATES = Object.keys(STATES);

export function renderBatch4AccountsState(state: string): ReactNode | null {
  return STATES[state]?.() ?? null;
}
