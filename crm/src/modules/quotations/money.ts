import type { ServiceType } from '@/modules/fulfilment/contracts';
import {
  type ChargeKind,
  type OptionKey,
  type PaiseString,
  type QuotationInstalmentView,
  type QuotationLineView,
  type TierKey,
  UNIT_KINDS,
  type UnitKind,
} from './contracts';

/*
 * Pure quotation money helpers (Mercury F1–F14, DEC-33/34). bigint paise in
 * every calculation; views carry decimal digit strings. Nothing here rounds a
 * stored value, derives a quantity from stay facts, applies a difference or
 * computes tax. The database decides again; these mirror it for the screen
 * (running totals, warnings) and for form parsing.
 */

const DIGITS = /^(0|[1-9][0-9]{0,18})$/;

/** "1250000" → 1250000n; null/invalid → null. */
export function paise(value: PaiseString | null | undefined): bigint | null {
  if (value === null || value === undefined || !DIGITS.test(value)) return null;
  return BigInt(value);
}

/** Signed paise ("-500" allowed) → bigint; null/invalid → null. */
export function signedPaise(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined || !/^-?(0|[1-9][0-9]{0,18})$/.test(value)) return null;
  return BigInt(value);
}

function cleanRupees(raw: string): string {
  return raw.replace(/[,\s]/g, '').replace(/^₹/, '');
}

/**
 * A customer-visible amount typed in rupees (selling prices, quoted totals,
 * instalments): whole rupees only. "12,500" / "₹12500" / "12500.00" →
 * "1250000"; "" → null; anything else (paise, letters, negative, more than
 * 13 rupee digits) → undefined. Never rounds.
 */
export function parseWholeRupees(raw: string | null | undefined): PaiseString | null | undefined {
  const value = cleanRupees(raw ?? '');
  if (value === '') return null;
  const match = /^(\d{1,13})(?:\.(0{1,2}))?$/.exec(value);
  if (!match) return undefined;
  return (BigInt(match[1]!) * 100n).toString();
}

/**
 * An internal cost estimate typed in rupees: paise allowed. "12,500.5" →
 * "1250050"; "" → null; invalid → undefined. Never rounds (a third decimal is refused).
 */
