import { z } from 'zod';
import type { RpcClient, RpcError } from '@/modules/fulfilment/commands';
import { RATE_ERROR_STATES, type RateErrorCode } from './contracts';
import {
  ContractWriteSchema,
  FileBeginSchema,
  FileDownloadSchema,
  FileFinishSchema,
  RateContractChoicesSchema,
  RateContractDetailSchema,
  RateContractLookupSchema,
  RateContractPageSchema,
  RateContractsStateSchema,
  RateSheetApplySchema,
  RateSheetGetSchema,
  RateSheetSummarySchema,
  RoomTypeWriteSchema,
  SwitchSchema,
} from './dto';
import { stateMatches } from '@/lib/sqlstate';

/**
 * Typed wrappers for the rate contract commands and reads (migrations
 * 20261205000500..0540). Every call runs under the staff member's OWN
 * session; the database authorizes and audits. Replies are zod-validated
 * (anything unexpected throws RateCommandError with code null: fail closed).
 * Database messages never reach the browser: errors map by SQLSTATE + token.
 */

const SESSION_STATES = new Set(['PGRST301', 'PGRST302', 'PGRST303', '401']);
const INPUT_STATES = new Set(['22023', '22P02', '22001', '22003', '22007', '22008', '23514', '23502']);
const REASON_MESSAGE = 'a reason of 10 to 500 characters is required';

export class RateCommandError extends Error {
  override name = 'RateCommandError';
  constructor(
    readonly command: string,
    readonly code: RateErrorCode | 'session' | null,
    readonly sqlState: string | null,
    /** The refused field for invalid_input / lines_overlap (database hint, e.g. lines[2].seasonTo). */
    readonly hint: string | null = null,
  ) {
    super(`${command} failed${sqlState ? ` (${sqlState})` : ''}${code ? `: ${code}` : ''}`);
  }
}

export function mapRateError(error: RpcError): RateErrorCode | 'session' | null {
  const state = error.code ?? '';
  const token = (error.message ?? '').trim();
  if (Object.hasOwn(RATE_ERROR_STATES, token) && stateMatches(RATE_ERROR_STATES[token as RateErrorCode], state)) return token as RateErrorCode;
  if (token === REASON_MESSAGE && state === '22023') return 'invalid_input';
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
    throw new RateCommandError(fn, null, null);
  }
  if (result.error) {
    const code = mapRateError(result.error);
    const hint = result.error.hint ?? ((result.error.message ?? '').trim() === REASON_MESSAGE ? 'reason' : null);
    throw new RateCommandError(fn, code, result.error.code ?? null, hint);
  }
  return result.data;
}

function parse<T>(fn: string, schema: z.ZodType<T, unknown>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new RateCommandError(fn, null, null);
  return parsed.data;
}

async function call<T>(client: RpcClient, fn: string, args: Record<string, unknown>, schema: z.ZodType<T, unknown>): Promise<T> {
  return parse(fn, schema, await invoke(client, fn, args));
}

// ---------------------------------------------------------------------------
// Switch (E1)
// ---------------------------------------------------------------------------

export function setRateContractsEnabled(client: RpcClient, enabled: boolean, reason: string) {
  return call(client, 'admin_set_rate_contracts_enabled', { p_enabled: enabled, p_reason: reason }, SwitchSchema);
}

// ---------------------------------------------------------------------------
// Room types (E2)
// ---------------------------------------------------------------------------

export function roomTypeSave(client: RpcClient, args: { hotelId: string | null; roomTypeId: string | null; expectedRowVersion: number; name: string; requestId: string }) {
  return call(client, 'hotel_room_type_save', {
    p_hotel_id: args.hotelId, p_room_type_id: args.roomTypeId, p_expected_row_version: args.expectedRowVersion, p_name: args.name,
    p_request_id: args.requestId,
  }, RoomTypeWriteSchema);
}

export function roomTypeRemove(client: RpcClient, args: { roomTypeId: string; reason: string; requestId: string }) {
  return call(client, 'hotel_room_type_remove', { p_room_type_id: args.roomTypeId, p_reason: args.reason, p_request_id: args.requestId },
    RoomTypeWriteSchema);
}

// ---------------------------------------------------------------------------
// Contracts (E3, E4, E6, E7, E8)
// ---------------------------------------------------------------------------

export interface ContractFields {
  supplierId?: string;
  hotelId?: string;
  validFrom?: string;
  validTo?: string;
  cancellationTerms?: string | null;
  note?: string | null;
}

export interface LineInput {
  seasonFrom: string;
  seasonTo: string;
  roomTypeId: string;
  mealPlan: string;
  ratePaise: string;
  weekendRatePaise: string | null;
  extraAdultPaise: string | null;
  childWithBedPaise: string | null;
  childWithoutBedPaise: string | null;
  note: string | null;
}

export function contractSave(client: RpcClient, args: { contractId: string | null; expectedRowVersion: number; fields: ContractFields; requestId: string }) {
  return call(client, 'rate_contract_save', {
    p_contract_id: args.contractId, p_expected_row_version: args.expectedRowVersion, p_fields: args.fields, p_request_id: args.requestId,
  }, ContractWriteSchema);
}

export function contractLinesSet(client: RpcClient, args: {
  contractId: string; expectedRowVersion: number; lines: LineInput[]; blackouts: Array<{ fromDate: string; toDate: string }>; requestId: string;
}) {
  return call(client, 'rate_contract_lines_set', {
    p_contract_id: args.contractId, p_expected_row_version: args.expectedRowVersion, p_lines: args.lines, p_blackouts: args.blackouts,
    p_request_id: args.requestId,
  }, ContractWriteSchema);
}

