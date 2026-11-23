'use server';

import { revalidatePath } from 'next/cache';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { readUuid, rupeesToPaise } from '@/modules/fulfilment/forms';
import { requireStaff } from '@/modules/identity/server/session';
import {
  type RefundRequestFields,
  RefundCommandError,
  refundDecide,
  refundPayoutRecord,
  refundRequestCreate,
  refundRequestResubmit,
  refundRequestWithdraw,
  setRefundsEnabled,
  supplierRefundCancel,
  supplierRefundRecord,
} from '../commands';
import {
  PAYEE_KINDS,
  PAYOUT_MODES,
  REFUND_DONE_TEXT,
  REFUND_ERROR_TEXT,
  REFUND_EVIDENCE_SUBJECTS,
  REFUND_FIELD as F,
  REFUND_KINDS,
  REFUND_OUTCOMES,
  REFUND_PATHS,
  REFUND_UNKNOWN_OUTCOME_TEXT,
  SUPPLIER_REFUND_MODES,
  SUPPLIER_REFUND_SOURCES,
  type PayeeKind,
  type PayoutMode,
  type RefundActionResult,
  type RefundCommandResult,
  type RefundErrorCode,
  type RefundEvidenceSubject,
  type RefundKind,
  type RefundOutcome,
  type RefundsSwitchResult,
  type SupplierRefundMode,
  type SupplierRefundResult,
  type SupplierRefundSource,
} from '../contracts';
import { storeRefundEvidence, type StoreRefundEvidenceResult } from './evidence';
import { refundProofRequestId } from './proof-id';

/**
 * Refund commands (one useActionState action per command, Addendum L3):
 * (prev, formData) => {ok: true, message, data} | {ok: false, code, message,
 * field?}. Every action: requireStaff(); read the form (never the actor,
 * entity, branch or status); run the database command under the staff
 * member's OWN session; revalidate the refund pages and the Deal page.
 * Staff-typed money arrives as <key>Rupees and is converted to whole paise
 * exactly (more than 2 decimals refused); approval-binding values arrive as
 * hidden paise. A refusal's field is the contract key (amountPaise, ...).
 * Database messages never reach the browser; nothing here logs amounts,
 * references, reasons or names.
 */

type Prev<T> = RefundActionResult<T> | null;
type Failure = Extract<RefundActionResult<never>, { ok: false }>;
type FailCode = RefundErrorCode | 'session' | 'file_rejected' | 'upload_failed';

function fail(code: FailCode, values?: Record<string, string>, field?: string): Failure {
  return { ok: false, code, message: REFUND_ERROR_TEXT[code], ...(field ? { field } : {}), ...(values ? { values } : {}) };
}

/** Known refusals become frozen text; anything else is rethrown without detail (the command may have committed). */
function failFrom(error: unknown, values?: Record<string, string>): Failure {
  if (error instanceof RefundCommandError && error.code) {
    const field = error.code === 'invalid_input' || error.code === 'refund_exceeds_money' || error.code === 'over_expected'
      ? (error.hint ?? undefined) : undefined;
    return fail(error.code, values, field);
  }
  throw new Error(REFUND_UNKNOWN_OUTCOME_TEXT);
}

function failFromEvidence(result: Exclude<StoreRefundEvidenceResult, { ok: true }>, values: Record<string, string>): Failure {
  if (result.code === 'unknown') throw new Error(REFUND_UNKNOWN_OUTCOME_TEXT);
  return fail(result.code, values, result.code === 'file_rejected' || result.code === 'upload_failed' ? F.file : result.field);
}

function revalidateRefunds(dealId?: string | null): void {
  for (const path of REFUND_PATHS) revalidatePath(path);
  if (dealId) revalidatePath(`/app/deals/${dealId}`);
  else revalidatePath('/app/deals/[id]', 'page');
}

function str(formData: FormData, name: string, max: number): string | null {
  const value = formData.get(name);
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v === '' || v.length > max ? null : v;
}

function typed(formData: FormData, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = formData.get(n);
    if (typeof v === 'string') out[n] = v.slice(0, 600);
  }
  return out;
}

function readRowVersion(formData: FormData): number | null {
  const raw = str(formData, F.expectedRowVersion, 10);
  if (raw === null || !/^\d{1,9}$/.test(raw)) return null;
  return Number(raw);
}

