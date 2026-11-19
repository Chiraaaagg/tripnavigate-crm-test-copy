import { z } from 'zod';
import type { RpcClient, RpcError } from '@/modules/fulfilment/commands';
import {
  CHANGE_ERROR_STATES,
  type ChangeDecision,
  type ChangeErrorCode,
  type ChangeKind,
  type ChangeRequestResult,
  type ChangeSwitchResult,
  type ChangeVersionResult,
  type ReconfirmationResult,
} from './contracts';
import {
  ChangeHistorySchema,
  ChangePreviewSchema,
  ChangeRequestResultSchema,
  ChangeRequestsPageSchema,
  ChangeSwitchResultSchema,
  ChangeVersionResultSchema,
  DealChangeRequestsSchema,
  ReconfirmationResultSchema,
  ServiceRemovalChargesSchema,
  ChangeReviewSchema,
  type ChangeReview,
  TaskReconfirmationSchema,
  type ChangeHistory,
  type ChangePreview,
  type ChangeRequestsFilter,
  type ChangeRequestsPage,
  type DealChangeRequests,
  type ServiceRemovalCharges,
  type TaskReconfirmation,
} from './dto';

/**
 * Typed wrappers of the change commands and reads (contract 10.2 G1, 10.3
 * G2-G9, 10.5 R-G1-R-G4). Every call runs under the CALLER's client (the
 * staff member's own session); replies are validated with zod and anything
 * unexpected throws ChangeCommandError with code null (fail closed). Database
 * messages never reach the browser: errors map by SQLSTATE + token.
 *
 * Database signatures (track H replaced the ones marked *, same signatures):
 *   admin_set_booking_changes_enabled(p_enabled boolean, p_reason text)
 *   admin_set_service_changes_enabled(p_enabled boolean, p_reason text)          (track H, H1)
 * * booking_change_request_create(p_deal_id uuid, p_fields jsonb {kind, itemIds, changeSummary, reason, customerChargePaise?}, p_request_id uuid)
 *   booking_change_request_resubmit(p_id uuid, p_expected_row_version integer, p_fields jsonb, p_request_id uuid)
 *   booking_change_request_withdraw(p_id uuid, p_expected_row_version integer, p_reason text, p_request_id uuid)
 *   booking_change_request_decide(p_id uuid, p_decision text, p_reason text, p_expected_row_version integer, p_request_id uuid)
 * * booking_change_open_version(p_change_request_id uuid, p_request_id uuid)
 * * booking_change_submit(p_change_request_id uuid, p_expected_content_hash text, p_expected_changed_item_ids uuid[], p_request_id uuid)
 *   task_reconfirm_record(p_reconfirmation_id uuid, p_expected_row_version integer, p_fields jsonb, p_request_id uuid)
 *   task_reconfirm_approve_over_budget(p_reconfirmation_id uuid, p_expected_row_version integer, p_request_id uuid)
 *   task_reconfirm_refuse(p_reconfirmation_id uuid, p_expected_row_version integer, p_reason text, p_request_id uuid)
 * * authz.booking_change_apply(p_change_request uuid) returns jsonb (internal)
 *   service_removal_charges(p_change_request_id uuid)                            (track H, R-H1)
 * Track H also replaced booking_change_request_resubmit (same signature): kinds
 * add_service / remove_service follow the same rules as at create.
 *
 * Order (Addendum O2): create (draft) -> open the change version -> fill it (incl.
 * selling total and payment plan) -> submit (requested; the version's hash is
 * stored) -> decide approve (exactly that version; reconfirmations start; applies
 * at once when nothing waits) | return (edit the same version, resubmit to change
 * the request's details, submit again) -> reconfirm -> applied.
 *   change_request_review(p_change_request_id uuid)                              (R-H2)
 */

const SESSION_STATES = new Set(['PGRST301', 'PGRST302', 'PGRST303', '401']);
const INPUT_STATES = new Set(['22023', '22P02', '22001', '22003', '22007', '22008', '23514', '23502']);

