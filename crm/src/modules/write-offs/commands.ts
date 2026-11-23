import { z } from 'zod';
import type { RpcClient, RpcError } from '@/modules/fulfilment/commands';
import {
  WRITE_OFF_ERROR_STATES,
  type WriteOffCommandResult,
  type WriteOffDecision,
  type WriteOffDirection,
  type WriteOffErrorCode,
  type WriteOffSwitchResult,
} from './contracts';
import {
  SmallBalancesPageSchema,
  WriteOffCommandResultSchema,
  WriteOffMonthlySchema,
  WriteOffSwitchResultSchema,
  type SmallBalancesFilter,
  type SmallBalancesPage,
  type WriteOffMonthly,
} from './dto';

/**
 * Typed wrappers of the write-off commands and reads (contract 6.1 B2, 6.6
 * B3-B6, R-B1, R-B2). Every call runs under the CALLER's client (the staff
 * member's own session); replies are validated with zod and anything
 * unexpected throws WriteOffCommandError with code null (fail closed).
 * Database messages never reach the browser: errors map by SQLSTATE + token.
 */

const SESSION_STATES = new Set(['PGRST301', 'PGRST302', 'PGRST303', '401']);
const INPUT_STATES = new Set(['22023', '22P02', '22001', '22003', '22007', '22008', '23514', '23502']);

export class WriteOffCommandError extends Error {
  override name = 'WriteOffCommandError';
  constructor(
    readonly command: string,
    readonly code: WriteOffErrorCode | 'session' | null,
    readonly sqlState: string | null,
    /** invalid_input: the refused field; not_ready: the blocker; write_off_over_limit: "limitPaise=<paise>". */
    readonly hint: string | null = null,
  ) {
    super(`${command} failed${sqlState ? ` (${sqlState})` : ''}${code ? `: ${code}` : ''}`);
  }
}

export function mapWriteOffError(error: RpcError): WriteOffErrorCode | 'session' | null {
  const state = error.code ?? '';
  const token = (error.message ?? '').trim();
  if (Object.hasOwn(WRITE_OFF_ERROR_STATES, token) && WRITE_OFF_ERROR_STATES[token as WriteOffErrorCode] === state) {
    return token as WriteOffErrorCode;
  }
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
    throw new WriteOffCommandError(fn, null, null);
  }
  if (result.error) throw new WriteOffCommandError(fn, mapWriteOffError(result.error), result.error.code ?? null, result.error.hint ?? null);
  return result.data;
}

function parse<T>(fn: string, schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new WriteOffCommandError(fn, null, null);
  return parsed.data;
}

const command = (client: RpcClient, fn: string, args: Record<string, unknown>): Promise<WriteOffCommandResult> =>
  invoke(client, fn, args).then((data) => parse(fn, WriteOffCommandResultSchema, data));

/** B3 fields: the amount is the whole balance shown (paise string), never typed. */
export interface WriteOffProposeFields {
  direction: WriteOffDirection;
  amountPaise: string;
  reason: string;
}

// B3
export function writeOffPropose(client: RpcClient, dealId: string, fields: WriteOffProposeFields, requestId: string) {
  return command(client, 'write_off_propose', { p_deal_id: dealId, p_fields: fields, p_request_id: requestId });
}
// B4 (p_expected_amount_paise is a bigint: sent as a decimal string, never a float)
export function writeOffDecide(client: RpcClient, writeOffId: string, decision: WriteOffDecision, expectedAmountPaise: string,
  reason: string | null, expectedRowVersion: number, requestId: string) {
  return command(client, 'write_off_decide', {
    p_id: writeOffId,
    p_decision: decision,
    p_expected_amount_paise: expectedAmountPaise,
    p_reason: reason,
    p_expected_row_version: expectedRowVersion,
    p_request_id: requestId,
  });
}
// B5
export function writeOffWithdraw(client: RpcClient, writeOffId: string, expectedRowVersion: number, reason: string, requestId: string) {
  return command(client, 'write_off_withdraw', { p_id: writeOffId, p_expected_row_version: expectedRowVersion, p_reason: reason, p_request_id: requestId });
}
// B6
export function writeOffUndo(client: RpcClient, writeOffId: string, expectedRowVersion: number, reason: string, requestId: string) {
  return command(client, 'write_off_undo', { p_id: writeOffId, p_expected_row_version: expectedRowVersion, p_reason: reason, p_request_id: requestId });
}
// B2 (finance policy managers)
export async function setWriteOff(client: RpcClient, entityId: string, enabled: boolean, limitPaise: string, reason: string): Promise<WriteOffSwitchResult> {
  const fn = 'admin_set_write_off';
  return parse(fn, WriteOffSwitchResultSchema, await invoke(client, fn, { p_entity: entityId, p_enabled: enabled, p_limit_paise: limitPaise, p_reason: reason }));
}

// Reads (null = not allowed)
export async function readSmallBalances(client: RpcClient, filter: SmallBalancesFilter, after: string | null, limit = 50): Promise<SmallBalancesPage | null> {
  const fn = 'small_balances_list';
  const data = await invoke(client, fn, { p_filter: filter, p_after: after, p_limit: limit });
  return data === null ? null : parse(fn, SmallBalancesPageSchema, data);
}
/** p_month: any date of the month, "YYYY-MM-DD". */
export async function readWriteOffMonthly(client: RpcClient, month: string): Promise<WriteOffMonthly | null> {
  const fn = 'write_off_monthly';
  const data = await invoke(client, fn, { p_month: month });
  return data === null ? null : parse(fn, WriteOffMonthlySchema, data);
}