function readEnum<T extends string>(formData: FormData, name: string, values: readonly T[]): T | null {
  const v = str(formData, name, 40);
  return v !== null && (values as readonly string[]).includes(v) ? (v as T) : null;
}

function readReason(formData: FormData, name: string = F.reason): string | null {
  const reason = str(formData, name, 500);
  return reason && reason.length >= 10 ? reason : null;
}

const PAISE = /^(0|[1-9][0-9]{0,17})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A rupee input: null when blank, undefined when not a valid amount (more than 2 decimals, letters). */
function readRupees(formData: FormData, name: string): string | null | undefined {
  const raw = formData.get(name);
  return rupeesToPaise(typeof raw === 'string' ? raw.slice(0, 30) : undefined);
}

const REQUEST_VALUES = [F.kind, F.outcome, F.customerChargeRupees, F.amountRupees, F.payeeKind, F.payeeReceiptId, F.payeeName,
  F.payeeReason, F.reason, F.useKeptCredit];

/** C1/C2 fields from the form; field = the contract key of the first bad input. */
function readRequestFields(formData: FormData): { ok: true; fields: RefundRequestFields } | { ok: false; field: string } {
  const kind = readEnum<RefundKind>(formData, F.kind, REFUND_KINDS);
  if (!kind) return { ok: false, field: 'kind' };
  const outcome = readEnum<RefundOutcome>(formData, F.outcome, REFUND_OUTCOMES);
  if (!outcome) return { ok: false, field: 'outcome' };
  const charge = readRupees(formData, F.customerChargeRupees);
  if (charge === undefined) return { ok: false, field: 'customerChargePaise' };
  const amount = readRupees(formData, F.amountRupees);
  if (amount === undefined) return { ok: false, field: 'amountPaise' };
  const reason = readReason(formData);
  if (!reason) return { ok: false, field: 'reason' };
  let payeeKind: PayeeKind | null = null;
  let payeeReceiptId: string | null = null;
  let payeeName: string | null = null;
  let payeeReason: string | null = null;
  if (outcome === 'payout') {
    payeeKind = readEnum<PayeeKind>(formData, F.payeeKind, PAYEE_KINDS);
    if (!payeeKind) return { ok: false, field: 'payeeKind' };
    if (payeeKind === 'original_payer') {
      payeeReceiptId = readUuid(formData, F.payeeReceiptId);
      if (!payeeReceiptId) return { ok: false, field: 'payeeReceiptId' };
    } else {
      payeeName = str(formData, F.payeeName, 200);
      if (!payeeName) return { ok: false, field: 'payeeName' };
      payeeReason = readReason(formData, F.payeeReason);
      if (!payeeReason) return { ok: false, field: 'payeeReason' };
    }
  }
  return {
    ok: true,
    fields: {
      kind,
      outcome,
      customerChargePaise: kind === 'cancellation' ? (charge ?? '0') : null,
      amountPaise: outcome === 'charge_only' ? '0' : amount,
      payeeKind,
      payeeReceiptId,
      payeeName,
      payeeReason,
      reason,
      // Addendum L7: 'true' sends useKeptCredit (payout only).
      ...(outcome === 'payout' && str(formData, F.useKeptCredit, 5) === 'true' ? { useKeptCredit: true } : {}),
    },
  };
}

function doneText(result: { outcome: string }, text: string): string {
  return result.outcome === 'existing' ? REFUND_DONE_TEXT.existing : text;
}

// ---------------------------------------------------------------------------
// C1-C4 requests and the Manager decision
// ---------------------------------------------------------------------------

/** Fields: dealId, kind, outcome, customerChargeRupees, amountRupees, payeeKind, payeeReceiptId, payeeName, payeeReason, reason, requestId. */
export async function requestRefundAction(_prev: Prev<RefundCommandResult>, formData: FormData): Promise<RefundActionResult<RefundCommandResult>> {
  const staff = await requireStaff();
  const values = typed(formData, REQUEST_VALUES);
  const dealId = readUuid(formData, F.dealId);
  const requestId = readUuid(formData, F.requestId);
  if (!dealId || !requestId) return fail('invalid_input', values);
  const parsed = readRequestFields(formData);
  if (!parsed.ok) return fail('invalid_input', values, parsed.field);
  try {
    const result = await refundRequestCreate(asRpcClient(staff.supabase), dealId, parsed.fields, requestId);
    revalidateRefunds(dealId);
    return { ok: true, data: result, message: doneText(result, REFUND_DONE_TEXT.requested) };
  } catch (error) {
    return failFrom(error, values);
  }
}

