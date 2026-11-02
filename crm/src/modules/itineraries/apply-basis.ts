import { z } from 'zod';
import { ItineraryFactsSchema } from './commands';
import type { DifferenceKind, ItineraryFacts } from './contracts';

/*
 * "Use the quotation (or booking) value" for one factual difference: write
 * the basis value for that path into the itinerary facts. Pure. Paths and
 * indexes follow Nova's facts-diff convention (0-based; `missing` → basis
 * index, `extra`/`different` → itinerary index). The basis value comes from
 * Nova's in-memory comparison (never stored) in the Atlas facts shape: a
 * scalar for a field path, a whole row for a list-row path, the whole stay
 * list for `stays`. An `extra` difference has no basis value: using the
 * basis means removing it. Answers the new facts and the provenance path to
 * mark, or null when the path or value does not fit (never guesses).
 */

const LISTS = ['stays', 'days', 'transfers', 'activities', 'flights'] as const;
type ListName = (typeof LISTS)[number];
const STRING_LISTS = ['inclusions', 'exclusions'] as const;

/** Validate a candidate facts object exactly as the read schema does (fail closed). */
function valid(facts: unknown): ItineraryFacts | null {
  const parsed = ItineraryFactsSchema.safeParse(facts);
  return parsed.success ? parsed.data : null;
}

export function applyBasisValue(
  facts: ItineraryFacts,
  diff: { path: string; kind: DifferenceKind },
  basisValue: unknown,
): { facts: ItineraryFacts; provenancePath: string | null } | null {
  const next = structuredClone(facts) as ItineraryFacts & Record<string, unknown>;
  const remove = diff.kind === 'extra';
  if (!remove && (basisValue === undefined || basisValue === null)) return null;

  const scalar = /^(destination|startDate|endDate)$/.exec(diff.path);
  if (scalar) {
    next[scalar[1] as 'destination'] = remove ? null : (basisValue as string);
    const out = valid(next);
    return out ? { facts: out, provenancePath: remove ? null : diff.path } : null;
  }

  const party = /^party\.(adults|children|infants|childAges)$/.exec(diff.path);
  if (party) {
    const key = party[1] as 'adults' | 'children' | 'infants' | 'childAges';
    (next.party as unknown as Record<string, unknown>)[key] = remove ? (key === 'childAges' ? [] : null) : basisValue;
    const out = valid(next);
    return out ? { facts: out, provenancePath: remove ? null : diff.path } : null;
  }

  if (diff.path === 'stays') {
    if (remove || !Array.isArray(basisValue)) return null;
    next.stays = basisValue as ItineraryFacts['stays'];
    const out = valid(next);
    return out ? { facts: out, provenancePath: 'stays' } : null;
  }

  const row = /^(stays|days|transfers|activities|flights|inclusions|exclusions)\[(\d+)\](?:\.([A-Za-z]+))?$/.exec(diff.path);
  if (!row) return null;
  const name = row[1] as ListName | (typeof STRING_LISTS)[number];
  const index = Number(row[2]);
  const field = row[3];
  const list = next[name] as unknown[];

  if (field) {
    if (!(LISTS as readonly string[]).includes(name) || index >= list.length) return null;
    const target = list[index] as Record<string, unknown>;
    target[field] = remove ? null : basisValue;
    const out = valid(next);
    return out ? { facts: out, provenancePath: remove ? null : diff.path } : null;
  }

  if (remove) {
    if (index >= list.length) return null;
    list.splice(index, 1);
    if (name === 'days') (next.days as ItineraryFacts['days']).forEach((d, i) => (d.n = i + 1));
    const out = valid(next);
    return out ? { facts: out, provenancePath: null } : null;
  }

  // missing row: append the basis row (strings for inclusions/exclusions).
  if ((STRING_LISTS as readonly string[]).includes(name) ? typeof basisValue !== 'string' : typeof basisValue !== 'object' || Array.isArray(basisValue)) return null;
  const appended = name === 'days' ? { ...(basisValue as object), n: list.length + 1 } : basisValue;
  list.push(appended);
  const out = valid(next);
  return out ? { facts: out, provenancePath: `${name}[${list.length - 1}]` } : null;
}

export const ApplyPathSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_.[\]-]{0,119}$/);
