'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { companyGstinMissingText, splitCompanyGstinPlaceholders } from '@/modules/documents/company-identity';
import { itineraryToEngine } from '@/modules/documents/itinerary-adapter';
import { checkCustomerText } from '@/modules/documents/server/check-customer-text';
import { basisValueAt, computeItineraryDifferences, loadItineraryDocumentView } from '@/modules/documents/server/itinerary';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { requireStaff } from '@/modules/identity/server/session';
import {
  itineraryDifferenceAcknowledge,
  itineraryDifferencesSave,
  itineraryDocumentCreate,
  itineraryDocumentGet,
  itineraryFactsMarkReady,
  itineraryFactsSave,
  itineraryRenderRequest,
  itinerarySourceBegin,
  itinerarySourceFinish,
  itinerarySourceRemove,
} from '../commands';
import {
  DOCUMENT_BLOCK_TEXT,
  ITINERARY_ERROR_TEXT,
  ITINERARY_TEMPLATE_VERSION,
  ITINERARY_TEXT,
  KEEP_ITINERARY_NOTE,
  SOURCE_BUCKET,
  SOURCE_MAX_BYTES,
  type ItineraryActionResult,
  type ItineraryCreateResult,
  type ItineraryDifferencesResult,
  type ItineraryFactsSaveResult,
  type ItineraryRenderResult,
} from '../contracts';
import { checkSourceFile, stableHash } from '../files';
import {
  factsCustomerText,
  IFIELD,
  parseAcknowledgeForm,
  parseCreateItineraryForm,
  parseDocumentForm,
  parseDraftRowForm,
  parseItineraryFactsForm,
  parseRenderForm,
  parseSourceRemoveForm,
  parseUseBasisForm,
} from '../forms';
import { applyBasisValue } from '../apply-basis';
import { ifail, ifailFrom, UNKNOWN_ITINERARY_OUTCOME } from './results';

/**
 * Branded itinerary actions (Phase F). Every action: requireStaff(); parse
 * (frozen IFIELD names; never actor, entity, branch or owner); one database
 * command under the staff member's own session (Atlas 0500 authorizes:
 * the quotation's or Deal's editors only). Source files: size, declared
 * type and bytes checked first; Storage only after itinerary_source_begin;
 * never sent outside, never extracted. Facts: customer text checked with
 * Nova's save-time scan before saving. Differences: computed by Nova's
 * documents code, stored by itinerary_differences_save. Render requests:
 * the input hash comes from Nova's adapter; the document maker is not
 * built yet, so jobs wait (status says so).
 */

type Prev<T> = ItineraryActionResult<T> | null;

function revalidateItineraries(): void {
  revalidatePath('/app/itineraries', 'layout');
  revalidatePath('/app/quotations', 'layout');
  revalidatePath('/app/deals/[id]', 'page');
}

/** "Make branded itinerary" from a quotation or a Deal. */
export async function createItineraryAction(_prev: Prev<ItineraryCreateResult>, formData: FormData): Promise<ItineraryActionResult<ItineraryCreateResult>> {
  const staff = await requireStaff();
  const parsed = parseCreateItineraryForm(formData);
  if (!parsed.ok) return ifail('invalid_input', parsed.fields);
  try {
    const result = await itineraryDocumentCreate(asRpcClient(staff.supabase), parsed.value);
    revalidateItineraries();
    return { ok: true, data: result, message: ITINERARY_TEXT.created };
  } catch (error) {
    return ifailFrom(error);
  }
}

