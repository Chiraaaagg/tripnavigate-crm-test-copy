'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { asRpcClient, type RpcClient } from '@/modules/fulfilment/commands';
import { checkEvidenceFile } from '@/modules/fulfilment/evidence';
import { readUuid } from '@/modules/fulfilment/forms';
import { requireStaff } from '@/modules/identity/server/session';
import {
  costApproveOverBudget,
  costPropose,
  evidenceBegin,
  evidenceFinish,
  evidenceRemove,
  ProcurementCommandError,
  purchaseWorkspace,
  quoteAdd,
  quoteWithdraw,
  supplierAddBeneficiary,
  supplierConfirm,
  supplierCreate,
  supplierApproveBeneficiary,
  supplierUpdate,
  supplierVerify,
  taskReassign,
  taskRelease,
} from '../commands';
import {
  A1_TEXT,
  PROCUREMENT_ERROR_TEXT,
  PROCUREMENT_UNKNOWN_OUTCOME_TEXT,
  type ProcurementActionResult,
  type ProcurementErrorCode,
  PURCHASE_EVIDENCE_BUCKET,
  PURCHASE_EVIDENCE_MAX_BYTES,
  SUPPLIER_CONFIRM_SUCCESS_TEXT,
} from '../contracts';
import {
  parseBeneficiaryForm,
  parseCostForm,
  parseQuoteForm,
  parseSupplierConfirmForm,
  parseSupplierForm,
  PFIELD,
  readPurchaseEvidenceKind,
  readPositiveInt,
  readRequestId,
  readRowVersion,
} from '../forms';

/**
 * Phase 4 commands. Every action: requireStaff(); parse the form (never the
 * actor, entity membership or assignee); run the database command under the
 * staff member's OWN session. The privileged client is used only for Storage,
 * after purchase_evidence_begin authorized the actor and generated the path.
 * Messages are frozen wording; database messages never reach the browser and
 * nothing here logs amounts, bank details or file contents.
 */

type Prev<T> = ProcurementActionResult<T> | null;
type Code = ProcurementErrorCode | 'upload_failed' | 'session';

const taskPath = (taskId: string) => `/app/purchase/${taskId}`;
const SUPPLIERS_PATH = '/app/purchase/suppliers';

type Failure = Extract<ProcurementActionResult<never>, { ok: false }>;

function fail(code: Code): Failure {
  return { ok: false, code, message: PROCUREMENT_ERROR_TEXT[code] };
}

