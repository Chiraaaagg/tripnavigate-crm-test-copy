/**
 * B1.2 (DEC-36), migration 20261120000400: the read-only Bitrix values the sync
 * stores when integration_intake_config.bitrix_trip_facts_read is on.
 *
 * Exactly the owner-named fields (codes confirmed by crm.*.fields metadata on
 * 12 October 2026, docs/implementation/frontend-first-plan-2026-10-10/b1.2/
 * phase-a-bitrix-and-engines.md section 2.0) plus the linked Contact / Company
 * name, phone and e-mail. Never a file field, passport, birth date, address,
 * adult/child split, budget or destination.
 *
 * Pure functions: they normalise a provider answer into the shapes the
 * database commands accept and record an issue CODE (never the value) for a
 * value they cannot read. The database re-checks every key.
 */

/** Deal custom fields (DEC-36). "Booking Note" (integer, UF_CRM_1784372510) is NOT Booking Notes. */
export const DEAL_TRIP_FACT_CODES = {
  bookingNotes: 'UF_CRM_1784359625',
  travellerTotal: 'UF_CRM_68A83F91534CA',
  tourStart: 'UF_CRM_1763180657',
  tourEnd: 'UF_CRM_68A83F9189BC9',
  customerType: 'UF_CRM_69203B670C550',
} as const;

/** Lead Customer Type (the only DEC-36 trip field a Lead has). */
export const LEAD_CUSTOMER_TYPE_CODE = 'UF_CRM_1761567338034';

const LINK_FIELDS = ['CONTACT_ID', 'CONTACT_IDS', 'COMPANY_ID'] as const;

/** Extra Deal fields selected from crm.deal.list when the switch is on (crm.deal.get returns them anyway). */
export const DEAL_TRIP_FACT_FIELDS: readonly string[] = [...Object.values(DEAL_TRIP_FACT_CODES), ...LINK_FIELDS];

/** Lead fields kept from the crm.lead.get answer when the switch is on (everything else is dropped). */
export const LEAD_FACT_FIELDS = [LEAD_CUSTOMER_TYPE_CODE, ...LINK_FIELDS, 'COMPANY_TITLE', 'DATE_MODIFY'] as const;
export type LeadFactField = (typeof LEAD_FACT_FIELDS)[number];

/** crm.contact.get / crm.company.get answers are reduced to these keys immediately. */
export const CONTACT_BASIC_FIELDS = ['ID', 'NAME', 'SECOND_NAME', 'LAST_NAME', 'PHONE', 'EMAIL', 'DATE_MODIFY'] as const;
export const COMPANY_BASIC_FIELDS = ['ID', 'TITLE', 'PHONE', 'EMAIL', 'DATE_MODIFY'] as const;
export type ContactBasicField = (typeof CONTACT_BASIC_FIELDS)[number];
export type CompanyBasicField = (typeof COMPANY_BASIC_FIELDS)[number];

/** Same list as authz.trip_fact_issue_codes() in the migration. */
export const TRIP_FACT_ISSUES = [
  'travellers_not_whole',
  'travellers_out_of_range',
  'tour_start_unreadable',
  'tour_end_unreadable',
  'tour_end_before_start',
  'booking_notes_truncated',
  'customer_type_unreadable',
  'contact_ids_truncated',
  'company_title_truncated',
  // Bitrix DATE_MODIFY unusable: values kept for the version the apply stored.
  'date_modify_unreadable',
] as const;
export type TripFactIssue = (typeof TRIP_FACT_ISSUES)[number];

export const BOOKING_NOTES_MAX = 4000;
export const COMPANY_TITLE_MAX = 200;
export const PARTY_NAME_MAX = 200;
export const MAX_CONTACT_IDS = 20;
export const MAX_PARTY_VALUES = 5;

export interface DealTripFacts {
  /** Null when Bitrix DATE_MODIFY is unusable (issue date_modify_unreadable). */
  dateModify: string | null;
  bookingNotes: string | null;
  travellerTotal: number | null;
  tourStart: string | null;
  tourEnd: string | null;
  customerTypeId: string | null;
  contactId: string | null;
  contactIds: string[];
  companyId: string | null;
  issues: TripFactIssue[];
}

export interface LeadSourceFacts {
  dateModify: string | null;
  customerTypeId: string | null;
  contactId: string | null;
  contactIds: string[];
  companyId: string | null;
  companyTitle: string | null;
  issues: TripFactIssue[];
}

export type PartyKind = 'contact' | 'company';

