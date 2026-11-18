import { describe, expect, it } from 'vitest';
import type { ViewerAccess } from '@/modules/access/policy';
import { canReadDealCommercial } from '@/modules/access/policy';
import { BookingFormSchema, BookingPanelB11Schema } from '@/modules/fulfilment/b11-commands';
import { toBookNowView } from '@/modules/fulfilment/b11-dto';
import { firstOpenFormStep, maskViewChecklist, toBookingFormVM } from '@/modules/fulfilment/booking-form-vm';
import { PRICE_ASK_OWNER_TEXT, type IntakeChecklist } from '@/modules/fulfilment/contracts';

/*
 * Booking form view model: new read keys, older-database compatibility,
 * checklist routing to the new sections and the price privacy rule
 * (Mercury money-privacy-copy.md B4, B9). Synthetic data only.
 */

const ENTITY = 'e0000000-0000-4000-8000-000000000001';
const BRANCH = 'b0000000-0000-4000-8000-000000000001';
const OWNER = 'a0000000-0000-4000-8000-000000000001';
const OTHER = 'a0000000-0000-4000-8000-000000000002';
const DEAL = 'd0000000-0000-4000-8000-000000000001';
const VERSION = '11111111-1111-4111-8111-111111111111';
const HOTEL = '33333333-3333-4333-8333-333333333331';
const CAR = '33333333-3333-4333-8333-333333333332';
const FLIGHT = '33333333-3333-4333-8333-333333333333';
const FILE = '77777777-7777-4777-8777-777777777777';
const HASH = 'c'.repeat(64);

const rolePermissions: ViewerAccess['rolePermissions'] = [
  { roleCode: 'sales', permissionCode: 'deal.read', scope: 'own' },
  { roleCode: 'sales', permissionCode: 'deal.read_commercial', scope: 'own' },
  { roleCode: 'manager', permissionCode: 'deal.read', scope: 'entity' },
];
const sales: ViewerAccess = { userId: OWNER, memberships: [{ legalEntityId: ENTITY, branchId: BRANCH, roleCode: 'sales' }], rolePermissions, grants: [] };
const noCommercial: ViewerAccess = { userId: OTHER, memberships: [{ legalEntityId: ENTITY, branchId: BRANCH, roleCode: 'manager' }], rolePermissions, grants: [] };
const deal = { id: DEAL, legalEntityId: ENTITY, branchId: BRANCH, ownerUserId: OWNER, activeAssigneeIds: [], reference: 'SYN-JOD-020', title: 'Synthetic Goa trip', sourceSystem: 'bitrix', sourceStageId: 'UC_AD0SLH' };

const hotelItem = {
  itemId: HOTEL,
  itemNo: 1,
  serviceType: 'hotel',
  department: 'purchase',
  state: 'planned',
  facts: { type: 'hotel', facts: { hotelName: 'Test Resort', city: 'Goa', checkIn: '2026-12-10', checkOut: '2026-12-13', rooms: 2, adults: 3, extraBeds: 1, childrenWithoutBed: 0 } },
  purchaseBudgetPaise: '0',
  factsHash: HASH,
  task: null,
  participants: [1],
  estimate: { kind: 'hotel', roomRatePaise: '500000', extraBedRatePaise: '100000', noBedRatePaise: null },
};
const carItem = {
  itemId: CAR,
  itemNo: 2,
  serviceType: 'transfer',
  department: 'purchase',
  state: 'planned',
  facts: { type: 'transfer', facts: { route: 'Airport to hotel', date: '2026-12-10', vehicleType: 'Sedan', passengers: 3, endDate: '2026-12-15', quantity: 2, vendor: 'Test cabs' } },
  factsHash: HASH,
  task: null,
  participants: [1],
  estimate: { kind: 'transfer', vehicleRatePaise: '2500000' },
};
const flightItem = {
  itemId: FLIGHT,
  itemNo: 3,
  serviceType: 'flight',
  department: 'flight',
  state: 'planned',
  facts: { type: 'flight', facts: { segments: [{ from: 'DEL', to: 'GOI', date: '2026-12-10', arrivalDate: '2026-12-10', airline: 'Test Air', flightNo: 'TA 101' }], passengers: 3 } },
  factsHash: HASH,
  task: null,
  participants: [1],
  estimate: null,
  files: [
    { fileId: FILE, kind: 'flight_screenshot', fileName: 'fare.png', mime: 'image/png', sizeBytes: 2048, status: 'stored', uploadedByYou: true, createdAt: '2026-10-22T08:00:00Z', rowVersion: 2 },
    { fileId: '77777777-7777-4777-8777-777777777778', kind: 'flight_screenshot', fileName: 'old.png', mime: 'image/png', sizeBytes: 2048, status: 'removed', uploadedByYou: true, createdAt: '2026-10-22T08:00:00Z', rowVersion: 3 },
  ],
};