export function parseRupeesWithPaise(raw: string | null | undefined): PaiseString | null | undefined {
  const value = cleanRupees(raw ?? '');
  if (value === '') return null;
  const match = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return undefined;
  return (BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0')).toString();
}

/** Paise → rupee input text ("1250050" → "12500.50"; "1250000" → "12500"). */
export function paiseToRupeesText(value: PaiseString | null | undefined): string {
  const p = paise(value);
  if (p === null) return '';
  const whole = (p / 100n).toString();
  const frac = (p % 100n).toString().padStart(2, '0');
  return frac === '00' ? whole : `${whole}.${frac}`;
}

const GROUP = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** Paise (signed allowed) → "₹12,500" or "₹12,500.50" (Indian grouping, exact, bigint). null → null. */
export function formatInr(value: string | bigint | null | undefined): string | null {
  const p = typeof value === 'bigint' ? value : signedPaise(value ?? null);
  if (p === null) return null;
  const negative = p < 0n;
  const abs = negative ? -p : p;
  const rupees = GROUP.format(abs / 100n);
  const frac = abs % 100n;
  const text = frac === 0n ? `₹${rupees}` : `₹${rupees}.${frac.toString().padStart(2, '0')}`;
  return negative ? `−${text}` : text;
}

/** Whole rupees as a bigint, or null when the amount has paise (engine adapter rule F14: refuse, never round). */
export function wholeRupees(value: PaiseString | bigint | null | undefined): bigint | null {
  const p = typeof value === 'bigint' ? value : paise(value ?? null);
  if (p === null || p % 100n !== 0n) return null;
  return p / 100n;
}

// ---------------------------------------------------------------------------
// Units (DEC-33)
// ---------------------------------------------------------------------------

/** The required unit of a `main` line for each service type (null = no linked item: line_total). */
export function requiredMainUnits(serviceType: ServiceType | null): readonly UnitKind[] {
  switch (serviceType) {
    case 'hotel':
      return ['room_night'];
    case 'transfer':
      return ['trip'];
    case 'activity':
      return ['person', 'line_total'];
    case 'flight':
    case 'visa':
    case 'passport':
    case null:
      return ['line_total'];
  }
}

/** Units a line may use (mirror of Mercury §2.2; the command decides). */
export function allowedUnits(chargeKind: ChargeKind, serviceType: ServiceType | null): readonly UnitKind[] {
  if (chargeKind === 'main') return requiredMainUnits(serviceType);
  if (chargeKind === 'extra_bed' || chargeKind === 'child_no_bed') return ['night', 'person', 'line_total'];
  return UNIT_KINDS.filter((u) => u === 'night' || u === 'person' || u === 'line_total');
}

/** Extra-bed and child-without-bed lines must price a hotel item. */
export function chargeNeedsHotel(chargeKind: ChargeKind): boolean {
  return chargeKind === 'extra_bed' || chargeKind === 'child_no_bed';
}

/** line_total and person have one period; line_total also one unit. */
export function fixedCounts(unit: UnitKind): { units: 1 | null; periods: 1 | null } {
  if (unit === 'line_total') return { units: 1, periods: 1 };
  if (unit === 'person') return { units: null, periods: 1 };
  return { units: null, periods: null };
}

/** unit × units × periods, exact. */
export function lineAmount(unitPaise: bigint, units: number, periods: number): bigint {
  return unitPaise * BigInt(units) * BigInt(periods);
}

// ---------------------------------------------------------------------------
// Tier comparison (DEC-34): typed total vs component sum; never applied
// ---------------------------------------------------------------------------

export function linesForTier<T extends Pick<QuotationLineView, 'optionKey'>>(lines: readonly T[], tier: TierKey): T[] {
  return lines.filter((l) => l.optionKey === 'common' || l.optionKey === tier);
}

export interface TierComparison {
  componentSell: bigint;
  /** quoted − components; null without a quoted total. */
  difference: bigint | null;
  /** null when any line's cost is unknown. */
  costTotal: bigint | null;
  /** quoted − cost; null when either is unknown. */
  margin: bigint | null;
}

export function compareTier(
  lines: ReadonlyArray<Pick<QuotationLineView, 'optionKey' | 'lineSellPaise' | 'lineCostPaise'>>,
  tier: TierKey,
  quotedTotal: PaiseString | null,
): TierComparison {
  const mine = linesForTier(lines, tier);
  let componentSell = 0n;
  let costTotal: bigint | null = 0n;
  for (const l of mine) {
    componentSell += paise(l.lineSellPaise) ?? 0n;
    const cost = paise(l.lineCostPaise);
    costTotal = cost === null || costTotal === null ? null : costTotal + cost;
  }
  const total = paise(quotedTotal);
  return {
    componentSell,
    difference: total === null ? null : total - componentSell,
    costTotal,
    margin: total === null || costTotal === null ? null : total - costTotal,
  };
}

/** Per-person price only when exact in whole rupees (Mercury §3.3); else null. */
export function perPersonExact(quotedTotal: PaiseString | bigint | null, travellers: number | null): bigint | null {
  const total = typeof quotedTotal === 'bigint' ? quotedTotal : paise(quotedTotal);
  if (total === null || !travellers || travellers < 1) return null;
  const step = BigInt(travellers) * 100n;
  return total % step === 0n ? total / BigInt(travellers) : null;
}

/** The nearest totals below and above that would print an exact per-person price (shown to Sales; never applied). */
export function nearestExactTotals(quotedTotal: PaiseString | bigint, travellers: number): { below: bigint; above: bigint } | null {
  const total = typeof quotedTotal === 'bigint' ? quotedTotal : paise(quotedTotal);
  if (total === null || travellers < 1) return null;
  const step = BigInt(travellers) * 100n;
  const below = (total / step) * step;
  return { below, above: below === total ? total : below + step };
}

// ---------------------------------------------------------------------------
// Payment plan (optional per tier; equals the typed total before sending)
// ---------------------------------------------------------------------------

export function planForTier<T extends Pick<QuotationInstalmentView, 'tierKey' | 'seq'>>(plan: readonly T[], tier: TierKey): T[] {
  return plan.filter((p) => p.tierKey === tier).sort((a, b) => a.seq - b.seq);
}

export function planTotal(plan: ReadonlyArray<Pick<QuotationInstalmentView, 'tierKey' | 'amountPaise'>>, tier: TierKey): bigint {
  return plan.filter((p) => p.tierKey === tier).reduce((sum, p) => sum + (paise(p.amountPaise) ?? 0n), 0n);
}

/** true when the tier has no plan (optional) or the plan adds up exactly to the typed total. */
export function planMatchesTotal(plan: ReadonlyArray<Pick<QuotationInstalmentView, 'tierKey' | 'amountPaise'>>, tier: TierKey, quotedTotal: PaiseString | null): boolean {
  const rows = plan.filter((p) => p.tierKey === tier);
  if (rows.length === 0) return true;
  const total = paise(quotedTotal);
  return total !== null && planTotal(plan, tier) === total;
}

/**
 * "Split by percentage" (Mercury §4): each instalment except the last is
 * floor(total × pct / 100) taken down to a whole rupee; the last takes the
 * remainder. Percentages must be whole numbers 1–100 that add up to 100,
 * else null. Staff see and save the amounts as typed amounts; no percentage
 * is stored.
 */
export function splitByPercentage(total: PaiseString | bigint, percentages: readonly number[]): bigint[] | null {
  const t = typeof total === 'bigint' ? total : paise(total);
  if (t === null || t % 100n !== 0n || percentages.length === 0) return null;
  if (!percentages.every((p) => Number.isInteger(p) && p >= 1 && p <= 100)) return null;
  if (percentages.reduce((a, b) => a + b, 0) !== 100) return null;
  const out: bigint[] = [];
  let used = 0n;
  percentages.forEach((pct, i) => {
    if (i === percentages.length - 1) {
      out.push(t - used);
      return;
    }
    const raw = (t * BigInt(pct)) / 100n;
    const whole = (raw / 100n) * 100n;
    out.push(whole);
    used += whole;
  });
  return out;
}

/** Which option keys a line may use given the version's tiers. */
export function optionKeysFor(tiers: readonly TierKey[]): OptionKey[] {
  return tiers.includes('upgrade') ? ['common', 'quoted', 'upgrade'] : ['common', 'quoted'];
}
