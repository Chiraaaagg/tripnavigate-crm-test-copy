import 'server-only';
import { z } from 'zod';
import type { StaffContext } from '@/modules/identity/server/session';
import { asRpcClient, BookingCommandError, flightTaskGet, flightTaskList } from '../commands';
import type { FlightQueueView, FlightTaskView } from '../contracts';
import { toFlightTaskSummary, toFlightTaskView } from '../dto';

/**
 * Flight queue reads (mirror of the Purchase loaders in queries.ts). The
 * database filters rows to the viewer's department and entity; the DTOs carry
 * no selling price, acceptance proof or other departments' budgets.
 */

type Staff = Pick<StaffContext, 'supabase'>;

const REFUSED = new Set(['not_authorized', 'not_found']);

function isRefusal(error: unknown): boolean {
  return error instanceof BookingCommandError && error.code !== null && REFUSED.has(error.code);
}

export async function loadFlightQueue(staff: Staff): Promise<FlightQueueView> {
  try {
    const records = await flightTaskList(asRpcClient(staff.supabase));
    return { tasks: records.map(toFlightTaskSummary) };
  } catch (error) {
    if (isRefusal(error)) return { tasks: [] };
    throw new Error('Could not load Flight tasks. Please retry.');
  }
}

/** null = not found or not visible (indistinguishable), or a malformed id. */
export async function loadFlightTask(staff: Staff, taskId: string): Promise<FlightTaskView | null> {
  const id = z.uuid().safeParse(taskId);
  if (!id.success) return null;
  try {
    const record = await flightTaskGet(asRpcClient(staff.supabase), id.data);
    return record ? toFlightTaskView(record) : null;
  } catch (error) {
    if (isRefusal(error)) return null;
    throw new Error('Could not load this Flight task. Please retry.');
  }
}
