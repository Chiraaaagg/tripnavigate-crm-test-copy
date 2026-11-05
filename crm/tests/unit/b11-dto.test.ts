import { describe, expect, it } from 'vitest';
import type { ViewerAccess } from '@/modules/access/policy';
import {
  BookingFormSchema,
  BookingPanelB11Schema,
  HistoryRowSchema,
  VisaTaskDetailSchema,
  WorkFormSchema,
} from '@/modules/fulfilment/b11-commands';
import { toBookNowView, toDepartmentWorkFormView, toVisaTaskSummary, toVisaTaskView } from '@/modules/fulfilment/b11-dto';
import { FlightSummarySchema } from '@/modules/fulfilment/commands';
import { toFlightTaskView, toPurchaseTaskView } from '@/modules/fulfilment/dto';
import { SalesPaymentClaimsSchema } from '@/modules/finance/dto';
import { z } from 'zod';

/**
 * B1.1 DTO allowlists: the Book now view carries commercial members only for
 * commercial readers and only when the database sent them; desk, Purchase
 * and Flight DTOs carry no selling price, list price, discount, plan, claims,
 * receipts, contacts or billing; identity only where the database allowed it.
 * Synthetic data only.
 */

const ENTITY = 'e0000000-0000-4000-8000-000000000001';
const BRANCH = 'b0000000-0000-4000-8000-000000000001';
const OWNER = 'a0000000-0000-4000-8000-000000000001';
const OTHER = 'a0000000-0000-4000-8000-000000000002';
const DEAL = 'd0000000-0000-4000-8000-000000000001';
const VERSION = '11111111-1111-4111-8111-111111111111';
const BASE = '11111111-1111-4111-8111-111111111110';
const TASK = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';
const ITEM2 = '33333333-3333-4333-8333-333333333334';
const TRAV = '44444444-4444-4444-8444-444444444444';
const APP = '55555555-5555-4555-8555-555555555555';
const ENTRY = '66666666-6666-4666-8666-666666666666';
const CLAIM = '88888888-8888-4888-8888-888888888888';
const HASH = 'c'.repeat(64);

const rolePermissions: ViewerAccess['rolePermissions'] = [
  { roleCode: 'sales', permissionCode: 'deal.read', scope: 'own' },
  { roleCode: 'sales', permissionCode: 'deal.read_commercial', scope: 'own' },
  { roleCode: 'manager', permissionCode: 'deal.read', scope: 'entity' },
];
const sales: ViewerAccess = { userId: OWNER, memberships: [{ legalEntityId: ENTITY, branchId: BRANCH, roleCode: 'sales' }], rolePermissions, grants: [] };
const noCommercial: ViewerAccess = { userId: OTHER, memberships: [{ legalEntityId: ENTITY, branchId: BRANCH, roleCode: 'manager' }], rolePermissions, grants: [] };
const deal = {
  id: DEAL,
  legalEntityId: ENTITY,
  branchId: BRANCH,
  ownerUserId: OWNER,
  activeAssigneeIds: [],
  reference: 'SYN-JOD-012',
  title: 'Synthetic Bangkok trip',
  sourceSystem: 'bitrix',
  sourceStageId: 'UC_AD0SLH',
};

const visaItem = {
  itemId: ITEM,
  itemNo: 1,
  serviceType: 'visa',
  department: 'visa',
  state: 'planned',
  facts: { type: 'visa', facts: { country: 'Thailand', purpose: 'Tourism', travelDate: '2026-12-10', feePaidBy: 'customer' } },
  factsHash: HASH,
  task: null,
  participants: [1],
};
const flightItem = {
  itemId: ITEM2,
  itemNo: 2,
  serviceType: 'flight',
  department: 'flight',
  state: 'planned',
  facts: { type: 'flight', facts: { segments: [{ from: 'DEL', to: 'BKK', date: '2026-12-10' }], passengers: 2 } },
  purchaseBudgetPaise: '4000000',
  factsHash: HASH,
  task: null,
  participants: [1, 2],
};

