import type { ReactNode } from 'react';
import { SettingsShell } from './settings-preview-frame';
import type { DealDetail, DealListItem } from '@/modules/deals/dto';
import {
  type BookingActionResult,
  type DealProgress,
  type DealServiceSummaryView,
  type DealServicesView,
  ERROR_TEXT,
  type EvidenceItemView,
  type FlightTaskSummary,
  type FlightTaskView,
  type IntakeChecklist,
  type IntakeView,
  type MyWorkCounts,
  type PurchaseTaskSummary,
  type PurchaseTaskView,
  type ServiceItemView,
  type Traveller,
} from '@/modules/fulfilment/contracts';
import { DealServicesCard, DealServicesUnavailable } from '@/views/deal-services-view';
import { DealsListScreen } from '@/views/deals-list-view';
import { previewDealsProps } from './batch1-fixtures';
import { FlightQueueLoading, FlightQueuePage, FlightTaskNotFoundView, FlightTaskPage } from '@/views/flight-views';
import { HomeView, NO_HOME_ROLES as NO_ROLES } from '@/views/home-view';
import type { IntakeActions, IntakePreview } from '@/views/intake-forms';
import { IntakeDisabledView, IntakeLoading, IntakeNotAvailableView, IntakeScreen } from '@/views/intake-views';
import { PurchaseQueuePage, PurchaseTaskPage } from '@/views/purchase-views';
import { LegacyDealPage } from './deal-workspace-states';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import { FeaturesSettingsView, WorkflowNoPermissionView, WorkflowUnavailableView } from '@/views/workflow-views';
import type { WorkflowSettingKey } from '@/modules/fulfilment/contracts';
import { featureRows, liveRows } from '@/modules/settings/rows';
import type { FeaturesPageModel } from '@/modules/settings/server/queries';
import { liveSection, workflowSection } from './batch4-settings-fixtures';
import { previewSwitchNotAuthorizedAction, previewSwitchSavedAction, previewVisaCountAction } from './batch4-settings-preview-actions';

/** Settings · Features model from a synthetic switch-state reply (Batch 4). */
export function featuresPreview(states: Partial<Record<WorkflowSettingKey, 'on' | 'off' | 'unknown'>>, opts: { canSwitch?: boolean } = {}): FeaturesPageModel {
  return { features: featureRows(workflowSection(states, opts), { tripFactsRead: 'on' }), live: liveRows(liveSection) };
}
import {
  previewRefuseConflictAction,
  previewRefuseInvalidAction,
  previewRefuseOnHoldAction,
  previewRefuseTaskConflictAction,
  previewSavedAction,
} from './b1-preview-actions';

/*
 * B1 design-review states (branch claude/b1-service-items, 10 October 2026):
 * intake screen, Deal page services card, Deals list progress, Home "My work",
 * Purchase facts per type, Flight queue and admin workflow switches. Synthetic
 * props only (example names, made-up amounts, no real customer, hotel, flight
 * or person). Actions are the gallery's stand-ins (b1-preview-actions.ts):
 * nothing is read or written.
 */

const sales: ShellViewer = {
  displayName: 'Synthetic Sales Delhi A',
  primaryRole: 'Sales',
  primaryBranch: 'Delhi',
  canAdministerStaff: false,
  canManageGrants: false,
};
const salesAssignee: ShellViewer = { ...sales, displayName: 'Synthetic Sales Delhi B' };
export const purchase: ShellViewer = { ...sales, displayName: 'Synthetic Purchase Jodhpur', primaryRole: 'Purchase', primaryBranch: 'Jodhpur', canSeePurchaseTasks: true };
export const flight: ShellViewer = { ...sales, displayName: 'Synthetic Flight Jodhpur', primaryRole: 'Flight', primaryBranch: 'Jodhpur', canSeeFlightTasks: true };
const manager: ShellViewer = { ...sales, displayName: 'Synthetic Manager Delhi', primaryRole: 'Manager', canSeeLeads: true, canSeePurchaseTasks: true };
const accounts: ShellViewer = { ...sales, displayName: 'Synthetic Accounts Jodhpur', primaryRole: 'Accounts', primaryBranch: 'Jodhpur', canUseAccounts: true, canCheckCustomers: true };
export const admin: ShellViewer = {
  displayName: 'Synthetic Admin Jodhpur',
  primaryRole: 'Super Admin',
  primaryBranch: 'Jodhpur',
  canAdministerStaff: true,
  canManageGrants: true,
  canManageIntegration: true,
  canOpenBitrixConnection: true,
};

const DEAL_ID = 'd0000000-0000-4000-8000-000000000001';
const VERSION_ID = 'b0000000-0000-4000-8000-000000000001';
const HASH = '5'.repeat(64);
const item = (n: number) => `a1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const task = (n: number) => `f0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const delhiSales = [{ branchName: 'Delhi', isHeadOffice: false, roleName: 'Sales', legalEntityName: 'Holiday Chacha Pvt LTD' }];

