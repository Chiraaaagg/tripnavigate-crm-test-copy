/**
 * Content-safety scan for customer documents (freeze part 2 section 5; Nova
 * Phase A section 5 rule 6). Runs on saved customer text and on the rendered
 * page text of BOTH documents (quotation and itinerary); any hit blocks
 * sending / issuing. Pure.
 *
 * The vocabulary follows the owner's quotation engine audit (internal rate
 * words, sales-pressure words, old-template leftovers, raw GDS strings),
 * written here independently and extended with CRM words that must never
 * reach a customer (Bitrix, purchase budget, supplier cost, paise, payment
 * claims, staff-only notes, identity numbers).
 *
 * The word lists live in ./safety-words.json (data, not identifiers: the
 * agent-portal scope guard forbids some of these words in TypeScript source).
 *
 * Matching is whole-phrase and case-insensitive ("international flights" never
 * reads as "internal"). A hit reports the list phrase and the place, never the
 * surrounding customer text.
 */

import WORDS from './safety-words.json';

export type SafetyKind = 'internal_rate' | 'sales_pressure' | 'old_template' | 'raw_gds' | 'crm_internal';

export interface SafetyHit {
  kind: SafetyKind;
  /** The list phrase or pattern name that matched (never customer text). */
  phrase: string;
  /** Field path for structured input; absent for rendered page text. */
  path?: string;
}

const PHRASES: Record<Exclude<SafetyKind, 'raw_gds'>, readonly string[]> = {
  internal_rate: WORDS.internal_rate,
  sales_pressure: WORDS.sales_pressure,
  old_template: WORDS.old_template,
  crm_internal: WORDS.crm_internal,
};

/** Raw GDS fragments: a booking-status token (HS1, HK2, ...), or a glued city pair followed by one. */
const GDS_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'gds_status_code', re: /\b(HS|HK|HL|UC|UN|NO|KK|TK)\d\b/ },
  { name: 'gds_sector_pair', re: /\b[A-Z]{3}[A-Z]{3}\s+(HS|HK)\d?\b/ },
];

/** CRM reference shapes that must not print (Bitrix Deal / Lead numbers). */
const REFERENCE_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'bitrix_reference', re: /\bBXL?-\d+\b/ },
];

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const COMPILED: ReadonlyArray<{ kind: SafetyKind; phrase: string; re: RegExp }> = (
  Object.entries(PHRASES) as Array<[Exclude<SafetyKind, 'raw_gds'>, readonly string[]]>
).flatMap(([kind, list]) =>
  list.map((phrase) => ({ kind, phrase, re: new RegExp(`(^|[^a-z0-9])${escape(phrase)}([^a-z0-9]|$)`, 'i') })),
);

/** Every hit in one text (each phrase at most once). */
export function scanText(text: string): SafetyHit[] {
  const hits: SafetyHit[] = [];
  for (const { kind, phrase, re } of COMPILED) if (re.test(text)) hits.push({ kind, phrase });
  for (const { name, re } of GDS_PATTERNS) if (re.test(text)) hits.push({ kind: 'raw_gds', phrase: name });
  for (const { name, re } of REFERENCE_PATTERNS) if (re.test(text)) hits.push({ kind: 'crm_internal', phrase: name });
  return hits;
}

/** Walks every string of a structured value (document input or view) and reports hits with their path. */
export function scanStrings(value: unknown, path = ''): SafetyHit[] {
  if (typeof value === 'string') return scanText(value).map((h) => ({ ...h, path: path || '$' }));
  if (Array.isArray(value)) return value.flatMap((v, i) => scanStrings(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => scanStrings(v, path ? `${path}.${k}` : k));
  }
  return [];
}

/** Plain text of rendered HTML for the page scan (tags and entities removed). */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
