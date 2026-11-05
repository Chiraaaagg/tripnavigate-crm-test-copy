import type {
  BookChecklistItem,
  BookNowView,
  BookSection,
  BookServiceItemView,
  BookStep,
  BookStepStatus,
  BookTravellerView,
  DealProgress,
  TravellerIdProofView,
  ServiceFacts,
} from '@/modules/fulfilment/contracts';
import { CHECKLIST_STEP, CHECKLIST_TEXT, ISSUE_TEXT, PREFILL_FIELD_LABEL, type PrefillFieldCode, type PrefillMarkState } from '@/modules/fulfilment/contracts';
import type { PrefillMarkerVM, PrefillNoticeVM, PrefillSectionVM, PrefillUiVM } from '@/modules/fulfilment/prefill-contract';
import type { SalesPaymentClaims } from '@/modules/finance/contracts';
import { bookSectionStatus, bookStepStatus } from '@/modules/fulfilment/b11-dto';

/*
 * Synthetic fixtures for the B1.1 preview states. Every name, phone,
 * reference and amount is made up. Nothing here reaches a database.
 */

export const DEAL_ID = 'd0000000-0000-4000-8000-000000000112';
export const VERSION_ID = 'v0000000-0000-4000-8000-000000000112';

export function item(no: number, serviceType: BookServiceItemView['serviceType'], facts: Record<string, unknown>, extra: Partial<BookServiceItemView> = {}): BookServiceItemView {
  const department = serviceType === 'flight' ? 'flight' : serviceType === 'visa' || serviceType === 'passport' ? 'visa' : 'purchase';
  return {
    itemId: `i0000000-0000-4000-8000-${String(no).padStart(12, '0')}`,
    itemNo: no,
    serviceType,
    department,
    state: 'planned',
    title: String(facts.hotelName ?? facts.preferences ?? facts.name ?? facts.country ?? facts.officeCity ?? facts.route ?? 'DEL to DXB, DXB to DEL'),
    facts: { type: serviceType, facts } as unknown as ServiceFacts,
    purchaseBudgetPaise: serviceType === 'visa' || serviceType === 'passport' ? undefined : '2500000',
    factsHash: `hash-${no}`,
    task: null,
    nextStep: 'confirm_version',
    participants: [1, 2, 3],
    waitingForLaunch: false,
    ...extra,
  };
}

export const HOTEL_1 = item(1, 'hotel', { mode: 'specific', hotelName: 'Sample Lake Palace Hotel', city: 'Udaipur', checkIn: '2026-11-20', checkOut: '2026-11-23', rooms: 1, adults: 2, children: 1, childAges: [8], mealPlan: 'Breakfast' });
export const HOTEL_2 = item(2, 'hotel', { mode: 'preferences', hotelName: null, preferences: '4-star near the lake, with a pool', city: 'Mount Abu', checkIn: '2026-11-23', checkOut: '2026-11-25', rooms: 1, adults: 2, children: 1, childAges: [8] });
export const FLIGHT_1 = item(3, 'flight', { tripType: 'return', segments: [{ from: 'DEL', to: 'DXB', date: '2026-11-18' }, { from: 'DXB', to: 'DEL', date: '2026-11-26' }], passengers: 3, cabin: 'Economy' });
export const TRANSFER_1 = item(4, 'transfer', { pickup: 'Udaipur airport', drop: 'Sample Lake Palace Hotel', route: 'Udaipur airport to Sample Lake Palace Hotel', date: '2026-11-20', vehicleType: 'Sedan', passengers: 3 });
export const ACTIVITY_1 = item(5, 'activity', { name: 'Sample boat ride', city: 'Udaipur', date: '2026-11-21', participants: 3 });
export const VISA_1 = item(6, 'visa', { country: 'United Arab Emirates', purpose: 'Tourism', travelDate: '2026-11-18', feePaidBy: 'customer' });
export const PASSPORT_1 = item(1, 'passport', { applicationType: 'renewal', officeCity: 'Jaipur', neededBy: '2026-11-01' }, { participants: [1] });

