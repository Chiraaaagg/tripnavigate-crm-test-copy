import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isEntryEligible, reconcileEligibleDeals, type ReconcileDeps } from '@/modules/integration/bitrix/reconcile';
import { asRpcClient, type RpcClient } from '@/modules/integration/commands';
import {
  dealListingStageIds,
  B11_INTAKE_CONFIG_COLUMNS,
  B12_INTAKE_CONFIG_COLUMNS,
  INTAKE_CONFIG_COLUMNS,
  LEGACY_INTAKE_CONFIG_COLUMNS,
  parseIntakeConfigRow,
  selectIntakeConfig,
  type IntakeConfig,
} from '@/modules/integration/intake-config';
import { toFullCheck } from '@/modules/integration/server/queries';
import {
  entryRuleView,
  PRUNE_DRY_RUN_NOTE,
  PRUNE_UNDO_NOTE,
  pruneDealsOutsideEntryStages,
  setDealEntryStages,
  WonOnlyCommandError,
  wonOnlyRefusalOf,
  wonOnlyRefusalText,
} from '@/modules/integration/won-only';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/modules/identity/server/session', () => ({
  requireStaff: async () => ({ supabase: { rpc: (...a: unknown[]) => mocks.rpc(...a) } }),
}));
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => mocks.revalidatePath(p) }));

/**
 * B1.1d Won-only Deal intake, application layer (migration
 * 20261119000400_b11_won_only_intake; freeze note 3.3). Synthetic data only.
 */

const MEMBER = 'synthetic-member-0001';
const CUTOFF = '2026-10-01T00:00:00+05:30';
const NOW = Date.parse('2026-10-08T10:00:00Z');
const WON = 'C7:WON';

const baseConfig = (over: Partial<IntakeConfig> = {}): IntakeConfig => ({
  portalDomain: 'synthetic.bitrix24.example',
  portalMemberId: MEMBER,
  categoryId: '7',
  categoryIds: ['7'],
  eligibleStageIds: ['C7:NEW'],
  cutoffAt: CUTOFF,
  pilotLegalEntityId: null,
  pilotBranchId: null,
  enabled: true,
  lastReconciledAt: '2026-10-08T09:00:00Z',
  dealIntakeMode: 'scope',
  ...over,
});

const row = {
  portal_domain: 'synthetic.bitrix24.example',
  portal_member_id: MEMBER,
  category_id: 7,
  eligible_stage_ids: ['C7:NEW'],
  cutoff_at: CUTOFF,
  enabled: true,
};

describe('intake config', () => {
  it('reads the entry list; absent, null or empty means off', () => {
    expect(parseIntakeConfigRow(row)?.dealEntryStageIds).toBeNull();
    expect(parseIntakeConfigRow({ ...row, deal_entry_stage_ids: null })?.dealEntryStageIds).toBeNull();
    expect(parseIntakeConfigRow({ ...row, deal_entry_stage_ids: [] })?.dealEntryStageIds).toBeNull();
    expect(parseIntakeConfigRow({ ...row, deal_entry_stage_ids: [WON] })?.dealEntryStageIds).toEqual([WON]);
    expect(B11_INTAKE_CONFIG_COLUMNS).toBe(`${LEGACY_INTAKE_CONFIG_COLUMNS}, deal_entry_stage_ids`);
    // B1.2 0400 adds the two read switches on top (older databases fall back),
    // and 0700 the ID-proof copy switch.
    expect(B12_INTAKE_CONFIG_COLUMNS).toBe(`${B11_INTAKE_CONFIG_COLUMNS}, bitrix_trip_facts_read, lead_intake_unowned`);
    // Batch 1 B1-1 (20261121000100) adds the name-read switch after it.
    // Voice-note batch (20261128000100) adds the trip details switch after it.
    expect(INTAKE_CONFIG_COLUMNS).toBe(`${B12_INTAKE_CONFIG_COLUMNS}, bitrix_id_proof_copy, bitrix_name_read, bitrix_trip_details_read`);
  });

  it('the listing stages are the entry list when on, the ticked stages when off', () => {
    expect(dealListingStageIds(baseConfig())).toEqual(['C7:NEW']);
    expect(dealListingStageIds(baseConfig({ dealEntryStageIds: [WON] }))).toEqual([WON]);
  });

  it('falls back to the legacy columns only when the database lacks the new column', async () => {
    const seen: string[] = [];
    const missing = await selectIntakeConfig(async (columns) => {
      seen.push(columns);
      return columns === INTAKE_CONFIG_COLUMNS ? { data: null, error: { code: '42703' } } : { data: [row], error: null };
    });
    // Voice-note batch: the next older list is the Batch 1 one (0700 plus the name switch).
    expect(seen).toEqual([INTAKE_CONFIG_COLUMNS, `${B12_INTAKE_CONFIG_COLUMNS}, bitrix_id_proof_copy, bitrix_name_read`]);
    expect(missing).toEqual({ data: [row], error: null });

    seen.length = 0;
    const denied = await selectIntakeConfig(async (columns) => {
      seen.push(columns);
      return { data: null, error: { code: '42501' } };
    });
    expect(seen).toEqual([INTAKE_CONFIG_COLUMNS]);
    expect(denied.error).toEqual({ code: '42501' });
  });
});

