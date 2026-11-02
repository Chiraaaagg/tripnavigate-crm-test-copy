import type { ReactNode } from 'react';
import { SettingsShell } from './settings-preview-frame';
import type { InboxItemView, IntegrationStatusView } from '@/modules/integration/contracts';
import {
  type IntakeManifestSummary,
  type IntakeScopeView,
  IntegrationAdminView,
  IntegrationNoPermissionView,
} from '@/views/integration-views';
import type { LeadTab, LeadWorkspaceVM, RecordOwnerVM } from '@/modules/deals/workspace-contract';
import { type LeadListItem, type LeadListRowVM, type LeadSourceView, LeadNotFoundView, LeadsListScreen, LeadsNoPermissionView, LeadWorkspaceView } from '@/views/lead-views';
import { previewBuiltLead, previewLeadsProps, previewName } from './batch1-fixtures';
import type { LeadWorkspaceInput } from '@/modules/leads/record';
import { SubjectQuotationsCard } from '@/views/b12/quote-page';
import { previewQuoteSavedAction } from './b12-preview-actions';
import { quoteList } from './b12-quote-fixtures';
import type { NameReadStateView } from '@/modules/integration/name-map';
import { BitrixNamesCard } from '@/views/bitrix-names-card';
import { previewNamesRefuseAction, previewNamesSavedAction } from './names-preview-actions';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';

/*
 * Phase 6 design-review states: approved import list (manifest) on the Bitrix
 * sync page and read-only Bitrix Lead provenance. Synthetic props only
 * (example.test portal, made-up lead numbers, titles and names). Visual
 * evidence, not evidence of a real intake.
 */

const sales: ShellViewer = {
  displayName: 'Synthetic Sales Delhi A',
  primaryRole: 'Sales',
  primaryBranch: 'Delhi',
  canAdministerStaff: false,
  canManageGrants: false,
  canSeeLeads: true,
};
const manager: ShellViewer = { ...sales, displayName: 'Synthetic Manager Delhi', primaryRole: 'Manager', canSeeLeads: true, canSeePurchaseTasks: true };
const purchase: ShellViewer = {
  ...sales,
  displayName: 'Synthetic Purchase Jodhpur',
  primaryRole: 'Purchase',
  primaryBranch: 'Jodhpur',
  canSeePurchaseTasks: true,
  // Purchase (in any entity) never sees the Leads link (lead-screens contract §2, lead decision).
  canSeeLeads: false,
};
const admin: ShellViewer = {
  displayName: 'Synthetic Admin Jodhpur',
  primaryRole: 'Super Admin',
  primaryBranch: 'Jodhpur',
  canAdministerStaff: true,
  canManageGrants: true,
  canManageIntegration: true,
  canOpenBitrixConnection: true,
  canSeeLeads: true,
};

/** Fixed preview clock: 4 Oct 2026, 5:30 pm IST. */
const NOW = Date.parse('2026-10-04T12:00:00Z');

const zero: IntegrationStatusView['counts'] = {
  pending: 0, processing: 0, processed: 0, ignored: 0, needs_review: 0, failed: 0, dead_letter: 0,
};
const healthy: IntegrationStatusView = {
  configured: true,
  environment: 'operational',
  portalDomain: 'synthetic-portal.example.test',
  pilotBranchName: 'Delhi',
  cutoffAt: '2026-10-03T18:30:00Z',
  credentialPresent: true,
  workerSecretPresent: true,
  enabledConfigCount: 1,
  counts: { ...zero, processed: 5, ignored: 2, needs_review: 1 },
  lastProcessedAt: '2026-10-04T11:40:00Z',
  lastWorkerRunAt: '2026-10-04T11:56:00Z',
  lastWorkerOutcome: 'ok',
  oldestPendingAt: null,
  attention: [],
};

const manifest: IntakeManifestSummary = {
  status: 'active',
  sourceObject: 'lead',
  sourceCode: 'WEBFORM',
  sourceCodeLabel: 'CRM form',
  businessDate: '2026-10-04',
  intervalFrom: '2026-10-03T18:30:00Z',
  intervalTo: '2026-10-04T18:30:00Z',
  expectedCount: 8,
  createdByOperator: 'synthetic-operator',
  createdAt: '2026-10-04T10:50:00Z',
  closedAt: null,
  counts: { imported: 5, heldForReview: 1, failed: 0, excluded: 2 },
};
const scope = (m: Partial<IntakeManifestSummary> | null, lastSuccessfulSyncAt: string | null = '2026-10-04T11:40:00Z'): IntakeScopeView => ({
  manifest: m === null ? null : { ...manifest, ...m, counts: { ...manifest.counts, ...m.counts } },
  lastSuccessfulSyncAt,
});

