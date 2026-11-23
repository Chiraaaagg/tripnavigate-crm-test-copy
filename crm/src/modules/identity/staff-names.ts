import { z } from 'zod';

/**
 * Direction A Batch 1 B1-4 (owner answer DEC-52, scoped on 19 October 2026):
 * the OWNER's display name on Deals and Leads the viewer can already open,
 * from public.record_staff_names(p_user_ids) (migration 20261121000130).
 * Assignee and other colleague names are not approved: screens keep today's
 * wording ("Another staff member") for them. Display name only.
 */

export const STAFF_NAMES_MAX_IDS = 200;

const Reply = z.array(z.object({ userId: z.uuid(), displayName: z.string().min(1).max(200) }));

/** userId -> display name; null when the reply is malformed (callers then show today's wording). */
export function toStaffNameMap(data: unknown): Map<string, string> | null {
  const parsed = Reply.safeParse(data);
  if (!parsed.success) return null;
  return new Map(parsed.data.map((r) => [r.userId, r.displayName]));
}

/** Distinct, valid ids in first-seen order, at most STAFF_NAMES_MAX_IDS. */
export function staffNameRequestIds(ids: Iterable<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id || seen.has(id) || !z.uuid().safeParse(id).success) continue;
    seen.add(id);
    out.push(id);
    if (out.length === STAFF_NAMES_MAX_IDS) break;
  }
  return out;
}
