'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { checkEvidenceFile } from '@/modules/fulfilment/evidence';
import { requireStaff } from '@/modules/identity/server/session';
import {
  FlightCommandError,
  bookingChangeApply,
  changeAcknowledge,
  changeDecide,
  changeSubmit,
  changeWithdraw,
  eTicketBegin,
  eTicketFinish,
  groupClaim,
  groupComplete,
  groupReassign,
  screenshotSectorsSave,
  sectorFillBlanks,
  ticketCorrect,
  travellerNameFill,
} from '../commands';
import {
  type BookingChangeApplyResult,
  type ChangeAckResult,
  type ChangeDecisionResult,
  type ChangeSubmitResult,
  FLIGHT_DONE_TEXT,
  FLIGHT_E_TICKET_BUCKET,
  FLIGHT_E_TICKET_MAX_BYTES,
  FLIGHT_ERROR_TEXT,
  FLIGHT_FIELD,
  FLIGHT_UNKNOWN_OUTCOME_TEXT,
  type FillBlanksResult,
  type FlightActionResult,
  type FlightErrorCode,
  type GroupClaimResult,
  type GroupCompleteResult,
  type GroupReassignResult,
  type ScreenshotSaveResult,
  type TicketCorrectResult,
  type TravellerNameFillResult,
} from '../contracts';
import {
  readText,
  readDecision,
  readPayloadArray,
  readPayloadObject,
  readPositiveInt,
  readReason,
  readRequestId,
  readUuid,
  readUuidList,
} from '../forms';

/**
 * Flight workspace commands (contract section 6.1). Every action:
 * requireStaff(); parse the form (never the actor, entity, assignee or
 * decider); run the database command under the staff member's OWN session.
 * The privileged client is used only for Storage, after
 * department_evidence_begin authorized the actor and generated the path.
 * Messages are frozen wording; database messages never reach the browser.
 * Signatures fit useActionState: (previous result | null, FormData).
 */

type Code = FlightErrorCode | 'upload_failed' | 'session';
type Prev<T> = FlightActionResult<T> | null;
type Failure = Extract<FlightActionResult<never>, { ok: false }>;

function fail(code: Code, fields?: string[]): Failure {
  return fields?.length ? { ok: false, code, message: FLIGHT_ERROR_TEXT[code], fields } : { ok: false, code, message: FLIGHT_ERROR_TEXT[code] };
}

/** Unexpected failures are rethrown without detail: the command may have committed. */
function failFrom(error: unknown): Failure {
  if (error instanceof FlightCommandError && error.code) return fail(error.code, error.hintKeys);
  throw new Error(FLIGHT_UNKNOWN_OUTCOME_TEXT);
}

function isCode(error: unknown, ...codes: FlightErrorCode[]): boolean {
  return error instanceof FlightCommandError && error.code !== null && error.code !== 'session' && codes.includes(error.code);
}

/** Every page that shows a Deal's flights. */
function revalidateFlight(dealId?: string | null): void {
  revalidatePath('/app/flight');
  if (dealId) {
    revalidatePath(`/app/flight/deals/${dealId}`);
    revalidatePath(`/app/deals/${dealId}`);
  } else {
    revalidatePath('/app/flight/deals/[dealId]', 'page');
    revalidatePath('/app/deals/[id]', 'page');
  }
  revalidatePath('/app');
}

const missing = (...fields: string[]) => fail('invalid_input', fields);
/** The names of the fields that are missing or malformed. */
const absent = (fields: Record<string, unknown>): string[] => Object.entries(fields).filter(([, v]) => !v).map(([k]) => k);

// ---------------------------------------------------------------------------
// A1 / A2 group
// ---------------------------------------------------------------------------

/** "Take these flights": every open flight task of the Deal at once. */
export async function claimFlightGroupAction(_prev: Prev<GroupClaimResult>, formData: FormData): Promise<FlightActionResult<GroupClaimResult>> {
  const staff = await requireStaff();
  const dealId = readUuid(formData, FLIGHT_FIELD.dealId);
  const requestId = readRequestId(formData);
  if (!dealId || !requestId) return missing(!dealId ? FLIGHT_FIELD.dealId : FLIGHT_FIELD.requestId);
  try {
    const result = await groupClaim(asRpcClient(staff.supabase), { dealId, requestId });
    revalidateFlight(dealId);
    return { ok: true, data: result, message: result.claimedTaskIds.length ? FLIGHT_DONE_TEXT.claimed : FLIGHT_DONE_TEXT.claimedExisting };
  } catch (error) {
    if (isCode(error, 'task_conflict')) revalidateFlight(dealId);
    return failFrom(error);
  }
}

