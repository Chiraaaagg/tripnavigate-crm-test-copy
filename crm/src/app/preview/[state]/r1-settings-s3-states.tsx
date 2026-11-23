import type { ReactNode } from 'react';
import type { ViewerAccess } from '@/modules/access/policy';
import type { InboxItemView, IntegrationStatusView } from '@/modules/integration/contracts';
import { bitrixPageModel } from '@/modules/settings/server/queries';
import { syncReview } from '@/modules/settings/sync-scope';
import { WonOnlyCard } from '@/views/b11/won-only-card';
import { BitrixNamesCard, BitrixTripDetailsCard } from '@/views/bitrix-names-card';
import { IntegrationAdminView, type BitrixTab } from '@/views/integration-views';
import { ImportsIndexView } from '@/views/settings/import-view';
import { SyncScopeSection } from '@/views/settings/sync-scope-form';
import { importIndexRows } from '@/views/settings/imports-index';
import { IdProofCopyAlertsCard } from '@/views/workflow-views';
import type { ShellViewer } from '@/views/StaffShell';
import { previewB11PruneDryRunAction, previewB11WonOnlySavedAction } from './b11-preview-actions';
import { switchStates, SYNTHETIC_PIPELINES } from './batch4-settings-fixtures';
import { previewSwitchSavedAction, previewSyncApplyAction, previewSyncApplyStaleAction, previewSyncPreviewAction } from './batch4-settings-preview-actions';
import { previewNamesSavedAction } from './names-preview-actions';
import { inSettings, settingsOwner } from './settings-preview-frame';

/*
 * UX redesign R1, helper S3: Settings › Bitrix connection (one state per
 * sub-tab, plus Status and Clean-up with problems) and the Settings › Imports
 * index. Synthetic props and stand-in actions only; rendered by the
 * design-review gallery (merged into the acc3-messages states map), never in
 * production. Every state renders the real Settings frame.
 */

const BITRIX = '/app/admin/integration';
const NOW = Date.parse('2026-11-17T10:00:00Z');

const healthy: IntegrationStatusView = {
  configured: true,
  environment: 'test',
  portalDomain: 'synthetic-portal.example.test',
  pilotBranchName: 'Jodhpur',
  cutoffAt: '2026-08-31T18:30:00Z',
  credentialPresent: true,
  workerSecretPresent: true,
  enabledConfigCount: 1,
  counts: { pending: 0, processing: 0, processed: 58, ignored: 4, needs_review: 0, failed: 0, dead_letter: 0 },
  lastProcessedAt: '2026-11-17T09:59:10Z',
  lastWorkerRunAt: '2026-11-17T09:59:40Z',
  lastWorkerOutcome: 'ok',
  oldestPendingAt: null,
  attention: [],
  crmDeals: 58,
  bitrixNow: 58,
  keptOutsideStages: 0,
  syncEnabled: true,
  categoryIds: ['0', '7'],
  stageIds: ['NEW', 'WON', 'C7:NEW'],
  lastRun: { at: '2026-11-17T09:59:40Z', fetched: 2, created: 0, updated: 2 },
  autoSync: { cronInstalled: true, jobActive: true, enabled: true, lastCalls: [{ at: '2026-11-17T09:59:30Z', statusCode: 200, ok: true, reason: null }], failingSince: null, lastSuccessAt: '2026-11-17T09:59:40Z' },
  waitingForOwner: 0,
  waitingByBitrixUser: [],
};

function inboxItem(n: number, extra: Partial<InboxItemView>): InboxItemView {
  return {
    inboxId: `a00000${n}0-0000-4000-8000-000000000000`,
    status: 'needs_review',
    origin: 'event',
    eventType: 'ONCRMDEALADD',
    sourceDealId: `9102${String(n).padStart(2, '0')}`,
    receivedAt: '2026-11-17T08:30:00Z',
    attempts: 1,
    maxAttempts: 8,
    nextAttemptAt: null,
    reasonCode: null,
    lastErrorCode: null,
    lastErrorAt: null,
    processedDealId: null,
    ...extra,
  };
}

/** Two rows that need a person and two deals waiting for an owner; the background update is late (checklist fails). */
const withProblems: IntegrationStatusView = {
  ...healthy,
  counts: { ...healthy.counts, needs_review: 1, dead_letter: 1 },
  attention: [
    inboxItem(1, { reasonCode: 'unmapped_owner' }),
    inboxItem(2, { status: 'dead_letter', attempts: 8, lastErrorCode: 'internal_error', lastErrorAt: '2026-11-17T07:00:00Z' }),
  ],
  waitingForOwner: 2,
  waitingByBitrixUser: [{ bitrixUserId: '77', deals: 2 }],
  lastWorkerRunAt: '2026-11-17T08:00:00Z',
};

