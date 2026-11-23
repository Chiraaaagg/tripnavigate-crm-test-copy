'use server';

import { MORE_PAGE } from './acc-fixtures';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY. Stand-in server actions for the Accounts
 * phase screens (acc- states, Phase 0 states), so a press shows the real
 * success or refusal path without a database. They read nothing, write
 * nothing and return fixed synthetic answers; the gallery is a 404 outside
 * the local preview mode.
 */

type Result = { ok: true; data?: unknown; message: string } | { ok: false; code: string; message: string; fields?: string[] };

async function settle<T>(value: T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  return value;
}
const ok = (message: string, data?: unknown): Promise<Result> => settle({ ok: true, message, data });
const no = (code: string, message: string, fields?: string[]): Promise<Result> => settle({ ok: false, code, message, fields });

/* Phase 0 */
export async function accCancelOk(): Promise<Result> {
  return ok('Payment request cancelled.');
}
export async function accCancelRefused(): Promise<Result> {
  return no('not_authorized', 'You cannot cancel this payment request. Only the person who asked for it or the current Flight owner can.');
}

/* Workspace row actions */
export async function accMatchOk(): Promise<Result> {
  return ok('Synthetic preview: marked matched in Tally.');
}
export async function accMatchRefused(): Promise<Result> {
  return no('version_changed', 'Someone changed this meanwhile. Reload and try again.');
}
export async function accExceptionOk(): Promise<Result> {
  return ok('Synthetic preview: exception raised. The exception owner is told.');
}
export async function accReopenOk(): Promise<Result> {
  return ok('Synthetic preview: reopened.');
}
export async function accReopenRefused(): Promise<Result> {
  return no('wrong_state', 'This step is already done. Reload the page.', ['neverExported']);
}
export async function accLinkOk(): Promise<Result> {
  return ok('Synthetic preview: bill linked to the task.');
}
export async function accLinkRefused(): Promise<Result> {
  return no('link_not_allowed', 'This bill cannot be linked to that task: the supplier is different or the task has no work with this supplier.', ['taskId']);
}

/* Deal money card */
export async function accInvoiceAddOk(): Promise<Result> {
  return ok('Synthetic preview: GST invoice reference recorded.');
}
export async function accInvoiceAddDuplicate(): Promise<Result> {
  return no('duplicate_tally_invoice', 'This GST invoice reference is already recorded for this financial year.', ['invoiceRef']);
}
export async function accInvoiceWithdrawOk(): Promise<Result> {
  return ok('Synthetic preview: GST invoice reference withdrawn.');
}

/* Tally export */
export async function accExportOk(): Promise<Result> {
  return ok('Export TE-2026-000012: 340 rows (12 exported before).', { exportId: 'e7000000-0000-4000-8000-000000000012', exportNo: 'TE-2026-000012', rowCount: 340, alreadyExportedCount: 12, skippedCount: 0 });
}
export async function accExportTooLarge(): Promise<Result> {
  return no('export_too_large', 'More than 10,000 rows. Narrow the dates.', ['from']);
}
export async function accExportNothing(): Promise<Result> {
  return no('nothing_to_export', 'Nothing is ready to export for these dates.');
}

/* Settings */
export async function accSettingOk(): Promise<Result> {
  return ok('Synthetic preview: saved. The change is recorded with your reason.');
}
export async function accSettingRefused(): Promise<Result> {
  return no('invalid_input', 'Check the highlighted field.', ['reason']);
}

/* Purchase booking change */
export async function accAckOk(): Promise<Result> {
  return ok('Synthetic preview: marked as seen. The banner shows again only if the booking changes again.');
}
export async function accAckStale(): Promise<Result> {
  return no('version_changed', 'Someone changed this meanwhile. Reload and try again.');
}

/* Supplier bill upload */
export async function accUploadDuplicate(): Promise<Result> {
  return no('duplicate_supplier_document', 'This supplier bill is already recorded (same supplier, number and financial year). Link it to this task instead.', ['number']);
}

/* Workspace "Show more" */
export async function accLoadMore(after: string) {
  void after;
  return settle(MORE_PAGE);
}
export async function accLoadMoreFail(after: string) {
  void after;
  return settle({ error: 'The next rows could not be loaded. Try again.' });
}

/* Bell (preview mode never calls these; they exist so the bell's API is complete) */
export async function accNoticeNoop() {
  return settle({ ok: false as const, message: 'Synthetic preview.' });
}
