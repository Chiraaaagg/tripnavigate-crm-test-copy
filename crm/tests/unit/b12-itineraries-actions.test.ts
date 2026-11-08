import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DOCUMENT_BLOCK_TEXT, DOCX_MIME, ITINERARY_ERROR_TEXT, ITINERARY_TEMPLATE_VERSION, ITINERARY_TEXT } from '@/modules/itineraries/contracts';

/**
 * Itinerary actions and loaders with a fake RPC client and Nova's documents
 * reads stubbed: session first; files checked before any call; Storage only
 * after begin; facts scanned before saving; differences computed by Nova
 * and stored as computed; acknowledgements; mark ready refusals; render
 * requests bound to the adapter's input hash, final blocked by placeholders;
 * downloads authorized under the session. Synthetic ids only.
 */

const requireStaff = vi.fn();
const rpc = vi.fn();
const upload = vi.fn();
const createSignedUrl = vi.fn();
const storageFrom = vi.fn();
const adminFactory = vi.fn();
const revalidatePath = vi.fn();
const computeItineraryDifferences = vi.fn();
const loadItineraryDocumentView = vi.fn();
const itineraryToEngine = vi.fn();

vi.mock('@/modules/identity/server/session', () => ({ requireStaff: () => requireStaff() }));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: () => adminFactory() }));
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
vi.mock('@/lib/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/config')>()),
  getAppConfig: () => ({ supabaseUrl: 'http://127.0.0.1:54321', supabasePublishableKey: 'sb_publishable_test' }),
}));
vi.mock('@/modules/documents/server/itinerary', async (importOriginal) => ({
  computeItineraryDifferences: (...a: unknown[]) => computeItineraryDifferences(...a),
  loadItineraryDocumentView: (...a: unknown[]) => loadItineraryDocumentView(...a),
  // Nova's real helper (values keyed by kind and path); the DB test runs Nova's real compute.
  basisValueAt: (await importOriginal<typeof import('@/modules/documents/server/itinerary')>()).basisValueAt,
}));
vi.mock('@/modules/documents/itinerary-adapter', () => ({ itineraryToEngine: (...a: unknown[]) => itineraryToEngine(...a) }));

const actions = await import('@/modules/itineraries/server/actions');
const queries = await import('@/modules/itineraries/server/queries');
const downloads = await import('@/modules/itineraries/server/downloads');

const USER = 'f0000000-0000-4000-8000-000000000001';
const ENTITY = 'e0000000-0000-4000-8000-000000000001';
const Q = 'a1000000-0000-4000-8000-000000000001';
const QV = 'a2000000-0000-4000-8000-000000000001';
const DOC = 'c1000000-0000-4000-8000-000000000001';
const DRAFT = 'c2000000-0000-4000-8000-000000000001';
const DIFF = 'c3000000-0000-4000-8000-000000000001';
const JOB = 'c4000000-0000-4000-8000-000000000001';
const RUN = 'c5000000-0000-4000-8000-000000000001';
const FILE = 'c6000000-0000-4000-8000-000000000001';
const RENDERED = 'c7000000-0000-4000-8000-000000000001';
const REQ = '77777777-7777-4777-8777-777777777777';
const HASH = 'a'.repeat(64);
const DOCX = (() => {
  const body = new TextEncoder().encode('[Content_Types].xml word/document.xml');
  return new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, ...body]);
})();

function form(fields: Record<string, string | string[] | Blob>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach((x) => fd.append(k, x));
    else fd.set(k, v);
  }
  return fd;
}

