'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { checkEvidenceFile } from '@/modules/fulfilment/evidence';
import { readUuid } from '@/modules/fulfilment/forms';
import { requireStaff } from '@/modules/identity/server/session';
import {
  documentReview,
  documentUpload,
  evidenceBegin,
  evidenceFinish,
  fundingDecide,
  fundingMarkRecovered,
  paymentDecide,
  paymentRecord,
  paymentRequestCancel,
  paymentRequestCreate,
  paymentRequestResubmit,
  paymentVerify,
  SupplierMoneyCommandError,
} from '../commands';
import {
  type DecisionResult,
  type PaymentRequestCreated,
  SM_FIELD,
  SUPPLIER_MONEY_BUCKET,
  SUPPLIER_MONEY_DONE_TEXT,
  SUPPLIER_MONEY_ERROR_TEXT,
  SUPPLIER_MONEY_MAX_BYTES,
  SUPPLIER_MONEY_UNKNOWN_OUTCOME_TEXT,
  type SupplierMoneyActionResult,
  type SupplierMoneyErrorCode,
} from '../contracts';
import {
  parseDocumentForm,
  parsePaymentRequestForm,
  parseRecordForm,
  paymentFormValues,
  readDecision,
  readEvidenceKind,
  readReason,
  readRequestId,
  readRowVersion,
} from '../forms';

/**
 * Supplier money commands. Every action: requireStaff(); parse the form
 * (never the actor, entity, supplier, route or funding amount); run the
 * database command under the staff member's OWN session. The privileged
 * client is used only for Storage, after supplier_money_evidence_begin
 * authorized the actor and generated the path. Messages are frozen wording;
 * database messages never reach the browser and nothing here logs amounts,
 * bank details, reasons or file contents.
 */

type Code = SupplierMoneyErrorCode | 'upload_failed' | 'session';
type Prev<T> = SupplierMoneyActionResult<T> | null;
type Failure = Extract<SupplierMoneyActionResult<never>, { ok: false }>;

function fail(code: Code, values?: Record<string, string>): Failure {
  return values ? { ok: false, code, message: SUPPLIER_MONEY_ERROR_TEXT[code], values } : { ok: false, code, message: SUPPLIER_MONEY_ERROR_TEXT[code] };
}

/** Unexpected failures are rethrown without detail: the command may have committed. */
function failFrom(error: unknown, values?: Record<string, string>): Failure {
  if (error instanceof SupplierMoneyCommandError && error.code) return fail(error.code, values);
  throw new Error(SUPPLIER_MONEY_UNKNOWN_OUTCOME_TEXT);
}

/** Every page that shows supplier money. */
function revalidateMoney(taskId?: string | null): void {
  if (taskId) revalidatePath(`/app/purchase/${taskId}`);
  else revalidatePath('/app/purchase/[taskId]', 'page');
  revalidatePath('/app/purchase/payments');
  revalidatePath('/app/accounts/supplier-payments');
  revalidatePath('/app/accounts/supplier-invoices');
  revalidatePath('/app/accounts/funding');
  revalidatePath('/app/approvals');
  revalidatePath('/app');
}

function decisionMessage(result: DecisionResult, created: string): string {
  return result.outcome === 'existing' ? SUPPLIER_MONEY_DONE_TEXT.existing : created;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Fields: kind (proforma | invoice | credit_note with taskId; payment_proof
 * with paymentId), requestId, file.
 */
export async function uploadSupplierMoneyFileAction(
  _prev: Prev<{ evidenceId: string }>,
  formData: FormData,
): Promise<SupplierMoneyActionResult<{ evidenceId: string }>> {
  const staff = await requireStaff();
  const kind = readEvidenceKind(formData);
  const requestId = readRequestId(formData);
  const targetId = kind === 'payment_proof' ? readUuid(formData, SM_FIELD.paymentId) : readUuid(formData, SM_FIELD.taskId);
  const taskId = readUuid(formData, SM_FIELD.taskId);
  const file = formData.get(SM_FIELD.file);
  if (!kind || !targetId || !requestId) return fail('invalid_input');
  if (!(file instanceof Blob) || file.size === 0 || file.size > SUPPLIER_MONEY_MAX_BYTES) return fail('evidence_rejected');

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
    begun = await evidenceBegin(rpc, {
      kind,
      targetId,
      fileName: check.fileName,
      mime: check.mime,
      sizeBytes: check.sizeBytes,
      sha256: check.sha256,
      requestId,
    });
  } catch (error) {
    return failFrom(error);
  }

  // The database authorized the actor and generated the path: only now the privileged client.
  let uploaded = false;
  try {
    const upload = await createSupabaseAdminClient()
      .storage.from(SUPPLIER_MONEY_BUCKET)
      .upload(begun.objectPath, bytes, { contentType: check.mime, upsert: false });
    uploaded = !upload.error;
  } catch {
    uploaded = false;
  }

  // An exact retry (outcome 'existing') may find the object already stored:
  // finish(true) checks Storage itself, so ask it before giving up.
  if (!uploaded && begun.outcome === 'created') {
    await evidenceFinish(rpc, begun.evidenceId, false).catch(() => undefined);
    revalidateMoney(taskId);
    return fail('upload_failed');
  }

  let status: 'stored' | 'failed' | null;
  try {
    // 'stored' only when Storage holds the object with the declared size.
    status = (await evidenceFinish(rpc, begun.evidenceId, true)).status;
  } catch {
    status = null;
  }
  revalidateMoney(taskId);
  if (status === 'stored') return { ok: true, data: { evidenceId: begun.evidenceId }, message: SUPPLIER_MONEY_DONE_TEXT.fileUploaded };
  if (status === 'failed') return fail('upload_failed');
  return { ok: false, code: 'upload_failed', message: SUPPLIER_MONEY_UNKNOWN_OUTCOME_TEXT };
}

