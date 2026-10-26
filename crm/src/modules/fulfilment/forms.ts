import * as z from 'zod/mini';
import {
  type ActivityServiceFacts,
  B11_FACT_LIMITS,
  BOOKING_FACT_LIMITS,
  FLIGHT_SEGMENT_KEYS,
  FLIGHT_TRIP_TYPES,
  HOTEL_MODES,
  PASSPORT_APPLICATION_TYPES,
  type PassportApplicationType,
  type PassportServiceFacts,
  VISA_FEE_PAID_BY,
  type VisaFeePaidBy,
  type VisaServiceFacts,
  type BookingFacts,
  type EvidenceKind,
  type FlightSegment,
  type FlightServiceFacts,
  type HotelServiceFacts,
  MAX_FLIGHT_SEGMENTS,
  MAX_TRAVELLERS,
  SERVICE_FACT_KEYS,
  SERVICE_FACT_LIMITS,
  SERVICE_TYPES,
  type ServiceFacts,
  type ServiceType,
  TRAVELLER_TYPES,
  type TransferServiceFacts,
  type Traveller,
  type TravellerType,
  WORKFLOW_SETTING_KEYS,
  type WorkflowSettingKey,
  HOTEL_EXTRA_LIMITS,
} from './contracts';

/**
 * Pure parsing of booking form posts. Field names are the API for agent C
 * (documented in README.md). Identity, entity, branch and deal ownership are
 * never read from the form; the database derives them from the session.
 * Amounts are entered in rupees (up to 2 decimals, commas allowed) and
 * converted to integer paise with string arithmetic only (never floats).
 */

export const EVIDENCE_KINDS = [
  'acceptance_message',
  'ticket',
  'bill',
  'payment_proof',
  'other',
] as const satisfies readonly EvidenceKind[];

export function isEvidenceKind(value: string): value is EvidenceKind {
  return (EVIDENCE_KINDS as readonly string[]).includes(value);
}

export const FIELD = {
  dealId: 'dealId',
  versionId: 'versionId',
  rowVersion: 'rowVersion',
  contentHash: 'contentHash',
  evidenceId: 'evidenceId',
  taskId: 'taskId',
  kind: 'kind',
  file: 'file',
  hotelName: 'hotelName',
  city: 'city',
  checkIn: 'checkIn',
  checkOut: 'checkOut',
  rooms: 'rooms',
  roomType: 'roomType',
  mealPlan: 'mealPlan',
  adults: 'adults',
  children: 'children',
  inclusions: 'inclusions',
  specialRequests: 'specialRequests',
  purchaseBudgetRupees: 'purchaseBudgetRupees',
  sellingTotalRupees: 'sellingTotalRupees',
  // B1 (freeze note §5)
  itemId: 'itemId',
  itemNo: 'itemNo',
  serviceType: 'serviceType',
  requestId: 'requestId',
  route: 'route',
  date: 'date',
  vehicleType: 'vehicleType',
  passengers: 'passengers',
  pickupTime: 'pickupTime',
  notes: 'notes',
  name: 'name',
  participants: 'participants',
  time: 'time',
  /** Parallel arrays (formData.getAll): index = segment order. */
  segmentFrom: 'segmentFrom',
  segmentTo: 'segmentTo',
  segmentDate: 'segmentDate',
  preferredTime: 'preferredTime',
  cabin: 'cabin',
  /** Parallel arrays: seq = position + 1 over the non-blank rows. */
  travellerName: 'travellerName',
  travellerType: 'travellerType',
  settingKey: 'settingKey',
  settingValue: 'settingValue',
  reason: 'reason',
  // B1.1 (lead decision 11 October 2026: Luna's form input names, frozen)
  // Customer and billing (booking_customer_save)
  contactName: 'contactName',
  mobile: 'mobile',
  email: 'email',
  /** Checkbox: 'on' when ticked. */
  contactConfirmed: 'contactConfirmed',
  bookingFor: 'bookingFor',
  /** Checkbox: 'on' when ticked. */
  payerDifferent: 'payerDifferent',
  payerName: 'payerName',
  billingRowVersion: 'billingRowVersion',
  billingName: 'billingName',
  addressLine1: 'addressLine1',
  addressLine2: 'addressLine2',
  billingCity: 'billingCity',
  stateCode: 'stateCode',
  postalCode: 'postalCode',
  gstin: 'gstin',
  // Trip and travellers (parallel arrays; seq = position + 1 over kept rows)
  destination: 'destination',
  tripScope: 'tripScope',
  tripStart: 'tripStart',
  tripEnd: 'tripEnd',
  travellerAge: 'travellerAge',
  travellerNeeds: 'travellerNeeds',
  // Identity (traveller_identity_save, one traveller per post)
  seq: 'seq',
  identityRowVersion: 'identityRowVersion',
  dateOfBirth: 'dateOfBirth',
  nationality: 'nationality',
  passportNumber: 'passportNumber',
  passportExpiry: 'passportExpiry',
  // Participation (service_item_travellers_save): repeated traveller seqs
  participantSeq: 'participantSeq',
  // Additive service facts
  mode: 'mode',
  preferences: 'preferences',
  area: 'area',
  /** Repeated (one value per child) or one comma-separated value. */
  childAges: 'childAges',
  exclusions: 'exclusions',
  // B1.2 hotel extras (DEC-33: counts and remarks only; entered at quotation, correctable in the booking)
  extraBeds: 'extraBeds',
  childrenWithoutBed: 'childrenWithoutBed',
  bedRemarks: 'bedRemarks',
  tripType: 'tripType',
  /** Parallel to segmentFrom/segmentTo/segmentDate. */
  segmentFlex: 'segmentFlex',
  flightPreferences: 'flightPreferences',
  assistance: 'assistance',
  pickup: 'pickup',
  drop: 'drop',
  country: 'country',
  purpose: 'purpose',
  travelDate: 'travelDate',
  applyBy: 'applyBy',
  feePaidBy: 'feePaidBy',
  applicationType: 'applicationType',
  officeCity: 'officeCity',
  neededBy: 'neededBy',
  // Selling price (booking_commercials_save); sellingTotalRupees above
  listRupees: 'listRupees',
  discountRupees: 'discountRupees',
  // Payment plan (booking_instalments_save; parallel arrays, seq = position + 1)
  instalmentLabel: 'instalmentLabel',
  instalmentAmountRupees: 'instalmentAmountRupees',
  instalmentDueDate: 'instalmentDueDate',
  // Revision
  baseVersionId: 'baseVersionId',
  changeClass: 'changeClass',
  // Department cost entries
  entryId: 'entryId',
  costKind: 'costKind',
  amountRupees: 'amountRupees',
  paidBy: 'paidBy',
  paymentMode: 'paymentMode',
  paidOn: 'paidOn',
  reference: 'reference',
  /** A stored fee receipt / direct-payment proof of the task (evidence id). */
  receiptEvidenceId: 'receiptEvidenceId',
  // Visa & Passport desk
  applicationId: 'applicationId',
  documentCode: 'documentCode',
  documentStatus: 'documentStatus',
  appointmentAt: 'appointmentAt',
  appointmentPlace: 'appointmentPlace',
  state: 'state',
} as const;

