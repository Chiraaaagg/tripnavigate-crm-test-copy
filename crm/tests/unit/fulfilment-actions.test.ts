import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIRM_SUCCESS_TEXT, ERROR_TEXT, EVIDENCE_MAX_BYTES, UNKNOWN_OUTCOME_TEXT } from '@/modules/fulfilment/contracts';

/**
 * Booking server actions with fake RPC / Storage clients. Ordering contract:
 * session gate first, then the database command under the staff member's own
 * session, and the privileged client only for Storage after begin_evidence.
 */

const requireStaff = vi.fn();
const rpc = vi.fn();
const upload = vi.fn();
const remove = vi.fn();
const adminFactory = vi.fn();
const revalidatePath = vi.fn();

vi.mock('@/modules/identity/server/session', () => ({ requireStaff: () => requireStaff() }));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: () => adminFactory() }));
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

const actions = await import('@/modules/fulfilment/server/actions');

const USER = 'a0000000-0000-4000-8000-000000000001';
const DEAL = 'd0000000-0000-4000-8000-000000000001';
const VERSION = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const EVIDENCE = '44444444-4444-4444-8444-444444444444';
const ENTITY = 'e0000000-0000-4000-8000-000000000001';
const PATH = `${ENTITY}/${DEAL}/${VERSION}/${EVIDENCE}`;
const HASH = 'c'.repeat(64);

const PDF = (() => {
  const b = new Uint8Array(128);
  b.set([0x25, 0x50, 0x44, 0x46, 0x2d]);
  return b;
})();

