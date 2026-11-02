import { isPhoneLike, type SearchErrorCode, type SearchKind, SEARCH_LIMITS, searchQueryLength } from './contracts';

/*
 * Batch 5 search: every word the search box and the search actions use, in
 * one place (contracts.md §E; Mercury's final words, mercury-redesign-batch5.md
 * DA-300 to DA-315 and DA-319; copy-catalogue §16.15). The server's refusal
 * `message` (searchMessage) and the screen (SEARCH_TEXT, re-exported by
 * src/views/list-search-text.ts) derive from the same strings, so they cannot
 * drift. Plain words and pure functions only: safe for the browser bundle.
 * No message ever contains the search words, except the on-screen echo of
 * “{q}”, which is the person's own words in their own page (never an address).
 */

export type SearchNoun = 'leads' | 'deals';

const ONE: Record<SearchNoun, string> = { leads: 'lead', deals: 'deal' };
const CAPITAL: Record<SearchNoun, string> = { leads: 'Leads', deals: 'Deals' };
const NOUN: Record<SearchKind, SearchNoun> = { lead: 'leads', deal: 'deals' };

/**
 * Why only references and Bitrix numbers were searched (titlesSearched false):
 * too short (2 characters), digits only, or an "@" (contracts E.4, Echo-A L1).
 */
function referencesOnlyReason(query: string): 'short' | 'number' | 'at' {
  if (isPhoneLike(query) && searchQueryLength(query) >= SEARCH_LIMITS.minTitleLength) return 'number';
  if (query.includes('@')) return 'at';
  return 'short';
}

const TOO_SHORT = 'Type at least 2 characters to search.';
const NOT_INSTALLED = (noun: SearchNoun) => `Searching all ${noun} is not installed in this CRM yet.`;
const NOT_AUTHORIZED = (noun: SearchNoun) => `Not searched: your access does not include the ${noun} list. If you need it, ask your admin.`;
const FAILED = 'Search did not finish. Nothing was changed. Your words are still in the box, so you can try again.';

/** DA-305 and its two variants. */
function referencesOnly(query: string): string {
  switch (referencesOnlyReason(query)) {
    case 'number':
      // DA-320 (lead ruling 23 Oct, Echo-A L1): digits never search titles at any length.
      return 'Numbers search references and Bitrix numbers only.';
    case 'at':
      // DA-321 (lead ruling 23 Oct, Echo-A L1): "@" queries never search titles.
      return 'Words with “@” search references and Bitrix numbers only. E-mails are not searched.';
    case 'short':
      return 'Two characters search references and Bitrix numbers only. Type 3 or more to also search Customer and trip.';
  }
}

export const SEARCH_TEXT = {
  /** DA-300. */
  label: (noun: SearchNoun) => `Search ${noun}`,
  /** DA-301. */
  placeholder: 'Reference, Bitrix number, customer or trip',
  /** DA-302: visible, linked by aria-describedby. */
  hint: (noun: SearchNoun) => `Searches all ${noun} you can see, not just this page, by reference, Bitrix number or Customer and trip. Not by phone or e-mail.`,
  /** DA-303. */
  submit: 'Search',
  submitting: 'Searching…',
  /** DA-306 (status region). */
  searching: (noun: SearchNoun) => `Searching ${noun}…`,
  /** DA-304. */
  tooShort: TOO_SHORT,
  /** DA-307. */
  resultsHeading: 'Search results',
  caption: (query: string, noun: SearchNoun) => `${CAPITAL[noun]} matching “${query}”`,
  found: (n: number, query: string, more: boolean) =>
    more ? `Showing ${n} matches for “${query}”. More are available.` : n === 1 ? `1 match for “${query}”.` : `${n} matches for “${query}”.`,
  /** DA-308: the second sentence only when a filter other than All is chosen (it stays in the address, so it really comes back). */
  filtersNote: (filterActive: boolean) =>
    filterActive ? 'Filters do not apply to search results. Your filter comes back when you clear search.' : 'Filters do not apply to search results.',
  /** DA-319 (Deals only: search results carry no service summary). */
  dealsNoServices: 'Services and progress are not shown in search results. Open the deal to see them.',
  /** DA-305, DA-320 (numbers), DA-321 ("@"): shown when titlesSearched is false. */
  referencesOnly,
  /** DA-310 and DA-322, split into the empty-state heading (first sentence) and its text (the rest). */
  noResultsTitle: (query: string, noun: SearchNoun, titlesSearched: boolean) =>
    titlesSearched ? `No ${ONE[noun]} you can see matches “${query}”.` : `No ${ONE[noun]} you can see has a reference or Bitrix number starting with “${query}”.`,
  noResultsBody: (query: string, noun: SearchNoun, titlesSearched: boolean) => {
    if (titlesSearched) return `Search checks the reference, Bitrix number and Customer and trip only. Check the spelling, or find the ${ONE[noun]} in Bitrix.`;
    if (referencesOnlyReason(query) === 'short') return `Type 3 or more characters to also search Customer and trip, or find the ${ONE[noun]} in Bitrix.`;
    // DA-322 (lead ruling 23 Oct, Echo-A L1): numbers and "@" never search Customer and trip, at any length.
    return `${referencesOnly(query)} Check the reference, or find the ${ONE[noun]} in Bitrix.`;
  },
  /** DA-309. */
  showMore: (noun: SearchNoun) => `Show more ${noun}`,
  showingMore: 'Loading more…',
  moreFailed: (noun: SearchNoun) => `More matches could not be loaded. The matches above are unchanged. Try Show more ${noun} again.`,
  /** DA-314. */
  clear: 'Clear search',
  cleared: 'Search cleared. The list is shown again.',
  /** DA-311: honest fallback to today's page-only search (DA-100, DA-101a, DA-102). */
  notInstalled: (noun: SearchNoun) => `${NOT_INSTALLED(noun)} This box searches this page only.`,
  /** DA-312. */
  notAuthorized: NOT_AUTHORIZED,
  /** DA-313. */
  failed: FAILED,
} as const;

/** The plain message a refused search carries (DA-304, DA-311 first sentence, DA-312, DA-313). */
export function searchMessage(kind: SearchKind, code: SearchErrorCode): string {
  switch (code) {
    case 'too_short':
      return TOO_SHORT;
    case 'not_installed':
      return NOT_INSTALLED(NOUN[kind]);
    case 'not_authorized':
      return NOT_AUTHORIZED(NOUN[kind]);
    case 'unexpected':
      return FAILED;
  }
}
