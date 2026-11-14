import { z } from 'zod';
import type {
  HandoverMethodValue,
  JurisdictionValue,
  VisaApplyApplicant,
  VisaApplyFields,
  VisaDecideFields,
  VisaDocumentAddFields,
  VisaFeeSendFields,
  VisaHandoverChoice,
  VisaHandoverFields,
  VisaKindValue,
  VisaOtherCostFields,
  VisaRowFields,
  VisaWithdrawFields,
} from './commands';
import { VISA_DOCUMENT_CATALOGUE, VISA_FIELD, VISA_LIMITS, type VisaCatalogueCode, visaApplicantField } from './contracts';

/**
 * Pure helpers of the Visa desk (contract section 10): rupees -> paise,
 * passport number normaliser, HH:MM parser, document label key, the "first
 * passenger's fees fill the empty boxes" helper, and the FormData parsers of
 * the server actions (FormData -> command fields). Never the actor, entity,
 * assignee or state: the database decides those. The database validates
 * every value again; these only help people type and keep refusals precise.
 */

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * "₹6,500", "6500.5", " 6 500.50 " -> "650050" (whole paise, > 0, at most 15
 * digits). Commas, spaces and the rupee sign are removed; more than two
 * decimals, a minus sign or zero are null. No floating point anywhere.
 */
export function rupeesToPaise(input: string | null | undefined): string | null {
  const value = (input ?? '').replace(/[,\s₹]/g, '');
  if (value === '' || value.length > 20) return null;
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!m) return null;
  const whole = m[1]!.replace(/^0+(?=\d)/, '');
  const fraction = (m[2] ?? '').padEnd(2, '0');
  const paise = `${whole}${fraction}`.replace(/^0+/, '');
  return /^[1-9][0-9]{0,14}$/.test(paise) ? paise : null;
}

/** "650050" -> "6,500.50"; "650000" -> "6,500" (Indian grouping). */
export function paiseToRupeesText(paise: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(paise)) return paise;
  const padded = paise.padStart(3, '0');
  const rupees = padded.slice(0, -2).replace(/^0+(?=\d)/, '');
  const fraction = padded.slice(-2);
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return fraction === '00' ? grouped : `${grouped}.${fraction}`;
}

// ---------------------------------------------------------------------------
// Passport number, time, label key
// ---------------------------------------------------------------------------

export const PASSPORT_NUMBER_PATTERN = /^[A-Z0-9]{6,15}$/;

/** Upper-cased, spaces and dashes removed (as the database stores it). */
export function normalizePassportNumber(input: string | null | undefined): string {
  return (input ?? '').toUpperCase().replace(/[\s-]+/g, '');
}

/** The normalised number when it is valid, else null. */
export function parsePassportNumber(input: string | null | undefined): string | null {
  const value = normalizePassportNumber(input);
  return PASSPORT_NUMBER_PATTERN.test(value) ? value : null;
}

