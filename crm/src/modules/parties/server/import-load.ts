import 'server-only';
import type { StaffContext } from '@/modules/identity/server/session';
import { asRpcClient } from '@/modules/fulfilment/commands';
import type { ImportBatchRow, ImportBranchChoice, ImportStatus } from '@/views/booking-form/vn-types';
import { IMPORT_ROLE, importEntity } from '../import-access';
import type { ImportKind } from '../import-mapping';
import { listImports } from './imports-db';

/**
 * Settings · Imports page read: whether the viewer may import this list and
 * the latest batches (under the viewer's own session; a refused or failed
 * read is null, shown as "could not be read").
 */

type Staff = Pick<StaffContext, 'supabase' | 'access'>;

export function importStatusOf(status: string): ImportStatus {
  if (status === 'applied') return 'applied';
  if (status === 'validated' || status === 'staged') return 'validated';
  return 'expired';
}

/**
 * Echo-A M1: the branches a customer import may go to (the importer's company, read under their
 * own session) and the default: the importer's own branch when they have exactly one there;
 * else nothing pre-selected. "Whole company" is offered by the screen as an explicit choice.
 */
async function branchChoice(staff: Staff, entityId: string): Promise<ImportBranchChoice | null> {
  const own = [...new Set(staff.access.memberships.filter((m) => m.legalEntityId === entityId && m.roleCode === IMPORT_ROLE.customer).map((m) => m.branchId))];
  const { data, error } = await staff.supabase.from('branches').select('id, name').eq('legal_entity_id', entityId).order('name');
  if (error || !data) return null;
  const options = data.map((b) => ({ branchId: b.id as string, name: b.name as string }));
  const only = own.length === 1 ? own[0]! : null;
  return { options, defaultBranchId: only && options.some((o) => o.branchId === only) ? only : null };
}

export async function loadImportPage(staff: Staff, kind: ImportKind): Promise<{ allowed: boolean; history: ImportBatchRow[] | null; branchChoice: ImportBranchChoice | null }> {
  const entity = importEntity(staff.access, kind);
  if (!entity.ok) return { allowed: false, history: [], branchChoice: null };
  // A failed branch read leaves the choice out; the action then refuses a customer import without a branch.
  const choice = kind === 'customer' ? await branchChoice(staff, entity.entityId).catch(() => null) : null;
  try {
    const list = await listImports(asRpcClient(staff.supabase), { kind, limit: 20 });
    return {
      allowed: true,
      branchChoice: choice,
      history: list.items.map((b) => ({
        batchId: b.batchId,
        kind: b.kind,
        fileName: b.fileName,
        status: importStatusOf(b.status),
        rows: b.rows,
        creates: b.created ?? 0,
        updates: b.updated ?? 0,
        invalid: b.invalid ?? 0,
        byName: b.uploadedByName ?? null,
        at: b.appliedAt ?? b.createdAt,
      })),
    };
  } catch {
    return { allowed: true, history: null, branchChoice: choice };
  }
}
