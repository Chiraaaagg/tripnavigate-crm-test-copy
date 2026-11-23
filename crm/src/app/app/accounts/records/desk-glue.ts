import 'server-only';
import type { StaffContext } from '@/modules/identity/server/session';
import type { RecordRow } from '@/views/accounts-desk/types';

/*
 * Page-side glue for the Accounts desk routes (Documents and money, Dues,
 * Tally): who is reading (for the scope line) and the filter choices the
 * screens can offer from data already loaded. The section tab strip's flags
 * come from ../section-viewer.ts. Display only; the database
 * decides every row (accounts_records / accounts_dues return null otherwise).
 */

export function deskViewerOf(staff: StaffContext, mode: 'accounts' | 'manager') {
  if (mode === 'accounts') {
    const entity = staff.memberships.find((m) => m.roleCode === 'accounts');
    return { kind: 'accounts' as const, entityName: entity?.legalEntityName ?? 'Your company' };
  }
  const branches = [...new Set(staff.memberships.filter((m) => m.roleCode === 'manager').map((m) => m.branchName))];
  return { kind: 'manager' as const, branchNames: branches.length ? branches : ['Your branch'] };
}

/** Branches the viewer can name in a filter (their own memberships; the database scopes the rows). */
export function branchChoices(staff: StaffContext, roleCode: 'accounts' | 'manager'): Array<{ id: string; name: string }> {
  const seen = new Map<string, string>();
  for (const m of staff.memberships) if (m.roleCode === roleCode) seen.set(m.branchId, m.branchName);
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Suppliers named on the rows shown (no supplier list read in Phase 1). */
export function supplierChoices(rows: RecordRow[], current?: string): Array<{ id: string; name: string }> {
  const seen = new Map<string, string>();
  for (const r of rows) if (r.supplierId && r.supplierName) seen.set(r.supplierId, r.supplierName);
  if (current && !seen.has(current)) seen.set(current, 'Chosen supplier');
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}
