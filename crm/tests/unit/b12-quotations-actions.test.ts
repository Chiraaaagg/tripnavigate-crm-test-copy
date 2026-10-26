import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QUOTATION_ERROR_TEXT, QUOTATION_TEXT } from '@/modules/quotations/contracts';

/**
 * Quotation server actions and loaders with a fake RPC client: session gate
 * first, one database command under the staff member's own session, exact
 * RPC arguments (money as decimal strings, counts as typed), refusals in
 * frozen words with fields/issues, conversion as ONE idempotent command,
 * Storage only after the database authorized, loaders answering null /
 * not_installed. Synthetic ids only.
 */

const requireStaff = vi.fn();
const rpc = vi.fn();
const upload = vi.fn();
const createSignedUrl = vi.fn();
const storageFrom = vi.fn();
const adminFactory = vi.fn();
const revalidatePath = vi.fn();

vi.mock('@/modules/identity/server/session', () => ({ requireStaff: () => requireStaff() }));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: () => adminFactory() }));
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
vi.mock('@/lib/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/config')>()),
  getAppConfig: () => ({ supabaseUrl: 'http://127.0.0.1:54321', supabasePublishableKey: 'sb_publishable_test' }),
}));

const actions = await import('@/modules/quotations/server/actions');
const money = await import('@/modules/quotations/server/money-actions');
const queries = await import('@/modules/quotations/server/queries');
const { quotationEvidenceDownloadResponse } = await import('@/modules/quotations/server/evidence-download');

const USER = 'f0000000-0000-4000-8000-000000000001';
const ENTITY = 'e0000000-0000-4000-8000-000000000001';
const DEAL = 'd0000000-0000-4000-8000-000000000001';
const Q = 'a1000000-0000-4000-8000-000000000001';
const V = 'a2000000-0000-4000-8000-000000000001';
const ITEM = 'a3000000-0000-4000-8000-000000000001';
const EV = 'a4000000-0000-4000-8000-000000000001';
const BV = 'b0000000-0000-4000-8000-000000000001';
const REQ = '77777777-7777-4777-8777-777777777777';
const HASH = 'e'.repeat(64);
const PATH = `${ENTITY}/${Q}/${V}/${EV}`;
const PDF = (() => {
  const b = new Uint8Array(128);
  b.set([0x25, 0x50, 0x44, 0x46, 0x2d]);
  return b;
})();

function form(fields: Record<string, string | string[] | Blob>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach((x) => fd.append(k, x));
    else fd.set(k, v);
  }
  return fd;
}

