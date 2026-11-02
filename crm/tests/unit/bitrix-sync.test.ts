import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BitrixClientError, createBitrixClient } from '@/modules/integration/bitrix/client';
import { resolveBitrixRestTarget } from '@/modules/integration/bitrix/config';
import { RESYNC_MAX_PAGES_PER_RUN } from '@/modules/integration/bitrix/resync';
import { runBitrixSync, type SyncDeps } from '@/modules/integration/bitrix/sync';
import { handleWorkerRequest, type WorkerEndpointDeps } from '@/modules/integration/bitrix/worker-endpoint';
import { asRpcClient } from '@/modules/integration/commands';
import type { IntakeConfig } from '@/modules/integration/intake-config';
import { FakeIntakeDb, startMockBitrix, syntheticDeal, type MockBitrix } from '../helpers/mock-bitrix';

/**
 * runBitrixSync (scheduler / ?task=sync / admin "Sync now") against the
 * in-process mock Bitrix and the fake command layer. Synthetic test data only;
 * the real SQL semantics are covered by the db/supabase suites.
 */

const PORTAL = 'synthetic.bitrix24.example';
const SECRET = 'synthetic-worker-secret-0123456789abcdef';
let mock: MockBitrix;
let db: FakeIntakeDb;
const sleep = vi.fn(async () => undefined);

const config = (): IntakeConfig => ({
  portalDomain: PORTAL,
  portalMemberId: db.config.memberId,
  categoryId: '7',
  categoryIds: ['7'],
  eligibleStageIds: ['C7:WON'],
  cutoffAt: '2026-10-01T00:00:00+05:30',
  pilotLegalEntityId: null,
  pilotBranchId: null,
  enabled: true,
  lastReconciledAt: db.config.lastReconciledAt,
});
const client = () => createBitrixClient({ target: resolveBitrixRestTarget(mock.baseUrl, PORTAL, 'local'), sleep });
const rpc = () => asRpcClient({ rpc: db.rpc });
const held = async (ids: number[]) => new Set(ids.filter((id) => db.deals.has(String(id))));
const sync = (over: Partial<SyncDeps> = {}) =>
  runBitrixSync({ rpc: rpc(), bitrix: client(), config: config(), heldDealIds: held, now: () => db.now, ...over });
const calls = (method: string) => mock.requests.filter((r) => r.method === method).length;