function text(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === 'string' ? value : undefined;
}

/** "1,23,456.5" → "12345650"; "" → null; invalid → undefined. */
export function rupeesToPaise(raw: string | undefined): string | null | undefined {
  const value = (raw ?? '').replace(/[,\s]/g, '').replace(/^₹/, '');
  if (value === '') return null;
  // At most 15 rupee digits: far beyond any booking, and well inside bigint.
  const match = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return undefined;
  const paise = BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  return paise.toString();
}

/** Integer paise string → rupee input value ("12345650" → "123456.50"), for prefilling forms. */
export function paiseToRupeesInput(paise: string | null | undefined): string {
  if (paise == null || !/^\d+$/.test(paise)) return '';
  const value = BigInt(paise);
  return `${(value / 100n).toString()}.${(value % 100n).toString().padStart(2, '0')}`;
}

export const uuidField = z.uuid();

export function readUuid(formData: FormData, name: string): string | null {
  const parsed = uuidField.safeParse(text(formData, name)?.trim());
  return parsed.success ? parsed.data : null;
}

function optionalText(formData: FormData, name: string, max: number): string | null | undefined {
  const value = (text(formData, name) ?? '').trim();
  if (value === '') return null;
  return value.length > max ? undefined : value;
}

function optionalInt(formData: FormData, name: string, min: number, max: number): number | null | undefined {
  const value = (text(formData, name) ?? '').trim();
  if (value === '') return null;
  if (!/^\d{1,4}$/.test(value)) return undefined;
  const n = Number(value);
  return n < min || n > max ? undefined : n;
}

function optionalDate(formData: FormData, name: string): string | null | undefined {
  const value = (text(formData, name) ?? '').trim();
  if (value === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : undefined;
}

export interface SaveDraftForm {
  dealId: string;
  versionId: string;
  expectedRowVersion: number;
  facts: BookingFacts;
  sellingTotalPaise: string | null;
  /** True only when the form carried the selling field (contract §12 A4 M3). */
  sellingTotalProvided: boolean;
}

/**
 * Returns the parsed draft or the list of invalid field names. Empty fields
 * are allowed (a draft may be incomplete); readiness reports what is missing.
 */
export function parseSaveDraftForm(formData: FormData): { ok: true; value: SaveDraftForm } | { ok: false; invalid: string[] } {
  const L = BOOKING_FACT_LIMITS;
  const dealId = readUuid(formData, FIELD.dealId);
  const versionId = readUuid(formData, FIELD.versionId);
  const rowVersionRaw = (text(formData, FIELD.rowVersion) ?? '').trim();
  const expectedRowVersion = /^\d{1,9}$/.test(rowVersionRaw) ? Number(rowVersionRaw) : null;

  const values = {
    hotelName: optionalText(formData, FIELD.hotelName, L.hotelName),
    city: optionalText(formData, FIELD.city, L.city),
    checkIn: optionalDate(formData, FIELD.checkIn),
    checkOut: optionalDate(formData, FIELD.checkOut),
    rooms: optionalInt(formData, FIELD.rooms, L.rooms.min, L.rooms.max),
    roomType: optionalText(formData, FIELD.roomType, L.roomType),
    mealPlan: optionalText(formData, FIELD.mealPlan, L.mealPlan),
    adults: optionalInt(formData, FIELD.adults, L.adults.min, L.adults.max),
    children: optionalInt(formData, FIELD.children, L.children.min, L.children.max),
    inclusions: optionalText(formData, FIELD.inclusions, L.inclusions),
    specialRequests: optionalText(formData, FIELD.specialRequests, L.specialRequests),
    purchaseBudgetPaise: rupeesToPaise(text(formData, FIELD.purchaseBudgetRupees)),
  };
  // The field is rendered only for commercial viewers. Without it the
  // commercial row is left untouched (p_selling_total_provided = false, A4 M3).
  const sellingTotalProvided = formData.has(FIELD.sellingTotalRupees);
  const sellingTotalPaise = sellingTotalProvided
    ? rupeesToPaise(text(formData, FIELD.sellingTotalRupees))
    : null;

  const invalid: string[] = [];
  if (!dealId) invalid.push(FIELD.dealId);
  if (!versionId) invalid.push(FIELD.versionId);
  if (expectedRowVersion === null) invalid.push(FIELD.rowVersion);
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) invalid.push(key === 'purchaseBudgetPaise' ? FIELD.purchaseBudgetRupees : key);
  }
  if (sellingTotalPaise === undefined) invalid.push(FIELD.sellingTotalRupees);
  if (invalid.length > 0) return { ok: false, invalid };

  return {
    ok: true,
    value: {
      dealId: dealId!,
      versionId: versionId!,
      expectedRowVersion: expectedRowVersion!,
      facts: values as BookingFacts,
      sellingTotalPaise: sellingTotalPaise ?? null,
      sellingTotalProvided,
    },
  };
}

