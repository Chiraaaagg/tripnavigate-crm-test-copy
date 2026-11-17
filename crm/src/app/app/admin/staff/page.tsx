import type { Metadata } from 'next';
import { getAppConfig } from '@/lib/config';
import { administeredEntityIds } from '@/modules/access/policy';
import { loadStaffAdmin } from '@/modules/access/server/admin-queries';
import { requireStaff } from '@/modules/identity/server/session';
import { loadBitrixDirectory } from '@/modules/integration/server/bitrix-admin';
import { StaffAdminView } from '@/views/staff-views';

export const metadata: Metadata = { title: 'People and access' };

export default async function StaffAdminPage() {
  const staff = await requireStaff();
  if (administeredEntityIds(staff.access, 'staff.manage').length === 0) {
    return (
      <>
        <h2>Staff</h2>
        <p role="status">You do not have permission to administer staff.</p>
      </>
    );
  }
  const data = await loadStaffAdmin(staff);
  const bitrix = await loadBitrixAccess(staff);
  return (
    <StaffAdminView
      staff={data.staff}
      branches={data.branches}
      roles={data.roles}
      inviteDomains={getAppConfig().inviteAllowedDomains}
      security={data.security}
      verificationMethods={data.verificationMethods}
      bitrix={bitrix}
      sectionLinks={{ staff: true, access: administeredEntityIds(staff.access, 'access.grant').length > 0 }}
    />
  );
}

/** Bitrix users and active links, only for admins who manage the integration (RLS decides). */
async function loadBitrixAccess(staff: Awaited<ReturnType<typeof requireStaff>>) {
  if (administeredEntityIds(staff.access, 'integration.manage').length === 0) return null;
  const [directory, mappings] = await Promise.all([
    loadBitrixDirectory(staff, { users: true }),
    staff.supabase.from('bitrix_user_mappings').select('bitrix_user_id, staff_user_id').eq('active', true),
  ]);
  const names = new Map((directory.users ?? []).map((u) => [u.id, u.name]));
  const links: Record<string, { id: string; name: string }> = {};
  for (const m of (mappings.data ?? []) as Array<{ bitrix_user_id: number | string; staff_user_id: string }>) {
    const id = String(m.bitrix_user_id);
    links[m.staff_user_id] = { id, name: names.get(id) ?? `Bitrix user #${id}` };
  }
  return { users: directory.users, error: directory.error, links };
}
