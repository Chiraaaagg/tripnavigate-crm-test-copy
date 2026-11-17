'use server';

import { revalidatePath } from 'next/cache';
import { requireStaff } from '@/modules/identity/server/session';
import { QUOTATION_ERROR_TEXT, type QuotationErrorCode } from '@/modules/quotations/contracts';
import { quotationPrefillApply } from '@/modules/quotations/commands';
import { qfail, qfailFrom } from '@/modules/quotations/server/results';
import { bookingPrefillApply, prefillMarkChecked } from '../b11-commands';
import { PREFILL_FIELD, parsePrefillDismissForm, parsePrefillForm, parsePrefillTargetForm, type PrefillForm } from '../b11-forms';
import { prefillFillEmpty, prefillNoticeDismiss } from '../prefill-auto';
import type { PrefillDismissResult, PrefillFillEmptyResult } from '../prefill-contract';
import { asRpcClient, BookingCommandError } from '../commands';
import {
  type BookingPrefillField,
  PREFILL_FIELD_LABEL,
  PREFILL_SKIP_TEXT,
  PREFILL_TEXT,
  type PrefillActionResult,
  type PrefillApplyResult,
  type PrefillCheckedResult,
  type PrefillFieldCode,
} from '../contracts';
import { fail, failFrom } from './b11-results';

/**
 * B1.2 Bitrix prefill actions (0600, DEC-36) for Book now and quotations.
 * requireStaff() first; the form names only the target, version, row
 * version and field codes — the values come from the database snapshot of
 * the Deal or Lead, never from the browser. One command under the staff
 * member's own session; the database authorizes (same gate as the target's
 * saves), audits and refuses prefill_unavailable while nothing was read.
 * No privileged client. Signatures fit useActionState.
 */

type Prev<T> = PrefillActionResult<T> | null;

const HINTS = { fields: PREFILL_FIELD.field, targetKind: PREFILL_FIELD.target };

function revalidateTarget(form: Pick<PrefillForm, 'targetKind' | 'dealId'>): void {
  if (form.targetKind === 'booking_version' && form.dealId) {
    revalidatePath(`/app/deals/${form.dealId}`);
    revalidatePath(`/app/deals/${form.dealId}/intake`);
    revalidatePath(`/app/deals/${form.dealId}/book`);
    revalidatePath('/app/deals/[id]/book', 'layout'); // the overview, the booking form layout (route group) and its steps
  } else {
    revalidatePath('/app/quotations', 'layout');
    revalidatePath('/app/leads/[id]', 'page');
    revalidatePath('/app/deals/[id]', 'page');
  }
}

function labels(codes: readonly PrefillFieldCode[]): string {
  return codes.map((c) => PREFILL_FIELD_LABEL[c]).join(', ');
}

function appliedMessage(result: PrefillApplyResult): string {
  const head = result.applied.length > 0 ? PREFILL_TEXT.applied.replace('{fields}', labels(result.applied)) : PREFILL_TEXT.appliedNone;
  const skipped = result.skipped.map((s) => PREFILL_TEXT.skipped.replace('{field}', PREFILL_FIELD_LABEL[s.field]).replace('{reason}', PREFILL_SKIP_TEXT[s.reason]));
  return [head, ...skipped].join(' ');
}

/** A refusal on a quotation target, in quotation wording when the token has one. */
function quotationRefusal(error: unknown): PrefillActionResult<never> {
  if (error instanceof BookingCommandError && error.code) {
    const code = error.code;
    if (code === 'session' || Object.hasOwn(QUOTATION_ERROR_TEXT, code)) {
      return qfail(code as QuotationErrorCode | 'session', code === 'invalid_input' ? [PREFILL_FIELD.field] : undefined);
    }
  }
  return failFrom(error, HINTS);
}

/**
 * "Use Bitrix values" for the chosen fields of a Book now working draft or a
 * quotation draft. Skipped fields (no value, end before start, mobile not a
 * 10-digit Indian number, no contact name, contact without mobile or email)
 * are named in the message; a contact filled from Bitrix stays unconfirmed.
 */
export async function usePrefillAction(_prev: Prev<PrefillApplyResult>, formData: FormData): Promise<PrefillActionResult<PrefillApplyResult>> {
  const staff = await requireStaff();
  const parsed = parsePrefillForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  const rpc = asRpcClient(staff.supabase);
  if (v.targetKind === 'booking_version') {
    try {
      const result = await bookingPrefillApply(rpc, { versionId: v.versionId, expectedRowVersion: v.expectedRowVersion, fields: v.fields as BookingPrefillField[] });
      revalidateTarget(v);
      return { ok: true, data: result, message: appliedMessage(result) };
    } catch (error) {
      if (error instanceof BookingCommandError && error.code === 'version_changed') revalidateTarget(v);
      return failFrom(error, HINTS);
    }
  }
  try {
    const result = await quotationPrefillApply(rpc, { versionId: v.versionId, expectedRowVersion: v.expectedRowVersion, fields: v.fields });
    revalidateTarget(v);
    return { ok: true, data: result, message: appliedMessage(result) };
  } catch (error) {
    return qfailFrom(error, HINTS);
  }
}

