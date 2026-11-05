import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { runProblems24h } from '@/modules/integration/auto-sync-state';
import { runResyncListing } from '@/modules/integration/bitrix/resync';
import { runInboxBatch } from '@/modules/integration/bitrix/worker';
import { enqueueReconcile, INTAKE_REASON_CODES, type RpcClient } from '@/modules/integration/commands';
import type { AutoSyncView, IntegrationStatusView, RunCounts24h } from '@/modules/integration/contracts';
import type { IntakeConfig } from '@/modules/integration/intake-config';
import { toAutoSync } from '@/modules/integration/server/queries';
import { integrationHealth, primaryCopy, RunProblemsLine, UNKNOWN_ERROR_COPY, UNKNOWN_REASON_COPY } from '@/views/integration-views';

/**
 * Sync reliability (9 October 2026).
 *
 * Root cause of the hosted internal_error worker runs: the database answers a
 * scope-mode Lead it does not store with ignored / owner_not_eligible (migration
 * 20261111000100), but the app's apply-result schema did not list that reason.
 * The parse threw AFTER the apply had committed, the worker then tried to mark
 * the already finished row failed (its lease was gone, so that threw too) and
 * counted the item as failed plus an internal error. These tests pin the fix,
 * the drift guard and the honest admin counts.
 */

const MEMBER = 'synthetic-member-0001';
const config: IntakeConfig = {
  portalDomain: 'synthetic.bitrix24.example',
  portalMemberId: MEMBER,
  categoryId: '7',
  categoryIds: ['7'],
  eligibleStageIds: ['C7:NEW'],
  cutoffAt: '2026-10-01T00:00:00+05:30',
  pilotLegalEntityId: null,
  pilotBranchId: null,
  enabled: true,
  lastReconciledAt: null,
};

const INBOX = '00000000-0000-4000-8000-0000000000a1';
const LOCK = '00000000-0000-4000-8000-0000000000b1';
const LEAD_UUID = '00000000-0000-4000-8000-0000000000c1';

function leadBatch(applyAnswer: Record<string, unknown>, rowStatus: { data: unknown; error: { code: string } | null } = { data: null, error: null }) {
  const calls: string[] = [];
  const rpc: RpcClient = {
    rpc: async (fn) => {
      calls.push(fn);
      if (fn === 'integration_claim_inbox') {
        return {
          data: [
            {
              inboxId: INBOX,
              lockToken: LOCK,
              portalMemberId: MEMBER,
              sourceObject: 'lead',
              sourceId: '4101',
              eventType: 'ONCRMLEADUPDATE',
              origin: 'event',
              attempts: 1,
            },
          ],
          error: null,
        };
      }
      if (fn === 'integration_apply_bitrix_lead') return { data: applyAnswer, error: null };
      // The row is already finished: its lease is gone, so a fail call is refused.
      if (fn === 'integration_fail_inbox') return { data: null, error: { code: '55P03', message: 'lease lost' } };
      if (fn === 'integration_inbox_row_status') return rowStatus;
      return { data: null, error: null };
    },
  };
  const bitrix = {
    getDeal: vi.fn(),
    getLead: vi.fn(async () => ({
      kind: 'ok' as const,
      lead: {
        ID: '4101',
        TITLE: 'Synthetic lead',
        STATUS_ID: 'NEW',
        SOURCE_ID: 'WEBFORM',
        ASSIGNED_BY_ID: '999',
        DATE_CREATE: '2026-10-02T11:00:00+05:30',
        DATE_MODIFY: '2026-10-02T11:00:00+05:30',
      },
    })),
  };
  return { calls, run: () => runInboxBatch({ rpc, bitrix, config }) };
}

