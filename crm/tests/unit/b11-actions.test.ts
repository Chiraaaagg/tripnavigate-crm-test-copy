import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOKING_ERROR_STATES, mapBookingError } from '@/modules/fulfilment/commands';
import { ERROR_TEXT, INTAKE_CONFIRM_NO_TASK_TEXT, UNKNOWN_OUTCOME_TEXT } from '@/modules/fulfilment/contracts';
import { FINANCE_ERROR_STATES, FINANCE_ERROR_TEXT } from '@/modules/finance/contracts';
import { mapFinanceError } from '@/modules/finance/commands';

/**
 * B1.1 server actions and loaders with a fake RPC client: session gate first,
 * every command under the staff member's own session, refusal tokens mapped
 * by SQLSTATE + exact token to frozen wording, database hints mapped to form
 * fields (never database text), conflicts carry who/when, unknown outcomes
 * never reported as "nothing changed", and "function missing" read as "not
 * installed". Synthetic ids only.
 */

const requireStaff = vi.fn();
const rpc = vi.fn();
const revalidatePath = vi.fn();

vi.mock('@/modules/identity/server/session', () => ({ requireStaff: () => requireStaff() }));
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: () => ({}) }));

const book = await import('@/modules/fulfilment/server/book-now-actions');
const intake = await import('@/modules/fulfilment/server/intake-actions');
const bookLoader = await import('@/modules/fulfilment/server/book-now');
const visaActions = await import('@/modules/fulfilment/server/visa-actions');
const visaLoaders = await import('@/modules/fulfilment/server/visa');
const dept = await import('@/modules/fulfilment/server/department-actions');
const deptLoader = await import('@/modules/fulfilment/server/department');
const claimActions = await import('@/modules/finance/server/claim-actions');
const expenseActions = await import('@/modules/finance/server/expense-actions');
const financeQueries = await import('@/modules/finance/server/queries');

const USER = 'a0000000-0000-4000-8000-000000000001';
const DEAL = 'd0000000-0000-4000-8000-000000000001';
const VERSION = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const APP = '55555555-5555-4555-8555-555555555555';
const ENTRY = '66666666-6666-4666-8666-666666666666';
const CLAIM = '88888888-8888-4888-8888-888888888888';
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

type RpcReply = { data?: unknown; error?: { code: string; message: string; hint?: string; details?: string } | null; throws?: boolean };
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

const dealRow = vi.fn();
const from = vi.fn((table: string) => {
  if (table === 'deals') return { select: () => ({ eq: () => ({ maybeSingle: () => dealRow() }) }) };
  return { select: () => ({ eq: () => ({ is: () => ({ data: [], error: null }) }) }) };
});
const access = { userId: USER, memberships: [], rolePermissions: [], grants: [] };
const staff = { access, supabase: { rpc, from } } as never;

beforeEach(() => {
  vi.clearAllMocks();
  requireStaff.mockResolvedValue({ userId: USER, supabase: { rpc, from }, access });
  dealRow.mockReturnValue({
    data: { id: DEAL, legal_entity_id: USER, branch_id: USER, owner_user_id: USER, reference: 'SYN-JOD-012', title: 'Synthetic trip', source_system: null, source_stage_id: null },
    error: null,
  });
});

const draft = { dealId: DEAL, versionId: VERSION, rowVersion: '5' };
const customer = { ...draft, requestId: REQUEST, contactName: 'Synthetic Customer', mobile: '9876543210', bookingFor: 'individual', contactConfirmed: 'on' };

const formReply = {
  data: {
    dealId: DEAL,
    canEdit: true,
    canConfirm: true,
    serviceItemsEnabled: true,
    visaPassportTasksEnabled: false,
    dealNotActive: false,
    version: { versionId: VERSION, versionNo: 1, status: 'draft', serviceType: 'package', rowVersion: 6, contentHash: HASH, updatedAt: '2026-10-11T08:31:00Z', updatedByName: 'Rahul (synthetic)', confirmedAt: null },
    trip: { destination: null, scope: null, start: null, end: null },
    contacts: null,
    billing: { status: 'none', prefillSource: null, rowVersion: 0 },
    travellers: [],
    items: [],
    evidence: [],
  },
};
const panelReply = {
  data: { dealId: DEAL, canEdit: true, canConfirm: true, gate: { realBookingEnabled: false, environment: 'test' }, version: null, readiness: null, evidence: [], evidenceVisible: true, task: null },
};

