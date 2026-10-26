'use server';

import { ERROR_TEXT, type BookingActionResult } from '@/modules/fulfilment/contracts';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY. Stand-in server actions for the booking
 * form states: they read nothing, write nothing and return fixed answers, so
 * the gallery shows saves and refusals (typed values kept, fields named)
 * through the real form path. The gallery page is a 404 outside local
 * preview mode.
 */

type Result = BookingActionResult<unknown>;

async function settle<T>(value: T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  return value;
}

function invalid(fields: string[]): Result {
  return { ok: false, code: 'invalid_input', message: ERROR_TEXT.invalid_input, fields };
}

export async function previewBookformSavedAction(): Promise<Result> {
  return settle({ ok: true, data: { rowVersion: 8 }, message: 'Saved.' });
}

export async function previewBookformRefuseCustomerAction(): Promise<Result> {
  return settle(invalid(['mobile', 'paxTotal']));
}

export async function previewBookformRefusePricesAction(): Promise<Result> {
  return settle(invalid(['priceSaleRupees[adult]']));
}

export async function previewBookformRefuseBillToAction(): Promise<Result> {
  return settle(invalid(['gstReason', 'postalCode']));
}

export async function previewBookformRefuseServiceAction(): Promise<Result> {
  return settle(invalid(['segmentDate[0]', 'passengers']));
}
