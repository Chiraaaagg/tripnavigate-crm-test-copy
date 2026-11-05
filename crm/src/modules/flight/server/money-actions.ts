'use server';

import { revalidatePath } from 'next/cache';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { checkEvidenceFile } from '@/modules/fulfilment/evidence';
import { requireStaff } from '@/modules/identity/server/session';
import { SupplierMoneyCommandError, documentUpload, evidenceBegin, evidenceFinish } from '@/modules/supplier-money/commands';
import { SUPPLIER_MONEY_BUCKET, SUPPLIER_MONEY_MAX_BYTES } from '@/modules/supplier-money/contracts';
import {
  FlightMoneyCommandError,
  flightDirectPaymentSave,
  flightFareApprovalDecide,
  flightFareApprovalRequest,
  flightFareApprovalWithdraw,
  flightFarePreview,
  flightPaymentRequestCancel,
  flightPaymentRequestCreate,
  flightPaymentRequestResubmit,
  flightSupplierAddBeneficiary,
  flightSupplierCreate,
  flightSupplierUpdate,
  flightTicketsConfirm,
} from '../money-commands';
import {
  FLIGHT_MONEY_DONE_TEXT,
  FLIGHT_MONEY_ERROR_STATES,
  FLIGHT_MONEY_ERROR_TEXT,
  FLIGHT_MONEY_UNKNOWN_OUTCOME_TEXT,
  FLIGHT_PURCHASE_HOLDER_HINT,
  FLIGHT_PURCHASE_HOLDER_TEXT,
  FM_FIELD,
  type FlightBeneficiaryRecorded,
  type FlightDirectPaymentSaved,
  type FlightFareApprovalChanged,
  type FlightFareApprovalRequested,
  type FlightFarePreviewView,
  type FlightMoneyActionResult,
  type FlightMoneyErrorCode,
  type FlightPaymentRequestCreated,
  type FlightSupplierCreated,
  type FlightTicketsConfirmed,
} from '../money-contracts';
import { toFlightFarePreviewView } from '../money-dto';
import {
  parseApprovalDecisionForm,
  parseBeneficiaryForm,
  parseDirectPaymentForm,
  parseFareFieldsForm,
  parseFareSetFields,
  parseFareSetForm,
  parseInvoiceForm,
  parsePaymentRequestForm,
  parseSupplierForm,
  parseSupplierUpdateForm,
  readFlightRowVersion,
  readFlightUuid,
} from '../money-forms';

/**
 * Flight money server actions (contract 6.2). Every action: requireStaff();
 * parse the form (never the actor, entity, route, budget or an amount to
 * pay); run the database command under the staff member's OWN session. The
 * privileged client is used only for Storage, after
 * supplier_money_evidence_begin authorized the actor and generated the path.
 * Messages are frozen wording; database messages never reach the browser and
 * nothing here logs amounts, PNRs, ticket numbers or bank details.
 * Signatures fit useActionState: (previous state, FormData).
 */

type Code = FlightMoneyErrorCode | 'upload_failed' | 'session';
type Prev<T> = FlightMoneyActionResult<T> | null;
type Failure = Extract<FlightMoneyActionResult<never>, { ok: false }>;

function fail(code: Code, fields?: string[]): Failure {
  const base = { ok: false as const, code, message: FLIGHT_MONEY_ERROR_TEXT[code] };
  return fields && fields.length > 0 ? { ...base, fields: [...new Set(fields)] } : base;
}

/** Unexpected failures are rethrown without detail: the command may have committed. */
function failFrom(error: unknown): Failure {
  if (error instanceof FlightMoneyCommandError && error.code) {
    if (error.code === 'not_authorized' && error.hintKeys.includes(FLIGHT_PURCHASE_HOLDER_HINT)) {
      return { ok: false, code: 'not_authorized', message: FLIGHT_PURCHASE_HOLDER_TEXT, fields: [FLIGHT_PURCHASE_HOLDER_HINT] };
    }
    return fail(error.code, error.code === 'invalid_input' ? error.hintKeys : undefined);
  }
  // Supplier money file and invoice commands share most tokens.
  if (error instanceof SupplierMoneyCommandError && error.code) {
    const code = error.code;
    if (code === 'session' || Object.hasOwn(FLIGHT_MONEY_ERROR_STATES, code)) return fail(code as Code);
  }
  throw new Error(FLIGHT_MONEY_UNKNOWN_OUTCOME_TEXT);
}

