import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Visa build, track B: server actions and loaders with a fake RPC client.
 * Session gate first; commands under the staff member's own session with the
 * screen's request id; refusals mapped to frozen wording with screen fields;
 * an unexplained failure is never reported as "nothing changed"; Storage only
 * after the database began the upload. Synthetic ids only.
 */

const requireStaff = vi.fn();
const rpc = vi.fn();
const revalidatePath = vi.fn();
const upload = vi.fn();

vi.mock('@/modules/identity/server/session', () => ({ requireStaff: () => requireStaff() }));
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
vi.mock('@/lib/supabase/admin', () => ({
  createSupabaseAdminClient: () => ({ storage: { from: () => ({ upload: (...a: unknown[]) => upload(...a) }) } }),
}));

const actions = await import('@/modules/visa/server/actions');
const uploads = await import('@/modules/visa/server/evidence');
const queries = await import('@/modules/visa/server/queries');
const { VISA_UNKNOWN_OUTCOME_TEXT } = await import('@/modules/visa/contracts');

const TASK = '22222222-2222-4222-8222-222222222222';
const DEAL = 'd0000000-0000-4000-8000-000000000001';
const APP = '55555555-5555-4555-8555-555555555555';
const DOC = '33333333-3333-4333-8333-333333333331';
const ENTRY = '66666666-6666-4666-8666-666666666666';
const EV = '44444444-4444-4444-8444-444444444444';
const REQ = '77777777-7777-4777-8777-777777777777';
const PATH = `${DEAL}/${TASK}/${EV}`;