// ---------------------------------------------------------------------------
// Payment requests (Purchase)
// ---------------------------------------------------------------------------

function createdMessage(result: Pick<PaymentRequestCreated, 'outcome' | 'route'>): string {
  if (result.outcome === 'existing') return SUPPLIER_MONEY_DONE_TEXT.requestExisting;
  return result.route === 'manager' ? SUPPLIER_MONEY_DONE_TEXT.requestCreatedManager : SUPPLIER_MONEY_DONE_TEXT.requestCreatedAccounts;
}

/** Fields: taskId, requestId, expectedCostVersionNo, part, amountRupees, dueDate, note, proformaEvidenceId, askFunding, fundingReason. */
export async function createPaymentRequestAction(
  _prev: Prev<PaymentRequestCreated>,
  formData: FormData,
): Promise<SupplierMoneyActionResult<PaymentRequestCreated>> {
  const staff = await requireStaff();
  const values = paymentFormValues(formData);
  const parsed = parsePaymentRequestForm(formData);
  if (!parsed.ok || !parsed.value.taskId) return fail('invalid_input', values);
  const { taskId, fields, requestId } = parsed.value;
  try {
    const result = await paymentRequestCreate(asRpcClient(staff.supabase), taskId, fields, requestId);
    revalidateMoney(taskId);
    return { ok: true, data: { ...result, companyFundingAsked: false }, message: createdMessage(result) };
  } catch (error) {
    if (error instanceof SupplierMoneyCommandError && error.code === 'version_changed') revalidateMoney(taskId);
    return failFrom(error, values);
  }
}

/** Fields: paymentId (the returned request), taskId (for the page), and the create fields. */
export async function resubmitPaymentRequestAction(
  _prev: Prev<PaymentRequestCreated>,
  formData: FormData,
): Promise<SupplierMoneyActionResult<PaymentRequestCreated>> {
  const staff = await requireStaff();
  const values = paymentFormValues(formData);
  const parsed = parsePaymentRequestForm(formData);
  if (!parsed.ok || !parsed.value.paymentId) return fail('invalid_input', values);
  const { taskId, paymentId, fields, requestId } = parsed.value;
  try {
    const result = await paymentRequestResubmit(asRpcClient(staff.supabase), paymentId, fields, requestId);
    revalidateMoney(taskId);
    return { ok: true, data: { ...result, companyFundingAsked: false }, message: createdMessage(result) };
  } catch (error) {
    if (error instanceof SupplierMoneyCommandError && error.code === 'version_changed') revalidateMoney(taskId);
    return failFrom(error, values);
  }
}

/** Fields: paymentId, expectedRowVersion, requestId, taskId (optional, for the page). */
export async function cancelPaymentRequestAction(_prev: Prev<DecisionResult>, formData: FormData): Promise<SupplierMoneyActionResult<DecisionResult>> {
  const staff = await requireStaff();
  const paymentId = readUuid(formData, SM_FIELD.paymentId);
  const rowVersion = readRowVersion(formData);
  const requestId = readRequestId(formData);
  const taskId = readUuid(formData, SM_FIELD.taskId);
  if (!paymentId || !rowVersion || !requestId) return fail('invalid_input');
  try {
    const result = await paymentRequestCancel(asRpcClient(staff.supabase), paymentId, rowVersion, requestId);
    revalidateMoney(taskId);
    return { ok: true, data: result, message: decisionMessage(result, SUPPLIER_MONEY_DONE_TEXT.requestCancelled) };
  } catch (error) {
    return failFrom(error);
  }
}

// ---------------------------------------------------------------------------
// Decisions, recording and verification (Accounts / branch Manager)
// ---------------------------------------------------------------------------

