import { describe, expect, it } from 'vitest';
import type { ViewerAccess } from '@/modules/access/policy';
import type { DealListItem } from '@/modules/deals/dto';
import {
  BITRIX_NAMES_OFF,
  bitrixName,
  bitrixNameKey,
  clampPage,
  dealFilters,
  dealsFreshness,
  dealSortLinks,
  dealsListHref,
  dealStageEntity,
  leadFilters,
  leadsFreshness,
  leadsListHref,
  listFreshness,
  listPager,
  parseDealListFilter,
  parseLeadListFilter,
  parseListPage,
  recordOwner,
  toDealListRow,
  toLeadListRow,
} from '@/modules/deals/list-model';
import type { LeadRow } from '@/modules/leads/dto';
import { dealsHref } from '@/views/staff-views';

/* Batch 1 list models (LE-01, DE-01): query string, pager, chips, freshness, names, owner, rows. */

const ME = 'a0000000-0000-4000-8000-000000000001';
const OTHER = 'a0000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-10-19T12:00:00Z');

const viewer = (memberships: Array<[string, string]> = [['del', 'sales']]): ViewerAccess => ({
  userId: ME,
  memberships: memberships.map(([branchId, roleCode]) => ({ legalEntityId: 'e1', branchId, roleCode })),
  rolePermissions: [],
  grants: [],
});

const lead: LeadRow = {
  id: '11111111-1111-4111-8111-111111111111',
  reference: 'BXL-501',
  title: 'Goa family trip',
  branch_id: 'del',
  owner_user_id: ME,
  source_lead_id: 501,
  source_status_id: 'NEW',
  source_id_code: 'WEBFORM',
  source_created_at: '2026-10-04T05:00:00Z',
  last_synced_at: '2026-10-19T10:00:00Z',
  last_verified_at: '2026-10-19T11:00:00Z',
  source_portal: 'example.bitrix24.in',
};

const deal: DealListItem = {
  id: 'd1',
  reference: 'BX-9',
  title: 'Synthetic Kerala trip',
  branchName: 'Delhi',
  relation: 'scope',
  createdOn: '1 Oct 2026',
  ownerName: null,
  source: {
    system: 'bitrix',
    sourceDealId: '9',
    stageId: 'C2:WON',
    lastSyncedAt: '2026-10-19T09:00:00Z',
    lastVerifiedAt: '2026-10-19T11:00:00Z',
    stale: false,
  },
};

describe('query string', () => {
  it('parses page, filters and ignores everything else (old ?after= links show page 1, All)', () => {
    expect(parseListPage('3')).toBe(3);
    for (const bad of [undefined, '', '0', '-1', 'x', '1.5', '1234567', ['2']]) expect(parseListPage(bad)).toBe(1);
    expect(parseLeadListFilter({ filter: 'mine' })).toBe('mine');
    expect(parseLeadListFilter({ mine: '' })).toBe('mine');
    expect(parseLeadListFilter({ mine: '1' })).toBe('mine');
    for (const p of [{}, { filter: 'all' }, { filter: 'owned' }, { filter: ['mine'] }, { mine: '0' }, { after: 'BXL-5' } as never]) {
      expect(parseLeadListFilter(p)).toBe('all');
    }
    expect(parseDealListFilter('owned')).toBe('owned');
    expect(parseDealListFilter('assigned')).toBe('assigned');
    for (const bad of [undefined, '', 'mine', 'needs_review', ['owned']]) expect(parseDealListFilter(bad)).toBe('all');
  });

  it('builds addresses with defaults left out; default Deals addresses equal today’s dealsHref', () => {
    expect(leadsListHref('all')).toBe('/app/leads');
    expect(leadsListHref('all', 2)).toBe('/app/leads?page=2');
    expect(leadsListHref('mine', 3)).toBe('/app/leads?filter=mine&page=3');
    for (const [page, sort] of [[1, 'id_desc'], [3, 'id_desc'], [1, 'id_asc'], [2, 'id_asc']] as const) {
      expect(dealsListHref('all', page, sort)).toBe(dealsHref(page, sort));
    }
    expect(dealsListHref('assigned', 2, 'id_asc')).toBe('/app/deals?sort=id_asc&filter=assigned&page=2');
    expect(dealSortLinks('owned', 'id_asc')).toEqual({
      current: 'id_asc',
      newestHref: '/app/deals?filter=owned',
      oldestHref: '/app/deals?sort=id_asc&filter=owned',
    });
  });
});

