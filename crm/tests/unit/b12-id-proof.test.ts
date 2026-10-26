import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BookingFormSchema } from '@/modules/fulfilment/b11-commands';
import { mergeBookChecklist, toIdProofViews } from '@/modules/fulfilment/b11-dto';
import { ID_PROOF_FIELD, parseIdProofRemoveForm, parseIdProofUploadForm } from '@/modules/fulfilment/b11-forms';
import { BOOKING_ERROR_STATES, mapBookingError } from '@/modules/fulfilment/commands';
import { idProofSlotsLeft, idProofsDetachedByRename } from '@/views/b11/book-fields';
import { CHECKLIST_STEP, ERROR_TEXT, ID_PROOF_BUCKET, ID_PROOF_MAX_BYTES, ID_PROOF_TEXT, ISSUE_TEXT, UNKNOWN_OUTCOME_TEXT } from '@/modules/fulfilment/contracts';

/**
 * B1.2 traveller identity proof (freeze note §2.2, DEC-38 … DEC-42; Atlas
 * 0100 shapes): session first; the consent tick and the file (size, type,
 * magic bytes) are checked before any database call; traveller_id_proof_begin
 * under the staff member's own session authorizes and generates the path;
 * only then the privileged client uploads to the private bucket; finish
 * decides 'stored'. Remove is soft, by the file's own row version. One
 * audited download route for every allowed viewer; every refusal an
 * indistinguishable 404. Task screens read stored proofs of their own
 * travellers only. No typed ID number anywhere. Synthetic ids and bytes only.
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

const actions = await import('@/modules/fulfilment/server/id-proof-actions');
const { idProofDownloadResponse } = await import('@/modules/fulfilment/server/id-proof-download');
const { ID_PROOFS_REFUSED, loadDealIdProofs, loadTaskIdProofs } = await import('@/modules/fulfilment/server/id-proofs');

const USER = 'a0000000-0000-4000-8000-000000000001';
const ENTITY = 'e0000000-0000-4000-8000-000000000001';
const DEAL = 'd0000000-0000-4000-8000-000000000001';
const TRAVELLER = 'b0000000-0000-4000-8000-000000000001';
const FILE = '99999999-9999-4999-8999-999999999999';
const OTHER_FILE = '99999999-9999-4999-8999-999999999998';
const TASK = '22222222-2222-4222-8222-222222222222';
const REQUEST = '77777777-7777-4777-8777-777777777777';
const PATH = `${ENTITY}/${DEAL}/${TRAVELLER}/${FILE}`;

const JPEG = (() => {
  const b = new Uint8Array(256);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  return b;
})();
const jpeg = (name = 'aadhaar front.jpg') => new File([JPEG], name, { type: 'image/jpeg' });

function form(fields: Record<string, string | Blob>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
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

const begun = (over: Record<string, unknown> = {}) => ({ data: { fileId: FILE, objectPath: PATH, outcome: 'created', status: 'pending_upload', rowVersion: 1, ...over } });
const finished = (status: 'stored' | 'failed') => ({ data: { fileId: FILE, status, rowVersion: 2 } });
const upForm = (file: Blob = jpeg(), extra: Record<string, string> = { consent: 'on' }) => form({ dealId: DEAL, travellerSeq: '2', requestId: REQUEST, file, ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  requireStaff.mockResolvedValue({ userId: USER, supabase: { rpc } });
  storageFrom.mockReturnValue({ upload, createSignedUrl });
  adminFactory.mockReturnValue({ storage: { from: storageFrom } });
  upload.mockResolvedValue({ data: { path: PATH }, error: null });
  createSignedUrl.mockResolvedValue({ data: { signedUrl: 'http://127.0.0.1:54321/storage/v1/object/sign/traveller-id-proofs/x?token=synthetic' }, error: null });
});

describe('form parsers and refusal tokens', () => {
  it('upload: dealId, travellerSeq, requestId and the consent tick; never actor or entity', () => {
    expect(parseIdProofUploadForm(form({ dealId: DEAL, travellerSeq: '3', requestId: REQUEST, consent: 'on', userId: USER, legalEntityId: ENTITY }))).toEqual({
      ok: true,
      value: { dealId: DEAL, travellerSeq: 3, requestId: REQUEST, consent: true },
    });
    expect(parseIdProofUploadForm(form({ dealId: DEAL, travellerSeq: '3', requestId: REQUEST }))).toMatchObject({ ok: true, value: { consent: false } });
    expect(parseIdProofUploadForm(form({ dealId: 'x', travellerSeq: '0' }))).toEqual({ ok: false, fields: ['dealId', 'requestId', 'travellerSeq'] });
    expect(parseIdProofUploadForm(form({ dealId: DEAL, travellerSeq: '101', requestId: REQUEST }))).toEqual({ ok: false, fields: ['travellerSeq'] });
  });

  it('remove: the file id and the file’s own row version (≥ 1)', () => {
    expect(parseIdProofRemoveForm(form({ dealId: DEAL, fileId: FILE, fileRowVersion: '2' }))).toEqual({ ok: true, value: { dealId: DEAL, fileId: FILE, expectedRowVersion: 2 } });
    expect(parseIdProofRemoveForm(form({ dealId: DEAL, fileId: 'nope', fileRowVersion: '0' }))).toEqual({ ok: false, fields: ['fileId', 'fileRowVersion'] });
  });

  it('new tokens map by SQLSTATE + exact token only', () => {
    expect(BOOKING_ERROR_STATES.id_proof_limit).toBe('55000');
    expect(BOOKING_ERROR_STATES.consent_required).toBe('22023');
    expect(mapBookingError({ code: '55000', message: 'id_proof_limit' })).toBe('id_proof_limit');
    expect(mapBookingError({ code: '22023', message: 'consent_required' })).toBe('consent_required');
    expect(mapBookingError({ code: '55000', message: 'consent_required' })).toBeNull();
    expect(ERROR_TEXT.id_proof_limit).toMatch(/Remove one first/);
  });
});

describe('uploadTravellerIdProofAction', () => {
  it('session first: nothing touches the database or Storage', async () => {
    requireStaff.mockRejectedValue(new Error('NEXT_REDIRECT /mfa/challenge'));
    await expect(actions.uploadTravellerIdProofAction(null, upForm())).rejects.toThrow('NEXT_REDIRECT');
    expect(rpc).not.toHaveBeenCalled();
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('DEC-39: without the consent tick nothing is called or uploaded', async () => {
    await expect(actions.uploadTravellerIdProofAction(null, upForm(jpeg(), {}))).resolves.toEqual({
      ok: false,
      code: 'consent_required',
      message: ERROR_TEXT.consent_required,
      fields: [ID_PROOF_FIELD.consent],
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('refuses a wrong type, a disguised file, an empty file or one over 4 MiB before any call', async () => {
    const cases = [
      new File([new Uint8Array([1, 2, 3])], 'a.txt', { type: 'text/plain' }),
      new File([new Uint8Array(64)], 'fake.jpg', { type: 'image/jpeg' }),
      new File([], 'empty.pdf', { type: 'application/pdf' }),
      new File([JPEG, new Uint8Array(ID_PROOF_MAX_BYTES)], 'big.jpg', { type: 'image/jpeg' }),
    ];
    for (const file of cases) {
      await expect(actions.uploadTravellerIdProofAction(null, upForm(file))).resolves.toEqual({ ok: false, code: 'evidence_rejected', message: ID_PROOF_TEXT.rejected, fields: ['file'] });
    }
    expect(rpc).not.toHaveBeenCalled();
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('begin (own session, consent true) → privileged upload to the private bucket → finish(true)', async () => {
    rpcReplies({ traveller_id_proof_begin: begun(), traveller_id_proof_finish: finished('stored') });
    await expect(actions.uploadTravellerIdProofAction(null, upForm())).resolves.toEqual({
      ok: true,
      data: { fileId: FILE, travellerSeq: 2, status: 'stored' },
      message: ID_PROOF_TEXT.uploaded,
    });
    expect(rpc).toHaveBeenNthCalledWith(1, 'traveller_id_proof_begin', {
      p_deal_id: DEAL,
      p_seq: 2,
      p_request_id: REQUEST,
      p_consent: true,
      p_file_name: 'aadhaar front.jpg',
      p_mime: 'image/jpeg',
      p_size_bytes: JPEG.byteLength,
      p_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(storageFrom).toHaveBeenCalledWith(ID_PROOF_BUCKET);
    expect(upload).toHaveBeenCalledWith(PATH, expect.any(Uint8Array), { contentType: 'image/jpeg', upsert: false });
    expect(rpc).toHaveBeenNthCalledWith(2, 'traveller_id_proof_finish', { p_file_id: FILE, p_ok: true });
    expect(rpc.mock.invocationCallOrder[0]!).toBeLessThan(upload.mock.invocationCallOrder[0]!);
    expect(revalidatePath).toHaveBeenCalledWith(`/app/deals/${DEAL}/book`);
  });

  it('database refusals stop before Storage, in frozen words', async () => {
    const cases: Array<[{ code: string; message: string; hint?: string }, Record<string, unknown>]> = [
      [{ code: '42501', message: 'not_authorized' }, { code: 'not_authorized', message: ERROR_TEXT.not_authorized }],
      [{ code: '55000', message: 'id_proof_limit' }, { code: 'id_proof_limit', message: ERROR_TEXT.id_proof_limit }],
      [{ code: '22023', message: 'evidence_rejected' }, { code: 'evidence_rejected', message: ID_PROOF_TEXT.rejected, fields: ['file'] }],
      [{ code: '22023', message: 'invalid_input', hint: 'seq' }, { code: 'invalid_input', fields: ['travellerSeq'] }],
      [{ code: 'P0002', message: 'not_found' }, { code: 'not_found', message: ID_PROOF_TEXT.travellerChanged }],
      [{ code: '40001', message: 'request_conflict' }, { code: 'request_conflict' }],
      [{ code: '55000', message: 'deal_not_active' }, { code: 'deal_not_active' }],
    ];
    for (const [error, expected] of cases) {
      rpcReplies({ traveller_id_proof_begin: { error } });
      await expect(actions.uploadTravellerIdProofAction(null, upForm())).resolves.toMatchObject({ ok: false, ...expected });
    }
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('a failed Storage upload is recorded as failed and reported, never as stored', async () => {
    upload.mockResolvedValue({ data: null, error: { message: 'boom' } });
    rpcReplies({ traveller_id_proof_begin: begun(), traveller_id_proof_finish: finished('failed') });
    await expect(actions.uploadTravellerIdProofAction(null, upForm())).resolves.toMatchObject({ ok: false, code: 'upload_failed' });
    expect(rpc).toHaveBeenLastCalledWith('traveller_id_proof_finish', { p_file_id: FILE, p_ok: false });
  });

  it('an exact retry never uploads or finishes twice: stored → already attached; pending → still uploading; failed/removed → honest text', async () => {
    rpcReplies({ traveller_id_proof_begin: begun({ outcome: 'existing', status: 'stored', rowVersion: 2, objectPath: null }) });
    await expect(actions.uploadTravellerIdProofAction(null, upForm())).resolves.toEqual({
      ok: true,
      data: { fileId: FILE, travellerSeq: 2, status: 'stored' },
      message: ID_PROOF_TEXT.alreadyUploaded,
    });
    rpcReplies({ traveller_id_proof_begin: begun({ outcome: 'existing', status: 'failed', rowVersion: 2, objectPath: null }) });
    await expect(actions.uploadTravellerIdProofAction(null, upForm())).resolves.toMatchObject({ ok: false, code: 'upload_failed' });
    expect(adminFactory).not.toHaveBeenCalled();

    // Double submit: the first request is still uploading. The second must not upload, and must not finish (that could mark it failed).
    rpcReplies({ traveller_id_proof_begin: begun({ outcome: 'existing' }) });
    await expect(actions.uploadTravellerIdProofAction(null, upForm())).resolves.toEqual({ ok: false, code: 'upload_failed', message: ID_PROOF_TEXT.stillUploading });
    rpcReplies({ traveller_id_proof_begin: begun({ outcome: 'existing', status: 'removed', objectPath: null }) });
    await expect(actions.uploadTravellerIdProofAction(null, upForm())).resolves.toEqual({ ok: false, code: 'upload_failed', message: ID_PROOF_TEXT.travellerChanged });
    expect(adminFactory).not.toHaveBeenCalled();
    expect(rpc.mock.calls.map((c) => c[0])).not.toContain('traveller_id_proof_finish');
  });

  it('a traveller removed or renamed since the page loaded: honest repair text, nothing uploaded', async () => {
    rpcReplies({ traveller_id_proof_begin: { error: { code: 'P0002', message: 'not_found' } } });
    await expect(actions.uploadTravellerIdProofAction(null, upForm())).resolves.toEqual({ ok: false, code: 'not_found', message: ID_PROOF_TEXT.travellerChanged });
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('an unseen finish outcome is never reported as nothing changed', async () => {
    rpcReplies({ traveller_id_proof_begin: begun(), traveller_id_proof_finish: { throws: true } });
    await expect(actions.uploadTravellerIdProofAction(null, upForm())).resolves.toEqual({ ok: false, code: 'upload_failed', message: UNKNOWN_OUTCOME_TEXT });
  });

  it('a malformed begin reply (bad path, or a path while not pending) never reaches Storage', async () => {
    rpcReplies({ traveller_id_proof_begin: begun({ objectPath: '../../etc/passwd' }) });
    await expect(actions.uploadTravellerIdProofAction(null, upForm())).rejects.toThrow(UNKNOWN_OUTCOME_TEXT);
    rpcReplies({ traveller_id_proof_begin: begun({ objectPath: `${ENTITY}/${DEAL}/${FILE}` }) });
    await expect(actions.uploadTravellerIdProofAction(null, upForm())).rejects.toThrow(UNKNOWN_OUTCOME_TEXT);
    rpcReplies({ traveller_id_proof_begin: begun({ status: 'stored' }) });
    await expect(actions.uploadTravellerIdProofAction(null, upForm())).rejects.toThrow(UNKNOWN_OUTCOME_TEXT);
    rpcReplies({ traveller_id_proof_begin: begun({ objectPath: null }) });
    await expect(actions.uploadTravellerIdProofAction(null, upForm())).rejects.toThrow(UNKNOWN_OUTCOME_TEXT);
    expect(adminFactory).not.toHaveBeenCalled();
  });
});

describe('removeTravellerIdProofAction', () => {
  it('soft removal with the file’s own row version; no Storage call', async () => {
    rpcReplies({ traveller_id_proof_remove: { data: { fileId: FILE, status: 'removed', rowVersion: 3 } } });
    await expect(actions.removeTravellerIdProofAction(null, form({ dealId: DEAL, fileId: FILE, fileRowVersion: '2' }))).resolves.toEqual({
      ok: true,
      data: { fileId: FILE, status: 'removed', rowVersion: 3 },
      message: ID_PROOF_TEXT.removed,
    });
    expect(rpc).toHaveBeenCalledWith('traveller_id_proof_remove', { p_file_id: FILE, p_expected_row_version: 2 });
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('a Deal removed in Bitrix: remove and attach refuse with honest words', async () => {
    rpcReplies({ traveller_id_proof_remove: { error: { code: '55000', message: 'deal_removed' } } });
    await expect(actions.removeTravellerIdProofAction(null, form({ dealId: DEAL, fileId: FILE, fileRowVersion: '1' }))).resolves.toEqual({ ok: false, code: 'deal_removed', message: ID_PROOF_TEXT.dealRemoved });
    rpcReplies({ traveller_id_proof_begin: { error: { code: '55000', message: 'deal_removed' } } });
    await expect(actions.uploadTravellerIdProofAction(null, upForm())).resolves.toEqual({ ok: false, code: 'deal_removed', message: ID_PROOF_TEXT.dealRemoved });
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('stale row version and other refusals in frozen words; malformed post refused before any call', async () => {
    rpcReplies({ traveller_id_proof_remove: { error: { code: '40001', message: 'version_changed' } } });
    await expect(actions.removeTravellerIdProofAction(null, form({ dealId: DEAL, fileId: FILE, fileRowVersion: '1' }))).resolves.toMatchObject({ ok: false, code: 'version_changed' });
    rpcReplies({ traveller_id_proof_remove: { error: { code: '42501', message: 'not_authorized' } } });
    await expect(actions.removeTravellerIdProofAction(null, form({ dealId: DEAL, fileId: FILE, fileRowVersion: '1' }))).resolves.toMatchObject({ ok: false, code: 'not_authorized' });
    rpc.mockClear();
    await expect(actions.removeTravellerIdProofAction(null, form({ dealId: DEAL, fileId: FILE }))).resolves.toMatchObject({ ok: false, code: 'invalid_input', fields: ['fileRowVersion'] });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('idProofDownloadResponse (/app/id-proofs/[fileId])', () => {
  it('authorizes under the session, then signs a short URL with a neutral download name; never cached', async () => {
    rpcReplies({ traveller_id_proof_authorize_download: { data: { objectPath: PATH, fileName: 'aadhaar front.jpg', mime: 'image/jpeg' } } });
    const res = await idProofDownloadResponse(FILE);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toMatch(/^http:\/\/127\.0\.0\.1:54321\/storage\//);
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    expect(storageFrom).toHaveBeenCalledWith(ID_PROOF_BUCKET);
    // Never the stored name (it may carry the customer's name) in the URL or logs.
    expect(createSignedUrl).toHaveBeenCalledWith(PATH, 60, { download: 'id-proof.jpg' });
    expect(rpc).toHaveBeenCalledWith('traveller_id_proof_authorize_download', { p_file_id: FILE });
    expect(rpc.mock.invocationCallOrder[0]!).toBeLessThan(createSignedUrl.mock.invocationCallOrder[0]!);
  });

  it('every refusal is the same 404: malformed id, not authorized, not stored, removed Deal, a path for another file', async () => {
    expect((await idProofDownloadResponse('x')).status).toBe(404);
    for (const error of [
      { code: '42501', message: 'not_authorized' },
      { code: 'P0002', message: 'not_found' },
      { code: '55000', message: 'deal_removed' },
    ]) {
      rpcReplies({ traveller_id_proof_authorize_download: { error } });
      expect((await idProofDownloadResponse(FILE)).status).toBe(404);
    }
    rpcReplies({ traveller_id_proof_authorize_download: { data: { objectPath: `${ENTITY}/${DEAL}/${TRAVELLER}/${OTHER_FILE}`, fileName: 'a.jpg', mime: 'image/jpeg' } } });
    expect((await idProofDownloadResponse(FILE)).status).toBe(404);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it('a foreign signed-URL origin is refused (503), never redirected to', async () => {
    rpcReplies({ traveller_id_proof_authorize_download: { data: { objectPath: PATH, fileName: 'a.jpg', mime: 'image/jpeg' } } });
    createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://evil.example/x' }, error: null });
    expect((await idProofDownloadResponse(FILE)).status).toBe(503);
  });
});

describe('loadTaskIdProofs (department task screens)', () => {
  const staff = { supabase: { rpc } } as never;
  it('maps stored proofs of the task’s travellers with the audited link; nothing else', async () => {
    rpcReplies({
      traveller_id_proofs_for_task: {
        data: {
          taskId: TASK,
          travellers: [
            { seq: 1, fullName: 'Asha (synthetic)', type: 'adult', idProofs: [{ fileId: FILE, fileName: 'aadhaar front.jpg', mime: 'image/jpeg', sizeBytes: 1_200_000, storedAt: '2026-10-12T08:30:02Z' }] },
            { seq: 3, fullName: 'Ravi (synthetic)', type: 'child', idProofs: [] },
          ],
        },
      },
    });
    const view = await loadTaskIdProofs(staff, TASK);
    expect(view).toEqual({
      taskId: TASK,
      travellers: [
        {
          seq: 1,
          fullName: 'Asha (synthetic)',
          type: 'adult',
          idProofs: [{ fileId: FILE, fileName: 'aadhaar front.jpg', mime: 'image/jpeg', sizeLabel: expect.stringMatching(/MB$/), storedAt: '2026-10-12T08:30:02Z', downloadHref: `/app/id-proofs/${FILE}` }],
        },
        { seq: 3, fullName: 'Ravi (synthetic)', type: 'child', idProofs: [] },
      ],
    });
    expect(rpc).toHaveBeenCalledWith('traveller_id_proofs_for_task', { p_task_id: TASK });
  });

  it('null when not allowed, not visible, malformed or not installed; a refused session is explicit, never hidden; unexplained failure → retry text', async () => {
    rpcReplies({ traveller_id_proofs_for_task: { data: null } });
    await expect(loadTaskIdProofs(staff, TASK)).resolves.toBeNull();
    rpcReplies({ traveller_id_proofs_for_task: { error: { code: 'PGRST202', message: 'missing' } } });
    await expect(loadTaskIdProofs(staff, TASK)).resolves.toBeNull();
    rpcReplies({ traveller_id_proofs_for_task: { error: { code: '42501', message: 'not_authorized' } } });
    await expect(loadTaskIdProofs(staff, TASK)).resolves.toBe(ID_PROOFS_REFUSED);
    rpcReplies({ traveller_id_proofs_for_task: { error: { code: 'PGRST301', message: 'JWT expired' } } });
    await expect(loadTaskIdProofs(staff, TASK)).resolves.toBe(ID_PROOFS_REFUSED);
    await expect(loadTaskIdProofs(staff, 'nope')).resolves.toBeNull();
    rpcReplies({ traveller_id_proofs_for_task: { error: { code: 'XX000', message: 'boom SECRET' } } });
    await expect(loadTaskIdProofs(staff, TASK)).rejects.toThrow('Could not load the traveller ID proofs. Please retry.');
    rpcReplies({ traveller_id_proofs_for_task: { data: { taskId: TASK, travellers: [{ seq: 1, fullName: 'A', type: 'adult', idProofs: [{ fileId: FILE, fileName: 'a.jpg', mime: 'image/gif', sizeBytes: 1, storedAt: '2026-10-12T08:30:02Z' }] }] } } });
    await expect(loadTaskIdProofs(staff, TASK)).rejects.toThrow('Please retry');
  });
});

describe('loadDealIdProofs (Accounts deal screen and other viewers, D2-5)', () => {
  const staff = { supabase: { rpc } } as never;
  it('every traveller with stored proofs and the audited link', async () => {
    rpcReplies({
      traveller_id_proofs_for_deal: {
        data: {
          dealId: DEAL,
          travellers: [
            { seq: 1, fullName: 'Asha (synthetic)', type: 'adult', idProofs: [{ fileId: FILE, fileName: 'id.pdf', mime: 'application/pdf', sizeBytes: 2048, storedAt: '2026-10-12T08:30:02Z' }] },
            { seq: 4, fullName: 'New (synthetic)', type: 'infant', idProofs: [] },
          ],
        },
      },
    });
    await expect(loadDealIdProofs(staff, DEAL)).resolves.toEqual({
      dealId: DEAL,
      travellers: [
        { seq: 1, fullName: 'Asha (synthetic)', type: 'adult', idProofs: [{ fileId: FILE, fileName: 'id.pdf', mime: 'application/pdf', sizeLabel: expect.any(String), storedAt: '2026-10-12T08:30:02Z', downloadHref: `/app/id-proofs/${FILE}` }] },
        { seq: 4, fullName: 'New (synthetic)', type: 'infant', idProofs: [] },
      ],
    });
    expect(rpc).toHaveBeenCalledWith('traveller_id_proofs_for_deal', { p_deal_id: DEAL });
  });

  it('null (no viewer rule, removed Deal, malformed id, not installed); refused session explicit; unexplained → retry text', async () => {
    rpcReplies({ traveller_id_proofs_for_deal: { data: null } });
    await expect(loadDealIdProofs(staff, DEAL)).resolves.toBeNull();
    rpcReplies({ traveller_id_proofs_for_deal: { error: { code: '42883', message: 'missing' } } });
    await expect(loadDealIdProofs(staff, DEAL)).resolves.toBeNull();
    await expect(loadDealIdProofs(staff, 'nope')).resolves.toBeNull();
    rpcReplies({ traveller_id_proofs_for_deal: { error: { code: '42501', message: 'not_authorized' } } });
    await expect(loadDealIdProofs(staff, DEAL)).resolves.toBe(ID_PROOFS_REFUSED);
    rpcReplies({ traveller_id_proofs_for_deal: { error: { code: 'XX000', message: 'boom SECRET' } } });
    await expect(loadDealIdProofs(staff, DEAL)).rejects.toThrow('Could not load the traveller ID proofs. Please retry.');
  });
});

describe('booking_form_get idProofs and limits → view; checklist', () => {
  const base = {
    dealId: DEAL,
    canEdit: true,
    canConfirm: null,
    serviceItemsEnabled: true,
    version: null,
    billing: { status: 'none', prefillSource: null, rowVersion: 0 },
    items: [],
    evidence: [],
    idProofLimits: { maxFilesPerTraveller: 4, maxBytes: 4194304 },
  };
  const file = (over: Record<string, unknown> = {}) => ({
    fileId: FILE,
    fileName: 'aadhaar front.jpg',
    mime: 'image/jpeg',
    sizeBytes: 1_200_000,
    status: 'stored',
    rowVersion: 2,
    uploadedByName: 'Sample Sales (synthetic)',
    uploadedByYou: true,
    consentByName: 'Sample Sales (synthetic)',
    consentAt: '2026-10-12T08:29:00Z',
    createdAt: '2026-10-12T08:30:00Z',
    storedAt: '2026-10-12T08:30:02Z',
    ...over,
  });
  const traveller = (over: Record<string, unknown> = {}) => ({ travellerId: TRAVELLER, seq: 1, fullName: 'Asha', type: 'adult', ...over });

  it('absent key → no proofs member (viewer rule failed); present → explicit copies with links only for stored files', () => {
    const none = BookingFormSchema.parse({ ...base, travellers: [traveller()] });
    expect(none.travellers[0]!.idProofs).toBeUndefined();
    expect(none.idProofLimits).toEqual({ maxFilesPerTraveller: 4, maxBytes: 4194304 });
    const parsed = BookingFormSchema.parse({ ...base, travellers: [traveller({ idProofs: [file(), file({ fileId: OTHER_FILE, status: 'pending_upload', storedAt: null })] })] });
    expect(toIdProofViews(parsed.travellers[0]!.idProofs!)).toEqual([
      {
        fileId: FILE,
        fileName: 'aadhaar front.jpg',
        mime: 'image/jpeg',
        sizeBytes: 1_200_000,
        sizeLabel: expect.stringMatching(/MB$/),
        status: 'stored',
        rowVersion: 2,
        uploadedByName: 'Sample Sales (synthetic)',
        uploadedByYou: true,
        uploadedAt: '2026-10-12T08:30:00Z',
        storedAt: '2026-10-12T08:30:02Z',
        consentByName: 'Sample Sales (synthetic)',
        consentAt: '2026-10-12T08:29:00Z',
        downloadHref: `/app/id-proofs/${FILE}`,
      },
      expect.objectContaining({ fileId: OTHER_FILE, status: 'pending_upload', downloadHref: null }),
    ]);
  });

  it('4 stored + 2 failed files still load the form (failed files do not count); the traveller has no slot left', () => {
    const six = [...Array.from({ length: 4 }, () => file()), file({ status: 'failed', storedAt: null }), file({ status: 'failed', storedAt: null })];
    const parsed = BookingFormSchema.parse({ ...base, travellers: [traveller({ idProofs: six })] });
    const views = toIdProofViews(parsed.travellers[0]!.idProofs!);
    expect(views).toHaveLength(6);
    expect(idProofSlotsLeft(views, { maxFilesPerTraveller: 4, maxBytes: 4194304 })).toBe(0);
    expect(idProofSlotsLeft(views.slice(2), { maxFilesPerTraveller: 4, maxBytes: 4194304 })).toBe(2);
    expect(idProofSlotsLeft(undefined, { maxFilesPerTraveller: 4, maxBytes: 4194304 })).toBe(4);
    expect(idProofSlotsLeft(views, null)).toBeNull();
  });

  it('D3-3: a renamed traveller who had a live proof is reported (spacing and case are not a rename); a removed traveller is not', () => {
    const t = (seq: number, fullName: string, statuses: string[] | undefined) => ({ seq, fullName, idProofs: statuses?.map((status) => ({ status })) });
    const before = { travellers: [t(1, 'Asha  Rao', ['stored']), t(2, 'Ravi', ['stored']), t(3, 'Meera', ['failed']), t(4, 'Gone', ['stored']), t(5, 'Hidden', undefined)] } as never;
    const after = { travellers: [t(1, 'asha rao', []), t(2, 'Ravi Kumar', []), t(3, 'Meera K', []), t(5, 'Hidden Two', undefined)] } as never;
    expect(idProofsDetachedByRename(before, after)).toEqual([{ seq: 2, fullName: 'Ravi Kumar' }]);
    expect(ID_PROOF_TEXT.detachedOnRename.replace('{name}', 'Ravi Kumar')).toBe('ID proof removed because the name changed — attach it again for Ravi Kumar.');
  });

  it('a removed row or an oversized file fails the shape (fail closed)', () => {
    const bad = (proofs: unknown[]) => BookingFormSchema.safeParse({ ...base, travellers: [traveller({ idProofs: proofs })] }).success;
    expect(bad([file({ status: 'removed' })])).toBe(false);
    expect(bad([file({ sizeBytes: ID_PROOF_MAX_BYTES + 1 })])).toBe(false);
  });

  it('DEC-38: adults blocking, children a warning, both on step 1 passengers with the traveller numbers', () => {
    expect(CHECKLIST_STEP.id_proof_missing).toEqual({ step: 'travellers', section: 'passengers', field: 'file' });
    expect(CHECKLIST_STEP.id_proof_missing_child).toEqual({ step: 'travellers', section: 'passengers', field: 'file' });
    const merged = mergeBookChecklist(
      {
        items: [
          { code: 'id_proof_missing', blocking: true, owner: 'sales', itemNos: [], travellerSeqs: [1, 2] },
          { code: 'id_proof_missing_child', blocking: false, owner: 'sales', itemNos: [], travellerSeqs: [3] },
        ],
        canConfirm: false,
      },
      ['id_proof_missing'],
    );
    expect(merged.map((i) => [i.code, i.step, i.section, i.blocking, i.travellerSeqs])).toEqual([
      ['id_proof_missing', 'travellers', 'passengers', true, [1, 2]],
      ['id_proof_missing_child', 'travellers', 'passengers', false, [3]],
    ]);
    expect(merged[0]!.text).toBe(`${ISSUE_TEXT.id_proof_missing} (traveller 1, 2)`);
    // Readiness alone (no checklist) still blocks on step 1.
    expect(mergeBookChecklist(null, ['id_proof_missing'])).toMatchObject([{ code: 'id_proof_missing', step: 'travellers', section: 'passengers', blocking: true }]);
  });
});
