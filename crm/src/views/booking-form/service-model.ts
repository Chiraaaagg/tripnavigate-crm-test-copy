import type { ChipPerson } from '@/components/ui/traveller-chips';
import type { SuggestItem } from '@/components/ui/suggest-multiselect';
import { CAR_KINDS, type BookingFormServiceItemView, type CarKind, type FlightEstimate, type FlightFareTotals } from '@/modules/fulfilment/booking-form-contract';
import { addDays, isIsoDate } from '@/modules/fulfilment/booking-form-model';
import type { BookTravellerView, ServiceType, TravellerType } from '@/modules/fulfilment/contracts';
import type { Airport } from '@/lib/airports/search';

/*
 * Pure helpers of step 2 (Book now v2), kept apart from the screens so the
 * rules are unit-tested: row numbering per service type (change 11), the
 * traveller chips (change 6, lead ruling D4), requests "for whom"
 * (changes 16 and 17), the car fill rules (change 14) and the fare per person
 * with the all-flights total (change 18). No React, no server imports.
 */

export const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const SERVICE_ONE: Record<ServiceType, string> = { hotel: 'Hotel', transfer: 'Car', flight: 'Flight', activity: 'Activity', visa: 'Visa', passport: 'Passport' };

/** "Hotel 1", "Hotel 2", "Flight 1" … per type, in item order (change 11). */
export function itemLabels(items: readonly Pick<BookingFormServiceItemView, 'itemId' | 'itemNo' | 'serviceType'>[]): Map<string, string> {
  const out = new Map<string, string>();
  const seen: Partial<Record<ServiceType, number>> = {};
  for (const i of [...items].sort((a, b) => a.itemNo - b.itemNo)) {
    const n = (seen[i.serviceType] ?? 0) + 1;
    seen[i.serviceType] = n;
    out.set(i.itemId, `${SERVICE_ONE[i.serviceType]} ${n}`);
  }
  return out;
}

/** Named passengers as chips, in seq order (lead ruling D4: only named passengers can be chosen). */
export function chipPeople(travellers: readonly Pick<BookTravellerView, 'seq' | 'fullName'>[]): ChipPerson[] {
  return [...travellers].sort((a, b) => a.seq - b.seq).filter((t) => t.fullName.trim() !== '').map((t) => ({ value: String(t.seq), label: t.fullName.trim() }));
}

/** "2 travellers not named yet. Name them in step 1." (D4); null when everyone is named. */
export function unnamedLine(partyTotal: number | null, named: number): string | null {
  const n = (partyTotal ?? 0) - named;
  if (n <= 0) return null;
  return `${plural(n, 'traveller')} not named yet. Name them in step 1.`;
}

/** "All 4 travellers" / "2 travellers" (prototype travText). */
export function travText(ids: readonly number[] | null | undefined, all: number): string {
  if (!ids) return '';
  return ids.length === all && all > 0 ? `All ${all} travellers` : plural(ids.length, 'traveller');
}

export interface RequestItemFact {
  text: string;
  forSeq: number | null;
}

/** Stored structured requests (facts.requestItems), or none. */
export function requestItemsOf(facts: Record<string, unknown> | null | undefined): RequestItemFact[] {
  const raw = facts?.requestItems;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : null))
    .filter((x): x is Record<string, unknown> => x !== null && typeof x.text === 'string' && x.text.trim() !== '')
    .map((x) => ({ text: String(x.text).trim(), forSeq: typeof x.forSeq === 'number' ? x.forSeq : null }));
}

export const toSuggestItems = (items: readonly RequestItemFact[]): SuggestItem[] => items.map((i) => ({ value: i.text, forKey: i.forSeq === null ? null : String(i.forSeq) }));

/** "Baby cot (Asha Rao), Early check-in"; falls back to the stored text of an older item. */
export function requestText(facts: Record<string, unknown>, textKey: 'specialRequests' | 'preferences', travellers: readonly Pick<BookTravellerView, 'seq' | 'fullName'>[]): string {
  const items = requestItemsOf(facts);
  if (items.length === 0) return str(facts[textKey]);
  return items
    .map((i) => {
      const t = i.forSeq === null ? null : travellers.find((x) => x.seq === i.forSeq);
      return t ? `${i.text} (${t.fullName})` : i.text;
    })
    .join(', ');
}

/** Requests on the form: a "for" person no longer on the service reads "for everyone". */
export function requestFormFields(items: readonly SuggestItem[], chosen: readonly string[]): Array<{ text: string; forSeq: string }> {
  return items.map((i) => ({ text: i.value, forSeq: i.forKey && chosen.includes(i.forKey) && chosen.length > 1 ? i.forKey : '' }));
}

// ---------------------------------------------------------------------------
// Car (change 14)
// ---------------------------------------------------------------------------

/** The stored kind, or for a car saved before Book now v2: Full trip when it has a route or end date, else Point to point. */
export function carKindOf(facts: Record<string, unknown> | null | undefined): CarKind {
  const k = str(facts?.carKind);
  if ((CAR_KINDS as readonly string[]).includes(k)) return k as CarKind;
  if (!facts) return 'airport_pickup';
  return str(facts.route) || str(facts.endDate) ? 'full_trip' : 'point_to_point';
}

