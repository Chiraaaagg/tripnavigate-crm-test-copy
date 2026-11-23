import 'server-only';
import { revalidatePath } from 'next/cache';
import { VisaCommandError } from '../commands';
import {
  type VisaActionResult,
  type VisaErrorCode,
  type VisaFailureCode,
  VISA_DONE_TEXT,
  VISA_ERROR_TEXT,
  VISA_UNKNOWN_OUTCOME_TEXT,
  visaNotReadyText,
} from '../contracts';
import { notReadyTokenFromHint, visaFieldsFromHint } from '../forms';

/**
 * Result helpers of the Visa actions. Refusals carry the frozen wording of
 * section 6.1 and the screen fields named by the database hint (never
 * database text). A failure the database did not explain is rethrown as
 * VISA_UNKNOWN_OUTCOME_TEXT because the command may have committed.
 */

type Failure = Extract<VisaActionResult<never>, { ok: false }>;

export function fail(code: VisaFailureCode, fields?: string[], message?: string): Failure {
  const unique = fields?.length ? [...new Set(fields)] : undefined;
  return unique ? { ok: false, code, message: message ?? VISA_ERROR_TEXT[code], fields: unique } : { ok: false, code, message: message ?? VISA_ERROR_TEXT[code] };
}

export function failFrom(error: unknown): Failure {
  if (error instanceof VisaCommandError && error.code) {
    const fields = visaFieldsFromHint(error.hintKeys);
    if (error.code === 'not_ready') return fail('not_ready', fields, visaNotReadyText(notReadyTokenFromHint(error.hintKeys)));
    return fail(error.code, fields);
  }
  throw new Error(VISA_UNKNOWN_OUTCOME_TEXT);
}

export function isVisaCode(error: unknown, ...codes: VisaErrorCode[]): boolean {
  return error instanceof VisaCommandError && error.code !== null && error.code !== 'session' && codes.includes(error.code);
}

/** Success text plus "This passenger is closed." / "…the task is completed." when that happened. */
export function withClosure(base: string, closed: boolean, taskCompleted: boolean): string {
  if (taskCompleted) return `${base}${VISA_DONE_TEXT.completedSuffix}`;
  if (closed) return `${base}${VISA_DONE_TEXT.closedSuffix}`;
  return base;
}

/** Every page that shows a visa task: queue, task page, the Deal page, Home (and Accounts for fees). */
export function revalidateVisa(taskId: string | null, dealId: string | null, opts: { accounts?: boolean } = {}): void {
  revalidatePath('/app/visa');
  if (taskId) revalidatePath(`/app/visa/${taskId}`);
  else revalidatePath('/app/visa/[taskId]', 'page');
  if (dealId) revalidatePath(`/app/deals/${dealId}`);
  else revalidatePath('/app/deals/[id]', 'page');
  revalidatePath('/app');
  if (opts.accounts) revalidatePath('/app/accounts/expenses');
}
