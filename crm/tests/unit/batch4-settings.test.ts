import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LastChange, SettingsSwitchStates } from '@/modules/access/settings-state';
import { bitrixRows, featureRows, lastChangeText, liveRows, visaPreviewModel, visaResultText } from '@/modules/settings/rows';
import { parseSwitchForm } from '@/modules/settings/switch';
import { syncPreviewInput, syncReview, syncReviewLines } from '@/modules/settings/sync-scope';

/*
 * Batch 4 Settings (R6, M1, M5; copy-catalogue DA-254 to DA-259): rows from
 * settings_switch_states, the one change flow for switches (server-side review
 * gate), the Visa count, and the sync scope in two phases (no one-step save).
 */

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/modules/identity/server/session', () => ({
  requireStaff: async () => ({ supabase: { rpc: (...a: unknown[]) => mocks.rpc(...a) }, access: { memberships: [{ roleCode: 'super_admin' }] } }),
}));
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => mocks.revalidatePath(p) }));

const change = (over: Partial<NonNullable<LastChange>> = {}): LastChange => ({
  at: '2026-10-13T05:00:00Z',
  byName: 'Synthetic Admin',
  byYou: false,
  via: 'command',
  command: 'admin_set_workflow_setting',
  from: false,
  to: true,
  fields: [],
  reason: 'Owner APPROVE 13 Oct',
  ...over,
});

type Workflow = Exclude<SettingsSwitchStates['workflow'], null | 'unreadable'>;
const workflow = (switches: Workflow['switches'], over: Partial<Workflow> = {}): Workflow => ({ readable: true, canSwitch: true, switches, ...over });

describe('last change lines (DA-254)', () => {
  it('person, you, system, nothing recorded and unreadable are four different lines', () => {
    expect(lastChangeText(change())).toEqual({ line: expect.stringMatching(/^Last changed on .+ IST by Synthetic Admin: switched on\.$/), reason: 'Reason: “Owner APPROVE 13 Oct”' });
    expect(lastChangeText(change({ byYou: true, to: false })).line).toMatch(/ by you: switched off\.$/);
    expect(lastChangeText(change({ byName: null, via: 'direct_sql', reason: null, to: null }))).toEqual({ line: expect.stringMatching(/by a system update \(no person recorded\)\.$/), reason: null });
    expect(lastChangeText(null).line).toBe('No change recorded since change tracking started.');
    expect(lastChangeText(undefined).line).toBe('Last change: could not be read.');
  });
});