function isCode(error: unknown, code: FlightMoneyErrorCode): boolean {
  return error instanceof FlightMoneyCommandError && error.code === code;
}

/** Every page that shows flight money. */
function revalidateFlightMoney(dealId?: string | null): void {
  revalidatePath('/app/flight');
  if (dealId) {
    revalidatePath(`/app/flight/deals/${dealId}`);
    revalidatePath(`/app/deals/${dealId}`);
  } else {
    revalidatePath('/app/flight/deals/[dealId]', 'page');
    revalidatePath('/app/deals/[id]', 'page');
  }
  revalidatePath('/app/accounts/supplier-payments');
  revalidatePath('/app/accounts/supplier-invoices');
  revalidatePath('/app/accounts/expenses');
  revalidatePath('/app/approvals');
  revalidatePath('/app');
}

// ---------------------------------------------------------------------------
// Fares and tickets (B4-B8)
// ---------------------------------------------------------------------------

/**
 * Live totals and the budget line for the Confirm tickets popup (B4; a read,
 * nothing is saved). Called directly with the popup's current fields.
 */
export async function previewFlightFaresAction(dealId: string, fields: unknown): Promise<FlightMoneyActionResult<FlightFarePreviewView>> {
  const staff = await requireStaff();
  // Ticket details are not needed to preview fares.
  const parsed = parseFareSetFields(fields);
  if (typeof dealId !== 'string' || !/^[0-9a-f-]{36}$/i.test(dealId)) return fail('invalid_input', [FM_FIELD.dealId]);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  try {
    const preview = await flightFarePreview(asRpcClient(staff.supabase), dealId, parsed.value);
    return { ok: true, data: toFlightFarePreviewView(preview), message: '' };
  } catch (error) {
    return failFrom(error);
  }
}

/** Fields: dealId, requestId, fareFields (JSON of FlightFareFields). Tickets and fares in one transaction. */
export async function confirmFlightTicketsAction(
  _prev: Prev<FlightTicketsConfirmed>,
  formData: FormData,
): Promise<FlightMoneyActionResult<FlightTicketsConfirmed>> {
  const staff = await requireStaff();
  const parsed = parseFareFieldsForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const { dealId, requestId, fields } = parsed.value;
  try {
    const result = await flightTicketsConfirm(asRpcClient(staff.supabase), dealId, fields, requestId);
    revalidateFlightMoney(dealId);
    return {
      ok: true,
      data: result,
      message: result.outcome === 'existing' ? FLIGHT_MONEY_DONE_TEXT.existing : FLIGHT_MONEY_DONE_TEXT.ticketsConfirmed(result.ticketCount),
    };
  } catch (error) {
    if (isCode(error, 'version_changed') || isCode(error, 'booking_changed')) revalidateFlightMoney(dealId);
    return failFrom(error);
  }
}

/** Fields: dealId, requestId, fareFields (ticket details optional). "Ask the Manager to approve" (B5). */
export async function requestFlightFareApprovalAction(
  _prev: Prev<FlightFareApprovalRequested>,
  formData: FormData,
): Promise<FlightMoneyActionResult<FlightFareApprovalRequested>> {
  const staff = await requireStaff();
  const parsed = parseFareSetForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const { dealId, requestId, fields } = parsed.value;
  try {
    const result = await flightFareApprovalRequest(asRpcClient(staff.supabase), dealId, fields, requestId);
    revalidateFlightMoney(dealId);
    return { ok: true, data: result, message: result.outcome === 'existing' ? FLIGHT_MONEY_DONE_TEXT.existing : FLIGHT_MONEY_DONE_TEXT.approvalRequested };
  } catch (error) {
    return failFrom(error);
  }
}

