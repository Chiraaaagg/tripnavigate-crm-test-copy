import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewerAccess } from '@/modules/access/policy';
import { SEARCH_FIELD } from '@/modules/search/contracts';

/*
 * Batch 5 search actions (contracts.md §E; Terra). Fake session client and a
 * mocked crm_search wrapper (Atlas's runCrmSearch; its own parsing is tested
 * by Atlas). Checks: authorization first, too short, not installed, not
 * authorized, ids mapped to list rows through the existing list reads in
 * search order, the Show more cursor, and that the words never appear in a
 * message, a thrown error or a log line.
 */

const requireStaff = vi.fn();
const runCrmSearch = vi.fn();

vi.mock('server-only', () => ({}));
vi.mock('@/modules/identity/server/session', () => ({
  requireStaff: () => requireStaff(),
  visibleBranches: (supabase: { from: (t: string) => { select: (c: string) => unknown } }) => supabase.from('branches').select('id, name, is_head_office'),
}));
vi.mock('@/modules/search/server/crm-search', () => ({ runCrmSearch: (...a: unknown[]) => runCrmSearch(...a) }));

const actions = await import('@/modules/search/server/actions');

const E = 'entity-hc';
const ME = 'a0000000-0000-4000-8000-000000000001';
const OTHER = 'a0000000-0000-4000-8000-000000000002';
const L1 = '10000000-0000-4000-8000-000000000001';
const L2 = '10000000-0000-4000-8000-000000000002';
const L3 = '10000000-0000-4000-8000-000000000003';
const D1 = '20000000-0000-4000-8000-000000000001';
const D2 = '20000000-0000-4000-8000-000000000002';
const SECRET_WORDS = 'Zebra Honeymoon Kovalam';

const lead = (id: string, n: number, owner: string | null) => ({
  id,
  reference: `BXL-${n}`,
  title: `Synthetic lead ${n}`,
  branch_id: 'jdh',
  owner_user_id: owner,
  source_lead_id: n,
  source_status_id: 'NEW',
  source_id_code: 'WEBFORM',
  source_created_at: '2026-10-04T05:00:00Z',
  last_synced_at: '2026-10-22T10:00:00Z',
  last_verified_at: '2026-10-22T10:00:00Z',
  source_portal: 'example.bitrix24.in',
});

const deal = (id: string, n: number, owner: string | null) => ({
  id,
  legal_entity_id: E,
  branch_id: 'jdh',
  reference: `BX-${n}`,
  title: `Synthetic deal ${n}`,
  owner_user_id: owner,
  created_at: '2026-10-01T00:00:00Z',
  source_system: 'bitrix',
  source_deal_id: n,
  source_stage_id: 'C1:WON',
  last_synced_at: '2026-10-22T10:00:00Z',
  last_verified_at: '2026-10-22T10:00:00Z',
  deal_assignments: [{ deal_id: id, user_id: ME, assignment_kind: 'sales' }],
  owner: owner === ME ? { display_name: 'Synthetic Me' } : null,
});

/** Every Data API call: table and the chained operations. */
let calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = [];
let leadRows: unknown[] = [];
let dealRows: unknown[] = [];
let leadError: { code?: string } | null = null;
let dealError: { code?: string } | null = null;
const rpc = vi.fn();

function from(table: string) {
  const entry = { table, ops: [] as Array<[string, unknown[]]> };
  calls.push(entry);
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'is', 'or', 'order', 'range']) {
    chain[m] = (...args: unknown[]) => {
      entry.ops.push([m, args]);
      return chain;
    };
  }
  chain.then = (resolve: (v: unknown) => void) => {
    if (table === 'crm_leads') return resolve({ data: leadError ? null : leadRows, error: leadError });
    if (table === 'deals') return resolve({ data: dealError ? null : dealRows, error: dealError });
    if (table === 'branches') return resolve({ data: [{ id: 'jdh', name: 'Jodhpur', is_head_office: false }], error: null });
    return resolve({ data: [], error: null });
  };
  return chain;
}

