import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Voice-note batch: stored customer actions with a fake RPC client. Session
 * first; own-session commands only; search words never leave the action
 * body; a document is checked before anything is written and stored only
 * after the database chose its path; Accounts check/return with reasons;
 * Bill To picks a stored customer (snapshot via the database) and then saves
 * the typed edits. Synthetic ids and names only.
 */

const requireStaff = vi.fn();
const rpc = vi.fn();
const upload = vi.fn();

vi.mock('@/modules/identity/server/session', () => ({ requireStaff: () => requireStaff() }));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: () => ({ storage: { from: () => ({ upload: (...a: unknown[]) => upload(...a) }) } }) }));

const parties = await import('@/modules/parties/server/party-actions');
const checks = await import('@/modules/parties/server/party-check-actions');
const bookForm = await import('@/modules/fulfilment/server/book-form-actions');
const { derivedRequestId } = await import('@/modules/parties/server/party-results');

const USER = 'a0000000-0000-4000-8000-000000000001';
const DEAL = 'd0000000-0000-4000-8000-000000000001';
const VERSION = '11111111-1111-4111-8111-111111111111';
const PARTY = '22222222-2222-4222-8222-222222222222';
const FILE = '44444444-4444-4444-8444-444444444444';
const REQUEST = '77777777-7777-4777-8777-777777777777';
const HASH = 'c'.repeat(64);

function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach((x) => fd.append(k, x));
    else fd.set(k, v);
  }
  return fd;
}
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

beforeEach(() => {
  vi.clearAllMocks();
  requireStaff.mockResolvedValue({ userId: USER, supabase: { rpc }, access: { userId: USER, memberships: [], rolePermissions: [], grants: [] } });
});

const record = (over: Record<string, unknown> = {}) => ({
  id: PARTY, partyType: 'business', name: 'Test Traders', contactPerson: 'Test Contact', phone: '9876500001', email: null,
  addressLine1: '1 Test Market', addressLine2: null, city: 'Jodhpur', stateCode: '08', postalCode: '342001',
  gstStatus: 'registered', gstin: '08AAAAA0000A1Z5', gstReason: null, checkStatus: 'not_checked', checkReason: null, checkedByName: null, checkedAt: null,
  sourceRef: null, branchId: null, branchName: null, rowVersion: 3, createdByName: 'Test Sales', createdAt: '2026-10-24T09:00:00Z', updatedAt: '2026-10-24T09:00:00Z',
  documents: [], canEdit: true, canAccountsEdit: false, canCheck: false, ...over,
});

