import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Voice-note batch: import, hotel search and destination trip-type actions
 * with a fake RPC client. Role picks the one company; the file is read and
 * refused here before anything is staged; the database stages, compares and
 * applies under the caller's session; search words never reach a URL.
 * Synthetic data only.
 */

const requireStaff = vi.fn();
const rpc = vi.fn();
vi.mock('@/modules/identity/server/session', () => ({ requireStaff: () => requireStaff() }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const imports = await import('@/modules/parties/server/import-actions');
const hotels = await import('@/modules/hotels/server/hotel-actions');
const destinations = await import('@/app/app/admin/integration/destination-actions');

const USER = 'a0000000-0000-4000-8000-000000000001';
const E1 = 'e0000000-0000-4000-8000-000000000001';
const BATCH = '66666666-6666-4666-8666-666666666666';
const HOTEL = '55555555-5555-4555-8555-555555555555';
const REQUEST = '77777777-7777-4777-8777-777777777777';

type RpcReply = { data?: unknown; error?: { code: string; message: string; hint?: string } | null };
function rpcReplies(map: Record<string, RpcReply | RpcReply[]>) {
  const queues = Object.fromEntries(Object.entries(map).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  rpc.mockImplementation(async (fn: string) => {
    const queue = queues[fn];
    if (!queue || queue.length === 0) throw new Error(`unexpected rpc ${fn}`);
    const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
    return { data: reply.data ?? null, error: reply.error ?? null };
  });
}
const sent = (fn: string) => rpc.mock.calls.find((c) => c[0] === fn)?.[1] as Record<string, unknown> | undefined;
const as = (roles: string[]) =>
  requireStaff.mockResolvedValue({ userId: USER, supabase: { rpc }, access: { userId: USER, memberships: roles.map((roleCode) => ({ legalEntityId: E1, branchId: 'b', roleCode })), rolePermissions: [], grants: [] } });

const BRANCH = 'b0000000-0000-4000-8000-000000000001';
const HASH = 'f'.repeat(64);

/** A customer upload goes to the chosen branch (Echo-A M1); pass branch null to post no choice. */
function upload(text: string, name = 'list.csv', kind = 'customer', branch: { scope: string; id?: string } | null = { scope: 'branch', id: BRANCH }): FormData {
  const fd = new FormData();
  fd.set('kind', kind);
  fd.set('requestId', REQUEST);
  if (kind === 'customer' && branch) {
    fd.set('branchScope', branch.scope);
    fd.set('branchId', branch.id ?? '');
  }
  fd.set('file', new File([new TextEncoder().encode(text)], name, { type: 'text/csv' }));
  return fd;
}

const batch = (over: Record<string, unknown> = {}) => ({
  batchId: BATCH, kind: 'customer', status: 'validated', rowVersion: 2, fileName: 'list.csv', branchId: null, branchName: null, uploadedByName: 'Test Accounts',
  createdAt: '2026-10-24T09:00:00Z', validatedAt: '2026-10-24T09:00:01Z', appliedAt: null, appliedByName: null, applyResult: null, rows: 2,
  valid: 1, invalid: 1, duplicatesInFile: 0, possibleDuplicates: 0, proposed: { create: 1, update: 0, unchanged: 0, skippedChecked: 0 },
  columns: [], invalidRows: [{ rowNo: 2, reasons: ['postal_code_invalid'] }], duplicateRows: [], proposalHash: HASH, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  as(['accounts']);
});

const CSV = 'Customer ID,Type,Name,PIN,Mood\r\nT-1,personal,Test One,110001,x\r\nT-2,personal,Test Two,012345,y\r\n';

describe('validateImportAction', () => {
  it('Accounts: reads the CSV, stages mapped rows only, and returns the summary; nothing is applied', async () => {
    rpcReplies({
      import_batch_stage: { data: { batchId: BATCH, rowCount: 2, outcome: 'created' } },
      import_batch_validate: { data: batch() },
      import_batch_get: { data: { batch: batch(), rows: [{ rowNo: 1, sourceRef: 'T-1', name: 'Test One', outcome: 'create', reasons: [], warnings: [], targetId: null }], hasMore: false } },
    });
    const r = await imports.validateImportAction(null, upload(CSV));
    expect(r).toMatchObject({ ok: true, message: 'File checked. Nothing is imported until you choose Import.' });
    const stage = sent('import_batch_stage')!;
    expect(stage).toMatchObject({ p_legal_entity_id: E1, p_kind: 'customer', p_branch_id: BRANCH, p_entity_wide: false, p_file_name: 'list.csv', p_request_id: REQUEST });
    expect(stage.p_rows).toEqual([
      { sourceRef: 'T-1', partyType: 'personal', name: 'Test One', postalCode: '110001' },
      { sourceRef: 'T-2', partyType: 'personal', name: 'Test Two', postalCode: '012345' },
    ]);
    expect(String(stage.p_sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(rpc.mock.calls.some((c) => c[0] === 'import_batch_apply')).toBe(false);
    if (!r.ok) throw new Error();
    expect(r.data.summary).toMatchObject({
      batchId: BATCH,
      counts: { rows: 2, valid: 1, invalid: 1, creates: 1 },
      invalidRows: [{ rowNo: 2, reasons: ['PIN code must be six digits and not start with 0.'] }],
      proposed: [{ rowNo: 1, action: 'create', name: 'Test One', changes: [] }],
      applyBlockedReason: null,
      rowVersion: 2,
      proposalHash: HASH,
    });
    expect(r.data.summary.mapping.find((m) => m.column === 'Mood')).toEqual({ column: 'Mood', field: null });
  });
  it('Echo-A M1: a customer import needs a branch, or the whole company chosen explicitly', async () => {
    expect(await imports.validateImportAction(null, upload(CSV, 'list.csv', 'customer', null))).toMatchObject({ ok: false, fields: ['branchId'], message: expect.stringMatching(/Choose the branch/) });
    expect(await imports.validateImportAction(null, upload(CSV, 'list.csv', 'customer', { scope: 'branch', id: 'nope' }))).toMatchObject({ ok: false, fields: ['branchId'] });
    expect(rpc).not.toHaveBeenCalled();
    rpcReplies({
      import_batch_stage: { data: { batchId: BATCH, rowCount: 2, outcome: 'created' } },
      import_batch_validate: { data: batch({ branchId: null, entityWide: true }) },
      import_batch_get: { data: { batch: batch(), rows: [], hasMore: false } },
    });
    const r = await imports.validateImportAction(null, upload(CSV, 'list.csv', 'customer', { scope: 'company' }));
    expect(sent('import_batch_stage')).toMatchObject({ p_branch_id: null, p_entity_wide: true });
    expect(r.ok && r.data.summary.branchName).toBeNull();
    // Hotels never carry a branch.
    as(['super_admin']);
    rpc.mockClear();
    rpcReplies({
      import_batch_stage: { data: { batchId: BATCH, rowCount: 1, outcome: 'created' } },
      import_batch_validate: { data: batch({ kind: 'hotel' }) },
      import_batch_get: { data: { batch: batch({ kind: 'hotel' }), rows: [], hasMore: false } },
    });
    await imports.validateImportAction(null, upload('Hotel name,City\nTest Stay,Goa\n', 'h.csv', 'hotel'));
    expect(sent('import_batch_stage')).toMatchObject({ p_branch_id: null, p_entity_wide: false });
  });
  it('refuses the wrong role, Purchase, two companies, broken and formula files before staging', async () => {
    as(['super_admin']);
    expect(await imports.validateImportAction(null, upload(CSV))).toMatchObject({ ok: false, code: 'not_authorized', message: 'Only Accounts can import the customer list.' });
    as(['accounts', 'purchase']);
    expect(await imports.validateImportAction(null, upload(CSV))).toMatchObject({ ok: false, code: 'not_authorized' });
    as(['accounts']);
    expect(await imports.validateImportAction(null, upload('Name,Type\n"open,personal\n'))).toMatchObject({ ok: false, fields: ['file'], message: expect.stringMatching(/never closed/) });
    expect(await imports.validateImportAction(null, upload('Type,Name\npersonal,"=cmd()"\n'))).toMatchObject({ ok: false, message: expect.stringMatching(/start like a spreadsheet formula.*row 1/) });
    expect(await imports.validateImportAction(null, upload('Name\nTest\n'))).toMatchObject({ ok: false, message: expect.stringMatching(/Add a column for: Type/) });
    expect(await imports.validateImportAction(null, upload(CSV, 'list.xlsx'))).toMatchObject({ ok: false, fields: ['file'] });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('explicit column choices map an unknown column; a choice for a column not in the file is refused', async () => {
    rpcReplies({
      import_batch_stage: { data: { batchId: BATCH, rowCount: 1, outcome: 'created' } },
      import_batch_validate: { data: batch() },
      import_batch_get: { data: { batch: batch(), rows: [], hasMore: false } },
    });
    const fd = upload('Kind,Party\npersonal,Test One\n');
    fd.append('column', 'Kind');
    fd.append('columnField', 'partyType');
    fd.append('column', 'Party');
    fd.append('columnField', 'name');
    expect(await imports.validateImportAction(null, fd)).toMatchObject({ ok: true });
    expect(sent('import_batch_stage')!.p_rows).toEqual([{ partyType: 'personal', name: 'Test One' }]);
  });
});

describe('applyImportAction', () => {
  const apply = (reason: string, shown: { version?: string; hash?: string } = { version: '2', hash: HASH }) => {
    const fd = new FormData();
    fd.set('batchId', BATCH);
    fd.set('requestId', REQUEST);
    fd.set('reason', reason);
    if (shown.version !== undefined) fd.set('batchRowVersion', shown.version);
    if (shown.hash !== undefined) fd.set('proposalHash', shown.hash);
    return fd;
  };
  it('needs a reason; applies with the batch row version; says imported records are Not checked', async () => {
    expect(await imports.applyImportAction(null, apply('short'))).toMatchObject({ ok: false, fields: ['reason'] });
    rpcReplies({
      import_batch_get: { data: { batch: batch(), rows: [], hasMore: false } },
      import_batch_apply: { data: { batchId: BATCH, status: 'applied', created: 1, updated: 0, unchanged: 0, skippedChecked: 0, invalid: 1 } },
    });
    const r = await imports.applyImportAction(null, apply('First customer list from the owner'));
    expect(r).toMatchObject({ ok: true, data: { applied: { creates: 1, updates: 0 } }, message: expect.stringMatching(/1 row was left out.*Not checked/) });
    expect(sent('import_batch_apply')).toEqual({ p_batch_id: BATCH, p_expected_row_version: 2, p_reason: 'First customer list from the owner', p_proposal_hash: HASH });
  });
  it('Echo-A L3: applies the version the screen showed (not the current one); no shown version = check again', async () => {
    rpcReplies({
      import_batch_get: { data: { batch: batch({ rowVersion: 3 }), rows: [], hasMore: false } },
      import_batch_apply: { error: { code: '40001', message: 'version_changed' } },
    });
    expect(await imports.applyImportAction(null, apply('First customer list from the owner', { version: '2', hash: HASH }))).toMatchObject({ ok: false, code: 'version_changed' });
    expect(sent('import_batch_apply')).toMatchObject({ p_expected_row_version: 2, p_proposal_hash: HASH });
    rpc.mockClear();
    expect(await imports.applyImportAction(null, apply('First customer list from the owner', {}))).toMatchObject({ ok: false, fields: ['batchRowVersion'] });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('a hotel batch needs a Super Admin; stale rows are refused in words', async () => {
    rpcReplies({ import_batch_get: { data: { batch: batch({ kind: 'hotel' }), rows: [], hasMore: false } } });
    expect(await imports.applyImportAction(null, apply('First hotel list from the owner'))).toMatchObject({ ok: false, code: 'not_authorized', message: 'Only a Super Admin can import the hotel list.' });
    rpcReplies({ import_batch_get: { data: { batch: batch(), rows: [], hasMore: false } }, import_batch_apply: { error: { code: '40001', message: 'import_stale' } } });
    expect(await imports.applyImportAction(null, apply('First customer list from the owner'))).toMatchObject({ ok: false, message: expect.stringMatching(/Check the file again/) });
  });
});

describe('hotel search', () => {
  it('type-ahead under the own session; short words search nothing; category in words', async () => {
    expect(await hotels.searchHotelsAction('a')).toEqual({ ok: true, items: [], more: false });
    rpcReplies({ hotel_catalogue_search: { data: { items: [{ id: HOTEL, name: 'Test Lake View', city: 'Udaipur', area: null, address: null, starCategory: '4', verification: 'not_checked' }], hasMore: true } } });
    expect(await hotels.searchHotelsAction(' lake ', { city: 'Udaipur' })).toEqual({ ok: true, more: true, items: [{ hotelId: HOTEL, name: 'Test Lake View', city: 'Udaipur', area: null, category: '4 star' }] });
    expect(sent('hotel_catalogue_search')).toMatchObject({ p_query: 'lake', p_city: 'Udaipur', p_limit: 20 });
    rpcReplies({ hotel_catalogue_search: { error: { code: 'XX000', message: 'boom' } } });
    expect(await hotels.searchHotelsAction('lake')).toEqual({ ok: false, message: expect.stringMatching(/Type the hotel name instead/) });
  });
});

describe('destination trip type', () => {
  const set = (over: Record<string, string> = {}) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries({ optionId: '101', listId: 'DEAL_DESTINATION', scope: 'international', reason: 'Bitrix option is Dubai', rowVersion: '0', requestId: REQUEST, ...over })) fd.set(k, v);
    return fd;
  };
  it('sends list, option, scope, row version and reason; clearing sends null', async () => {
    rpcReplies({ bitrix_destination_scope_set: { data: { changed: true, scope: 'international', rowVersion: 1 } } });
    expect(await destinations.setDestinationScopeAction(null, set())).toMatchObject({ ok: true, message: 'Trip type saved: International.' });
    expect(sent('bitrix_destination_scope_set')).toMatchObject({ p_list_id: 'DEAL_DESTINATION', p_option_id: '101', p_scope: 'international', p_expected_row_version: 0, p_reason: 'Bitrix option is Dubai' });
    rpc.mockClear();
    rpcReplies({ bitrix_destination_scope_set: { data: { changed: true, scope: null, rowVersion: 2 } } });
    await destinations.setDestinationScopeAction(null, set({ scope: '', rowVersion: '1' }));
    expect(sent('bitrix_destination_scope_set')!.p_scope).toBeNull();
  });
  it('a missing reason or an unknown list is refused before the database; a non-Super Admin is refused by it', async () => {
    expect(await destinations.setDestinationScopeAction(null, set({ reason: 'short' }))).toMatchObject({ ok: false, fields: ['reason'] });
    expect(await destinations.setDestinationScopeAction(null, set({ listId: 'OTHER' }))).toMatchObject({ ok: false, fields: ['listId'] });
    expect(rpc).not.toHaveBeenCalled();
    rpcReplies({ bitrix_destination_scope_set: { error: { code: '42501', message: 'not_authorized' } } });
    expect(await destinations.setDestinationScopeAction(null, set())).toMatchObject({ ok: false, code: 'not_authorized' });
  });
});
