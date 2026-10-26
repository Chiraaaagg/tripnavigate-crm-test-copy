import { scanStrings, type SafetyHit } from './safety';

/**
 * Save-time content-safety check for customer-visible text (quotation day
 * plans, includes/excludes, terms, line descriptions, itinerary stories).
 * Terra's save actions call it BEFORE the database command so staff see the
 * refusal with their typed input kept; the page scan at render time stays as
 * the final check. Pure; reports paths and list phrases, never the text.
 */
export type CustomerTextCheck = { ok: true } | { ok: false; hits: SafetyHit[] };

export function checkCustomerText(fields: Record<string, unknown>): CustomerTextCheck {
  const hits = scanStrings(fields);
  return hits.length ? { ok: false, hits } : { ok: true };
}
