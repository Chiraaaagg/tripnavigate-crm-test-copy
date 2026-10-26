import { describe, expect, it } from 'vitest';
import {
  countDealFilters,
  countMyDeals,
  countVisibleDeals,
  listVisibleDeals,
  loadDealsPage,
  PAGE_SIZE,
  parsePage,
  parseSort,
} from '@/modules/deals/server/queries';
import { dealsHref } from '@/views/staff-views';

/**
 * Deals list paging (server side, RLS decides the rows). A fake Data API
 * client records the calls; the real RLS semantics are in tests/db.
 */

const VIEWER = 'a0000000-0000-4000-8000-000000000007';

function fakeStaff(total: number) {
  const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];
  const deals = Array.from({ length: total }, (_, i) => ({
    id: `d${String(i).padStart(4, '0')}`,
    legal_entity_id: 'e1',
    branch_id: 'b1',
    reference: `BX-${i}`,
    title: `Synthetic ${i}`,
    owner_user_id: i % 3 === 0 ? null : VIEWER,
    created_at: '2026-10-01T00:00:00Z',
  }));
  const from = (table: string) => {
    const entry = { table, ops: [] as Array<[string, unknown[]]> };
    calls.push(entry);
    let range: [number, number] | null = null;
    let head = false;
    const chain: Record<string, unknown> = {};
    for (const m of ['eq', 'in', 'is', 'or', 'order']) {
      chain[m] = (...args: unknown[]) => {
        entry.ops.push([m, args]);
        return chain;
      };
    }
    chain.select = (...args: unknown[]) => {
      entry.ops.push(['select', args]);
      head = (args[1] as { head?: boolean } | undefined)?.head === true;
      return chain;
    };
    chain.range = (a: number, b: number) => {
      entry.ops.push(['range', [a, b]]);
      range = [a, b];
      return chain;
    };
    chain.then = (resolve: (v: unknown) => void) => {
      if (table === 'deals' && head) return resolve({ data: null, error: null, count: total });
      if (table === 'deals') return resolve({ data: range ? deals.slice(range[0], range[1] + 1) : deals, error: null });
      if (table === 'branches') return resolve({ data: [{ id: 'b1', name: 'Delhi' }], error: null });
      return resolve({ data: [], error: null });
    };
    return chain;
  };
  const staff = {
    userId: VIEWER,
    access: { userId: VIEWER, memberships: [], rolePermissions: [], grants: [] },
    supabase: { from },
  } as never;
  return { staff, calls };
}

