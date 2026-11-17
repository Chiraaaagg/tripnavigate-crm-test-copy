/**
 * B1.2 Phase F (freeze note part 2 section 5; Nova Phase A sections 5-6):
 * customer-document view DTOs, engine-shaped document inputs and adapter
 * results. Pure types and constants; no I/O.
 *
 * Customer views are ALLOWLISTS: they never carry cost, margin, purchase
 * budget, supplier name or rate, Bitrix ids, internal notes or remarks,
 * payment claims or receipts. Purchase, Flight and the Visa & Passport desk
 * never build or read them. `CUSTOMER_VIEW_FORBIDDEN_KEY` is the runtime
 * guard for that rule (tests walk every view type's sample with it).
 *
 * Money: CRM money is whole paise as a decimal string (bigint-safe); the
 * engine prints integer rupees. Customer amounts must be whole rupees; an
 * amount with paise is refused, never rounded.
 */

import WORDS from './safety-words.json';

export type ServiceKind = 'hotel' | 'transfer' | 'activity' | 'flight' | 'visa' | 'passport';
export type TierKey = 'quoted' | 'upgrade';
export type QuoteCategoryKey = 'flights' | 'hotels' | 'transfers' | 'tours' | 'visas' | 'insurance' | 'other';

/** Paise as a decimal string (whole number). */
export type PaiseString = string;

// ---------------------------------------------------------------------------
// Customer views (built by the documents server code from Atlas quotation_get,
// Mercury authz.quotation_money_customer_json and booking facts; never raw rows)
// ---------------------------------------------------------------------------

export interface DocumentPreparedBy {
  name: string;
  /** Plain role label, e.g. "Travel consultant". */
  role: string;
  /** Staff phone is not stored in the CRM yet: null = placeholder. */
  phone: string | null;
}

export interface DocumentCustomer {
  name: string | null;
  phone: string | null;
}

export interface DocumentStay {
  city: string;
  /** YYYY-MM-DD */
  checkIn: string | null;
  checkOut: string | null;
  /** Null in "preferences" mode or when not yet chosen. */
  hotelName: string | null;
  roomType: string | null;
  mealPlan: string | null;
  rooms: number | null;
  /** Star rating / area line under the property; null = placeholder. */
  note: string | null;
}

export interface DocumentFlightLeg {
  carrier: string | null;
  number: string | null;
  from: string;
  to: string;
  /** HH:MM local, null until the Flight desk confirms. */
  dep: string | null;
  arr: string | null;
}

export interface DocumentFlightGroup {
  label: string;
  /** YYYY-MM-DD */
  date: string;
  legs: DocumentFlightLeg[];
  baggage: string | null;
}

export interface DocumentDay {
  day: number;
  city: string | null;
  title: string;
  text: string;
}

export interface QuotationTierView {
  tierKey: TierKey;
  label: string | null;
  quotedTotalPaise: PaiseString;
  /** adults + children with bed + children without bed (infants not counted). */
  payingTravellers: number;
  /** Mercury: only when showPerPerson and exact; null otherwise. */
  perPersonPaise: PaiseString | null;
  /** True only when the components equal the typed total (breakdown amounts printed). */
  breakdownHasAmounts: boolean;
  breakdown: Array<{ categoryKey: QuoteCategoryKey; descriptions: string[]; amountPaise: PaiseString | null }>;
  /** One line per stay in trip order, for this tier (null = the stays' own hotels). */
  hotels: Array<string | null> | null;
  plan: Array<{
    seq: number;
    label: string;
    amountPaise: PaiseString;
    dueRule: 'on_acceptance' | 'days_before_start' | 'fixed_date';
    dueDays: number | null;
    dueDate: string | null;
  }>;
}

export interface QuotationDocumentView {
  kind: 'quotation';
  /** "TQ-12" */
  reference: string;
  versionNo: number;
  revisionNote: string | null;
  /** YYYY-MM-DD (IST) */
  issueDate: string;
  validUntil: string | null;
  preparedBy: DocumentPreparedBy;
  customer: DocumentCustomer;
  trip: { title: string | null; destination: string | null; start: string | null; end: string | null };
  pax: { adults: number; childrenWithBed: number; childrenNoBed: number; infants: number; basis: string | null };
  /** Service types present on the version (common + quoted tier). */
  serviceTypes: ServiceKind[];
  stays: DocumentStay[];
  flights: DocumentFlightGroup[];
  days: DocumentDay[];
  /** Quoted tier first; the upgrade tier only when it exists. */
  tiers: QuotationTierView[];
  includes: string[];
  excludes: string[];
  terms: string[] | null;
  /** DEC-50: the quotation's branch code (`branches.code`, e.g. JDH); null = unknown (the GSTIN prints a placeholder). */
  branchCode: string | null;
}