/** Fields: refundRequestId, expectedRowVersion, dealId (optional), the C1 fields, requestId. */
export async function resubmitRefundAction(_prev: Prev<RefundCommandResult>, formData: FormData): Promise<RefundActionResult<RefundCommandResult>> {
  const staff = await requireStaff();
  const values = typed(formData, REQUEST_VALUES);
  const id = readUuid(formData, F.refundRequestId);
  const rowVersion = readRowVersion(formData);
  const requestId = readUuid(formData, F.requestId);
  if (!id || rowVersion === null || !requestId) return fail('invalid_input', values);
  const parsed = readRequestFields(formData);
  if (!parsed.ok) return fail('invalid_input', values, parsed.field);
  try {
    const result = await refundRequestResubmit(asRpcClient(staff.supabase), id, rowVersion, parsed.fields, requestId);
    revalidateRefunds(readUuid(formData, F.dealId));
    return { ok: true, data: result, message: doneText(result, REFUND_DONE_TEXT.resubmitted) };
  } catch (error) {
    return failFrom(error, values);
  }
}

/** Fields: refundRequestId, expectedRowVersion, reason, dealId (optional), requestId. */
export async function withdrawRefundAction(_prev: Prev<RefundCommandResult>, formData: FormData): Promise<RefundActionResult<RefundCommandResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.reason]);
  const id = readUuid(formData, F.refundRequestId);
  const rowVersion = readRowVersion(formData);
  const requestId = readUuid(formData, F.requestId);
  if (!id || rowVersion === null || !requestId) return fail('invalid_input', values);
  const reason = readReason(formData);
  if (!reason) return fail('invalid_input', values, 'reason');
  try {
    const result = await refundRequestWithdraw(asRpcClient(staff.supabase), id, rowVersion, reason, requestId);
    revalidateRefunds(readUuid(formData, F.dealId));
    return { ok: true, data: result, message: doneText(result, REFUND_DONE_TEXT.withdrawn) };
  } catch (error) {
    return failFrom(error, values);
  }
}

/** Fields: refundRequestId, decision (approve|return), expectedAmountPaise, expectedChargePaise (hidden), reason (return), expectedRowVersion, dealId (optional), requestId. */
export async function decideRefundAction(_prev: Prev<RefundCommandResult>, formData: FormData): Promise<RefundActionResult<RefundCommandResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.reason]);
  const id = readUuid(formData, F.refundRequestId);
  const rowVersion = readRowVersion(formData);
  const requestId = readUuid(formData, F.requestId);
  const decision = readEnum<'approve' | 'return'>(formData, F.decision, ['approve', 'return']);
  const amount = str(formData, F.expectedAmountPaise, 20);
  const charge = str(formData, F.expectedChargePaise, 20);
  if (!id || rowVersion === null || !requestId || !decision || !amount || !PAISE.test(amount) || !charge || !PAISE.test(charge)) {
    return fail('invalid_input', values);
  }
  const reason = decision === 'return' ? readReason(formData) : null;
  if (decision === 'return' && !reason) return fail('invalid_input', values, 'reason');
  try {
    const result = await refundDecide(asRpcClient(staff.supabase), { id, decision, expectedAmountPaise: amount, expectedChargePaise: charge,
      reason, expectedRowVersion: rowVersion, requestId });
    revalidateRefunds(readUuid(formData, F.dealId));
    return { ok: true, data: result, message: doneText(result, decision === 'approve' ? REFUND_DONE_TEXT.approved : REFUND_DONE_TEXT.returned) };
  } catch (error) {
    return failFrom(error, values);
  }
}

// ---------------------------------------------------------------------------
// C5 proof and C6 payout (one Accounts person records and verifies, Q6)
// ---------------------------------------------------------------------------

