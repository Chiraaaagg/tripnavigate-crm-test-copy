'use server';

import { revalidatePath } from 'next/cache';
import { requireStaff } from '@/modules/identity/server/session';
import { asRpcClient } from '../commands';
import { normaliseNameReadReason } from '../name-map';
import { setBitrixNameRead } from './name-map';

/**
 * DEC-55: "Show Bitrix names" switch on the Bitrix sync page (Super Admin).
 *
 * Form fields: `state` = 'on' | 'off', `reason` (10-500 characters, spaces
 * collapsed), `confirm` = 'yes' (the page's confirmation step; refused without
 * it, so a confirmation that only exists in the browser is not enough).
 * Authorization is checked on the server twice: requireStaff() (aal2, active
 * staff) and the database command, which refuses anyone but a Super Admin of
 * the company and writes the audit rows (who, when, reason) itself. The actor
 * and company are never read from the form. Live use needs the owner's APPROVE.
 */

export type NameReadSwitchActionResult =
  | { ok: true; enabled: boolean; changed: boolean; message: string }
  | { ok: false; code: 'invalid_input'; fields: Array<'state' | 'reason' | 'confirm'>; message: string }
  | { ok: false; code: 'not_authorized' | 'not_configured' | 'not_installed' | 'failed'; message: string };

const INTEGRATION_PATH = '/app/admin/integration';

const MESSAGE = {
  invalid: 'Check the highlighted fields. Nothing was changed.',
  not_authorized: 'Only the Super Admin can change this setting. Nothing was changed.',
  not_configured: 'The Bitrix connection is not set up, so this setting cannot be changed. Nothing was changed.',
  not_installed: 'This setting is not available on this database yet. Nothing was changed.',
  failed: 'The setting could not be saved. Nothing was changed. Try again.',
  unchanged: (on: boolean) => `Bitrix names were already ${on ? 'on' : 'off'}. Nothing was changed.`,
  on: 'Bitrix names are on. Stage, status and source names will appear after the next daily read. The reason is recorded in the audit log.',
  off: 'Bitrix names are off. Screens show the codes again; stored names are kept. The reason is recorded in the audit log.',
} as const;

export async function setBitrixNameReadAction(
  _prev: NameReadSwitchActionResult | null,
  formData: FormData,
): Promise<NameReadSwitchActionResult> {
  const staff = await requireStaff();
  const fields: Array<'state' | 'reason' | 'confirm'> = [];
  const state = formData.get('state');
  if (state !== 'on' && state !== 'off') fields.push('state');
  const reason = normaliseNameReadReason(formData.get('reason'));
  if (reason === null) fields.push('reason');
  if (formData.get('confirm') !== 'yes') fields.push('confirm');
  if (fields.length > 0) return { ok: false, code: 'invalid_input', fields, message: MESSAGE.invalid };

  // Early refusal for people without a Super Admin role anywhere (the database decides again).
  if (!staff.access.memberships.some((m) => m.roleCode === 'super_admin')) {
    return { ok: false, code: 'not_authorized', message: MESSAGE.not_authorized };
  }

  const result = await setBitrixNameRead(asRpcClient(staff.supabase), state === 'on', reason!);
  if (!result.ok) {
    if (result.code === 'reason_required') return { ok: false, code: 'invalid_input', fields: ['reason'], message: MESSAGE.invalid };
    return { ok: false, code: result.code, message: MESSAGE[result.code] };
  }
  revalidatePath(INTEGRATION_PATH);
  const { changed, enabled } = result.result;
  return { ok: true, enabled, changed, message: changed ? (enabled ? MESSAGE.on : MESSAGE.off) : MESSAGE.unchanged(enabled) };
}
