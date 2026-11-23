import { errorSummary, orderSummaryItems } from '@/modules/fulfilment/book-flow';
import type { ErrorSummaryItem, ErrorSummaryVM, SaveRunReport } from '@/modules/fulfilment/book-flow-contract';
import type { PrefillFieldCode, PrefillView } from '@/modules/fulfilment/contracts';
import type { PrefillFieldStateRead } from '@/modules/fulfilment/prefill-contract';
import {
  QUOTATION_DEFAULT_VALID_DAYS,
  QUOTATION_ISSUE_TEXT,
  QUOTATION_TEXT,
  type QuotationChecklistCode,
  type QuotationVersionSummary,
  type QuotationVersionView,
} from './contracts';
import type {
  QuoteCopyLinks,
  QuoteCopyTab,
  QuoteHeaderVM,
  QuoteIssueTargets,
  QuoteMoreAction,
  QuotePartKey,
  QuotePartState,
  QuotePartVM,
  QuotePricesSaveReport,
  QuotePricesSaveStep,
  QuotePrimary,
  QuoteReadinessVM,
  QuoteStatusWord,
} from './editor-contract';

/*
 * Batch 2 quotation editor model (pure, server-safe; contract
 * editor-contract.ts): part states incl. "Not started", the readiness card,
 * the header (status word, one primary, More), the "Check and mark ready"
 * summary (unsaved parts first, duplicates once, internal checks only for
 * price readers), the Prices save report and the Edit / Customer copy links.
 * The server decides again on every command; nothing here authorizes.
 */

export const QUOTE_PART_ORDER = ['details', 'contact', 'services', 'narrative', 'money', 'plan'] as const satisfies readonly QuotePartKey[];

/** Part names (QE-12, accepted in DA-180). */
export const QUOTE_PART_LABEL: Record<QuotePartKey, string> = {
  details: 'Trip',
  contact: 'Customer',
  services: 'Services',
  narrative: 'Day plan and terms',
  money: 'Prices',
  plan: 'Payment plan',
};

// ---------------------------------------------------------------------------
// Bitrix-only values ("Not started" rule)
// ---------------------------------------------------------------------------

/**
 * Fields whose only content came from Bitrix and that staff never touched.
 * With Atlas's fieldStates: filledBy set and staffTouched false. Without
 * them (older database, or before the read is parsed): a mark still
 * from_bitrix.
 */
export function untouchedBitrixFields(prefill: Pick<PrefillView, 'fields'> | null | undefined, fieldStates?: readonly PrefillFieldStateRead[] | null): Set<PrefillFieldCode> {
  if (fieldStates && fieldStates.length > 0) return new Set(fieldStates.filter((f) => f.filledBy !== null && !f.staffTouched).map((f) => f.field));
  return new Set((prefill?.fields ?? []).filter((f) => f.state === 'from_bitrix').map((f) => f.field));
}

type V = QuotationVersionView;
const has = (s: string | null | undefined) => typeof s === 'string' && s.trim().length > 0;

/**
 * Does the part hold staff content? Creation defaults never count: the
 * stored validity date, zero traveller counts, the empty `quoted` option and
 * the empty content object that quotation_create writes for version 1; nor
 * do values written from Bitrix that staff never touched.
 */
function started(v: V, part: QuotePartKey, bitrixOnly: ReadonlySet<PrefillFieldCode>): boolean {
  const staff = (code: PrefillFieldCode, value: string | null | undefined) => has(value) && !bitrixOnly.has(code);
  switch (part) {
    case 'details':
      return (
        has(v.trip.destination) ||
        v.trip.scope !== null ||
        staff('trip.start', v.trip.start) ||
        staff('trip.end', v.trip.end) ||
        v.pax.adults + v.pax.childrenWithBed + v.pax.childrenNoBed + v.pax.infants > 0 ||
        has(v.pax.paxRemarks) ||
        staff('requirementsNote', v.requirementsNote)
        // The validity date is never staff input here: quotation_create stores a default (creation day + 7, IST,
        // quotation_versions.valid_until NOT NULL), so an untouched version 1 always has one (gate 26c697c).
      );
    case 'contact': {
      const c = v.contact;
      if (!c) return false;
      return (
        staff('contacts.contactName', c.contactName) ||
        staff('contacts.mobile', c.mobile) ||
        staff('contacts.email', c.email) ||
        staff('contacts.companyName', c.companyName) ||
        (c.bookingFor === 'business' && !bitrixOnly.has('contacts.bookingFor'))
      );
    }
    case 'services':
      return v.items.length > 0;
    case 'narrative':
      return v.content.days.length > 0 || v.content.includes.length > 0 || v.content.excludes.length > 0 || v.content.terms.length > 0 || has(v.content.notes);
    case 'money': {
      const m = v.money;
      if (!m) return false;
      return m.lines.length > 0 || m.tiers.some((t) => t.quotedTotalPaise !== null || (t.tierKey === 'upgrade' && has(t.label))) || has(v.tiers.find((t) => t.tierKey === 'quoted')?.label);
    }
    case 'plan':
      return (v.money?.plan.length ?? 0) > 0;
  }
}