function form(fields: Record<string, string | string[] | Blob>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) v.forEach((x) => fd.append(k, x));
    else fd.set(k, v);
  }
  return fd;
}
type Reply = { data?: unknown; error?: { code: string; message: string; hint?: string } | null; throws?: boolean };
function replies(map: Record<string, Reply | Reply[]>) {
  const queues = Object.fromEntries(Object.entries(map).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  rpc.mockImplementation(async (fn: string) => {
    const q = queues[fn];
    if (!q || q.length === 0) throw new Error(`unexpected rpc ${fn}`);
    const r = q.length > 1 ? q.shift()! : q[0]!;
    if (r.throws) throw new TypeError('fetch failed');
    return { data: r.data ?? null, error: r.error ?? null };
  });
}
const target = { taskId: TASK, dealId: DEAL, applicationId: APP, expectedRowVersion: '3', requestId: REQ };
const appResult = { outcome: 'updated', applicationId: APP, rowVersion: 4, state: 'issued', closed: true, taskCompleted: false };

beforeEach(() => {
  vi.clearAllMocks();
  requireStaff.mockResolvedValue({ userId: 'u', supabase: { rpc } });
  upload.mockResolvedValue({ data: { path: PATH }, error: null });
});

describe('session gate and own session', () => {
  it('requireStaff runs before any database call', async () => {
    requireStaff.mockRejectedValue(new Error('NEXT_REDIRECT'));
    await expect(actions.claimVisaTaskAction(null, form({ taskId: TASK }))).rejects.toThrow('NEXT_REDIRECT');
    await expect(actions.applyVisaApplicationsAction(null, form({ taskId: TASK }))).rejects.toThrow('NEXT_REDIRECT');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('passes the request id and only the listed keys; revalidates the task, Deal and Home', async () => {
    replies({ visa_application_set_row: { data: { outcome: 'updated', applicationId: APP, rowVersion: 4, ready: true, notReady: [], taskCompleted: false } } });
    const r = await actions.saveVisaRowAction(null, form({ ...target, remark: 'Synthetic', sellingPricePaise: '1', actorId: 'x' }));
    expect(r).toMatchObject({ ok: true, message: 'Passenger saved. Ready for Appointment.' });
    expect(rpc).toHaveBeenCalledWith('visa_application_set_row', {
      p_application_id: APP, p_expected_row_version: 3, p_fields: { remark: 'Synthetic' }, p_request_id: REQ,
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/app/visa/${TASK}`);
    expect(revalidatePath).toHaveBeenCalledWith(`/app/deals/${DEAL}`);
    expect(revalidatePath).toHaveBeenCalledWith('/app');
  });
});

describe('refusals', () => {
  it('invalid input never reaches the database', async () => {
    const r = await actions.saveVisaRowAction(null, form({ ...target, requestId: 'nope', remark: 'x' }));
    expect(r).toEqual({ ok: false, code: 'invalid_input', message: 'Check the highlighted field.', fields: ['requestId'] });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('maps hints to screen fields and not_ready to its reason', async () => {
    replies({ visa_applications_apply: [
      { error: { code: '22023', message: 'invalid_input', hint: 'applicants[0].governmentFeePaise,visaKind' } },
      { error: { code: '55000', message: 'not_ready', hint: 'applicants[1]:appointment_missing' } },
    ] });
    const f = {
      taskId: TASK, requestId: REQ, applicantCount: '1', paidBy: 'customer_direct',
      'applicants[0].applicationId': APP, 'applicants[0].expectedRowVersion': '2', 'applicants[0].reference': 'SYN-1',
      'applicants[0].appliedOn': '2026-11-07', 'applicants[0].governmentFee': '100',
    };
    expect(await actions.applyVisaApplicationsAction(null, form(f))).toEqual({
      ok: false, code: 'invalid_input', message: 'Check the highlighted field.', fields: ['applicants[0].governmentFee', 'visaKind'],
    });
    expect(await actions.applyVisaApplicationsAction(null, form(f))).toEqual({
      ok: false, code: 'not_ready', message: 'Not ready to apply yet: no appointment date.', fields: ['applicants[1]'],
    });
  });

  it('a token with the wrong SQLSTATE is never guessed; an unexplained failure is unknown outcome', async () => {
    replies({ visa_application_withdraw: [{ error: { code: 'XX000', message: 'boom' } }, { throws: true }] });
    const f = form({ ...target, reason: 'Synthetic cancel', customerInformed: 'on' });
    await expect(actions.withdrawVisaApplicationAction(null, f)).rejects.toThrow(VISA_UNKNOWN_OUTCOME_TEXT);
    await expect(actions.withdrawVisaApplicationAction(null, f)).rejects.toThrow(VISA_UNKNOWN_OUTCOME_TEXT);
  });

  it('decision without proof says upload the document first', async () => {
    const r = await actions.decideVisaApplicationAction(null, form({ ...target, decision: 'approved' }));
    expect(r).toMatchObject({ ok: false, code: 'outcome_document_required', message: 'Upload the visa or refusal document first.' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('closure and completion are said in the message', async () => {
    replies({ visa_application_set_handover: [{ data: appResult }, { data: { ...appResult, taskCompleted: true } }] });
    const f = form({ ...target, handoverMethod: 'not_with_us' });
    expect((await actions.setVisaHandoverAction(null, f)).message).toBe('Handover saved. This passenger is closed.');
    expect((await actions.setVisaHandoverAction(null, f)).message).toBe('Handover saved. Every passenger is closed, so the task is completed.');
  });

  it('fee send revalidates Accounts; cost_locked keeps its wording', async () => {
    replies({ visa_fee_send: { error: { code: '55000', message: 'cost_locked' } } });
    const r = await actions.sendVisaFeeAction(null, form({ taskId: TASK, entryId: ENTRY, expectedRowVersion: '2', requestId: REQ, amount: '6500' }));
    expect(r).toEqual({ ok: false, code: 'cost_locked', message: 'This fee is with Accounts and cannot be changed now.' });
    expect(revalidatePath).toHaveBeenCalledWith('/app/accounts/expenses');
  });
});

describe('uploads', () => {
  const pdf = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a])], 'synthetic.pdf', { type: 'application/pdf' });
  const docForm = (status = 'not_received') => form({ taskId: TASK, applicationId: APP, documentId: DOC, expectedRowVersion: '3', documentStatus: status, file: pdf() });

  it('refused begin: Storage is never touched', async () => {
    replies({ visa_document_file_begin: { error: { code: '42501', message: 'not_authorized' } } });
    expect(await uploads.uploadVisaDocumentFileAction(null, docForm())).toMatchObject({ ok: false, code: 'not_authorized' });
    expect(upload).not.toHaveBeenCalled();
  });

  it('stored file marks the document received with the file id as request id', async () => {
    replies({
      visa_document_file_begin: { data: { evidenceId: EV, objectPath: PATH } },
      department_evidence_finish: { data: { evidenceId: EV, status: 'stored' } },
      visa_application_set_row: { data: { outcome: 'updated', applicationId: APP, rowVersion: 4, ready: false, notReady: ['appointment_missing'] } },
    });
    const r = await uploads.uploadVisaDocumentFileAction(null, docForm());
    expect(r).toEqual({ ok: true, data: { evidenceId: EV, markedReceived: true }, message: 'File uploaded and the document marked received.' });
    expect(rpc).toHaveBeenCalledWith('visa_application_set_row', {
      p_application_id: APP, p_expected_row_version: 3, p_fields: { documents: [{ documentId: DOC, received: true }] }, p_request_id: EV,
    });
  });

  it('a refused tick keeps the stored file and says so', async () => {
    replies({
      visa_document_file_begin: { data: { evidenceId: EV, objectPath: PATH } },
      department_evidence_finish: { data: { evidenceId: EV, status: 'stored' } },
      visa_application_set_row: { error: { code: '40001', message: 'version_changed' } },
    });
    const r = await uploads.uploadVisaDocumentFileAction(null, docForm());
    expect(r).toMatchObject({ ok: true, data: { markedReceived: false } });
    expect(r.message).toMatch(/^File uploaded\. The document is not marked received yet: Someone changed this passenger meanwhile/);
  });

  it('a failed Storage write finishes as failed', async () => {
    upload.mockResolvedValue({ data: null, error: { message: 'x' } });
    replies({
      department_evidence_begin: { data: { evidenceId: EV, objectPath: PATH } },
      department_evidence_finish: { data: { evidenceId: EV, status: 'failed' } },
    });
    const r = await uploads.uploadVisaEvidenceAction(null, form({ taskId: TASK, kind: 'fee_receipt', file: pdf() }));
    expect(r).toMatchObject({ ok: false, code: 'upload_failed' });
    expect(rpc).toHaveBeenCalledWith('department_evidence_finish', { p_evidence_id: EV, p_ok: false });
  });

  it('refuses a kind outside the visa list and a non-file', async () => {
    expect(await uploads.uploadVisaEvidenceAction(null, form({ taskId: TASK, kind: 'e_ticket', file: pdf() }))).toMatchObject({ ok: false, code: 'invalid_input', fields: ['kind'] });
    expect(await uploads.uploadVisaEvidenceAction(null, form({ taskId: TASK, kind: 'fee_receipt' }))).toMatchObject({ ok: false, code: 'evidence_rejected' });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('loaders', () => {
  const staff = { supabase: { rpc } } as never;
  it('refusal and missing function read as null; a broken read throws a retry message', async () => {
    replies({ visa_workspace: [{ error: { code: '42501', message: 'not_authorized' } }, { error: { code: 'PGRST202', message: 'x' } }, { throws: true }] });
    await expect(queries.loadVisaWorkspace(staff, TASK)).resolves.toBeNull();
    await expect(queries.loadVisaWorkspace(staff, TASK)).resolves.toBeNull();
    await expect(queries.loadVisaWorkspace(staff, TASK)).rejects.toThrow('Could not load this visa task. Please retry.');
    await expect(queries.loadVisaWorkspace(staff, 'nope')).resolves.toBeNull();
  });

  it('queue carries the launch state (Addendum 1): a failed switch read is unknown, never off', async () => {
    const queue = { data: { isManagerView: false, canTake: true, tasks: [] } };
    const settings = (visa: boolean | undefined) => ({ data: { intakePromptEnabled: true, serviceItemsEnabled: true, visaPassportTasksEnabled: visa, updatedAt: null } });
    replies({ visa_queue: queue, workflow_settings_get: [settings(true), settings(false), settings(undefined), { error: { code: '42501', message: 'not_authorized' } }, { throws: true }] });
    for (const launch of ['on', 'off', 'unknown', 'unknown', 'unknown']) {
      await expect(queries.loadVisaQueue(staff)).resolves.toEqual({ isManagerView: false, canTake: true, tasks: [], launch, waitingCount: null });
    }
  });

  it('queue: not a reader is null even when the switch reads; a broken queue read throws', async () => {
    replies({ visa_queue: [{ data: null }, { throws: true }], workflow_settings_get: { data: { intakePromptEnabled: true, serviceItemsEnabled: true, visaPassportTasksEnabled: true } } });
    await expect(queries.loadVisaQueue(staff)).resolves.toBeNull();
    await expect(queries.loadVisaQueue(staff)).rejects.toThrow('Could not load the Visa and passport tasks. Please retry.');
  });

  it('deal reads answer error (not empty) on failure', async () => {
    replies({ deal_visa_history: { throws: true }, deal_visa_summary: { data: null } });
    await expect(queries.loadDealVisaHistory(staff, DEAL)).resolves.toBe('error');
    await expect(queries.loadDealVisaSummary(staff, DEAL)).resolves.toBeNull();
  });
});
