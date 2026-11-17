import type { Metadata } from 'next';
import { requireStaff } from '@/modules/identity/server/session';
import { decideCancellationAction } from '@/modules/procurement/server/actions';
import { loadManagerCancellations } from '@/modules/procurement/server/queries';
import { decideCompanyFundingAction, decidePaymentRequestAction } from '@/modules/supplier-money/server/actions';
import { loadManagerApprovals } from '@/modules/supplier-money/server/queries';
import { decideFlightFareApprovalAction } from '@/modules/flight/server/money-actions';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { FlightFaresApprovals } from '@/views/flight/manager-fares';
import { ApprovalsNotForYouView, ManagerApprovalsPage } from '@/views/purchase/manager-approvals';
import { todayInIndia } from '@/views/accounts/supplier-kit';
import { decideRefundAction } from '@/modules/refunds/server/actions';
import { loadRefundRequests } from '@/modules/refunds/server/queries';
import { ApprovalsRefundsSection, type QueuedRefund } from '@/views/refunds/desk';
import { loadSmallBalances } from '@/modules/write-offs/server/queries';
import { decideWriteOffAction, undoWriteOffAction } from '@/modules/write-offs/server/actions';
import { WriteOffApprovalsTab } from '@/views/write-offs/small-balances';
import { loadRateContracts, loadRateContractsState } from '@/modules/rate-contracts/server/queries';
import { decideChangeAction } from '@/modules/booking-changes/server/actions';
import { loadChangeRequests, loadChangeReview, loadServiceRemovalCharges } from '@/modules/booking-changes/server/queries';
import { changeRequestsPageView, changeReviewView, removalChargesView } from '@/views/booking-changes/adapt';
import { ChangeRequestsApprovalsSection } from '@/views/booking-changes/approvals';
import type { ServiceRemovalCharges } from '@/modules/booking-changes/dto';
import type { ChangeReviewView, RemovalChargesView } from '@/views/booking-changes/types';
import { RateContractApprovalsTab } from '@/views/rate-contracts/approvals';

export const metadata: Metadata = { title: 'Approvals' };

/**
 * Manager · Approvals (Purchase build; Flight build adds "Flight fares above
 * budget"). manager_approvals returns only items
 * of the branches the viewer manages; every decision command re-checks the
 * role and refuses the person's own entry.
 */
