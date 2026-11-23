'use server';

import { revalidatePath } from 'next/cache';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { readUuid, rupeesToPaise } from '@/modules/fulfilment/forms';
import { requireStaff } from '@/modules/identity/server/session';
import {
  ChangeCommandError,
  changeOpenVersion,
  changeRequestCreate,
  changeRequestDecide,
  changeRequestResubmit,
  changeRequestWithdraw,
  changeSubmit,
  reconfirmApproveOverBudget,
  reconfirmRecord,
  reconfirmRefuse,
  setBookingChanges,
  setServiceChanges,
  type ChangeRequestFields,
} from '../commands';
import {
  CHANGE_BLOCK_TEXT,
  CHANGE_DECISIONS,
  CHANGE_DONE_TEXT,
  CHANGE_ERROR_TEXT,
  CHANGE_FIELD as F,
  CHANGE_PATHS,
  CHANGE_UNKNOWN_OUTCOME_TEXT,
  type ChangeActionResult,
  type ChangeDecision,
  type ChangeErrorCode,
  type ChangeKind,
  type ChangeRequestResult,
  type ChangeSwitchResult,
  type ChangeVersionResult,
  type ReconfirmationResult,
} from '../contracts';
import { changedItemSet, customerChargeProblem, itemIdsProblem } from '../rules';

/**
 * Change commands (contract 10.2 G1, 10.3 G2-G9), one useActionState action
 * per command in the Phase 2 Addendum L3 shape: (prev, formData) -> {ok: true,
 * message, data} | {ok: false, code, message, field?}. Every action:
 * requireStaff(); read the form (never the actor, entity, branch or status);
 * run the database command under the staff member's OWN session; revalidate
 * the Deal page, Approvals, Purchase and Accounts. Rupee inputs are converted
 * to paise strings (no floats). Database messages never reach the browser;
 * nothing here logs amounts, references, reasons or names.
 */

type Prev<T> = ChangeActionResult<T> | null;
type Failure = Extract<ChangeActionResult<never>, { ok: false }>;

function fail(code: ChangeErrorCode | 'session', values?: Record<string, string>, field?: string, message?: string): Failure {
  return { ok: false, code, message: message ?? CHANGE_ERROR_TEXT[code], ...(field ? { field } : {}), ...(values ? { values } : {}) };
}

/** Known refusals become frozen text (not_ready adds the blocker's line); anything else is rethrown without detail. */
function failFrom(error: unknown, values?: Record<string, string>): Failure {
  if (error instanceof ChangeCommandError && error.code) {
    const hint = error.hint ?? '';
    if (error.code === 'not_ready' && Object.hasOwn(CHANGE_BLOCK_TEXT, hint)) {
      return fail('not_ready', values, undefined, `${CHANGE_ERROR_TEXT.not_ready} ${CHANGE_BLOCK_TEXT[hint as keyof typeof CHANGE_BLOCK_TEXT]}`);
    }
    if (error.code === 'change_outside_request' && /^[0-9,]{1,200}$/.test(hint)) {
      return fail('change_outside_request', values, undefined,
        `${CHANGE_ERROR_TEXT.change_outside_request} Services: ${hint.split(',').join(', ')}.`);
    }
    return fail(error.code, values, error.code === 'invalid_input' ? hint || undefined : undefined);
  }
  throw new Error(CHANGE_UNKNOWN_OUTCOME_TEXT);
}