/** Attach the existing itinerary (or another source file) privately. */
export async function uploadItinerarySourceAction(_prev: Prev<{ fileId: string }>, formData: FormData): Promise<ItineraryActionResult<{ fileId: string }>> {
  const staff = await requireStaff();
  const parsed = parseDocumentForm(formData);
  if (!parsed.ok) return ifail('invalid_input', parsed.fields);
  const file = formData.get(IFIELD.file);
  if (!(file instanceof Blob) || file.size === 0 || file.size > SOURCE_MAX_BYTES) return ifail('evidence_rejected', [IFIELD.file]);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkSourceFile({ bytes, declaredMime: file.type, fileName: 'name' in file && typeof file.name === 'string' ? file.name : '' });
  if (!check.ok) return ifail('evidence_rejected', [IFIELD.file]);

  const rpc = asRpcClient(staff.supabase);
  let begun;
  try {
    begun = await itinerarySourceBegin(rpc, { documentId: parsed.value.documentId, fileName: check.fileName, mime: check.mime, sizeBytes: check.sizeBytes, sha256: check.sha256 });
  } catch (error) {
    const refusal = ifailFrom(error);
    return !refusal.ok && refusal.code === 'evidence_rejected' ? { ...refusal, fields: [IFIELD.file] } : refusal;
  }
  // The database authorized the actor and generated the object path: only now the privileged client.
  let stored = false;
  try {
    const upload = await createSupabaseAdminClient().storage.from(SOURCE_BUCKET).upload(begun.objectPath, bytes, { contentType: check.mime, upsert: false });
    stored = !upload.error;
  } catch {
    stored = false;
  }
  let status: string | null;
  try {
    status = (await itinerarySourceFinish(rpc, begun.fileId, stored)).status;
  } catch {
    status = null;
  }
  revalidateItineraries();
  if (status === 'stored') return { ok: true, data: { fileId: begun.fileId }, message: ITINERARY_TEXT.sourceUploaded };
  if (status === 'failed') return ifail('upload_failed');
  return ifail('upload_failed', undefined, UNKNOWN_ITINERARY_OUTCOME);
}

export async function removeItinerarySourceAction(_prev: Prev<{ fileId: string }>, formData: FormData): Promise<ItineraryActionResult<{ fileId: string }>> {
  const staff = await requireStaff();
  const parsed = parseSourceRemoveForm(formData);
  if (!parsed.ok) return ifail('invalid_input', parsed.fields);
  try {
    const result = await itinerarySourceRemove(asRpcClient(staff.supabase), parsed.value.fileId);
    revalidateItineraries();
    return { ok: true, data: { fileId: result.fileId }, message: ITINERARY_TEXT.sourceRemoved };
  } catch (error) {
    return ifailFrom(error);
  }
}

/** Save the whole facts draft (full replace; a ready draft returns to draft). Customer text is scanned first. */
export async function saveItineraryFactsAction(_prev: Prev<ItineraryFactsSaveResult>, formData: FormData): Promise<ItineraryActionResult<ItineraryFactsSaveResult>> {
  const staff = await requireStaff();
  const parsed = parseItineraryFactsForm(formData);
  if (!parsed.ok) return ifail('invalid_input', parsed.fields);
  const v = parsed.value;
  const unsafe = factsCustomerText(v.facts).filter((t) => !checkCustomerText({ t: t.text }).ok).map((t) => t.field);
  if (unsafe.length > 0) return ifail('internal_wording', unsafe);
  try {
    const result = await itineraryFactsSave(asRpcClient(staff.supabase), { draftId: v.draftId, expectedRowVersion: v.expectedRowVersion, facts: v.facts, sourceFileId: v.sourceFileId });
    revalidateItineraries();
    return { ok: true, data: result, message: ITINERARY_TEXT.factsSaved };
  } catch (error) {
    return ifailFrom(error);
  }
}

/**
 * "Check differences": Nova computes the differences of the current facts
 * against the current basis (quotation or booking); the database stores them
 * bound to the facts hash and the basis hash. basis_changed → check again.
 */
type Staff = Awaited<ReturnType<typeof requireStaff>>;