describe('worker: a Lead ignored as owner_not_eligible is a clean ignore, not a failure', () => {
  it('counts the Lead as ignored, ends the run ok and never calls fail', async () => {
    const batch = leadBatch({ outcome: 'ignored', leadId: LEAD_UUID, reasonCode: 'owner_not_eligible' });
    const stats = await batch.run();
    expect(stats.summary).toEqual({ claimed: 1, created: 0, updated: 0, ignored: 1, needsReview: 0, failed: 0, deadLettered: 0 });
    expect(stats.internalErrors).toBe(0);
    expect(stats.outcome).toBe('ok');
    expect(batch.calls).not.toContain('integration_fail_inbox');
  });

  it('an unknown reason code from a newer database still counts the committed outcome', async () => {
    const batch = leadBatch({ outcome: 'ignored', leadId: null, reasonCode: 'some_future_reason' });
    const stats = await batch.run();
    expect(stats.summary.ignored).toBe(1);
    expect(stats.outcome).toBe('ok');
    expect(batch.calls).not.toContain('integration_fail_inbox');
  });

  it('an answer that cannot be read after the row was finished is counted by the row\'s real status', async () => {
    const ignored = await leadBatch({ outcome: 'merged' }, { data: { status: 'ignored' }, error: null }).run();
    expect(ignored.summary).toMatchObject({ ignored: 1, failed: 0 });
    expect(ignored.internalErrors).toBe(0);
    expect(ignored.outcome).toBe('ok');
    const saved = await leadBatch({ outcome: 'merged' }, { data: { status: 'processed' }, error: null }).run();
    expect(saved.summary).toMatchObject({ updated: 1, failed: 0 });
    expect(saved.outcome).toBe('ok');
    const held = await leadBatch({ outcome: 'merged' }, { data: { status: 'needs_review' }, error: null }).run();
    expect(held.summary).toMatchObject({ needsReview: 1, failed: 0 });
  });

  it('a row still open, or a database without the status command, stays an unconfirmed failure', async () => {
    const open = await leadBatch({ outcome: 'merged' }, { data: { status: 'processing' }, error: null }).run();
    expect(open.summary.failed).toBe(1);
    expect(open.outcome).toBe('internal_error');
    const older = await leadBatch({ outcome: 'merged' }, { data: null, error: { code: '42883' } }).run();
    expect(older.summary.failed).toBe(1);
    expect(older.outcome).toBe('internal_error');
  });

  it('an unknown outcome is still refused (fail closed)', async () => {
    const batch = leadBatch({ outcome: 'merged', leadId: null, reasonCode: null });
    const stats = await batch.run();
    expect(stats.outcome).toBe('internal_error');
    expect(stats.summary.failed).toBe(1);
  });
});

