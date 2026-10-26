import type { ReactNode } from 'react';
import type { BookingFormServiceItemView, PackagePriceView, PriceLine } from '@/modules/fulfilment/booking-form-contract';
import { bookingFormChecklist, formSectionStatus, type BookingFormVM } from '@/modules/fulfilment/booking-form-vm';
import type { BookNowView, ServiceType } from '@/modules/fulfilment/contracts';
import type { PrefillUiVM } from '@/modules/fulfilment/prefill-contract';
import { StaffShell } from '@/views/StaffShell';
import { BookingFormScreen } from '@/views/booking-form/booking-form-screen';
import type { BookingFormActions, FormStep } from '@/views/booking-form/types';
import { check, draftView, emptyDraft, inlinePrefillUi, travellers } from './b11-fixtures';
import { sales, SAVING_ACTIONS } from './b11-states';
import type { VoiceNoteProps } from '@/views/booking-form/vn-types';
import { previewCreatePartyAction, previewPickPartyAction, previewPickPartyFailAction, previewSearchHotelsAction, previewSearchPartiesAction, previewSearchPartiesThrowsAction } from './vn-preview-actions';
import { previewBookformRefreshAction, previewBookformRefuseBillToAction, previewBookformRefuseCustomerAction, previewBookformRefusePricesAction, previewBookformRefuseServiceAction, previewBookformReturnsAction, previewBookformSavedAction } from './bookform-preview-actions';

/*
 * LOCAL DESIGN-REVIEW GALLERY: the booking form (owner-approved preview of
 * 22 October 2026) with synthetic view models, so the screen can be checked
 * at desktop and 320/375 px without a database. Addresses:
 * /preview/bookform-{scenario}--{travellers|stay|finish}. Every name, phone
 * and amount is made up; nothing reaches a database.
 */

const saved = previewBookformSavedAction;

const ACTIONS: BookingFormActions = {
  ...SAVING_ACTIONS,
  saveService: saved,
  uploadServiceFile: saved,
  removeServiceFile: saved,
  savePrices: saved,
  saveBillTo: saved,
  fillEmptyPrefill: saved,
  saveFlightFares: saved,
  addReturnFlights: previewBookformReturnsAction,
  refreshFromBitrix: previewBookformRefreshAction,
};

const REFUSING: BookingFormActions = {
  ...ACTIONS,
  saveCustomer: previewBookformRefuseCustomerAction,
  savePrices: previewBookformRefusePricesAction,
  saveBillTo: previewBookformRefuseBillToAction,
  saveService: previewBookformRefuseServiceAction,
};

const ITEM_ID = (n: number) => `i0000000-0000-4000-8000-${String(100 + n).padStart(12, '0')}`;

function svc(no: number, serviceType: ServiceType, facts: Record<string, unknown>, extra: Partial<BookingFormServiceItemView> = {}): BookingFormServiceItemView {
  return { itemId: ITEM_ID(no), itemNo: no, serviceType, facts, summary: '', participants: [1, 2, 3, 4], locked: false, ...extra };
}

/** The owner's checked example: 6-night Himachal trip, 2 adults + 1 child + 1 infant (synthetic names). */
const OWNER_ITEMS: BookingFormServiceItemView[] = [
  svc(
    1,
    'hotel',
    { mode: 'specific', hotelName: 'Sample Palace Hotel', city: 'Jodhpur', checkIn: '2026-10-25', checkOut: '2026-10-31', rooms: 2, roomType: 'Palace room', mealPlan: 'Breakfast', adults: 2, children: 1, childAges: [8], extraBeds: 2, childrenWithoutBed: 1 },
    { purchaseBudgetPaise: null, estimate: { estimate: { kind: 'hotel', roomRatePaise: '1000000', extraBedRatePaise: '200000', noBedRatePaise: '100000' }, totalPaise: '15000000' } },
  ),
  svc(2, 'transfer', { date: '2026-10-25', endDate: '2026-10-31', vehicleType: 'Innova', quantity: 2, route: 'Jodhpur sightseeing and transfers' }, { purchaseBudgetPaise: null, estimate: { estimate: { kind: 'transfer', vehicleRatePaise: '2500000' }, totalPaise: '5000000' } }),
  svc(
    3,
    'flight',
    { tripType: 'one_way', cabin: 'Economy', passengers: 4, segments: [{ from: 'Delhi', to: 'Jodhpur', date: '2026-10-25', airline: 'Sample Air', flightNo: 'SA520', departTime: '12:00', arriveTime: '14:00' }] },
    { purchaseBudgetPaise: null, estimate: { estimate: { kind: 'flight', fareTotalPaise: null, fareAdultPaise: '600000', fareChildPaise: '450000', fareInfantPaise: null }, totalPaise: '1500000' } },
  ),
];

