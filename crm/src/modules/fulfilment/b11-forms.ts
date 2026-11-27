import {
  BOOKING_FOR,
  type BookingContactFields,
  type BookingFor,
  type BillingProposalFields,
  type BookingTripFields,
  CHANGE_CLASSES,
  type ChangeClass,
  CONTACT_LIMITS,
  COST_KINDS,
  COST_PAID_BY,
  COST_PAYMENT_MODES,
  type CostKind,
  type CostPaidBy,
  type CostPaymentMode,
  DEPARTMENT_EVIDENCE_KINDS,
  type DepartmentCostFields,
  type DepartmentEvidenceKind,
  INSTALMENT_LABEL_MAX,
  MAX_INSTALMENTS,
  MAX_TRAVELLERS,
  type PlanInstalment,
  TRAVELLER_LIMITS,
  type TravellerDetails,
  type TravellerIdentityFields,
  TRIP_LIMITS,
  TRIP_SCOPES,
  type TripScope,
  VISA_APPLICATION_LIMITS,
  VISA_DOCUMENT_LIMITS,
  VISA_DOCUMENT_STATUSES,
  VISA_STATE_COMMANDS,
  type VisaDocumentStatus,
  type VisaStateCommand,
  BOOKING_PREFILL_FIELDS,
  type PrefillFieldCode,
  type PrefillTargetKind,
  PREFILL_TARGET_KINDS,
  QUOTATION_PREFILL_FIELDS,
  B12_SWITCH_KEYS,
  B12_SWITCH_LIMITS,
  type B12SwitchKey,
} from './contracts';
import type { IdentityExtraKeys } from './booking-form-contract';
import type { PrefillDismissForm, PrefillFillEmptyForm } from './prefill-contract';
import { FIELD, formReaders, isTravellerType, type ParsedForm, readContentHash, readRowVersion, readSeqs, readUuid, rupeesToPaise } from './forms';

/**
 * B1.1 form parsers (pure). Field names are the frozen FIELD values (lead
 * decision of 11 October 2026, Luna's names). Each parser answers
 * { ok: true, value } or { ok: false, fields } naming the inputs to
 * highlight; the UI keeps what was typed. The database validates again and
 * decides; these mirrors only stop obviously malformed posts early. Actor,
 * entity, branch and ownership are never read from a form.
 */

const { text, optionalText, optionalDate, strings, isText, isIsoDate } = formReaders;

/** Same patterns as the Accounts billing form (finance/forms.ts) and accounts_billing_save. */
export const STATE_CODE_PATTERN = /^(0[1-9]|[12][0-9]|3[0-8]|97)$/;
export const POSTAL_CODE_PATTERN = /^[1-9][0-9]{5}$/;
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

function value(formData: FormData, name: string): string {
  return (text(formData, name) ?? '').trim();
}

function checkbox(formData: FormData, name: string): boolean {
  const v = value(formData, name);
  return v === 'on' || v === 'true' || v === '1';
}

function oneOf<T extends string>(values: readonly T[], raw: string): T | null | undefined {
  if (raw === '') return null;
  return (values as readonly string[]).includes(raw) ? (raw as T) : undefined;
}

