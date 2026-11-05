import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { autoSyncState } from '@/modules/integration/auto-sync-state';
import type { AutoSyncView, IntegrationStatusView } from '@/modules/integration/contracts';

/**
 * Sync completion §4: the admin page says when email alerts are not set up, and
 * the stopped reasons fit local and hosted alike (no commands in UI text).
 */

const NOW = Date.parse('2026-10-08T10:00:00Z');

const view = (over: Partial<AutoSyncView> = {}): AutoSyncView => ({
  cronInstalled: true,
  jobActive: true,
  enabled: true,
  lastCalls: [],
  failingSince: null,
  lastSuccessAt: '2026-10-08T09:00:00Z',
  ...over,
});

describe('stopped reasons', () => {
  it('give no local-only commands', () => {
    const reasons = [
      view({ cronInstalled: false }),
      view({ jobActive: false }),
      view({ lastCalls: [] }),
      view({ lastCalls: [{ at: '2026-10-08T09:59:00Z', statusCode: 200, ok: true, reason: null }] }),
      view({ lastCalls: [{ at: '2026-10-08T09:59:00Z', statusCode: null, ok: null, reason: null }] }),
    ].map((v) => {
      const state = autoSyncState(v, NOW);
      expect(state.kind).toBe('stopped');
      return state.kind === 'stopped' ? state.reason : '';
    });
    for (const reason of reasons) {
      expect(reason.length).toBeGreaterThan(10);
      expect(reason).not.toMatch(/npm|local:up|run [a-z]+:/i);
    }
  });
});

describe('admin page: email alerts notice', () => {
  const status: IntegrationStatusView = {
    configured: true,
    environment: 'operational',
    portalDomain: 'synthetic-portal.example.test',
    pilotBranchName: 'Jodhpur',
    cutoffAt: '2026-10-01T00:00:00Z',
    credentialPresent: true,
    workerSecretPresent: true,
    enabledConfigCount: 1,
    counts: { pending: 0, processing: 0, processed: 1, ignored: 0, needs_review: 0, failed: 0, dead_letter: 0 },
    lastProcessedAt: '2026-10-08T09:59:00Z',
    lastWorkerRunAt: '2026-10-08T09:59:00Z',
    lastWorkerOutcome: 'ok',
    oldestPendingAt: null,
    autoSync: view({ lastSuccessAt: '2026-10-08T09:59:50Z' }),
    attention: [],
  };

  async function render(emailAlertsConfigured?: boolean): Promise<string> {
    const { IntegrationAdminView } = await import('@/views/integration-views');
    return renderToStaticMarkup(createElement(IntegrationAdminView, { status, now: NOW, emailAlertsConfigured }));
  }

  it('says email alerts are not set up when the sender is missing', async () => {
    expect(await render(false)).toContain('Email alerts are off: problems show only on this page.');
  });

  it('says nothing when the sender is set up, or in previews (not passed)', async () => {
    expect(await render(true)).not.toContain('Email alerts are off');
    expect(await render(undefined)).not.toContain('Email alerts are off');
  });
});
