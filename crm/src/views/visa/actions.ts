import { VISA_FIELD } from '@/modules/visa/contracts';
import type { DecisionAction } from '@/views/accounts/supplier-forms';

/*
 * The server actions the Visa and passport screens call, passed in as props
 * (the route passes the real 'use server' actions from
 * src/modules/visa/server/actions.ts and evidence.ts, the preview gallery
 * passes stubs), so the views never import server code. Every action has the
 * `(prev, FormData) => { ok, message, code?, fields?, data? }` shape.
 *
 * Form fields are the server module's VISA_FIELD names (flat FormData; money
 * as rupees text, converted to whole paise by the server's parser). Every
 * application command also carries taskId and dealId (for revalidation) and
 * one request id per form, renewed only after a confirmed success.
 */

export const VF = VISA_FIELD;

export interface VisaWorkActions {
  /** C1 visa_task_claim (taskId, dealId). */
  claim: DecisionAction;
  /** C2 visa_application_set_row. */
  saveRow: DecisionAction;
  /** C3 visa_application_document_add. */
  addDocument: DecisionAction;
  /** C4 visa_application_document_remove (documentId, expectedRowVersion = the application's). */
  removeDocument: DecisionAction;
  /** C5 visa_applications_apply (applicants[i].<key>, applicantCount, shared fields). */
  apply: DecisionAction;
  /** C6 visa_application_decide. */
  decide: DecisionAction;
  /** C7 visa_application_set_handover. */
  setHandover: DecisionAction;
  /** C8 visa_application_mark_delivered. */
  markDelivered: DecisionAction;
  /** C9 visa_application_withdraw. */
  withdraw: DecisionAction;
  /** C10 visa_application_reapply. */
  reapply: DecisionAction;
  /** C12 visa_fee_send. */
  sendFee: DecisionAction;
  /** Section 16: an "other" visa cost of one passenger (department_cost_save). */
  saveOtherCost: DecisionAction;
  /** C13 visa_application_confirm_traveller. */
  confirmTraveller: DecisionAction;
  /** C11 + finish + C2: a document's file (documentId, applicationId, expectedRowVersion, documentStatus, file). */
  uploadDocument: DecisionAction;
  /** department_evidence_begin + finish: fee receipt or decision proof (taskId, applicationId?, kind, file). Returns data {evidenceId}. */
  uploadEvidence: DecisionAction;
}

/** Deal page notice card: C14 visa_result_notice_ack (noticeId, dealId). */
export interface DealVisaActions {
  ackNotice: DecisionAction;
}

type Value = string | number | boolean | null | undefined | File | readonly string[];

/** Flat FormData: arrays are repeated fields, booleans 'true'/'' , null/undefined left out. */
export function formOf(fields: Record<string, Value>, requestId?: string | null): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    if (v instanceof File) fd.set(k, v);
    else if (Array.isArray(v)) for (const x of v) fd.append(k, x);
    else if (typeof v === 'boolean') fd.set(k, v ? 'true' : '');
    else fd.set(k, String(v));
  }
  if (requestId) fd.set(VF.requestId, requestId);
  return fd;
}
