/**
 * Customer text helpers for document inputs. Pure.
 *
 * Placeholder rule (engine convention): a value the CRM does not know is
 * written "[Plain label]" and prints as a visible dashed token; any
 * placeholder blocks sending or issuing (preview only).
 *
 * The owner's quotation template treats any string that STARTS with "[" as a
 * placeholder and the itinerary template any string wholly in brackets, so
 * real customer text beginning with "[" is neutralised before it reaches a
 * template (the leading bracket pair becomes round brackets).
 */

export function placeholder(label: string): string {
  return `[${label.replace(/[[\]]/g, '').trim()}]`;
}

/** True for a placeholder token produced by `placeholder` (whole value in brackets). */
export function isPlaceholder(value: unknown): value is string {
  return typeof value === 'string' && /^\[[^[\]]*\]$/.test(value.trim());
}

/** Real text never starts with "[" (so no template mistakes it for a placeholder). */
export function neutraliseLeadingBracket(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[')) return trimmed;
  // The leading bracket pair becomes round brackets: "[Optional] dinner" -> "(Optional) dinner".
  const close = trimmed.indexOf(']');
  return close > 0 ? `(${trimmed.slice(1, close)})${trimmed.slice(close + 1)}` : `(${trimmed.slice(1)}`;
}

/**
 * Collects placeholders while an adapter builds its input: `text(value, label)`
 * returns the neutralised text, or a placeholder (recorded) when empty.
 */
export class PlaceholderCollector {
  readonly labels: string[] = [];

  text(value: string | null | undefined, label: string): string {
    if (value === null || value === undefined || value.trim() === '') return this.mark(label);
    return neutraliseLeadingBracket(value);
  }

  number(value: number | null | undefined, label: string): number | string {
    return value === null || value === undefined || !Number.isFinite(value) ? this.mark(label) : value;
  }

  mark(label: string): string {
    const token = placeholder(label);
    this.labels.push(token.slice(1, -1));
    return token;
  }
}

/** Neutralises every string of a list and drops empty ones. */
export function cleanList(values: readonly string[] | null | undefined): string[] {
  return (values ?? []).map((v) => (typeof v === 'string' ? neutraliseLeadingBracket(v) : '')).filter((v) => v !== '');
}

/** "2026-11-20" -> "20 Nov" (engine short date); null for anything else. */
export function shortDate(iso: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  if (!m) return null;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month}` : null;
}

/** Whole days between two YYYY-MM-DD dates (end - start), or null. */
export function daysBetween(start: string | null | undefined, end: string | null | undefined): number | null {
  const a = /^\d{4}-\d{2}-\d{2}$/.test(start ?? '') ? Date.parse(`${start}T00:00:00Z`) : NaN;
  const b = /^\d{4}-\d{2}-\d{2}$/.test(end ?? '') ? Date.parse(`${end}T00:00:00Z`) : NaN;
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}
