/*
 * Booking form view model (Terra, 22 October 2026). Pure and serializable:
 * builds BookingFormCore (booking-form-contract.ts) from the booking_form_get
 * record and the BookNowView already built from it, and routes the readiness
 * checklist to the new sections. No zod and no server imports (type-only
 * imports are erased), so a client component may import the types.
 *
 * Privacy (Mercury money-privacy-copy.md part B): `prices` and item
 * estimates are set only when the viewer may read the deal's commercials;
 * price readiness texts are masked to one line for everyone else.
 */

import type { DealTripFactsView } from '@/views/booking-form/vn-types';
import type { BookingFormRecord, FormItemRecord, TripFactsRecord } from './b11-commands';
import {
  BOOKING_FORM_SECTION_STEP,
  BOOKING_FORM_SECTIONS,
  PRICE_CATEGORIES,
  PRICE_CATEGORY_LABEL,
  type BillToView,
  type BookingFormCore,
  type BookingFormPrefillMode,
  type BookingFormSection,
  type BookingFormServiceItemView,
  type BookingParty,
  type HotelCoverage,
  type PackagePriceView,
  type PriceLine,
  type ServiceEstimate,
  type ServiceEstimateView,
  type ServiceItemFileView,
  type SellingTotalSource,
} from './booking-form-contract';
import {
  BOOKING_FORM_FIELD_ID,
  carEstimatePaise,
  flightEstimatePaise,
  formatInr,
  hotelCoverage,
  hotelEstimatePaise,
  priceFieldId,
  staysOf,
  stayNights,
  type ServiceItemFacts,
} from './booking-form-model';
import {
  BOOK_VERSION_STATUS_LABEL,
  PRICE_ASK_OWNER_TEXT,
  PRICE_ISSUE_CODES,
  type BookChecklistCode,
  type BookChecklistItem,
  type BookNowView,
  type BookSection,
  type BookStep,
  type BookStepStatus,
  type IntakeChecklistOwner,
} from './contracts';

export type BookingFormStep = BookStep;

/** One readiness item routed to the booking form's sections (words only; never an amount). */
export interface BookingFormChecklistItem {
  code: BookChecklistCode;
  blocking: boolean;
  owner: IntakeChecklistOwner;
  section: BookingFormSection;
  step: BookingFormStep;
  /** Input id to focus (BOOKING_FORM_FIELD_ID, priceFieldId, 'bf-item-{itemId}'), null = the section heading. */
  fieldId: string | null;
  text: string;
  itemNos: number[];
  travellerSeqs: number[];
}

/** What the booking form screen receives besides BookNowView. */
export interface BookingFormVM extends BookingFormCore {
  checklist: BookingFormChecklistItem[];
  /** True while the viewer may attach and remove flight screenshots on this draft. */
  itemFilesCanEdit: boolean;
  /** Voice-note batch: the saved adults count (null = not entered, or a version from before adults had its own box). */
  partyAdults?: number | null;
  /** Voice-note batch: values the Deal in Bitrix holds (null = switch off or nothing read: the form asks as before). */
  dealFacts?: DealTripFactsView | null;
}

/**
 * The Deal facts the form shows read-only (owner item 1). Only values the
 * server itself takes from Bitrix (source 'bitrix') are passed; a missing or
 * unreadable one stays null so the form asks for it once. Counts are passed
 * only when Bitrix's own counts add up to its total (else staff enter them).
 * The trip type is passed only when a Super Admin classified the Bitrix
 * destination; it is never guessed.
 */