/** Nova computes against the current basis; the database stores exactly that (bound to facts hash + basis hash). */
async function recheck(staff: Staff, documentId: string): Promise<ItineraryActionResult<ItineraryDifferencesResult>> {
  const computed = await computeItineraryDifferences(staff, documentId);
  if (computed.status === 'not_found') return ifail('not_found');
  if (computed.status === 'basis_changed') return ifail('basis_changed');
  if (computed.status !== 'ok') throw new Error('Could not compare the itinerary. Please retry.');
  try {
    const result = await itineraryDifferencesSave(asRpcClient(staff.supabase), {
      draftId: computed.draftId,
      expectedRowVersion: computed.rowVersion,
      basisKind: computed.basisKind,
      basisId: computed.basisId,
      basisHash: computed.basisHash,
      differences: computed.differences,
    });
    revalidateItineraries();
    const n = result.differenceCount;
    const message = n === 0 ? ITINERARY_TEXT.differencesNone : ITINERARY_TEXT.differencesFound.replace('{count}', String(n)).replace('{noun}', n === 1 ? 'difference' : 'differences');
    return { ok: true, data: result, message };
  } catch (error) {
    return ifailFrom(error);
  }
}

export async function checkItineraryDifferencesAction(_prev: Prev<ItineraryDifferencesResult>, formData: FormData): Promise<ItineraryActionResult<ItineraryDifferencesResult>> {
  const staff = await requireStaff();
  const parsed = parseDocumentForm(formData);
  if (!parsed.ok) return ifail('invalid_input', parsed.fields);
  return recheck(staff, parsed.value.documentId);
}

/**
 * "Use the quotation or booking value" for one difference: recompute on the
 * server (Nova; the basis value lives only in memory), write that value into
 * the facts (itinerary_facts_save, bound to the draft's row version; the
 * changed path is marked as coming from the quotation or booking), then check
 * the differences again. Nothing is taken from the browser but the path and
 * kind that name the difference.
 */
export async function useItineraryBasisValueAction(_prev: Prev<ItineraryDifferencesResult>, formData: FormData): Promise<ItineraryActionResult<ItineraryDifferencesResult>> {
  const staff = await requireStaff();
  const parsed = parseUseBasisForm(formData);
  if (!parsed.ok) return ifail('invalid_input', parsed.fields);
  const { documentId, path, kind } = parsed.value;
  const computed = await computeItineraryDifferences(staff, documentId);
  if (computed.status === 'not_found') return ifail('not_found');
  if (computed.status === 'basis_changed') return ifail('basis_changed');
  if (computed.status !== 'ok') throw new Error('Could not compare the itinerary. Please retry.');
  const diff = computed.differences.find((d) => d.path === path && d.kind === kind);
  if (!diff || computed.basisKind === 'none') return ifail('basis_value_unavailable');
  const rpc = asRpcClient(staff.supabase);
  let current;
  try {
    current = await itineraryDocumentGet(rpc, documentId);
  } catch (error) {
    return ifailFrom(error);
  }
  if (!current) return ifail('not_found');
  if (current.draft.rowVersion !== computed.rowVersion) return ifail('version_changed');
  const applied = applyBasisValue(current.draft.facts, diff, basisValueAt(computed, diff));
  if (!applied) return ifail('basis_value_unavailable');
  const origin = computed.basisKind === 'booking_version' ? 'booking' : 'quotation';
  const facts = applied.provenancePath ? { ...applied.facts, provenance: { ...applied.facts.provenance, [applied.provenancePath]: origin } as typeof applied.facts.provenance } : applied.facts;
  const unsafe = factsCustomerText(facts).filter((t) => !checkCustomerText({ t: t.text }).ok).map((t) => t.field);
  if (unsafe.length > 0) return ifail('internal_wording', unsafe);
  try {
    await itineraryFactsSave(rpc, { draftId: current.draft.draftId, expectedRowVersion: current.draft.rowVersion, facts, sourceFileId: current.draft.sourceFileId });
  } catch (error) {
    return ifailFrom(error);
  }
  const rechecked = await recheck(staff, documentId);
  return rechecked.ok ? { ...rechecked, message: ITINERARY_TEXT.basisValueUsed } : rechecked;
}

