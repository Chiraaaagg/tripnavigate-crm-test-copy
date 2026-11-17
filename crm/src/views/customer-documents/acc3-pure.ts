/*
 * Accounts phase 3 pure helpers for the automatic bills, Settings › Accounts
 * and daily check screens (track U). No React, no server code: unit-tested
 * in tests/unit/acc3u-bills-*.test.ts.
 */

/** Write-off limit ceiling (contract 6.1: 1..500000 paise = ₹5,000). */
export const WRITE_OFF_LIMIT_MAX_PAISE = 500000n;

/** Whole paise as a plain rupee text for an input ("500000" -> "5000", "123456" -> "1234.56"). Null for anything that is not whole paise. */
export function rupeesInputText(paise: string | null | undefined): string | null {
  if (paise === null || paise === undefined || !/^[0-9]{1,15}$/.test(paise)) return null;
  const p = BigInt(paise);
  const rupees = p / 100n;
  const rest = p % 100n;
  return rest === 0n ? rupees.toString() : `${rupees.toString()}.${rest.toString().padStart(2, '0')}`;
}

/**
 * The automatic-release switch as a person reads it: the stored value, and
 * whether it has any effect now (contract 6.1: only while customer documents
 * and automatic drafts are both on).
 */
export function releaseEffect(s: { documents: boolean | null; drafts: boolean | null; release: boolean | null }): 'unknown' | 'active' | 'no_effect' | 'off' {
  if (s.release === null) return 'unknown';
  if (!s.release) return 'off';
  return s.documents === true && s.drafts === true ? 'active' : 'no_effect';
}

/** Age of the oldest waiting customer message in words ("none waiting", "12 minutes", "2 h 05 min", "1 day 3 h"). */
export function queueAgeText(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) return 'none waiting';
  const m = Math.floor(minutes);
  if (m < 60) return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
  if (m < 1440) return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return `${d} ${d === 1 ? 'day' : 'days'}${h ? ` ${h} h` : ''}`;
}

/** A waiting queue older than this many minutes reads as late (the timer health rule, contract 5.2). */
export const QUEUE_LATE_MINUTES = 15;
