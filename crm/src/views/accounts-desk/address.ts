import { detectReferenceType, duesFilterFromParams, duesFilterToParams, recordsFilterFromParams, recordsFilterToParams, REFERENCE_TYPE_HINT, type ReferenceType } from '@/modules/accounts-desk/filters';
import type { DuesFilter, RecordsFilter } from './types';

/*
 * Filters kept in the address (contract 11). Track B's `filters.ts` owns the
 * allowlist and the parameter names; these helpers only build the links the
 * screens offer (chips, "Clear all", "Show more", the daily-check counts).
 */

export type SearchParams = Record<string, string | string[] | undefined>;

export const RECORDS_PATH = '/app/accounts/records';
export const DUES_PATH = '/app/accounts/dues';
export const TALLY_PATH = '/app/accounts/tally';

export const parseRecordsFilter = (sp: SearchParams): RecordsFilter => recordsFilterFromParams(sp);
export const parseDuesFilter = (sp: SearchParams): DuesFilter => duesFilterFromParams(sp);

function withExtra(p: URLSearchParams, extra: Record<string, string | undefined>): string {
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function recordsHref(f: RecordsFilter, extra: Record<string, string | undefined> = {}): string {
  return `${RECORDS_PATH}${withExtra(recordsFilterToParams(f), extra)}`;
}

export function duesHref(f: DuesFilter, extra: Record<string, string | undefined> = {}): string {
  return `${DUES_PATH}${withExtra(duesFilterToParams(f), extra)}`;
}

/** The "Missing originals" preset (contract 11.1). */
export const MISSING_ORIGINALS_FILTER: RecordsFilter = { kinds: ['original'], originals: 'missing' };

/** True when no filter or search is set (undefined values do not count). */
export function isEmptyFilter(f: object): boolean {
  return Object.values(f).every((v) => v === undefined);
}

export function referenceHint(q: string): string {
  const t: ReferenceType = detectReferenceType(q);
  return REFERENCE_TYPE_HINT[t];
}

export function readCursor(sp: SearchParams): string | null {
  const v = sp.after;
  const a = Array.isArray(v) ? v[0] : v;
  return a && a.length <= 200 ? a : null;
}

/** Whether the address asked for totals ("Show totals"). */
export function wantsTotals(sp: SearchParams): boolean {
  const v = sp.totals;
  return (Array.isArray(v) ? v[0] : v) === '1';
}
