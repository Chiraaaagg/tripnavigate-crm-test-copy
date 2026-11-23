import 'server-only';
import { asRpcClient } from '@/modules/fulfilment/commands';
import type { StaffContext } from '@/modules/identity/server/session';
import { readSmallBalances, readWriteOffMonthly } from '../commands';
import type { SmallBalancesFilter, SmallBalancesPage, WriteOffMonthly } from '../dto';

/**
 * Write-off reads for pages (contract 6.6), under the staff member's OWN
 * session. The database fences every read (R-B1: Accounts of the entity and
 * branch Managers; R-B2: branch Managers and Super Admins) and returns null
 * for everyone else; Purchase, Flight and Visa never read them.
 */

export function loadSmallBalances(staff: StaffContext, filter: SmallBalancesFilter, after: string | null, limit = 50): Promise<SmallBalancesPage | null> {
  return readSmallBalances(asRpcClient(staff.supabase), filter, after, limit);
}

/** month: any "YYYY-MM-DD" date of the month. */
export function loadWriteOffMonthly(staff: StaffContext, month: string): Promise<WriteOffMonthly | null> {
  return readWriteOffMonthly(asRpcClient(staff.supabase), month);
}
