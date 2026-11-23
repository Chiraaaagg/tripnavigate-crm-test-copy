import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BitrixClientError } from '@/modules/integration/bitrix/client';
import { reconcileEligibleDeals, WATERMARK_OVERLAP_SECONDS, type ReconcileDeps } from '@/modules/integration/bitrix/reconcile';
import { runBitrixSync } from '@/modules/integration/bitrix/sync';
import { handleWorkerRequest, runTriggerFor, type WorkerEndpointDeps } from '@/modules/integration/bitrix/worker-endpoint';
import { asRpcClient } from '@/modules/integration/commands';
import { parseIntakeConfigRow, type IntakeConfig } from '@/modules/integration/intake-config';

/**
 * Sync completion §2 review fixes: Lead scope pass (backfill from the sync date,
 * separate Lead watermark), Deal scope mode ignores the Deal manifest, run
 * triggers on every heartbeat, and the alert check after failed answers.
 * Synthetic data only.
 */

const MEMBER = 'synthetic-member-0001';
const CUTOFF = '2026-10-01T00:00:00+05:30';
const NOW = Date.parse('2026-10-08T10:00:00Z');
const SECRET = 'synthetic-worker-secret-0123456789abcdef';

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
  ...over,
});

type Page = { items: Array<Record<string, unknown>>; next: number | null; total: number | null };
const page = (items: Array<Record<string, unknown>>, next: number | null = null): Page => ({ items, next, total: items.length });

let calls: Array<{ fn: string; args: Record<string, unknown> | undefined }>;
const rpc = () =>
  asRpcClient({
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn === 'integration_enqueue_reconcile' || fn === 'integration_enqueue_reconcile_lead') {
        return { data: { inboxId: '00000000-0000-4000-8000-0000000000e1', duplicate: false, upToDate: false, ignored: false }, error: null };
      }
      return { data: null, error: null };
    },
  });
const fnCalls = (fn: string) => calls.filter((c) => c.fn === fn).map((c) => c.args);

let listDeals: ReturnType<typeof vi.fn>;
let listLeads: ReturnType<typeof vi.fn>;
let store: {
  read: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
  record: ReturnType<typeof vi.fn<(startedAt: string, ok: boolean) => Promise<void>>>;
};
let activeManifestIds: ReturnType<typeof vi.fn>;

beforeEach(() => {
  calls = [];
  listDeals = vi.fn(async () => page([]));
  listLeads = vi.fn(async () => page([]));
  store = {
    read: vi.fn<() => Promise<string | null>>(async () => null),
    record: vi.fn<(startedAt: string, ok: boolean) => Promise<void>>(async () => undefined),
  };
  activeManifestIds = vi.fn(async (object: string) => (object === 'deal' ? ['9001'] : ['501']));
});

const run = (config: IntakeConfig, over: Partial<ReconcileDeps> = {}) =>
  reconcileEligibleDeals({
    rpc: rpc(),
    bitrix: { listDeals, listLeads } as unknown as ReconcileDeps['bitrix'],
    config,
    activeManifestIds: activeManifestIds as ReconcileDeps['activeManifestIds'],
    leadWatermark: store,
    now: () => NOW,
    ...over,
  });

describe('intake config modes', () => {
  it('reads lead_intake_mode and deal_intake_mode; absent = manifest', () => {
    const row = {
      portal_domain: 'synthetic.bitrix24.example',
      portal_member_id: MEMBER,
      category_id: 7,
      eligible_stage_ids: ['C7:NEW'],
      cutoff_at: CUTOFF,
      enabled: true,
    };
    expect(parseIntakeConfigRow(row)).toMatchObject({ leadIntakeMode: 'manifest', dealIntakeMode: 'manifest' });
    expect(parseIntakeConfigRow({ ...row, lead_intake_mode: 'scope', deal_intake_mode: 'scope' })).toMatchObject({
      leadIntakeMode: 'scope',
      dealIntakeMode: 'scope',
    });
    expect(parseIntakeConfigRow({ ...row, lead_intake_mode: 'everything' })).toBeNull();
  });
});

