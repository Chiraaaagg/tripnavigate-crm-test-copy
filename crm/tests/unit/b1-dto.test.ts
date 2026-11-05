import { describe, expect, it } from 'vitest';
import type { ViewerAccess } from '@/modules/access/policy';
import {
  BookingPanelSchema,
  DealServiceSummarySchema,
  DealServicesSchema,
  FlightSummarySchema,
  ServiceItemRecordSchema,
  type DealServicesRecord,
  type FlightTaskDetailRecord,
  type PurchaseTaskDetailRecord,
  type PurchaseTaskRecord,
} from '@/modules/fulfilment/commands';
import { ERROR_TEXT, ISSUE_TEXT } from '@/modules/fulfilment/contracts';
import {
  BookingShapeError,
  itemTitle,
  toDealServiceSummary,
  toDealServicesView,
  toFlightTaskSummary,
  toFlightTaskView,
  toIntakeView,
  toMyWorkCounts,
  toPurchaseTaskSummary,
  toPurchaseTaskView,
  toServiceItemView,
  toWorkflowSettingsView,
} from '@/modules/fulfilment/dto';

/** B1 DTO shaping: explicit copies, derived titles/next steps/progress, and the Purchase/Flight exclusion walk. */

const ENTITY = 'e0000000-0000-4000-8000-000000000001';
const BRANCH = 'b0000000-0000-4000-8000-000000000001';
const OWNER = 'a0000000-0000-4000-8000-000000000001';
const PURCHASER = 'a0000000-0000-4000-8000-000000000009';
const DEAL = 'd0000000-0000-4000-8000-000000000001';
const VERSION = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';
const ITEM2 = '33333333-3333-4333-8333-333333333334';
const HASH = 'b'.repeat(64);

const hotelFacts = {
  type: 'hotel' as const,
  facts: { hotelName: 'Synthetic Palace', city: 'Jaipur', checkIn: '2026-11-01', checkOut: '2026-11-04', rooms: 1, adults: 2, children: 1 },
};
/** The same facts as the zod record carries them (optional keys present as null). */
const hotelFactsRecord = {
  type: 'hotel' as const,
  facts: { ...hotelFacts.facts, roomType: null, mealPlan: null, inclusions: null, specialRequests: null },
};
const flightFacts = {
  type: 'flight' as const,
  facts: {
    segments: [
      { from: 'DEL', to: 'JAI', date: '2026-11-01' },
      { from: 'JAI', to: 'DEL', date: '2026-11-04' },
    ],
    passengers: 3,
  },
};

const item = (over: Record<string, unknown> = {}) =>
  ServiceItemRecordSchema.parse({
    itemId: ITEM,
    itemNo: 1,
    serviceType: 'hotel',
    department: 'purchase',
    state: 'active',
    facts: hotelFacts,
    purchaseBudgetPaise: '4500000',
    factsHash: HASH,
    task: { taskId: TASK, status: 'in_progress', assigneeName: 'Synthetic Purchase', assignedToYou: false, supplierConfirmedAt: null },
    ...over,
  });

describe('itemTitle', () => {
  it('builds short titles per type', () => {
    expect(itemTitle(hotelFacts)).toBe('Synthetic Palace, Jaipur');
    expect(itemTitle({ type: 'transfer', facts: { route: 'Airport to hotel', date: '2026-11-01', vehicleType: 'Sedan', passengers: 2 } })).toBe('Airport to hotel');
    expect(itemTitle({ type: 'activity', facts: { name: 'City walk', city: 'Jaipur', date: '2026-11-02', participants: 2 } })).toBe('City walk, Jaipur');
    expect(itemTitle(flightFacts)).toBe('DEL → JAI → DEL');
  });
});

