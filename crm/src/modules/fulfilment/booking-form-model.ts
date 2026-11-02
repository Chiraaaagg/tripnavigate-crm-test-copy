/*
 * Booking form model (Terra, 22 October 2026): the shared money, date,
 * coverage, Bill To and customer-list rules of the owner-approved booking
 * form. Pure functions only: no zod, no server imports, no React, so client
 * components may import it (strict CSP) and the server actions use the same
 * maths. The database stays authoritative: every rule here is rechecked by
 * the database commands and by readiness at submit.
 *
 * Ported from the approved preview (model.ts and validation.ts) with the
 * production differences frozen in docs/implementation/booking-form-2026-10-22/contract.md:
 *   - money is whole paise held as decimal integer strings (bigint-safe);
 *   - markup starts empty, so an explicit zero and a missing value differ;
 *   - at most 100 passengers; India-only Bill To with a GST state code;
 *   - hotel stays are check-in plus nights (check-out is derived).
 */

import {
  BOOKING_FORM_SECTION_STEP,
  CUSTOMER_LIST_FIELD_MAX,
  CUSTOMER_LIST_FIELDS,
  CUSTOMER_LIST_ID_MAX,
  CUSTOMER_LIST_MAX_BYTES,
  CUSTOMER_LIST_MAX_RESULTS,
  CUSTOMER_LIST_MAX_ROWS,
  CUSTOMER_LIST_MIN_QUERY,
  PAX_TOTAL_MAX,
  PRICE_AMOUNT_MAX_PAISE,
  PRICE_CATEGORIES,
  PRICE_CATEGORY_LABEL,
  type BillToType,
  type BookingFormSection,
  type BookingParty,
  type GstStatus,
  type HotelCoverage,
  type PriceCategory,
  type PriceLine,
  REQUEST_ITEMS_MAX,
  REQUEST_TEXT_MAX,
  type FlightFareTotals,
  type RequestItem,
} from './booking-form-contract';

// ---------------------------------------------------------------------------
// Issues (instant checks in the browser; the server repeats them)
// ---------------------------------------------------------------------------

export interface FormIssue {
  /** Stable code (readiness code where one exists). */
  code: string;
  /** Plain words for staff. */
  text: string;
  section: BookingFormSection;
  /** Input id to focus (BOOKING_FORM_FIELD_ID values or a row-scoped id); null = the section heading. */
  fieldId: string | null;
}

export function issueStep(issue: Pick<FormIssue, 'section'>): 'travellers' | 'stay' | 'finish' {
  return BOOKING_FORM_SECTION_STEP[issue.section];
}

/**
 * Input ids of the booking form, keyed by the form field name the actions
 * read (refusal `fields` use the same names). Luna keeps these ids on the
 * inputs so error links and refusals focus the right field.
 */
export const BOOKING_FORM_FIELD_ID = {
  contactName: 'bf-contact-name',
  mobile: 'bf-contact-mobile',
  email: 'bf-contact-email',
  contactConfirmed: 'bf-contact-confirmed',
  customerType: 'bf-customer-type',
  market: 'bf-market',
  destination: 'bf-destination',
  tripScope: 'bf-trip-scope',
  tripStart: 'bf-trip-start',
  tripEnd: 'bf-trip-end',
  paxTotal: 'bf-pax-total',
  adults: 'bf-adults',
  children: 'bf-children',
  infants: 'bf-infants',
  // Echo B-M1: the passengers card heading (a row's own Details button when the item names a passenger).
  passengers: 'passengers-heading',
  services: 'bf-services',
  billToType: 'bf-bill-type',
  billingName: 'bf-bill-name',
  contactPerson: 'bf-bill-contact',
  billingPhone: 'bf-bill-phone',
  billingEmail: 'bf-bill-email',
  addressLine1: 'bf-bill-address1',
  addressLine2: 'bf-bill-address2',
  billingCity: 'bf-bill-city',
  stateCode: 'bf-bill-state',
  postalCode: 'bf-bill-pin',
  gstStatus: 'bf-bill-gst-status',
  gstin: 'bf-bill-gstin',
  gstReason: 'bf-bill-gst-reason',
} as const;

/** Input id of one price amount: price-{category}-{purchase|markup|sale|quantity}. */
export function priceFieldId(category: PriceCategory, field: 'quantity' | 'purchase' | 'markup' | 'sale'): string {
  return `price-${category}-${field}`;
}

// ---------------------------------------------------------------------------
// Numbers, money and dates
// ---------------------------------------------------------------------------

/** A whole number typed by staff ("4"); null when empty or not a plain non-negative integer. */
export function parseCount(text: string | number | null | undefined): number | null {
  if (typeof text === 'number') return Number.isSafeInteger(text) && text >= 0 ? text : null;
  const t = String(text ?? '').trim();
  if (!/^\d{1,9}$/.test(t)) return null;
  return Number(t);
}

const RUPEES = /^(\d{1,13})(?:\.(\d{1,2}))?$/;

/**
 * Rupees typed by staff → whole paise as a decimal string.
 *   ''              → null (missing, never zero)
 *   '1,234.56'      → '123456' (Indian or Western comma grouping allowed)
 *   invalid or over → undefined ("1.001", "-1", "1e3", "₹100", over the cap)
 * `signed` allows a leading minus (a derived markup only).
 */
export function rupeesToPaise(text: string | null | undefined, opts: { signed?: boolean; max?: bigint } = {}): string | null | undefined {
  const raw = String(text ?? '').trim();
  if (raw === '') return null;
  let t = raw;
  let negative = false;
  if (opts.signed && t.startsWith('-')) {
    negative = true;
    t = t.slice(1).trim();
  }
  if (/,/.test(t)) {
    // Commas only between digit groups, never leading, trailing or doubled.
    if (!/^\d{1,3}(,\d{2,3})*(\.\d{1,2})?$/.test(t)) return undefined;
    t = t.replace(/,/g, '');
  }
  const m = RUPEES.exec(t);
  if (!m) return undefined;
  const paise = BigInt(m[1] ?? '0') * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
  const max = opts.max ?? PRICE_AMOUNT_MAX_PAISE;
  if (paise > max) return undefined;
  if (negative && paise === 0n) return '0';
  return (negative ? -paise : paise).toString();
}

function toBig(paise: string | null | undefined): bigint | null {
  if (paise === null || paise === undefined || !/^-?\d{1,20}$/.test(paise)) return null;
  return BigInt(paise);
}