export function readEvidenceKind(formData: FormData): EvidenceKind | null {
  const value = (text(formData, FIELD.kind) ?? '').trim();
  return isEvidenceKind(value) ? value : null;
}

export function readContentHash(formData: FormData): string | null {
  const value = (text(formData, FIELD.contentHash) ?? '').trim();
  return /^[0-9a-f]{64}$/.test(value) ? value : null;
}

// ===========================================================================
// B1: service item, traveller and workflow-switch forms (freeze note §5).
// Parsers answer { ok: true, value } or { ok: false, fields } where `fields`
// names the inputs to highlight; the UI keeps what was typed. The database
// validates again (authz.validate_service_facts); this is the mirror.
// ===========================================================================

export type ParsedForm<T> = { ok: true; value: T } | { ok: false; fields: string[] };

export function readRequestId(formData: FormData): string | null {
  return readUuid(formData, FIELD.requestId);
}

export function readRowVersion(formData: FormData): number | null {
  const raw = (text(formData, FIELD.rowVersion) ?? '').trim();
  return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

export function isServiceType(value: string): value is ServiceType {
  return (SERVICE_TYPES as readonly string[]).includes(value);
}

export function isTravellerType(value: string): value is TravellerType {
  return (TRAVELLER_TYPES as readonly string[]).includes(value);
}

const DATE_MIN = '2000-01-01';
const DATE_MAX = '2100-12-31';
const TIME_24 = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const IATA = /^[A-Z]{3}$/;
/** B1.1: flight from/to may be an IATA code or a place name (appendix A §1.2). */
const PLACE = /^[A-Za-z][A-Za-z .'-]{1,59}$/;
function isPlace(value: unknown): value is string {
  return typeof value === 'string' && (IATA.test(value) || PLACE.test(value));
}
function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && value >= DATE_MIN && value <= DATE_MAX;
}

function isText(value: unknown, max: number, min = 1): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max && !CONTROL.test(value);
}

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function isOptional(value: unknown, check: (v: unknown) => boolean): boolean {
  return value === undefined || value === null || check(value);
}

/**
 * Pure mirror of authz.validate_service_facts (contract §8): returns the
 * invalid field keys, empty when valid. Unknown keys are invalid; dates are
 * 2000-01-01..2100-12-31; checkOut > checkIn; flight segment dates are
 * non-decreasing; IATA codes are three upper-case letters; times are HH:MM.
 */