describe('pager', () => {
  const href = (p: number) => `/p${p}`;
  it('clamps to the last page of an exact total; an unknown total clamps only below', () => {
    expect(clampPage(99, 120, 50)).toBe(3);
    expect(clampPage(0, 120, 50)).toBe(1);
    expect(clampPage(5, 0, 50)).toBe(1);
    expect(clampPage(7, null, 50)).toBe(7);
  });

  it('"from–to of N" with previous and next links', () => {
    expect(listPager({ page: 1, pageSize: 50, shown: 50, total: 120, href })).toEqual({ from: 1, to: 50, total: 120, previousHref: null, nextHref: '/p2' });
    expect(listPager({ page: 3, pageSize: 50, shown: 20, total: 120, href })).toEqual({ from: 101, to: 120, total: 120, previousHref: '/p2', nextHref: null });
    expect(listPager({ page: 1, pageSize: 50, shown: 0, total: 0, href })).toEqual({ from: 0, to: 0, total: 0, previousHref: null, nextHref: null });
  });

  it('an unknown total never shows as 0 and offers Next only after a full page', () => {
    expect(listPager({ page: 2, pageSize: 50, shown: 50, total: null, href })).toMatchObject({ from: 51, to: 100, total: null, nextHref: '/p3' });
    expect(listPager({ page: 2, pageSize: 50, shown: 3, total: null, href })).toMatchObject({ total: null, nextHref: null });
  });
});

describe('filter chips', () => {
  it('Leads: All / Mine with exact counts, page reset, scope named', () => {
    const vm = leadFilters({ all: 120, mine: 7 }, 'mine');
    expect(vm.chips).toEqual([
      { filter: 'all', label: 'All leads you can see', count: 120, href: '/app/leads', current: false },
      { filter: 'mine', label: 'Mine', count: 7, href: '/app/leads?filter=mine', current: true },
    ]);
    expect(vm.scopeText).toBe('Counts include all pages.');
  });

  it('Leads: an unreadable count stays null and the sentence never invents a number', () => {
    const vm = leadFilters({ all: 120, mine: null }, 'all');
    expect(vm.chips.map((c) => c.count)).toEqual([120, null]);
    expect(vm.scopeText).toBe('Counts include all pages.');
    expect(vm.scopeText).not.toMatch(/\d/);
  });

  it('Deals: All / Owned / Assigned, keep the order, reset the page, name the scope', () => {
    const vm = dealFilters({ all: 230, owned: 12, assigned: null }, 'owned', 'id_asc');
    expect(vm.chips).toEqual([
      { filter: 'all', label: 'All deals you can see', count: 230, href: '/app/deals?sort=id_asc', current: false },
      { filter: 'owned', label: 'Owned by you', count: 12, href: '/app/deals?sort=id_asc&filter=owned', current: true },
      { filter: 'assigned', label: 'Assigned to you', count: null, href: '/app/deals?sort=id_asc&filter=assigned', current: false },
    ]);
    expect(vm.scopeText).toBe('Counts include all pages.');
  });
});

describe('freshness from the rows shown', () => {
  it('oldest last-checked time and anyLate; unknown for no Bitrix rows or a missing value', () => {
    expect(listFreshness([])).toEqual({ state: 'unknown' });
    expect(listFreshness([{ bitrix: false, late: false }])).toEqual({ state: 'unknown' });
    expect(
      listFreshness([
        { bitrix: true, lastCheckedAt: '2026-10-19T11:00:00Z', late: false },
        { bitrix: true, lastCheckedAt: '2026-10-17T08:00:00Z', late: true },
        { bitrix: false, late: false },
      ]),
    ).toEqual({ state: 'known', oldestCheckedAt: '2026-10-17T08:00:00Z', anyLate: true });
    expect(listFreshness([{ bitrix: true, lastCheckedAt: '2026-10-19T11:00:00Z', late: false }, { bitrix: true, lastCheckedAt: null, late: false }])).toEqual({ state: 'unknown' });
    expect(listFreshness([{ bitrix: true, lastCheckedAt: 'not a time', late: false }])).toEqual({ state: 'unknown' });
  });

  it('Deals freshness leaves test records out; Leads freshness counts every row', () => {
    const bitrixRow = toDealListRow(deal, BITRIX_NAMES_OFF);
    const testRow = toDealListRow({ ...deal, id: 'd2', source: undefined }, BITRIX_NAMES_OFF);
    expect(dealsFreshness([bitrixRow, testRow])).toEqual({ state: 'known', oldestCheckedAt: '2026-10-19T11:00:00Z', anyLate: false });
    expect(dealsFreshness([testRow])).toEqual({ state: 'unknown' });
    const row = toLeadListRow(viewer(), lead, { branchNames: new Map(), names: BITRIX_NAMES_OFF, ownerNames: new Map() }, NOW);
    expect(leadsFreshness([row])).toEqual({ state: 'known', oldestCheckedAt: '2026-10-19T11:00:00Z', anyLate: false });
  });
});

