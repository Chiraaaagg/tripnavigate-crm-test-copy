import 'server-only';
import type { z } from 'zod';
import type { StaffContext } from '@/modules/identity/server/session';
import {
  AckReplySchema,
  BoxReplySchema,
  errorCodeOf,
  FileMoveAlertsSchema,
  FileMoveSettingsSchema,
  HoldReplySchema,
  LostReplySchema,
  PilotReplySchema,
  RelocateReplySchema,
  RetryReplySchema,
  SwitchReplySchema,
  type FileMoveAlerts,
  type FileMoveErrorCode,
  type FileMoveLoad,
  type FileMoveSettings,
  type FileMoveSwitch,
} from '@/modules/settings/file-move-rows';
import { asRpcClient, type RpcClient } from '../commands';

/*
 * S11 "files to Bitrix": the staff database functions of Settings › Bitrix
 * connection › "Files kept in Bitrix" (freeze, "Staff DB API"), called under
 * the person's OWN session. The database decides who may read or change
 * anything (the Super Admin of the configuration's company, the same test
 * DEC-43 uses), checks every reason and writes every audit row. Nothing here
 * uses the privileged client, and nothing reads the actor, company or branch
 * from a form.
 *
 * Every reply is checked with zod (shapes in modules/settings/file-move-rows.ts).
 * A refusal becomes FileMoveAdminError with a fixed code and the database's
 * hint (a detail code such as `pilot_required`, or the refused argument); the
 * database's own message text is never passed on. A reply of an unexpected
 * shape is "could not confirm" (the change may have been saved).
 */

type Staff = Pick<StaffContext, 'supabase'>;

/** PostgREST errors carry the Postgres hint; the shared RpcError type names only code and message. */
interface RpcErrorWithHint {
  code?: string;
  message?: string;
  hint?: string | null;
}

export class FileMoveAdminError extends Error {
  readonly fn: string;
  readonly code: FileMoveErrorCode;
  readonly sqlState: string | null;
  /** The database hint: the detail code of a 55000 refusal, or the argument a 22023 refusal names. */
  readonly hint: string | null;
  constructor(fn: string, code: FileMoveErrorCode, sqlState: string | null, hint: string | null) {
    super(`${fn} failed: ${code}`);
    this.name = 'FileMoveAdminError';
    this.fn = fn;
    this.code = code;
    this.sqlState = sqlState;
    this.hint = hint;
  }
}

/** Short hint codes only (a detail code or an argument name); anything else is dropped. */
function safeHint(hint: unknown): string | null {
  return typeof hint === 'string' && /^[a-z_]{1,60}$/.test(hint.trim()) ? hint.trim() : null;
}

async function call(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  let result: { data: unknown; error: RpcErrorWithHint | null };
  try {
    result = (await client.rpc(fn, args)) as { data: unknown; error: RpcErrorWithHint | null };
  } catch {
    throw new FileMoveAdminError(fn, 'unexpected', null, null);
  }
  if (result.error) {
    const state = result.error.code ?? null;
    throw new FileMoveAdminError(fn, errorCodeOf(state), state, safeHint(result.error.hint));
  }
  return result.data;
}