export interface ItineraryDocumentView {
  kind: 'itinerary';
  reference: string;
  /** YYYY-MM-DD */
  generatedOn: string;
  destination: string;
  destinationShort: string | null;
  country: string | null;
  category: string | null;
  paxBasis: string | null;
  /** The confirmed facts (after differences were settled). */
  facts: ItineraryFactsDraft;
  /** Optional customer copy; anything missing becomes a visible placeholder. */
  narrative: {
    intro: string[] | null;
    reasons: Array<{ title: string; body: string }> | null;
    weHandle: string[] | null;
    youBring: string[] | null;
  };
  /**
   * PENDING (owner): itinerary with or without prices. Null = without prices
   * (recommended); otherwise the quotation tiers to print.
   */
  prices: QuotationTierView[] | null;
  /** DEC-50: the itinerary document's branch code (`branches.code`); null = unknown (the GSTIN prints a placeholder). */
  branchCode: string | null;
}

// ---------------------------------------------------------------------------
// Itinerary facts draft (manual structured entry; extraction later, B6 only)
// ---------------------------------------------------------------------------

export interface FactsStay {
  city: string;
  nights: number;
  checkIn: string | null;
  checkOut: string | null;
  hotelName: string | null;
  roomType: string | null;
  mealPlan: string | null;
  rooms: number | null;
}

export interface FactsDay {
  n: number;
  date: string | null;
  base: string;
  title: string;
  story: string;
  highlights: string[];
  meals: string | null;
}

export interface FactsTransfer {
  date: string | null;
  from: string;
  to: string;
  mode: string | null;
}

export interface FactsActivity {
  date: string | null;
  city: string | null;
  name: string;
  included: boolean;
}

export interface FactsFlight {
  date: string | null;
  from: string;
  to: string;
  carrier: string | null;
  number: string | null;
}

export interface FactsParty {
  adults: number;
  children: number;
  /** Only when known on both sides; no age bands (DEC-33). */
  childAges: number[] | null;
  infants: number;
}

/** The factual content of an itinerary (no prices, supplier names, rates or internal notes). */
export interface TripFactsSet {
  destination: string | null;
  startDate: string | null;
  endDate: string | null;
  party: FactsParty;
  stays: FactsStay[];
  transfers: FactsTransfer[];
  activities: FactsActivity[];
  flights: FactsFlight[];
  /** null = the basis does not record a package-level list (a booking version); then not compared. */
  inclusions: string[] | null;
  exclusions: string[] | null;
}

/**
 * Optional itinerary copy stored with the facts (Atlas 0500 keys: coverWord
 * ≤60, country ≤80, category ≤60, roomBasis ≤120, introduction ≤2000,
 * reasons ≤6 × ≤200, handledByUs and youBring ≤10 × ≤200; text only).
 * Never a placeholder: empty means the section is not printed.
 */
export interface ItineraryNarrative {
  coverWord: string | null;
  country: string | null;
  category: string | null;
  roomBasis: string | null;
  /** Paragraphs (Atlas stores one text of at most 2000 characters, paragraphs split by blank lines). */
  introduction: string[];
  /** Short lines (Atlas: at most 6, each at most 200 characters). */
  reasons: string[];
  /** At most 10, each at most 200 characters (also youBring). */
  handledByUs: string[];
  youBring: string[];
}

/** Atlas 0500 facts provenance (an 'extracted' origin needs the B6 privacy approval; not built). */
export type FactOrigin = 'manual' | 'quotation' | 'booking';

/**
 * Atlas `itinerary_fact_drafts.facts` (migration 20261120000500), normalised:
 * missing lists read as [], missing values as null. No money keys exist.
 */
export interface ItineraryFactsDraft extends TripFactsSet {
  draftId: string;
  /** The private source file the facts were typed from (Atlas itinerary_source_files). */
  sourceFileId: string | null;
  days: FactsDay[];
  inclusions: string[];
  exclusions: string[];
  /** Optional cover and narrative copy (Atlas facts keys); absent when none is stored. */
  narrative?: ItineraryNarrative;
  /** Field path -> where the value came from. */
  provenance: Record<string, FactOrigin>;
}

/** Atlas itinerary_fact_differences.difference. */
export type FactDifferenceKind = 'missing' | 'different' | 'extra';

/** A factual difference: a field path and a kind only (never the values); see facts-diff.ts for the index convention. */
export interface FactDifference {
  path: string;
  kind: FactDifferenceKind;
}

// ---------------------------------------------------------------------------
// Engine-shaped document inputs (modelled on the owner's engine schemas;
// declared here, not copied). Differences from the engine, all deliberate:
//   * no GST amount: `gstText` is always "GST as applicable" (DEC-34);
//   * one or two tiers (the engine requires exactly two; the CRM template
//     prints one when there is no upgrade);
//   * no statutory block from the engine files: company identity comes only
//     from the approved record ./company-identity.ts (DEC-50), chosen by the
//     view's branch code.
// A string written as "[Label]" is a visible placeholder.
// ---------------------------------------------------------------------------

/** Value or "[placeholder]". */
export type Maybe<T> = T | string;

