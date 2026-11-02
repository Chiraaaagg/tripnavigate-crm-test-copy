import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ERROR_TEXT,
  INTAKE_CONFIRM_EXISTING_TEXT,
  UNKNOWN_OUTCOME_TEXT,
} from '@/modules/fulfilment/contracts';

/**
 * B1 server actions and loaders with a fake RPC client: session gate first,
 * every command under the staff member's own session, each refusal token
 * mapped to frozen wording, unknown outcomes never reported as "nothing
 * changed", and the right paths revalidated. Synthetic ids only.
 */

const requireStaff = vi.fn();
const rpc = vi.fn();
const revalidatePath = vi.fn();

vi.mock('@/modules/identity/server/session', () => ({ requireStaff: () => requireStaff() }));
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

const intake = await import('@/modules/fulfilment/server/intake-actions');
const flight = await import('@/modules/fulfilment/server/flight-actions');
const workflow = await import('@/modules/fulfilment/server/workflow-actions');
const loaders = await import('@/modules/fulfilment/server/intake');
const flightLoaders = await import('@/modules/fulfilment/server/flight');
const counts = await import('@/modules/fulfilment/server/counts');

const USER = 'a0000000-0000-4000-8000-000000000001';
const DEAL = 'd0000000-0000-4000-8000-000000000001';
const DEAL2 = 'd0000000-0000-4000-8000-000000000002';
const VERSION = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const TASK2 = '22222222-2222-4222-8222-222222222223';
const ITEM = '33333333-3333-4333-8333-333333333333';
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

const transferFields = { dealId: DEAL, versionId: VERSION, rowVersion: '3', requestId: REQUEST, serviceType: 'transfer', route: 'Airport to hotel', date: '2026-11-01', vehicleType: 'Sedan', passengers: '2', purchaseBudgetRupees: '1500' };

beforeEach(() => {
  vi.clearAllMocks();
  requireStaff.mockResolvedValue({ userId: USER, supabase: { rpc }, access: { userId: USER, memberships: [], rolePermissions: [], grants: [] } });
});

