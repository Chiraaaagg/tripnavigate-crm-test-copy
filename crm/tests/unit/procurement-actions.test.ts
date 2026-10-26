import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  A1_TEXT,
  PROCUREMENT_ERROR_TEXT,
  PROCUREMENT_UNKNOWN_OUTCOME_TEXT,
  SUPPLIER_CONFIRM_SUCCESS_TEXT,
} from '@/modules/procurement/contracts';

/**
 * Phase 4 server actions with fake RPC / Storage clients: the session gate
 * comes first, every command runs under the staff member's own session, the
 * privileged client is used only for Storage after purchase_evidence_begin,
 * and an unknown outcome (lost response) is never reported as success or
 * failure. Synthetic ids only.
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
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));

const actions = await import('@/modules/procurement/server/actions');

const USER = 'a0000000-0000-4000-8000-000000000001';
const TASK = '22222222-2222-4222-8222-222222222222';
const EVIDENCE = '44444444-4444-4444-8444-444444444444';
const ENTITY = 'e0000000-0000-4000-8000-000000000001';
const PATH = `${ENTITY}/${TASK}/${EVIDENCE}`;

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

type RpcReply = { data?: unknown; error?: { code: string; message: string } | null; throws?: boolean };
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

const TASK_JSON = {
  taskId: TASK,
  dealReference: 'SYN-DEL-001',
  hotelName: 'Synthetic Hotel',
  city: 'Synthetic City',
  checkIn: '2026-12-10',
  checkOut: '2026-12-13',
  rooms: 1,
  adults: 2,
  children: 0,
  purchaseBudgetPaise: '4500000',
  status: 'in_progress',
  assigneeName: 'Synthetic Purchase',
  assignedToYou: true,
  branchName: 'Jodhpur',
  createdAt: '2026-10-03T05:00:00Z',
  supplierConfirmedAt: null,
  roomType: null,
  mealPlan: null,
  inclusions: null,
  specialRequests: null,
  confirmedAt: '2026-10-03T04:00:00Z',
  confirmedByName: 'Synthetic Sales',
  versionNo: 1,
  canClaim: false,
};
const workspaceWith = (status: string | null): RpcReply => ({
  data: {
    task: TASK_JSON,
    canWork: true,
    canRelease: true,
    canReassign: false,
    canApproveOverBudget: false,
    assigneeUserId: USER,
    reassignCandidates: [],
    gateIssue: null,
    issues: [],
    supplierReference: null,
    selectedQuoteId: null,
    supplierConfirmedByName: null,
    quotes: [],
    costVersions: [],
    evidence:
      status === null
        ? []
        : [
            {
              id: EVIDENCE,
              kind: 'supplier_confirmation',
              fileName: 'supplier.pdf',
              mime: 'application/pdf',
              sizeBytes: 128,
              status,
              createdAt: '2026-10-03T06:00:00Z',
              uploadedByName: 'Synthetic Purchase',
            },
          ],
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  requireStaff.mockResolvedValue({ userId: USER, supabase: { rpc } });
  adminFactory.mockReturnValue({ storage: { from: () => ({ upload, remove }) } });
  upload.mockResolvedValue({ data: { path: PATH }, error: null });
  remove.mockResolvedValue({ data: [], error: null });
});

const pdf = () => new File([PDF], 'Supplier <confirmation>.pdf', { type: 'application/pdf' });
const uploadFields = () => ({ taskId: TASK, kind: 'supplier_confirmation', file: pdf() });
const confirmFields = (reference = 'SYN-CONF-0001') => ({ taskId: TASK, expectedVersionNo: '1', reference });

describe('session gate', () => {
  it.each([
    ['upload', () => actions.uploadPurchaseEvidenceAction(null, form(uploadFields()))],
    ['confirm', () => actions.confirmSupplierAction(null, form(confirmFields()))],
    ['remove', () => actions.removePurchaseEvidenceAction(null, form({ taskId: TASK, evidenceId: EVIDENCE }))],
  ])('%s stops before any database or storage call', async (_n, run) => {
    requireStaff.mockRejectedValue(new Error('NEXT_REDIRECT /mfa/challenge'));
    await expect(run()).rejects.toThrow('NEXT_REDIRECT');
    expect(rpc).not.toHaveBeenCalled();
    expect(adminFactory).not.toHaveBeenCalled();
  });
});

describe('uploadPurchaseEvidenceAction', () => {
  it('begins under the user session, uploads to the generated path with upsert:false, finishes ok', async () => {
    rpcReplies({
      purchase_evidence_begin: { data: { evidenceId: EVIDENCE, objectPath: PATH } },
      purchase_evidence_finish: { data: { evidenceId: EVIDENCE, status: 'stored' } },
    });
    const result = await actions.uploadPurchaseEvidenceAction(null, form({ ...uploadFields(), userId: 'x', objectPath: 'other/path' }));
    expect(result).toMatchObject({ ok: true, data: { evidenceId: EVIDENCE } });
    const begin = rpc.mock.calls.find((c) => c[0] === 'purchase_evidence_begin')![1];
    expect(begin).toMatchObject({ p_task_id: TASK, p_kind: 'supplier_confirmation', p_mime: 'application/pdf', p_size_bytes: 128 });
    expect(upload).toHaveBeenCalledWith(PATH, expect.any(Uint8Array), { contentType: 'application/pdf', upsert: false });
    expect(rpc).toHaveBeenLastCalledWith('purchase_evidence_finish', { p_evidence_id: EVIDENCE, p_ok: true });
  });

  it('rejects a fake PDF before any database or storage call', async () => {
    const file = new File([new TextEncoder().encode('<html>')], 'a.pdf', { type: 'application/pdf' });
    const result = await actions.uploadPurchaseEvidenceAction(null, form({ ...uploadFields(), file }));
    expect(result).toEqual({ ok: false, code: 'evidence_rejected', message: PROCUREMENT_ERROR_TEXT.evidence_rejected });
    expect(rpc).not.toHaveBeenCalled();
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('never touches Storage when begin is refused (e.g. not the assignee)', async () => {
    rpcReplies({ purchase_evidence_begin: { error: { code: '42501', message: 'not_authorized' } } });
    const result = await actions.uploadPurchaseEvidenceAction(null, form(uploadFields()));
    expect(result).toEqual({ ok: false, code: 'not_authorized', message: PROCUREMENT_ERROR_TEXT.not_authorized });
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it('a lost begin response is an unknown outcome, never a Storage write', async () => {
    rpcReplies({ purchase_evidence_begin: { throws: true } });
    await expect(actions.uploadPurchaseEvidenceAction(null, form(uploadFields()))).rejects.toThrow(PROCUREMENT_UNKNOWN_OUTCOME_TEXT);
    expect(adminFactory).not.toHaveBeenCalled();
  });

  it.each([
    ['Storage answers an error', () => upload.mockResolvedValue({ data: null, error: { message: 'storage down' } })],
    ['the Storage call throws (response lost)', () => upload.mockRejectedValue(new TypeError('fetch failed'))],
  ])('%s → finish(false), upload_failed, nothing deleted', async (_n, arrange) => {
    arrange();
    rpcReplies({
      purchase_evidence_begin: { data: { evidenceId: EVIDENCE, objectPath: PATH } },
      purchase_evidence_finish: { data: { evidenceId: EVIDENCE, status: 'failed' } },
    });
    const result = await actions.uploadPurchaseEvidenceAction(null, form(uploadFields()));
    expect(result).toEqual({ ok: false, code: 'upload_failed', message: PROCUREMENT_ERROR_TEXT.upload_failed });
    expect(rpc).toHaveBeenLastCalledWith('purchase_evidence_finish', { p_evidence_id: EVIDENCE, p_ok: false });
    expect(remove).not.toHaveBeenCalled();
  });

  it('finish(true) answering failed (object missing or wrong size) → upload_failed', async () => {
    rpcReplies({
      purchase_evidence_begin: { data: { evidenceId: EVIDENCE, objectPath: PATH } },
      purchase_evidence_finish: { data: { evidenceId: EVIDENCE, status: 'failed' } },
    });
    await expect(actions.uploadPurchaseEvidenceAction(null, form(uploadFields()))).resolves.toEqual({
      ok: false,
      code: 'upload_failed',
      message: PROCUREMENT_ERROR_TEXT.upload_failed,
    });
  });

  it('finish(true) response lost but the row is stored → ok after re-reading the workspace', async () => {
    rpcReplies({
      purchase_evidence_begin: { data: { evidenceId: EVIDENCE, objectPath: PATH } },
      purchase_evidence_finish: { throws: true },
      purchase_workspace: workspaceWith('stored'),
    });
    const result = await actions.uploadPurchaseEvidenceAction(null, form(uploadFields()));
    expect(result).toMatchObject({ ok: true, data: { evidenceId: EVIDENCE } });
    expect(rpc).toHaveBeenCalledWith('purchase_workspace', { p_task_id: TASK });
    expect(remove).not.toHaveBeenCalled();
  });

  it.each([
    ['still pending', workspaceWith('pending_upload')],
    ['row not visible', workspaceWith(null)],
    ['re-read fails', { error: { code: 'XX000', message: 'down' } }],
    ['re-read response lost', { throws: true }],
  ])('finish(true) response lost and %s → unknown outcome; object kept, never finished false', async (_n, wsReply) => {
    rpcReplies({
      purchase_evidence_begin: { data: { evidenceId: EVIDENCE, objectPath: PATH } },
      purchase_evidence_finish: { throws: true },
      purchase_workspace: wsReply,
    });
    const result = await actions.uploadPurchaseEvidenceAction(null, form(uploadFields()));
    expect(result).toEqual({ ok: false, code: 'upload_failed', message: PROCUREMENT_UNKNOWN_OUTCOME_TEXT });
    expect(remove).not.toHaveBeenCalled();
    expect(rpc.mock.calls.filter((c) => c[0] === 'purchase_evidence_finish')).toEqual([
      ['purchase_evidence_finish', { p_evidence_id: EVIDENCE, p_ok: true }],
    ]);
  });
});

describe('confirmSupplierAction (retry after a lost response)', () => {
  it('passes the expected version and trimmed reference under the user session', async () => {
    rpcReplies({ purchase_supplier_confirm: { data: { outcome: 'created', taskId: TASK } } });
    const result = await actions.confirmSupplierAction(null, form(confirmFields('  SYN-CONF-0001  ')));
    expect(result).toEqual({ ok: true, data: { outcome: 'created' }, message: SUPPLIER_CONFIRM_SUCCESS_TEXT });
    expect(rpc).toHaveBeenCalledWith('purchase_supplier_confirm', { p_task_id: TASK, p_expected_version_no: 1, p_reference: 'SYN-CONF-0001' });
    expect(revalidatePath).toHaveBeenCalledWith(`/app/purchase/${TASK}`);
    expect(revalidatePath).toHaveBeenCalledWith('/app/purchase');
  });

  it('a lost response is an unknown outcome (never success, never a database message); the retry answers existing', async () => {
    rpcReplies({
      purchase_supplier_confirm: [{ throws: true }, { data: { outcome: 'existing', taskId: TASK } }],
    });
    await expect(actions.confirmSupplierAction(null, form(confirmFields()))).rejects.toThrow(PROCUREMENT_UNKNOWN_OUTCOME_TEXT);
    const retry = await actions.confirmSupplierAction(null, form(confirmFields()));
    expect(retry).toEqual({ ok: true, data: { outcome: 'existing' }, message: 'The supplier confirmation was already recorded. Nothing changed.' });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
  });

  it('an unparseable reply is an unknown outcome too', async () => {
    rpcReplies({ purchase_supplier_confirm: { data: { outcome: 'booked', taskId: TASK } } });
    await expect(actions.confirmSupplierAction(null, form(confirmFields()))).rejects.toThrow(PROCUREMENT_UNKNOWN_OUTCOME_TEXT);
  });

  it.each([
    ['task_conflict', '40001', false],
    ['version_changed', '40001', true],
    ['not_ready', '55000', true],
    ['over_budget', '55000', false],
    ['procurement_disabled', '55000', false],
  ] as const)('%s maps to its frozen wording', async (code, state, revalidates) => {
    rpcReplies({ purchase_supplier_confirm: { error: { code: state, message: code } } });
    const result = await actions.confirmSupplierAction(null, form(confirmFields()));
    // The typed reference comes back so the dialog can show it again (review fix 2).
    expect(result).toEqual({ ok: false, code, message: PROCUREMENT_ERROR_TEXT[code], values: { reference: 'SYN-CONF-0001' } });
    expect(revalidatePath.mock.calls.length > 0).toBe(revalidates);
  });

  it('returns the typed reference on a permission refusal, never other fields', async () => {
    rpcReplies({ purchase_supplier_confirm: { error: { code: '42501', message: 'not authorized' } } });
    const result = await actions.confirmSupplierAction(null, form({ ...confirmFields('SYN-CONF-0042'), sellingTotalPaise: '999' }));
    expect(result).toEqual({
      ok: false,
      code: 'not_authorized',
      message: PROCUREMENT_ERROR_TEXT.not_authorized,
      values: { reference: 'SYN-CONF-0042' },
    });
  });

  it('returns what was typed on a validation refusal (not the trimmed or parsed value)', async () => {
    const result = await actions.confirmSupplierAction(null, form({ taskId: TASK, expectedVersionNo: '0', reference: ' SYN-7 ' }));
    expect(result).toMatchObject({ ok: false, code: 'invalid_input', values: { reference: ' SYN-7 ' } });
    const tooLong = await actions.confirmSupplierAction(null, form(confirmFields('R'.repeat(500))));
    expect(tooLong).toMatchObject({ ok: false, code: 'invalid_input' });
    expect((tooLong as { values?: { reference: string } }).values?.reference).toHaveLength(120);
  });

  it('a success returns no submitted values (the form clears)', async () => {
    rpcReplies({ purchase_supplier_confirm: { data: { outcome: 'created', taskId: TASK } } });
    const result = await actions.confirmSupplierAction(null, form(confirmFields()));
    expect(result).not.toHaveProperty('values');
  });

  it('refuses a missing reference or version without calling the database', async () => {
    await expect(actions.confirmSupplierAction(null, form(confirmFields('   ')))).resolves.toMatchObject({ ok: false, code: 'invalid_input' });
    await expect(actions.confirmSupplierAction(null, form({ taskId: TASK, expectedVersionNo: '0', reference: 'SYN' }))).resolves.toMatchObject({
      ok: false,
      code: 'invalid_input',
    });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('amendment A1 actions (manager decisions, release, reassignment)', () => {
  const SUPPLIER = '55555555-5555-4555-8555-555555555555';
  const TO = '66666666-6666-4666-8666-666666666666';

  it.each([
    ['verify', () => actions.verifySupplierAction(null, form({ supplierId: SUPPLIER, rowVersion: '2' }))],
    ['approve bank', () => actions.approveBeneficiaryAction(null, form({ supplierId: SUPPLIER, revisionNo: '1' }))],
    ['approve cost', () => actions.approveOverBudgetAction(null, form({ taskId: TASK, versionNo: '3' }))],
    ['release', () => actions.releaseTaskAction(null, form({ taskId: TASK }))],
    ['reassign', () => actions.reassignTaskAction(null, form({ taskId: TASK, expectedAssigneeId: USER, toUserId: TO }))],
  ])('%s stops at the session gate before any database call', async (_n, run) => {
    requireStaff.mockRejectedValue(new Error('NEXT_REDIRECT /mfa/challenge'));
    await expect(run()).rejects.toThrow('NEXT_REDIRECT');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('send only ids and versions from the form, under the user session, and word created vs existing', async () => {
    rpcReplies({
      supplier_verify: [
        { data: { supplierId: SUPPLIER, rowVersion: 3, outcome: 'created' } },
        { data: { supplierId: SUPPLIER, rowVersion: 3, outcome: 'existing' } },
      ],
      supplier_approve_beneficiary: { data: { revisionNo: 1, status: 'approved', outcome: 'created' } },
      purchase_cost_approve_over_budget: { data: { taskId: TASK, versionNo: 3, outcome: 'existing' } },
      purchase_task_release: { data: { taskId: TASK, status: 'not_started', outcome: 'created' } },
      purchase_task_reassign: { data: { taskId: TASK, outcome: 'created' } },
    });
    expect(await actions.verifySupplierAction(null, form({ supplierId: SUPPLIER, rowVersion: '2', verifiedBy: USER }))).toEqual({
      ok: true,
      data: { outcome: 'created' },
      message: A1_TEXT.verifyDone,
    });
    expect(await actions.verifySupplierAction(null, form({ supplierId: SUPPLIER, rowVersion: '2' }))).toMatchObject({ message: A1_TEXT.verifyExisting });
    expect(rpc).toHaveBeenCalledWith('supplier_verify', { p_supplier_id: SUPPLIER, p_expected_row_version: 2 });
    expect(await actions.approveBeneficiaryAction(null, form({ supplierId: SUPPLIER, revisionNo: '1' }))).toMatchObject({ message: A1_TEXT.approveBankDone });
    expect(rpc).toHaveBeenCalledWith('supplier_approve_beneficiary', { p_supplier_id: SUPPLIER, p_revision_no: 1 });
    expect(await actions.approveOverBudgetAction(null, form({ taskId: TASK, versionNo: '3' }))).toMatchObject({ message: A1_TEXT.approveCostExisting });
    expect(rpc).toHaveBeenCalledWith('purchase_cost_approve_over_budget', { p_task_id: TASK, p_version_no: 3 });
    expect(await actions.releaseTaskAction(null, form({ taskId: TASK }))).toMatchObject({ message: A1_TEXT.releaseDone });
    expect(rpc).toHaveBeenCalledWith('purchase_task_release', { p_task_id: TASK });
    expect(await actions.reassignTaskAction(null, form({ taskId: TASK, expectedAssigneeId: USER, toUserId: TO }))).toMatchObject({
      message: A1_TEXT.reassignDone,
    });
    expect(rpc).toHaveBeenCalledWith('purchase_task_reassign', { p_task_id: TASK, p_expected_assignee: USER, p_to_user_id: TO });
    expect(revalidatePath).toHaveBeenCalledWith('/app/purchase');
  });

  it('refuses malformed ids and versions without calling the database', async () => {
    for (const run of [
      () => actions.verifySupplierAction(null, form({ supplierId: 'x', rowVersion: '2' })),
      () => actions.approveBeneficiaryAction(null, form({ supplierId: SUPPLIER, revisionNo: '0' })),
      () => actions.approveOverBudgetAction(null, form({ taskId: TASK, versionNo: '-1' })),
      () => actions.releaseTaskAction(null, form({})),
      () => actions.reassignTaskAction(null, form({ taskId: TASK, expectedAssigneeId: USER })),
    ]) {
      await expect(run()).resolves.toMatchObject({ ok: false, code: 'invalid_input' });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it('maps refusals to frozen wording and a lost response to the unknown outcome', async () => {
    rpcReplies({
      supplier_approve_beneficiary: { error: { code: '42501', message: 'not_authorized' } },
      purchase_task_reassign: { error: { code: '40001', message: 'task_conflict' } },
      purchase_task_release: { throws: true },
    });
    expect(await actions.approveBeneficiaryAction(null, form({ supplierId: SUPPLIER, revisionNo: '1' }))).toEqual({
      ok: false,
      code: 'not_authorized',
      message: PROCUREMENT_ERROR_TEXT.not_authorized,
    });
    expect(await actions.reassignTaskAction(null, form({ taskId: TASK, expectedAssigneeId: USER, toUserId: TO }))).toMatchObject({
      code: 'task_conflict',
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/app/purchase/${TASK}`);
    await expect(actions.releaseTaskAction(null, form({ taskId: TASK }))).rejects.toThrow(PROCUREMENT_UNKNOWN_OUTCOME_TEXT);
  });
});
