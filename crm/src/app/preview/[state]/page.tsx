import { notFound } from 'next/navigation';
import { SettingsShell } from './settings-preview-frame';
import QRCode from 'qrcode';
import type { ReactNode } from 'react';
import AppLoading from '@/app/app/loading';
import { AuthCard } from '@/components/AuthCard';
import { isUiPreviewEnabled } from '@/lib/config';
import type { DealDetail, DealListItem } from '@/modules/deals/dto';
import type {
  OwnRecoveryView,
  RecoveryCase,
  StaffEmailDelivery,
  StaffSecurityInfo,
  VerificationMethodOption,
} from '@/modules/identity/contracts';
import {
  ForgotPasswordForm,
  MfaChallengeForm,
  MfaEnrollForm,
  PasswordForm,
  PASSWORD_RESET_GENERIC_MESSAGE,
  SignInForm,
} from '@/views/auth-forms';
import type { DealSourceView, InboxItemView, IntegrationStatusView } from '@/modules/integration/contracts';
import { IntegrationAdminView, IntegrationNoPermissionView } from '@/views/integration-views';
import { AccountRecoveryView } from '@/views/recovery-views';
import { DealsListLoading, DealsListScreen } from '@/views/deals-list-view';
import { previewDealsProps } from './batch1-fixtures';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import {
  AccessGrantsView,
  DealNotFoundView,
  HomeView,
  MyAccessView,
  StaffAdminView,
  type StaffLine,
} from '@/views/staff-views';
import { FinishOnboardingView } from '@/views/status-views';
import { NO_HOME_ROLES } from '@/views/home-view';
import type { MyWorkCounts } from '@/modules/fulfilment/contracts';
import { PreviewStaffError } from './preview-error';
import { renderB1State } from './b1-states';
import { LegacyDealPage, renderDealWorkspaceState } from './deal-workspace-states';
import { renderB11BookState } from './b11-states';
import { renderBookformState } from './bookform-states';
import { renderVnState } from './vn-states';
import { renderB12ItinState } from './b12-itin-states';
import { renderB12QuoteState } from './b12-quote-states';
import { renderBatch3State } from './batch3-states';
import { renderBatch4AccountsState } from './batch4-accounts-states';
import { renderBatch4DeptState } from './batch4-dept-states';
import { renderBatch4SettingsState } from './batch4-settings-states';
import { renderBatch5SearchState } from './batch5-search-states';
import { renderB11WorkState } from './b11-work-states';
import { renderBookingState } from './booking-states';
import { renderFinanceState } from './finance-states';
import { renderIntakeState } from './intake-states';
import { renderLeadIntakeState } from './lead-intake-states';
import { renderProcurementState } from './procurement-states';

/**
 * LOCAL DESIGN-REVIEW GALLERY. Renders the real view components with synthetic
 * props so reviewers can screenshot signed-in states without a live Supabase
 * stack. It performs no authentication and reads no data. It returns 404 unless
 * APP_ENV=local, NODE_ENV=development and ENABLE_UI_PREVIEW=true (see
 * isUiPreviewEnabled, unit-tested), so it can never serve on Vercel.
 */

export const dynamic = 'force-dynamic';

const sales: ShellViewer = {
  displayName: 'Synthetic Sales Delhi A',
  primaryRole: 'Sales',
  primaryBranch: 'Delhi',
  canAdministerStaff: false,
  canManageGrants: false,
};
const purchase: ShellViewer = { ...sales, displayName: 'Synthetic Purchase Jodhpur', primaryRole: 'Purchase', primaryBranch: 'Jodhpur' };
const manager: ShellViewer = { ...sales, displayName: 'Synthetic Manager Delhi', primaryRole: 'Manager', canSeeLeads: true, canSeePurchaseTasks: true };
const admin: ShellViewer = {
  displayName: 'Synthetic Admin Jodhpur',
  primaryRole: 'Super Admin',
  primaryBranch: 'Jodhpur',
  canAdministerStaff: true,
  canManageGrants: true,
};

// Direction A R0: synthetic "What needs you" counts (my_work_counts shape) and a multi-role viewer.
const salesWork: MyWorkCounts = { waitingForMe: 3, returnedToMe: 1, missingDetails: 2, intakeNeeded: 0, receiptsToVerify: null, requestsToApprove: null, claimsToProcess: null, expensesToReview: null, visaTasksWaiting: null };
const quietWork: MyWorkCounts = { waitingForMe: 0, returnedToMe: 0, missingDetails: 0, intakeNeeded: 0, receiptsToVerify: null, requestsToApprove: null, claimsToProcess: null, expensesToReview: null, visaTasksWaiting: null };
const accountsWork: MyWorkCounts = { waitingForMe: 4, returnedToMe: 0, missingDetails: 0, intakeNeeded: 0, receiptsToVerify: 2, requestsToApprove: null, claimsToProcess: 1, expensesToReview: 0, visaTasksWaiting: null };
const managerWork: MyWorkCounts = { waitingForMe: 5, returnedToMe: 0, missingDetails: 1, intakeNeeded: 2, receiptsToVerify: null, requestsToApprove: 0, claimsToProcess: null, expensesToReview: null, visaTasksWaiting: null };
const multiRole: ShellViewer = {
  displayName: 'Synthetic Sales Purchase Jodhpur',
  primaryRole: 'Sales',
  primaryBranch: 'Jodhpur',
  memberships: [
    { roleName: 'Sales', branchName: 'Jodhpur', isHeadOffice: true },
    { roleName: 'Purchase', branchName: 'Delhi', isHeadOffice: false },
  ],
  canAdministerStaff: false,
  canManageGrants: false,
  canSeePurchaseTasks: true,
};
const ownerAdmin: ShellViewer = {
  displayName: 'Synthetic Owner Jodhpur',
  primaryRole: 'Super Admin',
  primaryBranch: 'Jodhpur',
  canAdministerStaff: true,
  canManageGrants: true,
  canManageIntegration: true,
  canOpenBitrixConnection: true,
  canSeeLeads: true,
  canManageFinancePolicy: true,
};

