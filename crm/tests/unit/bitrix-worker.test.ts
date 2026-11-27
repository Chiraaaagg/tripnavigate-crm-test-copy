import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBitrixClient } from '@/modules/integration/bitrix/client';
import { resolveBitrixRestTarget } from '@/modules/integration/bitrix/config';
import { reconcileEligibleDeals } from '@/modules/integration/bitrix/reconcile';
import type { SyncSummary } from '@/modules/integration/bitrix/sync';
import {
  EVENT_DRAIN_BUDGET_MS,
  handleWorkerRequest,
  runTriggerFor,
  syncFollowupKind,
  type IdProofCopyResult,
  type WorkerEndpointDeps,
} from '@/modules/integration/bitrix/worker-endpoint';
import { clampLimit, emptySummary, processInboxBatch, WORKER_LEASE_SECONDS } from '@/modules/integration/bitrix/worker';
import { asRpcClient, claimInbox } from '@/modules/integration/commands';
import type { IntakeConfig } from '@/modules/integration/intake-config';
import { FakeIntakeDb, startMockBitrix, syntheticDeal, type MockBitrix } from '../helpers/mock-bitrix';

/**
 * Worker / reconcile at client+command level against the in-process mock Bitrix
 * and a FAKE command layer (agent B tests the real SQL semantics):
 * P2-04 ordering, P2-06 crash/lease, P2-07 outage/back-off/dead letter,
 * P2-11 reconcile, P2-12 endpoint/host rules, P2-13 no secrets.
 */

const PORTAL = 'synthetic.bitrix24.example';
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

// Generous timeout: a loaded machine must not turn a normal mock answer into a
// provider_timeout (that was the source of an intermittent failure). Only the
// explicit 'hang' test uses a short timeout.
const bitrix = (timeoutMs = 10_000) =>
  createBitrixClient({ target: resolveBitrixRestTarget(mock.baseUrl, PORTAL, 'local'), sleep, timeoutMs });
const rpc = () => asRpcClient({ rpc: db.rpc });
const run = (limit = 10, timeoutMs?: number) =>
  processInboxBatch({ rpc: rpc(), bitrix: bitrix(timeoutMs), config: config(), limit, now: () => db.now });
const reconcile = (over: Partial<Parameters<typeof reconcileEligibleDeals>[0]> = {}) =>
  reconcileEligibleDeals({ rpc: rpc(), bitrix: bitrix(), config: config(), now: () => db.now, ...over });

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
  sleep.mockClear();
});