describe('entry rule (reconcile mirror of the Deal apply)', () => {
  const at = (stageId: string) => ({ categoryId: '7', stageId, created: Date.parse('2026-10-02T10:00:00+05:30') / 1000 });

  it('off: the ticked stages decide; on: only the entry stages, the ticked list no longer counts', () => {
    expect(isEntryEligible(baseConfig(), at('C7:NEW'))).toBe(true);
    expect(isEntryEligible(baseConfig(), at(WON))).toBe(false);
    const on = baseConfig({ dealEntryStageIds: [WON] });
    expect(isEntryEligible(on, at(WON))).toBe(true);
    expect(isEntryEligible(on, at('C7:NEW'))).toBe(false);
    // Pipeline and sync date still apply.
    expect(isEntryEligible(on, { ...at(WON), categoryId: '1' })).toBe(false);
    expect(isEntryEligible(on, { ...at(WON), created: Date.parse('2026-09-01T10:00:00+05:30') / 1000 })).toBe(false);
  });

  describe('Deal update pass', () => {
    let enqueued: number[];
    const rpc = (): RpcClient =>
      asRpcClient({
        rpc: async (fn: string, args?: Record<string, unknown>) => {
          if (fn === 'integration_enqueue_reconcile') {
            enqueued.push(args!.p_deal_id as number);
            return { data: { inboxId: '00000000-0000-4000-8000-0000000000e1', duplicate: false, upToDate: false, ignored: false }, error: null };
          }
          return { data: null, error: null };
        },
      });
    beforeEach(() => {
      enqueued = [];
    });

    it('with Won-only on, an unknown Deal outside Won is not tracked; a held (also removed) Deal is still enqueued', async () => {
      const item = (id: number, stage: string) => ({
        ID: String(id), DATE_MODIFY: '2026-10-08T09:30:00+05:30', DATE_CREATE: '2026-10-02T10:00:00+05:30', STAGE_ID: stage, CATEGORY_ID: '7',
      });
      const listDeals = vi.fn(async () => ({ items: [item(1, 'C7:NEW'), item(2, WON), item(3, 'C7:NEW')], next: null, total: 3 }));
      const heldDealIds = vi.fn(async (ids: number[]) => new Set(ids.filter((id) => id === 3)));
      const summary = await reconcileEligibleDeals({
        rpc: rpc(),
        bitrix: { listDeals, listLeads: vi.fn() } as unknown as ReconcileDeps['bitrix'],
        config: baseConfig({ dealEntryStageIds: [WON] }),
        heldDealIds,
        now: () => NOW,
      });
      expect(heldDealIds).toHaveBeenCalledWith([1, 3]);
      expect(enqueued).toEqual([2, 3]);
      expect(summary.notTracked).toBe(1);
    });
  });
});

