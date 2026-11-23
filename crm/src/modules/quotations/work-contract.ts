/**
 * Direction A Batch 3: frozen view-model contract for the Quotations and
 * Itineraries destinations, referral drafts, linking and the two new Home
 * rows (Step 0; the lead's commit freezes it). Types and key lists only: no
 * reads, no wording beyond keys. Wire shapes are Atlas's
 * (atlas-batch3-shapes.md v2 §2–§4; zod in quotations/referral.ts); Terra
 * builds these view models from them on the server; Luna renders them.
 *
 * Rules carried by these types:
 * - No money in any list row or Home row (lead ruling: the prototype's
 *   "Final price" column is dropped). Editor money stays on quotation_get.
 * - Lists page by keyset cursor (`next`), never by page number; counts are
 *   exact for the chosen scope and the screen says so.
 * - Closed never-linked referral drafts appear only under the "closed_drafts"
 *   chip or an exact TD-n / TQ-n reference, and open read-only with Reopen.
 * - The referral switch is On, Off or Unknown; Unknown is never shown as Off.
 * - Linking a draft never converts: "Link to Bitrix Deal" (pick, confirm)
 *   and "Start booking from quotation" are two explicit steps; a refused
 *   second step is reported honestly.
 * - Every href is built by subject-links.ts (never an "undefined" address).
 */

import type { ListFilterVM } from '@/modules/deals/workspace-contract';
import type { QuoteStatusWord } from './editor-contract';
import type { SubjectLinkKind } from './subject-links';

// ---------------------------------------------------------------------------
// Shared: switch, draft state, subject
// ---------------------------------------------------------------------------

/**
 * The referral drafts switch as this page read it.
 * on / off: workflow_settings_get().referralDrafts; unknown: not reported
 * (older database or failed read). Off and Unknown both hide the "Referral
 * (no Bitrix record yet)" choice; only Off says "switched off" (DA-78);
 * Unknown says the CRM could not check.
 */
export type ReferralSwitchState = 'on' | 'off' | 'unknown';

/** atlas-batch3-shapes §2 AutoClose.state; `paused` = switch off (no date shown). */
export type ReferralAutoCloseState = 'paused' | 'scheduled' | 'closed' | 'none';

export type ReferralClosedReason = 'duplicate' | 'lost' | 'handled_elsewhere' | 'other' | 'no_activity';
export const REFERRAL_MANUAL_CLOSE_REASONS = ['duplicate', 'lost', 'handled_elsewhere', 'other'] as const satisfies readonly ReferralClosedReason[];

export type ReferralUnlinkReason = 'wrong_link' | 'duplicate' | 'other';
export const REFERRAL_UNLINK_REASONS = ['wrong_link', 'duplicate', 'other'] as const satisfies readonly ReferralUnlinkReason[];

export type ReferralSourceKind = 'walk_in' | 'phone' | 'whatsapp' | 'email' | 'referral' | 'repeat_customer' | 'social' | 'other';
export const REFERRAL_SOURCE_KINDS = ['walk_in', 'phone', 'whatsapp', 'email', 'referral', 'repeat_customer', 'social', 'other'] as const satisfies readonly ReferralSourceKind[];

/** Note and reason limits (atlas-batch3-shapes §3): unlink and reassign reasons 10–500; close note up to 500. */
export const REFERRAL_TEXT_LIMITS = { customerName: 120, companyName: 200, email: 254, sourceNote: 200, reasonMin: 10, reasonMax: 500, closeNoteMax: 500 } as const;

/** The draft's state as one line set for headers and rows (wording from Mercury, DA-73/74/75). */
export interface ReferralDraftStateVM {
  status: 'open' | 'closed';
  closedReason: ReferralClosedReason | null;
  /** Status word, e.g. "Open", "Closed", "Closed after 90 days without activity". Never colour alone. */
  statusText: string;
  /**
   * The automatic-close line under the status, or null when none applies:
   * scheduled → "Closes on {date} if nothing changes."; paused → Mercury's paused line;
   * closed by no activity → DA-74 history line; none → null.
   */
  autoCloseLine: string | null;
  autoCloseState: ReferralAutoCloseState;
}

/** Where a row's subject lives, already resolved to an address (subject-links.ts). */
export interface WorkSubjectVM {
  kind: SubjectLinkKind | 'quotation';
  /** "Lead L-55", "Deal D-5103", "Referral draft TD-301 · not linked to Bitrix yet". */
  text: string;
  /** null when the viewer cannot open it (never an "undefined" address). */
  href: string | null;
}

// ---------------------------------------------------------------------------
// Lists (QL, IL): filters, scope, counts, keyset pager, rows
// ---------------------------------------------------------------------------

