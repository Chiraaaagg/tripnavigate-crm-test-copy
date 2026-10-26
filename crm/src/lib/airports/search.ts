/*
 * Airport search of the booking form's From / To boxes (Book now v2, change 3).
 * The prototype's searchAirports, with the lead's review-round-1 ranking:
 * "Jodhpur (JDH)" finds JDH; otherwise the prototype's own rows come first
 * (an exact code, then a city or name that starts with the text), then an
 * exact code elsewhere, then a code, city or name that starts with the text
 * elsewhere, then anything that contains it; at most 8. Accents are folded,
 * so "male" finds Malé. The list (airports.json, built by
 * scripts/build-airports.mjs) is loaded with a dynamic import when a flight
 * drawer opens, so it is never part of the first page load.
 */

export interface Airport {
  /** IATA code, e.g. "JDH". */
  c: string;
  city: string;
  name: string;
  /** ISO country code, e.g. "IN". */
  country: string;
  /** One of the owner-approved prototype's rows (ranked first). */
  top?: boolean;
}

export type AirportRow = readonly [string, string, string, string] | readonly [string, string, string, string, number];

export const AIRPORT_RESULTS_MAX = 8;

export function airportsFromRows(rows: readonly AirportRow[]): Airport[] {
  return rows.map((r) => ({ c: r[0], city: r[1], name: r[2], country: r[3], ...(r[4] === 1 ? { top: true } : {}) }));
}

let cache: Promise<Airport[]> | null = null;

/** The full list, loaded once per page (dynamic import, its own chunk). */
export function loadAirports(): Promise<Airport[]> {
  cache ??= import('./airports.json').then((m) => airportsFromRows((m.default ?? m) as unknown as AirportRow[]));
  return cache;
}

export function findAirport(list: readonly Airport[], code: string | null | undefined): Airport | null {
  if (!code) return null;
  const up = code.trim().toUpperCase();
  return list.find((a) => a.c === up) ?? null;
}

/** "Jodhpur (JDH)" — the text shown in the box once an airport is picked. */
export const airportLabel = (a: Airport) => `${a.city} (${a.c})`;

/** Lower case without accents ("Malé" → "male"). */
export const fold = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export function searchAirports(list: readonly Airport[], query: string): Airport[] {
  let q = fold(query.trim());
  if (!q) return [];
  const inBrackets = /\(([a-z]{3})\)/.exec(q);
  if (inBrackets) {
    const hit = findAirport(list, inBrackets[1]);
    if (hit) return [hit];
  }
  q = q.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q) return [];
  // Tiers: 0 prototype exact code, 1 prototype prefix, 2 exact code, 3 prefix, 4 contains.
  const tiers: Airport[][] = [[], [], [], [], []];
  for (const a of list) {
    const code = a.c.toLowerCase();
    const city = fold(a.city);
    const name = fold(a.name);
    const prefix = code.startsWith(q) || city.startsWith(q) || name.startsWith(q);
    if (code === q) tiers[a.top ? 0 : 2]!.push(a);
    else if (prefix) tiers[a.top ? 1 : 3]!.push(a);
    else if (city.includes(q) || name.includes(q)) tiers[4]!.push(a);
  }
  return tiers.flat().slice(0, AIRPORT_RESULTS_MAX);
}