describe('refusal token maps', () => {
  it('every new booking token maps only with its SQLSTATE', () => {
    for (const [token, state] of Object.entries(BOOKING_ERROR_STATES)) {
      expect(mapBookingError({ code: state, message: token })).toBe(token);
    }
    expect(mapBookingError({ code: '22023', message: 'billing_verified' })).toBe('invalid_input');
    expect(mapBookingError({ code: '40001', message: 'cost_locked' })).toBeNull();
    expect(BOOKING_ERROR_STATES.direct_payment_over_limit).toBe('22023');
    expect(BOOKING_ERROR_STATES.classification_not_allowed).toBe('22023');
  });

  it('new finance tokens map only with their SQLSTATE; claims tokens have wording', () => {
    for (const [token, state] of Object.entries(FINANCE_ERROR_STATES)) {
      expect(mapFinanceError({ code: state, message: token })).toBe(token);
    }
    expect(mapFinanceError({ code: '55000', message: 'duplicate_claim' })).toBeNull();
    expect(FINANCE_ERROR_TEXT.claim_over_total).toMatch(/selling total/);
  });
});

describe('session gate', () => {
  it.each([
    ['start', () => book.startBookNowAction(null, form({ dealId: DEAL }))],
    ['customer', () => book.saveBookCustomerAction(null, form(customer))],
    ['trip', () => book.saveBookTripAction(null, form(draft))],
    ['price', () => book.saveBookPriceAction(null, form({ ...draft, sellingTotalRupees: '1000' }))],
    ['submit', () => book.submitBookingAction(null, form({ dealId: DEAL, versionId: VERSION, contentHash: HASH }))],
    ['visa claim', () => visaActions.claimVisaTaskAction(null, form({ taskId: TASK }))],
    ['cost', () => dept.saveDepartmentCostAction(null, form({ taskId: TASK }))],
    ['claim report', () => claimActions.reportPaymentClaimAction(null, form({ dealId: DEAL }))],
    ['expense accept', () => expenseActions.acceptExpenseRecordAction(null, form({ entryId: ENTRY }))],
  ])('%s stops before any database call', async (_n, run) => {
    requireStaff.mockRejectedValue(new Error('NEXT_REDIRECT /mfa/challenge'));
    await expect(run()).rejects.toThrow('NEXT_REDIRECT');
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('saveBookCustomerAction', () => {
  it('one command under the user session; no billing proposed when billing fields are empty', async () => {
    rpcReplies({ booking_customer_save: { data: { rowVersion: 6, contentHash: HASH, billing: null } } });
    const result = await book.saveBookCustomerAction(null, form({ ...customer, userId: 'spoof', legalEntityId: 'spoof' }));
    expect(result).toEqual({ ok: true, data: { rowVersion: 6, contentHash: HASH, billing: null }, message: 'Saved.' });
    expect(rpc).toHaveBeenCalledWith('booking_customer_save', {
      p_version_id: VERSION,
      p_expected_row_version: 5,
      p_contact: { contactName: 'Synthetic Customer', mobile: '9876543210', email: null, contactConfirmed: true, bookingFor: 'individual', payerDifferent: false, payerName: null },
      p_billing: null,
      p_billing_expected_row_version: 0,
      p_request_id: REQUEST,
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/app/deals/${DEAL}/book`);
  });

  it('an exact retry answered with the stored result says nothing changed', async () => {
    rpcReplies({ booking_customer_save: { data: { rowVersion: 6, contentHash: HASH, billing: null, outcome: 'existing' } } });
    await expect(book.saveBookCustomerAction(null, form(customer))).resolves.toEqual({
      ok: true,
      data: { rowVersion: 6, contentHash: HASH, billing: null, replayed: true },
      message: 'Saved. (already saved; nothing changed)',
    });
  });

  it('version_changed carries who saved and when (re-read of the form)', async () => {
    rpcReplies({ booking_customer_save: { error: { code: '40001', message: 'version_changed' } }, booking_form_get: formReply });
    await expect(book.saveBookCustomerAction(null, form(customer))).resolves.toEqual({
      ok: false,
      code: 'version_changed',
      message: ERROR_TEXT.version_changed,
      conflict: { savedByName: 'Rahul (synthetic)', savedAt: '2026-10-11T08:31:00Z' },
    });
  });

  it('billing_verified is reported in words; invalid_input hints become form fields, never database text', async () => {
    rpcReplies({ booking_customer_save: { error: { code: '55000', message: 'billing_verified' } } });
    await expect(book.saveBookCustomerAction(null, form(customer))).resolves.toMatchObject({ ok: false, code: 'billing_verified', message: ERROR_TEXT.billing_verified });
    rpcReplies({ booking_customer_save: { error: { code: '22023', message: 'invalid_input', hint: 'mobile,city' } } });
    await expect(book.saveBookCustomerAction(null, form(customer))).resolves.toEqual({
      ok: false,
      code: 'invalid_input',
      message: ERROR_TEXT.invalid_input,
      fields: ['mobile', 'billingCity'],
    });
    rpcReplies({ booking_customer_save: { error: { code: '22023', message: 'invalid_input', hint: 'DROP TABLE x; --' } } });
    const free = await book.saveBookCustomerAction(null, form(customer));
    expect(free).toEqual({ ok: false, code: 'invalid_input', message: ERROR_TEXT.invalid_input });
  });

  it('an unexplained failure is never reported as "nothing changed"', async () => {
    rpcReplies({ booking_customer_save: { error: { code: 'XX000', message: 'boom SECRET' } } });
    await expect(book.saveBookCustomerAction(null, form(customer))).rejects.toThrow(UNKNOWN_OUTCOME_TEXT);
    rpcReplies({ booking_customer_save: { throws: true } });
    await expect(book.saveBookCustomerAction(null, form(customer))).rejects.toThrow(UNKNOWN_OUTCOME_TEXT);
  });
});

describe('saveBookTripAction', () => {
  const trip = { ...draft, destination: 'Bangkok', tripScope: 'international', tripStart: '2026-12-10', tripEnd: '2026-12-15', travellerName: ['Asha'], travellerType: ['adult'] };
  it('trip then travellers with the new row version', async () => {
    rpcReplies({ booking_trip_save: { data: { rowVersion: 6, contentHash: HASH } }, deal_travellers_save: { data: { rowVersion: 7, contentHash: HASH } } });
    await expect(book.saveBookTripAction(null, form(trip))).resolves.toMatchObject({ ok: true, data: { rowVersion: 7 } });
    expect(rpc).toHaveBeenNthCalledWith(1, 'booking_trip_save', {
      p_version_id: VERSION,
      p_expected_row_version: 5,
      p_fields: { destination: 'Bangkok', scope: 'international', start: '2026-12-10', end: '2026-12-15' },
    });
    expect(rpc).toHaveBeenNthCalledWith(2, 'deal_travellers_save', {
      p_deal_id: DEAL,
      p_expected_row_version: 6,
      p_travellers: [{ fullName: 'Asha', type: 'adult', seq: 1, ageYears: null, specialNeeds: null }],
    });
  });

  it('says exactly what was saved when the travellers are refused; maps trip hints', async () => {
    rpcReplies({ booking_trip_save: { data: { rowVersion: 6, contentHash: HASH } }, deal_travellers_save: { error: { code: '55000', message: 'traveller_identity_locked' } } });
    await expect(book.saveBookTripAction(null, form(trip))).resolves.toEqual({
      ok: false,
      code: 'traveller_identity_locked',
      message: `Trip details saved. The travellers were not saved: ${ERROR_TEXT.traveller_identity_locked}`,
    });
    rpcReplies({ booking_trip_save: { error: { code: '22023', message: 'invalid_input', hint: 'start,end' } } });
    await expect(book.saveBookTripAction(null, form(trip))).resolves.toMatchObject({ fields: ['tripStart', 'tripEnd'] });
  });
});

describe('price, plan and submit', () => {
  it('price paise strings; hints map to rupee inputs', async () => {
    rpcReplies({ booking_commercials_save: { data: { rowVersion: 6, contentHash: HASH } } });
    await book.saveBookPriceAction(null, form({ ...draft, listRupees: '1,000', discountRupees: '100', sellingTotalRupees: '900' }));
    expect(rpc).toHaveBeenCalledWith('booking_commercials_save', { p_version_id: VERSION, p_expected_row_version: 5, p_list_paise: '100000', p_discount_paise: '10000', p_total_paise: '90000' });
    rpcReplies({ booking_commercials_save: { error: { code: '22023', message: 'invalid_input', hint: 'totalPaise' } } });
    await expect(book.saveBookPriceAction(null, form({ ...draft, sellingTotalRupees: '900' }))).resolves.toMatchObject({ fields: ['sellingTotalRupees'] });
    rpcReplies({ booking_commercials_save: { error: { code: '42501', message: 'not_authorized' } } });
    await expect(book.saveBookPriceAction(null, form({ ...draft, sellingTotalRupees: '900' }))).resolves.toMatchObject({ code: 'not_authorized' });
  });

  it('plan rows are sent with seq, label, paise and date', async () => {
    rpcReplies({ booking_instalments_save: { data: { rowVersion: 6, contentHash: HASH } } });
    await book.saveBookPaymentAction(null, form({ ...draft, instalmentLabel: ['Advance'], instalmentAmountRupees: ['900'], instalmentDueDate: ['2026-10-20'] }));
    expect(rpc).toHaveBeenCalledWith('booking_instalments_save', {
      p_version_id: VERSION,
      p_expected_row_version: 5,
      p_instalments: [{ seq: 1, label: 'Advance', amountPaise: '90000', dueDate: '2026-10-20' }],
    });
  });

  it('submit: zero tasks (desk not launched) is honest; not_ready brings the repair list; revised says no new task', async () => {
    rpcReplies({ booking_confirm: { data: { outcome: 'created', taskId: null, versionId: VERSION, taskIds: [] } } });
    const zero = await book.submitBookingAction(null, form({ dealId: DEAL, versionId: VERSION, contentHash: HASH }));
    expect(zero).toMatchObject({ ok: true, data: { taskId: null, taskIds: [] } });
    expect(zero.message).toMatch(/No task was created yet/);
    rpcReplies({ booking_confirm: { error: { code: '55000', message: 'not_ready' } }, booking_readiness: { data: { ready: false, issues: ['plan_total_mismatch'], contentHash: HASH } } });
    await expect(book.submitBookingAction(null, form({ dealId: DEAL, versionId: VERSION, contentHash: HASH }))).resolves.toEqual({
      ok: false,
      code: 'not_ready',
      message: ERROR_TEXT.not_ready,
      issues: ['plan_total_mismatch'],
    });
    rpcReplies({ booking_confirm: { data: { outcome: 'revised', taskId: TASK, versionId: VERSION, taskIds: [TASK], supersededVersionId: APP } } });
    const revised = await book.submitBookingAction(null, form({ dealId: DEAL, versionId: VERSION, contentHash: HASH }));
    expect(revised).toMatchObject({ ok: true, data: { outcome: 'revised', supersededVersionId: APP } });
    expect(revised.message).toMatch(/No new task was created/);
  });

  it('the B1 intake confirm tolerates no task (visa only, desk off) and says so', async () => {
    rpcReplies({ booking_confirm: { data: { outcome: 'created', taskId: null, versionId: VERSION, taskIds: [] } } });
    const result = await intake.confirmIntakeAction(null, form({ dealId: DEAL, versionId: VERSION, contentHash: HASH }));
    expect(result).toEqual({
      ok: true,
      data: { outcome: 'created', taskId: null, versionId: VERSION, taskIds: [] },
      message: INTAKE_CONFIRM_NO_TASK_TEXT,
    });
    rpcReplies({ booking_confirm: { data: { outcome: 'existing', taskId: null, versionId: VERSION, taskIds: [] } } });
    await expect(intake.confirmIntakeAction(null, form({ dealId: DEAL, versionId: VERSION, contentHash: HASH }))).resolves.toMatchObject({
      ok: true,
      data: { taskId: null },
    });
  });

  it('revision tokens arrive in plain words', async () => {
    rpcReplies({ booking_open_revision: { error: { code: '55000', message: 'already_committed' } } });
    await expect(book.openRevisionAction(null, form({ dealId: DEAL, baseVersionId: VERSION }))).resolves.toMatchObject({ code: 'already_committed', message: ERROR_TEXT.already_committed });
    rpcReplies({ booking_classify_revision: { error: { code: '22023', message: 'classification_not_allowed' } } });
    await expect(book.classifyRevisionAction(null, form({ ...draft, changeClass: 'format_only' }))).resolves.toMatchObject({ code: 'classification_not_allowed' });
  });
});

describe('loadBookNow', () => {
  it('function missing → not installed (PGRST202 and 42883); null when the database hides the form', async () => {
    rpcReplies({ booking_form_get: { error: { code: 'PGRST202', message: 'Could not find the function' } } });
    await expect(bookLoader.loadBookNow(staff, DEAL)).resolves.toBe('not_installed');
    rpcReplies({ booking_form_get: { error: { code: '42883', message: 'function does not exist' } } });
    await expect(bookLoader.loadBookNow(staff, DEAL)).resolves.toBe('not_installed');
    rpcReplies({ booking_form_get: { data: null } });
    await expect(bookLoader.loadBookNow(staff, DEAL)).resolves.toBeNull();
    await expect(bookLoader.loadBookNow(staff, 'not-a-uuid')).resolves.toBeNull();
  });

  it('builds the view when claims and history are not installed yet', async () => {
    rpcReplies({
      booking_form_get: formReply,
      booking_panel: panelReply,
      intake_checklist: { data: { items: [{ code: 'contact_missing', blocking: true, owner: 'sales' }], canConfirm: false } },
      deal_payment_claims: { error: { code: 'PGRST202', message: 'missing' } },
      booking_version_history: { error: { code: 'PGRST202', message: 'missing' } },
      bitrix_id_proof_copy_status: { error: { code: 'PGRST202', message: 'missing' } },
    });
    const view = await bookLoader.loadBookNow(staff, DEAL);
    expect(view).not.toBe('not_installed');
    expect(view).toMatchObject({ dealId: DEAL, dealReference: 'SYN-JOD-012', checklist: [{ code: 'contact_missing', step: 'travellers', section: 'customer' }] });
    expect(view).not.toHaveProperty('claims');
    expect(view).not.toHaveProperty('history');
  });

  it('an unexplained failure throws a retry message, never database text', async () => {
    rpcReplies({ booking_form_get: { error: { code: 'XX000', message: 'boom SECRET' } } });
    await expect(bookLoader.loadBookNow(staff, DEAL)).rejects.toThrow('Could not load the booking form. Please retry.');
  });
});

describe('Visa & Passport desk', () => {
  const detail = {
    taskId: TASK,
    dealReference: 'SYN-JOD-012',
    serviceType: 'visa',
    facts: { country: 'Thailand', purpose: 'Tourism', travelDate: '2026-12-10', feePaidBy: 'customer' },
    status: 'in_progress',
    assigneeName: null,
    assignedToYou: true,
    branchName: 'Jodhpur',
    createdAt: '2026-10-11T09:00:00Z',
    versionNo: 1,
    confirmedAt: '2026-10-11T08:00:00Z',
    canClaim: false,
    applicants: [{ applicationId: APP, seq: 1, fullName: 'Asha', type: 'adult', state: 'docs_pending', documents: { photo: 'received', passport_copy: 'missing' }, rowVersion: 2 }],
  };

  it('a document row update keeps the other stored documents', async () => {
    rpcReplies({ visa_task_get: { data: detail }, visa_application_update: { data: { applicationId: APP, rowVersion: 3, state: 'docs_pending' } } });
    await expect(
      visaActions.setApplicantDocumentAction(null, form({ taskId: TASK, applicationId: APP, rowVersion: '2', documentCode: 'passport_copy', documentStatus: 'checked' })),
    ).resolves.toMatchObject({ ok: true, data: { rowVersion: 3, taskCompleted: false } });
    expect(rpc).toHaveBeenCalledWith('visa_application_update', {
      p_application_id: APP,
      p_expected_row_version: 2,
      p_fields: { documents: { photo: 'received', passport_copy: 'checked' } },
    });
  });

  it('outcome without the authority document is refused in words; submission partial save is explained', async () => {
    rpcReplies({ visa_application_set_state: { error: { code: '55000', message: 'outcome_document_required' } } });
    await expect(
      visaActions.recordVisaOutcomeAction(null, form({ taskId: TASK, applicationId: APP, rowVersion: '4', state: 'issued', evidenceId: ENTRY })),
    ).resolves.toMatchObject({ code: 'outcome_document_required', message: ERROR_TEXT.outcome_document_required });
    rpcReplies({
      visa_application_update: { data: { applicationId: APP, rowVersion: 3, state: 'docs_pending' } },
      visa_application_set_state: { error: { code: '55000', message: 'documents_not_checked' } },
    });
    const partial = await visaActions.recordVisaSubmissionAction(null, form({ taskId: TASK, applicationId: APP, rowVersion: '2', reference: 'VFS-123' }));
    expect(partial).toMatchObject({ ok: false, code: 'documents_not_checked' });
    expect(partial.ok ? '' : partial.message).toMatch(/^The reference and appointment were saved/);
  });

  it('queue and task are empty / not available on a database without the desk', async () => {
    rpcReplies({ workflow_settings_get: { error: { code: 'PGRST202', message: 'x' } }, visa_task_list: { error: { code: 'PGRST202', message: 'x' } } });
    await expect(visaLoaders.loadVisaQueue(staff)).resolves.toEqual({ launch: 'unknown', waitingCount: null, tasks: [] });
    rpcReplies({ visa_task_get: { error: { code: '42883', message: 'x' } } });
    await expect(visaLoaders.loadVisaTask(staff, TASK)).resolves.toBeNull();
    rpcReplies({ department_work_form: { error: { code: 'PGRST202', message: 'x' } } });
    await expect(deptLoader.loadDepartmentWorkForm(staff, TASK)).resolves.toBeNull();
  });

  it('Batch 4: the queue reads the desk switch in three states; unknown is never "not launched"', async () => {
    const settings = (visa: boolean | undefined) => ({
      data: { intakePromptEnabled: false, serviceItemsEnabled: true, ...(visa === undefined ? {} : { visaPassportTasksEnabled: visa }), updatedAt: null },
    });
    for (const [reply, launch] of [
      [settings(true), 'on'],
      [settings(false), 'off'],
      [settings(undefined), 'unknown'],
      [{ error: { code: '42501', message: 'not_authorized' } }, 'unknown'],
      [{ throws: true }, 'unknown'],
    ] as const) {
      rpcReplies({ workflow_settings_get: reply, visa_task_list: { data: [] } });
      await expect(visaLoaders.loadVisaQueue(staff)).resolves.toMatchObject({ launch, tasks: [] });
    }
  });
});

describe('department costs', () => {
  it('flight direct payment over the limit is refused in words; hints map to inputs', async () => {
    const cost = { taskId: TASK, rowVersion: '0', requestId: REQUEST, costKind: 'fare', amountRupees: '60,000', paidBy: 'company', paymentMode: 'card', paidOn: '2026-10-10' };
    rpcReplies({ department_cost_save: { error: { code: '22023', message: 'direct_payment_over_limit' } } });
    await expect(dept.saveDepartmentCostAction(null, form(cost))).resolves.toMatchObject({ code: 'direct_payment_over_limit', message: ERROR_TEXT.direct_payment_over_limit });
    rpcReplies({ department_cost_save: { error: { code: '22023', message: 'invalid_input', hint: 'amountPaise' } } });
    await expect(dept.saveDepartmentCostAction(null, form(cost))).resolves.toMatchObject({ fields: ['amountRupees'] });
    rpcReplies({ department_cost_submit: { error: { code: '55000', message: 'receipt_required' } } });
    await expect(dept.submitExpenseRecordAction(null, form({ taskId: TASK, entryId: ENTRY, rowVersion: '1' }))).resolves.toMatchObject({ code: 'receipt_required' });
  });
});

describe('finance claims and expense records', () => {
  const report = { dealId: DEAL, requestId: REQUEST, claimMode: 'cash', claimAmountRupees: '10,000', claimPaidOn: '2026-10-10', claimPayerName: 'Synthetic Customer' };

  it('report under the user session; duplicate and over-total refusals in plain words', async () => {
    rpcReplies({ payment_claim_report: { data: { outcome: 'created', id: CLAIM, status: 'reported', rowVersion: 1 } } });
    const ok = await claimActions.reportPaymentClaimAction(null, form(report));
    expect(ok.status).toBe('ok');
    expect(rpc).toHaveBeenCalledWith('payment_claim_report', expect.objectContaining({ p_deal_id: DEAL, p_request_id: REQUEST }));
    rpcReplies({ payment_claim_report: { error: { code: '23505', message: 'duplicate_claim' } } });
    await expect(claimActions.reportPaymentClaimAction(null, form(report))).resolves.toEqual({ status: 'error', code: 'duplicate_claim', message: FINANCE_ERROR_TEXT.duplicate_claim });
    rpcReplies({ payment_claim_report: { error: { code: '55000', message: 'claim_over_total' } } });
    await expect(claimActions.reportPaymentClaimAction(null, form(report))).resolves.toMatchObject({ code: 'claim_over_total' });
  });

  it('claim context wording for wrong_state and not_self_approval', async () => {
    rpcReplies({ payment_claim_mark_not_received: { error: { code: '55000', message: 'wrong_state' } } });
    await expect(
      claimActions.markClaimNotReceivedAction(null, form({ claimId: CLAIM, requestId: REQUEST, reason: 'No such credit on the statement' })),
    ).resolves.toEqual({ status: 'error', code: 'wrong_state', message: 'This claim was already handled. Reload the page.' });
    rpcReplies({ payment_claim_link_receipt: { error: { code: '42501', message: 'not_self_approval' } } });
    await expect(claimActions.linkClaimReceiptAction(null, form({ claimId: CLAIM, receiptId: ENTRY, requestId: REQUEST }))).resolves.toMatchObject({
      message: 'You reported this payment or you sell this deal, so another Accounts person must handle it.',
    });
  });

  it('expense review: self review refused in words; unexplained failure rethrown', async () => {
    rpcReplies({ expense_record_accept: { error: { code: '42501', message: 'not_self_approval' } } });
    await expect(expenseActions.acceptExpenseRecordAction(null, form({ entryId: ENTRY, rowVersion: '2', requestId: REQUEST }))).resolves.toMatchObject({
      code: 'not_self_approval',
    });
    rpcReplies({ expense_record_return: { error: { code: 'XX000', message: 'boom' } } });
    await expect(
      expenseActions.returnExpenseRecordAction(null, form({ entryId: ENTRY, rowVersion: '2', requestId: REQUEST, reason: 'Receipt is for another trip' })),
    ).rejects.toThrow(/could not confirm/);
  });

  it('version_superseded (0300) maps in both token maps with plain wording', async () => {
    expect(mapFinanceError({ code: '55000', message: 'version_superseded' })).toBe('version_superseded');
    expect(mapBookingError({ code: '55000', message: 'version_superseded' })).toBe('version_superseded');
    expect(FINANCE_ERROR_TEXT.version_superseded).toBe('This booking version was replaced by a newer one. Reload to see the current version.');
    rpcReplies({ payment_claim_report: { error: { code: '55000', message: 'version_superseded' } } });
    await expect(claimActions.reportPaymentClaimAction(null, form(report))).resolves.toEqual({
      status: 'error',
      code: 'version_superseded',
      message: FINANCE_ERROR_TEXT.version_superseded,
    });
  });

  it('cash cap refusals name the cap that refused (DETAIL), like the receipt form', async () => {
    const receipt = {
      dealId: DEAL,
      claimId: CLAIM,
      requestId: REQUEST,
      mode: 'cash',
      amountRupees: '3,00,000',
      receivedOn: new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10),
      branchId: TASK,
      collectorUserId: USER,
      payerName: 'Synthetic Customer',
      payerMobile: '9876543210',
    };
    rpcReplies({ receipt_record_from_claim: { error: { code: '55000', message: 'cash_cap_exceeded', details: 'trip' } } });
    await expect(claimActions.recordReceiptFromClaimAction(null, form(receipt))).resolves.toEqual({
      status: 'error',
      code: 'cash_cap_exceeded',
      message: 'This cash amount is over the company cash limit for this trip. Ask for a bank transfer, UPI or cheque instead.',
    });
    rpcReplies({ receipt_record_from_claim: { error: { code: '55000', message: 'cash_cap_exceeded', details: 'payer_day' } } });
    await expect(claimActions.recordReceiptFromClaimAction(null, form(receipt))).resolves.toMatchObject({ message: expect.stringMatching(/for this payer today/) });
    rpcReplies({ receipt_record_from_claim: { error: { code: '55000', message: 'cash_cap_exceeded' } } });
    await expect(claimActions.recordReceiptFromClaimAction(null, form(receipt))).resolves.toMatchObject({ message: FINANCE_ERROR_TEXT.cash_cap_exceeded });
  });

  it('claims and expense lists are null (not installed) on an older database', async () => {
    rpcReplies({ accounts_payment_claims: { error: { code: 'PGRST202', message: 'x' } } });
    await expect(financeQueries.loadClaimsQueue(staff)).resolves.toBeNull();
    rpcReplies({ accounts_expense_records: { error: { code: '42883', message: 'x' } } });
    await expect(financeQueries.loadExpenseQueue(staff)).resolves.toBeNull();
    rpcReplies({ accounts_payment_claims: { error: { code: '42501', message: 'not_authorized' } } });
    await expect(financeQueries.loadClaimsQueue(staff)).rejects.toThrow();
  });
});
