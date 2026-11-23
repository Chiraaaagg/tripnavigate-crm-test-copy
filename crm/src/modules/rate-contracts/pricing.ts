/**
 * Pure mirror of authz.rate_contract_price (contract 9.2, LD21; migration
 * 20261205000520). The database is the authority; this mirror lets a screen
 * explain a price and is unit-tested against the same rules:
 *   - night by night (check-out night not charged) from the ACTIVE contract
 *     covering each night (latest start wins), the line of that contract for
 *     the room type and meal plan whose season covers the night;
 *   - the weekend rate on Friday and Saturday nights when the line has one;
 *   - blackout: a night with a matching line on a blackout date of its
 *     contract; partial: some nights priced; ok: every night priced;
 *   - ended: no active contract covers any night, and one of the pair ended
 *     (its validity end, or the day it was ended) before check-in; endedOn =
 *     the latest such day; otherwise no_contract;
 *   - totals only when ok; total = per-room total x rooms (at least 1).
 * Money is whole paise as decimal strings (BigInt inside; never floats).
 */

export { MEAL_PLAN_CODES as MEAL_PLANS } from './contracts';
import type { RateLookupState } from './contracts';

export interface PricingLine {
  id: string;
  seasonFrom: string;
  seasonTo: string;
  roomTypeId: string;
  mealPlan: string;
  ratePaise: string;
  weekendRatePaise?: string | null;
}

export interface PricingContract {
  id: string;
  status: string;
  validFrom: string;
  validTo: string;
  /** The India date it was ended early (status ended); validTo is used when absent. */
  endedOn?: string | null;
  lines: PricingLine[];
  blackouts?: Array<{ from?: string; to?: string; fromDate?: string; toDate?: string }>;
}

export interface PriceStayInput {
  contracts: readonly PricingContract[];
  roomTypeId: string | null;
  mealPlan: string | null;
  checkIn: string | null;
  checkOut: string | null;
  rooms?: number | null;
}

export interface PriceNight {
  date: string;
  ratePaise: string;
  lineId: string;
  weekend: boolean;
}

export interface PriceResult {
  state: RateLookupState;
  contractIds: string[];
  nights: PriceNight[];
  perRoomTotalPaise: string | null;
  totalPaise: string | null;
  endedOn: string | null;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function toDay(iso: string | null | undefined): number | null {
  if (!iso || !ISO.test(iso)) return null;
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== iso ? null : t / DAY_MS;
}

function fromDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** Whole paise decimal string -> BigInt (0n when malformed). */
function paise(v: string | null | undefined): bigint | null {
  return v != null && /^(0|[1-9]\d{0,17})$/.test(v) ? BigInt(v) : null;
}

const EMPTY = (state: RateLookupState, endedOn: string | null = null): PriceResult =>
  ({ state, contractIds: [], nights: [], perRoomTotalPaise: null, totalPaise: null, endedOn });

export function priceStay(input: PriceStayInput): PriceResult {
  const inDay = toDay(input.checkIn);
  const outDay = toDay(input.checkOut);
  if (inDay === null || outDay === null || outDay <= inDay || outDay - inDay > 366 || !input.roomTypeId || !input.mealPlan) {
    return EMPTY('no_contract');
  }
  const active = input.contracts.filter((c) => c.status === 'active');
  let covered = 0;
  let anyBlackout = false;
  const nights: PriceNight[] = [];
  const firstNight = new Map<string, number>();
  for (let d = inDay; d < outDay; d += 1) {
    const contract = active
      .filter((c) => (toDay(c.validFrom) ?? Infinity) <= d && d <= (toDay(c.validTo) ?? -Infinity))
      .sort((a, b) => (toDay(b.validFrom) ?? 0) - (toDay(a.validFrom) ?? 0) || (a.id < b.id ? -1 : 1))[0];
    if (!contract) continue;
    covered += 1;
    const line = contract.lines
      .filter((l) => l.roomTypeId === input.roomTypeId && l.mealPlan === input.mealPlan
        && (toDay(l.seasonFrom) ?? Infinity) <= d && d <= (toDay(l.seasonTo) ?? -Infinity))
      .sort((a, b) => (toDay(b.seasonFrom) ?? 0) - (toDay(a.seasonFrom) ?? 0) || (a.id < b.id ? -1 : 1))[0];
    if (!line) continue;
    const blackout = (contract.blackouts ?? []).some((b) => {
      const f = toDay(b.fromDate ?? b.from);
      const t = toDay(b.toDate ?? b.to);
      return f !== null && t !== null && f <= d && d <= t;
    });
    if (blackout) {
      anyBlackout = true;
      continue;
    }
    const dow = new Date(d * DAY_MS).getUTCDay();
    const weekend = dow === 5 || dow === 6;
    const rate = weekend && paise(line.weekendRatePaise) !== null ? paise(line.weekendRatePaise)! : (paise(line.ratePaise) ?? 0n);
    nights.push({ date: fromDay(d), ratePaise: rate.toString(), lineId: line.id, weekend });
    if (!firstNight.has(contract.id)) firstNight.set(contract.id, d);
  }
  const total = outDay - inDay;
  const contractIds = [...firstNight.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);

  let state: RateLookupState;
  let endedOn: string | null = null;
  if (anyBlackout) state = 'blackout';
  else if (nights.length === total) state = 'ok';
  else if (nights.length > 0) state = 'partial';
  else {
    const ends = input.contracts
      .filter((c) => c.status === 'active' || c.status === 'ended')
      .map((c) => {
        const to = toDay(c.validTo);
        const early = c.status === 'ended' ? toDay(c.endedOn ?? null) : null;
        return to === null ? null : early === null ? to : Math.min(to, early);
      })
      .filter((e): e is number => e !== null && e < inDay);
    if (covered === 0 && ends.length > 0) {
      state = 'ended';
      endedOn = fromDay(Math.max(...ends));
    } else state = 'no_contract';
  }
  if (state !== 'ok') return { state, contractIds, nights, perRoomTotalPaise: null, totalPaise: null, endedOn };
  const perRoom = nights.reduce((s, n) => s + BigInt(n.ratePaise), 0n);
  const rooms = BigInt(Math.max(1, Math.trunc(input.rooms ?? 1)));
  return { state, contractIds, nights, perRoomTotalPaise: perRoom.toString(), totalPaise: (perRoom * rooms).toString(), endedOn: null };
}

/** How an offer compares with the contract total (purchase_quotes.contract_state). */
export function compareOffer(price: Pick<PriceResult, 'state' | 'totalPaise'>, quotedPaise: string): 'none' | 'matches' | 'differs' | 'ended' {
  if (price.state === 'ended') return 'ended';
  if (price.state !== 'ok' || price.totalPaise === null) return 'none';
  return price.totalPaise === quotedPaise ? 'matches' : 'differs';
}