export function contractSubmit(client: RpcClient, args: { contractId: string; expectedRowVersion: number; requestId: string }) {
  return call(client, 'rate_contract_submit', {
    p_contract_id: args.contractId, p_expected_row_version: args.expectedRowVersion, p_request_id: args.requestId,
  }, ContractWriteSchema);
}

export function contractDecide(client: RpcClient, args: {
  contractId: string; decision: 'approve' | 'return'; reason: string | null; expectedRowVersion: number; requestId: string;
}) {
  return call(client, 'rate_contract_decide', {
    p_contract_id: args.contractId, p_decision: args.decision, p_reason: args.reason, p_expected_row_version: args.expectedRowVersion,
    p_request_id: args.requestId,
  }, ContractWriteSchema);
}

export function contractEnd(client: RpcClient, args: { contractId: string; expectedRowVersion: number; reason: string; requestId: string }) {
  return call(client, 'rate_contract_end', {
    p_contract_id: args.contractId, p_expected_row_version: args.expectedRowVersion, p_reason: args.reason, p_request_id: args.requestId,
  }, ContractWriteSchema);
}

// ---------------------------------------------------------------------------
// Files (E5)
// ---------------------------------------------------------------------------

export function fileBegin(client: RpcClient, args: { contractId: string; fileName: string; mime: string; sizeBytes: number; sha256: string }) {
  return call(client, 'rate_contract_file_begin', {
    p_contract_id: args.contractId, p_file_name: args.fileName, p_mime: args.mime, p_size_bytes: args.sizeBytes, p_sha256: args.sha256,
  }, FileBeginSchema);
}

export function fileFinish(client: RpcClient, fileId: string, ok: boolean) {
  return call(client, 'rate_contract_file_finish', { p_file_id: fileId, p_ok: ok }, FileFinishSchema);
}

export function fileAuthorizeDownload(client: RpcClient, fileId: string) {
  return call(client, 'rate_contract_file_authorize_download', { p_file_id: fileId }, FileDownloadSchema);
}

// ---------------------------------------------------------------------------
// Reads (R-E1..R-E3); null = not allowed (section 14 fence)
// ---------------------------------------------------------------------------

export interface RateContractFilter {
  supplierId?: string;
  hotelId?: string;
  status?: string[];
  endingWithinDays?: number;
  q?: string;
  preset?: 'to_approve' | 'ending_soon';
}

export function contractsList(client: RpcClient, args: { filter?: RateContractFilter; after?: string | null; limit?: number }) {
  return call(client, 'rate_contracts_list', { p_filter: args.filter ?? {}, p_after: args.after ?? null, p_limit: args.limit ?? 50 },
    RateContractPageSchema.nullable());
}

export function contractGet(client: RpcClient, contractId: string) {
  return call(client, 'rate_contract_get', { p_contract_id: contractId }, RateContractDetailSchema.nullable());
}

export function contractLookup(client: RpcClient, args: {
  taskId: string; supplierId: string; hotelId: string; roomTypeId: string | null; mealPlanCode: string | null;
}) {
  return call(client, 'rate_contract_lookup', {
    p_task_id: args.taskId, p_supplier_id: args.supplierId, p_hotel_id: args.hotelId, p_room_type_id: args.roomTypeId,
    p_meal_plan_code: args.mealPlanCode,
  }, RateContractLookupSchema.nullable());
}

export function contractsState(client: RpcClient) {
  return call(client, 'rate_contracts_state', {}, RateContractsStateSchema.nullable());
}

export function contractChoices(client: RpcClient) {
  return call(client, 'rate_contract_choices', {}, RateContractChoicesSchema.nullable());
}

// ---------------------------------------------------------------------------
// Rate-sheet import (9.4): the shared import commands with kind 'rate_sheet'
// ---------------------------------------------------------------------------

export function rateSheetStage(client: RpcClient, args: { legalEntityId: string; fileName: string; sha256: string; rows: Array<Record<string, string | null>>; requestId: string }) {
  return call(client, 'import_batch_stage', {
    p_legal_entity_id: args.legalEntityId, p_kind: 'rate_sheet', p_branch_id: null, p_file_name: args.fileName, p_sha256: args.sha256,
    p_rows: args.rows, p_request_id: args.requestId, p_entity_wide: false,
  }, z.object({ batchId: z.uuid(), rowCount: z.number().int(), outcome: z.enum(['created', 'existing']) }));
}

export function rateSheetValidate(client: RpcClient, batchId: string) {
  return call(client, 'import_batch_validate', { p_batch_id: batchId }, RateSheetSummarySchema);
}

export function rateSheetGet(client: RpcClient, args: { batchId: string; limit?: number; offset?: number }) {
  return call(client, 'import_batch_get', { p_batch_id: args.batchId, p_limit: args.limit ?? 200, p_offset: args.offset ?? 0 }, RateSheetGetSchema);
}

export function rateSheetApply(client: RpcClient, args: { batchId: string; expectedRowVersion: number; reason: string; proposalHash: string | null }) {
  return call(client, 'import_batch_apply', {
    p_batch_id: args.batchId, p_expected_row_version: args.expectedRowVersion, p_reason: args.reason, p_proposal_hash: args.proposalHash,
  }, RateSheetApplySchema);
}