describe('processInboxBatch', () => {
  it('creates a deal from the CURRENT Bitrix state, with only Bitrix-owned fields', async () => {
    mock.deals.set('662', syntheticDeal(662));
    db.enqueueEvent(662, 1_000, 'ONCRMDEALADD');
    const summary = await run();
    expect(summary).toEqual({ claimed: 1, created: 1, updated: 0, ignored: 0, needsReview: 0, failed: 0, deadLettered: 0 });
    const apply = db.calls.find((c) => c.fn === 'integration_apply_bitrix_deal')!;
    expect(Object.keys(apply.args.p_deal as object).sort()).toEqual(
      ['assignedById', 'categoryId', 'dateCreate', 'dateModify', 'id', 'leadId', 'sourceId', 'stageId', 'title'].sort(),
    );
    expect(JSON.stringify(apply.args)).not.toContain('99999'); // OPPORTUNITY never imported
    expect(db.inbox[0]!.status).toBe('processed');
  });

  it('P2-03/P2-05: duplicate and repeated work produce one deal', async () => {
    mock.deals.set('5', syntheticDeal(5));
    db.enqueueEvent(5, 10, 'ONCRMDEALADD');
    db.enqueueEvent(5, 10, 'ONCRMDEALADD'); // duplicate delivery
    db.enqueueEvent(5, 11); // later notification coalesces into the pending row (L6)
    const summary = await run();
    expect(db.inbox).toHaveLength(1);
    expect(summary.created).toBe(1);
    expect(db.deals.size).toBe(1);
  });

  it('P2-04: a delayed older event never overwrites newer state', async () => {
    mock.deals.set('9', syntheticDeal(9, { TITLE: 'v2', DATE_MODIFY: '2026-10-05T12:00:00+05:30' }));
    db.enqueueEvent(9, 200); // newer notification processed first
    await run();
    expect(db.deals.get('9')!.title).toBe('v2');
    // Bitrix still returns v2; the older notification arrives late -> stale.
    db.enqueueEvent(9, 100);
    const late = await run();
    expect(late.ignored).toBe(1);
    expect(db.deals.get('9')).toMatchObject({ title: 'v2', modifiedAt: '2026-10-05T12:00:00+05:30' });
    // A genuinely newer modification is applied.
    mock.deals.set('9', syntheticDeal(9, { TITLE: 'v3', DATE_MODIFY: '2026-10-05T13:00:00+05:30' }));
    db.enqueueEvent(9, 300);
    expect((await run()).updated).toBe(1);
    expect(db.deals.get('9')!.title).toBe('v3');
  });

  it('P2-06: crash after claim -> lease expires -> processed exactly once', async () => {
    mock.deals.set('11', syntheticDeal(11));
    db.enqueueEvent(11, 1);
    const crashed = await claimInbox(rpc(), 10, WORKER_LEASE_SECONDS); // worker dies here
    expect(crashed).toHaveLength(1);
    expect((await run()).claimed).toBe(0); // still leased
    db.now += (WORKER_LEASE_SECONDS + 1) * 1000;
    const recovered = await run();
    expect(recovered).toMatchObject({ claimed: 1, created: 1 });
    expect((await run()).claimed).toBe(0);
    expect(db.deals.size).toBe(1);
    // The crashed worker's stale lock token can no longer write.
    const stale = await db.rpc('integration_apply_bitrix_deal', {
      p_inbox_id: crashed[0]!.inboxId,
      p_lock_token: crashed[0]!.lockToken,
      p_deal: {},
    });
    expect(stale.error).not.toBeNull();
  });

  it('P2-07: outage -> retryable failure with back-off -> dead letter after max attempts', async () => {
    mock.deals.set('12', syntheticDeal(12));
    db.enqueueEvent(12, 1);
    const outcomes = [];
    for (let attempt = 1; attempt <= db.maxAttempts; attempt += 1) {
      mock.failNext('crm.deal.get', { status: 500, body: { error: 'INTERNAL_SERVER_ERROR', error_description: 'x' } });
      outcomes.push(await run());
      const row = db.inbox[0]!;
      if (attempt < db.maxAttempts) {
        expect(row.status).toBe('failed');
        expect(row.lastErrorCode).toBe('provider_unavailable');
        expect((await run()).claimed).toBe(0); // not due yet (back-off)
        db.now = row.nextAttemptAt;
      }
    }
    expect(outcomes.map((o) => o.failed)).toEqual([1, 1, 0]);
    expect(outcomes.at(-1)!.deadLettered).toBe(1);
    expect(db.inbox[0]!.status).toBe('dead_letter');
    const fails = db.calls.filter((c) => c.fn === 'integration_fail_inbox');
    expect(fails.every((c) => c.args.p_retryable === true && c.args.p_error_code === 'provider_unavailable')).toBe(true);
    expect(db.deals.size).toBe(0);
  });

  it('P2-07: timeout is retryable; auth failure is not retried automatically', async () => {
    mock.deals.set('13', syntheticDeal(13));
    mock.deals.set('14', syntheticDeal(14));
    db.enqueueEvent(13, 1);
    db.enqueueEvent(14, 1);
    mock.failNext('crm.deal.get', 'hang');
    mock.failNext('crm.deal.get', { status: 401, body: { error: 'INVALID_CREDENTIALS', error_description: 'x' } });
    await run(10, 200);
    const fails = db.calls.filter((c) => c.fn === 'integration_fail_inbox').map((c) => [c.args.p_error_code, c.args.p_retryable]);
    expect(fails).toEqual([
      ['provider_timeout', true],
      ['provider_auth_failed', false],
    ]);
  });

  it('L1: after a rate limit the rest of the batch is released (no attempt consumed) without calling Bitrix', async () => {
    for (const id of [21, 22, 23]) {
      mock.deals.set(String(id), syntheticDeal(id));
      db.enqueueEvent(id, 1);
    }
    for (let i = 0; i < 4; i += 1) {
      mock.failNext('crm.deal.get', { status: 503, body: { error: 'QUERY_LIMIT_EXCEEDED', error_description: 'x' } });
    }
    const summary = await run();
    expect(summary.failed).toBe(1);
    expect(mock.requests.filter((r) => r.method === 'crm.deal.get')).toHaveLength(4); // 1 + 3 retries, then stop
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(db.calls.filter((c) => c.fn === 'integration_release_inbox')).toHaveLength(2);
    const [first, ...rest] = db.inbox;
    expect(first).toMatchObject({ status: 'failed', lastErrorCode: 'provider_rate_limited', attempts: 1 });
    for (const row of rest) expect(row).toMatchObject({ status: 'pending', attempts: 0, lockToken: null });
  });

  it('deleted Bitrix deal -> source_deal_not_found (needs review), no deal', async () => {
    db.enqueueEvent(404, 1);
    const summary = await run();
    expect(summary.needsReview).toBe(1);
    expect(db.calls.find((c) => c.fn === 'integration_apply_bitrix_deal')!.args.p_deal).toBeNull();
    expect(db.calls.some((c) => c.fn === 'integration_fail_inbox')).toBe(false);
    expect(db.inbox[0]).toMatchObject({ status: 'needs_review', reasonCode: 'source_deal_not_found' });
  });

  it('ineligible/unmapped deals are reported, not created (DB decides)', async () => {
    mock.deals.set('31', syntheticDeal(31, { CATEGORY_ID: '0' }));
    mock.deals.set('32', syntheticDeal(32, { ASSIGNED_BY_ID: '999' }));
    db.enqueueEvent(31, 1);
    db.enqueueEvent(32, 1);
    expect(await run()).toMatchObject({ ignored: 1, needsReview: 1, created: 0 });
  });

  it('provider answering a different deal ID is treated as a bad response', async () => {
    mock.deals.set('41', syntheticDeal(42));
    db.enqueueEvent(41, 1);
    await run();
    expect(db.calls.find((c) => c.fn === 'integration_fail_inbox')!.args.p_error_code).toBe('provider_bad_response');
  });

  it('P2-12: a row from another portal is never fetched with this credential', async () => {
    db.enqueueEvent(51, 1);
    db.inbox[0]!.memberId = 'other-portal';
    await run();
    expect(mock.requests).toHaveLength(0);
    expect(db.inbox[0]!.status).toBe('dead_letter');
  });

  it('bounded batch size and deadline', async () => {
    expect(clampLimit('1000')).toBe(25);
    expect(clampLimit('abc')).toBe(10);
    expect(clampLimit(0)).toBe(10);
    for (let i = 60; i < 63; i += 1) {
      mock.deals.set(String(i), syntheticDeal(i));
      db.enqueueEvent(i, 1);
    }
    // Deterministic clock: deadline reached after the first item.
    const times = [db.now, db.now, db.now + 5];
    const summary = await processInboxBatch({
      rpc: rpc(),
      bitrix: bitrix(),
      config: config(),
      deadlineMs: 1,
      now: () => times.shift() ?? db.now + 10,
    });
    expect(summary).toMatchObject({ claimed: 3, created: 1, failed: 0 });
    // L1: unprocessed leases go back to pending without consuming an attempt.
    expect(db.inbox.filter((r) => r.status === 'pending')).toHaveLength(2);
    expect(db.inbox.filter((r) => r.status === 'pending').every((r) => r.attempts === 0)).toBe(true);
    expect((await run()).created).toBe(2);
  });
});