/** Filter keys = work_drafts_list status values (atlas-batch3-shapes §4.1). */
export const QUOTATION_LIST_FILTERS = [
  'open',
  'to_finish',
  'drafts',
  'ready',
  'shared',
  'accepted',
  // Atlas §7 (fix round): accepted, not converted, with a deal to book into (own, tied, or the draft's active deal link).
  'ready_to_book',
  'accepted_not_linked',
  'declined_or_expired',
  'closed_drafts',
  'all',
] as const;
export type QuotationListFilter = (typeof QUOTATION_LIST_FILTERS)[number];

export const ITINERARY_LIST_FILTERS = ['open', 'draft', 'ready', 'final_made', 'closed_drafts', 'all'] as const;
export type ItineraryListFilter = (typeof ITINERARY_LIST_FILTERS)[number];

/** mine = created by you or you own the Lead/Deal/draft; all = everything you can open (Sales own/assigned, Manager branch). */
export const WORK_LIST_SCOPES = ['mine', 'all'] as const;
export type WorkListScope = (typeof WORK_LIST_SCOPES)[number];

export type WorkListKind = 'quotations' | 'itineraries';

/** Keyset cursor (work_drafts_list `next`); carried in the address as `?after=` (encoded by Terra). */
export interface WorkListCursor {
  since: string;
  id: string;
}

/**
 * Keyset pager: no page numbers. "First page" when not on the first page;
 * "Next page" while hasMore. rangeText names the scope, e.g. "Showing 25 of
 * 61 quotations you can open" (Mercury words).
 */
export interface WorkListPagerVM {
  firstHref: string | null;
  nextHref: string | null;
  shown: number;
  /** Exact total for the current filter and scope; null when not counted (never shown as 0). */
  total: number | null;
  rangeText: string;
}

/** Scope switch (Manager and Sales): "Mine" / "All you can open". Counts are exact for the chosen scope. */
export interface WorkListScopeVM {
  current: WorkListScope;
  mineHref: string;
  allHref: string;
}

/** One action button per row (one primary per row; "Continue" on drafts). */
export type WorkRowActionKind = 'continue' | 'link_to_deal' | 'start_booking' | 'continue_booking' | 'open' | 'reopen';
export interface WorkRowActionVM {
  kind: WorkRowActionKind;
  label: string;
  href: string;
}

/** Quotations list row. No money (lead ruling). */
export interface WorkQuotationRowVM {
  quotationId: string;
  reference: string;
  title: string;
  /** The current version's editor (/app/quotations/[versionId]). */
  href: string;
  versionNo: number;
  statusWord: QuoteStatusWord;
  subject: WorkSubjectVM;
  /** Set for referral quotations: the draft's state (closed rows read-only). */
  draft: ReferralDraftStateVM | null;
  customerName: string | null;
  destination: string | null;
  tripStartText: string | null;
  validUntilText: string | null;
  /** DEC-52 owner name, or null when the read does not name them (row then says nothing). */
  ownerName: string | null;
  ownerIsYou: boolean;
  updatedText: string;
  action: WorkRowActionVM | null;
}

/** Itineraries list row. No money. */
export interface WorkItineraryRowVM {
  documentId: string;
  title: string;
  /** /app/itineraries/[documentId] */
  href: string;
  /** "Draft", "Ready for final PDF", "Final PDF made". */
  statusText: string;
  /** "From TQ-7001 v2", "From the booking", "Not from a quotation". */
  basisText: string;
  subject: WorkSubjectVM;
  draft: ReferralDraftStateVM | null;
  openDifferences: number;
  /** Fix round (Mercury F6, DA-210): false when the count is not known here; show "See the itinerary", never "None". Absent = known. */
  differencesKnown?: boolean;
  ownerName: string | null;
  updatedText: string;
  /** Download of the latest final PDF (existing route), when one exists. */
  finalDownloadHref: string | null;
}

/** "Open by reference" (exact TQ-n / TD-n): finds closed never-linked drafts for owner and Manager. */
export interface OpenByReferenceVM {
  /** The list address the form submits to (GET, `?reference=`). */
  action: string;
  /** The typed reference, kept after a miss. */
  value: string;
  /** null, or the no-match line (same for "does not exist" and "not yours"). */
  missText: string | null;
}

export type WorkListState = 'ok' | 'not_applicable' | 'error' | 'not_installed';