/** Branch Manager: move the Deal's in-progress flights to another Flight person (reason 10..300). */
export async function reassignFlightGroupAction(
  _prev: Prev<GroupReassignResult>,
  formData: FormData,
): Promise<FlightActionResult<GroupReassignResult>> {
  const staff = await requireStaff();
  const dealId = readUuid(formData, FLIGHT_FIELD.dealId);
  const expectedAssignee = readUuid(formData, FLIGHT_FIELD.expectedAssignee);
  const toUserId = readUuid(formData, FLIGHT_FIELD.toUserId);
  const reason = readReason(formData);
  const requestId = readRequestId(formData);
  if (!dealId || !expectedAssignee || !toUserId || !reason || !requestId) {
    return missing(...absent({ [FLIGHT_FIELD.dealId]: dealId, [FLIGHT_FIELD.expectedAssignee]: expectedAssignee,
      [FLIGHT_FIELD.toUserId]: toUserId, [FLIGHT_FIELD.reason]: reason, [FLIGHT_FIELD.requestId]: requestId }));
  }
  try {
    const result = await groupReassign(asRpcClient(staff.supabase), { dealId, expectedAssignee, toUserId, reason, requestId });
    revalidateFlight(dealId);
    return { ok: true, data: result, message: FLIGHT_DONE_TEXT.reassigned };
  } catch (error) {
    if (isCode(error, 'task_conflict')) revalidateFlight(dealId);
    return failFrom(error);
  }
}

// ---------------------------------------------------------------------------
// A3 - A5 itinerary
// ---------------------------------------------------------------------------

export async function applyFlightBookingChangeAction(
  _prev: Prev<BookingChangeApplyResult>,
  formData: FormData,
): Promise<FlightActionResult<BookingChangeApplyResult>> {
  const staff = await requireStaff();
  const dealId = readUuid(formData, FLIGHT_FIELD.dealId);
  const taskId = readUuid(formData, FLIGHT_FIELD.taskId);
  const expectedBasisVersionId = readUuid(formData, FLIGHT_FIELD.expectedBasisVersionId);
  const targetVersionId = readUuid(formData, FLIGHT_FIELD.targetVersionId);
  const requestId = readRequestId(formData);
  if (!taskId || !expectedBasisVersionId || !targetVersionId || !requestId) {
    return missing(!taskId ? FLIGHT_FIELD.taskId : !requestId ? FLIGHT_FIELD.requestId : FLIGHT_FIELD.targetVersionId);
  }
  try {
    const result = await bookingChangeApply(asRpcClient(staff.supabase), { taskId, expectedBasisVersionId, targetVersionId, requestId });
    revalidateFlight(dealId);
    return { ok: true, data: result, message: FLIGHT_DONE_TEXT.bookingApplied };
  } catch (error) {
    if (isCode(error, 'version_changed', 'not_ready')) revalidateFlight(dealId);
    return failFrom(error);
  }
}

/** Screenshot flights: the sectors typed from the screenshot (payload = sectors[]). */
export async function saveFlightScreenshotSectorsAction(
  _prev: Prev<ScreenshotSaveResult>,
  formData: FormData,
): Promise<FlightActionResult<ScreenshotSaveResult>> {
  const staff = await requireStaff();
  const dealId = readUuid(formData, FLIGHT_FIELD.dealId);
  const taskId = readUuid(formData, FLIGHT_FIELD.taskId);
  const expectedStateRowVersion = readPositiveInt(formData, FLIGHT_FIELD.expectedRowVersion);
  const sectors = readPayloadArray(formData);
  const requestId = readRequestId(formData);
  if (!taskId || !expectedStateRowVersion || !sectors || !requestId) {
    return missing(!taskId ? FLIGHT_FIELD.taskId : !sectors ? 'sectors' : !requestId ? FLIGHT_FIELD.requestId : FLIGHT_FIELD.expectedRowVersion);
  }
  try {
    const result = await screenshotSectorsSave(asRpcClient(staff.supabase), { taskId, expectedStateRowVersion, sectors, requestId });
    revalidateFlight(dealId);
    return { ok: true, data: result, message: FLIGHT_DONE_TEXT.sectorsSaved };
  } catch (error) {
    if (isCode(error, 'version_changed', 'booking_changed')) revalidateFlight(dealId);
    return failFrom(error);
  }
}