function form(fields: Record<string, string | Blob>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

type RpcReply = { data?: unknown; error?: { code: string; message: string } | null };
function rpcReplies(map: Record<string, RpcReply | RpcReply[]>) {
  const queues = Object.fromEntries(Object.entries(map).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  rpc.mockImplementation(async (fn: string) => {
    const queue = queues[fn];
    if (!queue || queue.length === 0) throw new Error(`unexpected rpc ${fn}`);
    const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
    return { data: reply.data ?? null, error: reply.error ?? null };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireStaff.mockResolvedValue({ userId: USER, supabase: { rpc } });
  adminFactory.mockReturnValue({ storage: { from: () => ({ upload, remove }) } });
  upload.mockResolvedValue({ data: { path: PATH }, error: null });
  remove.mockResolvedValue({ data: [], error: null });
});

describe('session gate', () => {
  it.each([
    ['open', () => actions.openBookingDraftAction(null, form({ dealId: DEAL }))],
    ['upload', () => actions.uploadBookingEvidenceAction(null, form({ dealId: DEAL, versionId: VERSION, kind: 'ticket', file: new File([PDF], 'a.pdf', { type: 'application/pdf' }) }))],
    ['confirm', () => actions.confirmBookingAction(null, form({ dealId: DEAL, versionId: VERSION, contentHash: HASH }))],
    ['claim', () => actions.claimPurchaseTaskAction(null, form({ taskId: TASK }))],
  ])('%s stops before any database or storage call', async (_n, run) => {
    requireStaff.mockRejectedValue(new Error('NEXT_REDIRECT /mfa/challenge'));
    await expect(run()).rejects.toThrow('NEXT_REDIRECT');
    expect(rpc).not.toHaveBeenCalled();
    expect(adminFactory).not.toHaveBeenCalled();
  });
});

describe('openBookingDraftAction / saveBookingDraftAction', () => {
  it('opens under the user session and ignores client-supplied identity fields', async () => {
    rpcReplies({ booking_open_draft: { data: { versionId: VERSION, versionNo: 1, rowVersion: 0, created: true } } });
    const result = await actions.openBookingDraftAction(null, form({ dealId: DEAL, userId: 'x', legalEntityId: ENTITY }));
    expect(result).toMatchObject({ ok: true, data: { versionId: VERSION, created: true } });
    expect(rpc).toHaveBeenCalledWith('booking_open_draft', { p_deal_id: DEAL });
    expect(revalidatePath).toHaveBeenCalledWith(`/app/deals/${DEAL}`);
  });

  it('maps already_confirmed to frozen wording', async () => {
    rpcReplies({ booking_open_draft: { error: { code: '55000', message: 'already_confirmed' } } });
    await expect(actions.openBookingDraftAction(null, form({ dealId: DEAL }))).resolves.toEqual({
      ok: false,
      code: 'already_confirmed',
      message: ERROR_TEXT.already_confirmed,
    });
  });

  it('rejects malformed input without calling the database', async () => {
    await expect(actions.saveBookingDraftAction(null, form({ dealId: DEAL, versionId: VERSION, rowVersion: 'x' }))).resolves.toMatchObject({
      ok: false,
      code: 'invalid_input',
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('save returns version_changed on a stale row version', async () => {
    rpcReplies({ booking_save_draft: { error: { code: '40001', message: 'version_changed' } } });
    const result = await actions.saveBookingDraftAction(
      null,
      form({ dealId: DEAL, versionId: VERSION, rowVersion: '2', hotelName: 'Synthetic', sellingTotalRupees: '100' }),
    );
    expect(result).toEqual({ ok: false, code: 'version_changed', message: ERROR_TEXT.version_changed });
    expect(rpc.mock.calls[0]![1]).toMatchObject({
      p_expected_row_version: 2,
      p_selling_total_paise: '10000',
      p_selling_total_provided: true,
    });
  });

  it('save without the selling field sends provided=false', async () => {
    rpcReplies({ booking_save_draft: { data: { versionId: VERSION, rowVersion: 3, contentHash: HASH } } });
    await actions.saveBookingDraftAction(null, form({ dealId: DEAL, versionId: VERSION, rowVersion: '2', hotelName: 'Synthetic' }));
    expect(rpc.mock.calls[0]![1]).toMatchObject({ p_selling_total_paise: null, p_selling_total_provided: false });
  });

  it('rethrows unexpected failures without the database message', async () => {
    rpcReplies({ booking_open_draft: { error: { code: 'XX000', message: 'internal detail SECRET' } } });
    const error = await actions.openBookingDraftAction(null, form({ dealId: DEAL })).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('SECRET');
    expect((error as Error).message).toBe(UNKNOWN_OUTCOME_TEXT);
  });
});

describe('uploadBookingEvidenceAction', () => {
  const pdf = () => new File([PDF], 'Ticket <1>.pdf', { type: 'application/pdf' });
  const fields = () => ({ dealId: DEAL, versionId: VERSION, kind: 'ticket', file: pdf() });

  it('validates, begins, uploads with upsert:false and finishes ok', async () => {
    rpcReplies({
      booking_begin_evidence: { data: { evidenceId: EVIDENCE, objectPath: PATH } },
      booking_finish_evidence: { data: { evidenceId: EVIDENCE, status: 'stored' } },
    });
    const result = await actions.uploadBookingEvidenceAction(null, form(fields()));
    expect(result).toMatchObject({ ok: true, data: { evidenceId: EVIDENCE } });
    const begin = rpc.mock.calls.find((c) => c[0] === 'booking_begin_evidence')![1];
    expect(begin).toMatchObject({ p_version_id: VERSION, p_kind: 'ticket', p_file_name: 'Ticket 1.pdf', p_mime: 'application/pdf', p_size_bytes: 128 });
    expect(begin.p_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(upload).toHaveBeenCalledWith(PATH, expect.any(Uint8Array), { contentType: 'application/pdf', upsert: false });
    expect(rpc).toHaveBeenLastCalledWith('booking_finish_evidence', { p_evidence_id: EVIDENCE, p_ok: true });
  });

  it.each([
    ['bad magic bytes', new File([new TextEncoder().encode('<html>')], 'a.pdf', { type: 'application/pdf' })],
    ['wrong mime', new File([PDF], 'a.html', { type: 'text/html' })],
    ['oversize', new File([new Uint8Array(EVIDENCE_MAX_BYTES + 1)], 'a.pdf', { type: 'application/pdf' })],
  ])('rejects %s before any database or storage call', async (_n, file) => {
    const result = await actions.uploadBookingEvidenceAction(null, form({ ...fields(), file }));
    expect(result).toEqual({ ok: false, code: 'evidence_rejected', message: ERROR_TEXT.evidence_rejected });
    expect(rpc).not.toHaveBeenCalled();
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('never touches storage when begin is refused', async () => {
    rpcReplies({ booking_begin_evidence: { error: { code: '42501', message: 'not_authorized' } } });
    const result = await actions.uploadBookingEvidenceAction(null, form(fields()));
    expect(result).toMatchObject({ ok: false, code: 'not_authorized' });
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('upload failure → finish(false) and upload_failed', async () => {
    rpcReplies({
      booking_begin_evidence: { data: { evidenceId: EVIDENCE, objectPath: PATH } },
      booking_finish_evidence: { data: { evidenceId: EVIDENCE, status: 'failed' } },
    });
    upload.mockResolvedValue({ data: null, error: { message: 'storage down' } });
    const result = await actions.uploadBookingEvidenceAction(null, form(fields()));
    expect(result).toEqual({ ok: false, code: 'upload_failed', message: ERROR_TEXT.upload_failed });
    expect(rpc).toHaveBeenLastCalledWith('booking_finish_evidence', { p_evidence_id: EVIDENCE, p_ok: false });
  });

  it('missing storage credentials count as an upload failure', async () => {
    rpcReplies({
      booking_begin_evidence: { data: { evidenceId: EVIDENCE, objectPath: PATH } },
      booking_finish_evidence: { data: { evidenceId: EVIDENCE, status: 'failed' } },
    });
    adminFactory.mockImplementation(() => {
      throw new Error('SUPABASE_SECRET_KEY is not configured.');
    });
    await expect(actions.uploadBookingEvidenceAction(null, form(fields()))).resolves.toMatchObject({ code: 'upload_failed' });
    expect(rpc).toHaveBeenLastCalledWith('booking_finish_evidence', { p_evidence_id: EVIDENCE, p_ok: false });
  });

  it('H2: finish(true) answering failed (no matching object) → upload_failed', async () => {
    rpcReplies({
      booking_begin_evidence: { data: { evidenceId: EVIDENCE, objectPath: PATH } },
      booking_finish_evidence: { data: { evidenceId: EVIDENCE, status: 'failed' } },
    });
    const result = await actions.uploadBookingEvidenceAction(null, form(fields()));
    expect(result).toEqual({ ok: false, code: 'upload_failed', message: ERROR_TEXT.upload_failed });
    expect(remove).not.toHaveBeenCalled();
  });

  const panelWith = (status: string | null) => ({
    data: {
      dealId: DEAL,
      canEdit: true,
      canConfirm: true,
      gate: { realBookingEnabled: false, environment: 'test' },
      version: null,
      readiness: null,
      evidence:
        status === null
          ? []
          : [{ id: EVIDENCE, kind: 'ticket', fileName: 'a.pdf', sizeBytes: 128, status, uploadedByYou: true, createdAt: '2026-10-02T10:00:00Z' }],
      evidenceVisible: true,
      task: null,
    },
  });

  it('M1: finish(true) throwing but the row is stored → ok; the object is kept', async () => {
    rpcReplies({
      booking_begin_evidence: { data: { evidenceId: EVIDENCE, objectPath: PATH } },
      booking_finish_evidence: { error: { code: 'XX000', message: 'boom' } },
      booking_panel: panelWith('stored'),
    });
    const result = await actions.uploadBookingEvidenceAction(null, form(fields()));
    expect(result).toMatchObject({ ok: true, data: { evidenceId: EVIDENCE } });
    expect(remove).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('booking_panel', { p_deal_id: DEAL });
  });

  it.each([
    ['still pending', panelWith('pending_upload')],
    ['row not visible', panelWith(null)],
    ['re-read fails', { error: { code: 'XX000', message: 'down' } }],
  ])('M1: finish(true) throwing and %s → unknown outcome; object kept, never finished false', async (_n, panelReply) => {
    rpcReplies({
      booking_begin_evidence: { data: { evidenceId: EVIDENCE, objectPath: PATH } },
      booking_finish_evidence: { error: { code: 'XX000', message: 'boom' } },
      booking_panel: panelReply,
    });
    const result = await actions.uploadBookingEvidenceAction(null, form(fields()));
    expect(result).toEqual({ ok: false, code: 'upload_failed', message: UNKNOWN_OUTCOME_TEXT });
    expect(remove).not.toHaveBeenCalled();
    expect(rpc.mock.calls.filter((c) => c[0] === 'booking_finish_evidence')).toHaveLength(1);
  });

  it('rejects an unknown evidence kind and a missing file', async () => {
    await expect(actions.uploadBookingEvidenceAction(null, form({ ...fields(), kind: 'selfie' }))).resolves.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      actions.uploadBookingEvidenceAction(null, form({ dealId: DEAL, versionId: VERSION, kind: 'bill' })),
    ).resolves.toMatchObject({ code: 'evidence_rejected' });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('removeBookingEvidenceAction', () => {
  it('removes under the user session', async () => {
    rpcReplies({ booking_remove_evidence: { data: { evidenceId: EVIDENCE, status: 'removed' } } });
    await expect(actions.removeBookingEvidenceAction(null, form({ dealId: DEAL, evidenceId: EVIDENCE }))).resolves.toMatchObject({ ok: true });
    expect(rpc).toHaveBeenCalledWith('booking_remove_evidence', { p_evidence_id: EVIDENCE });
  });
});

describe('confirmBookingAction', () => {
  const fields = { dealId: DEAL, versionId: VERSION, contentHash: HASH };

  it('passes the expected content hash from the form', async () => {
    rpcReplies({ booking_confirm: { data: { outcome: 'created', taskId: TASK, versionId: VERSION } } });
    const result = await actions.confirmBookingAction(null, form(fields));
    expect(result).toMatchObject({ ok: true, data: { outcome: 'created', taskId: TASK }, message: CONFIRM_SUCCESS_TEXT });
    expect(rpc).toHaveBeenCalledWith('booking_confirm', { p_version_id: VERSION, p_expected_content_hash: HASH });
    expect(revalidatePath).toHaveBeenCalledWith('/app/purchase');
  });

  it("repeat confirmation → 'existing' with the same task id", async () => {
    rpcReplies({ booking_confirm: { data: { outcome: 'existing', taskId: TASK, versionId: VERSION } } });
    const result = await actions.confirmBookingAction(null, form(fields));
    expect(result.ok && result.data).toEqual({ outcome: 'existing', taskId: TASK, versionId: VERSION });
    // Never claims the hotel is booked (P3-15).
    expect(result.ok && result.message).toContain('The hotel is not booked yet.');
  });

  it('not_ready returns the repair list from booking_readiness', async () => {
    rpcReplies({
      booking_confirm: { error: { code: '55000', message: 'not_ready' } },
      booking_readiness: { data: { ready: false, issues: ['missing_acceptance_proof'], contentHash: HASH } },
    });
    await expect(actions.confirmBookingAction(null, form(fields))).resolves.toEqual({
      ok: false,
      code: 'not_ready',
      message: ERROR_TEXT.not_ready,
      issues: ['missing_acceptance_proof'],
    });
  });

  it.each(['version_changed', 'booking_disabled', 'environment_unset'] as const)('%s keeps the frozen wording', async (code) => {
    rpcReplies({ booking_confirm: { error: { code: code === 'version_changed' ? '40001' : '55000', message: code } } });
    await expect(actions.confirmBookingAction(null, form(fields))).resolves.toEqual({ ok: false, code, message: ERROR_TEXT[code] });
  });

  it('requires a well-formed content hash', async () => {
    await expect(actions.confirmBookingAction(null, form({ ...fields, contentHash: 'abc' }))).resolves.toMatchObject({
      code: 'invalid_input',
    });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('claimPurchaseTaskAction', () => {
  it('claims and reports idempotent re-claims', async () => {
    rpcReplies({ purchase_task_claim: { data: { taskId: TASK, status: 'in_progress', assignedToYou: true, alreadyYours: true } } });
    const result = await actions.claimPurchaseTaskAction(null, form({ taskId: TASK }));
    expect(result).toMatchObject({ ok: true, message: 'This task is already yours.' });
    expect(revalidatePath).toHaveBeenCalledWith(`/app/purchase/${TASK}`);
  });

  it('task_conflict for a task someone else took', async () => {
    rpcReplies({ purchase_task_claim: { error: { code: '40001', message: 'task_conflict' } } });
    await expect(actions.claimPurchaseTaskAction(null, form({ taskId: TASK }))).resolves.toEqual({
      ok: false,
      code: 'task_conflict',
      message: ERROR_TEXT.task_conflict,
    });
  });

  it('session errors map to the session message', async () => {
    rpcReplies({ purchase_task_claim: { error: { code: 'PGRST301', message: 'JWT expired' } } });
    await expect(actions.claimPurchaseTaskAction(null, form({ taskId: TASK }))).resolves.toMatchObject({ code: 'session' });
  });
});