/** One Quotations or Itineraries list page. */
export interface WorkListPageVM<R, F extends string> {
  kind: WorkListKind;
  /**
   * ok; not_applicable (no Sales/Manager role: page says there is nothing here for them);
   * error ("could not load", never an empty list); not_installed (older database).
   */
  state: WorkListState;
  /** Heading line naming the scope, e.g. "Quotations you can open" (Mercury). */
  scopeLine: string;
  scope: WorkListScopeVM;
  /** Chips with exact counts in the chosen scope; scopeText e.g. "Counts include all pages." */
  filters: { chips: ListFilterVM<F>[]; scopeText: string };
  rows: R[];
  pager: WorkListPagerVM;
  /** Shown while the reference search is active: which reference was searched. */
  reference: string | null;
  openByReference: OpenByReferenceVM;
  /** "Closed drafts that were never linked are not in this list. Choose “Closed drafts” or open one by its reference." (DA-204) or null. */
  hiddenClosedLine: string | null;
  /** Current-page search only (DA-100/101a): the box says "Search this page". */
  pageSearch: true;
  empty: { title: string; text: string };
  /** The page's one primary action: "New quotation" / "New itinerary". */
  newHref: string;
}

export type QuotationListPageVM = WorkListPageVM<WorkQuotationRowVM, QuotationListFilter>;
export type ItineraryListPageVM = WorkListPageVM<WorkItineraryRowVM, ItineraryListFilter>;

// ---------------------------------------------------------------------------
// New quotation / New itinerary (QN, IN)
// ---------------------------------------------------------------------------

/** Frozen form field names for the referral create, draft and link forms. */
export const RFIELD = {
  branchId: 'branchId',
  customerName: 'customerName',
  mobile: 'mobile',
  email: 'email',
  companyName: 'companyName',
  sourceKind: 'sourceKind',
  sourceNote: 'sourceNote',
  title: 'title',
  requestId: 'requestId',
  draftId: 'draftId',
  rowVersion: 'rowVersion',
  reason: 'reason',
  note: 'note',
  targetKind: 'targetKind',
  targetId: 'targetId',
  linkId: 'linkId',
  newOwner: 'newOwner',
  query: 'query',
  reference: 'reference',
} as const;

export interface NewWorkVM {
  kind: WorkListKind;
  /** "For a lead or deal": no picker in Batch 3 (lead ruling); links to the lists plus one line. */
  fromBitrix: { text: string; leadsHref: string | null; dealsHref: string };
  /** "Referral (no Bitrix record yet)". The form shows only when state is 'on'. */
  referral: {
    state: ReferralSwitchState;
    /** Off: DA-78. Unknown: "could not check" line. On: null. */
    line: string | null;
    /** Branches where the person holds Sales or Manager (field shown only when more than one). */
    branches: Array<{ id: string; name: string }>;
    sourceKinds: Array<{ value: ReferralSourceKind; label: string }>;
    /** Fix round (DA-213): hint under "Title (optional)", naming the "Trip for {customer name}" default. */
    titleHint?: string;
  };
  /**
   * Fix round (Echo L4): false for anyone without the Quotations menu item (canSeeQuotations);
   * the page then shows the not-for-role state (DA-207) and no form. Absent = true.
   */
  allowed?: boolean;
}

/** Successful referral create (redirect target plus the DA-56 line and the never-blocking DA-57 hint). */
export interface ReferralCreatedVM {
  referralDraftId: string;
  referralReference: string;
  /** The new quotation version's editor, or the new itinerary's page. */
  href: string;
  createdText: string;
  /** References only, records the person can already open; never blocks. */
  possibleDuplicates: Array<{ reference: string; href: string | null }>;
}

// ---------------------------------------------------------------------------
// Referral draft page (/app/quotations/drafts/[draftId])
// ---------------------------------------------------------------------------

export const REFERRAL_DRAFT_TABS = ['overview', 'quotations', 'itineraries', 'link', 'history'] as const;
export type ReferralDraftTab = (typeof REFERRAL_DRAFT_TABS)[number];

/** One primary per state: open and unlinked → link; closed → reopen; accepted+linked → start booking (via the quotation); else none. */
export type ReferralDraftPrimary = 'link' | 'reopen' | 'start_booking' | null;

export interface ReferralLinkVM {
  linkId: string;
  targetKind: 'lead' | 'deal';
  reference: string;
  /** null when the viewer cannot read the target's title. */
  title: string | null;
  href: string | null;
  active: boolean;
  /** "Linked on {date} by you" / "Linked on {date}". */
  linkedText: string;
  /** Ended links stay in History: "Removed on {date}: Wrong customer". */
  endedText: string | null;
  /** Owner or branch Manager, before bind/convert (A4). */
  canRemove: boolean;
}