export function dealFactsView(facts: TripFactsRecord | null | undefined): DealTripFactsView | null {
  if (!facts || !facts.enabled) return null;
  const f = facts.fields;
  const fromBitrix = <T>(x: { bitrix: T | null; source: string }): T | null => (x.source === 'bitrix' ? x.bitrix : null);
  const countsUsable = facts.countsConsistent !== false;
  const count = (x: { bitrix: number | null; source: string }) => (countsUsable ? fromBitrix(x) : null);
  const view: DealTripFactsView = {
    destination: f.destination.source === 'bitrix' ? (f.destination.bitrix?.label ?? null) : null,
    start: fromBitrix(f.start),
    end: fromBitrix(f.end),
    total: fromBitrix(f.total),
    adults: count(f.adults),
    children: count(f.children),
    infants: count(f.infants),
    scope: f.scope.source === 'bitrix' && f.scope.classified ? f.scope.bitrix : null,
    readAt: facts.readAt,
  };
  const any = [view.destination, view.start, view.end, view.total, view.adults, view.children, view.infants, view.scope].some((v) => v !== null);
  return any ? view : null;
}

// ---------------------------------------------------------------------------
// Checklist routing
// ---------------------------------------------------------------------------

const OLD_TO_NEW: Record<BookSection, BookingFormSection> = {
  customer: 'customer',
  passengers: 'passengers',
  trip: 'customer',
  hotels: 'services',
  services: 'services',
  identity: 'passengers',
  price: 'price',
  payment: 'submit',
  review: 'submit',
};

const BILL_TO_CODES = new Set<string>(['billing_missing', 'gstin_missing', 'billing_unverified', 'gst_status_missing', 'gst_reason_missing', 'billing_contact_missing', 'billing_reach_missing']);
const PRICE_CODES = new Set<string>(PRICE_ISSUE_CODES);

const F = BOOKING_FORM_FIELD_ID;
const FIELD_OF_CODE: Partial<Record<BookChecklistCode, string>> = {
  contact_missing: F.contactName,
  contact_not_confirmed: F.contactConfirmed,
  trip_missing: F.destination,
  pax_missing: F.paxTotal,
  pax_types_exceeded: F.children,
  hotel_same_day_trip: F.tripEnd,
  billing_missing: F.billingName,
  gstin_missing: F.gstin,
  gst_status_missing: F.gstStatus,
  gst_reason_missing: F.gstReason,
  billing_contact_missing: F.contactPerson,
  billing_reach_missing: F.billingPhone,
  traveller_missing: F.passengers,
  traveller_count_mismatch: F.passengers,
  traveller_name_incomplete: F.passengers,
  missing_travellers: F.passengers,
  child_age_missing: F.passengers,
  id_proof_missing: F.passengers,
  id_proof_missing_child: F.passengers,
  quote_party_differs: F.passengers,
  identity_missing: F.passengers,
  passport_details_later: F.passengers,
  passport_expiry_before_trip_end: F.passengers,
  no_services: F.services,
  hotel_nights_missing: F.services,
};

export function formSectionOf(item: Pick<BookChecklistItem, 'code' | 'section'>): BookingFormSection {
  if (BILL_TO_CODES.has(item.code)) return 'billTo';
  return OLD_TO_NEW[item.section];
}

function dateWords(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : iso;
}

interface RouteContext {
  commercialAllowed: boolean;
  coverage: HotelCoverage | null;
  prices: PackagePriceView | undefined;
  party: BookingParty;
  itemIdByNo: Map<number, string>;
  /** Traveller seq → row position (1-based) on the passengers card. */
  rowBySeq?: Map<number, number>;
}

