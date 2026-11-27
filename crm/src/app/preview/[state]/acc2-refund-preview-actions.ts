'use server';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY. Stand-in server actions for the refund
 * states (acc2-refund-): a press shows the real success or refusal path
 * without a database. They read nothing and write nothing; the gallery is a
 * 404 outside the local preview mode. Refusal texts are track C's frozen
 * messages (modules/refunds/contracts.ts).
 */

type Result = { ok: true; data?: unknown; message: string } | { ok: false; code: string; message: string; field?: string };

async function settle<T>(value: T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  return value;
}

export async function rfOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: saved.' });
}
export async function rfRequestOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: refund request RF-2026-000016 sent to the branch Manager.' });
}
export async function rfExceeds(): Promise<Result> {
  return settle({ ok: false, code: 'refund_exceeds_money', message: 'The refund is more than the verified money held minus the customer charge.', field: 'amountPaise' });
}
export async function rfOpenExists(): Promise<Result> {
  return settle({ ok: false, code: 'refund_open_exists', message: 'This Deal already has a refund in progress. Finish or withdraw it first.' });
}
export async function rfSelf(): Promise<Result> {
  return settle({ ok: false, code: 'not_self_approval', message: 'You cannot approve or pay out something you asked for or approved.' });
}
export async function rfVersion(): Promise<Result> {
  return settle({ ok: false, code: 'version_changed', message: 'Someone changed this meanwhile. Reload and try again.' });
}
export async function rfEvidence(): Promise<Result> {
  return settle({ ok: false, code: 'evidence_missing', message: 'Upload the payment proof first.', field: 'file' });
}
export async function rfOver(): Promise<Result> {
  return settle({ ok: false, code: 'over_expected', message: 'This is more than the refund expected. Give a reason.', field: 'overExpectedReason' });
}