/** Unexpected failures are rethrown without detail: the command may have committed. */
function failFrom(error: unknown): Failure {
  if (error instanceof ProcurementCommandError && error.code) return fail(error.code);
  throw new Error(PROCUREMENT_UNKNOWN_OUTCOME_TEXT);
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

export async function createSupplierAction(_prev: Prev<{ supplierId: string }>, formData: FormData): Promise<ProcurementActionResult<{ supplierId: string }>> {
  const staff = await requireStaff();
  const entityId = readUuid(formData, PFIELD.entityId);
  const parsed = parseSupplierForm(formData, { allowStatus: false });
  if (!entityId || !parsed.ok) return fail('invalid_input');
  let supplierId: string;
  try {
    supplierId = (await supplierCreate(asRpcClient(staff.supabase), entityId, parsed.value)).supplierId;
  } catch (error) {
    return failFrom(error);
  }
  revalidatePath(SUPPLIERS_PATH);
  redirect(`${SUPPLIERS_PATH}/${supplierId}?created=1`);
}

export async function updateSupplierAction(_prev: Prev<{ rowVersion: number }>, formData: FormData): Promise<ProcurementActionResult<{ rowVersion: number }>> {
  const staff = await requireStaff();
  const supplierId = readUuid(formData, PFIELD.supplierId);
  const rowVersion = readRowVersion(formData);
  const parsed = parseSupplierForm(formData, { allowStatus: true });
  if (!supplierId || !rowVersion || !parsed.ok) return fail('invalid_input');
  try {
    const result = await supplierUpdate(asRpcClient(staff.supabase), supplierId, rowVersion, parsed.value);
    revalidatePath(SUPPLIERS_PATH);
    revalidatePath(`${SUPPLIERS_PATH}/${supplierId}`);
    return { ok: true, data: { rowVersion: result.rowVersion }, message: 'Supplier saved. Details are still marked not verified.' };
  } catch (error) {
    if (error instanceof ProcurementCommandError && error.code === 'version_changed') revalidatePath(`${SUPPLIERS_PATH}/${supplierId}`);
    return failFrom(error);
  }
}

export async function addBeneficiaryAction(_prev: Prev<{ revisionNo: number }>, formData: FormData): Promise<ProcurementActionResult<{ revisionNo: number }>> {
  const staff = await requireStaff();
  const supplierId = readUuid(formData, PFIELD.supplierId);
  const requestId = readRequestId(formData);
  const parsed = parseBeneficiaryForm(formData);
  if (!supplierId || !requestId || !parsed.ok) return fail('invalid_input');
  try {
    const result = await supplierAddBeneficiary(asRpcClient(staff.supabase), supplierId, requestId, parsed.value);
    revalidatePath(`${SUPPLIERS_PATH}/${supplierId}`);
    return {
      ok: true,
      data: { revisionNo: result.revisionNo },
      message: result.created
        ? `Bank details recorded as revision ${result.revisionNo}. They are not verified.`
        : `These bank details were already recorded as revision ${result.revisionNo}.`,
    };
  } catch (error) {
    return failFrom(error);
  }
}

// ---------------------------------------------------------------------------
// Task work
// ---------------------------------------------------------------------------

export async function addQuoteAction(_prev: Prev<{ quoteId: string }>, formData: FormData): Promise<ProcurementActionResult<{ quoteId: string }>> {
  const staff = await requireStaff();
  const taskId = readUuid(formData, PFIELD.taskId);
  const requestId = readRequestId(formData);
  const parsed = parseQuoteForm(formData);
  if (!taskId || !requestId || !parsed.ok) return fail('invalid_input');
  try {
    const result = await quoteAdd(asRpcClient(staff.supabase), taskId, requestId, parsed.value);
    revalidatePath(taskPath(taskId));
    return { ok: true, data: { quoteId: result.quoteId }, message: result.created ? 'Supplier offer added.' : 'This offer was already added.' };
  } catch (error) {
    return failFrom(error);
  }
}

export async function withdrawQuoteAction(_prev: Prev<{ quoteId: string }>, formData: FormData): Promise<ProcurementActionResult<{ quoteId: string }>> {
  const staff = await requireStaff();
  const taskId = readUuid(formData, PFIELD.taskId);
  const quoteId = readUuid(formData, PFIELD.quoteId);
  if (!taskId || !quoteId) return fail('invalid_input');
  try {
    await quoteWithdraw(asRpcClient(staff.supabase), quoteId);
    revalidatePath(taskPath(taskId));
    return { ok: true, data: { quoteId }, message: 'Offer withdrawn. It stays in the history.' };
  } catch (error) {
    return failFrom(error);
  }
}

export async function proposeCostAction(_prev: Prev<{ versionNo: number }>, formData: FormData): Promise<ProcurementActionResult<{ versionNo: number }>> {
  const staff = await requireStaff();
  const parsed = parseCostForm(formData);
  if (!parsed.ok) return fail('invalid_input');
  try {
    const result = await costPropose(asRpcClient(staff.supabase), parsed.value);
    revalidatePath(taskPath(parsed.value.taskId));
    return {
      ok: true,
      data: { versionNo: result.versionNo },
      message: `Cost proposed as version ${result.versionNo}. Nothing is payable yet.`,
    };
  } catch (error) {
    if (error instanceof ProcurementCommandError && error.code === 'version_changed') revalidatePath(taskPath(parsed.value.taskId));
    return failFrom(error);
  }
}

export async function uploadPurchaseEvidenceAction(
  _prev: Prev<{ evidenceId: string }>,
  formData: FormData,
): Promise<ProcurementActionResult<{ evidenceId: string }>> {
  const staff = await requireStaff();
  const taskId = readUuid(formData, PFIELD.taskId);
  const kind = readPurchaseEvidenceKind(formData);
  const file = formData.get(PFIELD.file);
  if (!taskId || !kind) return fail('invalid_input');
  if (!(file instanceof Blob) || file.size === 0 || file.size > PURCHASE_EVIDENCE_MAX_BYTES) return fail('evidence_rejected');

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
    begun = await evidenceBegin(rpc, { taskId, kind, fileName: check.fileName, mime: check.mime, sizeBytes: check.sizeBytes, sha256: check.sha256 });
  } catch (error) {
    return failFrom(error);
  }

  // The database authorized the actor and generated the path: only now the privileged client.
  let stored = false;
  try {
    const upload = await createSupabaseAdminClient()
      .storage.from(PURCHASE_EVIDENCE_BUCKET)
      .upload(begun.objectPath, bytes, { contentType: check.mime, upsert: false });
    stored = !upload.error;
  } catch {
    stored = false;
  }

  if (!stored) {
    await evidenceFinish(rpc, begun.evidenceId, false).catch(() => undefined);
    revalidatePath(taskPath(taskId));
    return fail('upload_failed');
  }

  let status: 'stored' | 'failed' | null;
  try {
    // 'stored' only when Storage holds the object with the declared size.
    status = (await evidenceFinish(rpc, begun.evidenceId, true)).status;
  } catch {
    // The finish may have committed: re-read; never delete an object whose outcome is unknown.
    status = await evidenceStatus(rpc, taskId, begun.evidenceId);
  }
  revalidatePath(taskPath(taskId));
  if (status === 'stored') return { ok: true, data: { evidenceId: begun.evidenceId }, message: 'File uploaded.' };
  if (status === 'failed') return fail('upload_failed');
  return { ok: false, code: 'upload_failed', message: PROCUREMENT_UNKNOWN_OUTCOME_TEXT };
}