/** "1035", "10:35", "9:05", "7:05 pm" -> "HH:MM" (24 h); anything else null. */
export function parseVisaTime(input: string | null | undefined): string | null {
  const value = (input ?? '').trim();
  if (value === '' || value.length > 8) return null;
  const m = /^(\d{1,2}):?(\d{2})\s*([ap])\.?\s*m?\.?$/i.exec(value) ?? /^(\d{1,2}):?(\d{2})$/.exec(value);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const meridiem = m[3]?.toLowerCase();
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = meridiem === 'a' ? (hour === 12 ? 0 : hour) : hour === 12 ? 12 : hour + 12;
  } else if (hour > 23) {
    return null;
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** "YYYY-MM-DD" within 2000-01-01..2100-12-31 and a real calendar date, else null. */
export function parseVisaDate(input: string | null | undefined): string | null {
  const value = (input ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? value : null;
}

/** Today in India (IST, UTC+05:30) as YYYY-MM-DD; the database's authz.finance_today() decides. */
export function todayIst(now: Date = new Date()): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/** Applied date default (H:15140): the appointment date when it is today or earlier, else today. */
export function defaultAppliedOn(appointmentDate: string | null, today: string): string {
  return appointmentDate && appointmentDate <= today ? appointmentDate : today;
}

/**
 * The database's label key: lower(regexp_replace(btrim(label), '\s+', ' ', 'g')).
 * btrim removes spaces only; \s is the ASCII whitespace class.
 */
export function visaLabelKey(label: string): string {
  return label.replace(/^ +| +$/g, '').replace(/[ \t\n\r\f\v]+/g, ' ').toLowerCase();
}

/** Trimmed, single spaces: the label as stored. */
export function cleanVisaLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ');
}

const CATALOGUE_BY_KEY: ReadonlyMap<string, VisaCatalogueCode> = new Map(
  VISA_DOCUMENT_CATALOGUE.map((d) => [visaLabelKey(d.label), d.code]),
);

/** A typed label equal to a catalogue label takes its code (section 4). */
export function catalogueCodeForLabel(label: string): VisaCatalogueCode | null {
  return CATALOGUE_BY_KEY.get(visaLabelKey(label)) ?? null;
}

export function isCatalogueCode(value: string): value is VisaCatalogueCode {
  return VISA_DOCUMENT_CATALOGUE.some((d) => d.code === value);
}

/** Catalogue entries not yet on a passenger's list (Add document select). */
export function catalogueNotListed(listedLabels: readonly string[]): { code: VisaCatalogueCode; label: string }[] {
  const listed = new Set(listedLabels.map(visaLabelKey));
  return VISA_DOCUMENT_CATALOGUE.filter((d) => !listed.has(visaLabelKey(d.label))).map((d) => ({ code: d.code, label: d.label }));
}

// ---------------------------------------------------------------------------
// Confirm applied: the first passenger's fees fill the empty boxes below
// ---------------------------------------------------------------------------

export interface FeeBoxes {
  governmentFee: string;
  serviceFee: string;
}

/**
 * Fills each empty box from the first line's value; a typed value (even a
 * different amount) is never overwritten and nothing is ever split.
 */
export function copyDownFees<T extends FeeBoxes>(lines: readonly T[]): T[] {
  const first = lines[0];
  if (!first) return [];
  return lines.map((line, i) => {
    if (i === 0) return line;
    return {
      ...line,
      governmentFee: line.governmentFee.trim() === '' ? first.governmentFee : line.governmentFee,
      serviceFee: line.serviceFee.trim() === '' ? first.serviceFee : line.serviceFee,
    };
  });
}

// ---------------------------------------------------------------------------
// FormData readers
// ---------------------------------------------------------------------------

const UUID = z.uuid();

export type Parsed<T> = { ok: true; value: T } | { ok: false; fields: string[] };

export function readText(formData: FormData, field: string): string | null {
  const raw = formData.get(field);
  return typeof raw === 'string' ? raw : null;
}

/** True when the form posted the field at all (absent = unchanged in C2). */
export function hasField(formData: FormData, field: string): boolean {
  return formData.has(field);
}

export function readUuid(formData: FormData, field: string): string | null {
  const parsed = UUID.safeParse((readText(formData, field) ?? '').trim());
  return parsed.success ? parsed.data : null;
}

/** An optional uuid: '' or absent = null; anything else must be a uuid. */
function readOptionalUuid(formData: FormData, field: string): { ok: boolean; value: string | null } {
  const raw = (readText(formData, field) ?? '').trim();
  if (raw === '') return { ok: true, value: null };
  const parsed = UUID.safeParse(raw);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, value: null };
}