export class ChangeCommandError extends Error {
  override name = 'ChangeCommandError';
  constructor(
    readonly command: string,
    readonly code: ChangeErrorCode | 'session' | null,
    readonly sqlState: string | null,
    /** invalid_input: the refused field; not_ready: the blocker; change_outside_request: item numbers "2,3". */
    readonly hint: string | null = null,
  ) {
    super(`${command} failed${sqlState ? ` (${sqlState})` : ''}${code ? `: ${code}` : ''}`);
  }
}

export function mapChangeError(error: RpcError): ChangeErrorCode | 'session' | null {
  const state = error.code ?? '';
  const token = (error.message ?? '').trim();
  if (Object.hasOwn(CHANGE_ERROR_STATES, token) && CHANGE_ERROR_STATES[token as ChangeErrorCode] === state) {
    return token as ChangeErrorCode;
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
    throw new ChangeCommandError(fn, null, null);
  }
  if (result.error) throw new ChangeCommandError(fn, mapChangeError(result.error), result.error.code ?? null, result.error.hint ?? null);
  return result.data;
}

function parse<T>(fn: string, schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ChangeCommandError(fn, null, null);
  return parsed.data;
}

async function read<T>(client: RpcClient, fn: string, schema: z.ZodType<T>, args: Record<string, unknown>): Promise<T | null> {
  const data = await invoke(client, fn, args);
  return data === null ? null : parse(fn, schema, data);
}

const request = async (client: RpcClient, fn: string, args: Record<string, unknown>): Promise<ChangeRequestResult> =>
  parse(fn, ChangeRequestResultSchema, await invoke(client, fn, args));
const reconf = async (client: RpcClient, fn: string, args: Record<string, unknown>): Promise<ReconfirmationResult> =>
  parse(fn, ReconfirmationResultSchema, await invoke(client, fn, args));

export interface ChangeRequestFields {
  kind: ChangeKind;
  /** change: 1..20; add_service: none (services are recorded as they are added); remove_service: exactly one. */
  itemIds: string[];
  changeSummary: string;
  reason: string;
  /**
   * Track H, remove_service only: what the customer is charged for dropping a
   * booked service (route cancellation: required, "0" allowed; simple route:
   * absent). Whole paise as a decimal string.
   */
  customerChargePaise?: string;
}

/** G7 fields: paise as decimal strings (never floats). */
export interface ReconfirmRecordFields {
  newRatePaise: string;
  supplierFeePaise: string;
  newReference: string;
  evidenceId: string;
  note: string | null;
}

