import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

function cells(html: string, tag: 'th' | 'td'): string[] {
  return html.match(new RegExp(`<${tag}[\\s>][^]*?</${tag}>`, 'g')) ?? [];
}

describe('Deals list route wiring', () => {
  const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/app/app');
  const loadingFiles = (dir: string) => readdirSync(dir).filter((name) => /^loading\.(t|j)sx?$/.test(name));

  it('the (list) route group renders DealsListLoading as its loading state', async () => {
    const { default: Loading } = await import('@/app/app/deals/(list)/loading');
    const { DealsListLoading } = await import('@/views/deals-list-view');
    const element = Loading();
    expect(element.type).toBe(DealsListLoading);
    const html = renderToStaticMarkup(element);
    expect(html).toContain('Loading deals…');
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
  });

  it('only the list page sits under it: the deal page has its own loading state, not the list skeleton', async () => {
    const deals = join(appDir, 'deals');
    expect(readdirSync(join(deals, '(list)')).sort()).toEqual(['loading.tsx', 'page.tsx']);
    // No loading file directly under deals/ (it would wrap both the list and /app/deals/[id]).
    expect(loadingFiles(deals)).toEqual([]);
    // The deal page (screen group 4) renders DealPageLoading, never the list's skeleton.
    expect(loadingFiles(join(deals, '[id]'))).toEqual(['loading.tsx']);
    const { default: DealLoading } = await import('@/app/app/deals/[id]/loading');
    const { DealPageLoading } = await import('@/views/deal-page-view');
    const { DealsListLoading } = await import('@/views/deals-list-view');
    expect(DealLoading().type).toBe(DealPageLoading);
    expect(DealLoading().type).not.toBe(DealsListLoading);
    // The staff frame keeps its general loading state for every other page.
    expect(loadingFiles(appDir)).toEqual(['loading.tsx']);
  });
});

// ---------------------------------------------------------------------------
// Direction A Batch 1: DealsListScreen (DE-01)
// ---------------------------------------------------------------------------

