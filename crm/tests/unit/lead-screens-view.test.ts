import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LeadWorkspaceVM } from '@/modules/deals/workspace-contract';
import { type LeadListRowVM, LeadsListScreen, LeadWorkspaceView } from '@/views/lead-views';

/**
 * Direction A Batch 1 Leads screens (LE-01 list, LE-02 record): owner column
 * instead of "why you can see it", Bitrix codes never given invented names,
 * provenance on demand, exact counts with their scope, true pager, one
 * primary action only for quotation editors, and no contact or money fields.
 */

const row: LeadListRowVM = {
  id: 'l1',
  reference: 'BXL-700601',
  title: 'Synthetic Udaipur weekend',
  status: { code: 'UC_SYN7', name: null, labelState: 'switched_off' },
  source: { code: 'WEBFORM', name: 'CRM form', labelState: 'named' },
  owner: { kind: 'you' },
  branchName: 'Delhi',
  createdInBitrixAt: '2026-10-04T04:12:00Z',
  late: true,
  details: { sourceLeadId: '700601', lastCheckedAt: '2026-10-03T06:00:00Z', relation: 'owner' },
};
const list = (rows: LeadListRowVM[] = [row], filter: 'all' | 'mine' = 'all') =>
  renderToStaticMarkup(
    createElement(LeadsListScreen, {
      rows,
      filters: {
        chips: [
          { filter: 'all', label: 'All leads you can see', count: 160, href: '/app/leads', current: filter === 'all' },
          { filter: 'mine', label: 'Mine', count: 12, href: '/app/leads?filter=mine', current: filter === 'mine' },
        ],
        scopeText: 'Counts include all pages.',
      },
      freshness: { state: 'known', oldestCheckedAt: '2026-10-03T06:00:00Z', anyLate: true },
      pager: rows.length ? { from: 1, to: rows.length, total: 160, previousHref: null, nextHref: '/app/leads?page=2' } : { from: 0, to: 0, total: 0, previousHref: null, nextHref: null },
      now: '2026-10-04T12:00:00Z',
    }),
  );

describe('LeadsListScreen', () => {
  it('columns: customer and trip, status, source, owner, branch, created, details; no "why you can see it" column', () => {
    const html = list();
    const heads = (html.match(/<th[\s>][^]*?<\/th>/g) ?? []).map((h) => h.replace(/<[^>]+>/g, ''));
    expect(heads).toEqual(['Customer and trip', 'Status', 'Source', 'Owner', 'Branch', 'Created', 'Details']);
    expect(html).not.toContain('Why you can see it');
  });

  it('unknown status shows the fallback, the code goes to Details; a named source shows the Bitrix name', () => {
    const html = list();
    expect(html).toContain('Status not recognised (code in details)');
    expect(html).toContain('Bitrix code: UC_SYN7. Reading Bitrix names is switched off.');
    expect(html).toContain('CRM form');
    expect(html).toContain('You see this lead because you own it.');
    // DA-94a: no separate names-off line for staff who cannot change the switch.
    expect(html).not.toContain('Bitrix names are not switched on yet');
  });

  it('late row badge in words; freshness line; counts with their scope; true pager', () => {
    const html = list();
    expect(html).toMatch(/data-tone="warning"[^>]*>.*?Not updated from Bitrix for over a day/);
    expect(html).toContain('Bitrix data updated 1 day ago. Rows over a day old are marked.');
    expect(html).toContain('(160)');
    expect(html).toContain('Counts include all pages.');
    expect(html).toContain('1–1 of 160 leads');
    expect(html).toContain('href="/app/leads?page=2"');
  });

  it('no contact details or money in the markup', () => {
    expect(list()).not.toMatch(/₹|phone|e-?mail|@/i);
  });

  it('empty and filtered-empty states are honest and distinct', () => {
    expect(list([])).toContain('No leads to show');
    const mine = list([], 'mine');
    expect(mine).toContain('Nothing matches this filter');
    expect(mine).toContain('Clear filters');
  });
});

