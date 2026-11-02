import 'server-only';
import type { StaffContext } from '@/modules/identity/server/session';
import { asRpcClient, callRpc, parseReply } from '../commands';
import { PrefillAutoFillSettingSchema } from '../prefill-auto';

/**
 * Batch 2 automatic fill: server reads (no privileged client; the caller's
 * own session, the database authorizes). Server actions live with the
 * screens (Terra); RPC wrappers in ../prefill-auto.ts.
 */

/**
 * The prefill_auto_fill switch as the database reports it: true/false, or
 * null when it cannot be read (database without migration A, refusal or
 * failure). Screens show null as Unknown, never as Off.
 */
export async function loadPrefillAutoFillSetting(staff: Pick<StaffContext, 'supabase'>): Promise<boolean | null> {
  try {
    const fn = 'workflow_settings_get';
    const parsed = parseReply(fn, PrefillAutoFillSettingSchema, await callRpc(asRpcClient(staff.supabase), fn, {}));
    return parsed.prefillAutoFill ?? null;
  } catch {
    return null;
  }
}
