import type { ReactNode } from 'react';
import type { IntegrationStatusView } from '@/modules/integration/contracts';
import { featureRows, liveRows } from '@/modules/settings/rows';
import { bitrixPageModel, featuresPageModel, type SyncStateModel } from '@/modules/settings/server/queries';
import { syncReview } from '@/modules/settings/sync-scope';
import { settingsOverviewRows, type OverviewFacts } from '@/modules/settings/contracts';
import { SETTINGS_TEXT } from '@/modules/settings/text';
import { Notice } from '@/components/ui/notice';
import type { RecoveryCase, StaffEmailDelivery, StaffSecurityInfo } from '@/modules/identity/contracts';
import { SettingsOverviewView } from '@/views/settings/settings-overview';
import { AccessGrantsView, PeopleNoPermissionView, RolesAndBranchesView, StaffAdminView, type StaffLine } from '@/views/settings/people-views';
import type { GrantLine } from '@/views/staff-views';
import { WonOnlyCard } from '@/views/b11/won-only-card';
import { BookingHealthPage } from '@/views/booking-health-views';
import { IntegrationAdminView } from '@/views/integration-views';
import { CompanyBranchesErrorView, CompanyBranchesNoPermissionView, CompanyBranchesView } from '@/views/settings/company-view';
import { SyncScopeSection } from '@/views/settings/sync-scope-form';
import { type ShellViewer } from '@/views/StaffShell';
import { FeaturesSettingsView, IdProofCopyAlertsCard } from '@/views/workflow-views';
import { previewB11PruneDryRunAction, previewB11WonOnlySavedAction } from './b11-preview-actions';
import { bitrixSection, companyModel, FEATURES_ALL_KNOWN, liveSection, switchStates, SYNTHETIC_PIPELINES, workflowSection } from './batch4-settings-fixtures';
import {
  previewSwitchNotAuthorizedAction,
  previewSwitchSavedAction,
  previewSyncApplyAction,
  previewSyncApplyStaleAction,
  previewSyncPreviewAction,
  previewVisaCountAction,
  previewVisaUncountedAction,
} from './batch4-settings-preview-actions';
import { inSettings, previewSettingsTabs, settingsIntegrationOnly, settingsOwner, settingsStaffOnly } from './settings-preview-frame';

/*
 * Batch 4 preview states: Settings (Direction A R6). Synthetic props only;
 * rendered by the design-review gallery (page.tsx), never in production.
 * Each state is a Settings page as the admin layout renders it (staff frame,
 * Settings frame with the viewer's tabs, then the page).
 */

const FEATURES = '/app/admin/workflow';
const BITRIX = '/app/admin/integration';
const COMPANY = '/app/admin/company';
const HEALTH = '/app/admin/bookings';

const switchActions = { change: previewSwitchSavedAction, previewVisa: previewVisaCountAction };
const salesViewer: ShellViewer = { displayName: 'Synthetic Sales Delhi A', primaryRole: 'Sales', primaryBranch: 'Delhi', canAdministerStaff: false, canManageGrants: false };

const NOW = Date.parse('2026-10-23T10:00:00Z');
const status: IntegrationStatusView = {
  configured: true,
  environment: 'test',
  portalDomain: 'synthetic-portal.example.test',
  pilotBranchName: 'Jodhpur',
  cutoffAt: '2026-08-31T18:30:00Z',
  credentialPresent: true,
  workerSecretPresent: true,
  enabledConfigCount: 1,
  counts: { pending: 0, processing: 0, processed: 58, ignored: 4, needs_review: 0, failed: 0, dead_letter: 0 },
  lastProcessedAt: '2026-10-23T09:59:10Z',
  lastWorkerRunAt: '2026-10-23T09:59:40Z',
  lastWorkerOutcome: 'ok',
  oldestPendingAt: null,
  attention: [],
  crmDeals: 58,
  bitrixNow: 58,
  keptOutsideStages: 0,
  syncEnabled: true,
  categoryIds: ['0', '7'],
  stageIds: ['NEW', 'WON', 'C7:NEW'],
  lastRun: { at: '2026-10-23T09:59:40Z', fetched: 2, created: 0, updated: 2 },
  autoSync: { cronInstalled: true, jobActive: true, enabled: true, lastCalls: [{ at: '2026-10-23T09:59:30Z', statusCode: 200, ok: true, reason: null }], failingSince: null, lastSuccessAt: '2026-10-23T09:59:40Z' },
};