const formRecord = (over: Record<string, unknown> = {}) =>
  BookingFormSchema.parse({
    dealId: DEAL,
    canEdit: true,
    canConfirm: true,
    serviceItemsEnabled: true,
    visaPassportTasksEnabled: false,
    dealNotActive: false,
    version: { versionId: VERSION, versionNo: 2, status: 'draft', serviceType: 'package', rowVersion: 5, contentHash: HASH, updatedAt: '2026-10-11T08:30:00Z', updatedByName: 'Sample Sales (synthetic)', confirmedAt: null },
    trip: { destination: 'Bangkok', scope: 'international', start: '2026-12-10', end: '2026-12-15' },
    contacts: { contactName: 'Synthetic Customer', mobile: '9876543210', email: null, contactConfirmed: true, confirmedAt: '2026-10-11T08:00:00Z', confirmedByName: 'Sample Sales (synthetic)', bookingFor: 'individual', payerDifferent: false, payerName: null },
    billing: { status: 'none', prefillSource: null, rowVersion: 0 },
    travellers: [
      { travellerId: TRAV, seq: 1, fullName: 'Asha Synthetic', type: 'adult', ageYears: null, specialNeeds: null, identity: { dateOfBirth: '1990-01-01', nationality: 'Indian', passportNumber: 'K1234567', passportExpiry: '2030-01-01', rowVersion: 2 } },
      { travellerId: null, seq: 2, fullName: 'Ravi Synthetic', type: 'child', ageYears: 9, specialNeeds: 'Vegetarian', identity: null },
      { travellerId: null, seq: 3, fullName: 'Mira Synthetic', type: 'adult', ageYears: null, specialNeeds: null, identity: null },
    ],
    items: [visaItem, flightItem],
    evidence: [],
    commercials: { listPricePaise: '25000000', discountPaise: '500000', sellingTotalPaise: '24500000' },
    plan: [
      { seq: 2, label: 'Balance', amountPaise: '14500000', dueDate: '2026-12-01' },
      { seq: 1, label: 'Advance', amountPaise: '10000000', dueDate: '2026-10-20' },
    ],
    ...over,
  });

const panelRecord = (over: Record<string, unknown> = {}) =>
  BookingPanelB11Schema.parse({
    dealId: DEAL,
    canEdit: true,
    canConfirm: true,
    gate: { realBookingEnabled: false, environment: 'test' },
    version: null,
    readiness: { ready: false, issues: ['missing_acceptance_proof'], contentHash: 'd'.repeat(64) },
    evidence: [],
    evidenceVisible: true,
    task: null,
    ...over,
  });

const claims = SalesPaymentClaimsSchema.parse({
  dealId: DEAL,
  sellingTotalPaise: '24500000',
  reportedPaise: '10000000',
  confirmedPaise: '0',
  balancePaise: '24500000',
  canReport: true,
  reportBlock: null,
  destinations: [],
  claims: [
    {
      claimId: CLAIM,
      status: 'reported',
      displayStatus: 'reported',
      amountPaise: '10000000',
      mode: 'cash',
      reference: null,
      chequeNumber: null,
      chequeDate: null,
      paidOn: '2026-10-10',
      payerName: 'Synthetic Customer',
      note: null,
      destinationLabel: null,
      receiptAmountPaise: null,
      notReceivedReason: null,
      reportedByName: 'Sample Sales (synthetic)',
      reportedAt: '2026-10-10T09:00:00Z',
      rowVersion: 1,
      canWithdraw: true,
    },
  ],
});

function keysOf(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => keysOf(v, prefix));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [`${prefix}.${k}`, ...keysOf(v, `${prefix}.${k}`)]);
  }
  return [];
}

const COMMERCIAL = /sellingTotal|listPrice|discount|\.plan($|\.)|paymentPlan|instalment|\.claims?($|\.)|claimId|\.receipts?($|\.)|receiptNo|receiptAmount|reportedPaise|confirmedPaise|balance/i;
const CUSTOMER = /contact|mobile|email|billing|gstin|payer/i;
const IDENTITY = /dateOfBirth|nationality|passportNumber|passportExpiry/;