function staffWith(roles: string[], userId = ME) {
  const access: ViewerAccess = {
    userId,
    memberships: roles.map((roleCode) => ({ legalEntityId: E, branchId: 'jdh', roleCode })),
    rolePermissions: [{ roleCode: 'sales', permissionCode: 'deal.read', scope: 'own' }],
    grants: [],
  };
  return { userId, displayName: 'Synthetic Me', email: 'me@example.test', memberships: [], access, supabase: { from, rpc } };
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const hits = (kind: 'lead' | 'deal', ids: string[]) => ids.map((id, i) => ({ kind, id, reference: `${kind === 'lead' ? 'BXL' : 'BX'}-${i}` }));
const okOutcome = (query: string, kind: 'lead' | 'deal', ids: string[], nextAfter: string | null = null) => ({
  ok: true,
  query,
  page: { hits: hits(kind, ids), nextAfter },
  titlesSearched: query.length >= 3,
});

beforeEach(() => {
  vi.clearAllMocks();
  calls = [];
  leadRows = [];
  dealRows = [];
  leadError = null;
  dealError = null;
  requireStaff.mockResolvedValue(staffWith(['sales']));
  // Batch 1 reads: the name map answers "switched off"; owner names come from record_staff_names.
  rpc.mockImplementation((fn: string) =>
    Promise.resolve(
      fn === 'bitrix_name_map'
        ? { data: { enabled: false, readAt: null, names: [] }, error: null }
        : fn === 'record_staff_names'
          ? { data: [{ userId: OTHER, displayName: 'Synthetic Other' }], error: null }
          : { data: null, error: null },
    ),
  );
});

describe('searchLeadsAction / searchDealsAction: refusals before the database', () => {
  it('runs requireStaff first (a signed-out caller never reaches the search)', async () => {
    requireStaff.mockRejectedValue(new Error('NEXT_REDIRECT'));
    await expect(actions.searchLeadsAction(form({ [SEARCH_FIELD.query]: 'BXL-1' }))).rejects.toThrow('NEXT_REDIRECT');
    await expect(actions.searchDealsAction(form({ [SEARCH_FIELD.query]: 'BX-1' }))).rejects.toThrow('NEXT_REDIRECT');
    expect(runCrmSearch).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it.each([[''], [' '], ['a'], ['  b  '], ['\t\n'], ['😀'], [' 𝔸 ']])('too short (%j; counted in characters, not UTF-16 units): too_short, no database call', async (q) => {
    const lead = await actions.searchLeadsAction(form({ [SEARCH_FIELD.query]: q }));
    const deal = await actions.searchDealsAction(form({ [SEARCH_FIELD.query]: q }));
    expect(lead).toMatchObject({ ok: false, kind: 'lead', code: 'too_short' });
    expect(deal).toMatchObject({ ok: false, kind: 'deal', code: 'too_short' });
    expect(runCrmSearch).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a missing query field is too_short', async () => {
    await expect(actions.searchDealsAction(new FormData())).resolves.toMatchObject({ ok: false, code: 'too_short', query: '' });
  });

  it('Purchase (alone, or with Sales) gets not_authorized on Leads without any query; the words are kept', async () => {
    for (const roles of [['purchase'], ['purchase', 'sales'], []]) {
      requireStaff.mockResolvedValue(staffWith(roles));
      const result = await actions.searchLeadsAction(form({ [SEARCH_FIELD.query]: '  BXL-12  ' }));
      expect(result).toMatchObject({ ok: false, kind: 'lead', code: 'not_authorized', query: 'BXL-12' });
    }
    expect(runCrmSearch).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('Purchase may search Deals (the Deals list is open to every staff member; the database scopes rows)', async () => {
    requireStaff.mockResolvedValue(staffWith(['purchase']));
    runCrmSearch.mockResolvedValue(okOutcome('BX-1', 'deal', []));
    await expect(actions.searchDealsAction(form({ [SEARCH_FIELD.query]: 'BX-1' }))).resolves.toMatchObject({ ok: true, rows: [] });
  });
});

describe('wrapper refusals map to the screen codes', () => {
  it.each([['not_installed'], ['not_authorized'], ['unexpected'], ['too_short']] as const)('%s passes through with the words kept', async (code) => {
    runCrmSearch.mockResolvedValue({ ok: false, query: 'Goa trip', code });
    const lead = await actions.searchLeadsAction(form({ [SEARCH_FIELD.query]: 'Goa   trip' }));
    const deal = await actions.searchDealsAction(form({ [SEARCH_FIELD.query]: 'Goa trip' }));
    expect(lead).toMatchObject({ ok: false, kind: 'lead', code, query: 'Goa trip' });
    expect(deal).toMatchObject({ ok: false, kind: 'deal', code, query: 'Goa trip' });
    expect(typeof (lead as { message: string }).message).toBe('string');
    // The list reads never run after a refusal.
    expect(calls).toHaveLength(0);
  });

  it('calls the wrapper with the caller session, its own kind, the raw words and the posted cursor', async () => {
    const staff = staffWith(['sales']);
    requireStaff.mockResolvedValue(staff);
    runCrmSearch.mockResolvedValue(okOutcome('BX-4', 'deal', []));
    await actions.searchDealsAction(form({ [SEARCH_FIELD.query]: 'BX-4', [SEARCH_FIELD.kind]: 'lead', [SEARCH_FIELD.after]: 'opaque-cursor' }));
    expect(runCrmSearch).toHaveBeenCalledWith(staff, 'deal', 'BX-4', 'opaque-cursor');
    runCrmSearch.mockResolvedValue(okOutcome('BXL-4', 'lead', []));
    await actions.searchLeadsAction(form({ [SEARCH_FIELD.query]: 'BXL-4', [SEARCH_FIELD.kind]: 'deal' }));
    expect(runCrmSearch).toHaveBeenLastCalledWith(staff, 'lead', 'BXL-4', null);
  });
});

describe('found ids become list rows through the existing list reads', () => {
  it('Leads: same columns and mapper, rows in search order, a hit no longer visible is dropped', async () => {
    runCrmSearch.mockResolvedValue(okOutcome('Synthetic', 'lead', [L3, L1, L2], 'cursor-2'));
    // The database returns rows in its own order and without L2 (no longer visible).
    leadRows = [lead(L1, 101, ME), lead(L3, 303, OTHER)];
    const result = await actions.searchLeadsAction(form({ [SEARCH_FIELD.query]: 'Synthetic' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.map((r) => r.id)).toEqual([L3, L1]);
    expect(result.rows[0]).toMatchObject({ reference: 'BXL-303', title: 'Synthetic lead 303', branchName: 'Jodhpur' });
    expect(result.rows[0]!.owner).toEqual({ kind: 'colleague', displayName: 'Synthetic Other' });
    expect(result).toMatchObject({ kind: 'lead', query: 'Synthetic', nextAfter: 'cursor-2', titlesSearched: true });
    const read = calls.find((c) => c.table === 'crm_leads')!;
    expect(read.ops).toContainEqual(['select', ['id, reference, title, branch_id, owner_user_id, source_lead_id, source_status_id, source_id_code, source_created_at, last_synced_at, last_verified_at, source_portal']]);
    expect(read.ops).toContainEqual(['in', ['id', [L3, L1, L2]]]);
  });

  it('Deals: same list read (columns, embeds, active assignments), toDealListRow, search order kept', async () => {
    runCrmSearch.mockResolvedValue(okOutcome('BX-2', 'deal', [D2, D1], null));
    dealRows = [deal(D1, 1, ME), deal(D2, 2, OTHER)];
    const result = await actions.searchDealsAction(form({ [SEARCH_FIELD.query]: 'BX-2' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.map((r) => r.reference)).toEqual(['BX-2', 'BX-1']);
    expect(result.rows[1]).toMatchObject({ title: 'Synthetic deal 1', branchName: 'Jodhpur', testRecord: false });
    expect(result).toMatchObject({ kind: 'deal', nextAfter: null, titlesSearched: true });
    const read = calls.find((c) => c.table === 'deals')!;
    const select = read.ops.find(([m]) => m === 'select')![1][0] as string;
    expect(select).toContain('deal_assignments(deal_id, user_id, assignment_kind)');
    expect(select).toContain('owner:staff_profiles!deals_owner_user_id_fkey(display_name)');
    expect(select).not.toMatch(/selling|margin|paise|commercial/);
    expect(read.ops).toContainEqual(['is', ['deal_assignments.ended_at', null]]);
    expect(read.ops).toContainEqual(['in', ['id', [D2, D1]]]);
  });

  it('no hits: ok with no rows and no list read', async () => {
    runCrmSearch.mockResolvedValue(okOutcome('zz', 'deal', []));
    const result = await actions.searchDealsAction(form({ [SEARCH_FIELD.query]: 'zz' }));
    expect(result).toMatchObject({ ok: true, rows: [], nextAfter: null, titlesSearched: false });
    expect(calls.filter((c) => c.table === 'deals')).toHaveLength(0);
  });

  it('Show more: the posted cursor reaches the wrapper and the next cursor comes back unchanged', async () => {
    runCrmSearch.mockResolvedValue(okOutcome('Synthetic', 'lead', [L2], 'cursor-3'));
    leadRows = [lead(L2, 202, ME)];
    const result = await actions.searchLeadsAction(form({ [SEARCH_FIELD.query]: 'Synthetic', [SEARCH_FIELD.after]: 'cursor-2' }));
    expect(runCrmSearch).toHaveBeenCalledWith(expect.anything(), 'lead', 'Synthetic', 'cursor-2');
    expect(result).toMatchObject({ ok: true, nextAfter: 'cursor-3' });
    if (result.ok) expect(result.rows.map((r) => r.id)).toEqual([L2]);
  });

  it('a refused list read (42501) is not_authorized; any other failure is unexpected, never "no results"', async () => {
    runCrmSearch.mockResolvedValue(okOutcome('Synthetic', 'lead', [L1]));
    leadError = { code: '42501' };
    await expect(actions.searchLeadsAction(form({ [SEARCH_FIELD.query]: 'Synthetic' }))).resolves.toMatchObject({ ok: false, code: 'not_authorized' });
    leadError = { code: '57014' };
    await expect(actions.searchLeadsAction(form({ [SEARCH_FIELD.query]: 'Synthetic' }))).resolves.toMatchObject({ ok: false, code: 'unexpected' });
    runCrmSearch.mockResolvedValue(okOutcome('BX-1', 'deal', [D1]));
    dealError = { code: 'XX000' };
    await expect(actions.searchDealsAction(form({ [SEARCH_FIELD.query]: 'BX-1' }))).resolves.toMatchObject({ ok: false, code: 'unexpected' });
  });
});

describe('privacy: the words never leave in a message, an error or a log line', () => {
  it('no refusal message and no console output contains the words', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const outcomes = [
      { ok: false, query: SECRET_WORDS, code: 'not_installed' },
      { ok: false, query: SECRET_WORDS, code: 'unexpected' },
      okOutcome(SECRET_WORDS, 'lead', [L1]),
    ];
    leadError = { code: '57014' };
    dealError = { code: 'XX000' };
    const results = [];
    for (const outcome of outcomes) {
      runCrmSearch.mockResolvedValue(outcome);
      results.push(await actions.searchLeadsAction(form({ [SEARCH_FIELD.query]: SECRET_WORDS })));
      runCrmSearch.mockResolvedValue({ ...outcome, page: { hits: hits('deal', [D1]), nextAfter: null } });
      results.push(await actions.searchDealsAction(form({ [SEARCH_FIELD.query]: SECRET_WORDS })));
    }
    requireStaff.mockResolvedValue(staffWith(['purchase']));
    results.push(await actions.searchLeadsAction(form({ [SEARCH_FIELD.query]: SECRET_WORDS })));
    for (const r of results) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message).not.toMatch(/Zebra|Honeymoon|Kovalam/i);
        // The words come back only in `query`, for the box of the person who typed them.
        expect(r.query).toBe(SECRET_WORDS);
      }
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    for (const spy of spies) spy.mockRestore();
  });

  it('a failing list read does not throw out of the action (no error text with the words reaches the framework log)', async () => {
    runCrmSearch.mockResolvedValue(okOutcome(SECRET_WORDS, 'deal', [D1]));
    dealError = { code: 'XX000' };
    await expect(actions.searchDealsAction(form({ [SEARCH_FIELD.query]: SECRET_WORDS }))).resolves.toMatchObject({ ok: false });
  });
});