type RpcReply = { data?: unknown; error?: { code: string; message: string; hint?: string } | null };
function rpcReplies(map: Record<string, RpcReply>) {
  rpc.mockImplementation(async (fn: string) => {
    const reply = map[fn];
    if (!reply) throw new Error(`unexpected rpc ${fn}`);
    return { data: reply.data ?? null, error: reply.error ?? null };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireStaff.mockResolvedValue({ userId: USER, supabase: { rpc }, access: { userId: USER, memberships: [], rolePermissions: [], grants: [] } });
  storageFrom.mockReturnValue({ upload, createSignedUrl });
  adminFactory.mockReturnValue({ storage: { from: storageFrom } });
  upload.mockResolvedValue({ data: {}, error: null });
  createSignedUrl.mockResolvedValue({ data: { signedUrl: 'http://127.0.0.1:54321/storage/v1/object/sign/x?token=synthetic' }, error: null });
});

describe('create and source files', () => {
  it('session first; create under the user session', async () => {
    requireStaff.mockRejectedValueOnce(new Error('NEXT_REDIRECT /mfa/challenge'));
    await expect(actions.createItineraryAction(null, form({ subjectKind: 'quotation', subjectId: Q, title: 'Goa', requestId: REQ }))).rejects.toThrow('NEXT_REDIRECT');
    expect(rpc).not.toHaveBeenCalled();
    rpcReplies({ itinerary_document_create: { data: { documentId: DOC, draftId: DRAFT, rowVersion: 1, created: true } } });
    await expect(actions.createItineraryAction(null, form({ subjectKind: 'quotation', subjectId: Q, title: 'Goa itinerary', requestId: REQ }))).resolves.toEqual({
      ok: true,
      data: { documentId: DOC, draftId: DRAFT, rowVersion: 1, created: true },
      message: ITINERARY_TEXT.created,
    });
    expect(rpc).toHaveBeenCalledWith('itinerary_document_create', { p_subject_kind: 'quotation', p_subject_id: Q, p_title: 'Goa itinerary', p_request_id: REQ });
  });

  it('a Word file is checked by its bytes before any call, then begin → private upload → finish', async () => {
    await expect(actions.uploadItinerarySourceAction(null, form({ documentId: DOC, file: new File([new Uint8Array([1, 2, 3])], 'x.docx', { type: DOCX_MIME }) }))).resolves.toMatchObject({ ok: false, code: 'evidence_rejected', fields: ['file'] });
    expect(rpc).not.toHaveBeenCalled();
    const path = `${ENTITY}/${DOC}/${FILE}`;
    rpcReplies({ itinerary_source_begin: { data: { fileId: FILE, objectPath: path } }, itinerary_source_finish: { data: { fileId: FILE, status: 'stored' } } });
    await expect(actions.uploadItinerarySourceAction(null, form({ documentId: DOC, file: new File([DOCX], 'Goa plan.docx', { type: DOCX_MIME }) }))).resolves.toEqual({
      ok: true,
      data: { fileId: FILE },
      message: ITINERARY_TEXT.sourceUploaded,
    });
    expect(rpc).toHaveBeenCalledWith('itinerary_source_begin', expect.objectContaining({ p_document_id: DOC, p_mime: DOCX_MIME, p_file_name: 'Goa plan.docx' }));
    expect(storageFrom).toHaveBeenCalledWith('itinerary-sources');
    expect(upload).toHaveBeenCalledWith(path, expect.any(Uint8Array), { contentType: DOCX_MIME, upsert: false });
    expect(rpc.mock.invocationCallOrder[0]!).toBeLessThan(upload.mock.invocationCallOrder[0]!);
  });
});

describe('facts, differences, ready', () => {
  const facts = { documentId: DOC, draftId: DRAFT, rowVersion: '3', destination: 'Goa', startDate: '2026-12-10', endDate: '2026-12-13', dayTitle: ['Arrive'] };

  it('facts: customer text scanned first (internal words refused with the inputs), then one full save', async () => {
    await expect(actions.saveItineraryFactsAction(null, form({ ...facts, dayStory: ['Net rate hotel, hurry!'], inclusion: ['Breakfast'] }))).resolves.toEqual({
      ok: false,
      code: 'internal_wording',
      message: ITINERARY_ERROR_TEXT.internal_wording,
      fields: ['dayStory[0]'],
    });
    expect(rpc).not.toHaveBeenCalled();
    rpcReplies({ itinerary_facts_save: { data: { rowVersion: 4, factsHash: HASH, status: 'draft' } } });
    await expect(actions.saveItineraryFactsAction(null, form(facts))).resolves.toMatchObject({ ok: true, data: { rowVersion: 4, factsHash: HASH } });
    expect(rpc).toHaveBeenCalledWith('itinerary_facts_save', {
      p_draft_id: DRAFT,
      p_expected_row_version: 3,
      p_facts: { destination: 'Goa', startDate: '2026-12-10', endDate: '2026-12-13', days: [{ n: 1, title: 'Arrive' }] },
      p_source_file_id: null,
    });
    rpcReplies({ itinerary_facts_save: { error: { code: '22023', message: 'invalid_input', hint: 'stays[2].nights,party.adults' } } });
    await expect(actions.saveItineraryFactsAction(null, form(facts))).resolves.toMatchObject({ ok: false, code: 'invalid_input', fields: ['stayNights[1]', 'adults'] });
  });

  it('check differences: Nova computes; the database stores exactly that; basis changes ask for a new check', async () => {
    computeItineraryDifferences.mockResolvedValue({ status: 'ok', draftId: DRAFT, rowVersion: 4, basisKind: 'quotation_version', basisId: QV, basisHash: HASH, differences: [{ path: 'stays[1].hotelName', kind: 'different', factsValueHash: 'b'.repeat(64), basisValueHash: 'c'.repeat(64) }] });
    rpcReplies({ itinerary_differences_save: { data: { runId: RUN, differenceCount: 1, openCount: 1, outcome: 'created' } } });
    await expect(actions.checkItineraryDifferencesAction(null, form({ documentId: DOC }))).resolves.toMatchObject({ ok: true, data: { openCount: 1 }, message: expect.stringContaining('1 difference') });
    expect(rpc).toHaveBeenCalledWith('itinerary_differences_save', {
      p_draft_id: DRAFT,
      p_expected_row_version: 4,
      p_basis_kind: 'quotation_version',
      p_basis_id: QV,
      p_basis_hash: HASH,
      // Passed through unchanged: path, kind and both value hashes (E3-9), never a value.
      p_differences: [{ path: 'stays[1].hotelName', kind: 'different', factsValueHash: 'b'.repeat(64), basisValueHash: 'c'.repeat(64) }],
    });
    rpcReplies({ itinerary_differences_save: { error: { code: '40001', message: 'basis_changed' } } });
    await expect(actions.checkItineraryDifferencesAction(null, form({ documentId: DOC }))).resolves.toMatchObject({ ok: false, code: 'basis_changed' });
    computeItineraryDifferences.mockResolvedValue({ status: 'basis_changed' });
    await expect(actions.checkItineraryDifferencesAction(null, form({ documentId: DOC }))).resolves.toMatchObject({ ok: false, code: 'basis_changed' });
  });

  it('acknowledge: keep with the standard note, note required for "note", "use the quotation value" explains the edit', async () => {
    rpcReplies({ itinerary_difference_acknowledge: { data: { differenceId: DIFF, acknowledged: true } } });
    await expect(actions.acknowledgeItineraryDifferenceAction(null, form({ documentId: DOC, differenceId: DIFF, choice: 'keep_itinerary' }))).resolves.toMatchObject({ ok: true });
    expect(rpc).toHaveBeenLastCalledWith('itinerary_difference_acknowledge', { p_difference_id: DIFF, p_note: 'Itinerary value kept on purpose.' });
    await actions.acknowledgeItineraryDifferenceAction(null, form({ documentId: DOC, differenceId: DIFF, choice: 'note', note: 'Customer asked for the beach hotel' }));
    expect(rpc).toHaveBeenLastCalledWith('itinerary_difference_acknowledge', { p_difference_id: DIFF, p_note: 'Customer asked for the beach hotel' });
    rpc.mockClear();
    await expect(actions.acknowledgeItineraryDifferenceAction(null, form({ documentId: DOC, differenceId: DIFF, choice: 'use_basis' }))).resolves.toEqual({
      ok: false,
      code: 'invalid_input',
      message: ITINERARY_TEXT.useBasisHint,
      fields: ['choice'],
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('mark ready: unchecked, open differences and missing facts are refused in words', async () => {
    const fd = form({ documentId: DOC, draftId: DRAFT, rowVersion: '5' });
    rpcReplies({ itinerary_facts_mark_ready: { error: { code: '55000', message: 'differences_not_checked' } } });
    await expect(actions.markItineraryReadyAction(null, fd)).resolves.toMatchObject({ ok: false, code: 'differences_not_checked' });
    rpcReplies({ itinerary_facts_mark_ready: { error: { code: '55000', message: 'differences_open' } } });
    await expect(actions.markItineraryReadyAction(null, fd)).resolves.toMatchObject({ ok: false, code: 'differences_open' });
    rpcReplies({ itinerary_facts_mark_ready: { error: { code: '55000', message: 'not_ready', hint: 'dates_missing,days_missing' } } });
    await expect(actions.markItineraryReadyAction(null, fd)).resolves.toEqual({ ok: false, code: 'not_ready', message: ITINERARY_ERROR_TEXT.not_ready, issues: ['dates_missing', 'days_missing'] });
    rpcReplies({ itinerary_facts_mark_ready: { data: { status: 'ready', rowVersion: 6 } } });
    await expect(actions.markItineraryReadyAction(null, fd)).resolves.toMatchObject({ ok: true, data: { rowVersion: 6 } });
  });
});

describe('use the quotation or booking value (one click)', () => {
  const getReply = (facts: Record<string, unknown>, rowVersion = 4) => ({
    documentId: DOC,
    title: 'Goa',
    subject: { kind: 'quotation', quotationId: Q, dealId: null },
    draft: { draftId: DRAFT, status: 'draft', rowVersion, facts, factsHash: HASH, sourceFileId: null, updatedAt: null },
    basis: { kind: 'quotation_version', id: QV, hash: HASH },
    differences: { runId: null, current: false, items: [] },
    sources: [],
    jobs: [],
    rendered: [],
  });
  const computedWith = (basisValues: Record<string, unknown>, differences = [{ path: 'stays[0].hotelName', kind: 'different' }]) => ({
    status: 'ok',
    draftId: DRAFT,
    rowVersion: 4,
    basisKind: 'quotation_version',
    basisId: QV,
    basisHash: HASH,
    differences,
    basisValues: Object.fromEntries(Object.entries(basisValues).map(([path, v]) => [`${differences.find((d) => d.path === path)?.kind ?? 'different'}:${path}`, v])),
  });

  it('recomputes on the server, writes the basis value with provenance, saves, then checks again', async () => {
    computeItineraryDifferences
      .mockResolvedValueOnce(computedWith({ 'stays[0].hotelName': 'Synthetic Beach Resort' }))
      .mockResolvedValueOnce({ ...computedWith({}, []), rowVersion: 5 });
    rpcReplies({
      itinerary_document_get: { data: getReply({ destination: 'Goa', stays: [{ city: 'Goa', nights: 3, hotelName: 'Sea View' }] }) },
      itinerary_facts_save: { data: { rowVersion: 5, factsHash: HASH, status: 'draft' } },
      itinerary_differences_save: { data: { runId: RUN, differenceCount: 0, openCount: 0, outcome: 'created' } },
    });
    await expect(actions.useItineraryBasisValueAction(null, form({ documentId: DOC, path: 'stays[0].hotelName', differenceKind: 'different' }))).resolves.toEqual({
      ok: true,
      data: { runId: RUN, differenceCount: 0, openCount: 0, outcome: 'created' },
      message: ITINERARY_TEXT.basisValueUsed,
    });
    expect(rpc).toHaveBeenCalledWith('itinerary_facts_save', {
      p_draft_id: DRAFT,
      p_expected_row_version: 4,
      p_facts: { destination: 'Goa', stays: [{ city: 'Goa', nights: 3, hotelName: 'Synthetic Beach Resort' }], provenance: { 'stays[0].hotelName': 'quotation' } },
      p_source_file_id: null,
    });
    expect(rpc).toHaveBeenLastCalledWith('itinerary_differences_save', expect.objectContaining({ p_expected_row_version: 5, p_differences: [] }));
  });

  it('refuses when the path is no longer a difference, the value is missing, or the draft changed meanwhile; nothing saved', async () => {
    computeItineraryDifferences.mockResolvedValue(computedWith({}));
    rpcReplies({ itinerary_document_get: { data: getReply({ stays: [{ city: 'Goa', nights: 3 }] }) } });
    await expect(actions.useItineraryBasisValueAction(null, form({ documentId: DOC, path: 'destination', differenceKind: 'different' }))).resolves.toMatchObject({ ok: false, code: 'basis_value_unavailable' });
    await expect(actions.useItineraryBasisValueAction(null, form({ documentId: DOC, path: 'stays[0].hotelName', differenceKind: 'different' }))).resolves.toMatchObject({ ok: false, code: 'basis_value_unavailable' });
    computeItineraryDifferences.mockResolvedValue(computedWith({ 'stays[0].hotelName': 'X' }));
    // Same path, other kind: not this difference.
    await expect(actions.useItineraryBasisValueAction(null, form({ documentId: DOC, path: 'stays[0].hotelName', differenceKind: 'missing' }))).resolves.toMatchObject({ ok: false, code: 'basis_value_unavailable' });
    await expect(actions.useItineraryBasisValueAction(null, form({ documentId: DOC, path: 'stays[0].hotelName' }))).resolves.toMatchObject({ ok: false, code: 'invalid_input', fields: ['differenceKind'] });
    rpcReplies({ itinerary_document_get: { data: getReply({ stays: [{ city: 'Goa', nights: 3 }] }, 6) } });
    await expect(actions.useItineraryBasisValueAction(null, form({ documentId: DOC, path: 'stays[0].hotelName', differenceKind: 'different' }))).resolves.toMatchObject({ ok: false, code: 'version_changed' });
    expect(rpc.mock.calls.map((c) => c[0])).not.toContain('itinerary_facts_save');
  });
});

describe('render requests', () => {
  it('bound to the adapter input hash and template version; final refused while placeholders remain; adapter refusals in words', async () => {
    loadItineraryDocumentView.mockResolvedValue({ status: 'ok', view: { synthetic: true } });
    itineraryToEngine.mockReturnValue({ ok: true, input: { title: 'Goa' }, placeholders: ['Hotel name'], internalNotes: [] });
    await expect(actions.requestItineraryRenderAction(null, form({ documentId: DOC, renderKind: 'final' }))).resolves.toMatchObject({ ok: false, code: 'document_blocked', blocks: [expect.stringContaining('missing')] });
    expect(rpc).not.toHaveBeenCalled();
    rpcReplies({ itinerary_render_request: { data: { jobId: JOB, status: 'queued', outcome: 'created' } } });
    await expect(actions.requestItineraryRenderAction(null, form({ documentId: DOC, renderKind: 'preview' }))).resolves.toEqual({
      ok: true,
      data: { jobId: JOB, status: 'queued', outcome: 'created' },
      message: ITINERARY_TEXT.renderRequested,
    });
    expect(rpc).toHaveBeenCalledWith('itinerary_render_request', { p_document_id: DOC, p_kind: 'preview', p_input_hash: expect.stringMatching(/^[0-9a-f]{64}$/), p_template_version: ITINERARY_TEMPLATE_VERSION });
    itineraryToEngine.mockReturnValue({ ok: false, refusals: [{ code: 'nights_mismatch', path: 'stays' }, { code: 'unsafe_text', path: 'days[0].story' }] });
    await expect(actions.requestItineraryRenderAction(null, form({ documentId: DOC, renderKind: 'preview' }))).resolves.toMatchObject({ ok: false, code: 'document_blocked', blocks: [expect.stringContaining('nights'), expect.stringContaining('internal words')] });
    loadItineraryDocumentView.mockResolvedValue({ status: 'not_found' });
    await expect(actions.requestItineraryRenderAction(null, form({ documentId: DOC, renderKind: 'preview' }))).resolves.toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('DEC-50: final render of a Delhi itinerary (company GSTIN not approved yet)', () => {
  const DELHI = 'The company GSTIN for Delhi is not approved yet. Ask Accounts; there is nothing for you to fill in.';

  it('the real adapter on a Delhi view: final refused before any database call, with the Accounts wording', async () => {
    const real = await vi.importActual<typeof import('@/modules/documents/itinerary-adapter')>('@/modules/documents/itinerary-adapter');
    const { itineraryView } = await import('./b12-documents-fixtures');
    const view = itineraryView({ branchCode: 'DEL' });
    loadItineraryDocumentView.mockResolvedValue({ status: 'ok', view });
    itineraryToEngine.mockImplementation((v: Parameters<typeof real.itineraryToEngine>[0]) => real.itineraryToEngine(v));
    const r = await actions.requestItineraryRenderAction(null, form({ documentId: DOC, renderKind: 'final' }));
    expect(r).toMatchObject({ ok: false, code: 'document_blocked' });
    // The fixture also leaves the day plan open, so both lines show: the GSTIN first, then the facts to fill in.
    expect(r.ok === false && 'blocks' in r ? r.blocks : null).toEqual([DELHI, DOCUMENT_BLOCK_TEXT.placeholders]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('only the GSTIN missing: the Accounts wording alone (no "fill them in"); a Jodhpur final with no placeholder is requested', async () => {
    loadItineraryDocumentView.mockResolvedValue({ status: 'ok', view: { synthetic: true } });
    itineraryToEngine.mockReturnValue({ ok: true, input: { title: 'Goa' }, placeholders: ['GSTIN for Delhi'], internalNotes: [] });
    await expect(actions.requestItineraryRenderAction(null, form({ documentId: DOC, renderKind: 'final' }))).resolves.toMatchObject({ ok: false, code: 'document_blocked', blocks: [DELHI] });
    // A preview is still allowed (the placeholder shows in brackets).
    rpcReplies({ itinerary_render_request: { data: { jobId: JOB, status: 'queued', outcome: 'created' } } });
    await expect(actions.requestItineraryRenderAction(null, form({ documentId: DOC, renderKind: 'preview' }))).resolves.toMatchObject({ ok: true });
    itineraryToEngine.mockReturnValue({ ok: true, input: { title: 'Goa' }, placeholders: [], internalNotes: [] });
    await expect(actions.requestItineraryRenderAction(null, form({ documentId: DOC, renderKind: 'final' }))).resolves.toMatchObject({ ok: true });
    expect(rpc).toHaveBeenLastCalledWith('itinerary_render_request', expect.objectContaining({ p_kind: 'final', p_template_version: 'itinerary-2' }));
  });

  it('unknown branch: the CRM team wording, not Accounts', async () => {
    loadItineraryDocumentView.mockResolvedValue({ status: 'ok', view: { synthetic: true } });
    itineraryToEngine.mockReturnValue({ ok: true, input: { title: 'Goa' }, placeholders: ['GSTIN for branch'], internalNotes: [] });
    await expect(actions.requestItineraryRenderAction(null, form({ documentId: DOC, renderKind: 'final' }))).resolves.toMatchObject({
      ok: false,
      code: 'document_blocked',
      blocks: ['The branch of this document is not known, so the company GSTIN cannot be printed. Tell the CRM team.'],
    });
  });
});

describe('loaders and downloads', () => {
  const staff = { supabase: { rpc } } as never;
  it('null for non-editors, not_installed without 0500, retry text otherwise', async () => {
    rpcReplies({ itinerary_document_list: { data: null } });
    await expect(queries.loadItinerariesForQuotation(staff, Q)).resolves.toBeNull();
    rpcReplies({ itinerary_document_get: { error: { code: 'PGRST202', message: 'missing' } } });
    await expect(queries.loadItineraryEditor(staff, DOC)).resolves.toBe('not_installed');
    rpcReplies({ itinerary_document_get: { error: { code: 'XX000', message: 'boom SECRET' } } });
    await expect(queries.loadItineraryEditor(staff, DOC)).rejects.toThrow('Could not load the itinerary. Please retry.');
    rpcReplies({ itinerary_document_list: { data: [{ documentId: DOC, title: 'Goa', subjectKind: 'deal', draftStatus: 'ready', factsHash: HASH, createdAt: '2026-10-12T08:00:00Z', latestFinal: { renderedId: RENDERED, createdAt: '2026-10-12T09:00:00Z' } }] } });
    await expect(queries.loadItinerariesForDeal(staff, 'd0000000-0000-4000-8000-000000000001')).resolves.toMatchObject({ documents: [{ draftStatus: 'ready', latestFinal: { downloadHref: `/app/itineraries/rendered/${RENDERED}` } }] });
  });

  it('downloads: authorized under the session, neutral names, 404 for every refusal', async () => {
    rpcReplies({ itinerary_source_authorize_download: { data: { objectPath: `${ENTITY}/${DOC}/${FILE}`, fileName: 'Ramesh plan.docx', mime: DOCX_MIME } } });
    expect((await downloads.itinerarySourceDownloadResponse(FILE)).status).toBe(302);
    expect(createSignedUrl).toHaveBeenLastCalledWith(`${ENTITY}/${DOC}/${FILE}`, 60, { download: 'itinerary-source.docx' });
    rpcReplies({ itinerary_rendered_authorize_download: { data: { objectPath: `${ENTITY}/${DOC}/${JOB}.pdf`, mime: 'application/pdf', fileName: 'itinerary-final-20261212.pdf' } } });
    expect((await downloads.itineraryRenderedDownloadResponse(RENDERED)).status).toBe(302);
    expect(storageFrom).toHaveBeenLastCalledWith('rendered-documents');
    rpcReplies({ itinerary_source_authorize_download: { error: { code: '42501', message: 'not_authorized' } } });
    expect((await downloads.itinerarySourceDownloadResponse(FILE)).status).toBe(404);
    expect((await downloads.itineraryRenderedDownloadResponse('x')).status).toBe(404);
  });
});
