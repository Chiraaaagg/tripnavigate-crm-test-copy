'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { asRpcClient, type RpcClient } from '@/modules/fulfilment/commands';
import { checkEvidenceFile } from '@/modules/fulfilment/evidence';
import { readUuid } from '@/modules/fulfilment/forms';
import { requireStaff } from '@/modules/identity/server/session';
import {
  contractDecide,
  contractEnd,
  contractGet,
  contractLinesSet,
  contractLookup,
  contractSave,
  contractSubmit,
  fileBegin,
  fileFinish,
  RateCommandError,
  roomTypeRemove,
  roomTypeSave,
  setRateContractsEnabled,
} from '../commands';
import {
  MEAL_PLAN_CODES,
  RATE_CONTRACT_FILE_BUCKET,
  RATE_CONTRACT_FILE_MAX_BYTES,
  RATE_DONE_TEXT,
  RATE_ERROR_TEXT,
  RATE_FIELD as F,
  RATE_FIELD_TEXT,
  type RateActionResult,
  type RateErrorCode,
} from '../contracts';
import type { ContractWrite, RateContractLookup, RoomTypeWrite } from '../dto';
import { fieldKey, hintToFormField, readContractFields, readLinesForm, readRequestId, readRowVersion, str } from '../forms';

/**
 * Rate contract commands (Accounts phase 3, E1-E8; Phase 2 Addendum L3 form
 * shape). Every action: requireStaff(); read the form (never the actor, entity
 * or a status the database owns); run the database command under the staff
 * member's OWN session; revalidate the pages. The privileged client is used
 * only for Storage, after rate_contract_file_begin authorized the actor and
 * generated the path. Messages are frozen wording (contracts.ts); database
 * messages never reach the browser; nothing here logs rates or names.
 */

type Prev<T> = RateActionResult<T> | null;
type Failure = Extract<RateActionResult<never>, { ok: false }>;
type Code = RateErrorCode | 'session' | 'upload_failed' | 'unexpected';

const LIST_PATH = '/app/purchase/rate-contracts';
const APPROVALS_PATH = '/app/manager/approvals';
const contractPath = (id: string) => `${LIST_PATH}/${id}`;

function revalidateContract(id?: string | null): void {
  revalidatePath(LIST_PATH);
  revalidatePath(APPROVALS_PATH);
  if (id) revalidatePath(contractPath(id));
}

function fail(code: Code, field?: string, values?: Record<string, string>): Failure {
  const key = field ? fieldKey(field) : undefined;
  const message = code === 'invalid_input' && key && RATE_FIELD_TEXT[key] ? RATE_FIELD_TEXT[key]! : RATE_ERROR_TEXT[code];
  return { ok: false, code, message, ...(field ? { field } : {}), ...(values ? { values } : {}) };
}

/** Known refusals become frozen text with the field they name; anything else: the outcome is unknown. */
function failFrom(error: unknown, values?: Record<string, string>): Failure {
  if (error instanceof RateCommandError && error.code) {
    const field = error.code === 'invalid_input' || error.code === 'lines_overlap' ? hintToFormField(error.hint) : undefined;
    return fail(error.code, field, values);
  }
  return fail('unexpected', undefined, values);
}

/** What the person typed, returned on a refusal so the form shows it again. */
function typed(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of formData.entries()) {
    if (typeof v === 'string' && !k.startsWith('$') && k !== F.requestId && Object.keys(out).length < 6000) out[k] = v.slice(0, 2000);
  }
  return out;
}

function contractMessage(w: ContractWrite, done: string): string {
  return w.outcome === 'existing' ? RATE_DONE_TEXT.existing : done;
}

// ---------------------------------------------------------------------------
// E1 switch (Super Admin)
// ---------------------------------------------------------------------------

