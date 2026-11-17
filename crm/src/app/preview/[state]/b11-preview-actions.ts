'use server';

import { BOOK_NOW_TEXT, type BookingActionResult, ERROR_TEXT } from '@/modules/fulfilment/contracts';
import type { FinanceActionState } from '@/modules/finance/forms';
import type { PruneFormState, WonOnlyFormState } from '@/modules/integration/server/won-only-actions';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY. Stand-in server actions for the B1.1
 * screens: they read nothing, write nothing and return fixed answers, so the
 * preview states can show refusals (typed values kept, fields named) and
 * successes through the real form path. The gallery page itself is a 404
 * outside local preview mode.
 */

type Result = BookingActionResult<unknown>;

async function settle<T>(value: T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  return value;
}

export async function previewB11SavedAction(): Promise<Result> {
  return settle({ ok: true, data: undefined, message: `Synthetic preview: ${BOOK_NOW_TEXT.savedNothingBooked}` });
}

/** A fix marked with a weaker change type than its changes allow (bookform-revision-refused). */
export async function previewB11ClassificationRefusedAction(): Promise<Result> {
  return settle({ ok: false, code: 'classification_not_allowed', message: '', fields: ['changeClass'] });
}

export async function previewB11ClaimReportedAction(): Promise<FinanceActionState> {
  return settle({ status: 'ok', message: 'Synthetic preview: reported to Accounts. It shows as “Reported by Sales, not verified” until Accounts checks it.' });
}

export async function previewB11ClaimDuplicateAction(): Promise<FinanceActionState> {
  return settle({
    status: 'error',
    code: 'duplicate_claim',
    message: 'This payment reference is already reported on this deal. Check the payments listed below before reporting it again.',
    fieldErrors: { claimReference: 'Already reported on this deal.' },
  });
}

export async function previewB11FinanceRefuseAction(): Promise<FinanceActionState> {
  return settle({
    status: 'error',
    code: 'cash_cap_exceeded',
    message: 'Synthetic preview: cash above the policy limit for this payer today is refused. Nothing was recorded.',
    fieldErrors: { amountRupees: 'Above the cash limit.' },
  });
}

export async function previewB11FinanceOkAction(): Promise<FinanceActionState> {
  return settle({ status: 'ok', message: 'Synthetic preview: done. Nothing real was recorded.' });
}

export async function previewB11TaskConflictAction(): Promise<Result> {
  return settle({ ok: false, code: 'task_conflict', message: 'Another colleague has already taken this task.' });
}

export async function previewB11DocumentsNotCheckedAction(): Promise<Result> {
  return settle({ ok: false, code: 'documents_not_checked', message: ERROR_TEXT.documents_not_checked });
}

export async function previewB11OutcomeDocumentAction(): Promise<Result> {
  return settle({ ok: false, code: 'outcome_document_required', message: ERROR_TEXT.outcome_document_required });
}

export async function previewB11OverLimitAction(): Promise<Result> {
  return settle({ ok: false, code: 'direct_payment_over_limit', message: ERROR_TEXT.direct_payment_over_limit, fields: ['amountRupees'] });
}

export async function previewB11WonOnlySavedAction(): Promise<WonOnlyFormState> {
  return settle({ status: 'success', message: 'Synthetic preview: saved. Nothing real changed.' });
}

export async function previewB11PruneDryRunAction(): Promise<PruneFormState> {
  return settle({
    status: 'success',
    message: 'Synthetic preview: dry run only, nothing changed: 24 Deals would be removed, 2 Deals kept because they have CRM work, 1 Deal kept while a sync is waiting.',
    result: {
      dryRun: true,
      entryStageIds: ['UC_AD0SLH'],
      storedActive: 31,
      atEntryStage: 4,
      pruned: { count: 24, deals: [{ id: '00000000-0000-4000-8000-000000000101', reference: 'SYN-DEL-101', stageId: 'NEW' }] },
      keptWithWork: { count: 2, byKind: { booking_version: ['00000000-0000-4000-8000-000000000102'] }, deals: [{ id: '00000000-0000-4000-8000-000000000102', reference: 'SYN-JOD-102', stageId: 'PREPARATION', work: ['booking_version', 'claim'] }] },
      keptSyncPending: { count: 1, deals: [{ id: '00000000-0000-4000-8000-000000000103', reference: 'SYN-AHM-103', stageId: 'NEW' }] },
      truncated: false,
    },
  });
}

// B1.2 traveller identity proof (gallery only).

export async function previewB12IdProofUploadedAction(): Promise<Result> {
  return settle({ ok: true, data: undefined, message: 'Synthetic preview: identity proof attached. Only the people who need it can open it.' });
}

export async function previewB12IdProofRejectedAction(): Promise<Result> {
  return settle({ ok: false, code: 'evidence_rejected', message: 'File not accepted: PDF, JPG, PNG or WebP up to 4 MB.', fields: ['file'] });
}

export async function previewB12IdProofRemovedAction(): Promise<Result> {
  return settle({ ok: true, data: undefined, message: 'Synthetic preview: identity proof removed for this traveller.' });
}
