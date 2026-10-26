import { scanText } from '@/modules/documents/safety';
import type { QuotationContent } from './contracts';
import type { QuotationLineInput, QuotationPlanRow } from './forms';
import { QFIELD } from './forms';

/*
 * Save-time content-safety check for customer-visible quotation text (Nova's
 * scan, documents/safety.ts: internal rate words, sales pressure, old
 * template leftovers, raw GDS strings, CRM-internal words). Runs BEFORE the
 * database command so staff keep their typed input; a hit is refused with
 * the same token the SQL uses (`internal_wording`) and the form inputs to
 * highlight, never the matched text. Internal fields (cost, remarks,
 * requirements note) are never scanned. Pure.
 */

function hit(text: string | null | undefined): boolean {
  return typeof text === 'string' && text !== '' && scanText(text).length > 0;
}

/** Form inputs (0-based, as posted) whose customer text has a forbidden word; empty when clean. */
export function contentWordingFields(content: QuotationContent): string[] {
  const out: string[] = [];
  content.days.forEach((d, i) => {
    if (hit(d.title)) out.push(`${QFIELD.dayTitle}[${i}]`);
    if (hit(d.text)) out.push(`${QFIELD.dayText}[${i}]`);
  });
  content.includes.forEach((t, i) => hit(t) && out.push(`${QFIELD.include}[${i}]`));
  content.excludes.forEach((t, i) => hit(t) && out.push(`${QFIELD.exclude}[${i}]`));
  content.terms.forEach((t, i) => hit(t) && out.push(`${QFIELD.term}[${i}]`));
  if (hit(content.notes)) out.push(QFIELD.notes);
  return out;
}

/** Price line descriptions (line n → lineDescription[n − 1]); costs and remarks are internal and not scanned. */
export function linesWordingFields(lines: readonly Pick<QuotationLineInput, 'lineNo' | 'description'>[]): string[] {
  return lines.filter((l) => hit(l.description)).map((l) => `${QFIELD.lineDescription}[${l.lineNo - 1}]`);
}

/** Tier names printed on the document. */
export function tiersWordingFields(tiers: ReadonlyArray<{ tierKey: 'quoted' | 'upgrade'; label: string | null }>): string[] {
  return tiers.filter((t) => hit(t.label)).map((t) => (t.tierKey === 'quoted' ? QFIELD.quotedTierLabel : QFIELD.upgradeTierLabel));
}

/** Instalment labels printed in the payment schedule. */
export function planWordingFields(rows: readonly Pick<QuotationPlanRow, 'seq' | 'label'>[]): string[] {
  return rows.filter((r) => hit(r.label)).map((r) => `${QFIELD.instalmentLabel}[${r.seq - 1}]`);
}

/** The company name printed with the customer contact. */
export function companyWordingFields(companyName: string | null): string[] {
  return hit(companyName) ? [QFIELD.companyName] : [];
}
