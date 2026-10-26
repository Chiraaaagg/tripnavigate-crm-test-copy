'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { requireStaff } from '@/modules/identity/server/session';
import {
  asRpcClient,
  beginEvidence,
  BookingCommandError,
  bookingPanel,
  claimPurchaseTask,
  confirmBooking,
  finishEvidence,
  openDraft,
  readiness,
  removeEvidence,
  type RpcClient,
  saveDraft,
} from '../commands';
import {
  type BookingActionResult,
  type BookingErrorCode,
  type ClaimTaskResult,
  CONFIRM_SUCCESS_TEXT,
  type ConfirmBookingResult,
  ERROR_TEXT,
  EVIDENCE_BUCKET,
  EVIDENCE_MAX_BYTES,
  type EvidenceStatus,
  type OpenDraftResult,
  type SaveDraftResult,
  UNKNOWN_OUTCOME_TEXT,
} from '../contracts';
import { checkEvidenceFile } from '../evidence';
import { FIELD, parseSaveDraftForm, readContentHash, readEvidenceKind, readUuid } from '../forms';

/**
 * Booking and Purchase task commands (contract §7–§8). Every action:
 *   1. requireStaff(): verified aal2 session, active staff (redirects otherwise).
 *   2. Parses the form; never reads actor, entity, branch or ownership from it.
 *   3. Runs the database command under the staff member's OWN session; the
 *      database authorizes, audits and decides.
 *   4. Only uploads use the privileged client, for Storage, and only after
 *      booking_begin_evidence authorized the actor and generated the path.
 * Results carry frozen ERROR_TEXT wording; database messages never reach the
 * browser, and nothing here logs file contents, URLs or amounts.
 *
 * Signatures fit useActionState: (previous result | null, FormData).
 */

type Prev<T> = BookingActionResult<T> | null;

const dealPath = (dealId: string) => `/app/deals/${dealId}`;
/** B1: the intake screen shows the same proof list, so evidence changes refresh it too. */
const intakePath = (dealId: string) => `/app/deals/${dealId}/intake`;
const PURCHASE_PATH = '/app/purchase';

function fail(code: BookingErrorCode | 'upload_failed' | 'session'): BookingActionResult<never> {
  return { ok: false, code, message: ERROR_TEXT[code] };
}

/**
 * A result whose outcome is unknown (the command may have committed). The
 * frozen result type has no dedicated code, so the closest code is kept and
 * the message is UNKNOWN_OUTCOME_TEXT (contract §12 A4 M4/L5).
 */
function unknownOutcome(code: BookingErrorCode | 'upload_failed'): BookingActionResult<never> {
  return { ok: false, code, message: UNKNOWN_OUTCOME_TEXT };
}

/**
 * Maps a command failure to a form result. Unexpected failures (unknown
 * SQLSTATE, malformed response, network) are rethrown without detail so the
 * route error boundary shows a retry state: they are never guessed into a
 * specific refusal.
 */
function failFrom(error: unknown): BookingActionResult<never> {
  if (error instanceof BookingCommandError && error.code) return fail(error.code);
  // The command may have committed before the failure: never claim "nothing changed".
  throw new Error(UNKNOWN_OUTCOME_TEXT);
}

export async function openBookingDraftAction(_prev: Prev<OpenDraftResult>, formData: FormData): Promise<BookingActionResult<OpenDraftResult>> {
  const staff = await requireStaff();
  const dealId = readUuid(formData, FIELD.dealId);
  if (!dealId) return fail('invalid_input');
  try {
    const result = await openDraft(asRpcClient(staff.supabase), dealId);
    revalidatePath(dealPath(dealId));
    revalidatePath(intakePath(dealId));
    return {
      ok: true,
      data: result,
      message: result.created ? 'Draft booking started. Add the hotel details.' : 'Draft booking opened.',
    };
  } catch (error) {
    return failFrom(error);
  }
}

export async function saveBookingDraftAction(_prev: Prev<SaveDraftResult>, formData: FormData): Promise<BookingActionResult<SaveDraftResult>> {
  const staff = await requireStaff();
  const parsed = parseSaveDraftForm(formData);
  if (!parsed.ok) return fail('invalid_input');
  const { dealId, versionId, expectedRowVersion, facts, sellingTotalPaise, sellingTotalProvided } = parsed.value;
  try {
    const result = await saveDraft(asRpcClient(staff.supabase), {
      versionId,
      expectedRowVersion,
      facts,
      sellingTotalPaise,
      sellingTotalProvided,
    });
    revalidatePath(dealPath(dealId));
    revalidatePath(intakePath(dealId));
    return { ok: true, data: result, message: 'Draft saved. It is not confirmed yet.' };
  } catch (error) {
    return failFrom(error);
  }
}