/** Book now v2 (26 October 2026 prototype): request items, car kinds, fare per person and a screenshot flight. */
const V2_ITEMS: BookingFormServiceItemView[] = [
  svc(
    1,
    'hotel',
    { mode: 'specific', hotelName: 'Sample Palace Hotel', city: 'Jodhpur', checkIn: '2026-10-25', checkOut: '2026-10-28', rooms: 1, roomType: 'Deluxe', mealPlan: 'Breakfast', adults: 2, children: 2, extraBeds: 1, requestItems: [{ text: 'Baby cot', forSeq: 4 }, { text: 'Early check-in', forSeq: null }], specialRequests: 'Baby cot (Sample Infant D), Early check-in' },
    { estimate: { estimate: { kind: 'hotel', roomRatePaise: '800000', extraBedRatePaise: '150000', noBedRatePaise: null }, totalPaise: '2850000' } },
  ),
  svc(2, 'hotel', { mode: 'specific', hotelName: 'Sample Lake Resort', city: 'Udaipur', checkIn: '2026-10-28', checkOut: '2026-10-31', rooms: 1, adults: 2, children: 2 }, { estimate: { estimate: { kind: 'hotel', roomRatePaise: null, extraBedRatePaise: null, noBedRatePaise: null }, totalPaise: null } }),
  svc(
    3,
    'flight',
    { tripType: 'one_way', cabin: 'Economy', passengers: 4, entryMode: 'typed', segments: [{ from: 'DEL', to: 'JDH', date: '2026-10-25', airline: 'Sample Air', flightNo: 'SA520', departTime: '08:10', arriveTime: '09:40' }], requestItems: [{ text: 'Wheelchair help', forSeq: 3 }] },
    { estimate: { estimate: { kind: 'flight', fareTotalPaise: null, fareAdultPaise: '600000', fareChildPaise: '450000', fareInfantPaise: '150000' }, totalPaise: null } },
  ),
  svc(4, 'flight', { tripType: 'one_way', cabin: 'Economy', passengers: 4, entryMode: 'screenshot', screenshotNote: 'Book the 08:00 option', segments: [] }, { estimate: { estimate: { kind: 'flight', fareTotalPaise: null, fareAdultPaise: null, fareChildPaise: null, fareInfantPaise: null }, totalPaise: null }, files: [{ fileId: 'f0000000-0000-4000-8000-000000000001', kind: 'flight_screenshot', fileName: 'fare-quote.png', sizeLabel: '210 KB', uploadedAt: '2026-10-24T10:00:00.000Z', uploadedByYou: true, downloadHref: '#', canRemove: true, rowVersion: 1 }] }),
  svc(5, 'transfer', { carKind: 'airport_pickup', flightItemId: ITEM_ID(3), date: '2026-10-25', pickupTime: '09:40', pickup: 'Jodhpur airport (JDH), flight SA520', drop: 'Sample Palace Hotel, Jodhpur', vehicleType: 'Innova', quantity: 1 }, { estimate: { estimate: { kind: 'transfer', vehicleRatePaise: '250000' }, totalPaise: '250000' } }),
];

