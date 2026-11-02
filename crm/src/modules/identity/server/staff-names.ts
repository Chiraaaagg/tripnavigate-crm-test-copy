import 'server-only';
import type { StaffContext } from './session';
import { staffNameRequestIds, toStaffNameMap } from '../staff-names';

/**
 * Direction A Batch 1 B1-4: owner display names for the records on one page,
 * under the staff member's own session (the database returns a name only for
 * the owner of a Deal or Lead the viewer can read). Never throws: any failure,
 * an older database without the function, or a malformed reply gives an empty
 * map, and screens keep "Another staff member".
 */

type Staff = Pick<StaffContext, 'supabase'>;
type Rpc = { rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string } | null }> };

export async function loadRecordOwnerNames(staff: Staff, ownerIds: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const ids = staffNameRequestIds(ownerIds);
  if (ids.length === 0) return new Map();
  try {
    const client = staff.supabase as unknown as Rpc;
    const { data, error } = await client.rpc('record_staff_names', { p_user_ids: ids });
    if (error) return new Map();
    return toStaffNameMap(data) ?? new Map();
  } catch {
    return new Map();
  }
}
