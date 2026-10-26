/*
 * Booking form parsers (Terra, 22 October 2026). Read the frozen form field
 * names Luna's screens post (lead relay, luna-booking-form.md §P2), never an
 * actor, entity, branch, owner or total. Amounts are parsed with the shared
 * model (booking-form-model.ts) into whole paise strings; the database
 * validates and recomputes everything again.
 */

import type { BillToType, GstStatus, PriceCategory, PriceLine, ServiceEstimate, TripSavePartyKeys } from './booking-form-contract';
import { CUSTOMER_MARKETS, CUSTOMER_TYPES, PAX_TOTAL_MAX, PRICE_CATEGORIES, type CustomerMarket, type CustomerType } from './booking-form-contract';
import { addDays, GST_REASON_LIMITS, GST_STATE_CODE, gstinMatchesState, isIsoDate, normalisePhone, POSTAL_CODE, rupeesToPaise, EMAIL_SHAPE } from './booking-form-model';
import { parseBookCustomerForm, parseBookTripBlockForm, type BookCustomerForm, type BookTripBlockForm } from './b11-forms';
import { derivedAdults } from './passenger-slots';
import type { BillingProposalFields, ServiceFacts } from './contracts';
import { FIELD, formReaders, type ParsedForm, parseServiceItemForm, readRowVersion, readUuid, type ServiceItemForm } from './forms';

const { text, strings } = formReaders;

/** New input names of the booking form (existing names stay in forms.ts FIELD). */
export const BOOKING_FORM_FIELD = {
  paxTotal: 'paxTotal',
  /** Voice-note batch: adults has its own box; adults + children + infants must equal the total. */
  adults: 'adults',
  children: 'children',
  infants: 'infants',
  customerType: 'customerType',
  market: 'market',
  // Services
  nights: 'nights',
  roomRateRupees: 'roomRateRupees',
  extraBedRateRupees: 'extraBedRateRupees',
  noBedRateRupees: 'noBedRateRupees',
  endDate: 'endDate',
  quantity: 'quantity',
  includedKms: 'includedKms',
  vendor: 'vendor',
  vehicleRateRupees: 'vehicleRateRupees',
  fareTotalRupees: 'fareTotalRupees',
  segmentArrivalDate: 'segmentArrivalDate',
  segmentAirline: 'segmentAirline',
  segmentFlightNo: 'segmentFlightNo',
  segmentDepartTime: 'segmentDepartTime',
  segmentArriveTime: 'segmentArriveTime',
  // Item files
  fileId: 'fileId',
  fileRowVersion: 'fileRowVersion',
  // Prices (four rows in PRICE_CATEGORIES order)
  priceCategory: 'priceCategory',
  priceQuantity: 'priceQuantity',
  pricePurchaseRupees: 'pricePurchaseRupees',
  priceMarkupRupees: 'priceMarkupRupees',
  priceSaleRupees: 'priceSaleRupees',
  // Bill To
  billToType: 'billToType',
  contactPerson: 'contactPerson',
  billingPhone: 'billingPhone',
  billingEmail: 'billingEmail',
  gstStatus: 'gstStatus',
  gstReason: 'gstReason',
} as const;

const B = BOOKING_FORM_FIELD;

// Voice-note batch (24 October 2026) input names.
/** Hidden repeated input: the seq of each saved passenger staff removed with "Remove passenger" (and confirmed). */
export const REMOVE_TRAVELLER_FIELD = 'removeTravellerSeq';
/** Per-row input (parallel to travellerName): comma-joined standard request codes ('' = none). */
export const TRAVELLER_REQUESTS_FIELD = 'travellerRequests';
/** Repeated input in the passenger Details drawer: additional phone numbers (0..3), same rule as the passenger phone. */
export const EXTRA_PHONE_FIELD = 'passengerPhoneExtra';
export const EXTRA_PHONES_MAX = 3;
/** Hidden Bill To input: the stored customer picked or added ('' = typed by hand). */
export const BILL_TO_PARTY_FIELD = 'partyId';