function priceText(code: string, ctx: RouteContext): { text: string; fieldId: string | null } {
  if (!ctx.commercialAllowed || code === 'prices_ask_owner') return { text: PRICE_ASK_OWNER_TEXT, fieldId: null };
  const lines = ctx.prices?.lines ?? [];
  const withPeople = lines.filter((l) => l.quantity > 0);
  if (code === 'price_missing') {
    const missing = withPeople.filter((l) => l.purchasePaise === null || l.salePaise === null);
    const first = missing[0];
    if (!first) return { text: 'Enter purchase, markup and final sale for every passenger type in the price table.', fieldId: null };
    return { text: `Enter purchase, markup and final sale for: ${missing.map((l) => PRICE_CATEGORY_LABEL[l.category].toLowerCase()).join(', ')}.`, fieldId: priceFieldId(first.category, first.purchasePaise === null ? 'purchase' : 'sale') };
  }
  if (code === 'price_below_purchase') {
    const below = withPeople.filter((l) => l.purchasePaise !== null && l.salePaise !== null && BigInt(l.salePaise) < BigInt(l.purchasePaise));
    const first = below[0];
    if (!first) return { text: 'Final sale is below purchase for a passenger type. Change the final sale or the purchase. A sale below purchase cannot be submitted.', fieldId: null };
    return {
      text: `Final sale is below purchase for: ${below.map((l) => PRICE_CATEGORY_LABEL[l.category].toLowerCase()).join(', ')}. Change the final sale or the purchase. A sale below purchase cannot be submitted.`,
      fieldId: priceFieldId(first.category, 'sale'),
    };
  }
  // price_count_mismatch
  const total = ctx.party.total;
  const children = ctx.party.children ?? 0;
  return {
    text: total === null ? 'Enter the total passengers first, then split the price counts.' : `Price counts must add up to ${total} passengers. Split all ${children} children into with bed or without bed.`,
    fieldId: priceFieldId('child_bed', 'quantity'),
  };
}

function routeItem(item: BookChecklistItem, ctx: RouteContext): BookingFormChecklistItem {
  const section = formSectionOf(item);
  let text = item.text;
  let fieldId: string | null = FIELD_OF_CODE[item.code] ?? null;
  if (PRICE_CODES.has(item.code)) ({ text, fieldId } = priceText(item.code, ctx));
  else if (item.code === 'hotel_nights_missing' && ctx.coverage && ctx.coverage.nights !== null && ctx.coverage.missing.length > 0) {
    text = `${ctx.coverage.covered} of ${ctx.coverage.nights} trip nights have a hotel. Add a hotel for ${ctx.coverage.missing.map(dateWords).join(', ')}.`;
  }
  // Echo B-M1: a passenger item opens that passenger's Details (row position on the card).
  if (section === 'passengers' && item.travellerSeqs.length > 0) {
    const row = ctx.rowBySeq?.get(item.travellerSeqs[0] ?? 0);
    if (row) fieldId = `passengers-${row}-details`;
  }
  if (fieldId === null && item.itemNos.length > 0 && section === 'services') {
    const itemId = ctx.itemIdByNo.get(item.itemNos[0] ?? 0);
    if (itemId) fieldId = `bf-item-${itemId}`;
  }
  return {
    code: item.code,
    blocking: item.blocking,
    owner: item.owner,
    section,
    step: BOOKING_FORM_SECTION_STEP[section],
    fieldId,
    text,
    itemNos: [...item.itemNos],
    travellerSeqs: [...item.travellerSeqs],
  };
}

/**
 * The checklist of the booking form: each item once per new section (an item
 * the old model listed on two sections collapses), in section order.
 */
