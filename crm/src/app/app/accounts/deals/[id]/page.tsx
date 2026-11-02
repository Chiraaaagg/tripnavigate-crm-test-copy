import type { Metadata } from 'next';
import { WorkErrorBoundary } from '@/components/WorkErrorBoundary';
import { loadAccountsDealDetail, loadDestinationOptions } from '@/modules/finance/server/queries';
import { linkClaimReceiptAction, markClaimNotReceivedAction, recordReceiptFromClaimAction } from '@/modules/finance/server/claim-actions';
import { requireStaff } from '@/modules/identity/server/session';
import { loadDealIdProofs } from '@/modules/fulfilment/server/id-proofs';
import { AccountsDealIdProofs } from '@/views/b11/id-proofs-list';
import { AccountsDealNotFoundView, accountsDealTabOf, AccountsDealView, FinanceNoAccessView, FinanceUnavailableView } from '@/views/finance-views';
import { FINANCE_ACTIONS, financeRead } from '../../finance-page-support';

export const metadata: Metadata = { title: 'Accounts deal' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Accounts deal page (plan T1: own address kept; DA-15 tabs Money · Review ·
 * Receipts · Documents as links, `?tab=`, allowlisted by the view; default =
 * the tab of the next action). Only the open tab is rendered; the ID proofs
 * are read only when Documents is open.
 */
export default async function AccountsDealPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string | string[] }> }) {
  const [{ id }, { tab }] = await Promise.all([params, searchParams]);
  const staff = await requireStaff();
  if (!UUID.test(id)) return <AccountsDealNotFoundView />;
  const detail = await financeRead(() => loadAccountsDealDetail(staff, id));
  if (!detail.ok) {
    if (detail.code === 'not_authorized') return <FinanceNoAccessView area="accounts" />;
    if (detail.code === 'not_found') return <AccountsDealNotFoundView />;
    return <FinanceUnavailableView code={detail.code} title="Accounts deal" />;
  }
  if (!detail.value) return <AccountsDealNotFoundView />;
  const current = accountsDealTabOf(detail.value, tab).tab;
  // Approved current company accounts for the receipt form. A refusal is passed on as "could not be loaded"
  // (never as "none approved"); the database rechecks the choice when recording.
  const [options, idProofs] = await Promise.all([
    financeRead(() => loadDestinationOptions(staff, id)),
    current === 'documents' ? loadDealIdProofs(staff, id).catch(() => 'error' as const) : Promise.resolve(null),
  ]);
  return (
    <WorkErrorBoundary title="Accounts deal">
      <AccountsDealView
        detail={detail.value}
        actions={FINANCE_ACTIONS}
        destinationOptions={options.ok ? options.value : []}
        destinationOptionsUnavailable={!options.ok}
        claimActions={{ record: recordReceiptFromClaimAction, link: linkClaimReceiptAction, notReceived: markClaimNotReceivedAction }}
        tabParam={tab}
        documents={current === 'documents' ? <AccountsDealIdProofs state={idProofs} /> : undefined}
      />
    </WorkErrorBoundary>
  );
}