describe('reconcileEligibleDeals (P2-11)', () => {
  it('update pass: every pipeline since the watermark, enqueues deals passing the creation-date entry rule', async () => {
    mock.pageSize = 5;
    for (let i = 1; i <= 12; i += 1) mock.deals.set(String(i), syntheticDeal(i));
    mock.deals.set('100', syntheticDeal(100, { CATEGORY_ID: '0' }));
    mock.deals.set('101', syntheticDeal(101, { STAGE_ID: 'C7:NEW' }));
    // Created before the sync date, modified after: NOT eligible (the sync date is the creation date).
    mock.deals.set('102', syntheticDeal(102, { DATE_CREATE: '2026-09-01T00:00:00+05:30', DATE_MODIFY: '2026-10-02T00:00:00+05:30' }));

    const first = await reconcile();
    expect(first).toMatchObject({ enqueued: 12, alreadyQueued: 0, alreadyCurrent: 0, notTracked: 3, truncated: false });
    const listCalls = mock.requests.filter((r) => r.method === 'crm.deal.list');
    // No pipeline or stage filter (moves out of a pipeline must be seen); keyset order on DATE_MODIFY.
    expect(listCalls[0]!.body).toMatchObject({
      filter: { '>DATE_MODIFY': '2026-10-01T00:00:00+05:30' },
      select: ['ID', 'DATE_MODIFY', 'DATE_CREATE', 'STAGE_ID', 'CATEGORY_ID'],
      order: { DATE_MODIFY: 'ASC', ID: 'ASC' },
      start: 0,
    });
    // Complete run -> watermark advanced to the run start.
    expect(db.config.lastReconciledAt).toBe(new Date(db.now).toISOString());

    await run(25);
    expect(db.deals.size).toBe(12);
    expect(db.deals.has('102')).toBe(false);
  });

  it('stopped at maxPages: the watermark moves to the last change listed and the next run continues there', async () => {
    mock.pageSize = 2;
    for (let i = 1; i <= 7; i += 1) {
      mock.deals.set(String(i), syntheticDeal(i, { DATE_MODIFY: `2026-10-05T10:0${i}:00+05:30` }));
    }
    const s = await reconcile({ maxPages: 2 });
    expect(s).toMatchObject({ truncated: true, enqueued: 4 });
    // Not a silent stop: progress is kept (Bitrix time of the 4th change).
    expect(db.config.lastReconciledAt).toBe(new Date('2026-10-05T10:04:00+05:30').toISOString());
    const next = await reconcile({ maxPages: 10 });
    expect(next).toMatchObject({ truncated: false });
    expect(db.inbox.map((r) => r.dealId).sort()).toEqual(['1', '2', '3', '4', '5', '6', '7']);
  });

  it('M1 update pass: a held deal moved out of the entry stages is enqueued; untracked ineligible deals are not', async () => {
    mock.deals.set('1', syntheticDeal(1));
    await reconcile();
    await run();
    expect(db.deals.get('1')!.stageId).toBe('C7:WON');
    const watermark = db.config.lastReconciledAt!;

    db.now += 60_000;
    const later = new Date(db.now).toISOString();
    mock.deals.set('1', syntheticDeal(1, { STAGE_ID: 'C7:LOSE', DATE_MODIFY: later }));
    mock.deals.set('2', syntheticDeal(2, { STAGE_ID: 'C7:LOSE', DATE_MODIFY: later }));
    const heldDealIds = vi.fn(async (ids: number[]) => new Set(ids.filter((id) => db.deals.has(String(id)))));
    const s = await reconcile({ heldDealIds });
    expect(heldDealIds).toHaveBeenCalledWith([1, 2]);
    expect(s).toMatchObject({ enqueued: 1, notTracked: 1 });
    expect(mock.requests.filter((r) => r.method === 'crm.deal.list').at(-1)!.body).toMatchObject({
      // Watermark minus the clock-skew overlap (WATERMARK_OVERLAP_SECONDS).
      filter: { '>DATE_MODIFY': new Date(Date.parse(watermark) - 120_000).toISOString() },
    });
    await run();
    expect(db.deals.get('1')!.stageId).toBe('C7:LOSE'); // stage applies to held deals (entry-only rule)
    expect(db.deals.has('2')).toBe(false);
  });

  it('provider failure during reconcile records ok=false and rethrows', async () => {
    mock.failNext('crm.deal.list', { status: 500, body: { error: 'INTERNAL_SERVER_ERROR', error_description: 'x' } });
    await expect(reconcile()).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(db.calls.find((c) => c.fn === 'integration_record_reconcile_run')!.args.p_ok).toBe(false);
  });
});