describe('toBookNowView', () => {
  it('composes the form for a commercial editor: version who/when, identity rule, plan by seq, claims, checklist', () => {
    const view = toBookNowView({ viewer: sales, deal, form: formRecord(), panel: panelRecord(), checklist: null, claims, history: null });
    expect(view.version).toMatchObject({ versionNo: 2, status: 'draft', savedByName: 'Sample Sales (synthetic)', savedAt: '2026-10-11T08:30:00Z', contentHash: 'd'.repeat(64) });
    expect(view.travellers.map((t) => [t.seq, t.identityRequired])).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ]);
    expect(view.travellers[0]!.identity).toEqual({ dateOfBirth: '1990-01-01', nationality: 'Indian', passportNumber: 'K1234567', passportExpiry: '2030-01-01', rowVersion: 2 });
    expect(view.commercials).toEqual({ listPricePaise: '25000000', discountPaise: '500000', sellingTotalPaise: '24500000' });
    expect(view.plan!.map((p) => p.seq)).toEqual([1, 2]);
    expect(view.claims?.claims[0]?.claimId).toBe(CLAIM);
    expect(view.checklist.map((i) => i.code)).toEqual(['missing_acceptance_proof']);
    expect(view.canSubmit).toBe(false);
    expect(view.stepStatus.finish).toBe('needs_input');
    expect(view.sectionStatus.review).toBe('needs_input');
    expect(view.items[0]).toMatchObject({ participants: [1], serviceType: 'visa', department: 'visa' });
  });

  it('commercial editing follows booking_form_get.canEditCommercials; ask-owner checklist codes parse', () => {
    expect(toBookNowView({ viewer: sales, deal, form: formRecord(), panel: panelRecord(), checklist: null }).canEditCommercials).toBe(true);
    expect(toBookNowView({ viewer: sales, deal, form: formRecord({ canEditCommercials: false }), panel: panelRecord(), checklist: null }).canEditCommercials).toBe(false);
    const askOwner = { items: [{ code: 'selling_total_ask_owner' as const, blocking: true, owner: 'sales' as const, itemNos: [] }, { code: 'plan_ask_owner' as const, blocking: true, owner: 'sales' as const, itemNos: [] }], canConfirm: false };
    const view = toBookNowView({ viewer: noCommercial, deal, form: formRecord({ canEditCommercials: false }), panel: panelRecord(), checklist: askOwner });
    expect(view.canEditCommercials).toBe(false);
    expect(view.checklist.map((i) => [i.code, i.step, i.section])).toEqual([
      ['selling_total_ask_owner', 'finish', 'price'],
      ['plan_ask_owner', 'finish', 'payment'],
      ['missing_acceptance_proof', 'finish', 'review'],
    ]);
  });

  it('B1.2: a draft converted from a quotation carries its source and the acceptance link (booking_form_get.sourceQuotation)', () => {
    const source = { quotationId: 'a1000000-0000-4000-8000-000000000001', reference: 'TQ-12', versionId: 'a2000000-0000-4000-8000-000000000001', versionNo: 2, acceptedAt: '2026-10-13T08:00:00Z', acceptedTierKey: 'upgrade', acceptanceEvidenceId: 'a4000000-0000-4000-8000-000000000001' };
    const view = toBookNowView({ viewer: sales, deal, form: formRecord({ sourceQuotation: source }), panel: panelRecord(), checklist: null });
    expect(view.quotationSource).toEqual({
      quotationId: source.quotationId,
      reference: 'TQ-12',
      versionId: source.versionId,
      versionNo: 2,
      acceptedAt: source.acceptedAt,
      acceptedTierKey: 'upgrade',
      acceptanceHref: `/app/quotations/evidence/${source.acceptanceEvidenceId}`,
    });
    expect(toBookNowView({ viewer: sales, deal, form: formRecord({ sourceQuotation: null }), panel: panelRecord(), checklist: null })).not.toHaveProperty('quotationSource');
    expect(toBookNowView({ viewer: sales, deal, form: formRecord({ sourceQuotation: { ...source, acceptanceEvidenceId: null } }), panel: panelRecord(), checklist: null }).quotationSource?.acceptanceHref).toBeNull();
  });

  it('B1.2: identity proofs per traveller only where the database sent them; limits copied; old database → null limits', () => {
    const proof = { fileId: '99999999-9999-4999-8999-999999999999', fileName: 'id.pdf', mime: 'application/pdf', sizeBytes: 2048, status: 'stored', rowVersion: 2, uploadedByName: null, uploadedByYou: false, consentByName: 'Sample Sales (synthetic)', consentAt: '2026-10-12T08:29:00Z', createdAt: '2026-10-12T08:30:00Z', storedAt: '2026-10-12T08:30:02Z' };
    const base = formRecord();
    const travellers = (base.travellers as unknown as Array<Record<string, unknown>>).map((t, i) => (i === 0 ? { ...t, idProofs: [proof] } : t));
    const form = formRecord({ travellers, idProofLimits: { maxFilesPerTraveller: 4, maxBytes: 4194304 }, idProofCanEdit: true, idProofCanRemove: true });
    const view = toBookNowView({ viewer: sales, deal, form, panel: panelRecord(), checklist: null });
    expect(view.travellers[0]!.idProofs).toEqual([expect.objectContaining({ fileId: proof.fileId, downloadHref: `/app/id-proofs/${proof.fileId}`, consentByName: 'Sample Sales (synthetic)' })]);
    expect(view.travellers[1]).not.toHaveProperty('idProofs');
    expect(view.idProofLimits).toEqual({ maxFilesPerTraveller: 4, maxBytes: 4194304 });
    expect(view.idProofCanEdit).toBe(true);
    const old = toBookNowView({ viewer: sales, deal, form: formRecord(), panel: panelRecord(), checklist: null });
    expect(old.idProofLimits).toBeNull();
    expect(old.idProofCanEdit).toBe(false);
    expect(old.idProofCanRemove).toBe(false);
    // D2-3: after submission canEdit is false but attaching stays allowed when the database says so.
    const confirmed = toBookNowView({ viewer: sales, deal, form: formRecord({ canEdit: false, idProofCanEdit: true, version: { ...(formRecord().version as object), status: 'confirmed' } }), panel: panelRecord(), checklist: null });
    expect(confirmed.canEdit).toBe(false);
    expect(confirmed.idProofCanEdit).toBe(true);
    // D3: switch off or lost Deal → attach paused, remove still allowed.
    const paused = toBookNowView({ viewer: sales, deal, form: formRecord({ idProofCanEdit: false, idProofCanRemove: true }), panel: panelRecord(), checklist: null });
    expect([paused.idProofCanEdit, paused.idProofCanRemove]).toEqual([false, true]);
    // D3: a sync-removed Deal → no idProofs anywhere and both flags false.
    const removed = toBookNowView({ viewer: sales, deal, form: formRecord({ idProofCanEdit: false, idProofCanRemove: false }), panel: panelRecord(), checklist: null });
    expect(removed.travellers.every((t) => !('idProofs' in t))).toBe(true);
    expect([removed.idProofCanEdit, removed.idProofCanRemove]).toEqual([false, false]);
  });

  it('leaves commercial members out for a viewer without commercial scope, even when the database sent them', () => {
    const view = toBookNowView({ viewer: noCommercial, deal, form: formRecord(), panel: panelRecord(), checklist: null, claims, history: null });
    expect(view).not.toHaveProperty('commercials');
    expect(view).not.toHaveProperty('plan');
    expect(view).not.toHaveProperty('claims');
  });

  it('leaves commercials out when the database withheld them (absent key), but shows a null row as empty', () => {
    const withheld = formRecord();
    delete (withheld as Record<string, unknown>).commercials;
    delete (withheld as Record<string, unknown>).plan;
    const a = toBookNowView({ viewer: sales, deal, form: withheld, panel: panelRecord(), checklist: null });
    expect(a).not.toHaveProperty('commercials');
    const b = toBookNowView({ viewer: sales, deal, form: formRecord({ commercials: null, plan: [] }), panel: panelRecord(), checklist: null });
    expect(b.commercials).toEqual({ listPricePaise: null, discountPaise: null, sellingTotalPaise: null });
    expect(b.plan).toEqual([]);
  });

  it('not started, lost Deal, switch off and other reasons in plain words', () => {
    const none = toBookNowView({ viewer: sales, deal, form: formRecord({ version: null }), panel: panelRecord(), checklist: null });
    expect(none.version).toBeNull();
    expect(none.openBlockedReason).toBeNull();
    expect(Object.values(none.stepStatus)).toEqual(Array(3).fill('needs_input'));
    expect(Object.values(none.sectionStatus)).toEqual(Array(9).fill('needs_input'));
    const lost = toBookNowView({ viewer: sales, deal, form: formRecord({ version: null, dealNotActive: true }), panel: panelRecord(), checklist: null });
    expect(lost.openBlockedReason).toMatch(/lost or rejected/);
    expect(lost.canEdit).toBe(false);
    const notWon = toBookNowView({ viewer: sales, deal, form: formRecord(), panel: panelRecord({ readiness: { ready: false, issues: ['stage_not_confirmed'], contentHash: HASH } }), checklist: null });
    expect(notWon.submitBlockedReason).toMatch(/Won - Payment Received/);
    expect(notWon.stage).toEqual({ stageId: 'UC_AD0SLH', label: null, isTriggerStage: false });
  });

  it('revision: base number from history, change class from the panel, hidden reasons stay hidden', () => {
    const history = z.array(HistoryRowSchema).parse([
      { versionId: BASE, versionNo: 1, status: 'confirmed', confirmedAt: '2026-10-09T10:00:00Z', reviewStatus: 'returned', reviewReason: 'Old reason', reviewReasonHidden: true, sellingTotalPaise: '24000000' },
      { versionId: VERSION, versionNo: 2, status: 'draft', revisesVersionId: BASE, changeClass: null, changedFields: [], reviewStatus: null },
    ]);
    const form = formRecord({ version: { versionId: VERSION, versionNo: 2, status: 'draft', rowVersion: 5, contentHash: HASH, revisesVersionId: BASE } });
    const panel = panelRecord({
      revision: { versionId: VERSION, versionNo: 2, rowVersion: 5, contentHash: HASH, changeClass: 'customer_material', changedFields: ['items.1.travelDate'], allowedClasses: ['customer_material'], readiness: { issues: [] } },
      accountsReview: { status: 'returned', reviewedAt: '2026-10-10T10:00:00Z', reason: 'Wrong travel date', reasonHidden: false },
      canRevise: false,
    });
    const view = toBookNowView({ viewer: sales, deal, form, panel, checklist: null, history });
    expect(view.version).toMatchObject({ revisesVersionId: BASE, revisesVersionNo: 1, changeClass: 'customer_material', changedFields: ['items.1.travelDate'], allowedClasses: ['customer_material'] });
    expect(view.accountsReview).toEqual({ status: 'returned', reviewedAt: '2026-10-10T10:00:00Z', reason: 'Wrong travel date', reasonHidden: false });
    expect(view.history![0]).toMatchObject({ reviewReason: null, reviewReasonHidden: true, sellingTotalPaise: '24000000' });
    const blind = toBookNowView({ viewer: noCommercial, deal, form, panel, checklist: null, history });
    expect(blind.history![0]).not.toHaveProperty('sellingTotalPaise');
  });

  it('refuses reads of another Deal', () => {
    expect(() => toBookNowView({ viewer: sales, deal: { ...deal, id: VERSION }, form: formRecord(), panel: panelRecord(), checklist: null })).toThrow('do not belong');
  });
});