/** Fields: subjectKind (customer_refund|supplier_refund), subjectId (refund request / cancellation case), file, requestId. */
export async function uploadRefundProofAction(_prev: Prev<{ evidenceId: string }>, formData: FormData): Promise<RefundActionResult<{ evidenceId: string }>> {
  const staff = await requireStaff();
  const subjectKind = readEnum<RefundEvidenceSubject>(formData, F.subjectKind, REFUND_EVIDENCE_SUBJECTS);
  const subjectId = readUuid(formData, F.subjectId);
  const requestId = readUuid(formData, F.requestId);
  if (!subjectKind || !subjectId || !requestId) return fail('invalid_input', {});
  const stored = await storeRefundEvidence(staff, { subjectKind, subjectId, file: formData.get(F.file), requestId });
  if (!stored.ok) return failFromEvidence(stored, {});
  return { ok: true, data: { evidenceId: stored.evidenceId }, message: REFUND_DONE_TEXT.proofStored };
}

/** Proof from the form: an already stored evidenceId, else the uploaded file (request id derived from the command's). */
async function proofFor(staff: Awaited<ReturnType<typeof requireStaff>>, formData: FormData, subjectKind: RefundEvidenceSubject,
  subjectId: string, requestId: string, values: Record<string, string>): Promise<{ ok: true; evidenceId: string } | { ok: false; failure: Failure }> {
  const given = readUuid(formData, F.evidenceId);
  if (given) return { ok: true, evidenceId: given };
  const file = formData.get(F.file);
  if (!(file instanceof Blob) || file.size === 0) return { ok: false, failure: fail('evidence_missing', values, F.file) };
  const stored = await storeRefundEvidence(staff, { subjectKind, subjectId, file, requestId: refundProofRequestId(requestId) });
  if (!stored.ok) return { ok: false, failure: failFromEvidence(stored, values) };
  return { ok: true, evidenceId: stored.evidenceId };
}

/** Fields: refundRequestId, expectedRowVersion, mode, paidOn, reference (blank only for cash), file or evidenceId, dealId (optional), requestId. */
export async function payOutRefundAction(_prev: Prev<RefundCommandResult>, formData: FormData): Promise<RefundActionResult<RefundCommandResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.mode, F.paidOn, F.reference]);
  const id = readUuid(formData, F.refundRequestId);
  const rowVersion = readRowVersion(formData);
  const requestId = readUuid(formData, F.requestId);
  if (!id || rowVersion === null || !requestId) return fail('invalid_input', values);
  const mode = readEnum<PayoutMode>(formData, F.mode, PAYOUT_MODES);
  if (!mode) return fail('invalid_input', values, 'mode');
  const paidOn = str(formData, F.paidOn, 10);
  if (!paidOn || !DATE.test(paidOn)) return fail('invalid_input', values, 'paidOn');
  const reference = str(formData, F.reference, 40);
  if ((mode !== 'cash' && !reference) || (reference && !/^[A-Za-z0-9/-]{4,40}$/.test(reference))) {
    return fail('invalid_input', values, 'reference');
  }
  const proof = await proofFor(staff, formData, 'customer_refund', id, requestId, values);
  if (!proof.ok) return proof.failure;
  try {
    const result = await refundPayoutRecord(asRpcClient(staff.supabase), id, rowVersion,
      { mode, paidOn, reference, evidenceId: proof.evidenceId }, requestId);
    revalidateRefunds(readUuid(formData, F.dealId));
    return { ok: true, data: result, message: doneText(result, REFUND_DONE_TEXT.paid) };
  } catch (error) {
    return failFrom(error, values);
  }
}

// ---------------------------------------------------------------------------
// C7/C8 supplier refunds (Addendum L1: one step; cancel with reason)
// ---------------------------------------------------------------------------

