import type { RateContractFilter, RateContractStatus, RateLookupNight, RateLookupPrice } from './types';

/*
 * Pure helpers for the rate contract screens (unit-tested in
 * tests/unit/acc3u-rates-format.test.ts). Money is BigInt only: no amount is
 * ever a float. Dates are plain YYYY-MM-DD strings shown without a time zone.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "12345650" -> "₹1,23,456.50" (Indian grouping). Anything else -> "". */
export function inr(paise: string | null | undefined): string {
  if (paise == null || !/^-?\d+$/.test(paise)) return '';
  const negative = paise.startsWith('-');
  const v = BigInt(negative ? paise.slice(1) : paise);
  const rupees = (v / 100n).toString();
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${negative ? '-' : ''}₹${grouped}.${(v % 100n).toString().padStart(2, '0')}`;
}

/** "1,234.5" / "₹ 1234.50" -> "123450"; '' -> null; not a rupee amount -> undefined. */
export function rupeesToPaise(raw: string | null | undefined): string | null | undefined {
  const value = (raw ?? '').trim().replace(/^₹\s*/, '').replace(/[,\s]/g, '');
  if (value === '') return null;
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(value);
  if (!m) return undefined;
  return (BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'))).toString();
}

/** "123450" -> "1234.50" (the value a rupee input starts with). */
export function paiseToRupees(paise: string | null | undefined): string {
  if (paise == null || !/^\d+$/.test(paise)) return '';
  const v = BigInt(paise);
  return `${(v / 100n).toString()}.${(v % 100n).toString().padStart(2, '0')}`;
}

/** "2026-11-05" -> "5 Nov 2026"; anything else is returned as it is. */
export function dateText(iso: string | null | undefined): string {
  if (!iso) return 'Not set';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** "5 Nov 2026 to 31 Mar 2027". */
export function rangeText(from: string, to: string): string {
  return from === to ? dateText(from) : `${dateText(from)} to ${dateText(to)}`;
}

/** Days-left words for an active contract; null for the other statuses (they say their own state). */
export function daysLeftText(daysLeft: number, status: RateContractStatus): string | null {
  if (status !== 'active') return null;
  if (daysLeft < 0) return 'Past its end date';
  if (daysLeft === 0) return 'Ends today';
  if (daysLeft === 1) return 'Ends tomorrow';
  return `${daysLeft.toLocaleString('en-IN')} days left`;
}

/** Ending soon = active and within 30 days (the first expiry alert). */
export function endingSoon(daysLeft: number, status: RateContractStatus): boolean {
  return status === 'active' && daysLeft >= 0 && daysLeft <= 30;
}

/** One run of consecutive nights priced from the same line at the same rate. */
export interface NightRun {
  from: string;
  to: string;
  nights: number;
  ratePaise: string;
  weekend: boolean;
  lineId: string;
}

function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Groups the night-by-night price into runs ("3 nights at ₹4,500.00, 1 weekend
 * night at ₹5,200.00") so a long stay stays readable. A run breaks on a gap,
 * a different line, a different rate or a weekend change.
 */
export function groupNights(nights: readonly RateLookupNight[]): NightRun[] {
  const runs: NightRun[] = [];
  for (const n of nights) {
    const last = runs[runs.length - 1];
    if (last && last.lineId === n.lineId && last.ratePaise === n.ratePaise && last.weekend === n.weekend && nextDay(last.to) === n.date) {
      last.to = n.date;
      last.nights += 1;
    } else {
      runs.push({ from: n.date, to: n.date, nights: 1, ratePaise: n.ratePaise, weekend: n.weekend, lineId: n.lineId });
    }
  }
  return runs;
}

/**
 * What the offer form shows next to the typed total, mirroring E9's
 * `contract_state` (the database decides; this is only the live hint).
 * `differs` needs the deviation reason.
 */
export type ContractCompare = 'none' | 'matches' | 'differs' | 'ended' | 'not_priced';
export function compareToContract(quotedPaise: string | null | undefined, price: Pick<RateLookupPrice, 'state' | 'totalPaise'> | null): ContractCompare {
  if (!price) return 'none';
  if (price.state === 'ended') return 'ended';
  if (price.state !== 'ok' || !price.totalPaise) return 'none';
  if (!quotedPaise) return 'not_priced';
  return BigInt(quotedPaise) === BigInt(price.totalPaise) ? 'matches' : 'differs';
}

/** Words for how far the offer is from the contract: "₹1,200.00 above the contract". */
export function differenceText(quotedPaise: string, contractPaise: string): string {
  const d = BigInt(quotedPaise) - BigInt(contractPaise);
  if (d === 0n) return 'Same as the contract';
  return `${inr((d < 0n ? -d : d).toString())} ${d > 0n ? 'above' : 'below'} the contract`;
}

/**
 * A refusal hint for a rate line (`lines[2].ratePaise`, from E4's
 * `invalid_input`) -> the line index and the form field it names (paise
 * fields map to their rupee inputs). Blackouts use `blackouts[n].field`.
 */
export function lineCellFor(hint: string | null | undefined): { group: 'lines' | 'blackouts'; index: number; field: string } | null {
  if (!hint) return null;
  const m = /^(lines|blackouts)\[(\d{1,3})\]\.([A-Za-z]+)$/.exec(hint);
  if (!m) return null;
  return { group: m[1] as 'lines' | 'blackouts', index: Number(m[2]), field: m[3]!.replace(/Paise$/, 'Rupees') };
}

/** A rate line as typed in the form (dates YYYY-MM-DD, rupee text). */
export interface LineDraft {
  seasonFrom: string;
  seasonTo: string;
  roomTypeId: string;
  mealPlan: string;
  rateRupees: string;
  weekendRateRupees: string;
  extraAdultRupees: string;
  childWithBedRupees: string;
  childWithoutBedRupees: string;
  note: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Checks the database repeats (it decides): every line complete, amounts in
 * rupees, rate above zero, season inside the contract dates, and no two lines
 * for the same room type and meal plan overlapping (`lines_overlap`).
 * Returns `lines[n].field` -> message, in line order.
 */
export function lineProblems(lines: readonly LineDraft[], validity: { from: string; to: string }): Record<string, string> {
  const p: Record<string, string> = {};
  const at = (i: number, f: string, m: string) => {
    if (!p[`lines[${i}].${f}`]) p[`lines[${i}].${f}`] = m;
  };
  lines.forEach((l, i) => {
    if (!ISO.test(l.seasonFrom)) at(i, 'seasonFrom', 'Enter the season start date.');
    if (!ISO.test(l.seasonTo)) at(i, 'seasonTo', 'Enter the season end date.');
    if (ISO.test(l.seasonFrom) && ISO.test(l.seasonTo)) {
      if (l.seasonFrom > l.seasonTo) at(i, 'seasonTo', 'The season ends before it starts.');
      else if ((ISO.test(validity.from) && l.seasonFrom < validity.from) || (ISO.test(validity.to) && l.seasonTo > validity.to)) at(i, 'seasonFrom', 'The season must be inside the contract dates.');
    }
    if (!l.roomTypeId) at(i, 'roomTypeId', 'Choose the room type.');
    if (!l.mealPlan) at(i, 'mealPlan', 'Choose the meal plan.');
    const rate = rupeesToPaise(l.rateRupees);
    if (rate === null) at(i, 'rateRupees', 'Enter the rate per room per night.');
    else if (rate === undefined || rate === '0') at(i, 'rateRupees', 'Enter a rupee amount above zero, like 4500 or 4500.50.');
    for (const f of ['weekendRateRupees', 'extraAdultRupees', 'childWithBedRupees', 'childWithoutBedRupees'] as const) {
      if (rupeesToPaise(l[f]) === undefined) at(i, f, 'Enter a rupee amount, like 1200, or leave it empty.');
    }
  });
  for (let i = 0; i < lines.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      const a = lines[j]!;
      const b = lines[i]!;
      if (!a.roomTypeId || a.roomTypeId !== b.roomTypeId || !a.mealPlan || a.mealPlan !== b.mealPlan) continue;
      if (![a.seasonFrom, a.seasonTo, b.seasonFrom, b.seasonTo].every((d) => ISO.test(d))) continue;
      if (a.seasonFrom <= b.seasonTo && b.seasonFrom <= a.seasonTo) at(i, 'seasonFrom', `Overlaps line ${j + 1} for the same room type and meal plan.`);
    }
  }
  return p;
}

/** The id of a line cell input (shared by the form and the refusal focus). */
export function lineCellId(base: string, group: 'lines' | 'blackouts', index: number, field: string): string {
  return `${base}-${group}-${index}-${field}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES: readonly RateContractStatus[] = ['draft', 'pending_approval', 'active', 'returned', 'ended'];

/** Reads the list address (the list view's href builder) back into a filter; unknown values are dropped. */
export function parseRateContractQuery(params: Record<string, string | string[] | undefined>): { filter: RateContractFilter; after: string | null } {
  const one = (v: string | string[] | undefined) => ((Array.isArray(v) ? v[0] : v) ?? '').trim();
  const filter: RateContractFilter = {};
  const supplierId = one(params.supplierId);
  if (UUID_RE.test(supplierId)) filter.supplierId = supplierId;
  const hotelId = one(params.hotelId);
  if (UUID_RE.test(hotelId)) filter.hotelId = hotelId;
  const status = one(params.status)
    .split(',')
    .filter((s): s is RateContractStatus => (STATUSES as readonly string[]).includes(s));
  if (status.length) filter.status = [...new Set(status)];
  const days = one(params.endingWithinDays);
  if (/^\d{1,4}$/.test(days) && Number(days) <= 1100) filter.endingWithinDays = Number(days);
  const q = one(params.q);
  if (q && q.length <= 100) filter.q = q;
  const preset = one(params.preset);
  if (preset === 'to_approve' || preset === 'ending_soon') filter.preset = preset;
  const after = one(params.after);
  return { filter, after: after && after.length <= 200 ? after : null };
}
