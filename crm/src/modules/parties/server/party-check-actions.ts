'use server';

import { revalidatePath } from 'next/cache';
import { requireStaff } from '@/modules/identity/server/session';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { PARTY_FIELD, parsePartyFields, readReturnReason, readRowVersionField, readUuidField } from '../party-forms';
import { checkParty, partyAccountsSave } from './parties-db';
import { vnFail, vnFailFrom, type VnResult } from './party-results';

/**
 * Accounts customer check (voice-note batch, owner item 10): edit, check,
 * return with a reason. requireStaff() first; each command runs under the
 * caller's own session, which decides (Accounts of the customer's entity;
 * the same Accounts person may edit and check, owner answer 4; never
 * Purchase) and writes the audit row. A stale screen is refused by the row
 * version it showed. Results carry ids and row versions only.
 */

type Done = { partyId: string; rowVersion: number; checkStatus: string };

const HINTS: Record<string, string> = {
  partyType: PARTY_FIELD.partyType,
  name: PARTY_FIELD.name,
  contactPerson: PARTY_FIELD.contactPerson,
  phone: PARTY_FIELD.phone,
  email: PARTY_FIELD.email,
  addressLine1: PARTY_FIELD.addressLine1,
  addressLine2: PARTY_FIELD.addressLine2,
  city: PARTY_FIELD.city,
  stateCode: PARTY_FIELD.stateCode,
  postalCode: PARTY_FIELD.postalCode,
  gstStatus: PARTY_FIELD.gstStatus,
  gstin: PARTY_FIELD.gstin,
  gstReason: PARTY_FIELD.gstReason,
  reason: PARTY_FIELD.reason,
};

function target(formData: FormData): { partyId: string; rowVersion: number } | { bad: string[] } {
  const partyId = readUuidField(formData, PARTY_FIELD.partyId);
  const rowVersion = readRowVersionField(formData, PARTY_FIELD.partyRowVersion);
  const bad = [...(partyId ? [] : [PARTY_FIELD.partyId]), ...(rowVersion === null ? [PARTY_FIELD.partyRowVersion] : []), ...(readUuidField(formData, PARTY_FIELD.requestId) ? [] : [PARTY_FIELD.requestId])];
  return bad.length > 0 ? { bad } : { partyId: partyId!, rowVersion: rowVersion! };
}

function revalidate(partyId: string): void {
  revalidatePath('/app/accounts/customers');
  revalidatePath(`/app/accounts/customers/${partyId}`);
}

/** "Save details" by Accounts: the customer goes back to Not checked (the database says so too). */
export async function saveCheckedPartyAction(_prev: VnResult<Done> | null, formData: FormData): Promise<VnResult<Done>> {
  const staff = await requireStaff();
  const t = target(formData);
  const parsed = parsePartyFields(formData);
  if ('bad' in t || !parsed.ok) return vnFail('invalid_input', [...('bad' in t ? t.bad : []), ...(parsed.ok ? [] : parsed.fields)]);
  try {
    const r = await partyAccountsSave(asRpcClient(staff.supabase), { partyId: t.partyId, expectedRowVersion: t.rowVersion, fields: parsed.fields, reason: null });
    revalidate(t.partyId);
    return { ok: true, data: { partyId: t.partyId, rowVersion: r.rowVersion, checkStatus: r.checkStatus }, message: 'Details saved. The customer is Not checked until you check it.' };
  } catch (error) {
    revalidate(t.partyId);
    return vnFailFrom(error, HINTS);
  }
}

/** "Mark checked": Accounts confirms the details. Nothing else changes (existing billing checks stay as they are). */
export async function checkPartyAction(_prev: VnResult<Done> | null, formData: FormData): Promise<VnResult<Done>> {
  const staff = await requireStaff();
  const t = target(formData);
  if ('bad' in t) return vnFail('invalid_input', t.bad);
  try {
    const r = await checkParty(asRpcClient(staff.supabase), { partyId: t.partyId, expectedRowVersion: t.rowVersion, decision: 'checked', reason: null });
    revalidate(t.partyId);
    return { ok: true, data: { partyId: t.partyId, rowVersion: r.rowVersion, checkStatus: r.checkStatus }, message: 'Customer checked.' };
  } catch (error) {
    revalidate(t.partyId);
    return vnFailFrom(error, HINTS);
  }
}

/** "Return to Sales" with a reason of 10 to 500 characters (Sales sees the reason and fixes the details). */
export async function returnPartyAction(_prev: VnResult<Done> | null, formData: FormData): Promise<VnResult<Done>> {
  const staff = await requireStaff();
  const t = target(formData);
  const reason = readReturnReason(formData);
  if ('bad' in t || reason === null) return vnFail('invalid_input', [...('bad' in t ? t.bad : []), ...(reason === null ? [PARTY_FIELD.reason] : [])], reason === null ? 'Write why you are returning this customer (10 to 500 characters). Nothing was changed.' : undefined);
  try {
    const r = await checkParty(asRpcClient(staff.supabase), { partyId: t.partyId, expectedRowVersion: t.rowVersion, decision: 'returned', reason });
    revalidate(t.partyId);
    return { ok: true, data: { partyId: t.partyId, rowVersion: r.rowVersion, checkStatus: r.checkStatus }, message: 'Customer returned with your reason.' };
  } catch (error) {
    revalidate(t.partyId);
    return vnFailFrom(error, HINTS);
  }
}
