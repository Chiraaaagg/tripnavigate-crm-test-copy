'use server';

import { revalidatePath } from 'next/cache';
import { asRpcClient } from '@/modules/fulfilment/commands';
import { readUuid, rupeesToPaise } from '@/modules/fulfilment/forms';
import { requireStaff } from '@/modules/identity/server/session';
import { WriteOffCommandError, setWriteOff, writeOffDecide, writeOffPropose, writeOffUndo, writeOffWithdraw } from '../commands';
import {
  WRITE_OFF_BLOCK_TEXT,
  WRITE_OFF_DECISIONS,
  WRITE_OFF_DIRECTIONS,
  WRITE_OFF_DONE_TEXT,
  WRITE_OFF_ERROR_TEXT,
  WRITE_OFF_FIELD as F,
  WRITE_OFF_PATHS,
  WRITE_OFF_UNKNOWN_OUTCOME_TEXT,
  type WriteOffActionResult,
  type WriteOffBlockCode,
  type WriteOffCommandResult,
  type WriteOffDecision,
  type WriteOffDirection,
  type WriteOffErrorCode,
  type WriteOffSwitchResult,
} from '../contracts';
import { limitAllowed } from '../limits';

/**
 * Write-off commands (contract 6.6 B3-B6, 6.1 B2), one useActionState action
 * per command in the Phase 2 Addendum L3 shape: (prev, formData) -> {ok: true,
 * message, data} | {ok: false, code, message, field?}. Every action:
 * requireStaff(); read the form (never the actor, entity, branch or status);
 * run the database command under the staff member's OWN session; revalidate
 * the small balances, Accounts and Approvals pages and the Deal page. The
 * write-off amount is never typed: the screen sends the whole balance it
 * showed (hidden, paise) and the database refuses anything else. Database
 * messages never reach the browser; nothing here logs amounts, references,
 * reasons or names.
 */

type Prev<T> = WriteOffActionResult<T> | null;
type Failure = Extract<WriteOffActionResult<never>, { ok: false }>;

const PAISE = /^(0|[1-9][0-9]{0,17})$/;

function fail(code: WriteOffErrorCode | 'session', values?: Record<string, string>, field?: string, message?: string): Failure {
  return { ok: false, code, message: message ?? WRITE_OFF_ERROR_TEXT[code], ...(field ? { field } : {}), ...(values ? { values } : {}) };
}

/** Known refusals become frozen text (not_ready adds the blocker's line); anything else is rethrown without detail. */
function failFrom(error: unknown, values?: Record<string, string>): Failure {
  if (error instanceof WriteOffCommandError && error.code) {
    const hint = error.hint ?? '';
    if (error.code === 'not_ready' && Object.hasOwn(WRITE_OFF_BLOCK_TEXT, hint)) {
      return fail('not_ready', values, undefined, `${WRITE_OFF_ERROR_TEXT.not_ready} ${WRITE_OFF_BLOCK_TEXT[hint as WriteOffBlockCode]}`);
    }
    return fail(error.code, values, error.code === 'invalid_input' ? hint || undefined : undefined);
  }
  throw new Error(WRITE_OFF_UNKNOWN_OUTCOME_TEXT);
}

function revalidateWriteOffs(dealId?: string | null): void {
  for (const path of WRITE_OFF_PATHS) revalidatePath(path);
  if (dealId) revalidatePath(`/app/deals/${dealId}`);
  else revalidatePath('/app/deals/[id]', 'page');
}

function str(formData: FormData, name: string, max: number): string | null {
  const value = formData.get(name);
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v === '' || v.length > max ? null : v;
}

function typed(formData: FormData, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = formData.get(n);
    if (typeof v === 'string') out[n] = v.slice(0, 600);
  }
  return out;
}

function readRowVersion(formData: FormData): number | null {
  const raw = str(formData, F.expectedRowVersion, 10);
  return raw !== null && /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

function readReason(formData: FormData): string | null {
  const reason = str(formData, F.reason, 500);
  return reason && reason.length >= 10 ? reason : null;
}

function readPaise(formData: FormData, name: string): string | null {
  const v = str(formData, name, 20);
  return v !== null && PAISE.test(v) ? v : null;
}

const done = <T extends { outcome: string }>(data: T, message: string): WriteOffActionResult<T> =>
  ({ ok: true, data, message: data.outcome === 'existing' ? WRITE_OFF_DONE_TEXT.existing : message });

/** B3. Fields: dealId, direction, amountPaise (hidden: the whole balance shown), reason, requestId. */
export async function proposeWriteOffAction(_prev: Prev<WriteOffCommandResult>, formData: FormData): Promise<WriteOffActionResult<WriteOffCommandResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.reason]);
  const dealId = readUuid(formData, F.dealId);
  const requestId = readUuid(formData, F.requestId);
  if (!dealId || !requestId) return fail('invalid_input', values);
  const direction = str(formData, F.direction, 10);
  if (!direction || !(WRITE_OFF_DIRECTIONS as readonly string[]).includes(direction)) return fail('invalid_input', values, 'direction');
  const amountPaise = readPaise(formData, F.amountPaise);
  if (!amountPaise) return fail('invalid_input', values, 'amountPaise');
  const reason = readReason(formData);
  if (!reason) return fail('invalid_input', values, 'reason');
  try {
    const result = await writeOffPropose(asRpcClient(staff.supabase), dealId, { direction: direction as WriteOffDirection, amountPaise, reason }, requestId);
    revalidateWriteOffs(dealId);
    return done(result, WRITE_OFF_DONE_TEXT.proposed);
  } catch (error) {
    return failFrom(error, values);
  }
}