/** Fill blank booking details (airline, flightNo, departTime, arriveTime, arriveDate); a filled value is an alternative. */
export async function fillFlightSectorBlanksAction(
  _prev: Prev<FillBlanksResult>,
  formData: FormData,
): Promise<FlightActionResult<FillBlanksResult>> {
  const staff = await requireStaff();
  const dealId = readUuid(formData, FLIGHT_FIELD.dealId);
  const sectorId = readUuid(formData, FLIGHT_FIELD.sectorId);
  const expectedRowVersion = readPositiveInt(formData, FLIGHT_FIELD.expectedRowVersion);
  const fields = readPayloadObject(formData);
  const requestId = readRequestId(formData);
  if (!sectorId || !expectedRowVersion || !fields || !requestId) {
    return missing(!sectorId ? FLIGHT_FIELD.sectorId : !fields ? 'fields' : !requestId ? FLIGHT_FIELD.requestId : FLIGHT_FIELD.expectedRowVersion);
  }
  try {
    const result = await sectorFillBlanks(asRpcClient(staff.supabase), { sectorId, expectedRowVersion, fields, requestId });
    revalidateFlight(dealId);
    return { ok: true, data: result, message: FLIGHT_DONE_TEXT.blanksFilled };
  } catch (error) {
    if (isCode(error, 'version_changed', 'booking_changed')) revalidateFlight(dealId);
    return failFrom(error);
  }
}

// ---------------------------------------------------------------------------
// A6 - A9 changes
// ---------------------------------------------------------------------------

/** Alternative / added sector / passenger itinerary (payload = {kind, fromSectorIds, travellerSeqs, remark, sectors}). */
export async function submitFlightChangeAction(
  _prev: Prev<ChangeSubmitResult>,
  formData: FormData,
): Promise<FlightActionResult<ChangeSubmitResult>> {
  const staff = await requireStaff();
  const dealId = readUuid(formData, FLIGHT_FIELD.dealId);
  const taskId = readUuid(formData, FLIGHT_FIELD.taskId);
  const fields = readPayloadObject(formData);
  const requestId = readRequestId(formData);
  if (!taskId || !fields || !requestId) return missing(!taskId ? FLIGHT_FIELD.taskId : !fields ? 'fields' : FLIGHT_FIELD.requestId);
  try {
    const result = await changeSubmit(asRpcClient(staff.supabase), { taskId, fields, requestId });
    revalidateFlight(dealId);
    return { ok: true, data: result, message: result.status === 'approved' ? FLIGHT_DONE_TEXT.changeApplied : FLIGHT_DONE_TEXT.changeSent };
  } catch (error) {
    if (isCode(error, 'booking_changed', 'held_by_change', 'version_changed')) revalidateFlight(dealId);
    return failFrom(error);
  }
}

/** Sales owner (fallback branch Manager): approve or reject (reason 10..500) a waiting change. */
export async function decideFlightChangeAction(
  _prev: Prev<ChangeDecisionResult>,
  formData: FormData,
): Promise<FlightActionResult<ChangeDecisionResult>> {
  const staff = await requireStaff();
  const dealId = readUuid(formData, FLIGHT_FIELD.dealId);
  const changeId = readUuid(formData, FLIGHT_FIELD.changeId);
  const decision = readDecision(formData);
  const expectedRowVersion = readPositiveInt(formData, FLIGHT_FIELD.expectedRowVersion);
  const reason = readReason(formData);
  const requestId = readRequestId(formData);
  if (!changeId || !decision || !expectedRowVersion || !requestId) {
    return missing(!changeId ? FLIGHT_FIELD.changeId : !decision ? FLIGHT_FIELD.decision : !requestId ? FLIGHT_FIELD.requestId : FLIGHT_FIELD.expectedRowVersion);
  }
  if (decision === 'reject' && !reason) return missing(FLIGHT_FIELD.reason);
  try {
    const result = await changeDecide(asRpcClient(staff.supabase), {
      changeId, decision, reason: decision === 'reject' ? reason : null, expectedRowVersion, requestId,
    });
    revalidateFlight(dealId);
    return { ok: true, data: result, message: decision === 'approve' ? FLIGHT_DONE_TEXT.changeApproved : FLIGHT_DONE_TEXT.changeRejected };
  } catch (error) {
    if (isCode(error, 'already_decided', 'version_changed')) revalidateFlight(dealId);
    return failFrom(error);
  }
}

