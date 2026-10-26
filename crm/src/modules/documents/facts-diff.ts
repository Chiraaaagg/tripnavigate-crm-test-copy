import type { FactDifference, TripFactsSet } from './contracts';

/**
 * Factual differences between the comparison basis (Atlas
 * `authz.itinerary_basis`: accepted quotation version, else the live sent one,
 * else the working version; or the Deal's booking version) and the itinerary
 * facts draft. Pure. Output matches Atlas `itinerary_fact_differences`
 * (migration 20261120000500): `{path, kind}` with kind `missing | different |
 * extra`, path `^[A-Za-z][A-Za-z0-9_.\[\]-]{0,119}$`, unique per (path, kind);
 * no values are ever stored (the screen shows both sides from their records).
 *
 * Path and index convention (frozen with Atlas's shapes):
 *   missing    the basis has it, the itinerary does not; an index is the BASIS index
 *   extra      the itinerary has it, the basis does not; an index is the ITINERARY index
 *   different  both have it and it differs; an index is the ITINERARY index
 * Examples: `startDate`, `party.adults`, `stays` (city order), `stays[1].hotelName`,
 * `transfers[0].date`, `activities[2]`, `inclusions[3]`, `exclusions[0]`.
 *
 * Factual: dates, travellers, city order, nights per city, hotel and room
 * details, transfers, activities, flights, inclusions/exclusions (an item
 * included on one side and excluded on the other is `different` on the
 * itinerary list where it now sits). Not factual: wording, highlight order,
 * marketing copy, photos. Text compares ignoring case, accents, spacing and
 * punctuation (but "&" is kept, so "&" and "and" differ; staff confirm).
 */

export const DIFFERENCE_PATH = /^[A-Za-z][A-Za-z0-9_.[\]-]{0,119}$/;

export function normaliseFactText(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9&]+/g, ' ')
    .trim();
}

function present(v: unknown): boolean {
  return !(v === null || v === undefined || (typeof v === 'string' && v.trim() === ''));
}

/** Key of a difference in a basis-values map: `${kind}:${path}` (a path may carry two kinds, e.g. inclusions[1]). */
export function differenceKey(d: FactDifference): string {
  return `${d.kind}:${d.path}`;
}

class Out {
  private readonly seen = new Set<string>();
  readonly items: FactDifference[] = [];
  /** The basis value behind each difference (null for `extra`: the basis has nothing there). */
  readonly values = new Map<string, unknown>();
  /** The itinerary (draft) value behind each difference (null for `missing`). */
  readonly draftValues = new Map<string, unknown>();
  add(path: string, kind: FactDifference['kind'], basisValue: unknown = null, draftValue: unknown = null): void {
    const d = { path, kind };
    const key = differenceKey(d);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.items.push(d);
    this.values.set(key, kind === 'extra' ? null : (basisValue ?? null));
    this.draftValues.set(key, kind === 'missing' ? null : (draftValue ?? null));
  }
  /** Optional value: missing / extra / different. Text values compare normalised. */
  value(path: string, basis: unknown, draft: unknown, text: boolean): void {
    const a = present(basis);
    const b = present(draft);
    if (a && !b) this.add(path, 'missing', basis);
    else if (!a && b) this.add(path, 'extra', null, draft);
    else if (a && b && (text ? normaliseFactText(String(basis)) !== normaliseFactText(String(draft)) : basis !== draft)) {
      this.add(path, 'different', basis, draft);
    }
  }
}

/** Keyed list: match by key (in order for repeats); missing (basis index), extra and field differences (itinerary index). */
function keyed<T>(
  out: Out,
  name: string,
  basis: readonly T[],
  draft: readonly T[],
  key: (x: T) => string,
  fields: ReadonlyArray<[string, (x: T) => unknown, boolean]>,
): void {
  const used = new Set<number>();
  basis.forEach((x, bi) => {
    const di = draft.findIndex((y, i) => !used.has(i) && key(y) === key(x));
    if (di < 0) return out.add(`${name}[${bi}]`, 'missing', x);
    used.add(di);
    const y = draft[di]!;
    for (const [field, get, text] of fields) out.value(`${name}[${di}].${field}`, get(x), get(y), text);
  });
  draft.forEach((y, di) => {
    if (!used.has(di)) out.add(`${name}[${di}]`, 'extra', null, y);
  });
}

export function compareTripFacts(basis: TripFactsSet, draft: TripFactsSet): FactDifference[] {
  return compareTripFactsDetailed(basis, draft).differences;
}