export interface PartInput {
  /** Parts with unsaved changes (from DraftSync). */
  dirty?: ReadonlySet<QuotePartKey>;
  /** "Check and mark ready" was pressed on this page: parts with blocking checks show needs_input. */
  checked?: boolean;
  /** The part a link targets (opens it). */
  target?: QuotePartKey | null;
  fieldStates?: readonly PrefillFieldStateRead[] | null;
}

const BLOCKING_PART = (codes: readonly QuotationChecklistCode[]): Set<QuotePartKey> => new Set(codes.filter((c) => QUOTATION_ISSUE_TEXT[c].blocking).map((c) => QUOTATION_ISSUE_TEXT[c].section));

/** Blocking codes this viewer may see: Atlas issues always, money codes only for price readers. */
export function visibleCodes(v: V): QuotationChecklistCode[] {
  return [...new Set<QuotationChecklistCode>([...v.issues, ...(v.money?.issues ?? [])])];
}

export function quotePartState(v: V, part: QuotePartKey, input: PartInput = {}): QuotePartState {
  const priceless = (part === 'money' || part === 'plan') && v.money === undefined;
  if (priceless) return 'prices_hidden';
  if (!v.canEdit) return 'read_only';
  if (input.dirty?.has(part) && input.checked) return 'needs_input';
  if (input.checked && BLOCKING_PART(visibleCodes(v)).has(part)) return 'needs_input';
  const bitrixOnly = untouchedBitrixFields(v.prefill, input.fieldStates);
  if (part === 'plan') return started(v, 'plan', bitrixOnly) ? 'saved' : 'optional';
  return started(v, part, bitrixOnly) ? 'saved' : 'not_started';
}

/** Six parts; the open one is the targeted part, else the first that needs input, else the first not started. */
export function quoteParts(v: V, input: PartInput = {}): QuotePartVM[] {
  const states = QUOTE_PART_ORDER.map((key) => ({ key, state: quotePartState(v, key, input) }));
  const openKey =
    input.target ??
    states.find((s) => s.state === 'needs_input')?.key ??
    (v.canEdit ? (states.find((s) => s.state === 'not_started')?.key ?? null) : null);
  return states.map(({ key, state }) => ({ key, label: QUOTE_PART_LABEL[key], state, open: key === openKey || (input.dirty?.has(key) ?? false) }));
}

/** A version is "Not started" when it is an editable draft and every part except the optional plan is not started. */
export function isQuoteUntouched(v: V, fieldStates?: readonly PrefillFieldStateRead[] | null): boolean {
  if (v.status !== 'draft' || !v.canEdit) return false;
  const bitrixOnly = untouchedBitrixFields(v.prefill, fieldStates);
  return QUOTE_PART_ORDER.every((p) => !started(v, p, bitrixOnly));
}

/**
 * Readiness card (DA-181 "{n} of 6 parts done"; Echo M5). A part is done
 * only when it holds saved staff content (or is the empty, optional payment
 * plan), none of today's blocking checks points at it, and it has no unsaved
 * changes. Started-but-unsaved or still-blocked parts never count.
 */
