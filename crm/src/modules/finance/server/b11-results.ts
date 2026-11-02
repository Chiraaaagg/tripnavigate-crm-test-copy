import 'server-only';
import { FinanceCommandError } from '../commands';
import { CLAIM_ERROR_TEXT, FINANCE_ERROR_TEXT, type FinanceCommandResult, type FinanceErrorCode } from '../contracts';
import type { FieldErrors, FinanceActionState } from '../forms';

/**
 * Result helpers for the B1.1 finance actions (claims and expense records).
 * Same rules as actions.ts: refusals map to plain wording by token; an
 * unexplained failure is rethrown without detail because the command may
 * have committed (the form shows "reload to check").
 */

// G-05
export const UNKNOWN_OUTCOME = 'We could not confirm this was saved. Reload the page to check before you try again. Your typed details are still here.';
export const SESSION_TEXT = 'Your session has ended. Sign in again, then retry.';
/** Same wording as finance actions.ts: which cash cap refused (DETAIL payer_day | trip). */
export const CAP_TEXT = {
  payer_day: 'This cash amount is over the company cash limit for this payer today (all branches). Ask for a bank transfer, UPI or cheque instead.',
  trip: 'This cash amount is over the company cash limit for this trip. Ask for a bank transfer, UPI or cheque instead.',
} as const;

export function invalid(fieldErrors: FieldErrors): FinanceActionState {
  const { _form, ...rest } = fieldErrors;
  return {
    status: 'error',
    code: 'invalid_input',
    message: _form ?? FINANCE_ERROR_TEXT.invalid_input,
    fieldErrors: Object.keys(rest).length > 0 ? rest : undefined,
  };
}

/** Wording for a refusal; `context` 'claim' uses the claim overrides (wrong_state, not_self_approval). */
export function refusalText(code: FinanceErrorCode, context: 'claim' | 'expense' | 'receipt'): string {
  if (context === 'claim' && CLAIM_ERROR_TEXT[code]) return CLAIM_ERROR_TEXT[code]!;
  if (context === 'expense' && code === 'wrong_state') return 'This expense record was already reviewed. Reload the page.';
  if (context === 'expense' && code === 'not_self_approval') return 'You recorded or sent this cost, or you sell this deal, so another Accounts person must review it.';
  return FINANCE_ERROR_TEXT[code];
}

export function refused(error: unknown, context: 'claim' | 'expense' | 'receipt'): FinanceActionState {
  if (error instanceof FinanceCommandError) {
    if (error.code === 'session') return { status: 'error', code: 'session', message: SESSION_TEXT };
    if (error.code === 'cash_cap_exceeded') {
      return { status: 'error', code: error.code, message: error.capKind ? CAP_TEXT[error.capKind] : FINANCE_ERROR_TEXT.cash_cap_exceeded };
    }
    if (error.code) return { status: 'error', code: error.code, message: refusalText(error.code, context) };
  }
  throw new Error(UNKNOWN_OUTCOME);
}

export function done(message: string, result?: FinanceCommandResult): FinanceActionState {
  const replay = result?.outcome === 'existing' ? ' (already recorded; nothing changed)' : '';
  return { status: 'ok', message: `${message}${replay}` };
}