describe('toServiceItemView', () => {
  it('copies every field, derives title and next step, keeps the budget only when sent', () => {
    const view = toServiceItemView(item());
    expect(view).toEqual({
      itemId: ITEM,
      itemNo: 1,
      serviceType: 'hotel',
      department: 'purchase',
      state: 'active',
      title: 'Synthetic Palace, Jaipur',
      facts: { type: 'hotel', facts: { ...hotelFacts.facts, roomType: null, mealPlan: null, inclusions: null, specialRequests: null } },
      purchaseBudgetPaise: '4500000',
      factsHash: HASH,
      task: { taskId: TASK, status: 'in_progress', assigneeName: 'Synthetic Purchase', assignedToYou: false, supplierConfirmedAt: null },
      nextStep: 'supplier_confirmation',
    });
    const withheld = toServiceItemView(item({ purchaseBudgetPaise: undefined }));
    expect('purchaseBudgetPaise' in withheld).toBe(false);
    expect(toServiceItemView(item({ purchaseBudgetPaise: null })).purchaseBudgetPaise).toBeNull();
  });

  it('ignores a database-sent title or next step in favour of the derived ones (every screen agrees)', () => {
    const view = toServiceItemView(item({ title: 'Other', nextStep: 'done' }));
    expect(view.title).toBe('Synthetic Palace, Jaipur');
    expect(view.nextStep).toBe('supplier_confirmation');
  });

  it('refuses facts or department that do not match the service type', () => {
    expect(() => toServiceItemView(item({ facts: flightFacts }))).toThrow(BookingShapeError);
    expect(() => toServiceItemView(item({ department: 'flight' }))).toThrow(BookingShapeError);
  });
});

const servicesRecord = (over: Partial<DealServicesRecord> = {}): DealServicesRecord =>
  DealServicesSchema.parse({
    dealId: DEAL,
    version: { versionId: VERSION, versionNo: 1, status: 'draft', rowVersion: 3, contentHash: HASH, serviceType: 'package' },
    items: [
      item({ state: 'planned', task: null }),
      item({ itemId: ITEM2, itemNo: 2, serviceType: 'flight', department: 'flight', facts: flightFacts, state: 'planned', task: null, purchaseBudgetPaise: undefined }),
    ],
    travellers: [
      { fullName: 'Synthetic Adult', type: 'adult', seq: 1 },
      { fullName: 'Synthetic Child', type: 'child', seq: 2 },
    ],
    canEdit: true,
    canConfirm: true,
    ...over,
  });

describe('toDealServicesView', () => {
  it('computes progress from the items and keeps travellers only when sent', () => {
    const view = toDealServicesView(servicesRecord());
    expect(view.items.map((i) => i.nextStep)).toEqual(['confirm_version', 'confirm_version']);
    expect(view.progress).toEqual({
      total: 2,
      byState: { planned: 2, notStarted: 0, inProgress: 0, supplierConfirmed: 0 },
      fulfilled: false,
      staleCount: 0,
      needs: ['confirm_version'],
    });
    expect(view.travellers).toHaveLength(2);
    expect(view.version).toEqual({ versionId: VERSION, versionNo: 1, status: 'draft', rowVersion: 3, contentHash: HASH, serviceType: 'package' });

    const purchaseView = toDealServicesView(servicesRecord({ travellers: undefined }));
    expect('travellers' in purchaseView).toBe(false);
  });

  it('recomputes progress even when the database sent one', () => {
    const view = toDealServicesView(
      servicesRecord({ progress: { total: 9, byState: { planned: 9, notStarted: 0, inProgress: 0, supplierConfirmed: 0 }, fulfilled: true, staleCount: 4, needs: [] } }),
    );
    expect(view.progress.total).toBe(2);
    expect(view.progress.staleCount).toBe(0);
  });
});

describe('summaries, counts and switches', () => {
  it('copy explicitly', () => {
    const summary = toDealServiceSummary(
      DealServiceSummarySchema.parse({
        dealId: DEAL,
        serviceTypes: ['hotel', 'flight'],
        total: 2,
        byState: { planned: 0, notStarted: 1, inProgress: 0, supplierConfirmed: 1 },
        fulfilled: false,
        staleCount: 0,
        needs: ['take_task'],
      }),
    );
    expect(summary).toEqual({
      dealId: DEAL,
      serviceTypes: ['hotel', 'flight'],
      total: 2,
      byState: { planned: 0, notStarted: 1, inProgress: 0, supplierConfirmed: 1 },
      fulfilled: false,
      staleCount: 0,
      needs: ['take_task'],
    });
    expect(toMyWorkCounts({ waitingForMe: 1, returnedToMe: 0, missingDetails: 2, intakeNeeded: 0, receiptsToVerify: null, requestsToApprove: 0 })).toEqual({
      waitingForMe: 1,
      returnedToMe: 0,
      missingDetails: 2,
      intakeNeeded: 0,
      receiptsToVerify: null,
      requestsToApprove: 0,
      claimsToProcess: null,
      expensesToReview: null,
      visaTasksWaiting: null,
      // Batch 1 key: null on a database without migration 20261121000120.
      draftsToContinue: null,
      // Batch 3 keys (FP-081): null on a database without migration 20261123000100.
      quotationDraftsToFinish: null,
      acceptedQuotesToLink: null,
    });
    expect(toWorkflowSettingsView({ intakePromptEnabled: true, serviceItemsEnabled: false, updatedAt: null })).toEqual({
      intakePromptEnabled: true,
      serviceItemsEnabled: false,
      visaPassportTasksEnabled: false,
      updatedAt: null,
    });
  });
});