describe('Visa & Passport desk DTOs', () => {
  const detailInput = {
    taskId: TASK,
    dealReference: 'SYN-JOD-012',
    serviceType: 'visa',
    // visa_task_json sends the facts object itself (0500).
    facts: { country: 'Thailand', purpose: 'Tourism', travelDate: '2026-12-10', feePaidBy: 'company' },
    purchaseBudgetPaise: '300000',
    applicantCount: 1,
    status: 'in_progress',
    assigneeName: 'Desk (synthetic)',
    assignedToYou: true,
    branchName: 'Jodhpur',
    createdAt: '2026-10-11T09:00:00Z',
    completedAt: null,
    versionNo: 1,
    confirmedAt: '2026-10-11T08:59:00Z',
    canClaim: false,
    canWork: true,
    applicants: [
      {
        applicationId: APP,
        seq: 1,
        fullName: 'Asha Synthetic',
        type: 'adult',
        state: 'issued',
        documents: { passport_copy: 'checked', photo: 'received' },
        rowVersion: 3,
        closed: true,
        documentsReturnedAt: '2026-11-30T10:00:00Z',
        identity: { dateOfBirth: '1990-01-01', nationality: 'Indian', passportNumber: 'K1234567', passportExpiry: '2030-01-01', rowVersion: 2 },
      },
    ],
    evidence: [],
    costs: [{ entryId: ENTRY, costKind: 'government_fee', amountPaise: '250000', paidBy: 'company', paymentMode: 'upi', paidOn: '2026-11-01', expenseStatus: 'draft', rowVersion: 1 }],
  };
  const detail = VisaTaskDetailSchema.parse(detailInput);

  it('carries no budget, price, plan, claim, contact or billing key', () => {
    const view = toVisaTaskView(detail);
    const keys = keysOf(view);
    expect(keys.filter((k) => /budget/i.test(k))).toEqual([]);
    expect(keys.filter((k) => COMMERCIAL.test(k))).toEqual([]);
    expect(keys.filter((k) => CUSTOMER.test(k))).toEqual([]);
    expect(keysOf(toVisaTaskSummary(detail)).filter((k) => /budget/i.test(k))).toEqual([]);
  });

  it('before the task is taken: applicants without an application, typed facts, applicant count', () => {
    const untaken = VisaTaskDetailSchema.parse({
      ...detailInput,
      status: 'not_started',
      assignedToYou: false,
      canClaim: true,
      canWork: false,
      applicants: [{ applicationId: null, seq: 1, fullName: null, type: null, ageYears: null, state: null, documents: {}, rowVersion: null, closed: false }],
      costs: [],
    });
    const view = toVisaTaskView(untaken);
    expect(view.applicants[0]).toMatchObject({ applicationId: null, state: null, rowVersion: null, fullName: 'Traveller 1', closed: false });
    expect(view.facts).toMatchObject({ country: 'Thailand' });
    expect(view.applicantCount).toBe(1);
    expect(VisaTaskDetailSchema.safeParse({ ...detailInput, facts: { country: 'Thailand' } }).success).toBe(false);
  });

  it('documents as sorted rows with labels; closed applicant; cost actions follow the worker and status', () => {
    const view = toVisaTaskView(detail);
    expect(view.applicants[0]!.documents).toEqual([
      { code: 'passport_copy', label: 'Passport copy', status: 'checked' },
      { code: 'photo', label: 'Photo', status: 'received' },
    ]);
    expect(view.applicants[0]!.closed).toBe(true);
    expect(view.canWork).toBe(true);
    expect(view.costs[0]).toMatchObject({ canEdit: true, canSubmit: true, department: 'visa' });
    const other = toVisaTaskView({ ...detail, assignedToYou: false, canWork: false });
    expect(other.costs[0]).toMatchObject({ canEdit: false, canSubmit: false });
  });
});

