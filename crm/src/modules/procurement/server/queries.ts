import 'server-only';
import { z } from 'zod';
import { asRpcClient } from '@/modules/fulfilment/commands';
import type { StaffContext } from '@/modules/identity/server/session';
import { ProcurementCommandError, purchaseWorkspace, supplierGet, supplierList } from '../commands';
import type { PurchaseWorkspaceView, SupplierDetailView, SupplierSummary } from '../contracts';
import { toSupplierDetail, toSupplierSummary, toWorkspaceView } from '../dto';

/**
 * Phase 4 reads, under the staff member's own session. "Not visible" and
 * "does not exist" both return null; an unexplained failure throws (never a
 * fabricated empty state).
 */

type Staff = Pick<StaffContext, 'supabase'>;

function isRefusal(error: unknown): boolean {
  return error instanceof ProcurementCommandError && (error.code === 'not_authorized' || error.code === 'not_found');
}

/** Purchase-role entities of the viewer (where a supplier may be created). */
export function purchaseEntities(staff: Pick<StaffContext, 'memberships'>): Array<{ id: string; name: string }> {
  const seen = new Map<string, string>();
  for (const m of staff.memberships) if (m.roleCode === 'purchase') seen.set(m.legalEntityId, m.legalEntityName);
  return [...seen].map(([id, name]) => ({ id, name }));
}

export async function loadPurchaseWorkspace(staff: Staff, taskId: string): Promise<PurchaseWorkspaceView | null> {
  const id = z.uuid().safeParse(taskId);
  if (!id.success) return null;
  const rpc = asRpcClient(staff.supabase);
  try {
    const record = await purchaseWorkspace(rpc, id.data);
    if (!record) return null;
    const suppliers = record.canWork ? await supplierList(rpc) : [];
    return toWorkspaceView(record, suppliers);
  } catch (error) {
    if (isRefusal(error)) return null;
    throw new Error('Could not load this Purchase task. Please retry.');
  }
}

export async function loadSuppliers(staff: Staff): Promise<SupplierSummary[]> {
  try {
    return (await supplierList(asRpcClient(staff.supabase))).map(toSupplierSummary);
  } catch (error) {
    if (isRefusal(error)) return [];
    throw new Error('Could not load suppliers. Please retry.');
  }
}

export async function loadSupplier(staff: Staff, supplierId: string): Promise<SupplierDetailView | null> {
  const id = z.uuid().safeParse(supplierId);
  if (!id.success) return null;
  try {
    const record = await supplierGet(asRpcClient(staff.supabase), id.data);
    return record ? toSupplierDetail(record) : null;
  } catch (error) {
    if (isRefusal(error)) return null;
    throw new Error('Could not load this supplier. Please retry.');
  }
}
