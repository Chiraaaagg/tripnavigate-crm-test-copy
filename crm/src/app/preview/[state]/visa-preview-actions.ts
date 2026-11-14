'use server';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY. Stand-in server actions for the Visa
 * build screens (visa- states), so a press shows the real success or refusal
 * path without a database. They read nothing, write nothing and return fixed
 * synthetic answers; the gallery is a 404 outside the local preview mode.
 */

type Result = { ok: true; data?: unknown; message: string } | { ok: false; code: string; message: string; fields?: string[] };

async function settle<T>(value: T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  return value;
}

const ok = (message: string, data?: unknown): Promise<Result> => settle({ ok: true, message, data });
const no = (code: string, message: string, fields?: string[]): Promise<Result> => settle({ ok: false, code, message, fields });

export async function vsClaim(): Promise<Result> {
  return ok('Synthetic preview: you have taken this task. Fill each passenger’s documents and date next.');
}
export async function vsClaimConflict(): Promise<Result> {
  return no('task_conflict', 'Someone at the desk took this task first.');
}
export async function vsRowSaved(): Promise<Result> {
  return ok('Synthetic preview: passenger saved. Ready for Appointment.');
}
export async function vsRowRefused(): Promise<Result> {
  return no('invalid_input', 'Check the highlighted field.', ['passportNumber']);
}
export async function vsDocAdded(): Promise<Result> {
  return ok('Synthetic preview: document added.', { documentId: 'c1000000-0000-4000-8000-000000009999', rowVersion: 4 });
}
export async function vsDocDuplicate(): Promise<Result> {
  return no('duplicate_document', 'This document is already on the list.', ['label']);
}
export async function vsDocRemoved(): Promise<Result> {
  return ok('Synthetic preview: document removed from the list.');
}
export async function vsApplied(): Promise<Result> {
  return ok('Synthetic preview: saved as applied. Waiting for the decision.');
}
export async function vsApplyDuplicateRef(): Promise<Result> {
  return no('duplicate_reference', 'This reference is already used on this task.', ['applicants[1].reference']);
}
export async function vsApplyFuture(): Promise<Result> {
  return no('applied_date_in_future', 'The applied date cannot be after today.', ['applicants[0].appliedOn']);
}
export async function vsDecided(): Promise<Result> {
  return ok('Synthetic preview: decision saved.');
}
export async function vsDecideNoProof(): Promise<Result> {
  return no('outcome_document_required', 'Upload the visa or refusal document first.', ['outcomeEvidenceId']);
}
export async function vsHandover(): Promise<Result> {
  return ok('Synthetic preview: handover saved.');
}
export async function vsDelivered(): Promise<Result> {
  return ok('Synthetic preview: delivery saved. This passenger is closed.');
}
export async function vsDeliveredFuture(): Promise<Result> {
  return no('delivered_date_in_future', 'The delivery date cannot be after today.', ['deliveredOn']);
}
export async function vsWithdrawn(): Promise<Result> {
  return ok('Synthetic preview: withdrawal saved. This passenger is closed.');
}
export async function vsReapplied(): Promise<Result> {
  return ok('Synthetic preview: new application started. The rejected one stays in History.');
}
export async function vsFeeSent(): Promise<Result> {
  return ok('Synthetic preview: fee sent to Accounts.');
}
export async function vsFeeLocked(): Promise<Result> {
  return no('cost_locked', 'This fee is with Accounts and cannot be changed now.');
}
export async function vsOtherCost(): Promise<Result> {
  return ok('Synthetic preview: cost saved. Attach the receipt and send it to Accounts.');
}
export async function vsConfirmed(): Promise<Result> {
  return ok('Synthetic preview: traveller change checked.');
}
export async function vsUploaded(): Promise<Result> {
  return ok('Synthetic preview: file uploaded and the document marked received.', { evidenceId: 'e1000000-0000-4000-8000-000000009999' });
}
export async function vsEvidence(): Promise<Result> {
  return ok('Synthetic preview: file uploaded.', { evidenceId: 'e1000000-0000-4000-8000-000000009998' });
}
export async function vsAck(): Promise<Result> {
  return ok('Synthetic preview: noted.');
}
/** Echoes which documents a row save posted (proves only the ticks changed in this edit are sent). */
export async function vsRowEcho(_prev: unknown, fd: FormData): Promise<Result> {
  const ids = fd.getAll('documentIds').length;
  const received = fd.getAll('receivedDocumentIds').length;
  return ok(`Synthetic preview: row saved with ${ids} document ${ids === 1 ? 'change' : 'changes'} (${received} marked received).`);
}