describe('Features rows: always the five switches; Unknown is never Off and never offers a form', () => {
  it('a known switch is changeable by a Super Admin; a missing one is Unknown with no form and no "never changed" line', () => {
    const model = featureRows(workflow([{ key: 'service_items_enabled', state: 'on', lastChange: change() }]));
    expect(model.rows.map((r) => r.key)).toEqual(['service_items_enabled', 'intake_prompt_enabled', 'visa_passport_tasks_enabled', 'prefill_auto_fill', 'referral_drafts']);
    const [book, count] = model.rows;
    expect(book).toMatchObject({ title: 'Book now (service list)', state: 'on', control: { kind: 'switch', canChange: true }, unknownText: null });
    expect(book!.review).toMatchObject({ approvalLine: expect.stringContaining('owner’s APPROVE') });
    expect(count).toMatchObject({ state: 'unknown', control: { kind: 'switch', canChange: false }, review: null, lastChange: { kind: 'unknown' }, lastChangeLine: 'Last change: could not be read.' });
    expect(count!.unknownText).toContain('Unknown is not Off');
  });

  it('nobody but the Super Admin gets a form; the reason is said in words', () => {
    const rows = featureRows(workflow([{ key: 'referral_drafts', state: 'off', lastChange: null }], { canSwitch: false })).rows;
    const referral = rows.find((r) => r.key === 'referral_drafts')!;
    expect(referral).toMatchObject({ state: 'off', control: { canChange: false, blockedText: 'Only a Super Admin can change this.' }, review: null, lastChangeLine: 'No change recorded since change tracking started.' });
  });

  it('a whole section unreadable, not installed or failed: every row Unknown with the section line', () => {
    for (const load of [workflow([], { readable: false }), 'unreadable', 'error'] as const) {
      const model = featureRows(load);
      expect(model.rows.every((r) => r.state === 'unknown' && r.control.kind === 'switch' && !r.control.canChange)).toBe(true);
      expect(model.sectionText).toContain('every switch here shows as Unknown');
    }
    expect(featureRows('not_installed').sectionText).toBe('These settings are not installed in this CRM yet. Nothing is assumed on or off.');
  });

  it('a section the person may not read gives no rows at all (not Unknown)', () => {
    expect(featureRows(null)).toEqual({ rows: [], sectionText: null, canSwitch: false });
  });

  it('Visa tasks: the count is read at review time; Fill from Bitrix names its dependency when trip facts are not on', () => {
    const rows = featureRows(workflow([{ key: 'visa_passport_tasks_enabled', state: 'off', lastChange: null }, { key: 'prefill_auto_fill', state: 'off', lastChange: null }]), { tripFactsRead: 'unknown' }).rows;
    expect(rows.find((r) => r.key === 'visa_passport_tasks_enabled')!.review!.preview).toEqual({ kind: 'visa_tasks', count: null, skipped: null, text: 'Counting the visa and passport services waiting…' });
    expect(rows.find((r) => r.key === 'prefill_auto_fill')!.review!.onText).toContain('“Read trip facts from Bitrix” is Unknown, so nothing is filled until it is on.');
  });
});

describe('Bitrix rows and read-only rows', () => {
  it('sync-scope switches say so in the review; won-only keeps its own card; ID-proof copy names the open stops', () => {
    const rows = bitrixRows(
      { readable: true, canSwitch: true, canManageSync: true, connectionEnabled: true, pilotLegalEntityId: null, pilotBranchId: null, pilotBranchName: null, switches: [
        { key: 'lead_intake_unowned', state: 'off', lastChange: null },
        { key: 'bitrix_id_proof_copy', state: 'off', lastChange: null },
        { key: 'won_only_intake', state: 'on', lastChange: null },
      ], syncSettings: { categoryIds: [1], stageIds: ['C1:NEW'], cutoffAt: null, leadIntakeMode: null, dealIntakeMode: null, autoSync: 'on', lastScopeChange: null, lastSaved: null } },
      { openStops: 2 },
    ).rows;
    expect(rows.find((r) => r.key === 'lead_intake_unowned')!.review!.onText).toContain('This changes which deals or leads are in the CRM for everyone.');
    expect(rows.find((r) => r.key === 'bitrix_id_proof_copy')!.review!.onText).toContain('closes 2 open automatic stops');
    expect(rows.find((r) => r.key === 'won_only_intake')).toMatchObject({ control: { kind: 'read_only' }, review: null });
    expect(rows.find((r) => r.key === 'bitrix_trip_facts_read')).toMatchObject({ state: 'unknown', control: { canChange: false } });
  });

  it('real bookings and supplier confirmation are read only, never a control', () => {
    const rows = liveRows({ realBooking: { state: 'on', lastChange: null }, supplierConfirmation: { state: 'unknown', lastChange: null }, financeModes: [] }).rows;
    expect(rows.map((r) => r.control)).toEqual([
      { kind: 'read_only', text: 'Changed by the CRM team with the owner’s approval, not here.' },
      { kind: 'read_only', text: 'Changed by the CRM team with the owner’s approval, not here.' },
    ]);
    expect(rows[1]).toMatchObject({ state: 'unknown', lastChangeLine: 'Last change: could not be read.' });
  });
});