export function validateServiceFacts(type: ServiceType, facts: unknown): string[] {
  if (typeof facts !== 'object' || facts === null || Array.isArray(facts)) return ['facts'];
  const f = facts as Record<string, unknown>;
  const allowed = SERVICE_FACT_KEYS[type];
  const invalid = new Set<string>();
  for (const key of Object.keys(f)) if (!allowed.includes(key)) invalid.add(key);
  const L = SERVICE_FACT_LIMITS;
  const B = BOOKING_FACT_LIMITS;
  const check = (key: string, ok: boolean) => {
    if (!ok) invalid.add(key);
  };
  switch (type) {
    case 'hotel':
      check('mode', isOptional(f.mode, (v) => isOneOf(HOTEL_MODES, v)));
      if (f.mode === 'preferences') {
        check('preferences', isText(f.preferences, B11_FACT_LIMITS.hotelPreferences));
        check('hotelName', isOptional(f.hotelName, (v) => isText(v, B.hotelName)));
      } else {
        check('hotelName', isText(f.hotelName, B.hotelName));
        check('preferences', isOptional(f.preferences, (v) => isText(v, B11_FACT_LIMITS.hotelPreferences)));
      }
      check('area', isOptional(f.area, (v) => isText(v, B11_FACT_LIMITS.area)));
      check('exclusions', isOptional(f.exclusions, (v) => isText(v, B11_FACT_LIMITS.exclusions)));
      if (f.childAges !== undefined && f.childAges !== null) {
        const ages = f.childAges;
        const children = typeof f.children === 'number' ? f.children : 0;
        check('childAges', Array.isArray(ages) && ages.every((a) => isInt(a, 0, 17)) && ages.length === children);
      }
      check('city', isText(f.city, B.city));
      check('checkIn', isIsoDate(f.checkIn));
      check('checkOut', isIsoDate(f.checkOut));
      if (isIsoDate(f.checkIn) && isIsoDate(f.checkOut) && !(f.checkOut > f.checkIn)) invalid.add('checkOut');
      check('rooms', isInt(f.rooms, B.rooms.min, B.rooms.max));
      check('adults', isInt(f.adults, B.adults.min, B.adults.max));
      check('roomType', isOptional(f.roomType, (v) => isText(v, B.roomType)));
      check('mealPlan', isOptional(f.mealPlan, (v) => isText(v, B.mealPlan)));
      check('children', isOptional(f.children, (v) => isInt(v, B.children.min, B.children.max)));
      check('inclusions', isOptional(f.inclusions, (v) => isText(v, B.inclusions)));
      check('specialRequests', isOptional(f.specialRequests, (v) => isText(v, B.specialRequests)));
      // B1.2 (0200, DEC-33)
      check('extraBeds', isOptional(f.extraBeds, (v) => isInt(v, HOTEL_EXTRA_LIMITS.extraBeds.min, HOTEL_EXTRA_LIMITS.extraBeds.max)));
      check('childrenWithoutBed', isOptional(f.childrenWithoutBed, (v) => isInt(v, HOTEL_EXTRA_LIMITS.childrenWithoutBed.min, HOTEL_EXTRA_LIMITS.childrenWithoutBed.max)));
      check('bedRemarks', isOptional(f.bedRemarks, (v) => isText(v, HOTEL_EXTRA_LIMITS.bedRemarks)));
      break;
    case 'transfer':
      check('pickup', isOptional(f.pickup, (v) => isText(v, B11_FACT_LIMITS.pickup)));
      check('drop', isOptional(f.drop, (v) => isText(v, B11_FACT_LIMITS.drop)));
      // B1.1: route may be left out when both pickup and drop are given (the database derives it).
      if (f.route === undefined || f.route === null) check('route', isText(f.pickup, B11_FACT_LIMITS.pickup) && isText(f.drop, B11_FACT_LIMITS.drop));
      else check('route', isText(f.route, L.route));
      check('date', isIsoDate(f.date));
      check('vehicleType', isOptional(f.vehicleType, (v) => isText(v, L.vehicleType)));
      check('passengers', isOptional(f.passengers, (v) => isInt(v, L.passengers.min, L.passengers.max)));
      check('pickupTime', isOptional(f.pickupTime, (v) => typeof v === 'string' && TIME_24.test(v)));
      check('notes', isOptional(f.notes, (v) => isText(v, L.notes)));
      break;
    case 'activity':
      check('name', isText(f.name, L.activityName));
      check('city', isText(f.city, L.city));
      check('date', isIsoDate(f.date));
      check('participants', isInt(f.participants, L.passengers.min, L.passengers.max));
      check('time', isOptional(f.time, (v) => typeof v === 'string' && TIME_24.test(v)));
      check('notes', isOptional(f.notes, (v) => isText(v, L.notes)));
      check('inclusions', isOptional(f.inclusions, (v) => isText(v, B11_FACT_LIMITS.activityInclusions)));
      break;
    case 'flight': {
      const segments = f.segments;
      if (!Array.isArray(segments) || segments.length < L.segments.min || segments.length > MAX_FLIGHT_SEGMENTS) {
        invalid.add('segments');
      } else {
        let previous: string | null = null;
        segments.forEach((segment, i) => {
          const s = (typeof segment === 'object' && segment !== null ? segment : {}) as Record<string, unknown>;
          for (const key of Object.keys(s)) if (!(FLIGHT_SEGMENT_KEYS as readonly string[]).includes(key)) invalid.add(`segments[${i}]`);
          check(`segments[${i}].from`, isPlace(s.from));
          check(`segments[${i}].to`, isPlace(s.to));
          check(`segments[${i}].flex`, isOptional(s.flex, (v) => isText(v, B11_FACT_LIMITS.flex)));
          const dateOk = isIsoDate(s.date);
          check(`segments[${i}].date`, dateOk && (previous === null || (s.date as string) >= previous));
          if (dateOk) previous = s.date as string;
        });
      }
      check('passengers', isInt(f.passengers, L.passengers.min, L.passengers.max));
      check('preferredTime', isOptional(f.preferredTime, (v) => isText(v, L.preferredTime)));
      check('cabin', isOptional(f.cabin, (v) => isText(v, L.cabin)));
      check('notes', isOptional(f.notes, (v) => isText(v, L.notes)));
      check('tripType', isOptional(f.tripType, (v) => isOneOf(FLIGHT_TRIP_TYPES, v)));
      check('preferences', isOptional(f.preferences, (v) => isText(v, B11_FACT_LIMITS.flightPreferences)));
      check('assistance', isOptional(f.assistance, (v) => isText(v, B11_FACT_LIMITS.assistance)));
      break;
    }
    case 'visa':
      check('country', isText(f.country, B11_FACT_LIMITS.visaCountry));
      check('purpose', isText(f.purpose, B11_FACT_LIMITS.visaPurpose));
      check('travelDate', isIsoDate(f.travelDate));
      check('applyBy', isOptional(f.applyBy, isIsoDate));
      if (isIsoDate(f.applyBy) && isIsoDate(f.travelDate) && f.applyBy > f.travelDate) invalid.add('applyBy');
      check('feePaidBy', isOneOf(VISA_FEE_PAID_BY, f.feePaidBy));
      check('notes', isOptional(f.notes, (v) => isText(v, B11_FACT_LIMITS.notes)));
      break;
    case 'passport':
      check('applicationType', isOneOf(PASSPORT_APPLICATION_TYPES, f.applicationType));
      check('officeCity', isText(f.officeCity, B11_FACT_LIMITS.officeCity));
      check('neededBy', isOptional(f.neededBy, isIsoDate));
      check('notes', isOptional(f.notes, (v) => isText(v, B11_FACT_LIMITS.notes)));
      break;
  }
  return [...invalid];
}

