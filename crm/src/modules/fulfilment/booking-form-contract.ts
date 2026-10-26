/*
 * Booking form contract (lead freeze, 22 October 2026).
 *
 * The owner-approved booking form (three steps: Customer & passengers,
 * Trip & services, Price & Bill To) replaces the Book now screens. This file
 * freezes the shapes shared by the database commands (Atlas), the loader and
 * actions (Terra) and the screens (Luna). Types and constants only; no zod and
 * no server imports, so client components may import it.
 *
 * Rulings and ownership: docs/implementation/booking-form-2026-10-22/contract.md.
 * Changing a shape here needs the lead.
 */

import type { BookingTrip, BookStepStatus, ServiceType } from './contracts';

// ---------------------------------------------------------------------------
// Steps (address keys unchanged: travellers / stay / finish)
// ---------------------------------------------------------------------------

/** New step labels (owner-approved preview). The address keys stay as today. */
export const BOOKING_FORM_STEP_LABEL = {
  travellers: 'Customer & passengers',
  stay: 'Trip & services',
  finish: 'Price & Bill To',
} as const;

/**
 * Sections of the new form, in page order. A section is the unit that saves.
 * customer   = customer contact, trip dates/destination/scope, party counts (step 1)
 * passengers = passenger rows and their Details drawer (identity, proofs, extras) (step 1)
 * services   = service picker, service cards and editors, hotel night coverage (step 2)
 * price      = per-person package price table (step 3)
 * billTo     = Bill To (step 3)
 * submit     = "Before you submit" group: payment plan, payment reports, acceptance, final review, submit (step 3)
 */
export type BookingFormSection = 'customer' | 'passengers' | 'services' | 'price' | 'billTo' | 'submit';
export const BOOKING_FORM_SECTIONS = ['customer', 'passengers', 'services', 'price', 'billTo', 'submit'] as const satisfies readonly BookingFormSection[];
export const BOOKING_FORM_SECTION_STEP = {
  customer: 'travellers',
  passengers: 'travellers',
  services: 'stay',
  price: 'finish',
  billTo: 'finish',
  submit: 'finish',
} as const satisfies Record<BookingFormSection, 'travellers' | 'stay' | 'finish'>;

// ---------------------------------------------------------------------------
// Party counts (booking_versions.pax_total / children_count / infants_count)
// ---------------------------------------------------------------------------

/** Production limit: named traveller rows are capped at 100 today, so the total is too. */
export const PAX_TOTAL_MAX = 100;

export interface BookingParty {
  /** 1..PAX_TOTAL_MAX; null = not entered. */
  total: number | null;
  /** 0..total; null = not entered. */
  children: number | null;
  /** 0..total; null = not entered. */
  infants: number | null;
}

/** booking_trip_save p_fields keys added (absent = unchanged, so older callers never wipe them). */
export interface TripSavePartyKeys {
  paxTotal?: number | null;
  children?: number | null;
  infants?: number | null;
}

// ---------------------------------------------------------------------------
// Customer labels (booking_version_contacts.customer_type / market)
// Plain labels only: no tax, currency, company or price effect.
// ---------------------------------------------------------------------------

export type CustomerType = 'individual' | 'b2d' | 'corporate' | 'travel_agent';
export const CUSTOMER_TYPES = ['individual', 'b2d', 'corporate', 'travel_agent'] as const satisfies readonly CustomerType[];
export type CustomerMarket = 'india' | 'uae' | 'other';
export const CUSTOMER_MARKETS = ['india', 'uae', 'other'] as const satisfies readonly CustomerMarket[];

// ---------------------------------------------------------------------------
// Passenger extras (traveller_identities: restricted, never in department JSON)
// ---------------------------------------------------------------------------

/** traveller_identity_save p_fields keys added. */
export interface IdentityExtraKeys {
  dateOfMarriage?: string | null; // YYYY-MM-DD, on/after date of birth when both are set
  phone?: string | null; // ^[6-9]\d{9}$ or ^\+[1-9]\d{6,14}$
  email?: string | null;
}

// ---------------------------------------------------------------------------
// Per-person package prices (booking_version_price_lines)
// ---------------------------------------------------------------------------

export type PriceCategory = 'adult' | 'child_bed' | 'child_no_bed' | 'infant';
export const PRICE_CATEGORIES = ['adult', 'child_bed', 'child_no_bed', 'infant'] as const satisfies readonly PriceCategory[];
export const PRICE_CATEGORY_LABEL: Record<PriceCategory, string> = {
  adult: 'Adult',
  child_bed: 'Child with bed',
  child_no_bed: 'Child without bed',
  infant: 'Infant',
};

/**
 * One category line. Amounts are INR paise per person for the whole package,
 * as decimal integer strings (bigint-safe). null = missing (never zero).
 * Stored: purchase and sale; markup is derived (sale - purchase) and may be
 * negative (flagged by readiness `price_below_purchase`, never clamped).
 */
export interface PriceLine {
  category: PriceCategory;
  quantity: number; // 0..PAX_TOTAL_MAX
  purchasePaise: string | null;
  markupPaise: string | null;
  salePaise: string | null;
}