describe('full check against the current settings', () => {
  const job = (stageIds: string[]) => ({
    reason: 'settings_changed',
    status: 'done',
    scanned: 1,
    bitrix_total: 1,
    listing_done: true,
    created_at: '2026-10-08T09:00:00Z',
    finished_at: '2026-10-08T09:05:00Z',
    result: { bitrix: 1, crm: 3, missing: 0, extra: 0, keptAfterStageMove: 2, inSync: true },
    cutoff_at: CUTOFF,
    category_ids: ['7'],
    stage_ids: stageIds,
  });

  it('a check that listed the entry stages matches the settings while Won-only intake is on', () => {
    const settings = { cutoffAt: CUTOFF, categoryIds: ['7'], stageIds: dealListingStageIds(baseConfig({ dealEntryStageIds: [WON] })) };
    expect(toFullCheck([job([WON]) as never], settings).last?.matchesSettings).toBe(true);
    expect(toFullCheck([job(['C7:NEW']) as never], settings).last?.matchesSettings).toBe(false);
  });
});

describe('Won-only commands', () => {
  const client = (answer: { data: unknown; error: { code?: string; message?: string } | null }) => {
    const calls: Array<{ fn: string; args: Record<string, unknown> | undefined }> = [];
    return {
      calls,
      rpc: asRpcClient({
        rpc: async (fn: string, args?: Record<string, unknown>) => {
          calls.push({ fn, args });
          return answer;
        },
      }),
    };
  };
  const id = '00000000-0000-4000-8000-0000000000d1';
  const prune = {
    dryRun: true,
    entryStageIds: [WON],
    storedActive: 3,
    atEntryStage: 1,
    pruned: { count: 1, deals: [{ id, reference: 'BX-1', stageId: 'C7:NEW' }] },
    keptWithWork: {
      count: 1,
      byKind: { booking_version: [id], task: [] },
      deals: [{ id, reference: 'BX-2', stageId: 'C7:NEW', work: ['booking_version'] }],
    },
    keptSyncPending: { count: 0, deals: [] },
    truncated: false,
  };

  it('pass the arguments under the caller session and parse the answers strictly', async () => {
    const set = client({ data: { changed: true, before: null, after: [WON], restored: 0, requeued: 0, resyncQueued: true }, error: null });
    expect(await setDealEntryStages(set.rpc, { stageIds: [WON], reason: 'Owner approval APPROVE' })).toMatchObject({ changed: true, after: [WON] });
    expect(set.calls).toEqual([{ fn: 'integration_set_deal_entry_stages', args: { p_stage_ids: [WON], p_reason: 'Owner approval APPROVE' } }]);

    const p = client({ data: prune, error: null });
    expect(await pruneDealsOutsideEntryStages(p.rpc, { reason: 'Owner approval APPROVE', dryRun: true })).toEqual(prune);
    expect(p.calls[0]).toEqual({ fn: 'integration_prune_deals_outside_entry_stages', args: { p_reason: 'Owner approval APPROVE', p_dry_run: true } });

    // An unknown key or work kind fails closed.
    await expect(pruneDealsOutsideEntryStages(client({ data: { ...prune, extra: 1 }, error: null }).rpc, { reason: 'x'.repeat(10), dryRun: true })).rejects.toBeInstanceOf(WonOnlyCommandError);
    const badKind = { ...prune, keptWithWork: { ...prune.keptWithWork, deals: [{ id, reference: 'BX-2', stageId: 'C7:NEW', work: ['money'] }] } };
    await expect(pruneDealsOutsideEntryStages(client({ data: badKind, error: null }).rpc, { reason: 'x'.repeat(10), dryRun: true })).rejects.toMatchObject({ refusal: 'unexpected' });
  });

  it('map every database refusal to a token and plain text, never the database message', async () => {
    expect(wonOnlyRefusalOf({ code: '42501', message: 'not_authorized' })).toBe('not_authorized');
    expect(wonOnlyRefusalOf({ code: '22023', message: 'invalid_input' })).toBe('invalid_input');
    expect(wonOnlyRefusalOf({ code: '22023', message: 'entry_stage_outside_pipelines' })).toBe('entry_stage_outside_pipelines');
    expect(wonOnlyRefusalOf({ code: '22023', message: 'a reason of 10 to 500 characters is required' })).toBe('reason_required');
    expect(wonOnlyRefusalOf({ code: '55000', message: 'entry_stages_not_set' })).toBe('entry_stages_not_set');
    expect(wonOnlyRefusalOf({ code: '55000', message: 'intake is not configured' })).toBe('not_configured');
    expect(wonOnlyRefusalOf({ code: 'PGRST202' })).toBe('not_installed');
    expect(wonOnlyRefusalOf({ code: 'XX000' })).toBe('unexpected');
    const err = await setDealEntryStages(client({ data: null, error: { code: '42501', message: 'secret detail' } }).rpc, {
      stageIds: null,
      reason: 'x'.repeat(10),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WonOnlyCommandError);
    expect((err as Error).message).not.toContain('secret detail');
    expect(wonOnlyRefusalText('entry_stages_not_set')).toMatch(/Won-only intake is off/);
    expect(wonOnlyRefusalText('entry_stages_not_set')).toContain(PRUNE_DRY_RUN_NOTE);
    expect(PRUNE_DRY_RUN_NOTE).toMatch(/writes only a record of the check/);
  });
});

describe('entry rule view', () => {
  const pipelines = [{ id: '7', name: 'Synthetic pipeline', stages: [{ id: WON, name: 'Won - Payment Received', kind: 'won' as const }] }];

  it('names the entry stages from the Bitrix directory, ids when unreadable; off shows the ticked stages', () => {
    expect(entryRuleView(baseConfig({ dealEntryStageIds: [WON] }), pipelines)).toEqual({
      wonOnly: true,
      entryStageIds: [WON],
      entryStages: [{ id: WON, label: 'Won - Payment Received', pipelineName: 'Synthetic pipeline' }],
      tickedStageIds: ['C7:NEW'],
    });
    expect(entryRuleView(baseConfig({ dealEntryStageIds: [WON] }), null).entryStages).toEqual([{ id: WON, label: WON, pipelineName: null }]);
    expect(entryRuleView(baseConfig(), pipelines)).toEqual({ wonOnly: false, entryStageIds: [], entryStages: [], tickedStageIds: ['C7:NEW'] });
  });
});

describe('server actions', () => {
  const { rpc, revalidatePath } = mocks;
  const form = (fields: Record<string, string | string[]>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) fd.append(k, x);
    return fd;
  };
  const REASON = 'Owner approval APPROVE 11 Oct';
  beforeEach(() => {
    rpc.mockReset();
    revalidatePath.mockReset();
  });

  it('setDealEntryStagesAction validates, calls the command and keeps typed values after a refusal', async () => {
    const { setDealEntryStagesAction } = await import('@/modules/integration/server/won-only-actions');
    const idle = { status: 'idle' as const };
    expect(await setDealEntryStagesAction(idle, form({ mode: 'on', stageId: WON, reason: 'short' }))).toMatchObject({
      status: 'error', values: { reason: 'short', stageIds: [WON] },
    });
    expect(rpc).not.toHaveBeenCalled();
    rpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'entry_stage_outside_pipelines' } });
    expect(await setDealEntryStagesAction(idle, form({ mode: 'on', stageId: 'C9:WON', reason: REASON }))).toMatchObject({
      status: 'error', message: expect.stringMatching(/pipeline the sync does not take/), values: { reason: REASON, stageIds: ['C9:WON'] },
    });
    rpc.mockResolvedValueOnce({ data: { changed: true, before: [WON], after: null, restored: 2, requeued: 3, resyncQueued: true }, error: null });
    const off = await setDealEntryStagesAction(idle, form({ mode: 'off', reason: REASON }));
    expect(rpc).toHaveBeenLastCalledWith('integration_set_deal_entry_stages', { p_stage_ids: null, p_reason: REASON });
    expect(off).toMatchObject({ status: 'success', message: expect.stringMatching(/2 Deals removed earlier came back\. 3 skipped Bitrix updates are checked again/) });
    expect(revalidatePath).toHaveBeenCalledWith('/app/admin/integration');
  });

  it('the real prune needs the typed confirmation; the dry run returns the result', async () => {
    const { pruneDryRunAction, pruneRunAction } = await import('@/modules/integration/server/won-only-actions');
    const idle = { status: 'idle' as const };
    expect(await pruneRunAction(idle, form({ reason: REASON, confirm: 'remove' }))).toMatchObject({ status: 'error', values: { confirm: 'remove' } });
    expect(rpc).not.toHaveBeenCalled();
    const answer = {
      dryRun: true, entryStageIds: [WON], storedActive: 1, atEntryStage: 0,
      pruned: { count: 1, deals: [{ id: '00000000-0000-4000-8000-0000000000d1', reference: 'BX-1', stageId: 'C7:NEW' }] },
      keptWithWork: { count: 0, byKind: {}, deals: [] }, keptSyncPending: { count: 0, deals: [] }, truncated: false,
    };
    rpc.mockResolvedValueOnce({ data: answer, error: null });
    const dry = await pruneDryRunAction(idle, form({ reason: REASON }));
    expect(rpc).toHaveBeenLastCalledWith('integration_prune_deals_outside_entry_stages', { p_reason: REASON, p_dry_run: true });
    expect(dry).toMatchObject({ status: 'success', result: answer, message: expect.stringMatching(/^Dry run: no Deal changed \(one record of this check was written\)\. 1 Deal would be removed/) });
    rpc.mockResolvedValueOnce({ data: { ...answer, dryRun: false }, error: null });
    expect(await pruneRunAction(idle, form({ reason: REASON, confirm: 'REMOVE' }))).toMatchObject({
      status: 'success', message: expect.stringContaining(PRUNE_UNDO_NOTE),
    });
    expect(rpc).toHaveBeenLastCalledWith('integration_prune_deals_outside_entry_stages', { p_reason: REASON, p_dry_run: false });
  });
});

