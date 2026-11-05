import 'server-only';
import { toDealListRow } from '@/modules/deals/list-model';
import { listVisibleDealsByIds, loadBitrixNameLookup } from '@/modules/deals/server/queries';
import type { StaffContext } from '@/modules/identity/server/session';
import { leadAccessDenied, loadLeadRowsByIds, NO_PERMISSION } from '@/modules/leads/server/queries';
import {
  type DealSearchResult,
  type LeadSearchResult,
  normaliseSearchQuery,
  SEARCH_FIELD,
  SEARCH_LIMITS,
  type SearchErrorCode,
  type SearchKind,
  searchQueryLength,
} from '../contracts';
import { searchMessage } from '../text';
import { runCrmSearch } from './crm-search';

/*
 * Batch 5 search (contracts.md §E, DEC-58). The steps behind the two server
 * actions, kept out of the 'use server' file so they can be tested with a
 * fake session client:
 *
 *   1. authorization first: Purchase (anywhere) and role-less viewers get
 *      not_authorized on Leads without any query, as on the Leads page;
 *   2. the words are normalised; fewer than 2 characters is too_short and
 *      never reaches the database;
 *   3. crm_search runs as the caller (Atlas's runCrmSearch, the person's own
 *      session client), so the list policies decide what can match;
 *   4. the found ids are loaded through the existing list reads (same
 *      columns, row mappers, Bitrix names and owner names) and kept in
 *      search order; a hit whose row is no longer visible is dropped.
 *
 * Privacy: the words travel only in the POST body. Nothing here logs, and no
 * returned message contains the words or the cursor (the result echoes the
 * normalised words back only to the person who typed them, for the box).
 */

function refuse<K extends SearchKind>(kind: K, query: string, code: SearchErrorCode) {
  return { ok: false as const, kind, query, code, message: searchMessage(kind, code) };
}

/** The posted words, normalised (the cursor is passed to runCrmSearch unread). */
function postedQuery(formData: FormData): string {
  return normaliseSearchQuery(formData.get(SEARCH_FIELD.query));
}

export async function searchLeads(staff: StaffContext, formData: FormData): Promise<LeadSearchResult> {
  const query = postedQuery(formData);
  if (leadAccessDenied(staff.access)) return refuse('lead', query, 'not_authorized');
  if (searchQueryLength(query) < SEARCH_LIMITS.minLength) return refuse('lead', query, 'too_short');
  const outcome = await runCrmSearch(staff, 'lead', formData.get(SEARCH_FIELD.query), formData.get(SEARCH_FIELD.after));
  if (!outcome.ok) return refuse('lead', outcome.query, outcome.code);
  try {
    const rows = await loadLeadRowsByIds(
      staff,
      outcome.page.hits.map((h) => h.id),
    );
    if (rows === NO_PERMISSION) return refuse('lead', outcome.query, 'not_authorized');
    return { ok: true, kind: 'lead', query: outcome.query, rows, nextAfter: outcome.page.nextAfter, titlesSearched: outcome.titlesSearched };
  } catch {
    return refuse('lead', outcome.query, 'unexpected');
  }
}

export async function searchDeals(staff: StaffContext, formData: FormData): Promise<DealSearchResult> {
  const query = postedQuery(formData);
  if (searchQueryLength(query) < SEARCH_LIMITS.minLength) return refuse('deal', query, 'too_short');
  const outcome = await runCrmSearch(staff, 'deal', formData.get(SEARCH_FIELD.query), formData.get(SEARCH_FIELD.after));
  if (!outcome.ok) return refuse('deal', outcome.query, outcome.code);
  try {
    const [items, names] = await Promise.all([
      listVisibleDealsByIds(
        staff,
        outcome.page.hits.map((h) => h.id),
      ),
      loadBitrixNameLookup(staff),
    ]);
    return {
      ok: true,
      kind: 'deal',
      query: outcome.query,
      rows: items.map((d) => toDealListRow(d, names)),
      nextAfter: outcome.page.nextAfter,
      titlesSearched: outcome.titlesSearched,
    };
  } catch {
    return refuse('deal', outcome.query, 'unexpected');
  }
}
