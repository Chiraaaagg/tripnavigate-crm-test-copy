'use server';

import { asRpcClient } from '@/modules/fulfilment/commands';
import { requireStaff } from '@/modules/identity/server/session';
import {
  visaApplicationConfirmTraveller,
  visaApplicationDecide,
  visaApplicationDocumentAdd,
  visaApplicationDocumentRemove,
  visaApplicationMarkDelivered,
  visaApplicationReapply,
  visaApplicationSetHandover,
  visaApplicationSetRow,
  visaApplicationsApply,
  visaApplicationWithdraw,
  visaFeeSend,
  visaOtherCostSave,
  visaResultNoticeAck,
  visaTaskClaim,
} from '../commands';
import {
  type VisaActionResult,
  type VisaApplicationResult,
  type VisaApplyResult,
  type VisaClaimResult,
  type VisaDocumentResult,
  type VisaFeeSendResult,
  type VisaNoticeAckResult,
  type VisaOtherCostResult,
  type VisaReapplyResult,
  type VisaRowSaveResult,
  VISA_DONE_TEXT,
  VISA_FIELD,
} from '../contracts';
import {
  parseApplicationTarget,
  parseApplyForm,
  parseDecideForm,
  parseDeliveredForm,
  parseDocumentAddForm,
  parseDocumentRemoveForm,
  parseFeeSendForm,
  parseHandoverForm,
  parseOtherCostForm,
  parseRowForm,
  parseWithdrawForm,
  readUuid,
} from '../forms';
import { fail, failFrom, isVisaCode, revalidateVisa, withClosure } from './results';

/**
 * Visa and Passport desk commands (contract section 6), one action per
 * command for useActionState: requireStaff(); parse the form (never the
 * actor, entity, assignee or state); run the database command under the
 * staff member's OWN session with the screen's request id. The database
 * checks the Visa assignee, every state rule, the receipt and proof rules and
 * audits in the same transaction. Messages are frozen wording; database
 * messages never reach the browser.
 */

type Prev<T> = VisaActionResult<T> | null;

// ---------------------------------------------------------------------------
// C1 take
// ---------------------------------------------------------------------------

/** "Take this task" (Visa people only; the Manager never takes). */
export async function claimVisaTaskAction(_prev: Prev<VisaClaimResult>, formData: FormData): Promise<VisaActionResult<VisaClaimResult>> {
  const staff = await requireStaff();
  const taskId = readUuid(formData, VISA_FIELD.taskId);
  const dealId = readUuid(formData, VISA_FIELD.dealId);
  if (!taskId) return fail('invalid_input', [VISA_FIELD.taskId]);
  try {
    const result = await visaTaskClaim(asRpcClient(staff.supabase), taskId);
    revalidateVisa(taskId, dealId);
    return { ok: true, data: result, message: result.alreadyYours ? VISA_DONE_TEXT.claimedExisting : VISA_DONE_TEXT.claimed };
  } catch (error) {
    if (isVisaCode(error, 'task_conflict')) revalidateVisa(taskId, dealId);
    return failFrom(error);
  }
}

// ---------------------------------------------------------------------------
// C2 - C4 Passengers table
// ---------------------------------------------------------------------------

/** Passengers row Save: appointment, documents received, passport number, remark, kind/jurisdiction while Sales left them blank. */
export async function saveVisaRowAction(_prev: Prev<VisaRowSaveResult>, formData: FormData): Promise<VisaActionResult<VisaRowSaveResult>> {
  const staff = await requireStaff();
  const parsed = parseRowForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const { target, fields } = parsed.value;
  try {
    const result = await visaApplicationSetRow(asRpcClient(staff.supabase), {
      applicationId: target.applicationId, expectedRowVersion: target.expectedRowVersion, fields, requestId: target.requestId,
    });
    revalidateVisa(target.taskId, target.dealId);
    return { ok: true, data: result, message: result.ready ? VISA_DONE_TEXT.rowSavedReady : VISA_DONE_TEXT.rowSaved };
  } catch (error) {
    if (isVisaCode(error, 'version_changed', 'wrong_state', 'application_closed')) revalidateVisa(target.taskId, target.dealId);
    return failFrom(error);
  }
}