export async function withdrawFlightChangeAction(
  _prev: Prev<ChangeDecisionResult>,
  formData: FormData,
): Promise<FlightActionResult<ChangeDecisionResult>> {
  const staff = await requireStaff();
  const dealId = readUuid(formData, FLIGHT_FIELD.dealId);
  const changeId = readUuid(formData, FLIGHT_FIELD.changeId);
  const expectedRowVersion = readPositiveInt(formData, FLIGHT_FIELD.expectedRowVersion);
  const requestId = readRequestId(formData);
  if (!changeId || !expectedRowVersion || !requestId) {
    return missing(!changeId ? FLIGHT_FIELD.changeId : !requestId ? FLIGHT_FIELD.requestId : FLIGHT_FIELD.expectedRowVersion);
  }
  try {
    const result = await changeWithdraw(asRpcClient(staff.supabase), { changeId, expectedRowVersion, requestId });
    revalidateFlight(dealId);
    return { ok: true, data: result, message: FLIGHT_DONE_TEXT.changeWithdrawn };
  } catch (error) {
    if (isCode(error, 'already_decided', 'version_changed')) revalidateFlight(dealId);
    return failFrom(error);
  }
}

/** "OK, seen" on a decided change (clears the Home row). */
export async function acknowledgeFlightChangeAction(
  _prev: Prev<ChangeAckResult>,
  formData: FormData,
): Promise<FlightActionResult<ChangeAckResult>> {
  const staff = await requireStaff();
  const dealId = readUuid(formData, FLIGHT_FIELD.dealId);
  const changeId = readUuid(formData, FLIGHT_FIELD.changeId);
  if (!changeId) return missing(FLIGHT_FIELD.changeId);
  try {
    const result = await changeAcknowledge(asRpcClient(staff.supabase), changeId);
    revalidateFlight(dealId);
    return { ok: true, data: result, message: FLIGHT_DONE_TEXT.changeSeen };
  } catch (error) {
    return failFrom(error);
  }
}

// ---------------------------------------------------------------------------
// A10 correct ticket, A12 mark flight done
// ---------------------------------------------------------------------------

/** "Correct ticket" (payload = {crsType, crsPnr, airlinePnr, ticketNumber}; reason 10..300). */
export async function correctFlightTicketAction(
  _prev: Prev<TicketCorrectResult>,
  formData: FormData,
): Promise<FlightActionResult<TicketCorrectResult>> {
  const staff = await requireStaff();
  const dealId = readUuid(formData, FLIGHT_FIELD.dealId);
  const sectorId = readUuid(formData, FLIGHT_FIELD.sectorId);
  const travellerSeq = readPositiveInt(formData, FLIGHT_FIELD.travellerSeq);
  const expectedRevisionNo = readPositiveInt(formData, FLIGHT_FIELD.expectedRevisionNo);
  const fields = readPayloadObject(formData);
  const reason = readReason(formData);
  const requestId = readRequestId(formData);
  if (!sectorId || !travellerSeq || !expectedRevisionNo || !fields || !reason || !requestId) {
    return missing(...absent({ [FLIGHT_FIELD.sectorId]: sectorId, [FLIGHT_FIELD.travellerSeq]: travellerSeq,
      [FLIGHT_FIELD.expectedRevisionNo]: expectedRevisionNo, fields, [FLIGHT_FIELD.reason]: reason, [FLIGHT_FIELD.requestId]: requestId }));
  }
  try {
    const result = await ticketCorrect(asRpcClient(staff.supabase), { sectorId, travellerSeq, expectedRevisionNo, fields, reason, requestId });
    revalidateFlight(dealId);
    return { ok: true, data: result, message: FLIGHT_DONE_TEXT.ticketCorrected };
  } catch (error) {
    if (isCode(error, 'version_changed')) revalidateFlight(dealId);
    return failFrom(error);
  }
}

/** "Mark flight done": refused not_ready with the done issues as `fields`. */
export async function completeFlightGroupAction(
  _prev: Prev<GroupCompleteResult>,
  formData: FormData,
): Promise<FlightActionResult<GroupCompleteResult>> {
  const staff = await requireStaff();
  const dealId = readUuid(formData, FLIGHT_FIELD.dealId);
  const expectedTaskIds = readUuidList(formData, FLIGHT_FIELD.expectedTaskIds);
  const requestId = readRequestId(formData);
  if (!dealId || !expectedTaskIds || !requestId) {
    return missing(!dealId ? FLIGHT_FIELD.dealId : !expectedTaskIds ? FLIGHT_FIELD.expectedTaskIds : FLIGHT_FIELD.requestId);
  }
  try {
    const result = await groupComplete(asRpcClient(staff.supabase), { dealId, expectedTaskIds, requestId });
    revalidateFlight(dealId);
    revalidatePath('/app/accounts/supplier-invoices');
    return { ok: true, data: result, message: FLIGHT_DONE_TEXT.completed };
  } catch (error) {
    if (isCode(error, 'version_changed', 'not_ready')) revalidateFlight(dealId);
    return failFrom(error);
  }
}

