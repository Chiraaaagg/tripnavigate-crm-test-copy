import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DealListFilter, LeadListFilter, ListFiltersVM, ListPagerVM } from '@/modules/deals/workspace-contract';
import { FLIGHT_TASK_STATUS_LABEL } from '@/modules/fulfilment/contracts';
import { DealsListScreen, type DealListRowVM } from '@/views/deals-list-view';
import { FLIGHT_INTERNAL_TEXT, FLIGHT_QUEUE_NOTE, flightConfirmedText } from '@/views/flight-views';
import { type LeadListRowVM, LeadsListScreen } from '@/views/lead-views';
import { nothingVisible } from '@/views/list-parts';
import { DealListRow, LeadListRow } from '@/views/list-rows';
import { searchMessage } from '@/modules/search/text';
import { SEARCH_TEXT } from '@/views/list-search-text';
import { FEATURES_PURCHASE_REFUSAL, WorkflowNoPermissionView } from '@/views/workflow-views';

/**
 * Batch 5 search, view side (contracts.md §E; copy DA-300 to DA-319): final
 * words, the client bundle stays free of server-only modules, the list renders
 * without script, found rows use the list's own row markup, and the carried
 * N1 / N2 wording. Behaviour in the browser: tests/e2e/batch5-search.e2e.ts.
 */

const src = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
const read = (path: string) => readFileSync(resolve(src, path), 'utf8');

const lead: LeadListRowVM = {
  id: 'l1',
  reference: 'BXL-9100',
  title: 'Sample Customer A · Goa beach week',
  status: { code: 'NEW', name: null, labelState: 'switched_off' },
  source: { code: 'WEB', name: 'Website', labelState: 'named' },
  owner: { kind: 'you' },
  branchName: 'Delhi',
  createdInBitrixAt: '2026-10-01T06:00:00Z',
  late: false,
  details: { sourceLeadId: '9100', lastCheckedAt: '2026-10-23T05:00:00Z', relation: 'owner' },
};

const deal: DealListRowVM = {
  id: 'd1',
  reference: 'BX-4400',
  title: 'Sample Customer A · Goa beach week',
  branchName: 'Delhi',
  owner: { kind: 'colleague', displayName: 'Synthetic Sales B' },
  stage: { code: 'C1:WON', name: null, labelState: 'switched_off' },
  testRecord: false,
  late: true,
  details: { relation: 'scope', createdOn: '2026-10-01', sourceDealId: '4400', lastCheckedAt: '2026-10-23T05:00:00Z' },
};

const pager = (shown: number, next: string | null = null): ListPagerVM => ({ from: shown ? 1 : 0, to: shown, total: shown, previousHref: null, nextHref: next });
const filters = (current: LeadListFilter): ListFiltersVM<LeadListFilter> => ({
  chips: [
    { filter: 'all', label: 'All', count: 1, href: '/app/leads', current: current === 'all' },
    { filter: 'mine', label: 'Mine', count: 0, href: '/app/leads?filter=mine', current: current === 'mine' },
  ],
  scopeText: 'Counts include all pages.',
});
const dealFilters: ListFiltersVM<DealListFilter> = {
  chips: [{ filter: 'all', label: 'All deals you can see', count: 1, href: '/app/deals', current: true }],
  scopeText: 'Counts include all pages.',
};

const leadSearch = async () => ({ ok: true as const, kind: 'lead' as const, query: 'goa', rows: [lead], nextAfter: null, titlesSearched: true });
const dealSearch = async () => ({ ok: true as const, kind: 'deal' as const, query: 'goa', rows: [deal], nextAfter: null, titlesSearched: true });

/** One <tr …>…</tr> holding the given reference. */
function rowOf(html: string, reference: string): string {
  const rows = html.match(/<tr[\s>][^]*?<\/tr>/g) ?? [];
  const found = rows.find((r) => r.includes(`>${reference}<`));
  if (!found) throw new Error(`row ${reference} not found`);
  return found;
}

