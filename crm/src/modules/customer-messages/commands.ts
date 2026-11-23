import type { z } from 'zod';
import type { RpcClient, RpcError } from '@/modules/fulfilment/commands';
import { MESSAGE_ERROR_STATES, type Channel, type MessageErrorCode, type MessageType, type TemplateStatus } from './contracts';
import {
  AdminCustomerMessagesDbSchema,
  DealCustomerMessagesSchema,
  DealMessagePrefsSchema,
  EvidenceBegunSchema,
  EvidenceFinishedSchema,
  PilotDealLookupSchema,
  TaskCustomerFilesSchema,
  OutcomeResultSchema,
  PrefsSetResultSchema,
  ResendResultSchema,
  SettingResultSchema,
  TaskCustomerMessageStatusSchema,
  type AdminCustomerMessagesDb,
  type DealCustomerMessages,
  type DealMessagePrefs,
  type PilotDealLookup,
  type TaskCustomerFiles,
  type TaskCustomerMessageStatus,
} from './dto';
import { isConflictSqlState, stateMatches } from '@/lib/sqlstate';

/**
 * Typed wrappers of the customer message commands and reads (contract 5.3,
 * 5.6, 5.9, 5.10). Staff calls run under the caller's own client; replies are
 * validated with zod and anything unexpected throws MessageCommandError with
 * code null (fail closed). Database messages never reach the browser.
 */

const SESSION_STATES = new Set(['PGRST301', 'PGRST302', 'PGRST303', '401']);
const INPUT_STATES = new Set(['22023', '22P02', '22001', '22003', '22007', '22008', '23514', '23502']);

export class MessageCommandError extends Error {
  override name = 'MessageCommandError';
  constructor(
    readonly command: string,
    readonly code: MessageErrorCode | 'session' | null,
    readonly sqlState: string | null,
    readonly hint: string | null = null,
  ) {
    super(`${command} failed${sqlState ? ` (${sqlState})` : ''}${code ? `: ${code}` : ''}`);
  }
}

export function mapMessageError(error: RpcError): MessageErrorCode | 'session' | null {
  const state = error.code ?? '';
  const token = (error.message ?? '').trim();
  if (Object.hasOwn(MESSAGE_ERROR_STATES, token) && stateMatches(MESSAGE_ERROR_STATES[token as MessageErrorCode], state)) {
    return token as MessageErrorCode;
  }
  if (SESSION_STATES.has(state)) return 'session';
  if (state === '42501') return 'not_authorized';
  if (state === 'P0002') return 'not_found';
  if (isConflictSqlState(state)) return 'version_changed';
  if (INPUT_STATES.has(state)) return 'invalid_input';
  return null;
}

async function invoke(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  let result: { data: unknown; error: RpcError | null };
  try {
    result = await client.rpc(fn, args);
  } catch {
    throw new MessageCommandError(fn, null, null);
  }
  if (result.error) throw new MessageCommandError(fn, mapMessageError(result.error), result.error.code ?? null, result.error.hint ?? null);
  return result.data;
}

function parse<T>(fn: string, schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new MessageCommandError(fn, null, null);
  return parsed.data;
}

