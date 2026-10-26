'use server';

import { revalidatePath } from 'next/cache';
import { requireStaff } from '@/modules/identity/server/session';
import { VnDbError } from '@/modules/parties/server/parties-db';
import { asRpcClient } from '../commands';
import { normaliseNameReadReason } from '../name-map';
import type { NameReadSwitchActionResult } from './name-map-actions';
import { setTripDetailsRead } from './destinations-db';

/**
 * Voice-note batch (24 October 2026): "Read trip details from Bitrix" switch
 * on the Bitrix connection page (Super Admin). Same form and checks as the
 * Bitrix names switch: `state` = 'on' | 'off', `reason` (10-500 characters,
 * spaces collapsed), `confirm` = 'yes'. The database command refuses anyone
 * but a Super Admin of the company and writes the audit rows itself. The
 * switch starts off; live use needs the owner's APPROVE.
 */

const INTEGRATION_PATH = '/app/admin/integration';

const MESSAGE = {
  invalid: 'Check the highlighted fields. Nothing was changed.',
  not_authorized: 'Only the Super Admin can change this setting. Nothing was changed.',
  not_configured: 'The Bitrix connection is not set up, so this setting cannot be changed. Nothing was changed.',
  not_installed: 'This setting is not available on this database yet. Nothing was changed.',
  failed: 'The setting could not be saved. Nothing was changed. Try again.',
  unchanged: (on: boolean) => `Reading trip details from Bitrix was already ${on ? 'on' : 'off'}. Nothing was changed.`,
  on: 'Trip details from Bitrix are on. Destination, adults, children and infants are read with the next Bitrix updates. The reason is recorded in the audit log.',
  off: 'Trip details from Bitrix are off. Bookings keep the values already saved. The reason is recorded in the audit log.',
} as const;

export async function setBitrixTripDetailsReadAction(
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

  try {
    const result = await setTripDetailsRead(asRpcClient(staff.supabase), state === 'on', reason!);
    revalidatePath(INTEGRATION_PATH);
    const { changed, enabled } = result;
    return { ok: true, enabled, changed, message: changed ? (enabled ? MESSAGE.on : MESSAGE.off) : MESSAGE.unchanged(enabled) };
  } catch (error) {
    const code = error instanceof VnDbError ? error.code : null;
    // A database without the command answers PGRST202 / 42883 (no mapped token).
    const missing = error instanceof VnDbError && (error.sqlState === 'PGRST202' || error.sqlState === '42883');
    if (code === 'invalid_input') return { ok: false, code: 'invalid_input', fields: ['reason'], message: MESSAGE.invalid };
    if (code === 'not_authorized' || code === 'not_configured') return { ok: false, code, message: MESSAGE[code] };
    if (missing) return { ok: false, code: 'not_installed', message: MESSAGE.not_installed };
    return { ok: false, code: 'failed', message: MESSAGE.failed };
  }
}
