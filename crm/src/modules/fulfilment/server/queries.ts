import 'server-only';
import { z } from 'zod';
import type { StaffContext } from '@/modules/identity/server/session';
import {
  asRpcClient,
  BookingCommandError,
  bookingHealth,
  bookingPanel,
  purchaseTaskGet,
  purchaseTaskList,
} from '../commands';
import type { BookingHealthView, BookingPanelView, PurchaseQueueView, PurchaseTaskView } from '../contracts';
import { toBookingHealthView, toBookingPanelView, toPurchaseTaskSummary, toPurchaseTaskView } from '../dto';

/**
 * Reads for booking screens. Everything runs under the staff member's own
 * session: the database decides visibility (RLS + security-definer read
 * functions). "Not visible" and "does not exist" both return null/empty; a
 * failure the database did not explain throws (never a fabricated empty state).
 */

type Staff = Pick<StaffContext, 'supabase' | 'access'>;

const REFUSED = new Set(['not_authorized', 'not_found']);

function isRefusal(error: unknown): boolean {
  return error instanceof BookingCommandError && error.code !== null && REFUSED.has(error.code);
}

/** Deal scope facts for the application policy mirror; null when the deal is not visible. */
async function dealScope(staff: Staff, dealId: string) {
  const [deal, assignments] = await Promise.all([
    staff.supabase.from('deals').select('id, legal_entity_id, branch_id, owner_user_id').eq('id', dealId).maybeSingle(),
    staff.supabase.from('deal_assignments').select('user_id').eq('deal_id', dealId).is('ended_at', null),
  ]);
  if (deal.error || assignments.error) throw new Error('Could not load the booking. Please retry.');
  const row = deal.data as { id: string; legal_entity_id: string; branch_id: string; owner_user_id: string } | null;
  if (!row) return null;
  return {
    id: row.id,
    legalEntityId: row.legal_entity_id,
    branchId: row.branch_id,
    ownerUserId: row.owner_user_id,
    activeAssigneeIds: ((assignments.data ?? []) as Array<{ user_id: string }>).map((a) => a.user_id),
  };
}

export async function loadBookingForDeal(staff: Staff, dealId: string): Promise<BookingPanelView | null> {
  const id = z.uuid().safeParse(dealId);
  if (!id.success) return null;
  const deal = await dealScope(staff, id.data);
  if (!deal) return null;
  try {
    const record = await bookingPanel(asRpcClient(staff.supabase), id.data);
    return record ? toBookingPanelView(staff.access, deal, record) : null;
  } catch (error) {
    if (isRefusal(error)) return null;
    throw new Error('Could not load the booking. Please retry.');
  }
}

export async function loadPurchaseQueue(staff: Staff): Promise<PurchaseQueueView> {
  try {
    const records = await purchaseTaskList(asRpcClient(staff.supabase));
    return { tasks: records.map(toPurchaseTaskSummary) };
  } catch (error) {
    // Not authorized = no task this person may see (the database already filters rows).
    if (isRefusal(error)) return { tasks: [] };
    throw new Error('Could not load Purchase tasks. Please retry.');
  }
}

export async function loadPurchaseTask(staff: Staff, taskId: string): Promise<PurchaseTaskView | null> {
  const id = z.uuid().safeParse(taskId);
  if (!id.success) return null;
  try {
    const record = await purchaseTaskGet(asRpcClient(staff.supabase), id.data);
    return record ? toPurchaseTaskView(record) : null;
  } catch (error) {
    if (isRefusal(error)) return null;
    throw new Error('Could not load this Purchase task. Please retry.');
  }
}

/** null = the viewer may not see booking health (not an admin). */
export async function loadBookingHealth(staff: Staff): Promise<BookingHealthView | null> {
  try {
    return toBookingHealthView(await bookingHealth(asRpcClient(staff.supabase)));
  } catch (error) {
    if (isRefusal(error)) return null;
    throw new Error('Could not load booking health. Please retry.');
  }
}