/** Fields: approvalId, dealId (optional, for the page), decision (approve | return), reason (return: 10-500), expectedRowVersion, requestId. */
export async function decideFlightFareApprovalAction(
  _prev: Prev<FlightFareApprovalChanged>,
  formData: FormData,
): Promise<FlightMoneyActionResult<FlightFareApprovalChanged>> {
  const staff = await requireStaff();
  const parsed = parseApprovalDecisionForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  try {
    const result = await flightFareApprovalDecide(asRpcClient(staff.supabase), v.approvalId, v.decision, v.reason, v.expectedRowVersion, v.requestId);
    revalidateFlightMoney(v.dealId);
    const done = v.decision === 'approve' ? FLIGHT_MONEY_DONE_TEXT.approvalApproved : FLIGHT_MONEY_DONE_TEXT.approvalReturned;
    return { ok: true, data: result, message: result.outcome === 'existing' ? FLIGHT_MONEY_DONE_TEXT.existing : done };
  } catch (error) {
    if (isCode(error, 'version_changed') || isCode(error, 'already_decided')) revalidateFlightMoney(v.dealId);
    return failFrom(error);
  }
}

/** Fields: approvalId, dealId (optional), expectedRowVersion, requestId. */
export async function withdrawFlightFareApprovalAction(
  _prev: Prev<FlightFareApprovalChanged>,
  formData: FormData,
): Promise<FlightMoneyActionResult<FlightFareApprovalChanged>> {
  const staff = await requireStaff();
  const approvalId = readFlightUuid(formData, FM_FIELD.approvalId);
  const requestId = readFlightUuid(formData, FM_FIELD.requestId);
  const rv = readFlightRowVersion(formData);
  const dealId = readFlightUuid(formData, FM_FIELD.dealId);
  if (!approvalId || !requestId || rv === null) return fail('invalid_input');
  try {
    const result = await flightFareApprovalWithdraw(asRpcClient(staff.supabase), approvalId, rv, requestId);
    revalidateFlightMoney(dealId);
    return { ok: true, data: result, message: result.outcome === 'existing' ? FLIGHT_MONEY_DONE_TEXT.existing : FLIGHT_MONEY_DONE_TEXT.approvalWithdrawn };
  } catch (error) {
    return failFrom(error);
  }
}

// ---------------------------------------------------------------------------
// Payments (B9, B10)
// ---------------------------------------------------------------------------

/** Fields: batchId, dealId (optional), expectedRowVersion (only for a returned entry), paymentMode, paidOn, reference, proofEvidenceId, requestId. */
export async function saveFlightDirectPaymentAction(
  _prev: Prev<FlightDirectPaymentSaved>,
  formData: FormData,
): Promise<FlightMoneyActionResult<FlightDirectPaymentSaved>> {
  const staff = await requireStaff();
  const parsed = parseDirectPaymentForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  try {
    const result = await flightDirectPaymentSave(asRpcClient(staff.supabase), v.batchId, v.expectedRowVersion, v.fields, v.requestId);
    revalidateFlightMoney(v.dealId);
    return { ok: true, data: result, message: result.outcome === 'existing' ? FLIGHT_MONEY_DONE_TEXT.existing : FLIGHT_MONEY_DONE_TEXT.directPaymentSaved };
  } catch (error) {
    if (isCode(error, 'version_changed') || isCode(error, 'cost_locked') || isCode(error, 'payment_in_progress')) revalidateFlightMoney(v.dealId);
    return failFrom(error);
  }
}

/**
 * Fields: batchId (new request) or paymentId (send a returned request again),
 * dealId (optional), dueDate, note, proformaEvidenceId (optional), requestId.
 */
export async function createFlightPaymentRequestAction(
  _prev: Prev<FlightPaymentRequestCreated>,
  formData: FormData,
): Promise<FlightMoneyActionResult<FlightPaymentRequestCreated>> {
  const staff = await requireStaff();
  const parsed = parsePaymentRequestForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  const rpc = asRpcClient(staff.supabase);
  try {
    const result = v.paymentId
      ? await flightPaymentRequestResubmit(rpc, v.paymentId, v.fields, v.requestId)
      : await flightPaymentRequestCreate(rpc, v.batchId!, v.fields, v.requestId);
    revalidateFlightMoney(v.dealId);
    const done = result.route === 'manager' ? FLIGHT_MONEY_DONE_TEXT.requestCreatedManager : FLIGHT_MONEY_DONE_TEXT.requestCreatedAccounts;
    return { ok: true, data: result, message: result.outcome === 'existing' ? FLIGHT_MONEY_DONE_TEXT.existing : done };
  } catch (error) {
    if (isCode(error, 'payment_in_progress') || isCode(error, 'already_decided')) revalidateFlightMoney(v.dealId);
    return failFrom(error);
  }
}