describe('search', () => {
  it('short words search nothing; hits are summaries only (one search, no per-hit reads)', async () => {
    expect(await parties.searchPartiesAction(DEAL, 'a')).toEqual({ ok: true, items: [], more: false });
    expect(rpc).not.toHaveBeenCalled();
    rpcReplies({
      customer_party_search: { data: { items: [{ id: PARTY, partyType: 'business', name: 'Test Traders', city: 'Jodhpur', stateCode: '08', gstin: null, checkStatus: 'not_checked', branchName: null }], hasMore: true } },
    });
    const r = await parties.searchPartiesAction(DEAL, ' test  tra ');
    expect(sent('customer_party_search')).toMatchObject({ p_query: 'test tra', p_deal_id: DEAL, p_limit: 20 });
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['customer_party_search']);
    expect(r).toEqual({ ok: true, more: true, items: [expect.objectContaining({ partyId: PARTY, name: 'Test Traders', city: 'Jodhpur', checkStatus: 'not_checked' })] });
  });
  it('the picked customer is read in full once; an unreadable one is "not available"', async () => {
    rpcReplies({ customer_party_get: { data: record() } });
    expect(await parties.pickPartyAction(PARTY)).toEqual({ ok: true, party: expect.objectContaining({ partyId: PARTY, addressLine1: '1 Test Market', postalCode: '342001', gstStatus: 'registered' }) });
    expect(sent('customer_party_get')).toEqual({ p_party_id: PARTY });
    rpcReplies({ customer_party_get: { data: null } });
    expect(await parties.pickPartyAction(PARTY)).toEqual({ ok: false, message: expect.stringMatching(/cannot be opened right now/) });
    rpc.mockClear();
    expect(await parties.pickPartyAction('not-a-uuid')).toMatchObject({ ok: false });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('a failed search says so in words (never a database message)', async () => {
    rpcReplies({ customer_party_search: { error: { code: '42501', message: 'not_authorized' } } });
    expect(await parties.searchPartiesAction(DEAL, 'test')).toEqual({ ok: false, message: expect.stringMatching(/cannot be searched right now/) });
  });
});

describe('Add customer', () => {
  const personal = { dealId: DEAL, requestId: REQUEST, partyType: 'personal', name: 'Test Person', phone: '9876500002', addressLine1: '2 Test Lane', city: 'Delhi', stateCode: '07', postalCode: '110001' };
  const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])], 'id.png', { type: 'image/png' });

  it('creates a Not checked customer under the own session and returns it', async () => {
    rpcReplies({ customer_party_create: { data: { partyId: PARTY, rowVersion: 1, checkStatus: 'not_checked', outcome: 'created' } }, customer_party_get: { data: record({ partyType: 'personal', contactPerson: null, gstStatus: null, gstin: null }) } });
    const r = await parties.createPartyAction(null, form(personal));
    expect(r).toMatchObject({ ok: true, data: { party: { partyId: PARTY, checkStatus: 'not_checked' } }, message: expect.stringMatching(/Accounts checks new customers/) });
    expect(Object.keys(sent('customer_party_create')!.p_fields as object)).not.toContain('checkStatus');
  });
  it('an ID file needs consent; it is refused before anything is written', async () => {
    const fd = form(personal);
    fd.set('idFile', png());
    expect(await parties.createPartyAction(null, fd)).toMatchObject({ ok: false, code: 'consent_required', fields: ['idConsent'] });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('with consent: begun under own session, stored by the privileged client at the database path, finished', async () => {
    const fd = form({ ...personal, idConsent: 'on' });
    fd.set('idFile', png());
    rpcReplies({
      customer_party_create: { data: { partyId: PARTY, rowVersion: 1, checkStatus: 'not_checked', outcome: 'created' } },
      customer_party_document_begin: { data: { fileId: FILE, outcome: 'created', status: 'pending_upload', rowVersion: 1, objectPath: `x/${FILE}` } },
      customer_party_document_finish: { data: { fileId: FILE, status: 'stored', rowVersion: 2 } },
      customer_party_get: { data: record({ partyType: 'personal' }) },
    });
    upload.mockResolvedValue({ error: null });
    expect(await parties.createPartyAction(null, fd)).toMatchObject({ ok: true });
    expect(sent('customer_party_document_begin')).toMatchObject({ p_party_id: PARTY, p_kind: 'id_proof', p_consent: true, p_request_id: derivedRequestId(REQUEST, 'doc-0') });
    expect(upload).toHaveBeenCalledWith(`x/${FILE}`, expect.any(Uint8Array), { contentType: 'image/png', upsert: false });
  });
  it('a failed upload keeps the customer and says which file was not attached', async () => {
    const fd = form({ ...personal, idConsent: 'on' });
    fd.set('idFile', png());
    rpcReplies({
      customer_party_create: { data: { partyId: PARTY, rowVersion: 1, checkStatus: 'not_checked', outcome: 'created' } },
      customer_party_document_begin: { data: { fileId: FILE, outcome: 'created', status: 'pending_upload', rowVersion: 1, objectPath: `x/${FILE}` } },
      customer_party_document_finish: { data: { fileId: FILE, status: 'failed', rowVersion: 2 } },
      customer_party_get: { data: record({ partyType: 'personal' }) },
    });
    upload.mockResolvedValue({ error: { message: 'boom' } });
    expect(await parties.createPartyAction(null, fd)).toMatchObject({ ok: true, message: expect.stringMatching(/The ID file could not be uploaded; the customer was added without it/) });
  });
  it('business without a GST answer is refused with the field; a database refusal maps hint keys', async () => {
    expect(await parties.createPartyAction(null, form({ ...personal, partyType: 'business' }))).toMatchObject({ ok: false, fields: ['gstStatus'] });
    rpcReplies({ customer_party_create: { error: { code: '22023', message: 'invalid_input', hint: 'postalCode' } } });
    expect(await parties.createPartyAction(null, form(personal))).toMatchObject({ ok: false, code: 'invalid_input', fields: ['postalCode'] });
  });
});

