import 'server-only';
import { z } from 'zod';
import type { RpcClient, RpcError } from '@/modules/fulfilment/commands';
import {
  BookingChangeError,
  type BookingChangeAckResult,
  type PurchaseBookingChangeDTO,
  type PurchaseHomeCountsDTO,
  mapBookingChangeError,
  toBookingChangeDTO,
} from '../booking-change';

/**
 * Purchase "Booking changed" RPC wrappers and zod schemas (server only; the
 * pure labels, DTO types and formatting are in ../booking-change.ts, which the
 * banner imports in the browser). Contract 7.6, 8.5; migration 20261203000430.
 */

const travellerType = z.enum(['adult', 'child', 'infant']);
const traveller = z.object({ seq: z.number().int().positive(), name: z.string(), type: travellerType });
const pair = <T extends z.ZodType>(t: T) => z.object({ seq: z.number().int().positive(), before: t, after: t });
const datePair = z.object({ before: z.string().nullable(), after: z.string().nullable() });

const RawFieldSchema = z.object({ key: z.string().min(1).max(80), before: z.unknown(), after: z.unknown() });

export const PurchaseBookingChangeRawSchema = z.object({
  taskId: z.uuid(),
  basisVersionId: z.uuid(),
  basisVersionNo: z.number().int().positive(),
  currentVersionId: z.uuid(),
  currentVersionNo: z.number().int().positive(),
  changedAt: z.string().nullable(),
  canAck: z.boolean(),
  budgetChanged: z.boolean(),
  fields: z.array(RawFieldSchema),
  travellers: z.object({
    added: z.array(traveller),
    removed: z.array(traveller),
    renamed: z.array(pair(z.string())),
    typeChanged: z.array(pair(travellerType)),
  }),
  tripChanged: z
    .object({ destination: datePair.optional(), start: datePair.optional(), end: datePair.optional() })
    .nullable(),
});


export const BookingChangeAckResultSchema = z.object({
  outcome: z.enum(['updated', 'existing']),
  taskId: z.uuid(),
  basisVersionId: z.uuid(),
  rowVersion: z.number().int().positive(),
});

export const PurchaseHomeCountsSchema = z.object({
  purchaseBookingChanged: z.number().int().nonnegative(),
  purchaseBookingChangedTaskId: z.uuid().nullable(),
});

async function invoke(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  let result: { data: unknown; error: RpcError | null };
  try {
    result = await client.rpc(fn, args);
  } catch {
    throw new BookingChangeError(fn, null, null);
  }
  if (result.error) throw new BookingChangeError(fn, mapBookingChangeError(result.error), result.error.code ?? null);
  return result.data;
}

/** The banner of one Purchase task; null when not readable or nothing changed. */
export async function purchaseBookingChange(client: RpcClient, taskId: string): Promise<PurchaseBookingChangeDTO | null> {
  const fn = 'purchase_booking_change';
  const data = await invoke(client, fn, { p_task_id: taskId });
  if (data === null) return null;
  const parsed = PurchaseBookingChangeRawSchema.safeParse(data);
  if (!parsed.success) throw new BookingChangeError(fn, null, null);
  return toBookingChangeDTO(parsed.data);
}

/** P1 "OK, seen" (the assignee): moves the basis to the current version. */
export async function purchaseBookingChangeAck(
  client: RpcClient,
  input: { taskId: string; expectedBasisVersionId: string; requestId: string },
): Promise<BookingChangeAckResult> {
  const fn = 'purchase_booking_change_ack';
  const data = await invoke(client, fn, {
    p_task_id: input.taskId,
    p_expected_basis_version_id: input.expectedBasisVersionId,
    p_request_id: input.requestId,
  });
  const parsed = BookingChangeAckResultSchema.safeParse(data);
  if (!parsed.success) throw new BookingChangeError(fn, null, null);
  return parsed.data;
}

/** Home row "Bookings changed on your tasks" (Purchase holders; null otherwise). */
export async function purchaseHomeCounts(client: RpcClient): Promise<PurchaseHomeCountsDTO | null> {
  const fn = 'purchase_home_counts';
  const data = await invoke(client, fn, {});
  if (data === null) return null;
  const parsed = PurchaseHomeCountsSchema.safeParse(data);
  if (!parsed.success) throw new BookingChangeError(fn, null, null);
  return parsed.data;
}

// Compile-time checks: the schemas produce exactly the shared DTO types.
export type _AckCheck = z.output<typeof BookingChangeAckResultSchema> extends BookingChangeAckResult ? true : never;
export type _HomeCheck = z.output<typeof PurchaseHomeCountsSchema> extends PurchaseHomeCountsDTO ? true : never;
