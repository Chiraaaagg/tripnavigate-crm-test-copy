'use server';

import { revalidatePath } from 'next/cache';
import { requireStaff } from '@/modules/identity/server/session';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { setDestinationScope } from '@/modules/integration/server/destinations-db';
import { vnFail, vnFailFrom, type VnResult } from '@/modules/parties/server/party-results';

/**
 * Settings · Bitrix connection · Trip type of each Bitrix destination
 * (voice-note batch, owner answer 3). A Super Admin classifies each Bitrix
 * destination option once as domestic or international, with a reason;
 * "not set" clears it (the booking then asks staff, never guesses).
 * requireStaff() first; bitrix_destination_scope_set runs under the caller's
 * own session (Super Admin only, reason 10 to 500, audited with before and
 * after). A stale screen is refused by the row version it showed.
 */

const FIELD = { optionId: 'optionId', listId: 'listId', source: 'source', scope: 'scope', reason: 'reason', rowVersion: 'rowVersion', requestId: 'requestId' } as const;
const LIST_ID = { single: 'DEAL_DESTINATION', multi: 'DEAL_DESTINATION_MULTI' } as const;

function text(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === 'string' ? v.trim() : '';
}

export async function setDestinationScopeAction(_prev: VnResult<{ rowVersion: number; scope: string | null }> | null, formData: FormData): Promise<VnResult<{ rowVersion: number; scope: string | null }>> {
  const staff = await requireStaff();
  const bad: string[] = [];
  const optionId = text(formData, FIELD.optionId);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(optionId)) bad.push(FIELD.optionId);
  // The card posts the Bitrix list id of the row (an older post may send source single|multi).
  const listRaw = text(formData, FIELD.listId);
  const sourceRaw = text(formData, FIELD.source);
  const listId = listRaw === LIST_ID.single || listRaw === LIST_ID.multi ? listRaw : listRaw === '' && (sourceRaw === 'single' || sourceRaw === 'multi') ? LIST_ID[sourceRaw] : null;
  if (!listId) bad.push(FIELD.listId);
  const scopeRaw = text(formData, FIELD.scope);
  const scope = scopeRaw === '' ? null : scopeRaw === 'domestic' || scopeRaw === 'international' ? scopeRaw : undefined;
  if (scope === undefined) bad.push(FIELD.scope);
  const reason = text(formData, FIELD.reason).replace(/\s+/g, ' ');
  const reasonOk = reason.length >= 10 && reason.length <= 500;
  if (!reasonOk) bad.push(FIELD.reason);
  const rv = text(formData, FIELD.rowVersion);
  const expectedRowVersion = /^(0|[1-9][0-9]{0,8})$/.test(rv) ? Number(rv) : null;
  if (expectedRowVersion === null) bad.push(FIELD.rowVersion);
  if (!/^[0-9a-f-]{36}$/i.test(text(formData, FIELD.requestId))) bad.push(FIELD.requestId);
  if (bad.length > 0) return vnFail('invalid_input', bad, reasonOk ? undefined : 'Write why you are setting this trip type (10 to 500 characters). Nothing was changed.');
  try {
    const r = await setDestinationScope(asRpcClient(staff.supabase), {
      listId: listId!,
      optionId,
      scope: scope ?? null,
      expectedRowVersion: expectedRowVersion!,
      reason,
    });
    revalidatePath('/app/admin/integration');
    const words = r.scope === 'domestic' ? 'Domestic' : r.scope === 'international' ? 'International' : 'Not set (staff choose on each booking)';
    return { ok: true, data: { rowVersion: r.rowVersion, scope: r.scope }, message: r.changed ? `Trip type saved: ${words}.` : `No change: it was already ${words}.` };
  } catch (error) {
    revalidatePath('/app/admin/integration');
    return vnFailFrom(error, { reason: FIELD.reason, scope: FIELD.scope, optionId: FIELD.optionId });
  }
}