async function read<T>(client: RpcClient, fn: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T | null> {
  const data = await invoke(client, fn, args);
  return data === null ? null : parse(fn, schema, data);
}

// --------------------------------------------------------------------- reads
export const dealCustomerMessages = (client: RpcClient, dealId: string): Promise<DealCustomerMessages | null> =>
  read(client, 'deal_customer_messages', { p_deal_id: dealId }, DealCustomerMessagesSchema);

export const taskCustomerMessageStatus = (client: RpcClient, taskId: string): Promise<TaskCustomerMessageStatus | null> =>
  read(client, 'task_customer_message_status', { p_task_id: taskId }, TaskCustomerMessageStatusSchema);

export const adminCustomerMessages = (client: RpcClient, entityId: string): Promise<AdminCustomerMessagesDb | null> =>
  read(client, 'admin_customer_messages', { p_entity: entityId }, AdminCustomerMessagesDbSchema);

export const dealMessagePrefs = (client: RpcClient, dealId: string): Promise<DealMessagePrefs | null> =>
  read(client, 'deal_message_prefs_get', { p_deal_id: dealId }, DealMessagePrefsSchema);

export const taskCustomerFiles = (client: RpcClient, taskId: string): Promise<TaskCustomerFiles | null> =>
  read(client, 'task_customer_files', { p_task_id: taskId }, TaskCustomerFilesSchema);

export const pilotDealLookup = (client: RpcClient, entityId: string, reference: string): Promise<PilotDealLookup | null> =>
  read(client, 'customer_message_deal_lookup', { p_entity: entityId, p_reference: reference }, PilotDealLookupSchema);

// ------------------------------------------------------------------ commands
export interface PrefsFields {
  language?: 'en' | 'hi';
  whatsappMobile?: string | null;
  whatsappSameAsMobile?: boolean;
  emailOverride?: string | null;
  whatsappOff?: boolean;
  emailOff?: boolean;
  offReason?: string | null;
}

export async function setDealMessagePrefs(client: RpcClient, dealId: string, expectedRowVersion: number, fields: PrefsFields, requestId: string) {
  const fn = 'deal_message_prefs_set';
  return parse(fn, PrefsSetResultSchema, await invoke(client, fn, {
    p_deal_id: dealId, p_expected_row_version: expectedRowVersion, p_fields: fields, p_request_id: requestId,
  }));
}

export async function restartWhatsapp(client: RpcClient, dealId: string, reason: string, requestId: string) {
  const fn = 'customer_whatsapp_restart';
  return parse(fn, OutcomeResultSchema, await invoke(client, fn, { p_deal_id: dealId, p_reason: reason, p_request_id: requestId }));
}

export async function resendMessage(client: RpcClient, messageId: string, requestId: string) {
  const fn = 'customer_message_resend';
  return parse(fn, ResendResultSchema, await invoke(client, fn, { p_message_id: messageId, p_request_id: requestId }));
}

export async function markVoucherReady(client: RpcClient, evidenceId: string, requestId: string) {
  const fn = 'purchase_voucher_mark_ready';
  return parse(fn, OutcomeResultSchema, await invoke(client, fn, { p_evidence_id: evidenceId, p_request_id: requestId }));
}

export async function setMessageSwitch(client: RpcClient, entityId: string, type: MessageType, channel: Channel, enabled: boolean,
  reason: string, expectedRowVersion: number) {
  const fn = 'admin_set_customer_message_switch';
  return parse(fn, SettingResultSchema, await invoke(client, fn, {
    p_entity: entityId, p_type: type, p_channel: channel, p_enabled: enabled, p_reason: reason, p_expected_row_version: expectedRowVersion,
  }));
}

export async function setPilotOnly(client: RpcClient, entityId: string, pilotOnly: boolean, reason: string) {
  const fn = 'admin_set_customer_message_pilot';
  return parse(fn, SettingResultSchema, await invoke(client, fn, { p_entity: entityId, p_pilot_only: pilotOnly, p_reason: reason }));
}

export async function setPilotDeal(client: RpcClient, entityId: string, dealId: string, inPilot: boolean, reason: string) {
  const fn = 'customer_message_pilot_set';
  return parse(fn, SettingResultSchema, await invoke(client, fn, { p_entity: entityId, p_deal_id: dealId, p_in: inPilot, p_reason: reason }));
}

export async function setTemplateStatus(client: RpcClient, entityId: string, templateCode: string, status: TemplateStatus, reason: string) {
  const fn = 'admin_set_whatsapp_template_status';
  return parse(fn, SettingResultSchema, await invoke(client, fn, {
    p_entity: entityId, p_template_code: templateCode, p_status: status, p_reason: reason,
  }));
}

export async function setTimerEnabled(client: RpcClient, enabled: boolean, reason: string) {
  const fn = 'admin_set_timer_enabled';
  return parse(fn, SettingResultSchema, await invoke(client, fn, { p_enabled: enabled, p_reason: reason }));
}

export interface FileInput { taskId: string; fileName: string; mime: string; sizeBytes: number; sha256: string }

/** Customer voucher on a supplier-confirmed Purchase task (purchase_evidence kind customer_voucher). */
export async function voucherBegin(client: RpcClient, input: FileInput) {
  const fn = 'purchase_evidence_begin';
  return parse(fn, EvidenceBegunSchema, await invoke(client, fn, {
    p_task_id: input.taskId, p_kind: 'customer_voucher', p_file_name: input.fileName, p_mime: input.mime,
    p_size_bytes: input.sizeBytes, p_sha256: input.sha256,
  }));
}

export async function voucherFinish(client: RpcClient, evidenceId: string, ok: boolean) {
  const fn = 'purchase_evidence_finish';
  return parse(fn, EvidenceFinishedSchema, await invoke(client, fn, { p_evidence_id: evidenceId, p_ok: ok }));
}

/** Boarding pass on a Flight task with a ticket batch (department_evidence kind boarding_pass). */
export async function boardingPassBegin(client: RpcClient, input: FileInput) {
  const fn = 'department_evidence_begin';
  return parse(fn, EvidenceBegunSchema, await invoke(client, fn, {
    p_task_id: input.taskId, p_application_id: null, p_kind: 'boarding_pass', p_file_name: input.fileName, p_mime: input.mime,
    p_size_bytes: input.sizeBytes, p_sha256: input.sha256,
  }));
}

export async function boardingPassFinish(client: RpcClient, evidenceId: string, ok: boolean) {
  const fn = 'department_evidence_finish';
  return parse(fn, EvidenceFinishedSchema, await invoke(client, fn, { p_evidence_id: evidenceId, p_ok: ok }));
}

/** Links a stored boarding pass to one flight and one traveller of its task (once). */
export async function boardingPassSlotLink(client: RpcClient, evidenceId: string, sectorId: string, passengerSeq: number) {
  const fn = 'boarding_pass_slot_link';
  return parse(fn, OutcomeResultSchema, await invoke(client, fn, { p_evidence_id: evidenceId, p_sector_id: sectorId, p_traveller_seq: passengerSeq }));
}
