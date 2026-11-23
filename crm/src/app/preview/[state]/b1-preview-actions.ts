'use server';

import { type BookingActionResult, ERROR_TEXT } from '@/modules/fulfilment/contracts';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY. Stand-in server actions for the B1
 * screens, so the preview states can show what a refusal or a success looks
 * like through the real form path (typed values kept, fields named) without
 * a database. They read nothing, write nothing and return fixed answers; the
 * gallery page itself is a 404 outside the local preview mode.
 */

type Result = BookingActionResult<unknown>;

function refuse(code: keyof typeof ERROR_TEXT): Result {
  return { ok: false, code, message: ERROR_TEXT[code] };
}

async function settle<T>(value: T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  return value;
}

/** Always "invalid input": shows the kept values and the named fields. */
export async function previewRefuseInvalidAction(): Promise<Result> {
  return settle(refuse('invalid_input'));
}

/** Always "someone changed it": shows the conflict text and the reload link. */
export async function previewRefuseConflictAction(): Promise<Result> {
  return settle(refuse('version_changed'));
}

/** Always "on hold": the visa/passport/train refusal. */
export async function previewRefuseOnHoldAction(): Promise<Result> {
  return settle(refuse('service_on_hold'));
}

/** Always "taken by a colleague". */
export async function previewRefuseTaskConflictAction(): Promise<Result> {
  return settle(refuse('task_conflict'));
}

/** Always a saved draft (nothing confirmed). */
export async function previewSavedAction(): Promise<Result> {
  return settle({ ok: true, data: undefined, message: 'Synthetic preview: saved. The draft is not confirmed and nothing is booked.' });
}
