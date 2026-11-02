import 'server-only';
import { z } from 'zod';
import type { StaffContext } from '@/modules/identity/server/session';
import { departmentWorkForm } from '../b11-commands';
import { toDepartmentWorkFormView } from '../b11-dto';
import { asRpcClient, BookingCommandError, isFunctionMissing } from '../commands';
import type { DepartmentWorkFormView } from '../contracts';

/**
 * Department work form of one task (Purchase placeholder, Flight cost block,
 * Visa & Passport desk). null = the caller cannot read the task, a malformed
 * id, or a database without migration 0500 (the task page then shows no cost
 * block).
 */
export async function loadDepartmentWorkForm(staff: Pick<StaffContext, 'supabase'>, taskId: string): Promise<DepartmentWorkFormView | null> {
  const id = z.uuid().safeParse(taskId);
  if (!id.success) return null;
  try {
    const record = await departmentWorkForm(asRpcClient(staff.supabase), id.data);
    return record ? toDepartmentWorkFormView(record) : null;
  } catch (error) {
    if (isFunctionMissing(error)) return null;
    if (error instanceof BookingCommandError && (error.code === 'not_authorized' || error.code === 'not_found')) return null;
    throw new Error('Could not load the work form of this task. Please retry.');
  }
}
