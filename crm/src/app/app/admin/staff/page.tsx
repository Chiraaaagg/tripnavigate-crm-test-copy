import type { Metadata } from 'next';
import { getAppConfig } from '@/lib/config';
import { parseTab } from '@/lib/parse-tab';
import { administeredEntityIds } from '@/modules/access/policy';
import { loadStaffAdmin } from '@/modules/access/server/admin-queries';
import { requireStaff } from '@/modules/identity/server/session';
import { loadBitrixDirectory } from '@/modules/integration/server/bitrix-admin';
import { STAFF_PAGE_TABS, STAFF_STATUS_FILTERS } from '@/modules/settings/contracts';
import { PeopleNoPermissionView, RolesAndBranchesView, StaffAdminView } from '@/views/settings/people-views';

export const metadata: Metadata = { title: 'People and access' };

/**
 * Settings · People and access › Staff (R1, audit S9 to S11): the staff list
 * first as a queue (search by name or work e-mail, status chips; the rows the
 * page already loads, not paged on the server), a row menu for each person's
 * actions, "Invite staff" in a drawer. `?tab=roles` shows the same rows as the
 * read-only Roles and branches list (D8 deferred). Every action is the server
 * action it always was; the database decides each step.
 */
export default async function StaffAdminPage({ searchParams }: { searchParams: Promise<{ tab?: string | string[]; q?: string | string[]; status?: string | string[] }> }) {
  const staff = await requireStaff();
  if (administeredEntityIds(staff.access, 'staff.manage').length === 0) {
    return <PeopleNoPermissionView section="staff" />;
  }
  const params = await searchParams;
  const tab = parseTab(params.tab, STAFF_PAGE_TABS, 'staff');
  const sectionLinks = { staff: true, access: administeredEntityIds(staff.access, 'access.grant').length > 0 };
  const data = await loadStaffAdmin(staff);
  if (tab === 'roles') return <RolesAndBranchesView staff={data.staff} sectionLinks={sectionLinks} />;
  const q = (Array.isArray(params.q) ? params.q[0] : params.q)?.trim().slice(0, 120) ?? '';
  const status = parseTab(params.status, STAFF_STATUS_FILTERS, 'all');
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
      sectionLinks={sectionLinks}
      filter={{ q, status }}
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