function singleLine(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** Indian mobile: spaces and dashes removed, an optional +91 / 91 / 0 prefix dropped. '' → null; invalid → undefined. */
export function normaliseIndianMobile(raw: string): string | null | undefined {
  const digits = raw.replace(/[\s-]/g, '');
  if (digits === '') return null;
  const local = digits.replace(/^(\+91|91(?=\d{10}$)|0(?=\d{10}$))/, '');
  return CONTACT_LIMITS.mobilePattern.test(local) ? local : undefined;
}

function common(formData: FormData, fields: string[], opts: { version?: boolean; row?: boolean; request?: boolean } = {}) {
  const dealId = readUuid(formData, FIELD.dealId);
  if (!dealId) fields.push(FIELD.dealId);
  const versionId = opts.version === false ? null : readUuid(formData, FIELD.versionId);
  if (opts.version !== false && !versionId) fields.push(FIELD.versionId);
  const expectedRowVersion = opts.row === false ? null : readRowVersion(formData);
  if (opts.row !== false && expectedRowVersion === null) fields.push(FIELD.rowVersion);
  const requestId = opts.request ? readUuid(formData, FIELD.requestId) : null;
  if (opts.request && !requestId) fields.push(FIELD.requestId);
  return { dealId, versionId, expectedRowVersion, requestId };
}

function readNonNegativeInt(formData: FormData, name: string): number | null {
  const raw = value(formData, name);
  return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

// ---------------------------------------------------------------------------
// Step 1: customer and billing (booking_customer_save)
// ---------------------------------------------------------------------------

export interface BookCustomerForm {
  dealId: string;
  versionId: string;
  expectedRowVersion: number;
  requestId: string;
  contact: BookingContactFields;
  /** null = no billing inputs posted, or all left empty (nothing proposed). */
  billing: BillingProposalFields | null;
  billingExpectedRowVersion: number;
}

export function parseBookCustomerForm(formData: FormData): ParsedForm<BookCustomerForm> {
  const fields: string[] = [];
  const { dealId, versionId, expectedRowVersion, requestId } = common(formData, fields, { request: true });

  const contactName = singleLine(value(formData, FIELD.contactName));
  if (!isText(contactName, CONTACT_LIMITS.contactName)) fields.push(FIELD.contactName);
  const mobile = normaliseIndianMobile(value(formData, FIELD.mobile));
  if (mobile === undefined) fields.push(FIELD.mobile);
  const emailRaw = value(formData, FIELD.email).toLowerCase();
  const email = emailRaw === '' ? null : emailRaw.length <= CONTACT_LIMITS.email && CONTACT_LIMITS.emailPattern.test(emailRaw) ? emailRaw : undefined;
  if (email === undefined) fields.push(FIELD.email);
  // The database requires a mobile number or an email on every contact row.
  if (mobile === null && email === null) fields.push(FIELD.mobile, FIELD.email);
  const bookingFor = oneOf<BookingFor>(BOOKING_FOR, value(formData, FIELD.bookingFor));
  if (!bookingFor) fields.push(FIELD.bookingFor);
  const payerDifferent = checkbox(formData, FIELD.payerDifferent);
  const payerName = singleLine(value(formData, FIELD.payerName));
  if (payerDifferent && !isText(payerName, CONTACT_LIMITS.payerName)) fields.push(FIELD.payerName);

  // Billing: posted only while Sales may propose (absent or draft profile).
  const billingKeys = [FIELD.billingName, FIELD.addressLine1, FIELD.addressLine2, FIELD.billingCity, FIELD.stateCode, FIELD.postalCode, FIELD.gstin];
  const posted = billingKeys.some((k) => formData.has(k));
  const allEmpty = billingKeys.every((k) => value(formData, k) === '');
  let billing: BillingProposalFields | null = null;
  const billingExpectedRowVersion = readNonNegativeInt(formData, FIELD.billingRowVersion);
  if (posted && !allEmpty) {
    const billingName = singleLine(value(formData, FIELD.billingName));
    const addressLine1 = singleLine(value(formData, FIELD.addressLine1));
    const addressLine2 = singleLine(value(formData, FIELD.addressLine2));
    const city = singleLine(value(formData, FIELD.billingCity));
    const stateCode = value(formData, FIELD.stateCode);
    const postalCode = value(formData, FIELD.postalCode).replace(/\s/g, '');
    const gstin = value(formData, FIELD.gstin).toUpperCase();
    if (!isText(billingName, 200)) fields.push(FIELD.billingName);
    if (!isText(addressLine1, 200)) fields.push(FIELD.addressLine1);
    if (addressLine2 !== '' && !isText(addressLine2, 200)) fields.push(FIELD.addressLine2);
    if (!isText(city, 120)) fields.push(FIELD.billingCity);
    if (!STATE_CODE_PATTERN.test(stateCode)) fields.push(FIELD.stateCode);
    if (!POSTAL_CODE_PATTERN.test(postalCode)) fields.push(FIELD.postalCode);
    if (gstin !== '' && (!GSTIN_PATTERN.test(gstin) || gstin.slice(0, 2) !== stateCode)) fields.push(FIELD.gstin);
    if (billingExpectedRowVersion === null) fields.push(FIELD.billingRowVersion);
    billing = { billingName, addressLine1, addressLine2: addressLine2 === '' ? null : addressLine2, city, stateCode, postalCode, gstin: gstin === '' ? null : gstin };
  }

  if (fields.length > 0) return { ok: false, fields: [...new Set(fields)] };
  return {
    ok: true,
    value: {
      dealId: dealId!,
      versionId: versionId!,
      expectedRowVersion: expectedRowVersion!,
      requestId: requestId!,
      contact: {
        contactName,
        mobile: mobile ?? null,
        email: email ?? null,
        contactConfirmed: checkbox(formData, FIELD.contactConfirmed),
        bookingFor: bookingFor!,
        payerDifferent,
        payerName: payerDifferent ? payerName : null,
      },
      billing,
      billingExpectedRowVersion: billingExpectedRowVersion ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// B1.2 step 1 · passengers (deal_travellers_save) and step 2 · destinations
// and dates (booking_trip_save). The B1.1 combined trip form is the
// composition of the two (kept for one release; no screen posts it).
// ---------------------------------------------------------------------------

export interface BookTravellersForm {
  dealId: string;
  versionId: string;
  expectedRowVersion: number;
  travellers: TravellerDetails[];
}

export interface BookTripBlockForm {
  dealId: string;
  versionId: string;
  expectedRowVersion: number;
  /** booking_trip_save replaces all four keys on every call: the form always posts all four. */
  trip: BookingTripFields;
}

function readTripBlock(formData: FormData, fields: string[]): BookingTripFields {
  const destination = optionalText(formData, FIELD.destination, TRIP_LIMITS.destination);
  if (destination === undefined) fields.push(FIELD.destination);
  const scope = oneOf<TripScope>(TRIP_SCOPES, value(formData, FIELD.tripScope));
  if (scope === undefined) fields.push(FIELD.tripScope);
  const start = optionalDate(formData, FIELD.tripStart);
  if (start === undefined || (start && !isIsoDate(start))) fields.push(FIELD.tripStart);
  const end = optionalDate(formData, FIELD.tripEnd);
  if (end === undefined || (end && !isIsoDate(end))) fields.push(FIELD.tripEnd);
  if (start && end && end < start) fields.push(FIELD.tripEnd);
  // Booking form (Echo H1): a trip is at most 365 nights (same rule and hint as booking_trip_save).
  else if (start && end && isIsoDate(start) && isIsoDate(end) && (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000 > 365) fields.push(FIELD.tripEnd);
  return { destination: destination ?? null, scope: scope ?? null, start: start ?? null, end: end ?? null };
}

/**
 * Hidden per-row input: the traveller's own seq as loaded (empty for a new
 * row). Atlas 0100 binds identity proofs to the traveller row; sending each
 * existing traveller's own seq keeps proofs, identity details and
 * participation with the right person when a row above is removed.
 */
export const TRAVELLER_SEQ_FIELD = 'travellerSeq';
/**
 * Hidden single input: the highest traveller seq the form was loaded with.
 * New rows are numbered above it, so a person added in the same save that
 * removes the last traveller never takes over the removed person's row (and
 * with it their identity details and participation).
 */
export const TRAVELLER_SEQ_MAX_FIELD = 'travellerSeqMax';

/**
 * Traveller rows (parallel arrays). An existing row keeps the seq it was
 * loaded with (TRAVELLER_SEQ_FIELD); a new row gets the next seq above both
 * the highest one posted and the highest one loaded (TRAVELLER_SEQ_MAX_FIELD).
 * A post without seqs (B1.1 screens) numbers rows by position as before. B1.1 rules otherwise unchanged (DEC-33: no age bands
 * are added): an age is read only for a child or infant row and, when given,
 * must be 0–17.
 */
function readTravellers(formData: FormData, fields: string[]): TravellerDetails[] {
  const names = strings(formData, FIELD.travellerName);
  const types = strings(formData, FIELD.travellerType);
  const ages = strings(formData, FIELD.travellerAge);
  const needs = strings(formData, FIELD.travellerNeeds);
  const seqs = strings(formData, TRAVELLER_SEQ_FIELD);
  const rows = Math.max(names.length, types.length, ages.length, needs.length);
  const kept: Array<{ row: Omit<TravellerDetails, 'seq'>; seq: number | null }> = [];
  const used = new Set<number>();
  for (let i = 0; i < rows; i += 1) {
    const name = singleLine(names[i] ?? '');
    const type = (types[i] ?? '').trim();
    const ageRaw = (ages[i] ?? '').trim();
    const need = (needs[i] ?? '').trim();
    if (name === '' && type === '' && ageRaw === '' && need === '') continue;
    const nameOk = isText(name, TRAVELLER_LIMITS.fullName);
    const typeOk = isTravellerType(type);
    if (!nameOk) fields.push(`${FIELD.travellerName}[${i}]`);
    if (!typeOk) fields.push(`${FIELD.travellerType}[${i}]`);
    let ageYears: number | null = null;
    // Age is asked for children and infants only; an adult row ignores it.
    if (ageRaw !== '' && type !== 'adult') {
      const n = /^\d{1,2}$/.test(ageRaw) ? Number(ageRaw) : -1;
      if (n < TRAVELLER_LIMITS.age.min || n > TRAVELLER_LIMITS.age.max) fields.push(`${FIELD.travellerAge}[${i}]`);
      else ageYears = n;
    }
    if (need !== '' && !isText(need, TRAVELLER_LIMITS.specialNeeds)) fields.push(`${FIELD.travellerNeeds}[${i}]`);
    const seqRaw = (seqs[i] ?? '').trim();
    let seq: number | null = null;
    if (seqRaw !== '') {
      const n = /^[1-9][0-9]{0,2}$/.test(seqRaw) ? Number(seqRaw) : 0;
      if (n < 1 || n > MAX_TRAVELLERS || used.has(n)) fields.push(`${TRAVELLER_SEQ_FIELD}[${i}]`);
      else {
        seq = n;
        used.add(n);
      }
    }
    if (nameOk && typeOk) kept.push({ row: { fullName: name, type, ageYears, specialNeeds: need === '' ? null : need }, seq });
  }
  const maxRaw = value(formData, TRAVELLER_SEQ_MAX_FIELD);
  let loadedMax = 0;
  if (maxRaw !== '') {
    if (/^(0|[1-9][0-9]{0,2})$/.test(maxRaw) && Number(maxRaw) <= MAX_TRAVELLERS) loadedMax = Number(maxRaw);
    else fields.push(TRAVELLER_SEQ_MAX_FIELD);
  }
  let next = Math.max(loadedMax, ...used) + 1;
  const travellers: TravellerDetails[] = kept.map(({ row, seq }) => {
    if (seq !== null) return { ...row, seq };
    const assigned = next;
    next += 1;
    return { ...row, seq: assigned };
  });
  if (travellers.length > MAX_TRAVELLERS || travellers.some((t) => t.seq > MAX_TRAVELLERS)) fields.push(FIELD.travellerName);
  return travellers;
}

export function parseBookTravellersForm(formData: FormData): ParsedForm<BookTravellersForm> {
  const fields: string[] = [];
  const { dealId, versionId, expectedRowVersion } = common(formData, fields);
  const travellers = readTravellers(formData, fields);
  if (fields.length > 0) return { ok: false, fields: [...new Set(fields)] };
  return { ok: true, value: { dealId: dealId!, versionId: versionId!, expectedRowVersion: expectedRowVersion!, travellers } };
}

export function parseBookTripBlockForm(formData: FormData): ParsedForm<BookTripBlockForm> {
  const fields: string[] = [];
  const { dealId, versionId, expectedRowVersion } = common(formData, fields);
  const trip = readTripBlock(formData, fields);
  if (fields.length > 0) return { ok: false, fields: [...new Set(fields)] };
  return { ok: true, value: { dealId: dealId!, versionId: versionId!, expectedRowVersion: expectedRowVersion!, trip } };
}

/** B1.1 step 2 (trip block and travellers in one post). Kept for one release; no B1.2 screen posts it. */
export interface BookTripForm {
  dealId: string;
  versionId: string;
  expectedRowVersion: number;
  trip: BookingTripFields;
  travellers: TravellerDetails[];
}

export function parseBookTripForm(formData: FormData): ParsedForm<BookTripForm> {
  const fields: string[] = [];
  const { dealId, versionId, expectedRowVersion } = common(formData, fields);
  const trip = readTripBlock(formData, fields);
  const travellers = readTravellers(formData, fields);
  if (fields.length > 0) return { ok: false, fields: [...new Set(fields)] };
  return { ok: true, value: { dealId: dealId!, versionId: versionId!, expectedRowVersion: expectedRowVersion!, trip, travellers } };
}

// ---------------------------------------------------------------------------
// Identity of one traveller (traveller_identity_save)
// ---------------------------------------------------------------------------

export interface TravellerIdentityForm {
  dealId: string;
  seq: number;
  /** Identity row version; 0 when no row exists yet. */
  expectedRowVersion: number;
  fields: TravellerIdentityFields & IdentityExtraKeys;
}

/** Booking form passenger extras in the Details drawer (absent from the post = unchanged). */
export const IDENTITY_EXTRA_FIELD = { dateOfMarriage: 'dateOfMarriage', phone: 'passengerPhone', email: 'passengerEmail' } as const;

function readIdentityExtras(formData: FormData, fields: string[], dateOfBirth: string | null | undefined, today: string): IdentityExtraKeys {
  const out: IdentityExtraKeys = {};
  if (formData.has(IDENTITY_EXTRA_FIELD.dateOfMarriage)) {
    const dom = optionalDate(formData, IDENTITY_EXTRA_FIELD.dateOfMarriage);
    if (dom === undefined || (dom && (!isIsoDate(dom) || dom > today || (dateOfBirth && dom < dateOfBirth)))) fields.push(IDENTITY_EXTRA_FIELD.dateOfMarriage);
    else out.dateOfMarriage = dom ?? null;
  }
  if (formData.has(IDENTITY_EXTRA_FIELD.phone)) {
    const raw = value(formData, IDENTITY_EXTRA_FIELD.phone).replace(/[\s()-]/g, '');
    const mobile = normaliseIndianMobile(raw);
    const phone = raw === '' ? null : typeof mobile === 'string' ? mobile : /^\+[1-9]\d{6,14}$/.test(raw) ? raw : undefined;
    if (phone === undefined) fields.push(IDENTITY_EXTRA_FIELD.phone);
    else out.phone = phone;
  }
  if (formData.has(IDENTITY_EXTRA_FIELD.email)) {
    const raw = value(formData, IDENTITY_EXTRA_FIELD.email).toLowerCase();
    const email = raw === '' ? null : raw.length <= CONTACT_LIMITS.email && CONTACT_LIMITS.emailPattern.test(raw) ? raw : undefined;
    if (email === undefined) fields.push(IDENTITY_EXTRA_FIELD.email);
    else out.email = email;
  }
  return out;
}

export function parseTravellerIdentityForm(formData: FormData, today: string = new Date().toISOString().slice(0, 10)): ParsedForm<TravellerIdentityForm> {
  const fields: string[] = [];
  const { dealId } = common(formData, fields, { version: false, row: false });
  const seqRaw = value(formData, FIELD.seq);
  const seq = /^\d{1,3}$/.test(seqRaw) && Number(seqRaw) >= 1 && Number(seqRaw) <= MAX_TRAVELLERS ? Number(seqRaw) : null;
  if (seq === null) fields.push(FIELD.seq);
  const expectedRowVersion = readNonNegativeInt(formData, FIELD.identityRowVersion);
  if (expectedRowVersion === null) fields.push(FIELD.identityRowVersion);

  const dateOfBirth = optionalDate(formData, FIELD.dateOfBirth);
  if (dateOfBirth === undefined || (dateOfBirth && (dateOfBirth < '1900-01-01' || dateOfBirth >= today))) fields.push(FIELD.dateOfBirth);
  const nationalityRaw = singleLine(value(formData, FIELD.nationality));
  const nationality =
    nationalityRaw === '' ? null : isText(nationalityRaw, TRAVELLER_LIMITS.nationality.max, TRAVELLER_LIMITS.nationality.min) ? nationalityRaw : undefined;
  if (nationality === undefined) fields.push(FIELD.nationality);
  const passportRaw = value(formData, FIELD.passportNumber).replace(/\s/g, '').toUpperCase();
  const passportNumber = passportRaw === '' ? null : TRAVELLER_LIMITS.passportPattern.test(passportRaw) ? passportRaw : undefined;
  if (passportNumber === undefined) fields.push(FIELD.passportNumber);
  const passportExpiry = optionalDate(formData, FIELD.passportExpiry);
  if (passportExpiry === undefined || (passportExpiry && !isIsoDate(passportExpiry))) fields.push(FIELD.passportExpiry);
  const extras = readIdentityExtras(formData, fields, dateOfBirth, today);

  if (fields.length > 0) return { ok: false, fields: [...new Set(fields)] };
  return {
    ok: true,
    value: {
      dealId: dealId!,
      seq: seq!,
      expectedRowVersion: expectedRowVersion!,
      fields: {
        dateOfBirth: dateOfBirth ?? null,
        nationality: nationality ?? null,
        passportNumber: passportNumber ?? null,
        passportExpiry: passportExpiry ?? null,
        ...extras,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Participation of one service item (service_item_travellers_save)
// ---------------------------------------------------------------------------

export interface ParticipationForm {
  dealId: string;
  versionId: string;
  itemId: string;
  expectedRowVersion: number;
  seqs: number[];
}

export function parseParticipationForm(formData: FormData): ParsedForm<ParticipationForm> {
  const fields: string[] = [];
  const { dealId, versionId, expectedRowVersion } = common(formData, fields);
  const itemId = readUuid(formData, FIELD.itemId);
  if (!itemId) fields.push(FIELD.itemId);
  const seqs = readSeqs(formData, FIELD.participantSeq);
  if (seqs === undefined) fields.push(FIELD.participantSeq);
  if (fields.length > 0) return { ok: false, fields };
  return { ok: true, value: { dealId: dealId!, versionId: versionId!, itemId: itemId!, expectedRowVersion: expectedRowVersion!, seqs: seqs! } };
}

// ---------------------------------------------------------------------------
// Step 4: selling price (booking_commercials_save)
// ---------------------------------------------------------------------------

export interface BookPriceForm {
  dealId: string;
  versionId: string;
  expectedRowVersion: number;
  listPaise: string | null;
  discountPaise: string | null;
  totalPaise: string;
}

export function parseBookPriceForm(formData: FormData): ParsedForm<BookPriceForm> {
  const fields: string[] = [];
  const { dealId, versionId, expectedRowVersion } = common(formData, fields);
  const list = rupeesToPaise(text(formData, FIELD.listRupees));
  const discount = rupeesToPaise(text(formData, FIELD.discountRupees));
  const total = rupeesToPaise(text(formData, FIELD.sellingTotalRupees));
  if (list === undefined) fields.push(FIELD.listRupees);
  if (discount === undefined) fields.push(FIELD.discountRupees);
  if (total === undefined || total === null || BigInt(total) <= 0n) fields.push(FIELD.sellingTotalRupees);
  // A discount needs a list price; list − discount must equal the final total.
  if (discount && list === null) fields.push(FIELD.listRupees);
  if (list && total && /^\d+$/.test(total) && discount !== undefined) {
    if (BigInt(list) - BigInt(discount ?? '0') !== BigInt(total)) fields.push(FIELD.sellingTotalRupees);
  }
  if (fields.length > 0) return { ok: false, fields: [...new Set(fields)] };
  return {
    ok: true,
    value: {
      dealId: dealId!,
      versionId: versionId!,
      expectedRowVersion: expectedRowVersion!,
      listPaise: list ?? null,
      discountPaise: list ? (discount ?? null) : null,
      totalPaise: total!,
    },
  };
}

/** list − discount, as paise digits; null when the list price is empty or invalid. */
export function expectedTotalPaise(listPaise: string | null, discountPaise: string | null): string | null {
  if (!listPaise || !/^\d+$/.test(listPaise)) return null;
  const d = discountPaise && /^\d+$/.test(discountPaise) ? BigInt(discountPaise) : 0n;
  const t = BigInt(listPaise) - d;
  return t < 0n ? null : t.toString();
}

// ---------------------------------------------------------------------------
// Step 5: payment plan (booking_instalments_save)
// ---------------------------------------------------------------------------

export interface BookPlanForm {
  dealId: string;
  versionId: string;
  expectedRowVersion: number;
  instalments: PlanInstalment[];
}

export function parseBookPlanForm(formData: FormData): ParsedForm<BookPlanForm> {
  const fields: string[] = [];
  const { dealId, versionId, expectedRowVersion } = common(formData, fields);
  const labels = strings(formData, FIELD.instalmentLabel);
  const amounts = strings(formData, FIELD.instalmentAmountRupees);
  const dates = strings(formData, FIELD.instalmentDueDate);
  const rows = Math.max(labels.length, amounts.length, dates.length);
  const instalments: PlanInstalment[] = [];
  for (let i = 0; i < rows; i += 1) {
    const label = singleLine(labels[i] ?? '');
    const amountRaw = (amounts[i] ?? '').trim();
    const due = (dates[i] ?? '').trim();
    if (label === '' && amountRaw === '' && due === '') continue;
    const amount = rupeesToPaise(amountRaw);
    if (!isText(label, INSTALMENT_LABEL_MAX)) fields.push(`${FIELD.instalmentLabel}[${i}]`);
    if (!amount || BigInt(amount) <= 0n) fields.push(`${FIELD.instalmentAmountRupees}[${i}]`);
    if (!isIsoDate(due)) fields.push(`${FIELD.instalmentDueDate}[${i}]`);
    instalments.push({ seq: instalments.length + 1, label, amountPaise: amount ?? '0', dueDate: due });
  }
  if (instalments.length > MAX_INSTALMENTS) fields.push(FIELD.instalmentLabel);
  if (fields.length > 0) return { ok: false, fields: [...new Set(fields)] };
  return { ok: true, value: { dealId: dealId!, versionId: versionId!, expectedRowVersion: expectedRowVersion!, instalments } };
}

/** Sum of instalment amounts in paise (digits). */
export function planTotalPaise(instalments: ReadonlyArray<Pick<PlanInstalment, 'amountPaise'>>): string {
  return instalments.reduce((sum, i) => sum + (/^\d+$/.test(i.amountPaise) ? BigInt(i.amountPaise) : 0n), 0n).toString();
}

// ---------------------------------------------------------------------------
// Submit and revision
// ---------------------------------------------------------------------------

export interface SubmitBookingForm {
  dealId: string;
  versionId: string;
  contentHash: string;
  requestId: string | null;
}

export function parseSubmitBookingForm(formData: FormData): ParsedForm<SubmitBookingForm> {
  const fields: string[] = [];
  const { dealId, versionId } = common(formData, fields, { row: false });
  const contentHash = readContentHash(formData);
  if (!contentHash) fields.push(FIELD.contentHash);
  const requestId = readUuid(formData, FIELD.requestId);
  if (fields.length > 0) return { ok: false, fields };
  return { ok: true, value: { dealId: dealId!, versionId: versionId!, contentHash: contentHash!, requestId } };
}

export interface OpenRevisionForm {
  dealId: string;
  baseVersionId: string;
  requestId: string | null;
}

export function parseOpenRevisionForm(formData: FormData): ParsedForm<OpenRevisionForm> {
  const fields: string[] = [];
  const { dealId } = common(formData, fields, { version: false, row: false });
  const baseVersionId = readUuid(formData, FIELD.baseVersionId);
  if (!baseVersionId) fields.push(FIELD.baseVersionId);
  if (fields.length > 0) return { ok: false, fields };
  return { ok: true, value: { dealId: dealId!, baseVersionId: baseVersionId!, requestId: readUuid(formData, FIELD.requestId) } };
}

export interface ClassifyRevisionForm {
  dealId: string;
  versionId: string;
  expectedRowVersion: number;
  changeClass: ChangeClass;
}

export function parseClassifyRevisionForm(formData: FormData): ParsedForm<ClassifyRevisionForm> {
  const fields: string[] = [];
  const { dealId, versionId, expectedRowVersion } = common(formData, fields);
  const changeClass = oneOf<ChangeClass>(CHANGE_CLASSES, value(formData, FIELD.changeClass));
  if (!changeClass) fields.push(FIELD.changeClass);
  if (fields.length > 0) return { ok: false, fields };
  return { ok: true, value: { dealId: dealId!, versionId: versionId!, expectedRowVersion: expectedRowVersion!, changeClass: changeClass! } };
}

export interface VersionRowForm {
  dealId: string;
  versionId: string;
  expectedRowVersion: number;
}

export function parseVersionRowForm(formData: FormData): ParsedForm<VersionRowForm> {
  const fields: string[] = [];
  const { dealId, versionId, expectedRowVersion } = common(formData, fields);
  if (fields.length > 0) return { ok: false, fields };
  return { ok: true, value: { dealId: dealId!, versionId: versionId!, expectedRowVersion: expectedRowVersion! } };
}

// ---------------------------------------------------------------------------
// Department cost entries
// ---------------------------------------------------------------------------

export const COST_REFERENCE_MAX = 120;

export interface DepartmentCostForm {
  taskId: string;
  /** null = a new entry (rowVersion 0). */
  entryId: string | null;
  expectedRowVersion: number;
  requestId: string;
  fields: DepartmentCostFields;
}

export function parseDepartmentCostForm(formData: FormData, today: string = new Date().toISOString().slice(0, 10)): ParsedForm<DepartmentCostForm> {
  const fields: string[] = [];
  const taskId = readUuid(formData, FIELD.taskId);
  if (!taskId) fields.push(FIELD.taskId);
  const entryRaw = value(formData, FIELD.entryId);
  const entryId = entryRaw === '' ? null : readUuid(formData, FIELD.entryId);
  if (entryRaw !== '' && !entryId) fields.push(FIELD.entryId);
  const expectedRowVersion = readNonNegativeInt(formData, FIELD.rowVersion) ?? (entryRaw === '' ? 0 : null);
  if (expectedRowVersion === null) fields.push(FIELD.rowVersion);
  const requestId = readUuid(formData, FIELD.requestId);
  if (!requestId) fields.push(FIELD.requestId);

  const costKind = oneOf<CostKind>(COST_KINDS, value(formData, FIELD.costKind));
  if (!costKind) fields.push(FIELD.costKind);
  const amount = rupeesToPaise(text(formData, FIELD.amountRupees));
  if (!amount || BigInt(amount) <= 0n) fields.push(FIELD.amountRupees);
  const paidBy = oneOf<CostPaidBy>(COST_PAID_BY, value(formData, FIELD.paidBy));
  if (!paidBy) fields.push(FIELD.paidBy);
  const modeRaw = value(formData, FIELD.paymentMode);
  const paidOnRaw = optionalDate(formData, FIELD.paidOn);
  let paymentMode: CostPaymentMode | null = null;
  let paidOn: string | null = null;
  if (paidBy === 'not_yet') {
    // "Not yet": no payment mode and no paid-on date (database check).
    if (modeRaw !== '') fields.push(FIELD.paymentMode);
    if (paidOnRaw) fields.push(FIELD.paidOn);
  } else if (paidBy) {
    const mode = oneOf<CostPaymentMode>(COST_PAYMENT_MODES, modeRaw);
    if (!mode) fields.push(FIELD.paymentMode);
    else paymentMode = mode;
    if (!paidOnRaw || !isIsoDate(paidOnRaw) || paidOnRaw > today) fields.push(FIELD.paidOn);
    else paidOn = paidOnRaw;
  }
  const reference = optionalText(formData, FIELD.reference, COST_REFERENCE_MAX);
  if (reference === undefined) fields.push(FIELD.reference);
  const evidenceRaw = value(formData, FIELD.receiptEvidenceId);
  const receiptEvidenceId = evidenceRaw === '' ? null : readUuid(formData, FIELD.receiptEvidenceId);
  if (evidenceRaw !== '' && !receiptEvidenceId) fields.push(FIELD.receiptEvidenceId);

  if (fields.length > 0) return { ok: false, fields: [...new Set(fields)] };
  return {
    ok: true,
    value: {
      taskId: taskId!,
      entryId,
      expectedRowVersion: expectedRowVersion!,
      requestId: requestId!,
      fields: { costKind: costKind!, amountPaise: amount!, paidBy: paidBy!, paymentMode, paidOn, reference: reference ?? null, receiptEvidenceId },
    },
  };
}

export interface CostEntryRowForm {
  taskId: string;
  entryId: string;
  expectedRowVersion: number;
}

export function parseCostEntryRowForm(formData: FormData): ParsedForm<CostEntryRowForm> {
  const fields: string[] = [];
  const taskId = readUuid(formData, FIELD.taskId);
  if (!taskId) fields.push(FIELD.taskId);
  const entryId = readUuid(formData, FIELD.entryId);
  if (!entryId) fields.push(FIELD.entryId);
  const expectedRowVersion = readRowVersion(formData);
  if (expectedRowVersion === null) fields.push(FIELD.rowVersion);
  if (fields.length > 0) return { ok: false, fields };
  return { ok: true, value: { taskId: taskId!, entryId: entryId!, expectedRowVersion: expectedRowVersion! } };
}

// ---------------------------------------------------------------------------
// Visa & Passport desk
// ---------------------------------------------------------------------------

interface ApplicationBase {
  taskId: string;
  applicationId: string;
  expectedRowVersion: number;
}

function applicationBase(formData: FormData, fields: string[]): Partial<ApplicationBase> {
  const taskId = readUuid(formData, FIELD.taskId);
  if (!taskId) fields.push(FIELD.taskId);
  const applicationId = readUuid(formData, FIELD.applicationId);
  if (!applicationId) fields.push(FIELD.applicationId);
  const expectedRowVersion = readRowVersion(formData);
  if (expectedRowVersion === null) fields.push(FIELD.rowVersion);
  return { taskId: taskId ?? undefined, applicationId: applicationId ?? undefined, expectedRowVersion: expectedRowVersion ?? undefined };
}

export interface ApplicantDocumentForm extends ApplicationBase {
  documentCode: string;
  documentStatus: VisaDocumentStatus;
}

export function parseApplicantDocumentForm(formData: FormData): ParsedForm<ApplicantDocumentForm> {
  const fields: string[] = [];
  const base = applicationBase(formData, fields);
  const documentCode = value(formData, FIELD.documentCode);
  if (!VISA_DOCUMENT_LIMITS.codePattern.test(documentCode)) fields.push(FIELD.documentCode);
  const documentStatus = oneOf<VisaDocumentStatus>(VISA_DOCUMENT_STATUSES, value(formData, FIELD.documentStatus));
  if (!documentStatus) fields.push(FIELD.documentStatus);
  if (fields.length > 0) return { ok: false, fields };
  return { ok: true, value: { ...(base as ApplicationBase), documentCode, documentStatus: documentStatus! } };
}

/** "2026-10-20T10:30" entered in India time (UTC+05:30) → ISO-8601 UTC. '' → null; invalid → undefined. */
export function istLocalToIso(raw: string): string | null | undefined {
  const v = raw.trim();
  if (v === '') return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (!m || !isIsoDate(m[1])) return undefined;
  const hh = Number(m[2]);
  const mm = Number(m[3]);
  if (hh > 23 || mm > 59) return undefined;
  const utc = Date.parse(`${m[1]}T${m[2]}:${m[3]}:00+05:30`);
  return Number.isNaN(utc) ? undefined : new Date(utc).toISOString();
}

export interface VisaSubmissionForm extends ApplicationBase {
  reference: string;
  appointmentAt: string | null;
  appointmentPlace: string | null;
}

export function parseVisaSubmissionForm(formData: FormData): ParsedForm<VisaSubmissionForm> {
  const fields: string[] = [];
  const base = applicationBase(formData, fields);
  const reference = singleLine(value(formData, FIELD.reference));
  if (!isText(reference, VISA_APPLICATION_LIMITS.reference)) fields.push(FIELD.reference);
  const appointmentAt = istLocalToIso(value(formData, FIELD.appointmentAt));
  if (appointmentAt === undefined) fields.push(FIELD.appointmentAt);
  const appointmentPlace = optionalText(formData, FIELD.appointmentPlace, VISA_APPLICATION_LIMITS.appointmentPlace);
  if (appointmentPlace === undefined) fields.push(FIELD.appointmentPlace);
  if (fields.length > 0) return { ok: false, fields };
  return { ok: true, value: { ...(base as ApplicationBase), reference, appointmentAt: appointmentAt ?? null, appointmentPlace: appointmentPlace ?? null } };
}

export interface VisaStateForm extends ApplicationBase {
  state: VisaStateCommand;
  evidenceId: string | null;
}

/** `allowed` limits which state commands this form may send (one action per step). */
export function parseVisaStateForm(formData: FormData, allowed: readonly VisaStateCommand[] = VISA_STATE_COMMANDS): ParsedForm<VisaStateForm> {
  const fields: string[] = [];
  const base = applicationBase(formData, fields);
  const state = oneOf<VisaStateCommand>(allowed, value(formData, FIELD.state));
  if (!state) fields.push(FIELD.state);
  const evidenceRaw = value(formData, FIELD.evidenceId);
  const evidenceId = evidenceRaw === '' ? null : readUuid(formData, FIELD.evidenceId);
  if (evidenceRaw !== '' && !evidenceId) fields.push(FIELD.evidenceId);
  if ((state === 'issued' || state === 'refused') && !evidenceId) fields.push(FIELD.evidenceId);
  if (fields.length > 0) return { ok: false, fields: [...new Set(fields)] };
  return { ok: true, value: { ...(base as ApplicationBase), state: state!, evidenceId } };
}

export function readDepartmentEvidenceKind(formData: FormData): DepartmentEvidenceKind | null {
  return oneOf<DepartmentEvidenceKind>(DEPARTMENT_EVIDENCE_KINDS, value(formData, FIELD.kind)) ?? null;
}

// ---------------------------------------------------------------------------
// B1.2 traveller identity proof (traveller_id_proof_begin / _remove)
// ---------------------------------------------------------------------------

/** Form input names of the identity-proof forms (B1.2; FIELD keeps the B1/B1.1 names; the file is FIELD.file). */
export const ID_PROOF_FIELD = {
  travellerSeq: 'travellerSeq',
  /** Checkbox "Customer agreed to share this ID for this booking" (DEC-39): 'on' when ticked. */
  consent: 'consent',
  fileId: 'fileId',
  /** The file's own row version (traveller_id_proof_remove); not the booking version's. */
  fileRowVersion: 'fileRowVersion',
  /** DEC-43: the Bitrix copy job to try again (IdProofCopyView.jobId). */
  copyJobId: 'copyJobId',
} as const;

export interface IdProofCopyRetryForm {
  /** Book now: the Deal whose pages are refreshed; null from the Super Admin's alerts list. */
  dealId: string | null;
  jobId: string;
}

export function parseIdProofCopyRetryForm(formData: FormData): ParsedForm<IdProofCopyRetryForm> {
  const fields: string[] = [];
  const dealRaw = value(formData, FIELD.dealId);
  const dealId = dealRaw === '' ? null : readUuid(formData, FIELD.dealId);
  if (dealRaw !== '' && !dealId) fields.push(FIELD.dealId);
  const jobId = readUuid(formData, ID_PROOF_FIELD.copyJobId);
  if (!jobId) fields.push(ID_PROOF_FIELD.copyJobId);
  if (fields.length > 0) return { ok: false, fields: [...new Set(fields)] };
  return { ok: true, value: { dealId, jobId: jobId! } };
}

export interface IdProofUploadForm {
  dealId: string;
  travellerSeq: number;
  requestId: string;
  /** DEC-39: true only when the consent box was ticked; the action refuses (consent_required) before any call otherwise. */
  consent: boolean;
}

/** dealId, travellerSeq, requestId and the consent tick; the file itself is checked by checkEvidenceFile in the action. */
export function parseIdProofUploadForm(formData: FormData): ParsedForm<IdProofUploadForm> {
  const fields: string[] = [];
  const { dealId, requestId } = common(formData, fields, { version: false, row: false, request: true });
  const raw = value(formData, ID_PROOF_FIELD.travellerSeq);
  const travellerSeq = /^[1-9][0-9]{0,2}$/.test(raw) && Number(raw) <= MAX_TRAVELLERS ? Number(raw) : null;
  if (travellerSeq === null) fields.push(ID_PROOF_FIELD.travellerSeq);
  if (fields.length > 0) return { ok: false, fields: [...new Set(fields)] };
  return { ok: true, value: { dealId: dealId!, travellerSeq: travellerSeq!, requestId: requestId!, consent: checkbox(formData, ID_PROOF_FIELD.consent) } };
}

export interface IdProofRemoveForm {
  dealId: string;
  fileId: string;
  expectedRowVersion: number;
}

export function parseIdProofRemoveForm(formData: FormData): ParsedForm<IdProofRemoveForm> {
  const fields: string[] = [];
  const { dealId } = common(formData, fields, { version: false, row: false });
  const fileId = readUuid(formData, ID_PROOF_FIELD.fileId);
  if (!fileId) fields.push(ID_PROOF_FIELD.fileId);
  const raw = value(formData, ID_PROOF_FIELD.fileRowVersion);
  const expectedRowVersion = /^[1-9][0-9]{0,8}$/.test(raw) ? Number(raw) : null;
  if (expectedRowVersion === null) fields.push(ID_PROOF_FIELD.fileRowVersion);
  if (fields.length > 0) return { ok: false, fields: [...new Set(fields)] };
  return { ok: true, value: { dealId: dealId!, fileId: fileId!, expectedRowVersion: expectedRowVersion! } };
}

// ---------------------------------------------------------------------------
// B1.2 Bitrix prefill (0600): "Use Bitrix values" and "Mark checked"
// ---------------------------------------------------------------------------

export const PREFILL_FIELD = {
  /** 'booking_version' (Book now) or 'quotation_version'. */
  target: 'prefillTarget',
  /** One input per field code (checkboxes or a single hidden input); repeated. */
  field: 'prefillField',
  /** Batch 2 "Keep mine": the Bitrix snapshot time the notice was shown for (PrefillNoticeVM.sourceModifiedAt). */
  sourceModifiedAt: 'prefillSourceModifiedAt',
} as const;

export interface PrefillForm {
  targetKind: PrefillTargetKind;
  /** Booking version or quotation version id (FIELD.versionId). */
  versionId: string;
  expectedRowVersion: number;
  /** Booking only (FIELD.dealId): the Deal whose Book now pages are refreshed. */
  dealId: string | null;
  fields: PrefillFieldCode[];
}

/**
 * Target, version, row version and the field codes. Only codes of that
 * target are accepted (booking: trip dates and contact; quotation adds the
 * requirements note and company name). No values: they come from the
 * database snapshot.
 */
export function parsePrefillForm(formData: FormData): ParsedForm<PrefillForm> {
  const fields: string[] = [];
  const target = value(formData, PREFILL_FIELD.target);
  const targetKind = (PREFILL_TARGET_KINDS as readonly string[]).includes(target) ? (target as PrefillTargetKind) : null;
  if (!targetKind) fields.push(PREFILL_FIELD.target);
  const versionId = readUuid(formData, FIELD.versionId);
  if (!versionId) fields.push(FIELD.versionId);
  const expectedRowVersion = readRowVersion(formData);
  if (expectedRowVersion === null) fields.push(FIELD.rowVersion);
  const dealId = readUuid(formData, FIELD.dealId);
  if (targetKind === 'booking_version' && !dealId) fields.push(FIELD.dealId);
  const allowed: readonly string[] = targetKind === 'booking_version' ? BOOKING_PREFILL_FIELDS : QUOTATION_PREFILL_FIELDS;
  const raw = formData.getAll(PREFILL_FIELD.field).map((v) => (typeof v === 'string' ? v.trim() : ''));
  const codes = [...new Set(raw)];
  if (codes.length === 0 || codes.length > QUOTATION_PREFILL_FIELDS.length || codes.some((c) => !allowed.includes(c))) fields.push(PREFILL_FIELD.field);
  if (fields.length > 0) return { ok: false, fields: [...new Set(fields)] };
  return {
    ok: true,
    value: { targetKind: targetKind!, versionId: versionId!, expectedRowVersion: expectedRowVersion!, dealId: targetKind === 'booking_version' ? dealId! : null, fields: codes as PrefillFieldCode[] },
  };
}

/**
 * Batch 2 "Fill empty fields from Bitrix" (prefill_fill_empty): target,
 * version, row version and (booking) the Deal. No field list and no values:
 * the database fills only untouched empty fields from its own snapshot.
 */
export function parsePrefillTargetForm(formData: FormData): ParsedForm<PrefillFillEmptyForm> {
  const fields: string[] = [];
  const target = value(formData, PREFILL_FIELD.target);
  const targetKind = (PREFILL_TARGET_KINDS as readonly string[]).includes(target) ? (target as PrefillTargetKind) : null;
  if (!targetKind) fields.push(PREFILL_FIELD.target);
  const versionId = readUuid(formData, FIELD.versionId);
  if (!versionId) fields.push(FIELD.versionId);
  const expectedRowVersion = readRowVersion(formData);
  if (expectedRowVersion === null) fields.push(FIELD.rowVersion);
  const dealId = readUuid(formData, FIELD.dealId);
  if (targetKind === 'booking_version' && !dealId) fields.push(FIELD.dealId);
  if (fields.length > 0) return { ok: false, fields: [...new Set(fields)] };
  return { ok: true, value: { targetKind: targetKind!, versionId: versionId!, expectedRowVersion: expectedRowVersion!, dealId: targetKind === 'booking_version' ? dealId! : null } };
}

const SNAPSHOT_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})$/;

/** Batch 2 "Keep mine" (prefill_notice_dismiss): the target form plus exactly one field code of that target and the snapshot time. */
export function parsePrefillDismissForm(formData: FormData): ParsedForm<PrefillDismissForm> {
  const base = parsePrefillTargetForm(formData);
  const fields: string[] = base.ok ? [] : [...base.fields];
  const target = value(formData, PREFILL_FIELD.target);
  const allowed: readonly string[] = target === 'booking_version' ? BOOKING_PREFILL_FIELDS : QUOTATION_PREFILL_FIELDS;
  const codes = [...new Set(formData.getAll(PREFILL_FIELD.field).map((v) => (typeof v === 'string' ? v.trim() : '')))];
  if (codes.length !== 1 || !allowed.includes(codes[0]!)) fields.push(PREFILL_FIELD.field);
  const at = value(formData, PREFILL_FIELD.sourceModifiedAt);
  if (at.length > 40 || !SNAPSHOT_TIME.test(at) || Number.isNaN(Date.parse(at))) fields.push(PREFILL_FIELD.sourceModifiedAt);
  if (!base.ok || fields.length > 0) return { ok: false, fields: [...new Set(fields)] };
  return { ok: true, value: { ...base.value, field: codes[0] as PrefillFieldCode, sourceModifiedAt: at } };
}

// ---------------------------------------------------------------------------
// B1.2 switches (Workflow page, Super Admin)
// ---------------------------------------------------------------------------

export const B12_SWITCH_FIELD = {
  key: 'switchKey',
  /** 'on' | 'off' */
  state: 'switchState',
  reason: 'reason',
} as const;

export interface B12SwitchForm {
  key: B12SwitchKey;
  on: boolean;
  reason: string;
}

export function parseB12SwitchForm(formData: FormData): ParsedForm<B12SwitchForm> {
  const fields: string[] = [];
  const keyRaw = value(formData, B12_SWITCH_FIELD.key);
  const key = (B12_SWITCH_KEYS as readonly string[]).includes(keyRaw) ? (keyRaw as B12SwitchKey) : null;
  if (!key) fields.push(B12_SWITCH_FIELD.key);
  const state = value(formData, B12_SWITCH_FIELD.state);
  if (state !== 'on' && state !== 'off') fields.push(B12_SWITCH_FIELD.state);
  const reason = value(formData, B12_SWITCH_FIELD.reason).replace(/\s+/g, ' ').trim();
  if (reason.length < B12_SWITCH_LIMITS.reason.min || reason.length > B12_SWITCH_LIMITS.reason.max) fields.push(B12_SWITCH_FIELD.reason);
  if (fields.length > 0) return { ok: false, fields };
  return { ok: true, value: { key: key!, on: state === 'on', reason } };
}