/** Fields: paymentId, decision (approve | return), reason (return: 10–500), expectedRowVersion, requestId. */
export async function decidePaymentRequestAction(_prev: Prev<DecisionResult>, formData: FormData): Promise<SupplierMoneyActionResult<DecisionResult>> {
  const staff = await requireStaff();
  const paymentId = readUuid(formData, SM_FIELD.paymentId);
  const decision = readDecision(formData, ['approve', 'return'] as const);
  const reason = decision === 'return' ? readReason(formData) : null;
  const rowVersion = readRowVersion(formData);
  const requestId = readRequestId(formData);
  const values = { [SM_FIELD.reason]: (formData.get(SM_FIELD.reason)?.toString() ?? '').slice(0, 600) };
  if (!paymentId || !decision || !rowVersion || !requestId || (decision === 'return' && !reason)) return fail('invalid_input', values);
  try {
    const result = await paymentDecide(asRpcClient(staff.supabase), paymentId, decision, reason, rowVersion, requestId);
    revalidateMoney();
    return {
      ok: true,
      data: result,
      message: decisionMessage(result, decision === 'approve' ? SUPPLIER_MONEY_DONE_TEXT.paymentApproved : SUPPLIER_MONEY_DONE_TEXT.paymentReturned),
    };
  } catch (error) {
    if (error instanceof SupplierMoneyCommandError && (error.code === 'version_changed' || error.code === 'already_decided')) revalidateMoney();
    return failFrom(error, values);
  }
}

/** Fields: paymentId, paidOn, paymentMode, bankReference, proofEvidenceId, expectedRowVersion, requestId. */
export async function recordSupplierPaymentAction(_prev: Prev<DecisionResult>, formData: FormData): Promise<SupplierMoneyActionResult<DecisionResult>> {
  const staff = await requireStaff();
  const values = {
    [SM_FIELD.paidOn]: (formData.get(SM_FIELD.paidOn)?.toString() ?? '').slice(0, 10),
    [SM_FIELD.paymentMode]: (formData.get(SM_FIELD.paymentMode)?.toString() ?? '').slice(0, 20),
    [SM_FIELD.bankReference]: (formData.get(SM_FIELD.bankReference)?.toString() ?? '').slice(0, 40),
  };
  const parsed = parseRecordForm(formData);
  if (!parsed.ok) return fail('invalid_input', values);
  try {
    const result = await paymentRecord(asRpcClient(staff.supabase), parsed.value);
    revalidateMoney();
    return { ok: true, data: result, message: decisionMessage(result, SUPPLIER_MONEY_DONE_TEXT.paymentRecorded) };
  } catch (error) {
    if (error instanceof SupplierMoneyCommandError && (error.code === 'version_changed' || error.code === 'already_decided')) revalidateMoney();
    return failFrom(error, values);
  }
}

/** Fields: paymentId, expectedRowVersion, requestId. */
export async function verifySupplierPaymentAction(_prev: Prev<DecisionResult>, formData: FormData): Promise<SupplierMoneyActionResult<DecisionResult>> {
  const staff = await requireStaff();
  const paymentId = readUuid(formData, SM_FIELD.paymentId);
  const rowVersion = readRowVersion(formData);
  const requestId = readRequestId(formData);
  if (!paymentId || !rowVersion || !requestId) return fail('invalid_input');
  try {
    const result = await paymentVerify(asRpcClient(staff.supabase), paymentId, rowVersion, requestId);
    revalidateMoney();
    return { ok: true, data: result, message: decisionMessage(result, SUPPLIER_MONEY_DONE_TEXT.paymentVerified) };
  } catch (error) {
    if (error instanceof SupplierMoneyCommandError && (error.code === 'version_changed' || error.code === 'already_decided')) revalidateMoney();
    return failFrom(error);
  }
}

// ---------------------------------------------------------------------------
// Company funding
// ---------------------------------------------------------------------------

/** Fields: fundingId, decision (approve | return), reason (return: 10–500), expectedRowVersion, requestId. */
export async function decideCompanyFundingAction(_prev: Prev<DecisionResult>, formData: FormData): Promise<SupplierMoneyActionResult<DecisionResult>> {
  const staff = await requireStaff();
  const fundingId = readUuid(formData, SM_FIELD.fundingId);
  const decision = readDecision(formData, ['approve', 'return'] as const);
  const reason = decision === 'return' ? readReason(formData) : null;
  const rowVersion = readRowVersion(formData);
  const requestId = readRequestId(formData);
  const values = { [SM_FIELD.reason]: (formData.get(SM_FIELD.reason)?.toString() ?? '').slice(0, 600) };
  if (!fundingId || !decision || !rowVersion || !requestId || (decision === 'return' && !reason)) return fail('invalid_input', values);
  try {
    const result = await fundingDecide(asRpcClient(staff.supabase), fundingId, decision, reason, rowVersion, requestId);
    revalidateMoney();
    return {
      ok: true,
      data: result,
      message: decisionMessage(result, decision === 'approve' ? SUPPLIER_MONEY_DONE_TEXT.fundingApproved : SUPPLIER_MONEY_DONE_TEXT.fundingReturned),
    };
  } catch (error) {
    if (error instanceof SupplierMoneyCommandError && (error.code === 'version_changed' || error.code === 'already_decided')) revalidateMoney();
    return failFrom(error, values);
  }
}