describe('Accounts check screen read', () => {
  it('history lines name actions, fields and reasons (never values); used-on links to the Accounts deal', async () => {
    const { loadPartyForCheck } = await import('@/modules/parties/server/party-check');
    rpcReplies({
      customer_party_get: {
        data: record({
          canAccountsEdit: true, canCheck: true, checkStatus: 'returned', checkReason: 'PIN does not match the city',
          history: [
            { action: 'party.returned', at: '2026-10-24T10:00:00Z', byName: 'Test Accounts', byYou: true, reason: 'PIN does not match the city', changedFields: [], previousStatus: 'not_checked' },
            { action: 'party.document_viewed', at: '2026-10-24T09:30:00Z', byName: 'Test Accounts', byYou: true, reason: null, changedFields: [], previousStatus: null },
            { action: 'party.updated', at: '2026-10-24T09:10:00Z', byName: 'Test Sales', byYou: false, reason: null, changedFields: ['postalCode', 'addressLine1'], previousStatus: null },
            { action: 'party.created', at: '2026-10-24T09:00:00Z', byName: 'Test Sales', byYou: false, reason: null, changedFields: ['name', 'phone', 'gstin'], previousStatus: null },
          ],
          usedOn: [{ dealId: '99999999-9999-4999-8999-999999999999', reference: 'SYN-1', title: 'Test deal', branchName: null, copiedAt: '2026-10-24T09:00:00Z' }],
        }),
      },
    });
    const loaded = await loadPartyForCheck({ supabase: { rpc } } as never, PARTY);
    expect(loaded?.party.history.map((h) => h.text)).toEqual(['Returned to Sales: PIN does not match the city', 'Details changed by Sales (PIN code, address)', 'Added']);
    expect(loaded?.party.usedOn).toEqual([{ reference: 'SYN-1', href: '/app/accounts/deals/99999999-9999-4999-8999-999999999999' }]);
    expect(loaded).toMatchObject({ canEdit: true, canCheck: true, party: { returnedReason: 'PIN does not match the city' } });
  });
});

describe('Accounts check', () => {
  const base = { partyId: PARTY, partyRowVersion: '3', requestId: REQUEST };
  it('check and return send the decision; return needs a reason of 10 to 500', async () => {
    rpcReplies({ customer_party_check: { data: { rowVersion: 4, checkStatus: 'checked', outcome: 'updated' } } });
    expect(await checks.checkPartyAction(null, form(base))).toMatchObject({ ok: true, data: { checkStatus: 'checked' } });
    expect(sent('customer_party_check')).toEqual({ p_party_id: PARTY, p_expected_row_version: 3, p_decision: 'checked', p_reason: null });
    rpc.mockClear();
    expect(await checks.returnPartyAction(null, form({ ...base, reason: 'short' }))).toMatchObject({ ok: false, fields: ['reason'] });
    expect(rpc).not.toHaveBeenCalled();
    rpcReplies({ customer_party_check: { data: { rowVersion: 4, checkStatus: 'returned', outcome: 'updated' } } });
    expect(await checks.returnPartyAction(null, form({ ...base, reason: 'PIN does not match the city' }))).toMatchObject({ ok: true, message: 'Customer returned with your reason.' });
  });
  it('an incomplete customer cannot be checked; the database names the fields', async () => {
    rpcReplies({ customer_party_check: { error: { code: '22023', message: 'party_incomplete', hint: 'gstStatus' } } });
    expect(await checks.checkPartyAction(null, form(base))).toMatchObject({ ok: false, fields: ['gstStatus'], message: expect.stringMatching(/missing billing details/) });
  });
  it('Accounts edit sends the fields and says the customer is Not checked again; a stale screen is refused', async () => {
    rpcReplies({ customer_party_accounts_save: { data: { rowVersion: 4, checkStatus: 'not_checked', outcome: 'updated' } } });
    const fields = { partyType: 'personal', name: 'Test Person', postalCode: '110001', stateCode: '07' };
    expect(await checks.saveCheckedPartyAction(null, form({ ...base, ...fields }))).toMatchObject({ ok: true, message: expect.stringMatching(/Not checked until you check it/) });
    rpcReplies({ customer_party_accounts_save: { error: { code: '40001', message: 'version_changed' } } });
    expect(await checks.saveCheckedPartyAction(null, form({ ...base, ...fields }))).toMatchObject({ ok: false, code: 'version_changed' });
  });
});

