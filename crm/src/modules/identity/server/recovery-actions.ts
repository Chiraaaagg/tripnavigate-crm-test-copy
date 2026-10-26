'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { type FormState, fieldValue } from '@/lib/forms';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import type { RecoveryCase } from '../contracts';
import { ROUTES } from '../session-policy';
import { requireSignedIn, requireStaff } from './session';

/**
 * Administrator-assisted MFA recovery (contract R1-R7).
 *
 * Order is the security property:
 *   1. requireStaff() (actor from verified claims; never from the form).
 *   2. begin_mfa_recovery() under the administrator's own session: authorizes,
 *      moves the target's session barrier, opens the case and audits. From this
 *      commit on, every old token of the target is denied by the database.
 *   3. ONLY THEN the privileged Auth admin API removes the target's factors.
 *   4. The outcome is recorded by the service role
 *      (record_mfa_recovery_provider_result). A failure keeps the target
 *      blocked and is reported truthfully; retrying repeats steps 2-4 on the
 *      same case. Success moves the barrier again (sessions opened meanwhile
 *      are denied).
 *   5. Confirmation (database) completes the case and ends every session of
 *      the target; only then the server deletes every factor except the one
 *      the staff member registered, and records that outcome.
 */

const DENIED = 'You do not have permission to do that for this staff member.';
const STAFF_PAGE = '/app/admin/staff';

function dbMessage(error: { code?: string; message?: string }): string {
  switch (error.code) {
    case '42501':
      return DENIED;
    case '22023':
      return error.message ?? 'The request is not valid in the current state.';
    case '54000':
      return error.message ?? 'Too many attempts. Please wait and try again.';
    default:
      return 'The request could not be completed. Please retry.';
  }
}

function asRecoveryCase(data: unknown): RecoveryCase | null {
  const c = data as Partial<RecoveryCase> | null;
  return c && typeof c.caseId === 'string' && typeof c.userId === 'string' && typeof c.status === 'string'
    ? (c as RecoveryCase)
    : null;
}

function providerErrorCode(error: unknown): string {
  const e = error as { code?: unknown; name?: unknown; status?: unknown } | null;
  const raw = (typeof e?.code === 'string' && e.code) || (typeof e?.name === 'string' && e.name) || 'provider_error';
  return `${raw}${typeof e?.status === 'number' ? `:${e.status}` : ''}`.slice(0, 100);
}

/** Deletes only IDs captured under the database case lock, never a fresh provider list. */
async function removePlannedFactors(
  admin: ReturnType<typeof createSupabaseAdminClient>, caseId: string, phase: 'provider' | 'cleanup',
): Promise<string | null> {
  try {
    const { data, error } = await admin.rpc('get_mfa_recovery_deletion_plan', { p_case_id: caseId, p_phase: phase });
    if (error) return `plan_lookup:${error.code ?? 'error'}`;
    const plan = z.object({
      caseId: z.uuid(), userId: z.uuid(), factorIds: z.array(z.uuid()), keepFactorId: z.uuid().nullable(),
    }).safeParse(data);
    if (!plan.success || plan.data.caseId !== caseId
        || (phase === 'cleanup' && (!plan.data.keepFactorId || plan.data.factorIds.includes(plan.data.keepFactorId)))) {
      return 'invalid_deletion_plan';
    }
    for (const id of plan.data.factorIds) {
      const del = await admin.auth.admin.mfa.deleteFactor({ id, userId: plan.data.userId });
      if (del.error) return providerErrorCode(del.error);
    }
    return null;
  } catch (error) {
    return providerErrorCode(error);
  }
}

/** A missing result is unknown, never confirmation that a provider result committed. */
async function recordOutcome(
  admin: ReturnType<typeof createSupabaseAdminClient>, caseId: string,
  phase: 'provider' | 'cleanup', failure: string | null,
): Promise<boolean> {
  try {
    const result = await admin.rpc(phase === 'provider' ? 'record_mfa_recovery_provider_result' : 'record_mfa_recovery_cleanup_result', {
      p_case_id: caseId, p_ok: failure === null, p_error_code: failure,
    });
    const recovery = asRecoveryCase(result.data);
    if (result.error || !recovery || recovery.caseId !== caseId) return false;
    if (phase === 'provider') return recovery.status === (failure === null ? 'awaiting_reenrollment' : 'provider_failed');
    if (recovery.status !== 'completed') return false;
    const cleaned = typeof recovery.cleanupCompletedAt === 'string' && recovery.cleanupCompletedAt.length > 0
      && recovery.cleanupError === null;
    return failure === null ? cleaned : cleaned || (typeof recovery.cleanupError === 'string' && recovery.cleanupError.length > 0);
  } catch {
    return false;
  }
}

