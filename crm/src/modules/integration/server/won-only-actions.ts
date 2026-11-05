'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { type FormState, fieldValue } from '@/lib/forms';
import { requireStaff } from '@/modules/identity/server/session';
import { asRpcClient } from '../commands';
import {
  PRUNE_CONFIRM_PHRASE,
  PRUNE_UNDO_NOTE,
  type PruneResult,
  WON_ONLY_REASON_MAX,
  WON_ONLY_REASON_MIN,
  WonOnlyCommandError,
  pruneDealsOutsideEntryStages,
  setDealEntryStages,
  wonOnlyRefusalText,
} from '../won-only';

/**
 * B1.1d Won-only Deal intake: Super Admin actions for the admin screen (freeze
 * note 3.3). Pattern as access-actions.ts: requireStaff() -> validate -> the
 * database command under the person's OWN session (it re-checks Super Admin at
 * aal2, the reason, writes the audit rows). No privileged client. Typed values
 * come back in `values` after every refusal so the form keeps them.
 *
 * Owner rule: switching on and the real prune run against the live database
 * only after the owner's APPROVE; the screen shows the dry run first.
 */

const SYNC_PATH = '/app/admin/integration';
const WORKFLOW_PATH = '/app/admin/workflow';

export interface WonOnlyFormState extends FormState {
  values?: { reason: string; stageIds: string[]; confirm?: string };
}

export interface PruneFormState extends WonOnlyFormState {
  /** The command's answer (dry run or real run); absent after a refusal. */
  result?: PruneResult;
}

const Reason = z
  .string()
  .transform((v) => v.trim())
  .refine((v) => v.length >= WON_ONLY_REASON_MIN && v.length <= WON_ONLY_REASON_MAX, {
    message: `Write a reason of ${WON_ONLY_REASON_MIN} to ${WON_ONLY_REASON_MAX} characters, including the owner's approval.`,
  });
const StageId = z.string().regex(/^[A-Za-z0-9_:.-]{1,50}$/);

function refusalMessage(error: unknown): string {
  return error instanceof WonOnlyCommandError
    ? wonOnlyRefusalText(error.refusal)
    : 'The request could not be completed. Nothing was changed. Please retry.';
}

const dealsText = (n: number) => `${n} Deal${n === 1 ? '' : 's'}`;

/**
 * Fields: `mode` ('on' | 'off'), `stageId` (repeatable, when on), `reason`.
 * On: sets the entry stages (Won-only intake on). Off: clears them (rollback).
 */
export async function setDealEntryStagesAction(_prev: WonOnlyFormState, formData: FormData): Promise<WonOnlyFormState> {
  const staff = await requireStaff();
  const reasonRaw = fieldValue(formData, 'reason') ?? '';
  const mode = fieldValue(formData, 'mode');
  const stageIdsRaw = formData.getAll('stageId').map(String);
  const values = { reason: reasonRaw, stageIds: stageIdsRaw };

  const reason = Reason.safeParse(reasonRaw);
  if (!reason.success) return { status: 'error', message: reason.error.issues[0]?.message, values };
  if (mode !== 'on' && mode !== 'off') return { status: 'error', message: 'Choose on or off.', values };
  let stageIds: string[] | null = null;
  if (mode === 'on') {
    const unique = [...new Set(stageIdsRaw)];
    const parsed = z.array(StageId).min(1).max(20).safeParse(unique);
    if (!parsed.success) return { status: 'error', message: 'Choose between 1 and 20 Bitrix stages.', values };
    stageIds = parsed.data;
  }

  try {
    const r = await setDealEntryStages(asRpcClient(staff.supabase), { stageIds, reason: reason.data });
    revalidatePath(SYNC_PATH);
    revalidatePath(WORKFLOW_PATH);
    if (!r.changed) {
      return { status: 'success', message: 'Nothing changed: the setting was already like this.', values: { reason: '', stageIds: stageIds ?? [] } };
    }
    const parts = [
      stageIds
        ? 'Saved. New Deals now enter the CRM only at the chosen stage. Deals already in the CRM stay and keep updating.'
        : 'Saved. Won-only intake is off: new Deals enter at the ticked stages again.',
    ];
    if (r.restored > 0) parts.push(`${dealsText(r.restored)} removed earlier came back.`);
    if (r.requeued > 0) parts.push(`${r.requeued} skipped Bitrix update${r.requeued === 1 ? ' is' : 's are'} checked again.`);
    if (r.resyncQueued) parts.push('A full check with Bitrix has started; its progress is shown on the Bitrix sync page.');
    return { status: 'success', message: parts.join(' '), values: { reason: '', stageIds: stageIds ?? [] } };
  } catch (error) {
    return { status: 'error', message: refusalMessage(error), values };
  }
}

/** Field: `reason`. Lists what the prune would remove and what it keeps. PRUNE_DRY_RUN_NOTE says what it writes. */
export async function pruneDryRunAction(_prev: PruneFormState, formData: FormData): Promise<PruneFormState> {
  const staff = await requireStaff();
  const reasonRaw = fieldValue(formData, 'reason') ?? '';
  const values = { reason: reasonRaw, stageIds: [] };
  const reason = Reason.safeParse(reasonRaw);
  if (!reason.success) return { status: 'error', message: reason.error.issues[0]?.message, values };
  try {
    const result = await pruneDealsOutsideEntryStages(asRpcClient(staff.supabase), { reason: reason.data, dryRun: true });
    return {
      status: 'success',
      message: `Dry run: no Deal changed (one record of this check was written). ${dealsText(result.pruned.count)} would be removed, ${dealsText(result.keptWithWork.count)} kept because they have CRM work, ${dealsText(result.keptSyncPending.count)} kept while a sync is waiting.`,
      values,
      result,
    };
  } catch (error) {
    return { status: 'error', message: refusalMessage(error), values };
  }
}

/**
 * Fields: `reason`, `confirm` (must equal PRUNE_CONFIRM_PHRASE). Soft-removes the
 * Deals outside the entry stages that have no CRM work. Reversible.
 */
export async function pruneRunAction(_prev: PruneFormState, formData: FormData): Promise<PruneFormState> {
  const staff = await requireStaff();
  const reasonRaw = fieldValue(formData, 'reason') ?? '';
  const confirm = fieldValue(formData, 'confirm') ?? '';
  const values = { reason: reasonRaw, stageIds: [], confirm };
  const reason = Reason.safeParse(reasonRaw);
  if (!reason.success) return { status: 'error', message: reason.error.issues[0]?.message, values };
  if (confirm.trim() !== PRUNE_CONFIRM_PHRASE) {
    return { status: 'error', message: `Type ${PRUNE_CONFIRM_PHRASE} to confirm. Nothing was changed.`, values };
  }
  try {
    const result = await pruneDealsOutsideEntryStages(asRpcClient(staff.supabase), { reason: reason.data, dryRun: false });
    revalidatePath(SYNC_PATH);
    revalidatePath('/app/deals');
    return {
      status: 'success',
      message: `${dealsText(result.pruned.count)} removed from the CRM. ${dealsText(result.keptWithWork.count)} kept because they have CRM work. ${PRUNE_UNDO_NOTE}`,
      values: { reason: '', stageIds: [], confirm: '' },
      result,
    };
  } catch (error) {
    return { status: 'error', message: refusalMessage(error), values };
  }
}