const deal: DealDetail = {
  id: DEAL_ID,
  reference: 'BX-900420',
  title: 'Synthetic honeymoon, Andaman (6 nights)',
  branchName: 'Delhi',
  relation: 'owner',
  createdOn: '2026-10-01',
  assignments: [{ kind: 'sales', isYou: true }],
  commercial: { visible: true, currency: 'INR', sellingTotal: '₹1,84,000.00', estimatedMargin: '₹16,000.00' },
  source: {
    system: 'bitrix',
    sourceDealId: '900420',
    stageId: 'UC_AD0SLH',
    stageLabel: 'Won - Payment Received',
    lastSyncedAt: '2026-10-09T09:15:00Z',
    lastVerifiedAt: '2026-10-10T09:50:00Z',
    stale: false,
  },
};

const err = (code: keyof typeof ERROR_TEXT): BookingActionResult<unknown> => ({ ok: false, code, message: ERROR_TEXT[code] });

// --- Sold services ----------------------------------------------------------

const hotelItem: ServiceItemView = {
  itemId: item(1),
  itemNo: 1,
  serviceType: 'hotel',
  department: 'purchase',
  state: 'planned',
  title: 'Synthetic Reef Resort, Havelock',
  facts: {
    type: 'hotel',
    facts: { hotelName: 'Synthetic Reef Resort', city: 'Havelock', checkIn: '2026-11-14', checkOut: '2026-11-18', rooms: 1, adults: 2, children: 0, roomType: 'Sea-view cottage', mealPlan: 'Breakfast only', inclusions: null, specialRequests: 'Late check-in, around 22:00.' },
  },
  purchaseBudgetPaise: '6000000',
  factsHash: '1'.repeat(64),
  task: null,
  nextStep: 'confirm_version',
};
const transferItem: ServiceItemView = {
  itemId: item(2),
  itemNo: 2,
  serviceType: 'transfer',
  department: 'purchase',
  state: 'planned',
  title: 'Airport to jetty, both ways',
  facts: { type: 'transfer', facts: { route: 'Airport to jetty, both ways', date: '2026-11-14', vehicleType: 'Sedan', passengers: 2, pickupTime: '10:30', notes: null } },
  purchaseBudgetPaise: '450000',
  factsHash: '2'.repeat(64),
  task: null,
  nextStep: 'confirm_version',
};
const activityItem: ServiceItemView = {
  itemId: item(3),
  itemNo: 3,
  serviceType: 'activity',
  department: 'purchase',
  state: 'planned',
  title: 'Synthetic scuba trial dive, Havelock',
  facts: { type: 'activity', facts: { name: 'Synthetic scuba trial dive', city: 'Havelock', date: '2026-11-16', participants: 2, time: '08:00', notes: 'Both are first-time divers.' } },
  purchaseBudgetPaise: '0',
  factsHash: '3'.repeat(64),
  task: null,
  nextStep: 'confirm_version',
};
const flightItem: ServiceItemView = {
  itemId: item(4),
  itemNo: 4,
  serviceType: 'flight',
  department: 'flight',
  state: 'planned',
  title: 'DEL → IXZ → DEL',
  facts: {
    type: 'flight',
    facts: {
      segments: [
        { from: 'DEL', to: 'IXZ', date: '2026-11-14' },
        { from: 'IXZ', to: 'DEL', date: '2026-11-20' },
      ],
      passengers: 2,
      preferredTime: 'Morning departure',
      cabin: 'Economy',
      notes: null,
    },
  },
  purchaseBudgetPaise: '5200000',
  factsHash: '4'.repeat(64),
  task: null,
  nextStep: 'confirm_version',
};
const plannedItems = [hotelItem, transferItem, activityItem, flightItem];

function withTask(it: ServiceItemView, n: number, status: PurchaseTaskSummary['status'], assigneeName: string | null, assignedToYou = false): ServiceItemView {
  return {
    ...it,
    state: 'active',
    task: { taskId: task(n), status, assigneeName, assignedToYou, supplierConfirmedAt: status === 'supplier_confirmed' ? '2026-10-09T06:30:00Z' : null },
    nextStep: status === 'supplier_confirmed' ? 'done' : status === 'in_progress' ? 'supplier_confirmation' : 'take_task',
  };
}
const activeItems: ServiceItemView[] = [
  withTask(hotelItem, 1, 'supplier_confirmed', 'Synthetic Purchase Jodhpur'),
  withTask(transferItem, 2, 'in_progress', 'Synthetic Purchase Colleague'),
  withTask(activityItem, 3, 'not_started', null),
  withTask(flightItem, 4, 'not_started', null),
];

