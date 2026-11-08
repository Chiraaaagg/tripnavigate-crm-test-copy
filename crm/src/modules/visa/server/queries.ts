import 'server-only';
import { z } from 'zod';
import { asRpcClient } from '@/modules/fulfilment/commands';
import type { StaffContext } from '@/modules/identity/server/session';
import {
  VisaCommandError,
  dealVisaHistory,
  dealVisaSummary,
  isVisaFunctionMissing,
  visaHomeCounts,
  visaQueue,
  visaWorkspace,
} from '../commands';
import type { DealVisaHistoryDTO, DealVisaSummaryDTO, VisaHomeCountsDTO, VisaQueueDTO, VisaWorkspaceDTO } from '../contracts';

/**
 * Visa and Passport desk reads (contract sections 8 and 9) under the staff
 * member's own session. The database decides who reads what and answers null
 * for "not available to this person" (never a partial object); a refusal
 * maps to null, an unexplained failure throws a plain retry message (never a
 * fabricated empty state). No read here carries a selling price, customer
 * money or Deal contacts; the passport object is filled for the task
 * assignee only, by the database.
 */

type Staff = Pick<StaffContext, 'supabase'>;

function isRefusal(error: unknown): boolean {
  return error instanceof VisaCommandError && (error.code === 'not_authorized' || error.code === 'not_found');
}

/** The Visa queue (Visa people of the entity; the branch Manager read-only); null = not a reader. */
export async function loadVisaQueue(staff: Staff): Promise<VisaQueueDTO | null> {
  try {
    return await visaQueue(asRpcClient(staff.supabase));
  } catch (error) {
    if (isRefusal(error) || isVisaFunctionMissing(error)) return null;
    throw new Error('Could not load the Visa and passport tasks. Please retry.');
  }
}

/** One task page; null = not found, not visible or a malformed id (indistinguishable). */
export async function loadVisaWorkspace(staff: Staff, taskId: string): Promise<VisaWorkspaceDTO | null> {
  const id = z.uuid().safeParse(taskId);
  if (!id.success) return null;
  try {
    return await visaWorkspace(asRpcClient(staff.supabase), id.data);
  } catch (error) {
    if (isRefusal(error) || isVisaFunctionMissing(error)) return null;
    throw new Error('Could not load this visa task. Please retry.');
  }
}

/**
 * Deal page visa card and result notices (Sales owner, branch Manager, other
 * Sales readers; notices only for the Sales owner or, without one, the
 * Manager). null for Purchase, Flight, Visa-only and Accounts; 'error' when
 * the read failed (the card shows a could-not-load line).
 */
export async function loadDealVisaSummary(staff: Staff, dealId: string): Promise<DealVisaSummaryDTO | null | 'error'> {
  const id = z.uuid().safeParse(dealId);
  if (!id.success) return null;
  try {
    return await dealVisaSummary(asRpcClient(staff.supabase), id.data);
  } catch (error) {
    if (isRefusal(error) || isVisaFunctionMissing(error)) return null;
    return 'error';
  }
}

/** Deal History "Visa and passport" group (Sales owner, branch Manager); null when not readable. */
export async function loadDealVisaHistory(staff: Staff, dealId: string): Promise<DealVisaHistoryDTO | null | 'error'> {
  const id = z.uuid().safeParse(dealId);
  if (!id.success) return null;
  try {
    return await dealVisaHistory(asRpcClient(staff.supabase), id.data);
  } catch (error) {
    if (isRefusal(error) || isVisaFunctionMissing(error)) return null;
    return 'error';
  }
}

/** Home rows of the Visa build; null when the read is missing or refused (Home leaves them out). */
export async function loadVisaHomeCounts(staff: Staff): Promise<VisaHomeCountsDTO | null> {
  try {
    return await visaHomeCounts(asRpcClient(staff.supabase));
  } catch {
    return null;
  }
}