export interface DetailedComparison {
  differences: FactDifference[];
  /**
   * In memory only, never stored or sent to the database: the basis value
   * behind each difference, keyed by `differenceKey` (`${kind}:${path}`), for
   * "Use quotation value". `missing` / `different`: the basis value (a scalar,
   * the matched list element, the basis stay list for a city-order change, or
   * the basis text of an inclusion/exclusion that moved lists); `extra`: null
   * (the basis has nothing there: using the basis value removes the item).
   */
  basisValues: Map<string, unknown>;
  /** Same, for the itinerary side (null for `missing`). In memory only; used for the value hashes. */
  draftValues: Map<string, unknown>;
}

export function compareTripFactsDetailed(basis: TripFactsSet, draft: TripFactsSet): DetailedComparison {
  const out = new Out();

  out.value('destination', basis.destination, draft.destination, true);
  out.value('startDate', basis.startDate, draft.startDate, false);
  out.value('endDate', basis.endDate, draft.endDate, false);

  // Travellers (child ages only when both sides know them; no age bands).
  for (const k of ['adults', 'children', 'infants'] as const) {
    if (basis.party[k] !== draft.party[k]) out.add(`party.${k}`, 'different', basis.party[k], draft.party[k]);
  }
  if (basis.party.childAges && draft.party.childAges) {
    const a = [...basis.party.childAges].sort((x, y) => x - y).join(',');
    const b = [...draft.party.childAges].sort((x, y) => x - y).join(',');
    if (a !== b) out.add('party.childAges', 'different', basis.party.childAges, draft.party.childAges);
  }

  // Stays: the city order first; when it matches, each stay's details.
  const order = (s: TripFactsSet['stays']) => s.map((x) => normaliseFactText(x.city)).join('|');
  if (order(basis.stays) !== order(draft.stays)) {
    out.add('stays', 'different', basis.stays, draft.stays);
  } else {
    basis.stays.forEach((s, i) => {
      const d = draft.stays[i]!;
      if (s.nights !== d.nights) out.add(`stays[${i}].nights`, 'different', s.nights, d.nights);
      out.value(`stays[${i}].checkIn`, s.checkIn, d.checkIn, false);
      out.value(`stays[${i}].checkOut`, s.checkOut, d.checkOut, false);
      out.value(`stays[${i}].hotelName`, s.hotelName, d.hotelName, true);
      out.value(`stays[${i}].roomType`, s.roomType, d.roomType, true);
      out.value(`stays[${i}].mealPlan`, s.mealPlan, d.mealPlan, true);
      out.value(`stays[${i}].rooms`, s.rooms, d.rooms, false);
    });
  }

  keyed(out, 'transfers', basis.transfers, draft.transfers, (t) => `${normaliseFactText(t.from)}>${normaliseFactText(t.to)}`, [
    ['date', (t) => t.date, false],
    ['mode', (t) => t.mode, true],
  ]);
  keyed(out, 'activities', basis.activities, draft.activities, (a) => normaliseFactText(a.name), [
    ['date', (a) => a.date, false],
    ['included', (a) => a.included, false],
  ]);
  keyed(out, 'flights', basis.flights, draft.flights, (f) => `${normaliseFactText(f.from)}>${normaliseFactText(f.to)}`, [
    ['date', (f) => f.date, false],
    ['carrier', (f) => f.carrier, true],
    ['number', (f) => f.number, true],
  ]);

  // Inclusions / exclusions (only when the basis records them; a booking version does not).
  if (basis.inclusions === null || basis.exclusions === null || draft.inclusions === null || draft.exclusions === null) {
    return { differences: out.items, basisValues: out.values, draftValues: out.draftValues };
  }
  const bInc = basis.inclusions;
  const bExc = basis.exclusions;
  const dInc = draft.inclusions;
  const dExc = draft.exclusions;
  const norm = (xs: string[]) => xs.map(normaliseFactText);
  const [bi, be, di, de] = [norm(basis.inclusions), norm(basis.exclusions), norm(draft.inclusions), norm(draft.exclusions)];
  bi.forEach((x, i) => {
    if (!x || di.includes(x)) return;
    const j = de.indexOf(x);
    if (j >= 0) out.add(`exclusions[${j}]`, 'different', bInc[i], dExc[j]);
    else out.add(`inclusions[${i}]`, 'missing', bInc[i]);
  });
  di.forEach((x, i) => {
    if (!x || bi.includes(x)) return;
    const k = be.indexOf(x);
    if (k >= 0) out.add(`inclusions[${i}]`, 'different', bExc[k], dInc[i]);
    else out.add(`inclusions[${i}]`, 'extra', null, dInc[i]);
  });
  be.forEach((x, i) => {
    if (!x || de.includes(x) || di.includes(x)) return;
    out.add(`exclusions[${i}]`, 'missing', bExc[i]);
  });
  de.forEach((x, i) => {
    if (!x || be.includes(x) || bi.includes(x)) return;
    out.add(`exclusions[${i}]`, 'extra', null, dExc[i]);
  });

  return { differences: out.items, basisValues: out.values, draftValues: out.draftValues };
}
