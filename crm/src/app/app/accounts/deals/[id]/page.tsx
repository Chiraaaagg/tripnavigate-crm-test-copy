import type { Metadata } from 'next';
import { WorkErrorBoundary } from '@/components/WorkErrorBoundary';
import { addTallyInvoiceAction, withdrawTallyInvoiceAction } from '@/modules/accounts-desk/server/actions';
import { loadDealDues } from '@/modules/accounts-desk/server/queries';
import { loadAccountsDealDetail, loadDestinationOptions } from '@/modules/finance/server/queries';
import { linkClaimReceiptAction, markClaimNotReceivedAction, recordReceiptFromClaimAction } from '@/modules/finance/server/claim-actions';
import { requireStaff } from '@/modules/identity/server/session';
import { loadDealIdProofs } from '@/modules/fulfilment/server/id-proofs';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { DealDuesCard } from '@/views/accounts-desk/deal-money';
import { AccountsDealIdProofs } from '@/views/b11/id-proofs-list';
import { AccountsDealNotFoundView, accountsDealTabOf, AccountsDealView, FinanceNoAccessView, FinanceUnavailableView } from '@/views/finance-views';
import { FINANCE_ACTIONS, financeRead } from '../../finance-page-support';
import { customerDocumentsCard, refundsCard } from '../../acc2-cards';

export const metadata: Metadata = { title: 'Accounts deal' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Accounts view of a Deal (plan T1: own address kept). R4 (design plan 2.3):
 * one page with the tabs Receipts · Dues and plan · Documents · Refunds ·
 * Review as links (`?tab=`, allowlisted by the view; the Batch 4 value
 * `money` opens Receipts; default = the tab of the next action). Only the
 * open tab's extra reads run: ID proofs and customer documents on Documents,
 * the dues on Dues and plan, the refunds on Refunds. Every read runs under the
 * person's own session and the database decides it.
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
  // Approved current company accounts for the receipt form ("Record a receipt" is at the top of every tab).
  // A refusal is passed on as "could not be loaded" (never as "none approved"); the database rechecks the
  // choice when recording. Accounts phase 2 (screens 11.1, 11.3): customer documents (Documents) and refund
  // payouts (Refunds) for Deals of every branch; the reads fence every row.
  const [options, idProofs, docsCard, refundCard, dues] = await Promise.all([
    financeRead(() => loadDestinationOptions(staff, id)),
    current === 'documents' ? loadDealIdProofs(staff, id).catch(() => 'error' as const) : Promise.resolve(null),
    current === 'documents' ? customerDocumentsCard(staff, id, { moneyReader: true, numberPrefix: null }) : Promise.resolve(null),
    current === 'refunds' ? refundsCard(staff, id, { moneyReader: true }) : Promise.resolve(null),
    current === 'dues' ? loadDealDues(staff, id).catch(() => 'error' as const) : Promise.resolve(null),
  ]);
  // The same dues card as the Deal page's Money tab; deal_dues decides the reading mode (null = none for this person).
  const duesCard =
    dues === 'error' ? (
      <DealDuesCard dues="error" viewer="accounts" />
    ) : dues ? (
      <DealDuesCard
        dues={dues}
        viewer={dues.viewer}
        actions={dues.viewer === 'accounts' ? { addTallyInvoice: addTallyInvoiceAction as unknown as DecisionAction, withdrawTallyInvoice: withdrawTallyInvoiceAction as unknown as DecisionAction } : null}
      />
    ) : undefined;
  return (
    <WorkErrorBoundary title="Accounts deal">
      <AccountsDealView
        detail={detail.value}
        actions={FINANCE_ACTIONS}
        destinationOptions={options.ok ? options.value : []}
        destinationOptionsUnavailable={!options.ok}
        claimActions={{ record: recordReceiptFromClaimAction, link: linkClaimReceiptAction, notReceived: markClaimNotReceivedAction }}
        tabParam={tab}
        documents={
          current === 'documents' ? (
            <>
              {docsCard}
              <AccountsDealIdProofs state={idProofs} />
            </>
          ) : undefined
        }
        dues={current === 'dues' ? duesCard : undefined}
        refunds={current === 'refunds' ? (refundCard ?? undefined) : undefined}
      />
    </WorkErrorBoundary>
  );
}
