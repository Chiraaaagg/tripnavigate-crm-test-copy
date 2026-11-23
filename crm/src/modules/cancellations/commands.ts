import type { z } from 'zod';
import type { RpcClient, RpcError } from '@/modules/fulfilment/commands';
import {
  CANCELLATION_ERROR_STATES,
  type CancellationErrorCode,
  type FlightChargeResult,
  type VisaChoiceResult,
  type VisaFeeRefundResult,
} from './contracts';
import { FlightChargeResultSchema, VisaChoiceResultSchema, VisaFeeRefundResultSchema } from './dto';

/**
 * Typed wrappers for C9-C11 (migration 20261204000330) under the staff
 * member's OWN session. Errors map by SQLSTATE + exact token; anything
 * unexpected throws CancellationCommandError with code null (fail closed).
 */

const SESSION_STATES = new Set(['PGRST301', 'PGRST302', 'PGRST303', '401']);
const INPUT_STATES = new Set(['22023', '22P02', '22001', '22003', '22007', '22008', '23514', '23502']);

export class CancellationCommandError extends Error {
  override name = 'CancellationCommandError';
  constructor(
    readonly command: string,
    readonly code: CancellationErrorCode | 'session' | null,
    readonly sqlState: string | null,
    readonly hint: string | null = null,
  ) {
    super(`${command} failed${sqlState ? ` (${sqlState})` : ''}${code ? `: ${code}` : ''}`);
  }
}

export function mapCancellationError(error: RpcError): CancellationErrorCode | 'session' | null {
  const state = error.code ?? '';
  const token = (error.message ?? '').trim();
  if (Object.hasOwn(CANCELLATION_ERROR_STATES, token) && CANCELLATION_ERROR_STATES[token as CancellationErrorCode] === state) {
    return token as CancellationErrorCode;
  }
  // The Visa replay reports a request reused with other details as duplicate_request (40001).
  if (token === 'duplicate_request' && state === '40001') return 'duplicate_request';
  if (SESSION_STATES.has(state)) return 'session';
  if (state === '42501') return 'not_authorized';
  if (state === 'P0002') return 'not_found';
  if (INPUT_STATES.has(state)) return 'invalid_input';
  return null;
}

async function invoke(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  let result: { data: unknown; error: RpcError | null };
  try {
    result = await client.rpc(fn, args);
  } catch {
    throw new CancellationCommandError(fn, null, null);
  }
  if (result.error) {
    throw new CancellationCommandError(fn, mapCancellationError(result.error), result.error.code ?? null, result.error.hint ?? null);
  }
  return result.data;
}

function parse<T>(fn: string, schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new CancellationCommandError(fn, null, null);
  return parsed.data;
}

export interface FlightChargeFields {
  airlineChargePaise: string;
  refundExpectedPaise: string;
  refundReportedPaise: string | null;
  note: string | null;
}

/** C9: Flight charge revision of one ticket batch. */
export async function flightCancellationChargeSet(client: RpcClient, batchId: string, fields: FlightChargeFields, expectedRevision: number,
  requestId: string): Promise<FlightChargeResult> {
  const fn = 'flight_cancellation_charge_set';
  return parse(fn, FlightChargeResultSchema, await invoke(client, fn, {
    p_batch_id: batchId, p_fields: fields, p_expected_revision: expectedRevision, p_request_id: requestId }));
}

/** C10: withdraw | finish for one submitted application of a cancelled trip. */
export async function visaCancellationChoice(client: RpcClient, input: { applicationId: string; expectedRowVersion: number;
  choice: 'withdraw' | 'finish'; reason: string; requestId: string }): Promise<VisaChoiceResult> {
  const fn = 'visa_application_cancellation_choice';
  return parse(fn, VisaChoiceResultSchema, await invoke(client, fn, {
    p_application_id: input.applicationId, p_expected_row_version: input.expectedRowVersion, p_choice: input.choice,
    p_reason: input.reason, p_request_id: input.requestId }));
}

/** C11: refund expected back on a company-paid Visa fee. */
export async function visaCancellationFeeSet(client: RpcClient, input: { entryId: string; refundExpectedPaise: string; note: string | null;
  expectedRevision: number; requestId: string }): Promise<VisaFeeRefundResult> {
  const fn = 'visa_cancellation_fee_set';
  return parse(fn, VisaFeeRefundResultSchema, await invoke(client, fn, {
    p_entry_id: input.entryId, p_refund_expected_paise: input.refundExpectedPaise, p_note: input.note,
    p_expected_revision: input.expectedRevision, p_request_id: input.requestId }));
}