const raw = (over: Record<string, unknown> = {}) => ({
  dealId: DEAL,
  canEdit: true,
  canConfirm: true,
  serviceItemsEnabled: true,
  visaPassportTasksEnabled: false,
  dealNotActive: false,
  version: { versionId: VERSION, versionNo: 1, status: 'draft', serviceType: 'package', rowVersion: 5, contentHash: HASH, updatedAt: '2026-10-22T08:30:00Z', updatedByName: 'Sample Sales (synthetic)', confirmedAt: null, formRules: 2 },
  trip: { destination: 'Goa', scope: 'domestic', start: '2026-12-10', end: '2026-12-15' },
  contacts: { contactName: 'Riya Mehta', mobile: '9876543210', email: null, contactConfirmed: true, confirmedAt: null, confirmedByName: null, bookingFor: 'individual', payerDifferent: false, payerName: null, customerType: 'b2d', market: 'india' },
  billing: { status: 'draft', prefillSource: 'sales', rowVersion: 2, billingName: 'Test Travels', addressLine1: 'Test street 1', addressLine2: null, city: 'Jodhpur', stateCode: '08', postalCode: '342001', gstin: null, billToType: 'business', contactPerson: 'Riya Mehta', phone: '9876543210', email: null, gstStatus: 'unregistered', gstReason: 'Small business, not registered' },
  travellers: [
    { travellerId: null, seq: 1, fullName: 'Riya Mehta', type: 'adult', ageYears: null, specialNeeds: null, identity: { dateOfBirth: '1990-01-01', nationality: 'Indian', passportNumber: null, passportExpiry: null, rowVersion: 1, dateOfMarriage: '2015-02-14', phone: '+971501234567', email: 'riya@example.com' } },
  ],
  items: [hotelItem, carItem, flightItem],
  evidence: [],
  commercials: { listPricePaise: null, discountPaise: null, sellingTotalPaise: '3600000' },
  plan: [],
  party: { total: 3, children: 1, infants: 0 },
  prices: {
    lines: [
      { category: 'adult', quantity: 2, purchasePaise: '1000000', markupPaise: '200000', salePaise: '1200000' },
      { category: 'child_bed', quantity: 1, purchasePaise: '1000000', markupPaise: '200000', salePaise: '1200000' },
    ],
    source: 'per_person',
    linesRequired: true,
  },
  itemFilesCanEdit: true,
  ...over,
});

const panel = (issues: string[] = []) =>
  BookingPanelB11Schema.parse({ dealId: DEAL, canEdit: true, canConfirm: true, gate: { realBookingEnabled: false, environment: 'test' }, version: null, readiness: { ready: false, issues, contentHash: 'd'.repeat(64) }, evidence: [], evidenceVisible: true, task: null });

function build(viewer: ViewerAccess, over: Record<string, unknown> = {}, checklist: IntakeChecklist | null = null, issues: string[] = []) {
  const form = BookingFormSchema.parse(raw(over));
  const commercialAllowed = canReadDealCommercial(viewer, deal);
  const view = maskViewChecklist(toBookNowView({ viewer, deal, form, panel: panel(issues), checklist }), commercialAllowed);
  return { view, vm: toBookingFormVM({ view, form, commercialAllowed, step: null, ownerText: 'You' }) };
}

function keysOf(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => keysOf(v, prefix));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => [`${prefix}.${k}`, ...keysOf(v, `${prefix}.${k}`)]);
  return [];
}