describe('DealsListScreen (Batch 1)', async () => {
  const { DealsListScreen } = await import('@/views/deals-list-view');
  type Props = Parameters<typeof DealsListScreen>[0];
  const row: Props['rows'][number] = {
    id: '00000000-0000-4000-8000-000000000001',
    reference: 'BX-900420',
    title: 'Synthetic Goa trip',
    branchName: 'Jodhpur',
    owner: { kind: 'you' },
    stage: { code: 'C1:UC_SYN7', name: null, labelState: 'switched_off' },
    testRecord: false,
    late: false,
    details: { relation: 'owner', createdOn: '2026-10-06', sourceDealId: '900420', lastCheckedAt: '2026-10-01T09:50:00Z', lastChangeAt: '2026-10-01T09:15:00Z' },
  };
  const base: Props = {
    rows: [row],
    filters: {
      chips: [
        { filter: 'all', label: 'All deals you can see', count: 107, href: '/app/deals', current: true },
        { filter: 'owned', label: 'Owned by you', count: 12, href: '/app/deals?filter=owned', current: false },
        { filter: 'assigned', label: 'Assigned to you', count: null, href: '/app/deals?filter=assigned', current: false },
      ],
      scopeText: 'Counts include all pages.',
    },
    freshness: { state: 'known', oldestCheckedAt: '2026-10-01T09:50:00Z', anyLate: false },
    pager: { from: 51, to: 51, total: 107, previousHref: '/app/deals?page=1', nextHref: '/app/deals?page=3' },
    sort: { current: 'id_desc', newestHref: '/app/deals', oldestHref: '/app/deals?sort=id_asc' },
    now: '2026-10-01T12:55:00Z',
  };
  const html = (props: Partial<Props> = {}) => renderToStaticMarkup(createElement(DealsListScreen, { ...base, ...props }));

  it('columns: reference, customer and trip, stage, owner, details; one labelled cell per header', () => {
    const out = html();
    const headers = cells(out, 'th').map((h) => h.replace(/<[^>]+>/g, ''));
    expect(headers).toEqual(['Reference', 'Customer and trip', 'Stage', 'Owner', 'Details']);
    const row1 = cells(out, 'td');
    // The Details cell has no stacked-card label: its control says "Details" (Echo L4: never "Details Details").
    expect(row1.map((c) => /data-label="([^"]*)"/.exec(c)?.[1])).toEqual(['Reference', 'Customer and trip', 'Stage', 'Owner', '']);
    expect(out).not.toContain('Why you can see it');
  });

  it('services columns only when the projection loaded; a failure is one honest notice', () => {
    const summary = { dealId: row.id, serviceTypes: ['hotel' as const], total: 2, byState: { planned: 0, notStarted: 1, inProgress: 0, supplierConfirmed: 1 }, fulfilled: false, staleCount: 0, needs: [] };
    const loaded = html({ services: new Map([[row.id, summary]]) });
    expect(cells(loaded, 'th').map((h) => h.replace(/<[^>]+>/g, ''))).toEqual(['Reference', 'Customer and trip', 'Stage', 'Owner', 'Services', 'Progress', 'Details']);
    expect(loaded).toContain('1 of 2 confirmed');
    const failed = html({ services: null });
    expect(failed).toContain('Services did not load. The deal list itself is fine. Reload to try again.');
    expect(failed).not.toContain('>Progress<');
  });

  it('chips: exact counts in brackets, the current one marked, a failed count said in words (never 0), scope named', () => {
    const out = html();
    expect(out).toMatch(/aria-current="page"[^>]*>.*?All deals you can see.*?\(107\)/);
    expect(out).toContain('(12)');
    expect(out).toContain('(count unavailable)');
    expect(out).toContain('Counts include all pages.');
    // Screen readers still hear the full scope of the Assigned chip.
    expect(out).toContain('Assigned to you<span class="sr-only">, owned by someone else</span>');
  });

  it('true pager: range of the total, previous and next keep the given addresses', () => {
    const out = html();
    expect(out).toContain('51–51 of 107 deals');
    expect(out).toContain('href="/app/deals?page=1"');
    expect(out).toContain('href="/app/deals?page=3"');
    expect(html({ pager: { from: 1, to: 1, total: null, previousHref: null, nextHref: null } })).toContain('1–1 of the deals you can see (total not known)');
  });

  it('freshness line from the rows shown, separate from the live indicator; unknown is said in words', () => {
    expect(html()).toContain('Bitrix data updated 3 hours ago.');
    expect(html({ freshness: { state: 'known', oldestCheckedAt: '2026-10-01T09:50:00Z', anyLate: true } })).toContain('Bitrix data updated 3 hours ago. Rows over a day old are marked.');
    expect(html({ freshness: { state: 'unknown' } })).toContain('Bitrix update time not known.');
  });

  it('statuses are words with icons: unknown stage, late row, test record, waiting for owner', () => {
    const out = html({
      rows: [
        { ...row, late: true },
        { ...row, id: 't', stage: undefined, testRecord: true, owner: { kind: 'waiting' } },
        { ...row, id: 'n', stage: { code: 'C1:WON', name: 'Won - Payment Received', labelState: 'named' }, owner: { kind: 'colleague', displayName: 'Synthetic Sales B' } },
        { ...row, id: 'c', owner: { kind: 'colleague' } },
      ],
    });
    expect(out).toContain('Stage not recognised (code in details)');
    expect(out).toContain('Bitrix code: C1:UC_SYN7. Reading Bitrix names is switched off.');
    expect(out).toMatch(/data-tone="warning"[^>]*>.*?Not updated from Bitrix for over a day/);
    expect(out).toMatch(/data-tone="warning"[^>]*>.*?Test record/);
    expect(out).toMatch(/data-tone="warning"[^>]*>.*?Waiting for owner/);
    expect(out).toContain('Won - Payment Received');
    expect(out).toContain('Synthetic Sales B');
    expect(out).toContain('Another staff member');
    // DA-94a: names-off is told only to someone who may change the switch, on the freshness line.
    expect(out).not.toContain('Bitrix names are off');
    expect(html({ namesSwitchable: true })).toContain('Bitrix names are off, so stages show as not recognised.');
    expect(out).not.toMatch(/\sstyle="/);
    expect(out).not.toContain('₹');
  });

  it('search text on each row is only the reference and title (nothing hidden is shipped)', () => {
    const out = html();
    expect(out.match(/data-search="([^"]*)"/g)).toEqual(['data-search="bx-900420 synthetic goa trip"']);
  });

  it('the empty list and the not-found page never claim visibility is only ownership or assignment; role texts for Accounts and Super Admin', async () => {
    const none = { rows: [], pager: { from: 0, to: 0, total: 0, previousHref: null, nextHref: null } };
    const empty = html(none);
    expect(empty).not.toMatch(/owned by or assigned to you|you own or are assigned to/i);
    expect(empty).toMatch(/No deal is visible to you/);
    const { DealNotFoundView } = await import('@/views/staff-views');
    const notFound = renderToStaticMarkup(createElement(DealNotFoundView));
    expect(notFound).not.toMatch(/owned by or assigned to you/);
    expect(notFound).toMatch(/or it is not visible to you/);
    expect(html({ ...none, emptyFor: 'accounts' })).toContain('Your Deal work is in Accounts.');
    expect(html({ ...none, emptyFor: 'super_admin' })).toContain('Deals show here only when you are given access to them.');
    const filtered = html({ ...none, filters: { ...base.filters, chips: base.filters.chips.map((c) => ({ ...c, current: c.filter === 'owned' })) } });
    expect(filtered).toContain('Nothing matches this filter');
    expect(filtered).toContain('Clear filters');
    const later = html({ rows: [], pager: { from: 0, to: 0, total: 107, previousHref: '/app/deals?page=3', nextHref: null } });
    expect(later).toContain('That was the last page');
  });

  it('order links: newest and oldest, the current one marked', () => {
    const out = html();
    expect(out).toMatch(/aria-current="true"[^>]*>.*?Newest first/);
    expect(out).toContain('href="/app/deals?sort=id_asc"');
  });
});
