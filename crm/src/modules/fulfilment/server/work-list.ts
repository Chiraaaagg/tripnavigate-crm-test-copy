import 'server-only';
import type { StaffContext } from '@/modules/identity/server/session';
import {
  MY_WORK_LIST_DEFAULT_LIMIT,
  MY_WORK_LIST_KINDS,
  MY_WORK_LIST_MAX_LIMIT,
  toMyWorkListPage,
  type MyWorkListCursor,
  type MyWorkListKind,
  type MyWorkListPage,
} from '../work-list';

/**
 * Direction A Batch 1 B1-3: one page of a Home work list under the staff
 * member's own session.
 *   ok             the page (applies:false = hide the row; available:false =
 *                  the intake prompt is switched off)
 *   error          "Counts unavailable. Reload; nothing is affected." (never
 *                  an empty list or zero)
 *   not_installed  a database without the function: keep the R0 behaviour
 *                  (counts link to the existing pages)
 */

export type MyWorkListResult = { state: 'ok'; page: MyWorkListPage } | { state: 'error' } | { state: 'not_installed' };

const FUNCTION_MISSING = new Set(['PGRST202', '42883']);

type Staff = Pick<StaffContext, 'supabase'>;
type Rpc = { rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string } | null }> };

export async function loadMyWorkList(
  staff: Staff,
  kind: MyWorkListKind,
  options: { after?: MyWorkListCursor | null; limit?: number } = {},
): Promise<MyWorkListResult> {
  if (!(MY_WORK_LIST_KINDS as readonly string[]).includes(kind)) return { state: 'error' };
  const limit = Math.min(MY_WORK_LIST_MAX_LIMIT, Math.max(1, Math.trunc(options.limit ?? MY_WORK_LIST_DEFAULT_LIMIT)));
  try {
    const client = staff.supabase as unknown as Rpc;
    const { data, error } = await client.rpc('my_work_list', {
      p_kind: kind,
      p_after: options.after ? { since: options.after.since, dealId: options.after.dealId } : null,
      p_limit: limit,
    });
    if (error) return FUNCTION_MISSING.has(error.code ?? '') ? { state: 'not_installed' } : { state: 'error' };
    const page = toMyWorkListPage(data);
    return page ? { state: 'ok', page } : { state: 'error' };
  } catch {
    return { state: 'error' };
  }
}
