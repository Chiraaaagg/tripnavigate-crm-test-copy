import 'server-only';
import { z } from 'zod';
import type { StaffContext } from '@/modules/identity/server/session';
import { asRpcClient } from '../commands';
import { TaskHistoryError, departmentTaskHistory, type TaskHistory } from '../task-history';

/**
 * History tab of a department task (DA-16). Never throws:
 *   record           the task's events (newest first)
 *   null             not found, not readable for this person, or a malformed id
 *   'not_installed'  the database has no Batch 4 read yet (say History is not available yet)
 *   'error'          anything else ("History could not be loaded")
 */

type Staff = Pick<StaffContext, 'supabase'>;

export async function loadTaskHistory(staff: Staff, taskId: string): Promise<TaskHistory | null | 'not_installed' | 'error'> {
  const id = z.uuid().safeParse(taskId);
  if (!id.success) return null;
  try {
    return await departmentTaskHistory(asRpcClient(staff.supabase), id.data);
  } catch (error) {
    if (error instanceof TaskHistoryError) {
      if (error.code === 'not_authorized') return null;
      if (error.code === 'not_installed') return 'not_installed';
    }
    return 'error';
  }
}
