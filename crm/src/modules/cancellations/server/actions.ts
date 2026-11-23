'use server';

import { revalidatePath } from 'next/cache';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { readUuid, rupeesToPaise } from '@/modules/fulfilment/forms';
import { requireStaff } from '@/modules/identity/server/session';
import { CancellationCommandError, flightCancellationChargeSet, visaCancellationChoice, visaCancellationFeeSet } from '../commands';
import {
  CANCELLATION_DONE_TEXT,
  CANCELLATION_ERROR_TEXT,
  CANCELLATION_FIELD as F,
  CANCELLATION_UNKNOWN_OUTCOME_TEXT,
  type CancellationActionResult,
  type CancellationErrorCode,
  type FlightChargeResult,
  type VisaChoiceResult,
  type VisaFeeRefundResult,
} from '../contracts';

/**
 * Flight and Visa trip-cancellation commands (C9-C11), one useActionState
 * action each (Addendum L3): requireStaff(); read the form; run the command
 * under the staff member's OWN session; revalidate the Flight / Visa pages
 * and the Deal page. Money typed by staff arrives as <key>Rupees; a
 * refusal's field is the contract key. Nothing here logs amounts or names.
 */

type Prev<T> = CancellationActionResult<T> | null;
type Failure = Extract<CancellationActionResult<never>, { ok: false }>;

function fail(code: CancellationErrorCode | 'session', values?: Record<string, string>, field?: string): Failure {
  return { ok: false, code, message: CANCELLATION_ERROR_TEXT[code], ...(field ? { field } : {}), ...(values ? { values } : {}) };
}

function failFrom(error: unknown, values?: Record<string, string>): Failure {
  if (error instanceof CancellationCommandError && error.code) {
    return fail(error.code, values, error.code === 'invalid_input' ? (error.hint ?? undefined) : undefined);
  }
  throw new Error(CANCELLATION_UNKNOWN_OUTCOME_TEXT);
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

function readInt(formData: FormData, name: string): number | null {
  const raw = str(formData, name, 10);
  return raw !== null && /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

function rupees(formData: FormData, name: string): string | null | undefined {
  const raw = formData.get(name);
  return rupeesToPaise(typeof raw === 'string' ? raw.slice(0, 30) : undefined);
}

function revalidate(dealId: string | null, taskId: string | null): void {
  revalidatePath('/app/flight');
  revalidatePath('/app/visa');
  revalidatePath('/app/approvals');
  if (dealId) revalidatePath(`/app/deals/${dealId}`);
  if (taskId) {
    revalidatePath(`/app/visa/${taskId}`);
    revalidatePath(`/app/flight/${taskId}`);
  }
}

/** Fields: batchId, expectedRevision, airlineChargeRupees, refundExpectedRupees, refundReportedRupees (optional), note (optional), dealId, requestId. */
export async function setFlightCancellationChargeAction(_prev: Prev<FlightChargeResult>, formData: FormData): Promise<CancellationActionResult<FlightChargeResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.airlineChargeRupees, F.refundExpectedRupees, F.refundReportedRupees, F.note]);
  const batchId = readUuid(formData, F.batchId);
  const revision = readInt(formData, F.expectedRevision);
  const requestId = readUuid(formData, F.requestId);
  if (!batchId || revision === null || !requestId) return fail('invalid_input', values);
  const airline = rupees(formData, F.airlineChargeRupees);
  if (!airline) return fail('invalid_input', values, 'airlineChargePaise');
  const expected = rupees(formData, F.refundExpectedRupees);
  if (!expected) return fail('invalid_input', values, 'refundExpectedPaise');
  const reported = rupees(formData, F.refundReportedRupees);
  if (reported === undefined) return fail('invalid_input', values, 'refundReportedPaise');
  const note = str(formData, F.note, 500);
  try {
    const result = await flightCancellationChargeSet(asRpcClient(staff.supabase), batchId,
      { airlineChargePaise: airline, refundExpectedPaise: expected, refundReportedPaise: reported, note }, revision, requestId);
    revalidate(readUuid(formData, F.dealId), readUuid(formData, F.taskId));
    return { ok: true, data: result, message: result.outcome === 'existing' ? CANCELLATION_DONE_TEXT.existing : CANCELLATION_DONE_TEXT.flightCharge };
  } catch (error) {
    return failFrom(error, values);
  }
}

/** Fields: applicationId, expectedRowVersion, choice (withdraw|finish), reason, taskId, dealId, requestId. */
export async function chooseVisaCancellationAction(_prev: Prev<VisaChoiceResult>, formData: FormData): Promise<CancellationActionResult<VisaChoiceResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.reason]);
  const applicationId = readUuid(formData, F.applicationId);
  const rowVersion = readInt(formData, F.expectedRowVersion);
  const requestId = readUuid(formData, F.requestId);
  const choice = str(formData, F.choice, 10);
  if (!applicationId || rowVersion === null || !requestId || (choice !== 'withdraw' && choice !== 'finish')) return fail('invalid_input', values);
  const reason = str(formData, F.reason, 300);
  if (!reason || reason.length < 10) return fail('invalid_input', values, 'reason');
  try {
    const result = await visaCancellationChoice(asRpcClient(staff.supabase), { applicationId, expectedRowVersion: rowVersion, choice, reason, requestId });
    revalidate(readUuid(formData, F.dealId), readUuid(formData, F.taskId));
    return { ok: true, data: result, message: result.outcome === 'existing' ? CANCELLATION_DONE_TEXT.existing
      : choice === 'withdraw' ? CANCELLATION_DONE_TEXT.visaWithdraw : CANCELLATION_DONE_TEXT.visaFinish };
  } catch (error) {
    return failFrom(error, values);
  }
}

/** Fields: entryId, expectedRevision, refundExpectedRupees, note (optional), taskId, dealId, requestId. */
export async function setVisaCancellationFeeAction(_prev: Prev<VisaFeeRefundResult>, formData: FormData): Promise<CancellationActionResult<VisaFeeRefundResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.refundExpectedRupees, F.note]);
  const entryId = readUuid(formData, F.entryId);
  const revision = readInt(formData, F.expectedRevision);
  const requestId = readUuid(formData, F.requestId);
  if (!entryId || revision === null || !requestId) return fail('invalid_input', values);
  const expected = rupees(formData, F.refundExpectedRupees);
  if (!expected) return fail('invalid_input', values, 'refundExpectedPaise');
  const note = str(formData, F.note, 500);
  try {
    const result = await visaCancellationFeeSet(asRpcClient(staff.supabase), { entryId, refundExpectedPaise: expected, note,
      expectedRevision: revision, requestId });
    revalidate(readUuid(formData, F.dealId), readUuid(formData, F.taskId));
    return { ok: true, data: result, message: result.outcome === 'existing' ? CANCELLATION_DONE_TEXT.existing : CANCELLATION_DONE_TEXT.visaFee };
  } catch (error) {
    return failFrom(error, values);
  }
}
