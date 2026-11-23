'use server';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY. Stand-in server actions for the
 * write-off states (acc3-writeoffs-), so a press shows the real success or
 * refusal path without a database. They read nothing and write nothing; the
 * gallery is a 404 outside the local preview mode. Refusal texts are the
 * frozen messages of contract 13 (track B owns the real ones).
 */

type Result = { ok: true; data?: unknown; message: string } | { ok: false; code: string; message: string; field?: string };

async function settle<T>(value: T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  return value;
}

export async function woProposeOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: write-off WO-2026-000016 sent to the branch Manager.' });
}
export async function woProposeOff(): Promise<Result> {
  return settle({ ok: false, code: 'write_off_off', message: 'Write-offs are not switched on yet.' });
}
export async function woProposeNotBalance(): Promise<Result> {
  return settle({ ok: false, code: 'write_off_not_balance', message: 'A write-off must be the whole remaining balance.' });
}
export async function woProposeOverLimit(): Promise<Result> {
  return settle({ ok: false, code: 'write_off_over_limit', message: 'This is more than the write-off limit for one Deal.' });
}
export async function woProposeExists(): Promise<Result> {
  return settle({ ok: false, code: 'write_off_open_exists', message: 'This Deal already has a write-off.' });
}
export async function woProposeShortReason(): Promise<Result> {
  return settle({ ok: false, code: 'invalid_input', message: 'Check the highlighted field.', field: 'reason' });
}
export async function woDecideOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: decision saved. Accounts are told.' });
}
export async function woDecideSelf(): Promise<Result> {
  return settle({ ok: false, code: 'not_self_approval', message: 'You cannot approve your own request.' });
}
export async function woDecideChanged(): Promise<Result> {
  return settle({ ok: false, code: 'version_changed', message: 'Someone changed this meanwhile. Reload and try again.' });
}
export async function woReasonOk(): Promise<Result> {
  return settle({ ok: true, message: 'Synthetic preview: saved with your reason.' });
}
