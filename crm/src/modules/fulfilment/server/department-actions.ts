'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { requireStaff } from '@/modules/identity/server/session';
import {
  departmentCostSave,
  departmentCostSubmit,
  departmentEvidenceBegin,
  departmentEvidenceFinish,
  departmentEvidenceRemove,
} from '../b11-commands';
import { parseCostEntryRowForm, parseDepartmentCostForm, readDepartmentEvidenceKind } from '../b11-forms';
import { asRpcClient } from '../commands';
import {
  type BookingActionResult,
  DEPARTMENT_COST_TEXT,
  DEPARTMENT_EVIDENCE_BUCKET,
  type DepartmentCostSaveResult,
  EVIDENCE_MAX_BYTES,
  UNKNOWN_OUTCOME_TEXT,
} from '../contracts';
import { checkEvidenceFile } from '../evidence';
import { FIELD, readUuid } from '../forms';
import { fail, failFrom, isCode } from './b11-results';

/**
 * Department work forms (contract §4, appendix A §3.2): cost entries and
 * their expense records, and department evidence. requireStaff(), parse,
 * then the database command under the staff member's own session. Uploads
 * use the privileged client for Storage only, after department_evidence_begin
 * authorized the actor and generated the object path. Sending a cost to
 * Accounts is an expense record for review, never a payment approval.
 */

type Prev<T> = BookingActionResult<T> | null;

function revalidateTask(taskId: string): void {
  revalidatePath(`/app/visa/${taskId}`);
  revalidatePath(`/app/flight/${taskId}`);
  revalidatePath(`/app/purchase/${taskId}`);
  revalidatePath('/app/accounts/expenses');
}

const COST_HINTS = {
  amountPaise: FIELD.amountRupees,
  costKind: FIELD.costKind,
  paidBy: FIELD.paidBy,
  paymentMode: FIELD.paymentMode,
  paidOn: FIELD.paidOn,
  reference: FIELD.reference,
  department: FIELD.costKind,
  requestId: FIELD.requestId,
};

export async function saveDepartmentCostAction(
  _prev: Prev<DepartmentCostSaveResult>,
  formData: FormData,
): Promise<BookingActionResult<DepartmentCostSaveResult>> {
  const staff = await requireStaff();
  const parsed = parseDepartmentCostForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  try {
    const result = await departmentCostSave(asRpcClient(staff.supabase), v);
    revalidateTask(v.taskId);
    const note = v.fields.paidBy === 'company' ? ` ${DEPARTMENT_COST_TEXT.companyFeeNote}` : '';
    return { ok: true, data: result, message: `Cost saved.${note}` };
  } catch (error) {
    if (isCode(error, 'version_changed') || isCode(error, 'cost_locked')) revalidateTask(v.taskId);
    return failFrom(error, COST_HINTS);
  }
}

/** "Send to Accounts": the expense record goes from draft/returned to submitted. */
export async function submitExpenseRecordAction(
  _prev: Prev<DepartmentCostSaveResult>,
  formData: FormData,
): Promise<BookingActionResult<DepartmentCostSaveResult>> {
  const staff = await requireStaff();
  const parsed = parseCostEntryRowForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  try {
    const result = await departmentCostSubmit(asRpcClient(staff.supabase), { entryId: v.entryId, expectedRowVersion: v.expectedRowVersion });
    revalidateTask(v.taskId);
    return { ok: true, data: result, message: DEPARTMENT_COST_TEXT.sentToAccounts };
  } catch (error) {
    if (isCode(error, 'version_changed') || isCode(error, 'cost_locked')) revalidateTask(v.taskId);
    return failFrom(error, COST_HINTS);
  }
}

/** Upload one department file (applicant document, fee receipt, authority outcome, direct payment proof). */
export async function uploadDepartmentEvidenceAction(
  _prev: Prev<{ evidenceId: string }>,
  formData: FormData,
): Promise<BookingActionResult<{ evidenceId: string }>> {
  const staff = await requireStaff();
  const taskId = readUuid(formData, FIELD.taskId);
  const applicationRaw = formData.get(FIELD.applicationId);
  const applicationId = typeof applicationRaw === 'string' && applicationRaw.trim() !== '' ? readUuid(formData, FIELD.applicationId) : null;
  const kind = readDepartmentEvidenceKind(formData);
  const file = formData.get(FIELD.file);
  if (!taskId || !kind || (typeof applicationRaw === 'string' && applicationRaw.trim() !== '' && !applicationId)) {
    return fail('invalid_input', [!taskId ? FIELD.taskId : !kind ? FIELD.kind : FIELD.applicationId]);
  }
  if (!(file instanceof Blob) || file.size === 0 || file.size > EVIDENCE_MAX_BYTES) return fail('evidence_rejected', [FIELD.file]);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkEvidenceFile({ bytes, declaredMime: file.type, fileName: 'name' in file && typeof file.name === 'string' ? file.name : '' });
  if (!check.ok) return fail('evidence_rejected', [FIELD.file]);

  const rpc = asRpcClient(staff.supabase);
  let begun;
  try {
    begun = await departmentEvidenceBegin(rpc, {
      taskId,
      applicationId,
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
      .storage.from(DEPARTMENT_EVIDENCE_BUCKET)
      .upload(begun.objectPath, bytes, { contentType: check.mime, upsert: false });
    stored = !upload.error;
  } catch {
    stored = false;
  }
  if (!stored) {
    await departmentEvidenceFinish(rpc, begun.evidenceId, false).catch(() => undefined);
    revalidateTask(taskId);
    return fail('upload_failed');
  }
  let status: string | null;
  try {
    status = (await departmentEvidenceFinish(rpc, begun.evidenceId, true)).status;
  } catch {
    // The finish may have committed; never claim an outcome we did not see.
    status = null;
  }
  revalidateTask(taskId);
  if (status === 'stored') return { ok: true, data: { evidenceId: begun.evidenceId }, message: 'File uploaded.' };
  if (status === 'failed' || status === 'removed') return fail('upload_failed');
  return fail('upload_failed', undefined, UNKNOWN_OUTCOME_TEXT);
}

export async function removeDepartmentEvidenceAction(
  _prev: Prev<{ evidenceId: string }>,
  formData: FormData,
): Promise<BookingActionResult<{ evidenceId: string }>> {
  const staff = await requireStaff();
  const taskId = readUuid(formData, FIELD.taskId);
  const evidenceId = readUuid(formData, FIELD.evidenceId);
  if (!taskId || !evidenceId) return fail('invalid_input');
  try {
    const result = await departmentEvidenceRemove(asRpcClient(staff.supabase), evidenceId);
    revalidateTask(taskId);
    return { ok: true, data: { evidenceId: result.evidenceId }, message: 'File removed.' };
  } catch (error) {
    return failFrom(error);
  }
}