describe('Bill To with a stored customer', () => {
  const formGet = (partyId: string | null) => ({
    data: {
      dealId: DEAL, canEdit: true, canConfirm: true, serviceItemsEnabled: true,
      version: { versionId: VERSION, versionNo: 1, status: 'draft', rowVersion: 5, contentHash: HASH, formRules: 2 },
      contacts: null, billing: { status: 'draft', rowVersion: 2, partyId }, travellers: [], items: [], evidence: [],
      party: { total: 2, children: 0, infants: 0, adults: 2 }, itemFilesCanEdit: true,
    },
  });
  const bill = { dealId: DEAL, requestId: REQUEST, billingRowVersion: '2', billToType: 'business', billingName: 'Test Traders', contactPerson: 'Test Contact', billingPhone: '9876500001', addressLine1: '1 Test Market', billingCity: 'Jodhpur', stateCode: '08', postalCode: '342001', gstStatus: 'registered', gstin: '08AAAAA0000A1Z5' };
  it('a new pick: the database copies the customer (snapshot, reference kept), then the typed edits save on the new billing row version', async () => {
    rpcReplies({
      booking_form_get: formGet(null),
      booking_bill_to_select_party: { data: { rowVersion: 6, contentHash: HASH, partyId: PARTY, billing: { outcome: 'updated', status: 'draft', rowVersion: 3 } } },
      booking_billing_propose: { data: { outcome: 'updated', status: 'draft', rowVersion: 4 } },
    });
    expect(await bookForm.saveBillToAction(null, form({ ...bill, partyId: PARTY }))).toMatchObject({ ok: true });
    expect(sent('booking_bill_to_select_party')).toEqual({ p_version_id: VERSION, p_expected_row_version: 5, p_party_id: PARTY, p_billing_expected_row_version: 2, p_request_id: derivedRequestId(REQUEST, 'select-party') });
    expect(sent('booking_billing_propose')).toMatchObject({ p_expected_row_version: 3 });
  });
  it('the same customer again: no second copy; typed by hand: no copy at all', async () => {
    rpcReplies({ booking_form_get: formGet(PARTY), booking_billing_propose: { data: { outcome: 'updated', status: 'draft', rowVersion: 3 } } });
    await bookForm.saveBillToAction(null, form({ ...bill, partyId: PARTY }));
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['booking_form_get', 'booking_billing_propose']);
    rpcReplies({ booking_form_get: formGet(null), booking_billing_propose: { data: { outcome: 'updated', status: 'draft', rowVersion: 3 } } });
    rpc.mockClear();
    await bookForm.saveBillToAction(null, form({ ...bill, partyId: '' }));
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['booking_form_get', 'booking_billing_propose']);
  });
  it('a returned customer cannot be used; nothing on the step is saved', async () => {
    rpcReplies({ booking_form_get: formGet(null), booking_bill_to_select_party: { error: { code: '55000', message: 'party_returned' } } });
    const r = await bookForm.saveBillToAction(null, form({ ...bill, partyId: PARTY }));
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/Accounts returned this customer/) });
    expect(rpc.mock.calls.some((c) => c[0] === 'booking_billing_propose')).toBe(false);
  });
});