describe('Lead scope pass (H1)', () => {
  const lead = (id: number, modified: string, created = '2026-10-02T10:00:00+05:30') => ({
    ID: String(id),
    DATE_MODIFY: modified,
    DATE_CREATE: created,
    ASSIGNED_BY_ID: '101',
  });

  it('first run backfills from the sync date with header fields only, then records the Lead watermark', async () => {
    listLeads.mockResolvedValueOnce(page([lead(501, '2026-10-03T10:00:00+05:30'), lead(502, '2026-10-04T10:00:00+05:30')]));
    const summary = await run(baseConfig({ leadIntakeMode: 'scope' }));
    expect(listLeads).toHaveBeenCalledTimes(1);
    expect(listLeads.mock.calls[0]![0]).toEqual({
      filter: { '>=DATE_CREATE': CUTOFF, '>DATE_MODIFY': CUTOFF },
      select: ['ID', 'DATE_MODIFY', 'DATE_CREATE', 'ASSIGNED_BY_ID'],
      order: { DATE_MODIFY: 'ASC', ID: 'ASC' },
      start: 0,
    });
    expect(fnCalls('integration_enqueue_reconcile_lead')).toEqual([
      { p_member_id: MEMBER, p_lead_id: 501, p_source_modified: Date.parse('2026-10-03T10:00:00+05:30') / 1000 },
      { p_member_id: MEMBER, p_lead_id: 502, p_source_modified: Date.parse('2026-10-04T10:00:00+05:30') / 1000 },
    ]);
    expect(summary.leadScope).toEqual({ scoped: true, unavailable: false, scanned: 2, enqueued: 2, truncated: false, error: null });
    // The manifest is not consulted for Leads in scope mode.
    expect(activeManifestIds.mock.calls.map((c) => c[0])).toEqual(['deal']);
    expect(store.record).toHaveBeenCalledWith(new Date(NOW).toISOString(), true);
  });

  it('later runs list from the Lead watermark minus the overlap, never before the sync date', async () => {
    store.read.mockResolvedValue('2026-10-08T09:30:00Z');
    await run(baseConfig({ leadIntakeMode: 'scope' }));
    const since = new Date(Date.parse('2026-10-08T09:30:00Z') - WATERMARK_OVERLAP_SECONDS * 1000).toISOString();
    expect(listLeads.mock.calls[0]![0].filter).toEqual({ '>=DATE_CREATE': CUTOFF, '>DATE_MODIFY': since });
    store.read.mockResolvedValue('2026-09-01T00:00:00Z');
    await run(baseConfig({ leadIntakeMode: 'scope' }));
    expect(listLeads.mock.calls[1]![0].filter['>DATE_MODIFY']).toBe(new Date(Date.parse(CUTOFF)).toISOString());
  });

  it('a Lead created before the sync date is never enqueued (local check)', async () => {
    listLeads.mockResolvedValueOnce(page([lead(503, '2026-10-03T10:00:00+05:30', '2026-09-20T10:00:00+05:30')]));
    const summary = await run(baseConfig({ leadIntakeMode: 'scope' }));
    expect(fnCalls('integration_enqueue_reconcile_lead')).toEqual([]);
    expect(summary.notTracked).toBe(1);
  });

  it('a page cap continues next run from the last Lead listed', async () => {
    listLeads.mockResolvedValueOnce(page([lead(504, '2026-10-05T10:00:00+05:30')], 50));
    const summary = await run(baseConfig({ leadIntakeMode: 'scope' }), { maxPages: 1 });
    expect(summary.leadScope.truncated).toBe(true);
    expect(summary.truncated).toBe(true);
    expect(store.record).toHaveBeenCalledWith(new Date(Date.parse('2026-10-05T10:00:00+05:30')).toISOString(), true);
  });

  it('without a readable Lead watermark the pass is skipped, never a full re-list', async () => {
    store.read.mockRejectedValue(new Error('column missing'));
    const summary = await run(baseConfig({ leadIntakeMode: 'scope' }));
    expect(listLeads).not.toHaveBeenCalled();
    expect(summary.leadScope).toMatchObject({ scoped: true, unavailable: true });
    const noStore = await run(baseConfig({ leadIntakeMode: 'scope' }), { leadWatermark: undefined });
    expect(noStore.leadScope.unavailable).toBe(true);
    expect(listLeads).not.toHaveBeenCalled();
  });

  it('a Lead listing failure is contained: the Deal pass completed, the Lead watermark stays', async () => {
    listLeads.mockRejectedValue(new BitrixClientError('provider_unavailable', 503));
    const summary = await run(baseConfig({ leadIntakeMode: 'scope', dealIntakeMode: 'scope' }));
    expect(summary.leadScope.error).toBe('provider_unavailable');
    expect(summary.truncated).toBe(true);
    expect(fnCalls('integration_record_reconcile_run')).toEqual([
      { p_member_id: MEMBER, p_started_at: new Date(NOW).toISOString(), p_ok: true },
    ]);
    expect(store.record).toHaveBeenCalledWith(new Date(NOW).toISOString(), false);
  });

  it('manifest mode is unchanged: the active Lead manifest is used, no scope listing', async () => {
    listLeads.mockResolvedValueOnce(page([{ ID: '501', DATE_MODIFY: '2026-10-03T10:00:00+05:30' }]));
    const summary = await run(baseConfig());
    expect(listLeads.mock.calls[0]![0]).toEqual({ filter: { '@ID': ['501'] }, select: ['ID', 'DATE_MODIFY'], start: 0 });
    expect(summary.leadScope.scoped).toBe(false);
    expect(store.read).not.toHaveBeenCalled();
  });
});