export function idProof(no: number, over: Partial<TravellerIdProofView> = {}): TravellerIdProofView {
  const fileId = `f0000000-0000-4000-8000-${String(no).padStart(12, '0')}`;
  return {
    fileId,
    fileName: no % 2 === 1 ? `sample-id-front-${no}.jpg` : `sample-id-back-${no}.jpg`,
    mime: 'image/jpeg',
    sizeBytes: 820_000,
    sizeLabel: '820 KB',
    status: 'stored',
    rowVersion: 1,
    uploadedByName: 'Synthetic Sales Delhi A',
    uploadedByYou: true,
    uploadedAt: '2026-10-11T08:20:00.000Z',
    storedAt: '2026-10-11T08:20:02.000Z',
    consentByName: 'Synthetic Sales Delhi A',
    consentAt: '2026-10-11T08:20:00.000Z',
    downloadHref: '/preview/b12-book-id-proof',
    ...over,
  };
}

/** Traveller A: front and back stored; B: none yet (adult: blocks submission); child C: none (optional). */
export function travellers(withIdentity = false, proofs: Array<TravellerIdProofView[] | undefined> = [[idProof(1), idProof(2)], [], []]): BookTravellerView[] {
  return [
    { travellerId: 't1', seq: 1, fullName: 'Sample Traveller A', type: 'adult', ageYears: null, specialNeeds: null, identityRequired: withIdentity, identity: withIdentity ? { dateOfBirth: '1988-04-12', nationality: 'Indian', passportNumber: null, passportExpiry: null, rowVersion: 1 } : null, idProofs: proofs[0] },
    { travellerId: 't2', seq: 2, fullName: 'Sample Traveller B', type: 'adult', ageYears: null, specialNeeds: 'Vegetarian meals', identityRequired: withIdentity, identity: null, idProofs: proofs[1] },
    { travellerId: 't3', seq: 3, fullName: 'Sample Child C', type: 'child', ageYears: 8, specialNeeds: null, identityRequired: withIdentity, identity: null, idProofs: proofs[2] },
  ];
}

export function check(code: BookChecklistItem['code'], blocking: boolean, extra: Partial<BookChecklistItem> = {}): BookChecklistItem {
  const target = CHECKLIST_STEP[code];
  return {
    code,
    step: target?.step ?? 'finish',
    section: target?.section ?? 'review',
    field: target?.field ?? null,
    blocking,
    owner: code === 'stage_not_confirmed' ? 'bitrix' : code === 'billing_unverified' ? 'accounts' : code === 'visa_waiting_for_launch' ? 'admin' : 'sales',
    itemNos: [],
    travellerSeqs: [],
    text: (CHECKLIST_TEXT as Record<string, string>)[code] ?? (ISSUE_TEXT as Record<string, string>)[code] ?? code,
    ...extra,
  };
}

/** Step markers the way the DTO computes them (a step is the worst of its sections). */
export function statusFrom(checklist: BookChecklistItem[]): Record<BookStep, BookStepStatus> {
  return bookStepStatus(checklist, true);
}

export function sectionStatusFrom(checklist: BookChecklistItem[]): Record<BookSection, BookStepStatus> {
  return bookSectionStatus(checklist, true);
}

export const PROGRESS_DRAFT: DealProgress = { total: 4, byState: { planned: 4, notStarted: 0, inProgress: 0, supplierConfirmed: 0 }, fulfilled: false, staleCount: 0, needs: ['confirm_version'] };

export const CLAIMS_EMPTY: SalesPaymentClaims = {
  dealId: DEAL_ID,
  sellingTotalPaise: '12000000',
  reportedPaise: '0',
  confirmedPaise: '0',
  balancePaise: '12000000',
  canReport: true,
  reportBlock: null,
  destinations: [
    { versionId: 'dv1', kind: 'bank', label: 'Synthetic Bank •••• 4321', bankName: 'Synthetic Bank', accountMasked: '•••• 4321', upiMasked: null },
    { versionId: 'dv2', kind: 'upi', label: 'Synthetic UPI ••••@bank', bankName: null, accountMasked: null, upiMasked: '••••@bank' },
  ],
  claims: [],
};

