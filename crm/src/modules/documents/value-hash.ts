import { createHash } from 'node:crypto';
import type { FactDifference } from './contracts';
import { differenceKey, type DetailedComparison } from './facts-diff';

/**
 * Hash of one side's value of a factual difference (Atlas 0500 review E3-9:
 * `factsValueHash` / `basisValueHash`, 32-64 lower-case hex). sha256 (64 hex)
 * of a canonical JSON: object keys sorted at every depth, `undefined` read as
 * null, text as stored (the comparison itself already ignored case and
 * spacing). Only the hash ever leaves the server code; never the value.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function valueHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** A difference as `itinerary_differences_save` takes it: path, kind and both value hashes (never a value). */
export interface SaveableDifference extends FactDifference {
  /** sha256 of the itinerary-side value (a missing value hashes as JSON null). */
  factsValueHash: string;
  /** sha256 of the basis-side value. */
  basisValueHash: string;
}

export function toSaveableDifferences(c: DetailedComparison): SaveableDifference[] {
  return c.differences.map((d) => ({
    ...d,
    factsValueHash: valueHash(c.draftValues.get(differenceKey(d))),
    basisValueHash: valueHash(c.basisValues.get(differenceKey(d))),
  }));
}
