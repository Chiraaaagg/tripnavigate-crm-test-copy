import type { DealListRowModel, LeadListRowModel } from '@/modules/deals/list-model';
import { normaliseSearchQuery, SEARCH_LIMITS, searchesTitles, searchQueryLength } from '@/modules/search/contracts';
import { previewName } from './batch1-fixtures';

/*
 * Batch 5 search preview fixtures (synthetic only: "Sample Customer" names,
 * made-up references, no real data). A pool of Leads and Deals rows in the
 * list row models, and a pure stand-in matcher with the contract's rules
 * (references from 2 characters, titles from 3, 20 per page, opaque
 * continuation). Nothing here reads data.
 */

const TRIPS = ['Goa beach week', 'Kerala backwaters', 'Goa family trip', 'Jaisalmer desert camp', 'Goa honeymoon', 'Udaipur lakes'];
const BRANCHES = ['Delhi', 'Jodhpur', 'Ahmedabad'];

function iso(day: number): string {
  return `2026-10-${String(1 + (day % 20)).padStart(2, '0')}T0${day % 9}:30:00Z`;
}

export const PREVIEW_SEARCH_LEADS: LeadListRowModel[] = Array.from({ length: 44 }, (_, i) => {
  const n = 9100 - i;
  return {
    id: `5ea10000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    reference: `BXL-${n}`,
    title: `Sample Customer ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? '2' : ''} · ${TRIPS[i % TRIPS.length]}`,
    status: previewName(i % 3 === 0 ? 'NEW' : 'IN_PROCESS', i % 3 === 0 ? 'New' : null),
    source: previewName(i % 2 === 0 ? 'WEB' : 'CALL', i % 2 === 0 ? 'Website' : null),
    owner: i % 4 === 0 ? { kind: 'you' } : { kind: 'colleague', displayName: `Synthetic Sales ${BRANCHES[i % 3]} B` },
    branchName: BRANCHES[i % 3]!,
    createdInBitrixAt: iso(i),
    late: i % 11 === 5,
    details: { sourceLeadId: String(n), lastCheckedAt: '2026-10-23T05:00:00Z', relation: i % 4 === 0 ? 'owner' : 'branch_manager' },
  };
});

export const PREVIEW_SEARCH_DEALS: DealListRowModel[] = Array.from({ length: 44 }, (_, i) => {
  const n = 4400 - i;
  return {
    id: `5ea20000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    reference: `BX-${n}`,
    title: `Sample Customer ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? '2' : ''} · ${TRIPS[i % TRIPS.length]}`,
    branchName: BRANCHES[i % 3]!,
    owner: i % 5 === 0 ? { kind: 'you' } : i % 7 === 3 ? { kind: 'waiting' } : { kind: 'colleague', displayName: `Synthetic Sales ${BRANCHES[i % 3]} B` },
    stage: previewName(i % 2 === 0 ? 'C1:PREPARATION' : 'C1:WON', i % 2 === 0 ? 'Preparing' : null),
    testRecord: false,
    late: i % 13 === 6,
    details: {
      relation: i % 5 === 0 ? 'owner' : i % 7 === 3 ? 'waiting' : 'scope',
      createdOn: iso(i).slice(0, 10),
      sourceDealId: String(n),
      lastCheckedAt: '2026-10-23T05:00:00Z',
      lastChangeAt: '2026-10-22T11:00:00Z',
    },
  };
});

/** The bare Bitrix number of a reference ("BXL-9100" → "9100"). */
function bitrixNumber(reference: string): string {
  return reference.replace(/^[A-Z]+-/, '');
}

/** Stand-in for the database search: the contract's field rules over the synthetic pool. */
export function previewSearchPage<R extends { reference: string; title: string }>(
  pool: R[],
  rawQuery: unknown,
  rawAfter: unknown,
): { query: string; rows: R[]; nextAfter: string | null; titlesSearched: boolean } | { query: string; tooShort: true } {
  const query = normaliseSearchQuery(rawQuery);
  if (searchQueryLength(query) < SEARCH_LIMITS.minLength) return { query, tooShort: true };
  const needle = query.toLowerCase();
  const titles = searchesTitles(query);
  const matches = pool.filter(
    (r) => r.reference.toLowerCase().startsWith(needle) || bitrixNumber(r.reference).startsWith(needle) || (titles && r.title.toLowerCase().includes(needle)),
  );
  const start = typeof rawAfter === 'string' && /^p\d{1,4}$/.test(rawAfter) ? Number(rawAfter.slice(1)) : 0;
  const rows = matches.slice(start, start + SEARCH_LIMITS.pageSize);
  const next = start + SEARCH_LIMITS.pageSize;
  return { query, rows, nextAfter: next < matches.length ? `p${next}` : null, titlesSearched: titles };
}