const PRICES: PriceLine[] = [
  { category: 'adult', quantity: 2, purchasePaise: '1100000', markupPaise: '500000', salePaise: '1600000' },
  { category: 'child_bed', quantity: 1, purchasePaise: '1000000', markupPaise: '200000', salePaise: '1200000' },
  { category: 'child_no_bed', quantity: 0, purchasePaise: null, markupPaise: null, salePaise: null },
  { category: 'infant', quantity: 1, purchasePaise: '50000', markupPaise: '10000', salePaise: '60000' },
];

function priceView(lines: PriceLine[], over: Partial<PackagePriceView> = {}): PackagePriceView {
  return { lines, sellingTotalPaise: '4460000', purchaseTotalPaise: '3250000', markupTotalPaise: '1210000', source: 'per_person', linesRequired: true, ...over };
}

const EMPTY_LINES: PriceLine[] = (['adult', 'child_bed', 'child_no_bed', 'infant'] as const).map((category) => ({ category, quantity: 0, purchasePaise: null, markupPaise: null, salePaise: null }));

/** Routes the view's checklist the way the loader does (Terra's booking-form-vm). */
function finish(view: BookNowView, vm: Omit<BookingFormVM, 'checklist' | 'sectionStatus' | 'itemFilesCanEdit'>): BookingFormVM {
  const checklist = bookingFormChecklist(view.checklist, {
    commercialAllowed: view.commercials !== undefined,
    coverage: vm.coverage,
    prices: vm.prices,
    party: vm.party,
    itemIdByNo: new Map(vm.items.map((i) => [i.itemNo, i.itemId])),
  });
  return { ...vm, checklist, sectionStatus: formSectionStatus(checklist, true), itemFilesCanEdit: view.canEdit };
}

function core(view: BookNowView, over: Partial<BookingFormVM> = {}): BookingFormVM {
  return finish(view, {
    initialStep: 'travellers',
    statusLine: { state: `Draft · version ${view.version?.versionNo ?? 1}`, owner: 'Owner: Synthetic Sales Delhi A', next: 'Next: finish 3 things (marked in the steps)' },
    party: { total: null, children: 0, infants: 0 },
    trip: view.trip,
    customerType: null,
    market: null,
    prefillMode: 'off',
    idProofCopyApplies: true,
    formRules: 2,
    items: [],
    coverage: null,
    prices: priceView(EMPTY_LINES, { sellingTotalPaise: null, purchaseTotalPaise: null, markupTotalPaise: null }),
    billTo: { status: 'none', type: 'personal', name: '', contactPerson: null, phone: null, email: null, addressLine1: '', addressLine2: null, city: '', stateCode: '', postalCode: '', country: 'India', gstStatus: null, gstReason: null, gstin: null, verifiedByName: null, verifiedAt: null, rowVersion: 0 },
    ...over,
  });
}

const OWNER_TRAVELLERS = [
  ...travellers(false, [[], [], []]).slice(0, 3).map((t, i) => ({ ...t, fullName: ['Sample Traveller A', 'Sample Traveller B', 'Sample Child C'][i]! })),
  { travellerId: 't4', seq: 4, fullName: 'Sample Infant D', type: 'infant' as const, ageYears: 1, specialNeeds: null, identityRequired: false, identity: null, idProofs: [] },
];

function ownerView(over: Partial<BookNowView> = {}): BookNowView {
  const checklist = over.checklist ?? [check('missing_acceptance_proof', true), check('billing_unverified', false)];
  return draftView({
    dealTitle: 'Synthetic Himachal family trip',
    trip: { destination: 'Himachal', scope: 'domestic', start: '2026-10-25', end: '2026-10-31' },
    contacts: { contactName: 'Sample Customer A', mobile: '9876500012', email: 'customer.a@example.com', contactConfirmed: true, confirmedAt: '2026-10-21T10:00:00.000Z', confirmedByName: 'Synthetic Sales Delhi A', bookingFor: 'individual', payerDifferent: false, payerName: null },
    travellers: OWNER_TRAVELLERS,
    checklist,
    ...over,
  });
}