const purchaseRecord = (over: Record<string, unknown> = {}): PurchaseTaskRecord => ({
  taskId: TASK,
  dealReference: 'SYN-JOD-001',
  serviceType: 'hotel',
  itemTitle: 'Synthetic Palace, Jaipur',
  facts: hotelFactsRecord,
  hotelName: 'Synthetic Palace',
  city: 'Jaipur',
  checkIn: '2026-11-01',
  checkOut: '2026-11-04',
  rooms: 1,
  adults: 2,
  children: 1,
  purchaseBudgetPaise: '4500000',
  status: 'not_started',
  assigneeName: null,
  assignedToYou: false,
  branchName: 'Jodhpur',
  createdAt: '2026-10-03T05:00:00Z',
  supplierConfirmedAt: null,
  ...over,
});
const purchaseDetail = (over: Record<string, unknown> = {}): PurchaseTaskDetailRecord => ({
  ...purchaseRecord(over),
  roomType: null,
  mealPlan: null,
  inclusions: null,
  specialRequests: null,
  confirmedAt: '2026-10-03T04:00:00Z',
  confirmedByName: 'Synthetic Sales',
  versionNo: 1,
  canClaim: true,
  ...over,
});

describe('toPurchaseTaskSummary / toPurchaseTaskView', () => {
  it('carries service type, title and typed facts for a hotel task', () => {
    const view = toPurchaseTaskSummary(purchaseRecord());
    expect(view.serviceType).toBe('hotel');
    expect(view.itemTitle).toBe('Synthetic Palace, Jaipur');
    expect(view.facts.type).toBe('hotel');
    expect(view.nights).toBe(3);
    expect(view.travellers).toEqual({ adults: 2, children: 1 });
  });

  it('builds hotel facts from the columns on a database before B1 (no facts object)', () => {
    const view = toPurchaseTaskSummary(purchaseRecord({ serviceType: undefined, itemTitle: undefined, facts: undefined }));
    expect(view.serviceType).toBe('hotel');
    expect(view.itemTitle).toBe('Synthetic Palace, Jaipur');
    expect(view.facts).toEqual({ type: 'hotel', facts: { ...hotelFacts.facts, roomType: null, mealPlan: null, inclusions: null, specialRequests: null } });
    expect(() => toPurchaseTaskSummary(purchaseRecord({ facts: undefined, hotelName: null }))).toThrow(BookingShapeError);
  });

  it('nulls the hotel fields for a non-hotel task and refuses a type mismatch', () => {
    const transfer = { type: 'transfer' as const, facts: { route: 'Airport to hotel', date: '2026-11-01', vehicleType: 'Sedan', passengers: 2 } };
    const view = toPurchaseTaskSummary(
      purchaseRecord({ serviceType: 'transfer', itemTitle: 'Airport to hotel', facts: transfer, hotelName: null, city: null, checkIn: null, checkOut: null, rooms: 0, adults: 2, children: 0 }),
    );
    expect(view).toMatchObject({ serviceType: 'transfer', hotelName: null, city: null, checkIn: null, checkOut: null, nights: 0, rooms: 0, travellers: { adults: 2, children: 0 } });
    expect(() => toPurchaseTaskSummary(purchaseRecord({ serviceType: 'transfer' }))).toThrow(BookingShapeError);
  });

  it('the detail view falls back to the hotel facts for room type and the like', () => {
    const detail = toPurchaseTaskView(purchaseDetail({ facts: { type: 'hotel', facts: { ...hotelFacts.facts, roomType: 'Deluxe', mealPlan: 'CP' } } }));
    expect(detail.roomType).toBe('Deluxe');
    expect(detail.mealPlan).toBe('CP');
    expect(detail.canClaim).toBe(true);
    expect(toPurchaseTaskView(purchaseDetail({ roomType: 'Suite' })).roomType).toBe('Suite');
  });
});

const flightRecord = (): FlightTaskDetailRecord => ({
  ...FlightSummarySchema.parse({
    taskId: TASK,
    dealReference: 'SYN-JOD-001',
    itemTitle: 'DEL → JAI → DEL',
    facts: flightFacts.facts,
    purchaseBudgetPaise: '1200000',
    status: 'not_started',
    assigneeName: null,
    assignedToYou: false,
    branchName: 'Jodhpur',
    createdAt: '2026-10-03T05:00:00Z',
    supplierConfirmedAt: null,
  }),
  confirmedAt: '2026-10-03T04:00:00Z',
  confirmedByName: 'Synthetic Sales',
  versionNo: 1,
  canClaim: true,
  travellerCount: 3,
});