describe('reason codes: the app knows every code the database may store', () => {
  const dir = join(process.cwd(), 'supabase/migrations');
  /** Every migration in apply order, comments removed; the last definition wins. */
  const all = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf8').replace(/--[^\n]*/g, ''))
    .join('\n');

  it('matches the newest integration_inbox_reason_code_check in the migrations', () => {
    const defs = [...all.matchAll(/add\s+constraint\s+integration_inbox_reason_code_check\s+check\s*\(\s*reason_code\s+in\s*\(([^)]*)\)/gi)];
    expect(defs.length).toBeGreaterThan(0);
    const fromDb = [...defs.at(-1)![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(fromDb).toContain('owner_not_eligible');
    expect([...INTAKE_REASON_CODES].sort()).toEqual(fromDb);
  });

  it('every reason the newest apply and enqueue functions return literally is known to the app', () => {
    const known = new Set<string>(INTAKE_REASON_CODES);
    for (const fn of [
      'integration_apply_bitrix_deal',
      'integration_apply_bitrix_lead',
      'integration_enqueue_reconcile',
      'integration_enqueue_reconcile_lead',
    ]) {
      const starts = [...all.matchAll(new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${fn}\\s*\\(`, 'gi'))];
      expect(starts.length, fn).toBeGreaterThan(0);
      const from = starts.at(-1)!.index!;
      // The body runs to the next function definition (dollar-quote tags differ between files).
      const nextFn = /create\s+(?:or\s+replace\s+)?function\b/gi;
      nextFn.lastIndex = from + 10;
      const body = all.slice(from, nextFn.exec(all)?.index ?? all.length);
      const emitted = [
        ...[...body.matchAll(/v_[a-z_]*reason\s*:=\s*'([a-z_]+)'/g)].map((m) => m[1]!),
        ...[...body.matchAll(/'reasonCode'\s*,\s*'([a-z_]+)'/g)].map((m) => m[1]!),
      ];
      expect(emitted.length, fn).toBeGreaterThan(0);
      for (const code of emitted) expect(known.has(code), `${fn}: ${code}`).toBe(true);
    }
  });
});

describe('a code newer than the app never breaks the admin page or the reconcile pass', () => {
  it('unknown reason and error codes get neutral copy', () => {
    const item = {
      inboxId: INBOX, status: 'needs_review' as const, origin: 'event' as const, eventType: 'ONCRMDEALUPDATE', sourceDealId: '1',
      receivedAt: '2026-10-09T10:00:00Z', attempts: 1, maxAttempts: 8, nextAttemptAt: null, lastErrorAt: null, processedDealId: null,
      reasonCode: 'some_future_reason' as never, lastErrorCode: null,
    };
    expect(primaryCopy(item)).toEqual(UNKNOWN_REASON_COPY);
    expect(primaryCopy({ ...item, sourceObject: 'lead' })?.sentence).toBe(UNKNOWN_REASON_COPY.sentence);
    expect(primaryCopy({ ...item, status: 'failed', reasonCode: null, lastErrorCode: 'some_future_error' as never })).toEqual(UNKNOWN_ERROR_COPY);
  });

  it('an enqueue answer with an unknown reason is still read', async () => {
    const rpc: RpcClient = {
      rpc: async () => ({ data: { inboxId: null, duplicate: false, upToDate: false, ignored: true, reasonCode: 'some_future_reason' }, error: null }),
    };
    await expect(enqueueReconcile(rpc, { memberId: MEMBER, sourceId: 1, sourceModified: 1 })).resolves.toBe('not_in_manifest');
  });
});

const counts = (over: Partial<RunCounts24h> = {}): RunCounts24h => ({
  worker: { ok: 276, partial: 35, providerError: 0, internalError: 27 },
  reconcile: { ok: 288, partial: 3, providerError: 0, internalError: 0 },
  itemsFailed: 549,
  itemsDeadLettered: 0,
  lastFailedAt: '2026-10-09T11:18:24Z',
  ...over,
});

describe('admin page: failed runs of the last 24 hours are counted and shown', () => {
  const NOW = Date.parse('2026-10-09T11:32:00Z');
  const auto = (runs24h: RunCounts24h | null | undefined): AutoSyncView => ({
    cronInstalled: true,
    jobActive: true,
    enabled: true,
    lastCalls: [{ at: '2026-10-09T11:31:50Z', statusCode: 200, ok: true, reason: null }],
    failingSince: null,
    lastSuccessAt: '2026-10-09T11:31:50Z',
    runs24h,
  });
  const status = (runs24h: RunCounts24h | null | undefined): IntegrationStatusView => ({
    configured: true,
    environment: 'operational',
    portalDomain: 'synthetic-portal.example.test',
    pilotBranchName: 'Delhi',
    cutoffAt: '2026-10-01T00:00:00Z',
    credentialPresent: true,
    workerSecretPresent: true,
    enabledConfigCount: 1,
    counts: { pending: 0, processing: 0, processed: 10, ignored: 0, needs_review: 0, failed: 0, dead_letter: 0 },
    lastProcessedAt: '2026-10-09T11:31:00Z',
    lastWorkerRunAt: '2026-10-09T11:31:53Z',
    lastWorkerOutcome: 'ok',
    oldestPendingAt: null,
    attention: [],
    autoSync: auto(runs24h),
  });

  it('toAutoSync reads runs24h from the admin RPC; absent or malformed is null, never zero', () => {
    const base = { cronInstalled: true, job: { active: true }, enabled: true, lastCalls: [], failingSince: null };
    expect(toAutoSync({ data: { ...base, runs24h: counts() }, error: null }, null)?.runs24h).toEqual(counts());
    expect(toAutoSync({ data: base, error: null }, null)?.runs24h).toBeNull();
    expect(toAutoSync({ data: { ...base, runs24h: { worker: { ok: -1 } } }, error: null }, null)?.runs24h).toBeNull();
  });

  it('runProblems24h adds failed worker and reconcile runs', () => {
    expect(runProblems24h(auto(counts({ reconcile: { ok: 1, partial: 0, providerError: 2, internalError: 1 } })))).toEqual({
      failedRuns: 30,
      partialRuns: 35,
      itemsFailed: 549,
      itemsDeadLettered: 0,
      lastFailedAt: '2026-10-09T11:18:24Z',
    });
    expect(runProblems24h(auto(undefined))).toBeNull();
  });

  it('the health pill is not "Receiving deals" while runs failed', () => {
    expect(integrationHealth(status(counts()), NOW, null)).toMatchObject({ tone: 'warn', label: '27 updates failed today', detail: '27 failed sync run(s) in the last 24 hours.' });
    const clean = counts({ worker: { ok: 300, partial: 0, providerError: 0, internalError: 0 }, reconcile: { ok: 300, partial: 0, providerError: 0, internalError: 0 }, itemsFailed: 0, lastFailedAt: null });
    expect(integrationHealth(status(clean), NOW, null)).toMatchObject({ tone: 'ok', label: 'Receiving deals' });
  });

  it('the summary says how many runs failed and how many items they could not save', () => {
    const html = renderToStaticMarkup(createElement(RunProblemsLine, { status: status(counts()) }));
    expect(html).toContain('role="alert"');
    expect(html).toContain('27 sync run(s) failed in the last 24 hours');
    expect(html).toContain('38 more finished only part of their work');
    expect(html).toContain('could not confirm 549 item(s) as saved');
    expect(html).not.toContain('could not save');
  });

  it('partial runs only: a plain note, no alert; a clean day or an older database: nothing', () => {
    const partial = counts({ worker: { ok: 10, partial: 2, providerError: 0, internalError: 0 }, itemsFailed: 0, lastFailedAt: null });
    const html = renderToStaticMarkup(createElement(RunProblemsLine, { status: status(partial) }));
    expect(html).not.toContain('role="alert"');
    expect(html).toContain('5 sync run(s) in the last 24 hours finished only part of their work');
    const clean = counts({ worker: { ok: 1, partial: 0, providerError: 0, internalError: 0 }, reconcile: { ok: 1, partial: 0, providerError: 0, internalError: 0 }, itemsFailed: 0, lastFailedAt: null });
    expect(renderToStaticMarkup(createElement(RunProblemsLine, { status: status(clean) }))).toBe('');
    expect(renderToStaticMarkup(createElement(RunProblemsLine, { status: status(null) }))).toBe('');
  });
});

describe('full resync passes Bitrix LEAD_ID so stored Deals get their Lead link', () => {
  it('lists LEAD_ID, sends it per Deal, counts Deals with a Lead and the re-queued links', async () => {
    const pages: unknown[] = [];
    const rpc: RpcClient = {
      rpc: async (fn, args) => {
        if (fn === 'integration_resync_next') {
          return {
            data: {
              jobId: '00000000-0000-4000-8000-0000000000d1',
              lockToken: '00000000-0000-4000-8000-0000000000d2',
              reason: 'daily',
              cutoffAt: '2026-10-01T00:00:00+05:30',
              categoryIds: ['7'],
              stageIds: ['C7:NEW'],
              cursorId: 0,
              listingDone: false,
              bitrixTotal: null,
              scanned: 0,
            },
            error: null,
          };
        }
        if (fn === 'integration_resync_page') {
          pages.push(args?.p_deals);
          return { data: { enqueued: 0, scanned: 3, cursorId: 3, leadLinkRequeued: 1 }, error: null };
        }
        return { data: null, error: null };
      },
    };
    const listDeals = vi.fn(async () => ({
      items: [
        { ID: '1', DATE_MODIFY: '2026-10-02T10:00:00+05:30', LEAD_ID: '41001' },
        { ID: '2', DATE_MODIFY: '2026-10-02T10:00:00+05:30', LEAD_ID: null },
        { ID: '3', DATE_MODIFY: '2026-10-02T10:00:00+05:30', LEAD_ID: '0' },
      ],
      next: null,
      total: 3,
    }));
    const step = await runResyncListing({ rpc, bitrix: { listDeals }, config, deadlineMs: Date.now() + 30_000 });
    expect((listDeals.mock.calls[0] as unknown[])[0]).toMatchObject({ select: ['ID', 'DATE_MODIFY', 'LEAD_ID'] });
    expect(pages[0]).toEqual([
      { id: 1, modified: Date.parse('2026-10-02T10:00:00+05:30') / 1000, leadId: '41001' },
      { id: 2, modified: Date.parse('2026-10-02T10:00:00+05:30') / 1000, leadId: '' },
      { id: 3, modified: Date.parse('2026-10-02T10:00:00+05:30') / 1000, leadId: '' },
    ]);
    expect(step).toMatchObject({ withLeadId: 1, leadLinkRequeued: 1, listingDone: true });
  });
});
