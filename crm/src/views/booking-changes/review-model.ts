import type { FactLine, ReviewSideView } from './types';

/*
 * Pure model of the Manager's side-by-side review (Addendum O2): one row per
 * service of either version, its state in words (changed / added / removed /
 * no change) and, per fact, the value before and after. Unit-tested in
 * tests/unit/acc3u-changes-review.test.ts.
 */

export interface ReviewLine {
  key: string;
  label: string;
  before: string | null;
  after: string | null;
  changed: boolean;
}

export interface ReviewServiceRow {
  itemId: string;
  itemNo: number;
  serviceTitle: string;
  state: 'changed' | 'added' | 'removed' | 'same';
  lines: ReviewLine[];
}

function byKey(lines: FactLine[]): Map<string, FactLine> {
  return new Map(lines.map((l) => [l.key, l]));
}

export function reviewServiceRows(base: ReviewSideView, proposed: ReviewSideView, changedItemIds: readonly string[]): ReviewServiceRow[] {
  const before = new Map(base.services.map((s) => [s.itemId, s]));
  const after = new Map(proposed.services.map((s) => [s.itemId, s]));
  const ids = [...new Set([...before.keys(), ...after.keys()])];
  const rows = ids.map((id): ReviewServiceRow => {
    const b = before.get(id);
    const a = after.get(id);
    const head = (a ?? b)!;
    const bl = byKey(b?.facts ?? []);
    const al = byKey(a?.facts ?? []);
    const keys = [...new Set([...bl.keys(), ...al.keys()])].sort();
    const lines = keys.map((key): ReviewLine => {
      const x = bl.get(key)?.value ?? null;
      const y = al.get(key)?.value ?? null;
      return { key, label: (al.get(key) ?? bl.get(key))!.label, before: b ? x : null, after: a ? y : null, changed: !!b && !!a && x !== y };
    });
    const state: ReviewServiceRow['state'] = !b ? 'added' : !a ? 'removed' : changedItemIds.includes(id) || lines.some((l) => l.changed) ? 'changed' : 'same';
    return { itemId: id, itemNo: head.itemNo, serviceTitle: head.serviceTitle, state, lines };
  });
  const order = { changed: 0, added: 1, removed: 2, same: 3 } as const;
  return rows.sort((x, y) => order[x.state] - order[y.state] || x.itemNo - y.itemNo);
}