describe('booking form view model: commercial editor', () => {
  const { vm, view } = build(sales);
  it('reads party, labels, form rules and Bill To', () => {
    expect(vm.party).toEqual({ total: 3, children: 1, infants: 0 });
    expect([vm.customerType, vm.market, vm.formRules]).toEqual(['b2d', 'india', 2]);
    expect(vm.billTo).toMatchObject({ type: 'business', status: 'draft', gstStatus: 'unregistered', gstin: null, country: 'India', rowVersion: 2 });
    expect(vm.prefillMode).toBe('off');
    expect(view.travellers[0]!.identity).toMatchObject({ dateOfMarriage: '2015-02-14', phone: '+971501234567', email: 'riya@example.com' });
  });
  it('prices: four categories in order, totals, source and requirement', () => {
    expect(vm.prices?.lines.map((l) => [l.category, l.quantity])).toEqual([['adult', 2], ['child_bed', 1], ['child_no_bed', 0], ['infant', 0]]);
    expect(vm.prices).toMatchObject({ sellingTotalPaise: '3600000', purchaseTotalPaise: '3000000', markupTotalPaise: '600000', source: 'per_person', linesRequired: true });
  });
  it('items: new fact keys kept, estimates worked out, only stored files, coverage', () => {
    const [hotel, car, flight] = vm.items;
    expect(hotel!.estimate).toEqual({ estimate: { kind: 'hotel', roomRatePaise: '500000', extraBedRatePaise: '100000', noBedRatePaise: null }, totalPaise: '3300000' });
    expect(car!.facts).toMatchObject({ endDate: '2026-12-15', quantity: 2, vendor: 'Test cabs' });
    expect(car!.estimate?.totalPaise).toBe('5000000');
    expect((flight!.facts.segments as Array<Record<string, unknown>>)[0]).toMatchObject({ arrivalDate: '2026-12-10', airline: 'Test Air', flightNo: 'TA 101' });
    expect(flight!.estimate).toEqual({ estimate: null, totalPaise: null });
    expect(flight!.files).toEqual([expect.objectContaining({ fileId: FILE, downloadHref: `/app/deals/${DEAL}/book/files/${FILE}`, canRemove: true })]);
    expect(vm.coverage).toEqual({ nights: 5, covered: 3, missing: ['2026-12-13', '2026-12-14'], outside: [] });
    expect(vm.statusLine).toEqual({ state: 'Draft · version 1', owner: 'Owner: You', next: 'Next: review and submit (step 3)' });
  });
});

describe('booking form view model: editor without price access (B4, B9)', () => {
  const checklist: IntakeChecklist = { items: [{ code: 'price_below_purchase', blocking: true, owner: 'sales', itemNos: [] }], canConfirm: false };
  const { vm, view } = build(noCommercial, {}, checklist);
  it('carries no prices, estimates or price keys at all', () => {
    expect('prices' in vm).toBe(false);
    expect(vm.items.every((i) => !('estimate' in i))).toBe(true);
    expect(keysOf(vm).filter((k) => /salePaise|markupPaise|purchasePaise|sellingTotal|priceLines|\.prices/.test(k))).toEqual([]);
  });
  it('masks the price readiness text to one line, with no field link', () => {
    const item = vm.checklist.find((i) => i.code === 'price_below_purchase');
    expect(item).toMatchObject({ text: PRICE_ASK_OWNER_TEXT, section: 'price', step: 'finish', fieldId: null });
    expect(view.checklist.find((i) => i.code === 'price_below_purchase')?.text).toBe(PRICE_ASK_OWNER_TEXT);
  });
});

