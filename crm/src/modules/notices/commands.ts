import type { z } from 'zod';
import type { RpcClient, RpcError } from '@/modules/fulfilment/commands';
import {
  NOTICE_ACTIONS,
  NOTICE_ERROR_STATES,
  type NoticeCountsDTO,
  type NoticeErrorCode,
  type NoticeHistoryDTO,
  type NoticeInboxDTO,
  type NoticeMarkAction,
  type NoticeMarkAllResult,
  type NoticeMarkResult,
  type NoticePreferencesDTO,
  type NoticePreferencesFields,
  PUSH_ERROR_STATES,
  type PushDevicesListDTO,
  type PushErrorCode,
} from './contracts';
import {
  NoticeCountsSchema,
  NoticeHistorySchema,
  NoticeInboxSchema,
  NoticeMarkAllResultSchema,
  NoticeMarkResultSchema,
  NoticePreferencesSchema,
  NoticeSwitchResultSchema,
  type NoticeSwitchResult,
  PushDevicesListSchema,
  PushRegisterResultSchema,
  type PushRegisterResult,
  PushRemoveCurrentResultSchema,
  type PushRemoveCurrentResult,
  PushRemoveResultSchema,
  type PushRemoveResult,
  PushTestResultSchema,
  type PushTestResult,
} from './dto';

/**
 * Typed wrappers for the bell reads and commands (contract 7.5 N1-N3, 8.4;
 * migration 20261203000420). Every call runs under the staff member's OWN
 * session: the database returns only the caller's rows that still pass the
 * access re-check. Responses are zod-validated (unknown keys stripped);
 * anything unexpected throws NoticeCommandError with code null (fail closed).
 * Database messages never reach the browser: errors map by SQLSTATE plus the
 * exact token.
 */

const SESSION_STATES = new Set(['PGRST301', 'PGRST302', 'PGRST303', '401']);
const FUNCTION_MISSING_STATES = new Set(['PGRST202', '42883']);

export class NoticeCommandError extends Error {
  override name = 'NoticeCommandError';
  constructor(
    readonly command: string,
    readonly code: NoticeErrorCode | 'session' | null,
    readonly sqlState: string | null,
  ) {
    super(`${command} failed${sqlState ? ` (${sqlState})` : ''}${code ? `: ${code}` : ''}`);
  }
}

export function mapNoticeError(error: RpcError): NoticeErrorCode | 'session' | null {
  const state = error.code ?? '';
  const token = (error.message ?? '').trim();
  if (Object.hasOwn(NOTICE_ERROR_STATES, token) && NOTICE_ERROR_STATES[token as NoticeErrorCode] === state) {
    return token as NoticeErrorCode;
  }
  if (SESSION_STATES.has(state)) return 'session';
  if (state === '42501') return 'not_authorized';
  if (state === 'P0002') return 'not_found';
  if (state === '22023' || state === '22P02') return 'invalid_input';
  return null;
}

export function isNoticeFunctionMissing(error: unknown): boolean {
  return error instanceof NoticeCommandError && error.sqlState !== null && FUNCTION_MISSING_STATES.has(error.sqlState);
}

async function invoke(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  let result: { data: unknown; error: RpcError | null };
  try {
    result = await client.rpc(fn, args);
  } catch {
    throw new NoticeCommandError(fn, null, null);
  }
  if (result.error) throw new NoticeCommandError(fn, mapNoticeError(result.error), result.error.code ?? null);
  return result.data;
}

function parse<S extends z.ZodType>(fn: string, schema: S, data: unknown): z.output<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new NoticeCommandError(fn, null, null);
  return parsed.data;
}

/** Reads answer null without a valid staff session (never a partial object). */
function parseNullable<S extends z.ZodType>(fn: string, schema: S, data: unknown): z.output<S> | null {
  return data === null ? null : parse(fn, schema, data);
}

export const NOTICE_PAGE_LIMIT = 50;

function limitOf(limit: number | undefined): number {
  const n = limit ?? NOTICE_PAGE_LIMIT;
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new NoticeCommandError('notice_limit', 'invalid_input', null);
  return n;
}

