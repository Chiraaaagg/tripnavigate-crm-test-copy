'use server';

import { revalidatePath } from 'next/cache';
import { requireStaff } from '@/modules/identity/server/session';
import { setBitrixIdProofCopy, setBitrixReadSwitches } from '../b11-commands';
import { B12_SWITCH_FIELD, parseB12SwitchForm } from '../b11-forms';
import { asRpcClient } from '../commands';
import { B12_SWITCH_ACTION_TEXT, B12_SWITCH_TEXT, type B12SwitchResult, type BookingActionResult } from '../contracts';
import { fail, failFrom } from './b11-results';

/**
 * B1.2 switches (Super Admin): one audited database command per change, under
 * the staff member's own session, with the typed reason. Nothing here reads
 * the actor or the company from the form. Live use needs the owner's APPROVE
 * (the page says so); the database refuses anyone but the Super Admin.
 */

const WORKFLOW_PATH = '/app/admin/workflow';

export async function setB12SwitchAction(_prev: BookingActionResult<B12SwitchResult> | null, formData: FormData): Promise<BookingActionResult<B12SwitchResult>> {
  const staff = await requireStaff();
  const parsed = parseB12SwitchForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const { key, on, reason } = parsed.value;
  const rpc = asRpcClient(staff.supabase);
  try {
    let result: B12SwitchResult;
    if (key === 'bitrix_id_proof_copy') {
      const r = await setBitrixIdProofCopy(rpc, { on, reason });
      result = { key, changed: r.changed, on: r.on };
    } else {
      const r = await setBitrixReadSwitches(rpc, {
        tripFactsRead: key === 'bitrix_trip_facts_read' ? on : null,
        leadIntakeUnowned: key === 'lead_intake_unowned' ? on : null,
        reason,
      });
      result = {
        key,
        changed: r.changed,
        on: key === 'bitrix_trip_facts_read' ? r.after.tripFactsRead : r.after.leadIntakeUnowned,
        ...(key === 'lead_intake_unowned' && r.changed && r.after.leadIntakeUnowned ? { requeued: r.requeued, notRequeued: r.notRequeued } : {}),
      };
    }
    revalidatePath(WORKFLOW_PATH);
    // Batch 4 (lead ruling D3): the Bitrix switches are shown on Settings · Bitrix connection.
    revalidatePath('/app/admin/integration');
    if (!result.changed) return { ok: true, data: result, message: B12_SWITCH_ACTION_TEXT.unchanged.replace('{state}', result.on ? 'on' : 'off') };
    const text = B12_SWITCH_TEXT[key];
    const extra =
      result.requeued !== undefined
        ? ` ${B12_SWITCH_ACTION_TEXT.requeued.replace('{requeued}', String(result.requeued)).replace('{notRequeued}', String(result.notRequeued ?? 0))}`
        : '';
    return { ok: true, data: result, message: `${result.on ? text.onNote : text.offNote}${extra} The reason is recorded in the audit log.` };
  } catch (error) {
    return failFrom(error, { reason: B12_SWITCH_FIELD.reason, on: B12_SWITCH_FIELD.state, switches: B12_SWITCH_FIELD.state });
  }
}