export interface PartySnapshot {
  kind: PartyKind;
  id: string;
  dateModify: string | null;
  name: string | null;
  phones: string[];
  emails: string[];
}

const ID = /^[1-9][0-9]{0,17}$/;
const ENUM_ID = /^[1-9][0-9]{0,9}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})$/;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const CONTROL_AND_BREAKS = /[\u0000-\u001F\u007F]+/g;
const PHONE = /^[0-9+() .-]{3,40}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function text(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** A Bitrix id, or null for absent / '' / '0' / anything that is not a positive whole number. */
export function toBitrixId(value: unknown): string | null {
  const t = text(value)?.trim() ?? '';
  return ID.test(t) ? t : null;
}

/** DATE_MODIFY as Bitrix sends it, or '' when unusable. */
export function toIsoOrEmpty(value: unknown): string {
  const t = text(value)?.trim() ?? '';
  return ISO.test(t) ? t : '';
}

/** Bitrix date fields arrive as ISO date-time in the portal's zone; the calendar date is the first 10 characters. */
export function toCalendarDate(value: unknown): { date: string | null; unreadable: boolean } {
  const t = text(value)?.trim() ?? '';
  if (t === '') return { date: null, unreadable: false };
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(t);
  if (!m) return { date: null, unreadable: true };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d || y < 2000 || y > 2100) {
    return { date: null, unreadable: true };
  }
  return { date: `${m[1]}-${m[2]}-${m[3]}`, unreadable: false };
}

/** "Total Number of Travelers" is a Bitrix double ("2.00"): whole numbers 0-100 only. */
export function toTravellerTotal(value: unknown): { total: number | null; issue: TripFactIssue | null } {
  const t = text(value)?.trim() ?? '';
  if (t === '') return { total: null, issue: null };
  if (!/^\d{1,6}(\.\d+)?$/.test(t)) return { total: null, issue: 'travellers_not_whole' };
  const n = Number(t);
  if (!Number.isInteger(n)) return { total: null, issue: 'travellers_not_whole' };
  if (n > 100) return { total: null, issue: 'travellers_out_of_range' };
  return { total: n, issue: null };
}

/** Free text: control characters removed (line breaks kept), trimmed, cut to `max`. */
export function toFreeText(value: unknown, max: number): { value: string | null; truncated: boolean } {
  const t = (text(value) ?? '').replace(CONTROL, '').trim();
  if (t === '') return { value: null, truncated: false };
  if (t.length <= max) return { value: t, truncated: false };
  return { value: t.slice(0, max).trimEnd(), truncated: true };
}

/** One-line text: every control character and line break becomes a space. */
function toLine(value: unknown, max: number): { value: string | null; truncated: boolean } {
  const t = (text(value) ?? '').replace(CONTROL_AND_BREAKS, ' ').replace(/\s+/g, ' ').trim();
  if (t === '') return { value: null, truncated: false };
  return t.length <= max ? { value: t, truncated: false } : { value: t.slice(0, max).trimEnd(), truncated: true };
}

function toEnumId(value: unknown): { id: string | null; unreadable: boolean } {
  const t = text(value)?.trim() ?? '';
  if (t === '') return { id: null, unreadable: false };
  return ENUM_ID.test(t) ? { id: t, unreadable: false } : { id: null, unreadable: true };
}

function toContactIds(value: unknown): { ids: string[]; truncated: boolean } {
  const list = Array.isArray(value) ? value : [];
  const ids = [...new Set(list.map(toBitrixId).filter((x): x is string => x !== null))];
  return ids.length > MAX_CONTACT_IDS ? { ids: ids.slice(0, MAX_CONTACT_IDS), truncated: true } : { ids, truncated: false };
}

function links(raw: Record<string, unknown>, issues: TripFactIssue[]) {
  const contacts = toContactIds(raw.CONTACT_IDS);
  if (contacts.truncated) issues.push('contact_ids_truncated');
  return { contactId: toBitrixId(raw.CONTACT_ID), contactIds: contacts.ids, companyId: toBitrixId(raw.COMPANY_ID) };
}

