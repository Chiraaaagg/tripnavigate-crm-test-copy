import 'server-only';
import { z } from 'zod';
import { asRpcClient, purchaseTaskGet } from '@/modules/fulfilment/commands';
import type { StaffContext } from '@/modules/identity/server/session';
import {
  accountsGoAheadList,
  dealCancellationSummary,
  managerCancellationList,
  ProcurementCommandError,
  purchaseQueueFlags,
  purchaseWorkspace,
  supplierGet,
  supplierList,
} from '../commands';
import type {
  AccountsGoAheadRow,
  DealCancellationSummary,
  ManagerCancellationRow,
  PurchaseQueueFlags,
  PurchaseWorkspaceView,
  SupplierDetailView,
  SupplierSummary,
} from '../contracts';
import {
  toAccountsGoAheadRow,
  toDealCancellationSummary,
  toManagerCancellationRow,
  toQueueFlags,
  toSupplierDetail,
  toSupplierSummary,
  toWorkspaceView,
} from '../dto';

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
    // Purchase build: the task comes from purchase_task_get, which carries
    // every service type (transfer and activity tasks too).
    const [record, task] = await Promise.all([purchaseWorkspace(rpc, id.data), purchaseTaskGet(rpc, id.data)]);
    if (!record || !task) return null;
    const suppliers = record.canWork ? await supplierList(rpc) : [];
    return toWorkspaceView(record, suppliers, task);
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

// ---------------------------------------------------------------------------
// Purchase build (20261130000120)
// ---------------------------------------------------------------------------

/** Accounts: hotel go-ahead requests (pending first). [] when the viewer is not Accounts. */
export async function loadAccountsGoAheadList(staff: Staff): Promise<AccountsGoAheadRow[]> {
  try {
    return (await accountsGoAheadList(asRpcClient(staff.supabase))).map(toAccountsGoAheadRow);
  } catch (error) {
    if (isRefusal(error)) return [];
    throw new Error('Could not load the hotel go-ahead requests. Please retry.');
  }
}

/** Branch Manager: trip cancellations of the Manager's branches (sent to the Manager first). */
export async function loadManagerCancellations(staff: Staff): Promise<ManagerCancellationRow[]> {
  try {
    return (await managerCancellationList(asRpcClient(staff.supabase))).map(toManagerCancellationRow);
  } catch (error) {
    if (isRefusal(error)) return [];
    throw new Error('Could not load trip cancellations. Please retry.');
  }
}

/** Deal page: the trip-cancellation state; null when the Deal is not readable. */
export async function loadDealCancellation(staff: Staff, dealId: string): Promise<DealCancellationSummary | null> {
  const id = z.uuid().safeParse(dealId);
  if (!id.success) return null;
  try {
    const record = await dealCancellationSummary(asRpcClient(staff.supabase), id.data);
    return record ? toDealCancellationSummary(record) : null;
  } catch (error) {
    if (isRefusal(error)) return null;
    throw new Error('Could not load the trip cancellation state. Please retry.');
  }
}

/** Purchase queue: go-ahead state and trip-cancelled flag per task id. {} when nothing is visible. */
export async function loadPurchaseQueueFlags(staff: Staff): Promise<Record<string, PurchaseQueueFlags>> {
  try {
    return toQueueFlags(await purchaseQueueFlags(asRpcClient(staff.supabase)));
  } catch (error) {
    if (isRefusal(error)) return {};
    throw new Error('Could not load the Purchase queue. Please retry.');
  }
}