function revalidateChanges(dealId?: string | null): void {
  for (const path of CHANGE_PATHS) revalidatePath(path);
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
  return raw !== null && /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

function readText(formData: FormData, name: string, min: number, max: number): string | null {
  const v = str(formData, name, max);
  return v && v.length >= min ? v : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readUuids(formData: FormData, name: string): string[] | null {
  const all = formData.getAll(name);
  const out: string[] = [];
  for (const v of all) {
    if (typeof v !== 'string' || !UUID.test(v.trim())) return null;
    out.push(v.trim().toLowerCase());
  }
  return out;
}

const done = <T extends { outcome: string }>(data: T, message: string): ChangeActionResult<T> =>
  ({ ok: true, data, message: data.outcome === 'existing' ? CHANGE_DONE_TEXT.existing : message });

function readRequestFields(formData: FormData, values: Record<string, string>, kind: ChangeKind = 'change'):
  { ok: true; itemIds: string[]; summary: string; reason: string } | { ok: false; failure: Failure } {
  const itemIds = readUuids(formData, F.itemIds);
  if (!itemIds || itemIdsProblem(kind, itemIds)) return { ok: false, failure: fail('invalid_input', values, 'itemIds') };
  const summary = readText(formData, F.changeSummary, 10, 500);
  if (!summary) return { ok: false, failure: fail('invalid_input', values, 'changeSummary') };
  const reason = readText(formData, F.reason, 10, 500);
  if (!reason) return { ok: false, failure: fail('invalid_input', values, 'reason') };
  return { ok: true, itemIds, summary, reason };
}

/** G2. Fields: dealId, itemIds (repeated), changeSummary, reason, requestId. Kind is 'change' (track H adds the others). */
export async function requestChangeAction(_prev: Prev<ChangeRequestResult>, formData: FormData): Promise<ChangeActionResult<ChangeRequestResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.changeSummary, F.reason]);
  const dealId = readUuid(formData, F.dealId);
  const requestId = readUuid(formData, F.requestId);
  if (!dealId || !requestId) return fail('invalid_input', values);
  const f = readRequestFields(formData, values);
  if (!f.ok) return f.failure;
  try {
    const result = await changeRequestCreate(asRpcClient(staff.supabase), dealId,
      { kind: 'change', itemIds: f.itemIds, changeSummary: f.summary, reason: f.reason }, requestId);
    revalidateChanges(dealId);
    return done(result, CHANGE_DONE_TEXT.requested);
  } catch (error) {
    return failFrom(error, values);
  }
}

/**
 * G3 resubmit. Fields: changeRequestId, expectedRowVersion, kind (hidden; default 'change'), itemIds (repeated;
 * none for add_service, one for remove_service), changeSummary, reason, customerChargeRupees (remove_service of a
 * booked service), requestId.
 */
export async function resubmitChangeAction(_prev: Prev<ChangeRequestResult>, formData: FormData): Promise<ChangeActionResult<ChangeRequestResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.changeSummary, F.reason, F.customerChargeRupees]);
  const id = readUuid(formData, F.changeRequestId);
  const requestId = readUuid(formData, F.requestId);
  const rv = readRowVersion(formData);
  if (!id || !requestId || rv === null) return fail('invalid_input', values);
  const kind = readKind(formData);
  if (!kind) return fail('invalid_input', values, 'kind');
  const f = readRequestFields(formData, values, kind);
  if (!f.ok) return f.failure;
  const charge = readCustomerCharge(formData);
  if (charge === undefined) return fail('invalid_input', values, 'customerChargePaise');
  try {
    const fields: ChangeRequestFields = { kind, itemIds: f.itemIds, changeSummary: f.summary, reason: f.reason };
    if (kind === 'remove_service' && charge !== null) fields.customerChargePaise = charge;
    const result = await changeRequestResubmit(asRpcClient(staff.supabase), id, rv, fields, requestId);
    revalidateChanges(result.dealId);
    return done(result, CHANGE_DONE_TEXT.resubmitted);
  } catch (error) {
    return failFrom(error, values);
  }
}

function readKind(formData: FormData): ChangeKind | null {
  const raw = str(formData, F.kind, 20) ?? 'change';
  return raw === 'change' || raw === 'add_service' || raw === 'remove_service' ? raw : null;
}

/** customerChargeRupees -> paise string; null when absent; undefined when not a valid amount. */
function readCustomerCharge(formData: FormData): string | null | undefined {
  const raw = formData.get(F.customerChargeRupees);
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const paise = rupeesToPaise(raw.slice(0, 30));
  return paise === undefined || customerChargeProblem('cancellation', paise) ? undefined : paise;
}