describe('Batch 5 search words (Mercury DA-300 to DA-319, exact)', () => {
  it('box, hint, placeholder and button', () => {
    expect(SEARCH_TEXT.label('leads')).toBe('Search leads');
    expect(SEARCH_TEXT.label('deals')).toBe('Search deals');
    expect(SEARCH_TEXT.placeholder).toBe('Reference, Bitrix number, customer or trip');
    expect(SEARCH_TEXT.hint('deals')).toBe(
      'Searches all deals you can see, not just this page, by reference, Bitrix number or Customer and trip. Not by phone or e-mail.',
    );
    expect([SEARCH_TEXT.submit, SEARCH_TEXT.submitting, SEARCH_TEXT.searching('leads')]).toEqual(['Search', 'Searching…', 'Searching leads…']);
    expect(SEARCH_TEXT.tooShort).toBe('Type at least 2 characters to search.');
  });

  it('counts never claim a total; the two-character and no-result variants', () => {
    expect(SEARCH_TEXT.found(20, 'goa', true)).toBe('Showing 20 matches for “goa”. More are available.');
    expect(SEARCH_TEXT.found(1, 'goa', false)).toBe('1 match for “goa”.');
    expect(SEARCH_TEXT.found(22, 'goa', false)).toBe('22 matches for “goa”.');
    expect(SEARCH_TEXT.caption('goa', 'deals')).toBe('Deals matching “goa”');
    expect(SEARCH_TEXT.noResultsTitle('zz', 'leads', false)).toBe('No lead you can see has a reference or Bitrix number starting with “zz”.');
    expect(SEARCH_TEXT.noResultsBody('goa', 'deals', true)).toBe('Search checks the reference, Bitrix number and Customer and trip only. Check the spelling, or find the deal in Bitrix.');
    for (const n of [0, 1, 20, 21]) for (const more of [true, false]) expect(SEARCH_TEXT.found(n, 'x', more)).not.toMatch(/\bof\b|total/i);
  });

  it('two characters, numbers and "@" search references only, each said in its own words', () => {
    expect(SEARCH_TEXT.referencesOnly('ab')).toBe('Two characters search references and Bitrix numbers only. Type 3 or more to also search Customer and trip.');
    expect(SEARCH_TEXT.referencesOnly('91')).toBe(SEARCH_TEXT.referencesOnly('ab'));
    expect(SEARCH_TEXT.referencesOnly('9100')).toBe('Numbers search references and Bitrix numbers only.');
    expect(SEARCH_TEXT.noResultsBody('zz', 'leads', false)).toBe('Type 3 or more characters to also search Customer and trip, or find the lead in Bitrix.');
    expect(SEARCH_TEXT.noResultsBody('98765', 'deals', false)).toBe('Numbers search references and Bitrix numbers only. Check the reference, or find the deal in Bitrix.');
    expect(SEARCH_TEXT.noResultsBody('a@b.in', 'deals', false)).not.toMatch(/Type 3 or more/);
  });

  it('DA-308: the second sentence only when a filter is chosen', () => {
    expect(SEARCH_TEXT.filtersNote(false)).toBe('Filters do not apply to search results.');
    expect(SEARCH_TEXT.filtersNote(true)).toBe('Filters do not apply to search results. Your filter comes back when you clear search.');
  });

  it('one source: the server refusal messages are the screen words (Echo-B L1)', () => {
    expect(searchMessage('lead', 'too_short')).toBe(SEARCH_TEXT.tooShort);
    expect(searchMessage('deal', 'not_authorized')).toBe(SEARCH_TEXT.notAuthorized('deals'));
    expect(searchMessage('lead', 'unexpected')).toBe(SEARCH_TEXT.failed);
    expect(SEARCH_TEXT.notInstalled('leads').startsWith(searchMessage('lead', 'not_installed'))).toBe(true);
    expect(searchMessage('lead', 'not_installed')).toBe('Searching all leads is not installed in this CRM yet.');
  });

  it('refusals keep the words and say what is still true', () => {
    expect(SEARCH_TEXT.notInstalled('leads')).toBe('Searching all leads is not installed in this CRM yet. This box searches this page only.');
    expect(SEARCH_TEXT.notAuthorized('deals')).toBe('Not searched: your access does not include the deals list. If you need it, ask your admin.');
    expect(SEARCH_TEXT.failed).toBe('Search did not finish. Nothing was changed. Your words are still in the box, so you can try again.');
    expect(SEARCH_TEXT.moreFailed('leads')).toBe('More matches could not be loaded. The matches above are unchanged. Try Show more leads again.');
    expect(SEARCH_TEXT.cleared).toBe('Search cleared. The list is shown again.');
    expect(SEARCH_TEXT.dealsNoServices).toBe('Services and progress are not shown in search results. Open the deal to see them.');
  });
});

describe('client bundle stays free of server-only modules', () => {
  it('the search box, its rows and its words import no validation library and no server module', () => {
    for (const file of ['views/list-search.tsx', 'views/list-rows.tsx', 'views/list-search-text.ts', 'views/list-seen-because.ts', 'views/list-parts.tsx', 'modules/search/contracts.ts', 'modules/search/text.ts']) {
      const imports = [...read(file).matchAll(/^import[^;]*?from '([^']+)'/gms)].map((m) => m[1]!);
      for (const spec of imports) {
        expect(spec, `${file} imports ${spec}`).not.toMatch(/zod|server-only|\/server\/|supabase|next\/headers/);
      }
      // Runtime imports of other list screens would pull their modules in; types only.
      expect(read(file), file).not.toMatch(/^import \{[^}]*\} from '\.\/(list-leads|deals-list-view|lead-views)'/m);
    }
    expect(read('views/list-search.tsx').startsWith("'use client';")).toBe(true);
    expect(read('views/list-rows.tsx')).not.toMatch(/'use (client|server)'/);
  });
});

