import type { ReactNode } from 'react';
import { financeEnabledEntityIds } from '@/modules/finance/server/queries';
import { requireStaff } from '@/modules/identity/server/session';
import { StaffShell } from '@/views/StaffShell';
import { shellPermissions } from './shell-permissions';

// Every staff page depends on the signed-in session; never prerender or cache.
export const dynamic = 'force-dynamic';

export default async function StaffLayout({ children }: { children: ReactNode }) {
  const staff = await requireStaff();
  const primary = staff.memberships.find((m) => m.isHeadOffice) ?? staff.memberships[0];
  // Navigation convenience only; every finance RPC re-checks access (phase-5a-contract.md §4).
  const financeEntities = await financeEnabledEntityIds(staff);
  return (
    <StaffShell
      viewer={{
        displayName: staff.displayName,
        primaryRole: primary?.roleName ?? '',
        primaryBranch: primary?.branchName ?? '',
        // Account panel (FP-004): the person's own memberships, already loaded by requireStaff.
        memberships: staff.memberships.map((m) => ({ roleName: m.roleName, branchName: m.branchName, isHeadOffice: m.isHeadOffice })),
        ...shellPermissions(staff, financeEntities),
      }}
    >
      {children}
    </StaffShell>
  );
}