/** booking_prices_save(p_version_id uuid, p_expected_row_version int, p_lines jsonb, p_request_id uuid). */
export interface PricesSaveInput {
  lines: PriceLine[]; // exactly the four categories, each once
}
export interface PricesSaveResult {
  rowVersion: number;
  contentHash: string;
  /** Σ quantity × sale when every line with quantity > 0 is complete and the total > 0; else null (not priced). */
  sellingTotalPaise: string | null;
}

/** Upper bound for one per-person amount (paise), so quantity × amount stays safe. */
export const PRICE_AMOUNT_MAX_PAISE = 99_999_999_999n;

/**
 * Where the selling total of a version comes from.
 * per_person      = derived from price lines (new-form drafts)
 * quotation_total = accepted quotation total (converted drafts; lines optional, a different total needs fresh acceptance)
 * legacy_total    = typed total of a version started before this release (never given invented lines)
 */
export type SellingTotalSource = 'per_person' | 'quotation_total' | 'legacy_total';

export interface PackagePriceView {
  lines: PriceLine[];
  sellingTotalPaise: string | null;
  purchaseTotalPaise: string | null;
  markupTotalPaise: string | null;
  source: SellingTotalSource;
  /** True when per-person lines are required before submit (form_rules 2 and not converted). */
  linesRequired: boolean;
}

// ---------------------------------------------------------------------------
// Supplier estimates (service_item_cost_estimates; cost side only, never sale)
// Visible to commercial readers and to the assignee of that item's department task.
// ---------------------------------------------------------------------------

export interface HotelEstimate {
  kind: 'hotel';
  roomRatePaise: string | null; // per room per night
  extraBedRatePaise: string | null; // per extra bed per night
  noBedRatePaise: string | null; // per no-bed guest per night
}
export interface CarEstimate {
  kind: 'transfer';
  vehicleRatePaise: string | null; // per vehicle, whole trip
}
export interface FlightEstimate {
  kind: 'flight';
  fareTotalPaise: string | null;
}
export type ServiceEstimate = HotelEstimate | CarEstimate | FlightEstimate;

/** Computed estimate: null = unknown ("Not priced"), never zero. */
export interface ServiceEstimateView {
  estimate: ServiceEstimate | null;
  totalPaise: string | null;
}

// ---------------------------------------------------------------------------
// New service fact keys (authz.validate_service_facts allowlist; unrestricted
// facts JSON: never money, never identity)
// ---------------------------------------------------------------------------

/** transfer (shown as "Car"): added keys. */
export interface TransferFactKeys {
  endDate?: string; // >= date
  quantity?: number; // 1..100 vehicles
  includedKms?: number; // >= 0
  vendor?: string; // <= 150
}
/** flight segment: added keys. Local clock times are never compared across time zones. */
export interface FlightSegmentKeys {
  arrivalDate?: string; // >= segment date
  airline?: string; // <= 60
  flightNo?: string; // <= 12
  departTime?: string; // HH:MM
  arriveTime?: string; // HH:MM
}

/**
 * booking_service_save(p_version_id uuid, p_expected_row_version int, p_item_id uuid|null,
 *   p_service_type text, p_facts jsonb, p_purchase_budget_paise bigint|null,
 *   p_estimate jsonb|null, p_participants int[]|null, p_request_id uuid)
 * One transaction: item add/save + estimate + participation (no partial save).
 */
export interface ServiceSaveResult {
  itemId: string;
  itemNo: number;
  rowVersion: number;
  contentHash: string;
}

// ---------------------------------------------------------------------------
// Hotel night coverage (shared rule: client model and authz.booking_issues)
// ---------------------------------------------------------------------------

export interface HotelCoverage {
  /** Tour nights (end - start); null when dates are missing/invalid. */
  nights: number | null;
  covered: number;
  /** YYYY-MM-DD nights from start up to (excluding) end with no hotel. */
  missing: string[];
  /** Service item ids whose stay falls before start or on/after end. */
  outside: string[];
}

// ---------------------------------------------------------------------------
// Flight screenshot (service_item_files, private bucket service-item-files)
// ---------------------------------------------------------------------------

export type ServiceItemFileKind = 'flight_screenshot';
export const SERVICE_ITEM_FILE_MAX_BYTES = 4 * 1024 * 1024;
export const SERVICE_ITEM_FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const;
export const SERVICE_ITEM_FILES_PER_ITEM = 5;

export interface ServiceItemFileView {
  fileId: string;
  kind: ServiceItemFileKind;
  fileName: string;
  sizeLabel: string;
  uploadedAt: string;
  uploadedByYou: boolean;
  /** /app/deals/{dealId}/book/files/{fileId} (authorized, signed redirect). */
  downloadHref: string;
  canRemove: boolean;
  /** The file row's version, posted back on removal (fileRowVersion); absent where removal is never offered. */
  rowVersion?: number;
}

// ---------------------------------------------------------------------------
// Bill To (customer_billing_profiles, added nullable columns; India only this release)
// ---------------------------------------------------------------------------

export type BillToType = 'personal' | 'business';
export type GstStatus = 'registered' | 'unregistered';

