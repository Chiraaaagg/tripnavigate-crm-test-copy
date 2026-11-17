import { formatPaise } from '@/modules/deals/dto';

/*
 * Display and input helpers for the Visa screens. Pure and server-safe.
 * Dates are calendar dates ('YYYY-MM-DD', no time zone shift); times stay as
 * typed ('HH:MM', IST). Money is whole paise as decimal strings, never a float.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-11-14' → '14 Nov 2026'. */
export function dayText(iso: string | null | undefined, empty = 'Not set'): string {
  if (!iso) return empty;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** '2026-11-14' + '10:30' → '14 Nov 2026, 10:30 am'. */
export function whenText(date: string | null | undefined, time: string | null | undefined, empty = 'Not set'): string {
  if (!date) return empty;
  if (!time) return dayText(date);
  const [h, mm] = time.split(':').map(Number);
  if (h === undefined || mm === undefined || Number.isNaN(h) || Number.isNaN(mm)) return `${dayText(date)}, ${time}`;
  const am = h < 12;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${dayText(date)}, ${h12}:${String(mm).padStart(2, '0')} ${am ? 'am' : 'pm'}`;
}

export function inr(paise: string | null | undefined, empty = '—'): string {
  if (paise === null || paise === undefined || paise === '') return empty;
  try {
    return formatPaise(paise);
  } catch {
    return empty;
  }
}

/** Sum of paise strings (bigint, exact). */
export function sumPaise(values: Array<string | null | undefined>): string {
  let total = 0n;
  for (const v of values) {
    if (!v) continue;
    try {
      total += BigInt(v);
    } catch {
      /* not a number: skipped */
    }
  }
  return total.toString();
}

/**
 * Rupees text → whole paise ("6,300" → "630000", "₹ 1,250.50" → "125050").
 * Strips commas, spaces and ₹; at most two decimals; more than zero.
 * Returns null when the text is not a valid amount.
 */
export function rupeesToPaise(text: string): string | null {
  const t = text.replace(/[,\s₹]/g, '');
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const paise = BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
  return paise > 0n ? paise.toString() : null;
}

/** Paise → rupees text for an input ("630000" → "6300", "125050" → "1250.50"). */
export function paiseToRupeesText(paise: string | null | undefined): string {
  if (!paise) return '';
  try {
    const v = BigInt(paise);
    const r = v / 100n;
    const p = v % 100n;
    return p === 0n ? r.toString() : `${r}.${p.toString().padStart(2, '0')}`;
  } catch {
    return '';
  }
}

/** Today in India ('YYYY-MM-DD'); the server's authz.finance_today() decides. */
export function todayIst(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Passport number as the server stores it: upper case, no spaces or dashes. */
export function normalisePassport(text: string): string {
  return text.toUpperCase().replace(/[\s-]+/g, '');
}

export const PASSPORT_PATTERN = /^[A-Z0-9]{6,15}$/;
export const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** Label key as the database computes it (contract 4): trimmed, single spaces, lower case. */
export function labelKey(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** File rules shared with department_evidence_begin: PDF/JPG/PNG/WebP up to 4 MB. */
export const FILE_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp';
export const FILE_HINT = 'PDF, JPG, PNG or WebP, up to 4 MB.';
export function fileProblem(file: File | null | undefined, required: boolean): string | null {
  if (!file) return required ? 'Choose the file.' : null;
  if (!/\.(pdf|jpe?g|png|webp)$/i.test(file.name)) return 'Choose a PDF, JPG, PNG or WebP file.';
  if (file.size > 4 * 1024 * 1024) return 'This file is larger than 4 MB. Choose a smaller file.';
  if (file.size === 0) return 'This file is empty. Choose another file.';
  return null;
}
