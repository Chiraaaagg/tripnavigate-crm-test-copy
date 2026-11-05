'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getAppConfig, isInviteRecipientAllowed } from '@/lib/config';
import { type FormState, fieldValue } from '@/lib/forms';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { requireStaff } from '@/modules/identity/server/session';
import { dbErrorMessage, inviteStaff, providerErrorCode } from './invite';

/**
 * Staff administration commands.
 *
 * Pattern for every command:
 *   1. requireStaff(): verified session, aal2, active staff (identity from claims).
 *   2. Validate input. Target IDs in the form are treated as requests, not as
 *      proof of authority; the actor is never read from the form.
 *   3. Call the database command under the actor's own session. It re-checks
 *      MFA, permission and scope, and writes the audit event atomically.
 *   4. Only then use the privileged Auth admin API, for the Auth-side effect.
 *
 * MFA reset lives in '@/modules/identity/server/recovery-actions'
 * (beginMfaRecoveryAction); resetStaffMfaAction was removed in Phase 1.5.
 */

export async function inviteStaffAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const { state } = await inviteStaff(staff, {
    email: fieldValue(formData, 'email'),
    displayName: fieldValue(formData, 'displayName'),
    branchId: fieldValue(formData, 'branchId'),
    roleCode: fieldValue(formData, 'roleCode'),
  });
  if (state.status === 'success') revalidatePath('/app/admin/staff');
  return state;
}

const ReasonInput = z.object({
  userId: z.uuid(),
  reason: z.string().trim().min(10, 'Give a reason of at least 10 characters.').max(500),
});

export async function deactivateStaffAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const parsed = ReasonInput.safeParse({ userId: fieldValue(formData, 'userId'), reason: fieldValue(formData, 'reason') });
  if (!parsed.success) return { status: 'error', message: parsed.error.issues[0]?.message };

  const { error } = await staff.supabase.rpc('deactivate_staff_member', {
    p_user_id: parsed.data.userId,
    p_reason: parsed.data.reason,
  });
  if (error) return { status: 'error', message: dbErrorMessage(error) };

  // CRM data access already stopped (RLS checks status on every request). Also
  // block new sign-ins and token refresh at the Auth layer.
  const admin = createSupabaseAdminClient();
  const ban = await admin.auth.admin.updateUserById(parsed.data.userId, { ban_duration: '876000h' });
  revalidatePath('/app/admin/staff');
  if (ban.error) {
    return {
      status: 'error',
      message: 'CRM access was removed, but blocking sign-in failed. Retry, or block the user in Supabase Auth.',
    };
  }
  return { status: 'success', message: 'Staff member deactivated and signed-in access blocked.' };
}

const EmailInput = z.object({
  userId: z.uuid(),
  kind: z.enum(['invitation_resend', 'password_reset']),
});


/**
 * Admin: resend an invitation link or send a password reset link. Both use
 * the provider's recovery email (inviteUserByEmail refuses existing users).
 * The database creates the delivery row and enforces the PROPOSED rate limit
 * first; the result is recorded by the service role. Wording is "handed to the
 * mail service", never "delivered".
 */
export async function sendStaffEmailAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const parsed = EmailInput.safeParse({ userId: fieldValue(formData, 'userId'), kind: fieldValue(formData, 'kind') });
  if (!parsed.success) return { status: 'error', message: 'Choose a staff member and an email type.' };

  const { data, error } = await staff.supabase.rpc('request_staff_email', {
    p_user_id: parsed.data.userId,
    p_kind: parsed.data.kind,
  });
  if (error) return { status: 'error', message: dbErrorMessage(error) };
  const deliveryId = (data as { deliveryId?: unknown } | null)?.deliveryId;
  if (typeof deliveryId !== 'string') {
    return { status: 'error', message: 'The request could not be completed. Please retry.' };
  }

  // The address comes from the database (RLS: administrators of that person only).
  const profile = await staff.supabase
    .from('staff_profiles')
    .select('work_email')
    .eq('user_id', parsed.data.userId)
    .maybeSingle();
  const email = profile.data?.work_email as string | undefined;
  const config = getAppConfig();
  const admin = createSupabaseAdminClient();

  let failure: string | null = null;
  if (profile.error || !email) {
    failure = 'recipient_unavailable';
  } else if (!isInviteRecipientAllowed(config, email)) {
    failure = 'recipient_not_allowed';
  } else {
    try {
      const sent = await admin.auth.resetPasswordForEmail(email, { redirectTo: `${config.siteUrl}/auth/confirm` });
      if (sent.error) failure = providerErrorCode(sent.error);
    } catch (e) {
      failure = providerErrorCode(e);
    }
  }
  const recorded = await admin.rpc('record_staff_email_result', {
    p_delivery_id: deliveryId,
    p_ok: failure === null,
    p_error_code: failure,
  });
  revalidatePath('/app/admin/staff');

  const what = parsed.data.kind === 'password_reset' ? 'Password reset link' : 'Invitation link';
  if (failure === 'recipient_not_allowed') {
    return { status: 'error', message: `This ${config.appEnv} environment cannot email that address. Nothing was sent.` };
  }
  if (failure !== null) {
    return { status: 'error', message: `The mail service did not accept the email (${failure}). Try again in a minute.` };
  }
  return {
    status: 'success',
    message: recorded.error
      ? `${what} handed to the mail service, but the delivery record could not be updated.`
      : `${what} handed to the mail service. Delivery is not confirmed; ask the person to check their inbox.`,
  };
}

const GrantInput = z.object({
  userId: z.uuid(),
  permission: z.enum(['deal.read', 'deal.read_commercial']),
  legalEntityId: z.uuid(),
  branchId: z.uuid().optional(),
  reason: z.string().trim().min(10, 'Give a reason of at least 10 characters.').max(500),
  expiresAt: z.iso.date().optional(),
});

export async function grantScopeAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const parsed = GrantInput.safeParse({
    userId: fieldValue(formData, 'userId'),
    permission: fieldValue(formData, 'permission'),
    legalEntityId: fieldValue(formData, 'legalEntityId'),
    branchId: fieldValue(formData, 'branchId') || undefined,
    reason: fieldValue(formData, 'reason'),
    expiresAt: fieldValue(formData, 'expiresAt') || undefined,
  });
  if (!parsed.success) return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form.' };

  const { error } = await staff.supabase.rpc('grant_access_scope', {
    p_user_id: parsed.data.userId,
    p_permission: parsed.data.permission,
    p_legal_entity_id: parsed.data.legalEntityId,
    p_branch_id: parsed.data.branchId ?? null,
    p_reason: parsed.data.reason,
    p_expires_at: parsed.data.expiresAt ? `${parsed.data.expiresAt}T23:59:59+05:30` : null,
  });
  if (error) return { status: 'error', message: dbErrorMessage(error) };
  revalidatePath('/app/admin/access');
  return { status: 'success', message: 'Access grant recorded and audited.' };
}

export async function revokeGrantAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const parsed = z
    .object({ grantId: z.uuid(), reason: z.string().trim().min(10, 'Give a reason of at least 10 characters.').max(500) })
    .safeParse({ grantId: fieldValue(formData, 'grantId'), reason: fieldValue(formData, 'reason') });
  if (!parsed.success) return { status: 'error', message: parsed.error.issues[0]?.message };
  const { error } = await staff.supabase.rpc('revoke_access_grant', {
    p_grant_id: parsed.data.grantId,
    p_reason: parsed.data.reason,
  });
  if (error) return { status: 'error', message: dbErrorMessage(error) };
  revalidatePath('/app/admin/access');
  return { status: 'success', message: 'Access grant revoked.' };
}