describe('department work form', () => {
  it('Purchase gets the read-only placeholder and no costs; Flight gets the direct-payment limit', () => {
    const purchase = toDepartmentWorkFormView(
      WorkFormSchema.parse({ taskId: TASK, department: 'purchase', costs: [{ entryId: ENTRY, costKind: 'other', amountPaise: '1', paidBy: 'not_yet', rowVersion: 1 }], canWork: true }),
    );
    expect(purchase).toMatchObject({ costs: [], canRecordCost: false, readOnlyReason: 'Costs are recorded in the supplier work.', directLimitPaise: null });
    const flight = toDepartmentWorkFormView(WorkFormSchema.parse({ taskId: TASK, department: 'flight', canWork: true }));
    expect(flight).toMatchObject({ canRecordCost: true, directLimitPaise: '5000000', readOnlyReason: null });
  });
});

describe('Purchase and Flight participants', () => {
  const flightDetail = FlightSummarySchema.extend({}).parse({
    taskId: TASK,
    dealReference: 'SYN-JOD-012',
    itemTitle: 'DEL → BKK',
    facts: { segments: [{ from: 'DEL', to: 'BKK', date: '2026-12-10' }], passengers: 2 },
    purchaseBudgetPaise: '4000000',
    status: 'in_progress',
    assigneeName: null,
    assignedToYou: true,
    branchName: 'Jodhpur',
    createdAt: '2026-10-11T09:00:00Z',
  });

  it('Flight shows identity only when the database sent it; Purchase never does', () => {
    const participants = [
      { seq: 1, fullName: 'Asha Synthetic', type: 'adult', ageYears: null, specialNeeds: null, dateOfBirth: '1990-01-01', nationality: 'Indian', passportNumber: 'K1234567', passportExpiry: '2030-01-01' },
      { seq: 2, fullName: 'Ravi Synthetic', type: 'child', ageYears: 9, specialNeeds: 'Vegetarian' },
    ];
    const flight = toFlightTaskView({
      ...flightDetail,
      confirmedAt: '2026-10-11T08:59:00Z',
      confirmedByName: 'Sample Sales (synthetic)',
      versionNo: 1,
      canClaim: false,
      travellerCount: 2,
      participants: participants as never,
      tripScope: 'international',
    } as never);
    expect(flight.participants![0]!.identity).toMatchObject({ passportNumber: 'K1234567' });
    expect(flight.participants![1]).not.toHaveProperty('identity');
    expect(flight.tripScope).toBe('international');

    const purchase = toPurchaseTaskView({
      taskId: TASK,
      dealReference: 'SYN-JOD-012',
      serviceType: 'hotel',
      facts: { type: 'hotel', facts: { hotelName: 'Synthetic Palace', city: 'Bangkok', checkIn: '2026-12-10', checkOut: '2026-12-15', rooms: 1, adults: 2, roomType: null, mealPlan: null, children: null, inclusions: null, specialRequests: null } },
      hotelName: 'Synthetic Palace',
      city: 'Bangkok',
      checkIn: '2026-12-10',
      checkOut: '2026-12-15',
      rooms: 1,
      adults: 2,
      children: 0,
      purchaseBudgetPaise: '1000000',
      status: 'not_started',
      assigneeName: null,
      assignedToYou: false,
      branchName: 'Jodhpur',
      createdAt: '2026-10-11T09:00:00Z',
      supplierConfirmedAt: null,
      roomType: null,
      mealPlan: null,
      inclusions: null,
      specialRequests: null,
      confirmedAt: '2026-10-11T08:59:00Z',
      confirmedByName: 'Sample Sales (synthetic)',
      versionNo: 1,
      canClaim: true,
      participants: participants as never,
    } as never);
    expect(keysOf(purchase).filter((k) => IDENTITY.test(k))).toEqual([]);
    expect(keysOf(purchase).filter((k) => COMMERCIAL.test(k) || CUSTOMER.test(k))).toEqual([]);
    expect(purchase.participants!.map((p) => p.fullName)).toEqual(['Asha Synthetic', 'Ravi Synthetic']);
  });
});

