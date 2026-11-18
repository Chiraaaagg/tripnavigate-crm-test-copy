import type { Metadata } from 'next';
import { administeredEntityIds } from '@/modules/access/policy';
import { loadGrantAdmin } from '@/modules/access/server/admin-queries';
import { requireStaff } from '@/modules/identity/server/session';
import { AccessGrantsView } from '@/views/staff-views';

export const metadata: Metadata = { title: 'Extra access' };

export default async function AccessGrantsPage() {
  const staff = await requireStaff();
  if (administeredEntityIds(staff.access, 'access.grant').length === 0) {
    return (
      <>
        <h2>Extra access</h2>
        <p role="status">You do not have permission to manage extra access.</p>
      </>
    );
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
