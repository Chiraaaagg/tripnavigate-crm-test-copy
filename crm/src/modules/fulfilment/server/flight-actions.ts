'use server';

import { revalidatePath } from 'next/cache';
import { requireStaff } from '@/modules/identity/server/session';
import { asRpcClient, BookingCommandError, flightTaskClaim } from '../commands';
import { type BookingActionResult, type BookingErrorCode, type ClaimTaskResult, ERROR_TEXT, UNKNOWN_OUTCOME_TEXT } from '../contracts';
import { FIELD, readUuid } from '../forms';

/**
 * Flight queue command (mirror of claimPurchaseTaskAction). Session gate
 * first, then the database command under the staff member's own session.
 * Signature fits useActionState: (previous result | null, FormData).
 */

const FLIGHT_PATH = '/app/flight';

function fail(code: BookingErrorCode | 'session'): BookingActionResult<never> {
  return { ok: false, code, message: ERROR_TEXT[code] };
}

function failFrom(error: unknown): BookingActionResult<never> {
  if (error instanceof BookingCommandError && error.code) return fail(error.code);
  // The command may have committed before the failure: never claim "nothing changed".
  throw new Error(UNKNOWN_OUTCOME_TEXT);
}

export async function claimFlightTaskAction(
  _prev: BookingActionResult<ClaimTaskResult> | null,
  formData: FormData,
): Promise<BookingActionResult<ClaimTaskResult>> {
  const staff = await requireStaff();
  const taskId = readUuid(formData, FIELD.taskId);
  if (!taskId) return fail('invalid_input');
  try {
    const result = await flightTaskClaim(asRpcClient(staff.supabase), taskId);
    revalidatePath(FLIGHT_PATH);
    revalidatePath(`${FLIGHT_PATH}/${taskId}`);
    return {
      ok: true,
      data: result,
      message: result.alreadyYours ? 'This task is already yours.' : 'You have taken this task. It is now in progress. No ticket is issued yet.',
    };
  } catch (error) {
    if (error instanceof BookingCommandError && error.code === 'task_conflict') revalidatePath(`${FLIGHT_PATH}/${taskId}`);
    return failFrom(error);
  }
}
