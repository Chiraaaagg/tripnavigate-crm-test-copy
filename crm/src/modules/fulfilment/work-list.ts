import { z } from 'zod';

/**
 * Direction A Batch 1 B1-3: the Home work rows behind the counts, from
 * public.my_work_list(p_kind, p_after, p_limit) (migration
 * 20261121000120). Each kind's rows use the predicate of its count key, so a
 * list's length equals the number Home shows:
 *   drafts           draftsToContinue (new key of my_work_counts)
 *   missing_details  missingDetails
 *   returned         returnedToMe
 *   needs_booking    intakeNeeded (only while the intake prompt is on)
 * Sales and Manager only. Row allowlist: dealId, reference, title, branchId,
 * versionNo (draft kinds), since. No money, contact, reason or staff identity.
 */

export const MY_WORK_LIST_KINDS = ['drafts', 'missing_details', 'returned', 'needs_booking'] as const;
export type MyWorkListKind = (typeof MY_WORK_LIST_KINDS)[number];

/** The count key each list mirrors (the drafts row reads draftsToContinue, never waitingForMe). */
export const MY_WORK_LIST_COUNT_KEY = {
  drafts: 'draftsToContinue',
  missing_details: 'missingDetails',
  returned: 'returnedToMe',
  needs_booking: 'intakeNeeded',
} as const satisfies Record<MyWorkListKind, string>;

export const MY_WORK_LIST_MAX_LIMIT = 50;
export const MY_WORK_LIST_DEFAULT_LIMIT = 20;

export interface MyWorkListCursor {
  since: string;
  dealId: string;
}

export interface MyWorkListRow {
  dealId: string;
  reference: string;
  title: string;
  branchId: string;
  /** Draft kinds only. */
  versionNo?: number;
  since: string;
}

export type MyWorkListPage =
  | { applies: false }
  | { applies: true; available: false; reason: 'switched_off' }
  | { applies: true; available: true; rows: MyWorkListRow[]; hasMore: boolean; next: MyWorkListCursor | null };

const Cursor = z.object({ since: z.string().min(1), dealId: z.uuid() });
const Row = z.object({
  dealId: z.uuid(),
  reference: z.string().min(1).max(200),
  title: z.string().min(1).max(500),
  branchId: z.uuid(),
  versionNo: z.number().int().min(1).optional(),
  since: z.string().min(1),
});
const Page = z.union([
  z.object({ applies: z.literal(false) }),
  z.object({ applies: z.literal(true), available: z.literal(false), reason: z.literal('switched_off') }),
  z.object({ applies: z.literal(true), available: z.literal(true), rows: z.array(Row), hasMore: z.boolean(), next: Cursor.nullable() }),
]);

/** Parses one page (keys copied explicitly). Malformed = null ("Counts unavailable", never empty). */
export function toMyWorkListPage(data: unknown): MyWorkListPage | null {
  const parsed = Page.safeParse(data);
  if (!parsed.success) return null;
  const p = parsed.data;
  if (!p.applies) return { applies: false };
  if (!p.available) return { applies: true, available: false, reason: 'switched_off' };
  return {
    applies: true,
    available: true,
    rows: p.rows.map((r) => ({
      dealId: r.dealId,
      reference: r.reference,
      title: r.title,
      branchId: r.branchId,
      ...(r.versionNo !== undefined ? { versionNo: r.versionNo } : {}),
      since: r.since,
    })),
    hasMore: p.hasMore,
    next: p.next ? { since: p.next.since, dealId: p.next.dealId } : null,
  };
}

/** A cursor taken from a URL or form (opaque to staff); anything malformed is ignored (first page). */
export function parseMyWorkListCursor(raw: unknown): MyWorkListCursor | null {
  const parsed = Cursor.safeParse(raw);
  return parsed.success ? { since: parsed.data.since, dealId: parsed.data.dealId } : null;
}