/** H (11.2). Fields: dealId, changeSummary, reason, requestId. Services are added after approval, in the change version. */
export async function requestAddServiceAction(_prev: Prev<ChangeRequestResult>, formData: FormData): Promise<ChangeActionResult<ChangeRequestResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.changeSummary, F.reason]);
  const dealId = readUuid(formData, F.dealId);
  const requestId = readUuid(formData, F.requestId);
  if (!dealId || !requestId) return fail('invalid_input', values);
  const summary = readText(formData, F.changeSummary, 10, 500);
  if (!summary) return fail('invalid_input', values, 'changeSummary');
  const reason = readText(formData, F.reason, 10, 500);
  if (!reason) return fail('invalid_input', values, 'reason');
  try {
    const result = await changeRequestCreate(asRpcClient(staff.supabase), dealId,
      { kind: 'add_service', itemIds: [], changeSummary: summary, reason }, requestId);
    revalidateChanges(dealId);
    return done(result, CHANGE_DONE_TEXT.requestedAdd);
  } catch (error) {
    return failFrom(error, values);
  }
}

/**
 * H (11.3). Fields: dealId, itemIds (exactly one), changeSummary, reason, customerChargeRupees (required when the
 * service is booked - R-G1 removable[].route 'cancellation'; "0" allowed), requestId.
 */
export async function requestRemoveServiceAction(_prev: Prev<ChangeRequestResult>, formData: FormData): Promise<ChangeActionResult<ChangeRequestResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.changeSummary, F.reason, F.customerChargeRupees]);
  const dealId = readUuid(formData, F.dealId);
  const requestId = readUuid(formData, F.requestId);
  if (!dealId || !requestId) return fail('invalid_input', values);
  const f = readRequestFields(formData, values, 'remove_service');
  if (!f.ok) return f.failure;
  const charge = readCustomerCharge(formData);
  if (charge === undefined) return fail('invalid_input', values, 'customerChargePaise');
  try {
    const fields: ChangeRequestFields = { kind: 'remove_service', itemIds: f.itemIds, changeSummary: f.summary, reason: f.reason };
    if (charge !== null) fields.customerChargePaise = charge;
    const result = await changeRequestCreate(asRpcClient(staff.supabase), dealId, fields, requestId);
    revalidateChanges(dealId);
    return done(result, CHANGE_DONE_TEXT.requestedRemove);
  } catch (error) {
    return failFrom(error, values);
  }
}

/** G3 withdraw. Fields: changeRequestId, expectedRowVersion, reason, requestId. */
export async function withdrawChangeAction(_prev: Prev<ChangeRequestResult>, formData: FormData): Promise<ChangeActionResult<ChangeRequestResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.reason]);
  const id = readUuid(formData, F.changeRequestId);
  const requestId = readUuid(formData, F.requestId);
  const rv = readRowVersion(formData);
  if (!id || !requestId || rv === null) return fail('invalid_input', values);
  const reason = readText(formData, F.reason, 10, 500);
  if (!reason) return fail('invalid_input', values, 'reason');
  try {
    const result = await changeRequestWithdraw(asRpcClient(staff.supabase), id, rv, reason, requestId);
    revalidateChanges(result.dealId);
    return done(result, CHANGE_DONE_TEXT.withdrawn);
  } catch (error) {
    return failFrom(error, values);
  }
}