/** "HH:MM" three hours earlier, wrapping past midnight. */
export function threeHoursBefore(time: string): string {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!m) return '';
  const total = (Number(m[1]) * 60 + Number(m[2]) - 180 + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export interface HotelStay {
  hotelName: string;
  city: string;
  checkIn: string;
  checkOut: string;
}

/** The hotel for the night of `date` (else the one checking out that day). */
export function hotelOnNight(hotels: readonly HotelStay[], date: string): HotelStay | null {
  if (!isIsoDate(date)) return null;
  return hotels.find((h) => isIsoDate(h.checkIn) && date >= h.checkIn && date < h.checkOut) ?? hotels.find((h) => h.checkOut === date) ?? null;
}

export interface FlightLeg {
  from: string;
  to: string;
  date: string;
  arrivalDate: string;
  flightNo: string;
  departTime: string;
  arriveTime: string;
}

export interface CarFill {
  pickup?: string;
  drop?: string;
  date?: string;
  time?: string;
}

const cityOf = (airports: readonly Airport[] | null, code: string) => airports?.find((a) => a.c === code)?.city ?? '';

/** The fill of "Meets which flight" / "For which flight" (prototype car drawer). */
export function carFillFromFlight(kind: 'airport_pickup' | 'airport_drop', leg: FlightLeg, hotels: readonly HotelStay[], airports: readonly Airport[] | null): CarFill {
  const place = (code: string) => `${cityOf(airports, code) ? `${cityOf(airports, code)} airport` : ''} (${code})${leg.flightNo ? `, flight ${leg.flightNo}` : ''}`.trim();
  if (kind === 'airport_pickup') {
    const d = leg.arrivalDate || leg.date;
    const h = hotelOnNight(hotels, d);
    return { pickup: place(leg.to), date: d, time: leg.arriveTime, ...(h ? { drop: `${h.hotelName}, ${h.city}` } : {}) };
  }
  const h = hotelOnNight(hotels, leg.date);
  return { drop: place(leg.from), date: leg.date, ...(leg.departTime ? { time: threeHoursBefore(leg.departTime) } : {}), ...(h ? { pickup: `${h.hotelName}, ${h.city}` } : {}) };
}

// ---------------------------------------------------------------------------
// Flights (changes 7, 18, 19)
// ---------------------------------------------------------------------------

export const isScreenshotFlight = (facts: Record<string, unknown> | null | undefined) => str(facts?.entryMode) === 'screenshot';

export function legsOf(facts: Record<string, unknown> | null | undefined): FlightLeg[] {
  const raw = Array.isArray(facts?.segments) ? (facts!.segments as Array<Record<string, unknown>>) : [];
  return raw.map((g) => ({ from: str(g.from), to: str(g.to), date: str(g.date), arrivalDate: str(g.arrivalDate), flightNo: str(g.flightNo), departTime: str(g.departTime), arriveTime: str(g.arriveTime) }));
}

export type FareKey = 'adult' | 'child' | 'infant';
export const FARE_LABEL: Record<FareKey, string> = { adult: 'Adult', child: 'Child', infant: 'Infant' };
const FARE_FIELD: Record<FareKey, keyof FlightEstimate> = { adult: 'fareAdultPaise', child: 'fareChildPaise', infant: 'fareInfantPaise' };
const TOTAL_FIELD: Record<FareKey, keyof FlightFareTotals> = { adult: 'adultPaise', child: 'childPaise', infant: 'infantPaise' };
const TYPE_OF: Record<FareKey, TravellerType> = { adult: 'adult', child: 'child', infant: 'infant' };

/** Adult always; Child and Infant only when step 1 has them. */
export function fareTypes(counts: { children: number; infants: number }): FareKey[] {
  return ['adult', ...(counts.children > 0 ? (['child'] as const) : []), ...(counts.infants > 0 ? (['infant'] as const) : [])];
}

export function flightFare(item: Pick<BookingFormServiceItemView, 'estimate'>, k: FareKey): string | null {
  const e = item.estimate?.estimate;
  if (!e || e.kind !== 'flight') return null;
  return (e as FlightEstimate)[FARE_FIELD[k]] ?? null;
}

export interface FareTotal {
  /** Every flight carrying this type has a fare: the total adds itself up and cannot be typed. */
  auto: boolean;
  /** Per person, paise; null = not known. */
  paise: string | null;
  /** "flight 2" numbers (1-based among flights) still without a fare, when only some have one. */
  missing: number[];
}

type FlightLike = Pick<BookingFormServiceItemView, 'itemId' | 'estimate' | 'participants'>;

/** The total per person of one traveller type over all flights (change 18). */
export function fareTotal(flights: readonly FlightLike[], k: FareKey, travellers: readonly Pick<BookTravellerView, 'seq' | 'type'>[], typed: FlightFareTotals | null | undefined): FareTotal {
  const typeOn = (f: FlightLike) => (f.participants ?? []).some((s) => travellers.find((t) => t.seq === s)?.type === TYPE_OF[k]);
  const carrying = flights.filter(typeOn);
  const priced = carrying.filter((f) => flightFare(f, k) !== null);
  if (carrying.length > 0 && priced.length === carrying.length) {
    return { auto: true, paise: priced.reduce((s, f) => s + BigInt(flightFare(f, k)!), 0n).toString(), missing: [] };
  }
  return {
    auto: false,
    paise: typed?.[TOTAL_FIELD[k]] ?? null,
    missing: priced.length > 0 ? carrying.filter((f) => flightFare(f, k) === null).map((f) => flights.indexOf(f) + 1) : [],
  };
}

/** Travellers of a type on at least one flight. */
export function flyersOf(flights: readonly FlightLike[], k: FareKey, travellers: readonly Pick<BookTravellerView, 'seq' | 'type'>[]): number {
  const seqs = new Set(flights.flatMap((f) => f.participants ?? []));
  return travellers.filter((t) => t.type === TYPE_OF[k] && seqs.has(t.seq)).length;
}

/** Next flight defaults (change 7): from = last To, date = last arrival (or departure) date. */
export function nextFlightFrom(last: FlightLeg | null): { from: string; date: string } {
  if (!last) return { from: '', date: '' };
  return { from: last.to, date: last.arrivalDate || last.date };
}

export { addDays };