function seqOf(seq: number | null | undefined): number | null {
  if (seq === null || seq === undefined) return null;
  if (!Number.isSafeInteger(seq) || seq < 0) throw new NoticeCommandError('notice_seq', 'invalid_input', null);
  return seq;
}

/** First page (afterSeq null: on load, reconnect and focus) or the rows after a seq (30 s poll). */
export async function noticeInbox(client: RpcClient, afterSeq: number | null = null, limit?: number): Promise<NoticeInboxDTO | null> {
  const fn = 'notice_inbox';
  return parseNullable(fn, NoticeInboxSchema, await invoke(client, fn, { p_after_seq: seqOf(afterSeq), p_limit: limitOf(limit) }));
}

/** Read, done and resolved notices of the last 30 days, newest first. */
export async function noticeHistory(client: RpcClient, beforeSeq: number | null = null, limit?: number): Promise<NoticeHistoryDTO | null> {
  const fn = 'notice_history';
  return parseNullable(fn, NoticeHistorySchema, await invoke(client, fn, { p_before_seq: seqOf(beforeSeq), p_limit: limitOf(limit) }));
}

export async function noticeUnreadCount(client: RpcClient): Promise<NoticeCountsDTO | null> {
  const fn = 'notice_unread_count';
  return parseNullable(fn, NoticeCountsSchema, await invoke(client, fn, {}));
}

export async function noticePreferencesGet(client: RpcClient): Promise<NoticePreferencesDTO | null> {
  const fn = 'notice_preferences_get';
  return parseNullable(fn, NoticePreferencesSchema, await invoke(client, fn, {}));
}

/** N1: read (normal rows close; urgent rows stay open), done or open (both close). Idempotent. */
export async function noticeMark(client: RpcClient, noticeId: string, action: NoticeMarkAction): Promise<NoticeMarkResult> {
  const fn = 'notice_mark';
  if (!(NOTICE_ACTIONS as readonly string[]).includes(action)) throw new NoticeCommandError(fn, 'invalid_input', null);
  return parse(fn, NoticeMarkResultSchema, await invoke(client, fn, { p_notice_id: noticeId, p_action: action }));
}

/** N2: every unread normal notice of the caller (urgent and escalated stay). */
export async function noticeMarkAllRead(client: RpcClient): Promise<NoticeMarkAllResult> {
  const fn = 'notice_mark_all_read';
  return parse(fn, NoticeMarkAllResultSchema, await invoke(client, fn, {}));
}

/** N3: the caller's own sound and / or pop-up preference (at least one key; the other is kept). */
export async function noticePreferencesSet(client: RpcClient, fields: NoticePreferencesFields): Promise<NoticePreferencesDTO> {
  const fn = 'notice_preferences_set';
  const out: NoticePreferencesFields = {};
  if (fields.soundOn !== undefined) {
    if (typeof fields.soundOn !== 'boolean') throw new NoticeCommandError(fn, 'invalid_input', null);
    out.soundOn = fields.soundOn;
  }
  if (fields.popupsOn !== undefined) {
    if (typeof fields.popupsOn !== 'boolean') throw new NoticeCommandError(fn, 'invalid_input', null);
    out.popupsOn = fields.popupsOn;
  }
  if (out.soundOn === undefined && out.popupsOn === undefined) throw new NoticeCommandError(fn, 'invalid_input', null);
  return parse(fn, NoticePreferencesSchema, await invoke(client, fn, { p_fields: out }));
}

/** Super Admin: switch notices on or off (reason 10..500; audited settings.notices_changed). */
export async function adminSetNoticesEnabled(client: RpcClient, enabled: boolean, reason: string): Promise<NoticeSwitchResult> {
  const fn = 'admin_set_notices_enabled';
  return parse(fn, NoticeSwitchResultSchema, await invoke(client, fn, { p_enabled: enabled, p_reason: reason }));
}