export function bookingFormChecklist(items: readonly BookChecklistItem[], ctx: RouteContext): BookingFormChecklistItem[] {
  const seen = new Set<string>();
  const routed = items.map((i) => routeItem(i, ctx)).filter((i) => {
    const key = `${i.code}\u0000${i.section}\u0000${i.itemNos.join(',')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return routed.sort((a, b) => BOOKING_FORM_SECTIONS.indexOf(a.section) - BOOKING_FORM_SECTIONS.indexOf(b.section));
}

/** Price readiness texts in the BookNowView itself, masked for viewers without price access (the view reaches the browser too). */
export function maskViewChecklist(view: BookNowView, commercialAllowed: boolean): BookNowView {
  if (commercialAllowed) return view;
  return { ...view, checklist: view.checklist.map((i) => (PRICE_CODES.has(i.code) ? { ...i, text: PRICE_ASK_OWNER_TEXT } : i)) };
}

export function formSectionStatus(checklist: readonly BookingFormChecklistItem[], started: boolean): Record<BookingFormSection, BookStepStatus> {
  const out = {} as Record<BookingFormSection, BookStepStatus>;
  for (const section of BOOKING_FORM_SECTIONS) {
    const items = checklist.filter((i) => i.section === section);
    out[section] = !started ? 'needs_input' : items.some((i) => i.blocking) ? 'needs_input' : items.length > 0 ? 'warnings_only' : 'complete';
  }
  return out;
}

/** The first step with a section that still needs input; step 3 when nothing does. */
export function firstOpenFormStep(status: Record<BookingFormSection, BookStepStatus>): BookingFormStep {
  const open = BOOKING_FORM_SECTIONS.find((s) => status[s] === 'needs_input');
  return open ? BOOKING_FORM_SECTION_STEP[open] : 'finish';
}

// ---------------------------------------------------------------------------
// Items, estimates, files
// ---------------------------------------------------------------------------

/** The stored facts as a plain record (allowlisted keys only, as parsed), deep-copied. */
export function mergedFacts(record: FormItemRecord): Record<string, unknown> {
  return JSON.parse(JSON.stringify(record.facts.facts)) as Record<string, unknown>;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function estimateView(serviceType: string, facts: Record<string, unknown>, estimate: ServiceEstimate | null): ServiceEstimateView {
  if (!estimate) return { estimate: null, totalPaise: null };
  if (estimate.kind === 'hotel' && serviceType === 'hotel') {
    return {
      estimate,
      totalPaise: hotelEstimatePaise({
        nights: stayNights(str(facts.checkIn), str(facts.checkOut)),
        rooms: num(facts.rooms),
        extraBeds: num(facts.extraBeds) ?? 0,
        noBedGuests: num(facts.childrenWithoutBed) ?? 0,
        roomRatePaise: estimate.roomRatePaise,
        extraBedRatePaise: estimate.extraBedRatePaise,
        noBedRatePaise: estimate.noBedRatePaise,
      }),
    };
  }
  if (estimate.kind === 'transfer' && serviceType === 'transfer') return { estimate, totalPaise: carEstimatePaise(num(facts.quantity) ?? 1, estimate.vehicleRatePaise) };
  if (estimate.kind === 'flight' && serviceType === 'flight') return { estimate, totalPaise: flightEstimatePaise(estimate.fareTotalPaise) };
  return { estimate: null, totalPaise: null };
}

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function fileViews(dealId: string, record: FormItemRecord, canEdit: boolean): ServiceItemFileView[] {
  return (record.files ?? [])
    .filter((f) => f.status === 'stored')
    .map((f) => ({
      fileId: f.fileId,
      kind: f.kind,
      fileName: f.fileName,
      sizeLabel: sizeLabel(f.sizeBytes),
      uploadedAt: f.createdAt,
      uploadedByYou: f.uploadedByYou,
      downloadHref: `/app/deals/${dealId}/book/files/${f.fileId}`,
      canRemove: canEdit,
      // Echo L4: removal posts this back (a stale screen is refused).
      rowVersion: f.rowVersion,
    }));
}

// ---------------------------------------------------------------------------
// Prices and Bill To
// ---------------------------------------------------------------------------

function sumPaise(lines: readonly PriceLine[], key: 'purchasePaise' | 'salePaise'): string | null {
  let total = 0n;
  for (const l of lines) {
    if (l.quantity === 0) continue;
    const v = l[key];
    if (v === null) return null;
    total += BigInt(l.quantity) * BigInt(v);
  }
  return total.toString();
}

/** Four category lines in order; missing categories read as quantity 0 with no amounts (never invented). */
export function normalisedLines(lines: readonly PriceLine[] | undefined): PriceLine[] {
  return PRICE_CATEGORIES.map((category) => {
    const l = lines?.find((x) => x.category === category);
    return l ? { ...l } : { category, quantity: 0, purchasePaise: null, markupPaise: null, salePaise: null };
  });
}

export function packagePriceView(input: {
  record: BookingFormRecord['prices'];
  formRules: 1 | 2;
  fromQuotation: boolean;
  sellingTotalPaise: string | null;
}): PackagePriceView {
  const lines = normalisedLines(input.record?.lines);
  const source: SellingTotalSource = input.record?.source ?? (input.fromQuotation ? 'quotation_total' : input.formRules === 2 ? 'per_person' : 'legacy_total');
  const purchaseTotalPaise = lines.some((l) => l.quantity > 0) ? sumPaise(lines, 'purchasePaise') : null;
  const saleSum = lines.some((l) => l.quantity > 0) ? sumPaise(lines, 'salePaise') : null;
  return {
    lines,
    sellingTotalPaise: input.sellingTotalPaise,
    purchaseTotalPaise,
    markupTotalPaise: purchaseTotalPaise !== null && saleSum !== null ? (BigInt(saleSum) - BigInt(purchaseTotalPaise)).toString() : null,
    source,
    linesRequired: input.record?.linesRequired ?? (input.formRules === 2 && !input.fromQuotation),
  };
}

export function billToView(record: BookingFormRecord['billing'], bookingFor: 'individual' | 'business' | null): BillToView | null {
  if (record.status === 'none') return null;
  return {
    status: record.status,
    type: record.billToType ?? (bookingFor === 'business' ? 'business' : 'personal'),
    name: record.billingName ?? '',
    contactPerson: record.contactPerson,
    phone: record.phone,
    email: record.email,
    addressLine1: record.addressLine1 ?? '',
    addressLine2: record.addressLine2,
    city: record.city ?? '',
    stateCode: record.stateCode ?? '',
    postalCode: record.postalCode ?? '',
    country: 'India',
    gstStatus: record.gstStatus ?? (record.gstin ? 'registered' : null),
    gstReason: record.gstReason,
    gstin: record.gstin,
    verifiedByName: record.verifiedByName,
    verifiedAt: record.verifiedAt,
    rowVersion: record.rowVersion,
    ...(record.partyId !== undefined ? { partyId: record.partyId } : {}),
    ...(record.partyCheckStatus !== undefined ? { partyCheckStatus: record.partyCheckStatus } : {}),
  };
}

// ---------------------------------------------------------------------------
// The view model
// ---------------------------------------------------------------------------

export function statusLineOf(view: Pick<BookNowView, 'version'>, ownerText: string | null, checklist: readonly BookingFormChecklistItem[]) {
  const v = view.version;
  const state = v ? `${v.status === 'draft' ? 'Draft' : BOOK_VERSION_STATUS_LABEL[v.status]} · version ${v.versionNo}` : 'Not started';
  const blocking = checklist.filter((i) => i.blocking).length;
  const next = v?.status !== 'draft' ? null : blocking > 0 ? `Next: finish ${blocking} ${blocking === 1 ? 'thing' : 'things'} (marked in the steps)` : 'Next: review and submit (step 3)';
  return { state, owner: ownerText ? `Owner: ${ownerText}` : null, next };
}

export interface BookingFormVMInput {
  view: BookNowView;
  form: BookingFormRecord;
  commercialAllowed: boolean;
  /** The step the address asked for; null = the first step that needs input. */
  step: BookingFormStep | null;
  ownerText: string | null;
}

export function toBookingFormVM(input: BookingFormVMInput): BookingFormVM {
  const { view, form, commercialAllowed } = input;
  const started = view.version !== null;
  const editable = view.canEdit && view.version?.status === 'draft' && !view.dealNotActive;
  const party: BookingParty = { total: form.party?.total ?? null, children: form.party?.children ?? null, infants: form.party?.infants ?? null };
  const formRules: 1 | 2 = form.version?.formRules === 2 ? 2 : 1;
  const itemFilesCanEdit = editable && form.itemFilesCanEdit === true;
  const records = new Map(form.items.map((r) => [r.itemId, r]));

  const items: BookingFormServiceItemView[] = view.items.map((item) => {
    const record = records.get(item.itemId);
    const facts = record ? mergedFacts(record) : { ...(item.facts.facts as unknown as Record<string, unknown>) };
    const locked = !editable || item.state !== 'planned';
    return {
      itemId: item.itemId,
      itemNo: item.itemNo,
      serviceType: item.serviceType,
      facts,
      summary: item.title,
      participants: [...item.participants],
      ...(item.purchaseBudgetPaise !== undefined ? { purchaseBudgetPaise: item.purchaseBudgetPaise } : {}),
      ...(commercialAllowed && record && record.estimate !== undefined ? { estimate: estimateView(item.serviceType, facts, record.estimate) } : {}),
      ...(record && record.files !== undefined ? { files: fileViews(view.dealId, record, itemFilesCanEdit && !locked) } : {}),
      locked,
    };
  });

  const coverageItems: ServiceItemFacts[] = items.map((i) => ({ id: i.itemId, serviceType: i.serviceType, facts: i.facts }));
  const stays = staysOf(coverageItems);
  // The database's own coverage when it sends one (same rule); else worked out here (older database).
  const coverage =
    stays.length === 0 ? null : form.coverage ? { nights: form.coverage.nights, covered: form.coverage.covered, missing: [...form.coverage.missing], outside: [...form.coverage.outside] } : hotelCoverage(view.trip.start, view.trip.end, stays);

  const prices =
    commercialAllowed && form.prices !== undefined
      ? packagePriceView({ record: form.prices, formRules, fromQuotation: view.quotationSource !== undefined, sellingTotalPaise: form.prices?.sellingTotalPaise ?? view.commercials?.sellingTotalPaise ?? null })
      : commercialAllowed && view.commercials !== undefined
        ? // Older database (no price lines yet): the typed total, no lines, nothing required.
          packagePriceView({ record: { lines: [], source: view.quotationSource ? 'quotation_total' : 'legacy_total', linesRequired: false, sellingTotalPaise: null }, formRules, fromQuotation: view.quotationSource !== undefined, sellingTotalPaise: view.commercials.sellingTotalPaise })
          : undefined;

  const checklist = bookingFormChecklist(view.checklist, {
    commercialAllowed,
    coverage,
    prices,
    party,
    itemIdByNo: new Map(items.map((i) => [i.itemNo, i.itemId])),
    rowBySeq: new Map(view.travellers.map((t, i) => [t.seq, i + 1])),
  });
  const sectionStatus = formSectionStatus(checklist, started);
  const prefillMode: BookingFormPrefillMode = view.prefill?.autoFill?.enabled === true ? 'auto' : 'off';

  return {
    initialStep: input.step ?? firstOpenFormStep(sectionStatus),
    statusLine: statusLineOf(view, input.ownerText, checklist),
    party,
    trip: { ...view.trip },
    customerType: form.contacts?.customerType ?? null,
    market: form.contacts?.market ?? null,
    prefillMode,
    formRules,
    items,
    coverage,
    ...(prices ? { prices } : {}),
    billTo: billToView(form.billing, view.contacts?.bookingFor ?? null),
    sectionStatus,
    checklist,
    itemFilesCanEdit,
    partyAdults: form.party?.adults ?? null,
    dealFacts: dealFactsView(form.tripFacts),
  };
}

/** "Package selling total ₹24,000" or "Not worked out yet" (never ₹0 for missing amounts). */
export function sellingTotalText(prices: Pick<PackagePriceView, 'sellingTotalPaise'>): string {
  return formatInr(prices.sellingTotalPaise, 'Not worked out yet');
}
