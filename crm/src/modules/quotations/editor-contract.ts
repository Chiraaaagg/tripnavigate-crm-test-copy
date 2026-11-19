import type { ErrorSummaryVM, SaveRunReport } from '@/modules/fulfilment/book-flow-contract';
import type { QuotationChecklistCode, QuotationSection } from './contracts';

/*
 * Batch 2 frozen contract (lead Step 0, 20 October 2026): the quotation
 * editor (QU-02..QU-05). Types only.
 *
 * Rulings this freezes:
 *   - Six collapsible parts in today's order (Trip · Customer · Services ·
 *     Day plan and terms · Prices · Payment plan; part keys are today's
 *     section keys). Closed parts stay mounted; a part with unsaved changes
 *     never collapses. The first part that needs input is open.
 *   - Nothing red before "Check and mark ready". Pressing it: if any part
 *     has unsaved changes, show the summary (unsaved parts first, then the
 *     blocking checks the page already holds) and make no server call;
 *     otherwise call quotation_mark_ready, whose not_ready issues are
 *     authoritative. pax_missing and traveller_count_missing show as one line.
 *   - Internal warnings (cost_incomplete, margin_negative) come only from the
 *     money block (price readers) and carry an "Internal" tag.
 *   - "Save prices" runs the existing commands in order (quotation_tiers_save,
 *     quotation_lines_save, quotation_total_save per option): no new command,
 *     honest partial-save report (SaveRunReport).
 *   - Customer copy is the existing server-rendered /preview route (documents
 *     adapter). It is never a client tab built from editor data.
 *   - The validity date stays editable and empty by default (empty = 7 days
 *     after sharing).
 *
 * "Not started" rule for a part: every field of the part is empty, or holds
 * only a value written from Bitrix that staff never touched (prefill
 * fieldStates: filledBy set and staffTouched false). Use Atlas's fieldStates
 * when the read has them; on an older database a field marked from_bitrix
 * counts as untouched. Fields without Bitrix provenance count as started when
 * they hold a value. An empty Payment plan is 'optional', never 'not_started'
 * for readiness. A version is "Not started" when every part is not started.
 */

export type QuotePartKey = QuotationSection;

/** Page order of the parts. */
export type QuotePartOrder = readonly ['details', 'contact', 'services', 'narrative', 'money', 'plan'];

/**
 * not_started · saved (holds staff content, nothing unsaved) · needs_input
 * (only after "Check and mark ready": a blocking check or unsaved changes) ·
 * optional (Payment plan left empty) · read_only (not editable for this
 * viewer or state) · prices_hidden (Prices or Payment plan for a reader
 * without price access: one locked line, no empty form).
 */
export type QuotePartState = 'not_started' | 'saved' | 'needs_input' | 'optional' | 'read_only' | 'prices_hidden';

export interface QuotePartVM {
  key: QuotePartKey;
  label: string;
  state: QuotePartState;
  /** Open on first render (the first part that needs input, or the part a link targets). */
  open: boolean;
}

/** Status words (copy-catalogue DA-41). */
export type QuoteStatusWord =
  | 'Not started'
  | 'Draft'
  | 'Ready to share'
  | 'Shared with customer'
  | 'Accepted'
  | 'Declined'
  | 'Expired'
  | `Replaced by v${number}`
  | 'Replaced by a newer version'
  | 'Discarded'
  | 'Booking started';

/** The one header primary per state; null = none for this viewer. */
export type QuotePrimary =
  | 'check_and_mark_ready'
  | 'mark_as_shared'
  | 'record_answer'
  | 'link_deal'
  | 'start_booking'
  | 'continue_booking'
  | 'new_version'
  | 'open_version'
  | null;

/** Secondary actions in the header "More" menu. */
export type QuoteMoreAction = 'new_version' | 'discard';

export interface QuoteHeaderVM {
  statusWord: QuoteStatusWord;
  primary: QuotePrimary;
  more: QuoteMoreAction[];
  /** "Next: …" line. */
  nextLine: string;
  /** "Valid until {date}" or "Valid for 7 days after the quotation was made" (the server always stores a date; null only in older or preview data). */
  validityText: string;
  ownerName: string | null;
}

export interface QuoteReadinessVM {
  state: 'not_started' | 'in_progress' | 'ready';
  /** Parts with state 'saved' (Payment plan counts when saved or optional). */
  savedParts: number;
  totalParts: 6;
}

/** Where each check is fixed: the part to open and the input id to focus (ids agreed with Luna's markup). */
export interface QuoteIssueTarget {
  part: QuotePartKey;
  fieldId: string;
}
export type QuoteIssueTargets = Readonly<Record<QuotationChecklistCode, QuoteIssueTarget>>;

/** Codes that say the same thing to staff and are listed once (both still run on the server). */
export type QuoteDuplicateIssues = readonly [readonly ['pax_missing', 'traveller_count_missing']];

/** Result of pressing "Check and mark ready". */
export type QuoteCheckOutcome =
  | { kind: 'unsaved'; summary: ErrorSummaryVM }
  | { kind: 'not_ready'; summary: ErrorSummaryVM }
  | { kind: 'ready' }
  | { kind: 'refused'; message: string };

/** The forms "Save prices" runs, in order. */
export type QuotePricesSaveStep = 'tiers' | 'lines' | 'total_quoted' | 'total_upgrade';

export interface QuotePricesSaveReport extends SaveRunReport {
  /** Steps that ran and saved, in order. */
  savedSteps: QuotePricesSaveStep[];
}

/** Edit / Customer copy switch: two server-rendered links. */
export type QuoteCopyTab = 'edit' | 'customer_copy';
export interface QuoteCopyLinks {
  /** /app/quotations/{versionId} */
  edit: string;
  /** /app/quotations/{versionId}/preview (server adapter; refused for readers without price access). */
  customerCopy: string;
  current: QuoteCopyTab;
}