function ownerCore(view: BookNowView, over: Partial<BookingFormVM> = {}): BookingFormVM {
  return core(view, {
    party: { total: 4, children: 1, infants: 1 },
    customerType: 'individual',
    market: 'india',
    items: OWNER_ITEMS,
    coverage: { nights: 6, covered: 6, missing: [], outside: [] },
    prices: priceView(PRICES),
    billTo: {
      status: 'draft',
      type: 'business',
      name: 'Sample Travels Pvt Ltd',
      contactPerson: 'Sample Contact',
      phone: '9876500099',
      email: null,
      addressLine1: '1 Sample Road',
      addressLine2: null,
      city: 'Jodhpur',
      stateCode: '08',
      postalCode: '342001',
      country: 'India',
      gstStatus: 'unregistered',
      gstReason: 'Small firm below the GST threshold',
      gstin: null,
      verifiedByName: null,
      verifiedAt: null,
      rowVersion: 2,
    },
    ...over,
  });
}

/** The Batch 2 fixture uses the old field ids; the booking form uses BOOKING_FORM_FIELD_ID (as prefill-ui.ts does now). */
const FORM_ID: Record<string, string> = {
  'customer-contact-name': 'bf-contact-name',
  'customer-mobile': 'bf-contact-mobile',
  'customer-email': 'bf-contact-email',
  'customer-booking-for': 'bf-bill-type',
  'trip-start': 'bf-trip-start',
  'trip-end': 'bf-trip-end',
};
function toFormIds(ui: PrefillUiVM): PrefillUiVM {
  if (ui.mode !== 'inline') return ui;
  return { ...ui, sections: ui.sections.map((sec) => ({ ...sec, fields: sec.fields.map((f) => ({ ...f, fieldId: FORM_ID[f.fieldId] ?? f.fieldId })), notices: sec.notices.map((n) => ({ ...n, fieldId: FORM_ID[n.fieldId] ?? n.fieldId })) })) };
}

interface Scenario {
  view: BookNowView;
  vm: BookingFormVM;
  actions?: BookingFormActions;
  prefillUi?: PrefillUiVM | null;
  vn?: VoiceNoteProps;
}

/** Voice-note batch: stored hotel and customer search wired to synthetic lists. */
const VN_SEARCH: VoiceNoteProps = {
  searchHotels: previewSearchHotelsAction,
  parties: { search: previewSearchPartiesAction, create: previewCreatePartyAction, canCreate: true, pick: previewPickPartyAction },
};
const DEAL_FACTS = { destination: 'Himachal', start: '2026-10-25', end: '2026-10-31', total: 4, adults: 2, children: 1, infants: 1, scope: 'domestic' as const, readAt: '2026-10-24T05:30:00.000Z', bitrixDealHref: null };

