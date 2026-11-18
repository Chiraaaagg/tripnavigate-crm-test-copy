import type { Metadata } from 'next';
import { requireStaff } from '@/modules/identity/server/session';
import { loadWriteOffMonthly } from '@/modules/write-offs/server/queries';
import { WriteOffMonthlyView } from '@/views/write-offs/monthly';
import { SmallBalancesNoAccess } from '@/views/write-offs/small-balances';

export const metadata: Metadata = { title: 'Write-offs by month' };

function monthOf(value: string | string[] | undefined): string {
  const v = Array.isArray(value) ? value[0] : value;
  if (v && /^\d{4}-\d{2}(-\d{2})?$/.test(v)) return `${v.slice(0, 7)}-01`;
  const now = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' }).format(new Date());
  return `${now.slice(0, 7)}-01`;
}

/**
 * Write-offs by month (Accounts phase 3 contract 6.6 R-B2, screen 15.6):
 * branch Managers (own branches) and Super Admins (all); everyone else gets
 * null from the database.
 */
export default async function WriteOffMonthlyRoute({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff();
  const month = monthOf((await searchParams).month);
  const data = await loadWriteOffMonthly(staff, month).catch(() => 'error' as const);
  if (data === null) return <SmallBalancesNoAccess />;
  const canSeeList = staff.memberships.some((m) => m.roleCode === 'accounts' || m.roleCode === 'manager');
  return <WriteOffMonthlyView data={data} canSeeList={canSeeList} />;
}