/** G4. Fields: changeRequestId, decision ('approve' | 'return'), reason (required to return), expectedRowVersion, requestId. */
export async function decideChangeAction(_prev: Prev<ChangeRequestResult>, formData: FormData): Promise<ChangeActionResult<ChangeRequestResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.reason]);
  const id = readUuid(formData, F.changeRequestId);
  const requestId = readUuid(formData, F.requestId);
  const rv = readRowVersion(formData);
  if (!id || !requestId || rv === null) return fail('invalid_input', values);
  const decision = str(formData, F.decision, 10);
  if (!decision || !(CHANGE_DECISIONS as readonly string[]).includes(decision)) return fail('invalid_input', values, 'decision');
  const raw = str(formData, F.reason, 500);
  const reason = readText(formData, F.reason, 10, 500);
  if ((decision === 'return' && !reason) || (raw !== null && !reason)) return fail('invalid_input', values, 'reason');
  try {
    const result = await changeRequestDecide(asRpcClient(staff.supabase), id, decision as ChangeDecision, reason, rv, requestId);
    revalidateChanges(result.dealId);
    return done(result, decision === 'return' ? CHANGE_DONE_TEXT.returned
      : result.status === 'applied' ? CHANGE_DONE_TEXT.applied : CHANGE_DONE_TEXT.approved);
  } catch (error) {
    return failFrom(error, values);
  }
}

/** G5. Fields: changeRequestId, requestId. */
export async function openChangeVersionAction(_prev: Prev<ChangeVersionResult>, formData: FormData): Promise<ChangeActionResult<ChangeVersionResult>> {
  const staff = await requireStaff();
  const id = readUuid(formData, F.changeRequestId);
  const requestId = readUuid(formData, F.requestId);
  if (!id || !requestId) return fail('invalid_input');
  try {
    const result = await changeOpenVersion(asRpcClient(staff.supabase), id, requestId);
    revalidateChanges();
    return done(result, CHANGE_DONE_TEXT.opened);
  } catch (error) {
    return failFrom(error);
  }
}

/** G6. Fields: changeRequestId, expectedContentHash (hidden), changedItemIds (repeated hidden), requestId. */
export async function submitChangeAction(_prev: Prev<ChangeRequestResult>, formData: FormData): Promise<ChangeActionResult<ChangeRequestResult>> {
  const staff = await requireStaff();
  const id = readUuid(formData, F.changeRequestId);
  const requestId = readUuid(formData, F.requestId);
  const hash = str(formData, F.expectedContentHash, 64);
  const changed = readUuids(formData, F.changedItemIds);
  if (!id || !requestId || !hash || !/^[0-9a-f]{64}$/.test(hash) || !changed) return fail('invalid_input');
  try {
    const result = await changeSubmit(asRpcClient(staff.supabase), id, hash, changedItemSet(changed), requestId);
    revalidateChanges(result.dealId);
    return done(result, CHANGE_DONE_TEXT.submitted);  // Addendum O2: submit sends the filled version to the Manager
  } catch (error) {
    return failFrom(error);
  }
}

/** G7. Fields: reconfirmationId, expectedRowVersion, newRateRupees, supplierFeeRupees, newReference, evidenceId, note, requestId. */
export async function recordReconfirmAction(_prev: Prev<ReconfirmationResult>, formData: FormData): Promise<ChangeActionResult<ReconfirmationResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.newRateRupees, F.supplierFeeRupees, F.newReference, F.note]);
  const id = readUuid(formData, F.reconfirmationId);
  const requestId = readUuid(formData, F.requestId);
  const rv = readRowVersion(formData);
  if (!id || !requestId || rv === null) return fail('invalid_input', values);
  const rawRate = formData.get(F.newRateRupees);
  const rate = rupeesToPaise(typeof rawRate === 'string' ? rawRate.slice(0, 30) : undefined);
  if (!rate || rate === '0') return fail('invalid_input', values, 'newRatePaise');
  const rawFee = formData.get(F.supplierFeeRupees);
  const fee = rupeesToPaise(typeof rawFee === 'string' ? rawFee.slice(0, 30) : undefined);
  if (fee === undefined) return fail('invalid_input', values, 'supplierFeePaise');
  const reference = readText(formData, F.newReference, 1, 120);
  if (!reference) return fail('invalid_input', values, 'newReference');
  const evidenceId = readUuid(formData, F.evidenceId);
  if (!evidenceId) return fail('evidence_missing', values);
  const note = str(formData, F.note, 500);
  try {
    const result = await reconfirmRecord(asRpcClient(staff.supabase), id, rv,
      { newRatePaise: rate, supplierFeePaise: fee ?? '0', newReference: reference, evidenceId, note }, requestId);
    revalidateChanges();
    return done(result, result.changeRequestStatus === 'applied' ? CHANGE_DONE_TEXT.applied : CHANGE_DONE_TEXT.recorded);
  } catch (error) {
    return failFrom(error, values);
  }
}

