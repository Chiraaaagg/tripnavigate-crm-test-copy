'use server';

import type { NameReadSwitchActionResult } from '@/modules/integration/server/name-map-actions';

/*
 * LOCAL DESIGN-REVIEW GALLERY ONLY. Stand-in server actions for the DEC-55
 * "Bitrix names" card: fixed answers through the real form path, no database.
 * The gallery page itself is a 404 outside the local preview mode.
 */

/** Always refused as not authorized: shows the refusal and the kept reason. */
export async function previewNamesRefuseAction(): Promise<NameReadSwitchActionResult> {
  return { ok: false, code: 'not_authorized', message: 'Only the Super Admin can change this setting. Nothing was changed.' };
}

/** Always saved (turned on). */
export async function previewNamesSavedAction(): Promise<NameReadSwitchActionResult> {
  return {
    ok: true,
    enabled: true,
    changed: true,
    message: 'Bitrix names are on. Stage, status and source names will appear after the next daily read. The reason is recorded in the audit log.',
  };
}
