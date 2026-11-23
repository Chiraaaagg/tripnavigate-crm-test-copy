import { inr, sumPaise, todayIst } from './format';
import type { VisaResult } from './kit';
import { HANDOVER_LABEL, KIND_LABEL, nameOf } from './labels';
import type { VisaApplicant, VisaFee, VisaKind, VisaWorkspace } from './types';

/*
 * Pure helpers of the Visa Work tab: which passengers sit in which table,
 * the visa line under a name, fee totals, popup defaults. The database is
 * the authority (ready, notReady, can.*); these only arrange what it sent.
 */



/** Preview gallery only: values a popup starts with (and the answer it shows), to prove typed input survives a refusal. */
export interface PopupSeed {
  references?: string[];
  governmentFees?: string[];
  paymentMode?: string;
  email?: string;
  handoverMethod?: string;
  courierNumber?: string;
  remark?: string;
  result?: VisaResult;
}

export type Popup =
  | { kind: 'apply'; ids: string[] }
  | { kind: 'approve' | 'reject' | 'withdraw' | 'handover' | 'delivered' | 'reapply' | 'addDoc' | 'otherCost'; id: string }
  | { kind: 'uploadDoc'; id: string; documentId?: string }
  | { kind: 'removeDoc'; id: string; documentId: string }
  | { kind: 'fee'; entryId: string };

/** Ids every application command carries (taskId and dealId let the server refresh the right pages). */
export function appTarget(ws: Pick<VisaWorkspace, 'taskId' | 'dealId'>, a: Pick<VisaApplicant, 'applicationId' | 'rowVersion'>) {
  return { taskId: ws.taskId, dealId: ws.dealId, applicationId: a.applicationId, expectedRowVersion: a.rowVersion };
}

/**
 * Fee work (Track A 0140): the task's last assignee may still upload fee receipts, send or fix fees
 * and add "other" costs on a COMPLETED task. The database's canManageFees decides; every other
 * control stays read-only on a completed task.
 */
export function canManageFees(ws: VisaWorkspace): boolean {
  return ws.canManageFees;
}

/** A traveller's "other" visa costs (section 16). */
export function otherCostsOf(t: NonNullable<VisaWorkspace['costSummary']>['travellers'][number]): string | null {
  return t.otherPaise;
}

export const isPassportTask = (ws: Pick<VisaWorkspace, 'serviceType'>) => ws.serviceType === 'passport';

export function salesVisa(ws: VisaWorkspace) {
  return 'visa' in ws.facts ? ws.facts.visa : null;
}

/** Sales left the kind blank: the desk may choose it before Applied (QB5). */
export function salesKindBlank(ws: VisaWorkspace): boolean {
  const v = salesVisa(ws);
  return !!v && !v.visaKind;
}

/** Sales left jurisdiction blank (the desk may set it for sticker visas). */
export function salesJurisdictionBlank(ws: VisaWorkspace): boolean {
  const v = salesVisa(ws);
  return !!v && !v.jurisdiction;
}

export function kindOf(a: VisaApplicant): VisaKind | null {
  return a.visaKind.value;
}

export const isApplied = (a: VisaApplicant) => a.state !== 'docs_pending';
export const isDecided = (a: VisaApplicant) => a.state === 'issued' || a.state === 'refused' || a.state === 'withdrawn';

/** Passengers table: current applications, removed ones last. */
export function passengerRows(ws: VisaWorkspace): VisaApplicant[] {
  return [...ws.applicants].sort((x, y) => Number(x.removed) - Number(y.removed) || x.seq - y.seq);
}

/** Appointment table: ready (not applied yet) and applied-or-later passengers. */
export function appointmentRows(ws: VisaWorkspace): VisaApplicant[] {
  return ws.applicants.filter((a) => isApplied(a) || (a.ready && !a.removed)).sort((x, y) => x.seq - y.seq);
}

/** Passengers that can be ticked for Applied (the database's can.select). */
export function selectable(ws: VisaWorkspace): VisaApplicant[] {
  return appointmentRows(ws).filter((a) => a.can.select && !isApplied(a));
}

/** Passport custody words (contract 8 visa line): with us / not with us / returned. */
function custody(a: VisaApplicant): string | null {
  if (!a.applied) return null;
  const returned = a.handover?.kind === 'legacy_returned' || (a.handover?.method === 'courier' && !!a.closed) || !!a.handover?.deliveredOn;
  if (returned) return 'Passport returned';
  return a.applied.passportTaken ? 'Passport with us' : 'Passport not with us';
}

/** "E-visa · Passport photo only" / "Sticker visa · Passport with us · Jurisdiction Mumbai". */
export function visaLine(ws: VisaWorkspace, a: VisaApplicant): string | null {
  // Passport tasks have no custody tick (VL8): only "Passport returned" once the handover is done.
  if (isPassportTask(ws)) return custody(a) === 'Passport returned' ? 'Passport returned' : null;
  const kind = kindOf(a);
  if (!kind) return null;
  if (kind === 'e_visa') return `${KIND_LABEL.e_visa} · Passport photo only`;
  const jur = a.jurisdiction.required === true ? `Jurisdiction ${a.jurisdiction.place ?? ''}`.trim() : a.jurisdiction.required === false ? 'No jurisdiction' : null;
  return [KIND_LABEL.sticker, custody(a), jur].filter(Boolean).join(' · ');
}

/** Latest fee entries counted for a passenger (returned ones stay until fixed). */
export function feeTotal(fees: VisaFee[]): string | null {
  const counted = fees.filter((f) => f.costKind !== 'other');
  if (counted.length === 0) return null;
  return inr(sumPaise(counted.map((f) => f.amountPaise)));
}

/** Applied date default: the appointment date when it is not after today, else today. */
export function defaultAppliedOn(a: VisaApplicant, today = todayIst()): string {
  const d = a.appointment.date;
  return d && d <= today ? d : today;
}

/** Company fees without a receipt (draft): "Send fee to Accounts". */
export function draftFees(ws: VisaWorkspace) {
  return ws.applicants.flatMap((a) =>
    a.fees.filter((f) => f.paidBy === 'company' && f.expenseStatus === 'draft').map((f) => ({ a, f })),
  );
}

/** Files of one passenger by kind (decision proof on file, documents). */
export function filesOf(ws: VisaWorkspace, a: VisaApplicant, kind: 'authority_outcome' | 'fee_receipt' | 'applicant_document') {
  return ws.files.filter((f) => f.status === 'stored' && f.kind === kind && f.applicationId === a.applicationId);
}

export function handoverTitle(ws: VisaWorkspace, a: VisaApplicant): string {
  if (isPassportTask(ws)) return 'Passport handover';
  return a.state === 'refused' ? 'Passport return' : 'Sticker visa';
}

export function methodText(a: VisaApplicant): string | null {
  return a.handover?.method ? HANDOVER_LABEL[a.handover.method] : null;
}

export function namesOf(list: VisaApplicant[]): string {
  return list.map(nameOf).join(', ');
}