describe('Deal scope mode (M1)', () => {
  it('skips the Deal manifest and runs the portal-wide update pass', async () => {
    listDeals.mockResolvedValueOnce(
      page([{ ID: '9411', DATE_MODIFY: '2026-10-08T09:10:00Z', DATE_CREATE: '2026-10-02T10:00:00+05:30', STAGE_ID: 'C7:NEW', CATEGORY_ID: '7' }]),
    );
    const summary = await run(baseConfig({ dealIntakeMode: 'scope' }));
    expect(activeManifestIds.mock.calls.map((c) => c[0])).toEqual(['lead']);
    expect(listDeals.mock.calls[0]![0].filter).toHaveProperty('>DATE_MODIFY');
    expect(listDeals.mock.calls[0]![0].filter).not.toHaveProperty('@ID');
    expect(fnCalls('integration_enqueue_reconcile')).toEqual([
      { p_member_id: MEMBER, p_deal_id: 9411, p_source_modified: Date.parse('2026-10-08T09:10:00Z') / 1000 },
    ]);
    expect(summary.manifest.deal.scoped).toBe(false);
    expect(fnCalls('integration_record_reconcile_run')).toHaveLength(1);
  });

  it('manifest mode keeps the manifest pass and leaves the Deal watermark alone', async () => {
    listDeals.mockResolvedValueOnce(page([{ ID: '9001', DATE_MODIFY: '2026-10-08T09:10:00Z' }]));
    const summary = await run(baseConfig());
    expect(listDeals.mock.calls[0]![0].filter).toEqual({ '@ID': ['9001'] });
    expect(summary.manifest.deal.scoped).toBe(true);
    expect(fnCalls('integration_record_reconcile_run')).toEqual([]);
  });
});

describe('run triggers (I6)', () => {
  it('maps the endpoint call to the recorded trigger', () => {
    expect(runTriggerFor('cron', 'batch')).toBe('cron');
    expect(runTriggerFor('cron', 'sync')).toBe('cron');
    expect(runTriggerFor('manual', 'sync')).toBe('cron');
    expect(runTriggerFor('manual', 'batch')).toBe('manual');
    expect(runTriggerFor('manual', 'reconcile')).toBe('manual');
  });

  it('a sync run records its trigger on the reconcile and worker heartbeats', async () => {
    await runBitrixSync({
      rpc: asRpcClient({
        rpc: async (fn: string, args?: Record<string, unknown>) => {
          calls.push({ fn, args });
          return { data: fn === 'integration_claim_inbox' ? [] : null, error: null };
        },
      }),
      bitrix: { listDeals, listLeads, getDeal: vi.fn(), getLead: vi.fn() } as never,
      config: baseConfig(),
      trigger: 'cron',
      now: () => NOW,
    });
    const runs = fnCalls('integration_record_worker_run').map((a) => a!.p_run as Record<string, unknown>);
    expect(runs.map((r) => [r.kind, r.trigger])).toEqual([
      ['reconcile', 'cron'],
      ['worker', 'cron'],
    ]);
  });
});

describe('alert check after failed answers (M2)', () => {
  const deps = (over: Partial<WorkerEndpointDeps> = {}): WorkerEndpointDeps => ({
    env: { bitrixWebhookBaseUrl: null, bitrixEventApplicationToken: null, intakeWorkerSecret: SECRET, cronSecret: null },
    appEnv: 'local',
    vercelEnv: undefined,
    loadConfigRows: async () => [
      {
        portal_domain: 'synthetic.bitrix24.example',
        portal_member_id: MEMBER,
        category_id: '7',
        eligible_stage_ids: ['C7:NEW'],
        cutoff_at: CUTOFF,
        enabled: true,
      },
    ],
    rpc,
    alerts: { env: {}, log: () => undefined },
    ...over,
  });
  const post = (query = '') =>
    new Request(`https://crm.example.test/api/integrations/bitrix/worker${query}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}` },
    });

  it.each([
    ['configuration unreadable', { loadConfigRows: async () => Promise.reject(new Error('down')) }],
    ['no enabled configuration', { loadConfigRows: async () => [] }],
    ['Bitrix REST URL missing (BitrixConfigError)', {}],
  ] as const)('%s: 503 and the alert check still runs', async (_label, over) => {
    const res = await handleWorkerRequest(post(), deps(over as Partial<WorkerEndpointDeps>));
    expect(res.status).toBe(503);
    expect(calls.map((c) => c.fn)).toEqual(['integration_sync_alert_check']);
  });

  it('before authentication or on a refused environment, nothing runs', async () => {
    const bad = new Request('https://crm.example.test/api/integrations/bitrix/worker', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong' },
    });
    expect((await handleWorkerRequest(bad, deps())).status).toBe(401);
    expect((await handleWorkerRequest(post(), deps({ appEnv: 'staging', vercelEnv: 'preview' }))).status).toBe(503);
    expect(calls).toEqual([]);
  });
});