/** From a crm.deal.get record (or a crm.deal.list row selected with DEAL_TRIP_FACT_FIELDS and DATE_MODIFY). */
export function toDealTripFacts(raw: Record<string, unknown>): DealTripFacts {
  const issues: TripFactIssue[] = [];
  const notes = toFreeText(raw[DEAL_TRIP_FACT_CODES.bookingNotes], BOOKING_NOTES_MAX);
  if (notes.truncated) issues.push('booking_notes_truncated');
  const total = toTravellerTotal(raw[DEAL_TRIP_FACT_CODES.travellerTotal]);
  if (total.issue) issues.push(total.issue);
  const start = toCalendarDate(raw[DEAL_TRIP_FACT_CODES.tourStart]);
  if (start.unreadable) issues.push('tour_start_unreadable');
  const end = toCalendarDate(raw[DEAL_TRIP_FACT_CODES.tourEnd]);
  if (end.unreadable) issues.push('tour_end_unreadable');
  // Both dates are kept; the order problem is shown, never "fixed".
  if (start.date && end.date && end.date < start.date) issues.push('tour_end_before_start');
  const type = toEnumId(raw[DEAL_TRIP_FACT_CODES.customerType]);
  if (type.unreadable) issues.push('customer_type_unreadable');
  const dateModify = toIsoOrEmpty(raw.DATE_MODIFY) || null;
  if (dateModify === null) issues.push('date_modify_unreadable');
  return {
    dateModify,
    bookingNotes: notes.value,
    travellerTotal: total.total,
    tourStart: start.date,
    tourEnd: end.date,
    customerTypeId: type.id,
    ...links(raw, issues),
    issues: [...new Set(issues)].sort(),
  };
}

/** From the Lead fact keys kept by the client (LEAD_FACT_FIELDS). */
export function toLeadSourceFacts(raw: Partial<Record<LeadFactField, unknown>>): LeadSourceFacts {
  const issues: TripFactIssue[] = [];
  const type = toEnumId(raw[LEAD_CUSTOMER_TYPE_CODE]);
  if (type.unreadable) issues.push('customer_type_unreadable');
  const title = toLine(raw.COMPANY_TITLE, COMPANY_TITLE_MAX);
  if (title.truncated) issues.push('company_title_truncated');
  const l = links(raw as Record<string, unknown>, issues);
  const dateModify = toIsoOrEmpty(raw.DATE_MODIFY) || null;
  if (dateModify === null) issues.push('date_modify_unreadable');
  return {
    dateModify,
    customerTypeId: type.id,
    ...l,
    companyTitle: title.value,
    issues: [...new Set(issues)].sort(),
  };
}

/** Bitrix multifield (PHONE, EMAIL): [{VALUE, VALUE_TYPE, ...}]. Only VALUE is used. */
function multiValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (v && typeof v === 'object' ? text((v as Record<string, unknown>).VALUE) : null))
    .filter((v): v is string => v !== null)
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

/** Phones as typed when they look like a phone number; at most five. */
export function toPhones(value: unknown): string[] {
  return [...new Set(multiValues(value).filter((v) => PHONE.test(v)))].slice(0, MAX_PARTY_VALUES);
}

/** E-mails lower-cased when they look like an address; at most five. */
export function toEmails(value: unknown): string[] {
  return [...new Set(multiValues(value).map((v) => v.toLowerCase()).filter((v) => v.length <= 254 && EMAIL.test(v)))].slice(
    0,
    MAX_PARTY_VALUES,
  );
}

/** Keeps only the listed keys of a provider answer; everything else is dropped. */
export function pickKeys<K extends string>(raw: Record<string, unknown>, keys: readonly K[]): Partial<Record<K, unknown>> {
  const out: Partial<Record<K, unknown>> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) out[key] = raw[key];
  }
  return out;
}

/** Contact: name = first, second and last name. Null when the id is unusable. */
export function toContactSnapshot(raw: Partial<Record<ContactBasicField, unknown>>): PartySnapshot | null {
  const id = toBitrixId(raw.ID);
  if (!id) return null;
  const name = toLine([raw.NAME, raw.SECOND_NAME, raw.LAST_NAME].map((x) => text(x) ?? '').join(' '), PARTY_NAME_MAX);
  return {
    kind: 'contact',
    id,
    dateModify: toIsoOrEmpty(raw.DATE_MODIFY) || null,
    name: name.value,
    phones: toPhones(raw.PHONE),
    emails: toEmails(raw.EMAIL),
  };
}

/** Company: name = TITLE. Null when the id is unusable. */
export function toCompanySnapshot(raw: Partial<Record<CompanyBasicField, unknown>>): PartySnapshot | null {
  const id = toBitrixId(raw.ID);
  if (!id) return null;
  return {
    kind: 'company',
    id,
    dateModify: toIsoOrEmpty(raw.DATE_MODIFY) || null,
    name: toLine(raw.TITLE, PARTY_NAME_MAX).value,
    phones: toPhones(raw.PHONE),
    emails: toEmails(raw.EMAIL),
  };
}
