import type { ReactNode } from 'react';
import { SettingsShell } from './settings-preview-frame';
import type { DealDetail, DealListItem } from '@/modules/deals/dto';
import {
  type DealSourceView,
  type InboxItemView,
  type IntakeErrorCode,
  type IntakeReasonCode,
  type IntegrationStatusView,
} from '@/modules/integration/contracts';
import { IntegrationAdminView, IntegrationNoPermissionView } from '@/views/integration-views';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import { LegacyDealPage } from './deal-workspace-states';
import { DealsListScreen } from '@/views/deals-list-view';
import { previewDealsProps } from './batch1-fixtures';

/*
 * Phase 5 design-review states: imported Bitrix deals and sync problems.
 * Synthetic props only (example.test portal, made-up deal numbers and names).
 * Visual evidence, not evidence of a real intake.
 */

const sales: ShellViewer = {
  displayName: 'Synthetic Sales Delhi A',
  primaryRole: 'Sales',
  primaryBranch: 'Delhi',
  canAdministerStaff: false,
  canManageGrants: false,
};
const purchase: ShellViewer = {
  ...sales,
  displayName: 'Synthetic Purchase Jodhpur',
  primaryRole: 'Purchase',
  primaryBranch: 'Jodhpur',
  canSeePurchaseTasks: true,
};
const admin: ShellViewer = {
  displayName: 'Synthetic Admin Jodhpur',
  primaryRole: 'Super Admin',
  primaryBranch: 'Jodhpur',
  canAdministerStaff: true,
  canManageGrants: true,
  canManageIntegration: true,
  canOpenBitrixConnection: true,
};

/** Fixed preview clock so stale and worker states are deterministic. */
const NOW = Date.parse('2026-10-03T10:00:00Z');

const labelled: DealSourceView = {
  system: 'bitrix',
  sourceDealId: '900301',
  stageId: 'C1:PREPARATION',
  stageLabel: 'Quote sent',
  lastSyncedAt: '2026-10-03T08:40:00Z',
  lastVerifiedAt: '2026-10-03T09:45:00Z',
  stale: false,
};
const rawStage: DealSourceView = {
  ...labelled,
  sourceDealId: '900302',
  stageId: 'C1:UC_SYN42',
  stageLabel: null,
};
const stale: DealSourceView = {
  ...labelled,
  sourceDealId: '900303',
  stageId: 'C1:NEW',
  stageLabel: 'New enquiry',
  lastSyncedAt: '2026-09-30T06:00:00Z',
  lastVerifiedAt: '2026-10-01T06:00:00Z',
  stale: true,
};

const base: DealListItem = {
  id: 'd5000000-0000-4000-8000-000000000001',
  reference: 'BX-900301',
  title: 'Synthetic Bitrix enquiry Jaipur',
  branchName: 'Delhi',
  relation: 'owner',
  createdOn: '2026-10-02',
};
const salesDeals: DealListItem[] = [
  { ...base, source: labelled },
  { ...base, id: 'd5-2', reference: 'BX-900302', title: 'Synthetic Bitrix enquiry Goa', source: rawStage },
  { ...base, id: 'd5-3', reference: 'BX-900303', title: 'Synthetic Bitrix enquiry Kerala', source: stale },
];
const purchaseDeals: DealListItem[] = [{ ...base, id: 'd5-3', reference: 'BX-900303', title: 'Synthetic Bitrix enquiry Kerala', relation: 'assigned', source: stale }];

const salesDetail = (source: DealSourceView): DealDetail => ({
  ...base,
  reference: `BX-${source.sourceDealId}`,
  title: salesDeals.find((d) => d.source === source)?.title ?? base.title,
  assignments: [{ kind: 'purchase', isYou: false }],
  commercial: { visible: true, currency: 'INR', sellingTotal: '₹98,765.00', estimatedMargin: '₹9,876.00' },
  source,
});
const purchaseDetail: DealDetail = {
  ...base,
  reference: 'BX-900303',
  title: 'Synthetic Bitrix enquiry Kerala',
  relation: 'assigned',
  assignments: [{ kind: 'purchase', isYou: true }],
  commercial: { visible: false },
  commercialAbsence: 'withheld',
  source: stale,
};

const zero: IntegrationStatusView['counts'] = {
  pending: 0, processing: 0, processed: 0, ignored: 0, needs_review: 0, failed: 0, dead_letter: 0,
};
const healthy: IntegrationStatusView = {
  configured: true,
  environment: 'operational',
  portalDomain: 'synthetic-portal.example.test',
  pilotBranchName: 'Delhi',
  cutoffAt: '2026-10-01T00:00:00Z',
  credentialPresent: true,
  workerSecretPresent: true,
  enabledConfigCount: 1,
  counts: { ...zero, processed: 18, ignored: 4 },
  lastProcessedAt: '2026-10-03T09:45:00Z',
  lastWorkerRunAt: '2026-10-03T09:56:00Z',
  lastWorkerOutcome: 'ok',
  oldestPendingAt: null,
  attention: [],
};

