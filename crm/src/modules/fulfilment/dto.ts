import { type DealScopeFacts, type ViewerAccess, canReadDealCommercial } from '@/modules/access/policy';
import type {
  BookingHealthRecord,
  BookingPanelRecord,
  DealServiceSummaryRecord,
  DealServicesRecord,
  DealTravellerRecord,
  TaskParticipantRecord,
  FlightTaskDetailRecord,
  FlightTaskRecord,
  PurchaseTaskDetailRecord,
  PurchaseTaskRecord,
  ServiceItemRecord,
} from './commands';
import {
  type BookingHealthView,
  type BookingIssueCode,
  type BookingPanelState,
  type BookingPanelView,
  type BookingTrip,
  CHECKLIST_TEXT,
  type DealTravellerView,
  type TaskParticipantView,
  type TravellerIdentity,
  type ServiceType,
  type DealProgress,
  type DealServiceSummaryView,
  type DealServicesView,
  ERROR_TEXT,
  type EvidenceItemView,
  type FlightTaskSummary,
  type FlightTaskView,
  type IntakeChecklist,
  type IntakeChecklistItem,
  type IntakeView,
  ISSUE_TEXT,
  type MyWorkCounts,
  type PurchaseTaskSummary,
  type PurchaseTaskView,
  SERVICE_DEPARTMENT,
  type ServiceFacts,
  type ServiceItemState,
  type ServiceItemTaskView,
  type ServiceItemView,
  type ServiceNextStep,
  type WorkflowSettingsView,
} from './contracts';
import type { ServiceItemFileView } from './booking-form-contract';
import { estimateView } from './booking-form-vm';
import type { TaskFileRecord } from './commands';

/**
 * DTO shaping for booking screens. A DTO is the ONLY shape that reaches the
 * browser. Every field is copied explicitly (never spread from a record), so
 * an unexpected column from a query can never leak:
 *   - sellingTotalPaise is added to the booking panel only when the
 *     application mirror of the policy (canReadDealCommercial) allows it, in
 *     addition to the database withholding it;
 *   - Purchase DTOs have no commercial or evidence field at all.
 */

export class BookingShapeError extends Error {
  override name = 'BookingShapeError';
}