describe('older database and legacy versions', () => {
  it('loads without the booking form keys: rules 1, empty party, typed total kept, no invented lines', () => {
    const { vm } = build(sales, { party: undefined, prices: undefined, itemFilesCanEdit: undefined, version: { ...raw().version, formRules: undefined }, items: [{ ...carItem, estimate: undefined, facts: { type: 'transfer', facts: { route: 'A to B', date: '2026-12-10', vehicleType: null, passengers: null } } }] });
    expect(vm.formRules).toBe(1);
    expect(vm.party).toEqual({ total: null, children: null, infants: null });
    expect(vm.prices).toMatchObject({ source: 'legacy_total', linesRequired: false, sellingTotalPaise: '3600000' });
    expect(vm.prices?.lines.every((l) => l.quantity === 0 && l.salePaise === null)).toBe(true);
    expect('estimate' in vm.items[0]!).toBe(false);
    expect(vm.itemFilesCanEdit).toBe(false);
  });
  it('Echo H1: an oversized or odd coverage block never fails the read', () => {
    const long = Array.from({ length: 400 }, (_, i) => new Date(Date.UTC(2026, 11, 10 + i)).toISOString().slice(0, 10));
    const { vm } = build(sales, { coverage: { nights: 400, covered: 0, missing: long, outside: [] } });
    expect(vm.coverage?.missing.length).toBe(366);
    expect(() => build(sales, { coverage: { nights: 'many' } })).not.toThrow();
  });
  it('unknown readiness codes from a newer database are dropped, not fatal', () => {
    expect(() => build(sales, {}, null, ['some_future_code', 'missing_acceptance_proof'])).not.toThrow();
  });
});

describe('checklist routing to the new sections', () => {
  const checklist: IntakeChecklist = {
    items: [
      { code: 'trip_missing', blocking: true, owner: 'sales', itemNos: [] },
      { code: 'gst_reason_missing', blocking: true, owner: 'sales', itemNos: [] },
      { code: 'billing_unverified', blocking: false, owner: 'accounts', itemNos: [] },
      { code: 'hotel_nights_missing', blocking: true, owner: 'sales', itemNos: [] },
      { code: 'plan_missing', blocking: true, owner: 'sales', itemNos: [] },
      { code: 'price_missing', blocking: true, owner: 'sales', itemNos: [] },
    ],
    canConfirm: false,
  };
  const { vm } = build(sales, { prices: { lines: [{ category: 'adult', quantity: 2, purchasePaise: '1000000', markupPaise: null, salePaise: null }], source: 'per_person', linesRequired: true } }, checklist);
  it('routes each code to its section, step and field', () => {
    const by = Object.fromEntries(vm.checklist.map((i) => [i.code, [i.section, i.step, i.fieldId]]));
    expect(by.trip_missing).toEqual(['customer', 'travellers', 'bf-destination']);
    expect(by.gst_reason_missing).toEqual(['billTo', 'finish', 'bf-bill-gst-reason']);
    expect(by.billing_unverified).toEqual(['billTo', 'finish', null]);
    expect(by.hotel_nights_missing).toEqual(['services', 'stay', 'bf-services']);
    expect(by.plan_missing).toEqual(['submit', 'finish', null]);
    expect(by.price_missing).toEqual(['price', 'finish', 'price-adult-sale']);
  });
  it('Echo B-M1: passenger codes link to the row Details button, else the passengers heading', () => {
    const items: IntakeChecklist = {
      items: [
        { code: 'identity_missing', blocking: true, owner: 'sales', itemNos: [], travellerSeqs: [1] },
        { code: 'traveller_name_incomplete', blocking: true, owner: 'sales', itemNos: [] },
      ],
      canConfirm: false,
    };
    const { vm: v } = build(sales, {}, items);
    expect(v.checklist.find((i) => i.code === 'identity_missing')?.fieldId).toBe('passengers-1-details');
    expect(v.checklist.find((i) => i.code === 'traveller_name_incomplete')?.fieldId).toBe('passengers-heading');
  });
  it('names missing nights and price categories for a commercial reader', () => {
    expect(vm.checklist.find((i) => i.code === 'hotel_nights_missing')?.text).toBe('3 of 5 trip nights have a hotel. Add a hotel for 13 Dec, 14 Dec.');
    expect(vm.checklist.find((i) => i.code === 'price_missing')?.text).toBe('Enter purchase, markup and final sale for: adult.');
  });
  it('section markers and the first open step', () => {
    expect(vm.sectionStatus).toMatchObject({ customer: 'needs_input', passengers: 'complete', services: 'needs_input', billTo: 'needs_input', submit: 'needs_input' });
    expect(vm.initialStep).toBe('travellers');
    expect(firstOpenFormStep({ customer: 'complete', passengers: 'warnings_only', services: 'complete', price: 'needs_input', billTo: 'complete', submit: 'complete' })).toBe('finish');
    expect(vm.statusLine.next).toBe(`Next: finish ${vm.checklist.filter((i) => i.blocking).length} things (marked in the steps)`);
  });
});
