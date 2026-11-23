/*
 * Department task lists (Batch 4, screen plan PU-01 / FL-01 / VI-01): the
 * tabs "Not taken · Mine · All" over the full list the database already
 * returned. Pure helpers: the route parses `?show=`, the view filters the
 * rows it was given. No extra read, nothing hidden is sent.
 */

export type QueueShow = 'not_taken' | 'mine' | 'all';

export const QUEUE_SHOW_LABEL: Record<QueueShow, string> = { not_taken: 'Not taken', mine: 'Mine', all: 'All' };

/** Takers (the department role) get Mine; a branch Manager only follows progress. */
export function queueShowsFor(canTakeTasks: boolean): QueueShow[] {
  return canTakeTasks ? ['not_taken', 'mine', 'all'] : ['not_taken', 'all'];
}

/** Screen plan: default Not taken for the department, All for the branch Manager. */
export function defaultQueueShow(canTakeTasks: boolean): QueueShow {
  return canTakeTasks ? 'not_taken' : 'all';
}

/** Server allowlist: anything else is the default. */
export function parseQueueShow(raw: string | string[] | undefined, canTakeTasks: boolean): QueueShow {
  const v = Array.isArray(raw) ? raw[0] : raw;
  const shows = queueShowsFor(canTakeTasks);
  return shows.some((s) => s === v) ? (v as QueueShow) : defaultQueueShow(canTakeTasks);
}

/** The default tab keeps the bare address. */
export function queueShowHref(basePath: string, show: QueueShow, canTakeTasks: boolean): string {
  return show === defaultQueueShow(canTakeTasks) ? basePath : `${basePath}?show=${show}`;
}

interface Takeable {
  status: string;
  assigneeName: string | null;
  assignedToYou: boolean;
}

/** Not taken = nobody holds it and it is not finished. */
export function isNotTaken(t: Takeable): boolean {
  return !t.assignedToYou && !t.assigneeName && t.status === 'not_started';
}

export function filterQueue<T extends Takeable>(tasks: T[], show: QueueShow): T[] {
  if (show === 'mine') return tasks.filter((t) => t.assignedToYou);
  if (show === 'not_taken') return tasks.filter(isNotTaken);
  return tasks;
}

// ---------------------------------------------------------------------------
// R3 queue pattern (design plan 1.2, C2): search, status chips and sort over
// the rows the database already returned. Pure helpers; the address carries
// `?show=&q=&chip=&sort=` so every filter is a link and keeps the back button.
// ---------------------------------------------------------------------------

export type QueueSort = 'soonest' | 'latest' | 'deal';
export const QUEUE_SORTS = ['soonest', 'latest', 'deal'] as const satisfies readonly QueueSort[];
export const DEFAULT_QUEUE_SORT: QueueSort = 'soonest';
export const QUEUE_SORT_LABEL: Record<QueueSort, string> = {
  soonest: 'Soonest travel first',
  latest: 'Latest travel first',
  deal: 'Deal reference',
};
export const QUEUE_SORT_OPTIONS = QUEUE_SORTS.map((value) => ({ value, label: QUEUE_SORT_LABEL[value] }));

/** Longest search kept from the address (longer input is cut, never refused). */
export const QUEUE_SEARCH_MAX = 100;

export interface QueueQuery<C extends string = string> {
  /** Search words as typed (trimmed, spaces collapsed); '' = no search. */
  q: string;
  /** The chosen status chip; null = none. */
  chip: C | null;
  sort: QueueSort;
}

type Raw = string | string[] | undefined;
const first = (raw: unknown): string | undefined => {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' ? v : undefined;
};

/** `?q=`: first value, spaces collapsed, trimmed, at most 100 characters; '' = no search. */
export function parseQueueSearch(raw: unknown): string {
  return (first(raw) ?? '').replace(/\s+/g, ' ').trim().slice(0, QUEUE_SEARCH_MAX);
}

/** `?sort=`: server allowlist; anything else is soonest travel first. */
export function parseQueueSort(raw: unknown): QueueSort {
  const v = first(raw);
  return v !== undefined && (QUEUE_SORTS as readonly string[]).includes(v) ? (v as QueueSort) : DEFAULT_QUEUE_SORT;
}