// G1 (Super Admin)
export async function setBookingChanges(client: RpcClient, enabled: boolean, reason: string): Promise<ChangeSwitchResult> {
  const fn = 'admin_set_booking_changes_enabled';
  return parse(fn, ChangeSwitchResultSchema, await invoke(client, fn, { p_enabled: enabled, p_reason: reason }));
}
// H1 (Super Admin)
export async function setServiceChanges(client: RpcClient, enabled: boolean, reason: string): Promise<ChangeSwitchResult> {
  const fn = 'admin_set_service_changes_enabled';
  return parse(fn, ChangeSwitchResultSchema, await invoke(client, fn, { p_enabled: enabled, p_reason: reason }));
}
// G2
export function changeRequestCreate(client: RpcClient, dealId: string, fields: ChangeRequestFields, requestId: string) {
  return request(client, 'booking_change_request_create', { p_deal_id: dealId, p_fields: fields, p_request_id: requestId });
}
// G3
export function changeRequestResubmit(client: RpcClient, id: string, expectedRowVersion: number, fields: ChangeRequestFields, requestId: string) {
  return request(client, 'booking_change_request_resubmit', {
    p_id: id, p_expected_row_version: expectedRowVersion, p_fields: fields, p_request_id: requestId,
  });
}
export function changeRequestWithdraw(client: RpcClient, id: string, expectedRowVersion: number, reason: string, requestId: string) {
  return request(client, 'booking_change_request_withdraw', {
    p_id: id, p_expected_row_version: expectedRowVersion, p_reason: reason, p_request_id: requestId,
  });
}
// G4
export function changeRequestDecide(client: RpcClient, id: string, decision: ChangeDecision, reason: string | null,
  expectedRowVersion: number, requestId: string) {
  return request(client, 'booking_change_request_decide', {
    p_id: id, p_decision: decision, p_reason: reason, p_expected_row_version: expectedRowVersion, p_request_id: requestId,
  });
}
// G5
export async function changeOpenVersion(client: RpcClient, changeRequestId: string, requestId: string): Promise<ChangeVersionResult> {
  const fn = 'booking_change_open_version';
  return parse(fn, ChangeVersionResultSchema, await invoke(client, fn, { p_change_request_id: changeRequestId, p_request_id: requestId }));
}
// G6
export function changeSubmit(client: RpcClient, changeRequestId: string, expectedContentHash: string, changedItemIds: string[], requestId: string) {
  return request(client, 'booking_change_submit', {
    p_change_request_id: changeRequestId, p_expected_content_hash: expectedContentHash,
    p_expected_changed_item_ids: changedItemIds, p_request_id: requestId,
  });
}
// G7
export function reconfirmRecord(client: RpcClient, reconfirmationId: string, expectedRowVersion: number, fields: ReconfirmRecordFields,
  requestId: string) {
  return reconf(client, 'task_reconfirm_record', {
    p_reconfirmation_id: reconfirmationId, p_expected_row_version: expectedRowVersion, p_fields: fields, p_request_id: requestId,
  });
}
// G8
export function reconfirmApproveOverBudget(client: RpcClient, reconfirmationId: string, expectedRowVersion: number, requestId: string) {
  return reconf(client, 'task_reconfirm_approve_over_budget', {
    p_reconfirmation_id: reconfirmationId, p_expected_row_version: expectedRowVersion, p_request_id: requestId,
  });
}
// G9
export function reconfirmRefuse(client: RpcClient, reconfirmationId: string, expectedRowVersion: number, reason: string, requestId: string) {
  return reconf(client, 'task_reconfirm_refuse', {
    p_reconfirmation_id: reconfirmationId, p_expected_row_version: expectedRowVersion, p_reason: reason, p_request_id: requestId,
  });
}

// Reads (null = not allowed)
export function readDealChangeRequests(client: RpcClient, dealId: string): Promise<DealChangeRequests | null> {
  return read(client, 'deal_change_requests', DealChangeRequestsSchema, { p_deal_id: dealId });
}
export function readChangeRequests(client: RpcClient, filter: ChangeRequestsFilter, after: string | null, limit = 50): Promise<ChangeRequestsPage | null> {
  return read(client, 'change_requests_list', ChangeRequestsPageSchema, { p_filter: filter, p_after: after, p_limit: limit });
}
export function readTaskReconfirmation(client: RpcClient, taskId: string): Promise<TaskReconfirmation | null> {
  return read(client, 'task_reconfirmation_get', TaskReconfirmationSchema, { p_task_id: taskId });
}
export function readChangeHistory(client: RpcClient, dealId: string): Promise<ChangeHistory | null> {
  return read(client, 'deal_change_history', ChangeHistorySchema, { p_deal_id: dealId });
}
/** R-H1 (track H): the supplier charges of a booked removal - branch Manager (and the LD37 Approver) and Accounts. */
export function readServiceRemovalCharges(client: RpcClient, changeRequestId: string): Promise<ServiceRemovalCharges | null> {
  return read(client, 'service_removal_charges', ServiceRemovalChargesSchema, { p_change_request_id: changeRequestId });
}
/** R-H2 (Addendum O2): what the Manager approves - old and new booking side by side. */
export function readChangeReview(client: RpcClient, changeRequestId: string): Promise<ChangeReview | null> {
  return read(client, 'change_request_review', ChangeReviewSchema, { p_change_request_id: changeRequestId });
}
export function readChangePreview(client: RpcClient, changeRequestId: string): Promise<ChangePreview | null> {
  return read(client, 'booking_change_preview', ChangePreviewSchema, { p_change_request_id: changeRequestId });
}
