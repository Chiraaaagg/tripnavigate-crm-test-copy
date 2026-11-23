import type { Metadata } from 'next';
import { administeredEntityIds } from '@/modules/access/policy';
import { loadGrantAdmin } from '@/modules/access/server/admin-queries';
import { requireStaff } from '@/modules/identity/server/session';
import { AccessGrantsView, PeopleNoPermissionView } from '@/views/settings/people-views';

export const metadata: Metadata = { title: 'Extra access' };

/** Settings · People and access › Extra access (R1): the list first, "Give extra access" in a drawer, Revoke in a dialog. */
export default async function AccessGrantsPage() {
  const staff = await requireStaff();
  if (administeredEntityIds(staff.access, 'access.grant').length === 0) {
    return <PeopleNoPermissionView section="access" />;
  }
  const data = await loadGrantAdmin(staff);
  return (
    <AccessGrantsView
      grants={data.grants}
      staff={data.staff}
      entities={data.entities}
      branches={data.branches}
      sectionLinks={{ staff: administeredEntityIds(staff.access, 'staff.manage').length > 0, access: true }}
    />
  );
}