// ---------------------------------------------------------------------------
// Closed-browser alerts (Accounts phase 3, contract 8.3 D1-D5; migration 20261205000400).
// Under the staff member's OWN session; the database answers only for the caller's own devices.
// ---------------------------------------------------------------------------

export class PushCommandError extends Error {
  override name = 'PushCommandError';
  constructor(
    readonly command: string,
    readonly code: PushErrorCode | 'session' | null,
    readonly sqlState: string | null,
    /** invalid_input: the field the database named. */
    readonly hint: string | null = null,
  ) {
    super(`${command} failed${sqlState ? ` (${sqlState})` : ''}${code ? `: ${code}` : ''}`);
  }
}

export function mapPushError(error: RpcError): PushErrorCode | 'session' | null {
  const state = error.code ?? '';
  const token = (error.message ?? '').trim();
  if (Object.hasOwn(PUSH_ERROR_STATES, token) && PUSH_ERROR_STATES[token as PushErrorCode] === state) return token as PushErrorCode;
  return mapNoticeError(error);
}

async function invokePush(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  let result: { data: unknown; error: RpcError | null };
  try {
    result = await client.rpc(fn, args);
  } catch {
    throw new PushCommandError(fn, null, null);
  }
  if (result.error) {
    throw new PushCommandError(fn, mapPushError(result.error), result.error.code ?? null, result.error.hint ?? null);
  }
  return result.data;
}

function parsePush<S extends z.ZodType>(fn: string, schema: S, data: unknown): z.output<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new PushCommandError(fn, null, null);
  return parsed.data;
}

/** D1: register this browser for the caller (keys and endpoint go to the database only). */
export async function pushDeviceRegister(
  client: RpcClient,
  input: { endpoint: string; p256dh: string; authKey: string; label: string; requestId: string },
): Promise<PushRegisterResult> {
  const fn = 'push_device_register';
  return parsePush(fn, PushRegisterResultSchema, await invokePush(client, fn, {
    p_endpoint: input.endpoint, p_p256dh: input.p256dh, p_auth_key: input.authKey, p_label: input.label, p_request_id: input.requestId,
  }));
}

/** D2: remove one of the caller's own devices. */
export async function pushDeviceRemove(client: RpcClient, deviceId: string, requestId: string): Promise<PushRemoveResult> {
  const fn = 'push_device_remove';
  return parsePush(fn, PushRemoveResultSchema, await invokePush(client, fn, { p_device_id: deviceId, p_request_id: requestId }));
}

/** D2 (sign-out, "Turn off on this device"): the caller's device for this browser's endpoint. */
export async function pushDeviceRemoveCurrent(client: RpcClient, endpoint: string): Promise<PushRemoveCurrentResult> {
  const fn = 'push_device_remove_current';
  return parsePush(fn, PushRemoveCurrentResultSchema, await invokePush(client, fn, { p_endpoint: endpoint }));
}

/** D3: the caller's devices; `endpointHash` (sha256 hex of this browser's endpoint) marks "this device". */
export async function pushDevicesList(client: RpcClient, endpointHash: string | null): Promise<PushDevicesListDTO | null> {
  const fn = 'push_devices_list';
  const data = await invokePush(client, fn, { p_endpoint_hash: endpointHash });
  return data === null ? null : parsePush(fn, PushDevicesListSchema, data);
}

/** D4: one test alert to one of the caller's devices (at most 3 per 10 minutes: not_ready). */
export async function pushTestSend(client: RpcClient, deviceId: string, requestId: string): Promise<PushTestResult> {
  const fn = 'push_test_send';
  return parsePush(fn, PushTestResultSchema, await invokePush(client, fn, { p_device_id: deviceId, p_request_id: requestId }));
}

/** D5: Super Admin switch (reason 10..500; audited settings.notices_changed). */
export async function adminSetPushEnabled(client: RpcClient, enabled: boolean, reason: string): Promise<NoticeSwitchResult> {
  const fn = 'admin_set_push_enabled';
  return parsePush(fn, NoticeSwitchResultSchema, await invokePush(client, fn, { p_enabled: enabled, p_reason: reason }));
}