async function evidenceStatus(rpc: RpcClient, taskId: string, evidenceId: string): Promise<'stored' | 'failed' | null> {
  try {
    const ws = await purchaseWorkspace(rpc, taskId);
    const status = ws?.evidence.find((e) => e.id === evidenceId)?.status;
    return status === 'stored' || status === 'failed' ? status : null;
  } catch {
    return null;
  }
}

export async function removePurchaseEvidenceAction(
  _prev: Prev<{ evidenceId: string }>,
  formData: FormData,
): Promise<ProcurementActionResult<{ evidenceId: string }>> {
  const staff = await requireStaff();
  const taskId = readUuid(formData, PFIELD.taskId);
  const evidenceId = readUuid(formData, PFIELD.evidenceId);
  if (!taskId || !evidenceId) return fail('invalid_input');
  try {
    await evidenceRemove(asRpcClient(staff.supabase), evidenceId);
    revalidatePath(taskPath(taskId));
    return { ok: true, data: { evidenceId }, message: 'File removed.' };
  } catch (error) {
    return failFrom(error);
  }
}

export async function confirmSupplierAction(
  _prev: Prev<{ outcome: 'created' | 'existing' }>,
  formData: FormData,
): Promise<ProcurementActionResult<{ outcome: 'created' | 'existing' }>> {
  const staff = await requireStaff();
  // Only the reference is typed in this form; it is the person's own entry, never a commercial value.
  const typed = formData.get(PFIELD.reference);
  const values = { reference: typeof typed === 'string' ? typed.slice(0, 120) : '' };
  const parsed = parseSupplierConfirmForm(formData);
  if (!parsed.ok) return { ...fail('invalid_input'), values };
  const { taskId, expectedVersionNo, reference } = parsed.value;
  try {
    const result = await supplierConfirm(asRpcClient(staff.supabase), taskId, expectedVersionNo, reference);
    revalidatePath(taskPath(taskId));
    revalidatePath('/app/purchase');
    return {
      ok: true,
      data: { outcome: result.outcome },
      message: result.outcome === 'created' ? SUPPLIER_CONFIRM_SUCCESS_TEXT : 'The supplier confirmation was already recorded. Nothing changed.',
    };
  } catch (error) {
    if (error instanceof ProcurementCommandError && (error.code === 'version_changed' || error.code === 'not_ready')) {
      revalidatePath(taskPath(taskId));
    }
    return { ...failFrom(error), values };
  }
}

// ---------------------------------------------------------------------------
// Amendment A1 (contract §9): manager decisions, release, reassignment.
// The database decides who may act (manager of the entity or of the deal's
// branch, the assignee, never the person who entered the value).
// ---------------------------------------------------------------------------

type Outcome = { outcome: 'created' | 'existing' };