/** Fields: paymentId, dealId (optional), expectedRowVersion, requestId. Pending requests only. */
export async function cancelFlightPaymentRequestAction(
  _prev: Prev<{ id: string; status: string; rowVersion: number }>,
  formData: FormData,
): Promise<FlightMoneyActionResult<{ id: string; status: string; rowVersion: number }>> {
  const staff = await requireStaff();
  const paymentId = readFlightUuid(formData, FM_FIELD.paymentId);
  const requestId = readFlightUuid(formData, FM_FIELD.requestId);
  const rv = readFlightRowVersion(formData);
  const dealId = readFlightUuid(formData, FM_FIELD.dealId);
  if (!paymentId || !requestId || rv === null) return fail('invalid_input');
  try {
    const result = await flightPaymentRequestCancel(asRpcClient(staff.supabase), paymentId, rv, requestId);
    revalidateFlightMoney(dealId);
    return {
      ok: true,
      data: { id: result.id, status: result.status, rowVersion: result.rowVersion },
      message: result.outcome === 'existing' ? FLIGHT_MONEY_DONE_TEXT.existing : FLIGHT_MONEY_DONE_TEXT.requestCancelled,
    };
  } catch (error) {
    return failFrom(error);
  }
}

// ---------------------------------------------------------------------------
// Suppliers (B2, B3)
// ---------------------------------------------------------------------------

/** Fields: name, city, contactName, contactPhone, contactEmail, requestId. The supplier serves flights only. */
export async function createFlightSupplierAction(
  _prev: Prev<FlightSupplierCreated>,
  formData: FormData,
): Promise<FlightMoneyActionResult<FlightSupplierCreated>> {
  const staff = await requireStaff();
  const parsed = parseSupplierForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  try {
    const result = await flightSupplierCreate(asRpcClient(staff.supabase), parsed.value.fields, parsed.value.requestId);
    revalidatePath('/app/flight/deals/[dealId]', 'page');
    revalidatePath('/app/approvals');
    return { ok: true, data: result, message: result.outcome === 'existing' ? FLIGHT_MONEY_DONE_TEXT.existing : FLIGHT_MONEY_DONE_TEXT.supplierCreated };
  } catch (error) {
    return failFrom(error);
  }
}

/**
 * Edit or archive a flight supplier (L15). Fields: supplierId,
 * expectedRowVersion, name, city, contactName, contactPhone, contactEmail,
 * status (active | archived; empty = unchanged).
 */
export async function updateFlightSupplierAction(
  _prev: Prev<{ supplierId: string; rowVersion: number }>,
  formData: FormData,
): Promise<FlightMoneyActionResult<{ supplierId: string; rowVersion: number }>> {
  const staff = await requireStaff();
  const parsed = parseSupplierUpdateForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  try {
    const result = await flightSupplierUpdate(asRpcClient(staff.supabase), v.supplierId, v.expectedRowVersion, v.fields);
    revalidatePath('/app/flight/deals/[dealId]', 'page');
    revalidatePath('/app/approvals');
    return {
      ok: true,
      data: result,
      message: v.fields.status === 'archived' ? FLIGHT_MONEY_DONE_TEXT.supplierArchived : FLIGHT_MONEY_DONE_TEXT.supplierUpdated,
    };
  } catch (error) {
    if (isCode(error, 'version_changed')) revalidatePath('/app/flight/deals/[dealId]', 'page');
    return failFrom(error);
  }
}

/** Fields: supplierId, accountHolder, bankName, ifsc, accountNumber, requestId. The branch Manager approves them later. */
export async function addFlightSupplierBeneficiaryAction(
  _prev: Prev<FlightBeneficiaryRecorded>,
  formData: FormData,
): Promise<FlightMoneyActionResult<FlightBeneficiaryRecorded>> {
  const staff = await requireStaff();
  const parsed = parseBeneficiaryForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  try {
    const result = await flightSupplierAddBeneficiary(asRpcClient(staff.supabase), v.supplierId, v.fields, v.requestId);
    revalidatePath('/app/flight/deals/[dealId]', 'page');
    revalidatePath('/app/approvals');
    return { ok: true, data: result, message: result.created ? FLIGHT_MONEY_DONE_TEXT.beneficiaryRecorded : FLIGHT_MONEY_DONE_TEXT.existing };
  } catch (error) {
    return failFrom(error);
  }
}