/** Fields: cancellationId or changeRequestId (subject of the proof; a 'reconfirmation' source names its change request), sourceKind, sourceId, amountRupees, receivedOn, mode, reference, overExpectedReason, file or evidenceId, dealId (optional), requestId. */
export async function recordSupplierRefundAction(_prev: Prev<SupplierRefundResult>, formData: FormData): Promise<RefundActionResult<SupplierRefundResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.amountRupees, F.receivedOn, F.mode, F.reference, F.overExpectedReason]);
  const requestId = readUuid(formData, F.requestId);
  const sourceKind = readEnum<SupplierRefundSource>(formData, F.sourceKind, SUPPLIER_REFUND_SOURCES);
  const sourceId = readUuid(formData, F.sourceId);
  // Accounts phase 3: a reconfirmation source's proof belongs to its change request.
  const subjectId = sourceKind === 'reconfirmation' ? readUuid(formData, 'changeRequestId') : readUuid(formData, 'cancellationId');
  if (!subjectId || !requestId || !sourceKind || !sourceId) return fail('invalid_input', values);
  const amount = readRupees(formData, F.amountRupees);
  if (!amount || amount === '0') return fail('invalid_input', values, 'amountPaise');
  const receivedOn = str(formData, F.receivedOn, 10);
  if (!receivedOn || !DATE.test(receivedOn)) return fail('invalid_input', values, 'receivedOn');
  const mode = readEnum<SupplierRefundMode>(formData, F.mode, SUPPLIER_REFUND_MODES);
  if (!mode) return fail('invalid_input', values, 'mode');
  const reference = str(formData, F.reference, 40);
  if (!reference || !/^[A-Za-z0-9/-]{4,40}$/.test(reference)) return fail('invalid_input', values, 'reference');
  const overRaw = str(formData, F.overExpectedReason, 500);
  if (overRaw !== null && overRaw.length < 10) return fail('invalid_input', values, 'overExpectedReason');
  const proof = await proofFor(staff, formData, 'supplier_refund', subjectId, requestId, values);
  if (!proof.ok) return proof.failure;
  try {
    const result = await supplierRefundRecord(asRpcClient(staff.supabase), { sourceKind, sourceId, amountPaise: amount, receivedOn, mode,
      reference, evidenceId: proof.evidenceId, overExpectedReason: overRaw }, requestId);
    revalidateRefunds(readUuid(formData, F.dealId));
    return { ok: true, data: result, message: doneText(result, REFUND_DONE_TEXT.supplierRefundRecorded) };
  } catch (error) {
    return failFrom(error, values);
  }
}

/** Fields: supplierRefundId, expectedRowVersion, reason, dealId (optional), requestId. */
export async function cancelSupplierRefundAction(_prev: Prev<SupplierRefundResult>, formData: FormData): Promise<RefundActionResult<SupplierRefundResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.reason]);
  const id = readUuid(formData, F.supplierRefundId);
  const rowVersion = readRowVersion(formData);
  const requestId = readUuid(formData, F.requestId);
  if (!id || rowVersion === null || !requestId) return fail('invalid_input', values);
  const reason = readReason(formData);
  if (!reason) return fail('invalid_input', values, 'reason');
  try {
    const result = await supplierRefundCancel(asRpcClient(staff.supabase), id, rowVersion, reason, requestId);
    revalidateRefunds(readUuid(formData, F.dealId));
    return { ok: true, data: result, message: doneText(result, REFUND_DONE_TEXT.supplierRefundCancelled) };
  } catch (error) {
    return failFrom(error, values);
  }
}

// ---------------------------------------------------------------------------
// C12 refunds switch
// ---------------------------------------------------------------------------

/** Fields: entityId, enabled ('true'|'false'), reason. */
export async function setRefundsEnabledAction(_prev: Prev<RefundsSwitchResult>, formData: FormData): Promise<RefundActionResult<RefundsSwitchResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.reason]);
  const entityId = readUuid(formData, F.entityId);
  const enabledRaw = str(formData, F.enabled, 5);
  if (!entityId || (enabledRaw !== 'true' && enabledRaw !== 'false')) return fail('invalid_input', values);
  const reason = readReason(formData);
  if (!reason) return fail('invalid_input', values, 'reason');
  try {
    const result = await setRefundsEnabled(asRpcClient(staff.supabase), entityId, enabledRaw === 'true', reason);
    revalidatePath('/app/admin/accounts');
    revalidateRefunds();
    return { ok: true, data: result, message: result.changed ? REFUND_DONE_TEXT.switched : REFUND_DONE_TEXT.existing };
  } catch (error) {
    return failFrom(error, values);
  }
}