export async function verifySupplierAction(_prev: Prev<Outcome>, formData: FormData): Promise<ProcurementActionResult<Outcome>> {
  const staff = await requireStaff();
  const supplierId = readUuid(formData, PFIELD.supplierId);
  const rowVersion = readRowVersion(formData);
  if (!supplierId || !rowVersion) return fail('invalid_input');
  try {
    const result = await supplierVerify(asRpcClient(staff.supabase), supplierId, rowVersion);
    revalidatePath(SUPPLIERS_PATH);
    revalidatePath(`${SUPPLIERS_PATH}/${supplierId}`);
    return { ok: true, data: { outcome: result.outcome }, message: result.outcome === 'created' ? A1_TEXT.verifyDone : A1_TEXT.verifyExisting };
  } catch (error) {
    if (error instanceof ProcurementCommandError && error.code === 'version_changed') revalidatePath(`${SUPPLIERS_PATH}/${supplierId}`);
    return failFrom(error);
  }
}

export async function approveBeneficiaryAction(_prev: Prev<Outcome>, formData: FormData): Promise<ProcurementActionResult<Outcome>> {
  const staff = await requireStaff();
  const supplierId = readUuid(formData, PFIELD.supplierId);
  const revisionNo = readPositiveInt(formData, PFIELD.revisionNo);
  if (!supplierId || !revisionNo) return fail('invalid_input');
  try {
    const result = await supplierApproveBeneficiary(asRpcClient(staff.supabase), supplierId, revisionNo);
    revalidatePath(`${SUPPLIERS_PATH}/${supplierId}`);
    return {
      ok: true,
      data: { outcome: result.outcome },
      message: result.outcome === 'created' ? A1_TEXT.approveBankDone : A1_TEXT.approveBankExisting,
    };
  } catch (error) {
    if (error instanceof ProcurementCommandError && error.code === 'version_changed') revalidatePath(`${SUPPLIERS_PATH}/${supplierId}`);
    return failFrom(error);
  }
}

export async function approveOverBudgetAction(_prev: Prev<Outcome>, formData: FormData): Promise<ProcurementActionResult<Outcome>> {
  const staff = await requireStaff();
  const taskId = readUuid(formData, PFIELD.taskId);
  const versionNo = readPositiveInt(formData, PFIELD.versionNo);
  if (!taskId || !versionNo) return fail('invalid_input');
  try {
    const result = await costApproveOverBudget(asRpcClient(staff.supabase), taskId, versionNo);
    revalidatePath(taskPath(taskId));
    return {
      ok: true,
      data: { outcome: result.outcome },
      message: result.outcome === 'created' ? A1_TEXT.approveCostDone : A1_TEXT.approveCostExisting,
    };
  } catch (error) {
    if (error instanceof ProcurementCommandError && error.code === 'version_changed') revalidatePath(taskPath(taskId));
    return failFrom(error);
  }
}

export async function releaseTaskAction(_prev: Prev<Outcome>, formData: FormData): Promise<ProcurementActionResult<Outcome>> {
  const staff = await requireStaff();
  const taskId = readUuid(formData, PFIELD.taskId);
  if (!taskId) return fail('invalid_input');
  try {
    const result = await taskRelease(asRpcClient(staff.supabase), taskId);
    revalidatePath(taskPath(taskId));
    revalidatePath('/app/purchase');
    return { ok: true, data: { outcome: result.outcome }, message: result.outcome === 'created' ? A1_TEXT.releaseDone : A1_TEXT.releaseExisting };
  } catch (error) {
    if (error instanceof ProcurementCommandError && error.code === 'task_conflict') revalidatePath(taskPath(taskId));
    return failFrom(error);
  }
}

export async function reassignTaskAction(_prev: Prev<Outcome>, formData: FormData): Promise<ProcurementActionResult<Outcome>> {
  const staff = await requireStaff();
  const taskId = readUuid(formData, PFIELD.taskId);
  const expected = readUuid(formData, PFIELD.expectedAssigneeId);
  const toUserId = readUuid(formData, PFIELD.toUserId);
  if (!taskId || !expected || !toUserId) return fail('invalid_input');
  try {
    const result = await taskReassign(asRpcClient(staff.supabase), taskId, expected, toUserId);
    revalidatePath(taskPath(taskId));
    revalidatePath('/app/purchase');
    return { ok: true, data: { outcome: result.outcome }, message: result.outcome === 'created' ? A1_TEXT.reassignDone : A1_TEXT.reassignExisting };
  } catch (error) {
    if (error instanceof ProcurementCommandError && error.code === 'task_conflict') revalidatePath(taskPath(taskId));
    return failFrom(error);
  }
}