const BeginInput = z.object({
  userId: z.uuid(),
  reason: z.string().trim().min(10, 'Give a reason of at least 10 characters.').max(500),
});

/** Admin: begin (or retry) MFA recovery for formData userId + reason. */
export async function beginMfaRecoveryAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const parsed = BeginInput.safeParse({ userId: fieldValue(formData, 'userId'), reason: fieldValue(formData, 'reason') });
  if (!parsed.success) return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };

  const { data, error } = await staff.supabase.rpc('begin_mfa_recovery', {
    p_user_id: parsed.data.userId,
    p_reason: parsed.data.reason,
  });
  if (error) return { status: 'error', message: dbMessage(error) };
  const recovery = asRecoveryCase(data);
  if (!recovery) return { status: 'error', message: 'The request could not be completed. Please retry.' };
  return runProviderStep(recovery);
}

/**
 * Admin: retry or reconcile the provider step of the exact case the Staff page
 * showed (formData caseId). The database refuses unless that case is still
 * open in a provider state, so a stale page can never open a new case.
 */
export async function resumeMfaRecoveryProviderAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const caseId = z.uuid().safeParse(fieldValue(formData, 'caseId'));
  if (!caseId.success) return { status: 'error', message: 'Reload the Staff page and retry.' };
  const { data, error } = await staff.supabase.rpc('resume_mfa_recovery_provider', { p_case_id: caseId.data });
  if (error) {
    if (error.code === '22023' && /moved on/.test(error.message ?? '')) {
      revalidatePath(STAFF_PAGE);
      return { status: 'error', message: 'This recovery has moved on since the page loaded. Nothing was changed. Reload the Staff page.' };
    }
    return { status: 'error', message: dbMessage(error) };
  }
  const recovery = asRecoveryCase(data);
  if (!recovery || recovery.caseId !== caseId.data) {
    return { status: 'error', message: 'The request could not be completed. Reload the Staff page.' };
  }
  return runProviderStep(recovery);
}

async function runProviderStep(recovery: RecoveryCase): Promise<FormState> {
  if (recovery.status !== 'provider_pending' && recovery.status !== 'provider_failed') {
    // Provider step already done; never delete the factor the person may have just enrolled.
    revalidatePath(STAFF_PAGE);
    return {
      status: 'success',
      message:
        recovery.status === 'completed'
          ? 'Recovery confirmation is recorded. Reload the Staff page to check cleanup status.'
          : 'Recovery is already in progress. The staff member must sign in, set up a new authenticator and read you their confirmation code.',
    };
  }

  // The barrier is committed: only now touch the provider.
  const admin = createSupabaseAdminClient();
  const failure = await removePlannedFactors(admin, recovery.caseId, 'provider');
  const recorded = await recordOutcome(admin, recovery.caseId, 'provider', failure);
  revalidatePath(STAFF_PAGE);

  // An unrecorded result leaves the case pending: the Staff page then offers
  // "Check and finish removing the old authenticator" on the same case.
  if (!recorded) {
    return {
      status: 'error',
      message:
        "The person's sessions are blocked, but the result of removing their old authenticator could not be recorded, " +
        'so the outcome is unknown. Reload the Staff page and use "Check and finish removing the old authenticator".',
    };
  }
  if (failure !== null) {
    return {
      status: 'error',
      message:
        `All of this person's existing sessions are blocked, but removing their old authenticator failed (${failure}). ` +
        'They stay blocked until recovery finishes. Use "Retry removing the old authenticator" on the Staff page.',
    };
  }
  return {
    status: 'success',
    message:
      'Recovery started: existing sessions are blocked and the old authenticator was removed. ' +
      'Ask the staff member to sign in, set up a new authenticator and read you the confirmation code shown to them.',
  };
}

const ConfirmInput = z.object({
  caseId: z.uuid(),
  method: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/, 'Choose an approved verification method.'),
  confirmationCode: z
    .string()
    .transform((v) => v.replace(/\s/g, '').toUpperCase())
    .pipe(z.string().regex(/^[0-9A-Z]{6}$/, 'Enter the 6-character code the staff member reads to you.')),
  note: z.string().trim().max(500).optional(),
});