/** Form input → typed value. '' → null; malformed → undefined (the field is highlighted). */
function requiredText(formData: FormData, name: string, max: number): string | null | undefined {
  return optionalText(formData, name, max);
}

function requiredInt(formData: FormData, name: string, min: number, max: number): number | null | undefined {
  return optionalInt(formData, name, min, max);
}

function optionalTime(formData: FormData, name: string): string | null | undefined {
  const value = (text(formData, name) ?? '').trim();
  if (value === '') return null;
  return TIME_24.test(value) ? value : undefined;
}

function strings(formData: FormData, name: string): string[] {
  return formData.getAll(name).map((v) => (typeof v === 'string' ? v : ''));
}

/**
 * Builds the facts object for one service type from the form. Required
 * fields left empty are reported as invalid (an item is saved whole; a draft
 * version may still have zero items). The form field names are the keys.
 */
export function factsFromForm(type: ServiceType, formData: FormData): { facts: ServiceFacts['facts']; fields: string[] } {
  const L = SERVICE_FACT_LIMITS;
  const B = BOOKING_FACT_LIMITS;
  const fields: string[] = [];
  const required = <T>(name: string, value: T | null | undefined): T | undefined => {
    if (value === null || value === undefined) {
      fields.push(name);
      return undefined;
    }
    return value;
  };
  const optional = <T>(name: string, value: T | null | undefined): T | null => {
    if (value === undefined) {
      fields.push(name);
      return null;
    }
    return value;
  };

  switch (type) {
    case 'hotel': {
      const modeRaw = (text(formData, FIELD.mode) ?? '').trim();
      const mode = modeRaw === '' ? null : isOneOf(HOTEL_MODES, modeRaw) ? modeRaw : undefined;
      if (mode === undefined) fields.push(FIELD.mode);
      const preferencesMode = mode === 'preferences';
      const preferences = requiredText(formData, FIELD.preferences, B11_FACT_LIMITS.hotelPreferences);
      const childAges = readChildAges(formData);
      if (childAges === undefined) fields.push(FIELD.childAges);
      const b11 = {
        ...(mode ? { mode } : {}),
        ...present('preferences', preferencesMode ? required(FIELD.preferences, preferences) : optional(FIELD.preferences, preferences)),
        ...present('area', optional(FIELD.area, requiredText(formData, FIELD.area, B11_FACT_LIMITS.area))),
        ...(childAges && childAges.length > 0 ? { childAges } : {}),
        ...present('exclusions', optional(FIELD.exclusions, requiredText(formData, FIELD.exclusions, B11_FACT_LIMITS.exclusions))),
        // B1.2: 0 or empty = none (left out); never multiplied into money.
        ...nonZero('extraBeds', optional(FIELD.extraBeds, requiredInt(formData, FIELD.extraBeds, HOTEL_EXTRA_LIMITS.extraBeds.min, HOTEL_EXTRA_LIMITS.extraBeds.max))),
        ...nonZero('childrenWithoutBed', optional(FIELD.childrenWithoutBed, requiredInt(formData, FIELD.childrenWithoutBed, HOTEL_EXTRA_LIMITS.childrenWithoutBed.min, HOTEL_EXTRA_LIMITS.childrenWithoutBed.max))),
        ...present('bedRemarks', optional(FIELD.bedRemarks, requiredText(formData, FIELD.bedRemarks, HOTEL_EXTRA_LIMITS.bedRemarks))),
      };
      const hotelNameRaw = requiredText(formData, FIELD.hotelName, B.hotelName);
      const facts = {
        hotelName: preferencesMode ? optional(FIELD.hotelName, hotelNameRaw) : required(FIELD.hotelName, hotelNameRaw),
        city: required(FIELD.city, requiredText(formData, FIELD.city, B.city)),
        checkIn: required(FIELD.checkIn, optionalDate(formData, FIELD.checkIn)),
        checkOut: required(FIELD.checkOut, optionalDate(formData, FIELD.checkOut)),
        rooms: required(FIELD.rooms, requiredInt(formData, FIELD.rooms, B.rooms.min, B.rooms.max)),
        adults: required(FIELD.adults, requiredInt(formData, FIELD.adults, B.adults.min, B.adults.max)),
        roomType: optional(FIELD.roomType, requiredText(formData, FIELD.roomType, B.roomType)),
        mealPlan: optional(FIELD.mealPlan, requiredText(formData, FIELD.mealPlan, B.mealPlan)),
        children: optional(FIELD.children, requiredInt(formData, FIELD.children, B.children.min, B.children.max)),
        inclusions: optional(FIELD.inclusions, requiredText(formData, FIELD.inclusions, B.inclusions)),
        specialRequests: optional(FIELD.specialRequests, requiredText(formData, FIELD.specialRequests, B.specialRequests)),
        ...b11,
      };
      return { facts: facts as HotelServiceFacts, fields };
    }
    case 'transfer': {
      const pickup = optional(FIELD.pickup, requiredText(formData, FIELD.pickup, B11_FACT_LIMITS.pickup));
      const drop = optional(FIELD.drop, requiredText(formData, FIELD.drop, B11_FACT_LIMITS.drop));
      const routeRaw = requiredText(formData, FIELD.route, L.route);
      // B1.1: the route may be left empty when pickup and drop are both given (the database derives it).
      const route = routeRaw === null && pickup && drop ? undefined : required(FIELD.route, routeRaw);
      const facts = {
        ...(route !== undefined ? { route } : {}),
        date: required(FIELD.date, optionalDate(formData, FIELD.date)),
        vehicleType: optional(FIELD.vehicleType, requiredText(formData, FIELD.vehicleType, L.vehicleType)),
        passengers: optional(FIELD.passengers, requiredInt(formData, FIELD.passengers, L.passengers.min, L.passengers.max)),
        pickupTime: optional(FIELD.pickupTime, optionalTime(formData, FIELD.pickupTime)),
        notes: optional(FIELD.notes, requiredText(formData, FIELD.notes, L.notes)),
        ...present('pickup', pickup),
        ...present('drop', drop),
      };
      return { facts: facts as TransferServiceFacts, fields };
    }
    case 'activity': {
      const facts = {
        name: required(FIELD.name, requiredText(formData, FIELD.name, L.activityName)),
        city: required(FIELD.city, requiredText(formData, FIELD.city, L.city)),
        date: required(FIELD.date, optionalDate(formData, FIELD.date)),
        participants: required(FIELD.participants, requiredInt(formData, FIELD.participants, L.passengers.min, L.passengers.max)),
        time: optional(FIELD.time, optionalTime(formData, FIELD.time)),
        notes: optional(FIELD.notes, requiredText(formData, FIELD.notes, L.notes)),
        ...present('inclusions', optional(FIELD.inclusions, requiredText(formData, FIELD.inclusions, B11_FACT_LIMITS.activityInclusions))),
      };
      return { facts: facts as ActivityServiceFacts, fields };
    }
    case 'flight': {
      const from = strings(formData, FIELD.segmentFrom);
      const to = strings(formData, FIELD.segmentTo);
      const dates = strings(formData, FIELD.segmentDate);
      const flexes = strings(formData, FIELD.segmentFlex);
      const rows = Math.max(from.length, to.length, dates.length);
      const segments: FlightSegment[] = [];
      for (let i = 0; i < rows; i += 1) {
        const f = normalisePlace(from[i] ?? '');
        const t = normalisePlace(to[i] ?? '');
        const d = (dates[i] ?? '').trim();
        const x = (flexes[i] ?? '').trim();
        if (f === '' && t === '' && d === '' && x === '') continue; // a blank row is skipped, not an error
        if (!isPlace(f)) fields.push(`${FIELD.segmentFrom}[${i}]`);
        if (!isPlace(t)) fields.push(`${FIELD.segmentTo}[${i}]`);
        if (!isIsoDate(d)) fields.push(`${FIELD.segmentDate}[${i}]`);
        if (x !== '' && !isText(x, B11_FACT_LIMITS.flex)) fields.push(`${FIELD.segmentFlex}[${i}]`);
        segments.push({ from: f, to: t, date: d, ...(x !== '' ? { flex: x } : {}) });
      }
      const tripRaw = (text(formData, FIELD.tripType) ?? '').trim();
      const tripType = tripRaw === '' ? null : isOneOf(FLIGHT_TRIP_TYPES, tripRaw) ? tripRaw : undefined;
      if (tripType === undefined) fields.push(FIELD.tripType);
      if (segments.length < L.segments.min || segments.length > MAX_FLIGHT_SEGMENTS) fields.push(FIELD.segmentFrom);
      const facts = {
        segments,
        passengers: required(FIELD.passengers, requiredInt(formData, FIELD.passengers, L.passengers.min, L.passengers.max)),
        preferredTime: optional(FIELD.preferredTime, requiredText(formData, FIELD.preferredTime, L.preferredTime)),
        cabin: optional(FIELD.cabin, requiredText(formData, FIELD.cabin, L.cabin)),
        notes: optional(FIELD.notes, requiredText(formData, FIELD.notes, L.notes)),
        ...(tripType ? { tripType } : {}),
        ...present('preferences', optional(FIELD.flightPreferences, requiredText(formData, FIELD.flightPreferences, B11_FACT_LIMITS.flightPreferences))),
        ...present('assistance', optional(FIELD.assistance, requiredText(formData, FIELD.assistance, B11_FACT_LIMITS.assistance))),
      };
      return { facts: facts as FlightServiceFacts, fields };
    }
    case 'visa': {
      const V = B11_FACT_LIMITS;
      const fee = (text(formData, FIELD.feePaidBy) ?? '').trim();
      const facts = {
        country: required(FIELD.country, requiredText(formData, FIELD.country, V.visaCountry)),
        purpose: required(FIELD.purpose, requiredText(formData, FIELD.purpose, V.visaPurpose)),
        travelDate: required(FIELD.travelDate, optionalDate(formData, FIELD.travelDate)),
        applyBy: optional(FIELD.applyBy, optionalDate(formData, FIELD.applyBy)),
        feePaidBy: required(FIELD.feePaidBy, (VISA_FEE_PAID_BY as readonly string[]).includes(fee) ? (fee as VisaFeePaidBy) : fee === '' ? null : undefined),
        notes: optional(FIELD.notes, requiredText(formData, FIELD.notes, L.notes)),
      };
      return { facts: facts as VisaServiceFacts, fields };
    }
    case 'passport': {
      const V = B11_FACT_LIMITS;
      const kind = (text(formData, FIELD.applicationType) ?? '').trim();
      const facts = {
        applicationType: required(
          FIELD.applicationType,
          (PASSPORT_APPLICATION_TYPES as readonly string[]).includes(kind) ? (kind as PassportApplicationType) : kind === '' ? null : undefined,
        ),
        officeCity: required(FIELD.officeCity, requiredText(formData, FIELD.officeCity, V.officeCity)),
        neededBy: optional(FIELD.neededBy, optionalDate(formData, FIELD.neededBy)),
        notes: optional(FIELD.notes, requiredText(formData, FIELD.notes, L.notes)),
      };
      return { facts: facts as PassportServiceFacts, fields };
    }
  }
}