describe('Flight DTOs', () => {
  it('copy the flight facts and the traveller count, never names', () => {
    const view = toFlightTaskView(flightRecord());
    expect(view.facts.segments).toHaveLength(2);
    expect(view.travellerCount).toBe(3);
    expect(toFlightTaskSummary(flightRecord()).itemTitle).toBe('DEL → JAI → DEL');
    expect(JSON.stringify(view)).not.toMatch(/fullName|Synthetic Adult/);
  });
});

/** Walks every key (nested) of a value. */
function keysOf(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => keysOf(v, `${path}[${i}]`));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => [`${path}.${k}`, ...keysOf(v, `${path}.${k}`)]);
  }
  return [];
}
const FORBIDDEN = /selling|margin|evidence|acceptance|proof|commercial|lead|traveller(?!s$|Count$)|fullName/i;

describe('Purchase and Flight DTO exclusion (contract §6, DEC-06)', () => {
  it('no key of a Purchase or Flight DTO names a selling price, margin, proof file, Lead or traveller name', () => {
    const leaky = { sellingTotalPaise: '9', estimatedMarginPaise: '1', evidence: [{ id: 'x' }], acceptanceProof: 'y', leadId: 'z' };
    const views = [
      toPurchaseTaskSummary({ ...purchaseRecord(), ...leaky } as PurchaseTaskRecord),
      toPurchaseTaskView({ ...purchaseDetail(), ...leaky } as PurchaseTaskDetailRecord),
      toFlightTaskSummary({ ...flightRecord(), ...leaky } as FlightTaskDetailRecord),
      toFlightTaskView({ ...flightRecord(), ...leaky } as FlightTaskDetailRecord),
    ];
    for (const view of views) {
      const keys = keysOf(view);
      expect(keys.length).toBeGreaterThan(10);
      expect(keys.filter((k) => FORBIDDEN.test(k.split('.').pop()!))).toEqual([]);
      expect(JSON.stringify(view)).not.toMatch(/sellingTotalPaise|estimatedMargin|leadId|acceptanceProof/);
    }
  });

  it('a Purchase DTO never carries another department’s budget: one budget key, the task’s own', () => {
    const keys = keysOf(toPurchaseTaskSummary(purchaseRecord()));
    expect(keys.filter((k) => /budget/i.test(k))).toEqual(['.purchaseBudgetPaise']);
  });
});

// ---------------------------------------------------------------------------
// toIntakeView
// ---------------------------------------------------------------------------

const rolePermissions: ViewerAccess['rolePermissions'] = [
  { roleCode: 'sales', permissionCode: 'deal.read', scope: 'own' },
  { roleCode: 'sales', permissionCode: 'deal.read_commercial', scope: 'own' },
  { roleCode: 'manager', permissionCode: 'deal.read', scope: 'entity' },
];
const sales: ViewerAccess = { userId: OWNER, memberships: [{ legalEntityId: ENTITY, branchId: BRANCH, roleCode: 'sales' }], rolePermissions, grants: [] };
const manager: ViewerAccess = { userId: PURCHASER, memberships: [{ legalEntityId: ENTITY, branchId: BRANCH, roleCode: 'manager' }], rolePermissions, grants: [] };
const deal = {
  id: DEAL,
  legalEntityId: ENTITY,
  branchId: BRANCH,
  ownerUserId: OWNER,
  activeAssigneeIds: [],
  reference: 'SYN-JOD-001',
  title: 'Synthetic family trip',
  sourceSystem: 'bitrix',
  sourceStageId: 'UC_AD0SLH',
};
const panel = (over: Record<string, unknown> = {}) =>
  BookingPanelSchema.parse({
    dealId: DEAL,
    canEdit: true,
    canConfirm: true,
    gate: { realBookingEnabled: false, environment: 'test' },
    version: { versionId: VERSION, versionNo: 1, status: 'draft', rowVersion: 3, contentHash: HASH, facts: {}, sellingTotalPaise: '2000000' },
    readiness: { ready: false, issues: ['missing_acceptance_proof'], contentHash: HASH },
    evidence: [],
    evidenceVisible: true,
    task: null,
    ...over,
  });