/** A package draft with most details filled in; variants override parts. */
export function draftView(over: Partial<BookNowView> = {}): BookNowView {
  const checklist = over.checklist ?? [check('missing_acceptance_proof', true), check('billing_unverified', false)];
  const base: BookNowView = {
    dealId: DEAL_ID,
    dealReference: 'SYN-JOD-012',
    dealTitle: 'Synthetic family trip to Udaipur',
    stage: { stageId: 'UC_AD0SLH', label: 'Won - Payment Received', isTriggerStage: true },
    dealNotActive: false,
    serviceItemsEnabled: true,
    visaPassportTasksEnabled: false,
    gate: { realBookingEnabled: false, environment: 'test' },
    version: { versionId: VERSION_ID, versionNo: 1, status: 'draft', serviceType: 'package', confirmedAt: null, rowVersion: 7, contentHash: 'hash-v1', savedAt: '2026-10-11T08:35:00.000Z', savedByName: 'Synthetic Sales Delhi A', revisesVersionId: null, revisesVersionNo: null, changeClass: null, changedFields: [], allowedClasses: null },
    canEdit: true,
    canEditCommercials: true,
    canSubmit: true,
    submitBlockedReason: null,
    openBlockedReason: null,
    canOpenRevision: false,
    accountsReview: null,
    trip: { destination: 'Udaipur and Mount Abu', scope: 'domestic', start: '2026-11-20', end: '2026-11-25' },
    contacts: { contactName: 'Sample Customer A', mobile: '9876500012', email: null, contactConfirmed: true, confirmedAt: '2026-10-10T10:00:00.000Z', confirmedByName: 'Synthetic Sales Delhi A', bookingFor: 'individual', payerDifferent: false, payerName: null },
    billing: { status: 'draft', prefillSource: 'sales', rowVersion: 2, billingName: 'Sample Customer A', addressLine1: '12 Sample Street', addressLine2: null, city: 'Jodhpur', stateCode: '08', postalCode: '342001', gstin: null, editableBySales: true },
    travellers: travellers(),
    items: [HOTEL_1, HOTEL_2, TRANSFER_1, ACTIVITY_1],
    commercials: { listPricePaise: '13000000', discountPaise: '1000000', sellingTotalPaise: '12000000' },
    plan: [
      { seq: 1, label: 'Advance', amountPaise: '3000000', dueDate: '2026-10-12' },
      { seq: 2, label: 'Balance', amountPaise: '9000000', dueDate: '2026-11-10' },
    ],
    claims: CLAIMS_EMPTY,
    evidence: [],
    evidenceVisible: true,
    checklist,
    idProofCanEdit: true,
    idProofCanRemove: true,
    idProofLimits: { maxFilesPerTraveller: 4, maxBytes: 4 * 1024 * 1024 },
    stepStatus: statusFrom(checklist),
    sectionStatus: sectionStatusFrom(checklist),
    progress: PROGRESS_DRAFT,
  };
  const merged = { ...base, ...over };
  if (over.checklist && !over.stepStatus) merged.stepStatus = statusFrom(over.checklist);
  if (over.checklist && !over.sectionStatus) merged.sectionStatus = sectionStatusFrom(over.checklist);
  return merged;
}

export const EMPTY_DRAFT_CHECKLIST: BookChecklistItem[] = [
  check('contact_missing', true),
  check('billing_missing', true),
  check('trip_missing', true),
  check('no_services', true),
  check('missing_selling_total', true),
  check('plan_missing', true),
  check('missing_acceptance_proof', true),
];

export function emptyDraft(over: Partial<BookNowView> = {}): BookNowView {
  return draftView({
    contacts: null,
    billing: { status: 'none', prefillSource: null, rowVersion: 0, billingName: null, addressLine1: null, addressLine2: null, city: null, stateCode: null, postalCode: null, gstin: null, editableBySales: true },
    trip: { destination: null, scope: null, start: null, end: null },
    travellers: [],
    items: [],
    commercials: { listPricePaise: null, discountPaise: null, sellingTotalPaise: null },
    plan: [],
    checklist: EMPTY_DRAFT_CHECKLIST,
    progress: { total: 0, byState: { planned: 0, notStarted: 0, inProgress: 0, supplierConfirmed: 0 }, fulfilled: false, staleCount: 0, needs: [] },
    ...over,
  });
}