export default async function ApprovalsRoute() {
  const staff = await requireStaff();
  if (!staff.memberships.some((m) => m.roleCode === 'manager')) {
    return <ApprovalsNotForYouView />;
  }
  const [view, cancellationDetails, refundRes, writeOffs, rateContracts, rateState, changeRequests] = await Promise.all([
    loadManagerApprovals(staff),
    loadManagerCancellations(staff).catch(() => []),
    // Accounts phase 2 (contract 7.5 R-C2 preset to_approve, screen 11.4): refunds waiting for this Manager.
    loadRefundRequests(staff, { preset: 'to_approve' }, null).catch(() => ({ ok: false as const, invalid: null })),
    // Accounts phase 3 (contract 6.6 R-B1 preset to_approve, screen 15.6): write-offs waiting for this Manager.
    loadSmallBalances(staff, { preset: 'to_approve' }, null).catch(() => 'error' as const),
    // Accounts phase 3 (contract 9.5 R-E1 preset to_approve, screen 15.9): rate contracts waiting for a Manager.
    loadRateContracts(staff, { filter: { preset: 'to_approve' }, limit: 50 }).catch(() => 'error' as const),
    loadRateContractsState(staff).catch(() => null),
    // Accounts phase 3 (contract 10.5 R-G2 preset to_approve, screen 15.10): change requests waiting for this Manager.
    loadChangeRequests(staff, { preset: 'to_approve' }, null).catch(() => 'error' as const),
  ]);
  // Accounts phase 3 (contract 11.3 R-H1): the supplier charges of each booked removal waiting for this Manager.
  // Addendum O2 (R-H2): the old and new booking side by side for each request waiting for this Manager.
  const [removalCharges, changeReviews] = await Promise.all([removalChargesFor(staff, changeRequests), changeReviewsFor(staff, changeRequests)]);
  const changesPage =
    changeRequests === 'error' || changeRequests === null
      ? changeRequests
      : ((v) => ({
          ...v,
          items: v.items.map((r) => {
            const c = removalCharges.raw[r.id];
            return c ? { ...r, removalRoute: c.removalRoute, customerChargePaise: c.customerChargePaise, chargesComplete: c.complete } : r;
          }),
        }))(changeRequestsPageView(changeRequests));
  const writeOffCount = writeOffs === 'error' ? 1 : (writeOffs?.items.length ?? 0);
  const rateCount = rateContracts === 'error' ? 1 : (rateContracts?.items.length ?? 0);
  const changeCount = changeRequests === 'error' ? 1 : (changeRequests?.items.length ?? 0);
  const refundQueue: QueuedRefund[] | 'error' | null = refundRes.ok ? (refundRes.data === null ? null : refundRes.data.items) : 'error';
  return (
    <ManagerApprovalsPage
      view={view}
      cancellationDetails={cancellationDetails}
      today={todayInIndia()}
      actions={{ decidePayment: decidePaymentRequestAction, decideFunding: decideCompanyFundingAction, decideCancellation: decideCancellationAction }}
      phase3Count={writeOffCount + rateCount + changeCount}
      phase3Sections={
        writeOffCount + rateCount + changeCount === 0 ? undefined : (
          <>
            {writeOffs === null || writeOffCount === 0 ? null : (
              <WriteOffApprovalsTab
                page={writeOffs === 'error' ? 'error' : { items: writeOffs.items, nextAfter: writeOffs.nextAfter, hasMore: writeOffs.hasMore ?? writeOffs.nextAfter !== null }}
                actions={{ decide: decideWriteOffAction as unknown as DecisionAction, undo: undoWriteOffAction as unknown as DecisionAction }}
              />
            )}
            {rateContracts === null || rateCount === 0 ? null : (
              <RateContractApprovalsTab
                rows={rateContracts === 'error' ? 'error' : rateContracts.items}
                // rate_contracts_state; an unreadable state counts as On (a decision while Off is refused rate_contracts_off).
                // Rows carry isMine / canApprove (migration 0570); the database still refuses a self-approval.
                enabled={rateState?.enabled ?? true}
                visibleHeading
              />
            )}
            {changeRequests === null || changeCount === 0 ? null : (
              <ChangeRequestsApprovalsSection
                page={changesPage === 'error' || changesPage === null ? 'error' : changesPage}
                charges={removalCharges.views}
                reviews={changeReviews}
                actions={{ decide: decideChangeAction as unknown as DecisionAction }}
              />
            )}
          </>
        )
      }
      refundCount={Array.isArray(refundQueue) ? refundQueue.length : refundQueue === 'error' ? 1 : 0}
      refundSection={
        refundQueue === null || (Array.isArray(refundQueue) && refundQueue.length === 0) ? undefined : (
          <ApprovalsRefundsSection
            queue={refundQueue}
            actions={{ decide: decideRefundAction as unknown as DecisionAction }}
            today={todayInIndia()}
          />
        )
      }
      // Flight build (contract 11.1): fares above a Deal's flight budget, approve or return with a reason.
      flightSection={
        view.flightFares?.length ? <FlightFaresApprovals rows={view.flightFares} actions={{ decideFares: decideFlightFareApprovalAction as unknown as DecisionAction }} /> : undefined
      }
    />
  );
}

async function removalChargesFor(staff: Awaited<ReturnType<typeof requireStaff>>, page: Awaited<ReturnType<typeof loadChangeRequests>> | 'error') {
  const raw: Record<string, ServiceRemovalCharges> = {};
  const views: Record<string, RemovalChargesView | 'error'> = {};
  if (page === 'error' || page === null) return { raw, views };
  const removals = page.items.filter((r) => r.kind === 'remove_service');
  await Promise.all(
    removals.map(async (r) => {
      const c = await loadServiceRemovalCharges(staff, r.id).catch(() => 'error' as const);
      if (c === 'error') views[r.id] = 'error';
      else if (c) {
        raw[r.id] = c;
        if (c.removalRoute === 'cancellation') views[r.id] = removalChargesView(c);
      }
    }),
  );
  return { raw, views };
}

/** Addendum O2: the side-by-side review of each waiting request (an unreadable one blocks its Approve button). */
async function changeReviewsFor(staff: Awaited<ReturnType<typeof requireStaff>>, page: Awaited<ReturnType<typeof loadChangeRequests>> | 'error') {
  const views: Record<string, ChangeReviewView | 'error'> = {};
  if (page === 'error' || page === null) return views;
  await Promise.all(
    page.items
      .filter((r) => r.status === 'requested')
      .map(async (r) => {
        const v = await loadChangeReview(staff, r.id).catch(() => 'error' as const);
        if (v === 'error') views[r.id] = 'error';
        else if (v) views[r.id] = changeReviewView(v);
      }),
  );
  return views;
}