const workspace = (over: Partial<LeadWorkspaceVM> = {}): LeadWorkspaceVM => ({
  header: {
    leadId: 'l1',
    reference: 'BXL-700601',
    title: 'Synthetic Udaipur weekend',
    status: { code: 'UC_SYN7', name: null, labelState: 'switched_off' },
    owner: { kind: 'you' },
    branchName: 'Delhi',
    bitrixLate: false,
    next: { text: 'follow up in Bitrix' },
    canCreateQuotation: true,
  },
  tabs: [
    { tab: 'overview', label: 'Overview', href: '/app/leads/l1', current: true },
    { tab: 'quotations', label: 'Quotations', href: '/app/leads/l1?tab=quotations', current: false },
    { tab: 'bitrix', label: 'Bitrix details', href: '/app/leads/l1?tab=bitrix', current: false },
  ],
  current: 'overview',
  overview: { source: { code: 'WEBFORM', name: null, labelState: 'switched_off' }, createdInBitrixAt: '2026-10-04T04:12:00Z', branchName: 'Delhi', owner: { kind: 'you' } },
  ...over,
});
const record = (w: LeadWorkspaceVM, quotationsTab?: string) =>
  renderToStaticMarkup(createElement(LeadWorkspaceView, { workspace: w, quotationsTab: quotationsTab ? createElement('p', null, quotationsTab) : undefined }));

describe('LeadWorkspaceView', () => {
  it('one h1, Next line with the owner, one primary "New quotation" linking to the Quotations tab', () => {
    const html = record(workspace());
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toContain('Next:</span> follow up in Bitrix');
    expect(html).toContain('· You');
    const primary = html.match(/<a[^>]*data-slot="lead-primary"[^>]*>/)?.[0] ?? '';
    expect(primary).toContain('href="/app/leads/l1?tab=quotations"');
    expect(html).toContain('New quotation</a>');
  });

  it('no primary and no Quotations tab for viewers without quotation access', () => {
    const w = workspace({ header: { ...workspace().header, canCreateQuotation: false } });
    w.tabs = w.tabs.filter((t) => t.tab !== 'quotations');
    const html = record(w);
    expect(html).not.toContain('New quotation');
    expect(html).not.toContain('>Quotations<');
  });

  it('only the open tab renders; the Quotations body is the route slot', () => {
    expect(record(workspace(), 'SLOT')).not.toContain('SLOT');
    const q = workspace({ current: 'quotations', overview: undefined });
    expect(record(q, 'SLOT')).toContain('<p>SLOT</p>');
    expect(record(q)).toContain('Quotations did not load.');
  });

  it('late warning under the title; Bitrix details tab keeps the facts and the ownership line', () => {
    expect(record(workspace({ header: { ...workspace().header, bitrixLate: true } }))).toContain(
      'Not updated from Bitrix for over a day. Check the lead in Bitrix before you rely on it.',
    );
    const html = record(
      workspace({
        current: 'bitrix',
        overview: undefined,
        bitrix: {
          sourceLeadId: '700601',
          status: { code: 'UC_SYN7', name: null, labelState: 'not_in_list' },
          source: { code: 'WEBFORM', name: 'CRM form', labelState: 'named' },
          createdInBitrixAt: '2026-10-04T04:12:00Z',
          lastCheckedAt: '2026-10-04T11:40:00Z',
          lastChangeAt: '2026-10-04T11:10:00Z',
          relation: 'branch_manager',
        },
      }),
    );
    expect(html).toContain('Bitrix code: UC_SYN7. This code is not in Bitrix’s list of names.');
    expect(html).toContain('You see this lead because you manage this branch.');
    expect(html).toContain('Title, status, source and owner come from Bitrix. Change them in Bitrix.');
    expect(html).toContain('It does not prove which form the customer used.');
  });
});