/** B4. Fields: writeOffId, decision ('approve' | 'return'), expectedAmountPaise (hidden), reason (required to return), expectedRowVersion, requestId. */
export async function decideWriteOffAction(_prev: Prev<WriteOffCommandResult>, formData: FormData): Promise<WriteOffActionResult<WriteOffCommandResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.reason]);
  const writeOffId = readUuid(formData, F.writeOffId);
  const requestId = readUuid(formData, F.requestId);
  const rowVersion = readRowVersion(formData);
  if (!writeOffId || !requestId || rowVersion === null) return fail('invalid_input', values);
  const decision = str(formData, F.decision, 10);
  if (!decision || !(WRITE_OFF_DECISIONS as readonly string[]).includes(decision)) return fail('invalid_input', values, 'decision');
  const expected = readPaise(formData, F.expectedAmountPaise);
  if (!expected) return fail('invalid_input', values, 'expectedAmountPaise');
  const rawReason = str(formData, F.reason, 500);
  const reason = readReason(formData);
  if ((decision === 'return' && !reason) || (rawReason !== null && !reason)) return fail('invalid_input', values, 'reason');
  try {
    const result = await writeOffDecide(asRpcClient(staff.supabase), writeOffId, decision as WriteOffDecision, expected, reason, rowVersion, requestId);
    revalidateWriteOffs(result.dealId);
    return done(result, decision === 'approve' ? WRITE_OFF_DONE_TEXT.approved : WRITE_OFF_DONE_TEXT.returned);
  } catch (error) {
    return failFrom(error, values);
  }
}

/** B5. Fields: writeOffId, reason, expectedRowVersion, requestId. */
export async function withdrawWriteOffAction(_prev: Prev<WriteOffCommandResult>, formData: FormData): Promise<WriteOffActionResult<WriteOffCommandResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.reason]);
  const writeOffId = readUuid(formData, F.writeOffId);
  const requestId = readUuid(formData, F.requestId);
  const rowVersion = readRowVersion(formData);
  if (!writeOffId || !requestId || rowVersion === null) return fail('invalid_input', values);
  const reason = readReason(formData);
  if (!reason) return fail('invalid_input', values, 'reason');
  try {
    const result = await writeOffWithdraw(asRpcClient(staff.supabase), writeOffId, rowVersion, reason, requestId);
    revalidateWriteOffs(result.dealId);
    return done(result, WRITE_OFF_DONE_TEXT.withdrawn);
  } catch (error) {
    return failFrom(error, values);
  }
}

/** B6. Fields: writeOffId, reason, expectedRowVersion, requestId. */
export async function undoWriteOffAction(_prev: Prev<WriteOffCommandResult>, formData: FormData): Promise<WriteOffActionResult<WriteOffCommandResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.reason]);
  const writeOffId = readUuid(formData, F.writeOffId);
  const requestId = readUuid(formData, F.requestId);
  const rowVersion = readRowVersion(formData);
  if (!writeOffId || !requestId || rowVersion === null) return fail('invalid_input', values);
  const reason = readReason(formData);
  if (!reason) return fail('invalid_input', values, 'reason');
  try {
    const result = await writeOffUndo(asRpcClient(staff.supabase), writeOffId, rowVersion, reason, requestId);
    revalidateWriteOffs(result.dealId);
    return done(result, WRITE_OFF_DONE_TEXT.undone);
  } catch (error) {
    return failFrom(error, values);
  }
}

/** B2 (Settings > Accounts). Fields: entityId, enabled ('true' | 'false'), limitRupees, reason. */
export async function setWriteOffAction(_prev: Prev<WriteOffSwitchResult>, formData: FormData): Promise<WriteOffActionResult<WriteOffSwitchResult>> {
  const staff = await requireStaff();
  const values = typed(formData, [F.reason, F.limitRupees]);
  const entityId = readUuid(formData, F.entityId);
  const enabledRaw = str(formData, F.enabled, 5);
  if (!entityId || (enabledRaw !== 'true' && enabledRaw !== 'false')) return fail('invalid_input', values);
  const raw = formData.get(F.limitRupees);
  const limitPaise = rupeesToPaise(typeof raw === 'string' ? raw.slice(0, 30) : undefined);
  if (!limitPaise || !limitAllowed(limitPaise)) return fail('invalid_input', values, 'limitPaise');
  const reason = readReason(formData);
  if (!reason) return fail('invalid_input', values, 'reason');
  try {
    const result = await setWriteOff(asRpcClient(staff.supabase), entityId, enabledRaw === 'true', limitPaise, reason);
    revalidatePath('/app/admin/accounts');
    revalidateWriteOffs();
    return { ok: true, data: result, message: result.changed ? WRITE_OFF_DONE_TEXT.switched : WRITE_OFF_DONE_TEXT.existing };
  } catch (error) {
    return failFrom(error, values);
  }
}