export function quoteReadiness(v: V, input: PartInput = {}): QuoteReadinessVM {
  const blocked = BLOCKING_PART(visibleCodes(v));
  const savedParts = QUOTE_PART_ORDER.filter((p) => {
    const state = quotePartState(v, p, { ...input, checked: false });
    return (state === 'saved' || state === 'optional') && !blocked.has(p) && !(input.dirty?.has(p) ?? false);
  }).length;
  const state: QuoteReadinessVM['state'] = v.status === 'ready' ? 'ready' : isQuoteUntouched(v, input.fieldStates) ? 'not_started' : 'in_progress';
  return { state, savedParts, totalParts: 6 };
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function latestNo(versions: readonly QuotationVersionSummary[], current: V): number | null {
  const newer = versions.filter((x) => x.versionNo > current.versionNo).map((x) => x.versionNo);
  return newer.length > 0 ? Math.max(...newer) : null;
}

export function quoteStatusWord(v: V, versions: readonly QuotationVersionSummary[] = [], fieldStates?: readonly PrefillFieldStateRead[] | null): QuoteStatusWord {
  switch (v.status) {
    case 'draft':
      return isQuoteUntouched(v, fieldStates) ? 'Not started' : 'Draft';
    case 'ready':
      return 'Ready to share';
    case 'sent':
      return 'Shared with customer';
    case 'accepted':
      return v.conversion ? 'Booking started' : 'Accepted';
    case 'declined':
      return 'Declined';
    case 'expired':
      return 'Expired';
    case 'superseded': {
      const n = latestNo(versions, v);
      // DA-185: the version list normally names the newer version; without it, no guessed number.
      return n === null ? 'Replaced by a newer version' : `Replaced by v${n}`;
    }
    case 'discarded':
      return 'Discarded';
  }
}

export function quotePrimary(v: V, versions: readonly QuotationVersionSummary[] = [], hasCandidates = false): QuotePrimary {
  switch (v.status) {
    case 'draft':
      return v.canMarkReady ? 'check_and_mark_ready' : null;
    case 'ready':
      return v.canSend ? 'mark_as_shared' : null;
    case 'sent':
      return v.canUploadEvidence || v.canAccept || v.canDecline ? 'record_answer' : null;
    case 'accepted':
      if (v.conversion) return 'continue_booking';
      if (v.canConvert) return 'start_booking';
      if (v.canLinkDeal && hasCandidates) return 'link_deal';
      return null;
    case 'expired':
    case 'declined':
      return v.canNewVersion ? 'new_version' : null;
    case 'superseded':
    case 'discarded':
      return latestNo(versions, v) !== null ? 'open_version' : null;
  }
}

export function quoteMore(v: V, primary: QuotePrimary): QuoteMoreAction[] {
  const more: QuoteMoreAction[] = [];
  if (v.canNewVersion && primary !== 'new_version' && !(v.status === 'accepted' && v.conversion)) more.push('new_version');
  if (v.canDiscard) more.push('discard');
  return more;
}

const DATE = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const dateText = (iso: string) => DATE.format(new Date(`${iso}T00:00:00+05:30`));

/**
 * Header validity (DA-186). The database always stores a date: quotation_create
 * writes creation day + 7 (IST) and quotation_mark_sent keeps it, so the
 * honest text is the stored date. The rule text is only a fallback for a read
 * without a date.
 */
export function quoteValidityText(v: Pick<V, 'validUntil'>): string {
  return v.validUntil ? `Valid until ${dateText(v.validUntil)}` : `Valid for ${QUOTATION_DEFAULT_VALID_DAYS} days after the quotation was made`;
}

/** "Next:" lines (DA-184). */
function nextLine(v: V, primary: QuotePrimary, untouched: boolean): string {
  // Batch 3: a closed referral draft is read-only until someone reopens it (DA-75).
  if (v.referral?.status === 'closed') return 'Next: reopen the referral draft to make changes';
  if (!v.canEdit && (v.status === 'draft' || v.status === 'ready')) return 'Next: Sales or the branch Manager finishes this quotation';
  switch (primary) {
    case 'check_and_mark_ready':
      return untouched ? 'Next: start with the trip details' : 'Next: finish the parts, then press “Check and mark ready”';
    case 'mark_as_shared':
      return 'Next: check the customer copy, share it yourself, then mark it as shared';
    case 'record_answer':
      return `Next: wait for the customer’s written answer (${v.validUntil ? `valid until ${dateText(v.validUntil)}` : `valid for ${QUOTATION_DEFAULT_VALID_DAYS} days after the quotation was made`})`;
    case 'link_deal':
      return 'Next: link the deal Bitrix made from this lead';
    case 'start_booking':
      return 'Next: start the booking from this quotation';
    case 'continue_booking':
      return 'Next: continue the booking';
    case 'new_version':
      return 'Next: make a new version if the customer still wants an offer';
    case 'open_version':
      return 'Next: open the latest version';
    case null:
      if (v.status === 'accepted' && !v.linkedDealId && v.subject.kind === 'lead') return 'Next: convert the lead to a deal in Bitrix, then link it here';
      // Batch 3 (DA-70): a referral quotation books only after the draft is linked to the confirmed deal.
      if (v.status === 'accepted' && !v.linkedDealId && !v.conversion && v.subject.kind === 'referral') return 'Next: link the referral draft to the confirmed Bitrix deal';
      return 'Nothing waiting.';
  }
}

export function quoteHeader(input: { version: V; versions?: readonly QuotationVersionSummary[]; candidates?: readonly unknown[] | null; ownerName: string | null; fieldStates?: readonly PrefillFieldStateRead[] | null }): QuoteHeaderVM {
  const v = input.version;
  const versions = input.versions ?? [];
  const primary = quotePrimary(v, versions, (input.candidates?.length ?? 0) > 0);
  const statusWord = quoteStatusWord(v, versions, input.fieldStates);
  return {
    statusWord,
    primary,
    more: quoteMore(v, primary),
    nextLine: nextLine(v, primary, statusWord === 'Not started'),
    validityText: quoteValidityText(v),
    ownerName: input.ownerName,
  };
}

// ---------------------------------------------------------------------------
// "Check and mark ready"
// ---------------------------------------------------------------------------

/** Where each check is fixed: the part to open and the element id to focus. */
export const QUOTE_ISSUE_TARGETS: QuoteIssueTargets = {
  // Same table as Luna's markup (luna-batch2-props.md, 20 Oct): inputs where one field fixes it, else the part's heading.
  trip_missing: { part: 'details', fieldId: 'q-details-destination' },
  pax_missing: { part: 'details', fieldId: 'q-details-adults' },
  traveller_count_missing: { part: 'details', fieldId: 'q-details-adults' },
  valid_until_past: { part: 'details', fieldId: 'q-details-validUntil' },
  contact_missing: { part: 'contact', fieldId: 'q-contact-contactName' },
  no_items: { part: 'services', fieldId: 'q-services-add-type' },
  item_facts_invalid: { part: 'services', fieldId: 'services-heading' },
  tier_missing: { part: 'money', fieldId: 'q-tier-quoted' },
  upgrade_tier_missing: { part: 'money', fieldId: 'q-tier-upgrade' },
  quoted_total_missing: { part: 'money', fieldId: 'q-total-quoted' },
  upgrade_total_missing: { part: 'money', fieldId: 'q-total-upgrade' },
  lines_missing: { part: 'money', fieldId: 'q-lines-heading' },
  unit_not_allowed: { part: 'money', fieldId: 'q-lines-heading' },
  line_tier_mismatch: { part: 'money', fieldId: 'q-lines-heading' },
  plan_total_mismatch: { part: 'plan', fieldId: 'plan-heading' },
  plan_due_invalid: { part: 'plan', fieldId: 'plan-heading' },
  component_mismatch: { part: 'money', fieldId: 'money-heading' },
  cost_incomplete: { part: 'money', fieldId: 'money-heading' },
  margin_negative: { part: 'money', fieldId: 'money-heading' },
  extra_bed_not_priced: { part: 'money', fieldId: 'money-heading' },
  child_no_bed_not_priced: { part: 'money', fieldId: 'money-heading' },
  per_person_not_exact: { part: 'money', fieldId: 'money-heading' },
};

/** Said once to staff; both codes still run on the server (QE-07). */
const SAME_LINE: Partial<Record<QuotationChecklistCode, QuotationChecklistCode>> = { traveller_count_missing: 'pax_missing' };
const MERGED_PAX_TEXT = 'Add the number of travellers (at least one adult).';

const INTERNAL = new Set<QuotationChecklistCode>(['cost_incomplete', 'margin_negative']);

function issueItem(code: QuotationChecklistCode): ErrorSummaryItem {
  const t = QUOTE_ISSUE_TARGETS[code];
  const text = code === 'pax_missing' || code === 'traveller_count_missing' ? MERGED_PAX_TEXT : QUOTATION_ISSUE_TEXT[code].text;
  return { kind: 'blocking', partId: t.part, fieldId: t.fieldId, message: `${QUOTE_PART_LABEL[t.part]}: ${text}`, href: `#${t.fieldId}` };
}

/** Blocking codes as summary lines: page order of parts, pax duplicate once. Warnings are not listed here. */
export function blockingItems(codes: readonly QuotationChecklistCode[]): ErrorSummaryItem[] {
  const blocking = [...new Set(codes.map((c) => SAME_LINE[c] ?? c))].filter((c) => QUOTATION_ISSUE_TEXT[c].blocking);
  return blocking
    .sort((a, b) => QUOTE_PART_ORDER.indexOf(QUOTE_ISSUE_TARGETS[a].part) - QUOTE_PART_ORDER.indexOf(QUOTE_ISSUE_TARGETS[b].part))
    .map(issueItem);
}

/** "Worth checking" notes: non-blocking codes; internal ones (cost, margin) only from the money block and tagged. */
export function warningLines(v: V): Array<{ code: QuotationChecklistCode; text: string; internal: boolean; part: QuotePartKey; fieldId: string }> {
  const fromAtlas = v.issues.filter((c) => !QUOTATION_ISSUE_TEXT[c].blocking && !INTERNAL.has(c));
  const fromMoney = (v.money?.issues ?? []).filter((c) => !QUOTATION_ISSUE_TEXT[c].blocking);
  return [...new Set<QuotationChecklistCode>([...fromAtlas, ...fromMoney])].map((code) => ({
    code,
    text: QUOTATION_ISSUE_TEXT[code].text,
    internal: INTERNAL.has(code),
    part: QUOTE_ISSUE_TARGETS[code].part,
    fieldId: QUOTE_ISSUE_TARGETS[code].fieldId,
  }));
}

/** DA-183: the success line after "Check and mark ready" (same as QUOTATION_TEXT.markedReady). */
export const QUOTE_MARKED_READY_TEXT = QUOTATION_TEXT.markedReady;

/** DA-183 summary title. */
export const QUOTE_CHECK_TITLE = (n: number) => `To finish before sharing (${n})`;

/**
 * Step 1 of "Check and mark ready": with unsaved parts, the summary lists
 * them first, then the blocking checks the page already holds, and the
 * caller makes no server call. Returns null when nothing is unsaved (the
 * caller then calls quotation_mark_ready).
 */
export function unsavedCheckSummary(v: V, unsaved: ReadonlyArray<{ part: QuotePartKey; label: string }>): ErrorSummaryVM | null {
  if (unsaved.length === 0) return null;
  const items: ErrorSummaryItem[] = [
    // DA-183
    ...unsaved.map((u) => ({ kind: 'unsaved' as const, partId: u.part, fieldId: null, message: `${u.label}: changes not saved yet`, href: `#${u.part}` })),
    ...withPriceAccess(blockingItems(visibleCodes(v)), v.money !== undefined),
  ];
  const ordered = orderSummaryItems(items);
  return errorSummary(QUOTE_CHECK_TITLE(ordered.length), ordered);
}

/** DA-194: one line for an editor without price access instead of links to fields they cannot see. */
export const QUOTE_PRICES_BY_SALES_TEXT = 'Prices: Sales on this deal fills the prices and totals.';

function withPriceAccess(items: ErrorSummaryItem[], priceAccess: boolean): ErrorSummaryItem[] {
  if (priceAccess) return items;
  const isMoney = (i: ErrorSummaryItem) => i.partId === 'money' || i.partId === 'plan';
  const first = items.findIndex(isMoney);
  if (first < 0) return items;
  const merged: ErrorSummaryItem = { kind: 'blocking', partId: 'money', fieldId: null, message: QUOTE_PRICES_BY_SALES_TEXT, href: '#money' };
  return [...items.slice(0, first).filter((i) => !isMoney(i)), merged, ...items.slice(first).filter((i) => !isMoney(i))];
}

/** Step 2: the server's not_ready issues are authoritative. `priceAccess` false (no money block): money lines merge into one (DA-194). */
export function notReadySummary(codes: readonly QuotationChecklistCode[], opts: { priceAccess?: boolean } = {}): ErrorSummaryVM | null {
  const items = withPriceAccess(blockingItems(codes), opts.priceAccess ?? true);
  return errorSummary(QUOTE_CHECK_TITLE(items.length), items);
}

// ---------------------------------------------------------------------------
// "Save prices" (existing commands in order) and Customer copy
// ---------------------------------------------------------------------------

/** Order the forms of the Prices part run in; only the tiers offered. */
export function pricesSaveSteps(upgradeOffered: boolean): QuotePricesSaveStep[] {
  return ['tiers', 'lines', 'total_quoted', ...(upgradeOffered ? (['total_upgrade'] as const) : [])];
}

export function pricesSaveReport(report: SaveRunReport, savedSteps: readonly QuotePricesSaveStep[]): QuotePricesSaveReport {
  return { ...report, savedSteps: [...savedSteps] };
}

export function quoteCopyLinks(versionId: string, current: QuoteCopyTab): QuoteCopyLinks {
  return { edit: `/app/quotations/${versionId}`, customerCopy: `/app/quotations/${versionId}/preview`, current };
}