describe('Visa count (DA-258, lead rulings: shown first, not enforced; confirm disabled when unreadable)', () => {
  it('counts, zero, skipped, unreadable', () => {
    expect(visaPreviewModel({ switchState: 'off', wouldCreate: 3, skipped: 1, deals: 2 })).toEqual({
      state: 'counted', wouldCreate: 3, skipped: 1, deals: 2, canConfirm: true,
      lines: ['Switching on now creates 3 Visa and passport tasks on 2 deals, one for each sold service that has no task yet.', '1 services on removed or lost deals get no task.'],
    });
    expect(visaPreviewModel({ switchState: 'off', wouldCreate: 0, skipped: 0, deals: 0 }).lines).toEqual(['Switching on now creates no tasks: no sold visa or passport service is waiting.']);
    for (const load of [null, 'not_installed', 'error'] as const) expect(visaPreviewModel(load)).toMatchObject({ state: 'uncounted', canConfirm: false });
  });

  it('the result names the actual count, and the review count only when it differs', () => {
    expect(visaResultText(3, 3)).toBe('Visa and passport tasks are on. 3 tasks were created.');
    expect(visaResultText(4, 3)).toBe('Visa and passport tasks are on. 4 tasks were created (3 were counted in the review; services changed in between).');
  });
});

describe('switch form: the review step is checked on the server', () => {
  const fd = (fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.append(k, v);
    return f;
  };
  it('a post without the review confirm is refused; bad fields are named first', () => {
    expect(parseSwitchForm(fd({ settingKey: 'referral_drafts', state: 'on', reason: 'Owner APPROVE 23 Oct' }))).toEqual({ ok: false, code: 'review_required', fields: ['confirm'] });
    expect(parseSwitchForm(fd({ settingKey: 'nope', state: 'maybe', reason: 'short', confirm: 'yes' }))).toEqual({ ok: false, code: 'invalid_input', fields: ['settingKey', 'state', 'reason'] });
    expect(parseSwitchForm(fd({ settingKey: 'visa_passport_tasks_enabled', state: 'on', reason: '  Owner   APPROVE 23 Oct ', confirm: 'yes', reviewedCount: '3' }))).toEqual({
      ok: true,
      value: { key: 'visa_passport_tasks_enabled', on: true, reason: 'Owner APPROVE 23 Oct', reviewedCount: 3 },
    });
  });
});

describe('changeSettingSwitchAction', () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.revalidatePath.mockReset();
  });
  const post = (fields: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries({ reason: 'Owner APPROVE 23 Oct 2026', confirm: 'yes', ...fields })) f.append(k, v);
    return f;
  };

  it('never calls the database without the review confirm', async () => {
    const { changeSettingSwitchAction } = await import('@/modules/settings/server/actions');
    const f = post({ settingKey: 'referral_drafts', state: 'on' });
    f.delete('confirm');
    expect(await changeSettingSwitchAction(null, f)).toMatchObject({ ok: false, code: 'review_required' });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('a Features switch goes through admin_set_workflow_setting with the reason; Visa reports the actual count', async () => {
    const { changeSettingSwitchAction } = await import('@/modules/settings/server/actions');
    mocks.rpc.mockResolvedValueOnce({ data: { key: 'visa_passport_tasks_enabled', changed: true, before: false, after: true, updatedAt: '2026-10-23T08:00:00Z', tasksCreated: 4, skipped: 0 }, error: null });
    const r = await changeSettingSwitchAction(null, post({ settingKey: 'visa_passport_tasks_enabled', state: 'on', reviewedCount: '3' }));
    expect(mocks.rpc).toHaveBeenCalledWith('admin_set_workflow_setting', { p_key: 'visa_passport_tasks_enabled', p_value: true, p_reason: 'Owner APPROVE 23 Oct 2026' });
    expect(r).toMatchObject({ ok: true, key: 'visa_passport_tasks_enabled', state: 'on', changed: true, tasksCreated: 4 });
    expect(r.message).toBe('Visa and passport tasks are on. 4 tasks were created (3 were counted in the review; services changed in between). Recorded with your name and reason.');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/admin/workflow');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/app/admin/integration');
  });

  it('a Bitrix switch uses its own command; refusals come back in words with nothing changed', async () => {
    const { changeSettingSwitchAction } = await import('@/modules/settings/server/actions');
    mocks.rpc.mockResolvedValueOnce({ data: { changed: true, before: { tripFactsRead: false, leadIntakeUnowned: false }, after: { tripFactsRead: true, leadIntakeUnowned: false }, requeued: 0 }, error: null });
    expect(await changeSettingSwitchAction(null, post({ settingKey: 'bitrix_trip_facts_read', state: 'on' }))).toMatchObject({ ok: true, message: 'Read trip facts from Bitrix is now on. Recorded with your name and reason.' });
    expect(mocks.rpc).toHaveBeenLastCalledWith('integration_set_bitrix_read_switches', { p_trip_facts_read: true, p_lead_intake_unowned: null, p_reason: 'Owner APPROVE 23 Oct 2026' });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'not_authorized' } });
    expect(await changeSettingSwitchAction(null, post({ settingKey: 'referral_drafts', state: 'on' }))).toEqual({ ok: false, code: 'not_authorized', message: 'Only a Super Admin can change this. Nothing was changed.' });
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '55P03', message: 'settings_busy' } });
    expect(await changeSettingSwitchAction(null, post({ settingKey: 'referral_drafts', state: 'on' }))).toMatchObject({ ok: false, code: 'settings_busy' });
  });
});

