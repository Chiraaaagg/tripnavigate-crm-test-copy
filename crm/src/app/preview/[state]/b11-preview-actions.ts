'use server';

import { BOOK_NOW_TEXT, type BookingActionResult, ERROR_TEXT } from '@/modules/fulfilment/contracts';
import type { FinanceActionState } from '@/modules/finance/forms';
import type { PruneFormState, WonOnlyFormState } from '@/modules/integration/server/won-only-actions';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY. Stand-in server actions for the B1.1
 * screens: they read nothing, write nothing and return fixed answers, so the
 * preview states can show refusals (typed values kept, fields named), the
 * "someone saved first" conflict, a failed upload and successes through the
 * real form path. The gallery page itself is a 404 outside local preview mode.
 */

type Result = BookingActionResult<unknown>;

async function settle<T>(value: T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  return value;
}

function invalid(fields: string[]): Result {
  return { ok: false, code: 'invalid_input', message: ERROR_TEXT.invalid_input, fields };
}

export async function previewB11SavedAction(): Promise<Result> {
  return settle({ ok: true, data: undefined, message: `Synthetic preview: ${BOOK_NOW_TEXT.savedNothingBooked}` });
}

export async function previewB11RefuseCustomerAction(): Promise<Result> {
  return settle(invalid(['mobile', 'postalCode', 'gstin']));
}

export async function previewB11RefuseTripAction(): Promise<Result> {
  return settle(invalid(['tripEnd', 'travellerName[1]']));
}

export async function previewB11RefuseServiceAction(): Promise<Result> {
  return settle(invalid(['checkOut', 'childAges']));
}

export async function previewB11RefusePriceAction(): Promise<Result> {
  return settle(invalid(['sellingTotalRupees']));
}

export async function previewB11RefusePlanAction(): Promise<Result> {
  return settle(invalid(['instalmentAmountRupees[1]']));
}

export async function previewB11ConflictAction(): Promise<Result> {
  return settle({
    ok: false,
    code: 'version_changed',
    message: '',
    conflict: { savedByName: 'Synthetic Manager Delhi', savedAt: '2026-10-11T08:32:00.000Z' },
  });
}

export async function previewB11UploadFailedAction(): Promise<Result> {
  return settle({ ok: false, code: 'upload_failed', message: ERROR_TEXT.upload_failed });
}

export async function previewB11NotReadyAction(): Promise<Result> {
  return settle({ ok: false, code: 'not_ready', message: ERROR_TEXT.not_ready, issues: ['plan_total_mismatch'] });
}

export async function previewB11ClassificationRefusedAction(): Promise<Result> {
  return settle({ ok: false, code: 'classification_not_allowed', message: ERROR_TEXT.classification_not_allowed, fields: ['changeClass'] });
}

export async function previewB11RevisionNotAllowedAction(): Promise<Result> {
  return settle({ ok: false, code: 'revision_not_allowed', message: ERROR_TEXT.revision_not_allowed });
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

// B1.2 row-version chain check (gallery only, Echo D4-1), stateless so parallel workers cannot
// interfere. The b12-book-chain view is at row version 7. The first section's save accepts its
// base and returns base + 1; the second section's save behaves like the database: it is refused
// as version_changed unless it posts 8, the row version the first save returned.
export async function previewB12ChainFirstAction(_prev: unknown, formData: FormData): Promise<Result> {
  const posted = Number(formData.get('rowVersion'));
  return settle({ ok: true, data: { rowVersion: posted + 1, contentHash: `hash-${posted + 1}` }, message: `Synthetic preview: saved at row version ${posted + 1}.` });
}

export async function previewB12ChainSecondAction(_prev: unknown, formData: FormData): Promise<Result> {
  const posted = Number(formData.get('rowVersion'));
  if (posted !== 8) return settle({ ok: false, code: 'version_changed', message: '' });
  return settle({ ok: true, data: { rowVersion: 9, contentHash: 'hash-9' }, message: 'Synthetic preview: saved at row version 9.' });
}

/** Batch 2: "Fill empty fields from Bitrix" that skipped every field (ok, empty list): the screen says nothing was filled and why. */
export async function previewB2FillEmptyNothingAction(): Promise<Result> {
  return settle({ ok: true, data: { rowVersion: 8, filled: [], skipped: [{ field: 'contacts.email', reason: 'no_value' }, { field: 'trip.start', reason: 'cleared_by_staff' }] }, message: 'Filled from Bitrix: .' });
}
