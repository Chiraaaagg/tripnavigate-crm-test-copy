'use server';

import { revalidatePath } from 'next/cache';
import { requireStaff } from '@/modules/identity/server/session';
import { documentsPatch, visaApplicationSetState, visaApplicationUpdate, visaTaskClaim, visaTaskGet } from '../b11-commands';
import { parseApplicantDocumentForm, parseVisaStateForm, parseVisaSubmissionForm } from '../b11-forms';
import { asRpcClient, BookingCommandError } from '../commands';
import {
  type BookingActionResult,
  type ClaimTaskResult,
  ERROR_TEXT,
  VISA_APPLICATION_STATE_LABEL,
  type VisaApplicationResult,
  type VisaStateCommand,
} from '../contracts';
import { FIELD, readUuid } from '../forms';
import { fail, failFrom, isCode } from './b11-results';

/**
 * Visa & Passport desk commands (appendix A §3.2). requireStaff(), parse,
 * then the database command under the staff member's own session; the
 * database checks the desk role, the assignee and every state rule (documents
 * checked before submission, authority document before an outcome, forward
 * only). A fee receipt or a reference never marks an applicant issued.
 */

type Prev<T> = BookingActionResult<T> | null;

const VISA_PATH = '/app/visa';

function revalidateTask(taskId: string): void {
  revalidatePath(VISA_PATH);
  revalidatePath(`${VISA_PATH}/${taskId}`);
  revalidatePath('/app');
}

function stateMessage(result: VisaApplicationResult): string {
  const base = `Saved. Applicant status: ${VISA_APPLICATION_STATE_LABEL[result.state]}.`;
  return result.taskCompleted ? `${base} Every applicant is closed, so the task is completed.` : base;
}

const APPLICATION_HINTS = {
  documents: FIELD.documentCode,
  reference: FIELD.reference,
  appointmentAt: FIELD.appointmentAt,
  appointmentPlace: FIELD.appointmentPlace,
  state: FIELD.state,
  evidence: FIELD.evidenceId,
};

export async function claimVisaTaskAction(_prev: Prev<ClaimTaskResult>, formData: FormData): Promise<BookingActionResult<ClaimTaskResult>> {
  const staff = await requireStaff();
  const taskId = readUuid(formData, FIELD.taskId);
  if (!taskId) return fail('invalid_input', [FIELD.taskId]);
  try {
    const result = await visaTaskClaim(asRpcClient(staff.supabase), taskId);
    revalidateTask(taskId);
    return {
      ok: true,
      data: result,
      message: result.alreadyYours ? 'This task is already yours.' : 'You have taken this task. It is now in progress. Nothing is issued yet.',
    };
  } catch (error) {
    if (isCode(error, 'task_conflict')) revalidateTask(taskId);
    return failFrom(error);
  }
}

/** One document row: Missing / Received / Checked. The other documents stay as stored. */
export async function setApplicantDocumentAction(
  _prev: Prev<VisaApplicationResult>,
  formData: FormData,
): Promise<BookingActionResult<VisaApplicationResult>> {
  const staff = await requireStaff();
  const parsed = parseApplicantDocumentForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  const rpc = asRpcClient(staff.supabase);
  try {
    // The update carries the whole documents map: start from the stored one.
    const task = await visaTaskGet(rpc, v.taskId);
    const applicant = task?.applicants.find((a) => a.applicationId === v.applicationId);
    if (!applicant) return fail('not_found');
    const documents = documentsPatch(applicant.documents, v.documentCode, v.documentStatus);
    const result = await visaApplicationUpdate(rpc, { applicationId: v.applicationId, expectedRowVersion: v.expectedRowVersion, fields: { documents } });
    revalidateTask(v.taskId);
    return { ok: true, data: result, message: 'Document status saved.' };
  } catch (error) {
    if (isCode(error, 'version_changed')) revalidateTask(v.taskId);
    return failFrom(error, APPLICATION_HINTS);
  }
}

/**
 * "Record submission": saves the reference and appointment, then moves the
 * applicant to submitted (refused with documents_not_checked until every
 * document is checked). If the details save and the state change is
 * refused, the message says so.
 */
export async function recordVisaSubmissionAction(
  _prev: Prev<VisaApplicationResult>,
  formData: FormData,
): Promise<BookingActionResult<VisaApplicationResult>> {
  const staff = await requireStaff();
  const parsed = parseVisaSubmissionForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  const rpc = asRpcClient(staff.supabase);
  let updated: VisaApplicationResult;
  try {
    updated = await visaApplicationUpdate(rpc, {
      applicationId: v.applicationId,
      expectedRowVersion: v.expectedRowVersion,
      fields: { reference: v.reference, appointmentAt: v.appointmentAt, appointmentPlace: v.appointmentPlace },
    });
  } catch (error) {
    if (isCode(error, 'version_changed')) revalidateTask(v.taskId);
    return failFrom(error, APPLICATION_HINTS);
  }
  try {
    const result = await visaApplicationSetState(rpc, {
      applicationId: v.applicationId,
      expectedRowVersion: updated.rowVersion,
      state: 'submitted',
      evidenceId: null,
    });
    revalidateTask(v.taskId);
    return { ok: true, data: result, message: stateMessage(result) };
  } catch (error) {
    revalidateTask(v.taskId);
    if (error instanceof BookingCommandError && error.code) {
      return fail(error.code, undefined, `The reference and appointment were saved. The application was not marked submitted: ${ERROR_TEXT[error.code]}`);
    }
    return failFrom(error);
  }
}

async function setState(formData: FormData, allowed: readonly VisaStateCommand[]): Promise<BookingActionResult<VisaApplicationResult>> {
  const staff = await requireStaff();
  const parsed = parseVisaStateForm(formData, allowed);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  try {
    const result = await visaApplicationSetState(asRpcClient(staff.supabase), {
      applicationId: v.applicationId,
      expectedRowVersion: v.expectedRowVersion,
      state: v.state,
      evidenceId: v.evidenceId,
    });
    revalidateTask(v.taskId);
    return { ok: true, data: result, message: stateMessage(result) };
  } catch (error) {
    if (isCode(error, 'version_changed') || isCode(error, 'application_closed')) revalidateTask(v.taskId);
    return failFrom(error, APPLICATION_HINTS);
  }
}

/** "Waiting for decision". */
export async function markVisaDecisionPendingAction(_prev: Prev<VisaApplicationResult>, formData: FormData): Promise<BookingActionResult<VisaApplicationResult>> {
  return setState(formData, ['decision_pending']);
}

/** "Record outcome": issued or refused, with the stored authority outcome document (evidenceId). */
export async function recordVisaOutcomeAction(_prev: Prev<VisaApplicationResult>, formData: FormData): Promise<BookingActionResult<VisaApplicationResult>> {
  return setState(formData, ['issued', 'refused']);
}

/** "Withdraw application" (any open state). */
export async function withdrawVisaApplicationAction(_prev: Prev<VisaApplicationResult>, formData: FormData): Promise<BookingActionResult<VisaApplicationResult>> {
  return setState(formData, ['withdrawn']);
}

/** "Record documents returned" (after issued). */
export async function recordDocumentsReturnedAction(_prev: Prev<VisaApplicationResult>, formData: FormData): Promise<BookingActionResult<VisaApplicationResult>> {
  return setState(formData, ['documents_returned']);
}

/** "Customer informed" (after refused or withdrawn). */
export async function recordCustomerInformedAction(_prev: Prev<VisaApplicationResult>, formData: FormData): Promise<BookingActionResult<VisaApplicationResult>> {
  return setState(formData, ['customer_informed']);
}