describe('settings save refusal text (review W4; Batch 4: preview then apply, M1)', () => {
  it('names the Won-only pipeline rule in plain words when the review is refused', async () => {
    const { previewSyncScopeAction } = await import('@/modules/settings/server/actions');
    mocks.rpc.mockReset();
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'entry_stage_pipeline_required' } });
    const fd = new FormData();
    fd.append('categoryId', '1');
    fd.append('stageId', 'C1:NEW');
    fd.append('cutoff', '2026-09-01');
    fd.append('syncEnabled', 'off');
    const res = await previewSyncScopeAction(null, fd);
    expect(mocks.rpc).toHaveBeenCalledWith('integration_preview_sync_settings', expect.objectContaining({ p_category_ids: [1], p_stage_ids: ['C1:NEW'] }));
    expect(res).toEqual({
      ok: false,
      code: 'invalid_input',
      hint: null,
      fields: ['categoryIds'],
      message:
        '“Bring in deals only when won” takes new deals from a stage in a pipeline you unticked. Keep that pipeline ticked, or switch it off first. Nothing was changed.',
    });
  });

  it('the old one-step save never reaches the database', async () => {
    const { updateSyncSettingsAction } = await import('@/modules/integration/server/access-actions');
    mocks.rpc.mockReset();
    expect(await updateSyncSettingsAction()).toEqual({ status: 'error', message: 'Not saved: review the change first. Nothing was changed.' });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