describe('lists with server search', () => {
  it('without script the Leads list renders as before, with no search box', () => {
    const html = renderToStaticMarkup(
      createElement(LeadsListScreen, { rows: [lead], filters: filters('all'), freshness: { state: 'unknown' }, pager: pager(1), search: leadSearch }),
    );
    expect(html).toContain('id="leads-table"');
    expect(html).toContain('data-search-state="no-script"');
    expect(html).not.toMatch(/type="search"/);
    expect(html).not.toMatch(/\sstyle="/);
  });

  it('the Deals order control still shows without script', () => {
    const html = renderToStaticMarkup(
      createElement(DealsListScreen, {
        rows: [deal],
        filters: dealFilters,
        freshness: { state: 'unknown' },
        pager: pager(1),
        sort: { current: 'id_desc', newestHref: '/app/deals', oldestHref: '/app/deals?sort=id_asc' },
        search: dealSearch,
      }),
    );
    expect(html).toContain('aria-label="Order of deals"');
    expect(html).toContain('id="deals-table"');
  });

  it('a found row is the list row: same markup from the shared row components', () => {
    const list = renderToStaticMarkup(createElement(LeadsListScreen, { rows: [lead], filters: filters('all'), freshness: { state: 'unknown' }, pager: pager(1) }));
    const alone = renderToStaticMarkup(createElement('table', null, createElement('tbody', null, createElement(LeadListRow, { lead }))));
    expect(rowOf(alone, 'BXL-9100')).toBe(rowOf(list, 'BXL-9100'));
    const deals = renderToStaticMarkup(
      createElement(DealsListScreen, {
        rows: [deal],
        filters: dealFilters,
        freshness: { state: 'unknown' },
        pager: pager(1),
        sort: { current: 'id_desc', newestHref: '/app/deals', oldestHref: '/app/deals?sort=id_asc' },
      }),
    );
    const dealAlone = renderToStaticMarkup(createElement('table', null, createElement('tbody', null, createElement(DealListRow, { deal }))));
    expect(rowOf(dealAlone, 'BX-4400')).toBe(rowOf(deals, 'BX-4400'));
  });

  it('no box when the viewer can see nothing at all; a box for an empty filter or a later page', () => {
    expect(nothingVisible(0, filters('all'), pager(0))).toBe(true);
    expect(nothingVisible(0, filters('mine'), pager(0))).toBe(false);
    expect(nothingVisible(0, filters('all'), { ...pager(0), previousHref: '/app/leads' })).toBe(false);
    expect(nothingVisible(1, filters('all'), pager(1))).toBe(false);
  });
});

describe('carried N2 and N1 wording', () => {
  it('Flight says what the CRM recorded, never "Ticket issued" (DA-316 to DA-318)', () => {
    expect(FLIGHT_QUEUE_NOTE).toBe('Flight tasks from submitted bookings. Issue each ticket outside the CRM, then record the fare on the task.');
    expect(FLIGHT_INTERNAL_TEXT).toBe('Internal task. Tickets are issued outside the CRM.');
    expect(flightConfirmedText(null)).toBe('Internal task. Supplier confirmation recorded. No payment, bill or invoice was created by the CRM.');
    expect(flightConfirmedText('2026-10-20T06:00:00Z')).toMatch(/^Internal task\. Supplier confirmation recorded on 20 Oct 2026.*\. No payment, bill or invoice was created by the CRM\.$/);
    expect(FLIGHT_TASK_STATUS_LABEL.supplier_confirmed).toBe('Confirmed by supplier');
    for (const file of ['views/flight-views.tsx', 'views/department/task-history-vm.ts', 'views/deal-workspace/header.tsx', 'modules/deals/workspace.ts']) {
      expect(read(file), file).not.toContain("'Ticket issued'");
    }
  });

  it('N1: Features refusal for a Bitrix-connection manager who also works in Purchase', () => {
    expect(FEATURES_PURCHASE_REFUSAL).toBe('Features is not available to staff who also work in Purchase. Ask a Super Admin to change these switches.');
    expect(renderToStaticMarkup(createElement(WorkflowNoPermissionView, { reason: 'purchase' }))).toContain(FEATURES_PURCHASE_REFUSAL);
    expect(renderToStaticMarkup(createElement(WorkflowNoPermissionView))).toContain('Only a Super Admin or staff who manage the Bitrix connection can open Features.');
  });
});
