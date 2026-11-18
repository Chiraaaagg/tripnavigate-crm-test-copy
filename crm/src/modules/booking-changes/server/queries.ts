import 'server-only';
import { asRpcClient } from '@/modules/fulfilment/commands';
import type { StaffContext } from '@/modules/identity/server/session';
import {
  readChangeHistory,
  readChangePreview,
  readChangeRequests,
  readChangeReview,
  readDealChangeRequests,
  readServiceRemovalCharges,
  readTaskReconfirmation,
} from '../commands';
import type {
  ChangeHistory,
  ChangePreview,
  ChangeRequestsFilter,
  ChangeRequestsPage,
  ChangeReview,
  DealChangeRequests,
  ServiceRemovalCharges,
  TaskReconfirmation,
} from '../dto';

/**
 * Change reads for pages (contract 10.5), under the staff member's OWN
 * session. The database fences every read (section 14) and returns null for
 * everyone it does not allow; pages show nothing then.
 */

/** R-G1: Deal page card (Sales owner, branch Manager, Accounts). */
export function loadDealChangeRequests(staff: StaffContext, dealId: string): Promise<DealChangeRequests | null> {
  return readDealChangeRequests(asRpcClient(staff.supabase), dealId);
}

/** R-G2: Approvals and lists (Manager preset to_approve; Sales owner own Deals; Accounts read-only). */
export function loadChangeRequests(staff: StaffContext, filter: ChangeRequestsFilter, after: string | null, limit = 50): Promise<ChangeRequestsPage | null> {
  return readChangeRequests(asRpcClient(staff.supabase), filter, after, limit);
}

/** R-G3: Purchase task "Reconfirm with supplier" panel (the task's Purchase readers and the branch Manager). */
export function loadTaskReconfirmation(staff: StaffContext, taskId: string): Promise<TaskReconfirmation | null> {
  return readTaskReconfirmation(asRpcClient(staff.supabase), taskId);
}

/** R-G4: change history on the Deal page. */
export function loadChangeHistory(staff: StaffContext, dealId: string): Promise<ChangeHistory | null> {
  return readChangeHistory(asRpcClient(staff.supabase), dealId);
}

/** Change mode of the booking form: what G6 needs (content hash, changed services). */
export function loadChangePreview(staff: StaffContext, changeRequestId: string): Promise<ChangePreview | null> {
  return readChangePreview(asRpcClient(staff.supabase), changeRequestId);
}

/** R-H1 (track H): the supplier charges of a booked removal (Approvals, the branch Manager; Accounts read). */
export function loadServiceRemovalCharges(staff: StaffContext, changeRequestId: string): Promise<ServiceRemovalCharges | null> {
  return readServiceRemovalCharges(asRpcClient(staff.supabase), changeRequestId);
}

/** R-H2 (Addendum O2): the Manager's approval view - accepted booking and change version side by side. */
export function loadChangeReview(staff: StaffContext, changeRequestId: string): Promise<ChangeReview | null> {
  return readChangeReview(asRpcClient(staff.supabase), changeRequestId);
}