function progressOf(items: ServiceItemView[]): DealProgress {
  const byState = { planned: 0, notStarted: 0, inProgress: 0, supplierConfirmed: 0 };
  for (const it of items) {
    if (it.nextStep === 'confirm_version') byState.planned += 1;
    else if (it.nextStep === 'take_task') byState.notStarted += 1;
    else if (it.nextStep === 'supplier_confirmation') byState.inProgress += 1;
    else byState.supplierConfirmed += 1;
  }
  const needs = (['take_task', 'supplier_confirmation', 'confirm_version'] as const).filter((s) => items.some((i) => i.nextStep === s));
  return { total: items.length, byState, fulfilled: items.length > 0 && byState.supplierConfirmed === items.length, staleCount: 0, needs };
}

const travellers: Traveller[] = [
  { fullName: 'Synthetic Traveller One', type: 'adult', seq: 1 },
  { fullName: 'Synthetic Traveller Two', type: 'adult', seq: 2 },
];

function servicesView(items: ServiceItemView[], extra: Partial<DealServicesView> = {}): DealServicesView {
  const confirmed = items.some((i) => i.state === 'active');
  return {
    dealId: DEAL_ID,
    version: { versionId: VERSION_ID, versionNo: 1, status: confirmed ? 'confirmed' : 'draft', rowVersion: 3, contentHash: HASH, serviceType: 'package' },
    items,
    travellers,
    progress: progressOf(items),
    canEdit: !confirmed,
    canConfirm: !confirmed,
    ...extra,
  };
}

