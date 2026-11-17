import { type NoticeItemDTO, isShownUrgent, isUnread } from './contracts';

/**
 * Bell grouping (contract 9.4), pure. Normal unread notices of the same Deal
 * created within 10 minutes of the group's first notice collapse into one
 * line "{n} updates on {BX}" (expandable). Urgent notices (stored urgent or
 * an escalated receipt) are never grouped and are always listed first while
 * open. Read, done or resolved notices are listed one by one.
 */

export const GROUP_WINDOW_MS = 10 * 60_000;

export type NoticeEntry =
  | { type: 'single'; item: NoticeItemDTO }
  | { type: 'group'; dealId: string; dealReference: string; items: NoticeItemDTO[] };

export interface GroupedNotices {
  /** Open urgent notices, newest first. */
  urgent: NoticeItemDTO[];
  /** Everything else, newest first (by the newest notice of each entry). */
  entries: NoticeEntry[];
}

function newestSeq(entry: NoticeEntry): number {
  return entry.type === 'single' ? entry.item.seq : Math.max(...entry.items.map((i) => i.seq));
}

export function groupNotices(items: readonly NoticeItemDTO[]): GroupedNotices {
  const urgent: NoticeItemDTO[] = [];
  const singles: NoticeEntry[] = [];
  const groups: Array<{ dealId: string; dealReference: string; first: number; items: NoticeItemDTO[] }> = [];
  const open = new Map<string, (typeof groups)[number]>();

  const byCreated = [...items].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.seq - b.seq);
  for (const item of byCreated) {
    if (isShownUrgent(item) && isUnread(item)) {
      urgent.push(item);
      continue;
    }
    if (!isUnread(item) || item.dealId === null) {
      singles.push({ type: 'single', item });
      continue;
    }
    const at = Date.parse(item.createdAt);
    const current = open.get(item.dealId);
    if (current && at - current.first <= GROUP_WINDOW_MS) {
      current.items.push(item);
      continue;
    }
    const group = { dealId: item.dealId, dealReference: item.dealReference ?? 'this booking', first: at, items: [item] };
    groups.push(group);
    open.set(item.dealId, group);
  }

  const entries: NoticeEntry[] = [
    ...singles,
    ...groups.map((g): NoticeEntry =>
      g.items.length === 1
        ? { type: 'single', item: g.items[0]! }
        : { type: 'group', dealId: g.dealId, dealReference: g.dealReference, items: [...g.items].sort((a, b) => b.seq - a.seq) }),
  ].sort((a, b) => newestSeq(b) - newestSeq(a));

  return { urgent: urgent.sort((a, b) => b.seq - a.seq), entries };
}