function scenario(name: string): Scenario | null {
  switch (name) {
    case 'empty': {
      const view = emptyDraft();
      return { view, vm: core(view) };
    }
    case 'owner': {
      const view = ownerView();
      return { view, vm: ownerCore(view) };
    }
    case 'gaps': {
      const view = ownerView({ checklist: [check('hotel_nights_missing', true), check('missing_acceptance_proof', true), check('plan_total_mismatch', true)] });
      const items = [svc(1, 'hotel', { ...OWNER_ITEMS[0]!.facts, checkOut: '2026-10-28' }, { estimate: OWNER_ITEMS[0]!.estimate }), svc(2, 'hotel', { mode: 'specific', hotelName: 'Sample Hill Resort', city: 'Shimla', checkIn: '2026-10-29', checkOut: '2026-10-31', rooms: 1, adults: 2 }, { estimate: { estimate: null, totalPaise: null } })];
      return { view, vm: ownerCore(view, { items, coverage: { nights: 6, covered: 5, missing: ['2026-10-28'], outside: [] } }) };
    }
    case 'refused': {
      const view = ownerView();
      return { view, vm: ownerCore(view), actions: REFUSING };
    }
    case 'no-price': {
      const view = ownerView({ commercials: undefined, plan: undefined, canEditCommercials: false });
      return { view, vm: ownerCore(view, { prices: undefined, items: OWNER_ITEMS.map(({ estimate, purchaseBudgetPaise, ...i }) => (void estimate, void purchaseBudgetPaise, i)) }) };
    }
    case 'verified': {
      const view = ownerView();
      const vm = ownerCore(view);
      return { view, vm: { ...vm, billTo: { ...vm.billTo!, status: 'verified', verifiedByName: 'Synthetic Accounts 1', verifiedAt: '2026-10-21T12:00:00.000Z' } } };
    }
    case 'legacy': {
      const view = ownerView();
      return { view, vm: ownerCore(view, { formRules: 1, prices: priceView(EMPTY_LINES, { sellingTotalPaise: '12000000', source: 'legacy_total', linesRequired: false }) }) };
    }
    case 'read-only': {
      const view = ownerView({ canEdit: false, canEditCommercials: false });
      return { view, vm: ownerCore(view) };
    }
    case 'auto': {
      const view = emptyDraft({ contacts: { contactName: 'Sample Customer A', mobile: '9876500012', email: null, contactConfirmed: false, confirmedAt: null, confirmedByName: null, bookingFor: 'individual', payerDifferent: false, payerName: null } });
      return { view, vm: core(view, { prefillMode: 'auto' }), prefillUi: toFormIds(inlinePrefillUi()) };
    }
    case 'v2': {
      // Book now v2: every trip fact from the Bitrix Deal (locked bar), structured requests, fares and a screenshot flight.
      const view = ownerView();
      return { view, vm: ownerCore(view, { items: V2_ITEMS, coverage: { nights: 6, covered: 6, missing: [], outside: [] }, flightFareTotals: { adultPaise: null, childPaise: null, infantPaise: null } }), vn: { ...VN_SEARCH, dealFacts: { ...DEAL_FACTS, bitrixDealHref: 'https://example.invalid/crm/deal/details/1/' } } };
    }
    case 'v2-nocopy': {
      // The ID proof is not copied to Bitrix for this Deal (switch off or a Deal not from Bitrix): no copy note.
      const view = ownerView();
      return { view, vm: ownerCore(view, { items: V2_ITEMS, idProofCopyApplies: false, flightFareTotals: { adultPaise: null, childPaise: null, infantPaise: null } }), vn: { ...VN_SEARCH, dealFacts: { ...DEAL_FACTS, bitrixDealHref: null } } };
    }
    case 'v2-quote': {
      // Converted from an accepted quotation: the total and the customer's yes come from it; per-person lines are optional.
      const view = ownerView({
        evidence: [],
        checklist: [],
        quotationSource: { quotationId: 'q0000000-0000-4000-8000-000000000001', reference: 'TQ-1', versionId: 'q0000000-0000-4000-8000-000000000002', versionNo: 1, acceptedAt: '2026-10-24T10:00:00.000Z', acceptedTierKey: 'quoted', acceptanceHref: '#' },
      });
      return { view, vm: ownerCore(view, { items: V2_ITEMS, prices: priceView(EMPTY_LINES, { sellingTotalPaise: '3000000', purchaseTotalPaise: null, markupTotalPaise: null, source: 'quotation_total', linesRequired: false }), flightFareTotals: { adultPaise: null, childPaise: null, infantPaise: null } }), vn: { ...VN_SEARCH, dealFacts: DEAL_FACTS } };
    }
    case 'v2-empty': {
      // A new draft with nothing typed and no Bitrix values (prototype start).
      const view = emptyDraft();
      return { view, vm: core(view), vn: { ...VN_SEARCH, dealFacts: null } };
    }
    case 'vn-deal': {
      // Every trip fact from the Bitrix Deal: one read-only line, no trip inputs.
      const view = ownerView();
      return { view, vm: ownerCore(view), vn: { ...VN_SEARCH, dealFacts: DEAL_FACTS } };
    }
    case 'vn-gaps': {
      // The Deal has a total but no split, and its destination is not classified; one infant too many is named.
      const view = ownerView();
      return {
        view,
        vm: ownerCore(view, { party: { total: 4, children: 1, infants: 0 } }),
        vn: { ...VN_SEARCH, dealFacts: { ...DEAL_FACTS, destination: 'Kerala', scope: null, adults: null, children: null, infants: null } },
      };
    }
    case 'vn-nodeal': {
      // Nothing read from the Deal (switch off): every trip value is asked here once.
      const view = emptyDraft();
      return { view, vm: core(view), vn: { ...VN_SEARCH, dealFacts: null } };
    }
    case 'vn-billto': {
      // Bill To with stored customers: search first, nothing chosen yet.
      const view = ownerView();
      const vm = ownerCore(view);
      return { view, vm: { ...vm, billTo: { ...vm.billTo!, status: 'none', name: '', contactPerson: null, phone: null, addressLine1: '', city: '', stateCode: '', postalCode: '', gstStatus: null, gstReason: null, type: 'personal' } }, vn: { ...VN_SEARCH, dealFacts: DEAL_FACTS } };
    }
    case 'vn-billto-pickfail': {
      // Reading the picked customer fails: nothing in Bill To changes.
      const view = ownerView();
      const vm = ownerCore(view);
      return { view, vm, vn: { ...VN_SEARCH, parties: { ...VN_SEARCH.parties!, pick: previewPickPartyFailAction }, dealFacts: DEAL_FACTS } };
    }
    case 'vn-billto-searchfail': {
      // Echo-B M2: the customer search fails; the list says so (never "Searching…" forever).
      const view = ownerView();
      const vm = ownerCore(view);
      return { view, vm: { ...vm, billTo: { ...vm.billTo!, status: 'none', name: '', contactPerson: null, phone: null, addressLine1: '', city: '', stateCode: '', postalCode: '', gstStatus: null, gstReason: null, type: 'personal' } }, vn: { ...VN_SEARCH, parties: { ...VN_SEARCH.parties!, search: previewSearchPartiesThrowsAction }, dealFacts: DEAL_FACTS } };
    }
    case 'vn-billto-picked': {
      // A stored customer behind the Bill To: summary with "Edit details".
      const view = ownerView();
      const vm = ownerCore(view);
      return { view, vm: { ...vm, billTo: { ...vm.billTo!, partyId: 'p0000000-0000-4000-8000-000000000002', partyCheckStatus: 'not_checked' } }, vn: { ...VN_SEARCH, dealFacts: DEAL_FACTS } };
    }
    default:
      return null;
  }
}

