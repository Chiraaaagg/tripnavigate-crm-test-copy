'use server';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY. Stand-in server actions for the change
 * states (acc3-changes-), so a press shows the real success or refusal path
 * without a database. They read nothing and write nothing; the gallery is a
 * 404 outside the local preview mode. Refusal texts are the frozen staff
 * messages of contract section 13.
 */

type Result = { ok: true; data?: unknown; message: string } | { ok: false; code: string; message: string; field?: string };

async function settle<T>(value: T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  return value;
}

export async function crCreateOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: change CR-2026-000031 sent to the branch Manager.' });
}
export async function crCreateOpenExists(): Promise<Result> {
  return settle({ ok: false, code: 'change_open_exists', message: 'This Deal already has a change in progress. Finish or withdraw it first.' });
}
export async function crCreateNotSupported(): Promise<Result> {
  return settle({ ok: false, code: 'change_not_supported', message: 'This booking cannot be changed here.' });
}
export async function crCreateInvalid(): Promise<Result> {
  return settle({ ok: false, code: 'invalid_input', message: 'Check the highlighted field.', field: 'changeSummary' });
}
export async function crReasonOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: saved with your reason.' });
}
export async function crOpenVersionOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: change version opened. Edit the booking now.' });
}
export async function crDecideOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: decision saved. The Sales owner is told.' });
}
export async function crDecideSelf(): Promise<Result> {
  return settle({ ok: false, code: 'not_self_approval', message: 'You cannot approve your own request. Another Manager approves it.' });
}
export async function crDecideChargesMissing(): Promise<Result> {
  return settle({ ok: false, code: 'charges_missing', message: 'The supplier charges for this service are not entered yet.' });
}
export async function crDecideVersionChanged(): Promise<Result> {
  return settle({ ok: false, code: 'version_changed', message: 'Someone changed this since you opened it. Reload the page and check again.' });
}
export async function crSubmitOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: change sent. Purchase reconfirms with the supplier.' });
}
export async function crSubmitOutside(): Promise<Result> {
  return settle({ ok: false, code: 'change_outside_request', message: 'Some changed services are not part of the approved request. (Service 3)' });
}
export async function rcRecordOk(): Promise<Result> {
  return settle({ ok: true, message: "Synthetic preview: supplier's answer saved." });
}
export async function rcRecordPaymentInProgress(): Promise<Result> {
  return settle({ ok: false, code: 'payment_in_progress', message: 'A supplier payment for this task is in progress. Finish or withdraw it first.' });
}
export async function rcRecordEvidenceMissing(): Promise<Result> {
  return settle({ ok: false, code: 'evidence_missing', message: 'Upload the supplier confirmation first.', field: 'evidenceId' });
}
export async function rcApproveOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: cost above budget approved.' });
}