const deal001: DealListItem = {
  id: 'd0000000-0000-4000-8000-000000000001',
  reference: 'SYN-DEL-001',
  title: 'Synthetic package A (Delhi)',
  branchName: 'Delhi',
  relation: 'owner',
  createdOn: '2026-10-01',
};
const managerDeals: DealListItem[] = [
  { ...deal001, relation: 'scope' },
  { ...deal001, id: 'd2', reference: 'SYN-DEL-002', title: 'Synthetic package B (Delhi)', relation: 'scope' },
  { ...deal001, id: 'd3', reference: 'SYN-DEL-003', title: 'Synthetic package D (former staff)', relation: 'scope' },
];
const salesDetail: DealDetail = {
  ...deal001,
  assignments: [{ kind: 'purchase', isYou: false }],
  commercial: { visible: true, currency: 'INR', sellingTotal: '₹1,23,456.00', estimatedMargin: '₹11,111.00' },
};
const purchaseDetail: DealDetail = {
  ...deal001,
  relation: 'assigned',
  assignments: [{ kind: 'purchase', isYou: true }],
  commercial: { visible: false },
  commercialAbsence: 'withheld',
};
// Phase 2: synthetic Bitrix provenance and integration states (no real portal, deal or person).
const freshSource: DealSourceView = {
  system: 'bitrix',
  sourceDealId: '900101',
  stageId: 'C1:NEW',
  lastSyncedAt: '2026-10-01T09:15:00Z',
  lastVerifiedAt: '2026-10-01T09:50:00Z',
  stale: false,
};
const staleSource: DealSourceView = {
  ...freshSource,
  sourceDealId: '900102',
  lastSyncedAt: '2026-09-27T06:00:00Z',
  lastVerifiedAt: '2026-09-28T06:00:00Z',
  stale: true,
};
const bitrixDeals: DealListItem[] = [
  { ...deal001, id: 'b1', reference: 'BX-900101', title: 'Synthetic Bitrix enquiry A', source: freshSource },
  { ...deal001, id: 'b2', reference: 'BX-900102', title: 'Synthetic Bitrix enquiry B', source: staleSource },
  deal001,
];
// Lagoon Deals list (screen group 3): one row of each kind, all made up.
const mixedDeals: DealListItem[] = [
  { ...deal001, id: 'm1', reference: 'BX-900420', title: 'Synthetic honeymoon, Andaman (6 nights)', relation: 'owner', source: { ...freshSource, sourceDealId: '900420', stageLabel: 'Quote sent' } },
  { ...deal001, id: 'm2', reference: 'BX-900418', title: 'Synthetic family trip, Kerala', relation: 'assigned', ownerName: 'Synthetic Sales Delhi B', source: { ...freshSource, sourceDealId: '900418', stageId: 'C1:UC_SYN7' } },
  { ...deal001, id: 'm3', reference: 'BX-900415', title: 'Synthetic group tour, Rajasthan', relation: 'scope', ownerName: 'Synthetic Sales Delhi C', source: { ...staleSource, sourceDealId: '900415', stageLabel: 'Negotiation' } },
  { ...deal001, id: 'm4', reference: 'BX-900409', title: 'Synthetic weekend, Rishikesh', relation: 'waiting', ownerName: null, source: { ...freshSource, sourceDealId: '900409', stageLabel: 'New enquiry' } },
  { ...deal001, id: 'm5', reference: 'SYN-DEL-005', title: 'Synthetic package E (Delhi)', relation: 'scope', ownerName: null },
];
const bitrixDetail = (source: DealSourceView): DealDetail => ({
  ...deal001,
  id: 'b1',
  reference: `BX-${source.sourceDealId}`,
  title: 'Synthetic Bitrix enquiry A',
  assignments: [],
  commercial: { visible: false },
  // Imported from Bitrix with no commercial row yet: the viewer may read it, nothing is recorded.
  commercialAbsence: 'not_recorded',
  source,
});
/** Fixed preview clock so stale/fresh states are deterministic. */
const PREVIEW_NOW = Date.parse('2026-10-01T10:00:00Z');
const zeroCounts: IntegrationStatusView['counts'] = {
  pending: 0, processing: 0, processed: 0, ignored: 0, needs_review: 0, failed: 0, dead_letter: 0,
};
const notConfigured: IntegrationStatusView = {
  configured: false,
  environment: 'unset',
  portalDomain: null,
  pilotBranchName: null,
  cutoffAt: null,
  credentialPresent: false,
  workerSecretPresent: false,
  enabledConfigCount: 0,
  counts: zeroCounts,
  lastProcessedAt: null,
  lastWorkerRunAt: null,
  lastWorkerOutcome: null,
  oldestPendingAt: null,
  attention: [],
};
const configuredBase: IntegrationStatusView = {
  configured: true,
  environment: 'test',
  portalDomain: 'synthetic-portal.example.test',
  pilotBranchName: 'Delhi',
  cutoffAt: '2026-09-01T00:00:00Z',
  credentialPresent: true,
  workerSecretPresent: true,
  enabledConfigCount: 1,
  counts: { ...zeroCounts, processed: 42, ignored: 7, pending: 1 },
  lastProcessedAt: '2026-10-01T09:15:00Z',
  lastWorkerRunAt: '2026-10-01T09:55:00Z',
  lastWorkerOutcome: 'ok',
  oldestPendingAt: '2026-10-01T09:58:00Z',
  attention: [],
};
/** Prompt 6 fields: available deals vs Bitrix, last run, scheduler running (12 s ago). */
const healthySync: Partial<IntegrationStatusView> = {
  crmDeals: 42,
  bitrixNow: 42,
  keptOutsideStages: 0,
  lastRun: { at: '2026-10-01T09:59:48Z', fetched: 3, created: 1, updated: 2 },
  autoSync: {
    cronInstalled: true,
    jobActive: true,
    enabled: true,
    lastCalls: [{ at: '2026-10-01T09:59:30Z', statusCode: 200, ok: true, reason: null }],
    failingSince: null,
    lastSuccessAt: '2026-10-01T09:59:48Z',
  },
};
/** Scheduler refused since 09:40 (no success for 20 minutes) and Bitrix ahead by 3. */
const stoppedSync: Partial<IntegrationStatusView> = {
  crmDeals: 42,
  bitrixNow: 45,
  keptOutsideStages: 0,
  autoSync: {
    cronInstalled: true,
    jobActive: true,
    enabled: true,
    lastCalls: [
      { at: '2026-10-01T09:59:30Z', statusCode: 401, ok: false, reason: "Synthetic preview: the CRM refused the scheduler's secret (HTTP 401)." },
    ],
    failingSince: '2026-10-01T09:40:00Z',
    lastSuccessAt: '2026-10-01T09:39:30Z',
  },
};
function inboxItem(n: number, extra: Partial<InboxItemView>): InboxItemView {
  return {
    inboxId: `i000000${n}-0000-4000-8000-000000000000`,
    status: 'needs_review',
    origin: 'event',
    eventType: 'ONCRMDEALADD',
    sourceDealId: `9002${String(n).padStart(2, '0')}`,
    receivedAt: '2026-10-01T08:30:00Z',
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
const attentionItems: InboxItemView[] = [
  inboxItem(1, { reasonCode: 'unmapped_owner' }),
  inboxItem(2, { reasonCode: 'owner_not_in_pilot_branch', origin: 'reconcile', eventType: 'RECONCILE' }),
  inboxItem(3, { reasonCode: 'invalid_source_data' }),
  inboxItem(4, { reasonCode: 'source_deal_not_found', origin: 'manual_retry' }),
  inboxItem(5, { reasonCode: 'not_configured' }),
  inboxItem(6, { reasonCode: 'environment_unset' }),
  inboxItem(13, { reasonCode: 'reference_conflict' }),
  inboxItem(7, {
    status: 'failed', attempts: 3, lastErrorCode: 'provider_rate_limited', lastErrorAt: '2026-10-01T08:31:00Z', nextAttemptAt: '2026-10-01T08:39:00Z',
  }),
  inboxItem(8, {
    status: 'failed', attempts: 2, lastErrorCode: 'provider_bad_response', lastErrorAt: '2026-10-01T08:32:00Z', nextAttemptAt: '2026-10-01T08:36:00Z',
  }),
  inboxItem(9, { status: 'dead_letter', attempts: 8, lastErrorCode: 'internal_error', lastErrorAt: '2026-10-01T07:00:00Z' }),
];
const providerDown: InboxItemView[] = [
  inboxItem(10, {
    status: 'dead_letter', attempts: 8, lastErrorCode: 'provider_unavailable', lastErrorAt: '2026-10-01T09:40:00Z',
  }),
  inboxItem(11, {
    status: 'failed', attempts: 4, lastErrorCode: 'provider_timeout', lastErrorAt: '2026-10-01T09:35:00Z', nextAttemptAt: '2026-10-01T09:51:00Z',
  }),
  inboxItem(12, { status: 'dead_letter', attempts: 8, lastErrorCode: 'provider_auth_failed', lastErrorAt: '2026-10-01T09:20:00Z' }),
];
const integrationAdmin: ShellViewer = { ...admin, canManageIntegration: true, canOpenBitrixConnection: true };
const reasonOnlyCodes = ['not_eligible_category', 'not_eligible_stage', 'before_cutoff', 'stale_ignored'] as const;

const delhiSales = [{ branchName: 'Delhi', isHeadOffice: false, roleName: 'Sales', legalEntityName: 'Holiday Chacha Pvt LTD' }];

const adminBranches = [
  { value: 'b-amd', label: 'Ahmedabad' },
  { value: 'b-del', label: 'Delhi' },
  { value: 'b-jdh', label: 'Jodhpur (head office)' },
];
const adminRoles = ['Accounts', 'Flight', 'Manager', 'Purchase', 'Sales', 'Super Admin', 'Visa'].map((r) => ({
  value: r,
  label: r,
}));
const baseStaff: StaffLine[] = [
  { userId: 'u7', displayName: 'Synthetic Admin Jodhpur', email: 'admin.jodhpur@example.test', status: 'active', access: ['Super Admin, Jodhpur'], isYou: true },
  { userId: 'u1', displayName: 'Synthetic Sales Delhi A', email: 'sales.delhi.a@example.test', status: 'active', access: ['Sales, Delhi'], isYou: false },
  { userId: 'u12', displayName: 'Synthetic Invited Staff', email: 'invited.staff@example.test', status: 'invited', access: ['Sales, Delhi'], isYou: false },
  { userId: 'u8', displayName: 'Synthetic Former Staff', email: 'former.staff@example.test', status: 'inactive', access: [], isYou: false },
];
const recoveryStaff: StaffLine[] = [
  baseStaff[0]!,
  { userId: 'r1', displayName: 'Synthetic Recovery Pending', email: 'recovery.pending@example.test', status: 'active', access: ['Sales, Delhi'], isYou: false },
  { userId: 'r2', displayName: 'Synthetic Recovery Failed', email: 'recovery.failed@example.test', status: 'active', access: ['Purchase, Jodhpur'], isYou: false },
  { userId: 'r3', displayName: 'Synthetic Recovery Reenrol', email: 'recovery.reenrol@example.test', status: 'active', access: ['Visa, Jodhpur'], isYou: false },
  { userId: 'r4', displayName: 'Synthetic Recovery Confirm', email: 'recovery.confirm@example.test', status: 'active', access: ['Manager, Delhi'], isYou: false },
  { userId: 'r5', displayName: 'Synthetic Recovery Done', email: 'recovery.done@example.test', status: 'active', access: ['Accounts, Jodhpur'], isYou: false },
  { userId: 'r6', displayName: 'Synthetic Cleanup Pending', email: 'cleanup.pending@example.test', status: 'active', access: ['Sales, Jodhpur'], isYou: false },
  { userId: 'r7', displayName: 'Synthetic Cleanup Failed', email: 'cleanup.failed@example.test', status: 'active', access: ['Sales, Ahmedabad'], isYou: false },
  { userId: 'r8', displayName: 'Synthetic Cleanup Stuck', email: 'cleanup.stuck@example.test', status: 'active', access: ['Visa, Delhi'], isYou: false },
  baseStaff[2]!,
  baseStaff[3]!,
];
function syntheticCase(userId: string, status: RecoveryCase['status'], extra: Partial<RecoveryCase> = {}): RecoveryCase {
  return {
    caseId: `c-${userId}`,
    userId,
    status,
    providerAttempts: 1,
    lastProviderError: null,
    openedAt: '2026-10-01T09:30:00Z',
    openedBy: 'u7',
    completedAt: null,
    ...extra,
  };
}
function syntheticEmail(userId: string, kind: StaffEmailDelivery['kind'], status: StaffEmailDelivery['status'], extra: Partial<StaffEmailDelivery> = {}): StaffEmailDelivery {
  return {
    deliveryId: `e-${userId}`,
    userId,
    invitationId: null,
    kind,
    status,
    attemptNo: 1,
    errorCode: null,
    createdAt: '2026-10-01T08:00:00Z',
    completedAt: status === 'pending' ? null : '2026-10-01T08:00:02Z',
    ...extra,
  };
}
const recoverySecurity: Record<string, StaffSecurityInfo> = {
  r1: { recovery: syntheticCase('r1', 'provider_pending'), lastEmail: syntheticEmail('r1', 'password_reset', 'pending') },
  r2: {
    recovery: syntheticCase('r2', 'provider_failed', { providerAttempts: 3, lastProviderError: 'provider_unavailable' }),
    lastEmail: syntheticEmail('r2', 'password_reset', 'failed', { errorCode: 'smtp_rejected', attemptNo: 2 }),
  },
  r3: { recovery: syntheticCase('r3', 'awaiting_reenrollment'), lastEmail: syntheticEmail('r3', 'invitation', 'handed_to_provider') },
  r4: { recovery: syntheticCase('r4', 'awaiting_admin_confirmation'), lastEmail: null },
  r5: {
    recovery: syntheticCase('r5', 'completed', { completedAt: '2026-10-01T11:00:00Z', cleanupCompletedAt: '2026-10-01T11:00:05Z', cleanupError: null }),
    lastEmail: syntheticEmail('r5', 'password_reset', 'handed_to_provider'),
  },
  r6: { recovery: syntheticCase('r6', 'completed', { completedAt: '2026-10-01T11:10:00Z', cleanupCompletedAt: null, cleanupError: null }), lastEmail: null },
  r7: {
    recovery: syntheticCase('r7', 'completed', { completedAt: '2026-10-01T11:20:00Z', cleanupCompletedAt: null, cleanupError: 'provider_unavailable:503' }),
    lastEmail: null,
  },
  r8: {
    recovery: syntheticCase('r8', 'completed', { completedAt: '2026-10-01T11:30:00Z', cleanupCompletedAt: null, cleanupError: 'plan_lookup:22023' }),
    lastEmail: null,
  },
  u12: { recovery: null, lastEmail: syntheticEmail('u12', 'invitation_resend', 'handed_to_provider', { attemptNo: 2 }) },
};
const syntheticMethods: VerificationMethodOption[] = [
  { code: 'SYNTHETIC_TEST_CALLBACK', label: 'Synthetic test callback (local and CI only)' },
];
const ownCase = (status: OwnRecoveryView['status'], confirmationCode?: string): OwnRecoveryView => ({
  caseId: 'c-self',
  status,
  confirmationCode,
});

async function render(state: string): Promise<ReactNode> {
  switch (state) {
    case 'sign-in-error':
      return (
        <AuthCard title="Sign in">
          <SignInForm
            initialState={{
              status: 'error',
              message:
                'Email or password is incorrect, or this account is not active. Contact your administrator if you need help.',
            }}
          />
        </AuthCard>
      );
    case 'onboarding-password':
      return (
        <AuthCard title="Choose your password">
          <p>
            Next you will use your authenticator app. If this is a new account, or your administrator has started
            authenticator recovery, you will set up a new one.
          </p>
          <PasswordForm />
        </AuthCard>
      );
    case 'mfa-enroll-start':
      return (
        <AuthCard title="Set up your authenticator app">
          <p>Every TripNavigate staff account must use an authenticator app. CRM data stays locked until this is done.</p>
          <MfaEnrollForm />
        </AuthCard>
      );
    case 'mfa-enroll-qr': {
      const secret = 'SYNTHETICPREVIEWKEYNOTREAL234567';
      const qrCode = await QRCode.toDataURL(
        `otpauth://totp/TripNavigate%20CRM%20(preview):synthetic@example.test?secret=${secret}&issuer=TripNavigate`,
      );
      return (
        <AuthCard title="Set up your authenticator app">
          <MfaEnrollForm initialEnrollment={{ status: 'ready', factorId: '00000000-0000-4000-8000-000000000000', qrCode, secret }} />
        </AuthCard>
      );
    }
    case 'mfa-challenge':
    case 'mfa-challenge-error':
      return (
        <AuthCard title="Enter your authenticator code">
          <MfaChallengeForm
            factors={[{ id: '00000000-0000-4000-8000-000000000000', name: 'Authenticator app' }]}
            initialState={
              state === 'mfa-challenge-error'
                ? { status: 'error', message: 'That code was not accepted. Wait for a new code and try again.' }
                : undefined
            }
          />
        </AuthCard>
      );
    case 'finish-onboarding':
      return <FinishOnboardingView />;
    case 'app-frame-loading':
      // The staff frame's content-area loading state (src/app/app/loading.tsx).
      return (
        <StaffShell viewer={sales} currentPath="/app">
          <h1 className="visually-hidden">Home</h1>
          <AppLoading />
        </StaffShell>
      );
    case 'home-sales':
      return (
        <StaffShell viewer={sales} currentPath="/app">
          <HomeView displayName={sales.displayName} counts={{ visible: 1, owned: 1, assigned: 0 }} roles={{ ...NO_HOME_ROLES, bookings: true }} myWork={salesWork} />
        </StaffShell>
      );
    case 'home-accounts':
      return (
        <StaffShell viewer={{ ...sales, displayName: 'Synthetic Accounts Jodhpur', primaryRole: 'Accounts', canUseAccounts: true, canCheckCustomers: true }} currentPath="/app">
          <HomeView displayName="Synthetic Accounts Jodhpur" counts={{ visible: 0, owned: 0, assigned: 0 }} canUseAccounts roles={{ ...NO_HOME_ROLES, accounts: true }} myWork={accountsWork} />
        </StaffShell>
      );
    case 'home-nothing':
      return (
        <StaffShell viewer={sales} currentPath="/app">
          <HomeView displayName={sales.displayName} counts={{ visible: 1, owned: 1, assigned: 0 }} roles={{ ...NO_HOME_ROLES, bookings: true }} myWork={quietWork} />
        </StaffShell>
      );
    case 'home-super-admin':
      // Super Admin by role alone: no counts apply, so Home shows the one empty message (and Settings in the menu).
      return (
        <StaffShell viewer={ownerAdmin} currentPath="/app">
          <HomeView displayName={ownerAdmin.displayName} counts={{ visible: 0, owned: 0, assigned: 0 }} roles={NO_HOME_ROLES} myWork={quietWork} adminPrimary={{ href: '/app/admin/integration', label: 'Open Bitrix connection' }} />
        </StaffShell>
      );
    case 'home-multi-role':
      return (
        <StaffShell viewer={multiRole} currentPath="/app">
          <HomeView displayName={multiRole.displayName} counts={{ visible: 4, owned: 2, assigned: 2 }} roles={{ ...NO_HOME_ROLES, bookings: true, purchase: true }} myWork={{ ...salesWork, waitingForMe: 7, draftsToContinue: 3 }} />
        </StaffShell>
      );
    case 'app-frame-error':
      // The staff frame's page error (src/app/app/error.tsx); "Try again" does nothing here.
      return (
        <StaffShell viewer={sales} currentPath="/app/deals">
          <PreviewStaffError />
        </StaffShell>
      );
    case 'home-manager': {
      // A Manager with Leads and Purchase tasks in the navigation: Home offers the same sections.
      const viewer: ShellViewer = {
        ...manager,
        displayName: 'Synthetic Manager Delhi',
        canSeeLeads: true,
        canSeePurchaseTasks: true,
        memberships: [
          { roleName: 'Manager', branchName: 'Delhi', isHeadOffice: false },
          { roleName: 'Sales', branchName: 'Jodhpur', isHeadOffice: true },
        ],
      };
      return (
        <StaffShell viewer={viewer} currentPath="/app">
          <HomeView
            displayName={viewer.displayName}
            memberships={[
              { branchName: 'Delhi', roleName: 'Manager', isHeadOffice: false, legalEntityName: 'Holiday Chacha Pvt LTD' },
              { branchName: 'Jodhpur', roleName: 'Sales', isHeadOffice: true, legalEntityName: 'Holiday Chacha Pvt LTD' },
            ]}
            counts={{ visible: 1284, owned: 12, assigned: 3 }}
            canSeePurchaseTasks={viewer.canSeePurchaseTasks}
            roles={{ ...NO_HOME_ROLES, bookings: true, branchManager: true }}
            myWork={managerWork}
          />
        </StaffShell>
      );
    }
    case 'deals-sales':
      return (
        <StaffShell viewer={sales} currentPath="/app/deals">
          <DealsListScreen {...previewDealsProps({ items: [deal001] })} now="2026-10-01T10:00:00Z" />
        </StaffShell>
      );
    case 'deals-manager-branch-grant':
      return (
        <StaffShell viewer={manager} currentPath="/app/deals">
          <DealsListScreen {...previewDealsProps({ items: managerDeals })} now="2026-10-01T10:00:00Z" />
        </StaffShell>
      );
    case 'deals-empty':
      return (
        <StaffShell viewer={{ ...sales, displayName: 'Synthetic Visa Jodhpur', primaryRole: 'Visa', primaryBranch: 'Jodhpur' }} currentPath="/app/deals">
          <DealsListScreen {...previewDealsProps({ items: [] })} now="2026-10-01T10:00:00Z" />
        </StaffShell>
      );
    case 'deals-mixed':
      // Lagoon Deals list with every row kind: owner, assigned, scope, waiting for an owner,
      // labelled / raw / stale Bitrix stages, a synthetic record, and more than one page.
      return (
        <StaffShell viewer={manager} currentPath="/app/deals">
          <DealsListScreen
            {...previewDealsProps({ items: mixedDeals, total: 107, counts: { owned: 12, assigned: 4 } })}
            now="2026-10-01T10:00:00Z"
            live={
              // Static stand-in for LiveDealsRefresh (no realtime connection in previews).
              <p className="live-indicator live" role="status" aria-live="polite">
                <span aria-hidden="true" className="status-glyph">
                  ●
                </span>
                Live updates on
              </p>
            }
          />
        </StaffShell>
      );
    case 'deals-list-past-end':
      // No rows on this page although other pages have deals (e.g. deals removed while paging):
      // the empty message stays a status on its own and the pager follows it.
      return (
        <StaffShell viewer={sales} currentPath="/app/deals">
          <DealsListScreen {...previewDealsProps({ items: [], total: 107, page: 4 })} now="2026-10-01T10:00:00Z" />
        </StaffShell>
      );
    case 'deals-filter-owned-empty':
      // Batch 1: "Owned by you" chosen, nothing owned (filtered empty, FE).
      return (
        <StaffShell viewer={manager} currentPath="/app/deals">
          <DealsListScreen {...previewDealsProps({ items: [], total: 0, filter: 'owned', counts: { all: 107, owned: 0, assigned: 4 } })} now="2026-10-01T10:00:00Z" />
        </StaffShell>
      );
    case 'deals-counts-unavailable':
      // Batch 1: chip counts and the total could not be read: said in words, never 0.
      return (
        <StaffShell viewer={sales} currentPath="/app/deals">
          <DealsListScreen {...previewDealsProps({ items: mixedDeals, total: null, counts: { all: null, owned: null, assigned: null } })} now="2026-10-01T10:00:00Z" />
        </StaffShell>
      );
    case 'deals-accounts-empty':
      return (
        <StaffShell viewer={{ ...sales, displayName: 'Synthetic Accounts Jodhpur', primaryRole: 'Accounts', primaryBranch: 'Jodhpur', canUseAccounts: true, canCheckCustomers: true }} currentPath="/app/deals">
          <DealsListScreen {...previewDealsProps({ items: [] })} emptyFor="accounts" now="2026-10-01T10:00:00Z" />
        </StaffShell>
      );
    case 'deals-super-admin-empty':
      return (
        <StaffShell viewer={admin} currentPath="/app/deals">
          <DealsListScreen {...previewDealsProps({ items: [] })} emptyFor="super_admin" now="2026-10-01T10:00:00Z" />
        </StaffShell>
      );
    case 'deals-loading':
      // The Deals list loading state (src/app/app/deals/(list)/loading.tsx).
      return (
        <StaffShell viewer={sales} currentPath="/app/deals">
          <DealsListLoading />
        </StaffShell>
      );
    case 'deal-detail-sales':
      return (
        <StaffShell viewer={sales} currentPath="/app/deals">
          <LegacyDealPage stem="deal-detail-sales" detail={salesDetail} />
        </StaffShell>
      );
    case 'deal-detail-bitrix-money':
      return (
        <StaffShell viewer={sales} currentPath="/app/deals">
          <LegacyDealPage stem="deal-detail-bitrix" current="money" detail={bitrixDetail(freshSource)} />
        </StaffShell>
      );
    case 'deal-detail-sales-money':
      return (
        <StaffShell viewer={sales} currentPath="/app/deals">
          <LegacyDealPage stem="deal-detail-sales" current="money" detail={salesDetail} />
        </StaffShell>
      );
    case 'deal-detail-purchase':
      return (
        <StaffShell viewer={purchase} currentPath="/app/deals">
          <LegacyDealPage stem="deal-detail-purchase" detail={purchaseDetail} />
        </StaffShell>
      );
    case 'deal-not-found':
      return (
        <StaffShell viewer={sales} currentPath="/app/deals">
          <DealNotFoundView />
        </StaffShell>
      );
    case 'my-access-manager':
      return (
        <StaffShell viewer={manager} currentPath="/app/access">
          <MyAccessView
            memberships={[{ ...delhiSales[0]!, roleName: 'Manager' }]}
            grants={[
              {
                id: 'g1',
                staffName: manager.displayName,
                permissionLabel: 'View deals',
                scopeLabel: 'Delhi branch',
                reason: 'SYNTHETIC FIXTURE: Delhi branch read scope for tests',
                grantedOn: '2026-10-01',
                expiresOn: null,
              },
            ]}
          />
        </StaffShell>
      );
    case 'admin-staff':
      return (
        <SettingsShell viewer={admin} currentPath="/app/admin/staff">
          <StaffAdminView
            sectionLinks={{ staff: true, access: true }}
            inviteDomains={['example.test']}
            branches={adminBranches}
            roles={adminRoles}
            staff={baseStaff}
            security={{ u12: recoverySecurity.u12! }}
          />
        </SettingsShell>
      );
    case 'admin-staff-recovery':
    case 'admin-staff-recovery-no-method':
      return (
        <SettingsShell viewer={admin} currentPath="/app/admin/staff">
          <StaffAdminView
            sectionLinks={{ staff: true, access: true }}
            inviteDomains={['example.test']}
            branches={adminBranches}
            roles={adminRoles}
            staff={recoveryStaff}
            security={recoverySecurity}
            verificationMethods={state === 'admin-staff-recovery' ? syntheticMethods : []}
          />
        </SettingsShell>
      );
    case 'account-recovery-provider-pending':
      return <AccountRecoveryView recovery={ownCase('provider_pending')} />;
    case 'account-recovery-provider-failed':
      return <AccountRecoveryView recovery={ownCase('provider_failed')} />;
    case 'account-recovery-awaiting-reenrollment':
      return <AccountRecoveryView recovery={ownCase('awaiting_reenrollment')} />;
    case 'account-recovery-register-error':
      return (
        <AccountRecoveryView
          recovery={ownCase('awaiting_reenrollment')}
          registerInitialState={{
            status: 'error',
            message: 'No new authenticator was found for this session. Set up a new authenticator app first.',
          }}
        />
      );
    case 'account-recovery-awaiting-confirmation':
      return <AccountRecoveryView recovery={ownCase('awaiting_admin_confirmation', 'K7Q2XM')} />;
    case 'account-recovery-code-other-device':
      return <AccountRecoveryView recovery={ownCase('awaiting_admin_confirmation')} />;
    case 'account-recovery-register-multiple':
      return (
        <AccountRecoveryView
          recovery={ownCase('awaiting_reenrollment')}
          registerInitialState={{
            status: 'error',
            message: 'More than one new authenticator was added. Contact your administrator.',
          }}
        />
      );
    case 'account-recovery-completed':
      return <AccountRecoveryView recovery={ownCase('completed')} />;
    case 'forgot-password':
      return (
        <AuthCard title="Reset your password">
          <ForgotPasswordForm />
        </AuthCard>
      );
    case 'forgot-password-sent':
      return (
        <AuthCard title="Reset your password">
          <ForgotPasswordForm initialState={{ status: 'success', message: PASSWORD_RESET_GENERIC_MESSAGE }} />
        </AuthCard>
      );
    case 'shell-sign-out-everywhere':
      return (
        <StaffShell viewer={sales} currentPath="/app" signOutOptionsOpen>
          <HomeView displayName={sales.displayName} counts={{ visible: 1, owned: 1, assigned: 0 }} roles={{ ...NO_HOME_ROLES, bookings: true }} myWork={salesWork} />
        </StaffShell>
      );
    case 'admin-grants':
      return (
        <SettingsShell viewer={admin} currentPath="/app/admin/access">
          <AccessGrantsView
            sectionLinks={{ staff: true, access: true }}
            staff={[{ value: 'u1', label: 'Synthetic Sales Delhi A' }]}
            entities={[{ value: 'e1', label: 'Holiday Chacha Pvt LTD' }]}
            branches={[
              { value: 'b-amd', label: 'Ahmedabad' },
              { value: 'b-del', label: 'Delhi' },
              { value: 'b-jdh', label: 'Jodhpur' },
            ]}
            grants={[
              { id: 'g1', staffName: 'Synthetic Manager Delhi', permissionLabel: 'View deals', scopeLabel: 'Delhi branch', reason: 'SYNTHETIC FIXTURE: Delhi branch read scope for tests', grantedOn: '2026-10-01', expiresOn: null },
              { id: 'g2', staffName: 'Synthetic Accounts Jodhpur', permissionLabel: 'View selling price and margin', scopeLabel: 'Whole entity (Holiday Chacha Pvt LTD)', reason: 'SYNTHETIC FIXTURE: entity-wide commercial scope for tests', grantedOn: '2026-10-01', expiresOn: '2026-12-31' },
            ]}
          />
        </SettingsShell>
      );
    case 'deals-bitrix-source':
      return (
        <StaffShell viewer={sales} currentPath="/app/deals">
          <DealsListScreen {...previewDealsProps({ items: bitrixDeals })} now="2026-10-01T10:00:00Z" />
        </StaffShell>
      );
    case 'deal-detail-bitrix':
      return (
        <StaffShell viewer={sales} currentPath="/app/deals">
          <LegacyDealPage stem="deal-detail-bitrix" detail={bitrixDetail(freshSource)} />
        </StaffShell>
      );
    case 'deal-detail-bitrix-stale':
      return (
        <StaffShell viewer={sales} currentPath="/app/deals">
          <LegacyDealPage stem="deal-detail-bitrix-stale" detail={bitrixDetail(staleSource)} />
        </StaffShell>
      );
    case 'integration-not-configured':
      return (
        <SettingsShell viewer={integrationAdmin} currentPath="/app/admin/integration">
          <IntegrationAdminView status={notConfigured} now={PREVIEW_NOW} />
        </SettingsShell>
      );
    case 'integration-switched-off':
      return (
        <SettingsShell viewer={integrationAdmin} currentPath="/app/admin/integration">
          <IntegrationAdminView
            status={{
              ...configuredBase,
              configured: false,
              enabledConfigCount: 0,
              counts: zeroCounts,
              lastProcessedAt: null,
              lastWorkerRunAt: null,
              lastWorkerOutcome: null,
              oldestPendingAt: null,
            }}
            now={PREVIEW_NOW}
          />
        </SettingsShell>
      );
    case 'integration-healthy':
      return (
        <SettingsShell viewer={integrationAdmin} currentPath="/app/admin/integration">
          <IntegrationAdminView status={{ ...configuredBase, ...healthySync }} now={PREVIEW_NOW} />
        </SettingsShell>
      );
    case 'integration-attention':
      return (
        <SettingsShell viewer={integrationAdmin} currentPath="/app/admin/integration">
          <IntegrationAdminView
            status={{ ...configuredBase, counts: { ...configuredBase.counts, needs_review: 7, failed: 2, dead_letter: 1 }, attention: attentionItems }}
            now={PREVIEW_NOW}
          />
        </SettingsShell>
      );
    case 'integration-provider-unavailable':
      return (
        <SettingsShell viewer={integrationAdmin} currentPath="/app/admin/integration">
          <IntegrationAdminView
            status={{
              ...configuredBase,
              lastWorkerOutcome: 'provider_error',
              counts: { ...configuredBase.counts, failed: 1, dead_letter: 2 },
              attention: providerDown,
            }}
            now={PREVIEW_NOW}
          />
        </SettingsShell>
      );
    case 'integration-stale':
      return (
        <SettingsShell viewer={integrationAdmin} currentPath="/app/admin/integration">
          <IntegrationAdminView status={{ ...configuredBase, lastProcessedAt: '2026-09-28T06:00:00Z' }} now={PREVIEW_NOW} />
        </SettingsShell>
      );
    case 'integration-worker-never-run':
    case 'integration-worker-not-recent':
    case 'integration-backlog':
    case 'integration-worker-secret-missing':
    case 'integration-multiple-configs': {
      const variants: Record<string, Partial<IntegrationStatusView>> = {
        'integration-worker-never-run': { lastWorkerRunAt: null, lastWorkerOutcome: null, lastProcessedAt: null, oldestPendingAt: '2026-10-01T08:00:00Z', counts: { ...zeroCounts, pending: 5 } },
        'integration-worker-not-recent': { lastWorkerRunAt: '2026-10-01T07:30:00Z', oldestPendingAt: '2026-10-01T08:10:00Z', counts: { ...zeroCounts, processed: 42, pending: 3 }, ...stoppedSync },
        'integration-backlog': { oldestPendingAt: '2026-10-01T09:20:00Z', lastWorkerOutcome: 'partial', counts: { ...zeroCounts, processed: 42, pending: 12 } },
        'integration-worker-secret-missing': { workerSecretPresent: false, lastWorkerRunAt: null, lastWorkerOutcome: null },
        'integration-multiple-configs': { configured: false, enabledConfigCount: 2, lastWorkerRunAt: '2026-10-01T09:55:00Z' },
      };
      return (
        <SettingsShell viewer={integrationAdmin} currentPath="/app/admin/integration">
          <IntegrationAdminView status={{ ...configuredBase, ...variants[state] }} now={PREVIEW_NOW} />
        </SettingsShell>
      );
    }
    case 'integration-reconcile-cooldown':
      return (
        <SettingsShell viewer={integrationAdmin} currentPath="/app/admin/integration">
          <IntegrationAdminView
            status={configuredBase}
            now={PREVIEW_NOW}
            reconcileInitialState={{ status: 'error', message: 'Synthetic preview: a check ran recently. Try again in 4 minutes.' }}
          />
        </SettingsShell>
      );
    case 'integration-reason-codes':
      // Reasons normally recorded on ignored rows, shown here so every plain-language text is reviewable.
      return (
        <SettingsShell viewer={integrationAdmin} currentPath="/app/admin/integration">
          <IntegrationAdminView
            status={{
              ...configuredBase,
              attention: reasonOnlyCodes.map((reasonCode, i) => inboxItem(20 + i, { reasonCode, status: 'ignored' })),
            }}
            now={PREVIEW_NOW}
          />
        </SettingsShell>
      );
    case 'integration-action-results':
      return (
        <SettingsShell viewer={integrationAdmin} currentPath="/app/admin/integration">
          <IntegrationAdminView
            status={{ ...configuredBase, counts: { ...configuredBase.counts, needs_review: 1 }, attention: [attentionItems[0]!] }}
            now={PREVIEW_NOW}
            reconcileInitialState={{ status: 'success', message: 'Synthetic preview: 2 missed deals were queued.' }}
            retryInitialState={{ status: 'error', message: 'Synthetic preview: the responsible person is still not linked.' }}
          />
        </SettingsShell>
      );
    case 'integration-no-permission':
      return (
        <SettingsShell viewer={sales} currentPath="/app/admin/integration">
          <IntegrationNoPermissionView />
        </SettingsShell>
      );
    default:
      // Phase 3: hotel booking, Purchase tasks and booking health. Phase 4: Purchase work and suppliers.
      // Phase 5: imported Bitrix deals and sync problems.
      // Phase 6: approved import list and Bitrix Lead provenance.
      // B1: intake, services, Flight queue, Home counts and workflow switches.
      // B1.1: Book now, claims, department forms, Visa & Passport desk.
      return renderVnState(state) ?? renderBatch5SearchState(state) ?? renderBatch4SettingsState(state) ?? renderBatch4DeptState(state) ?? renderBatch4AccountsState(state) ?? renderBookformState(state) ?? renderDealWorkspaceState(state) ?? renderBatch3State(state) ?? renderB12QuoteState(state) ?? renderB12ItinState(state) ?? renderB11BookState(state) ?? renderB11WorkState(state) ?? renderB1State(state) ?? renderBookingState(state) ?? renderProcurementState(state) ?? renderIntakeState(state) ?? renderLeadIntakeState(state) ?? renderFinanceState(state);
  }
}

export default async function PreviewPage({ params }: { params: Promise<{ state: string }> }) {
  if (!isUiPreviewEnabled(process.env)) notFound();
  const { state } = await params;
  const content = await render(state);
  if (!content) notFound();
  return (
    <>
      <div className="preview-banner" role="note">
        Design preview: synthetic props, no authentication, no provider and no database. Not evidence of a real
        journey.
      </div>
      {content}
    </>
  );
}
