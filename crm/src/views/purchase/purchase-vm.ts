import { formatPaise } from '@/modules/deals/dto';
import { stayNights } from '@/modules/fulfilment/booking-form-model';
import type { PurchaseTaskView } from '@/modules/fulfilment/contracts';

/*
 * Purchase screens (Purchase build, 2 Nov 2026): pure view-model helpers.
 * No data access, no money beyond supplier cost and the Purchase budget.
 * Unit-tested in tests/unit/purchase-vm.test.ts.
 */

// ---------------------------------------------------------------------------
// "What Sales booked for this hotel": the room breakup from the booking
// form's cost estimate (service_item_cost_estimates, assignee only).
// ---------------------------------------------------------------------------

export interface BreakupLine {
  key: 'room' | 'extra_bed' | 'no_bed';
  label: string;
  quantityText: string;
  /** Cost per night per unit, paise; null when Sales gave no rate for this line. */
  ratePaise: string | null;
  rateUnit: string;
  nights: number;
  /** quantity × rate × nights; null when the rate is missing. */
  totalPaise: string | null;
}

export interface HotelBreakup {
  lines: BreakupLine[];
  nights: number;
  /** Sum of the line totals; null when any line has no rate. */
  totalPaise: string | null;
  /** Per-night total; null when unknown. */
  perNightPaise: string | null;
}

