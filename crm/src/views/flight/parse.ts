/*
 * Typing helpers for the Flight forms (contract section 10, forms.ts). The
 * server re-validates everything; these only turn what staff type into the
 * stored shape so the screen can show it back before sending. Kept pure so
 * the server module can share or replace them.
 */

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function iso(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** "2 Dec 26", "2 dec 2026", "2/12/26", "2-12-2026", "2026-12-02" → "2026-12-02"; null when not a real date. */
export function parseFlightDate(input: string): string | null {
  const s = input.trim().toLowerCase();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(s);
  if (m) return iso(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{1,2})\s+([a-z]{3})[a-z]*\.?\s+(\d{2}|\d{4})$/.exec(s);
  if (m && MONTHS[m[2]!]) return iso(Number(m[3]), MONTHS[m[2]!]!, Number(m[1]));
  return null;
}

/** "1035", "10:35", "7:05 pm", "07:05 PM" → "HH:MM"; null otherwise. Input boxes allow 8 characters. */
export function parseFlightTime(input: string): string | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, ' ');
  const m = /^(\d{1,2}):?(\d{2})\s?(am|pm)?$/.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    if (m[3] === 'pm' && h !== 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
  }
  if (h > 23) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export const TIME_MAX_LENGTH = 8;

/** Every 5 minutes, for the time boxes' suggestion list. */
export const TIME_OPTIONS: string[] = Array.from({ length: 288 }, (_, i) => `${String(Math.floor(i / 12)).padStart(2, '0')}:${String((i % 12) * 5).padStart(2, '0')}`);

/** Arrival date: the departure date, or the next day when the arrival time is earlier than departure. */
export function autoArrivalDate(departDate: string | null, departTime: string | null, arriveTime: string | null): string | null {
  if (!departDate) return null;
  if (departTime && arriveTime && arriveTime < departTime) {
    const d = new Date(`${departDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  return departDate;
}

export function normalizePnr(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, '');
}
export const PNR_PATTERN = /^[A-Z0-9]{5,8}$/;

export function normalizeTicketNumber(input: string): string {
  return input.trim().replace(/\s+/g, '');
}
export const TICKET_PATTERN = /^[0-9](?!.*--)[0-9-]{4,18}[0-9]$/;

/** Next ticket number: last run of digits + 1, padding kept ("176-2410394501" → "176-2410394502"). */
export function nextTicketNumber(input: string): string | null {
  const s = normalizeTicketNumber(input);
  const m = /^(.*?)(\d+)$/.exec(s);
  if (!m) return null;
  const digits = m[2]!;
  const next = (BigInt(digits) + 1n).toString().padStart(digits.length, '0');
  return `${m[1]}${next}`;
}

/** Full start and end numbers: "176-2410394501 – 176-2410394508". */
export function ticketRangeText(numbers: string[]): string {
  const list = [...new Set(numbers.filter(Boolean))];
  if (list.length === 0) return '—';
  if (list.length === 1) return list[0]!;
  return `${list[0]} – ${list[list.length - 1]}`;
}

/** Rupees text → whole paise string ("16,800.50" → "1680050"); null when invalid or negative. */
export function rupeesToPaise(input: string): string | null {
  const s = input.replace(/[,\s₹]/g, '');
  if (s === '') return '0';
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return (BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'))).toString();
}

export function paiseToRupeesText(paise: string | null | undefined): string {
  if (!paise) return '';
  const v = BigInt(paise);
  const r = v / 100n;
  const p = v % 100n;
  return p === 0n ? r.toString() : `${r}.${p.toString().padStart(2, '0')}`;
}