function value(formData: FormData, name: string): string {
  return (text(formData, name) ?? '').trim();
}

export const INCLUDED_KMS_MAX = 100_000;

function readOptionalCount(formData: FormData, name: string, min: number, max: number): number | null | undefined {
  const raw = value(formData, name);
  if (raw === '') return null;
  if (!/^\d{1,6}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n < min || n > max ? undefined : n;
}

function readRequestId(formData: FormData, fields: string[]): string | null {
  const id = readUuid(formData, FIELD.requestId);
  if (!id) fields.push(FIELD.requestId);
  return id;
}

// ---------------------------------------------------------------------------
// Step 1 · customer, trip and party (booking_customer_save then booking_trip_save)
// ---------------------------------------------------------------------------

export interface BookingCustomerForm {
  /** True when the form did not post booking-for / payer (the action keeps the stored values). */
  keepStoredContactExtras: boolean;
  customer: BookCustomerForm & { contact: BookCustomerForm['contact'] & { customerType: CustomerType | null; market: CustomerMarket | null } };
  trip: BookTripBlockForm & { trip: BookTripBlockForm['trip'] & TripSavePartyKeys & { adults?: number | null } };
  /**
   * Voice-note batch: the adults count, only when the form has the adults box
   * (absent = an older screen; the counts then follow the old rule). An empty
   * box with a total is worked out as total − children − infants.
   */
  adults?: number | null;
}

/**
 * The customer card of step 1: contact (billing is never posted here; Bill
 * To saves in step 3), trip block (all four keys, since the database clears
 * an absent one) and the party counts. bookingFor, payerDifferent and
 * payerName are posted as hidden values so the contact save keeps them.
 */
export function parseBookingCustomerForm(formData: FormData): ParsedForm<BookingCustomerForm> {
  const fields: string[] = [];
  // Billing inputs never ride on this form.
  const contactData = new FormData();
  for (const [k, v] of formData.entries()) {
    if ([FIELD.billingName, FIELD.addressLine1, FIELD.addressLine2, FIELD.billingCity, FIELD.stateCode, FIELD.postalCode, FIELD.gstin].includes(k as never)) continue;
    contactData.append(k, v);
  }
  const keepStoredContactExtras = !formData.has(FIELD.bookingFor);
  if (keepStoredContactExtras) contactData.set(FIELD.bookingFor, 'individual');
  const customer = parseBookCustomerForm(contactData);
  if (!customer.ok) fields.push(...customer.fields);
  const trip = parseBookTripBlockForm(formData);
  if (!trip.ok) fields.push(...trip.fields);

  const customerTypeRaw = value(formData, B.customerType);
  const customerType = customerTypeRaw === '' ? null : (CUSTOMER_TYPES as readonly string[]).includes(customerTypeRaw) ? (customerTypeRaw as CustomerType) : undefined;
  if (customerType === undefined) fields.push(B.customerType);
  const marketRaw = value(formData, B.market);
  const market = marketRaw === '' ? null : (CUSTOMER_MARKETS as readonly string[]).includes(marketRaw) ? (marketRaw as CustomerMarket) : undefined;
  if (market === undefined) fields.push(B.market);

  const paxTotal = readOptionalCount(formData, B.paxTotal, 1, PAX_TOTAL_MAX);
  if (paxTotal === undefined) fields.push(B.paxTotal);
  const children = readOptionalCount(formData, B.children, 0, PAX_TOTAL_MAX);
  if (children === undefined) fields.push(B.children);
  const infants = readOptionalCount(formData, B.infants, 0, PAX_TOTAL_MAX);
  if (infants === undefined) fields.push(B.infants);
  if (typeof paxTotal === 'number' && (children ?? 0) + (infants ?? 0) > paxTotal) fields.push(B.children);
  if (paxTotal === null && ((children ?? 0) > 0 || (infants ?? 0) > 0)) fields.push(B.paxTotal);
  const hasAdults = formData.has(B.adults);
  let adults = hasAdults ? readOptionalCount(formData, B.adults, 0, PAX_TOTAL_MAX) : undefined;
  if (hasAdults && adults === undefined) fields.push(B.adults);
  if (hasAdults && adults === null && typeof paxTotal === 'number' && children !== undefined && infants !== undefined) {
    adults = derivedAdults({ total: paxTotal, children, infants });
  }
  if (hasAdults && paxTotal === null && (adults ?? 0) > 0) fields.push(B.paxTotal);

  if (fields.length > 0 || !customer.ok || !trip.ok) return { ok: false, fields: [...new Set(fields)] };
  return {
    ok: true,
    value: {
      keepStoredContactExtras,
      customer: { ...customer.value, billing: null, contact: { ...customer.value.contact, customerType: customerType ?? null, market: market ?? null } },
      trip: { ...trip.value, trip: { ...trip.value.trip, paxTotal: paxTotal ?? null, children: children ?? null, infants: infants ?? null } },
      ...(hasAdults ? { adults: adults ?? null } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Step 2 · one service (booking_service_save)
// ---------------------------------------------------------------------------

export interface BookingServiceForm extends Omit<ServiceItemForm, 'facts' | 'requestId'> {
  requestId: string;
  facts: ServiceFacts;
  /** null = the editor posted no estimate inputs (unchanged; also what an editor without price access sends). */
  estimate: ServiceEstimate | null;
  /** null = keep the stored budget on a save (0 on an add). */
  budgetPaise: string | null;
  /**
   * Voice-note batch: a hotel posted without adults (the box is gone). The
   * facts then carry no adults; the action leaves it to the database (which
   * takes the booking's adults) or, on an older database, fills the
   * booking's adults itself.
   */
  adultsFromBooking: boolean;
  /** Voice-note batch: the stored hotel picked from the list (undefined = not posted). */
  catalogueHotelId?: string | null;
  /** Voice-note batch: "Save and attach screenshot" (the drawer reopens on the saved flight). */
  thenAttach: boolean;
}

/** Hidden inputs of the voice-note service editor. */
export const SERVICE_VN_FIELD = { hotelId: 'hotelId', thenAttach: 'thenAttach' } as const;
/** Placeholder adults while parsing a hotel without the adults box; never saved (removed before the save). */
const ADULTS_PLACEHOLDER = '1';

function readRate(formData: FormData, name: string, fields: string[]): string | null {
  const paise = rupeesToPaise(value(formData, name));
  if (paise === undefined) {
    fields.push(name);
    return null;
  }
  return paise;
}

/**
 * One service editor. Reuses the existing facts parser (field names and
 * rules unchanged), adds the hotel nights (check-out derived), the car and
 * flight keys of the booking form and the supplier estimate.
 */
export function parseBookingServiceForm(formData: FormData): ParsedForm<BookingServiceForm> {
  const fields: string[] = [];
  const data = new FormData();
  for (const [k, v] of formData.entries()) data.append(k, v);
  const type = value(formData, FIELD.serviceType);

  // Hotel: nights → check-out (the database stores check-out, as today).
  if (type === 'hotel' && formData.has(B.nights)) {
    const nights = readOptionalCount(formData, B.nights, 1, 365);
    const checkIn = value(formData, FIELD.checkIn);
    if (nights === undefined || nights === null) fields.push(B.nights);
    else if (isIsoDate(checkIn)) data.set(FIELD.checkOut, addDays(checkIn, nights));
  }
  if (type === 'hotel' && !value(formData, FIELD.mode)) data.set(FIELD.mode, 'specific');
  // Voice-note batch: hotel adults is no longer typed (owner item 4).
  const adultsFromBooking = type === 'hotel' && value(formData, FIELD.adults) === '';
  if (adultsFromBooking) data.set(FIELD.adults, ADULTS_PLACEHOLDER);
  // Voice-note batch: flight passengers follow the passengers chosen (owner item 7).
  if (type === 'flight' && formData.has(FIELD.participantSeq)) {
    const chosen = new Set(strings(formData, FIELD.participantSeq).map((x) => x.trim()).filter((x) => x !== ''));
    if (chosen.size > 0) data.set(FIELD.passengers, String(chosen.size));
  }
  let catalogueHotelId: string | null | undefined;
  if (type === 'hotel' && formData.has(SERVICE_VN_FIELD.hotelId)) {
    const raw = value(formData, SERVICE_VN_FIELD.hotelId);
    if (raw === '') catalogueHotelId = null;
    else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) catalogueHotelId = raw.toLowerCase();
    else fields.push(SERVICE_VN_FIELD.hotelId);
  }

  const base = parseServiceItemForm(data);
  if (!base.ok) fields.push(...base.fields);
  const requestId = readRequestId(formData, fields);

  let estimate: ServiceEstimate | null = null;
  const extra: Record<string, unknown> = {};
  if (type === 'hotel') {
    if ([B.roomRateRupees, B.extraBedRateRupees, B.noBedRateRupees].some((n) => formData.has(n))) {
      estimate = { kind: 'hotel', roomRatePaise: readRate(formData, B.roomRateRupees, fields), extraBedRatePaise: readRate(formData, B.extraBedRateRupees, fields), noBedRatePaise: readRate(formData, B.noBedRateRupees, fields) };
    }
  } else if (type === 'transfer') {
    const endDate = value(formData, B.endDate);
    const date = value(formData, FIELD.date);
    if (endDate !== '') {
      if (!isIsoDate(endDate) || (isIsoDate(date) && endDate < date)) fields.push(B.endDate);
      else extra.endDate = endDate;
    }
    const quantity = readOptionalCount(formData, B.quantity, 1, 100);
    if (quantity === undefined) fields.push(B.quantity);
    else if (quantity !== null) extra.quantity = quantity;
    // Echo L5: one limit everywhere (validate_service_facts, the facts schemas): 0 to 100,000.
    const kms = readOptionalCount(formData, B.includedKms, 0, INCLUDED_KMS_MAX);
    if (kms === undefined) fields.push(B.includedKms);
    else if (kms !== null) extra.includedKms = kms;
    const vendor = value(formData, B.vendor).replace(/\s+/g, ' ');
    if (vendor.length > 150) fields.push(B.vendor);
    else if (vendor !== '') extra.vendor = vendor;
    if (formData.has(B.vehicleRateRupees)) estimate = { kind: 'transfer', vehicleRatePaise: readRate(formData, B.vehicleRateRupees, fields) };
  } else if (type === 'flight') {
    if (formData.has(B.fareTotalRupees)) estimate = { kind: 'flight', fareTotalPaise: readRate(formData, B.fareTotalRupees, fields) };
  }

  if (fields.length > 0 || !base.ok) return { ok: false, fields: [...new Set(fields)] };
  const v = base.value;
  let facts = v.facts;
  if (facts.type === 'hotel' && adultsFromBooking) {
    const { adults: _placeholder, ...rest } = facts.facts;
    void _placeholder;
    facts = { type: 'hotel', facts: rest as typeof facts.facts };
  }
  if (facts.type === 'transfer') facts = { type: 'transfer', facts: { ...facts.facts, ...extra } };
  if (facts.type === 'flight') {
    const segs = flightSegmentExtras(formData, fields);
    if (fields.length > 0) return { ok: false, fields: [...new Set(fields)] };
    facts = { type: 'flight', facts: { ...facts.facts, segments: facts.facts.segments.map((s, i) => ({ ...s, ...(segs[i] ?? {}) })) } };
  }
  return {
    ok: true,
    value: {
      ...v,
      facts,
      requestId: requestId!,
      estimate,
      // The existing parser reads an empty budget as '0'; an empty input means "keep" on a save.
      budgetPaise: value(formData, FIELD.purchaseBudgetRupees) === '' ? (v.itemId ? null : '0') : v.purchaseBudgetPaise,
      adultsFromBooking,
      ...(catalogueHotelId !== undefined ? { catalogueHotelId } : {}),
      thenAttach: value(formData, SERVICE_VN_FIELD.thenAttach) === '1',
    },
  };
}

/** Segment extras aligned with the segments the facts parser kept (blank rows are skipped there too). */
function flightSegmentExtras(formData: FormData, fields: string[]): Array<Record<string, string>> {
  const from = strings(formData, FIELD.segmentFrom);
  const to = strings(formData, FIELD.segmentTo);
  const dates = strings(formData, FIELD.segmentDate);
  const flexes = strings(formData, FIELD.segmentFlex);
  const arrival = strings(formData, B.segmentArrivalDate);
  const airline = strings(formData, B.segmentAirline);
  const flightNo = strings(formData, B.segmentFlightNo);
  const depart = strings(formData, B.segmentDepartTime);
  const arrive = strings(formData, B.segmentArriveTime);
  const rows = Math.max(from.length, to.length, dates.length);
  const out: Array<Record<string, string>> = [];
  const time = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
  for (let i = 0; i < rows; i += 1) {
    if ([from[i], to[i], dates[i], flexes[i]].every((x) => (x ?? '').trim() === '')) continue;
    const seg: Record<string, string> = {};
    const a = (arrival[i] ?? '').trim();
    if (a !== '') {
      if (!isIsoDate(a) || a < (dates[i] ?? '').trim()) fields.push(`${B.segmentArrivalDate}[${i}]`);
      else seg.arrivalDate = a;
    }
    const al = (airline[i] ?? '').trim().replace(/\s+/g, ' ');
    if (al.length > 60) fields.push(`${B.segmentAirline}[${i}]`);
    else if (al !== '') seg.airline = al;
    const no = (flightNo[i] ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
    if (no.length > 12) fields.push(`${B.segmentFlightNo}[${i}]`);
    else if (no !== '') seg.flightNo = no;
    const d = (depart[i] ?? '').trim();
    if (d !== '' && !time.test(d)) fields.push(`${B.segmentDepartTime}[${i}]`);
    else if (d !== '') seg.departTime = d;
    const r = (arrive[i] ?? '').trim();
    if (r !== '' && !time.test(r)) fields.push(`${B.segmentArriveTime}[${i}]`);
    else if (r !== '') seg.arriveTime = r;
    // Local clock times are never compared across time zones.
    out.push(seg);
  }
  return out;
}

/** Database hint keys of booking_service_save → form names (facts keys keep the existing mapping). */
export function serviceHintField(key: string): string {
  const seg = /^segments\[(\d+)\]\.(arrivalDate|airline|flightNo|departTime|arriveTime|from|to|date|flex)$/.exec(key);
  if (seg) {
    const part = seg[2]!;
    const name = { arrivalDate: B.segmentArrivalDate, airline: B.segmentAirline, flightNo: B.segmentFlightNo, departTime: B.segmentDepartTime, arriveTime: B.segmentArriveTime, from: FIELD.segmentFrom, to: FIELD.segmentTo, date: FIELD.segmentDate, flex: FIELD.segmentFlex }[part];
    return `${name}[${seg[1]}]`;
  }
  const est = /^estimate\.(roomRatePaise|extraBedRatePaise|noBedRatePaise|vehicleRatePaise|fareTotalPaise)$/.exec(key);
  if (est) return { roomRatePaise: B.roomRateRupees, extraBedRatePaise: B.extraBedRateRupees, noBedRatePaise: B.noBedRateRupees, vehicleRatePaise: B.vehicleRateRupees, fareTotalPaise: B.fareTotalRupees }[est[1] as 'roomRatePaise'];
  if (key === 'purchaseBudgetPaise' || key === 'budget') return FIELD.purchaseBudgetRupees;
  if (key === 'participants') return FIELD.participantSeq;
  return key.replace(/\[\d+\].*$/, '').replace(/\..*$/, '');
}

// ---------------------------------------------------------------------------
// Step 2 · flight screenshot files
// ---------------------------------------------------------------------------

export interface ItemFileUploadForm {
  dealId: string;
  versionId: string;
  itemId: string;
  kind: 'flight_screenshot';
  requestId: string;
}

export function parseItemFileUploadForm(formData: FormData): ParsedForm<ItemFileUploadForm> {
  const fields: string[] = [];
  const dealId = readUuid(formData, FIELD.dealId);
  if (!dealId) fields.push(FIELD.dealId);
  const versionId = readUuid(formData, FIELD.versionId);
  if (!versionId) fields.push(FIELD.versionId);
  const itemId = readUuid(formData, FIELD.itemId);
  if (!itemId) fields.push(FIELD.itemId);
  if (value(formData, FIELD.kind) !== 'flight_screenshot') fields.push(FIELD.kind);
  const requestId = readRequestId(formData, fields);
  if (fields.length > 0) return { ok: false, fields };
  return { ok: true, value: { dealId: dealId!, versionId: versionId!, itemId: itemId!, kind: 'flight_screenshot', requestId: requestId! } };
}

/** Removal posts the file's row version as the screen showed it (Echo L4: a stale screen is refused, never re-read). */
export function parseItemFileRemoveForm(formData: FormData): ParsedForm<{ dealId: string; fileId: string; expectedRowVersion: number }> {
  const fields: string[] = [];
  const dealId = readUuid(formData, FIELD.dealId);
  if (!dealId) fields.push(FIELD.dealId);
  const fileId = readUuid(formData, B.fileId);
  if (!fileId) fields.push(B.fileId);
  const rv = value(formData, B.fileRowVersion);
  const expectedRowVersion = /^[1-9][0-9]{0,8}$/.test(rv) ? Number(rv) : null;
  if (expectedRowVersion === null) fields.push(B.fileRowVersion);
  if (fields.length > 0) return { ok: false, fields };
  return { ok: true, value: { dealId: dealId!, fileId: fileId!, expectedRowVersion: expectedRowVersion! } };
}

// ---------------------------------------------------------------------------
// Step 3 · per-person prices (booking_prices_save)
// ---------------------------------------------------------------------------

export interface BookingPricesForm {
  dealId: string;
  versionId: string;
  expectedRowVersion: number;
  requestId: string;
  lines: PriceLine[];
}

/** Input name of one price amount in the row of `category` (refusal field names). */
export function priceInputName(name: string, category: PriceCategory): string {
  return `${name}[${category}]`;
}

/**
 * The four category rows (PRICE_CATEGORIES order, each once). '' = missing.
 * Each row with people needs all three amounts or none (the database stores
 * a row whole), and purchase + markup = final sale. Markup may be negative
 * (a sale below purchase saves as a draft; readiness blocks submit).
 */
export function parseBookingPricesForm(formData: FormData): ParsedForm<BookingPricesForm> {
  const fields: string[] = [];
  const dealId = readUuid(formData, FIELD.dealId);
  if (!dealId) fields.push(FIELD.dealId);
  const versionId = readUuid(formData, FIELD.versionId);
  if (!versionId) fields.push(FIELD.versionId);
  const expectedRowVersion = readRowVersion(formData);
  if (expectedRowVersion === null) fields.push(FIELD.rowVersion);
  const requestId = readRequestId(formData, fields);

  const cats = strings(formData, B.priceCategory);
  const qtys = strings(formData, B.priceQuantity);
  const purchases = strings(formData, B.pricePurchaseRupees);
  const markups = strings(formData, B.priceMarkupRupees);
  const sales = strings(formData, B.priceSaleRupees);
  if (cats.length !== PRICE_CATEGORIES.length || PRICE_CATEGORIES.some((c, i) => cats[i]?.trim() !== c)) return { ok: false, fields: [...new Set([...fields, B.priceCategory])] };

  const lines: PriceLine[] = PRICE_CATEGORIES.map((category, i) => {
    const qRaw = (qtys[i] ?? '').trim();
    const quantity = /^\d{1,3}$/.test(qRaw) && Number(qRaw) <= PAX_TOTAL_MAX ? Number(qRaw) : null;
    if (quantity === null) fields.push(priceInputName(B.priceQuantity, category));
    if (!quantity) return { category, quantity: quantity ?? 0, purchasePaise: null, markupPaise: null, salePaise: null };
    const purchasePaise = rupeesToPaise(purchases[i] ?? '');
    const markupPaise = rupeesToPaise(markups[i] ?? '', { signed: true });
    const salePaise = rupeesToPaise(sales[i] ?? '');
    if (purchasePaise === undefined) fields.push(priceInputName(B.pricePurchaseRupees, category));
    if (markupPaise === undefined) fields.push(priceInputName(B.priceMarkupRupees, category));
    if (salePaise === undefined) fields.push(priceInputName(B.priceSaleRupees, category));
    const set = [purchasePaise, markupPaise, salePaise];
    if (set.every((x) => typeof x === 'string')) {
      if (BigInt(purchasePaise!) + BigInt(markupPaise!) !== BigInt(salePaise!)) fields.push(priceInputName(B.priceSaleRupees, category));
    } else if (set.some((x) => typeof x === 'string') && set.every((x) => x !== undefined)) {
      // Part of a row: name the empty ones (the database stores a row whole).
      if (purchasePaise === null) fields.push(priceInputName(B.pricePurchaseRupees, category));
      if (markupPaise === null) fields.push(priceInputName(B.priceMarkupRupees, category));
      if (salePaise === null) fields.push(priceInputName(B.priceSaleRupees, category));
    }
    return { category, quantity, purchasePaise: purchasePaise ?? null, markupPaise: markupPaise ?? null, salePaise: salePaise ?? null };
  });
  if (fields.length > 0) return { ok: false, fields: [...new Set(fields)] };
  return { ok: true, value: { dealId: dealId!, versionId: versionId!, expectedRowVersion: expectedRowVersion!, requestId: requestId!, lines } };
}

/** Database hint 'lines[adult].salePaise' → 'priceSaleRupees[adult]'. */
export function priceHintField(key: string): string {
  const m = /^lines\[(adult|child_bed|child_no_bed|infant)\]\.(quantity|purchasePaise|markupPaise|salePaise)$/.exec(key);
  if (!m) return key === 'lines' ? B.priceCategory : key;
  const name = { quantity: B.priceQuantity, purchasePaise: B.pricePurchaseRupees, markupPaise: B.priceMarkupRupees, salePaise: B.priceSaleRupees }[m[2] as 'quantity'];
  return priceInputName(name, m[1] as PriceCategory);
}

// ---------------------------------------------------------------------------
// Step 3 · Bill To (booking_billing_propose)
// ---------------------------------------------------------------------------

export interface BillToForm {
  dealId: string;
  requestId: string;
  billingExpectedRowVersion: number;
  fields: BillingProposalFields & {
    billToType: BillToType;
    contactPerson: string | null;
    phone: string | null;
    email: string | null;
    gstStatus: GstStatus | null;
    gstReason: string | null;
  };
}

/**
 * Bill To as a draft proposal (Accounts verifies; Sales never does). The
 * profile needs name, address, city, state and PIN to be stored; the GST
 * answer, business contact and phone/email may follow later (readiness
 * names them). India only this release.
 */
export function parseBillToForm(formData: FormData): ParsedForm<BillToForm> {
  const fields: string[] = [];
  const dealId = readUuid(formData, FIELD.dealId);
  if (!dealId) fields.push(FIELD.dealId);
  const requestId = readRequestId(formData, fields);
  const rvRaw = value(formData, FIELD.billingRowVersion);
  const billingExpectedRowVersion = /^\d{1,9}$/.test(rvRaw) ? Number(rvRaw) : null;
  if (billingExpectedRowVersion === null) fields.push(FIELD.billingRowVersion);

  const typeRaw = value(formData, B.billToType);
  const type: BillToType | null = typeRaw === 'personal' || typeRaw === 'business' ? typeRaw : null;
  if (!type) fields.push(B.billToType);
  const business = type === 'business';
  const line = (name: string, max: number, required: boolean): string | null => {
    const v = value(formData, name).replace(/\s+/g, ' ');
    if (v === '') {
      if (required) fields.push(name);
      return null;
    }
    if (v.length > max) fields.push(name);
    return v;
  };
  const billingName = line(FIELD.billingName, 200, true);
  const addressLine1 = line(FIELD.addressLine1, 200, true);
  const addressLine2 = line(FIELD.addressLine2, 200, false);
  const city = line(FIELD.billingCity, 120, true);
  const stateCode = value(formData, FIELD.stateCode);
  if (!GST_STATE_CODE.test(stateCode)) fields.push(FIELD.stateCode);
  const postalCode = value(formData, FIELD.postalCode).replace(/\s/g, '');
  if (!POSTAL_CODE.test(postalCode)) fields.push(FIELD.postalCode);
  const contactPerson = business ? line(B.contactPerson, 120, false) : null;
  const phone = normalisePhone(value(formData, B.billingPhone));
  if (phone === undefined) fields.push(B.billingPhone);
  const emailRaw = value(formData, B.billingEmail).toLowerCase();
  const email = emailRaw === '' ? null : emailRaw.length <= 254 && EMAIL_SHAPE.test(emailRaw) ? emailRaw : undefined;
  if (email === undefined) fields.push(B.billingEmail);

  const statusRaw = value(formData, B.gstStatus);
  const gstStatus: GstStatus | null = !business || statusRaw === '' ? null : statusRaw === 'registered' || statusRaw === 'unregistered' ? statusRaw : null;
  if (business && statusRaw !== '' && gstStatus === null) fields.push(B.gstStatus);
  const gstinRaw = value(formData, FIELD.gstin).toUpperCase();
  let gstin: string | null = null;
  let gstReason: string | null = null;
  if (gstStatus === 'registered' && gstinRaw !== '') {
    if (!gstinMatchesState(gstinRaw, stateCode)) fields.push(FIELD.gstin);
    gstin = gstinRaw;
  }
  if (gstStatus === 'unregistered') {
    const reason = value(formData, B.gstReason);
    if (reason !== '' && (reason.length < GST_REASON_LIMITS.min || reason.length > GST_REASON_LIMITS.max)) fields.push(B.gstReason);
    gstReason = reason === '' ? null : reason;
  }

  if (fields.length > 0) return { ok: false, fields: [...new Set(fields)] };
  return {
    ok: true,
    value: {
      dealId: dealId!,
      requestId: requestId!,
      billingExpectedRowVersion: billingExpectedRowVersion!,
      fields: {
        billingName: billingName!,
        addressLine1: addressLine1!,
        addressLine2,
        city: city!,
        stateCode,
        postalCode,
        gstin,
        billToType: type!,
        contactPerson,
        phone: phone ?? null,
        email: email ?? null,
        gstStatus,
        gstReason,
      },
    },
  };
}

/** Database hint keys of the billing proposal → form names. */
export const BILL_TO_HINTS: Readonly<Record<string, string>> = {
  billingName: FIELD.billingName,
  addressLine1: FIELD.addressLine1,
  addressLine2: FIELD.addressLine2,
  city: FIELD.billingCity,
  stateCode: FIELD.stateCode,
  postalCode: FIELD.postalCode,
  gstin: FIELD.gstin,
  billToType: B.billToType,
  contactPerson: B.contactPerson,
  phone: B.billingPhone,
  email: B.billingEmail,
  gstStatus: B.gstStatus,
  gstReason: B.gstReason,
  billing: FIELD.billingName,
  requestId: FIELD.requestId,
};