// ---------------------------------------------------------------------------
// Supplier files and invoices of a flight task
// ---------------------------------------------------------------------------

/**
 * Upload a proforma or a supplier invoice file of a flight task (private
 * bucket supplier-money). Fields: taskId, dealId (optional), kind (proforma |
 * invoice), requestId, file.
 */
export async function uploadFlightSupplierFileAction(
  _prev: Prev<{ evidenceId: string }>,
  formData: FormData,
): Promise<FlightMoneyActionResult<{ evidenceId: string }>> {
  const staff = await requireStaff();
  const taskId = readFlightUuid(formData, FM_FIELD.taskId);
  const requestId = readFlightUuid(formData, FM_FIELD.requestId);
  const dealId = readFlightUuid(formData, FM_FIELD.dealId);
  const kindRaw = formData.get(FM_FIELD.kind);
  const kind = kindRaw === 'proforma' || kindRaw === 'invoice' ? kindRaw : null;
  const file = formData.get(FM_FIELD.file);
  if (!taskId || !requestId || !kind) return fail('invalid_input', [!taskId ? FM_FIELD.taskId : !kind ? FM_FIELD.kind : FM_FIELD.requestId]);
  if (!(file instanceof Blob) || file.size === 0 || file.size > SUPPLIER_MONEY_MAX_BYTES) return fail('evidence_rejected', [FM_FIELD.file]);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkEvidenceFile({ bytes, declaredMime: file.type, fileName: 'name' in file && typeof file.name === 'string' ? file.name : '' });
  if (!check.ok) return fail('evidence_rejected', [FM_FIELD.file]);

  const rpc = asRpcClient(staff.supabase);
  let begun;
  try {
    begun = await evidenceBegin(rpc, { kind, targetId: taskId, fileName: check.fileName, mime: check.mime, sizeBytes: check.sizeBytes, sha256: check.sha256, requestId });
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
  if (!uploaded && begun.outcome === 'created') {
    await evidenceFinish(rpc, begun.evidenceId, false).catch(() => undefined);
    revalidateFlightMoney(dealId);
    return fail('upload_failed');
  }
  let status: 'stored' | 'failed' | null;
  try {
    status = (await evidenceFinish(rpc, begun.evidenceId, true)).status;
  } catch {
    status = null;
  }
  revalidateFlightMoney(dealId);
  if (status === 'stored') return { ok: true, data: { evidenceId: begun.evidenceId }, message: FLIGHT_MONEY_DONE_TEXT.fileUploaded };
  if (status === 'failed') return fail('upload_failed');
  return { ok: false, code: 'upload_failed', message: FLIGHT_MONEY_UNKNOWN_OUTCOME_TEXT };
}

/**
 * Record the supplier invoice of a flight task (after confirmation, also
 * after done). Fields: taskId, dealId (optional), supplierId (needed when the
 * task's batches have more than one supplier), number, docDate, totalRupees,
 * gstIncluded, evidenceId (a stored invoice file of the task), requestId.
 */
export async function saveFlightSupplierInvoiceAction(
  _prev: Prev<{ id: string; status: string; rowVersion: number }>,
  formData: FormData,
): Promise<FlightMoneyActionResult<{ id: string; status: string; rowVersion: number }>> {
  const staff = await requireStaff();
  const parsed = parseInvoiceForm(formData);
  const evidenceId = readFlightUuid(formData, 'evidenceId');
  if (!parsed.ok || !evidenceId) return fail('invalid_input', parsed.ok ? ['evidenceId'] : parsed.fields);
  const v = parsed.value;
  try {
    const fields = {
      kind: 'invoice' as const,
      number: v.number,
      docDate: v.docDate,
      totalPaise: v.totalPaise,
      gstIncluded: v.gstIncluded,
      evidenceId,
      ...(v.supplierId ? { supplierId: v.supplierId } : {}),
    };
    const result = await documentUpload(asRpcClient(staff.supabase), v.taskId, fields, v.requestId);
    revalidateFlightMoney(v.dealId);
    return {
      ok: true,
      data: { id: result.id, status: result.status, rowVersion: result.rowVersion },
      message: result.outcome === 'existing' ? FLIGHT_MONEY_DONE_TEXT.existing : FLIGHT_MONEY_DONE_TEXT.invoiceUploaded,
    };
  } catch (error) {
    return failFrom(error);
  }
}
