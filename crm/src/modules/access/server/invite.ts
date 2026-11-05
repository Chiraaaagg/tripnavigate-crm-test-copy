import 'server-only';
import { z } from 'zod';
import { getAppConfig, isInviteRecipientAllowed } from '@/lib/config';
import type { FormState } from '@/lib/forms';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import type { StaffContext } from '@/modules/identity/server/session';

/** Invite core shared by staff-actions.ts and the Bitrix "Add staff" action (not a server action itself). */

export const DENIED = 'You do not have permission to do that for this staff member or branch.';

export function dbErrorMessage(error: { code?: string; message?: string }): string {
  switch (error.code) {
    case '42501':
      return DENIED;
    case '23505':
      return error.message?.includes('already exists')
        ? 'A staff member with this email already exists.'
        : 'An open invitation for this email already exists with different access.';
    case '23503':
      return 'The branch or entity selected does not match.';
    case '22023':
    case '54000':
      return error.message ?? 'The request is not valid.';
    case '23514':
      // Check violations carry table, constraint or id names; never show them.
      return 'The request is not valid for this staff member, branch or role.';
    default:
      return 'The request could not be completed. Please retry.';
  }
}


export function providerErrorCode(error: unknown): string {
  const e = error as { code?: unknown; name?: unknown; status?: unknown } | null;
  const raw = (typeof e?.code === 'string' && e.code) || (typeof e?.name === 'string' && e.name) || 'provider_error';
  return `${raw}${typeof e?.status === 'number' ? `:${e.status}` : ''}`.slice(0, 100);
}

const InviteInput = z.object({
  email: z.email().max(254).transform((v) => v.toLowerCase()),
  displayName: z.string().trim().min(1).max(120),
  branchId: z.uuid(),
  roleCode: z.enum(['sales', 'accounts', 'purchase', 'flight', 'visa', 'manager', 'super_admin']),
});

/** The Auth user id for `email`, null when there is none, undefined when the lookup itself failed. */
async function findAuthUserIdByEmail(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  email: string,
): Promise<string | null | undefined> {
  // Staff population is ~50, so a bounded scan is acceptable for this edge case.
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 });
    if (error) return undefined;
    const match = data.users.find((u) => u.email?.toLowerCase() === email);
    if (match) return match.id;
    if (data.users.length < 100) return null;
  }
  return null;
}

export type InviteInputData = z.infer<typeof InviteInput>;

/**
 * Invites one staff member (create_staff_invitation under the actor's own
 * session -> delivery row -> Auth invite -> link_invitation_user). Shared by
 * the Staff page invite form and "Add staff from Bitrix". Returns the form
 * state and, on success, the staff user id.
 */
export async function inviteStaff(
  staff: StaffContext,
  input: Record<string, unknown>,
): Promise<{ state: FormState; userId: string | null }> {
  const parsed = InviteInput.safeParse(input);
  if (!parsed.success) {
    return { state: { status: 'error', message: 'Enter a valid email, name, branch and role.' }, userId: null };
  }
  const config = getAppConfig();
  if (!isInviteRecipientAllowed(config, parsed.data.email)) {
    return {
      state: {
        status: 'error',
        message:
          config.appEnv === 'production'
            ? 'Invitations can only be sent to the company staff email domain.'
            : `This ${config.appEnv} environment can only invite: ${config.inviteAllowedDomains.join(', ')}.`,
      },
      userId: null,
    };
  }

  const { data: invitationId, error } = await staff.supabase.rpc('create_staff_invitation', {
    p_email: parsed.data.email,
    p_display_name: parsed.data.displayName,
    p_branch_id: parsed.data.branchId,
    p_role_code: parsed.data.roleCode,
  });
  if (error || !invitationId) {
    return { state: { status: 'error', message: dbErrorMessage(error ?? {}) }, userId: null };
  }

  // Delivery row first (R03): pending, rate limited per invitation, under the
  // administrator's own session. Only then the provider call.
  const requested = await staff.supabase.rpc('request_invitation_email', { p_invitation_id: invitationId });
  if (requested.error) {
    return { state: { status: 'error', message: dbErrorMessage(requested.error) }, userId: null };
  }
  const deliveryId = (requested.data as { deliveryId?: unknown } | null)?.deliveryId;
  if (typeof deliveryId !== 'string') {
    return { state: { status: 'error', message: 'The request could not be completed. Please retry.' }, userId: null };
  }

  const admin = createSupabaseAdminClient();
  let inviteError: unknown = null;
  // A thrown call (for example a lost response) may still have sent the email:
  // its outcome is unknown, not a refusal (audit U03).
  let unknownOutcome = false;
  let userId: string | null | undefined = null;
  try {
    const invite = await admin.auth.admin.inviteUserByEmail(parsed.data.email, {
      redirectTo: `${config.siteUrl}/auth/confirm`,
      data: { invitation_id: invitationId },
    });
    inviteError = invite.error;
    userId = invite.data.user?.id ?? null;
  } catch (e) {
    inviteError = e ?? 'provider_error';
    unknownOutcome = true;
  }
  const handed = !inviteError && userId !== null;
  let recordFailed = false;
  try {
    const recorded = await admin.rpc('record_staff_email_result', {
      p_delivery_id: deliveryId,
      p_ok: handed,
      p_error_code: handed ? null : unknownOutcome ? 'provider_outcome_unknown' : providerErrorCode(inviteError),
    });
    recordFailed = Boolean(recorded.error);
  } catch {
    recordFailed = true;
  }
  const recordNote = recordFailed ? ' The delivery status could not be recorded, so the Staff page may still show it as pending.' : '';

  let notice =
    'Invitation handed to the mail service. Delivery is not confirmed. The person must set a password and enrol an authenticator app.' + recordNote;
  if (!handed) {
    // A previous attempt (or this one, if its response was lost) may have created the Auth user.
    userId = await findAuthUserIdByEmail(admin, parsed.data.email);
    if (userId === undefined) {
      return {
        state: {
          status: 'error',
          message: 'Invitation recorded, but we could not confirm whether the mail service accepted the email or whether a sign-in account exists. Check the Staff page before resending.' + recordNote,
        },
        userId: null,
      };
    }
    if (!userId) {
      return {
        state: {
          status: 'error',
          message: unknownOutcome
            ? 'Invitation recorded, but we could not confirm whether the mail service accepted the email. Check the Staff page before resending.' + recordNote
            : 'Invitation recorded, but the mail service did not accept the email. If this repeats, ask the system administrator to check the email (SMTP) settings, then resend.' + recordNote,
        },
        userId: null,
      };
    }
    notice = unknownOutcome
      ? 'The sign-in account exists and access has been linked. We could not confirm whether an email was sent; use "Resend invitation" if the person did not receive it.' + recordNote
      : 'The sign-in account already existed; access has been linked. No new email was sent; use "Resend invitation" if needed.' + recordNote;
  }
  const link = await admin.rpc('link_invitation_user', { p_invitation_id: invitationId, p_user_id: userId });
  if (link.error) {
    return {
      state: {
        status: 'error',
        message: handed
          ? 'Invitation email handed to the mail service, but access could not be linked. Please retry.'
          : 'Access could not be linked. Please retry.',
      },
      userId: null,
    };
  }
  return { state: { status: 'success', message: notice }, userId };
}