/** Add document: a catalogue item or "Other" with a typed name (a typed catalogue name takes its code). */
export async function addVisaDocumentAction(_prev: Prev<VisaDocumentResult>, formData: FormData): Promise<VisaActionResult<VisaDocumentResult>> {
  const staff = await requireStaff();
  const parsed = parseDocumentAddForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const { target, fields } = parsed.value;
  try {
    const result = await visaApplicationDocumentAdd(asRpcClient(staff.supabase), {
      applicationId: target.applicationId, expectedRowVersion: target.expectedRowVersion, fields, requestId: target.requestId,
    });
    revalidateVisa(target.taskId, target.dealId);
    return { ok: true, data: result, message: VISA_DONE_TEXT.documentAdded };
  } catch (error) {
    if (isVisaCode(error, 'version_changed', 'wrong_state')) revalidateVisa(target.taskId, target.dealId);
    return failFrom(error);
  }
}

/** Remove a not-received document before Applied (expectedRowVersion = the passenger's row version). */
export async function removeVisaDocumentAction(_prev: Prev<VisaDocumentResult>, formData: FormData): Promise<VisaActionResult<VisaDocumentResult>> {
  const staff = await requireStaff();
  const parsed = parseDocumentRemoveForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  try {
    const result = await visaApplicationDocumentRemove(asRpcClient(staff.supabase), {
      documentId: v.documentId, expectedRowVersion: v.expectedRowVersion, requestId: v.requestId,
    });
    revalidateVisa(v.taskId, v.dealId);
    return { ok: true, data: result, message: VISA_DONE_TEXT.documentRemoved };
  } catch (error) {
    if (isVisaCode(error, 'version_changed', 'document_received', 'wrong_state')) revalidateVisa(v.taskId, v.dealId);
    return failFrom(error);
  }
}