describe('sync scope: preview then apply (M1); there is no one-step save', () => {
  beforeEach(() => mocks.rpc.mockReset());
  const draftForm = (extra: Record<string, string> = {}) => {
    const f = new FormData();
    f.append('categoryId', '1');
    f.append('stageId', 'C1:NEW');
    f.append('stageId', 'C9:WON');
    f.append('cutoff', '2026-09-01');
    f.append('syncEnabled', 'on');
    for (const [k, v] of Object.entries(extra)) f.append(k, v);
    return f;
  };
  const preview = {
    previewId: '00000000-0000-4000-8000-0000000000aa',
    expiresAt: '2026-10-23T08:10:00Z',
    changed: true,
    current: { categoryIds: [1, 2], stageIds: ['C1:NEW', 'C2:NEW'], cutoffAt: '2026-08-31T18:30:00Z', autoSync: true, leadIntakeMode: 'scope', dealIntakeMode: 'scope' },
    proposed: { categoryIds: [1], stageIds: ['C1:NEW'], cutoffAt: '2026-08-31T18:30:00Z', autoSync: true, leadIntakeMode: 'scope', dealIntakeMode: 'scope' },
    hide: { total: 4, beforeSyncDate: 0, pipelineNotEligible: 4, stageNotEligible: 0, withCrmWork: 1 },
    bringBack: 0,
    recheck: 2,
    autoSyncChange: 'none',
  };

  it('stages count only inside ticked pipelines; empty choices are named', () => {
    expect(syncPreviewInput({ categoryIds: ['1'], stageIds: ['C1:NEW', 'C9:WON'], cutoff: '2026-09-01', syncEnabled: true })).toEqual({
      ok: true,
      input: { categoryIds: [1], stageIds: ['C1:NEW'], cutoffAt: '2026-09-01T00:00:00+05:30', syncEnabled: true },
    });
    expect(syncPreviewInput({ categoryIds: [], stageIds: [], cutoff: '', syncEnabled: false })).toEqual({ ok: false, fields: ['categoryIds', 'stageIds', 'cutoff'] });
  });

  it('the review shows exact counts, the CRM-work line, and a confirm that says how many deals it hides', async () => {
    const { previewSyncScopeAction } = await import('@/modules/settings/server/actions');
    mocks.rpc.mockResolvedValueOnce({ data: preview, error: null });
    const r = await previewSyncScopeAction(null, draftForm());
    expect(mocks.rpc).toHaveBeenCalledWith('integration_preview_sync_settings', expect.objectContaining({ p_category_ids: [1], p_stage_ids: ['C1:NEW'], p_sync_enabled: true }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const lines = syncReviewLines(r.review, { categoryIds: ['1', '2'], stageIds: ['C1:NEW', 'C2:NEW'], cutoff: '2026-09-01', syncEnabled: true }, [
      { id: '1', name: 'Sales', stages: [{ id: 'C1:NEW', name: 'New', kind: 'open' }] },
      { id: '2', name: 'Visa', stages: [{ id: 'C2:NEW', name: 'New', kind: 'open' }] },
    ]);
    expect(lines.changes).toEqual(['Pipelines removed: Visa', 'Stages removed: New (Visa)']);
    expect(lines.hides).toBe('Hides 4 deals from everyone now.');
    expect(lines.details).toContain('1 of them have CRM work (a booking, task, payment record or document). Their records are kept and come back with the deal.');
    expect(lines.details).toContain('Bitrix is checked again for 2 skipped records. Some may come in at the next update; this number is not exact.');
    expect(lines.confirmLabel).toBe('Save and hide 4 deals');
  });

  it('apply sends only the preview id and the reason; a stale review comes back with fresh numbers and nothing saved', async () => {
    const { applySyncScopeAction } = await import('@/modules/settings/server/actions');
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '40001', message: 'preview_stale', hint: 'counts_changed' } });
    mocks.rpc.mockResolvedValueOnce({ data: { ...preview, previewId: '00000000-0000-4000-8000-0000000000bb', hide: { ...preview.hide, total: 5, pipelineNotEligible: 5 } }, error: null });
    const r = await applySyncScopeAction(null, draftForm({ previewId: preview.previewId, reason: 'Owner APPROVE 23 Oct 2026' }));
    expect(mocks.rpc.mock.calls[0]).toEqual(['integration_apply_sync_settings', { p_preview_id: preview.previewId, p_reason: 'Owner APPROVE 23 Oct 2026' }]);
    expect(r).toMatchObject({ ok: false, code: 'preview_stale', hint: 'counts_changed', message: 'Not saved: the numbers changed after your review. Check the new numbers below and confirm again.' });
    expect(r.review).toMatchObject({ state: 'ready', previewId: '00000000-0000-4000-8000-0000000000bb', hide: { total: 5 } });
  });

  it('a database without the two-phase commands says not installed; a short reason never reaches it', async () => {
    const { applySyncScopeAction, previewSyncScopeAction } = await import('@/modules/settings/server/actions');
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'x' } });
    expect(await previewSyncScopeAction(null, draftForm())).toMatchObject({ ok: false, code: 'not_installed', message: 'Reviewing these changes is not installed in this CRM yet, so they cannot be saved now. Nothing was changed.' });
    mocks.rpc.mockReset();
    expect(await applySyncScopeAction(null, draftForm({ previewId: preview.previewId, reason: 'short' }))).toMatchObject({ ok: false, code: 'invalid_reason' });
    expect(await applySyncScopeAction(null, draftForm({ reason: 'Owner APPROVE 23 Oct 2026' }))).toMatchObject({ ok: false, code: 'preview_required' });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('automatic updates must be chosen: a missing answer is refused, never read as Off (Echo-A L4)', async () => {
    const { previewSyncScopeAction } = await import('@/modules/settings/server/actions');
    const unchosen = draftForm();
    unchosen.delete('syncEnabled');
    expect(await previewSyncScopeAction(null, unchosen)).toMatchObject({ ok: false, code: 'invalid_input', fields: ['syncEnabled'] });
    const bogus = draftForm();
    bogus.set('syncEnabled', 'maybe');
    expect(await previewSyncScopeAction(null, bogus)).toMatchObject({ ok: false, code: 'invalid_input', fields: ['syncEnabled'] });
    expect(mocks.rpc).not.toHaveBeenCalled();
    mocks.rpc.mockResolvedValueOnce({ data: preview, error: null });
    const off = draftForm();
    off.set('syncEnabled', 'off');
    expect((await previewSyncScopeAction(null, off)).ok).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith('integration_preview_sync_settings', expect.objectContaining({ p_sync_enabled: false }));
  });

  it('the review model keeps the posted ticks', () => {
    expect(syncReview({ categoryIds: ['1'], stageIds: ['C1:NEW'], cutoff: '2026-09-01', syncEnabled: true }, preview as never).draft.categoryIds).toEqual(['1']);
  });
});

