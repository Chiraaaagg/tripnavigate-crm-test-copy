/*
 * One rule for a rupee amount typed by staff (owner decision D4, 17 November
 * 2026). It is the Book now rule, moved here unchanged so that every money box
 * reads typed text the same way. Pure: no React, no server imports, so client
 * components and server actions share it. No floating point anywhere.
 *
 * Accepted: digits, optional comma grouping between digit groups (Indian
 * "12,50,000" or western "1,250,000"), at most two decimals, spaces only
 * around the amount.
 * Refused: a rupee sign ("₹100"), spaces inside, odd commas ("1,2,3", ",100"),
 * an exponent ("1e3"), more than two decimals ("1.001"), a minus sign (unless
 * `signed`), and anything above the largest allowed amount.
 *
 * Each screen keeps its own largest amount, its own meaning of an empty box and
 * its own refusal sentence; those live in the screen's own small wrapper.
 */

/** Book now's largest single amount: ₹999,999,999.99 (equals PRICE_AMOUNT_MAX_PAISE). */
export const DEFAULT_MAX_PAISE = 99_999_999_999n;

/** The largest amount with `wholeDigits` rupee digits and two paise digits (12 -> ₹999,999,999,999.99). */
export function maxPaiseForDigits(wholeDigits: number): bigint {
  return 10n ** BigInt(wholeDigits + 2) - 1n;
}

/** Commas only between digit groups, never leading, trailing or doubled. */
const GROUPED = /^\d{1,3}(,\d{2,3})*(\.\d{1,2})?$/;

/**
 * Rupees typed by staff -> whole paise as a decimal string.
 *   ''              -> null (missing, never zero)
 *   '1,234.56'      -> '123456' (Indian or western comma grouping allowed)
 *   invalid or over -> undefined ("1.001", "-1", "1e3", "₹100", over the cap)
 * `signed` allows a leading minus (a derived markup only). `max` is in paise.
 */
export function rupeesToPaise(text: string | null | undefined, opts: { signed?: boolean; max?: bigint } = {}): string | null | undefined {
  const raw = String(text ?? '').trim();
  if (raw === '') return null;
  const max = opts.max ?? DEFAULT_MAX_PAISE;
  let t = raw;
  let negative = false;
  if (opts.signed && t.startsWith('-')) {
    negative = true;
    t = t.slice(1).trim();
  }
  if (/,/.test(t)) {
    if (!GROUPED.test(t)) return undefined;
    t = t.replace(/,/g, '');
  }
  // At least 13 rupee digits, as Book now always allowed (leading zeros included);
  // more only when a screen's own maximum needs them.
  const wholeDigits = Math.max(13, (max / 100n).toString().length);
  const m = new RegExp(`^(\\d{1,${wholeDigits}})(?:\\.(\\d{1,2}))?$`).exec(t);
  if (!m) return undefined;
  const paise = BigInt(m[1] ?? '0') * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
  if (paise > max) return undefined;
  if (negative && paise === 0n) return '0';
  return (negative ? -paise : paise).toString();
}