const syncActions = { preview: previewSyncPreviewAction, apply: previewSyncApplyAction };

function bitrixPage(opts: { states?: Parameters<typeof bitrixPageModel>[0]; sync?: 'full' | 'none'; apply?: typeof previewSyncApplyAction } = {}): ReactNode {
  const page = bitrixPageModel(opts.states ?? switchStates(), { openStops: 0 });
  return (
    <IntegrationAdminView
      status={status}
      now={NOW}
      pipelines={SYNTHETIC_PIPELINES}
      emailAlertsConfigured={false}
      switches={page.switches}
      switchActions={{ change: previewSwitchSavedAction }}
      sync={opts.sync === 'none' ? undefined : { model: page.sync, text: page.syncText, preview: previewSyncPreviewAction, apply: opts.apply ?? previewSyncApplyAction }}
    >
      <IdProofCopyAlertsCard alerts={{ stops: [], manualChecks: [] }} />
      <WonOnlyCard rule={null} stageOptions={[]} setAction={previewB11WonOnlySavedAction} dryRunAction={previewB11PruneDryRunAction} runAction={previewB11PruneDryRunAction} />
    </IntegrationAdminView>
  );
}

function syncOnly(model: SyncStateModel | null, opts: { text?: string | null; installed?: boolean; review?: boolean; apply?: typeof previewSyncApplyAction } = {}): ReactNode {
  const review = opts.review
    ? syncReview(
        { categoryIds: ['0'], stageIds: ['NEW', 'WON'], cutoff: '2026-09-01', syncEnabled: true },
        {
          previewId: '0b4e0000-0000-4000-8000-000000000001',
          expiresAt: '2026-10-23T10:10:00.000Z',
          changed: true,
          current: null as never,
          proposed: null as never,
          hide: { total: 12, beforeSyncDate: 0, pipelineNotEligible: 9, stageNotEligible: 3, withCrmWork: 2 },
          bringBack: 1,
          recheck: 4,
          autoSyncChange: 'none',
        },
      )
    : null;
  return (
    <SyncScopeSection
      configured
      pipelines={SYNTHETIC_PIPELINES}
      directoryError={null}
      model={model}
      text={opts.text ?? null}
      installed={opts.installed ?? true}
      actions={{ ...syncActions, ...(opts.apply ? { apply: opts.apply } : {}) }}
      initialReview={review}
      initialReason={review ? 'Owner APPROVE on 23 Oct: stop the corporate pipeline (synthetic).' : ''}
    />
  );
}

const syncModel = (over: Partial<SyncStateModel> = {}): SyncStateModel => ({ ...bitrixPageModel(switchStates()).sync!, ...over });

// ---------------------------------------------------------------------------
// R1 Settings frame, Overview and People and access (helper S1). Synthetic.
// ---------------------------------------------------------------------------

const OVERVIEW = '/app/admin';
const STAFF = '/app/admin/staff';
const ACCESS = '/app/admin/access';

const OVERVIEW_FACTS: OverviewFacts = {
  people: { active: 14, invited: 2 },
  company: { missingGstin: ['Ahmedabad', 'Delhi'], notApproved: 0 },
  money: { on: 3, total: 4 },
  bitrix: { autoSync: 'on' },
  features: { on: 4, total: 5, unknown: 0 },
  messages: { on: 4, total: 18, pilotOnly: true, pilotDeals: 2, keysMissing: 1 },
  health: { realBooking: 'off' },
};
const OVERVIEW_UNKNOWN: OverviewFacts = { people: 'unknown', company: 'unknown', money: 'unknown', bitrix: 'unknown', features: 'unknown', messages: 'unknown', health: 'unknown' };

function overview(viewer: ShellViewer, facts: OverviewFacts): ReactNode {
  const tabs = previewSettingsTabs(viewer);
  return inSettings(viewer, OVERVIEW, <SettingsOverviewView rows={settingsOverviewRows(tabs, facts)} tabs={tabs} />);
}

