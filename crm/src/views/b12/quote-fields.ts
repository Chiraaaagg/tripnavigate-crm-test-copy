import type { StatusTone } from '@/components/ui/badge';
import { QUOTATION_ISSUE_TEXT, QUOTATION_TEXT, TIER_KEY_LABEL, type DueRule, type QuotationChecklistCode, type QuotationSection } from '@/modules/quotations/contracts';
import { formatInr } from '@/modules/quotations/money';
import { dateText } from '../b11/book-fields';
import type { QuoteInstalmentView, QuoteLineView, QuoteState, QuoteTierMoney, QuoteVersionSummary, QuoteVersionView } from './quote-shapes';

/*
 * Pure helpers and the screen words of the quotation screens (B1.2 Phase E;
 * freeze note part 2 §2–§3, DEC-33 … DEC-35). Money stays whole paise in
 * strings; amounts are formatted with Terra's exact bigint formatter.
 */

/** Screen words for the effective state (stricter than the stored label: they say what is still possible). */
export const QUOTE_STATE_LABEL: Record<QuoteState, string> = {
  // Batch 2 (copy-catalogue Q-06 / DA-41): "Shared", never "Sent" (the CRM sends nothing).
  draft: 'Draft',
  ready: 'Ready to share',
  sent: 'Shared with customer',
  accepted: 'Accepted',
  declined: 'Declined',
  expired: 'Expired · cannot be accepted',
  superseded: 'Replaced by a newer version · cannot be accepted',
  discarded: 'Discarded',
};

export const QUOTE_STATE_TONE: Record<QuoteState, StatusTone> = {
  draft: 'neutral',
  ready: 'info',
  sent: 'info',
  accepted: 'success',
  declined: 'danger',
  expired: 'danger',
  superseded: 'neutral',
  discarded: 'neutral',
};

export const TIER_LABEL = TIER_KEY_LABEL;

export const QUOTE_TEXT = {
  noInternalWords: 'Checked: no internal or pushy words.',
  previewNeedsPrices: 'The customer copy shows prices, so only Sales on this lead or deal can open it.',
  pricesForEditors: 'Prices are shown only to Sales on this lead or deal.',
} as const;

export function inr0(value: string | bigint | null | undefined): string {
  return formatInr(value ?? null) ?? '—';
}

/** "1 room × 3 nights × ₹22,000 per room per night = ₹66,000": the arithmetic staff typed, nothing more. */
export function lineFormula(line: Pick<QuoteLineView, 'unitKind' | 'units' | 'periods' | 'unitSellPaise' | 'lineSellPaise'>): string {
  const rate = inr0(line.unitSellPaise);
  const total = Number(line.lineSellPaise) === 0 ? 'included' : inr0(line.lineSellPaise);
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  switch (line.unitKind) {
    case 'room_night':
      return `${n(line.units, 'room', 'rooms')} × ${n(line.periods, 'night', 'nights')} × ${rate} per room per night = ${total}`;
    case 'trip':
      return `${n(line.units, 'vehicle', 'vehicles')} × ${n(line.periods, 'trip', 'trips')} × ${rate} per trip = ${total}`;
    case 'night':
      return `${line.units} × ${n(line.periods, 'night', 'nights')} × ${rate} per night = ${total}`;
    case 'person':
      return `${n(line.units, 'person', 'persons')} × ${rate} per person = ${total}`;
    case 'line_total':
    default:
      return `${total} total for the line`;
  }
}

/** The warning when the line prices and the typed total differ (never a refusal, never corrected). */
export function mismatchText(tier: Pick<QuoteTierMoney, 'tierKey' | 'quotedTotalPaise' | 'componentSellPaise' | 'componentDifferencePaise'>): string | null {
  if (tier.componentDifferencePaise === null || tier.componentDifferencePaise === '0') return null;
  const d = BigInt(tier.componentDifferencePaise);
  return `${TIER_LABEL[tier.tierKey]}: ${QUOTATION_TEXT.mismatchWarning
    .replace('{components}', inr0(tier.componentSellPaise))
    .replace('{total}', inr0(tier.quotedTotalPaise))
    .replace('{difference}', inr0(d < 0n ? -d : d))
    .replace('{direction}', d > 0n ? 'higher' : 'lower')} Check before sending; nothing is corrected automatically.`;
}

/** Per person only when exact; otherwise "₹total for N travellers". */
export function perPersonText(tier: Pick<QuoteTierMoney, 'quotedTotalPaise' | 'payingTravellers' | 'perPersonPaise' | 'showPerPerson'>): string | null {
  if (!tier.quotedTotalPaise || !tier.payingTravellers) return null;
  if (tier.showPerPerson && tier.perPersonPaise) return `${inr0(tier.perPersonPaise)} per person`;
  return QUOTATION_TEXT.totalForTravellers.replace('{total}', inr0(tier.quotedTotalPaise)).replace('{count}', String(tier.payingTravellers));
}

export function dueText(i: Pick<QuoteInstalmentView, 'dueRule' | 'dueDays' | 'dueDate'>): string {
  const rule: DueRule = i.dueRule;
  if (rule === 'on_acceptance') return 'On confirmation';
  if (rule === 'days_before_start') return `${i.dueDays ?? '?'} days before departure`;
  return `By ${dateText(i.dueDate) ?? '?'}`;
}

export function paxText(pax: QuoteVersionView['pax']): string {
  const parts: string[] = [];
  if (pax.adults) parts.push(`${pax.adults} adult${pax.adults === 1 ? '' : 's'}`);
  const kids = (pax.childrenWithBed ?? 0) + (pax.childrenNoBed ?? 0);
  if (kids) parts.push(`${kids} child${kids === 1 ? '' : 'ren'}${pax.childrenNoBed ? ` (${pax.childrenNoBed} without a bed)` : ''}`);
  if (pax.infants) parts.push(`${pax.infants} infant${pax.infants === 1 ? '' : 's'}`);
  return parts.join(', ') || 'Travellers not entered';
}

export function nightsText(start: string | null, end: string | null): string | null {
  if (!start || !end || end < start) return null;
  const n = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000);
  return `${n} night${n === 1 ? '' : 's'}`;
}

/** Validity in words with the effective state (expiry is computed on every read). */
export function validityText(v: { status: QuoteState; validUntil: string | null }): string {
  if (!v.validUntil) return 'Valid for 7 days after sending (editable before sending)';
  if (v.status === 'expired') return `Expired ${dateText(v.validUntil)}`;
  return `Valid until ${dateText(v.validUntil)}`;
}

/** Issue codes → text, blocking flag and the editor section that fixes them. */
export function issuesOf(codes: readonly QuotationChecklistCode[]): Array<{ code: QuotationChecklistCode; text: string; blocking: boolean; section: QuotationSection }> {
  return codes.map((code) => ({ code, ...QUOTATION_ISSUE_TEXT[code] }));
}

export function latestVersion(versions: readonly QuoteVersionSummary[]): QuoteVersionSummary | null {
  return [...versions].sort((a, b) => b.versionNo - a.versionNo)[0] ?? null;
}
