'use server';

import { PROCUREMENT_ERROR_TEXT, PURCHASE_BUILD_TEXT, type ProcurementActionResult } from '@/modules/procurement/contracts';
import { SUPPLIER_MONEY_DONE_TEXT, SUPPLIER_MONEY_ERROR_TEXT } from '@/modules/supplier-money/contracts';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY. Stand-in server actions for the Purchase
 * build's Purchase screens (pb- states), so a press shows the real success or
 * refusal path without a database. They read nothing, write nothing and
 * return fixed synthetic answers; the gallery is a 404 outside the local
 * preview mode.
 */

type Result = { ok: true; data: unknown; message: string } | { ok: false; code: string; message: string; values?: Record<string, string> };

async function settle<T>(value: T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  return value;
}

export async function pbAddRateAction(): Promise<Result> {
  return settle({ ok: true, data: { quoteId: 'e0000000-0000-4000-8000-0000000000aa' }, message: 'Synthetic preview: rate added.' });
}

export async function pbUseFinalRateAction(): Promise<Result> {
  return settle({ ok: false, code: 'payment_in_progress', message: PROCUREMENT_ERROR_TEXT.payment_in_progress });
}

export async function pbEmailAction(): Promise<Result> {
  return settle({ ok: true, data: { emailId: 'e0000000-0000-4000-8000-0000000000bb', status: 'marked_sent', outcome: 'created' }, message: PURCHASE_BUILD_TEXT.emailMarkedSent });
}

export async function pbBookingRequestAction(): Promise<Result> {
  return settle({ ok: true, data: null, message: PURCHASE_BUILD_TEXT.bookingRequestRecorded });
}

export async function pbChargeAction(): Promise<Result> {
  return settle({ ok: true, data: null, message: PURCHASE_BUILD_TEXT.chargeSaved });
}

export async function pbSendChargesAction(): Promise<Result> {
  return settle({ ok: false, code: 'not_ready', message: 'Synthetic preview: every Purchase service of the Deal needs its charges first.' });
}

/** Mirrors uploadSupplierMoneyFileAction's target rule: a payment proof needs paymentId; other kinds need taskId. */
function uploadTargetMissing(formData: FormData): boolean {
  const kind = formData.get('kind');
  const target = kind === 'payment_proof' ? formData.get('paymentId') : formData.get('taskId');
  return typeof target !== 'string' || !/^[0-9a-f-]{36}$/.test(target) || !(formData.get('file') instanceof Blob);
}

export async function pbUploadAction(_prev: unknown, formData: FormData): Promise<Result> {
  if (uploadTargetMissing(formData)) return settle({ ok: false, code: 'invalid_input', message: 'Synthetic preview: the upload names no payment request or task.' });
  return settle({ ok: true, data: { evidenceId: 'b0000000-0000-4000-8000-0000000000cc' }, message: SUPPLIER_MONEY_DONE_TEXT.fileUploaded });
}

export async function pbCreatePaymentAction(): Promise<Result> {
  return settle({ ok: false, code: 'customer_money_short', message: SUPPLIER_MONEY_ERROR_TEXT.customer_money_short });
}

export async function pbCancelPaymentAction(): Promise<Result> {
  return settle({ ok: true, data: null, message: SUPPLIER_MONEY_DONE_TEXT.requestCancelled });
}

export async function pbDocumentAction(): Promise<Result> {
  return settle({ ok: true, data: null, message: SUPPLIER_MONEY_DONE_TEXT.documentUploaded });
}

export async function pbConfirmAction(...args: [unknown, FormData]): Promise<ProcurementActionResult<{ outcome: 'created' | 'existing' }>> {
  void args;
  return pbConfirmRefusal();
}

async function pbConfirmRefusal(): Promise<ProcurementActionResult<{ outcome: 'created' | 'existing' }>> {
  return settle({ ok: false, code: 'go_ahead_missing', message: PROCUREMENT_ERROR_TEXT.go_ahead_missing });
}
