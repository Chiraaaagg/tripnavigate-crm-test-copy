import type { z } from 'zod';
import type { RpcClient, RpcError } from '@/modules/fulfilment/commands';
import { FLIGHT_ERROR_STATES, type FlightErrorCode } from './contracts';
import {
  BookingChangeApplyResultSchema,
  ChangeAckResultSchema,
  ChangeDecisionResultSchema,
  ChangeSubmitResultSchema,
  DealFlightHistorySchema,
  DealFlightSummarySchema,
  EvidenceBegunSchema,
  EvidenceDownloadSchema,
  EvidenceFinishedSchema,
  FillBlanksResultSchema,
  FlightHomeCountsSchema,
  FlightQueueSchema,
  FlightWorkspaceSchema,
  GroupClaimResultSchema,
  GroupCompleteResultSchema,
  GroupReassignResultSchema,
  ScreenshotSaveResultSchema,
  TicketCorrectResultSchema,
  TravellerNameFillResultSchema,
} from './dto';

/**
 * Typed wrappers for the Flight workspace commands and reads (migrations
 * 20261201000100..0130). Every call runs under the staff member's OWN
 * session; the database authorizes and audits. Responses are zod-validated
 * (unknown keys stripped); anything unexpected throws FlightCommandError with
 * code null (fail closed). Database messages never reach the browser: errors
 * map by SQLSTATE + exact token; a hint is kept only when it is a plain list
 * of field keys or done issues.
 */

const SESSION_STATES = new Set(['PGRST301', 'PGRST302', 'PGRST303', '401']);
const INPUT_STATES = new Set(['22023', '22P02', '22001', '22003', '22007', '22008', '23514', '23502']);
const FUNCTION_MISSING_STATES = new Set(['PGRST202', '42883']);
const HINT_KEYS = /^[A-Za-z0-9_.[\]]{1,60}(,[A-Za-z0-9_.[\]]{1,60}){0,30}$/;

export class FlightCommandError extends Error {
  override name = 'FlightCommandError';
  constructor(
    readonly command: string,
    readonly code: FlightErrorCode | 'session' | null,
    readonly sqlState: string | null,
    /** Field keys (invalid_input) or done issue tokens (not_ready) from the database hint; never shown as text. */
    readonly hintKeys: string[] = [],
  ) {
    super(`${command} failed${sqlState ? ` (${sqlState})` : ''}${code ? `: ${code}` : ''}`);
  }
}

export function mapFlightError(error: RpcError): FlightErrorCode | 'session' | null {
  const state = error.code ?? '';
  const token = (error.message ?? '').trim();
  if (Object.hasOwn(FLIGHT_ERROR_STATES, token) && FLIGHT_ERROR_STATES[token as FlightErrorCode] === state) {
    return token as FlightErrorCode;
  }
  // finance_replay's request_conflict when it escapes a wrapper.
  if (token === 'request_conflict' && state === '40001') return 'duplicate_request';
  if (SESSION_STATES.has(state)) return 'session';
  if (state === '42501') return 'not_authorized';
  if (state === 'P0002') return 'not_found';
  if (INPUT_STATES.has(state)) return 'invalid_input';
  return null;
}

export function isFlightFunctionMissing(error: unknown): boolean {
  return error instanceof FlightCommandError && error.sqlState !== null && FUNCTION_MISSING_STATES.has(error.sqlState);
}

function hintKeys(hint: string | null | undefined): string[] {
  const value = (hint ?? '').trim();
  return HINT_KEYS.test(value) ? value.split(',') : [];
}

async function invoke(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  let result: { data: unknown; error: RpcError | null };
  try {
    result = await client.rpc(fn, args);
  } catch {
    throw new FlightCommandError(fn, null, null);
  }
  if (result.error) {
    const code = mapFlightError(result.error);
    throw new FlightCommandError(fn, code, result.error.code ?? null,
      code === 'invalid_input' || code === 'not_ready' ? hintKeys(result.error.hint) : []);
  }
  return result.data;
}

