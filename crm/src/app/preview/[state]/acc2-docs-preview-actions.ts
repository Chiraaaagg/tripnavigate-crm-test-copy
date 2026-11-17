'use server';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY. Stand-in server actions for the customer
 * documents states (acc2-docs-), so a press shows the real success or refusal
 * path without a database. They read nothing and write nothing; the gallery
 * is a 404 outside the local preview mode. Refusal texts are track B's frozen
 * messages (modules/customer-documents/contracts.ts).
 */

type Result = { ok: true; data?: unknown; message: string } | { ok: false; code: string; message: string; field?: string };

async function settle<T>(value: T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  return value;
}

export async function docDraftOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: draft made. Check it, then release it.' });
}
export async function docRefreshOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: draft refreshed with the latest booking and money.' });
}
export async function docReleaseOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: released as 10101-INV-3.' });
}
export async function docReleaseStale(): Promise<Result> {
  return settle({ ok: false, code: 'document_stale', message: 'The booking or money changed since this draft was made. Refresh the draft first.' });
}
export async function docReasonOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: saved with your reason.' });
}
export async function docReasonShort(): Promise<Result> {
  return settle({ ok: false, code: 'invalid_input', message: 'Check the highlighted field.', field: 'reason' });
}
export async function docCancelHasCn(): Promise<Result> {
  return settle({ ok: false, code: 'has_credit_notes', message: 'A released credit note refers to this document. It cannot be cancelled.' });
}
export async function docLinkOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: GST invoice number linked.' });
}
export async function docRetryOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: the PDF will be made again.' });
}