/**
 * DEC-50: the statutory line printed at the foot of every customer document
 * (from ./company-identity.ts). `gstin` is a placeholder while the branch's
 * GSTIN is not given (Delhi, Ahmedabad) or the branch is unknown, which
 * blocks a final document.
 */
export interface DocumentIdentity {
  legalName: string;
  registeredAddress: string;
  pan: string;
  gstin: Maybe<string>;
  /** GST state of the branch; null when the branch is unknown. */
  gstinState: string | null;
}

export interface QuoteDocumentInput {
  quoteNo: string;
  revision: number;
  revisionNote: string | null;
  date: string;
  validUntil: Maybe<string>;
  preparedBy: { name: string; role: string; phone: Maybe<string> };
  customer: { name: Maybe<string>; phone: Maybe<string> };
  trip: { title: Maybe<string>; nights: number; days: number; cities: string[]; start: Maybe<string>; end: Maybe<string> };
  pax: { adults: number; childWithBed: number; childNoBed: number; infants: number; basis: Maybe<string> };
  covers: Array<{ k: string; in: boolean }>;
  /** Optional, may be a summary (fewer days than the trip); city optional (null = not printed). */
  days: Array<{ n: number; city: string | null; t: string; d: string }>;
  stay: Array<{ city: string; in: Maybe<string>; out: Maybe<string>; nights: number; hotel: Maybe<string>; room: Maybe<string>; plan: Maybe<string>; rooms: Maybe<number>; note: Maybe<string> }>;
  flights: Array<{ label: string; date: string; legs: Array<{ carrier: Maybe<string>; no: Maybe<string>; from: string; to: string; dep: Maybe<string>; arr: Maybe<string> }>; baggage: Maybe<string> }>;
  price: {
    /** Integer rupees, only when exact; otherwise "total for N travellers" is printed (perPerson null). */
    perPerson: number | null;
    paxCount: number;
    total: number;
    totalWords: string;
    gstText: 'GST as applicable';
    notTaxInvoice: 'Quotation — not a tax invoice';
    categories: Array<{ k: string; note: string; amt: number | null }>;
  };
  tiers: Array<{ name: string; label: Maybe<string>; quoted: boolean; hotels: Array<Maybe<string>>; perPerson: number | null; total: number }>;
  payment: Array<{ k: string; amt: number; when: string }>;
  includes: string[];
  excludes: string[];
  terms: string[] | null;
  identity: DocumentIdentity;
}

export interface PackageDocumentInput {
  code: string;
  generated: string;
  destination: string;
  /** Optional cover and narrative copy (Atlas facts keys): null / [] = the template hides it; never a placeholder. */
  destinationShort: string | null;
  country: string | null;
  days: number;
  nights: number;
  category: string | null;
  pickup: Maybe<string>;
  drop: Maybe<string>;
  paxBasis: string | null;
  bases: Array<{ name: string; nights: number }>;
  daysList: Array<{ n: number; base: string; title: string; story: string; highlights: string[]; meal: Maybe<string> | null; stay: Maybe<string> }>;
  hotels: Array<{ city: string; nights: number; hotel: Maybe<string>; room: Maybe<string> }>;
  moves: Array<{ day: Maybe<string>; title: string }>;
  intro: string[];
  reasons: Array<{ title: string; body: string }>;
  weHandle: string[];
  youBring: string[];
  inclusions: string[];
  exclusions: string[];
  /** Null = itinerary without prices (PENDING owner; recommended). */
  tiers: Array<{ name: string; total: number; perPerson: number | null }> | null;
  identity: DocumentIdentity;
}

// ---------------------------------------------------------------------------
// Adapter results
// ---------------------------------------------------------------------------

export type AdapterRefusalCode =
  | 'amount_has_paise'
  | 'amount_invalid'
  | 'unsafe_text'
  | 'forbidden_field'
  | 'tier_missing'
  | 'nights_mismatch'
  | 'days_mismatch'
  | 'dates_invalid';

/** `path` names the place (e.g. "tiers[0].quotedTotalPaise"); `detail` is a code, never customer text. */
export interface AdapterRefusal {
  code: AdapterRefusalCode;
  path: string;
  detail?: string;
}

export type AdapterResult<T> =
  | {
      ok: true;
      input: T;
      /** Placeholder labels in document order; any placeholder blocks sending / issue (preview only). */
      placeholders: string[];
      /** Readiness notes for staff (codes); never printed. */
      internalNotes: string[];
    }
  | { ok: false; refusals: AdapterRefusal[] };

/** Fixed customer-facing wording (DEC-34). */
export const GST_TEXT = 'GST as applicable' as const;
export const NOT_TAX_INVOICE_TEXT = 'Quotation — not a tax invoice' as const;

/**
 * Keys a customer view or document input must never contain (case-insensitive,
 * matched against every key at any depth); word list in ./safety-words.json.
 */
export const CUSTOMER_VIEW_FORBIDDEN_KEY = new RegExp(`(${WORDS.forbidden_key_words.join('|')})`, 'i');