export async function setRateContractsEnabledAction(_prev: Prev<{ enabled: boolean }>, formData: FormData): Promise<RateActionResult<{ enabled: boolean }>> {
  const staff = await requireStaff();
  const raw = str(formData, F.enabled);
  const reason = str(formData, F.reason) ?? '';
  if (raw !== 'true' && raw !== 'false') return fail('invalid_input', F.enabled);
  if (reason.length < 10 || reason.length > 500) return fail('invalid_input', F.reason, typed(formData));
  try {
    const r = await setRateContractsEnabled(asRpcClient(staff.supabase), raw === 'true', reason);
    revalidatePath('/app/admin/settings');
    revalidateContract();
    return { ok: true, data: { enabled: r.after }, message: r.after ? RATE_DONE_TEXT.switchOn : RATE_DONE_TEXT.switchOff };
  } catch (error) {
    return failFrom(error, typed(formData));
  }
}

// ---------------------------------------------------------------------------
// E3 header, E4 lines, E6 submit
// ---------------------------------------------------------------------------

export async function saveRateContractAction(_prev: Prev<ContractWrite>, formData: FormData): Promise<RateActionResult<ContractWrite>> {
  const staff = await requireStaff();
  const contractId = str(formData, F.contractId) === null ? null : readUuid(formData, F.contractId);
  const requestId = readRequestId(formData);
  const rowVersion = readRowVersion(formData, contractId === null);
  if (str(formData, F.contractId) !== null && !contractId) return fail('invalid_input', F.contractId, typed(formData));
  if (!requestId || rowVersion === null) return fail('invalid_input', undefined, typed(formData));
  const fields = readContractFields(formData);
  if (!fields.ok) return fail('invalid_input', fields.field, typed(formData));
  if (contractId === null && (!fields.value.supplierId || !fields.value.hotelId)) {
    return fail('invalid_input', fields.value.supplierId ? F.hotelId : F.supplierId, typed(formData));
  }
  try {
    const w = await contractSave(asRpcClient(staff.supabase), { contractId, expectedRowVersion: rowVersion, fields: fields.value, requestId });
    revalidateContract(w.contractId);
    return { ok: true, data: w, message: w.outcome === 'created' ? RATE_DONE_TEXT.created : contractMessage(w, RATE_DONE_TEXT.saved) };
  } catch (error) {
    if (error instanceof RateCommandError && error.code === 'version_changed' && contractId) revalidateContract(contractId);
    return failFrom(error, typed(formData));
  }
}

export async function setRateLinesAction(_prev: Prev<ContractWrite>, formData: FormData): Promise<RateActionResult<ContractWrite>> {
  const staff = await requireStaff();
  const contractId = readUuid(formData, F.contractId);
  const requestId = readRequestId(formData);
  const rowVersion = readRowVersion(formData);
  if (!contractId || !requestId || rowVersion === null) return fail('invalid_input', undefined, typed(formData));
  const read = readLinesForm(formData);
  if (!read.ok) return fail('invalid_input', read.field, typed(formData));
  try {
    const w = await contractLinesSet(asRpcClient(staff.supabase), { contractId, expectedRowVersion: rowVersion, ...read.value, requestId });
    revalidateContract(contractId);
    return { ok: true, data: w, message: contractMessage(w, RATE_DONE_TEXT.linesSet) };
  } catch (error) {
    if (error instanceof RateCommandError && error.code === 'version_changed') revalidateContract(contractId);
    return failFrom(error, typed(formData));
  }
}

export async function submitRateContractAction(_prev: Prev<ContractWrite>, formData: FormData): Promise<RateActionResult<ContractWrite>> {
  const staff = await requireStaff();
  const contractId = readUuid(formData, F.contractId);
  const requestId = readRequestId(formData);
  const rowVersion = readRowVersion(formData);
  if (!contractId || !requestId || rowVersion === null) return fail('invalid_input');
  try {
    const w = await contractSubmit(asRpcClient(staff.supabase), { contractId, expectedRowVersion: rowVersion, requestId });
    revalidateContract(contractId);
    return { ok: true, data: w, message: contractMessage(w, RATE_DONE_TEXT.submitted) };
  } catch (error) {
    return failFrom(error);
  }
}

// ---------------------------------------------------------------------------
// E7 decide, E8 end (Managers)
// ---------------------------------------------------------------------------