describe('worker endpoint', () => {
  const SECRET = 'synthetic-worker-secret-0123456789abcdef';
  const rowFor = (over: Record<string, unknown> = {}) => ({
    portal_domain: PORTAL,
    portal_member_id: db.config.memberId,
    category_id: '7',
    eligible_stage_ids: ['C7:WON'],
    cutoff_at: '2026-10-01T00:00:00+05:30',
    enabled: true,
    ...over,
  });
  const deps = (over: Partial<WorkerEndpointDeps> = {}): WorkerEndpointDeps => ({
    env: { bitrixWebhookBaseUrl: mock.baseUrl, bitrixEventApplicationToken: null, intakeWorkerSecret: SECRET, cronSecret: null },
    appEnv: 'local',
    loadConfigRows: async () => [rowFor()],
    rpc,
    ...over,
  });
  const req = (auth?: string, query = '') =>
    new Request(`https://crm.example.test/api/integrations/bitrix/worker${query}`, {
      method: 'POST',
      headers: auth ? { authorization: auth } : {},
    });

  it.each([
    ['no header', undefined],
    ['wrong secret', `Bearer ${SECRET}x`],
    ['prefix of secret', `Bearer ${SECRET.slice(0, 10)}`],
    ['basic scheme', `Basic ${SECRET}`],
  ])('401 for %s, before any database work', async (_l, auth) => {
    const loadConfigRows = vi.fn(async () => [rowFor()]);
    const res = await handleWorkerRequest(req(auth), deps({ loadConfigRows }));
    expect(res.status).toBe(401);
    expect(loadConfigRows).not.toHaveBeenCalled();
    expect(db.calls).toHaveLength(0);
  });

  it('503 when the worker secret is missing or too short', async () => {
    for (const s of [null, 'short']) {
      const res = await handleWorkerRequest(req(`Bearer ${s}`), deps({ env: { bitrixWebhookBaseUrl: mock.baseUrl, bitrixEventApplicationToken: null, intakeWorkerSecret: s, cronSecret: null } }));
      expect(res.status).toBe(503);
    }
  });

  it('runs one batch and returns WorkerRunSummary', async () => {
    mock.deals.set('77', syntheticDeal(77));
    db.enqueueEvent(77, 1);
    const res = await handleWorkerRequest(req(`Bearer ${SECRET}`, '?limit=5'), deps());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claimed: 1, created: 1, updated: 0, ignored: 0, needsReview: 0, failed: 0, deadLettered: 0 });
    expect(db.calls.find((c) => c.fn === 'integration_claim_inbox')!.args.p_limit).toBe(5);
    // M2 heartbeat: counts and outcome only.
    expect(db.workerRuns).toEqual([
      { kind: 'worker', outcome: 'ok', trigger: 'manual', startedAt: expect.any(String), finishedAt: expect.any(String), claimed: 1, created: 1, updated: 0, ignored: 0, needsReview: 0, failed: 0, deadLettered: 0 },
    ]);
  });

  it('M2 heartbeat outcome reflects provider failures', async () => {
    db.enqueueEvent(79, 1);
    mock.failNext('crm.deal.get', { status: 500, body: { error: 'INTERNAL_SERVER_ERROR', error_description: 'x' } });
    await handleWorkerRequest(req(`Bearer ${SECRET}`), deps());
    expect(db.workerRuns.at(-1)).toMatchObject({ kind: 'worker', outcome: 'provider_error' });
    // An empty run is still a heartbeat (worker alive).
    await handleWorkerRequest(req(`Bearer ${SECRET}`), deps());
    expect(db.workerRuns.at(-1)).toMatchObject({ kind: 'worker', outcome: 'ok', claimed: 0 });
    // Every heartbeat was accepted by the strict key check.
    expect(db.calls.filter((c) => c.fn === 'integration_record_worker_run')).toHaveLength(db.workerRuns.length);
  });

  it('heartbeat write failure does not fail the run', async () => {
    const failing = asRpcClient({
      rpc: (fn: string, args?: Record<string, unknown>) =>
        fn === 'integration_record_worker_run'
          ? Promise.resolve({ data: null, error: { code: '42883', message: 'missing' } })
          : db.rpc(fn, args),
    });
    const res = await handleWorkerRequest(req(`Bearer ${SECRET}`), deps({ rpc: () => failing }));
    expect(res.status).toBe(200);
  });

  it('task=reconcile runs reconciliation', async () => {
    mock.deals.set('78', syntheticDeal(78));
    const res = await handleWorkerRequest(req(`Bearer ${SECRET}`, '?task=reconcile'), deps({ now: () => db.now }));
    expect(await res.json()).toMatchObject({ enqueued: 1 });
    expect(db.workerRuns.at(-1)).toEqual({
      kind: 'reconcile',
      outcome: 'ok',
      startedAt: expect.any(String),
      finishedAt: expect.any(String),
      enqueued: 1,
      trigger: 'manual',
    });
  });

  it('P2-12: base URL host not matching the portal (non-local) -> 503, nothing claimed, nothing fetched', async () => {
    const fetchImpl = vi.fn();
    const res = await handleWorkerRequest(
      req(`Bearer ${SECRET}`),
      deps({ appEnv: 'production', vercelEnv: 'production', fetchImpl: fetchImpl as unknown as typeof fetch, env: { bitrixWebhookBaseUrl: 'https://evil.example/rest/1/abcd1234/', bitrixEventApplicationToken: null, intakeWorkerSecret: SECRET, cronSecret: null } }),
    );
    expect(res.status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
    // Nothing claimed: only the sync-stopped alert check ran (§4).
    expect(db.calls.map((c) => c.fn)).toEqual(['integration_sync_alert_check']);
  });

  it('503 when not configured (no row / disabled / missing base URL)', async () => {
    expect((await handleWorkerRequest(req(`Bearer ${SECRET}`), deps({ loadConfigRows: async () => [] }))).status).toBe(503);
    expect((await handleWorkerRequest(req(`Bearer ${SECRET}`), deps({ loadConfigRows: async () => [rowFor({ enabled: false })] }))).status).toBe(503);
    expect(
      (await handleWorkerRequest(req(`Bearer ${SECRET}`), deps({ env: { bitrixWebhookBaseUrl: null, bitrixEventApplicationToken: null, intakeWorkerSecret: SECRET, cronSecret: null } }))).status,
    ).toBe(503);
  });

  it('P2-13: responses, fake inbox rows and logs never contain the base URL, webhook code or secrets', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
    mock.deals.set('88', syntheticDeal(88));
    db.enqueueEvent(88, 1);
    db.enqueueEvent(89, 1);
    mock.failNext('crm.deal.get', { status: 500, raw: `upstream failed for ${mock.baseUrl}` });
    const bodies = [
      await (await handleWorkerRequest(req(`Bearer ${SECRET}`), deps())).text(),
      await (await handleWorkerRequest(req('Bearer nope'), deps())).text(),
    ];
    const everything = JSON.stringify({ bodies, inbox: db.inbox, calls: db.calls });
    expect(everything).not.toContain(mock.webhookCode);
    expect(everything).not.toContain(SECRET);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    spies.forEach((s) => s.mockRestore());
  });
});