describe('Bitrix names (B1-1, Off by default)', () => {
  it('switched off and unreadable keep the code and never a name', () => {
    expect(bitrixName(BITRIX_NAMES_OFF, 'STATUS', 'NEW')).toEqual({ code: 'NEW', name: null, labelState: 'switched_off' });
    expect(bitrixName({ state: 'list_unreadable' }, 'STATUS', 'NEW')).toEqual({ code: 'NEW', name: null, labelState: 'list_unreadable' });
  });

  it('on: named, missing marked, unknown code not in list', () => {
    const names = new Map([
      [bitrixNameKey('STATUS', 'NEW'), { name: ' New enquiry ', missing: false }],
      [bitrixNameKey('DEAL_STAGE_2', 'C2:WON'), { name: 'Won - payment received', missing: true }],
    ]);
    const on = { state: 'on' as const, names };
    expect(bitrixName(on, 'STATUS', 'NEW')).toEqual({ code: 'NEW', name: 'New enquiry', labelState: 'named' });
    expect(bitrixName(on, 'DEAL_STAGE_2', 'C2:WON')).toEqual({ code: 'C2:WON', name: 'Won - payment received', labelState: 'named', noLongerInList: true });
    expect(bitrixName(on, 'SOURCE', 'NEW')).toEqual({ code: 'NEW', name: null, labelState: 'not_in_list' });
  });

  it('deal stage list follows the Bitrix pipeline prefix', () => {
    expect(dealStageEntity('WON')).toBe('DEAL_STAGE');
    expect(dealStageEntity('C2:WON')).toBe('DEAL_STAGE_2');
    expect(dealStageEntity('C:WON')).toBe('DEAL_STAGE');
  });
});

describe('owner (DEC-52: owner name only)', () => {
  it('you / waiting / colleague with or without a name', () => {
    expect(recordOwner(ME, ME, 'Me')).toEqual({ kind: 'you' });
    expect(recordOwner(null, ME, 'x')).toEqual({ kind: 'waiting' });
    expect(recordOwner(OTHER, ME, ' Asha Rao ')).toEqual({ kind: 'colleague', displayName: 'Asha Rao' });
    expect(recordOwner(OTHER, ME, '  ')).toEqual({ kind: 'colleague' });
    expect(recordOwner(OTHER, ME)).toEqual({ kind: 'colleague' });
  });
});

describe('rows', () => {
  it('Lead row: header, names, owner and details only; no contact, portal or ids of people', () => {
    const row = toLeadListRow(
      viewer([['del', 'manager']]),
      { ...lead, owner_user_id: OTHER, last_verified_at: null },
      { branchNames: new Map([['del', 'Delhi']]), names: BITRIX_NAMES_OFF, ownerNames: new Map([[OTHER, 'Asha Rao']]) },
      NOW,
    );
    expect(row).toEqual({
      id: lead.id,
      reference: 'BXL-501',
      title: 'Goa family trip',
      status: { code: 'NEW', name: null, labelState: 'switched_off' },
      source: { code: 'WEBFORM', name: null, labelState: 'switched_off' },
      owner: { kind: 'colleague', displayName: 'Asha Rao' },
      branchName: 'Delhi',
      createdInBitrixAt: '2026-10-04T05:00:00Z',
      late: false,
      details: { sourceLeadId: '501', lastCheckedAt: '2026-10-19T10:00:00Z', relation: 'branch_manager' },
    });
    expect(JSON.stringify(row)).not.toMatch(/phone|email|comment|amount|portal|₹|a0000000/i);
  });

  it('Lead row: unreadable branch shows "Not shown"; late when verification is old', () => {
    const row = toLeadListRow(viewer(), { ...lead, last_verified_at: '2026-10-10T00:00:00Z' }, { branchNames: new Map(), names: BITRIX_NAMES_OFF, ownerNames: new Map() }, NOW);
    expect(row).toMatchObject({ branchName: 'Not shown', late: true, owner: { kind: 'you' }, details: { relation: 'owner' } });
  });

  it('Deal row: stage from the name map, details from the source, no money', () => {
    const row = toDealListRow({ ...deal, ownerName: 'Synthetic Owner' }, BITRIX_NAMES_OFF);
    expect(row).toEqual({
      id: 'd1',
      reference: 'BX-9',
      title: 'Synthetic Kerala trip',
      branchName: 'Delhi',
      owner: { kind: 'colleague', displayName: 'Synthetic Owner' },
      stage: { code: 'C2:WON', name: null, labelState: 'switched_off' },
      testRecord: false,
      late: false,
      details: {
        relation: 'scope',
        createdOn: '1 Oct 2026',
        sourceDealId: '9',
        lastCheckedAt: '2026-10-19T11:00:00Z',
        lastChangeAt: '2026-10-19T09:00:00Z',
      },
    });
    expect(JSON.stringify(row)).not.toMatch(/₹|selling|margin|paise/i);
  });

  it('Deal row: test record without source; owner from relation', () => {
    const row = toDealListRow({ ...deal, source: undefined, relation: 'owner', ownerName: 'Me' }, BITRIX_NAMES_OFF);
    expect(row).toEqual({
      id: 'd1',
      reference: 'BX-9',
      title: 'Synthetic Kerala trip',
      branchName: 'Delhi',
      owner: { kind: 'you' },
      testRecord: true,
      late: false,
      details: { relation: 'owner', createdOn: '1 Oct 2026' },
    });
    expect(toDealListRow({ ...deal, relation: 'waiting' }, BITRIX_NAMES_OFF).owner).toEqual({ kind: 'waiting' });
    expect(toDealListRow({ ...deal, relation: 'assigned' }, BITRIX_NAMES_OFF).owner).toEqual({ kind: 'colleague' });
  });
});
