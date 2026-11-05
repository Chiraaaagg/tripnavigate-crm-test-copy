'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { requireStaff } from '@/modules/identity/server/session';
import { bitrixIdProofCopyRetry, travellerIdProofBegin, travellerIdProofFinish, travellerIdProofRemove } from '../b11-commands';
import { ID_PROOF_FIELD, parseIdProofCopyRetryForm, parseIdProofRemoveForm, parseIdProofUploadForm } from '../b11-forms';
import { asRpcClient, BookingCommandError } from '../commands';
import {
  type BookingActionResult,
  ID_PROOF_BUCKET,
  ID_PROOF_COPY_TEXT,
  ID_PROOF_MAX_BYTES,
  ID_PROOF_TEXT,
  type TravellerIdProofRemoveResult,
  type TravellerIdProofUploadResult,
  UNKNOWN_OUTCOME_TEXT,
} from '../contracts';
import { checkEvidenceFile } from '../evidence';
import { FIELD } from '../forms';
import { fail, failFrom } from './b11-results';

/**
 * B1.2 traveller identity proof (freeze note §2.2; migration 20261120000100):
 * a photo or PDF of an Aadhaar card or another ID, per traveller. Never a
 * typed ID number; never read or extracted, and sent nowhere except the
 * owner-approved copy to the linked Bitrix Deal (DEC-43, worker only). requireStaff()
 * (aal2, active staff); parse (dealId, travellerSeq, requestId and the
 * customer-consent tick, DEC-39; never actor, entity, branch or ownership);
 * refuse without consent before any call; check the file (size, declared type AND
 * magic bytes) before anything is stored; then traveller_id_proof_begin under
 * the staff member's OWN session, which authorizes (booking editors),
 * enforces the per-traveller cap and generates the object path. Only after
 * that does the privileged client upload the bytes to the private bucket;
 * traveller_id_proof_finish records 'stored' only when the object exists
 * with the declared size. Never hashed; never bumps the booking version's
 * row version; allowed after submission.
 */

type Prev<T> = BookingActionResult<T> | null;

function revalidateBook(dealId: string): void {
  revalidatePath(`/app/deals/${dealId}/book`);
  revalidatePath('/app/deals/[id]/book', 'layout'); // the overview, the booking form layout (route group) and its steps
}

function fileName(file: Blob): string {
  return 'name' in file && typeof file.name === 'string' ? file.name : '';
}

