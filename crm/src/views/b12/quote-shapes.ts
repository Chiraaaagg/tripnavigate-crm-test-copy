import type {
  QuotationInstalmentView,
  QuotationLineView,
  QuotationLinkCandidate,
  QuotationListView,
  QuotationStatus,
  QuotationSummary,
  QuotationTierMoneyView,
  QuotationVersionSummary,
  QuotationVersionView,
  TierKey,
} from '@/modules/quotations/contracts';

/*
 * View-side names for the quotation screens (B1.2 Phase E), pointed at
 * Terra's contracts (claude/b12-ts 0afa454, module modules/quotations).
 * Screens import from here so contract names stay in one place.
 */

export type QuoteState = QuotationStatus;
export type QuoteTierKey = TierKey;
export type QuoteLineView = QuotationLineView;
export type QuoteTierMoney = QuotationTierMoneyView;
export type QuoteInstalmentView = QuotationInstalmentView;
export type QuoteVersionView = QuotationVersionView;
export type QuoteVersionSummary = QuotationVersionSummary;
export type QuoteListView = QuotationListView;
export type QuoteSummary = QuotationSummary;
export type QuoteLinkCandidate = QuotationLinkCandidate;

/**
 * What the quotation screen shows beyond one version: the version list (from
 * the quotation's summary) and, for an accepted Lead quotation, the Deals
 * Bitrix sent that came from this Lead.
 */
export interface QuoteScreenData {
  version: QuoteVersionView;
  versions: QuoteVersionSummary[];
  /** null = not asked (not a Lead quotation, or not accepted yet). */
  candidates: QuoteLinkCandidate[] | null;
  ownerName: string | null;
  /** Reference and title of the linked Deal (the view carries only its id). */
  linkedDeal: { reference: string; title: string } | null;
}

/** Derived state of the Lead → Deal link (freeze note part 2 §2.6). */
export type QuoteLinkState = 'not_needed' | 'waiting' | 'candidate' | 'linked';

export function linkStateOf(data: Pick<QuoteScreenData, 'version' | 'candidates'>): QuoteLinkState {
  const v = data.version;
  if (v.subject.kind !== 'lead' || v.status !== 'accepted') return v.linkedDealId ? 'linked' : 'not_needed';
  if (v.linkedDealId) return 'linked';
  return data.candidates && data.candidates.some((c) => c.linkable) ? 'candidate' : 'waiting';
}

export function dealHref(dealId: string): string {
  return `/app/deals/${dealId}`;
}

export function bookingHref(dealId: string): string {
  return `/app/deals/${dealId}/book`;
}

/** The quotation screen of one version. */
export function quotationHref(versionId: string): string {
  return `/app/quotations/${versionId}`;
}

export function quotationPreviewHref(versionId: string): string {
  return `/app/quotations/${versionId}/preview`;
}