/** Settle one difference: keep the itinerary value (optional note) or keep it with a note. "Use the quotation value" is an edit of the facts, not this. */
export async function acknowledgeItineraryDifferenceAction(_prev: Prev<{ differenceId: string }>, formData: FormData): Promise<ItineraryActionResult<{ differenceId: string }>> {
  const staff = await requireStaff();
  if (String(formData.get(IFIELD.choice) ?? '') === 'use_basis') return ifail('invalid_input', [IFIELD.choice], ITINERARY_TEXT.useBasisHint);
  const parsed = parseAcknowledgeForm(formData);
  if (!parsed.ok) return ifail('invalid_input', parsed.fields);
  const v = parsed.value;
  const note = v.choice === 'keep_itinerary' ? (v.note ? `${KEEP_ITINERARY_NOTE} ${v.note}`.slice(0, 500) : KEEP_ITINERARY_NOTE) : v.note;
  try {
    const result = await itineraryDifferenceAcknowledge(asRpcClient(staff.supabase), { differenceId: v.differenceId, note });
    revalidateItineraries();
    return { ok: true, data: { differenceId: result.differenceId }, message: ITINERARY_TEXT.acknowledged };
  } catch (error) {
    return ifailFrom(error);
  }
}

/** "Facts ready": needs a current difference check with nothing open. */
export async function markItineraryReadyAction(_prev: Prev<{ rowVersion: number }>, formData: FormData): Promise<ItineraryActionResult<{ rowVersion: number }>> {
  const staff = await requireStaff();
  const parsed = parseDraftRowForm(formData);
  if (!parsed.ok) return ifail('invalid_input', parsed.fields);
  try {
    const result = await itineraryFactsMarkReady(asRpcClient(staff.supabase), { draftId: parsed.value.draftId, expectedRowVersion: parsed.value.expectedRowVersion });
    revalidateItineraries();
    return { ok: true, data: result, message: ITINERARY_TEXT.markedReady };
  } catch (error) {
    return ifailFrom(error);
  }
}

/**
 * Request a preview or the final document. Nova's adapter builds the
 * document input from the current facts; its hash binds the job (the same
 * input is never made twice). A final document needs a clean input (no
 * placeholders, no refusal); a preview may show placeholders. The document
 * maker is not built yet: the job waits and the screen says so.
 */
export async function requestItineraryRenderAction(_prev: Prev<ItineraryRenderResult>, formData: FormData): Promise<ItineraryActionResult<ItineraryRenderResult>> {
  const staff = await requireStaff();
  const parsed = parseRenderForm(formData);
  if (!parsed.ok) return ifail('invalid_input', parsed.fields);
  const { documentId, kind } = parsed.value;
  const loaded = await loadItineraryDocumentView(staff, documentId);
  if (loaded.status === 'not_found') return ifail('not_found');
  if (loaded.status !== 'ok') throw new Error('Could not prepare the itinerary. Please retry.');
  const adapted = itineraryToEngine(loaded.view);
  if (!adapted.ok) {
    const blocks = [...new Set(adapted.refusals.map((r) => DOCUMENT_BLOCK_TEXT[r.code] ?? DOCUMENT_BLOCK_TEXT.dates_invalid!))];
    return { ok: false, code: 'document_blocked', message: ITINERARY_ERROR_TEXT.document_blocked, blocks };
  }
  if (kind === 'final' && adapted.placeholders.length > 0) {
    // DEC-50 review: a missing company GSTIN is said plainly (Accounts' data, nothing for staff to fill in).
    const { gstinBranches, others } = splitCompanyGstinPlaceholders(adapted.placeholders);
    const blocks = [...gstinBranches.map(companyGstinMissingText), ...(others.length ? [DOCUMENT_BLOCK_TEXT.placeholders!] : [])];
    return { ok: false, code: 'document_blocked', message: ITINERARY_ERROR_TEXT.document_blocked, blocks };
  }
  try {
    const result = await itineraryRenderRequest(asRpcClient(staff.supabase), { documentId, kind, inputHash: stableHash(adapted.input), templateVersion: ITINERARY_TEMPLATE_VERSION });
    revalidateItineraries();
    return { ok: true, data: result, message: result.outcome === 'existing' ? ITINERARY_TEXT.renderExisting : ITINERARY_TEXT.renderRequested };
  } catch (error) {
    return ifailFrom(error);
  }
}