/** Maps a validator key (facts key, "segments[2].date") back to the form field that carries it. */
export function fieldForFactKey(type: ServiceType, key: string): string {
  const segment = /^segments\[(\d+)\](?:\.(from|to|date|flex))?$/.exec(key);
  if (segment) {
    const part =
      segment[2] === 'to' ? FIELD.segmentTo : segment[2] === 'date' ? FIELD.segmentDate : segment[2] === 'flex' ? FIELD.segmentFlex : FIELD.segmentFrom;
    return `${part}[${segment[1]}]`;
  }
  if (key === 'segments') return FIELD.segmentFrom;
  // B1.1: the flight preferences key has its own form name (hotel uses `preferences`).
  if (type === 'flight' && key === 'preferences') return FIELD.flightPreferences;
  return key;
}

/** An optional B1.1 key is sent only when it has a value (B1-style facts stay byte-identical). */
function nonZero<K extends string>(key: K, value: number | null | undefined): Partial<Record<K, number>> {
  return value ? ({ [key]: value } as Record<K, number>) : {};
}

function present<K extends string, V>(key: K, value: V | null | undefined): Partial<Record<K, V>> {
  return value === null || value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** Flight from/to: a 3-letter entry is read as an IATA code (upper-cased); anything else is a place name. */
function normalisePlace(raw: string): string {
  const value = raw.trim().replace(/\s+/g, ' ');
  return /^[A-Za-z]{3}$/.test(value) ? value.toUpperCase() : value;
}

/** Child ages: repeated `childAges` values or one comma-separated value. '' → []; invalid → undefined. */
export function readChildAges(formData: FormData): number[] | undefined {
  const parts = strings(formData, FIELD.childAges)
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter((v) => v !== '');
  const ages: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,2}$/.test(part)) return undefined;
    const n = Number(part);
    if (n > 17) return undefined;
    ages.push(n);
  }
  return ages;
}