const namesOn = {
  state: 'known' as const,
  enabled: true,
  connectionEnabled: true,
  effective: true,
  canSwitch: true,
  lastChange: { at: '2026-11-10T06:00:00Z', byName: 'Synthetic Owner Jodhpur', via: 'settings', to: true, reason: 'Synthetic: owner approved showing Bitrix names.' },
};

function bitrixTab(tab: BitrixTab, status: IntegrationStatusView = healthy): ReactNode {
  const page = bitrixPageModel(switchStates(), { openStops: 0 });
  return inSettings(
    settingsOwner,
    BITRIX,
    <IntegrationAdminView
      tab={tab}
      status={status}
      now={NOW}
      pipelines={SYNTHETIC_PIPELINES}
      bitrixUsers={[{ id: '77', name: 'Synthetic Bitrix User', email: null, active: true }]}
      emailAlertsConfigured
      switches={page.switches}
      switchActions={{ change: previewSwitchSavedAction }}
      sync={{ model: page.sync, text: page.syncText, preview: previewSyncPreviewAction, apply: previewSyncApplyAction }}
      slots={{
        switches: (
          <>
            <BitrixNamesCard state={namesOn as never} action={previewNamesSavedAction} />
            <BitrixTripDetailsCard state={namesOn as never} action={previewNamesSavedAction} />
          </>
        ),
        deals: <WonOnlyCard rule={null} stageOptions={[]} setAction={previewB11WonOnlySavedAction} dryRunAction={previewB11PruneDryRunAction} runAction={previewB11PruneDryRunAction} />,
        cleanup: <IdProofCopyAlertsCard alerts={{ stops: [], manualChecks: [] }} />,
      }}
    />,
  );
}

/** Which deals come in: the one confirm dialog open on a counted change (C7, reason required). */
function syncConfirm(opts: { stale?: boolean; reason?: string } = {}): ReactNode {
  const model = bitrixPageModel(switchStates()).sync!;
  const review = syncReview(
    { categoryIds: ['0'], stageIds: ['NEW', 'WON'], cutoff: '2026-09-01', syncEnabled: true },
    {
      previewId: '0b4e0000-0000-4000-8000-000000000101',
      expiresAt: '2026-11-17T10:10:00.000Z',
      changed: true,
      current: null as never,
      proposed: null as never,
      hide: { total: 12, beforeSyncDate: 0, pipelineNotEligible: 9, stageNotEligible: 3, withCrmWork: 2 },
      bringBack: 1,
      recheck: 4,
      autoSyncChange: 'none',
    },
  );
  return inSettings(
    settingsOwner,
    BITRIX,
    <SyncScopeSection
      configured
      pipelines={SYNTHETIC_PIPELINES}
      directoryError={null}
      model={model}
      text={null}
      installed
      actions={{ preview: previewSyncPreviewAction, apply: opts.stale ? previewSyncApplyStaleAction : previewSyncApplyAction }}
      initialReview={review}
      initialReason={opts.reason ?? ''}
    />,
  );
}

const ENTITY = 'e0000000-0000-4000-8000-000000000001';
const access = (roles: string[]): ViewerAccess => ({ memberships: roles.map((roleCode) => ({ legalEntityId: ENTITY, roleCode })) }) as unknown as ViewerAccess;
const accountsImporter: ShellViewer = { displayName: 'Synthetic Accounts 1', primaryRole: 'Accounts', primaryBranch: 'Jodhpur', canAdministerStaff: false, canManageGrants: false, canImport: true };

export const R1_S3_STATES: Record<string, () => ReactNode> = {
  /* Settings › Bitrix connection, one state per sub-tab */
  'r1-bitrix-status': () => bitrixTab('status'),
  'r1-bitrix-status-problems': () => bitrixTab('status', withProblems),
  'r1-bitrix-deals': () => bitrixTab('deals'),
  'r1-bitrix-switches': () => bitrixTab('switches'),
  'r1-bitrix-cleanup': () => bitrixTab('cleanup'),
  'r1-bitrix-cleanup-attention': () => bitrixTab('cleanup', withProblems),
  /* Which deals come in: one confirm dialog with the effect and the required reason */
  'r1-bitrix-sync-confirm': () => syncConfirm(),
  'r1-bitrix-sync-confirm-stale': () => syncConfirm({ stale: true, reason: 'Owner APPROVE on 17 Nov: stop the corporate pipeline (synthetic).' }),
  /* Settings › Imports index */
  'r1-imports-index': () => inSettings(settingsOwner, '/app/admin/imports', <ImportsIndexView entries={importIndexRows(access(['super_admin']))} />),
  'r1-imports-index-accounts': () => inSettings(accountsImporter, '/app/admin/imports', <ImportsIndexView entries={importIndexRows(access(['accounts']))} />),
};