/** booking_billing_propose / accounts_billing_save p_fields keys added (same signatures). */
export interface BillToKeys {
  billToType?: BillToType;
  contactPerson?: string | null; // business: required at readiness, 1..120
  phone?: string | null;
  email?: string | null;
  gstStatus?: GstStatus | null; // business: required at readiness; personal: null
  gstReason?: string | null; // unregistered business: 10..500
}

export interface BillToView {
  status: 'none' | 'draft' | 'verified';
  /** Null on a legacy profile: derived from booking_for. */
  type: BillToType;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  stateCode: string;
  postalCode: string;
  country: 'India';
  gstStatus: GstStatus | null;
  gstReason: string | null;
  gstin: string | null;
  verifiedByName: string | null;
  verifiedAt: string | null;
  rowVersion: number | null;
  /** Voice-note batch: the stored customer this billing was copied from (null = typed by hand or older record). */
  partyId?: string | null;
  /** That customer's Accounts check state, when the viewer may read it. */
  partyCheckStatus?: 'not_checked' | 'checked' | 'returned' | null;
}

/**
 * Local customer list (browser memory only; never uploaded, never stored).
 * Only the selected entry's fields are copied into the Bill To form; its id is
 * shown to tell similar names apart and is not persisted.
 */
export const CUSTOMER_LIST_MAX_BYTES = 1024 * 1024;
export const CUSTOMER_LIST_MAX_ROWS = 1000;
export const CUSTOMER_LIST_FIELD_MAX = 500;
export const CUSTOMER_LIST_ID_MAX = 80;
export const CUSTOMER_LIST_MIN_QUERY = 2;
export const CUSTOMER_LIST_MAX_RESULTS = 20;
export const CUSTOMER_LIST_FIELDS = [
  'name', 'contact', 'phone', 'email', 'address', 'city', 'state', 'pin', 'country', 'gstin', 'gstReason',
] as const;

// ---------------------------------------------------------------------------
// New readiness codes (authz.booking_issues, form_rules 2 drafts only;
// confirm rechecks atomically under the version lock)
// ---------------------------------------------------------------------------

export const BOOKING_FORM_ISSUE_CODES = [
  'pax_missing',
  'pax_types_exceeded',
  'price_missing',
  'price_count_mismatch',
  'price_below_purchase',
  'hotel_nights_missing',
  'hotel_outside_trip',
  'hotel_same_day_trip',
  'service_dates_outside_trip',
  'gst_status_missing',
  'gst_reason_missing',
  'billing_contact_missing',
  'billing_reach_missing',
] as const;
export type BookingFormIssueCode = (typeof BOOKING_FORM_ISSUE_CODES)[number];

/** Error code added for booking_commercials_save while per-person lines exist. */
export type BookingFormErrorCode = 'priced_per_person';

// ---------------------------------------------------------------------------
// Prefill (unchanged precedence; switch prefill_auto_fill decides)
// ---------------------------------------------------------------------------

/**
 * 'auto'  = switch on: untouched eligible fields are filled by the database at
 *           start and by one automatic fill-empty run on open (no dirty form);
 *           inline "From Bitrix" markers; no per-field "Use Bitrix value".
 * 'off'   = switch off or unknown: no Bitrix values are copied anywhere, no
 *           buttons; one quiet line says details are entered by hand.
 */
export type BookingFormPrefillMode = 'auto' | 'off';

// ---------------------------------------------------------------------------
// View model consumed by the screens (built by Terra's loader; serializable)
// ---------------------------------------------------------------------------

export interface BookingFormServiceItemView {
  itemId: string;
  itemNo: number;
  serviceType: ServiceType;
  /** Facts as stored (allowlisted keys only). */
  facts: Record<string, unknown>;
  /** One-line card summary (dates, place, quantities). */
  summary: string;
  participants: number[] | null;
  /** Commercial readers and Purchase rules as today; absent otherwise. */
  purchaseBudgetPaise?: string | null;
  /** Absent when the viewer may not read estimates. */
  estimate?: ServiceEstimateView;
  files?: ServiceItemFileView[];
  locked: boolean;
}

export interface BookingFormStatusLine {
  /** e.g. "Draft · version 2" */
  state: string;
  /** e.g. "Owner: Riya Mehta" */
  owner: string | null;
  /** The next step in plain words. */
  next: string | null;
}

/** Fields shared by every step; the loader adds the existing BookNowView blocks it still needs. */
export interface BookingFormCore {
  initialStep: 'travellers' | 'stay' | 'finish';
  statusLine: BookingFormStatusLine;
  party: BookingParty;
  trip: BookingTrip;
  customerType: CustomerType | null;
  market: CustomerMarket | null;
  prefillMode: BookingFormPrefillMode;
  formRules: 1 | 2;
  items: BookingFormServiceItemView[];
  coverage: HotelCoverage | null;
  /** Commercial readers only; absent otherwise (Purchase never receives it). */
  prices?: PackagePriceView;
  billTo: BillToView | null;
  sectionStatus: Record<BookingFormSection, BookStepStatus>;
}