/** Fields: fundingId, reason (the recovery note, 10–500), expectedRowVersion, requestId. */
export async function markFundingRecoveredAction(_prev: Prev<DecisionResult>, formData: FormData): Promise<SupplierMoneyActionResult<DecisionResult>> {
  const staff = await requireStaff();
  const fundingId = readUuid(formData, SM_FIELD.fundingId);
  const note = readReason(formData);
  const rowVersion = readRowVersion(formData);
  const requestId = readRequestId(formData);
  const values = { [SM_FIELD.reason]: (formData.get(SM_FIELD.reason)?.toString() ?? '').slice(0, 600) };
  if (!fundingId || !note || !rowVersion || !requestId) return fail('invalid_input', values);
  try {
    const result = await fundingMarkRecovered(asRpcClient(staff.supabase), fundingId, note, rowVersion, requestId);
    revalidateMoney();
    return { ok: true, data: result, message: decisionMessage(result, SUPPLIER_MONEY_DONE_TEXT.fundingRecovered) };
  } catch (error) {
    if (error instanceof SupplierMoneyCommandError && (error.code === 'version_changed' || error.code === 'already_decided')) revalidateMoney();
    return failFrom(error, values);
  }
}

// ---------------------------------------------------------------------------
// Supplier invoices and credit notes
// ---------------------------------------------------------------------------

/** Fields: taskId, requestId, kind (invoice | credit_note), number, docDate, totalRupees, gstIncluded, evidenceId (uploaded first). */
export async function uploadSupplierDocumentAction(_prev: Prev<DecisionResult>, formData: FormData): Promise<SupplierMoneyActionResult<DecisionResult>> {
  const staff = await requireStaff();
  const values = {
    [SM_FIELD.kind]: (formData.get(SM_FIELD.kind)?.toString() ?? '').slice(0, 20),
    [SM_FIELD.number]: (formData.get(SM_FIELD.number)?.toString() ?? '').slice(0, 60),
    [SM_FIELD.docDate]: (formData.get(SM_FIELD.docDate)?.toString() ?? '').slice(0, 10),
    [SM_FIELD.totalRupees]: (formData.get(SM_FIELD.totalRupees)?.toString() ?? '').slice(0, 24),
  };
  const parsed = parseDocumentForm(formData);
  if (!parsed.ok) return fail('invalid_input', values);
  try {
    const result = await documentUpload(asRpcClient(staff.supabase), parsed.value.taskId, parsed.value.fields, parsed.value.requestId);
    revalidateMoney(parsed.value.taskId);
    return { ok: true, data: result, message: decisionMessage(result, SUPPLIER_MONEY_DONE_TEXT.documentUploaded) };
  } catch (error) {
    return failFrom(error, values);
  }
}

/** Fields: documentId, decision (accept | return), reason (return: 10–500), expectedRowVersion, requestId. */
export async function reviewSupplierDocumentAction(_prev: Prev<DecisionResult>, formData: FormData): Promise<SupplierMoneyActionResult<DecisionResult>> {
  const staff = await requireStaff();
  const documentId = readUuid(formData, SM_FIELD.documentId);
  const decision = readDecision(formData, ['accept', 'return'] as const);
  const reason = decision === 'return' ? readReason(formData) : null;
  const rowVersion = readRowVersion(formData);
  const requestId = readRequestId(formData);
  const values = { [SM_FIELD.reason]: (formData.get(SM_FIELD.reason)?.toString() ?? '').slice(0, 600) };
  if (!documentId || !decision || !rowVersion || !requestId || (decision === 'return' && !reason)) return fail('invalid_input', values);
  try {
    const result = await documentReview(asRpcClient(staff.supabase), documentId, decision, reason, rowVersion, requestId);
    revalidateMoney();
    return {
      ok: true,
      data: result,
      message: decisionMessage(result, decision === 'accept' ? SUPPLIER_MONEY_DONE_TEXT.documentAccepted : SUPPLIER_MONEY_DONE_TEXT.documentReturned),
    };
  } catch (error) {
    if (error instanceof SupplierMoneyCommandError && (error.code === 'version_changed' || error.code === 'already_decided')) revalidateMoney();
    return failFrom(error, values);
  }
}
