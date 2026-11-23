import type { ReactNode } from 'react';
import { SettingsShell } from './settings-preview-frame';
import type { DealDetail } from '@/modules/deals/dto';
import {
  type BookingActionResult,
  type BookingFacts,
  type BookingHealthView,
  type BookingPanelView,
  ERROR_TEXT,
  type EvidenceItemView,
  type PurchaseTaskSummary,
  type PurchaseTaskView,
} from '@/modules/fulfilment/contracts';
import { BookingHealthNoPermissionView, BookingHealthPage } from '@/views/booking-health-views';
import { type BookingPanelPreview, HotelBookingPanel, HotelBookingUnavailable } from '@/views/booking-views';
import { PurchaseQueuePage, PurchaseTaskNotFoundView, PurchaseTaskPage } from '@/views/purchase-views';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import { DealPageLoading } from '@/views/deal-page-view';
import { LegacyDealPage } from './deal-workspace-states';

/*
 * Phase 3 design-review states (synthetic props only; no real hotel, person,
 * customer or document). Rendered by the preview gallery page.
 */

const sales: ShellViewer = {
  displayName: 'Synthetic Sales Delhi A',
  primaryRole: 'Sales',
  primaryBranch: 'Delhi',
  canAdministerStaff: false,
  canManageGrants: false,
};
const salesAssignee: ShellViewer = { ...sales, displayName: 'Synthetic Sales Delhi B' };
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

const DEAL_ID = 'd0000000-0000-4000-8000-000000000001';
const VERSION_ID = 'b0000000-0000-4000-8000-000000000001';
const TASK_ID = 'f0000000-0000-4000-8000-000000000001';
const HASH = '5'.repeat(64);

const deal: DealDetail = {
  id: DEAL_ID,
  reference: 'SYN-DEL-001',
  title: 'Synthetic package A (Delhi)',
  branchName: 'Delhi',
  relation: 'owner',
  createdOn: '2026-10-01',
  assignments: [],
  commercial: { visible: true, currency: 'INR', sellingTotal: '₹1,23,456.00', estimatedMargin: '₹11,111.00' },
};

const fullFacts: BookingFacts = {
  hotelName: 'Synthetic Lakeside Hotel',
  city: 'Udaipur',
  checkIn: '2026-11-14',
  checkOut: '2026-11-17',
  rooms: 2,
  roomType: 'Deluxe double',
  mealPlan: 'Breakfast only',
  adults: 4,
  children: 1,
  inclusions: 'Airport pick-up on arrival.',
  specialRequests: 'Adjoining rooms if possible.',
  purchaseBudgetPaise: '4500000',
};
const partialFacts: BookingFacts = {
  ...fullFacts,
  city: null,
  checkIn: '2026-11-17',
  checkOut: '2026-11-14',
  adults: null,
  purchaseBudgetPaise: null,
};

