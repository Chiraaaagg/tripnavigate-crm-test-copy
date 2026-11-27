'use server';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY. Stand-in server actions for the Accounts
 * phase 2 trip-cancellation screens (acc2-cancel- states), so a press shows
 * the real success or refusal path without a database. They read nothing,
 * write nothing and return fixed synthetic answers; the gallery is a 404
 * outside the local preview mode.
 */

type Result = { ok: true; data?: unknown; message: string } | { ok: false; code: string; message: string; field?: string };

async function settle<T>(value: T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  return value;
}
const ok = (message: string, data?: unknown): Promise<Result> => settle({ ok: true, message, data });
const no = (code: string, message: string, field?: string): Promise<Result> => settle({ ok: false, code, message, ...(field ? { field } : {}) });

export async function cxChargeOk(): Promise<Result> {
  return ok('Synthetic preview: airline charges saved as revision 2. The branch Manager sees them with the cancellation.');
}
export async function cxChargeVersionChanged(): Promise<Result> {
  return no('version_changed', 'Someone changed this meanwhile. Reload and try again.');
}
export async function cxChargeTooHigh(): Promise<Result> {
  return no('invalid_input', 'Check the highlighted field: the airline charge cannot be more than the supplier cost.', 'airlineChargePaise');
}
export async function cxChoiceOk(): Promise<Result> {
  return ok('Synthetic preview: choice saved. The application is withdrawn and the passport handover follows.');
}
export async function cxChoiceReason(): Promise<Result> {
  return no('invalid_input', 'Check the highlighted field: write 10 to 300 characters.', 'reason');
}
export async function cxFeeOk(): Promise<Result> {
  return ok('Synthetic preview: refund expected saved. Accounts sees it with the supplier refunds due.');
}
export async function cxFeeVersionChanged(): Promise<Result> {
  return no('version_changed', 'Someone changed this meanwhile. Reload and try again.');
}
export async function cxDecideOk(): Promise<Result> {
  return ok('Synthetic preview: cancellation charges approved.');
}
