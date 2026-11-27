import 'server-only';
import { z } from 'zod';
import { asRpcClient } from '@/modules/fulfilment/commands';
import type { StaffContext } from '@/modules/identity/server/session';
import { RefundCommandError, dealRefunds, refundRequestsList, supplierRefundsDue } from '../commands';
import type { DealRefundsView, RefundListFilter, RefundListPage, SupplierRefundsDueFilter, SupplierRefundsDuePage } from '../contracts';

/**
 * Refund reads under the staff member's own session. null = the database
 * says this person may not read it (the page shows "not available"); a
 * refused filter (invalid_input) is { invalid: field } so the page keeps the
 * typed filter. An unexplained failure throws (never a fabricated empty state).
 */

type Staff = Pick<StaffContext, 'supabase'>;

export type RefundListResult<T> = { ok: true; data: T | null } | { ok: false; invalid: string | null };

function isRefusal(error: unknown): boolean {
  return error instanceof RefundCommandError
    && (error.code === 'not_authorized' || error.code === 'not_found' || error.code === 'not_configured' || error.code === 'environment_unset');
}
function invalidField(error: unknown): string | null | undefined {
  if (error instanceof RefundCommandError && error.code === 'invalid_input') return error.hint ?? null;
  return undefined;
}

export async function loadDealRefunds(staff: Staff, dealId: string): Promise<DealRefundsView | null> {
  const id = z.uuid().safeParse(dealId);
  if (!id.success) return null;
  try {
    return await dealRefunds(asRpcClient(staff.supabase), id.data);
  } catch (error) {
    if (isRefusal(error)) return null;
    throw new Error('Could not load refunds. Please retry.');
  }
}

export async function loadRefundRequests(staff: Staff, filter: RefundListFilter, after: string | null,
  limit = 50): Promise<RefundListResult<RefundListPage>> {
  try {
    return { ok: true, data: await refundRequestsList(asRpcClient(staff.supabase), filter, after, limit) };
  } catch (error) {
    const field = invalidField(error);
    if (field !== undefined) return { ok: false, invalid: field };
    if (isRefusal(error)) return { ok: true, data: null };
    throw new Error('Could not load refunds. Please retry.');
  }
}

export async function loadSupplierRefundsDue(staff: Staff, filter: SupplierRefundsDueFilter, after: string | null,
  limit = 50): Promise<RefundListResult<SupplierRefundsDuePage>> {
  try {
    return { ok: true, data: await supplierRefundsDue(asRpcClient(staff.supabase), filter, after, limit) };
  } catch (error) {
    const field = invalidField(error);
    if (field !== undefined) return { ok: false, invalid: field };
    if (isRefusal(error)) return { ok: true, data: null };
    throw new Error('Could not load supplier refunds. Please retry.');
  }
}