describe('deals paging', () => {
  it('the total is a real count, not the length of a page', async () => {
    const { staff } = fakeStaff(1_234);
    expect(await countVisibleDeals(staff)).toBe(1_234);
  });

  it('reads one page of 50 by range with a stable order, and only that page’s assignments', async () => {
    const { staff, calls } = fakeStaff(230);
    const page = await listVisibleDeals(staff, 3, 230);
    expect(page).toMatchObject({ page: 3, pageSize: PAGE_SIZE, offset: 100 });
    expect(page.items).toHaveLength(50);
    expect(page.items[0]!.reference).toBe('BX-100');
    const dealsCall = calls.find((c) => c.table === 'deals')!;
    expect(dealsCall.ops).toContainEqual(['range', [100, 149]]);
    // Bitrix deal ID, highest first (never sync time); id breaks ties.
    expect(dealsCall.ops.filter(([m]) => m === 'order')).toEqual([
      ['order', ['source_deal_id', { ascending: false, nullsFirst: false }]],
      ['order', ['id']],
    ]);
    expect(page.sort).toBe('id_desc');
    // Speed plan C3: the page's active assignments and owner names are embedded in the same
    // read (RLS applies to embedded rows too); there is no separate assignments or owners call.
    const select = dealsCall.ops.find(([m]) => m === 'select')![1][0] as string;
    expect(select).toContain('deal_assignments(deal_id, user_id, assignment_kind)');
    expect(select).toContain('owner:staff_profiles!deals_owner_user_id_fkey(display_name)');
    expect(dealsCall.ops).toContainEqual(['is', ['deal_assignments.ended_at', null]]);
    expect(calls.map((c) => c.table).sort()).toEqual(['branches', 'deals']);
  });

  it('uses the embedded assignments and owner names for relation and owner name', async () => {
    const { staff } = fakeStaff(0);
    const row = {
      id: 'd1', legal_entity_id: 'e1', branch_id: 'b1', reference: 'BX-1', title: 'Synthetic', owner_user_id: 'u-other',
      created_at: '2026-10-01T00:00:00Z',
      deal_assignments: [{ deal_id: 'd1', user_id: VIEWER, assignment_kind: 'visa' }],
      owner: { display_name: 'Synthetic Owner' },
    };
    const supabase = (staff as unknown as { supabase: { from: (t: string) => Record<string, unknown> } }).supabase;
    const original = supabase.from;
    supabase.from = (table: string) => {
      const chain = original(table);
      if (table === 'deals') chain.then = (resolve: (v: unknown) => void) => resolve({ data: [row], error: null });
      return chain;
    };
    const page = await listVisibleDeals(staff, 1, 1);
    expect(page.items[0]).toMatchObject({ relation: 'assigned', ownerName: 'Synthetic Owner', branchName: 'Delhi' });
  });

  it('loadDealsPage reads the count and the page together and clamps a page beyond the end', async () => {
    const { staff, calls } = fakeStaff(230);
    const { total, list } = await loadDealsPage(staff, 99);
    expect(total).toBe(230);
    expect(list).toMatchObject({ page: 5, offset: 200 });
    expect(list.items).toHaveLength(30);
    // shared count + two chip counts + first page read + one re-read of the last page
    expect(calls.filter((c) => c.table === 'deals')).toHaveLength(5);
    expect(calls.filter((c) => c.table === 'deals' && c.ops.some(([m]) => m === 'range'))).toHaveLength(2);
    const inRange = await loadDealsPage(fakeStaff(230).staff, 2);
    expect(inRange.list).toMatchObject({ page: 2, offset: 50 });
  });

  it('a page beyond the end shows the last page; the last page is short', async () => {
    const { staff } = fakeStaff(230);
    const last = await listVisibleDeals(staff, 99, 230);
    expect(last).toMatchObject({ page: 5, offset: 200 });
    expect(last.items).toHaveLength(30);
  });

  it('the Deal ID ↑ toggle sorts ascending in the database query', async () => {
    const { staff, calls } = fakeStaff(10);
    const page = await listVisibleDeals(staff, 1, 10, 'id_asc');
    expect(page.sort).toBe('id_asc');
    expect(calls.find((c) => c.table === 'deals')!.ops).toContainEqual(['order', ['source_deal_id', { ascending: true, nullsFirst: false }]]);
  });

  it('the order is kept in the URL across pages; default URLs stay clean', () => {
    expect(parseSort('id_asc')).toBe('id_asc');
    for (const other of [undefined, '', 'id_desc', 'last_synced', ['id_asc']]) expect(parseSort(other)).toBe('id_desc');
    expect(dealsHref(1)).toBe('/app/deals');
    expect(dealsHref(3)).toBe('/app/deals?page=3');
    expect(dealsHref(1, 'id_asc')).toBe('/app/deals?sort=id_asc');
    expect(dealsHref(2, 'id_asc')).toBe('/app/deals?sort=id_asc&page=2');
  });

  it('parsePage accepts 1-based integers only', () => {
    expect(parsePage('4')).toBe(4);
    for (const bad of [undefined, '', '0', '-1', 'abc', '1.5', ['2']]) expect(parsePage(bad)).toBe(1);
  });
});

describe('home deal counters', () => {
  it('counts assigned-not-owned deals with one exact head query (no id list)', async () => {
    const { staff, calls } = fakeStaff(7);
    const counts = await countMyDeals(staff);
    expect(counts).toEqual({ visible: 7, owned: 7, assigned: 7 });
    const dealCalls = calls.filter((c) => c.table === 'deals');
    expect(calls.every((c) => c.table === 'deals')).toBe(true);
    const assigned = dealCalls.find((c) => c.ops.some(([m]) => m === 'or'));
    expect(assigned?.ops).toEqual([
      ['select', ['id, deal_assignments!inner(deal_id)', { count: 'exact', head: true }]],
      ['eq', ['deal_assignments.user_id', VIEWER]],
      ['is', ['deal_assignments.ended_at', null]],
      ['or', [`owner_user_id.is.null,owner_user_id.neq.${VIEWER}`]],
    ]);
    expect(dealCalls.some((c) => c.ops.some(([m]) => m === 'range'))).toBe(false);
  });
});

