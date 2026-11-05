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
  const [view, cancellationDetails] = await Promise.all([loadManagerApprovals(staff), loadManagerCancellations(staff).catch(() => [])]);
  return (
    <ManagerApprovalsPage
      view={view}
      cancellationDetails={cancellationDetails}
      today={todayInIndia()}
      actions={{ decidePayment: decidePaymentRequestAction, decideFunding: decideCompanyFundingAction, decideCancellation: decideCancellationAction }}
      // Flight build (contract 11.1): fares above a Deal's flight budget, approve or return with a reason.
      flightSection={
        view.flightFares?.length ? <FlightFaresApprovals rows={view.flightFares} actions={{ decideFares: decideFlightFareApprovalAction as unknown as DecisionAction }} /> : undefined
      }
    />
  );
}
