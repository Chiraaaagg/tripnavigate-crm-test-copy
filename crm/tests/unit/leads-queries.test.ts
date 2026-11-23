import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewerAccess } from '@/modules/access/policy';
import { LEAD_PAGE_SIZE, loadLead, loadLeads, NO_PERMISSION } from '@/modules/leads/server/queries';

/*
 * Lead-screens contract §1 and batch-1-backend-contract §3: session-client
 * reads, refusal mapping, Purchase short-circuit, true offset pages ordered by
 * Bitrix lead number, "Mine" filter and exact chip counts.
 */

const ID = '11111111-1111-4111-8111-111111111111';
const E = 'entity-a';
const row = {
  id: ID,
  reference: 'BXL-501',
  title: 'Goa family trip',
  branch_id: 'del',
  owner_user_id: 'sales-b',
  source_lead_id: 501,
  source_status_id: 'NEW',
  source_id_code: 'WEBFORM',
  source_created_at: '2026-10-04T05:00:00Z',
  last_synced_at: '2026-10-05T10:00:00Z',
  last_verified_at: '2026-10-05T10:00:00Z',
  source_portal: 'example.bitrix24.in',
};

/** Every crm_leads call: [method, args] in order. */
let leadCalls: Array<Array<[string, unknown[]]>> = [];
const listResult = vi.fn();
const countResult = vi.fn();
const oneResult = vi.fn();
const branches = vi.fn();
const profile = vi.fn();

function leadsChain() {
  const ops: Array<[string, unknown[]]> = [];
  leadCalls.push(ops);
  let head = false;
  let filter: unknown = null;
  const chain: Record<string, unknown> = {};
  chain.select = (...args: unknown[]) => {
    ops.push(['select', args]);
    head = (args[1] as { head?: boolean } | undefined)?.head === true;
    return chain;
  };
  chain.eq = (...args: unknown[]) => {
    ops.push(['eq', args]);
    filter = args[1];
    return chain;
  };
  chain.order = (...args: unknown[]) => {
    ops.push(['order', args]);
    return chain;
  };
  chain.range = (...args: unknown[]) => {
    ops.push(['range', args]);
    return listResult(...args);
  };
  chain.maybeSingle = () => oneResult();
  chain.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
    if (!head) return Promise.reject(new Error('list read without range')).then(resolve, reject);
    return Promise.resolve(countResult(filter)).then(resolve, reject);
  };
  return chain;
}

const from = vi.fn((table: string) => {
  if (table === 'crm_leads') return leadsChain();
  if (table === 'branches') return { select: () => branches() };
  if (table === 'staff_profiles') return { select: () => ({ eq: () => ({ maybeSingle: () => profile() }) }) };
  throw new Error(`unexpected table ${table}`);
});
const rpc = vi.fn();

function staffWith(memberships: Array<[string, string]>, userId = 'mgr') {
  const access: ViewerAccess = {
    userId,
    memberships: memberships.map(([branchId, roleCode]) => ({ legalEntityId: E, branchId, roleCode })),
    rolePermissions: [],
    grants: [],
  };
  return { userId, displayName: 'Me', access, supabase: { from, rpc } } as never;
}

const listCalls = () => leadCalls.filter((ops) => ops.some(([m]) => m === 'range'));
const countCalls = () => leadCalls.filter((ops) => !ops.some(([m]) => m === 'range') && ops.some(([m, a]) => m === 'select' && (a[1] as { head?: boolean } | undefined)?.head));

beforeEach(() => {
  vi.clearAllMocks();
  leadCalls = [];
  listResult.mockResolvedValue({ data: [row], error: null });
  countResult.mockImplementation((filter: unknown) => ({ data: null, error: null, count: filter === null ? 120 : 7 }));
  oneResult.mockResolvedValue({ data: row, error: null });
  branches.mockResolvedValue({ data: [{ id: 'del', name: 'Delhi' }], error: null });
  profile.mockResolvedValue({ data: { display_name: 'Asha Rao' }, error: null });
  // Batch 1 reads: the name map answers "switched off" (its default) and no owner names are returned.
  rpc.mockImplementation((fn: string) =>
    Promise.resolve(
      fn === 'bitrix_name_map'
        ? { data: { enabled: false, readAt: null, names: [] }, error: null }
        : { data: [], error: null },
    ),
  );
});

