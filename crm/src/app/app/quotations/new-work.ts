import 'server-only';
import { loadWorkflowSwitchStates } from '@/modules/fulfilment/server/workflow-settings';
import type { StaffContext } from '@/modules/identity/server/session';
import type { NewWorkVM, WorkListKind } from '@/modules/quotations/work-contract';
import { newWorkVM, referralSwitchState } from '@/modules/quotations/work-model';
import { shellPermissions } from '../shell-permissions';

/**
 * QN / IN (Batch 3): the New quotation / New itinerary choice. The referral
 * switch is read under the person's own session; a failed read is Unknown
 * (the referral form is not offered, and the page says it could not check),
 * never Off. The branch list is display only: the database decides on create.
 */
export async function loadNewWork(staff: StaffContext, kind: WorkListKind, financeEntities: string[]): Promise<NewWorkVM> {
  const settings = shellPermissions(staff, financeEntities).canSeeQuotations ? await loadWorkflowSwitchStates(staff).catch(() => null) : null;
  const allowed = shellPermissions(staff, financeEntities);
  return newWorkVM({
    kind,
    switchState: referralSwitchState(settings),
    memberships: staff.memberships,
    canSeeLeads: Boolean(allowed.canSeeLeads),
    // Echo L4: only people with the Quotations menu item get the referral form; others see the not-for-role state.
    allowed: allowed.canSeeQuotations,
  });
}
