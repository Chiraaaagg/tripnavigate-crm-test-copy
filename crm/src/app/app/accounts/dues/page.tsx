import type { Metadata } from 'next';
import { loadDues, loadFilterOptions } from '@/modules/accounts-desk/server/queries';
import { requireStaff } from '@/modules/identity/server/session';
import { parseDuesFilter, readCursor } from '@/views/accounts-desk/address';
import { DuesNoAccess, DuesPageView } from '@/views/accounts-desk/dues';
import { branchChoices, deskViewerOf } from '../records/desk-glue';

export const metadata: Metadata = { title: 'Dues' };

/**
 * Accounts › Dues (contract 8.3, 11.2). accounts_dues decides who reads:
 * Accounts (company), a branch Manager (own branches, view only) and Sales
 * (own Deals); everyone else gets null. Filters live in the address.
 */
export default async function DuesRoute({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requireStaff();
  const sp = await searchParams;
  const filter = parseDuesFilter(sp);
  const after = readCursor(sp);
  const [res, options] = await Promise.all([loadDues(staff, filter, after), loadFilterOptions(staff).catch(() => null)]);
  if (res.ok && res.data === null) return <DuesNoAccess />;
  const page = res.ok ? res.data! : null;
  const mode = page?.scope.mode ?? 'sales';
  const viewer = mode === 'sales' ? { kind: 'sales' as const } : deskViewerOf(staff, mode);
  const branches = mode === 'sales' ? [] : options ? options.branches.map((b) => ({ id: b.branchId, name: b.name })) : branchChoices(staff, mode === 'accounts' ? 'accounts' : 'manager');
  const owners = mode === 'sales' || !options ? [] : options.owners.map((o) => ({ id: o.userId, name: o.name }));
  return <DuesPageView viewer={viewer} filter={filter} page={page ?? 'error'} branches={branches} owners={owners} after={after} />;
}
