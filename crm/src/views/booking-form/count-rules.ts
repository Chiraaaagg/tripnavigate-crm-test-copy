import { parseCount } from '@/modules/fulfilment/booking-form-model';
import { countIssues, derivedAdults } from '@/modules/fulfilment/passenger-slots';

/*
 * The count rule as the Customer & trip card applies it on screen (pure, so it
 * is unit-tested). The shared rule (countIssues, passenger-slots.ts) decides;
 * this file only reads the typed boxes: an empty Adults box is worked out as
 * total minus children and infants, and nothing entered at all (no total, no
 * counts, or only the 0 the steppers start at) is not a problem, so a
 * contact-only save goes through (gate finding, 24 October 2026).
 */

export interface TypedCounts {
  paxTotal: string;
  adults: string;
  children: string;
  infants: string;
}

const countOf = (x: string) => (x.trim() === '' ? null : (parseCount(x) ?? Number.NaN));

/** Adults as typed, or worked out as total - children - infants when the box is empty (the server does the same). */
export function effectiveAdults(v: TypedCounts): number | null {
  const typed = countOf(v.adults);
  if (typed !== null) return Number.isNaN(typed) ? null : typed;
  const total = countOf(v.paxTotal);
  if (total === null || Number.isNaN(total)) return null;
  return derivedAdults({ total, children: countOf(v.children || '0'), infants: countOf(v.infants || '0') });
}

/** The first count problem in plain words, or null (also null when nothing is entered yet). */
export function countsProblem(v: TypedCounts, totalFromDeal: boolean): string | null {
  const adults = v.adults.trim() === '' ? effectiveAdults(v) : countOf(v.adults);
  const issues = countIssues({ total: countOf(v.paxTotal), adults, children: countOf(v.children), infants: countOf(v.infants) }, { totalFromDeal });
  return issues[0]?.text ?? null;
}