// ---------------------------------------------------------------------------
// A11 e-ticket upload
// ---------------------------------------------------------------------------

/** Upload one e-ticket (PDF, JPG, PNG or WebP up to 4 MB) to an in-progress flight task of the caller. */
export async function uploadFlightETicketAction(
  _prev: Prev<{ evidenceId: string }>,
  formData: FormData,
): Promise<FlightActionResult<{ evidenceId: string }>> {
  const staff = await requireStaff();
  const dealId = readUuid(formData, FLIGHT_FIELD.dealId);
  const taskId = readUuid(formData, FLIGHT_FIELD.taskId);
  const file = formData.get(FLIGHT_FIELD.file);
  if (!taskId) return missing(FLIGHT_FIELD.taskId);
  if (!(file instanceof Blob) || file.size === 0 || file.size > FLIGHT_E_TICKET_MAX_BYTES) return fail('evidence_rejected', [FLIGHT_FIELD.file]);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkEvidenceFile({ bytes, declaredMime: file.type, fileName: 'name' in file && typeof file.name === 'string' ? file.name : '' });
  if (!check.ok) return fail('evidence_rejected', [FLIGHT_FIELD.file]);

  const rpc = asRpcClient(staff.supabase);
  let begun;
  try {
    begun = await eTicketBegin(rpc, { taskId, fileName: check.fileName, mime: check.mime, sizeBytes: check.sizeBytes, sha256: check.sha256 });
  } catch (error) {
    return failFrom(error);
  }

  // The database authorized the actor and generated the object path: only now the privileged client.
  let stored = false;
  try {
    const upload = await createSupabaseAdminClient()
      .storage.from(FLIGHT_E_TICKET_BUCKET)
      .upload(begun.objectPath, bytes, { contentType: check.mime, upsert: false });
    stored = !upload.error;
  } catch {
    stored = false;
  }
  if (!stored) {
    await eTicketFinish(rpc, begun.evidenceId, false).catch(() => undefined);
    revalidateFlight(dealId);
    return fail('upload_failed');
  }
  let status: string | null;
  try {
    status = (await eTicketFinish(rpc, begun.evidenceId, true)).status;
  } catch {
    // The finish may have committed; never claim an outcome we did not see.
    status = null;
  }
  revalidateFlight(dealId);
  if (status === 'stored') return { ok: true, data: { evidenceId: begun.evidenceId }, message: FLIGHT_DONE_TEXT.eTicketStored };
  if (status === 'failed' || status === 'removed') return fail('upload_failed');
  throw new Error(FLIGHT_UNKNOWN_OUTCOME_TEXT);
}

// ---------------------------------------------------------------------------
// R3 (Addendum 2): fill a blank traveller name on the accepted booking
// ---------------------------------------------------------------------------

/** Deal page: the Sales owner (branch Manager only without one) names a traveller who has no name yet. */
export async function fillTravellerNameAction(
  _prev: Prev<TravellerNameFillResult>,
  formData: FormData,
): Promise<FlightActionResult<TravellerNameFillResult>> {
  const staff = await requireStaff();
  const dealId = readUuid(formData, FLIGHT_FIELD.dealId);
  const versionId = readUuid(formData, FLIGHT_FIELD.versionId);
  const seq = readPositiveInt(formData, FLIGHT_FIELD.seq);
  const fullName = (readText(formData, FLIGHT_FIELD.fullName) ?? '').trim();
  const type = readText(formData, FLIGHT_FIELD.travellerType);
  const travellerType = type === 'adult' || type === 'child' || type === 'infant' ? type : null;
  const requestId = readRequestId(formData);
  if (!dealId || !versionId || !seq || !fullName || fullName.length > 120 || !travellerType || !requestId) {
    return missing(...absent({ [FLIGHT_FIELD.dealId]: dealId, [FLIGHT_FIELD.versionId]: versionId, [FLIGHT_FIELD.seq]: seq,
      [FLIGHT_FIELD.fullName]: fullName && fullName.length <= 120, [FLIGHT_FIELD.travellerType]: travellerType,
      [FLIGHT_FIELD.requestId]: requestId }));
  }
  try {
    const result = await travellerNameFill(asRpcClient(staff.supabase), { dealId, versionId, seq, fullName, travellerType, requestId });
    revalidateFlight(dealId);
    return { ok: true, data: result, message: FLIGHT_DONE_TEXT.travellerNamed };
  } catch (error) {
    if (isCode(error, 'name_already_set', 'version_changed')) revalidateFlight(dealId);
    return failFrom(error);
  }
}