export const BOOKFORM_SCENARIOS = ['v2', 'v2-nocopy', 'v2-quote', 'v2-empty', 'empty', 'owner', 'gaps', 'refused', 'no-price', 'verified', 'legacy', 'read-only', 'auto', 'vn-deal', 'vn-gaps', 'vn-nodeal', 'vn-billto', 'vn-billto-picked', 'vn-billto-pickfail', 'vn-billto-searchfail'] as const;
export const BOOKFORM_STATES = BOOKFORM_SCENARIOS.flatMap((s) => (['travellers', 'stay', 'finish'] as const).map((step) => `bookform-${s}--${step}`));

export function renderBookformState(state: string): ReactNode | null {
  const m = /^bookform-(.+)--(travellers|stay|finish)$/.exec(state);
  if (!m) return null;
  const s = scenario(m[1]!);
  if (!s) return null;
  const step = m[2] as FormStep;
  const steps = Object.fromEntries((['travellers', 'stay', 'finish'] as const).map((k) => [k, `/preview/bookform-${m[1]}--${k}`])) as Record<FormStep, string>;
  return (
    <StaffShell viewer={sales} currentPath="/app/deals">
      <BookingFormScreen
        vm={{ ...s.vm, initialStep: step }}
        view={s.view}
        actions={s.actions ?? ACTIONS}
        links={{ steps, reload: `/preview/${state}`, deal: '/preview/b11-deal-draft', book: '/preview/b11-submitted-sales' }}
        prefillUi={s.prefillUi ?? null}
        ownerText="You"
        vn={s.vn}
      />
    </StaffShell>
  );
}
