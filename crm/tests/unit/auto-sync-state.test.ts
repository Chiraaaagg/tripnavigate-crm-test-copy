import { describe, expect, it } from 'vitest';
import { autoSyncState, STOPPED_AFTER_INTERVALS, SYNC_INTERVAL_SECONDS } from '@/modules/integration/auto-sync-state';
import type { AutoSyncView } from '@/modules/integration/contracts';
import { toAutoSync, toFullCheck } from '@/modules/integration/server/queries';

const NOW = Date.parse('2026-10-05T08:00:00Z');
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();
const view = (over: Partial<AutoSyncView> = {}): AutoSyncView => ({
  cronInstalled: true,
  jobActive: true,
  enabled: true,
  lastCalls: [{ at: ago(10), statusCode: 200, ok: true, reason: null }],
  failingSince: null,
  lastSuccessAt: ago(12),
  ...over,
});

describe('auto sync status (admin page)', () => {
  it('running: "last run X s ago" while a successful run is at most 3 intervals old', () => {
    expect(autoSyncState(view(), NOW)).toEqual({ kind: 'running', lastRunSecondsAgo: 12 });
    const edge = SYNC_INTERVAL_SECONDS * STOPPED_AFTER_INTERVALS;
    expect(autoSyncState(view({ lastSuccessAt: ago(edge) }), NOW).kind).toBe('running');
  });

  it('stopped after more than 3 intervals without a successful run, with the last call’s plain reason', () => {
    const reason = "The CRM refused the scheduler's secret (HTTP 401): …";
    const s = autoSyncState(
      view({
        lastSuccessAt: ago(SYNC_INTERVAL_SECONDS * STOPPED_AFTER_INTERVALS + 1),
        lastCalls: [
          { at: ago(5), statusCode: null, ok: null, reason: null },
          { at: ago(35), statusCode: 401, ok: false, reason },
        ],
        failingSince: ago(1800),
      }),
      NOW,
    );
    expect(s).toEqual({ kind: 'stopped', since: ago(91), reason });
  });

  it('stopped with a cron reason when the job is missing or inactive; never-run counts as stopped', () => {
    expect(autoSyncState(view({ cronInstalled: false }), NOW)).toMatchObject({ kind: 'stopped', reason: expect.stringMatching(/missing/) });
    expect(autoSyncState(view({ jobActive: false }), NOW)).toMatchObject({ kind: 'stopped', reason: expect.stringMatching(/switched off/) });
    expect(autoSyncState(view({ lastSuccessAt: null, lastCalls: [] }), NOW)).toMatchObject({ kind: 'stopped', since: null });
  });

  it('paused when the admin switch is off; unknown when the status cannot be read', () => {
    expect(autoSyncState(view({ enabled: false, lastSuccessAt: null }), NOW)).toEqual({ kind: 'paused' });
    expect(autoSyncState(null, NOW)).toEqual({ kind: 'unknown' });
  });

  it('toAutoSync maps the admin RPC and the last successful heartbeat', () => {
    const v = toAutoSync(
      { data: { cronInstalled: true, job: { schedule: '30 seconds', active: true }, enabled: true, lastCalls: [], failingSince: null }, error: null },
      { data: { finished_at: ago(3) }, error: null },
    );
    expect(v).toEqual({ cronInstalled: true, jobActive: true, enabled: true, lastCalls: [], failingSince: null, lastSuccessAt: ago(3), runs24h: null });
    expect(toAutoSync({ data: null, error: { code: '42501' } }, null)).toBeNull();
  });
});

describe('"Bitrix" next to "Available deals" uses a check made with the current settings only', () => {
  const done = {
    reason: 'daily' as const,
    status: 'done' as const,
    scanned: 92,
    bitrix_total: 92,
    listing_done: true,
    created_at: ago(600),
    finished_at: ago(590),
    result: { bitrix: 92, crm: 92, missing: 0, extra: 0, keptAfterStageMove: 0, inSync: true },
    cutoff_at: '2026-09-30T18:30:00+00:00',
    category_ids: [1, 0],
    stage_ids: ['NEW', 'C1:NEW'],
  };
  it('same filter (any order) -> matchesSettings; another sync date -> not', () => {
    const settings = { cutoffAt: '2026-10-01T00:00:00+05:30', categoryIds: ['0', '1'], stageIds: ['C1:NEW', 'NEW'] };
    expect(toFullCheck([done], settings).last?.matchesSettings).toBe(true);
    expect(toFullCheck([done], { ...settings, cutoffAt: '2026-09-01T00:00:00+05:30' }).last?.matchesSettings).toBe(false);
  });
});