describe('lead loaders', () => {
  it('Purchase (alone or with Sales) and role-less viewers get the marker without any query', async () => {
    for (const s of [
      staffWith([['del', 'purchase']]),
      staffWith([['del', 'purchase'], ['del', 'sales']]),
      staffWith([]),
    ]) {
      await expect(loadLeads(s)).resolves.toBe(NO_PERMISSION);
      await expect(loadLeads(s, { filter: 'mine', page: 3 })).resolves.toBe(NO_PERMISSION);
      await expect(loadLead(s, ID)).resolves.toBe(NO_PERMISSION);
    }
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('maps visible rows to list rows with branch names, exact chip counts and the filter total', async () => {
    const leads = await loadLeads(staffWith([['del', 'manager']]));
    expect(leads).toEqual({
      items: [
        {
          id: ID,
          reference: 'BXL-501',
          title: 'Goa family trip',
          status: { code: 'NEW', name: null, labelState: 'switched_off' },
          source: { code: 'WEBFORM', name: null, labelState: 'switched_off' },
          owner: { kind: 'colleague' },
          branchName: 'Delhi',
          createdInBitrixAt: '2026-10-04T05:00:00Z',
          late: expect.any(Boolean),
          details: { sourceLeadId: '501', lastCheckedAt: '2026-10-05T10:00:00Z', relation: 'branch_manager' },
        },
      ],
      filter: 'all',
      page: 1,
      pageSize: LEAD_PAGE_SIZE,
      total: 120,
      counts: { all: 120, mine: 7 },
    });
    expect(JSON.stringify(leads)).not.toMatch(/portal|sales-b|phone|email/i);
  });

  it('true pagination: one range read ordered by Bitrix lead number (highest first), id breaks ties', async () => {
    const staff = staffWith([['del', 'manager']]);
    await loadLeads(staff, { page: 2 });
    const [list] = listCalls();
    expect(list).toEqual([
      ['select', [expect.stringContaining('source_lead_id')]],
      ['order', ['source_lead_id', { ascending: false }]],
      ['order', ['id']],
      ['range', [LEAD_PAGE_SIZE, 2 * LEAD_PAGE_SIZE - 1]],
    ]);
    expect(listCalls()).toHaveLength(1);
    // Two exact head counts (All and Mine), read with the page; never an id list.
    expect(countCalls()).toEqual([
      [['select', ['id', { count: 'exact', head: true }]]],
      [['select', ['id', { count: 'exact', head: true }]], ['eq', ['owner_user_id', 'mgr']]],
    ]);
  });

  it('"Mine" filters rows by owner and its total is the Mine count', async () => {
    const staff = staffWith([['del', 'sales']], 'sales-b');
    const leads = await loadLeads(staff, { filter: 'mine' });
    expect(listCalls()[0]).toContainEqual(['eq', ['owner_user_id', 'sales-b']]);
    expect(leads).toMatchObject({ filter: 'mine', total: 7, counts: { all: 120, mine: 7 }, items: [{ owner: { kind: 'you' } }] });
  });

  it('a page beyond the end shows the last page of the filter (one re-read)', async () => {
    const staff = staffWith([['del', 'manager']]);
    const leads = await loadLeads(staff, { page: 99 });
    expect(leads).toMatchObject({ page: 3, total: 120 });
    expect(listCalls().map((ops) => ops.find(([m]) => m === 'range'))).toEqual([
      ['range', [98 * LEAD_PAGE_SIZE, 99 * LEAD_PAGE_SIZE - 1]],
      ['range', [2 * LEAD_PAGE_SIZE, 3 * LEAD_PAGE_SIZE - 1]],
    ]);
    countResult.mockReturnValue({ data: null, error: null, count: 0 });
    await expect(loadLeads(staff, { page: 4 })).resolves.toMatchObject({ page: 1, total: 0, counts: { all: 0, mine: 0 } });
  });

  it('a failed count is null (never 0) and the page still shows', async () => {
    countResult.mockImplementation((filter: unknown) => (filter === null ? { data: null, error: { code: 'XX000' }, count: null } : { data: null, error: null, count: 7 }));
    const leads = await loadLeads(staffWith([['del', 'manager']]), { page: 5 });
    expect(leads).toMatchObject({ total: null, counts: { all: null, mine: 7 }, page: 5 });
    expect(listCalls()).toHaveLength(1);
  });

  it('page size is bounded; an empty list is honest', async () => {
    listResult.mockResolvedValue({ data: [], error: null });
    countResult.mockReturnValue({ data: null, error: null, count: 0 });
    await expect(loadLeads(staffWith([['del', 'manager']]))).resolves.toMatchObject({ items: [], total: 0, page: 1 });
    expect(LEAD_PAGE_SIZE).toBeLessThanOrEqual(200);
  });

  it('detail resolves owner name, or null when the profile is unreadable', async () => {
    await expect(loadLead(staffWith([['del', 'manager']]), ID)).resolves.toMatchObject({ ownerName: 'Asha Rao' });
    profile.mockResolvedValue({ data: null, error: { code: '42501' } });
    await expect(loadLead(staffWith([['del', 'manager']]), ID)).resolves.toMatchObject({ ownerName: null });
    oneResult.mockResolvedValue({ data: { ...row, owner_user_id: 'sales-a' }, error: null });
    await expect(loadLead(staffWith([['del', 'sales']], 'sales-a'), ID)).resolves.toMatchObject({
      ownerName: 'Me',
      relation: 'owner',
    });
  });

  it('detail names a colleague owner through the record-owner read when the profile is unreadable (DEC-52)', async () => {
    const owner = '00000000-0000-4000-8000-00000000000b';
    oneResult.mockResolvedValue({ data: { ...row, owner_user_id: owner }, error: null });
    profile.mockResolvedValue({ data: null, error: { code: '42501' } });
    rpc.mockImplementation((fn: string, args?: Record<string, unknown>) =>
      Promise.resolve(
        fn === 'record_staff_names'
          ? { data: [{ userId: owner, displayName: 'Synthetic Owner' }], error: null }
          : { data: { enabled: false, readAt: null, names: [] }, error: null },
      ).then((r) => (fn === 'record_staff_names' ? (expect(args).toEqual({ p_user_ids: [owner] }), r) : r)),
    );
    await expect(loadLead(staffWith([['del', 'manager']]), ID)).resolves.toMatchObject({ ownerName: 'Synthetic Owner', ownerState: 'assigned' });
    // A failed name read leaves no name, never an error.
    rpc.mockImplementation(() => Promise.resolve({ data: null, error: { code: '42883' } }));
    await expect(loadLead(staffWith([['del', 'manager']]), ID)).resolves.toMatchObject({ ownerName: null });
  });

  it('detail marks a Lead without an owner as waiting, never naming anyone', async () => {
    oneResult.mockResolvedValue({ data: { ...row, owner_user_id: null }, error: null });
    const lead = await loadLead(staffWith([['del', 'manager']]), ID);
    expect(lead).toMatchObject({ ownerState: 'waiting', ownerName: null });
    oneResult.mockResolvedValue({ data: { ...row, owner_user_id: 'sales-a' }, error: null });
    await expect(loadLead(staffWith([['del', 'manager']]), ID)).resolves.toMatchObject({ ownerState: 'assigned' });
  });

  it('malformed, unknown and refused ids are the same null', async () => {
    const s = staffWith([['del', 'sales']]);
    await expect(loadLead(s, 'not-a-uuid')).resolves.toBeNull();
    expect(from).not.toHaveBeenCalled();
    oneResult.mockResolvedValue({ data: null, error: null });
    await expect(loadLead(s, ID)).resolves.toBeNull();
    oneResult.mockResolvedValue({ data: null, error: { code: '42501', message: 'not_authorized' } });
    await expect(loadLead(s, ID)).resolves.toBeNull();
  });

  it('list refusal shows no permission; unexplained errors throw; unreadable branches show "Not shown"', async () => {
    const s = staffWith([['del', 'sales']]);
    listResult.mockResolvedValue({ data: null, error: { code: '42501' } });
    await expect(loadLeads(s)).resolves.toBe(NO_PERMISSION);
    listResult.mockResolvedValue({ data: null, error: { code: 'XX000' } });
    await expect(loadLeads(s)).rejects.toThrow('Could not load leads');
    oneResult.mockResolvedValue({ data: null, error: { code: 'XX000' } });
    await expect(loadLead(s, ID)).rejects.toThrow('Could not load the lead');

    listResult.mockResolvedValue({ data: [row], error: null });
    branches.mockResolvedValue({ data: null, error: { code: '42501' } });
    await expect(loadLeads(s)).resolves.toMatchObject({ items: [{ branchName: 'Not shown' }], total: 120 });
  });
});