function row(n: number, extra: Partial<InboxItemView>): InboxItemView {
  return {
    inboxId: `i6000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
    sourceObject: 'lead',
    status: 'needs_review',
    origin: 'event',
    eventType: 'ONCRMLEADADD',
    sourceDealId: `7006${String(n).padStart(2, '0')}`,
    receivedAt: '2026-10-04T11:10:00Z',
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

const leadAttention: InboxItemView[] = [
  row(1, { reasonCode: 'outside_manifest_scope' }),
  row(2, { reasonCode: 'unmapped_owner' }),
  row(3, { reasonCode: 'not_in_manifest', status: 'ignored', attempts: 0 }),
  // A pre-Phase 6 row without sourceObject reads as a Deal.
  row(4, { sourceObject: undefined, eventType: 'ONCRMDEALADD', sourceDealId: '900499', reasonCode: 'not_in_manifest', status: 'ignored', attempts: 0 }),
];
const failedRows: InboxItemView[] = [
  row(5, { status: 'failed', attempts: 3, lastErrorCode: 'provider_timeout', lastErrorAt: '2026-10-04T11:45:00Z', nextAttemptAt: '2026-10-04T12:05:00Z' }),
  row(6, { status: 'dead_letter', attempts: 8, lastErrorCode: 'internal_error', lastErrorAt: '2026-10-04T11:20:00Z' }),
];

const adminView = (status: IntegrationStatusView, s: IntakeScopeView | null) => (
  <SettingsShell viewer={admin} currentPath="/app/admin/integration">
    <IntegrationAdminView status={status} scope={s} now={NOW} />
  </SettingsShell>
);

const fresh: LeadSourceView = {
  system: 'bitrix',
  sourceLeadId: '700601',
  statusId: 'NEW',
  statusLabel: 'New lead',
  sourceCode: 'WEBFORM',
  sourceCodeLabel: 'CRM form',
  sourceCreatedAt: '2026-10-04T04:12:00Z',
  lastSyncedAt: '2026-10-04T11:10:00Z',
  lastVerifiedAt: '2026-10-04T11:40:00Z',
  stale: false,
};
const rawStale: LeadSourceView = {
  ...fresh,
  sourceLeadId: '700602',
  statusId: 'UC_SYN7',
  statusLabel: null,
  lastSyncedAt: '2026-10-02T06:00:00Z',
  lastVerifiedAt: '2026-10-03T06:00:00Z',
  stale: true,
};
const baseLead: LeadListItem = {
  id: 'l6000000-0000-4000-8000-000000000001',
  reference: 'BXL-700601',
  title: 'Synthetic enquiry form: Udaipur weekend',
  branchName: 'Delhi',
  relation: 'owner',
  source: fresh,
};
const salesLeads: LeadListItem[] = [
  baseLead,
  { ...baseLead, id: 'l6-2', reference: 'BXL-700602', title: 'Synthetic enquiry form: Shimla family trip', source: rawStale },
];
/** Synthetic keyset page: `count` leads numbered from `start` (BXL-<start>…). */
const pageOfLeads = (start: number, count = 200): LeadListItem[] =>
  Array.from({ length: count }, (_, index) => ({
    ...baseLead,
    id: `synthetic-page-${start + index}`,
    reference: `BXL-${start + index}`,
  }));
const NOW_ISO = new Date(NOW).toISOString();
const ownerFor = (relation: LeadListItem['relation']): RecordOwnerVM =>
  relation === 'owner' ? { kind: 'you' } : { kind: 'colleague', displayName: 'Synthetic Sales Delhi A' };
/** Batch 1 row for an older list fixture. `named` shows the state after Bitrix names are switched on. */
const leadRow = (lead: LeadListItem, named = false): LeadListRowVM => ({
  id: lead.id,
  reference: lead.reference,
  title: lead.title,
  status: previewName(lead.source.statusId, named ? lead.source.statusLabel : null),
  source: previewName(lead.source.sourceCode, named ? lead.source.sourceCodeLabel : null),
  owner: ownerFor(lead.relation),
  branchName: lead.branchName,
  createdInBitrixAt: lead.source.sourceCreatedAt,
  late: lead.source.stale,
  details: { sourceLeadId: lead.source.sourceLeadId, lastCheckedAt: lead.source.lastVerifiedAt, relation: lead.relation },
});
const managerLeads: LeadListItem[] = salesLeads.map((l) => ({ ...l, relation: 'branch_manager' }));
/** The Lead as loadLead returns it, for the builder (owner name only when the viewer may read it). */
const leadRecord = (lead: LeadListItem, ownerName: string | null = null): LeadWorkspaceInput['lead'] => ({
  id: lead.id,
  reference: lead.reference,
  title: lead.title,
  branchName: lead.branchName,
  relation: lead.relation,
  ownerName,
  source: {
    sourceLeadId: lead.source.sourceLeadId,
    statusId: lead.source.statusId,
    sourceCode: lead.source.sourceCode,
    sourceCreatedAt: lead.source.sourceCreatedAt,
    lastSyncedAt: lead.source.lastSyncedAt,
    lastVerifiedAt: lead.source.lastVerifiedAt,
    stale: lead.source.stale,
  },
});
/** Lead record exactly as the route builds it (buildLeadWorkspace); tab links point at the preview states. */
function leadWorkspace(lead: LeadListItem, current: LeadTab, opts: { quotations?: boolean; ownerName?: string | null } = {}): LeadWorkspaceVM {
  const stem = lead.source.stale ? 'p6-lead-raw-status-stale' : 'p6-lead-sales';
  return previewBuiltLead({ lead: leadRecord(lead, opts.ownerName ?? null), stem, tab: current, quotations: opts.quotations === false ? null : quoteList({ subjectId: lead.id }) });
}
/** The real Quotations card (SubjectQuotationsCard) with a stand-in create action. */
const quotationsCard = (lead: LeadListItem) => (
  <SubjectQuotationsCard list={quoteList({ subjectId: lead.id })} subjectId={lead.id} defaultTitle={lead.title} createAction={previewQuoteSavedAction} />
);
const leadsScreen = (rows: LeadListRowVM[], extra: Omit<Parameters<typeof previewLeadsProps>[0], 'rows'> = {}) => (
  <LeadsListScreen {...previewLeadsProps({ rows, ...extra })} now={NOW_ISO} />
);


/** The Bitrix sync page with the DEC-55 "Bitrix names" card under it. */
const namesPage = (viewer: ShellViewer, nameState: NameReadStateView, opts: { step?: 'choose' | 'review'; reason?: string; refused?: boolean } = {}) => (
  <SettingsShell viewer={viewer} currentPath="/app/admin/integration">
    <IntegrationAdminView status={healthy} scope={null} now={NOW} />
    <BitrixNamesCard
      state={nameState}
      action={opts.refused ? previewNamesRefuseAction : previewNamesSavedAction}
      initialStep={opts.step}
      initialReason={opts.reason}
      initialResult={opts.refused ? { ok: false, code: 'not_authorized', message: 'Only the Super Admin can change this setting. Nothing was changed.' } : null}
    />
  </SettingsShell>
);

const states: Record<string, () => ReactNode> = {
  'p6-sync-scope-active': () =>
    adminView({ ...healthy, counts: { ...healthy.counts, needs_review: 2, ignored: 2 }, attention: leadAttention }, scope({})),
  'p6-sync-scope-complete': () =>
    adminView(healthy, scope({ counts: { imported: 8, heldForReview: 0, failed: 0, excluded: 2 } })),
  'p6-sync-scope-failed': () =>
    adminView(
      { ...healthy, counts: { ...healthy.counts, failed: 1, dead_letter: 1, needs_review: 0 }, attention: failedRows },
      scope({ counts: { imported: 6, heldForReview: 0, failed: 2, excluded: 0 } }),
    ),
  'p6-sync-scope-stale': () =>
    adminView(
      { ...healthy, lastProcessedAt: '2026-10-03T08:00:00Z' },
      scope({ counts: { imported: 3, heldForReview: 0, failed: 0, excluded: 0 } }, '2026-10-03T08:00:00Z'),
    ),
  'p6-sync-scope-never-synced': () =>
    adminView({ ...healthy, lastProcessedAt: null }, scope({ counts: { imported: 0, heldForReview: 0, failed: 0, excluded: 0 } }, null)),
  'p6-sync-scope-closed': () =>
    adminView(healthy, scope({ status: 'closed', closedAt: '2026-10-04T11:58:00Z', counts: { imported: 8, heldForReview: 0, failed: 0, excluded: 3 } })),
  'p6-sync-scope-none': () => adminView({ ...healthy, counts: { ...zero, ignored: 4 } }, scope(null, null)),
  'p6-sync-scope-switched-off': () =>
    adminView({ ...healthy, configured: false, enabledConfigCount: 0 }, scope({ counts: { imported: 2, heldForReview: 0, failed: 0, excluded: 0 } })),
  'p6-sync-scope-unavailable': () => adminView(healthy, null),
  'p6-sync-scope-changed': () =>
    adminView(
      { ...healthy, counts: { ...healthy.counts, needs_review: 1 }, attention: [row(7, { reasonCode: 'scope_changed', eventType: 'ONCRMLEADUPDATE' })] },
      scope({ counts: { imported: 5, heldForReview: 1, failed: 0, excluded: 2 } }),
    ),
  // DEC-55: the "Bitrix names" card under the Bitrix sync page (Super Admin can change it).
  'names-switch-off-admin': () => namesPage(admin, { state: 'known', enabled: false, connectionEnabled: true, effective: false, canSwitch: true, lastChange: null }),
  'names-switch-on-admin': () =>
    namesPage(admin, {
      state: 'known',
      enabled: true,
      connectionEnabled: true,
      effective: true,
      canSwitch: true,
      lastChange: { at: '2026-10-04T09:30:00Z', byName: 'Synthetic Admin Jodhpur', via: 'command', to: true, reason: 'Synthetic: owner approved showing Bitrix names.' },
    }),
  'names-switch-review': () => namesPage(admin, { state: 'known', enabled: false, connectionEnabled: true, effective: false, canSwitch: true, lastChange: null }, { step: 'review', reason: 'Synthetic: owner approved showing Bitrix names.' }),
  'names-switch-refused': () =>
    namesPage(admin, { state: 'known', enabled: false, connectionEnabled: true, effective: false, canSwitch: true, lastChange: null }, {
      step: 'choose',
      reason: 'Synthetic: owner approved showing Bitrix names.',
      refused: true,
    }),
  'names-switch-read-only': () =>
    namesPage({ ...admin, displayName: 'Synthetic Integration Admin Delhi', primaryRole: 'Manager', canAdministerStaff: false, canManageGrants: false }, {
      state: 'known',
      enabled: false,
      connectionEnabled: true,
      effective: false,
      canSwitch: false,
      lastChange: { at: '2026-10-04T09:30:00Z', byName: null, via: 'direct_sql', to: false, reason: null },
    }),
  'names-switch-on-connection-off': () =>
    namesPage(admin, { state: 'known', enabled: true, connectionEnabled: false, effective: false, canSwitch: true, lastChange: null }),
  'names-switch-unknown': () => namesPage(admin, { state: 'unknown', reason: 'failed' }),
  'p6-sync-purchase-denied': () => (
    <SettingsShell viewer={purchase} currentPath="/app/admin/integration">
      <IntegrationNoPermissionView />
    </SettingsShell>
  ),
  'p6-leads-sales': () => (
    <StaffShell viewer={sales} currentPath="/app/leads">
      {leadsScreen(salesLeads.map((l) => leadRow(l)))}
    </StaffShell>
  ),
  'p6-leads-limited': () => (
    <StaffShell viewer={sales} currentPath="/app/leads">
      {leadsScreen(pageOfLeads(800000, 50).map((l) => leadRow(l)), { total: 160 })}
    </StaffShell>
  ),
  'p6-leads-page-middle': () => (
    <StaffShell viewer={sales} currentPath="/app/leads">
      {leadsScreen(pageOfLeads(800050, 50).map((l) => leadRow(l)), { total: 160, page: 2 })}
    </StaffShell>
  ),
  'p6-leads-page-last': () => (
    <StaffShell viewer={sales} currentPath="/app/leads">
      {leadsScreen(pageOfLeads(800150, 10).map((l) => leadRow(l)), { total: 160, page: 4 })}
    </StaffShell>
  ),
  'p6-leads-page-past-end': () => (
    <StaffShell viewer={sales} currentPath="/app/leads">
      {leadsScreen([], { total: 160, page: 5 })}
    </StaffShell>
  ),
  'p6-leads-manager': () => (
    <StaffShell viewer={manager} currentPath="/app/leads">
      {leadsScreen(managerLeads.map((l) => leadRow(l, true)), { mine: 0 })}
    </StaffShell>
  ),
  'p6-leads-empty': () => (
    <StaffShell viewer={sales} currentPath="/app/leads">
      {leadsScreen([])}
    </StaffShell>
  ),
  'p6-lead-sales': () => (
    <StaffShell viewer={sales} currentPath="/app/leads">
      <LeadWorkspaceView workspace={leadWorkspace(baseLead, 'overview')} />
    </StaffShell>
  ),
  'p6-lead-raw-status-stale': () => (
    <StaffShell viewer={sales} currentPath="/app/leads">
      <LeadWorkspaceView workspace={leadWorkspace({ ...salesLeads[1]!, relation: 'branch_manager' }, 'overview')} />
    </StaffShell>
  ),
  'p6-lead-sales-quotations': () => (
    <StaffShell viewer={sales} currentPath="/app/leads">
      <LeadWorkspaceView workspace={leadWorkspace(baseLead, 'quotations')} quotationsTab={quotationsCard(baseLead)} />
    </StaffShell>
  ),
  'p6-lead-sales-bitrix': () => (
    <StaffShell viewer={sales} currentPath="/app/leads">
      <LeadWorkspaceView workspace={leadWorkspace(baseLead, 'bitrix')} />
    </StaffShell>
  ),
  'p6-lead-raw-status-stale-bitrix': () => (
    <StaffShell viewer={sales} currentPath="/app/leads">
      <LeadWorkspaceView workspace={leadWorkspace({ ...salesLeads[1]!, relation: 'branch_manager' }, 'bitrix')} />
    </StaffShell>
  ),
  'p6-lead-raw-status-stale-quotations': () => (
    <StaffShell viewer={sales} currentPath="/app/leads">
      <LeadWorkspaceView workspace={leadWorkspace({ ...salesLeads[1]!, relation: 'branch_manager' }, 'quotations')} quotationsTab={quotationsCard(salesLeads[1]!)} />
    </StaffShell>
  ),
  'p6-lead-admin-no-quotations': () => (
    // Integration admin (Super Admin): no Quotations tab, no "New quotation".
    <StaffShell viewer={admin} currentPath="/app/leads">
      <LeadWorkspaceView workspace={leadWorkspace({ ...baseLead, relation: 'integration_admin' }, 'overview', { quotations: false, ownerName: 'Synthetic Sales Delhi A' })} />
    </StaffShell>
  ),
  'p6-leads-mine-empty': () => (
    <StaffShell viewer={manager} currentPath="/app/leads">
      {leadsScreen([], { filter: 'mine', total: 0, mine: 0 })}
    </StaffShell>
  ),
  'p6-leads-counts-unavailable': () => (
    <StaffShell viewer={sales} currentPath="/app/leads">
      {leadsScreen(salesLeads.map((l) => leadRow(l)), { total: null, mine: null })}
    </StaffShell>
  ),
  'p6-lead-not-found': () => (
    <StaffShell viewer={sales} currentPath="/app/leads">
      <LeadNotFoundView />
    </StaffShell>
  ),
  'p6-lead-purchase-denied': () => (
    <StaffShell viewer={purchase} currentPath="/app/leads">
      <LeadsNoPermissionView />
    </StaffShell>
  ),
  'p6-leads-purchase-denied': () => (
    <StaffShell viewer={purchase} currentPath="/app/leads">
      <LeadsNoPermissionView />
    </StaffShell>
  ),
};

export const LEAD_INTAKE_PREVIEW_STATES = Object.keys(states);

export function renderLeadIntakeState(state: string): ReactNode | null {
  return states[state]?.() ?? null;
}