const settings = { intakePromptEnabled: false, serviceItemsEnabled: true, updatedAt: null };
const checklist = (items: Array<{ code: string; blocking: boolean; owner: string }> = [], canConfirm = items.every((i) => !i.blocking)) =>
  ({ items: items.map((i) => ({ ...i, itemNos: [] })), canConfirm }) as never;

describe('toIntakeView', () => {
  it('composes the screen: stage, services, travellers, checklist, proof, selling total for commercial viewers', () => {
    const view = toIntakeView({ viewer: sales, deal, settings, panel: panel(), services: servicesRecord(), checklist: checklist() });
    expect(view).toMatchObject({
      dealId: DEAL,
      dealReference: 'SYN-JOD-001',
      dealTitle: 'Synthetic family trip',
      stage: { stageId: 'UC_AD0SLH', label: null, isTriggerStage: true },
      serviceItemsEnabled: true,
      prefillSource: 'crm',
      sellingTotalPaise: '2000000',
      evidenceVisible: true,
      canEdit: true,
      canConfirm: true,
      confirmBlockedReason: null,
      openBlockedReason: null,
      dealNotActive: false,
    });
    expect(view.travellers).toHaveLength(2);
    expect(view.services.items).toHaveLength(2);
    expect(view.checklist).toEqual({ items: [], canConfirm: true });
  });

  it('a blocking checklist item or the database saying no blocks confirmation', () => {
    const blocked = toIntakeView({
      viewer: sales,
      deal,
      settings,
      panel: panel(),
      services: servicesRecord(),
      checklist: checklist([{ code: 'stage_not_confirmed', blocking: true, owner: 'bitrix' }]),
    });
    expect(blocked.canConfirm).toBe(false);
    expect(blocked.stage?.isTriggerStage).toBe(false);
    expect(blocked.confirmBlockedReason).toBeNull();

    const notAllowed = toIntakeView({ viewer: sales, deal, settings, panel: panel(), services: servicesRecord({ canConfirm: false }), checklist: checklist() });
    expect(notAllowed.canConfirm).toBe(false);
    expect(notAllowed.confirmBlockedReason).toBe(ERROR_TEXT.not_authorized);

    const gated = toIntakeView({
      viewer: sales,
      deal,
      settings,
      panel: panel({ readiness: { ready: false, issues: ['booking_disabled'], contentHash: HASH } }),
      services: servicesRecord(),
      checklist: checklist([{ code: 'no_services', blocking: true, owner: 'sales' }]),
    });
    expect(gated.confirmBlockedReason).toBe(ISSUE_TEXT.booking_disabled);
  });

  it('omits the selling total for viewers without commercial scope and when the database withheld it', () => {
    const view = toIntakeView({ viewer: manager, deal, settings, panel: panel(), services: servicesRecord(), checklist: checklist() });
    expect('sellingTotalPaise' in view).toBe(false);
    const base = panel();
    const { sellingTotalPaise: _withheld, ...version } = base.version!;
    void _withheld;
    const withheld = toIntakeView({ viewer: sales, deal, settings, panel: { ...base, version }, services: servicesRecord(), checklist: checklist() });
    expect('sellingTotalPaise' in withheld).toBe(false);
  });

  it('a confirmed version is read-only; a lost Deal without a version explains why; synthetic Deals have no stage', () => {
    const confirmed = toIntakeView({
      viewer: sales,
      deal,
      settings,
      panel: panel(),
      services: servicesRecord({ version: { versionId: VERSION, versionNo: 1, status: 'confirmed', rowVersion: 3, contentHash: HASH, serviceType: 'package' } }),
      checklist: checklist(),
    });
    expect(confirmed.canEdit).toBe(false);
    expect(confirmed.canConfirm).toBe(false);

    const lost = toIntakeView({
      viewer: sales,
      deal: { ...deal, sourceSystem: null, sourceStageId: null },
      settings,
      panel: panel({ version: null, readiness: null, dealNotActive: true }),
      services: servicesRecord({ version: null, items: [], travellers: [] }),
      checklist: checklist(),
    });
    expect(lost.stage).toBeNull();
    expect(lost.openBlockedReason).toBe(ERROR_TEXT.deal_not_active);
    expect(lost.dealNotActive).toBe(true);
  });

  it('refuses reads that belong to another deal', () => {
    expect(() => toIntakeView({ viewer: sales, deal: { ...deal, id: VERSION }, settings, panel: panel(), services: servicesRecord(), checklist: checklist() })).toThrow(
      BookingShapeError,
    );
  });
});
