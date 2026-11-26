/*
 * One date and count formatter for the redesign (CQ-12). Dates read the same
 * on every screen: "6 Nov 2026", short form "6 Nov", ranges "6–9 Nov 2026".
 * Business days are Indian Standard Time (Asia/Kolkata): a timestamp is shown
 * on the IST calendar day it falls on; a plain date ("2026-11-06") is shown
 * as written, never shifted. Unreadable or missing input shows a dash.
 *
 * Month names are a fixed table (not Intl), because en-IN writes "Sept" and
 * the design writes "Sep".
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** Shown for a missing or unreadable date. */
export const NO_DATE = '—';

/** No-break space: keeps "6 Nov 2026" and a range on one line. */
const NBSP = '\u00a0';
/** Word joiner: a line may break after an en dash; this forbids it (no inline style needed). */
const WJ = '\u2060';

const IST_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export type DateInput = string | Date | null | undefined;

interface Day {
  y: number;
  m: number; // 1 to 12
  d: number;
}

/** The IST calendar day of the input, or null when it cannot be read. */
function toDay(input: DateInput): Day | null {
  if (input == null || input === '') return null;
  if (typeof input === 'string') {
    const plain = DATE_ONLY.exec(input.trim());
    if (plain) return checked(Number(plain[1]), Number(plain[2]), Number(plain[3]));
  }
  const time = input instanceof Date ? input.getTime() : Date.parse(input);
  if (Number.isNaN(time)) return null;
  const match = DATE_ONLY.exec(IST_DAY.format(time));
  return match ? checked(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

function checked(y: number, m: number, d: number): Day | null {
  if (m < 1 || m > 12 || d < 1) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= last ? { y, m, d } : null;
}

const mon = (day: Day) => MONTHS[day.m - 1]!;

/** "6 Nov 2026". Plain dates are shown as written; timestamps on their IST day. */
export function dayText(input: DateInput): string {
  const day = toDay(input);
  return day ? `${day.d} ${mon(day)} ${day.y}` : NO_DATE;
}

/** "6 Nov" (no year), for rows where the year is obvious. */
export function shortDate(input: DateInput): string {
  const day = toDay(input);
  return day ? `${day.d} ${mon(day)}` : NO_DATE;
}

/**
 * A date range that never wraps: "6–9 Nov 2026", "28 Nov – 2 Dec 2026",
 * "28 Dec 2026 – 2 Jan 2027". One known end shows that end alone; the same
 * day twice shows the day once. Spaces are no-break spaces and a word joiner
 * (U+2060) follows the dash, so no break opportunity remains anywhere.
 */
export function dateRangeText(from: DateInput, to: DateInput): string {
  const a = toDay(from);
  const b = toDay(to);
  let text: string;
  if (!a && !b) return NO_DATE;
  if (!a || !b) text = dayText((a ? from : to) as DateInput);
  else if (a.y === b.y && a.m === b.m && a.d === b.d) text = dayText(from);
  else if (a.y === b.y && a.m === b.m) text = `${a.d}–${b.d} ${mon(b)} ${b.y}`;
  else if (a.y === b.y) text = `${a.d} ${mon(a)} – ${b.d} ${mon(b)} ${b.y}`;
  else text = `${a.d} ${mon(a)} ${a.y} – ${b.d} ${mon(b)} ${b.y}`;
  return text.replace(/ /g, NBSP).replace(/–/g, `–${WJ}`);
}

/** Today's IST calendar day as YYYY-MM-DD (for "due today" and "overdue" comparisons). */
export function todayIst(now: Date = new Date()): string {
  return IST_DAY.format(now);
}

const COUNT = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/**
 * "1 receipt", "2 receipts", "1,250 receipts" (Indian grouping). Give the
 * plural when it is not the singular plus "s": plural(3, 'entry', 'entries').
 */
export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${COUNT.format(n)} ${n === 1 ? one : many}`;
}
