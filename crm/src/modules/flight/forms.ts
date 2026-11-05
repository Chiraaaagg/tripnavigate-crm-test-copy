import { z } from 'zod';
import { FLIGHT_FIELD } from './contracts';

/**
 * Pure helpers shared by the Flight screens and the server actions (Flight
 * build contract, section 10): date and time parsers, PNR and ticket number
 * normalizers, next ticket number, ticket range text, the automatic arrival
 * date and the carrier prefix, plus the FormData readers of the actions.
 * The database validates everything again; these only help people type.
 */

// ---------------------------------------------------------------------------
// Dates and times
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

function isoFromParts(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const fullYear = (y: string): number => (y.length === 2 ? 2000 + Number(y) : Number(y));

/**
 * "2 Dec 26", "2 dec 2026", "2/12/26", "2-12-2026", "2026-12-02" -> "2026-12-02".
 * Day first; a two-digit year is 20yy; impossible dates are null.
 */
export function parseFlightDate(input: string | null | undefined): string | null {
  const value = (input ?? '').trim();
  if (value === '' || value.length > 20) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (m) return isoFromParts(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(value);
  if (m) return isoFromParts(fullYear(m[3]!), Number(m[2]), Number(m[1]));
  m = /^(\d{1,2})[\s-]+([A-Za-z]{3,9})\.?[\s-]+(\d{2}|\d{4})$/.exec(value);
  if (m) {
    const month = MONTHS[m[2]!.toLowerCase()];
    return month ? isoFromParts(fullYear(m[3]!), month, Number(m[1])) : null;
  }
  return null;
}

/** "1035", "10:35", "7:05 pm", "07:05 PM" -> "HH:MM" (24 h). At most 8 characters. */
export function parseFlightTime(input: string | null | undefined): string | null {
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
    if (meridiem === 'a') hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  } else if (hour > 23) {
    return null;
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Arrival date when none is typed: the departure date, or the next day when the arrival time is earlier. */
export function autoArrivalDate(departDate: string, departTime: string | null, arriveTime: string | null): string {
  if (!departTime || !arriveTime || arriveTime >= departTime) return departDate;
  const [y, mo, d] = departDate.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  return next.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// PNRs, ticket numbers, carriers
// ---------------------------------------------------------------------------

export const PNR_PATTERN = /^[A-Z0-9]{5,8}$/;
export const TICKET_NUMBER_PATTERN = /^[0-9][0-9-]{4,18}[0-9]$/;

export function normalizePnr(input: string | null | undefined): string {
  return (input ?? '').trim().toUpperCase();
}

/** Trimmed, spaces removed; dashes kept. */
export function normalizeTicketNumber(input: string | null | undefined): string {
  return (input ?? '').replace(/\s+/g, '');
}

/** Valid ticket number after normalization: digits and single dashes, 6..20 digits. */
export function isTicketNumber(input: string): boolean {
  const value = normalizeTicketNumber(input);
  const digits = value.replace(/-/g, '');
  return TICKET_NUMBER_PATTERN.test(value) && !value.includes('--') && digits.length >= 6 && digits.length <= 20;
}

/** The next ticket number: the last digit run + 1, padding and prefix kept (BigInt, no float rounding). */
export function nextTicketNumber(ticket: string): string {
  const value = normalizeTicketNumber(ticket);
  const m = /(\d+)(\D*)$/.exec(value);
  if (!m) return value;
  const run = m[1]!;
  const next = (BigInt(run) + 1n).toString().padStart(run.length, '0');
  return value.slice(0, m.index) + next + m[2]!;
}

/** "176-2410394501 – 176-2410394508": full start and end numbers (one number when equal). */
export function ticketRangeText(first: string, last: string): string {
  return first === last ? first : `${first} – ${last}`;
}

/** The 2-character IATA prefix of a flight number ("AI 470" -> "AI", "6E211" -> "6E"); null for a bare number. */
export function carrierFromFlightNo(flightNo: string | null | undefined): string | null {
  const m = /^([A-Z0-9]{2})\s?\d{1,4}[A-Z]?$/.exec((flightNo ?? '').trim().toUpperCase());
  if (!m || !/[A-Z]/.test(m[1]!)) return null;
  return m[1]!;
}

/** "AI 470" shown once with its carrier (never "AI AI 470"). */
export function flightNoText(airlineCode: string | null, flightNo: string | null): string {
  const no = (flightNo ?? '').trim();
  if (!airlineCode || carrierFromFlightNo(no) === airlineCode.toUpperCase()) return no;
  return no ? `${airlineCode} ${no}` : airlineCode;
}

// ---------------------------------------------------------------------------
// FormData readers (server actions)
// ---------------------------------------------------------------------------

const UUID = z.uuid();

export function readText(formData: FormData, field: string): string | null {
  const raw = formData.get(field);
  return typeof raw === 'string' ? raw : null;
}

export function readUuid(formData: FormData, field: string): string | null {
  const parsed = UUID.safeParse((readText(formData, field) ?? '').trim());
  return parsed.success ? parsed.data : null;
}

export function readPositiveInt(formData: FormData, field: string): number | null {
  const raw = (readText(formData, field) ?? '').trim();
  if (!/^[0-9]{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 ? n : null;
}

export function readRequestId(formData: FormData): string | null {
  return readUuid(formData, FLIGHT_FIELD.requestId);
}

/** Trimmed reason, or null when empty (the database checks the length). */
export function readReason(formData: FormData): string | null {
  const value = (readText(formData, FLIGHT_FIELD.reason) ?? '').trim();
  return value === '' ? null : value.slice(0, 600);
}

/** The JSON `payload` field (structured arguments); null when missing or not JSON. */
export function readPayload(formData: FormData): unknown {
  const raw = readText(formData, FLIGHT_FIELD.payload);
  if (raw === null || raw.length > 200_000) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function readPayloadObject(formData: FormData): Record<string, unknown> | null {
  const value = readPayload(formData);
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function readPayloadArray(formData: FormData): unknown[] | null {
  const value = readPayload(formData);
  return Array.isArray(value) ? value : null;
}

/** Comma- or JSON-listed task ids (expectedTaskIds). */
export function readUuidList(formData: FormData, field: string): string[] | null {
  const raw = (readText(formData, field) ?? '').trim();
  if (raw === '') return null;
  let items: unknown;
  try {
    items = raw.startsWith('[') ? JSON.parse(raw) : raw.split(',');
  } catch {
    return null;
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > 40) return null;
  const ids = items.map((v) => UUID.safeParse(typeof v === 'string' ? v.trim() : v));
  return ids.every((p) => p.success) ? ids.map((p) => p.data as string) : null;
}

export function readDecision(formData: FormData): 'approve' | 'reject' | null {
  const value = readText(formData, FLIGHT_FIELD.decision);
  return value === 'approve' || value === 'reject' ? value : null;
}