export interface ServiceItemForm {
  dealId: string;
  versionId: string;
  expectedRowVersion: number;
  /** null = add (the action then needs requestId); set = save. */
  itemId: string | null;
  serviceType: ServiceType;
  facts: ServiceFacts;
  /** Integer paise as a decimal string; '0' when the budget field was empty. */
  purchaseBudgetPaise: string;
  requestId: string | null;
  /**
   * B1.1: traveller seqs from repeated `participantSeq` inputs; null when the
   * form carried none (participation then stays as it is).
   */
  participantSeqs: number[] | null;
}

/**
 * Parses an add/save post for one service item. `fields` lists every input
 * to highlight (form field names, `segmentFrom[1]` style for flight rows);
 * an on-hold or unknown service type reports `serviceType`.
 */
export function parseServiceItemForm(formData: FormData): ParsedForm<ServiceItemForm> {
  const fields: string[] = [];
  const dealId = readUuid(formData, FIELD.dealId);
  const versionId = readUuid(formData, FIELD.versionId);
  const expectedRowVersion = readRowVersion(formData);
  const itemIdRaw = (text(formData, FIELD.itemId) ?? '').trim();
  const itemId = itemIdRaw === '' ? null : readUuid(formData, FIELD.itemId);
  const requestIdRaw = (text(formData, FIELD.requestId) ?? '').trim();
  const requestId = requestIdRaw === '' ? null : readRequestId(formData);
  const typeRaw = (text(formData, FIELD.serviceType) ?? '').trim();
  const budget = rupeesToPaise(text(formData, FIELD.purchaseBudgetRupees));

  if (!dealId) fields.push(FIELD.dealId);
  if (!versionId) fields.push(FIELD.versionId);
  if (expectedRowVersion === null) fields.push(FIELD.rowVersion);
  if (itemIdRaw !== '' && !itemId) fields.push(FIELD.itemId);
  if (requestIdRaw !== '' && !requestId) fields.push(FIELD.requestId);
  if (budget === undefined) fields.push(FIELD.purchaseBudgetRupees);
  if (!isServiceType(typeRaw)) {
    fields.push(FIELD.serviceType);
    return { ok: false, fields };
  }

  const participantSeqs = formData.has(FIELD.participantSeq) ? readSeqs(formData, FIELD.participantSeq) : null;
  if (participantSeqs === undefined) fields.push(FIELD.participantSeq);

  const built = factsFromForm(typeRaw, formData);
  fields.push(...built.fields);
  if (built.fields.length === 0) {
    for (const key of validateServiceFacts(typeRaw, built.facts)) fields.push(fieldForFactKey(typeRaw, key));
  }
  if (fields.length > 0) return { ok: false, fields: [...new Set(fields)] };

  return {
    ok: true,
    value: {
      dealId: dealId!,
      versionId: versionId!,
      expectedRowVersion: expectedRowVersion!,
      itemId,
      serviceType: typeRaw,
      facts: { type: typeRaw, facts: built.facts } as ServiceFacts,
      purchaseBudgetPaise: budget ?? '0',
      requestId,
      participantSeqs: participantSeqs ?? null,
    },
  };
}