function count(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function times(ratePaise: string | null, quantity: number, nights: number): string | null {
  if (ratePaise === null) return null;
  try {
    return (BigInt(ratePaise) * BigInt(quantity) * BigInt(nights)).toString();
  } catch {
    return null;
  }
}

/**
 * Lines Sales entered in Book now for a hotel: room type × rooms, extra beds,
 * guests without a bed. Null when this viewer has no estimate (not the
 * assignee, an older booking, or not a hotel) or Sales gave no room rate.
 */
export function hotelBreakup(task: Pick<PurchaseTaskView, 'serviceType' | 'facts' | 'estimate' | 'roomType' | 'rooms' | 'checkIn' | 'checkOut' | 'nights'>): HotelBreakup | null {
  if (task.serviceType !== 'hotel' || task.facts.type !== 'hotel') return null;
  const estimate = task.estimate?.estimate;
  if (!estimate || estimate.kind !== 'hotel' || estimate.roomRatePaise === null) return null;
  const nights = stayNights(task.checkIn, task.checkOut) ?? (task.nights > 0 ? task.nights : null);
  if (!nights) return null;
  const facts = task.facts.facts;
  const rooms = count(task.rooms || facts.rooms);
  if (rooms === 0) return null;
  const lines: BreakupLine[] = [
    {
      key: 'room',
      label: task.roomType ?? facts.roomType ?? 'Room',
      quantityText: plural(rooms, 'room', 'rooms'),
      ratePaise: estimate.roomRatePaise,
      rateUnit: 'per room',
      nights,
      totalPaise: times(estimate.roomRatePaise, rooms, nights),
    },
  ];
  const extraBeds = count(facts.extraBeds);
  if (extraBeds > 0) {
    lines.push({ key: 'extra_bed', label: 'Extra bed', quantityText: plural(extraBeds, 'bed', 'beds'), ratePaise: estimate.extraBedRatePaise, rateUnit: 'per bed', nights, totalPaise: times(estimate.extraBedRatePaise, extraBeds, nights) });
  }
  const noBed = count(facts.childrenWithoutBed);
  if (noBed > 0) {
    lines.push({ key: 'no_bed', label: 'Guest without a bed', quantityText: plural(noBed, 'guest', 'guests'), ratePaise: estimate.noBedRatePaise, rateUnit: 'per guest', nights, totalPaise: times(estimate.noBedRatePaise, noBed, nights) });
  }
  const known = lines.every((l) => l.totalPaise !== null);
  const total = known ? lines.reduce((sum, l) => sum + BigInt(l.totalPaise!), 0n) : null;
  return {
    lines,
    nights,
    totalPaise: total === null ? null : total.toString(),
    perNightPaise: total === null ? null : (total / BigInt(nights)).toString(),
  };
}

// ---------------------------------------------------------------------------
// Rates against the budget
// ---------------------------------------------------------------------------

export type BudgetDelta = { kind: 'no_budget' } | { kind: 'under' | 'over' | 'equal'; differencePaise: string };

export function budgetDelta(amountPaise: string, budgetPaise: string | null | undefined): BudgetDelta {
  let budget: bigint;
  let amount: bigint;
  try {
    budget = BigInt(budgetPaise ?? '0');
    amount = BigInt(amountPaise);
  } catch {
    return { kind: 'no_budget' };
  }
  if (budget <= 0n) return { kind: 'no_budget' };
  if (amount === budget) return { kind: 'equal', differencePaise: '0' };
  return amount < budget ? { kind: 'under', differencePaise: (budget - amount).toString() } : { kind: 'over', differencePaise: (amount - budget).toString() };
}

/** Whole rupees when the difference has no paise ("₹8,000 under budget"), else with paise. */
function shortInr(paise: string): string {
  const full = formatPaise(paise);
  return full.endsWith('.00') ? full.slice(0, -3) : full;
}

export function budgetDeltaText(delta: BudgetDelta): string {
  if (delta.kind === 'no_budget') return 'No budget set';
  if (delta.kind === 'equal') return 'Equal to the budget';
  return `${shortInr(delta.differencePaise)} ${delta.kind === 'under' ? 'under' : 'over'} budget`;
}

/** Lowest amount among the given rates; null when none. */
export function lowestPaise(amounts: string[]): string | null {
  let best: bigint | null = null;
  for (const a of amounts) {
    try {
      const v = BigInt(a);
      if (best === null || v < best) best = v;
    } catch {
      // ignore malformed values
    }
  }
  return best === null ? null : best.toString();
}

/**
 * "Or per room per night" fills the whole-stay amount: rate × rooms × nights.
 * Returns rupees text with two decimals, or null when the input is not a
 * positive amount.
 */
export function wholeStayFromPerNight(perNightRupees: string, rooms: number, nights: number): string | null {
  const m = /^\s*(\d{1,9})(?:\.(\d{1,2}))?\s*$/.exec(perNightRupees.replace(/,/g, ''));
  if (!m || rooms < 1 || nights < 1) return null;
  const paise = BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
  if (paise <= 0n) return null;
  const total = paise * BigInt(rooms) * BigInt(nights);
  return `${total / 100n}.${(total % 100n).toString().padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Supplier e-mail fields (the drafts themselves come from
// modules/procurement/email-draft.ts, one source for screen and server)
// ---------------------------------------------------------------------------

/** Comma, semicolon or space separated Cc list; trimmed, empty parts dropped. */
export function splitEmails(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmailShaped(value: string): boolean {
  return value.length <= 254 && EMAIL_SHAPE.test(value);
}

// ---------------------------------------------------------------------------
// Payment routing preview (the server decides; this only explains)
// ---------------------------------------------------------------------------

/** ₹50,000 in paise: exactly this amount is Accounts; above is the branch Manager. */
export const APPROVAL_LIMIT_PAISE = 5_000_000n;

export function routeFor(cumulativePaise: bigint): 'accounts' | 'manager' {
  return cumulativePaise > APPROVAL_LIMIT_PAISE ? 'manager' : 'accounts';
}

/** Rupees text ("1,14,000" or "1,14,000.50") to paise; null when not a positive amount. */
export function rupeesToPaise(text: string): bigint | null {
  const m = /^\s*(\d{1,10})(?:\.(\d{1,2}))?\s*$/.exec(text.replace(/,/g, ''));
  if (!m) return null;
  const paise = BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
  return paise > 0n ? paise : null;
}