export interface ReferralDraftVM {
  referralDraftId: string;
  reference: string;
  rowVersion: number;
  tab: ReferralDraftTab;
  tabs: Array<{ tab: ReferralDraftTab; label: string; href: string; current: boolean }>;
  header: {
    /** "{customer name} · referral draft" */
    title: string;
    state: ReferralDraftStateVM;
    /** "Referral draft TD-301 · not linked to Bitrix yet" / "· linked to Deal D-5109" (DA-58). */
    refLine: string;
    /** Named for the owner themself and the branch Manager only; else null. */
    ownerName: string | null;
    branchName: string;
    nextLine: string;
    /** DA-59 */
    privacyLine: string;
    primary: ReferralDraftPrimary;
    /** Fix round (Echo M4): for primary 'start_booking', "Open {TQ-ref} to start booking" and that quotation's editor. */
    startBooking?: { label: string; href: string } | null;
  };
  /** Fix round (Echo M1): DA-64 / DA-68 result after a link or unlink (the action redirects here); shown once, outside any form. */
  resultNotice?: string | null;
  /** Fix round (DA-213): "Trip for {customer name}", the prefill for Add quotation / Make branded itinerary. */
  defaultTitle?: string;
  overview: Array<{ label: string; value: string | null }>;
  quotations: WorkQuotationRowVM[];
  itineraries: WorkItineraryRowVM[];
  links: ReferralLinkVM[];
  /** Newest first; `at` is already a display time in India time ("16 Oct 2026, 11:05"). */
  history: Array<{ at: string; text: string }>;
  /** Server-decided rights (referral_draft_get.can); hidden controls, never disabled lies. */
  can: { edit: boolean; close: boolean; reopen: boolean; reassign: boolean; link: boolean; unlink: boolean; addQuotation: boolean; addItinerary: boolean };
  /** Existing drafts keep working while the switch is off (DEC-54); creation elsewhere follows it. */
  switchState: ReferralSwitchState;
  /** Closed drafts: read-only page with Reopen (DA-75). */
  readOnly: boolean;
}

// ---------------------------------------------------------------------------
// Linking flow (DA-61..70; lead ruling: pick → confirm → link; booking is a separate step)
// ---------------------------------------------------------------------------

export interface ReferralCandidateVM {
  kind: 'lead' | 'deal';
  id: string;
  reference: string;
  title: string;
  branchName: string;
  /** "Made from the linked lead" / "Already has an accepted quotation" (DA-62). */
  flags: string[];
  linkable: boolean;
  /** Why it cannot be linked (DA-65 words) when not linkable. */
  refusedText: string | null;
}

/** The Link to Bitrix tab: never preselects a candidate (contracts B.4). */
export interface ReferralLinkStepVM {
  kind: 'lead' | 'deal';
  /** DA-62 heading with the branch named. */
  heading: string;
  query: string;
  candidates: ReferralCandidateVM[];
  /** Empty or no-match line; null when there are candidates. */
  emptyText: string | null;
  /** DA-63 / DA-229 confirm text with a "{ref}" placeholder (plain data: view models cross to client components). */
  confirmTemplate: string;
  /** Fix round (Echo M3): the candidate read failed; show this instead of the list (never nothing). */
  loadError?: string | null;
}

/** Remove-link form (DA-66/67): reason, note 10–500, confirm. */
export interface ReferralUnlinkFormVM {
  link: ReferralLinkVM;
  reasons: Array<{ value: ReferralUnlinkReason; label: string }>;
  confirmText: string;
}

/**
 * Report after the two booking steps on a referral quotation:
 * step 1 bind (quotation_link_deal, immutable), step 2 start booking
 * (quotation_convert_to_booking). Only shown when step 2 was tried and refused
 * after step 1 succeeded: "Linked to D-5109. Booking not started: {reason}."
 */
export interface ReferralBookingReportVM {
  bound: { dealReference: string; dealHref: string } | null;
  booking: { started: true; href: string } | { started: false; reasonText: string } | null;
}

// ---------------------------------------------------------------------------
// Deal page section (DA-71) and Home rows (FP-081)
// ---------------------------------------------------------------------------

export interface SubjectReferralDraftRowVM {
  referralDraftId: string;
  reference: string;
  customerName: string;
  href: string;
  state: ReferralDraftStateVM;
  ownerName: string | null;
  quotationCount: number;
  hasAccepted: boolean;
}

/** "Referral drafts for this deal" (DA-71); null section when the read is not visible to the viewer. */
export interface SubjectReferralDraftsVM {
  heading: string;
  /** "Only one quotation per deal can be accepted. Close the others as duplicates." when more than one. */
  note: string | null;
  rows: SubjectReferralDraftRowVM[];
}

/**
 * The two Home rows (FP-081). Counts from my_work_counts (quotationDraftsToFinish,
 * acceptedQuotesToLink; null = not applicable, row hidden). Buttons open a menu
 * address with a query (lead ruling): /app/quotations?filter=to_finish and
 * /app/quotations?filter=accepted_not_linked. Shown only when the person may see
 * the Quotations menu item (canSeeQuotations).
 */
export type HomeQuotationRowKey = 'quotationDraftsToFinish' | 'acceptedQuotesToLink';
export const HOME_QUOTATION_ROW_FILTER: Record<HomeQuotationRowKey, QuotationListFilter> = {
  quotationDraftsToFinish: 'to_finish',
  acceptedQuotesToLink: 'accepted_not_linked',
};