type RpcReply = { data?: unknown; error?: { code: string; message: string; hint?: string } | null; throws?: boolean };
function rpcReplies(map: Record<string, RpcReply | RpcReply[]>) {
  const queues = Object.fromEntries(Object.entries(map).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  rpc.mockImplementation(async (fn: string) => {
    const queue = queues[fn];
    if (!queue || queue.length === 0) throw new Error(`unexpected rpc ${fn}`);
    const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (reply.throws) throw new TypeError('fetch failed');
    return { data: reply.data ?? null, error: reply.error ?? null };
  });
}

const staff = { supabase: { rpc } } as never;

beforeEach(() => {
  vi.clearAllMocks();
  requireStaff.mockResolvedValue({ userId: USER, supabase: { rpc } });
  storageFrom.mockReturnValue({ upload, createSignedUrl });
  adminFactory.mockReturnValue({ storage: { from: storageFrom } });
  upload.mockResolvedValue({ data: { path: PATH }, error: null });
  createSignedUrl.mockResolvedValue({ data: { signedUrl: 'http://127.0.0.1:54321/storage/v1/object/sign/quotation-evidence/x?token=synthetic' }, error: null });
});

describe('session gate', () => {
  it.each([
    ['create', () => actions.createQuotationAction(null, form({ subjectKind: 'deal', subjectId: DEAL, title: 'x', requestId: REQ }))],
    ['convert', () => actions.convertQuotationAction(null, form({ versionId: V, contentHash: HASH, requestId: REQ }))],
    ['lines', () => money.saveQuotationLinesAction(null, form({ versionId: V, rowVersion: '1' }))],
    ['evidence', () => actions.uploadQuotationEvidenceAction(null, form({ versionId: V, evidenceKind: 'acceptance_message', file: new File([PDF], 'ok.pdf', { type: 'application/pdf' }) }))],
  ])('%s stops before any database or storage call', async (_n, run) => {
    requireStaff.mockRejectedValue(new Error('NEXT_REDIRECT /mfa/challenge'));
    await expect(run()).rejects.toThrow('NEXT_REDIRECT');
    expect(rpc).not.toHaveBeenCalled();
    expect(adminFactory).not.toHaveBeenCalled();
  });
});

describe('create, save, ready, send', () => {
  it('create under the user session; replay answers the same quotation', async () => {
    rpcReplies({ quotation_create: { data: { quotationId: Q, reference: 'TQ-12', versionId: V, versionNo: 1, rowVersion: 1, created: true } } });
    await expect(actions.createQuotationAction(null, form({ subjectKind: 'deal', subjectId: DEAL, title: 'Goa family', requestId: REQ, legalEntityId: ENTITY }))).resolves.toEqual({
      ok: true,
      data: { quotationId: Q, reference: 'TQ-12', versionId: V, versionNo: 1, rowVersion: 1, created: true },
      message: QUOTATION_TEXT.created,
    });
    expect(rpc).toHaveBeenCalledWith('quotation_create', { p_subject_kind: 'deal', p_subject_id: DEAL, p_title: 'Goa family', p_request_id: REQ });
  });

  it('details save sends every key of the form; refusals in frozen words with mapped fields', async () => {
    rpcReplies({ quotation_version_save: { data: { rowVersion: 4, status: 'draft' } } });
    const fd = form({ versionId: V, rowVersion: '3', destination: 'Goa', tripScope: 'domestic', tripStart: '2026-12-10', tripEnd: '2026-12-13', adults: '2', childrenWithBed: '0', childrenNoBed: '1', infants: '0', validUntil: '2099-01-01' });
    await expect(actions.saveQuotationDetailsAction(null, fd)).resolves.toMatchObject({ ok: true, data: { rowVersion: 4 } });
    expect(rpc).toHaveBeenCalledWith('quotation_version_save', {
      p_version_id: V,
      p_expected_row_version: 3,
      p_fields: { destination: 'Goa', scope: 'domestic', start: '2026-12-10', end: '2026-12-13', adults: 2, childrenWithBed: 0, childrenNoBed: 1, infants: 0, paxRemarks: null, requirementsNote: null, validUntil: '2099-01-01' },
    });
    // An empty validity date is left out (the database keeps the current date and refuses null).
    await actions.saveQuotationDetailsAction(null, form({ versionId: V, rowVersion: '3', adults: '2' }));
    expect(rpc.mock.lastCall![1].p_fields).not.toHaveProperty('validUntil');
    // Content: a day without text and empty notes are left out, never sent as null.
    rpcReplies({ quotation_version_save: { data: { rowVersion: 5, status: 'draft' } } });
    await actions.saveQuotationContentAction(null, form({ versionId: V, rowVersion: '4', dayTitle: ['Arrive'], dayText: [''] }));
    expect(rpc).toHaveBeenLastCalledWith('quotation_version_save', { p_version_id: V, p_expected_row_version: 4, p_fields: { content: { days: [{ day: 1, title: 'Arrive' }], includes: [], excludes: [], terms: [] } } });
    rpcReplies({ quotation_version_save: { error: { code: '22023', message: 'invalid_input', hint: 'start,adults' } } });
    await expect(actions.saveQuotationDetailsAction(null, fd)).resolves.toEqual({ ok: false, code: 'invalid_input', message: QUOTATION_ERROR_TEXT.invalid_input, fields: ['tripStart', 'adults'] });
    rpcReplies({ quotation_version_save: { error: { code: '55000', message: 'wrong_state' } } });
    await expect(actions.saveQuotationDetailsAction(null, fd)).resolves.toMatchObject({ ok: false, code: 'wrong_state' });
  });

  it('item: add without itemId, save with it; facts are the booking keys', async () => {
    rpcReplies({ quotation_item_add: { data: { itemId: ITEM, itemNo: 1, rowVersion: 5 } } });
    const base = { versionId: V, rowVersion: '4', serviceType: 'flight', itemTierKey: '', tripType: 'one_way', passengers: '2', segmentFrom: ['JDH'], segmentTo: ['GOI'], segmentDate: ['2026-12-10'] };
    const added = await actions.saveQuotationItemAction(null, form({ ...base, itemId: '' }));
    expect(added).toMatchObject({ ok: true, data: { itemId: ITEM, itemNo: 1 }, message: QUOTATION_TEXT.itemAdded });
    expect(rpc).toHaveBeenCalledWith('quotation_item_add', expect.objectContaining({ p_version_id: V, p_expected_row_version: 4, p_service_type: 'flight', p_tier_key: null }));
    rpcReplies({ quotation_item_save: { data: { rowVersion: 6 } } });
    await expect(actions.saveQuotationItemAction(null, form({ ...base, itemId: ITEM }))).resolves.toMatchObject({ ok: true, data: { rowVersion: 6 } });
    expect(rpc).toHaveBeenLastCalledWith('quotation_item_save', expect.objectContaining({ p_item_id: ITEM, p_version_id: V }));
  });

  it('mark ready: not_ready lists the blocking issues from the hint', async () => {
    rpcReplies({ quotation_mark_ready: { error: { code: '55000', message: 'not_ready', hint: 'trip_missing,quoted_total_missing' } } });
    await expect(actions.markQuotationReadyAction(null, form({ versionId: V, rowVersion: '6' }))).resolves.toEqual({
      ok: false,
      code: 'not_ready',
      message: QUOTATION_ERROR_TEXT.not_ready,
      issues: ['trip_missing', 'quoted_total_missing'],
    });
    rpcReplies({ quotation_mark_ready: { data: { status: 'ready', contentHash: HASH, rowVersion: 7 } } });
    await expect(actions.markQuotationReadyAction(null, form({ versionId: V, rowVersion: '6' }))).resolves.toMatchObject({ ok: true, data: { contentHash: HASH, rowVersion: 7 } });
  });

  it('mark sent is bound to the ready hash', async () => {
    rpcReplies({ quotation_mark_sent: { data: { status: 'sent', validUntil: '2026-10-19', supersededVersionId: null } } });
    await expect(actions.markQuotationSentAction(null, form({ versionId: V, contentHash: HASH, channel: 'whatsapp', requestId: REQ }))).resolves.toMatchObject({ ok: true, data: { validUntil: '2026-10-19' } });
    expect(rpc).toHaveBeenCalledWith('quotation_mark_sent', { p_version_id: V, p_expected_content_hash: HASH, p_channel: 'whatsapp', p_request_id: REQ });
    rpcReplies({ quotation_mark_sent: { error: { code: '40001', message: 'version_changed' } } });
    await expect(actions.markQuotationSentAction(null, form({ versionId: V, contentHash: HASH, channel: 'whatsapp', requestId: REQ }))).resolves.toMatchObject({ ok: false, code: 'version_changed' });
  });
});

describe('acceptance evidence, accept, link, convert', () => {
  it('evidence: file checked first; begin authorizes; Storage after; finish decides', async () => {
    await expect(actions.uploadQuotationEvidenceAction(null, form({ versionId: V, evidenceKind: 'acceptance_message', file: new File([new Uint8Array(64)], 'fake.pdf', { type: 'application/pdf' }) }))).resolves.toMatchObject({
      ok: false,
      code: 'evidence_rejected',
    });
    expect(rpc).not.toHaveBeenCalled();
    rpcReplies({ quotation_evidence_begin: { data: { evidenceId: EV, objectPath: PATH } }, quotation_evidence_finish: { data: { evidenceId: EV, status: 'stored' } } });
    await expect(actions.uploadQuotationEvidenceAction(null, form({ versionId: V, evidenceKind: 'acceptance_message', file: new File([PDF], 'ok.pdf', { type: 'application/pdf' }) }))).resolves.toEqual({
      ok: true,
      data: { evidenceId: EV },
      message: QUOTATION_TEXT.evidenceUploaded,
    });
    expect(storageFrom).toHaveBeenCalledWith('quotation-evidence');
    expect(rpc.mock.invocationCallOrder[0]!).toBeLessThan(upload.mock.invocationCallOrder[0]!);
    expect(rpc).toHaveBeenLastCalledWith('quotation_evidence_finish', { p_evidence_id: EV, p_ok: true });
  });

  it('accept needs the stored acceptance of this version; refusals in words', async () => {
    rpcReplies({ quotation_accept: { data: { status: 'accepted', acceptedTier: 'upgrade', quotationId: Q, discardedVersionId: null, supersededVersionId: null } } });
    await expect(actions.acceptQuotationAction(null, form({ versionId: V, contentHash: HASH, evidenceId: EV, acceptedTierKey: 'upgrade', requestId: REQ }))).resolves.toEqual({
      ok: true,
      data: { quotationId: Q, tierKey: 'upgrade', discardedVersionId: null, supersededVersionId: null },
      message: QUOTATION_TEXT.accepted,
    });
    for (const [state, token] of [
      ['55000', 'acceptance_proof_required'],
      ['55000', 'quotation_expired'],
      ['55000', 'quotation_already_accepted'],
      ['55000', 'version_superseded'],
    ] as const) {
      rpcReplies({ quotation_accept: { error: { code: state, message: token } } });
      await expect(actions.acceptQuotationAction(null, form({ versionId: V, contentHash: HASH, evidenceId: EV, acceptedTierKey: 'quoted', requestId: REQ }))).resolves.toEqual({
        ok: false,
        code: token,
        message: QUOTATION_ERROR_TEXT[token],
      });
    }
  });

  it('link: the Deal must come from this Lead and be in the same branch', async () => {
    rpcReplies({ quotation_link_deal: { error: { code: '22023', message: 'deal_not_from_lead' } } });
    await expect(actions.linkQuotationDealAction(null, form({ quotationId: Q, dealId: DEAL, rowVersion: '3' }))).resolves.toMatchObject({ ok: false, code: 'deal_not_from_lead' });
    rpcReplies({ quotation_link_deal: { error: { code: '22023', message: 'branch_mismatch' } } });
    await expect(actions.linkQuotationDealAction(null, form({ quotationId: Q, dealId: DEAL, rowVersion: '3' }))).resolves.toMatchObject({ ok: false, code: 'branch_mismatch' });
    rpcReplies({ quotation_link_deal: { data: { quotationId: Q, linkedDealId: DEAL, rowVersion: 4 } } });
    await expect(actions.linkQuotationDealAction(null, form({ quotationId: Q, dealId: DEAL, rowVersion: '3' }))).resolves.toMatchObject({ ok: true, data: { linkedDealId: DEAL } });
    expect(revalidatePath).toHaveBeenCalledWith(`/app/deals/${DEAL}`);
  });

  it('convert: ONE command bound to version + hash; a repeat answers existing with the same draft; waits for the Deal', async () => {
    rpcReplies({ quotation_convert_to_booking: { data: { outcome: 'created', bookingVersionId: BV, dealId: DEAL, itemsCreated: 3 } } });
    await expect(actions.convertQuotationAction(null, form({ versionId: V, contentHash: HASH, requestId: REQ }))).resolves.toEqual({
      ok: true,
      data: { outcome: 'created', bookingVersionId: BV, dealId: DEAL, itemsCreated: 3 },
      message: QUOTATION_TEXT.converted,
    });
    // Batch 3: one read first (does a referral quotation need binding?), then ONE conversion command.
    expect(rpc.mock.calls.filter(([fn]) => fn === 'quotation_convert_to_booking')).toHaveLength(1);
    expect(rpc.mock.calls.map(([fn]) => fn).filter((fn) => fn !== 'quotation_get')).toEqual(['quotation_convert_to_booking']);
    expect(rpc).toHaveBeenCalledWith('quotation_convert_to_booking', { p_version_id: V, p_expected_content_hash: HASH, p_request_id: REQ });
    expect(revalidatePath).toHaveBeenCalledWith(`/app/deals/${DEAL}/book`);
    rpcReplies({ quotation_convert_to_booking: { data: { outcome: 'existing', bookingVersionId: BV, dealId: DEAL, itemsCreated: 3 } } });
    await expect(actions.convertQuotationAction(null, form({ versionId: V, contentHash: HASH, requestId: REQ }))).resolves.toMatchObject({ ok: true, message: QUOTATION_TEXT.convertedExisting });
    for (const token of ['deal_link_required', 'draft_not_empty', 'already_confirmed'] as const) {
      rpcReplies({ quotation_convert_to_booking: { error: { code: '55000', message: token } } });
      await expect(actions.convertQuotationAction(null, form({ versionId: V, contentHash: HASH, requestId: REQ }))).resolves.toEqual({ ok: false, code: token, message: QUOTATION_ERROR_TEXT[token] });
    }
  });

  it('an unexplained failure is never reported as nothing changed', async () => {
    rpcReplies({ quotation_convert_to_booking: { error: { code: 'XX000', message: 'boom SECRET' } } });
    await expect(actions.convertQuotationAction(null, form({ versionId: V, contentHash: HASH, requestId: REQ }))).rejects.toThrow('Reload the page to check');
  });
});

describe('money actions (Mercury commands)', () => {
  it('lines: amounts as decimal strings, counts as typed; hints map to the row inputs', async () => {
    rpcReplies({ quotation_lines_save: { data: { rowVersion: 9, status: 'draft' } } });
    const fd = form({
      versionId: V,
      rowVersion: '8',
      lineOptionKey: ['quoted'],
      lineItemId: [ITEM],
      lineChargeKind: ['main'],
      lineCategoryKey: ['hotels'],
      lineDescription: ['Sea View, deluxe'],
      lineUnitKind: ['room_night'],
      lineUnits: ['2'],
      linePeriods: ['3'],
      lineUnitSellRupees: ['4,500'],
      lineUnitCostRupees: ['3800.50'],
      lineRemark: [''],
    });
    await expect(money.saveQuotationLinesAction(null, fd)).resolves.toMatchObject({ ok: true, data: { rowVersion: 9 } });
    expect(rpc).toHaveBeenCalledWith('quotation_lines_save', {
      p_version_id: V,
      p_expected_row_version: 8,
      p_lines: [{ lineNo: 1, optionKey: 'quoted', itemId: ITEM, chargeKind: 'main', categoryKey: 'hotels', description: 'Sea View, deluxe', unitKind: 'room_night', units: 2, periods: 3, unitSellPaise: '450000', unitCostPaise: '380050', remark: null }],
    });
    rpcReplies({ quotation_lines_save: { error: { code: '22023', message: 'invalid_input', hint: 'lines[1].unitKind' } } });
    await expect(money.saveQuotationLinesAction(null, fd)).resolves.toMatchObject({ ok: false, code: 'invalid_input', fields: ['lineUnitKind[0]'] });
    rpcReplies({ quotation_lines_save: { error: { code: '22023', message: 'internal_wording', hint: 'lines[1].description' } } });
    await expect(money.saveQuotationLinesAction(null, fd)).resolves.toMatchObject({ ok: false, code: 'internal_wording', fields: ['lineDescription[0]'] });
  });

  it('typed total: whole rupees as a paise string, never a JS number; plan rows by due rule', async () => {
    rpcReplies({ quotation_total_save: { data: { rowVersion: 10, status: 'draft' } } });
    await money.saveQuotationTierTotalAction(null, form({ versionId: V, rowVersion: '9', tierKey: 'quoted', quotedTotalRupees: '1,23,45,67,890', showPerPerson: 'on' }));
    expect(rpc).toHaveBeenCalledWith('quotation_total_save', { p_version_id: V, p_expected_row_version: 9, p_tier_key: 'quoted', p_total_paise: '123456789000', p_show_per_person: true });
    rpcReplies({ quotation_plan_save: { data: { rowVersion: 11, status: 'draft' } } });
    await money.saveQuotationPlanAction(null, form({ versionId: V, rowVersion: '10', tierKey: 'quoted', instalmentLabel: ['Advance'], instalmentAmountRupees: ['30000'], instalmentDueRule: ['on_acceptance'] }));
    expect(rpc).toHaveBeenLastCalledWith('quotation_plan_save', {
      p_version_id: V,
      p_expected_row_version: 10,
      p_tier_key: 'quoted',
      p_instalments: [{ seq: 1, label: 'Advance', amountPaise: '3000000', dueRule: 'on_acceptance', dueDays: null, dueDate: null }],
    });
  });

  it('non-commercial callers are refused by the database in plain words; nothing is sent for paise in a selling price', async () => {
    rpcReplies({ quotation_total_save: { error: { code: '42501', message: 'not_authorized' } } });
    await expect(money.saveQuotationTierTotalAction(null, form({ versionId: V, rowVersion: '9', tierKey: 'quoted', quotedTotalRupees: '95000' }))).resolves.toMatchObject({ ok: false, code: 'not_authorized' });
    rpc.mockClear();
    await expect(money.saveQuotationTierTotalAction(null, form({ versionId: V, rowVersion: '9', tierKey: 'quoted', quotedTotalRupees: '95000.50' }))).resolves.toMatchObject({ ok: false, fields: ['quotedTotalRupees'] });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('cost refresh: one cost per line, no row version', async () => {
    rpcReplies({ quotation_cost_estimates_save: { data: { versionId: V, updated: 1 } } });
    await expect(money.saveQuotationCostEstimatesAction(null, form({ versionId: V, lineUnitCostRupees: ['3900', ''] }))).resolves.toMatchObject({ ok: true, data: { updated: 1 } });
    expect(rpc).toHaveBeenCalledWith('quotation_cost_estimates_save', { p_version_id: V, p_costs: [{ lineNo: 1, unitCostPaise: '390000' }, { lineNo: 2, unitCostPaise: null }] });
  });
});

describe('customer-text safety scan before the database (Nova safety.ts)', () => {
  it('a forbidden word in any customer text is refused as internal_wording with the inputs to fix; nothing is sent', async () => {
    const cases: Array<[Promise<unknown>, string[]]> = [
      [actions.saveQuotationContentAction(null, form({ versionId: V, rowVersion: '1', dayTitle: ['Arrive', 'Beach'], dayText: ['', 'Hurry, book now'], include: ['Breakfast', 'Net rate hotel'] })), ['dayText[1]', 'include[1]']],
      [actions.saveQuotationTiersAction(null, form({ versionId: V, rowVersion: '1', quotedTierLabel: 'Deluxe', upgradeOffered: 'on', upgradeTierLabel: 'Lowest price luxury' })), ['upgradeTierLabel']],
      [actions.saveQuotationContactAction(null, form({ versionId: V, rowVersion: '1', contactName: 'Synthetic', mobile: '9876543210', companyName: 'Net rate travels' })), ['companyName']],
      [
        money.saveQuotationLinesAction(
          null,
          form({ versionId: V, rowVersion: '1', lineOptionKey: ['common', 'common'], lineCategoryKey: ['flights', 'other'], lineDescription: ['Flights', 'Our margin'], lineUnitKind: ['line_total', 'line_total'], lineUnitSellRupees: ['1000', '500'] }),
        ),
        ['lineDescription[1]'],
      ],
      [money.saveQuotationPlanAction(null, form({ versionId: V, rowVersion: '1', tierKey: 'quoted', instalmentLabel: ['Net rate deposit'], instalmentAmountRupees: ['1000'], instalmentDueRule: ['on_acceptance'] })), ['instalmentLabel[0]']],
    ];
    for (const [run, fields] of cases) {
      await expect(run).resolves.toEqual({ ok: false, code: 'internal_wording', message: QUOTATION_ERROR_TEXT.internal_wording, fields });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it('internal fields are never scanned; whole phrases only ("international" is fine)', async () => {
    rpcReplies({ quotation_lines_save: { data: { rowVersion: 2, status: 'draft' } } });
    await expect(
      money.saveQuotationLinesAction(
        null,
        form({ versionId: V, rowVersion: '1', lineOptionKey: ['common'], lineCategoryKey: ['flights'], lineDescription: ['International flights'], lineUnitKind: ['line_total'], lineUnitSellRupees: ['1000'], lineRemark: ['margin is thin here'] }),
      ),
    ).resolves.toMatchObject({ ok: true });
  });
});

describe('loaders and download', () => {
  it('null for a non-reader, not_installed without the functions, retry text otherwise', async () => {
    rpcReplies({ quotation_list: { data: null } });
    await expect(queries.loadQuotationsForDeal(staff, DEAL)).resolves.toBeNull();
    rpcReplies({ quotation_list: { error: { code: 'PGRST202', message: 'missing' } } });
    await expect(queries.loadQuotationsForLead(staff, DEAL)).resolves.toBe('not_installed');
    rpcReplies({ quotation_get: { error: { code: '42501', message: 'not_authorized' } } });
    await expect(queries.loadQuotation(staff, V)).resolves.toBeNull();
    await expect(queries.loadQuotation(staff, 'nope')).resolves.toBeNull();
    rpcReplies({ quotation_get: { error: { code: 'XX000', message: 'boom SECRET' } } });
    await expect(queries.loadQuotation(staff, V)).rejects.toThrow('Could not load the quotation. Please retry.');
    rpcReplies({ quotation_link_candidates: { data: [{ dealId: DEAL, reference: 'D-1', title: 'Synthetic', branchName: 'Jodhpur', sameBranch: true, active: true, linkable: true }] } });
    await expect(queries.loadQuotationLinkCandidates(staff, Q)).resolves.toEqual([{ dealId: DEAL, reference: 'D-1', title: 'Synthetic', branchName: 'Jodhpur', sameBranch: true, active: true, linkable: true }]);
  });

  it('evidence download: authorize under the session, neutral name, 404 for every refusal', async () => {
    rpcReplies({ quotation_evidence_authorize_download: { data: { objectPath: PATH, fileName: 'Ramesh acceptance.pdf', mime: 'application/pdf' } } });
    const res = await quotationEvidenceDownloadResponse(EV);
    expect(res.status).toBe(302);
    expect(createSignedUrl).toHaveBeenCalledWith(PATH, 60, { download: 'quotation-file.pdf' });
    rpcReplies({ quotation_evidence_authorize_download: { error: { code: '42501', message: 'not_authorized' } } });
    expect((await quotationEvidenceDownloadResponse(EV)).status).toBe(404);
    expect((await quotationEvidenceDownloadResponse('x')).status).toBe(404);
  });
});
