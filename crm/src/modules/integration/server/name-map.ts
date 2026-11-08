import 'server-only';
import type { StaffContext } from '@/modules/identity/server/session';
import { asRpcClient, type RpcClient } from '../commands';
import {
  NameReadSwitchSchema,
  toBitrixNameMapView,
  toNameReadStateView,
  type BitrixNameMapView,
  type NameReadStateView,
  type NameReadSwitchResult,
} from '../name-map';

/**
 * Direction A Batch 1 B1-1: the staff read of Bitrix stage, status and source
 * names and the switch command, under the staff member's own session (the
 * database authorizes: active staff of the configuration's entity for the
 * read; Super Admin at aal2 with a reason for the switch).
 *
 * The read never throws: a failure is 'list_unreadable' (never "off", never an
 * empty list), a database without the function is 'not_installed', and a
 * database answer of enabled:false is 'switched_off' (screens show the code
 * fallback). One call per page render.
 */

type Staff = Pick<StaffContext, 'supabase'>;

/** PostgREST "function not found" (PGRST202) or Postgres undefined function (42883). */
const FUNCTION_MISSING = new Set(['PGRST202', '42883']);

export async function readBitrixNameMap(client: RpcClient): Promise<BitrixNameMapView> {
  try {
    const { data, error } = await client.rpc('bitrix_name_map', {});
    if (error) return FUNCTION_MISSING.has(error.code ?? '') ? { state: 'not_installed' } : { state: 'list_unreadable' };
    return toBitrixNameMapView(data);
  } catch {
    return { state: 'list_unreadable' };
  }
}

export function loadBitrixNameMap(staff: Staff): Promise<BitrixNameMapView> {
  return readBitrixNameMap(asRpcClient(staff.supabase));
}

export type NameReadSwitchOutcome =
  | { ok: true; result: NameReadSwitchResult }
  | { ok: false; code: 'not_authorized' | 'reason_required' | 'not_configured' | 'not_installed' | 'failed' };

/**
 * integration_set_bitrix_name_read(p_enabled, p_reason). Fixed codes only; the
 * database message is never shown. Live use needs the owner's APPROVE.
 */
export async function setBitrixNameRead(client: RpcClient, enabled: boolean, reason: string): Promise<NameReadSwitchOutcome> {
  try {
    const { data, error } = await client.rpc('integration_set_bitrix_name_read', { p_enabled: enabled, p_reason: reason });
    if (error) {
      const code = error.code ?? '';
      if (code === '42501') return { ok: false, code: 'not_authorized' };
      if (code === '22023') return { ok: false, code: 'reason_required' };
      if (code === '55000') return { ok: false, code: 'not_configured' };
      if (FUNCTION_MISSING.has(code)) return { ok: false, code: 'not_installed' };
      return { ok: false, code: 'failed' };
    }
    const parsed = NameReadSwitchSchema.safeParse(data);
    return parsed.success ? { ok: true, result: parsed.data } : { ok: false, code: 'failed' };
  } catch {
    return { ok: false, code: 'failed' };
  }
}

/**
 * DEC-55: the switch card on the Bitrix sync page. Current state, whether this
 * person may change it (Super Admin of the company, checked by the database),
 * and who changed it last and when. Never throws; anything but a clean answer
 * is 'unknown' (shown as Unknown, never Off).
 */
export async function readBitrixNameReadState(client: RpcClient): Promise<NameReadStateView> {
  try {
    const { data, error } = await client.rpc('bitrix_name_read_state', {});
    if (error) {
      const code = error.code ?? '';
      if (code === '42501') return { state: 'unknown', reason: 'not_authorized' };
      if (code === '55000') return { state: 'unknown', reason: 'not_configured' };
      if (FUNCTION_MISSING.has(code)) return { state: 'unknown', reason: 'not_installed' };
      return { state: 'unknown', reason: 'failed' };
    }
    return toNameReadStateView(data);
  } catch {
    return { state: 'unknown', reason: 'failed' };
  }
}

export function loadBitrixNameReadState(staff: Staff): Promise<NameReadStateView> {
  return readBitrixNameReadState(asRpcClient(staff.supabase));
}
