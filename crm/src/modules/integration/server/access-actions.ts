'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { type FormState, fieldValue } from '@/lib/forms';
import { inviteStaff } from '@/modules/access/server/invite';
import { requireStaff } from '@/modules/identity/server/session';
import { adminBitrixClient, bitrixErrorText, getBitrixUser } from './bitrix-admin';

/**
 * Bitrix access administration (Staff page and Bitrix sync page). Pattern as in
 * staff-actions.ts: requireStaff() -> validate -> database command under the
 * admin's OWN session (it re-checks aal2, integration.manage / staff.manage,
 * writes the audit event and recomputes deal ownership in one transaction).
 * Nothing here uses the privileged client.
 */

const STAFF_PATH = '/app/admin/staff';
const SYNC_PATH = '/app/admin/integration';

function errorText(error: { code?: string; message?: string }): string {
  switch (error.code) {
    case '42501':
      return 'You do not have permission to manage Bitrix access for this staff member.';
    case '23505':
      return error.message?.includes('another staff member')
        ? 'This Bitrix user is already linked to another staff member. Unlink them first.'
        : 'This staff member is already linked to another Bitrix user. Unlink first.';
    case '55000':
      return 'Bitrix intake is not configured yet.';
    case '22023':
      // B1.1d: the settings save keeps the Won-only entry stage's pipeline ticked.
      if (error.message === 'entry_stage_pipeline_required') {
        return 'Won-only intake takes new Deals from a stage in a pipeline you unticked. Keep that pipeline ticked, or switch Won-only intake off first. Nothing was saved.';
      }
      return error.message ? `${error.message.charAt(0).toUpperCase()}${error.message.slice(1)}.` : 'The request is not valid.';
    default:
      return 'The change could not be saved. Please retry.';
  }
}

const dealsText = (n: number) => `${n} deal${n === 1 ? '' : 's'}`;

const LinkInput = z.object({ userId: z.uuid(), bitrixUserId: z.string().regex(/^[1-9][0-9]{0,17}$/) });

/** Grant: link a staff member to a Bitrix user; their Bitrix deals become theirs at once. */
export async function linkBitrixUserAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const parsed = LinkInput.safeParse({ userId: fieldValue(formData, 'userId'), bitrixUserId: fieldValue(formData, 'bitrixUserId') });
  if (!parsed.success) return { status: 'error', message: 'Choose a Bitrix user from the list.' };
  const { data, error } = await staff.supabase.rpc('integration_link_bitrix_user', {
    p_staff_user_id: parsed.data.userId,
    p_bitrix_user_id: Number(parsed.data.bitrixUserId),
  });
  if (error) return { status: 'error', message: errorText(error) };
  revalidatePath(STAFF_PATH);
  revalidatePath(SYNC_PATH);
  const n = (data as { dealsChanged?: number } | null)?.dealsChanged ?? 0;
  return {
    status: 'success',
    message: `Linked. ${dealsText(n)} now belong to this person. Future Bitrix deals of this user are assigned automatically${
      n === 0 ? ' (deals appear once the person has finished signing up, if they have not yet)' : ''
    }.`,
  };
}

/** Revoke: unlink; that Bitrix user's deals go back to "waiting for owner". */
export async function unlinkBitrixUserAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const parsed = z.uuid().safeParse(fieldValue(formData, 'userId'));
  if (!parsed.success) return { status: 'error', message: 'Select a valid staff member.' };
  const { data, error } = await staff.supabase.rpc('integration_unlink_bitrix_user', { p_staff_user_id: parsed.data });
  if (error) return { status: 'error', message: errorText(error) };
  revalidatePath(STAFF_PATH);
  revalidatePath(SYNC_PATH);
  const r = data as { bitrixUserId?: number | null; dealsChanged?: number } | null;
  if (!r?.bitrixUserId) return { status: 'success', message: 'This person was not linked to a Bitrix user. Nothing changed.' };
  return {
    status: 'success',
    message: `Unlinked. ${dealsText(r.dealsChanged ?? 0)} returned to "waiting for owner"; this person no longer sees them.`,
  };
}

const AddInput = z.object({
  bitrixUserId: z.string().regex(/^[1-9][0-9]{0,17}$/),
  branchId: z.uuid(),
  roleCode: z.enum(['sales', 'accounts', 'purchase', 'flight', 'visa', 'manager', 'super_admin']),
});

/** Invite a Bitrix user as staff (name + email read from Bitrix), then link them. */
export async function addStaffFromBitrixAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const staff = await requireStaff();
  const parsed = AddInput.safeParse({
    bitrixUserId: fieldValue(formData, 'bitrixUserId'),
    branchId: fieldValue(formData, 'branchId'),
    roleCode: fieldValue(formData, 'roleCode'),
  });
  if (!parsed.success) return { status: 'error', message: 'Choose a Bitrix user, a branch and a role.' };

  const got = await adminBitrixClient(staff);
  if ('error' in got) return { status: 'error', message: got.error };
  let person;
  try {
    person = await getBitrixUser(got.client, parsed.data.bitrixUserId);
  } catch (error) {
    return { status: 'error', message: bitrixErrorText(error) };
  }
  if (!person) return { status: 'error', message: 'That Bitrix user was not found.' };
  if (!person.email) return { status: 'error', message: `${person.name} has no email address in Bitrix; add one there first.` };

  const invited = await inviteStaff(staff, {
    email: person.email,
    displayName: person.name,
    branchId: parsed.data.branchId,
    roleCode: parsed.data.roleCode,
  });
  if (!invited.userId) return invited.state;

  const { error } = await staff.supabase.rpc('integration_link_bitrix_user', {
    p_staff_user_id: invited.userId,
    p_bitrix_user_id: Number(person.id),
  });
  revalidatePath(STAFF_PATH);
  revalidatePath(SYNC_PATH);
  if (error) {
    return { status: 'error', message: `Invitation sent to ${person.email}, but linking failed: ${errorText(error)}` };
  }
  return {
    status: 'success',
    message: `Invitation sent to ${person.email} and linked to Bitrix user ${person.name}. Their deals appear for them once they finish signing up (password + authenticator).`,
  };
}

/**
 * Batch 4 (M1, DA-259): the one-step save is gone. Sync settings are saved
 * only through Settings · Bitrix connection: preview (exact counts) then apply
 * with the preview and a reason (src/modules/settings/server/actions.ts
 * previewSyncScopeAction / applySyncScopeAction). The database refuses the old
 * one-step command too (preview_required). Kept only so an older form cannot
 * reach the old command; it never saves.
 */
export async function updateSyncSettingsAction(): Promise<FormState> {
  await requireStaff();
  return { status: 'error', message: 'Not saved: review the change first. Nothing was changed.' };
}