function proof(n: number, extra: Partial<EvidenceItemView> = {}): EvidenceItemView {
  return {
    id: `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    kind: 'acceptance_message',
    fileName: `synthetic-acceptance-${n}.pdf`,
    sizeLabel: '214 KB',
    status: 'stored',
    uploadedByYou: true,
    uploadedAt: '2026-10-09T06:30:00Z',
    ...extra,
  };
}

const clearChecklist: IntakeChecklist = { items: [], canConfirm: true };

function intakeView(extra: Partial<IntakeView> = {}): IntakeView {
  return {
    dealId: DEAL_ID,
    dealReference: deal.reference,
    dealTitle: deal.title,
    stage: { stageId: 'UC_AD0SLH', label: 'Won - Payment Received', isTriggerStage: true },
    serviceItemsEnabled: true,
    services: servicesView(plannedItems),
    travellers,
    prefillSource: 'crm',
    checklist: clearChecklist,
    evidence: [proof(1)],
    evidenceVisible: true,
    sellingTotalPaise: '18400000',
    gate: { realBookingEnabled: false, environment: 'test' },
    canEdit: true,
    canConfirm: true,
    confirmBlockedReason: null,
    openBlockedReason: null,
    dealNotActive: false,
    ...extra,
  };
}

const realActions: IntakeActions = {
  openDraft: previewSavedAction,
  addServiceItem: previewSavedAction,
  saveServiceItem: previewSavedAction,
  removeServiceItem: previewSavedAction,
  saveTravellers: previewSavedAction,
  confirmIntake: previewRefuseConflictAction,
};
const refusingActions: IntakeActions = {
  openDraft: previewRefuseInvalidAction,
  addServiceItem: previewRefuseInvalidAction,
  saveServiceItem: previewRefuseInvalidAction,
  removeServiceItem: previewRefuseOnHoldAction,
  saveTravellers: previewRefuseInvalidAction,
  confirmIntake: previewRefuseConflictAction,
};

const intakeStates: Record<string, { viewer: ShellViewer; view: IntakeView; actions?: IntakeActions; preview?: IntakePreview; owner?: string | null }> = {
  // Just synced from Bitrix: trigger stage reached, no services or travellers typed yet.
  'intake-synced-only': {
    viewer: sales,
    view: intakeView({
      services: servicesView([], { progress: progressOf([]) }),
      travellers: [],
      evidence: [],
      canConfirm: false,
      checklist: {
        items: [
          { code: 'no_services', blocking: true, owner: 'sales', itemNos: [] },
          { code: 'acceptance_missing', blocking: true, owner: 'sales', itemNos: [] },
        ],
        canConfirm: false,
      },
    }),
  },
  // Some services typed; the checklist still blocks (travellers, one service's dates) and warns (visa mentioned).
  'intake-partially-filled': {
    viewer: sales,
    view: intakeView({
      services: servicesView([hotelItem, transferItem]),
      travellers: [travellers[0]!],
      canConfirm: false,
      checklist: {
        items: [
          { code: 'traveller_missing', blocking: true, owner: 'sales', itemNos: [] },
          { code: 'dates_outside_trip', blocking: false, owner: 'sales', itemNos: [2] },
          { code: 'budget_missing', blocking: false, owner: 'sales', itemNos: [2] },
          { code: 'visa_mentioned', blocking: false, owner: 'sales', itemNos: [] },
        ],
        canConfirm: false,
      },
    }),
  },
  // Everything in place: the primary action is offered.
  'intake-ready': { viewer: sales, view: intakeView() },
  'intake-confirm-dialog': { viewer: sales, view: intakeView(), preview: { confirmOpen: true } },
  'intake-confirm-conflict': { viewer: sales, view: intakeView(), preview: { confirmOpen: true, confirmState: err('version_changed') } },
  // The accepted version is saved: items are active, each with its task.
  'intake-created': {
    viewer: sales,
    view: intakeView({ services: servicesView(activeItems), canEdit: false, canConfirm: false }),
  },
  // Stage not reached yet: keep preparing, tasks wait for Bitrix.
  'intake-stage-not-confirmed': {
    viewer: sales,
    view: intakeView({
      stage: { stageId: 'C1:UC_SYN3', label: 'Quote sent', isTriggerStage: false },
      canConfirm: false,
      checklist: { items: [{ code: 'stage_not_confirmed', blocking: true, owner: 'bitrix', itemNos: [] }], canConfirm: false },
    }),
  },
  // A refusal: the add form shows kept values and the named fields; the travellers form too.
  'intake-refused': {
    viewer: sales,
    view: intakeView({ services: servicesView([hotelItem]) }),
    actions: refusingActions,
    preview: { addState: err('invalid_input'), travellersState: err('invalid_input') },
  },
  // A Sales assignee who may edit but not confirm.
  'intake-assignee': {
    viewer: salesAssignee,
    view: intakeView({ canConfirm: false, confirmBlockedReason: ERROR_TEXT.not_authorized, sellingTotalPaise: undefined }),
    owner: 'Synthetic Sales Delhi A',
  },
  // A reader (branch scope) with no editing rights and no proof access.
  'intake-read-only': {
    viewer: salesAssignee,
    view: intakeView({ canEdit: false, canConfirm: false, evidence: [], evidenceVisible: false, sellingTotalPaise: undefined, services: servicesView(plannedItems, { canEdit: false, canConfirm: false }) }),
    owner: 'Synthetic Sales Delhi C',
  },
  // Lost in Bitrix: nothing can start.
  'intake-deal-not-active': {
    viewer: sales,
    view: intakeView({
      services: servicesView([], { version: null, progress: progressOf([]), canEdit: false, canConfirm: false }),
      travellers: [],
      evidence: [],
      canEdit: false,
      canConfirm: false,
      openBlockedReason: ERROR_TEXT.deal_not_active,
      dealNotActive: true,
      checklist: { items: [{ code: 'no_services', blocking: true, owner: 'sales', itemNos: [] }], canConfirm: false },
    }),
  },
  // A synthetic (non-Bitrix) deal: no stage to wait for.
  'intake-no-bitrix-stage': { viewer: sales, view: intakeView({ stage: null, dealReference: 'SYN-DEL-001', dealTitle: 'Synthetic package A (Delhi)' }) },
  // No draft yet (the Deal reached the trigger stage; nothing started): one primary action, "Start the intake draft" (review E4).
  'intake-no-version': {
    viewer: sales,
    view: intakeView({
      services: servicesView([], { version: null, progress: progressOf([]), canConfirm: false }),
      travellers: [],
      evidence: [],
      canConfirm: false,
      checklist: { items: [{ code: 'no_services', blocking: true, owner: 'sales', itemNos: [] }], canConfirm: false },
    }),
  },
};

// --- Deal page --------------------------------------------------------------

const purchaseDeal: DealDetail = { ...deal, relation: 'assigned', ownerName: 'Synthetic Sales Delhi A', assignments: [{ kind: 'purchase', isYou: true }], commercial: { visible: false }, commercialAbsence: 'withheld' };

// --- Deals list -------------------------------------------------------------

const baseDeal: DealListItem = { id: DEAL_ID, reference: 'BX-900420', title: 'Synthetic honeymoon, Andaman (6 nights)', branchName: 'Delhi', relation: 'owner', createdOn: '2026-10-01', source: deal.source };
const listDeals: DealListItem[] = [
  baseDeal,
  { ...baseDeal, id: 'm2', reference: 'BX-900418', title: 'Synthetic family trip, Kerala', relation: 'assigned', ownerName: 'Synthetic Sales Delhi B' },
  { ...baseDeal, id: 'm3', reference: 'BX-900415', title: 'Synthetic group tour, Rajasthan', relation: 'scope', ownerName: 'Synthetic Sales Delhi C' },
  { ...baseDeal, id: 'm4', reference: 'SYN-DEL-005', title: 'Synthetic package E (Delhi)', relation: 'scope', ownerName: null, source: undefined },
];
function summary(id: string, items: ServiceItemView[]): DealServiceSummaryView {
  return { dealId: id, serviceTypes: items.map((i) => i.serviceType), ...progressOf(items) };
}
const summaries = new Map<string, DealServiceSummaryView>([
  [DEAL_ID, summary(DEAL_ID, activeItems)],
  ['m2', summary('m2', plannedItems)],
  ['m3', summary('m3', [withTask(hotelItem, 7, 'supplier_confirmed', 'Synthetic Purchase Jodhpur'), withTask({ ...hotelItem, itemNo: 2 }, 8, 'supplier_confirmed', 'Synthetic Purchase Jodhpur')])],
  // m4 has no services: the chips say so.
]);

// --- Home -------------------------------------------------------------------

const salesCounts: MyWorkCounts = { waitingForMe: 3, returnedToMe: 1, missingDetails: 2, intakeNeeded: 4, receiptsToVerify: null, requestsToApprove: null };
const accountsCounts: MyWorkCounts = { waitingForMe: 6, returnedToMe: 0, missingDetails: 0, intakeNeeded: 0, receiptsToVerify: 2, requestsToApprove: null };
const purchaseCounts: MyWorkCounts = { waitingForMe: 5, returnedToMe: 0, missingDetails: 0, intakeNeeded: 0, receiptsToVerify: null, requestsToApprove: null };

// --- Purchase ---------------------------------------------------------------

function purchaseSummary(it: ServiceItemView, n: number, status: PurchaseTaskSummary['status'], assigneeName: string | null): PurchaseTaskSummary {
  const hotel = it.facts.type === 'hotel' ? it.facts.facts : null;
  const heads =
    it.facts.type === 'hotel'
      ? it.facts.facts.adults
      : it.facts.type === 'activity'
        ? it.facts.facts.participants
        : it.facts.type === 'transfer' || it.facts.type === 'flight'
          ? (it.facts.facts.passengers ?? 0)
          : 0;
  return {
    taskId: task(n),
    dealReference: 'BX-900420',
    serviceType: it.serviceType,
    itemTitle: it.title,
    facts: it.facts,
    hotelName: hotel?.hotelName ?? null,
    city: hotel?.city ?? null,
    checkIn: hotel?.checkIn ?? null,
    checkOut: hotel?.checkOut ?? null,
    nights: hotel ? 4 : 0,
    rooms: hotel?.rooms ?? 0,
    travellers: { adults: heads, children: hotel?.children ?? 0 },
    purchaseBudgetPaise: it.purchaseBudgetPaise ?? '0',
    status,
    assigneeName,
    assignedToYou: assigneeName === 'Synthetic Purchase Jodhpur',
    branchName: 'Delhi',
    createdAt: '2026-10-09T07:05:00Z',
    supplierConfirmedAt: status === 'supplier_confirmed' ? '2026-10-09T09:30:00Z' : null,
  };
}
export const purchaseQueue: PurchaseTaskSummary[] = [
  purchaseSummary(hotelItem, 1, 'not_started', null),
  purchaseSummary(transferItem, 2, 'in_progress', 'Synthetic Purchase Jodhpur'),
  purchaseSummary(activityItem, 3, 'not_started', null),
];
export function purchaseView(s: PurchaseTaskSummary): PurchaseTaskView {
  const hotel = s.facts.type === 'hotel' ? s.facts.facts : null;
  return {
    ...s,
    roomType: hotel?.roomType ?? null,
    mealPlan: hotel?.mealPlan ?? null,
    inclusions: hotel?.inclusions ?? null,
    specialRequests: hotel?.specialRequests ?? null,
    confirmedAt: '2026-10-09T07:05:00Z',
    confirmedByName: 'Synthetic Sales Delhi A',
    versionNo: 1,
    canClaim: true,
  };
}

// --- Flight -----------------------------------------------------------------

const flightSummary: FlightTaskSummary = {
  taskId: task(4),
  dealReference: 'BX-900420',
  itemTitle: 'DEL → IXZ → DEL',
  facts: flightItem.facts.type === 'flight' ? flightItem.facts.facts : { segments: [], passengers: 2 },
  purchaseBudgetPaise: '5200000',
  status: 'not_started',
  assigneeName: null,
  assignedToYou: false,
  branchName: 'Delhi',
  createdAt: '2026-10-09T07:05:00Z',
  supplierConfirmedAt: null,
};
const flightQueue: FlightTaskSummary[] = [
  flightSummary,
  {
    ...flightSummary,
    taskId: task(5),
    dealReference: 'BX-900418',
    itemTitle: 'BOM → GOI → BOM',
    facts: { segments: [{ from: 'BOM', to: 'GOI', date: '2026-12-02' }, { from: 'GOI', to: 'BOM', date: '2026-12-06' }], passengers: 4, cabin: 'Economy' },
    purchaseBudgetPaise: '3800000',
    status: 'in_progress',
    assigneeName: 'Synthetic Flight Jodhpur',
    assignedToYou: true,
  },
  {
    ...flightSummary,
    taskId: task(6),
    dealReference: 'BX-900415',
    itemTitle: 'JAI → DEL',
    facts: { segments: [{ from: 'JAI', to: 'DEL', date: '2026-11-30' }], passengers: 12 },
    purchaseBudgetPaise: '9000000',
    status: 'supplier_confirmed',
    assigneeName: 'Synthetic Flight Colleague',
    supplierConfirmedAt: '2026-10-09T09:30:00Z',
  },
];
export const flightView: FlightTaskView = { ...flightSummary, confirmedAt: '2026-10-09T07:05:00Z', confirmedByName: 'Synthetic Sales Delhi A', versionNo: 1, canClaim: true, travellerCount: 2 };

// --- Workflow ---------------------------------------------------------------

// A database with B1.1 always returns all three switches; a missing one would show Unknown.

export const B1_PREVIEW_STATES = [
  ...Object.keys(intakeStates),
  'intake-disabled',
  'intake-not-visible',
  'intake-loading',
  'deal-services-planned',
  'deal-services-active',
  'deal-services-legacy-hotel',
  'deal-services-purchase',
  'deal-services-unavailable',
  'deals-list-progress',
  'deals-list-progress-unavailable',
  'home-my-work-sales',
  'home-my-work-accounts',
  'home-my-work-purchase',
  'home-my-work-unavailable',
  'purchase-queue-mixed',
  'purchase-task-transfer',
  'purchase-task-activity',
  'flight-queue',
  'flight-queue-empty',
  'flight-queue-loading',
  'flight-task-open',
  'flight-task-mine',
  'flight-task-claim-conflict',
  'flight-task-issued',
  'flight-task-not-found',
  'admin-workflow-off',
  'admin-workflow-on',
  'admin-workflow-refused',
  'admin-workflow-changed',
  'admin-workflow-no-permission',
  'admin-workflow-unavailable',
];

export function renderB1State(state: string): ReactNode | null {
  const intake = intakeStates[state];
  if (intake) {
    return (
      <StaffShell viewer={intake.viewer} currentPath="/app/deals">
        <IntakeScreen view={intake.view} ownerText={intake.owner === undefined ? 'You' : intake.owner} actions={intake.actions ?? realActions} preview={intake.preview} />
      </StaffShell>
    );
  }
  switch (state) {
    case 'intake-disabled':
      return (
        <StaffShell viewer={sales} currentPath="/app/deals">
          <IntakeDisabledView dealId={DEAL_ID} />
        </StaffShell>
      );
    case 'intake-not-visible':
      return (
        <StaffShell viewer={purchase} currentPath="/app/deals">
          <IntakeNotAvailableView />
        </StaffShell>
      );
    case 'intake-loading':
      return (
        <StaffShell viewer={sales} currentPath="/app/deals">
          <IntakeLoading />
        </StaffShell>
      );
    case 'deal-services-planned': {
      const view = servicesView(plannedItems);
      return (
        <StaffShell viewer={sales} currentPath="/app/deals">
          <LegacyDealPage stem={state} detail={deal} services={<DealServicesCard services={view} intakeHref={`/app/deals/${DEAL_ID}/intake`} />} read={{ services: { ok: true, view: view } }} />
        </StaffShell>
      );
    }
    case 'deal-services-active': {
      const view = servicesView(activeItems);
      return (
        <StaffShell viewer={sales} currentPath="/app/deals">
          <LegacyDealPage stem={state} detail={deal} services={<DealServicesCard services={view} />} read={{ services: { ok: true, view: view } }} />
        </StaffShell>
      );
    }
    case 'deal-services-legacy-hotel': {
      // A deal from before B1: the backfilled hotel item beside the unchanged hotel panel.
      const legacy = withTask({ ...hotelItem, title: 'Synthetic Lakeside Hotel, Udaipur' }, 9, 'in_progress', 'Synthetic Purchase Jodhpur');
      const view = servicesView([legacy], { version: { versionId: VERSION_ID, versionNo: 1, status: 'confirmed', rowVersion: 3, contentHash: HASH, serviceType: 'hotel' } });
      return (
        <StaffShell viewer={sales} currentPath="/app/deals">
          <LegacyDealPage
            stem={state}
            detail={{ ...deal, reference: 'SYN-DEL-001', title: 'Synthetic package A (Delhi)', source: undefined }}
            read={{ services: { ok: true, view }, legacyBooking: { ok: true, exists: true } }}
            services={
              <>
                <DealServicesCard services={view} />
                <section className="work-panel" aria-labelledby="booking-heading" id="hotel-booking">
                <div className="work-panel-head">
                  <div>
                    <span className="eyebrow">Hotel booking · version 1</span>
                    <h2 id="booking-heading">Hotel booking</h2>
                    <p className="mb-0">Unchanged legacy hotel panel (stand-in in this preview; the real panel renders on the deal page).</p>
                  </div>
                </div>
                </section>
              </>
            }
          />
        </StaffShell>
      );
    }
    case 'deal-services-purchase': {
      // Purchase sees only its department's items, no travellers and no selling price.
      const view = servicesView(activeItems.filter((i) => i.department === 'purchase'), { travellers: undefined, canEdit: false, canConfirm: false });
      return (
        <StaffShell viewer={purchase} currentPath="/app/deals">
          <LegacyDealPage stem={state} detail={purchaseDeal} services={<DealServicesCard services={view} />} read={{ services: { ok: true, view: view } }} />
        </StaffShell>
      );
    }
    case 'deal-services-unavailable':
      return (
        <StaffShell viewer={sales} currentPath="/app/deals">
          <LegacyDealPage stem={state} detail={deal} services={<DealServicesUnavailable />} />
        </StaffShell>
      );
    case 'deals-list-progress':
      return (
        <StaffShell viewer={manager} currentPath="/app/deals">
          <DealsListScreen {...previewDealsProps({ items: listDeals, total: 4 })} services={summaries} now="2026-10-01T10:00:00Z" />
        </StaffShell>
      );
    case 'deals-list-progress-unavailable':
      return (
        <StaffShell viewer={manager} currentPath="/app/deals">
          <DealsListScreen {...previewDealsProps({ items: listDeals, total: 4 })} services={null} now="2026-10-01T10:00:00Z" />
        </StaffShell>
      );
    case 'home-my-work-sales':
      return (
        <StaffShell viewer={sales} currentPath="/app">
          <HomeView displayName={sales.displayName} memberships={delhiSales} counts={{ visible: 12, owned: 12, assigned: 0 }} roles={{ ...NO_ROLES, bookings: true }} myWork={salesCounts} />
        </StaffShell>
      );
    case 'home-my-work-accounts':
      return (
        <StaffShell viewer={accounts} currentPath="/app">
          <HomeView displayName={accounts.displayName} memberships={[{ ...delhiSales[0]!, roleName: 'Accounts', branchName: 'Jodhpur', isHeadOffice: true }]} counts={{ visible: 0, owned: 0, assigned: 0 }} canUseAccounts roles={{ ...NO_ROLES, accounts: true }} myWork={accountsCounts} />
        </StaffShell>
      );
    case 'home-my-work-purchase':
      return (
        <StaffShell viewer={purchase} currentPath="/app">
          <HomeView displayName={purchase.displayName} memberships={[{ ...delhiSales[0]!, roleName: 'Purchase', branchName: 'Jodhpur', isHeadOffice: true }]} counts={{ visible: 3, owned: 0, assigned: 3 }} canSeePurchaseTasks roles={{ ...NO_ROLES, purchase: true }} myWork={purchaseCounts} />
        </StaffShell>
      );
    case 'home-my-work-unavailable':
      return (
        <StaffShell viewer={sales} currentPath="/app">
          <HomeView displayName={sales.displayName} memberships={delhiSales} counts={{ visible: 12, owned: 12, assigned: 0 }} roles={{ ...NO_ROLES, bookings: true }} myWork={null} />
        </StaffShell>
      );
    case 'purchase-queue-mixed':
      return (
        <StaffShell viewer={purchase} currentPath="/app/purchase">
          <PurchaseQueuePage queue={{ tasks: purchaseQueue }} canTakeTasks show="all" />
        </StaffShell>
      );
    case 'purchase-task-transfer':
      return (
        <StaffShell viewer={purchase} currentPath="/app/purchase">
          <PurchaseTaskPage task={purchaseView(purchaseQueue[1]!)} />
        </StaffShell>
      );
    case 'purchase-task-activity':
      return (
        <StaffShell viewer={purchase} currentPath="/app/purchase">
          <PurchaseTaskPage task={purchaseView(purchaseQueue[2]!)} />
        </StaffShell>
      );
    case 'flight-queue':
      return (
        <StaffShell viewer={flight} currentPath="/app/flight">
          <FlightQueuePage queue={{ tasks: flightQueue }} canTakeTasks show="all" />
        </StaffShell>
      );
    case 'flight-queue-empty':
      return (
        <StaffShell viewer={flight} currentPath="/app/flight">
          <FlightQueuePage queue={{ tasks: [] }} canTakeTasks />
        </StaffShell>
      );
    case 'flight-queue-loading':
      return (
        <StaffShell viewer={flight} currentPath="/app/flight">
          <FlightQueueLoading />
        </StaffShell>
      );
    case 'flight-task-open':
      return (
        <StaffShell viewer={flight} currentPath="/app/flight">
          <FlightTaskPage task={flightView} claimAction={previewSavedAction} />
        </StaffShell>
      );
    case 'flight-task-mine':
      return (
        <StaffShell viewer={flight} currentPath="/app/flight">
          <FlightTaskPage
            task={{ ...flightView, status: 'in_progress', assignedToYou: true, assigneeName: 'Synthetic Flight Jodhpur' }}
            claimAction={previewSavedAction}
            claimInitialState={{ ok: true, data: undefined, message: 'You have taken this task. It is now in progress.' }}
          />
        </StaffShell>
      );
    case 'flight-task-claim-conflict':
      return (
        <StaffShell viewer={flight} currentPath="/app/flight">
          <FlightTaskPage task={{ ...flightView, status: 'in_progress', assigneeName: 'Synthetic Flight Colleague' }} claimAction={previewRefuseTaskConflictAction} claimInitialState={err('task_conflict')} />
        </StaffShell>
      );
    case 'flight-task-issued':
      return (
        <StaffShell viewer={flight} currentPath="/app/flight">
          <FlightTaskPage task={{ ...flightView, status: 'supplier_confirmed', assigneeName: 'Synthetic Flight Jodhpur', assignedToYou: true, supplierConfirmedAt: '2026-10-09T09:30:00Z' }} claimAction={previewSavedAction} />
        </StaffShell>
      );
    case 'flight-task-not-found':
      return (
        <StaffShell viewer={flight} currentPath="/app/flight">
          <FlightTaskNotFoundView />
        </StaffShell>
      );
    case 'admin-workflow-off':
      return (
        <SettingsShell viewer={admin} currentPath="/app/admin/workflow">
          <FeaturesSettingsView model={featuresPreview({ service_items_enabled: 'off', intake_prompt_enabled: 'off', visa_passport_tasks_enabled: 'off', prefill_auto_fill: 'off', referral_drafts: 'off' })} actions={{ change: previewSwitchSavedAction, previewVisa: previewVisaCountAction }} bitrixHref="/app/admin/integration" />
        </SettingsShell>
      );
    case 'admin-workflow-on':
      return (
        <SettingsShell viewer={admin} currentPath="/app/admin/workflow">
          <FeaturesSettingsView model={featuresPreview({ service_items_enabled: 'on', intake_prompt_enabled: 'on', visa_passport_tasks_enabled: 'on', prefill_auto_fill: 'on', referral_drafts: 'on' })} actions={{ change: previewSwitchSavedAction }} bitrixHref="/app/admin/integration" />
        </SettingsShell>
      );
    case 'admin-workflow-refused':
      // The database refuses the save (not a Super Admin at aal2): the reason and choice stay on screen.
      return (
        <SettingsShell viewer={admin} currentPath="/app/admin/workflow">
          <FeaturesSettingsView model={featuresPreview({ service_items_enabled: 'off', intake_prompt_enabled: 'off', visa_passport_tasks_enabled: 'off', prefill_auto_fill: 'off', referral_drafts: 'off' })} actions={{ change: previewSwitchNotAuthorizedAction }} bitrixHref={null} />
        </SettingsShell>
      );
    case 'admin-workflow-changed':
      return (
        <SettingsShell viewer={admin} currentPath="/app/admin/workflow">
          <FeaturesSettingsView model={featuresPreview({ service_items_enabled: 'off', intake_prompt_enabled: 'on', visa_passport_tasks_enabled: 'off', prefill_auto_fill: 'off', referral_drafts: 'off' })} actions={{ change: previewSwitchSavedAction }} bitrixHref="/app/admin/integration" />
        </SettingsShell>
      );
    case 'admin-workflow-no-permission':
      return (
        <SettingsShell viewer={sales} currentPath="/app/admin/workflow">
          <WorkflowNoPermissionView />
        </SettingsShell>
      );
    case 'admin-workflow-unavailable':
      return (
        <SettingsShell viewer={admin} currentPath="/app/admin/workflow">
          <WorkflowUnavailableView />
        </SettingsShell>
      );
    default:
      return null;
  }
}

/**
 * Batch 1 workspace previews: the synthetic services read for a Sales owner or a
 * Purchase assignee (one Purchase task assigned to the viewer). The workspace
 * header is built from this same view, so its progress line matches the card.
 */
export function previewServicesView(viewer: 'sales' | 'purchase' | 'sales-draft'): DealServicesView {
  // A booking draft: services planned, no tasks yet (the header progress and the card match).
  if (viewer === 'sales-draft') return servicesView(plannedItems);
  if (viewer === 'sales') return servicesView(activeItems);
  const items = activeItems
    .filter((i) => i.department === 'purchase')
    .map((i, n) => (n === 1 && i.task ? { ...i, task: { ...i.task, assigneeName: 'Synthetic Purchase Jodhpur', assignedToYou: true } } : i));
  return servicesView(items, { travellers: undefined, canEdit: false, canConfirm: false });
}

/** Today's services card for the Services and tasks tab, from the same synthetic read. */
export function previewServicesTabCard(viewer: 'sales' | 'purchase' | 'sales-draft'): ReactNode {
  const editor = viewer !== 'purchase';
  return <DealServicesCard services={previewServicesView(viewer)} intakeHref={editor ? '/preview/b11-book-travellers' : null} linkLabel={editor ? 'Open the booking' : undefined} />;
}