const accountsImporter: ShellViewer = { displayName: 'Synthetic Accounts Jodhpur', primaryRole: 'Accounts', primaryBranch: 'Jodhpur', canAdministerStaff: false, canManageGrants: false, canImport: true };

const PEOPLE_BRANCHES = [
  { value: 'b-amd', label: 'Ahmedabad' },
  { value: 'b-del', label: 'Delhi' },
  { value: 'b-jdh', label: 'Jodhpur (head office)' },
];
const PEOPLE_ROLES = ['Accounts', 'Flight', 'Manager', 'Purchase', 'Sales', 'Super Admin', 'Visa'].map((r) => ({ value: r, label: r }));
const PEOPLE: StaffLine[] = [
  { userId: 's-you', displayName: 'Synthetic Owner Jodhpur', email: 'owner.jodhpur@example.test', status: 'active', access: ['Super Admin, Jodhpur'], isYou: true },
  { userId: 's-sales', displayName: 'Synthetic Sales Delhi A', email: 'sales.delhi.a@example.test', status: 'active', access: ['Sales, Delhi', 'Manager, Delhi'], isYou: false },
  { userId: 's-recover', displayName: 'Synthetic Recovery Failed', email: 'recovery.failed@example.test', status: 'active', access: ['Purchase, Jodhpur'], isYou: false },
  { userId: 's-invited', displayName: 'Synthetic Invited Staff', email: 'invited.staff.with.a.very.long.address@example.test', status: 'invited', access: ['Visa, Ahmedabad'], isYou: false },
  { userId: 's-former', displayName: 'Synthetic Former Staff', email: 'former.staff@example.test', status: 'inactive', access: [], isYou: false },
];
const emailOf = (userId: string, status: StaffEmailDelivery['status'], extra: Partial<StaffEmailDelivery> = {}): StaffEmailDelivery => ({
  deliveryId: `e-${userId}`,
  userId,
  invitationId: null,
  kind: 'invitation',
  status,
  attemptNo: 1,
  errorCode: null,
  createdAt: '2026-11-10T08:00:00Z',
  completedAt: status === 'pending' ? null : '2026-11-10T08:00:02Z',
  ...extra,
});
const failedCase: RecoveryCase = {
  caseId: 'c-s-recover',
  userId: 's-recover',
  status: 'provider_failed',
  providerAttempts: 3,
  lastProviderError: 'provider_unavailable:503',
  openedAt: '2026-11-10T09:30:00Z',
  openedBy: 's-you',
  completedAt: null,
};
const PEOPLE_SECURITY: Record<string, StaffSecurityInfo> = {
  's-sales': { recovery: null, lastEmail: emailOf('s-sales', 'handed_to_provider', { kind: 'password_reset' }) },
  's-recover': { recovery: failedCase, lastEmail: emailOf('s-recover', 'failed', { kind: 'password_reset', errorCode: 'smtp_rejected', attemptNo: 2 }) },
  's-invited': { recovery: null, lastEmail: emailOf('s-invited', 'pending', { kind: 'invitation_resend', attemptNo: 2 }) },
};
const PEOPLE_METHODS = [{ code: 'SYNTHETIC_TEST_CALLBACK', label: 'Synthetic test callback (local and CI only)' }];
const BOTH = { staff: true, access: true };

function staffPage(over: Partial<Parameters<typeof StaffAdminView>[0]> = {}): ReactNode {
  return (
    <StaffAdminView
      staff={PEOPLE}
      branches={PEOPLE_BRANCHES}
      roles={PEOPLE_ROLES}
      inviteDomains={['example.test']}
      security={PEOPLE_SECURITY}
      verificationMethods={PEOPLE_METHODS}
      sectionLinks={BOTH}
      {...over}
    />
  );
}

