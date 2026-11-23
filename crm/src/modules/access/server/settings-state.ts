import 'server-only';
import type { StaffContext } from '@/modules/identity/server/session';
import { asRpcClient } from '@/modules/fulfilment/commands';
import {
  SettingsReadError,
  settingsSwitchStates,
  workflowVisaTaskPreview,
  type SettingsSwitchStates,
  type VisaTaskPreview,
} from '../settings-state';

/**
 * Direction A Batch 4 Settings loaders (Atlas migration 20261125000100), run
 * under the staff member's own session. Never throw:
 *   record           the database answered
 *   null             this person may not read it (no tab, no card)
 *   'not_installed'  the database has no Batch 4 functions yet (say so; show
 *                    today's screens; never assume Off)
 *   'error'          anything else (show "could not be read", never Off)
 */

type Staff = Pick<StaffContext, 'supabase'>;
export type SettingsLoad<T> = T | null | 'not_installed' | 'error';

async function load<T>(read: () => Promise<T>): Promise<SettingsLoad<T>> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof SettingsReadError) {
      if (error.code === 'not_authorized') return null;
      if (error.code === 'not_installed') return 'not_installed';
    }
    return 'error';
  }
}

export function loadSettingsSwitchStates(staff: Staff): Promise<SettingsLoad<SettingsSwitchStates>> {
  return load(() => settingsSwitchStates(asRpcClient(staff.supabase)));
}

/** Read just before the "Switch Visa and passport tasks on" review step (plan M5). */
export function loadVisaTaskPreview(staff: Staff): Promise<SettingsLoad<VisaTaskPreview>> {
  return load(() => workflowVisaTaskPreview(asRpcClient(staff.supabase)));
}