/** Admin: confirm recovery with formData caseId, method, confirmationCode, note. */
export async function confirmMfaRecoveryAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const parsed = ConfirmInput.safeParse({
    caseId: fieldValue(formData, 'caseId'),
    method: fieldValue(formData, 'method'),
    confirmationCode: fieldValue(formData, 'confirmationCode') ?? '',
    note: fieldValue(formData, 'note') || undefined,
  });
  if (!parsed.success) return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };

  const { data, error } = await staff.supabase.rpc('confirm_mfa_recovery', {
    p_case_id: parsed.data.caseId,
    p_method: parsed.data.method,
    p_confirmation_code: parsed.data.confirmationCode,
    p_note: parsed.data.note ?? null,
  });
  if (error) return { status: 'error', message: dbMessage(error) };
  const recovery = asRecoveryCase(data);
  if (recovery?.status !== 'completed') {
    revalidatePath(STAFF_PAGE);
    return {
      status: 'error',
      message: 'The code did not match. Nothing was changed. Ask the staff member to read the code on their screen again.',
    };
  }

  return finishRecoveryCleanup(recovery.caseId);
}

/** Authorized completed-case retry; the consumed confirmation code is not needed. */
export async function retryMfaRecoveryCleanupAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const caseId = z.uuid().safeParse(fieldValue(formData, 'caseId'));
  if (!caseId.success) return { status: 'error', message: 'Reload the Staff page and retry.' };
  const { data, error } = await staff.supabase.rpc('retry_mfa_recovery_cleanup', { p_case_id: caseId.data });
  if (error) return { status: 'error', message: dbMessage(error) };
  const recovery = asRecoveryCase(data);
  if (recovery?.status !== 'completed' || recovery.caseId !== caseId.data) {
    return { status: 'error', message: 'Cleanup was not authorized. Reload the Staff page.' };
  }
  return finishRecoveryCleanup(recovery.caseId);
}

async function finishRecoveryCleanup(caseId: string): Promise<FormState> {
  const admin = createSupabaseAdminClient();
  const failure = await removePlannedFactors(admin, caseId, 'cleanup');
  const recorded = await recordOutcome(admin, caseId, 'cleanup', failure);
  revalidatePath(STAFF_PAGE);
  if (!recorded) {
    return {
      status: 'error',
      message: 'The result of removing the other authenticators could not be recorded, so the outcome is unknown. ' +
        'Access is not confirmed and the person may still be blocked. Reload the Staff page to see the recorded state.',
    };
  }
  if (failure !== null) {
    return {
      status: 'error',
      message: `Recovery confirmed, but removing the person's other authenticators failed (${failure}). ` +
        'Access is not confirmed: the person stays blocked. Use "Retry removing other authenticators" on the Staff page.',
    };
  }
  return {
    status: 'success',
    message: 'Recovery confirmed. The staff member must sign in again with their new authenticator; all earlier sessions have ended.',
  };
}

/** Target user (aal2, new factor): register factor; returns the code in FormState.message. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature fixed by contracts.ts (useActionState)
export async function registerRecoveryFactorAction(_prev: FormState, _formData: FormData): Promise<FormState> {
  const { supabase, snapshot } = await requireSignedIn();
  if (snapshot.claims?.aal !== 'aal2') {
    redirect(snapshot.verifiedFactorCount > 0 ? ROUTES.mfaChallenge : ROUTES.mfaEnroll);
  }
  const { data, error } = await supabase.rpc('register_my_recovery_factor');
  if (error) {
    if (error.code === '42501') {
      return { status: 'error', message: 'Sign in again and complete the authenticator step, then retry.' };
    }
    return { status: 'error', message: dbMessage(error) };
  }
  const result = data as { confirmation_code?: unknown; refused?: unknown } | null;
  if (result?.refused === 'extra_factor') {
    return {
      status: 'error',
      message:
        'More than one new authenticator was set up on this account, so no code was issued. ' +
        'Tell your administrator; this attempt has been recorded.',
    };
  }
  const code = result?.confirmation_code;
  if (typeof code !== 'string') {
    return { status: 'error', message: 'The request could not be completed. Please retry.' };
  }
  return {
    status: 'success',
    message: `Your confirmation code is ${code}. Read it to your administrator by phone or in person. Never send it by email or chat.`,
  };
}