/** Repeated traveller seq inputs (1..MAX_TRAVELLERS, distinct, '' skipped). Invalid → undefined. */
export function readSeqs(formData: FormData, name: string): number[] | undefined {
  const seqs: number[] = [];
  for (const raw of strings(formData, name)) {
    const value = raw.trim();
    if (value === '') continue;
    if (!/^\d{1,3}$/.test(value)) return undefined;
    const n = Number(value);
    if (n < 1 || n > MAX_TRAVELLERS || seqs.includes(n)) return undefined;
    seqs.push(n);
  }
  return seqs.sort((a, b) => a - b);
}

export interface TravellersForm {
  dealId: string;
  expectedRowVersion: number;
  travellers: Traveller[];
}

/**
 * Parses the traveller editor: parallel `travellerName[]` / `travellerType[]`
 * arrays. Rows with neither a name nor a type are skipped; the kept rows get
 * `seq` 1..n in order. A row with only one of the two is invalid. An empty
 * list is allowed (it clears the travellers).
 */
export function parseTravellersForm(formData: FormData): ParsedForm<TravellersForm> {
  const fields: string[] = [];
  const dealId = readUuid(formData, FIELD.dealId);
  const expectedRowVersion = readRowVersion(formData);
  if (!dealId) fields.push(FIELD.dealId);
  if (expectedRowVersion === null) fields.push(FIELD.rowVersion);

  const names = strings(formData, FIELD.travellerName);
  const types = strings(formData, FIELD.travellerType);
  const rows = Math.max(names.length, types.length);
  const travellers: Traveller[] = [];
  for (let i = 0; i < rows; i += 1) {
    const name = (names[i] ?? '').trim().replace(/\s+/g, ' ');
    const type = (types[i] ?? '').trim();
    if (name === '' && type === '') continue;
    const nameOk = isText(name, 120);
    const typeOk = isTravellerType(type);
    if (!nameOk) fields.push(`${FIELD.travellerName}[${i}]`);
    if (!typeOk) fields.push(`${FIELD.travellerType}[${i}]`);
    if (nameOk && typeOk) travellers.push({ fullName: name, type, seq: travellers.length + 1 });
  }
  if (travellers.length > MAX_TRAVELLERS) fields.push(FIELD.travellerName);
  if (fields.length > 0) return { ok: false, fields };
  return { ok: true, value: { dealId: dealId!, expectedRowVersion: expectedRowVersion!, travellers } };
}

export interface WorkflowSettingForm {
  key: WorkflowSettingKey;
  value: boolean;
  reason: string;
}

export const WORKFLOW_REASON_LIMITS = { min: 10, max: 500 } as const;

export function isWorkflowSettingKey(value: string): value is WorkflowSettingKey {
  return (WORKFLOW_SETTING_KEYS as readonly string[]).includes(value);
}

/** `settingKey`, `settingValue` ('on' | 'off') and a 10–500 character reason. */
export function parseWorkflowSettingForm(formData: FormData): ParsedForm<WorkflowSettingForm> {
  const fields: string[] = [];
  const key = (text(formData, FIELD.settingKey) ?? '').trim();
  const value = (text(formData, FIELD.settingValue) ?? '').trim();
  const reason = (text(formData, FIELD.reason) ?? '').trim().replace(/\s+/g, ' ');
  if (!isWorkflowSettingKey(key)) fields.push(FIELD.settingKey);
  if (value !== 'on' && value !== 'off') fields.push(FIELD.settingValue);
  if (!isText(reason, WORKFLOW_REASON_LIMITS.max, WORKFLOW_REASON_LIMITS.min)) fields.push(FIELD.reason);
  if (fields.length > 0 || !isWorkflowSettingKey(key)) return { ok: false, fields };
  return { ok: true, value: { key, value: value === 'on', reason } };
}

/** Low-level readers shared with the B1.1 parsers (b11-forms.ts). Pure; no I/O. */
export const formReaders = { text, optionalText, optionalInt, optionalDate, strings, isText, isIsoDate } as const;