/**
 * "Mark checked": staff confirm fields filled from Bitrix. Only fields still
 * marked from Bitrix change (checked or changed ones stay as they are); the
 * row version does not move.
 */
export async function markPrefillCheckedAction(_prev: Prev<PrefillCheckedResult>, formData: FormData): Promise<PrefillActionResult<PrefillCheckedResult>> {
  const staff = await requireStaff();
  const parsed = parsePrefillForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  try {
    const result = await prefillMarkChecked(asRpcClient(staff.supabase), {
      targetKind: v.targetKind,
      targetId: v.versionId,
      expectedRowVersion: v.expectedRowVersion,
      fields: v.fields,
    });
    revalidateTarget(v);
    const message = result.checked.length > 0 ? PREFILL_TEXT.checked.replace('{fields}', labels(result.checked)) : PREFILL_TEXT.checkedNone;
    return { ok: true, data: result, message };
  } catch (error) {
    return v.targetKind === 'quotation_version' ? quotationRefusal(error) : failFrom(error, HINTS);
  }
}

/** DA-162 / DA-165 (copy-catalogue §16.11). */
const FILL_EMPTY_TEXT = {
  filled: 'Filled from Bitrix: {fields}. Check them with the customer.',
  none: 'Nothing was filled from Bitrix.',
  dismissed: 'Kept your value. The Bitrix change is hidden until Bitrix changes it again.',
} as const;

const DISMISS_HINTS = { field: PREFILL_FIELD.field, sourceModifiedAt: PREFILL_FIELD.sourceModifiedAt, targetKind: PREFILL_FIELD.target };

/**
 * Batch 2 "Fill empty fields from Bitrix" (prefill_fill_empty, switch on,
 * drafts without a creation fill). Fills only empty fields staff never
 * touched; cleared and unprovable fields come back as skipped, named in the
 * message. Bumps the row version: the reply's rowVersion joins the page's
 * own-save chain. A contact filled here stays unconfirmed.
 */
export async function fillEmptyPrefillAction(_prev: Prev<PrefillFillEmptyResult>, formData: FormData): Promise<PrefillActionResult<PrefillFillEmptyResult>> {
  const staff = await requireStaff();
  const parsed = parsePrefillTargetForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  try {
    const result = await prefillFillEmpty(asRpcClient(staff.supabase), { targetKind: v.targetKind, targetId: v.versionId, expectedRowVersion: v.expectedRowVersion });
    revalidateTarget(v);
    const head = result.filled.length > 0 ? FILL_EMPTY_TEXT.filled.replace('{fields}', labels(result.filled)) : FILL_EMPTY_TEXT.none;
    const skipped = result.skipped.map((s) => PREFILL_TEXT.skipped.replace('{field}', PREFILL_FIELD_LABEL[s.field]).replace('{reason}', PREFILL_SKIP_TEXT[s.reason]));
    return { ok: true, data: result, message: [head, ...skipped].join(' ') };
  } catch (error) {
    if (error instanceof BookingCommandError && error.code === 'version_changed') revalidateTarget(v);
    return v.targetKind === 'quotation_version' ? quotationRefusal(error) : failFrom(error, HINTS);
  }
}

/**
 * Batch 2 "Keep mine" on a "Bitrix now says …" notice (prefill_notice_dismiss):
 * hides the notice of one field until Bitrix changes it again. No value is
 * written and the row version does not move.
 */
export async function dismissPrefillNoticeAction(_prev: Prev<PrefillDismissResult>, formData: FormData): Promise<PrefillActionResult<PrefillDismissResult>> {
  const staff = await requireStaff();
  const parsed = parsePrefillDismissForm(formData);
  if (!parsed.ok) return fail('invalid_input', parsed.fields);
  const v = parsed.value;
  try {
    const result = await prefillNoticeDismiss(asRpcClient(staff.supabase), {
      targetKind: v.targetKind,
      targetId: v.versionId,
      expectedRowVersion: v.expectedRowVersion,
      field: v.field,
      sourceModifiedAt: v.sourceModifiedAt,
    });
    revalidateTarget(v);
    return { ok: true, data: result, message: FILL_EMPTY_TEXT.dismissed };
  } catch (error) {
    return v.targetKind === 'quotation_version' ? quotationRefusal(error) : failFrom(error, DISMISS_HINTS);
  }
}
