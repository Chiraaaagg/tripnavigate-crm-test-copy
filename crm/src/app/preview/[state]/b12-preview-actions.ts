'use server';

import { B12_SWITCH_TEXT, ID_PROOF_COPY_TEXT, PREFILL_TEXT } from '@/modules/fulfilment/contracts';
import { ITINERARY_ERROR_TEXT, ITINERARY_TEXT } from '@/modules/itineraries/contracts';
import { QUOTATION_ERROR_TEXT, QUOTATION_TEXT, type QuotationActionResult } from '@/modules/quotations/contracts';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY. Stand-in quotation actions: they read
 * nothing, write nothing and return fixed answers, so the preview states show
 * refusals (typed values kept, fields named, blocking issues listed) and
 * successes through the real form path. The gallery is a 404 outside local
 * preview mode.
 */

type Result = QuotationActionResult<unknown>;

async function settle<T>(value: T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  return value;
}

export async function previewQuoteSavedAction(): Promise<Result> {
  return settle({ ok: true, data: { rowVersion: 5 }, message: `Synthetic preview: ${QUOTATION_TEXT.saved}` });
}

export async function previewQuoteRefuseDetailsAction(): Promise<Result> {
  return settle({ ok: false, code: 'invalid_input', message: QUOTATION_ERROR_TEXT.invalid_input, fields: ['tripEnd', 'adults'] });
}

export async function previewQuoteRefuseTitleAction(): Promise<Result> {
  return settle({ ok: false, code: 'invalid_input', message: QUOTATION_ERROR_TEXT.invalid_input, fields: ['title'] });
}

export async function previewQuoteNotReadyAction(): Promise<Result> {
  return settle({ ok: false, code: 'not_ready', message: QUOTATION_ERROR_TEXT.not_ready, issues: ['contact_missing', 'quoted_total_missing'] });
}

export async function previewQuoteConflictAction(): Promise<Result> {
  return settle({ ok: false, code: 'version_changed', message: QUOTATION_ERROR_TEXT.version_changed });
}

export async function previewQuoteDraftNotEmptyAction(): Promise<Result> {
  return settle({ ok: false, code: 'draft_not_empty', message: QUOTATION_ERROR_TEXT.draft_not_empty });
}

export async function previewQuoteProofRequiredAction(): Promise<Result> {
  return settle({ ok: false, code: 'acceptance_proof_required', message: QUOTATION_ERROR_TEXT.acceptance_proof_required });
}

export async function previewQuoteInternalWordingAction(): Promise<Result> {
  return settle({ ok: false, code: 'internal_wording', message: QUOTATION_ERROR_TEXT.internal_wording, fields: ['dayTitle[0]', 'include'] });
}

export async function previewPrefillUsedAction(): Promise<Result> {
  return settle({ ok: true, data: { rowVersion: 5, applied: ['contacts.mobile'], skipped: [] }, message: `Synthetic preview: ${PREFILL_TEXT.applied.replace('{fields}', 'Contact mobile')}` });
}

export async function previewPrefillCheckedAction(): Promise<Result> {
  return settle({ ok: true, data: { checked: ['contacts.contactName'] }, message: `Synthetic preview: ${PREFILL_TEXT.checked.replace('{fields}', 'Contact name')}` });
}

// Itineraries (Phase F)
export async function previewItinSavedAction(): Promise<Result> {
  return settle({ ok: true, data: { rowVersion: 8, factsHash: 'h' }, message: `Synthetic preview: ${ITINERARY_TEXT.factsSaved}` });
}

export async function previewItinInternalWordingAction(): Promise<Result> {
  return settle({ ok: false, code: 'internal_wording', message: ITINERARY_ERROR_TEXT.internal_wording, fields: ['dayTitle[0]'] });
}

export async function previewItinCheckedAction(): Promise<Result> {
  return settle({ ok: true, data: { runId: 'r', differenceCount: 2, openCount: 2, outcome: 'created' }, message: `Synthetic preview: ${ITINERARY_TEXT.differencesFound.replace('{count}', '2').replace('{noun}', 'differences')}` });
}

export async function previewItinBasisUnavailableAction(): Promise<Result> {
  return settle({ ok: false, code: 'basis_value_unavailable', message: ITINERARY_ERROR_TEXT.basis_value_unavailable } as unknown as Result);
}

export async function previewItinAcknowledgedAction(): Promise<Result> {
  return settle({ ok: true, data: { differenceId: 'd' }, message: `Synthetic preview: ${ITINERARY_TEXT.acknowledged}` });
}

export async function previewItinRenderAction(): Promise<Result> {
  return settle({ ok: true, data: { jobId: 'j', status: 'queued', outcome: 'created' }, message: `Synthetic preview: ${ITINERARY_TEXT.renderRequested}` });
}

export async function previewItinNotReadyAction(): Promise<Result> {
  return settle({ ok: false, code: 'not_ready', message: ITINERARY_ERROR_TEXT.not_ready, issues: ['days_missing'] } as unknown as Result);
}

// DEC-43 Bitrix copy of ID proofs
export async function previewCopyRetriedAction(): Promise<Result> {
  return settle({ ok: true, data: { jobId: 'j', status: 'pending' }, message: `Synthetic preview: ${ID_PROOF_COPY_TEXT.retried}` } as unknown as Result);
}

// B1.2 switches (Workflow page)
export async function previewB12SwitchSavedAction(): Promise<Result> {
  return settle({ ok: true, data: { key: 'bitrix_id_proof_copy', changed: true, on: true }, message: `Synthetic preview: ${B12_SWITCH_TEXT.bitrix_id_proof_copy.onNote}` } as unknown as Result);
}

export async function previewB12SwitchRefusedAction(): Promise<Result> {
  return settle({ ok: false, code: 'invalid_input', message: 'Some details are missing or not valid. Check the highlighted fields.', fields: ['reason'] } as unknown as Result);
}