function row(n: number, extra: Partial<InboxItemView>): InboxItemView {
  return {
    inboxId: `i5000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
    status: 'needs_review',
    origin: 'event',
    eventType: 'ONCRMDEALADD',
    sourceDealId: `9004${String(n).padStart(2, '0')}`,
    receivedAt: '2026-10-03T08:30:00Z',
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

/** The five problems an admin meets most: two owner fixes, a failed event, a dead letter and a rejected credential. */
const mixed: InboxItemView[] = [
  row(1, { reasonCode: 'unmapped_owner' }),
  row(2, { reasonCode: 'owner_not_in_pilot_branch', origin: 'reconcile', eventType: 'RECONCILE' }),
  row(3, {
    status: 'failed', attempts: 2, lastErrorCode: 'provider_timeout', lastErrorAt: '2026-10-03T09:40:00Z', nextAttemptAt: '2026-10-03T10:04:00Z',
  }),
  row(4, { status: 'dead_letter', attempts: 8, lastErrorCode: 'provider_unavailable', lastErrorAt: '2026-10-03T07:10:00Z' }),
  row(5, { status: 'dead_letter', attempts: 8, lastErrorCode: 'provider_auth_failed', lastErrorAt: '2026-10-03T09:30:00Z' }),
];

const reasonCodes: IntakeReasonCode[] = [
  'not_configured', 'environment_unset', 'not_eligible_category', 'not_eligible_stage', 'before_cutoff', 'unmapped_owner',
  'owner_not_in_pilot_branch', 'invalid_source_data', 'source_deal_not_found', 'stale_ignored', 'reference_conflict',
];
const errorCodes: IntakeErrorCode[] = [
  'provider_timeout', 'provider_unavailable', 'provider_rate_limited', 'provider_auth_failed', 'provider_bad_response', 'internal_error',
];
const IGNORED_REASONS = new Set<IntakeReasonCode>(['not_eligible_category', 'not_eligible_stage', 'before_cutoff', 'stale_ignored']);
const everyCode: InboxItemView[] = [
  ...reasonCodes.map((reasonCode, i) => row(10 + i, { reasonCode, status: IGNORED_REASONS.has(reasonCode) ? 'ignored' : 'needs_review' })),
  ...errorCodes.map((lastErrorCode, i) =>
    row(30 + i, {
      lastErrorCode,
      status: 'failed',
      attempts: 3,
      lastErrorAt: '2026-10-03T09:20:00Z',
      nextAttemptAt: '2026-10-03T10:10:00Z',
    }),
  ),
];

const adminView = (status: IntegrationStatusView) => (
  <SettingsShell viewer={admin} currentPath="/app/admin/integration">
    <IntegrationAdminView status={status} now={NOW} />
  </SettingsShell>
);

const states: Record<string, () => ReactNode> = {
  'intake-deals-sales': () => (
    <StaffShell viewer={sales} currentPath="/app/deals">
      <DealsListScreen {...previewDealsProps({ items: salesDeals })} now={new Date(NOW).toISOString()} />
    </StaffShell>
  ),
  'intake-deal-sales': () => (
    <StaffShell viewer={sales} currentPath="/app/deals">
      <LegacyDealPage stem="intake-deal-sales" detail={salesDetail(labelled)} />
    </StaffShell>
  ),
  'intake-deal-sales-raw-stage': () => (
    <StaffShell viewer={sales} currentPath="/app/deals">
      <LegacyDealPage stem="intake-deal-sales-raw-stage" detail={salesDetail(rawStage)} />
    </StaffShell>
  ),
  'intake-deal-sales-stale': () => (
    <StaffShell viewer={sales} currentPath="/app/deals">
      <LegacyDealPage stem="intake-deal-sales-stale" detail={salesDetail(stale)} />
    </StaffShell>
  ),
  'intake-deal-sales-stale-money': () => (
    <StaffShell viewer={sales} currentPath="/app/deals">
      <LegacyDealPage stem="intake-deal-sales-stale" current="money" detail={salesDetail(stale)} />
    </StaffShell>
  ),
  'intake-deals-purchase': () => (
    <StaffShell viewer={purchase} currentPath="/app/deals">
      <DealsListScreen {...previewDealsProps({ items: purchaseDeals })} now={new Date(NOW).toISOString()} />
    </StaffShell>
  ),
  'intake-deal-purchase': () => (
    <StaffShell viewer={purchase} currentPath="/app/deals">
      <LegacyDealPage stem="intake-deal-purchase" detail={purchaseDetail} />
    </StaffShell>
  ),
  'intake-sync-healthy': () => adminView(healthy),
  'intake-sync-problems': () =>
    adminView({ ...healthy, counts: { ...healthy.counts, needs_review: 2, failed: 1, dead_letter: 2 }, attention: mixed }),
  'intake-sync-auth-failed': () =>
    adminView({
      ...healthy,
      lastWorkerOutcome: 'provider_error',
      counts: { ...healthy.counts, dead_letter: 1 },
      attention: [mixed[4]!],
    }),
  'intake-sync-worker-down': () =>
    adminView({
      ...healthy,
      lastWorkerRunAt: '2026-10-03T06:00:00Z',
      oldestPendingAt: '2026-10-03T06:20:00Z',
      counts: { ...healthy.counts, pending: 6 },
    }),
  'intake-sync-every-code': () =>
    adminView({ ...healthy, counts: { ...healthy.counts, needs_review: 7, failed: errorCodes.length }, attention: everyCode }),
  'intake-sync-sales-denied': () => (
    <SettingsShell viewer={sales} currentPath="/app/admin/integration">
      <IntegrationNoPermissionView />
    </SettingsShell>
  ),
  'intake-sync-purchase-denied': () => (
    <SettingsShell viewer={purchase} currentPath="/app/admin/integration">
      <IntegrationNoPermissionView />
    </SettingsShell>
  ),
};

export const INTAKE_PREVIEW_STATES = Object.keys(states);

export function renderIntakeState(state: string): ReactNode | null {
  return states[state]?.() ?? null;
}