const GRANTS: GrantLine[] = [
  { id: 'g1', staffName: 'Synthetic Manager Delhi', permissionLabel: 'View deals', scopeLabel: 'Delhi branch', reason: 'SYNTHETIC FIXTURE: Delhi branch read scope for tests', grantedOn: '2026-11-01', expiresOn: null },
  { id: 'g2', staffName: 'Synthetic Accounts Jodhpur', permissionLabel: 'See prices and margin', scopeLabel: 'Whole entity (Holiday Chacha Pvt LTD)', reason: 'SYNTHETIC FIXTURE: entity-wide commercial scope for tests', grantedOn: '2026-11-01', expiresOn: '2026-12-31' },
];
function accessPage(over: Partial<Parameters<typeof AccessGrantsView>[0]> = {}): ReactNode {
  return (
    <AccessGrantsView
      grants={GRANTS}
      staff={[{ value: 's-sales', label: 'Synthetic Sales Delhi A' }]}
      entities={[{ value: 'e1', label: 'Holiday Chacha Pvt LTD' }]}
      branches={PEOPLE_BRANCHES}
      sectionLinks={BOTH}
      {...over}
    />
  );
}

const R1_STATES: Record<string, () => ReactNode> = {
  // Overview landing (N7)
  'settings-overview': () => overview(settingsOwner, OVERVIEW_FACTS),
  'settings-overview-unknown': () => overview(settingsOwner, OVERVIEW_UNKNOWN),
  'settings-overview-staff-only': () => overview(settingsStaffOnly, { people: { active: 3, invited: 0 }, company: { missingGstin: [], notApproved: 0 } }),
  // Frame: one area only (Accounts with Imports), no Overview and no list beyond it
  'settings-frame-one-area': () =>
    inSettings(
      accountsImporter,
      '/app/admin/imports',
      <Notice tone="info">
        <p>The Imports page appears here (frame preview only).</p>
      </Notice>,
    ),
  // People and access › Staff (S9, S10)
  'settings-staff': () => inSettings(settingsOwner, STAFF, staffPage()),
  'settings-staff-invited-only': () => inSettings(settingsOwner, `${STAFF}?status=invited`, staffPage({ filter: { status: 'invited' } })),
  'settings-staff-no-match': () => inSettings(settingsOwner, `${STAFF}?q=nobody`, staffPage({ filter: { q: 'nobody' } })),
  'settings-staff-invite-open': () => inSettings(settingsOwner, STAFF, staffPage({ inviteOpen: true })),
  'settings-staff-invite-refused': () =>
    inSettings(settingsOwner, STAFF, staffPage({ inviteOpen: true, inviteState: { status: 'error', message: 'This email address cannot be invited in this environment.' } })),
  'settings-staff-only-admin': () => inSettings(settingsStaffOnly, STAFF, staffPage({ sectionLinks: { staff: true, access: false } })),
  'settings-staff-no-permission': () => inSettings(salesViewer, STAFF, <PeopleNoPermissionView section="staff" />),
  // Roles and branches (D8 deferred: read only)
  'settings-staff-roles': () => inSettings(settingsOwner, `${STAFF}?tab=roles`, <RolesAndBranchesView staff={PEOPLE} sectionLinks={BOTH} />),
  // Extra access
  'settings-access': () => inSettings(settingsOwner, ACCESS, accessPage()),
  'settings-access-empty': () => inSettings(settingsOwner, ACCESS, accessPage({ grants: [] })),
  'settings-access-grant-open': () => inSettings(settingsOwner, ACCESS, accessPage({ grantOpen: true })),
};

export const R1_SETTINGS_STATES = Object.keys(R1_STATES);

