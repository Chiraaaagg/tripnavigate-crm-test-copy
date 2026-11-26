'use server';

import { SUPPLIER_MONEY_DONE_TEXT, SUPPLIER_MONEY_ERROR_TEXT } from '@/modules/supplier-money/contracts';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY. Stand-in server actions for the Purchase
 * build's Accounts and Manager screens (pm- states), so a press shows the
 * real success or refusal path without a database. They read nothing, write
 * nothing and return fixed synthetic answers; the gallery is a 404 outside
 * the local preview mode.
 */

type Result = { ok: true; data: unknown; message: string } | { ok: false; code: string; message: string };

async function settle<T>(value: T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  return value;
}

/** Approve or return: answers with the frozen wording for the pressed decision. */
export async function pmPreviewDecideAction(_prev: unknown, formData: FormData): Promise<Result> {
  const decision = formData.get('decision');
  return settle({ ok: true, data: null, message: decision === 'return' ? 'Synthetic preview: returned with your reason.' : 'Synthetic preview: approved. Nothing is paid.' });
}

/** Always refuses: the booking review for that version is not approved. */
export async function pmPreviewBookingNotApprovedAction(): Promise<Result> {
  return settle({ ok: false, code: 'booking_not_approved', message: SUPPLIER_MONEY_ERROR_TEXT.booking_not_approved });
}

/** Mirrors uploadSupplierMoneyFileAction's target rule: a payment proof needs paymentId; other kinds need taskId. */
function uploadTargetMissing(formData: FormData): boolean {
  const kind = formData.get('kind');
  const target = kind === 'payment_proof' ? formData.get('paymentId') : formData.get('taskId');
  return typeof target !== 'string' || !/^[0-9a-f-]{36}$/.test(target) || !(formData.get('file') instanceof Blob);
}

export async function pmPreviewUploadAction(_prev: unknown, formData: FormData): Promise<Result> {
  if (uploadTargetMissing(formData)) return settle({ ok: false, code: 'invalid_input', message: 'Synthetic preview: the upload names no payment request or task.' });
  return settle({ ok: true, data: { evidenceId: 'b0000000-0000-4000-8000-0000000000aa', outcome: 'created', objectPath: 'synthetic' }, message: SUPPLIER_MONEY_DONE_TEXT.fileUploaded });
}

export async function pmPreviewRecordAction(): Promise<Result> {
  return settle({ ok: true, data: null, message: SUPPLIER_MONEY_DONE_TEXT.paymentRecorded });
}

export async function pmPreviewVerifyAction(): Promise<Result> {
  return settle({ ok: false, code: 'not_self_verification', message: SUPPLIER_MONEY_ERROR_TEXT.not_self_verification });
}

export async function pmPreviewRecoverAction(): Promise<Result> {
  return settle({ ok: true, data: null, message: SUPPLIER_MONEY_DONE_TEXT.fundingRecovered });
}