/* Client-safe: no node:crypto here (evidence.ts is server-side). */
/** Human-readable size (binary units), e.g. "240 KB", "1.4 MB". */
export function formatEvidenceSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole nights between two ISO dates (UTC calendar days); 0 when not after. */
export function nightsBetween(checkIn: string, checkOut: string): number {
  const a = Date.parse(`${checkIn}T00:00:00Z`);
  const b = Date.parse(`${checkOut}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return 0;
  return Math.round((b - a) / DAY_MS);
}

export interface BookingDealFacts extends DealScopeFacts {
  id: string;
}

function panelState(record: BookingPanelRecord): BookingPanelState {
  if (!record.version) return 'none';
  if (record.version.status === 'confirmed') return 'confirmed';
  return record.readiness?.ready ? 'draft_ready' : 'draft_needs_repair';
}

const GATE_ISSUES: BookingIssueCode[] = ['environment_unset', 'booking_disabled'];

function blockedReason(record: BookingPanelRecord, state: BookingPanelState, issues: BookingIssueCode[]): string | null {
  if (state === 'none' || state === 'confirmed') return null;
  if (!record.canConfirm) return ERROR_TEXT.not_authorized;
  const gate = GATE_ISSUES.find((code) => issues.includes(code));
  if (gate) return ISSUE_TEXT[gate];
  // Not ready for another reason: the repair list (issues) says what to fix.
  return null;
}

function toEvidenceItems(record: BookingPanelRecord): EvidenceItemView[] {
  return record.evidence
    .filter((e) => e.status !== 'removed')
    .map((e) => ({
      id: e.id,
      kind: e.kind,
      fileName: e.fileName,
      sizeLabel: formatEvidenceSize(e.sizeBytes),
      status: e.status,
      uploadedByYou: e.uploadedByYou,
      uploadedAt: e.createdAt,
    }));
}

export function toBookingPanelView(viewer: ViewerAccess, deal: BookingDealFacts, record: BookingPanelRecord): BookingPanelView {
  if (record.dealId !== deal.id) throw new BookingShapeError('booking panel does not belong to this deal');
  const version = record.version;
  if (version?.status === 'confirmed' && (!record.task || !version.confirmedAt)) {
    // Confirmation and task creation are one transaction (§5.1); anything else is not shown as confirmed.
    throw new BookingShapeError('confirmed booking without its Purchase task');
  }
  const state = panelState(record);
  const issues = state === 'confirmed' ? [] : (record.readiness?.issues ?? []);
  const isDraft = version?.status === 'draft';
  const canEdit = record.canEdit && state !== 'confirmed';
  const canConfirm = record.canConfirm && isDraft && state === 'draft_ready';
  // Render the selling field only when the database also returned the amount (re-review L-b).
  const commercialAllowed =
    canReadDealCommercial(viewer, deal) && (version === null || version.sellingTotalPaise !== undefined);

  return {
    dealId: deal.id,
    state,
    versionId: version?.versionId ?? null,
    versionNo: version?.versionNo ?? null,
    rowVersion: version?.rowVersion ?? null,
    // The hash the confirm form posts back unchanged: readiness' hash when present (same canonical function).
    contentHash: isDraft ? (record.readiness?.contentHash ?? version!.contentHash) : (version?.contentHash ?? null),
    facts: version
      ? {
          hotelName: version.facts.hotelName,
          city: version.facts.city,
          checkIn: version.facts.checkIn,
          checkOut: version.facts.checkOut,
          rooms: version.facts.rooms,
          roomType: version.facts.roomType,
          mealPlan: version.facts.mealPlan,
          adults: version.facts.adults,
          children: version.facts.children,
          inclusions: version.facts.inclusions,
          specialRequests: version.facts.specialRequests,
          purchaseBudgetPaise: version.facts.purchaseBudgetPaise,
        }
      : null,
    ...(commercialAllowed ? { sellingTotalPaise: version?.sellingTotalPaise ?? null } : {}),
    evidence: toEvidenceItems(record),
    evidenceVisible: record.evidenceVisible,
    issues,
    canEdit,
    canConfirm,
    confirmBlockedReason: canEdit && !canConfirm ? blockedReason(record, state, issues) : null,
    openBlockedReason: state === 'none' && record.dealNotActive === true ? ERROR_TEXT.deal_not_active : null,
    gate: { realBookingEnabled: record.gate.realBookingEnabled, environment: record.gate.environment },
    confirmed:
      state === 'confirmed' && record.task && version?.confirmedAt
        ? {
            at: version.confirmedAt,
            byName: version.confirmedByName ?? 'Unknown colleague',
            taskId: record.task.taskId,
            taskStatus: record.task.status,
            taskAssigneeName: record.task.assigneeName,
          }
        : null,
  };
}

// ---------------------------------------------------------------------------
// B1 pure helpers: titles, next steps, progress, checklist text
// ---------------------------------------------------------------------------

function shorten(value: string | null): string | null {
  if (!value) return null;
  const line = value.split(/\r?\n/)[0]!.trim();
  if (line === '') return null;
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/** Short title of a sold service: "Synthetic Palace, Jaipur", "Airport to hotel", "DEL → BOM → DEL". */
export function itemTitle(facts: ServiceFacts): string {
  switch (facts.type) {
    case 'hotel': {
      // B1.1: preferences mode may have no hotel name; the title then uses the preferences (shortened).
      const name = facts.facts.hotelName ?? shorten(facts.facts.preferences ?? null) ?? 'Hotel';
      return `${name}, ${facts.facts.city}`;
    }
    case 'transfer':
      return facts.facts.route;
    case 'visa':
      return `${facts.facts.country} · ${facts.facts.purpose}`;
    case 'passport':
      return `Passport (${facts.facts.applicationType}) · ${facts.facts.officeCity}`;
    case 'activity':
      return `${facts.facts.name}, ${facts.facts.city}`;
    case 'flight': {
      const segments = facts.facts.segments;
      if (segments.length === 0) return 'Flight';
      return [segments[0]!.from, ...segments.map((s) => s.to)].join(' → ');
    }
  }
}

type ProgressItem = { state: ServiceItemState; task: { status: ServiceItemTaskView['status'] } | null; serviceType?: ServiceType };

const DESK_TYPES: ReadonlySet<ServiceType> = new Set<ServiceType>(['visa', 'passport']);

/**
 * Contract §5.4 / ServiceNextStep: derived from the item state and its task,
 * never stored. B1.1: an accepted visa/passport item without a task waits for
 * the desk launch; a completed desk task is done.
 */
export function nextStepFor(item: ProgressItem): ServiceNextStep {
  if (item.state === 'planned') return 'confirm_version';
  if (!item.task) return item.serviceType && DESK_TYPES.has(item.serviceType) ? 'waiting_for_desk_launch' : 'confirm_version';
  if (item.task.status === 'supplier_confirmed' || item.task.status === 'completed') return 'done';
  if (item.task.status === 'in_progress') return item.serviceType && DESK_TYPES.has(item.serviceType) ? 'visa_processing' : 'supplier_confirmation';
  return 'take_task';
}

const NEEDS_ORDER: ServiceNextStep[] = ['take_task', 'supplier_confirmation', 'visa_processing', 'waiting_for_desk_launch', 'confirm_version'];

/**
 * Deal progress over the items given (contract §5.4). Cancelled items are
 * on hold and left out; `fulfilled` = every remaining item has a supplier
 * confirmation or a completed desk task (false while nothing is counted);
 * `staleCount` is 0. B1.1 keys `waitingForLaunch` and `completed` appear only
 * when non-zero (B1 shapes stay identical). Waiting items count in `total`
 * and are never fulfilled.
 */
export function computeProgress(items: ReadonlyArray<ProgressItem>): DealProgress {
  const counted = items.filter((i) => i.state !== 'cancelled');
  const byState = { planned: 0, notStarted: 0, inProgress: 0, supplierConfirmed: 0 };
  let waitingForLaunch = 0;
  let completed = 0;
  const open = new Set<ServiceNextStep>();
  for (const item of counted) {
    const step = nextStepFor(item);
    if (step === 'confirm_version') byState.planned += 1;
    else if (step === 'take_task') byState.notStarted += 1;
    else if (step === 'supplier_confirmation' || step === 'visa_processing') byState.inProgress += 1;
    else if (step === 'waiting_for_desk_launch') waitingForLaunch += 1;
    else if (item.task?.status === 'completed') completed += 1;
    else byState.supplierConfirmed += 1;
    if (step !== 'done') open.add(step);
  }
  return {
    total: counted.length,
    byState: {
      ...byState,
      ...(waitingForLaunch > 0 ? { waitingForLaunch } : {}),
      ...(completed > 0 ? { completed } : {}),
    },
    fulfilled: counted.length > 0 && byState.supplierConfirmed + completed === counted.length,
    staleCount: 0,
    needs: NEEDS_ORDER.filter((step) => open.has(step)),
  };
}

/** Frozen wording for one checklist item; the item numbers are appended for item-level rules. */
export function checklistText(item: Pick<IntakeChecklistItem, 'code' | 'itemNos'>): string {
  const base = CHECKLIST_TEXT[item.code];
  if (item.itemNos.length === 0) return base;
  return `${base} (service ${item.itemNos.join(', ')})`;
}

// ---------------------------------------------------------------------------
// B1 DTOs (explicit copies; never spread)
// ---------------------------------------------------------------------------

function toItemTask(task: ServiceItemRecord['task']): ServiceItemTaskView | null {
  if (!task) return null;
  return {
    taskId: task.taskId,
    status: task.status,
    assigneeName: task.assigneeName,
    assignedToYou: task.assignedToYou,
    supplierConfirmedAt: task.supplierConfirmedAt,
    ...(task.completedAt !== undefined ? { completedAt: task.completedAt } : {}),
  };
}

/** Copies an optional key only when the database sent it (old facts stay byte-identical in DTOs). */
function opt<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

export function copyFacts(facts: ServiceFacts): ServiceFacts {
  switch (facts.type) {
    case 'hotel': {
      const f = facts.facts;
      return {
        type: 'hotel',
        facts: {
          hotelName: f.hotelName ?? null,
          city: f.city,
          checkIn: f.checkIn,
          checkOut: f.checkOut,
          rooms: f.rooms,
          adults: f.adults,
          roomType: f.roomType ?? null,
          mealPlan: f.mealPlan ?? null,
          children: f.children ?? null,
          inclusions: f.inclusions ?? null,
          specialRequests: f.specialRequests ?? null,
          ...opt('mode', f.mode),
          ...opt('preferences', f.preferences),
          ...opt('area', f.area),
          ...opt('childAges', f.childAges === undefined || f.childAges === null ? f.childAges : [...f.childAges]),
          ...opt('exclusions', f.exclusions),
        },
      };
    }
    case 'transfer': {
      const f = facts.facts;
      return {
        type: 'transfer',
        facts: {
          route: f.route,
          date: f.date,
          vehicleType: f.vehicleType ?? null,
          passengers: f.passengers ?? null,
          pickupTime: f.pickupTime ?? null,
          notes: f.notes ?? null,
          ...opt('pickup', f.pickup),
          ...opt('drop', f.drop),
          // Booking form (car for the whole trip): facts only, never an estimate or a price.
          ...opt('endDate', f.endDate),
          ...opt('quantity', f.quantity),
          ...opt('includedKms', f.includedKms),
          ...opt('vendor', f.vendor),
        },
      };
    }
    case 'activity': {
      const f = facts.facts;
      return {
        type: 'activity',
        facts: {
          name: f.name,
          city: f.city,
          date: f.date,
          participants: f.participants,
          time: f.time ?? null,
          notes: f.notes ?? null,
          ...opt('inclusions', f.inclusions),
        },
      };
    }
    case 'flight': {
      const f = facts.facts;
      return {
        type: 'flight',
        facts: {
          segments: f.segments.map((s) => ({
            from: s.from,
            to: s.to,
            date: s.date,
            ...opt('flex', s.flex),
            // Booking form: requested flight details (local times are never compared across time zones).
            ...opt('arrivalDate', s.arrivalDate),
            ...opt('airline', s.airline),
            ...opt('flightNo', s.flightNo),
            ...opt('departTime', s.departTime),
            ...opt('arriveTime', s.arriveTime),
          })),
          passengers: f.passengers,
          preferredTime: f.preferredTime ?? null,
          cabin: f.cabin ?? null,
          notes: f.notes ?? null,
          ...opt('tripType', f.tripType),
          ...opt('preferences', f.preferences),
          ...opt('assistance', f.assistance),
        },
      };
    }
    case 'visa': {
      const f = facts.facts;
      return {
        type: 'visa',
        facts: {
          country: f.country,
          purpose: f.purpose,
          travelDate: f.travelDate,
          applyBy: f.applyBy ?? null,
          feePaidBy: f.feePaidBy,
          notes: f.notes ?? null,
        },
      };
    }
    case 'passport': {
      const f = facts.facts;
      return {
        type: 'passport',
        facts: {
          applicationType: f.applicationType,
          officeCity: f.officeCity,
          neededBy: f.neededBy ?? null,
          notes: f.notes ?? null,
        },
      };
    }
  }
}

/**
 * One service item for the Deal page and intake screen. The budget key is
 * copied only when the database sent it (own department or booking reader);
 * title and next step are derived here so every screen agrees.
 */
export function toServiceItemView(record: ServiceItemRecord): ServiceItemView {
  if (record.facts.type !== record.serviceType) throw new BookingShapeError('service item facts do not match its type');
  if (record.department !== SERVICE_DEPARTMENT[record.serviceType]) throw new BookingShapeError('service item department does not match its type');
  const facts = copyFacts(record.facts);
  const nextStep = nextStepFor(record);
  return {
    itemId: record.itemId,
    itemNo: record.itemNo,
    serviceType: record.serviceType,
    department: record.department,
    state: record.state,
    title: itemTitle(facts),
    facts,
    ...(record.purchaseBudgetPaise !== undefined ? { purchaseBudgetPaise: record.purchaseBudgetPaise } : {}),
    factsHash: record.factsHash,
    task: toItemTask(record.task),
    nextStep,
    ...(record.participants !== undefined ? { participants: [...record.participants] } : {}),
    ...(nextStep === 'waiting_for_desk_launch' ? { waitingForLaunch: true } : {}),
  };
}

export function toDealServicesView(record: DealServicesRecord): DealServicesView {
  const items = record.items.map(toServiceItemView);
  const version = record.version;
  return {
    dealId: record.dealId,
    version: version
      ? {
          versionId: version.versionId,
          versionNo: version.versionNo,
          status: version.status,
          rowVersion: version.rowVersion,
          contentHash: version.contentHash,
          serviceType: version.serviceType,
        }
      : null,
    items,
    ...(record.travellers !== undefined ? { travellers: record.travellers.map(toDealTraveller) } : {}),
    ...(record.trip !== undefined ? { trip: record.trip ? copyTrip(record.trip) : null } : {}),
    progress: computeProgress(items),
    canEdit: record.canEdit,
    canConfirm: record.canConfirm,
  };
}

function toDealTraveller(t: DealTravellerRecord): DealTravellerView {
  return {
    fullName: t.fullName,
    type: t.type,
    seq: t.seq,
    ...(t.ageYears !== undefined ? { ageYears: t.ageYears } : {}),
    ...(t.specialNeeds !== undefined ? { specialNeeds: t.specialNeeds } : {}),
    ...(t.identityStatus !== undefined ? { identityStatus: t.identityStatus } : {}),
  };
}

export function copyTrip(trip: BookingTrip): BookingTrip {
  return { destination: trip.destination, scope: trip.scope, start: trip.start, end: trip.end };
}

export function toDealServiceSummary(record: DealServiceSummaryRecord): DealServiceSummaryView {
  const waiting = record.byState.waitingForLaunch ?? 0;
  const completed = record.byState.completed ?? 0;
  return {
    dealId: record.dealId,
    serviceTypes: [...record.serviceTypes],
    total: record.total,
    byState: {
      planned: record.byState.planned,
      notStarted: record.byState.notStarted,
      inProgress: record.byState.inProgress,
      supplierConfirmed: record.byState.supplierConfirmed,
      ...(waiting > 0 ? { waitingForLaunch: waiting } : {}),
      ...(completed > 0 ? { completed } : {}),
    },
    fulfilled: record.fulfilled,
    staleCount: record.staleCount,
    needs: [...record.needs],
  };
}

export function toMyWorkCounts(record: MyWorkCounts): MyWorkCounts {
  return {
    waitingForMe: record.waitingForMe,
    returnedToMe: record.returnedToMe,
    missingDetails: record.missingDetails,
    intakeNeeded: record.intakeNeeded,
    receiptsToVerify: record.receiptsToVerify,
    requestsToApprove: record.requestsToApprove,
    // B1.1: null when absent (older database) or not applicable.
    claimsToProcess: record.claimsToProcess ?? null,
    expensesToReview: record.expensesToReview ?? null,
    visaTasksWaiting: record.visaTasksWaiting ?? null,
    // Batch 1: null when absent (older database) or not applicable.
    draftsToContinue: record.draftsToContinue ?? null,
    // Batch 3 (FP-081): null when absent (older database) or not applicable.
    quotationDraftsToFinish: record.quotationDraftsToFinish ?? null,
    acceptedQuotesToLink: record.acceptedQuotesToLink ?? null,
  };
}

export function toWorkflowSettingsView(record: WorkflowSettingsView): WorkflowSettingsView {
  return {
    intakePromptEnabled: record.intakePromptEnabled,
    serviceItemsEnabled: record.serviceItemsEnabled,
    visaPassportTasksEnabled: record.visaPassportTasksEnabled ?? false,
    updatedAt: record.updatedAt,
  };
}

/** Deal header facts the intake screen needs (read under the viewer's session). */
export interface IntakeDealFacts extends BookingDealFacts {
  reference: string;
  title: string;
  sourceSystem: string | null;
  sourceStageId: string | null;
}

export interface IntakeInputs {
  viewer: ViewerAccess;
  deal: IntakeDealFacts;
  settings: WorkflowSettingsView;
  panel: BookingPanelRecord;
  services: DealServicesRecord;
  checklist: IntakeChecklist;
}

function copyChecklist(checklist: IntakeChecklist): IntakeChecklist {
  return {
    items: checklist.items.map((i) => ({
      code: i.code,
      blocking: i.blocking,
      owner: i.owner,
      itemNos: [...i.itemNos],
      ...(i.travellerSeqs !== undefined ? { travellerSeqs: [...i.travellerSeqs] } : {}),
    })),
    canConfirm: checklist.canConfirm,
  };
}

/**
 * SCR-INTAKE view composed from the panel (gate, proof, selling total), the
 * services read, the checklist and the workflow switches. Confirmation is
 * offered only while the draft exists, the database allows it and the
 * checklist has no blocking item.
 */
export function toIntakeView(input: IntakeInputs): IntakeView {
  const { viewer, deal, settings, panel, services, checklist } = input;
  if (panel.dealId !== deal.id || services.dealId !== deal.id) throw new BookingShapeError('intake reads do not belong to this deal');
  const version = services.version;
  const isDraft = version?.status === 'draft';
  const canEdit = services.canEdit && isDraft;
  const blocking = checklist.items.some((i) => i.blocking);
  const canConfirm = services.canConfirm && checklist.canConfirm && isDraft && !blocking;
  const issues = panel.readiness?.issues ?? [];
  const gateIssue = GATE_ISSUES.find((code) => issues.includes(code));
  const commercialAllowed = canReadDealCommercial(viewer, deal) && (panel.version === null || panel.version.sellingTotalPaise !== undefined);
  const synced = deal.sourceSystem === 'bitrix' && !!deal.sourceStageId;

  let confirmBlockedReason: string | null = null;
  if (canEdit && !canConfirm) {
    if (!services.canConfirm) confirmBlockedReason = ERROR_TEXT.not_authorized;
    else if (gateIssue) confirmBlockedReason = ISSUE_TEXT[gateIssue];
  }

  return {
    dealId: deal.id,
    dealReference: deal.reference,
    dealTitle: deal.title,
    stage: synced
      ? {
          stageId: deal.sourceStageId!,
          label: null,
          isTriggerStage: !checklist.items.some((i) => i.code === 'stage_not_confirmed'),
        }
      : null,
    serviceItemsEnabled: settings.serviceItemsEnabled,
    services: toDealServicesView(services),
    travellers: (services.travellers ?? []).map((t) => ({ fullName: t.fullName, type: t.type, seq: t.seq })),
    prefillSource: 'crm',
    checklist: copyChecklist(checklist),
    evidence: toEvidenceItems(panel),
    evidenceVisible: panel.evidenceVisible,
    ...(commercialAllowed ? { sellingTotalPaise: panel.version?.sellingTotalPaise ?? null } : {}),
    gate: { realBookingEnabled: panel.gate.realBookingEnabled, environment: panel.gate.environment },
    canEdit,
    canConfirm,
    confirmBlockedReason,
    openBlockedReason: version === null && panel.dealNotActive === true ? ERROR_TEXT.deal_not_active : null,
    dealNotActive: panel.dealNotActive === true,
  };
}

// ---------------------------------------------------------------------------
// Purchase and Flight DTOs: explicit whitelists with NO selling price, margin,
// acceptance evidence or other departments' budgets.
// ---------------------------------------------------------------------------

/** Hotel facts for a task from a database before B1 (no facts object yet): the hotel columns. */
function legacyHotelFacts(record: PurchaseTaskRecord): ServiceFacts {
  if (!record.hotelName || !record.city || !record.checkIn || !record.checkOut || record.rooms < 1 || record.adults < 1) {
    throw new BookingShapeError('purchase task without service facts or hotel details');
  }
  return {
    type: 'hotel',
    facts: {
      hotelName: record.hotelName,
      city: record.city,
      checkIn: record.checkIn,
      checkOut: record.checkOut,
      rooms: record.rooms,
      adults: record.adults,
      children: record.children,
      roomType: null,
      mealPlan: null,
      inclusions: null,
      specialRequests: null,
    },
  };
}

/** Explicit whitelist: no selling price, margin or evidence can pass through. */
export function toPurchaseTaskSummary(record: PurchaseTaskRecord): PurchaseTaskSummary {
  const facts = record.facts ? copyFacts(record.facts) : legacyHotelFacts(record);
  if (record.serviceType !== undefined && record.serviceType !== facts.type) {
    throw new BookingShapeError('purchase task facts do not match its service type');
  }
  const isHotel = facts.type === 'hotel';
  return {
    taskId: record.taskId,
    dealReference: record.dealReference,
    serviceType: facts.type,
    // One naming rule for every screen (review E7): the title is derived here, never copied.
    itemTitle: itemTitle(facts),
    facts,
    hotelName: isHotel ? record.hotelName : null,
    city: isHotel ? record.city : null,
    checkIn: isHotel ? record.checkIn : null,
    checkOut: isHotel ? record.checkOut : null,
    nights: isHotel && record.checkIn && record.checkOut ? nightsBetween(record.checkIn, record.checkOut) : 0,
    rooms: isHotel ? record.rooms : 0,
    travellers: { adults: record.adults, children: record.children },
    purchaseBudgetPaise: record.purchaseBudgetPaise,
    status: record.status,
    assigneeName: record.assigneeName,
    assignedToYou: record.assignedToYou,
    branchName: record.branchName,
    createdAt: record.createdAt,
    supplierConfirmedAt: record.supplierConfirmedAt,
  };
}

export function toPurchaseTaskView(record: PurchaseTaskDetailRecord): PurchaseTaskView {
  const summary = toPurchaseTaskSummary(record);
  const hotel = summary.facts.type === 'hotel' ? summary.facts.facts : null;
  return {
    taskId: summary.taskId,
    dealReference: summary.dealReference,
    serviceType: summary.serviceType,
    itemTitle: summary.itemTitle,
    facts: summary.facts,
    hotelName: summary.hotelName,
    city: summary.city,
    checkIn: summary.checkIn,
    checkOut: summary.checkOut,
    nights: summary.nights,
    rooms: summary.rooms,
    travellers: summary.travellers,
    purchaseBudgetPaise: summary.purchaseBudgetPaise,
    status: summary.status,
    assigneeName: summary.assigneeName,
    assignedToYou: summary.assignedToYou,
    branchName: summary.branchName,
    createdAt: summary.createdAt,
    supplierConfirmedAt: summary.supplierConfirmedAt,
    roomType: record.roomType ?? hotel?.roomType ?? null,
    mealPlan: record.mealPlan ?? hotel?.mealPlan ?? null,
    inclusions: record.inclusions ?? hotel?.inclusions ?? null,
    specialRequests: record.specialRequests ?? hotel?.specialRequests ?? null,
    confirmedAt: record.confirmedAt,
    confirmedByName: record.confirmedByName,
    versionNo: record.versionNo,
    canClaim: record.canClaim,
    // Purchase never receives identity data, even if a reply carried it.
    ...taskExtras(record, false),
    // Booking form: the item's supplier estimate (cost only), when the database sent it to this assignee.
    ...(record.estimate !== undefined ? { estimate: estimateView(summary.serviceType, summary.facts.facts as unknown as Record<string, unknown>, record.estimate) } : {}),
  };
}

/** Explicit copy of a department task participant; identity only where allowed. */
export function toTaskParticipant(p: TaskParticipantRecord, withIdentity: boolean): TaskParticipantView {
  const hasIdentity = p.dateOfBirth !== undefined || p.nationality !== undefined || p.passportNumber !== undefined || p.passportExpiry !== undefined;
  return {
    seq: p.seq,
    fullName: p.fullName,
    type: p.type,
    ageYears: p.ageYears,
    specialNeeds: p.specialNeeds,
    ...(withIdentity && hasIdentity
      ? {
          identity: {
            dateOfBirth: p.dateOfBirth ?? null,
            nationality: p.nationality ?? null,
            passportNumber: p.passportNumber ?? null,
            passportExpiry: p.passportExpiry ?? null,
            rowVersion: 0,
          },
        }
      : {}),
  };
}

export function copyIdentity(i: TravellerIdentity): TravellerIdentity {
  return {
    dateOfBirth: i.dateOfBirth,
    nationality: i.nationality,
    passportNumber: i.passportNumber,
    passportExpiry: i.passportExpiry,
    rowVersion: i.rowVersion,
  };
}

function taskExtras(
  record: { participants?: TaskParticipantRecord[]; changedFields?: string[] },
  withIdentity: boolean,
): Pick<PurchaseTaskView, 'participants' | 'changedFields'> {
  return {
    ...(record.participants !== undefined ? { participants: record.participants.map((p) => toTaskParticipant(p, withIdentity)) } : {}),
    ...(record.changedFields !== undefined ? { changedFields: [...record.changedFields] } : {}),
  };
}

export function toFlightTaskSummary(record: FlightTaskRecord): FlightTaskSummary {
  const facts = copyFacts({ type: 'flight', facts: record.facts });
  if (facts.type !== 'flight') throw new BookingShapeError('flight task without flight facts');
  return {
    taskId: record.taskId,
    dealReference: record.dealReference,
    itemTitle: itemTitle({ type: 'flight', facts: record.facts }),
    facts: facts.facts,
    purchaseBudgetPaise: record.purchaseBudgetPaise,
    status: record.status,
    assigneeName: record.assigneeName,
    assignedToYou: record.assignedToYou,
    branchName: record.branchName,
    createdAt: record.createdAt,
    supplierConfirmedAt: record.supplierConfirmedAt,
  };
}

export function toFlightTaskView(record: FlightTaskDetailRecord): FlightTaskView {
  const summary = toFlightTaskSummary(record);
  return {
    taskId: summary.taskId,
    dealReference: summary.dealReference,
    itemTitle: summary.itemTitle,
    facts: summary.facts,
    purchaseBudgetPaise: summary.purchaseBudgetPaise,
    status: summary.status,
    assigneeName: summary.assigneeName,
    assignedToYou: summary.assignedToYou,
    branchName: summary.branchName,
    createdAt: summary.createdAt,
    supplierConfirmedAt: summary.supplierConfirmedAt,
    confirmedAt: record.confirmedAt,
    confirmedByName: record.confirmedByName,
    versionNo: record.versionNo,
    canClaim: record.canClaim,
    travellerCount: record.travellerCount,
    // Identity reaches Flight only when the database sent it (assignee, international trip).
    ...taskExtras(record, true),
    ...(record.tripScope !== undefined ? { tripScope: record.tripScope } : {}),
    // Booking form: estimated fare and stored screenshots, when the database sent them to this assignee.
    ...(record.estimate !== undefined ? { estimate: estimateView('flight', summary.facts as unknown as Record<string, unknown>, record.estimate) } : {}),
    ...(record.files !== undefined ? { files: flightTaskFiles(record.files) } : {}),
  };
}

/** Stored screenshots only; downloads go through the Flight route (authorized again there); never removable from the task. */
function flightTaskFiles(files: readonly TaskFileRecord[]): ServiceItemFileView[] {
  return files
    .filter((f) => f.status === 'stored')
    .map((f) => ({
      fileId: f.fileId,
      kind: f.kind,
      fileName: f.fileName,
      sizeLabel: formatEvidenceSize(f.sizeBytes),
      uploadedAt: f.storedAt ?? f.createdAt,
      uploadedByYou: f.uploadedByYou === true,
      downloadHref: `/app/flight/files/${f.fileId}`,
      canRemove: false,
    }));
}

export function toBookingHealthView(record: BookingHealthRecord): BookingHealthView {
  return {
    realBookingEnabled: record.realBookingEnabled,
    environment: record.environment,
    drafts: record.drafts,
    draftsNeedingRepair: record.draftsNeedingRepair,
    confirmed: record.confirmed,
    tasksNotStarted: record.tasksNotStarted,
    tasksInProgress: record.tasksInProgress,
    pendingOutboxEvents: record.pendingOutboxEvents,
  };
}