// ---------------------------------------------------------------------------
// Batch 2: "From Bitrix" inline mode (switch prefill_auto_fill on). Synthetic
// view models in the frozen PrefillUiVM shape; Terra's builder replaces these
// hand-built ones once it exists.
// ---------------------------------------------------------------------------

/** DA-160: a marker only while the value is still Bitrix's; checked and changed show details only. */
const MARKER_TEXT: Partial<Record<PrefillMarkState, string>> = {
  from_bitrix: 'From Bitrix',
  kept: 'From Bitrix, saved, not checked',
};

function marker(field: PrefillFieldCode, fieldId: string, state: PrefillMarkState | null, detailsText: string | null = null): PrefillMarkerVM {
  return { field, fieldId, label: PREFILL_FIELD_LABEL[field], marker: state, markerText: state ? (MARKER_TEXT[state] ?? null) : null, detailsText: detailsText ?? (state ? 'From Bitrix, not checked yet' : null) };
}

export interface InlinePrefillOptions {
  /** Booking field states (null = no Bitrix value used). */
  states?: Partial<Record<PrefillFieldCode, PrefillMarkState | null>>;
  notices?: PrefillNoticeVM[];
  fillEmptyOffered?: boolean;
  available?: boolean;
  notFilled?: Array<{ field: PrefillFieldCode; reasonText: string }>;
}

/** Booking inline-mode view model for the preview gallery. */
export function inlinePrefillUi(o: InlinePrefillOptions = {}): PrefillUiVM {
  const states = { 'contacts.contactName': 'from_bitrix', 'contacts.mobile': 'kept', 'contacts.email': null, 'contacts.bookingFor': null, 'trip.start': 'from_bitrix', 'trip.end': 'changed', ...o.states } as Record<string, PrefillMarkState | null>;
  const ids: Record<string, string> = {
    'contacts.contactName': 'customer-contact-name',
    'contacts.mobile': 'customer-mobile',
    'contacts.email': 'customer-email',
    'contacts.bookingFor': 'customer-booking-for',
    'trip.start': 'trip-start',
    'trip.end': 'trip-end',
  };
  const section = (key: 'customer' | 'trip', codes: PrefillFieldCode[]): PrefillSectionVM => {
    const fields = codes.map((c) => marker(c, ids[c]!, states[c] ?? null, states[c] === 'changed' ? 'Changed by staff after filling from Bitrix' : null));
    const checkable = codes.filter((c) => states[c] === 'from_bitrix' || states[c] === 'kept');
    return {
      section: key,
      fields,
      notices: (o.notices ?? []).filter((n) => codes.includes(n.field)),
      checkable,
      canCheck: checkable.length > 0,
      details: { readAt: '2026-10-12T06:00:00.000Z', sourceModifiedAt: '2026-10-11T12:00:00.000Z', issues: [], notFilled: (o.notFilled ?? []).filter((n) => codes.includes(n.field)).map((n) => ({ ...n, label: PREFILL_FIELD_LABEL[n.field] })) },
    };
  };
  const available = o.available ?? true;
  return {
    mode: 'inline',
    available,
    unavailableText: available ? null : 'Bitrix details are not available right now. Type them in.',
    sections: available ? [section('customer', ['contacts.contactName', 'contacts.mobile', 'contacts.email', 'contacts.bookingFor']), section('trip', ['trip.start', 'trip.end'])] : [],
    fillEmpty: { offered: o.fillEmptyOffered ?? false, disabledReason: null },
    reference: { bookingNotes: 'Quiet hotel near the lake. Vegetarian meals.', notesHidden: false, customerTypeLabel: null, travellerTotal: 3 },
  };
}