export async function decideRateContractAction(_prev: Prev<ContractWrite>, formData: FormData): Promise<RateActionResult<ContractWrite>> {
  const staff = await requireStaff();
  const contractId = readUuid(formData, F.contractId);
  const requestId = readRequestId(formData);
  const rowVersion = readRowVersion(formData);
  const decision = str(formData, F.decision);
  const reason = str(formData, F.reason);
  if (!contractId || !requestId || rowVersion === null) return fail('invalid_input', undefined, typed(formData));
  if (decision !== 'approve' && decision !== 'return') return fail('invalid_input', F.decision, typed(formData));
  if (decision === 'return' && (!reason || reason.length < 10 || reason.length > 500)) return fail('invalid_input', F.reason, typed(formData));
  try {
    const w = await contractDecide(asRpcClient(staff.supabase), { contractId, decision, reason: decision === 'return' ? reason : null, expectedRowVersion: rowVersion, requestId });
    revalidateContract(contractId);
    const done = decision === 'return' ? RATE_DONE_TEXT.returned : (w.endedOlder ?? 0) > 0 ? RATE_DONE_TEXT.approvedReplaced : RATE_DONE_TEXT.approved;
    return { ok: true, data: w, message: contractMessage(w, done) };
  } catch (error) {
    return failFrom(error, typed(formData));
  }
}

export async function endRateContractAction(_prev: Prev<ContractWrite>, formData: FormData): Promise<RateActionResult<ContractWrite>> {
  const staff = await requireStaff();
  const contractId = readUuid(formData, F.contractId);
  const requestId = readRequestId(formData);
  const rowVersion = readRowVersion(formData);
  const reason = str(formData, F.reason);
  if (!contractId || !requestId || rowVersion === null) return fail('invalid_input', undefined, typed(formData));
  if (!reason || reason.length < 10 || reason.length > 500) return fail('invalid_input', F.reason, typed(formData));
  try {
    const w = await contractEnd(asRpcClient(staff.supabase), { contractId, expectedRowVersion: rowVersion, reason, requestId });
    revalidateContract(contractId);
    return { ok: true, data: w, message: contractMessage(w, RATE_DONE_TEXT.ended) };
  } catch (error) {
    return failFrom(error, typed(formData));
  }
}

// ---------------------------------------------------------------------------
// E2 room types
// ---------------------------------------------------------------------------

export async function saveRoomTypeAction(_prev: Prev<RoomTypeWrite>, formData: FormData): Promise<RateActionResult<RoomTypeWrite>> {
  const staff = await requireStaff();
  const hotelId = str(formData, F.hotelId) === null ? null : readUuid(formData, F.hotelId);
  const roomTypeId = str(formData, F.roomTypeId) === null ? null : readUuid(formData, F.roomTypeId);
  const requestId = readRequestId(formData);
  const rowVersion = readRowVersion(formData, roomTypeId === null);
  const name = str(formData, F.name);
  if (!requestId || rowVersion === null || (!hotelId && !roomTypeId)) return fail('invalid_input', undefined, typed(formData));
  if (!name || name.length > 120) return fail('invalid_input', F.name, typed(formData));
  try {
    const w = await roomTypeSave(asRpcClient(staff.supabase), { hotelId, roomTypeId, expectedRowVersion: rowVersion, name, requestId });
    revalidateContract(str(formData, F.contractId) ? readUuid(formData, F.contractId) : null);
    return { ok: true, data: w, message: w.outcome === 'existing' ? RATE_DONE_TEXT.existing : RATE_DONE_TEXT.roomTypeSaved };
  } catch (error) {
    return failFrom(error, typed(formData));
  }
}

export async function removeRoomTypeAction(_prev: Prev<RoomTypeWrite>, formData: FormData): Promise<RateActionResult<RoomTypeWrite>> {
  const staff = await requireStaff();
  const roomTypeId = readUuid(formData, F.roomTypeId);
  const requestId = readRequestId(formData);
  const reason = str(formData, F.reason);
  if (!roomTypeId || !requestId) return fail('invalid_input', undefined, typed(formData));
  if (!reason || reason.length < 10 || reason.length > 300) return fail('invalid_input', F.reason, typed(formData));
  try {
    const w = await roomTypeRemove(asRpcClient(staff.supabase), { roomTypeId, reason, requestId });
    revalidateContract(str(formData, F.contractId) ? readUuid(formData, F.contractId) : null);
    return { ok: true, data: w, message: w.outcome === 'existing' ? RATE_DONE_TEXT.existing : RATE_DONE_TEXT.roomTypeRemoved };
  } catch (error) {
    return failFrom(error, typed(formData));
  }
}