/** "Attach identity proof" for one traveller: one file per post (PDF, JPEG, PNG or WebP; at most 4 MiB). */
export async function uploadTravellerIdProofAction(
  _prev: Prev<TravellerIdProofUploadResult>,
  formData: FormData,
): Promise<BookingActionResult<TravellerIdProofUploadResult>> {
  const staff = await requireStaff();
  const parsed = parseIdProofUploadForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const { dealId, travellerSeq, requestId, consent } = parsed.value;
  if (!consent) return fail('consent_required', [ID_PROOF_FIELD.consent]);
  const file = formData.get(FIELD.file);
  if (!(file instanceof Blob) || file.size === 0 || file.size > ID_PROOF_MAX_BYTES) {
    return fail('evidence_rejected', [FIELD.file], ID_PROOF_TEXT.rejected);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkEvidenceFile({ bytes, declaredMime: file.type, fileName: fileName(file) });
  if (!check.ok || check.sizeBytes > ID_PROOF_MAX_BYTES) return fail('evidence_rejected', [FIELD.file], ID_PROOF_TEXT.rejected);

  const rpc = asRpcClient(staff.supabase);
  let begun;
  try {
    begun = await travellerIdProofBegin(rpc, {
      dealId,
      travellerSeq,
      requestId,
      consent: true,
      fileName: check.fileName,
      mime: check.mime,
      sizeBytes: check.sizeBytes,
      sha256: check.sha256,
    });
  } catch (error) {
    const refusal = failFrom(error, { requestId: FIELD.requestId, seq: ID_PROOF_FIELD.travellerSeq, consent: ID_PROOF_FIELD.consent, file: FIELD.file });
    if (!refusal.ok && refusal.code === 'evidence_rejected') return { ...refusal, message: ID_PROOF_TEXT.rejected, fields: [FIELD.file] };
    // not_found here means "no traveller at this seq" (removed or renamed since the page loaded).
    if (!refusal.ok && refusal.code === 'not_found') return { ...refusal, message: ID_PROOF_TEXT.travellerChanged };
    if (!refusal.ok && refusal.code === 'deal_removed') return { ...refusal, message: ID_PROOF_TEXT.dealRemoved };
    return refusal;
  }

  // An exact retry (same request id): never upload or finish twice. The first
  // request owns the upload; a second click must not mark a good upload failed.
  if (begun.outcome === 'existing') {
    revalidateBook(dealId);
    if (begun.status === 'stored') return { ok: true, data: { fileId: begun.fileId, travellerSeq, status: 'stored' }, message: ID_PROOF_TEXT.alreadyUploaded };
    if (begun.status === 'pending_upload') return fail('upload_failed', undefined, ID_PROOF_TEXT.stillUploading);
    if (begun.status === 'removed') return fail('upload_failed', undefined, ID_PROOF_TEXT.travellerChanged);
    return fail('upload_failed');
  }
  if (begun.objectPath === null) return fail('upload_failed', undefined, UNKNOWN_OUTCOME_TEXT);

  // The database authorized the actor and generated the object path: only now the privileged client.
  let stored = false;
  try {
    const upload = await createSupabaseAdminClient()
      .storage.from(ID_PROOF_BUCKET)
      .upload(begun.objectPath, bytes, { contentType: check.mime, upsert: false });
    stored = !upload.error;
  } catch {
    stored = false;
  }
  let status: string | null;
  try {
    status = (await travellerIdProofFinish(rpc, begun.fileId, stored)).status;
  } catch {
    // The finish may have committed; never claim an outcome we did not see.
    status = null;
  }
  revalidateBook(dealId);
  if (status === 'stored') return { ok: true, data: { fileId: begun.fileId, travellerSeq, status: 'stored' }, message: ID_PROOF_TEXT.uploaded };
  if (status === 'failed') return fail('upload_failed');
  return fail('upload_failed', undefined, UNKNOWN_OUTCOME_TEXT);
}

/** "Remove": soft removal of one identity-proof file (its own row version); the stored object is kept. */
export async function removeTravellerIdProofAction(
  _prev: Prev<TravellerIdProofRemoveResult>,
  formData: FormData,
): Promise<BookingActionResult<TravellerIdProofRemoveResult>> {
  const staff = await requireStaff();
  const parsed = parseIdProofRemoveForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const { dealId, fileId, expectedRowVersion } = parsed.value;
  try {
    const result = await travellerIdProofRemove(asRpcClient(staff.supabase), { fileId, expectedRowVersion });
    revalidateBook(dealId);
    return { ok: true, data: result, message: ID_PROOF_TEXT.removed };
  } catch (error) {
    const refusal = failFrom(error, { fileId: ID_PROOF_FIELD.fileId });
    if (!refusal.ok && refusal.code === 'version_changed') revalidateBook(dealId);
    if (!refusal.ok && refusal.code === 'deal_removed') return { ...refusal, message: ID_PROOF_TEXT.dealRemoved };
    return refusal;
  }
}

/**
 * DEC-43 "Try again" for a Bitrix copy that failed or is unclear (booking
 * editors; the database also lets the Super Admin, and keeps copies stopped
 * for lost files, a refused sign-in or needs_manual_check to the Super Admin
 * only). Nothing is sent from here: the job goes back to the worker's queue
 * (a read-back of the Deal first when the outcome was unclear). dealId is
 * optional: the Super Admin's alerts list has none.
 */
export async function retryIdProofCopyAction(
  _prev: Prev<{ jobId: string; status: 'pending' | 'unknown' }>,
  formData: FormData,
): Promise<BookingActionResult<{ jobId: string; status: 'pending' | 'unknown' }>> {
  const staff = await requireStaff();
  const parsed = parseIdProofCopyRetryForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const { dealId, jobId } = parsed.value;
  const refresh = () => (dealId ? revalidateBook(dealId) : revalidatePath('/app', 'layout'));
  try {
    const result = await bitrixIdProofCopyRetry(asRpcClient(staff.supabase), jobId);
    refresh();
    return { ok: true, data: result, message: result.status === 'unknown' ? ID_PROOF_COPY_TEXT.retriedChecking : ID_PROOF_COPY_TEXT.retried };
  } catch (error) {
    if (error instanceof BookingCommandError && error.code === 'wrong_state' && error.hintKeys.includes('switch_off')) {
      return fail('wrong_state', undefined, ID_PROOF_COPY_TEXT.switchOff);
    }
    const refusal = failFrom(error, { jobId: ID_PROOF_FIELD.copyJobId });
    // A booking editor sees a copy only the Super Admin may retry (lost files, refused sign-in).
    if (!refusal.ok && refusal.code === 'not_authorized') return { ...refusal, message: ID_PROOF_COPY_TEXT.askSuperAdmin };
    if (!refusal.ok && refusal.code === 'wrong_state') refresh();
    return refusal;
  }
}
