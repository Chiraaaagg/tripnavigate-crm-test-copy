'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { sendSupplierEmail } from '@/lib/email/supplier-email';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { asRpcClient, type RpcClient } from '@/modules/fulfilment/commands';
import { checkEvidenceFile } from '@/modules/fulfilment/evidence';
import { readUuid } from '@/modules/fulfilment/forms';
import { requireStaff } from '@/modules/identity/server/session';
import {
  bookingRequestSend,
  cancellationChargeSet,
  cancellationDecide,
  cancellationOpen,
  cancellationSend,
  emailMarkResult,
  emailRecord,
  goAheadDecide,
  setSupplierEmailSending,
  type SupplierEmailInput,
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
  type BookingRequestResult,
  type CancellationChargeResult,
  type CancellationResult,
  type EmailRecordResult,
  type GoAheadDecisionResult,
  PURCHASE_BUILD_TEXT,
  type SupplierEmailStatus,
  PROCUREMENT_ERROR_TEXT,
  PROCUREMENT_UNKNOWN_OUTCOME_TEXT,
  type ProcurementActionResult,
  type ProcurementErrorCode,
  PURCHASE_EVIDENCE_BUCKET,
  PURCHASE_EVIDENCE_MAX_BYTES,
  SUPPLIER_CONFIRM_SUCCESS_TEXT,
} from '../contracts';
import {
  parseBookingRequestForm,
  parseCancellationChargeForm,
  parseCancellationDecisionForm,
  parseCancellationOpenForm,
  parseCancellationSendForm,
  parseEmailSwitchForm,
  parseGoAheadDecisionForm,
  parseRateRequestForm,
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

// ---------------------------------------------------------------------------
// Purchase build (20261130000100..0120): supplier e-mails, booking request and
// hotel go-ahead, trip cancellation, e-mail switch. The database decides who
// may act; the provider is called only for an e-mail the database queued
// (switch on) under this person's own session, then the result is recorded.
// ---------------------------------------------------------------------------

const GO_AHEAD_PATH = '/app/accounts/go-ahead';
const APPROVALS_PATH = '/app/approvals';
const dealPath = (dealId: string) => `/app/deals/${dealId}`;

/** The person's own typed e-mail fields, returned so a refused form can show them again. */
function emailValues(formData: FormData): Record<string, string> {
  const pick = (name: string, max: number) => {
    const v = formData.get(name);
    return typeof v === 'string' ? v.slice(0, max) : '';
  };
  return { to: pick(PFIELD.to, 254), cc: pick(PFIELD.cc, 3000), subject: pick(PFIELD.subject, 300), body: pick(PFIELD.body, 8000) };
}

/**
 * Sends a queued e-mail through the provider and records the result. Called
 * only after purchase_email_record / purchase_booking_request_send queued it
 * under the person's own session (that command authorized the actor). The
 * result is recorded with the privileged client: purchase_email_mark_result
 * is executable by service_role only, so nobody can mark an e-mail sent from
 * the API. Never throws: an unknown outcome leaves the row 'queued' (shown as
 * "Sending…") so nobody sends it twice by accident.
 */
async function deliverQueued(emailId: string, mail: SupplierEmailInput, replyTo: string): Promise<SupplierEmailStatus> {
  const sent = await sendSupplierEmail({ to: mail.to, cc: mail.cc, subject: mail.subject, text: mail.body, replyTo }).catch(
    () => ({ ok: false, reason: 'provider_error' }) as const,
  );
  try {
    const marked = await emailMarkResult(
      asRpcClient(createSupabaseAdminClient()),
      sent.ok
        ? { emailId, status: 'sent', providerId: sent.providerId, failure: null }
        : { emailId, status: 'failed', providerId: null, failure: sent.reason },
    );
    return marked.status;
  } catch {
    return 'queued';
  }
}

function emailMessage(status: SupplierEmailStatus, outcome: 'created' | 'existing'): string {
  if (outcome === 'existing') return PURCHASE_BUILD_TEXT.emailExisting;
  if (status === 'sent') return PURCHASE_BUILD_TEXT.emailSent;
  if (status === 'failed') return PURCHASE_BUILD_TEXT.emailSendFailed;
  if (status === 'queued') return PROCUREMENT_UNKNOWN_OUTCOME_TEXT;
  return PURCHASE_BUILD_TEXT.emailMarkedSent;
}

/** "Ask for rates": switch off = "Mark as sent"; switch on = send through the CRM. */
export async function recordRateRequestAction(_prev: Prev<EmailRecordResult>, formData: FormData): Promise<ProcurementActionResult<EmailRecordResult>> {
  const staff = await requireStaff();
  const values = emailValues(formData);
  const parsed = parseRateRequestForm(formData);
  if (!parsed.ok) return { ...fail('invalid_input'), values };
  const input = parsed.value;
  const rpc = asRpcClient(staff.supabase);
  let recorded;
  try {
    recorded = await emailRecord(rpc, { ...input, kind: 'rate_request' });
  } catch (error) {
    return { ...failFrom(error), values };
  }
  let status = recorded.status;
  if (status === 'queued' && recorded.outcome === 'created') status = await deliverQueued(recorded.emailId, input, staff.email);
  revalidatePath(taskPath(input.taskId));
  return { ok: true, data: { emailId: recorded.emailId, status, outcome: recorded.outcome }, message: emailMessage(status, recorded.outcome) };
}

/** "Send booking request": the e-mail and, for a hotel, the go-ahead request to Accounts (one transaction). */
export async function sendBookingRequestAction(_prev: Prev<BookingRequestResult>, formData: FormData): Promise<ProcurementActionResult<BookingRequestResult>> {
  const staff = await requireStaff();
  const values = emailValues(formData);
  const parsed = parseBookingRequestForm(formData);
  if (!parsed.ok) return { ...fail('invalid_input'), values };
  const input = parsed.value;
  const rpc = asRpcClient(staff.supabase);
  let recorded;
  try {
    recorded = await bookingRequestSend(rpc, input);
  } catch (error) {
    if (error instanceof ProcurementCommandError && error.code === 'version_changed') revalidatePath(taskPath(input.taskId));
    return { ...failFrom(error), values };
  }
  let status = recorded.status;
  if (status === 'queued' && recorded.outcome === 'created') status = await deliverQueued(recorded.emailId, input, staff.email);
  revalidatePath(taskPath(input.taskId));
  revalidatePath('/app/purchase');
  revalidatePath(GO_AHEAD_PATH);
  const base = emailMessage(status, recorded.outcome);
  const message =
    recorded.outcome === 'created' && (status === 'marked_sent' || status === 'sent')
      ? recorded.goAheadRequestId
        ? PURCHASE_BUILD_TEXT.bookingRequestRecorded
        : PURCHASE_BUILD_TEXT.bookingRequestRecordedNoGoAhead
      : base;
  return {
    ok: true,
    data: {
      emailId: recorded.emailId,
      status,
      outcome: recorded.outcome,
      goAheadRequestId: recorded.goAheadRequestId,
      goAheadState: recorded.goAheadState,
    },
    message,
  };
}

/** Accounts: give or return the hotel go-ahead. */
export async function decideGoAheadAction(_prev: Prev<GoAheadDecisionResult>, formData: FormData): Promise<ProcurementActionResult<GoAheadDecisionResult>> {
  const staff = await requireStaff();
  const typed = formData.get(PFIELD.reason);
  const values = { reason: typeof typed === 'string' ? typed.slice(0, 500) : '' };
  const parsed = parseGoAheadDecisionForm(formData);
  if (!parsed.ok) return { ...fail('invalid_input'), values };
  try {
    const result = await goAheadDecide(asRpcClient(staff.supabase), parsed.value);
    revalidatePath(GO_AHEAD_PATH);
    revalidatePath('/app/purchase');
    return {
      ok: true,
      data: { requestId: result.requestId, status: result.status, outcome: result.outcome },
      message:
        result.outcome === 'existing'
          ? PURCHASE_BUILD_TEXT.goAheadExisting
          : result.status === 'approved'
            ? PURCHASE_BUILD_TEXT.goAheadApproved
            : PURCHASE_BUILD_TEXT.goAheadReturned,
    };
  } catch (error) {
    if (error instanceof ProcurementCommandError && (error.code === 'version_changed' || error.code === 'already_decided')) revalidatePath(GO_AHEAD_PATH);
    return { ...failFrom(error), values };
  }
}

/** Branch Manager: "Trip cancelled" on the Deal. */
export async function openTripCancellationAction(_prev: Prev<CancellationResult>, formData: FormData): Promise<ProcurementActionResult<CancellationResult>> {
  const staff = await requireStaff();
  const typed = formData.get(PFIELD.reason);
  const values = { reason: typeof typed === 'string' ? typed.slice(0, 500) : '' };
  const parsed = parseCancellationOpenForm(formData);
  if (!parsed.ok) return { ...fail('invalid_input'), values };
  try {
    const result = await cancellationOpen(asRpcClient(staff.supabase), parsed.value);
    revalidatePath(dealPath(parsed.value.dealId));
    revalidatePath(APPROVALS_PATH);
    revalidatePath('/app/purchase');
    return {
      ok: true,
      data: { cancellationId: result.cancellationId, status: result.status, rowVersion: result.rowVersion, outcome: result.outcome },
      message: PURCHASE_BUILD_TEXT.tripCancelDone,
    };
  } catch (error) {
    if (error instanceof ProcurementCommandError && error.code === 'already_decided') revalidatePath(dealPath(parsed.value.dealId));
    return { ...failFrom(error), values };
  }
}

/** Purchase: what the supplier keeps and refunds on one task. */
export async function setCancellationChargeAction(
  _prev: Prev<CancellationChargeResult>,
  formData: FormData,
): Promise<ProcurementActionResult<CancellationChargeResult>> {
  const staff = await requireStaff();
  const pick = (name: string, max: number) => {
    const v = formData.get(name);
    return typeof v === 'string' ? v.slice(0, max) : '';
  };
  const values = { keepsRupees: pick(PFIELD.keepsRupees, 30), refundRupees: pick(PFIELD.refundRupees, 30), note: pick(PFIELD.note, 500) };
  const parsed = parseCancellationChargeForm(formData);
  if (!parsed.ok) return { ...fail('invalid_input'), values };
  try {
    const result = await cancellationChargeSet(asRpcClient(staff.supabase), parsed.value);
    revalidatePath(taskPath(parsed.value.taskId));
    revalidatePath(APPROVALS_PATH);
    return {
      ok: true,
      data: { cancellationId: result.cancellationId, revisionNo: result.revisionNo, status: result.status, outcome: result.outcome },
      message: result.outcome === 'existing' ? PURCHASE_BUILD_TEXT.chargeExisting : PURCHASE_BUILD_TEXT.chargeSaved,
    };
  } catch (error) {
    if (error instanceof ProcurementCommandError && error.code === 'version_changed') revalidatePath(taskPath(parsed.value.taskId));
    return { ...failFrom(error), values };
  }
}

/** Purchase: "Send charges to the Manager". */
export async function sendCancellationChargesAction(_prev: Prev<CancellationResult>, formData: FormData): Promise<ProcurementActionResult<CancellationResult>> {
  const staff = await requireStaff();
  const taskId = readUuid(formData, PFIELD.taskId);
  const parsed = parseCancellationSendForm(formData);
  if (!parsed.ok) return fail('invalid_input');
  try {
    const result = await cancellationSend(asRpcClient(staff.supabase), parsed.value);
    if (taskId) revalidatePath(taskPath(taskId));
    revalidatePath(APPROVALS_PATH);
    return {
      ok: true,
      data: { cancellationId: result.cancellationId, status: result.status, rowVersion: result.rowVersion, outcome: result.outcome },
      message: PURCHASE_BUILD_TEXT.chargesSent,
    };
  } catch (error) {
    if (taskId && error instanceof ProcurementCommandError && (error.code === 'version_changed' || error.code === 'not_ready')) {
      revalidatePath(taskPath(taskId));
    }
    return failFrom(error);
  }
}

/** Branch Manager: approve or return the cancellation charges. */
export async function decideCancellationAction(_prev: Prev<CancellationResult>, formData: FormData): Promise<ProcurementActionResult<CancellationResult>> {
  const staff = await requireStaff();
  const typed = formData.get(PFIELD.reason);
  const values = { reason: typeof typed === 'string' ? typed.slice(0, 500) : '' };
  const parsed = parseCancellationDecisionForm(formData);
  if (!parsed.ok) return { ...fail('invalid_input'), values };
  try {
    const result = await cancellationDecide(asRpcClient(staff.supabase), parsed.value);
    revalidatePath(APPROVALS_PATH);
    return {
      ok: true,
      data: { cancellationId: result.cancellationId, status: result.status, rowVersion: result.rowVersion, outcome: result.outcome },
      message: result.status === 'approved' ? PURCHASE_BUILD_TEXT.chargesApproved : PURCHASE_BUILD_TEXT.chargesReturned,
    };
  } catch (error) {
    if (error instanceof ProcurementCommandError && (error.code === 'version_changed' || error.code === 'already_decided')) revalidatePath(APPROVALS_PATH);
    return { ...failFrom(error), values };
  }
}

/** Super Admin: supplier e-mail sending on or off (audited by the database, with the reason). */
export async function setSupplierEmailSendingAction(
  _prev: Prev<{ enabled: boolean; changed: boolean }>,
  formData: FormData,
): Promise<ProcurementActionResult<{ enabled: boolean; changed: boolean }>> {
  const staff = await requireStaff();
  const parsed = parseEmailSwitchForm(formData);
  if (!parsed.ok) return fail('invalid_input');
  try {
    const result = await setSupplierEmailSending(asRpcClient(staff.supabase), parsed.value.enabled, parsed.value.reason);
    revalidatePath('/app/admin');
    return {
      ok: true,
      data: { enabled: result.after, changed: result.changed },
      message: result.after ? PURCHASE_BUILD_TEXT.switchOn : PURCHASE_BUILD_TEXT.switchOff,
    };
  } catch (error) {
    return failFrom(error);
  }
}