describe('session gate', () => {
  it.each([
    ['add', () => intake.addServiceItemAction(null, form(transferFields))],
    ['save', () => intake.saveServiceItemAction(null, form({ ...transferFields, itemId: ITEM }))],
    ['remove', () => intake.removeServiceItemAction(null, form({ dealId: DEAL, versionId: VERSION, rowVersion: '3', itemId: ITEM }))],
    ['travellers', () => intake.saveTravellersAction(null, form({ dealId: DEAL, rowVersion: '3' }))],
    ['confirm', () => intake.confirmIntakeAction(null, form({ dealId: DEAL, versionId: VERSION, contentHash: HASH }))],
    ['flight claim', () => flight.claimFlightTaskAction(null, form({ taskId: TASK }))],
    ['workflow', () => workflow.setWorkflowSettingAction(null, form({ settingKey: 'service_items_enabled', settingValue: 'on', reason: 'Pilot for Jodhpur only' }))],
  ])('%s stops before any database call', async (_n, run) => {
    requireStaff.mockRejectedValue(new Error('NEXT_REDIRECT /mfa/challenge'));
    await expect(run()).rejects.toThrow('NEXT_REDIRECT');
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('addServiceItemAction', () => {
  it('sends the typed facts, paise and replay key under the user session; revalidates deal, intake', async () => {
    rpcReplies({ service_item_add: { data: { itemId: ITEM, itemNo: 2, rowVersion: 4, contentHash: HASH } } });
    const result = await intake.addServiceItemAction(null, form({ ...transferFields, userId: 'x', legalEntityId: 'y' }));
    expect(result).toEqual({ ok: true, data: { itemId: ITEM, itemNo: 2, rowVersion: 4, contentHash: HASH }, message: 'Transfer or cab added as service 2. The draft is not confirmed yet.' });
    expect(rpc).toHaveBeenCalledWith('service_item_add', {
      p_version_id: VERSION,
      p_expected_row_version: 3,
      p_service_type: 'transfer',
      p_facts: { route: 'Airport to hotel', date: '2026-11-01', vehicleType: 'Sedan', passengers: 2, pickupTime: null, notes: null },
      p_purchase_budget_paise: '150000',
      p_request_id: REQUEST,
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/app/deals/${DEAL}`);
    expect(revalidatePath).toHaveBeenCalledWith(`/app/deals/${DEAL}/intake`);
  });

  it('refuses without a replay key, with an itemId, or an on-hold type, before the database', async () => {
    const { requestId: _r, ...noKey } = transferFields;
    void _r;
    await expect(intake.addServiceItemAction(null, form(noKey))).resolves.toMatchObject({ ok: false, code: 'invalid_input' });
    await expect(intake.addServiceItemAction(null, form({ ...transferFields, itemId: ITEM }))).resolves.toMatchObject({ ok: false, code: 'invalid_input' });
    await expect(intake.addServiceItemAction(null, form({ ...transferFields, serviceType: 'train' }))).resolves.toMatchObject({ ok: false, code: 'invalid_input' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['service_on_hold', '22023'],
    ['too_many_items', '22023'],
    ['service_items_disabled', '55000'],
    ['invalid_input', '22023'],
    ['version_changed', '40001'],
    ['not_authorized', '42501'],
    ['deal_removed', '55000'],
    ['deal_not_active', '55000'],
  ] as const)('%s maps to its frozen wording', async (code, state) => {
    rpcReplies({ service_item_add: { error: { code: state, message: code } } });
    await expect(intake.addServiceItemAction(null, form(transferFields))).resolves.toEqual({ ok: false, code, message: ERROR_TEXT[code] });
  });

  it('a token with the wrong SQLSTATE is not guessed; a lost response is an unknown outcome', async () => {
    rpcReplies({ service_item_add: { error: { code: '55000', message: 'too_many_items' } } });
    await expect(intake.addServiceItemAction(null, form(transferFields))).rejects.toThrow(UNKNOWN_OUTCOME_TEXT);
    rpcReplies({ service_item_add: { throws: true } });
    await expect(intake.addServiceItemAction(null, form(transferFields))).rejects.toThrow(UNKNOWN_OUTCOME_TEXT);
    rpcReplies({ service_item_add: { data: { itemId: ITEM } } });
    await expect(intake.addServiceItemAction(null, form(transferFields))).rejects.toThrow(UNKNOWN_OUTCOME_TEXT);
  });

  it('an exact retry sends the same arguments (the database replays the request id)', async () => {
    rpcReplies({ service_item_add: [{ throws: true }, { data: { itemId: ITEM, itemNo: 1, rowVersion: 1, contentHash: HASH } }] });
    await expect(intake.addServiceItemAction(null, form(transferFields))).rejects.toThrow(UNKNOWN_OUTCOME_TEXT);
    await expect(intake.addServiceItemAction(null, form(transferFields))).resolves.toMatchObject({ ok: true });
    expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
  });
});

describe('saveServiceItemAction / removeServiceItemAction', () => {
  it('save needs an itemId and sends the full facts', async () => {
    rpcReplies({ service_item_save: { data: { rowVersion: 5, contentHash: HASH } } });
    await expect(intake.saveServiceItemAction(null, form(transferFields))).resolves.toMatchObject({ ok: false, code: 'invalid_input' });
    const result = await intake.saveServiceItemAction(null, form({ ...transferFields, itemId: ITEM }));
    expect(result).toMatchObject({ ok: true, data: { rowVersion: 5 } });
    expect(rpc).toHaveBeenCalledWith('service_item_save', expect.objectContaining({ p_item_id: ITEM, p_version_id: VERSION, p_expected_row_version: 3, p_purchase_budget_paise: '150000' }));
  });

  it('remove maps item_locked and revalidates', async () => {
    rpcReplies({ service_item_remove: { error: { code: '55000', message: 'item_locked' } } });
    await expect(intake.removeServiceItemAction(null, form({ dealId: DEAL, versionId: VERSION, rowVersion: '3', itemId: ITEM }))).resolves.toEqual({
      ok: false,
      code: 'item_locked',
      message: ERROR_TEXT.item_locked,
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/app/deals/${DEAL}/intake`);
    rpcReplies({ service_item_remove: { data: { removed: true, rowVersion: 4, contentHash: HASH } } });
    await expect(intake.removeServiceItemAction(null, form({ dealId: DEAL, versionId: VERSION, rowVersion: '3', itemId: ITEM }))).resolves.toMatchObject({ ok: true, data: { removed: true } });
    expect(rpc).toHaveBeenLastCalledWith('service_item_remove', { p_item_id: ITEM, p_version_id: VERSION, p_expected_row_version: 3 });
  });
});

describe('saveTravellersAction', () => {
  it('sends the traveller set with seq and maps traveller_identity_locked', async () => {
    rpcReplies({ deal_travellers_save: { data: { rowVersion: 6, contentHash: HASH } } });
    const result = await intake.saveTravellersAction(null, form({ dealId: DEAL, rowVersion: '5', travellerName: ['Synthetic Adult', 'Synthetic Child'], travellerType: ['adult', 'child'] }));
    expect(result).toEqual({ ok: true, data: { rowVersion: 6, contentHash: HASH }, message: '2 travellers saved.' });
    expect(rpc).toHaveBeenCalledWith('deal_travellers_save', {
      p_deal_id: DEAL,
      p_expected_row_version: 5,
      p_travellers: [
        { fullName: 'Synthetic Adult', type: 'adult', seq: 1 },
        { fullName: 'Synthetic Child', type: 'child', seq: 2 },
      ],
    });
    rpcReplies({ deal_travellers_save: { error: { code: '55000', message: 'traveller_identity_locked' } } });
    await expect(intake.saveTravellersAction(null, form({ dealId: DEAL, rowVersion: '5', travellerName: ['X'], travellerType: ['adult'] }))).resolves.toEqual({
      ok: false,
      code: 'traveller_identity_locked',
      message: ERROR_TEXT.traveller_identity_locked,
    });
    rpcReplies({ deal_travellers_save: { error: { code: 'P0002', message: 'not_found' } } });
    await expect(intake.saveTravellersAction(null, form({ dealId: DEAL, rowVersion: '5' }))).resolves.toMatchObject({ code: 'not_found' });
  });
});

describe('confirmIntakeAction', () => {
  const fields = { dealId: DEAL, versionId: VERSION, contentHash: HASH };

  it('counts the tasks created and revalidates deal, intake, Purchase and Flight', async () => {
    rpcReplies({ booking_confirm: { data: { outcome: 'created', taskId: TASK, versionId: VERSION, taskIds: [TASK, TASK2] } } });
    const result = await intake.confirmIntakeAction(null, form(fields));
    expect(result).toMatchObject({ ok: true, data: { outcome: 'created', taskIds: [TASK, TASK2] } });
    expect(result.ok && result.message).toBe('Accepted version saved and 2 internal tasks created. Nothing is booked or paid yet.');
    expect(rpc).toHaveBeenCalledWith('booking_confirm', { p_version_id: VERSION, p_expected_content_hash: HASH });
    for (const p of [`/app/deals/${DEAL}`, `/app/deals/${DEAL}/intake`, '/app/purchase', '/app/flight']) expect(revalidatePath).toHaveBeenCalledWith(p);
  });

  it('a legacy hotel reply (no taskIds) counts one task; a repeat says nothing was created twice', async () => {
    rpcReplies({ booking_confirm: { data: { outcome: 'created', taskId: TASK, versionId: VERSION } } });
    expect((await intake.confirmIntakeAction(null, form(fields))) as { message: string }).toMatchObject({ message: expect.stringContaining('1 internal task created') });
    rpcReplies({ booking_confirm: { data: { outcome: 'existing', taskId: TASK, versionId: VERSION, taskIds: [TASK] } } });
    expect(await intake.confirmIntakeAction(null, form(fields))).toMatchObject({ ok: true, message: INTAKE_CONFIRM_EXISTING_TEXT });
  });

  it('not_ready re-reads the readiness issues (B1 codes accepted)', async () => {
    rpcReplies({
      booking_confirm: { error: { code: '55000', message: 'not_ready' } },
      booking_readiness: { data: { ready: false, issues: ['stage_not_confirmed', 'traveller_count_mismatch'], contentHash: HASH } },
    });
    await expect(intake.confirmIntakeAction(null, form(fields))).resolves.toEqual({
      ok: false,
      code: 'not_ready',
      message: ERROR_TEXT.not_ready,
      issues: ['stage_not_confirmed', 'traveller_count_mismatch'],
    });
  });

  it.each([
    ['service_items_disabled', '55000'],
    ['version_changed', '40001'],
    ['booking_disabled', '55000'],
  ] as const)('%s keeps the frozen wording', async (code, state) => {
    rpcReplies({ booking_confirm: { error: { code: state, message: code } } });
    await expect(intake.confirmIntakeAction(null, form(fields))).resolves.toEqual({ ok: false, code, message: ERROR_TEXT[code] });
  });

  it('an empty taskIds array is an unknown outcome (fail closed)', async () => {
    rpcReplies({ booking_confirm: { data: { outcome: 'created', taskId: TASK, versionId: VERSION, taskIds: [] } } });
    await expect(intake.confirmIntakeAction(null, form(fields))).rejects.toThrow(UNKNOWN_OUTCOME_TEXT);
  });
});

describe('claimFlightTaskAction', () => {
  it('claims under the user session and reports repeats; task_conflict maps', async () => {
    rpcReplies({ flight_task_claim: { data: { taskId: TASK, status: 'in_progress', assignedToYou: true, alreadyYours: false } } });
    const result = await flight.claimFlightTaskAction(null, form({ taskId: TASK }));
    expect(result).toMatchObject({ ok: true, message: expect.stringContaining('No ticket is issued yet') });
    expect(rpc).toHaveBeenCalledWith('flight_task_claim', { p_task_id: TASK });
    expect(revalidatePath).toHaveBeenCalledWith('/app/flight');
    expect(revalidatePath).toHaveBeenCalledWith(`/app/flight/${TASK}`);
    rpcReplies({ flight_task_claim: { error: { code: '40001', message: 'task_conflict' } } });
    await expect(flight.claimFlightTaskAction(null, form({ taskId: TASK }))).resolves.toEqual({ ok: false, code: 'task_conflict', message: ERROR_TEXT.task_conflict });
    await expect(flight.claimFlightTaskAction(null, form({ taskId: 'x' }))).resolves.toMatchObject({ code: 'invalid_input' });
  });
});

describe('setWorkflowSettingAction', () => {
  const fields = { settingKey: 'service_items_enabled', settingValue: 'on', reason: 'Pilot for Jodhpur, one salesperson only' };

  it('sends key, value and reason; words changed vs unchanged', async () => {
    rpcReplies({
      admin_set_workflow_setting: [
        { data: { key: 'service_items_enabled', changed: true, before: false, after: true, updatedAt: '2026-10-10T10:00:00Z' } },
        { data: { key: 'service_items_enabled', changed: false, before: true, after: true, updatedAt: '2026-10-10T10:00:00Z' } },
      ],
    });
    const first = await workflow.setWorkflowSettingAction(null, form(fields));
    expect(first).toMatchObject({ ok: true, data: { changed: true, after: true }, message: expect.stringContaining('is now on') });
    expect(rpc).toHaveBeenCalledWith('admin_set_workflow_setting', { p_key: 'service_items_enabled', p_value: true, p_reason: 'Pilot for Jodhpur, one salesperson only' });
    expect(revalidatePath).toHaveBeenCalledWith('/app/admin/workflow');
    const second = await workflow.setWorkflowSettingAction(null, form(fields));
    expect(second).toMatchObject({ ok: true, message: expect.stringContaining('Nothing changed') });
  });

  it('refuses a short reason or unknown key before the database; maps not_authorized and invalid_input', async () => {
    await expect(workflow.setWorkflowSettingAction(null, form({ ...fields, reason: 'short' }))).resolves.toMatchObject({ code: 'invalid_input' });
    await expect(workflow.setWorkflowSettingAction(null, form({ ...fields, settingKey: 'real_booking_enabled' }))).resolves.toMatchObject({ code: 'invalid_input' });
    expect(rpc).not.toHaveBeenCalled();
    rpcReplies({ admin_set_workflow_setting: { error: { code: '42501', message: 'not_authorized' } } });
    await expect(workflow.setWorkflowSettingAction(null, form(fields))).resolves.toEqual({ ok: false, code: 'not_authorized', message: ERROR_TEXT.not_authorized });
    rpcReplies({ admin_set_workflow_setting: { error: { code: '22023', message: 'invalid_input' } } });
    await expect(workflow.setWorkflowSettingAction(null, form(fields))).resolves.toMatchObject({ code: 'invalid_input' });
  });
});

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

const dealRow = vi.fn();
const assignments = vi.fn();
const from = vi.fn((table: string) => {
  if (table === 'deals') return { select: () => ({ eq: () => ({ maybeSingle: () => dealRow() }) }) };
  return { select: () => ({ eq: () => ({ is: () => assignments() }) }) };
});
const access = { userId: USER, memberships: [], rolePermissions: [], grants: [] };
const staff = { access, supabase: { rpc, from } } as never;

const settingsOn = { data: { intakePromptEnabled: false, serviceItemsEnabled: true, updatedAt: '2026-10-10T10:00:00Z' } };
const panel = { data: { dealId: DEAL, canEdit: true, canConfirm: true, gate: { realBookingEnabled: false, environment: 'test' }, version: null, readiness: null, evidence: [], evidenceVisible: true, task: null } };
const services = { data: { dealId: DEAL, version: null, items: [], travellers: [], canEdit: true, canConfirm: false } };
const checklist = { data: { items: [{ code: 'no_services', blocking: true, owner: 'sales', itemNos: [] }], canConfirm: false } };
const summary = (dealId: string) => ({ dealId, serviceTypes: ['hotel'], total: 1, byState: { planned: 0, notStarted: 1, inProgress: 0, supplierConfirmed: 0 }, fulfilled: false, staleCount: 0, needs: ['take_task'] });

describe('loaders', () => {
  beforeEach(() => {
    dealRow.mockResolvedValue({ data: { id: DEAL, legal_entity_id: 'e', branch_id: 'b', owner_user_id: USER, reference: 'SYN-JOD-001', title: 'Synthetic trip', source_system: 'bitrix', source_stage_id: 'NEW' }, error: null });
    assignments.mockResolvedValue({ data: [], error: null });
  });

  it('loadIntake composes the four reads under the user session', async () => {
    rpcReplies({ workflow_settings_get: settingsOn, booking_panel: panel, deal_services: services, intake_checklist: checklist });
    const view = await loaders.loadIntake(staff, DEAL);
    expect(view).toMatchObject({ dealId: DEAL, dealReference: 'SYN-JOD-001', serviceItemsEnabled: true, stage: { stageId: 'NEW', isTriggerStage: true }, canConfirm: false });
    expect(view!.checklist.items[0]!.code).toBe('no_services');
    expect(rpc).toHaveBeenCalledWith('intake_checklist', { p_deal_id: DEAL });
  });

  it('loadIntake is null for a malformed id, an invisible deal, a refusal or a withheld read; unexplained failures throw', async () => {
    await expect(loaders.loadIntake(staff, 'nope')).resolves.toBeNull();
    dealRow.mockResolvedValueOnce({ data: null, error: null });
    await expect(loaders.loadIntake(staff, DEAL)).resolves.toBeNull();
    expect(rpc).not.toHaveBeenCalled();
    rpcReplies({ workflow_settings_get: settingsOn, booking_panel: panel, deal_services: { data: null }, intake_checklist: checklist });
    await expect(loaders.loadIntake(staff, DEAL)).resolves.toBeNull();
    rpcReplies({ workflow_settings_get: settingsOn, booking_panel: panel, deal_services: services, intake_checklist: { error: { code: '42501', message: 'not_authorized' } } });
    await expect(loaders.loadIntake(staff, DEAL)).resolves.toBeNull();
    rpcReplies({ workflow_settings_get: settingsOn, booking_panel: panel, deal_services: services, intake_checklist: { error: { code: 'XX000', message: 'boom SECRET' } } });
    await expect(loaders.loadIntake(staff, DEAL)).rejects.toThrow('Could not load the intake screen');
  });

  it('loadWorkflowSettings: off on an older database or refusal, throws otherwise', async () => {
    rpcReplies({ workflow_settings_get: { error: { code: 'PGRST202', message: 'Could not find the function' } } });
    await expect(loaders.loadWorkflowSettings(staff)).resolves.toEqual({ intakePromptEnabled: false, serviceItemsEnabled: false, visaPassportTasksEnabled: false, updatedAt: null });
    rpcReplies({ workflow_settings_get: { error: { code: '42501', message: 'not_authorized' } } });
    await expect(loaders.loadWorkflowSettings(staff)).resolves.toMatchObject({ serviceItemsEnabled: false });
    rpcReplies({ workflow_settings_get: { error: { code: 'XX000', message: 'boom' } } });
    await expect(loaders.loadWorkflowSettings(staff)).rejects.toThrow('Could not load the workflow switches');
    rpcReplies({ workflow_settings_get: { data: { serviceItemsEnabled: 'yes' } } });
    await expect(loaders.loadWorkflowSettings(staff)).rejects.toThrow();
  });

  it('loadWorkflowSwitchStates (Workflow switches page): no fallback to off; a switch not returned stays unknown', async () => {
    rpcReplies({ workflow_settings_get: { data: { intakePromptEnabled: true, serviceItemsEnabled: true, updatedAt: null } } });
    const read = await loaders.loadWorkflowSwitchStates(staff);
    expect(read).toMatchObject({ intakePromptEnabled: true, serviceItemsEnabled: true });
    expect(read.visaPassportTasksEnabled).toBeUndefined();
    for (const error of [
      { code: 'PGRST202', message: 'Could not find the function' },
      { code: '42501', message: 'not_authorized' },
      { code: 'XX000', message: 'boom' },
    ]) {
      rpcReplies({ workflow_settings_get: { error } });
      await expect(loaders.loadWorkflowSwitchStates(staff)).rejects.toThrow('Could not load the workflow switches');
    }
  });

  it('loadDealServices: view, null on refusal/older database, throws otherwise', async () => {
    rpcReplies({ deal_services: services });
    await expect(loaders.loadDealServices(staff, DEAL)).resolves.toMatchObject({ dealId: DEAL, progress: { total: 0 } });
    rpcReplies({ deal_services: { error: { code: 'PGRST202', message: 'missing' } } });
    await expect(loaders.loadDealServices(staff, DEAL)).resolves.toBeNull();
    rpcReplies({ deal_services: { error: { code: 'XX000', message: 'boom' } } });
    await expect(loaders.loadDealServices(staff, DEAL)).rejects.toThrow('Could not load the services');
    await expect(loaders.loadDealServices(staff, 'x')).resolves.toBeNull();
  });

  it('loadDealServiceSummaries chunks by 50, dedupes ids, keys by deal; empty on an older database', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `d0000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    rpc.mockImplementation(async (_fn: string, args: { p_deal_ids: string[] }) => ({ data: args.p_deal_ids.slice(0, 2).map(summary), error: null }));
    const map = await loaders.loadDealServiceSummaries(staff, [...ids, ids[0]!, 'not-a-uuid']);
    const sizes = rpc.mock.calls.map((c) => (c[1] as { p_deal_ids: string[] }).p_deal_ids.length);
    expect(sizes).toEqual([50, 50, 20]);
    expect(map.size).toBe(6);
    expect(map.get(ids[0]!)).toMatchObject({ total: 1, serviceTypes: ['hotel'] });
    await expect(loaders.loadDealServiceSummaries(staff, [])).resolves.toEqual(new Map());
    rpcReplies({ deal_service_summary: { error: { code: 'PGRST202', message: 'missing' } } });
    await expect(loaders.loadDealServiceSummaries(staff, [DEAL, DEAL2])).resolves.toEqual(new Map());
    rpcReplies({ deal_service_summary: { error: { code: 'XX000', message: 'boom' } } });
    await expect(loaders.loadDealServiceSummaries(staff, [DEAL])).rejects.toThrow('Could not load the progress');
  });

  it('loadMyWorkCounts is null on any failure, never zeros', async () => {
    rpcReplies({ my_work_counts: { data: { waitingForMe: 2, returnedToMe: 0, missingDetails: 1, intakeNeeded: 0, receiptsToVerify: null, requestsToApprove: null } } });
    await expect(counts.loadMyWorkCounts(staff)).resolves.toEqual({
      waitingForMe: 2,
      returnedToMe: 0,
      missingDetails: 1,
      intakeNeeded: 0,
      receiptsToVerify: null,
      requestsToApprove: null,
      // B1.1 keys: null on a database without migration 0500.
      claimsToProcess: null,
      expensesToReview: null,
      visaTasksWaiting: null,
      // Batch 1 key: null on a database without migration 20261121000120.
      draftsToContinue: null,
      // Batch 3 keys (FP-081): null on a database without migration 20261123000100.
      quotationDraftsToFinish: null,
      acceptedQuotesToLink: null,
    });
    rpcReplies({ my_work_counts: { error: { code: 'PGRST202', message: 'missing' } } });
    await expect(counts.loadMyWorkCounts(staff)).resolves.toBeNull();
    rpcReplies({ my_work_counts: { throws: true } });
    await expect(counts.loadMyWorkCounts(staff)).resolves.toBeNull();
    rpcReplies({ my_work_counts: { data: { waitingForMe: -1 } } });
    await expect(counts.loadMyWorkCounts(staff)).resolves.toBeNull();
  });

  it('Flight loaders mirror Purchase: empty/null on refusal, throw otherwise', async () => {
    const task = { taskId: TASK, dealReference: 'SYN-JOD-001', itemTitle: 'DEL → JAI', facts: { segments: [{ from: 'DEL', to: 'JAI', date: '2026-11-01' }], passengers: 2 }, purchaseBudgetPaise: '100000', status: 'not_started', assigneeName: null, assignedToYou: false, branchName: 'Jodhpur', createdAt: '2026-10-03T05:00:00Z', supplierConfirmedAt: null };
    rpcReplies({ flight_task_list: { data: [task] }, flight_task_get: { data: { ...task, confirmedAt: '2026-10-03T04:00:00Z', confirmedByName: 'Synthetic Sales', versionNo: 1, canClaim: true, travellerCount: 2 } } });
    await expect(flightLoaders.loadFlightQueue(staff)).resolves.toMatchObject({ tasks: [{ taskId: TASK, itemTitle: 'DEL → JAI' }] });
    await expect(flightLoaders.loadFlightTask(staff, TASK)).resolves.toMatchObject({ travellerCount: 2, canClaim: true });
    rpcReplies({ flight_task_list: { error: { code: '42501', message: 'not_authorized' } }, flight_task_get: { error: { code: 'P0002', message: 'not_found' } } });
    await expect(flightLoaders.loadFlightQueue(staff)).resolves.toEqual({ tasks: [] });
    await expect(flightLoaders.loadFlightTask(staff, TASK)).resolves.toBeNull();
    rpcReplies({ flight_task_list: { error: { code: 'XX000', message: 'boom' } } });
    await expect(flightLoaders.loadFlightQueue(staff)).rejects.toThrow('Could not load Flight tasks');
  });
});