function parse<T>(fn: string, schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new FileMoveAdminError(fn, 'unexpected', null, null);
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Reads (null = the database answered null: not the Super Admin)
// ---------------------------------------------------------------------------

export async function fileMoveSettingsGet(client: RpcClient): Promise<FileMoveSettings | null> {
  const fn = 'file_move_settings_get';
  const data = await call(client, fn, {});
  return data === null ? null : parse(fn, FileMoveSettingsSchema, data);
}

export async function fileMoveAlerts(client: RpcClient): Promise<FileMoveAlerts | null> {
  const fn = 'file_move_alerts';
  const data = await call(client, fn, {});
  return data === null ? null : parse(fn, FileMoveAlertsSchema, data);
}

// ---------------------------------------------------------------------------
// Changes (Super Admin; reason 10 to 500 characters; audited by the database)
// ---------------------------------------------------------------------------

export async function fileMoveSetSwitch(client: RpcClient, input: { switch: FileMoveSwitch; on: boolean; reason: string }) {
  const fn = 'file_move_set_switch';
  return parse(fn, SwitchReplySchema, await call(client, fn, { p_switch: input.switch, p_on: input.on, p_reason: input.reason }));
}

export async function fileMoveSetHold(client: RpcClient, input: { minutes: number; reason: string }) {
  const fn = 'file_move_set_hold';
  return parse(fn, HoldReplySchema, await call(client, fn, { p_minutes: input.minutes, p_reason: input.reason }));
}

export async function fileMoveSetAccountsBox(client: RpcClient, input: { itemKey: string; reason: string }) {
  const fn = 'file_move_set_accounts_box';
  return parse(fn, BoxReplySchema, await call(client, fn, { p_item_key: input.itemKey, p_reason: input.reason }));
}

/** dealId null clears the pilot (the company-wide start). The deal number is sent as text so no digit is lost. */
export async function fileMoveSetPilot(client: RpcClient, input: { dealId: string | null; reason: string }) {
  const fn = 'file_move_set_pilot';
  return parse(fn, PilotReplySchema, await call(client, fn, { p_source_deal_id: input.dealId, p_reason: input.reason }));
}

export async function fileMoveAcknowledgeStop(client: RpcClient, input: { stopId: string; reason: string }) {
  const fn = 'file_move_acknowledge_stop';
  return parse(fn, AckReplySchema, await call(client, fn, { p_stop_id: input.stopId, p_reason: input.reason }));
}

export async function fileMoveRetry(client: RpcClient, moveId: string) {
  const fn = 'file_move_retry';
  return parse(fn, RetryReplySchema, await call(client, fn, { p_id: moveId }));
}

export async function fileMoveRelocate(client: RpcClient, input: { moveId: string; dealId: string }) {
  const fn = 'file_move_relocate';
  return parse(fn, RelocateReplySchema, await call(client, fn, { p_id: input.moveId, p_new_source_deal_id: input.dealId }));
}

export async function fileMoveAcceptLost(client: RpcClient, input: { moveId: string; reason: string }) {
  const fn = 'file_move_accept_lost';
  return parse(fn, LostReplySchema, await call(client, fn, { p_id: input.moveId, p_reason: input.reason }));
}

// ---------------------------------------------------------------------------
// The page's one load
// ---------------------------------------------------------------------------

/**
 * Settings and alerts for the Bitrix connection page. Never throws:
 *  - 'hidden': the database answered null or refused (not the Super Admin): the page shows nothing;
 *  - 'not_installed': an older database without these functions: the section says so and offers no change;
 *  - 'error': the settings could not be read: shown as "could not be read", never as Off;
 *  - 'ready': the settings, with the alerts (or 'error' when only the alerts failed).
 * `superAdminSomewhere` (the person holds a Super Admin role in some company) decides
 * whether 'not_installed' and 'error' are shown at all, so other integration
 * managers never see a section they could not use.
 */
export async function loadFileMoveAdmin(staff: Staff, opts: { superAdminSomewhere: boolean }): Promise<FileMoveLoad> {
  const rpc = asRpcClient(staff.supabase);
  let settings: FileMoveSettings | null;
  try {
    settings = await fileMoveSettingsGet(rpc);
  } catch (error) {
    if (!opts.superAdminSomewhere) return { kind: 'hidden' };
    if (error instanceof FileMoveAdminError && error.code === 'not_installed') return { kind: 'not_installed' };
    if (error instanceof FileMoveAdminError && error.code === 'not_authorized') return { kind: 'hidden' };
    return { kind: 'error' };
  }
  if (settings === null) return { kind: 'hidden' };
  let alerts: FileMoveAlerts | 'error' | null;
  try {
    alerts = await fileMoveAlerts(rpc);
  } catch {
    alerts = 'error';
  }
  return { kind: 'ready', settings, alerts };
}
