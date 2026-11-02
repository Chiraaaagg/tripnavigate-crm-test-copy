import type { DealListRowModel, LeadListRowModel } from '@/modules/deals/list-model';

/*
 * Batch 5 Step 0 (frozen contract, 23 October 2026). Search across Leads and
 * Deals (contracts.md section E; plan.md DEC-58).
 *
 * - Scope: everything the person may already see in that list, and no more.
 *   The database read `crm_search` runs as the caller (security invoker), so
 *   the existing list policies decide what can match.
 * - Fields: reference (BX-<n>, BXL-<n>) and the plain Bitrix number, exact or
 *   prefix from 2 characters; title "contains" from 3 characters. Never mobile
 *   numbers or e-mails.
 * - Privacy: the search words travel only in a POST body (a server action),
 *   never in an address, a log line, an audit row or analytics.
 * - Results reuse the list row models, so a found row looks exactly like the
 *   same row in the list. Filter chips do not apply to search results.
 *
 * Types, constants and pure functions only; nothing here reads or writes.
 */

export type SearchKind = 'lead' | 'deal';

export const SEARCH_LIMITS = {
  /** Longer input is cut to this length before it reaches the database. */
  maxLength: 60,
  /** Shortest search: a reference or Bitrix number prefix. */
  minLength: 2,
  /** Shortest search that also matches titles. */
  minTitleLength: 3,
  /** Results per "Show more" step. */
  pageSize: 20,
} as const;

/** Form field names posted by the search box. */
export const SEARCH_FIELD = {
  query: 'q',
  kind: 'kind',
  /** Opaque continuation cursor from the previous result, or absent for the first page. */
  after: 'after',
} as const;

/** Atlas's parsed database result (one kind per call). `nextAfter` is opaque to the screen. */
export interface SearchHitRecord {
  kind: SearchKind;
  id: string;
  reference: string;
}

export interface SearchPageRecord {
  hits: SearchHitRecord[];
  nextAfter: string | null;
}

export type SearchErrorCode =
  /** Fewer than SEARCH_LIMITS.minLength characters after trimming. Never reaches the database. */
  | 'too_short'
  /** The database has no crm_search yet (older database). */
  | 'not_installed'
  /** The person may not use this list at all (for example Purchase on Leads). */
  | 'not_authorized'
  | 'unexpected';

export type LeadSearchResult =
  | { ok: true; kind: 'lead'; query: string; rows: LeadListRowModel[]; nextAfter: string | null; titlesSearched: boolean }
  | { ok: false; kind: 'lead'; query: string; code: SearchErrorCode; message: string };

export type DealSearchResult =
  | { ok: true; kind: 'deal'; query: string; rows: DealListRowModel[]; nextAfter: string | null; titlesSearched: boolean }
  | { ok: false; kind: 'deal'; query: string; code: SearchErrorCode; message: string };

export type ListSearchResult = LeadSearchResult | DealSearchResult;

/** Length in characters (code points), as the database counts it, not UTF-16 units. */
export function searchQueryLength(query: string): number {
  return Array.from(query).length;
}

/**
 * Trim, collapse inner spaces and cut to the maximum length. The cut counts
 * characters, as the database does, so it never splits a character in two
 * (Echo-A L3).
 */
export function normaliseSearchQuery(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return Array.from(raw.replace(/\s+/g, ' ').trim()).slice(0, SEARCH_LIMITS.maxLength).join('').trim();
}

/** Only digits and phone punctuation (space + - ( ) .), with at least one digit: a possible phone number. */
export function isPhoneLike(query: string): boolean {
  return /^[0-9 +().-]+$/.test(query) && /[0-9]/.test(query);
}

/**
 * True when the query is long enough to also match titles (2 characters match
 * references only). Phone-like queries (digits with spaces, +, -, brackets or
 * dots) and anything with "@" never match titles, so a mobile number or e-mail typed into a Bitrix title is never
 * searchable (contracts E.4; Echo-A L1). The database applies the same rule.
 */
export function searchesTitles(query: string): boolean {
  if (isPhoneLike(query) || query.includes('@')) return false;
  return searchQueryLength(query) >= SEARCH_LIMITS.minTitleLength;
}