describe('S4 worker endpoint: event run and follow-up runs', () => {
  const SECRET = 'synthetic-worker-secret-0123456789abcdef';
  const rowFor = (over: Record<string, unknown> = {}) => ({
    portal_domain: PORTAL,
    portal_member_id: db.config.memberId,
    category_id: '7',
    eligible_stage_ids: ['C7:WON'],
    cutoff_at: '2026-10-01T00:00:00+05:30',
    enabled: true,
    last_reconciled_at: db.config.lastReconciledAt,
    ...over,
  });
  /** The fake command layer plus the S4 follow-up RPC (answer chosen per test). */
  let followup: { data: unknown; error: { code?: string; message?: string } | null };
  const s4rpc = () =>
    asRpcClient({
      rpc: (fn: string, args?: Record<string, unknown>) => {
        if (fn === 'integration_sync_request_followup') {
          db.calls.push({ fn, args: args ?? {} });
          return Promise.resolve(followup);
        }
        return db.rpc(fn, args);
      },
    });
  const deps = (over: Partial<WorkerEndpointDeps> = {}): WorkerEndpointDeps => ({
    env: { bitrixWebhookBaseUrl: mock.baseUrl, bitrixEventApplicationToken: null, intakeWorkerSecret: SECRET, cronSecret: null },
    appEnv: 'local',
    loadConfigRows: async () => [rowFor()],
    rpc: s4rpc,
    heldDealIds: async (_member, ids) => new Set(ids.filter((id) => db.deals.has(String(id)))),
    now: () => db.now,
    ...over,
  });
  const post = (query: string) =>
    new Request(`https://crm.example.test/api/integrations/bitrix/worker${query}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}` },
    });
  const EVENT = '?task=batch&limit=25&source=event';
  const followupCalls = () => db.calls.filter((c) => c.fn === 'integration_sync_request_followup');
  const RAN: Extract<IdProofCopyResult, { status: 'ran' }> = { status: 'ran', claimed: 1, sent: 1, retried: 0, failed: 0, unknown: 0, stopped: false, errors: [] };
  const IDLE: IdProofCopyResult = { ...RAN, claimed: 0, sent: 0 };

  beforeEach(() => {
    followup = { data: { dispatched: true }, error: null };
  });

  it('runTriggerFor: source=event on task=batch is the event run; anywhere else it is ignored', () => {
    expect(runTriggerFor('manual', 'batch', 'event')).toBe('event');
    expect(runTriggerFor('manual', 'batch', 'other')).toBe('manual');
    expect(runTriggerFor('manual', 'batch', null)).toBe('manual');
    expect(runTriggerFor('manual', 'sync', 'event')).toBe('cron');
    expect(runTriggerFor('manual', 'reconcile', 'event')).toBe('manual');
    expect(runTriggerFor('cron', 'batch')).toBe('cron');
    expect(EVENT_DRAIN_BUDGET_MS).toBe(30_000);
  });

  it('event run: drains in batches of 25 until empty, heartbeat trigger event, counts only; no pull, no follow-up', async () => {
    for (let i = 1; i <= 30; i += 1) {
      mock.deals.set(String(i), syntheticDeal(i));
      db.enqueueEvent(i, 1);
    }
    const res = await handleWorkerRequest(post(EVENT), deps());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      claimed: 30,
      created: 30,
      updated: 0,
      ignored: 0,
      needsReview: 0,
      failed: 0,
      deadLettered: 0,
      batches: 2,
      budgetReached: false,
    });
    expect(db.calls.filter((c) => c.fn === 'integration_claim_inbox').map((c) => c.args.p_limit)).toEqual([25, 25]);
    expect(db.workerRuns.map((r) => [r.kind, r.trigger])).toEqual([
      ['worker', 'event'],
      ['worker', 'event'],
    ]);
    // Drain only: no resync step, no update pass, no reconcile heartbeat.
    expect(db.calls.some((c) => c.fn === 'integration_resync_next' || c.fn === 'integration_record_reconcile_run')).toBe(false);
    expect(followupCalls()).toHaveLength(0);
    expect(db.inbox.every((r) => r.status === 'processed')).toBe(true);
  });

  it('event run: stops at the 30 s budget and hands unprocessed rows back', async () => {
    mock.deals.set('5', syntheticDeal(5));
    db.enqueueEvent(5, 1);
    // The claim "takes" longer than the whole event budget.
    const slow = asRpcClient({
      rpc: (fn: string, args?: Record<string, unknown>) => {
        if (fn === 'integration_claim_inbox') db.now += EVENT_DRAIN_BUDGET_MS + 1_000;
        return db.rpc(fn, args);
      },
    });
    const res = await handleWorkerRequest(post(EVENT), deps({ rpc: () => slow }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ claimed: 1, created: 0, batches: 1, budgetReached: true });
    expect(db.inbox[0]!.status).toBe('pending');
    expect(db.workerRuns).toHaveLength(1);
  });

  it('event run: a failed claim is not a 200 and leaks nothing', async () => {
    const failing = asRpcClient({
      rpc: (fn: string, args?: Record<string, unknown>) =>
        fn === 'integration_claim_inbox'
          ? Promise.resolve({ data: null, error: { code: '57014', message: 'synthetic detail' } })
          : db.rpc(fn, args),
    });
    const res = await handleWorkerRequest(post(EVENT), deps({ rpc: () => failing }));
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(JSON.parse(body)).toMatchObject({ claimed: 0, batches: 0, budgetReached: false });
    expect(body).not.toContain('synthetic detail');
  });

  it('plain ?task=batch (operator) is unchanged: one batch, trigger manual, WorkerRunSummary only', async () => {
    for (let i = 1; i <= 3; i += 1) {
      mock.deals.set(String(i), syntheticDeal(i));
      db.enqueueEvent(i, 1);
    }
    const res = await handleWorkerRequest(post('?task=batch&limit=2&source=other'), deps());
    expect(await res.json()).toEqual({ claimed: 2, created: 2, updated: 0, ignored: 0, needsReview: 0, failed: 0, deadLettered: 0 });
    expect(db.calls.filter((c) => c.fn === 'integration_claim_inbox')).toHaveLength(1);
    expect(db.workerRuns.map((r) => r.trigger)).toEqual(['manual']);
  });

  it('source=event on task=sync is ignored: a full run with trigger cron', async () => {
    mock.deals.set('7', syntheticDeal(7));
    const res = await handleWorkerRequest(post('?task=sync&source=event'), deps());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reconcileError: null, worker: { created: 1 }, followUp: null });
    expect(db.workerRuns.every((r) => r.trigger === 'cron')).toBe(true);
    expect(db.workerRuns.some((r) => r.kind === 'reconcile')).toBe(true);
  });

  it('the Lead watermark store gets the config this run already read (no second config read)', async () => {
    mock.deals.set('7', syntheticDeal(7));
    const at = '2026-10-05T00:00:00.000Z';
    const leadWatermark = vi.fn<NonNullable<WorkerEndpointDeps['leadWatermark']>>(() => ({ read: async () => at, record: async () => undefined }));
    const loadConfigRows = vi.fn(async () => [rowFor({ lead_reconciled_at: at })]);
    await handleWorkerRequest(post('?task=sync'), deps({ loadConfigRows, leadWatermark }));
    expect(loadConfigRows).toHaveBeenCalledTimes(1);
    expect(leadWatermark).toHaveBeenCalledTimes(1);
    expect(leadWatermark.mock.calls[0]![0]).toBe(db.config.memberId);
    expect(leadWatermark.mock.calls[0]![1]).toMatchObject({ portalMemberId: db.config.memberId, leadReconciledAt: at });
  });

  it('a finished full run requests no follow-up', async () => {
    mock.deals.set('7', syntheticDeal(7));
    const res = await handleWorkerRequest(post('?task=sync'), deps());
    expect(await res.json()).toMatchObject({ resync: { result: { inSync: true } }, followUp: null });
    expect(followupCalls()).toHaveLength(0);
  });

  it('a full run that ran out of time requests one chain run, after its own work', async () => {
    mock.deals.set('7', syntheticDeal(7));
    const res = await handleWorkerRequest(post('?task=sync'), deps({ syncBudgetMs: 1_000 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ budgetReached: true, followUp: 'chain' });
    expect(followupCalls().map((c) => c.args)).toEqual([{ p_kind: 'chain' }]);
    // Requested after the run's own work (the alert check follows the answer).
    const fns = db.calls.map((c) => c.fn);
    expect(fns.indexOf('integration_sync_request_followup')).toBeGreaterThan(fns.lastIndexOf('integration_record_worker_run'));
  });

  it('a copy step that ran a job requests one copy run; one that claimed nothing does not', async () => {
    mock.deals.set('7', syntheticDeal(7));
    const on = () => [rowFor({ bitrix_id_proof_copy: true })];
    const ran = await handleWorkerRequest(post('?task=sync'), deps({ loadConfigRows: async () => on(), idProofCopy: async () => RAN }));
    expect(await ran.json()).toMatchObject({ idProofCopy: RAN, followUp: 'copy' });
    expect(followupCalls().map((c) => c.args)).toEqual([{ p_kind: 'copy' }]);

    db.calls.length = 0;
    const idle = await handleWorkerRequest(post('?task=sync'), deps({ loadConfigRows: async () => on(), idProofCopy: async () => IDLE }));
    expect(await idle.json()).toMatchObject({ followUp: null });
    expect(followupCalls()).toHaveLength(0);
  });

  it('chain wins when both apply: exactly one request', async () => {
    mock.deals.set('7', syntheticDeal(7));
    const res = await handleWorkerRequest(
      post('?task=sync'),
      deps({ syncBudgetMs: 1_000, loadConfigRows: async () => [rowFor({ bitrix_id_proof_copy: true })], idProofCopy: async () => RAN }),
    );
    expect(await res.json()).toMatchObject({ followUp: 'chain' });
    expect(followupCalls().map((c) => c.args)).toEqual([{ p_kind: 'chain' }]);
  });

  it('a failing or refused follow-up request does not change the answer', async () => {
    mock.deals.set('7', syntheticDeal(7));
    const answers: Array<Record<string, unknown>> = [];
    for (const answer of [
      { data: { dispatched: true }, error: null },
      { data: { dispatched: false }, error: null },
      { data: null, error: { code: 'PGRST202', message: 'synthetic: function not found' } },
      { data: 'unexpected', error: null },
    ]) {
      db = new FakeIntakeDb();
      mock.requests.length = 0;
      followup = answer;
      const res = await handleWorkerRequest(post('?task=sync'), deps({ syncBudgetMs: 1_000 }));
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain('synthetic: function not found');
      answers.push(JSON.parse(text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')) as Record<string, unknown>);
    }
    for (const a of answers.slice(1)) expect(a).toEqual(answers[0]);
  });
});

describe('S4 syncFollowupKind (which follow-up a full run asks for)', () => {
  const summary = (over: Partial<SyncSummary> = {}): SyncSummary => ({
    resync: null,
    reconcile: { truncated: false } as SyncSummary['reconcile'],
    reconcileError: null,
    batches: 1,
    worker: emptySummary(),
    released: 0,
    budgetReached: false,
    outcome: 'ok',
    ...over,
  });
  const resync = (over: Partial<NonNullable<SyncSummary['resync']>> = {}): NonNullable<SyncSummary['resync']> => ({
    jobId: '00000000-0000-4000-8000-000000000001',
    scanned: 0,
    bitrixTotal: null,
    pages: 0,
    listingDone: false,
    result: null,
    waiting: null,
    withLeadId: 0,
    leadLinkRequeued: 0,
    ...over,
  });
  const RAN: Extract<IdProofCopyResult, { status: 'ran' }> = { status: 'ran', claimed: 1, sent: 1, retried: 0, failed: 0, unknown: 0, stopped: false, errors: [] };

  it('chain: out of time, page limit hit, or an open resync that made progress', () => {
    expect(syncFollowupKind(summary({ budgetReached: true }), null)).toBe('chain');
    expect(syncFollowupKind(summary({ reconcile: { truncated: true } as SyncSummary['reconcile'] }), null)).toBe('chain');
    expect(syncFollowupKind(summary({ resync: resync({ pages: 2 }) }), null)).toBe('chain');
    expect(syncFollowupKind(summary({ resync: resync({ listingDone: true }), worker: { ...emptySummary(), claimed: 3 } }), null)).toBe('chain');
  });

  it('none: a finished run, item failures alone, a resync with no progress or already complete, a pull failure', () => {
    expect(syncFollowupKind(summary(), null)).toBeNull();
    expect(
      syncFollowupKind(summary({ outcome: 'partial', released: 2, worker: { ...emptySummary(), claimed: 2, failed: 2 } }), null),
    ).toBeNull();
    expect(syncFollowupKind(summary({ resync: resync() }), null)).toBeNull();
    expect(
      syncFollowupKind(summary({ resync: resync({ pages: 3, result: { bitrix: 1, crm: 1 } as never }) }), null),
    ).toBeNull();
    expect(
      syncFollowupKind(
        summary({ reconcile: null, reconcileError: 'provider_unavailable', outcome: 'provider_error', resync: resync({ pages: 1 }) }),
        null,
      ),
    ).toBeNull();
  });

  it('copy: the copy step ran a job; chain wins; skipped, failed or empty copy steps ask for nothing', () => {
    expect(syncFollowupKind(summary(), RAN)).toBe('copy');
    expect(syncFollowupKind(summary({ budgetReached: true }), RAN)).toBe('chain');
    expect(syncFollowupKind(summary(), { ...RAN, claimed: 0 })).toBeNull();
    expect(syncFollowupKind(summary(), { status: 'skipped', code: 'not_enough_time' })).toBeNull();
    expect(syncFollowupKind(summary(), { status: 'error', code: 'copy_failed' })).toBeNull();
    expect(syncFollowupKind(summary(), { status: 'not_configured', code: 'missing' })).toBeNull();
  });
});
