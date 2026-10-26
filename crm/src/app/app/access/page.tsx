import type { Metadata } from 'next';
import { loadMyGrants } from '@/modules/access/server/admin-queries';
import { requireStaff } from '@/modules/identity/server/session';
import { MyAccessView } from '@/views/staff-views';

export const metadata: Metadata = { title: 'My access' };

export default async function MyAccessPage() {
  const staff = await requireStaff();
  return <MyAccessView memberships={staff.memberships} grants={await loadMyGrants(staff)} />;
}