/** "OK, checked" on a traveller whose name or type changed in the booking. */
export async function confirmVisaTravellerAction(_prev: Prev<VisaApplicationResult>, formData: FormData): Promise<VisaActionResult<VisaApplicationResult>> {
  const staff = await requireStaff();
  const parsed = parseApplicationTarget(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const t = parsed.value;
  try {
    const result = await visaApplicationConfirmTraveller(asRpcClient(staff.supabase), {
      applicationId: t.applicationId, expectedRowVersion: t.expectedRowVersion, requestId: t.requestId,
    });
    revalidateVisa(t.taskId, t.dealId);
    return { ok: true, data: result, message: VISA_DONE_TEXT.travellerConfirmed };
  } catch (error) {
    if (isVisaCode(error, 'version_changed')) revalidateVisa(t.taskId, t.dealId);
    return failFrom(error);
  }
}

// ---------------------------------------------------------------------------
// C5 Applied (one or several passengers, one transaction)
// ---------------------------------------------------------------------------

/** Mark as applied / Confirm applied. Nothing is saved for anyone when one line is refused. */
export async function applyVisaApplicationsAction(_prev: Prev<VisaApplyResult>, formData: FormData): Promise<VisaActionResult<VisaApplyResult>> {
  const staff = await requireStaff();
  const parsed = parseApplyForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  try {
    const result = await visaApplicationsApply(asRpcClient(staff.supabase), { taskId: v.taskId, fields: v.fields, requestId: v.requestId });
    revalidateVisa(v.taskId, v.dealId, { accounts: true });
    const n = result.applications.length;
    const base = n > 1 ? VISA_DONE_TEXT.appliedMany.replace('{n}', String(n)) : VISA_DONE_TEXT.appliedOne;
    return { ok: true, data: result, message: withClosure(base, false, result.taskCompleted) };
  } catch (error) {
    if (isVisaCode(error, 'version_changed', 'wrong_state', 'not_ready', 'traveller_changed', 'applicant_removed')) {
      revalidateVisa(v.taskId, v.dealId);
    }
    return failFrom(error);
  }
}

// ---------------------------------------------------------------------------
// C6 - C10 decision, handover, delivery, withdrawal, apply again
// ---------------------------------------------------------------------------

/** Approve / Reject (decision = approved | rejected); the visa or refusal document is required (Q3). */
export async function decideVisaApplicationAction(_prev: Prev<VisaApplicationResult>, formData: FormData): Promise<VisaActionResult<VisaApplicationResult>> {
  const staff = await requireStaff();
  const parsed = parseDecideForm(formData);
  if (!parsed.ok) {
    // The proof is the one rule with its own refusal: say "upload the document first".
    if (parsed.fields.length === 1 && parsed.fields[0] === VISA_FIELD.outcomeEvidenceId) return fail('outcome_document_required', parsed.fields);
    return fail('invalid_input', parsed.fields);
  }
  const { target, fields } = parsed.value;
  try {
    const result = await visaApplicationDecide(asRpcClient(staff.supabase), {
      applicationId: target.applicationId, expectedRowVersion: target.expectedRowVersion, fields, requestId: target.requestId,
    });
    revalidateVisa(target.taskId, target.dealId);
    const base = fields.decision === 'approved' ? VISA_DONE_TEXT.approved : VISA_DONE_TEXT.rejected;
    return { ok: true, data: result, message: withClosure(base, result.closed, result.taskCompleted) };
  } catch (error) {
    if (isVisaCode(error, 'version_changed', 'wrong_state', 'application_closed')) revalidateVisa(target.taskId, target.dealId);
    return failFrom(error);
  }
}

/** Set handover / Record handover (method; legacy e-visa: the e-mail; legacy refused e-visa: customer told). */
export async function setVisaHandoverAction(_prev: Prev<VisaApplicationResult>, formData: FormData): Promise<VisaActionResult<VisaApplicationResult>> {
  const staff = await requireStaff();
  const parsed = parseHandoverForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const { target, fields } = parsed.value;
  try {
    const result = await visaApplicationSetHandover(asRpcClient(staff.supabase), {
      applicationId: target.applicationId, expectedRowVersion: target.expectedRowVersion, fields, requestId: target.requestId,
    });
    revalidateVisa(target.taskId, target.dealId);
    return { ok: true, data: result, message: withClosure(VISA_DONE_TEXT.handoverSaved, result.closed, result.taskCompleted) };
  } catch (error) {
    if (isVisaCode(error, 'version_changed', 'already_recorded', 'application_closed')) revalidateVisa(target.taskId, target.dealId);
    return failFrom(error);
  }
}

/** Mark delivered (office or executive handover; delivered on today or earlier). */
export async function markVisaDeliveredAction(_prev: Prev<VisaApplicationResult>, formData: FormData): Promise<VisaActionResult<VisaApplicationResult>> {
  const staff = await requireStaff();
  const parsed = parseDeliveredForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const { target, fields } = parsed.value;
  try {
    const result = await visaApplicationMarkDelivered(asRpcClient(staff.supabase), {
      applicationId: target.applicationId, expectedRowVersion: target.expectedRowVersion, fields, requestId: target.requestId,
    });
    revalidateVisa(target.taskId, target.dealId);
    return { ok: true, data: result, message: withClosure(VISA_DONE_TEXT.delivered, result.closed, result.taskCompleted) };
  } catch (error) {
    if (isVisaCode(error, 'version_changed', 'wrong_state', 'application_closed')) revalidateVisa(target.taskId, target.dealId);
    return failFrom(error);
  }
}

/** Withdrawn by customer: reason and "the customer has been told" required; optional handover when the passport is with us. */
export async function withdrawVisaApplicationAction(_prev: Prev<VisaApplicationResult>, formData: FormData): Promise<VisaActionResult<VisaApplicationResult>> {
  const staff = await requireStaff();
  const parsed = parseWithdrawForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const { target, fields } = parsed.value;
  try {
    const result = await visaApplicationWithdraw(asRpcClient(staff.supabase), {
      applicationId: target.applicationId, expectedRowVersion: target.expectedRowVersion, fields, requestId: target.requestId,
    });
    revalidateVisa(target.taskId, target.dealId, { accounts: true });
    return { ok: true, data: result, message: withClosure(VISA_DONE_TEXT.withdrawn, result.closed, result.taskCompleted) };
  } catch (error) {
    if (isVisaCode(error, 'version_changed', 'wrong_state', 'application_closed')) revalidateVisa(target.taskId, target.dealId);
    return failFrom(error);
  }
}

/** Apply again after a rejection: a new application row ("Second application"); the rejected one stays in History. */
export async function reapplyVisaApplicationAction(_prev: Prev<VisaReapplyResult>, formData: FormData): Promise<VisaActionResult<VisaReapplyResult>> {
  const staff = await requireStaff();
  const parsed = parseApplicationTarget(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const t = parsed.value;
  try {
    const result = await visaApplicationReapply(asRpcClient(staff.supabase), {
      applicationId: t.applicationId, expectedRowVersion: t.expectedRowVersion, requestId: t.requestId,
    });
    revalidateVisa(t.taskId, t.dealId);
    return { ok: true, data: result, message: VISA_DONE_TEXT.reapplied };
  } catch (error) {
    if (isVisaCode(error, 'version_changed', 'wrong_state', 'application_closed')) revalidateVisa(t.taskId, t.dealId);
    return failFrom(error);
  }
}

// ---------------------------------------------------------------------------
// C12 fees, C14 notices
// ---------------------------------------------------------------------------

/** Fix fee (returned) / Send fee to Accounts (receipt-less draft): amount, receipt, remark; submitted in one step. */
export async function sendVisaFeeAction(_prev: Prev<VisaFeeSendResult>, formData: FormData): Promise<VisaActionResult<VisaFeeSendResult>> {
  const staff = await requireStaff();
  const parsed = parseFeeSendForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  try {
    const result = await visaFeeSend(asRpcClient(staff.supabase), {
      entryId: v.entryId, expectedRowVersion: v.expectedRowVersion, fields: v.fields, requestId: v.requestId,
    });
    revalidateVisa(v.taskId, v.dealId, { accounts: true });
    return { ok: true, data: result, message: VISA_DONE_TEXT.feeSent };
  } catch (error) {
    if (isVisaCode(error, 'version_changed', 'cost_locked', 'wrong_state')) revalidateVisa(v.taskId, v.dealId, { accounts: true });
    return failFrom(error);
  }
}

/**
 * Section 16 (VL18 changed): record or correct an "other" visa cost of one
 * passenger (for example courier). Company-paid ones are drafts until sent
 * to Accounts with the receipt (sendVisaFeeAction); customer-paid ones are
 * recorded only. Task-level manual visa entries stay refused (visaFees).
 */
export async function saveVisaOtherCostAction(_prev: Prev<VisaOtherCostResult>, formData: FormData): Promise<VisaActionResult<VisaOtherCostResult>> {
  const staff = await requireStaff();
  const parsed = parseOtherCostForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  try {
    const result = await visaOtherCostSave(asRpcClient(staff.supabase), {
      taskId: v.taskId, entryId: v.entryId, expectedRowVersion: v.expectedRowVersion, fields: v.fields, requestId: v.requestId,
    });
    revalidateVisa(v.taskId, v.dealId, { accounts: true });
    const draft = result.expenseStatus === 'draft' || result.expenseStatus === 'returned';
    return { ok: true, data: result, message: draft ? VISA_DONE_TEXT.otherCostSavedDraft : VISA_DONE_TEXT.otherCostSaved };
  } catch (error) {
    if (isVisaCode(error, 'version_changed', 'cost_locked')) revalidateVisa(v.taskId, v.dealId, { accounts: true });
    return failFrom(error);
  }
}

/** "OK, seen" on a visa result notice (Deal page / Home; the Deal's Sales owner, or the Manager without one). */
export async function acknowledgeVisaNoticeAction(_prev: Prev<VisaNoticeAckResult>, formData: FormData): Promise<VisaActionResult<VisaNoticeAckResult>> {
  const staff = await requireStaff();
  const noticeId = readUuid(formData, VISA_FIELD.noticeId);
  const dealId = readUuid(formData, VISA_FIELD.dealId);
  if (!noticeId) return fail('invalid_input', [VISA_FIELD.noticeId]);
  try {
    const result = await visaResultNoticeAck(asRpcClient(staff.supabase), noticeId);
    revalidateVisa(null, dealId);
    return { ok: true, data: result, message: VISA_DONE_TEXT.noticeSeen };
  } catch (error) {
    return failFrom(error);
  }
}