/** Paise → rupee text for an input: '1300000' → '13000', '123456' → '1234.56', '-100000' → '-1000'. */
export function paiseToRupeesText(paise: string | null | undefined): string {
  const p = toBig(paise);
  if (p === null) return '';
  const neg = p < 0n;
  const abs = neg ? -p : p;
  const rupees = abs / 100n;
  const rest = abs % 100n;
  return `${neg ? '-' : ''}${rupees.toString()}${rest === 0n ? '' : `.${rest.toString().padStart(2, '0')}`}`;
}

/** Derived amount text always with two decimals, as the preview showed it ('13000.00', '-1000.00'). */
export function paiseToFixedText(p: bigint): string {
  const neg = p < 0n;
  const abs = neg ? -p : p;
  return `${neg ? '-' : ''}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}`;
}

const INR_GROUP = new Intl.NumberFormat('en-IN');

/** '2400000' → '₹24,000'; '123456' → '₹1,234.56'; null → 'Not priced' (never ₹0 for a missing amount). */
export function formatInr(paise: string | null | undefined, missing = 'Not priced'): string {
  const p = toBig(paise);
  if (p === null) return missing;
  const neg = p < 0n;
  const abs = neg ? -p : p;
  const rest = abs % 100n;
  return `${neg ? '−' : ''}₹${INR_GROUP.format(abs / 100n)}${rest === 0n ? '' : `.${rest.toString().padStart(2, '0')}`}`;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date YYYY-MM-DD. */
export function isIsoDate(v: string | null | undefined): v is string {
  if (!v || !ISO_DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** date + days (0..36500), '' when the date is not real. */
export function addDays(date: string, days: number): string {
  if (!isIsoDate(date) || !Number.isSafeInteger(days) || days < 0 || days > 36500) return '';
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  const out = d.toISOString();
  return /^\d{4}-/.test(out) ? out.slice(0, 10) : '';
}

/** Whole days from `a` to `b` (may be negative); null when either date is not real. */
export function daysBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!isIsoDate(a) || !isIsoDate(b)) return null;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Tour nights end − start, 0..365; null when missing, reversed or longer. */
export function tripNights(start: string | null | undefined, end: string | null | undefined): number | null {
  const n = daysBetween(start, end);
  return n !== null && n >= 0 && n <= 365 ? n : null;
}

/** Hotel nights from stored check-in/check-out (1..365), null otherwise. */
export function stayNights(checkIn: string | null | undefined, checkOut: string | null | undefined): number | null {
  const n = daysBetween(checkIn, checkOut);
  return n !== null && n >= 1 && n <= 365 ? n : null;
}

// ---------------------------------------------------------------------------
// Party counts
// ---------------------------------------------------------------------------

export interface PartyCounts {
  total: number | null;
  children: number | null;
  infants: number | null;
  /** total − children − infants; may be negative (an issue); null while any count is missing. */
  adults: number | null;
}

export function partyCounts(party: { total: string | number | null; children: string | number | null; infants: string | number | null }): PartyCounts {
  const total = parseCount(party.total);
  const children = parseCount(party.children);
  const infants = parseCount(party.infants);
  const adults = total === null || children === null || infants === null ? null : total - children - infants;
  return { total, children, infants, adults };
}

/** A saved party with missing child/infant counts reads as 0 for pricing (the form shows them as 0). */
export function partyFromSaved(p: BookingParty): PartyCounts {
  return partyCounts({ total: p.total, children: p.children ?? 0, infants: p.infants ?? 0 });
}

// ---------------------------------------------------------------------------
// Per-person package prices (step 3)
// ---------------------------------------------------------------------------

/** One category row as typed (rupee text). '' = missing. */
export interface PriceLineInput {
  category: PriceCategory;
  quantity: string;
  purchase: string;
  markup: string;
  sale: string;
}

export function emptyPriceLines(): PriceLineInput[] {
  return PRICE_CATEGORIES.map((category) => ({ category, quantity: '0', purchase: '', markup: '', sale: '' }));
}

/** Stored lines (paise) → typed rows, always the four categories in order. */
export function priceLinesFromSaved(lines: readonly PriceLine[] | null | undefined): PriceLineInput[] {
  return PRICE_CATEGORIES.map((category) => {
    const l = lines?.find((x) => x.category === category);
    if (!l) return { category, quantity: '0', purchase: '', markup: '', sale: '' };
    const markup = l.markupPaise ?? (l.purchasePaise !== null && l.salePaise !== null ? (BigInt(l.salePaise) - BigInt(l.purchasePaise)).toString() : null);
    return { category, quantity: String(l.quantity), purchase: paiseToRupeesText(l.purchasePaise), markup: paiseToRupeesText(markup), sale: paiseToRupeesText(l.salePaise) };
  });
}

/**
 * The approved edit rules (owner, 22 October 2026):
 *   purchase → markup kept, final sale recalculated;
 *   markup   → purchase kept, final sale recalculated;
 *   sale     → purchase kept, markup recalculated.
 * A dependent value that cannot be worked out becomes '' (missing), never 0.
 * A sale below purchase gives a negative markup; it is shown, never clamped.
 */
export function editPrice(line: PriceLineInput, field: 'purchase' | 'markup' | 'sale', value: string): PriceLineInput {
  const next = { ...line, [field]: value };
  const purchase = rupeesToPaise(next.purchase);
  if (field === 'sale') {
    const sale = rupeesToPaise(value);
    next.markup = typeof purchase === 'string' && typeof sale === 'string' ? paiseToFixedText(BigInt(sale) - BigInt(purchase)) : '';
    return next;
  }
  const markup = rupeesToPaise(next.markup, { signed: true });
  if (typeof purchase === 'string' && typeof markup === 'string') {
    const sale = BigInt(purchase) + BigInt(markup);
    next.sale = sale >= 0n && sale <= PRICE_AMOUNT_MAX_PAISE ? paiseToFixedText(sale) : '';
  } else {
    next.sale = '';
  }
  return next;
}

/** Categories shown: adult always; the two child rows only with children; infant only with infants. */
export function visiblePriceCategories(party: PartyCounts): PriceCategory[] {
  return PRICE_CATEGORIES.filter((c) => c === 'adult' || ((c === 'child_bed' || c === 'child_no_bed') && (party.children ?? 0) > 0) || (c === 'infant' && (party.infants ?? 0) > 0));
}

/**
 * Category quantities follow the party: adult = total − children − infants
 * (read-only), infant = infants (read-only); child rows keep the typed split
 * while there are children, else 0. A row with quantity 0 is cleared (no
 * hidden money in the total).
 */
export function bookingPriceLines(party: PartyCounts, lines: readonly PriceLineInput[]): PriceLineInput[] {
  const byCat = new Map(lines.map((l) => [l.category, l]));
  return PRICE_CATEGORIES.map((category) => {
    const line = byCat.get(category) ?? { category, quantity: '0', purchase: '', markup: '', sale: '' };
    let quantity: string;
    if (category === 'adult') quantity = String(Math.max(0, party.adults ?? 0));
    else if (category === 'infant') quantity = String(party.infants ?? 0);
    else quantity = (party.children ?? 0) > 0 ? line.quantity.trim() || '0' : '0';
    return parseCount(quantity) === 0 ? { category, quantity: '0', purchase: '', markup: '', sale: '' } : { ...line, quantity };
  });
}

export interface PriceTotals {
  /** Σ quantity × sale; null when any line with people is incomplete or invalid. */
  salePaise: string | null;
  purchasePaise: string | null;
  markupPaise: string | null;
  /** Passengers counted over all categories (invalid quantities count 0). */
  people: number;
  /** Lines with people but a missing or invalid amount. */
  incomplete: PriceCategory[];
}

export function priceTotals(lines: readonly PriceLineInput[]): PriceTotals {
  let sale = 0n;
  let purchase = 0n;
  let ok = true;
  let people = 0;
  const incomplete: PriceCategory[] = [];
  for (const line of lines) {
    const q = parseCount(line.quantity);
    if (q === null || q > PAX_TOTAL_MAX) {
      ok = false;
      continue;
    }
    people += q;
    if (q === 0) continue;
    const p = rupeesToPaise(line.purchase);
    const s = rupeesToPaise(line.sale);
    const m = rupeesToPaise(line.markup, { signed: true });
    if (typeof p !== 'string' || typeof s !== 'string' || typeof m !== 'string' || BigInt(p) + BigInt(m) !== BigInt(s)) {
      ok = false;
      incomplete.push(line.category);
      continue;
    }
    sale += BigInt(q) * BigInt(s);
    purchase += BigInt(q) * BigInt(p);
  }
  return ok
    ? { salePaise: sale.toString(), purchasePaise: purchase.toString(), markupPaise: (sale - purchase).toString(), people, incomplete }
    : { salePaise: null, purchasePaise: null, markupPaise: null, people, incomplete };
}

function categoryList(cats: readonly PriceCategory[]): string {
  return cats.map((c) => PRICE_CATEGORY_LABEL[c].toLowerCase()).join(', ');
}

/** Price checks of step 3 (Mercury A.8 words). Draft saves still go through; submit needs none of these. */
export function priceIssues(party: PartyCounts, lines: readonly PriceLineInput[]): FormIssue[] {
  const issues: FormIssue[] = [];
  const add = (code: string, text: string, fieldId: string | null) => issues.push({ code, text, section: 'price', fieldId });
  const qty = (c: PriceCategory) => parseCount(lines.find((l) => l.category === c)?.quantity ?? '0');
  const quantities = PRICE_CATEGORIES.map(qty);
  const sum = quantities.reduce<number>((n, q) => n + (q ?? 0), 0);
  const children = (qty('child_bed') ?? 0) + (qty('child_no_bed') ?? 0);
  if (quantities.some((q) => q === null || q > PAX_TOTAL_MAX) || party.total === null || sum !== party.total || children !== (party.children ?? 0)) {
    add('price_count_mismatch', `Price counts must add up to ${party.total ?? 0} passengers. Split all ${party.children ?? 0} children into with bed or without bed.`, priceFieldId('child_bed', 'quantity'));
  }
  const missing: PriceCategory[] = [];
  const below: PriceCategory[] = [];
  const bad: PriceCategory[] = [];
  for (const line of lines) {
    if (!parseCount(line.quantity)) continue;
    const p = rupeesToPaise(line.purchase);
    const m = rupeesToPaise(line.markup, { signed: true });
    const s = rupeesToPaise(line.sale);
    if (p === undefined || m === undefined || s === undefined) bad.push(line.category);
    else if (p === null || m === null || s === null) missing.push(line.category);
    else if (BigInt(p) + BigInt(m) !== BigInt(s)) bad.push(line.category);
    else if (BigInt(m) < 0n) below.push(line.category);
  }
  const [firstBad] = bad;
  const [firstMissing] = missing;
  const [firstBelow] = below;
  if (firstBad) add('invalid_amount', 'Use rupees, 0 or more, with up to 2 decimals.', priceFieldId(firstBad, 'purchase'));
  if (firstMissing) add('price_missing', `Enter purchase, markup and final sale for: ${categoryList(missing)}.`, firstMissingField(lines, firstMissing));
  if (firstBelow) {
    add('price_below_purchase', `Final sale is below purchase for: ${categoryList(below)}. Change the final sale or the purchase. A sale below purchase cannot be submitted.`, priceFieldId(firstBelow, 'sale'));
  }
  return issues;
}

function firstMissingField(lines: readonly PriceLineInput[], category: PriceCategory): string {
  const l = lines.find((x) => x.category === category);
  if (!l || l.purchase.trim() === '') return priceFieldId(category, 'purchase');
  if (l.markup.trim() === '') return priceFieldId(category, 'markup');
  return priceFieldId(category, 'sale');
}

/** True when the line shows "Final sale is below purchase." (field-level hint). */
export function isBelowPurchase(line: PriceLineInput): boolean {
  const p = rupeesToPaise(line.purchase);
  const s = rupeesToPaise(line.sale);
  return typeof p === 'string' && typeof s === 'string' && BigInt(s) < BigInt(p);
}

/** Typed rows → the stored shape (paise strings; '' → null). undefined = an amount is invalid (do not post). */
export function priceLinesForSave(lines: readonly PriceLineInput[]): PriceLine[] | undefined {
  const out: PriceLine[] = [];
  for (const category of PRICE_CATEGORIES) {
    const l = lines.find((x) => x.category === category) ?? { category, quantity: '0', purchase: '', markup: '', sale: '' };
    const quantity = parseCount(l.quantity);
    const purchasePaise = rupeesToPaise(l.purchase);
    const markupPaise = rupeesToPaise(l.markup, { signed: true });
    const salePaise = rupeesToPaise(l.sale);
    if (quantity === null || quantity > PAX_TOTAL_MAX || purchasePaise === undefined || markupPaise === undefined || salePaise === undefined) return undefined;
    out.push({ category, quantity, purchasePaise, markupPaise, salePaise });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Supplier estimates (cost side only; null = "Not priced", never zero)
// ---------------------------------------------------------------------------

const ESTIMATE_MAX = PRICE_AMOUNT_MAX_PAISE;

/**
 * Hotel = nights × (rooms × room rate + extra beds × extra-bed rate + no-bed
 * guests × no-bed rate). All three rates are nightly. A rate is needed only
 * when its count is above 0. Rooms must be at least 1.
 */
export function hotelEstimatePaise(input: {
  nights: number | string | null;
  rooms: number | string | null;
  extraBeds: number | string | null;
  noBedGuests: number | string | null;
  roomRatePaise: string | null;
  extraBedRatePaise: string | null;
  noBedRatePaise: string | null;
}): string | null {
  const nights = parseCount(input.nights);
  if (nights === null || nights < 1 || nights > 365) return null;
  const rooms = parseCount(input.rooms);
  if (rooms === null || rooms < 1) return null;
  let perNight = 0n;
  for (const [count, rate] of [
    [rooms, input.roomRatePaise],
    [parseCount(input.extraBeds ?? 0), input.extraBedRatePaise],
    [parseCount(input.noBedGuests ?? 0), input.noBedRatePaise],
  ] as const) {
    if (count === null) return null;
    if (count === 0) continue;
    const r = toBig(rate);
    if (r === null || r < 0n || r > ESTIMATE_MAX) return null;
    perNight += BigInt(count) * r;
  }
  return (BigInt(nights) * perNight).toString();
}

/** Car = vehicles × rate per vehicle for the whole trip. */
export function carEstimatePaise(quantity: number | string | null, vehicleRatePaise: string | null): string | null {
  const q = parseCount(quantity);
  const r = toBig(vehicleRatePaise);
  if (q === null || q < 1 || r === null || r < 0n || r > ESTIMATE_MAX) return null;
  return (BigInt(q) * r).toString();
}

/** Flight: the estimated fare total as entered (items saved before Book now v2). */
export function flightEstimatePaise(fareTotalPaise: string | null): string | null {
  const r = toBig(fareTotalPaise);
  return r === null || r < 0n || r > ESTIMATE_MAX ? null : r.toString();
}

// ---------------------------------------------------------------------------
// Book now v2: flight fare per person (cost side only; never the customer price)
// ---------------------------------------------------------------------------

export type FareTravellerType = 'adult' | 'child' | 'infant';
export const FARE_TRAVELLER_TYPES = ['adult', 'child', 'infant'] as const satisfies readonly FareTravellerType[];
export const FARE_TYPE_LABEL: Record<FareTravellerType, string> = { adult: 'Adult', child: 'Child', infant: 'Infant' };

export interface FlightFares {
  fareAdultPaise: string | null;
  fareChildPaise: string | null;
  fareInfantPaise: string | null;
}
const fareOf = (f: FlightFares, t: FareTravellerType): string | null =>
  t === 'adult' ? f.fareAdultPaise : t === 'child' ? f.fareChildPaise : f.fareInfantPaise;

function validFare(paise: string | null | undefined): bigint | null {
  const r = toBig(paise);
  return r === null || r < 0n || r > ESTIMATE_MAX ? null : r;
}

/**
 * One flight's estimate: Σ fare of each traveller type × the travellers of
 * that type on the flight. A type with travellers needs its fare (else null,
 * "Not priced"). A flight without any fare per person falls back to the older
 * total (items saved before Book now v2).
 */
export function flightFareEstimatePaise(input: FlightFares & { fareTotalPaise?: string | null; counts: Record<FareTravellerType, number> }): string | null {
  const anyFare = FARE_TRAVELLER_TYPES.some((t) => fareOf(input, t) !== null);
  if (!anyFare) return flightEstimatePaise(input.fareTotalPaise ?? null);
  let total = 0n;
  let people = 0;
  for (const t of FARE_TRAVELLER_TYPES) {
    const n = input.counts[t];
    if (!Number.isSafeInteger(n) || n < 0) return null;
    if (n === 0) continue;
    const fare = validFare(fareOf(input, t));
    if (fare === null) return null;
    total += BigInt(n) * fare;
    people += n;
  }
  return people === 0 ? null : total.toString();
}

/** "Fare per person: Adult ₹6,000 · Child ₹4,500" (only the types with a fare); null when none is set. */
export function farePerPersonText(f: FlightFares): string | null {
  const parts = FARE_TRAVELLER_TYPES.filter((t) => validFare(fareOf(f, t)) !== null).map((t) => `${FARE_TYPE_LABEL[t]} ${formatInr(fareOf(f, t))}`);
  return parts.length === 0 ? null : `Fare per person: ${parts.join(' · ')}`;
}

/** One flight of the draft for the "Total fare per person, all flights" box. */
export interface FlightFareRow {
  /** "Flight 2" style label (number within the flights). */
  label: string;
  fares: FlightFares;
  /** The travellers on this flight, with their type. */
  travellers: ReadonlyArray<{ seq: number; type: FareTravellerType }>;
}

/**
 * Per traveller type: 'sum' = every flight carrying the type has a fare (added
 * up, read-only); 'typed' = no flight has one and staff typed the total;
 * 'missing' = no flight has one and nothing is typed (staff type it);
 * 'partial' = only some flights have one (names the flights still missing a
 * fare); 'none' = nobody of that type flies (not shown).
 */
export type FlightFareMode = 'sum' | 'typed' | 'missing' | 'partial' | 'none';
export interface FlightFareTypeSummary {
  type: FareTravellerType;
  mode: FlightFareMode;
  /** Travellers of that type on at least one flight. */
  travellers: number;
  /** Per person, all flights (null unless 'sum' or 'typed'). */
  perPersonPaise: string | null;
  /** perPersonPaise × travellers. */
  totalPaise: string | null;
  /** 'partial': labels of the flights carrying this type without a fare. */
  missingFlights: string[];
}
export interface FlightFareSummary {
  types: FlightFareTypeSummary[];
  /** Σ of every shown type's total; null while any shown type has none. */
  allFlightsPaise: string | null;
}

export function flightFareSummary(rows: readonly FlightFareRow[], typed: FlightFareTotals | null | undefined): FlightFareSummary {
  const types = FARE_TRAVELLER_TYPES.map((type): FlightFareTypeSummary => {
    const carrying = rows.filter((r) => r.travellers.some((x) => x.type === type));
    const travellers = new Set(carrying.flatMap((r) => r.travellers.filter((x) => x.type === type).map((x) => x.seq))).size;
    if (travellers === 0) return { type, mode: 'none', travellers: 0, perPersonPaise: null, totalPaise: null, missingFlights: [] };
    const priced = carrying.filter((r) => validFare(fareOf(r.fares, type)) !== null);
    let mode: FlightFareMode;
    let per: bigint | null = null;
    if (priced.length === carrying.length) {
      mode = 'sum';
      per = priced.reduce((acc, r) => acc + (validFare(fareOf(r.fares, type)) ?? 0n), 0n);
    } else if (priced.length === 0) {
      const t = validFare(type === 'adult' ? typed?.adultPaise : type === 'child' ? typed?.childPaise : typed?.infantPaise);
      mode = t === null ? 'missing' : 'typed';
      per = t;
    } else {
      mode = 'partial';
    }
    return {
      type,
      mode,
      travellers,
      perPersonPaise: per === null ? null : per.toString(),
      totalPaise: per === null ? null : (per * BigInt(travellers)).toString(),
      missingFlights: mode === 'partial' ? carrying.filter((r) => validFare(fareOf(r.fares, type)) === null).map((r) => r.label) : [],
    };
  });
  const shown = types.filter((t) => t.mode !== 'none');
  const allFlightsPaise =
    shown.length > 0 && shown.every((t) => t.totalPaise !== null) ? shown.reduce((acc, t) => acc + BigInt(t.totalPaise!), 0n).toString() : null;
  return { types, allFlightsPaise };
}

/** "Adult: flight 2 has no fare yet" (one line per partial type). */
export function flightFareGapText(t: FlightFareTypeSummary): string | null {
  if (t.mode !== 'partial') return null;
  const names = t.missingFlights.map((l) => l.charAt(0).toLowerCase() + l.slice(1));
  return `${FARE_TYPE_LABEL[t.type]}: ${names.join(', ')} ${names.length === 1 ? 'has' : 'have'} no fare yet`;
}

// ---------------------------------------------------------------------------
// Book now v2: requests "for whom" (hotel special requests, flight preferences)
// ---------------------------------------------------------------------------

/** The readable text the database stores: "Wheelchair help (Child C), Vegetarian meal" (same rule as authz.bf2_request_text). */
export function requestItemsText(items: readonly RequestItem[], nameOf: (seq: number) => string | null | undefined): string {
  return items.map((i) => (i.forSeq === null ? i.text : `${i.text}${nameOf(i.forSeq) ? ` (${nameOf(i.forSeq)})` : ''}`)).join(', ');
}

/**
 * The requests of a stored item for the drawer: its requestItems, else the
 * older free text split at ", " into requests for everyone. Null when the
 * older text cannot be shown as requests (over 20 parts, a part over 80
 * characters or a repeated part): the drawer then leaves the requests list
 * unposted so the stored text is kept.
 */
export function requestItemsFromStored(facts: { requestItems?: unknown; text?: unknown }): RequestItem[] | null {
  if (Array.isArray(facts.requestItems)) {
    return facts.requestItems
      .filter((x): x is { text: string; forSeq?: number | null } => typeof x === 'object' && x !== null && typeof (x as { text?: unknown }).text === 'string')
      .map((x) => ({ text: x.text, forSeq: typeof x.forSeq === 'number' ? x.forSeq : null }));
  }
  if (typeof facts.text !== 'string' || facts.text.trim() === '') return [];
  const parts = facts.text.split(/,\s*/).map((p) => p.trim().replace(/\s+/g, ' ')).filter((p) => p !== '');
  const seen = new Set(parts.map((p) => p.toLowerCase()));
  if (parts.length > REQUEST_ITEMS_MAX || seen.size !== parts.length || parts.some((p) => p.length > REQUEST_TEXT_MAX)) return null;
  return parts.map((text) => ({ text, forSeq: null }));
}

// ---------------------------------------------------------------------------
// Hotel night coverage (same rule as readiness)
// ---------------------------------------------------------------------------

export interface StayDates {
  id: string;
  checkIn: string | null;
  /** 1..365; null/invalid = the stay cannot be placed (counted as outside). */
  nights: number | null;
}

/**
 * Every calendar night from start up to (excluding) end must have a hotel.
 * Parallel rows count once; a stay before the start or on/after the end is
 * outside; overlapping stays cannot hide a missing night elsewhere.
 */
export function hotelCoverage(start: string | null, end: string | null, stays: readonly StayDates[]): HotelCoverage {
  const nights = tripNights(start, end);
  const covered = new Set<string>();
  const outside = new Set<string>();
  for (const stay of stays) {
    const n = stay.nights;
    if (!isIsoDate(stay.checkIn) || n === null || !Number.isSafeInteger(n) || n < 1 || n > 365) {
      outside.add(stay.id);
      continue;
    }
    for (let i = 0; i < n; i += 1) {
      const night = addDays(stay.checkIn, i);
      if (nights === null || !start || !end || night < start || night >= end) {
        outside.add(stay.id);
        continue;
      }
      covered.add(night);
    }
  }
  const missing = nights === null || !start ? [] : Array.from({ length: nights }, (_, i) => addDays(start, i)).filter((d) => !covered.has(d));
  return { nights, covered: covered.size, missing, outside: [...outside] };
}

// ---------------------------------------------------------------------------
// Customer, trip and passengers (step 1)
// ---------------------------------------------------------------------------

export const INDIAN_MOBILE = /^[6-9]\d{9}$/;
export const INTERNATIONAL_PHONE = /^\+[1-9]\d{6,14}$/;
export const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Contact mobile as the database stores it: 10 digits starting 6–9 (spaces, dashes and a +91/0 prefix removed). */
export function normaliseMobile(raw: string): string | null | undefined {
  const t = raw.replace(/[\s-]/g, '');
  if (t === '') return null;
  const m = /^(?:\+?91|0)?([6-9]\d{9})$/.exec(t);
  return m ? m[1] : undefined;
}

/** Bill To or passenger phone: Indian mobile or +country number. */
export function normalisePhone(raw: string): string | null | undefined {
  const t = raw.replace(/[\s-]/g, '');
  if (t === '') return null;
  const mobile = normaliseMobile(t);
  if (typeof mobile === 'string') return mobile;
  return INTERNATIONAL_PHONE.test(t) ? t : undefined;
}

export interface CustomerInput {
  contactName: string;
  mobile: string;
  email: string;
  destination: string;
  tripStart: string;
  tripEnd: string;
  paxTotal: string;
  children: string;
  infants: string;
}

export interface PassengerInput {
  name: string;
  type: 'adult' | 'child' | 'infant';
  dateOfBirth?: string;
  dateOfMarriage?: string;
}

/** Step 1 checks (preview conditions 1, 2, 5, 6, 7). */
export function customerIssues(c: CustomerInput, passengers: readonly PassengerInput[]): FormIssue[] {
  const issues: FormIssue[] = [];
  const add = (code: string, text: string, fieldId: string | null, section: BookingFormSection = 'customer') => issues.push({ code, text, section, fieldId });
  const F = BOOKING_FORM_FIELD_ID;
  if (!c.contactName.trim()) add('contact_missing', 'Enter the customer name.', F.contactName);
  const mobile = normaliseMobile(c.mobile);
  if (mobile === undefined) add('mobile_format', 'Enter a 10-digit Indian mobile number.', F.mobile);
  if (c.email.trim() && !EMAIL_SHAPE.test(c.email.trim())) add('email_format', 'Check the email address.', F.email);
  if (mobile === null && !c.email.trim()) add('contact_reach_missing', 'Enter a mobile number or email.', F.mobile);
  if (!c.destination.trim()) add('trip_missing', 'Enter the destination.', F.destination);
  if (!isIsoDate(c.tripStart)) add('trip_missing', 'Choose a valid travel date.', F.tripStart);
  if (c.tripEnd && tripNights(c.tripStart, c.tripEnd) === null) add('trip_end_invalid', 'Return date must be on or after travel date, within 365 nights.', F.tripEnd);
  const p = partyCounts({ total: c.paxTotal, children: c.children || '0', infants: c.infants || '0' });
  if (p.total === null || p.total < 1 || p.total > PAX_TOTAL_MAX) add('pax_missing', `Enter the total number of passengers (1 to ${PAX_TOTAL_MAX}).`, F.paxTotal);
  if (p.children === null || p.infants === null || (p.adults !== null && p.adults < 0)) add('pax_split_invalid', 'Children and infants cannot be more than the total passengers.', F.children);
  if (passengers.some((x) => !x.name.trim())) add('traveller_name_incomplete', 'Name each passenger row, or remove unused rows.', F.passengers, 'passengers');
  if (p.total !== null && passengers.length > p.total) add('pax_types_exceeded', 'More passengers are named than the total allows. Change the total or remove a passenger.', F.paxTotal);
  else if (
    (p.children !== null && passengers.filter((x) => x.type === 'child').length > p.children) ||
    (p.infants !== null && passengers.filter((x) => x.type === 'infant').length > p.infants) ||
    (p.adults !== null && passengers.filter((x) => x.type === 'adult').length > p.adults)
  ) {
    add('pax_types_exceeded', 'More passengers are named than the adult, child and infant counts allow. Change the counts or remove a passenger.', F.paxTotal);
  }
  passengers.forEach((x, i) => {
    const who = x.name.trim() || `passenger ${i + 1}`;
    if (x.dateOfBirth && (!isIsoDate(x.dateOfBirth) || (isIsoDate(c.tripStart) && x.dateOfBirth > c.tripStart))) add('dob_invalid', `Check date of birth for ${who}.`, null, 'passengers');
    if (x.dateOfMarriage && (!isIsoDate(x.dateOfMarriage) || (x.dateOfBirth && x.dateOfMarriage < x.dateOfBirth))) add('dom_invalid', `Check date of marriage for ${who}.`, null, 'passengers');
  });
  return issues;
}

// ---------------------------------------------------------------------------
// Services (step 2). Items use the stored fact shapes; cars are `transfer`.
// ---------------------------------------------------------------------------

export interface ServiceItemFacts {
  id: string;
  serviceType: 'hotel' | 'transfer' | 'flight' | 'activity' | 'visa' | 'passport';
  facts: Record<string, unknown>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Hotel stays of the items as coverage rows (nights from check-in/check-out). */
export function staysOf(items: readonly ServiceItemFacts[]): StayDates[] {
  return items.filter((i) => i.serviceType === 'hotel').map((i) => ({ id: i.id, checkIn: str(i.facts.checkIn) || null, nights: stayNights(str(i.facts.checkIn), str(i.facts.checkOut)) }));
}

/** Step 2 checks (preview conditions 8–15). Visa and passport dates may be outside the trip. */
export function serviceIssues(trip: { start: string | null; end: string | null }, items: readonly ServiceItemFacts[]): FormIssue[] {
  const issues: FormIssue[] = [];
  const add = (code: string, text: string, fieldId: string | null = BOOKING_FORM_FIELD_ID.services, section: BookingFormSection = 'services') => issues.push({ code, text, section, fieldId });
  const start = trip.start ?? '';
  const end = trip.end ?? '';
  const range = isIsoDate(start) && isIsoDate(end) ? `${start} to ${end}` : 'not set';
  if (items.length === 0) add('no_services', 'Add at least one service.');
  const dated = items.some((i) => i.serviceType === 'hotel' || i.serviceType === 'transfer' || i.serviceType === 'flight' || i.serviceType === 'activity');
  if (dated && tripNights(start, end) === null) add('trip_missing', 'Set the travel and return dates, within 365 nights.', BOOKING_FORM_FIELD_ID.tripEnd, 'customer');
  const stays = staysOf(items);
  if (stays.length > 0) {
    const cov = hotelCoverage(trip.start, trip.end, stays);
    if (cov.nights === 0) add('hotel_same_day_trip', 'A same-day trip cannot have an overnight hotel stay. Change the return date or remove the hotel.', BOOKING_FORM_FIELD_ID.tripEnd, 'customer');
    else if (cov.nights !== null) {
      if (cov.outside.length > 0) add('hotel_outside_trip', `Keep each hotel stay within the trip dates (${range}).`);
      if (cov.missing.length > 0) add('hotel_nights_missing', `${cov.covered} of ${cov.nights} trip nights have a hotel. Add a hotel for ${cov.missing.join(', ')}.`);
    }
  }
  const outside = (d: string) => isIsoDate(start) && isIsoDate(end) && (d < start || d > end);
  for (const item of items) {
    const f = item.facts;
    if (item.serviceType === 'transfer') {
      const from = str(f.date);
      const to = str(f.endDate) || from;
      if (!isIsoDate(from) || !isIsoDate(to) || to < from || outside(from) || outside(to)) add('service_dates_outside_trip', `Keep car dates within the trip dates (${range}). Visa and passport dates may be outside them.`);
      const q = f.quantity === undefined || f.quantity === null ? 1 : parseCount(f.quantity as number);
      if (q === null || q < 1 || q > 100) add('car_quantity_invalid', 'Number of vehicles must be 1 to 100.');
    } else if (item.serviceType === 'flight') {
      const segments = Array.isArray(f.segments) ? (f.segments as Array<Record<string, unknown>>) : [];
      for (const s of segments) {
        if (str(s.from).trim().toLowerCase() !== '' && str(s.from).trim().toLowerCase() === str(s.to).trim().toLowerCase()) add('flight_same_place', 'Flight departure and arrival places must differ.');
        const dep = str(s.date);
        const arr = str(s.arrivalDate) || dep;
        // Local departure/arrival clock times are never compared across time zones.
        if (!isIsoDate(dep) || !isIsoDate(arr) || arr < dep || outside(dep) || outside(arr)) add('service_dates_outside_trip', `Keep flight dates within the trip dates (${range}). Visa and passport dates may be outside them.`);
      }
    } else if (item.serviceType === 'activity') {
      const d = str(f.date);
      if (d && (!isIsoDate(d) || outside(d))) add('service_dates_outside_trip', `Keep activity dates within the trip dates (${range}). Visa and passport dates may be outside them.`);
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Bill To (India only this release)
// ---------------------------------------------------------------------------

export interface BillToInput {
  type: BillToType;
  name: string;
  contactPerson: string;
  phone: string;
  email: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  stateCode: string;
  postalCode: string;
  gstStatus: GstStatus | '';
  gstin: string;
  gstReason: string;
}

export function emptyBillTo(type: BillToType = 'personal'): BillToInput {
  return { type, name: '', contactPerson: '', phone: '', email: '', addressLine1: '', addressLine2: '', city: '', stateCode: '', postalCode: '', gstStatus: '', gstin: '', gstReason: '' };
}

export const GST_STATE_CODE = /^(0[1-9]|[12][0-9]|3[0-8]|97)$/;
export const POSTAL_CODE = /^[1-9][0-9]{5}$/;
export const GST_REASON_LIMITS = { min: 10, max: 500 } as const;

/** Basic GSTIN structure only (not a registration, checksum or ownership check). */
export function gstinShape(v: string): boolean {
  return /^(0[1-9]|[12][0-9]|3[0-8]|97)[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v);
}

/** The GSTIN shape and its first two digits matching the chosen state. */
export function gstinMatchesState(gstin: string, stateCode: string): boolean {
  return gstinShape(gstin) && gstin.slice(0, 2) === stateCode;
}

/**
 * Switching Personal ↔ Business keeps phone, email and address; the name,
 * contact person and GST answers start fresh. Clicking the type already
 * chosen changes nothing.
 */
export function switchBillToType(b: BillToInput, type: BillToType): BillToInput {
  if (b.type === type) return b;
  return { ...emptyBillTo(type), phone: b.phone, email: b.email, addressLine1: b.addressLine1, addressLine2: b.addressLine2, city: b.city, stateCode: b.stateCode, postalCode: b.postalCode };
}

/** Bill To checks (preview conditions 23–24; Mercury A.8 words). Field ids from BOOKING_FORM_FIELD_ID. */
export function billToIssues(b: BillToInput): FormIssue[] {
  const issues: FormIssue[] = [];
  const F = BOOKING_FORM_FIELD_ID;
  const add = (code: string, text: string, fieldId: string) => issues.push({ code, text, section: 'billTo', fieldId });
  const business = b.type === 'business';
  if (!b.name.trim()) add('billing_missing', business ? 'Enter the company name.' : 'Enter the Bill To name.', F.billingName);
  if (business && !b.contactPerson.trim()) add('billing_contact_missing', 'Add the contact name at the business.', F.contactPerson);
  const phone = normalisePhone(b.phone);
  if (phone === undefined) add('billing_phone_format', 'Check the billing phone number.', F.billingPhone);
  if (b.email.trim() && !EMAIL_SHAPE.test(b.email.trim())) add('billing_email_format', 'Check the billing email.', F.billingEmail);
  if (phone === null && !b.email.trim()) add('billing_reach_missing', 'Add a billing phone number or email.', F.billingPhone);
  if (!b.addressLine1.trim() || !b.city.trim()) add('billing_missing', 'Add the Bill To details: name, address, city, state and PIN code.', F.addressLine1);
  if (!GST_STATE_CODE.test(b.stateCode)) add('billing_state_missing', 'Choose the state.', F.stateCode);
  if (!POSTAL_CODE.test(b.postalCode.replace(/\s/g, ''))) add('billing_pin_invalid', 'Enter a six-digit PIN code that does not start with 0.', F.postalCode);
  if (business) {
    if (!b.gstStatus) add('gst_status_missing', 'Choose whether the business is GST registered.', F.gstStatus);
    else if (b.gstStatus === 'unregistered') {
      const n = b.gstReason.trim().length;
      if (n < GST_REASON_LIMITS.min || n > GST_REASON_LIMITS.max) add('gst_reason_missing', 'Record why the business has no GSTIN (10 to 500 characters).', F.gstReason);
    } else {
      const g = b.gstin.trim().toUpperCase();
      if (!g) add('gstin_missing', 'This business is GST registered. Add the GSTIN.', F.gstin);
      else if (!gstinMatchesState(g, b.stateCode)) add('gstin_invalid', 'Check the GSTIN. Its first two digits must match the state.', F.gstin);
    }
  }
  return issues;
}

/**
 * The Bill To fields that are posted: GST answers only for a business, the
 * GSTIN only when registered, the reason only when not registered.
 */
export function billToForSave(b: BillToInput): BillToInput {
  const business = b.type === 'business';
  return {
    ...b,
    name: b.name.trim(),
    contactPerson: business ? b.contactPerson.trim() : '',
    phone: b.phone.trim(),
    email: b.email.trim().toLowerCase(),
    postalCode: b.postalCode.replace(/\s/g, ''),
    gstStatus: business ? b.gstStatus : '',
    gstin: business && b.gstStatus === 'registered' ? b.gstin.trim().toUpperCase() : '',
    gstReason: business && b.gstStatus === 'unregistered' ? b.gstReason.trim() : '',
  };
}

// ---------------------------------------------------------------------------
// Local customer list (browser memory only; never uploaded or stored)
// ---------------------------------------------------------------------------

export type CustomerListField = (typeof CUSTOMER_LIST_FIELDS)[number];

export interface CustomerListEntry {
  /** Shown to tell similar names apart; never saved with Bill To. */
  id: string;
  type: BillToType;
  name: string;
  contact: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  state: string;
  pin: string;
  country: string;
  gstin: string;
  gstReason: string;
  gstStatus: GstStatus | '';
}

/** Refusals of a customer list (Mercury A.7 words). The list already open stays unchanged. */
export const CUSTOMER_LIST_TEXT = {
  tooLarge: 'Choose a customer list up to 1 MB.',
  notList: 'Use a customer list with up to 1,000 entries.',
  badRow: 'Each customer needs a unique ID, a name and a type (personal or business).',
  duplicateId: 'Customer IDs must be unique.',
  badField: 'Customer fields must be text, up to 500 characters each.',
  notJson: 'This file is not a customer list. Nothing changed.',
  unchanged: 'The list you had open is unchanged.',
  opened: (n: number) => `${n} customers opened in this tab only. Not uploaded.`,
  noMatch: 'No matching clients. Enter new details below.',
  tooMany: (n: number) => `${n} matches. Type more to narrow the list.`,
  outsideIndia:
    'This client’s address is outside India. Bill To takes Indian addresses only for now: enter an Indian billing address or ask Accounts.',
} as const;

export class CustomerListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomerListError';
  }
}

/** Validates an already-parsed JSON value. Throws CustomerListError (message = staff words). Only allowlisted fields are read. */
export function parseCustomerList(raw: unknown): CustomerListEntry[] {
  if (!Array.isArray(raw) || raw.length > CUSTOMER_LIST_MAX_ROWS) throw new CustomerListError(CUSTOMER_LIST_TEXT.notList);
  const ids = new Set<string>();
  return raw.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new CustomerListError(CUSTOMER_LIST_TEXT.badRow);
    const row = item as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!id || id.length > CUSTOMER_LIST_ID_MAX || !name || (row.type !== 'personal' && row.type !== 'business')) throw new CustomerListError(CUSTOMER_LIST_TEXT.badRow);
    if (ids.has(id)) throw new CustomerListError(CUSTOMER_LIST_TEXT.duplicateId);
    ids.add(id);
    const entry: CustomerListEntry = { id, type: row.type, name: '', contact: '', phone: '', email: '', address: '', city: '', state: '', pin: '', country: '', gstin: '', gstReason: '', gstStatus: '' };
    for (const key of CUSTOMER_LIST_FIELDS) {
      const v = row[key];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'string' || v.length > CUSTOMER_LIST_FIELD_MAX) throw new CustomerListError(CUSTOMER_LIST_TEXT.badField);
      entry[key] = v.trim();
    }
    const registered = entry.type === 'business' && (row.gstRegistered === true || row.gstStatus === 'registered');
    entry.gstStatus = entry.type !== 'business' ? '' : registered ? 'registered' : row.gstStatus === 'unregistered' ? 'unregistered' : '';
    entry.gstin = registered ? entry.gstin.toUpperCase() : '';
    entry.gstReason = entry.gstStatus === 'unregistered' ? entry.gstReason : '';
    return entry;
  });
}

/** Reads a chosen file's text (size checked first, before reading). Throws CustomerListError. */
export function readCustomerListText(text: string, sizeBytes: number): CustomerListEntry[] {
  if (sizeBytes > CUSTOMER_LIST_MAX_BYTES) throw new CustomerListError(CUSTOMER_LIST_TEXT.tooLarge);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CustomerListError(CUSTOMER_LIST_TEXT.notJson);
  }
  return parseCustomerList(json);
}

export interface CustomerSearchResult {
  /** At most CUSTOMER_LIST_MAX_RESULTS rows. */
  matches: CustomerListEntry[];
  /** All matches (to say "n matches. Type more…"). */
  total: number;
}

/** Search by id, name, contact, phone, email or GSTIN (2+ characters, case-insensitive). Never merges rows. */
export function searchCustomerList(list: readonly CustomerListEntry[], query: string): CustomerSearchResult {
  const q = query.trim().toLowerCase();
  if (q.length < CUSTOMER_LIST_MIN_QUERY) return { matches: [], total: 0 };
  const all = list.filter((r) => [r.id, r.name, r.contact, r.phone, r.email, r.gstin].some((v) => v.toLowerCase().includes(q)));
  return { matches: all.slice(0, CUSTOMER_LIST_MAX_RESULTS), total: all.length };
}

/** The GST state code for a typed state (a code like "08" or a name like "Rajasthan"); '' when unknown. */
export function stateCodeOf(state: string, states: ReadonlyArray<{ code: string; name: string }>): string {
  const t = state.trim().toLowerCase();
  if (!t) return '';
  if (GST_STATE_CODE.test(t)) return t;
  return states.find((s) => s.name.toLowerCase() === t)?.code ?? '';
}

/**
 * The Bill To form filled from one selected list entry (editable afterwards;
 * no customer master changes, verification stays with Accounts). `outsideIndia`
 * is true when the entry names another country (Bill To is India-only).
 */
export function billToFromCustomer(entry: CustomerListEntry, states: ReadonlyArray<{ code: string; name: string }>): { billTo: BillToInput; outsideIndia: boolean } {
  const country = entry.country.trim().toLowerCase();
  const outsideIndia = country !== '' && country !== 'india' && country !== 'in';
  const billTo: BillToInput = {
    type: entry.type,
    name: entry.name,
    contactPerson: entry.type === 'business' ? entry.contact : '',
    phone: entry.phone,
    email: entry.email,
    addressLine1: outsideIndia ? '' : entry.address,
    addressLine2: '',
    city: outsideIndia ? '' : entry.city,
    stateCode: outsideIndia ? '' : stateCodeOf(entry.state, states),
    postalCode: outsideIndia ? '' : entry.pin,
    gstStatus: entry.gstStatus,
    gstin: entry.gstin,
    gstReason: entry.gstReason,
  };
  return { billTo, outsideIndia };
}
