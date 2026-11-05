import 'server-only';
import { FINANCE_ERROR_TEXT, type FinanceErrorCode } from '@/modules/finance/contracts';
import * as financeActions from '@/modules/finance/server/actions';
import type { StaffContext } from '@/modules/identity/server/session';
import type { FinanceAction, FinanceActions } from '@/views/finance-forms';

/**
 * Page-side glue for the Phase 5A Accounts routes. The database decides every
 * read (authz.can_accounts / can_manage_finance_policy); pages only turn a
 * refusal token into an honest screen and pass the server actions to views.
 */

const CODES = Object.keys(FINANCE_ERROR_TEXT) as FinanceErrorCode[];

/** The finance refusal token carried by a thrown loader error, or null for anything unexpected. */
export function financeErrorCode(error: unknown): FinanceErrorCode | null {
  if (!error || typeof error !== 'object') return null;
  const e = error as { code?: unknown; message?: unknown };
  if (typeof e.code === 'string' && (CODES as string[]).includes(e.code)) return e.code as FinanceErrorCode;
  if (typeof e.message === 'string' && (CODES as string[]).includes(e.message)) return e.message as FinanceErrorCode;
  return null;
}

/** Runs a finance read; refusals come back as a token, unexpected errors reach the route error boundary. */
export async function financeRead<T>(read: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: FinanceErrorCode }> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    const code = financeErrorCode(error);
    if (code) return { ok: false, code };
    throw error;
  }
}

/** Entities where the viewer holds the given role, ordered by name, optionally narrowed by ?entity=. */
export function pickEntity(staff: StaffContext, roleCode: string, requested: string | string[] | undefined): string | null {
  const ids = [...new Set(staff.memberships.filter((m) => m.roleCode === roleCode).map((m) => m.legalEntityId))];
  const want = Array.isArray(requested) ? requested[0] : requested;
  if (want && ids.includes(want)) return want;
  return ids[0] ?? null;
}

const optional = financeActions as unknown as { uploadEvidenceAction?: FinanceAction };

export const FINANCE_ACTIONS: FinanceActions = {
  saveBillingAction: financeActions.saveBillingAction,
  verifyBillingAction: financeActions.verifyBillingAction,
  returnReviewAction: financeActions.returnReviewAction,
  approveReviewAction: financeActions.approveReviewAction,
  recordReceiptAction: financeActions.recordReceiptAction,
  verifyReceiptAction: financeActions.verifyReceiptAction,
  rejectReceiptAction: financeActions.rejectReceiptAction,
  clearChequeAction: financeActions.clearChequeAction,
  markChequeAction: financeActions.markChequeAction,
  representChequeAction: financeActions.representChequeAction,
  reverseReceiptAction: financeActions.reverseReceiptAction,
  recordDepositAction: financeActions.recordDepositAction,
  verifyDepositAction: financeActions.verifyDepositAction,
  rejectDepositAction: financeActions.rejectDepositAction,
  recordReconciliationAction: financeActions.recordReconciliationAction,
  verifyReconciliationAction: financeActions.verifyReconciliationAction,
  updatePolicyAction: financeActions.updatePolicyAction,
  uploadEvidenceAction: optional.uploadEvidenceAction,
  submitDestinationAction: financeActions.submitDestinationAction,
  approveDestinationAction: financeActions.approveDestinationAction,
  returnDestinationAction: financeActions.returnDestinationAction,
  retireDestinationAction: financeActions.retireDestinationAction,
  showDestinationDetailAction: financeActions.showDestinationDetailAction,
};