// ---------------------------------------------------------------------------
// E5 contract file upload (Purchase)
// ---------------------------------------------------------------------------

export async function uploadRateContractFileAction(_prev: Prev<{ fileId: string }>, formData: FormData): Promise<RateActionResult<{ fileId: string }>> {
  const staff = await requireStaff();
  const contractId = readUuid(formData, F.contractId);
  const file = formData.get(F.file);
  if (!contractId) return fail('invalid_input');
  if (!(file instanceof Blob) || file.size === 0 || file.size > RATE_CONTRACT_FILE_MAX_BYTES) return fail('evidence_rejected', F.file);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkEvidenceFile({ bytes, declaredMime: file.type, fileName: 'name' in file && typeof file.name === 'string' ? file.name : '' });
  if (!check.ok) return fail('evidence_rejected', F.file);

  const rpc = asRpcClient(staff.supabase);
  let begun;
  try {
    begun = await fileBegin(rpc, { contractId, fileName: check.fileName, mime: check.mime, sizeBytes: check.sizeBytes, sha256: check.sha256 });
  } catch (error) {
    return failFrom(error);
  }
  // The database authorized the actor and generated the path: only now the privileged client.
  let stored = false;
  try {
    const upload = await createSupabaseAdminClient()
      .storage.from(RATE_CONTRACT_FILE_BUCKET)
      .upload(begun.objectPath, bytes, { contentType: check.mime, upsert: false });
    stored = !upload.error;
  } catch {
    stored = false;
  }
  if (!stored) {
    await fileFinish(rpc, begun.fileId, false).catch(() => undefined);
    revalidateContract(contractId);
    return fail('upload_failed', F.file);
  }
  let status: string | null;
  try {
    status = (await fileFinish(rpc, begun.fileId, true)).status;
  } catch {
    // The finish may have committed: re-read; never delete an object whose outcome is unknown.
    status = await fileStatus(rpc, contractId, begun.fileId);
  }
  revalidateContract(contractId);
  if (status === 'stored') return { ok: true, data: { fileId: begun.fileId }, message: RATE_DONE_TEXT.fileStored };
  if (status === 'failed') return fail('upload_failed', F.file);
  return fail('unexpected');
}

async function fileStatus(rpc: RpcClient, contractId: string, fileId: string): Promise<string | null> {
  try {
    return (await contractGet(rpc, contractId))?.files.find((f) => f.fileId === fileId)?.status ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// R-E3 lookup for the offer form (called by the route's bound action)
// ---------------------------------------------------------------------------

/**
 * The contract price for a task's stay. The route binds taskId, supplierId and
 * hotelId; the screen passes the picked room type and meal plan. Null = the
 * viewer may not read it (Purchase of the task only).
 */
export async function lookupRateContractAction(
  bound: { taskId: string; supplierId: string; hotelId: string },
  input: { roomTypeId: string; mealPlanCode: string },
): Promise<{ ok: true; data: RateContractLookup | null } | { ok: false; message: string }> {
  const staff = await requireStaff();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const roomTypeId = input.roomTypeId === '' ? null : input.roomTypeId;
  const mealPlanCode = input.mealPlanCode === '' ? null : input.mealPlanCode;
  if (![bound.taskId, bound.supplierId, bound.hotelId].every((v) => uuid.test(v)) || (roomTypeId !== null && !uuid.test(roomTypeId))
      || (mealPlanCode !== null && !(MEAL_PLAN_CODES as readonly string[]).includes(mealPlanCode))) {
    return { ok: false, message: RATE_ERROR_TEXT.invalid_input };
  }
  try {
    return { ok: true, data: await contractLookup(asRpcClient(staff.supabase), { ...bound, roomTypeId, mealPlanCode }) };
  } catch (error) {
    const code = error instanceof RateCommandError && error.code ? error.code : 'unexpected';
    return { ok: false, message: RATE_ERROR_TEXT[code] };
  }
}
