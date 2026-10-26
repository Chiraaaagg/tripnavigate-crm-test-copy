import 'server-only';
import type { StaffContext } from '@/modules/identity/server/session';
import { asRpcClient, myWorkCounts } from '../commands';
import type { MyWorkCounts } from '../contracts';
import { toMyWorkCounts } from '../dto';

/**
 * Home "My work" counts under the viewer's own session. Returns null on ANY
 * failure (refusal, older database, malformed reply, network): Home then
 * shows "counts unavailable" instead of zeros that would read as "nothing to
 * do". Nothing is logged or rethrown; the rest of Home still renders.
 */
export async function loadMyWorkCounts(staff: Pick<StaffContext, 'supabase'>): Promise<MyWorkCounts | null> {
  try {
    return toMyWorkCounts(await myWorkCounts(asRpcClient(staff.supabase)));
  } catch {
    return null;
  }
}