function parse<S extends z.ZodType>(fn: string, schema: S, data: unknown): z.output<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new FlightCommandError(fn, null, null);
  return parsed.data;
}

/** Reads answer null when the caller may not read (never a partial object). */
function parseNullable<S extends z.ZodType>(fn: string, schema: S, data: unknown): z.output<S> | null {
  return data === null ? null : parse(fn, schema, data);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function flightQueue(client: RpcClient) {
  const fn = 'flight_queue';
  return parse(fn, FlightQueueSchema, await invoke(client, fn, {}));
}

export async function flightWorkspace(client: RpcClient, dealId: string) {
  const fn = 'flight_workspace';
  return parseNullable(fn, FlightWorkspaceSchema, await invoke(client, fn, { p_deal_id: dealId }));
}

export async function dealFlightSummary(client: RpcClient, dealId: string) {
  const fn = 'deal_flight_summary';
  return parseNullable(fn, DealFlightSummarySchema, await invoke(client, fn, { p_deal_id: dealId }));
}

export async function dealFlightHistory(client: RpcClient, dealId: string) {
  const fn = 'deal_flight_history';
  return parseNullable(fn, DealFlightHistorySchema, await invoke(client, fn, { p_deal_id: dealId }));
}

export async function flightHomeCounts(client: RpcClient) {
  const fn = 'flight_home_counts';
  return parse(fn, FlightHomeCountsSchema, await invoke(client, fn, {}));
}

// ---------------------------------------------------------------------------
// Commands (section 6.1)
// ---------------------------------------------------------------------------

export async function groupClaim(client: RpcClient, input: { dealId: string; requestId: string }) {
  const fn = 'flight_group_claim';
  return parse(fn, GroupClaimResultSchema, await invoke(client, fn, { p_deal_id: input.dealId, p_request_id: input.requestId }));
}

export async function groupReassign(
  client: RpcClient,
  input: { dealId: string; expectedAssignee: string; toUserId: string; reason: string; requestId: string },
) {
  const fn = 'flight_group_reassign';
  return parse(fn, GroupReassignResultSchema, await invoke(client, fn, {
    p_deal_id: input.dealId, p_expected_assignee: input.expectedAssignee, p_to_user_id: input.toUserId,
    p_reason: input.reason, p_request_id: input.requestId,
  }));
}

export async function bookingChangeApply(
  client: RpcClient,
  input: { taskId: string; expectedBasisVersionId: string; targetVersionId: string; requestId: string },
) {
  const fn = 'flight_booking_change_apply';
  return parse(fn, BookingChangeApplyResultSchema, await invoke(client, fn, {
    p_task_id: input.taskId, p_expected_basis_version_id: input.expectedBasisVersionId,
    p_target_version_id: input.targetVersionId, p_request_id: input.requestId,
  }));
}

export async function screenshotSectorsSave(
  client: RpcClient,
  input: { taskId: string; expectedStateRowVersion: number; sectors: unknown[]; requestId: string },
) {
  const fn = 'flight_screenshot_sectors_save';
  return parse(fn, ScreenshotSaveResultSchema, await invoke(client, fn, {
    p_task_id: input.taskId, p_expected_state_row_version: input.expectedStateRowVersion,
    p_sectors: input.sectors, p_request_id: input.requestId,
  }));
}

export async function sectorFillBlanks(
  client: RpcClient,
  input: { sectorId: string; expectedRowVersion: number; fields: Record<string, unknown>; requestId: string },
) {
  const fn = 'flight_sector_fill_blanks';
  return parse(fn, FillBlanksResultSchema, await invoke(client, fn, {
    p_sector_id: input.sectorId, p_expected_row_version: input.expectedRowVersion, p_fields: input.fields, p_request_id: input.requestId,
  }));
}

export async function changeSubmit(client: RpcClient, input: { taskId: string; fields: Record<string, unknown>; requestId: string }) {
  const fn = 'flight_change_submit';
  return parse(fn, ChangeSubmitResultSchema, await invoke(client, fn, {
    p_task_id: input.taskId, p_fields: input.fields, p_request_id: input.requestId,
  }));
}

export async function changeDecide(
  client: RpcClient,
  input: { changeId: string; decision: 'approve' | 'reject'; reason: string | null; expectedRowVersion: number; requestId: string },
) {
  const fn = 'flight_change_decide';
  return parse(fn, ChangeDecisionResultSchema, await invoke(client, fn, {
    p_change_id: input.changeId, p_decision: input.decision, p_reason: input.reason,
    p_expected_row_version: input.expectedRowVersion, p_request_id: input.requestId,
  }));
}

export async function changeWithdraw(client: RpcClient, input: { changeId: string; expectedRowVersion: number; requestId: string }) {
  const fn = 'flight_change_withdraw';
  return parse(fn, ChangeDecisionResultSchema, await invoke(client, fn, {
    p_change_id: input.changeId, p_expected_row_version: input.expectedRowVersion, p_request_id: input.requestId,
  }));
}

export async function changeAcknowledge(client: RpcClient, changeId: string) {
  const fn = 'flight_change_acknowledge';
  return parse(fn, ChangeAckResultSchema, await invoke(client, fn, { p_change_id: changeId }));
}

export async function ticketCorrect(
  client: RpcClient,
  input: { sectorId: string; travellerSeq: number; expectedRevisionNo: number; fields: Record<string, unknown>; reason: string; requestId: string },
) {
  const fn = 'flight_ticket_correct';
  return parse(fn, TicketCorrectResultSchema, await invoke(client, fn, {
    p_sector_id: input.sectorId, p_traveller_seq: input.travellerSeq, p_expected_revision_no: input.expectedRevisionNo,
    p_fields: input.fields, p_reason: input.reason, p_request_id: input.requestId,
  }));
}

export async function groupComplete(client: RpcClient, input: { dealId: string; expectedTaskIds: string[]; requestId: string }) {
  const fn = 'flight_group_complete';
  return parse(fn, GroupCompleteResultSchema, await invoke(client, fn, {
    p_deal_id: input.dealId, p_expected_task_ids: input.expectedTaskIds, p_request_id: input.requestId,
  }));
}

/** R3 (Addendum 2): the Sales owner fills a blank traveller name on the accepted booking. */
export async function travellerNameFill(
  client: RpcClient,
  input: { dealId: string; versionId: string; seq: number; fullName: string; travellerType: 'adult' | 'child' | 'infant'; requestId: string },
) {
  const fn = 'deal_traveller_name_fill';
  return parse(fn, TravellerNameFillResultSchema, await invoke(client, fn, {
    p_deal_id: input.dealId, p_version_id: input.versionId, p_seq: input.seq, p_full_name: input.fullName,
    p_traveller_type: input.travellerType, p_request_id: input.requestId,
  }));
}

// ---------------------------------------------------------------------------
// E-tickets (department evidence, kind e_ticket)
// ---------------------------------------------------------------------------

export async function eTicketBegin(
  client: RpcClient,
  input: { taskId: string; fileName: string; mime: string; sizeBytes: number; sha256: string },
) {
  const fn = 'department_evidence_begin';
  return parse(fn, EvidenceBegunSchema, await invoke(client, fn, {
    p_task_id: input.taskId, p_application_id: null, p_kind: 'e_ticket', p_file_name: input.fileName, p_mime: input.mime,
    p_size_bytes: input.sizeBytes, p_sha256: input.sha256,
  }));
}

export async function eTicketFinish(client: RpcClient, evidenceId: string, ok: boolean) {
  const fn = 'department_evidence_finish';
  return parse(fn, EvidenceFinishedSchema, await invoke(client, fn, { p_evidence_id: evidenceId, p_ok: ok }));
}

export async function eTicketAuthorizeDownload(client: RpcClient, evidenceId: string) {
  const fn = 'department_evidence_authorize_download';
  return parse(fn, EvidenceDownloadSchema, await invoke(client, fn, { p_evidence_id: evidenceId }));
}