/** G8. Fields: reconfirmationId, expectedRowVersion, requestId. */
export async function approveReconfirmOverBudgetAction(_prev: Prev<ReconfirmationResult>, formData: FormData):
  Promise<ChangeActionResult<ReconfirmationResult>> {
  const staff = await requireStaff();
  const id = readUuid(formData, F.reconfirmationId);
  const requestId = readUuid(formData, F.requestId);
  const rv = readRowVersion(formData);
  if (!id || !requestId || rv === null) return fail('invalid_input');
  try {
    const result = await reconfirmApproveOverBudget(asRpcClient(staff.supabase), id, rv, requestId);
    revalidateChanges();
    return done(result, result.changeRequestStatus === 'applied' ? CHANGE_DONE_TEXT.applied : CHANGE_DONE_TEXT.overBudgetApproved);
  } catch (error) {
    return failFrom(error);
  }
}

/** G9. Fields: reconfirmationId, expectedRowVersion, reason, requestId. */
export async function refuseReconfirmAction(_prev: Prev<ReconfirmationResult>, formData: FormData): Promise<ChangeActionResult<ReconfirmationResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.reason]);
  const id = readUuid(formData, F.reconfirmationId);
  const requestId = readUuid(formData, F.requestId);
  const rv = readRowVersion(formData);
  if (!id || !requestId || rv === null) return fail('invalid_input', values);
  const reason = readText(formData, F.reason, 10, 500);
  if (!reason) return fail('invalid_input', values, 'reason');
  try {
    const result = await reconfirmRefuse(asRpcClient(staff.supabase), id, rv, reason, requestId);
    revalidateChanges();
    return done(result, CHANGE_DONE_TEXT.refused);
  } catch (error) {
    return failFrom(error, values);
  }
}

/** G1 (Settings, Super Admin). Fields: enabled ('true' | 'false'), reason. */
export async function setBookingChangesAction(_prev: Prev<ChangeSwitchResult>, formData: FormData): Promise<ChangeActionResult<ChangeSwitchResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.reason]);
  const enabledRaw = str(formData, F.enabled, 5);
  if (enabledRaw !== 'true' && enabledRaw !== 'false') return fail('invalid_input', values, 'enabled');
  const reason = readText(formData, F.reason, 10, 500);
  if (!reason) return fail('invalid_input', values, 'reason');
  try {
    const result = await setBookingChanges(asRpcClient(staff.supabase), enabledRaw === 'true', reason);
    revalidatePath('/app/admin');
    revalidateChanges();
    return { ok: true, data: result, message: result.changed ? CHANGE_DONE_TEXT.switched : CHANGE_DONE_TEXT.existing };
  } catch (error) {
    return failFrom(error, values);
  }
}

/** H1 (Settings, Super Admin): adding or removing services. Fields: enabled ('true' | 'false'), reason. */
export async function setServiceChangesAction(_prev: Prev<ChangeSwitchResult>, formData: FormData): Promise<ChangeActionResult<ChangeSwitchResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.reason]);
  const enabledRaw = str(formData, F.enabled, 5);
  if (enabledRaw !== 'true' && enabledRaw !== 'false') return fail('invalid_input', values, 'enabled');
  const reason = readText(formData, F.reason, 10, 500);
  if (!reason) return fail('invalid_input', values, 'reason');
  try {
    const result = await setServiceChanges(asRpcClient(staff.supabase), enabledRaw === 'true', reason);
    revalidatePath('/app/admin');
    revalidateChanges();
    return { ok: true, data: result, message: result.changed ? CHANGE_DONE_TEXT.switched : CHANGE_DONE_TEXT.existing };
  } catch (error) {
    return failFrom(error, values);
  }
}