const STATES: Record<string, () => ReactNode> = {
  ...R1_STATES,
  // Features (DA-256 to DA-258)
  'settings-features': () => inSettings(settingsOwner, FEATURES, <FeaturesSettingsView model={featuresPageModel(switchStates())} actions={switchActions} bitrixHref={BITRIX} />),
  'settings-features-visa-uncounted': () =>
    inSettings(settingsOwner, FEATURES, <FeaturesSettingsView model={featuresPageModel(switchStates())} actions={{ change: previewSwitchSavedAction, previewVisa: previewVisaUncountedAction }} bitrixHref={BITRIX} />),
  'settings-features-refused': () => inSettings(settingsOwner, FEATURES, <FeaturesSettingsView model={featuresPageModel(switchStates())} actions={{ change: previewSwitchNotAuthorizedAction }} bitrixHref={BITRIX} />),
  'settings-features-unknown': () => {
    const { visa_passport_tasks_enabled: _visa, ...known } = FEATURES_ALL_KNOWN;
    void _visa;
    return inSettings(settingsOwner, FEATURES, <FeaturesSettingsView model={featuresPageModel(switchStates({ workflow: workflowSection(known) }))} actions={switchActions} bitrixHref={BITRIX} />);
  },
  'settings-features-unreadable': () => inSettings(settingsOwner, FEATURES, <FeaturesSettingsView model={{ features: featureRows('error'), live: liveRows('error') }} actions={switchActions} bitrixHref={BITRIX} />),
  'settings-features-not-installed': () =>
    inSettings(settingsOwner, FEATURES, <FeaturesSettingsView model={{ features: featureRows('not_installed'), live: liveRows('not_installed') }} actions={switchActions} bitrixHref={BITRIX} />),
  'settings-features-read-only': () =>
    inSettings(settingsIntegrationOnly, FEATURES, <FeaturesSettingsView model={{ features: featureRows(workflowSection(FEATURES_ALL_KNOWN, { canSwitch: false }), { tripFactsRead: 'on' }), live: liveRows(null) }} actions={switchActions} bitrixHref={BITRIX} />),

  // Bitrix connection (DA-257, DA-259, DA-260)
  'settings-bitrix': () => inSettings(settingsOwner, BITRIX, bitrixPage()),
  'settings-bitrix-integration-only': () => inSettings(settingsIntegrationOnly, BITRIX, bitrixPage({ states: switchStates({ workflow: null, live: null, bitrix: bitrixSection({ canSwitch: false }) }) })),
  'settings-bitrix-sync-not-installed': () => inSettings(settingsOwner, BITRIX, bitrixPage({ sync: 'none' })),
  'settings-bitrix-sync-review': () => inSettings(settingsOwner, BITRIX, syncOnly(syncModel(), { review: true })),
  'settings-bitrix-sync-stale': () => inSettings(settingsOwner, BITRIX, syncOnly(syncModel(), { review: true, apply: previewSyncApplyStaleAction })),
  'settings-bitrix-sync-unknown': () => inSettings(settingsOwner, BITRIX, syncOnly(null, { text: SETTINGS_TEXT.unknownSection })),
  'settings-bitrix-sync-read-only': () => inSettings(settingsOwner, BITRIX, syncOnly(syncModel({ canManageSync: false }))),
  'settings-bitrix-sync-auto-unknown': () => inSettings(settingsOwner, BITRIX, syncOnly(syncModel({ autoSync: 'unknown', current: { ...syncModel().current, syncEnabled: null } }))),

  // Company and branches (DA-261)
  'settings-company': () => inSettings(settingsOwner, COMPANY, <CompanyBranchesView model={companyModel('yes')} />),
  'settings-company-pilot-unknown': () => inSettings(settingsStaffOnly, COMPANY, <CompanyBranchesView model={companyModel('unknown')} />),
  'settings-company-error': () => inSettings(settingsOwner, COMPANY, <CompanyBranchesErrorView />),
  'settings-company-no-permission': () => inSettings(salesViewer, COMPANY, <CompanyBranchesNoPermissionView />),

  // System health (DA-262)
  'settings-health': () =>
    inSettings(
      settingsOwner,
      HEALTH,
      <BookingHealthPage
        health={{ environment: 'test', realBookingEnabled: false, drafts: 4, draftsNeedingRepair: 1, confirmed: 9, tasksNotStarted: 2, tasksInProgress: 3, pendingOutboxEvents: 6 }}
        live={liveRows(liveSection)}
        pdfMaker={{ on: false }}
        emailAlertsConfigured={false}
        bitrix={{ label: 'Receiving deals', tone: 'ok' }}
        bitrixHref={BITRIX}
      />,
    ),
  'settings-health-unknown': () =>
    inSettings(settingsIntegrationOnly, HEALTH, <BookingHealthPage health={null} live={liveRows('error')} pdfMaker={{ on: null }} emailAlertsConfigured={true} bitrix={null} bitrixHref={BITRIX} />),
};

export const BATCH4_SETTINGS_STATES = Object.keys(STATES);

export function renderBatch4SettingsState(state: string): ReactNode | null {
  return STATES[state]?.() ?? null;
}