describe('no fail-closed size caps on unbounded finance arrays (Mercury review F3)', () => {
  it('a Deal with 250 claims and 60 company accounts still parses', async () => {
    const { SalesPaymentClaimsSchema: S } = await import('@/modules/finance/dto');
    const claim = {
      claimId: CLAIM,
      status: 'reported',
      displayStatus: 'reported',
      amountPaise: '100',
      mode: 'cash',
      reference: null,
      chequeNumber: null,
      chequeDate: null,
      paidOn: '2026-10-10',
      payerName: 'Synthetic',
      note: null,
      destinationLabel: null,
      receiptAmountPaise: null,
      notReceivedReason: null,
      reportedByName: null,
      reportedAt: '2026-10-10T09:00:00Z',
      rowVersion: 1,
      canWithdraw: true,
    };
    const destination = { versionId: CLAIM, kind: 'bank', label: 'Synthetic', bankName: null, accountMasked: 'XXXX1234', upiMasked: null };
    const parsed = S.safeParse({
      dealId: DEAL,
      sellingTotalPaise: null,
      reportedPaise: '0',
      confirmedPaise: '-5',
      balancePaise: null,
      canReport: true,
      reportBlock: null,
      destinations: Array(60).fill(destination),
      claims: Array(250).fill(claim),
    });
    expect(parsed.success).toBe(true);
  });
});