describe('Batch 4 fix round', () => {
  beforeEach(() => mocks.rpc.mockReset());

  it('an integration manager who is not a Super Admin (canSwitch false): every row shows its state and last change, read only, no form', () => {
    const model = featureRows(
      workflow(
        [
          { key: 'service_items_enabled', state: 'on', lastChange: change() },
          { key: 'intake_prompt_enabled', state: 'off', lastChange: null },
          { key: 'visa_passport_tasks_enabled', state: 'off', lastChange: null },
          { key: 'prefill_auto_fill', state: 'off', lastChange: null },
          { key: 'referral_drafts', state: 'off', lastChange: null },
        ],
        { canSwitch: false },
      ),
    );
    expect(model.canSwitch).toBe(false);
    expect(model.sectionText).toBeNull();
    expect(model.rows).toHaveLength(5);
    for (const row of model.rows) {
      expect(row.state).not.toBe('unknown');
      expect(row.control).toEqual({ kind: 'switch', canChange: false, blockedText: 'Only a Super Admin can change this.' });
      expect(row.review).toBeNull();
    }
    expect(model.rows[0]!.lastChangeLine).toMatch(/by Synthetic Admin: switched on\.$/);
  });

  it('a Purchase holder (or anyone without the Bitrix connection right) is refused by preview and apply in plain words', async () => {
    const { applySyncScopeAction, previewSyncScopeAction } = await import('@/modules/settings/server/actions');
    const f = new FormData();
    f.append('categoryId', '1');
    f.append('stageId', 'C1:NEW');
    f.append('cutoff', '2026-09-01');
    f.append('syncEnabled', 'off');
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'not_authorized' } });
    expect(await previewSyncScopeAction(null, f)).toEqual({ ok: false, code: 'not_authorized', hint: null, message: 'Only staff who manage the Bitrix connection can change this. Nothing was changed.' });
    f.append('previewId', '00000000-0000-4000-8000-0000000000aa');
    f.append('reason', 'Owner APPROVE 23 Oct 2026');
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'not_authorized' } });
    expect(await applySyncScopeAction(null, f)).toEqual({ ok: false, code: 'not_authorized', hint: null, message: 'Only staff who manage the Bitrix connection can change this. Nothing was changed.' });
  });

  it('reasons keep their line breaks; only runs of spaces collapse (Echo-A L10)', async () => {
    const { normaliseReason } = await import('@/modules/settings/switch');
    expect(normaliseReason('  Owner   APPROVE\r\n\r\n\r\n  23 Oct\t 2026 ')).toBe('Owner APPROVE\n\n23 Oct 2026');
    const { changeSettingSwitchAction } = await import('@/modules/settings/server/actions');
    mocks.rpc.mockResolvedValueOnce({ data: { key: 'referral_drafts', changed: true, before: false, after: true, updatedAt: '2026-10-23T08:00:00Z' }, error: null });
    const f = new FormData();
    for (const [k, v] of Object.entries({ settingKey: 'referral_drafts', state: 'on', reason: 'Owner APPROVE 23 Oct\nTicket 42', confirm: 'yes' })) f.append(k, v);
    await changeSettingSwitchAction(null, f);
    expect(mocks.rpc).toHaveBeenCalledWith('admin_set_workflow_setting', { p_key: 'referral_drafts', p_value: true, p_reason: 'Owner APPROVE 23 Oct\nTicket 42' });
  });
});