beforeAll(async () => {
  mock = await startMockBitrix();
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => {
  mock.deals.clear();
  mock.requests.length = 0;
  mock.pageSize = 50;
  db = new FakeIntakeDb();
  db.maxAttempts = 8;
  sleep.mockClear();
});

describe('runBitrixSync', () => {
  it('first run: the daily full resync lists every eligible deal, stores it and records Bitrix = CRM', async () => {
    for (let i = 1; i <= 5; i += 1) mock.deals.set(String(i), syntheticDeal(i));
    mock.deals.set('9', syntheticDeal(9, { STAGE_ID: 'C7:NEW' })); // not an entry stage

    const s = await sync();
    expect(s).toMatchObject({ reconcileError: null, budgetReached: false, outcome: 'ok' });
    expect(s.worker).toMatchObject({ claimed: 5, created: 5 });
    // Resync page, update pass, one list for the whole worker batch; no per-deal reads.
    expect(calls('crm.deal.list')).toBe(3);
    expect(calls('crm.deal.get')).toBe(0);
    // The resync lists with exactly the configured filter: creation date, ID cursor.
    expect(mock.requests.find((r) => r.method === 'crm.deal.list')!.body).toMatchObject({
      filter: { '@CATEGORY_ID': ['7'], '@STAGE_ID': ['C7:WON'], '>=DATE_CREATE': '2026-10-01T00:00:00+05:30', '>ID': 0 },
      order: { ID: 'ASC' },
    });
    expect(db.deals.size).toBe(5);
    expect(s.resync).toMatchObject({ bitrixTotal: 5, listingDone: true, result: { bitrix: 5, crm: 5, inSync: true } });
    expect(db.config.lastReconciledAt).toBe(new Date(db.now).toISOString());
    expect(db.workerRuns.map((r) => r.kind)).toEqual(['reconcile', 'worker']);
  });

  it('no-change poll costs one crm.deal.list call and no crm.deal.get', async () => {
    for (let i = 1; i <= 3; i += 1) mock.deals.set(String(i), syntheticDeal(i));
    await sync();
    mock.requests.length = 0;

    db.now += 30_000; // next scheduled run: the daily resync is done, only the update pass
    const s = await sync();
    expect(s.resync).toBeNull();
    expect(calls('crm.deal.list')).toBe(1);
    expect(calls('crm.deal.get')).toBe(0);
    expect(s.worker.claimed).toBe(0);
    expect(s.outcome).toBe('ok');
  });

  it('a change in Bitrix is picked up by the next run (update pass)', async () => {
    mock.deals.set('1', syntheticDeal(1));
    await sync();
    db.now += 30_000;
    mock.deals.set('1', syntheticDeal(1, { TITLE: 'Renamed trip', STAGE_ID: 'C7:LOSE', DATE_MODIFY: new Date(db.now - 5_000).toISOString() }));
    mock.deals.set('2', syntheticDeal(2, { DATE_CREATE: new Date(db.now - 5_000).toISOString(), DATE_MODIFY: new Date(db.now - 5_000).toISOString() }));

    const s = await sync();
    expect(s.resync).toBeNull();
    expect(s.worker).toMatchObject({ created: 1, updated: 1 });
    expect(db.deals.get('1')).toMatchObject({ title: 'Renamed trip', stageId: 'C7:LOSE' });
    expect(db.deals.has('2')).toBe(true);
  });

  it('the full resync is queued again once 24 hours have passed (daily safety net)', async () => {
    mock.deals.set('1', syntheticDeal(1));
    await sync();
    db.now += 23 * 3_600_000;
    expect((await sync()).resync).toBeNull();
    db.now += 2 * 3_600_000;
    const s = await sync();
    expect(s.resync).toMatchObject({ result: { bitrix: 1, crm: 1, inSync: true } });
    expect(db.resyncJobs.map((j) => [j.reason, j.status])).toEqual([
      ['daily', 'done'],
      ['daily', 'done'],
    ]);
  });

  it('the update pass pages through a bulk edit (many deals with the same DATE_MODIFY) without truncating', async () => {
    db.autoDailyResync = false;
    mock.pageSize = 2;
    for (let i = 1; i <= 50; i += 1) mock.deals.set(String(i), syntheticDeal(i)); // 25 pages, one second
    const s = await sync();
    expect(s.reconcile).toMatchObject({ truncated: false, enqueued: 50, scanned: 50 });
    expect(db.config.lastReconciledAt).not.toBeNull();
  });

  it('a resync continues across runs by ID cursor until complete (no truncation, no restart)', async () => {
    mock.pageSize = 2;
    const n = RESYNC_MAX_PAGES_PER_RUN * 2 + 10; // more than one run can list
    for (let i = 1; i <= n; i += 1) mock.deals.set(String(i), syntheticDeal(i));
    const first = await sync({ budgetMs: 600_000 });
    expect(first.resync).toMatchObject({ scanned: RESYNC_MAX_PAGES_PER_RUN * 2, bitrixTotal: n, listingDone: false, result: null });
    expect(first.outcome).toBe('partial');
    expect(db.resyncJobs[0]!.cursor).toBe(RESYNC_MAX_PAGES_PER_RUN * 2);

    db.now += 30_000;
    mock.requests.length = 0;
    const second = await sync({ budgetMs: 600_000 });
    // Continued from the cursor: the first resync request of this run starts after the last listed ID.
    expect(mock.requests.find((r) => r.method === 'crm.deal.list')!.body).toMatchObject({
      filter: { '>ID': RESYNC_MAX_PAGES_PER_RUN * 2 },
    });
    expect(second.resync).toMatchObject({ scanned: n, listingDone: true, result: { bitrix: n, crm: n, inSync: true } });
    expect(db.deals.size).toBe(n);
  });

  it('the resync count check reports deals kept after a stage move, and re-reads deals Bitrix no longer lists', async () => {
    for (let i = 1; i <= 3; i += 1) mock.deals.set(String(i), syntheticDeal(i));
    await sync();
    // Deal 1 moves to a stage that is not ticked (kept: stages decide entry only);
    // deal 2 moves to another pipeline (removed); deal 3 is deleted in Bitrix.
    const later = new Date(db.now + 60_000).toISOString();
    mock.deals.set('1', syntheticDeal(1, { STAGE_ID: 'C7:LOSE', DATE_MODIFY: later }));
    mock.deals.set('2', syntheticDeal(2, { CATEGORY_ID: '9', STAGE_ID: 'C9:NEW', DATE_MODIFY: later }));
    mock.deals.delete('3');
    db.now += 25 * 3_600_000;
    const s = await sync();
    expect(db.deals.get('1')).toMatchObject({ stageId: 'C7:LOSE', removed: null });
    expect(db.deals.get('2')!.removed).toBe('pipeline_not_eligible');
    expect(s.resync!.result).toMatchObject({ bitrix: 0, crm: 2, keptAfterStageMove: 1, extra: 1, inSync: false });
    // Deal 3 was read again and went to "needs attention".
    db.now += 30_000;
    await sync();
    expect(db.inbox.filter((r) => r.dealId === '3').map((r) => r.reasonCode)).toContain('source_deal_not_found');
  });

  it('two overlapping runs share one resync job safely and import every deal once', async () => {
    for (let i = 1; i <= 8; i += 1) mock.deals.set(String(i), syntheticDeal(i));
    await Promise.all([sync({ batchLimit: 3 }), sync({ batchLimit: 3 })]);
    db.now += 30_000;
    await sync();
    expect(db.deals.size).toBe(8);
    expect(db.resyncJobs).toHaveLength(1);
    expect(db.resyncJobs[0]).toMatchObject({ status: 'done', result: { bitrix: 8, crm: 8, inSync: true } });
    // Idempotent: running again changes nothing.
    db.now += 30_000;
    const again = await sync();
    expect(again.worker.claimed).toBe(0);
    expect(db.deals.size).toBe(8);
  });

  it('a deal the batch list does not return falls back to crm.deal.get (deleted -> needs review)', async () => {
    mock.deals.set('1', syntheticDeal(1));
    mock.deals.set('2', syntheticDeal(2));
    db.enqueueEvent(3, 1); // not in Bitrix
    const s = await sync();
    expect(s.worker).toMatchObject({ claimed: 3, created: 2, needsReview: 1 });
    expect(calls('crm.deal.get')).toBe(1);
    expect(mock.requests.find((r) => r.method === 'crm.deal.get')!.body).toEqual({ id: '3' });
  });

  it('respects the time budget and releases leased rows it could not process', async () => {
    for (let i = 1; i <= 10; i += 1) mock.deals.set(String(i), syntheticDeal(i));
    const real = client();
    // Each batch read "takes" 5 s of the 12 s budget.
    const slow = {
      getDeal: real.getDeal,
      getLead: real.getLead,
      listLeads: real.listLeads,
      listDeals: async (p: Parameters<typeof real.listDeals>[0]) => {
        if (p.filter['@ID']) db.now += 5_000;
        return real.listDeals(p);
      },
    };
    const s = await sync({ bitrix: slow, budgetMs: 12_000, batchLimit: 2 });
    expect(s.budgetReached).toBe(true);
    expect(s.outcome).toBe('partial');
    expect(s.worker.created).toBeLessThan(10);
    expect(s.released).toBeGreaterThan(0);
    // Released rows went back to pending without using an attempt; nothing is lost.
    const pending = db.inbox.filter((r) => r.status === 'pending');
    expect(pending.length).toBe(10 - s.worker.created);
    expect(pending.every((r) => r.attempts === 0)).toBe(true);

    // The next run finishes the backlog.
    db.now += 30_000;
    const next = await sync();
    expect(db.deals.size).toBe(10);
    expect(next.outcome).toBe('ok');
  });

  it('two overlapping runs never process the same row twice', async () => {
    db.autoDailyResync = false;
    for (let i = 1; i <= 8; i += 1) mock.deals.set(String(i), syntheticDeal(i));
    const [a, b] = await Promise.all([sync({ batchLimit: 3 }), sync({ batchLimit: 3 })]);
    expect(db.deals.size).toBe(8);
    expect(a.worker.created + b.worker.created).toBe(8);
    expect(a.worker.claimed + b.worker.claimed).toBe(8);
    expect(db.inbox.filter((r) => r.status === 'processed')).toHaveLength(8);
  });

  it('a Bitrix outage leaves queued rows untouched (no attempts used) and reports provider_error', async () => {
    db.enqueueEvent(41, 1);
    db.enqueueEvent(42, 1);
    mock.failNext('crm.deal.list', { status: 503, body: { error: 'INTERNAL_SERVER_ERROR', error_description: 'down' } });

    const s = await sync();
    expect(s).toMatchObject({ reconcileError: 'provider_unavailable', outcome: 'provider_error', batches: 0 });
    expect(calls('crm.deal.get')).toBe(0);
    expect(db.inbox.map((r) => [r.status, r.attempts])).toEqual([
      ['pending', 0],
      ['pending', 0],
    ]);
    // Failed at the first read (resync listing): watermark not advanced, the job's lease released.
    expect(db.config.lastReconciledAt).toBeNull();
    expect(db.resyncJobs[0]).toMatchObject({ status: 'running', lockToken: null, cursor: 0 });

    // Bitrix back: the next run processes them.
    mock.deals.set('41', syntheticDeal(41));
    mock.deals.set('42', syntheticDeal(42));
    const next = await sync();
    expect(next.worker.created).toBe(2);
  });

  it('a rate limit during the drain stops the run; the rest stays queued', async () => {
    for (let i = 1; i <= 4; i += 1) mock.deals.set(String(i), syntheticDeal(i));
    const busy = { status: 503, body: { error: 'QUERY_LIMIT_EXCEEDED', error_description: 'Too many requests' } };
    for (let i = 0; i < 4; i += 1) mock.failNext('crm.deal.get', busy); // first try + 3 back-off retries
    const real = client();
    // The batch list is rate limited too, so the worker falls back to crm.deal.get.
    const limited = {
      getDeal: real.getDeal,
      getLead: real.getLead,
      listLeads: real.listLeads,
      listDeals: async (p: Parameters<typeof real.listDeals>[0]) => {
        if (p.filter['@ID']) throw new BitrixClientError('provider_rate_limited', 503, 'QUERY_LIMIT_EXCEEDED');
        return real.listDeals(p);
      },
    };
    const s = await sync({ bitrix: limited, batchLimit: 25 });
    expect(s.batches).toBe(1);
    expect(s.outcome).toBe('partial');
    expect(db.inbox.filter((r) => r.status === 'pending').length).toBe(3);
    expect(db.inbox.filter((r) => r.status === 'failed').length).toBe(1);
  });
});

describe('POST /api/integrations/bitrix/worker?task=sync', () => {
  const rowFor = () => ({
    portal_domain: PORTAL,
    portal_member_id: db.config.memberId,
    category_id: '7',
    eligible_stage_ids: ['C7:WON'],
    cutoff_at: '2026-10-01T00:00:00+05:30',
    enabled: true,
    last_reconciled_at: db.config.lastReconciledAt,
  });
  const deps = (over: Partial<WorkerEndpointDeps> = {}): WorkerEndpointDeps => ({
    env: { bitrixWebhookBaseUrl: mock.baseUrl, bitrixEventApplicationToken: null, intakeWorkerSecret: SECRET, cronSecret: null },
    appEnv: 'local',
    loadConfigRows: async () => [rowFor()],
    rpc,
    heldDealIds: async (_member, ids) => held(ids),
    now: () => db.now,
    ...over,
  });
  const req = (auth?: string) =>
    new Request('https://crm.example.test/api/integrations/bitrix/worker?task=sync', {
      method: 'POST',
      headers: auth ? { authorization: auth } : {},
    });

  it('401 without, or with a wrong, bearer secret; nothing is read or written', async () => {
    const loadConfigRows = vi.fn(async () => [rowFor()]);
    for (const auth of [undefined, 'Bearer wrong-secret', `Basic ${SECRET}`, `Bearer ${SECRET}x`]) {
      const res = await handleWorkerRequest(req(auth), deps({ loadConfigRows }));
      expect(res.status).toBe(401);
    }
    expect(loadConfigRows).not.toHaveBeenCalled();
    expect(db.calls).toHaveLength(0);
    expect(mock.requests).toHaveLength(0);
  });

  it('200 with the bearer secret: runs the sync and returns counts only', async () => {
    mock.deals.set('7', syntheticDeal(7));
    const res = await handleWorkerRequest(req(`Bearer ${SECRET}`), deps());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ reconcileError: null, worker: { created: 1 }, resync: { result: { inSync: true } } });
    expect(JSON.stringify(body)).not.toContain('Synthetic trip');
    expect(JSON.stringify(body)).not.toContain(mock.webhookCode);
  });

  it('503 with the provider code when Bitrix cannot be read', async () => {
    mock.failNext('crm.deal.list', { status: 401, body: { error: 'NO_AUTH_FOUND', error_description: 'x' } });
    const res = await handleWorkerRequest(req(`Bearer ${SECRET}`), deps());
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ reconcileError: 'provider_auth_failed' });
  });
});