export async function uploadBookingEvidenceAction(
  _prev: Prev<{ evidenceId: string }>,
  formData: FormData,
): Promise<BookingActionResult<{ evidenceId: string }>> {
  const staff = await requireStaff();
  const dealId = readUuid(formData, FIELD.dealId);
  const versionId = readUuid(formData, FIELD.versionId);
  const kind = readEvidenceKind(formData);
  const file = formData.get(FIELD.file);
  if (!dealId || !versionId || !kind) return fail('invalid_input');
  if (!(file instanceof Blob) || file.size === 0 || file.size > EVIDENCE_MAX_BYTES) return fail('evidence_rejected');

  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkEvidenceFile({
    bytes,
    declaredMime: file.type,
    fileName: 'name' in file && typeof file.name === 'string' ? file.name : '',
  });
  if (!check.ok) return fail('evidence_rejected');

  const rpc = asRpcClient(staff.supabase);
  let begun;
  try {
    begun = await beginEvidence(rpc, {
      versionId,
      kind,
      fileName: check.fileName,
      mime: check.mime,
      sizeBytes: check.sizeBytes,
      sha256: check.sha256,
    });
  } catch (error) {
    return failFrom(error);
  }

  // The database authorized the actor and generated the object path: only now the privileged client.
  let stored = false;
  try {
    const upload = await createSupabaseAdminClient()
      .storage
      .from(EVIDENCE_BUCKET)
      .upload(begun.objectPath, bytes, { contentType: check.mime, upsert: false });
    stored = !upload.error;
  } catch {
    stored = false;
  }

  if (!stored) {
    await finishEvidence(rpc, begun.evidenceId, false).catch(() => undefined);
    revalidatePath(dealPath(dealId));
    revalidatePath(intakePath(dealId));
    return fail('upload_failed');
  }

  const uploaded = { ok: true as const, data: { evidenceId: begun.evidenceId }, message: 'Proof uploaded.' };
  let status: EvidenceStatus | null;
  try {
    // H2: the database marks 'stored' only when the Storage object exists with
    // the declared size; otherwise it answers 'failed'.
    status = (await finishEvidence(rpc, begun.evidenceId, true)).status;
  } catch {
    // M1: the finish may have committed. Re-read the outcome; never delete an
    // object whose outcome is unknown (orphan cleanup is a follow-up, A4 L2).
    status = await evidenceStatus(rpc, dealId, begun.evidenceId);
  }
  revalidatePath(dealPath(dealId));
  if (status === 'stored') return uploaded;
  if (status === 'failed' || status === 'removed') return fail('upload_failed');
  return unknownOutcome('upload_failed');
}

/** Current status of one evidence row via the panel read, or null when it cannot be determined. */
async function evidenceStatus(rpc: RpcClient, dealId: string, evidenceId: string): Promise<EvidenceStatus | null> {
  try {
    const panel = await bookingPanel(rpc, dealId);
    return panel?.evidence.find((e) => e.id === evidenceId)?.status ?? null;
  } catch {
    return null;
  }
}

export async function removeBookingEvidenceAction(
  _prev: Prev<{ evidenceId: string }>,
  formData: FormData,
): Promise<BookingActionResult<{ evidenceId: string }>> {
  const staff = await requireStaff();
  const dealId = readUuid(formData, FIELD.dealId);
  const evidenceId = readUuid(formData, FIELD.evidenceId);
  if (!dealId || !evidenceId) return fail('invalid_input');
  try {
    const result = await removeEvidence(asRpcClient(staff.supabase), evidenceId);
    revalidatePath(dealPath(dealId));
    revalidatePath(intakePath(dealId));
    return { ok: true, data: { evidenceId: result.evidenceId }, message: 'Proof removed.' };
  } catch (error) {
    return failFrom(error);
  }
}

export async function confirmBookingAction(
  _prev: Prev<ConfirmBookingResult>,
  formData: FormData,
): Promise<BookingActionResult<ConfirmBookingResult>> {
  const staff = await requireStaff();
  const dealId = readUuid(formData, FIELD.dealId);
  const versionId = readUuid(formData, FIELD.versionId);
  const expectedContentHash = readContentHash(formData);
  if (!dealId || !versionId || !expectedContentHash) return fail('invalid_input');

  const rpc = asRpcClient(staff.supabase);
  try {
    const result = await confirmBooking(rpc, { versionId, expectedContentHash });
    revalidatePath(dealPath(dealId));
    revalidatePath(intakePath(dealId));
    revalidatePath(PURCHASE_PATH);
    return {
      ok: true,
      data: result,
      message:
        result.outcome === 'created'
          ? CONFIRM_SUCCESS_TEXT
          : 'These booking details were already confirmed. The existing Purchase task is unchanged. The hotel is not booked yet.',
    };
  } catch (error) {
    if (error instanceof BookingCommandError && error.code === 'not_ready') {
      // The repair list comes from the side-effect-free readiness read.
      const issues = await readiness(rpc, versionId)
        .then((r) => r.issues)
        .catch(() => undefined);
      revalidatePath(dealPath(dealId));
      revalidatePath(intakePath(dealId));
      return { ok: false, code: 'not_ready', message: ERROR_TEXT.not_ready, ...(issues ? { issues } : {}) };
    }
    if (error instanceof BookingCommandError && error.code === 'version_changed') revalidatePath(dealPath(dealId));
    return failFrom(error);
  }
}

export async function claimPurchaseTaskAction(_prev: Prev<ClaimTaskResult>, formData: FormData): Promise<BookingActionResult<ClaimTaskResult>> {
  const staff = await requireStaff();
  const taskId = readUuid(formData, FIELD.taskId);
  if (!taskId) return fail('invalid_input');
  try {
    const result = await claimPurchaseTask(asRpcClient(staff.supabase), taskId);
    revalidatePath(PURCHASE_PATH);
    revalidatePath(`${PURCHASE_PATH}/${taskId}`);
    return {
      ok: true,
      data: result,
      message: result.alreadyYours ? 'This task is already yours.' : 'You have taken this task. It is now in progress.',
    };
  } catch (error) {
    if (error instanceof BookingCommandError && error.code === 'task_conflict') {
      revalidatePath(`${PURCHASE_PATH}/${taskId}`);
    }
    return failFrom(error);
  }
}