function proof(n: number, extra: Partial<EvidenceItemView> = {}): EvidenceItemView {
  return {
    id: `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    kind: 'acceptance_message',
    fileName: `synthetic-acceptance-${n}.pdf`,
    sizeLabel: '214 KB',
    status: 'stored',
    uploadedByYou: true,
    uploadedAt: '2026-10-02T06:30:00Z',
    ...extra,
  };
}

const base: BookingPanelView = {
  dealId: DEAL_ID,
  state: 'draft_ready',
  versionId: VERSION_ID,
  versionNo: 1,
  rowVersion: 3,
  contentHash: HASH,
  facts: fullFacts,
  sellingTotalPaise: '5200000',
  evidence: [proof(1), proof(2, { kind: 'ticket', fileName: 'synthetic-ticket.png', sizeLabel: '1.2 MB', uploadedByYou: false })],
  evidenceVisible: true,
  issues: [],
  canEdit: true,
  canConfirm: true,
  confirmBlockedReason: null,
  openBlockedReason: null,
  gate: { realBookingEnabled: false, environment: 'test' },
  confirmed: null,
};

const err = (code: keyof typeof ERROR_TEXT): BookingActionResult<unknown> => ({ ok: false, code, message: ERROR_TEXT[code] });

const bookingStates: Record<string, { viewer: ShellViewer; booking: BookingPanelView | 'unavailable'; preview?: BookingPanelPreview }> = {
  'booking-none': {
    viewer: sales,
    booking: { ...base, state: 'none', versionId: null, versionNo: null, rowVersion: null, contentHash: null, facts: null, sellingTotalPaise: null, evidence: [], canConfirm: false },
  },
  'booking-none-deal-not-active': {
    viewer: sales,
    booking: {
      ...base, state: 'none', versionId: null, versionNo: null, rowVersion: null, contentHash: null, facts: null, sellingTotalPaise: null,
      evidence: [], canConfirm: false, openBlockedReason: ERROR_TEXT.deal_not_active,
    },
  },
  'booking-none-deal-not-active-read-only': {
    viewer: salesAssignee,
    booking: {
      ...base, state: 'none', versionId: null, versionNo: null, rowVersion: null, contentHash: null, facts: null,
      evidence: [], canEdit: false, canConfirm: false, openBlockedReason: ERROR_TEXT.deal_not_active,
    },
  },
  'booking-none-read-only': {
    viewer: salesAssignee,
    booking: { ...base, state: 'none', versionId: null, versionNo: null, rowVersion: null, contentHash: null, facts: null, evidence: [], canEdit: false, canConfirm: false },
  },
  'booking-draft-needs-repair': {
    viewer: sales,
    booking: {
      ...base,
      state: 'draft_needs_repair',
      facts: partialFacts,
      sellingTotalPaise: null,
      canConfirm: false,
      evidence: [proof(3, { status: 'failed', fileName: 'synthetic-bill.jpg', kind: 'bill' })],
      issues: ['missing_city', 'check_out_not_after_check_in', 'missing_travellers', 'missing_purchase_budget', 'missing_selling_total', 'missing_acceptance_proof'],
    },
  },
  'booking-draft-ask-owner': {
    viewer: salesAssignee,
    booking: {
      ...base,
      state: 'draft_needs_repair',
      sellingTotalPaise: undefined,
      canConfirm: false,
      confirmBlockedReason: ERROR_TEXT.not_authorized,
      issues: ['missing_selling_total_ask_owner'],
    },
  },
  'booking-draft-ready': { viewer: sales, booking: base },
  'booking-draft-ready-assignee': {
    viewer: salesAssignee,
    booking: { ...base, canConfirm: false, confirmBlockedReason: ERROR_TEXT.not_authorized, sellingTotalPaise: undefined },
  },
  'booking-confirm-dialog': { viewer: sales, booking: base, preview: { confirmOpen: true } },
  'booking-confirm-conflict': {
    viewer: sales,
    booking: base,
    preview: { confirmOpen: true, confirmState: err('version_changed') },
  },
  'booking-save-conflict': { viewer: sales, booking: base, preview: { saveState: err('version_changed') } },
  'booking-saved': {
    viewer: sales,
    booking: base,
    preview: { saveState: { ok: true, data: undefined, message: 'Draft saved. It is not confirmed yet.' } },
  },
  'booking-gate-off': {
    viewer: sales,
    booking: { ...base, state: 'draft_needs_repair', canConfirm: false, confirmBlockedReason: null, issues: ['booking_disabled'], gate: { realBookingEnabled: false, environment: 'staging' } },
  },
  'booking-environment-unset': {
    viewer: sales,
    booking: { ...base, state: 'draft_needs_repair', canConfirm: false, issues: ['environment_unset'], gate: { realBookingEnabled: false, environment: 'unset' } },
  },
  'booking-source-stale': {
    viewer: sales,
    booking: { ...base, state: 'draft_needs_repair', canConfirm: false, issues: ['source_not_recently_verified', 'evidence_upload_incomplete'], evidence: [proof(1), proof(4, { status: 'pending_upload', fileName: 'synthetic-payment.webp', kind: 'payment_proof' })] },
  },
  'booking-upload-failed': { viewer: sales, booking: base, preview: { uploadState: err('upload_failed') } },
  'booking-upload-rejected': { viewer: sales, booking: base, preview: { uploadState: err('evidence_rejected') } },
  'booking-max-files': {
    viewer: sales,
    booking: { ...base, evidence: Array.from({ length: 10 }, (_, i) => proof(i + 1, { fileName: `synthetic-proof-${i + 1}.pdf` })) },
  },
  'booking-confirmed': {
    viewer: sales,
    booking: {
      ...base,
      state: 'confirmed',
      canEdit: false,
      canConfirm: false,
      issues: [],
      confirmed: { at: '2026-10-02T07:05:00Z', byName: 'Synthetic Sales Delhi A', taskId: TASK_ID, taskStatus: 'not_started', taskAssigneeName: null },
    },
  },
  'booking-confirmed-proof-hidden': {
    viewer: sales,
    booking: {
      ...base,
      state: 'confirmed',
      sellingTotalPaise: undefined,
      evidence: [],
      evidenceVisible: false,
      canEdit: false,
      canConfirm: false,
      issues: [],
      confirmed: { at: '2026-10-02T07:05:00Z', byName: 'Synthetic Sales Delhi A', taskId: TASK_ID, taskStatus: 'not_started', taskAssigneeName: null },
    },
  },
  'booking-confirmed-taken': {
    viewer: sales,
    booking: {
      ...base,
      state: 'confirmed',
      canEdit: false,
      canConfirm: false,
      confirmed: { at: '2026-10-02T07:05:00Z', byName: 'Synthetic Manager Delhi', taskId: TASK_ID, taskStatus: 'in_progress', taskAssigneeName: 'Synthetic Purchase Jodhpur' },
    },
  },
  'booking-unavailable': { viewer: sales, booking: 'unavailable' },
  // A branch reader who may see the draft but neither edit it nor see money or proof.
  'booking-draft-read-only': {
    viewer: salesAssignee,
    booking: {
      ...base,
      state: 'draft_needs_repair',
      facts: { ...partialFacts, purchaseBudgetPaise: '4500000' },
      sellingTotalPaise: undefined,
      evidence: [],
      evidenceVisible: false,
      canEdit: false,
      canConfirm: false,
      issues: ['missing_city', 'missing_travellers', 'missing_selling_total_ask_owner'],
    },
  },
  // Every fact filled, gate off: Sales is done, confirmation waits for an admin.
  'booking-gate-off-ready': {
    viewer: sales,
    booking: { ...base, state: 'draft_needs_repair', canConfirm: false, confirmBlockedReason: null, issues: ['booking_disabled'], gate: { realBookingEnabled: false, environment: 'operational' } },
  },
};

const summary: PurchaseTaskSummary = {
  taskId: TASK_ID,
  dealReference: 'SYN-DEL-001',
  serviceType: 'hotel',
  itemTitle: 'Synthetic Lakeside Hotel, Udaipur',
  facts: {
    type: 'hotel',
    facts: { hotelName: 'Synthetic Lakeside Hotel', city: 'Udaipur', checkIn: '2026-11-14', checkOut: '2026-11-17', rooms: 2, adults: 4, children: 1, roomType: 'Deluxe double', mealPlan: 'Breakfast only', inclusions: 'Airport pick-up on arrival.', specialRequests: 'Adjoining rooms if possible.' },
  },
  hotelName: 'Synthetic Lakeside Hotel',
  city: 'Udaipur',
  checkIn: '2026-11-14',
  checkOut: '2026-11-17',
  nights: 3,
  rooms: 2,
  travellers: { adults: 4, children: 1 },
  purchaseBudgetPaise: '4500000',
  status: 'not_started',
  assigneeName: null,
  assignedToYou: false,
  branchName: 'Delhi',
  createdAt: '2026-10-02T07:05:00Z',
};
const queue: PurchaseTaskSummary[] = [
  summary,
  {
    ...summary,
    taskId: 'f0000000-0000-4000-8000-000000000002',
    dealReference: 'SYN-DEL-002',
    itemTitle: 'Synthetic Hill View Resort, Shimla',
    facts: { type: 'hotel', facts: { hotelName: 'Synthetic Hill View Resort', city: 'Shimla', checkIn: '2026-12-20', checkOut: '2026-12-21', rooms: 1, adults: 1 } },
    hotelName: 'Synthetic Hill View Resort',
    city: 'Shimla',
    checkIn: '2026-12-20',
    checkOut: '2026-12-21',
    nights: 1,
    rooms: 1,
    travellers: { adults: 1, children: 0 },
    purchaseBudgetPaise: '850000',
    status: 'in_progress',
    assigneeName: 'Synthetic Purchase Jodhpur',
    assignedToYou: true,
  },
  {
    ...summary,
    taskId: 'f0000000-0000-4000-8000-000000000003',
    dealReference: 'SYN-AMD-004',
    itemTitle: 'Synthetic Riverside Inn, Varanasi',
    facts: { type: 'hotel', facts: { hotelName: 'Synthetic Riverside Inn', city: 'Varanasi', checkIn: '2026-11-14', checkOut: '2026-11-17', rooms: 2, adults: 4, children: 1 } },
    hotelName: 'Synthetic Riverside Inn',
    city: 'Varanasi',
    status: 'in_progress',
    assigneeName: 'Synthetic Purchase Colleague',
    branchName: 'Ahmedabad',
  },
];
const taskView: PurchaseTaskView = {
  ...summary,
  roomType: 'Deluxe double',
  mealPlan: 'Breakfast only',
  inclusions: 'Airport pick-up on arrival.',
  specialRequests: 'Adjoining rooms if possible.',
  confirmedAt: '2026-10-02T07:05:00Z',
  confirmedByName: 'Synthetic Sales Delhi A',
  versionNo: 1,
  canClaim: true,
};

const health: BookingHealthView = {
  realBookingEnabled: false,
  environment: 'test',
  drafts: 4,
  draftsNeedingRepair: 3,
  confirmed: 2,
  tasksNotStarted: 1,
  tasksInProgress: 1,
  pendingOutboxEvents: 4,
};

/** The Lagoon Bitrix deal with a hotel booking (every header part). */
const bitrixBookingDeal = {
  ...deal,
  reference: 'BX-900420',
  title: 'Synthetic honeymoon, Andaman (6 nights)',
  assignments: [
    { kind: 'sales', isYou: true },
    { kind: 'purchase', isYou: false },
  ],
  source: {
    system: 'bitrix' as const,
    sourceDealId: '900420',
    stageId: 'C1:UC_SYN3',
    stageLabel: 'Quote sent',
    lastSyncedAt: '2026-10-01T09:15:00Z',
    lastVerifiedAt: '2026-10-01T09:50:00Z',
    stale: false,
  },
};
const BITRIX_BOOKING_LEAD = { href: '/app/leads/c6000000-0000-4000-8000-000000000001', reference: 'BXL-700311' };

/** Older B1 hotel version (DA-30): the legacy booking read returned a panel, so the builder says "Hotel booking". */
const HOTEL_READ = { legacyBooking: { ok: true as const, exists: true } };

export const BOOKING_PREVIEW_STATES = [
  ...Object.keys(bookingStates),
  'booking-loading',
  'deal-loading',
  'deal-page-bitrix-booking',
  'deal-page-purchase-stale',
  'deal-page-waiting',
  'deal-page-long-title',
  'purchase-queue',
  'purchase-queue-empty',
  'purchase-queue-sales-view',
  'purchase-task-open',
  'purchase-task-mine',
  'purchase-task-claim-conflict',
  'purchase-task-sales-view',
  'purchase-task-not-found',
  'booking-health-off',
  'booking-health-on',
  'booking-health-environment-unset',
  'booking-health-unknown',
  'booking-health-no-permission',
  'deal-detail-commercial-not-recorded',
  'deal-detail-commercial-not-recorded-money',
  'deal-page-bitrix-booking-money',
  'deal-page-bitrix-booking-overview',
];

export function renderBookingState(state: string): ReactNode | null {
  // Batch 1: "-overview" and "-money" variants of every booking state (the base state opens on Services and tasks).
  const variant = /^(.*)-(overview|money)$/.exec(state);
  const variantOf = variant ? bookingStates[variant[1]!] : undefined;
  if (variant && variantOf) {
    return (
      <StaffShell viewer={variantOf.viewer} currentPath="/app/deals">
        <LegacyDealPage
          stem={variant[1]!}
          current={variant[2] as 'overview' | 'money'}
          servicesFirst
          detail={variantOf.viewer === salesAssignee ? { ...deal, relation: 'assigned', commercial: { visible: false }, commercialAbsence: 'withheld' } : deal}
          read={HOTEL_READ}
        />
      </StaffShell>
    );
  }
  const b = bookingStates[state];
  if (b) {
    const panel =
      b.booking === 'unavailable' ? <HotelBookingUnavailable /> : <HotelBookingPanel booking={b.booking} preview={b.preview} />;
    return (
      <StaffShell viewer={b.viewer} currentPath="/app/deals">
        <LegacyDealPage
          stem={state}
          detail={b.viewer === salesAssignee ? { ...deal, relation: 'assigned', commercial: { visible: false }, commercialAbsence: 'withheld' } : deal}
          services={panel}
          read={HOTEL_READ}
        />
      </StaffShell>
    );
  }
  switch (state) {
    case 'booking-loading':
    case 'deal-loading':
      // The deal page loading state, exactly as its route loading file renders it
      // (src/app/app/deals/[id]/loading.tsx).
      return (
        <StaffShell viewer={sales} currentPath="/app/deals">
          <DealPageLoading />
        </StaffShell>
      );
    case 'deal-page-bitrix-booking':
      // Lagoon deal page with every header part: Bitrix source, owner, Lead link, live
      // indicator, a draft ready to confirm, assignments and the deal selling price.
      return (
        <StaffShell viewer={sales} currentPath="/app/deals">
          <LegacyDealPage
            stem={state}
            detail={bitrixBookingDeal}
            services={<HotelBookingPanel booking={base} />}
            leadLink={{ href: '/app/leads/c6000000-0000-4000-8000-000000000001', reference: 'BXL-700311' }}
            read={HOTEL_READ}
          />
        </StaffShell>
      );
    case 'deal-page-bitrix-booking-money':
    case 'deal-page-bitrix-booking-overview':
      return (
        <StaffShell viewer={sales} currentPath="/app/deals">
          <LegacyDealPage
            stem="deal-page-bitrix-booking"
            current={state.endsWith('-money') ? 'money' : 'overview'}
            servicesFirst
            detail={bitrixBookingDeal}
            leadLink={BITRIX_BOOKING_LEAD}
            read={HOTEL_READ}
          />
        </StaffShell>
      );
    case 'deal-page-purchase-stale':
      // Purchase on an assigned Bitrix deal: no booking panel, no money, sync overdue.
      return (
        <StaffShell viewer={purchase} currentPath="/app/deals">
          <LegacyDealPage
            stem={state}
            detail={{
              ...deal,
              reference: 'BX-900415',
              title: 'Synthetic group tour, Rajasthan',
              relation: 'assigned',
              ownerName: 'Synthetic Sales Delhi C',
              assignments: [{ kind: 'purchase', isYou: true }],
              commercial: { visible: false },
              commercialAbsence: 'withheld',
              source: {
                system: 'bitrix',
                sourceDealId: '900415',
                stageId: 'C1:UC_SYN5',
                stageLabel: 'Negotiation',
                lastSyncedAt: '2026-09-27T06:00:00Z',
                lastVerifiedAt: '2026-09-28T06:00:00Z',
                stale: true,
              },
            }}
          />
        </StaffShell>
      );
    case 'deal-page-long-title':
      // Long unbroken words from Bitrix (title, owner name, stage) must wrap, never widen the page.
      return (
        <StaffShell viewer={sales} currentPath="/app/deals">
          <LegacyDealPage
            stem={state}
            detail={{
              ...deal,
              reference: 'BX-900999',
              title: 'SyntheticHoneymoonAndamanHavelockNeilPortBlairSixNightsWithFerriesAndTransfersIncluded',
              relation: 'assigned',
              ownerName: 'SyntheticSalesPersonWithAVeryLongUnbrokenDisplayName',
              assignments: [{ kind: 'sales', isYou: true }],
              commercial: { visible: false },
              commercialAbsence: 'withheld',
              source: {
                system: 'bitrix',
                sourceDealId: '900999',
                stageId: 'C1:UC_SYNTHETIC_STAGE_WITH_A_VERY_LONG_UNBROKEN_IDENTIFIER',
                lastSyncedAt: '2026-10-01T09:15:00Z',
                lastVerifiedAt: '2026-10-01T09:50:00Z',
                stale: false,
              },
            }}
            leadLink={{ href: '/app/leads/c6000000-0000-4000-8000-000000000001', reference: 'BXL-700312' }}
          />
        </StaffShell>
      );
    case 'deal-page-waiting':
      // An administrator on a synthetic deal that is waiting for an owner.
      return (
        <StaffShell viewer={admin} currentPath="/app/deals">
          <LegacyDealPage
            stem={state}
            detail={{ ...deal, relation: 'waiting', ownerName: null, commercial: { visible: false }, commercialAbsence: 'not_recorded' }}
          />
        </StaffShell>
      );
    case 'deal-detail-commercial-not-recorded':
      return (
        <StaffShell viewer={sales} currentPath="/app/deals">
          <LegacyDealPage stem="deal-detail-commercial-not-recorded" detail={{ ...deal, commercial: { visible: false }, commercialAbsence: 'not_recorded' }} />
        </StaffShell>
      );
    case 'deal-detail-commercial-not-recorded-money':
      return (
        <StaffShell viewer={sales} currentPath="/app/deals">
          <LegacyDealPage stem="deal-detail-commercial-not-recorded" current="money" detail={{ ...deal, commercial: { visible: false }, commercialAbsence: 'not_recorded' }} />
        </StaffShell>
      );
    case 'purchase-queue':
      return (
        <StaffShell viewer={purchase} currentPath="/app/purchase">
          <PurchaseQueuePage queue={{ tasks: queue }} canTakeTasks show="all" />
        </StaffShell>
      );
    case 'purchase-queue-empty':
      return (
        <StaffShell viewer={purchase} currentPath="/app/purchase">
          <PurchaseQueuePage queue={{ tasks: [] }} canTakeTasks />
        </StaffShell>
      );
    case 'purchase-queue-sales-view':
      return (
        <StaffShell viewer={sales} currentPath="/app/purchase">
          <PurchaseQueuePage queue={{ tasks: queue }} canTakeTasks={false} />
        </StaffShell>
      );
    case 'purchase-task-open':
      return (
        <StaffShell viewer={purchase} currentPath="/app/purchase">
          <PurchaseTaskPage task={taskView} />
        </StaffShell>
      );
    case 'purchase-task-mine':
      return (
        <StaffShell viewer={purchase} currentPath="/app/purchase">
          <PurchaseTaskPage
            task={{ ...taskView, status: 'in_progress', assignedToYou: true, assigneeName: 'Synthetic Purchase Jodhpur' }}
            claimInitialState={{ ok: true, data: undefined, message: 'You have taken this task. It is now in progress.' }}
          />
        </StaffShell>
      );
    case 'purchase-task-claim-conflict':
      return (
        <StaffShell viewer={purchase} currentPath="/app/purchase">
          <PurchaseTaskPage
            task={{ ...taskView, status: 'in_progress', assigneeName: 'Synthetic Purchase Colleague' }}
            claimInitialState={err('task_conflict')}
          />
        </StaffShell>
      );
    case 'purchase-task-sales-view':
      return (
        <StaffShell viewer={sales} currentPath="/app/purchase">
          <PurchaseTaskPage task={{ ...taskView, canClaim: false }} />
        </StaffShell>
      );
    case 'purchase-task-not-found':
      return (
        <StaffShell viewer={purchase} currentPath="/app/purchase">
          <PurchaseTaskNotFoundView />
        </StaffShell>
      );
    case 'booking-health-off':
      return (
        <SettingsShell viewer={admin} currentPath="/app/admin/bookings">
          <BookingHealthPage health={health} />
        </SettingsShell>
      );
    case 'booking-health-on':
      return (
        <SettingsShell viewer={admin} currentPath="/app/admin/bookings">
          <BookingHealthPage health={{ ...health, realBookingEnabled: true, environment: 'operational' }} />
        </SettingsShell>
      );
    case 'booking-health-environment-unset':
      return (
        <SettingsShell viewer={admin} currentPath="/app/admin/bookings">
          <BookingHealthPage
            health={{ ...health, environment: 'unset', drafts: 0, draftsNeedingRepair: 0, confirmed: 0, tasksNotStarted: 0, tasksInProgress: 0, pendingOutboxEvents: 0 }}
          />
        </SettingsShell>
      );
    case 'booking-health-unknown':
      return (
        <SettingsShell viewer={admin} currentPath="/app/admin/bookings">
          <BookingHealthPage health={null} />
        </SettingsShell>
      );
    case 'booking-health-no-permission':
      return (
        <SettingsShell viewer={sales} currentPath="/app/admin/bookings">
          <BookingHealthNoPermissionView />
        </SettingsShell>
      );
    default:
      return null;
  }
}
