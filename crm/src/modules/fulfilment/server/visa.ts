import 'server-only';
import { z } from 'zod';
import type { StaffContext } from '@/modules/identity/server/session';
import { visaTaskGet, visaTaskList } from '../b11-commands';
import { toVisaQueueView, toVisaTaskView } from '../b11-dto';
import { asRpcClient, BookingCommandError, isFunctionMissing } from '../commands';
import type { VisaQueueView, VisaTaskView } from '../contracts';
import type { SwitchState } from '@/modules/settings/contracts';
import { loadWorkflowSwitchStates } from './intake';

/**
 * Visa & Passport desk reads (appendix A §3.2). The database filters rows to
 * the desk role and entity; the DTOs carry no selling price, list price,
 * discount, plan, claims, receipts, contacts or billing. A database without
 * migration 0500 answers "function missing": the queue is then empty with
 * launch = 'unknown' and a task is "not available".
 */

type Staff = Pick<StaffContext, 'supabase'>;

const REFUSED = new Set(['not_authorized', 'not_found']);

function isRefusal(error: unknown): boolean {
  return error instanceof BookingCommandError && error.code !== null && REFUSED.has(error.code);
}

/**
 * The desk switch as read, in three states (Batch 4): any failed or refused
 * read, or a database that does not report the switch, is 'unknown', never
 * 'off' (loadWorkflowSettings would read as off; it is not used here).
 */
async function visaLaunchState(staff: Staff): Promise<SwitchState> {
  try {
    const settings = await loadWorkflowSwitchStates(staff);
    const on = settings.visaPassportTasksEnabled;
    return on === true ? 'on' : on === false ? 'off' : 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function loadVisaQueue(staff: Staff): Promise<VisaQueueView> {
  const launch = await visaLaunchState(staff);
  try {
    const records = await visaTaskList(asRpcClient(staff.supabase));
    return toVisaQueueView(records, launch, null);
  } catch (error) {
    if (isRefusal(error) || isFunctionMissing(error)) return toVisaQueueView([], launch, null);
    throw new Error('Could not load the Visa & Passport tasks. Please retry.');
  }
}

/** null = not found, not visible, malformed id, or not installed (indistinguishable). */
export async function loadVisaTask(staff: Staff, taskId: string): Promise<VisaTaskView | null> {
  const id = z.uuid().safeParse(taskId);
  if (!id.success) return null;
  try {
    const record = await visaTaskGet(asRpcClient(staff.supabase), id.data);
    return record ? toVisaTaskView(record) : null;
  } catch (error) {
    if (isRefusal(error) || isFunctionMissing(error)) return null;
    throw new Error('Could not load this Visa & Passport task. Please retry.');
  }
}