/** Server allowlist for the toolbar values: unknown chips and sorts are ignored, never an error. */
export function parseQueueQuery<C extends string>(raw: { q?: Raw; chip?: Raw; sort?: Raw }, chips: readonly C[]): QueueQuery<C> {
  const chipRaw = first(raw.chip);
  return {
    q: parseQueueSearch(raw.q),
    chip: chipRaw !== undefined && (chips as readonly string[]).includes(chipRaw) ? (chipRaw as C) : null,
    sort: parseQueueSort(raw.sort),
  };
}

/** True when every search word appears somewhere in the row's fields (case does not matter). Empty search = true. */
export function matchesSearch(q: string, fields: ReadonlyArray<string | null | undefined>): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fields.filter(Boolean).join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
}

/**
 * Sorted copy (one rule for the Purchase, Flight and Visa queues). Soonest /
 * latest compare the travel day (YYYY-MM-DD); rows with no travel day always
 * go last; the same day orders by Deal reference. Deal reference sorts by
 * reference (numbers in order), then soonest travel. Remaining ties keep the
 * order the database returned.
 */
export function sortQueue<T>(rows: readonly T[], sort: QueueSort, travelDay: (row: T) => string | null | undefined, dealRef: (row: T) => string): T[] {
  const byDay = (a: T, b: T, dir: 1 | -1) => {
    const x = travelDay(a) || null;
    const y = travelDay(b) || null;
    if (x === y) return 0;
    if (!x) return 1;
    if (!y) return -1;
    return x < y ? -dir : dir;
  };
  const byRef = (a: T, b: T) => dealRef(a).localeCompare(dealRef(b), 'en', { numeric: true, sensitivity: 'base' });
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const c = sort === 'deal' ? byRef(a.row, b.row) || byDay(a.row, b.row, 1) : byDay(a.row, b.row, sort === 'soonest' ? 1 : -1) || byRef(a.row, b.row);
      return c || a.i - b.i;
    })
    .map((x) => x.row);
}

/** A row's "Next step": words, and the one row button when the viewer can act. */
export interface RowNext {
  text: string;
  button?: { label: string; href: string; primary?: boolean };
}

/**
 * One list address: empty and default values are left out, keys in a fixed
 * order (show, only, q, chip, sort). `only` is the Flight and Visa chip (Home's
 * links), `chip` the Purchase one.
 */
export function queueAddress(
  basePath: string,
  params: { show?: string | null; only?: string | null; q?: string | null; chip?: string | null; sort?: QueueSort | null },
): string {
  const qs = new URLSearchParams();
  if (params.show) qs.set('show', params.show);
  if (params.only) qs.set('only', params.only);
  if (params.q) qs.set('q', params.q);
  if (params.chip) qs.set('chip', params.chip);
  if (params.sort && params.sort !== DEFAULT_QUEUE_SORT) qs.set('sort', params.sort);
  const s = qs.toString();
  return s ? `${basePath}?${s}` : basePath;
}

// ---------------------------------------------------------------------------
// Flight and Visa desk queues (R3, C2): the same pattern with the `?only=`
// chip that Home's rows already link to ("/app/flight?show=mine&only=ready").
// ---------------------------------------------------------------------------

export interface DeskQueueQuery {
  show: QueueShow;
  only?: string | null;
  q?: string;
  sort?: QueueSort;
}

/** The desk queue address for a tab, chip, search and sort; the default tab and sort are left out. */
export function deskQueueHref(basePath: string, canTakeTasks: boolean, query: DeskQueueQuery): string {
  return queueAddress(basePath, { show: query.show === defaultQueueShow(canTakeTasks) ? null : query.show, only: query.only, q: query.q, sort: query.sort });
}

/** Hidden fields the toolbar keeps on submit: the tab and the chip (never a page number). */
export function deskToolbarKeep(canTakeTasks: boolean, query: DeskQueueQuery): Record<string, string> | undefined {
  const keep: Record<string, string> = {};
  if (query.show !== defaultQueueShow(canTakeTasks)) keep.show = query.show;
  if (query.only) keep.only = query.only;
  return Object.keys(keep).length ? keep : undefined;
}