describe('deals list filters (Batch 1 chips)', () => {
  const ranged = (calls: ReturnType<typeof fakeStaff>['calls']) => calls.filter((c) => c.table === 'deals' && c.ops.some(([m]) => m === 'range'));

  it('All: no filter on the rows; total is countVisibleDeals; chip counts come from the Home queries', async () => {
    const { staff, calls } = fakeStaff(230);
    const result = await loadDealsPage(staff, 1);
    expect(result).toMatchObject({ filter: 'all', total: 230, counts: { all: 230, owned: 230, assigned: 230 } });
    const [rows] = ranged(calls);
    expect(rows!.ops.filter(([m]) => m === 'eq' || m === 'or')).toEqual([]);
    // the shared count stays one plain head count (Home and the Bitrix sync page use it too)
    expect(calls.filter((c) => c.table === 'deals' && c.ops.length === 1)).toEqual([
      { table: 'deals', ops: [['select', ['id', { count: 'exact', head: true }]]] },
    ]);
  });

  it('Owned: rows filtered by owner, same predicate as the owned count', async () => {
    const { staff, calls } = fakeStaff(30);
    const result = await loadDealsPage(staff, 1, 'id_desc', 'owned');
    expect(result.filter).toBe('owned');
    const [rows] = ranged(calls);
    expect(rows!.ops).toContainEqual(['eq', ['owner_user_id', VIEWER]]);
    expect(rows!.ops.find(([m]) => m === 'select')![1][0]).not.toContain('mine:');
    const ownedCount = calls.find((c) => c.table === 'deals' && !c.ops.some(([m]) => m === 'range') && c.ops.some(([m, a]) => m === 'eq' && a[0] === 'owner_user_id'));
    expect(ownedCount?.ops).toEqual([
      ['select', ['id', { count: 'exact', head: true }]],
      ['eq', ['owner_user_id', VIEWER]],
    ]);
  });

  it('Assigned: aliased inner embed of the viewer’s active assignment, owner not the viewer; relation embed kept', async () => {
    const { staff, calls } = fakeStaff(30);
    await listVisibleDeals(staff, 1, 30, 'id_asc', 'assigned');
    const [rows] = ranged(calls);
    const select = rows!.ops.find(([m]) => m === 'select')![1][0] as string;
    expect(select).toContain('deal_assignments(deal_id, user_id, assignment_kind)');
    expect(select).toContain('mine:deal_assignments!inner(deal_id)');
    expect(rows!.ops).toEqual(
      expect.arrayContaining([
        ['is', ['deal_assignments.ended_at', null]],
        ['eq', ['mine.user_id', VIEWER]],
        ['is', ['mine.ended_at', null]],
        ['or', [`owner_user_id.is.null,owner_user_id.neq.${VIEWER}`]],
        ['order', ['source_deal_id', { ascending: true, nullsFirst: false }]],
      ]),
    );
  });

  it('the page clamps to the filter’s own total', async () => {
    const { staff } = fakeStaff(60);
    const result = await loadDealsPage(staff, 9, 'id_desc', 'assigned');
    expect(result).toMatchObject({ total: 60, list: { page: 2, offset: 50 } });
  });

  it('a failed chip count is null, never 0; the shared count failing still fails the page', async () => {
    const { staff } = fakeStaff(10);
    const supabase = (staff as unknown as { supabase: { from: (t: string) => Record<string, unknown> } }).supabase;
    const original = supabase.from;
    supabase.from = (table: string) => {
      const chain = original(table);
      const or = chain.or as (...a: unknown[]) => Record<string, unknown>;
      chain.or = (...args: unknown[]) => {
        const next = or(...args);
        next.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: { code: 'XX000' }, count: null });
        return next;
      };
      return chain;
    };
    expect(await countDealFilters(staff)).toEqual({ owned: 10, assigned: null });
    const result = await loadDealsPage(staff, 1, 'id_desc', 'owned');
    expect(result.counts).toEqual({ all: 10, owned: 10, assigned: null });

    // Only the shared count (a plain head count with no filter) fails.
    const { staff: failing, calls } = fakeStaff(10);
    const sb = (failing as unknown as { supabase: { from: (t: string) => Record<string, unknown> } }).supabase;
    const base = sb.from;
    sb.from = (table: string) => {
      const chain = base(table);
      const entry = calls[calls.length - 1]!;
      const then = chain.then as (resolve: (v: unknown) => void) => void;
      chain.then = (resolve: (v: unknown) => void) =>
        entry.ops.length === 1 && entry.ops[0]![1][0] === 'id' ? resolve({ data: null, error: { code: 'XX000' }, count: null }) : then(resolve);
      return chain;
    };
    await expect(loadDealsPage(failing as never, 1)).rejects.toThrow('Could not count deals.');
  });
});
