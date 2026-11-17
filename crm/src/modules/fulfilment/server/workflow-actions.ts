'use server';

import { revalidatePath } from 'next/cache';
import { requireStaff } from '@/modules/identity/server/session';
import { adminSetWorkflowSetting, asRpcClient, BookingCommandError } from '../commands';
import {
  type BookingActionResult,
  type BookingErrorCode,
  ERROR_TEXT,
  UNKNOWN_OUTCOME_TEXT,
  WORKFLOW_SETTING_LABEL,
  type WorkflowSettingResult,
} from '../contracts';
import { parseWorkflowSettingForm } from '../forms';

/**
 * Super Admin workflow switches (contract §13). The database checks
 * authz.can_switch_live_settings, requires the reason and writes the audit
 * row; nothing here reads the actor or entity from the form. Flipping a
 * switch on the live database still needs the owner's APPROVE first
 * (standing rules §3); this action is the mechanism, not the permission.
 */

const WORKFLOW_PATH = '/app/admin/workflow';

function fail(code: BookingErrorCode | 'session'): BookingActionResult<never> {
  return { ok: false, code, message: ERROR_TEXT[code] };
}

function failFrom(error: unknown): BookingActionResult<never> {
  if (error instanceof BookingCommandError && error.code) return fail(error.code);
  throw new Error(UNKNOWN_OUTCOME_TEXT);
}

export async function setWorkflowSettingAction(
  _prev: BookingActionResult<WorkflowSettingResult> | null,
  formData: FormData,
): Promise<BookingActionResult<WorkflowSettingResult>> {
  const staff = await requireStaff();
  const parsed = parseWorkflowSettingForm(formData);
  if (!parsed.ok) return fail('invalid_input');
  try {
    const result = await adminSetWorkflowSetting(asRpcClient(staff.supabase), parsed.value);
    revalidatePath(WORKFLOW_PATH);
    // Batch 4: Settings · System health shows the same switches read only.
    revalidatePath('/app/admin/bookings');
    revalidatePath('/app');
    revalidatePath('/app/deals');
    const title = WORKFLOW_SETTING_LABEL[result.key].title;
    return {
      ok: true,
      data: result,
      message: result.changed
        ? `"${title}" is now ${result.after ? 'on' : 'off'}. The reason is recorded in the audit log.`
        : `"${title}" was already ${result.after ? 'on' : 'off'}. Nothing changed.`,
    };
  } catch (error) {
    return failFrom(error);
  }
}
