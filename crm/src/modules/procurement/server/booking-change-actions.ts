'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { readUuid } from '@/modules/fulfilment/forms';
import { requireStaff } from '@/modules/identity/server/session';
import {
  BOOKING_CHANGE_ERROR_TEXT,
  BOOKING_CHANGE_TEXT,
  BookingChangeError,
  type BookingChangeAckResult,
  type BookingChangeErrorCode,
  type PurchaseBookingChangeDTO,
  type PurchaseHomeCountsDTO,
  isBookingChangeFunctionMissing,
} from '../booking-change';
import { purchaseBookingChange, purchaseBookingChangeAck, purchaseHomeCounts } from './booking-change-rpc';

/**
 * Purchase "Booking changed" banner, "OK, seen" and the Home row (contract
 * 7.6, 8.5, 11.7, 11.8). requireStaff() first; the database (own session)
 * decides who reads (Purchase people, the branch Manager read-only) and who
 * acknowledges (the task's assignee), checks the expected basis version and
 * audits purchase.booking_change_seen in the same transaction. No commercial
 * value is ever part of the read.
 *
 * Form fields of the acknowledgement: taskId, expectedBasisVersionId, requestId.
 */

export type BookingChangeActionResult =
  | { ok: true; data: BookingChangeAckResult; message: string }
  | { ok: false; code: BookingChangeErrorCode | 'session' | 'failed'; message: string; fields?: string[] };

const UNKNOWN_OUTCOME = 'We could not confirm this was saved. Reload the page to check before trying again.';

/** The banner of a Purchase task; null = nothing changed, not readable, or not available. */
export async function loadPurchaseBookingChange(taskId: string): Promise<PurchaseBookingChangeDTO | null> {
  const staff = await requireStaff();
  const id = z.uuid().safeParse(taskId);
  if (!id.success) return null;
  try {
    return await purchaseBookingChange(asRpcClient(staff.supabase), id.data);
  } catch (error) {
    if (isBookingChangeFunctionMissing(error) || (error instanceof BookingChangeError && error.code === 'not_authorized')) return null;
    throw new Error('Could not check this booking for changes. Please retry.');
  }
}

/** Home row "Bookings changed on your tasks"; null when not a Purchase holder or unavailable (Home leaves it out). */
export async function loadPurchaseHomeCounts(): Promise<PurchaseHomeCountsDTO | null> {
  const staff = await requireStaff();
  try {
    return await purchaseHomeCounts(asRpcClient(staff.supabase));
  } catch {
    return null;
  }
}

/** "OK, seen" on the banner (the task's assignee). */
export async function acknowledgeBookingChangeAction(
  _prev: BookingChangeActionResult | null,
  formData: FormData,
): Promise<BookingChangeActionResult> {
  const staff = await requireStaff();
  const taskId = readUuid(formData, 'taskId');
  const expectedBasisVersionId = readUuid(formData, 'expectedBasisVersionId');
  const requestId = readUuid(formData, 'requestId');
  const missing = [
    ...(taskId ? [] : ['taskId']),
    ...(expectedBasisVersionId ? [] : ['expectedBasisVersionId']),
    ...(requestId ? [] : ['requestId']),
  ];
  if (!taskId || !expectedBasisVersionId || !requestId) {
    return { ok: false, code: 'invalid_input', message: BOOKING_CHANGE_ERROR_TEXT.invalid_input, fields: missing };
  }
  try {
    const data = await purchaseBookingChangeAck(asRpcClient(staff.supabase), { taskId, expectedBasisVersionId, requestId });
    revalidatePath(`/app/purchase/${taskId}`);
    revalidatePath('/app/purchase');
    revalidatePath('/app');
    return { ok: true, data, message: BOOKING_CHANGE_TEXT.acked };
  } catch (error) {
    if (error instanceof BookingChangeError && error.code) {
      return { ok: false, code: error.code, message: BOOKING_CHANGE_ERROR_TEXT[error.code] };
    }
    return { ok: false, code: 'failed', message: UNKNOWN_OUTCOME };
  }
}