export function readPositiveInt(formData: FormData, field: string): number | null {
  const raw = (readText(formData, field) ?? '').trim();
  if (!/^[0-9]{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 ? n : null;
}

export function readRequestId(formData: FormData): string | null {
  return readUuid(formData, VISA_FIELD.requestId);
}

/** Checkbox / yes-no: 'on', 'true', 'yes', '1' are true. */
export function readTick(formData: FormData, field: string): boolean {
  const v = (readText(formData, field) ?? '').trim().toLowerCase();
  return v === 'on' || v === 'true' || v === 'yes' || v === '1';
}

/** Trimmed text; '' = null; longer than max = invalid. */
function readOptionalText(formData: FormData, field: string, max: number, min = 1): { ok: boolean; value: string | null } {
  const value = (readText(formData, field) ?? '').trim();
  if (value === '') return { ok: true, value: null };
  return value.length >= min && value.length <= max ? { ok: true, value } : { ok: false, value: null };
}

function readKind(formData: FormData): { ok: boolean; value: VisaKindValue | null } {
  const v = (readText(formData, VISA_FIELD.visaKind) ?? '').trim();
  if (v === '') return { ok: true, value: null };
  return v === 'e_visa' || v === 'sticker' ? { ok: true, value: v } : { ok: false, value: null };
}

function readJurisdiction(formData: FormData): { ok: boolean; value: JurisdictionValue | null } {
  const v = (readText(formData, VISA_FIELD.jurisdiction) ?? '').trim();
  if (v === '') return { ok: true, value: null };
  return v === 'yes' || v === 'no' ? { ok: true, value: v } : { ok: false, value: null };
}

function readMethod(formData: FormData): HandoverMethodValue | null {
  const v = (readText(formData, VISA_FIELD.handoverMethod) ?? '').trim();
  return v === 'office' || v === 'executive' || v === 'courier' || v === 'not_with_us' ? v : null;
}

/** Ids of one application command: application, row version, request id. */
export interface ApplicationTarget {
  taskId: string;
  dealId: string | null;
  applicationId: string;
  expectedRowVersion: number;
  requestId: string;
}

export function parseApplicationTarget(formData: FormData): Parsed<ApplicationTarget> {
  const taskId = readUuid(formData, VISA_FIELD.taskId);
  const dealId = readUuid(formData, VISA_FIELD.dealId);
  const applicationId = readUuid(formData, VISA_FIELD.applicationId);
  const expectedRowVersion = readPositiveInt(formData, VISA_FIELD.expectedRowVersion);
  const requestId = readRequestId(formData);
  const fields = missingOf({
    [VISA_FIELD.taskId]: taskId,
    [VISA_FIELD.applicationId]: applicationId,
    [VISA_FIELD.expectedRowVersion]: expectedRowVersion,
    [VISA_FIELD.requestId]: requestId,
  });
  if (fields.length) return { ok: false, fields };
  return { ok: true, value: { taskId: taskId!, dealId, applicationId: applicationId!, expectedRowVersion: expectedRowVersion!, requestId: requestId! } };
}

function missingOf(values: Record<string, unknown>): string[] {
  return Object.entries(values).filter(([, v]) => v === null || v === undefined || v === false).map(([k]) => k);
}

/** Optional handover choice in the decide and withdraw popups ('' = not decided yet). */
function readHandoverChoice(formData: FormData, bad: string[]): VisaHandoverChoice | undefined {
  const raw = (readText(formData, VISA_FIELD.handoverMethod) ?? '').trim();
  if (raw === '') return undefined;
  const method = readMethod(formData);
  if (!method) {
    bad.push(VISA_FIELD.handoverMethod);
    return undefined;
  }
  if (method !== 'courier') return { method };
  const courier = readOptionalText(formData, VISA_FIELD.courierNumber, VISA_LIMITS.courierNumber);
  if (!courier.ok || !courier.value) {
    bad.push(VISA_FIELD.courierNumber);
    return undefined;
  }
  return { method, courierNumber: courier.value };
}

// ---------------------------------------------------------------------------
// C2 Passengers row
// ---------------------------------------------------------------------------

/**
 * Only the fields the row form posts are sent (absent = unchanged); an empty
 * value clears it. Documents: every id in documentIds is sent as received
 * when it is also in receivedDocumentIds, else as not received.
 */
export function parseRowForm(formData: FormData): Parsed<{ target: ApplicationTarget; fields: VisaRowFields }> {
  const target = parseApplicationTarget(formData);
  if (!target.ok) return target;
  const bad: string[] = [];
  const fields: VisaRowFields = {};

  if (hasField(formData, VISA_FIELD.appointmentDate)) {
    const raw = (readText(formData, VISA_FIELD.appointmentDate) ?? '').trim();
    const date = raw === '' ? null : parseVisaDate(raw);
    if (raw !== '' && !date) bad.push(VISA_FIELD.appointmentDate);
    fields.appointmentDate = date;
  }
  if (hasField(formData, VISA_FIELD.appointmentTime)) {
    const raw = (readText(formData, VISA_FIELD.appointmentTime) ?? '').trim();
    const time = raw === '' ? null : parseVisaTime(raw);
    if (raw !== '' && !time) bad.push(VISA_FIELD.appointmentTime);
    fields.appointmentTime = time;
  }
  if (fields.appointmentTime && fields.appointmentDate === null) bad.push(VISA_FIELD.appointmentTime);
  if (hasField(formData, VISA_FIELD.remark)) {
    const remark = readOptionalText(formData, VISA_FIELD.remark, VISA_LIMITS.remark);
    if (!remark.ok) bad.push(VISA_FIELD.remark);
    fields.remark = remark.value;
  }
  if (hasField(formData, VISA_FIELD.passportNumber)) {
    const raw = readText(formData, VISA_FIELD.passportNumber) ?? '';
    const number = normalizePassportNumber(raw) === '' ? null : parsePassportNumber(raw);
    if (normalizePassportNumber(raw) !== '' && !number) bad.push(VISA_FIELD.passportNumber);
    fields.passportNumber = number;
  }
  if (hasField(formData, VISA_FIELD.visaKind)) {
    const kind = readKind(formData);
    if (!kind.ok) bad.push(VISA_FIELD.visaKind);
    fields.visaKind = kind.value;
  }
  if (hasField(formData, VISA_FIELD.jurisdiction)) {
    const j = readJurisdiction(formData);
    if (!j.ok) bad.push(VISA_FIELD.jurisdiction);
    fields.jurisdiction = j.value;
    const place = readOptionalText(formData, VISA_FIELD.jurisdictionPlace, VISA_LIMITS.jurisdictionPlace);
    if (!place.ok || (j.value === 'yes' && !place.value)) bad.push(VISA_FIELD.jurisdictionPlace);
    fields.jurisdictionPlace = j.value === 'yes' ? place.value : null;
  }
  if (hasField(formData, VISA_FIELD.documentIds)) {
    const ids = formData.getAll(VISA_FIELD.documentIds).map((v) => (typeof v === 'string' ? v.trim() : ''));
    const received = new Set(formData.getAll(VISA_FIELD.receivedDocumentIds).map((v) => (typeof v === 'string' ? v.trim() : '')));
    if (ids.length > VISA_LIMITS.documentsPerApplicant || ids.some((id) => !UUID.safeParse(id).success) || new Set(ids).size !== ids.length) {
      bad.push(VISA_FIELD.documentIds);
    } else {
      fields.documents = ids.map((documentId) => ({ documentId, received: received.has(documentId) }));
    }
  }
  if (bad.length) return { ok: false, fields: [...new Set(bad)] };
  if (Object.keys(fields).length === 0) return { ok: false, fields: ['fields'] };
  return { ok: true, value: { target: target.value, fields } };
}

// ---------------------------------------------------------------------------
// C3 / C4 documents
// ---------------------------------------------------------------------------

/** Catalogue select value, or "other" with a typed label (a typed catalogue label takes its code). */
export function parseDocumentAddForm(formData: FormData): Parsed<{ target: ApplicationTarget; fields: VisaDocumentAddFields }> {
  const target = parseApplicationTarget(formData);
  if (!target.ok) return target;
  const code = (readText(formData, VISA_FIELD.catalogueCode) ?? '').trim();
  const remark = readOptionalText(formData, VISA_FIELD.remark, VISA_LIMITS.remark);
  const received = readTick(formData, VISA_FIELD.received);
  if (!remark.ok) return { ok: false, fields: [VISA_FIELD.remark] };
  if (code !== '' && code !== 'other') {
    if (!isCatalogueCode(code)) return { ok: false, fields: [VISA_FIELD.catalogueCode] };
    return { ok: true, value: { target: target.value, fields: { catalogueCode: code, received, remark: remark.value } } };
  }
  const label = cleanVisaLabel(readText(formData, VISA_FIELD.label) ?? '');
  if (label.length < 1 || label.length > VISA_LIMITS.documentLabel) return { ok: false, fields: [VISA_FIELD.label] };
  const matched = catalogueCodeForLabel(label);
  return {
    ok: true,
    value: { target: target.value, fields: matched ? { catalogueCode: matched, received, remark: remark.value } : { label, received, remark: remark.value } },
  };
}

export function parseDocumentRemoveForm(
  formData: FormData,
): Parsed<{ taskId: string; dealId: string | null; documentId: string; expectedRowVersion: number; requestId: string }> {
  const taskId = readUuid(formData, VISA_FIELD.taskId);
  const documentId = readUuid(formData, VISA_FIELD.documentId);
  const expectedRowVersion = readPositiveInt(formData, VISA_FIELD.expectedRowVersion);
  const requestId = readRequestId(formData);
  const fields = missingOf({
    [VISA_FIELD.taskId]: taskId,
    [VISA_FIELD.documentId]: documentId,
    [VISA_FIELD.expectedRowVersion]: expectedRowVersion,
    [VISA_FIELD.requestId]: requestId,
  });
  if (fields.length) return { ok: false, fields };
  return { ok: true, value: { taskId: taskId!, dealId: readUuid(formData, VISA_FIELD.dealId), documentId: documentId!, expectedRowVersion: expectedRowVersion!, requestId: requestId! } };
}

// ---------------------------------------------------------------------------
// C5 Applied
// ---------------------------------------------------------------------------

/**
 * Mark as applied (one line) and Confirm applied (several lines): one line per
 * applicant posted as applicants[i].<key> for i = 0..applicantCount-1; fees in
 * rupees (converted to whole paise here, never split); shared kind,
 * jurisdiction, passport tick, fee details, receipt and remark. Refused
 * lines are named "applicants[i].<key>" like the database's hints.
 */
export function parseApplyForm(formData: FormData): Parsed<{ taskId: string; dealId: string | null; requestId: string; fields: VisaApplyFields }> {
  const taskId = readUuid(formData, VISA_FIELD.taskId);
  const requestId = readRequestId(formData);
  const countRaw = (readText(formData, VISA_FIELD.applicantCount) ?? '').trim();
  const n = /^[0-9]{1,3}$/.test(countRaw) ? Number(countRaw) : 0;
  const head = missingOf({ [VISA_FIELD.taskId]: taskId, [VISA_FIELD.requestId]: requestId, [VISA_FIELD.applicantCount]: n >= 1 && n <= VISA_LIMITS.applicantsPerApply });
  if (head.length) return { ok: false, fields: head };

  const bad: string[] = [];
  const applicants: VisaApplyApplicant[] = [];
  for (let i = 0; i < n; i++) {
    const f = (key: Parameters<typeof visaApplicantField>[1]) => visaApplicantField(i, key);
    const applicationId = readUuid(formData, f('applicationId'));
    const expectedRowVersion = readPositiveInt(formData, f('expectedRowVersion'));
    const reference = (readText(formData, f('reference')) ?? '').trim();
    const appliedOn = parseVisaDate(readText(formData, f('appliedOn')));
    const governmentFeePaise = rupeesToPaise(readText(formData, f('governmentFee')));
    const serviceRaw = (readText(formData, f('serviceFee')) ?? '').replace(/[,\s₹]/g, '');
    const serviceFeePaise = serviceRaw === '' ? null : rupeesToPaise(serviceRaw);
    if (!applicationId) bad.push(f('applicationId'));
    if (!expectedRowVersion) bad.push(f('expectedRowVersion'));
    if (reference.length < 1 || reference.length > VISA_LIMITS.reference) bad.push(f('reference'));
    if (!appliedOn) bad.push(f('appliedOn'));
    if (!governmentFeePaise) bad.push(f('governmentFee'));
    if (serviceRaw !== '' && !serviceFeePaise) bad.push(f('serviceFee'));
    if (applicationId && expectedRowVersion && appliedOn && governmentFeePaise) {
      applicants.push({ applicationId, expectedRowVersion, reference, appliedOn, governmentFeePaise, serviceFeePaise });
    }
  }
  const ids = applicants.map((a) => a.applicationId);
  if (new Set(ids).size !== ids.length) bad.push(VISA_FIELD.applicantCount);
  // Two references equal ignoring case inside the club are refused before the database sees them.
  const refs = new Map<string, number>();
  applicants.forEach((a, i) => {
    const key = a.reference.toLowerCase();
    if (refs.has(key)) bad.push(visaApplicantField(i, 'reference'));
    else refs.set(key, i);
  });
  // V11 (applied date after today) is the database's rule: applied_date_in_future with the frozen wording.

  const fields: VisaApplyFields = { applicants, paidBy: 'company' };
  const kind = readKind(formData);
  if (!kind.ok) bad.push(VISA_FIELD.visaKind);
  else if (kind.value) fields.visaKind = kind.value;
  if (hasField(formData, VISA_FIELD.jurisdiction)) {
    const j = readJurisdiction(formData);
    if (!j.ok) bad.push(VISA_FIELD.jurisdiction);
    else if (j.value) {
      fields.jurisdiction = j.value;
      const place = readOptionalText(formData, VISA_FIELD.jurisdictionPlace, VISA_LIMITS.jurisdictionPlace);
      if (!place.ok || (j.value === 'yes' && !place.value)) bad.push(VISA_FIELD.jurisdictionPlace);
      fields.jurisdictionPlace = j.value === 'yes' ? place.value : null;
    }
  }
  if (readTick(formData, VISA_FIELD.passportTaken)) fields.passportTaken = true;
  const paidBy = (readText(formData, VISA_FIELD.paidBy) ?? '').trim();
  if (paidBy !== 'company' && paidBy !== 'customer_direct') bad.push(VISA_FIELD.paidBy);
  else fields.paidBy = paidBy;
  const mode = (readText(formData, VISA_FIELD.paymentMode) ?? '').trim();
  if (mode !== '') {
    if (mode === 'bank_transfer' || mode === 'upi' || mode === 'card' || mode === 'cash' || mode === 'other') fields.paymentMode = mode;
    else bad.push(VISA_FIELD.paymentMode);
  } else if (paidBy === 'company') {
    bad.push(VISA_FIELD.paymentMode);
  }
  const receipt = readOptionalUuid(formData, VISA_FIELD.receiptEvidenceId);
  if (!receipt.ok) bad.push(VISA_FIELD.receiptEvidenceId);
  else if (receipt.value) fields.receiptEvidenceId = receipt.value;
  const remark = readOptionalText(formData, VISA_FIELD.remark, VISA_LIMITS.remark);
  if (!remark.ok) bad.push(VISA_FIELD.remark);
  else fields.remark = remark.value;

  if (bad.length) return { ok: false, fields: [...new Set(bad)] };
  return { ok: true, value: { taskId: taskId!, dealId: readUuid(formData, VISA_FIELD.dealId), requestId: requestId!, fields } };
}

// ---------------------------------------------------------------------------
// C6 decision, C7 handover, C8 delivered, C9 withdraw
// ---------------------------------------------------------------------------

export function parseDecideForm(formData: FormData): Parsed<{ target: ApplicationTarget; fields: VisaDecideFields }> {
  const target = parseApplicationTarget(formData);
  if (!target.ok) return target;
  const bad: string[] = [];
  const decision = (readText(formData, VISA_FIELD.decision) ?? '').trim();
  if (decision !== 'approved' && decision !== 'rejected') return { ok: false, fields: [VISA_FIELD.decision] };
  // Q3/V5: the proof is required; without it the database answers outcome_document_required.
  const proof = readUuid(formData, VISA_FIELD.outcomeEvidenceId);
  if (!proof) bad.push(VISA_FIELD.outcomeEvidenceId);
  const fields: VisaDecideFields = { decision, outcomeEvidenceId: proof ?? '' };
  const kind = readKind(formData);
  if (!kind.ok) bad.push(VISA_FIELD.visaKind);
  else if (kind.value) fields.visaKind = kind.value;
  if (decision === 'approved') {
    const remark = readOptionalText(formData, VISA_FIELD.remark, VISA_LIMITS.remark);
    if (!remark.ok) bad.push(VISA_FIELD.remark);
    else fields.remark = remark.value;
  } else {
    const reason = readOptionalText(formData, VISA_FIELD.reason, VISA_LIMITS.reasonMax, VISA_LIMITS.reasonMin);
    if (!reason.ok || !reason.value) bad.push(VISA_FIELD.reason);
    else fields.reason = reason.value;
  }
  if (hasField(formData, VISA_FIELD.recipientEmail)) {
    const email = readEmail(formData);
    if (email === false) bad.push(VISA_FIELD.recipientEmail);
    else if (email) fields.recipientEmail = email;
  }
  const handover = readHandoverChoice(formData, bad);
  if (handover) fields.handover = handover;
  if (bad.length) return { ok: false, fields: [...new Set(bad)] };
  return { ok: true, value: { target: target.value, fields } };
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** null = empty; false = present but not an e-mail address. */
function readEmail(formData: FormData): string | null | false {
  const value = (readText(formData, VISA_FIELD.recipientEmail) ?? '').trim();
  if (value === '') return null;
  return value.length >= 3 && value.length <= VISA_LIMITS.email && EMAIL.test(value) ? value : false;
}

/** Set handover / Record handover: a method, or (legacy e-visa) the e-mail, or (legacy refused e-visa) "customer told". */
export function parseHandoverForm(formData: FormData): Parsed<{ target: ApplicationTarget; fields: VisaHandoverFields }> {
  const target = parseApplicationTarget(formData);
  if (!target.ok) return target;
  if (readTick(formData, VISA_FIELD.customerTold)) return { ok: true, value: { target: target.value, fields: { customerTold: true } } };
  if (hasField(formData, VISA_FIELD.recipientEmail) && !hasField(formData, VISA_FIELD.handoverMethod)) {
    const email = readEmail(formData);
    if (!email) return { ok: false, fields: [VISA_FIELD.recipientEmail] };
    return { ok: true, value: { target: target.value, fields: { recipientEmail: email } } };
  }
  const method = readMethod(formData);
  if (!method) return { ok: false, fields: [VISA_FIELD.handoverMethod] };
  const remark = readOptionalText(formData, VISA_FIELD.remark, VISA_LIMITS.remark);
  if (!remark.ok) return { ok: false, fields: [VISA_FIELD.remark] };
  if (method === 'courier') {
    const courier = readOptionalText(formData, VISA_FIELD.courierNumber, VISA_LIMITS.courierNumber);
    if (!courier.ok || !courier.value) return { ok: false, fields: [VISA_FIELD.courierNumber] };
    return { ok: true, value: { target: target.value, fields: { method, courierNumber: courier.value, remark: remark.value } } };
  }
  return { ok: true, value: { target: target.value, fields: { method, remark: remark.value } } };
}

export function parseDeliveredForm(formData: FormData): Parsed<{ target: ApplicationTarget; fields: { deliveredOn: string; remark: string | null } }> {
  const target = parseApplicationTarget(formData);
  if (!target.ok) return target;
  const deliveredOn = parseVisaDate(readText(formData, VISA_FIELD.deliveredOn));
  const remark = readOptionalText(formData, VISA_FIELD.remark, VISA_LIMITS.remark);
  const bad: string[] = [];
  // A date after today is the database's rule (delivered_date_in_future with the frozen wording).
  if (!deliveredOn) bad.push(VISA_FIELD.deliveredOn);
  if (!remark.ok) bad.push(VISA_FIELD.remark);
  if (bad.length) return { ok: false, fields: bad };
  return { ok: true, value: { target: target.value, fields: { deliveredOn: deliveredOn!, remark: remark.value } } };
}

export function parseWithdrawForm(formData: FormData): Parsed<{ target: ApplicationTarget; fields: VisaWithdrawFields }> {
  const target = parseApplicationTarget(formData);
  if (!target.ok) return target;
  const bad: string[] = [];
  const reason = readOptionalText(formData, VISA_FIELD.reason, VISA_LIMITS.reasonMax, VISA_LIMITS.reasonMin);
  if (!reason.ok || !reason.value) bad.push(VISA_FIELD.reason);
  if (!readTick(formData, VISA_FIELD.customerInformed)) bad.push(VISA_FIELD.customerInformed);
  const handover = readHandoverChoice(formData, bad);
  if (bad.length) return { ok: false, fields: [...new Set(bad)] };
  const fields: VisaWithdrawFields = { reason: reason.value!, customerInformed: true };
  if (handover) fields.handover = handover;
  return { ok: true, value: { target: target.value, fields } };
}

// ---------------------------------------------------------------------------
// C12 fee send
// ---------------------------------------------------------------------------

export function parseFeeSendForm(
  formData: FormData,
): Parsed<{ taskId: string; dealId: string | null; entryId: string; expectedRowVersion: number; requestId: string; fields: VisaFeeSendFields }> {
  const taskId = readUuid(formData, VISA_FIELD.taskId);
  const entryId = readUuid(formData, VISA_FIELD.entryId);
  const expectedRowVersion = readPositiveInt(formData, VISA_FIELD.expectedRowVersion);
  const requestId = readRequestId(formData);
  const head = missingOf({
    [VISA_FIELD.taskId]: taskId,
    [VISA_FIELD.entryId]: entryId,
    [VISA_FIELD.expectedRowVersion]: expectedRowVersion,
    [VISA_FIELD.requestId]: requestId,
  });
  if (head.length) return { ok: false, fields: head };
  const bad: string[] = [];
  const amountPaise = rupeesToPaise(readText(formData, VISA_FIELD.amount));
  if (!amountPaise) bad.push(VISA_FIELD.amount);
  const receipt = readOptionalUuid(formData, VISA_FIELD.receiptEvidenceId);
  if (!receipt.ok) bad.push(VISA_FIELD.receiptEvidenceId);
  const remark = readOptionalText(formData, VISA_FIELD.remark, VISA_LIMITS.remark);
  if (!remark.ok) bad.push(VISA_FIELD.remark);
  if (bad.length) return { ok: false, fields: bad };
  return {
    ok: true,
    value: {
      taskId: taskId!, dealId: readUuid(formData, VISA_FIELD.dealId), entryId: entryId!, expectedRowVersion: expectedRowVersion!, requestId: requestId!,
      fields: { amountPaise: amountPaise!, receiptEvidenceId: receipt.value, remark: remark.value },
    },
  };
}

// ---------------------------------------------------------------------------
// Section 16: other visa cost of one passenger (department_cost_save)
// ---------------------------------------------------------------------------

/**
 * Fields taskId, applicationId, entryId ('' = new), expectedRowVersion (0 or
 * absent for a new one), amount (rupees), paidBy, paymentMode (required when
 * company), paidOn (YYYY-MM-DD), reference?, receiptEvidenceId?, requestId.
 */
export function parseOtherCostForm(
  formData: FormData,
): Parsed<{ taskId: string; dealId: string | null; entryId: string | null; expectedRowVersion: number; requestId: string; fields: VisaOtherCostFields }> {
  const bad: string[] = [];
  const taskId = readUuid(formData, VISA_FIELD.taskId);
  const applicationId = readUuid(formData, VISA_FIELD.applicationId);
  const entry = readOptionalUuid(formData, VISA_FIELD.entryId);
  const versionRaw = (readText(formData, VISA_FIELD.expectedRowVersion) ?? '').trim();
  const expectedRowVersion = versionRaw === '' ? (entry.value ? null : 0) : /^[0-9]{1,9}$/.test(versionRaw) ? Number(versionRaw) : null;
  const requestId = readRequestId(formData);
  if (!taskId) bad.push(VISA_FIELD.taskId);
  if (!applicationId) bad.push(VISA_FIELD.applicationId);
  if (!entry.ok) bad.push(VISA_FIELD.entryId);
  if (expectedRowVersion === null || (entry.value && expectedRowVersion < 1)) bad.push(VISA_FIELD.expectedRowVersion);
  if (!requestId) bad.push(VISA_FIELD.requestId);
  const amountPaise = rupeesToPaise(readText(formData, VISA_FIELD.amount));
  if (!amountPaise) bad.push(VISA_FIELD.amount);
  const paidBy = (readText(formData, VISA_FIELD.paidBy) ?? '').trim();
  if (paidBy !== 'company' && paidBy !== 'customer_direct') bad.push(VISA_FIELD.paidBy);
  const modeRaw = (readText(formData, VISA_FIELD.paymentMode) ?? '').trim();
  const mode = modeRaw === 'bank_transfer' || modeRaw === 'upi' || modeRaw === 'card' || modeRaw === 'cash' || modeRaw === 'other' ? modeRaw : null;
  if ((modeRaw !== '' && !mode) || (paidBy === 'company' && !mode)) bad.push(VISA_FIELD.paymentMode);
  const paidOn = parseVisaDate(readText(formData, VISA_FIELD.paidOn));
  if (!paidOn) bad.push(VISA_FIELD.paidOn);
  const reference = readOptionalText(formData, VISA_FIELD.reference, VISA_LIMITS.reference);
  if (!reference.ok) bad.push(VISA_FIELD.reference);
  const receipt = readOptionalUuid(formData, VISA_FIELD.receiptEvidenceId);
  if (!receipt.ok) bad.push(VISA_FIELD.receiptEvidenceId);
  if (bad.length) return { ok: false, fields: [...new Set(bad)] };
  return {
    ok: true,
    value: {
      taskId: taskId!, dealId: readUuid(formData, VISA_FIELD.dealId), entryId: entry.value, expectedRowVersion: expectedRowVersion!, requestId: requestId!,
      fields: {
        applicationId: applicationId!, amountPaise: amountPaise!, paidBy: paidBy as 'company' | 'customer_direct', paymentMode: mode,
        paidOn: paidOn!, reference: reference.value, receiptEvidenceId: receipt.value,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Database hints -> screen fields
// ---------------------------------------------------------------------------

/**
 * Database hint keys use the command's names ("applicants[1].governmentFeePaise",
 * "applicants[2]:documents_missing", "documents", "outcomeEvidenceId"); the
 * screens use the form names above. Applicant tokens become "applicants[i]".
 */
const HINT_TO_FIELD: Readonly<Record<string, string>> = {
  governmentFeePaise: 'governmentFee',
  serviceFeePaise: 'serviceFee',
  amountPaise: VISA_FIELD.amount,
  documents: VISA_FIELD.documentIds,
  customerInformed: VISA_FIELD.customerInformed,
  method: VISA_FIELD.handoverMethod,
  'handover.method': VISA_FIELD.handoverMethod,
  'handover.courierNumber': VISA_FIELD.courierNumber,
  applicants: VISA_FIELD.applicantCount,
};

export function visaFieldsFromHint(keys: readonly string[]): string[] {
  const out = keys.map((key) => {
    const [base] = key.split(':') as [string];
    const m = /^applicants\[(\d+)\](?:\.(.+))?$/.exec(base);
    if (m) return m[2] ? `applicants[${m[1]}].${HINT_TO_FIELD[m[2]] ?? m[2]}` : `applicants[${m[1]}]`;
    return HINT_TO_FIELD[base] ?? base.replace(/\[\d+\].*$/, '');
  });
  return [...new Set(out)];
}

/** The notReady token of a not_ready hint ("applicants[2]:documents_missing" -> "documents_missing"). */
export function notReadyTokenFromHint(keys: readonly string[]): string | null {
  for (const key of keys) {
    const token = key.split(':')[1];
    if (token) return token;
  }
  return null;
}
