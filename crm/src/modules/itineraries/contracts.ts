import type { EvidenceMime } from '@/modules/fulfilment/contracts';

/*
 * B1.2 Phase F: branded itineraries from canonical facts (freeze note part 2
 * §5; Atlas 20261120000500, shapes note atlas-b12-0500-shapes.md). The
 * editor side: documents on a quotation or a Deal, private source files
 * (never sent outside, no extraction), a hand-entered facts draft (no money
 * keys), factual differences against the quotation/booking basis (field
 * paths only; acknowledged one by one), mark ready, and render jobs (the
 * renderer is not built yet: jobs wait honestly). Customer-document
 * adapters, the view for rendering and the difference computation are
 * Nova's (crm/src/modules/documents); this module reuses them.
 *
 * Editors = readers: the quotation's editors, or the Deal's booking editors
 * (Sales owner/assignee, branch Manager). Nobody else.
 */

// ---------------------------------------------------------------------------
// Subjects, states
// ---------------------------------------------------------------------------

/**
 * Batch 3 (migration 20261123000100, atlas-batch3-shapes §4.5): an itinerary
 * is made on a quotation, a Deal or a referral draft (TD-n, "not from a
 * quotation"). Reads drop a subject kind they do not know instead of failing.
 */
export type ItinerarySubjectKind = 'quotation' | 'deal' | 'referral';
export const ITINERARY_SUBJECT_KINDS = ['quotation', 'deal', 'referral'] as const satisfies readonly ItinerarySubjectKind[];

export function isItinerarySubjectKind(value: unknown): value is ItinerarySubjectKind {
  return typeof value === 'string' && (ITINERARY_SUBJECT_KINDS as readonly string[]).includes(value);
}

export type ItineraryDraftStatus = 'draft' | 'ready';
export const ITINERARY_DRAFT_STATUSES = ['draft', 'ready'] as const satisfies readonly ItineraryDraftStatus[];
export const ITINERARY_DRAFT_STATUS_LABEL: Record<ItineraryDraftStatus, string> = {
  // I-02 (DA-43; the lists already say it)
  draft: 'Draft',
  ready: 'Ready for final PDF',
};

export type RenderKind = 'preview' | 'final';
export const RENDER_KINDS = ['preview', 'final'] as const satisfies readonly RenderKind[];
export const RENDER_KIND_LABEL: Record<RenderKind, string> = { preview: 'Preview', final: 'Final document' };

export type RenderJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export const RENDER_JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const satisfies readonly RenderJobStatus[];
/** Honest status words (I-07, §14 #2): never claim the PDF maker is off; its state is a server setting. */
export const RENDER_JOB_STATUS_TEXT: Record<RenderJobStatus, string> = {
  queued: 'Waiting for the PDF maker. Nothing is sent to the customer.',
  running: 'Being made now.',
  succeeded: 'Ready to download.',
  failed: 'Could not be made. Check the facts and request it again.',
  cancelled: 'Cancelled.',
};

/** Renderer error codes the worker may record (Atlas allowlist) → plain words. */
export const RENDER_ERROR_TEXT: Record<string, string> = {
  // I-11
  render_timeout: 'The PDF took too long. Try again.',
  browser_failed: 'The PDF maker did not start. Try again.',
  asset_missing: 'A picture or font is missing. Tell your admin.',
  input_invalid: 'Some facts could not be printed. Check the facts.',
  upload_failed: 'The finished file could not be stored.',
  internal: 'The PDF could not be made. Try again; if it repeats, tell your admin.',
  content_safety: 'Customer text contains internal words. Reword it.',
  layout_overflow: 'Some text does not fit on the page. Shorten it.',
  placeholders_present: 'Some facts are still missing (shown in brackets). Fill them in.',
  qa_blocked: 'The final check found missing facts, internal words or layout problems.',
  text_clipped: 'Some text was cut off on the page. Shorten it.',
  input_changed: 'The facts or the quotation changed after the final document was requested. Request it again.',
  lease_expired: 'The PDF could not be made. Try again; if it repeats, tell your admin.',
};

/** Why the document input can't be built (Nova's adapter refusal codes) → plain words. */
export const DOCUMENT_BLOCK_TEXT: Record<string, string> = {
  placeholders: 'Some facts are still missing (they would print in brackets). Fill them in.',
  unsafe_text: 'Customer text contains internal words. Reword it.',
  // I-12 (§14 #7)
  forbidden_field: 'This PDF was stopped to protect internal details. Tell your admin.',
  nights_mismatch: 'The stay nights do not add up to the trip dates.',
  days_mismatch: 'The day-by-day plan does not match the number of trip days.',
  dates_invalid: 'A date is not valid.',
  amount_has_paise: 'An amount has paise; customer amounts are whole rupees.',
  amount_invalid: 'An amount is not valid.',
  tier_missing: 'The quoted option is missing.',
};

/** Template version sent with every render request (the renderer reads it; bump when the template changes). itinerary-2: DEC-50 statutory footer line. */
export const ITINERARY_TEMPLATE_VERSION = 'itinerary-2';

// ---------------------------------------------------------------------------
// Facts (Atlas allowlist; no money keys; every key optional)
// ---------------------------------------------------------------------------

export interface ItineraryParty {
  adults: number | null;
  children: number | null;
  /** 0–17, at most 20 (no age bands). */
  childAges: number[];
  infants: number | null;
}
export interface ItineraryStay {
  city: string | null;
  nights: number | null;
  checkIn: string | null;
  checkOut: string | null;
  hotelName: string | null;
  roomType: string | null;
  mealPlan: string | null;
  rooms: number | null;
}
export interface ItineraryDay {
  n: number;
  date: string | null;
  base: string | null;
  title: string | null;
  story: string | null;
  highlights: string[];
  meals: string | null;
}
export interface ItineraryTransfer {
  date: string | null;
  from: string | null;
  to: string | null;
  mode: string | null;
}
export interface ItineraryActivity {
  date: string | null;
  city: string | null;
  name: string | null;
  included: boolean | null;
}
export interface ItineraryFlight {
  date: string | null;
  from: string | null;
  to: string | null;
  carrier: string | null;
  number: string | null;
}
export type FactProvenance = 'manual' | 'quotation' | 'booking';
export const FACT_PROVENANCES = ['manual', 'quotation', 'booking'] as const satisfies readonly FactProvenance[];
export const FACT_PROVENANCE_LABEL: Record<FactProvenance, string> = {
  manual: 'Typed by staff',
  quotation: 'From the quotation',
  booking: 'From the booking',
};

export interface ItineraryFacts {
  destination: string | null;
  startDate: string | null;
  endDate: string | null;
  party: ItineraryParty;
  stays: ItineraryStay[];
  days: ItineraryDay[];
  transfers: ItineraryTransfer[];
  activities: ItineraryActivity[];
  flights: ItineraryFlight[];
  inclusions: string[];
  exclusions: string[];
  // Document wording (Atlas 0500 addition; all optional, customer-visible, scanned before every save)
  /** One word on the cover (for example "Kerala"). */
  coverWord: string | null;
  country: string | null;
  /** Kind of trip as shown on the cover (for example "Family holiday"). */
  category: string | null;
  /** Room basis line (for example "Twin sharing"). */
  roomBasis: string | null;
  /** Opening paragraph. */
  introduction: string | null;
  /** "Why this trip" points. */
  reasons: string[];
  /** "We take care of" points. */
  handledByUs: string[];
  /** "You bring" points. */
  youBring: string[];
  /** Field path → where the value came from. */
  provenance: Record<string, FactProvenance>;
}

export const ITINERARY_FACT_LIMITS = {
  destination: 200,
  party: { max: 100, childAges: 20, age: { min: 0, max: 17 } },
  stays: 30,
  stay: { city: 120, nights: { min: 1, max: 60 }, hotelName: 200, roomType: 120, mealPlan: 60, rooms: { min: 1, max: 50 } },
  days: 60,
  day: { base: 120, title: 120, story: 2000, highlights: 10, highlight: 200, meals: 60 },
  transfers: 40,
  transfer: { place: 200, mode: 60 },
  activities: 60,
  activity: { city: 120, name: 200 },
  flights: 20,
  flight: { place: 60, carrier: 60, number: 20 },
  lists: 60,
  listItem: 300,
  // Document wording (Atlas 0500 5d321b3)
  coverWord: 60,
  country: 80,
  category: 60,
  roomBasis: 120,
  introduction: 2000,
  point: 200,
  reasons: 6,
  handledByUs: 10,
  youBring: 10,
  provenance: 500,
  path: 120,
} as const;

export const EMPTY_ITINERARY_FACTS: ItineraryFacts = {
  destination: null,
  startDate: null,
  endDate: null,
  party: { adults: null, children: null, childAges: [], infants: null },
  stays: [],
  days: [],
  transfers: [],
  activities: [],
  flights: [],
  inclusions: [],
  exclusions: [],
  coverWord: null,
  country: null,
  category: null,
  roomBasis: null,
  introduction: null,
  reasons: [],
  handledByUs: [],
  youBring: [],
  provenance: {},
};

/** Form labels for the document wording facts (also used for difference labels). */
export const ITINERARY_WORDING_LABEL = {
  coverWord: 'Cover word',
  country: 'Country',
  category: 'Trip type',
  roomBasis: 'Room basis',
  introduction: 'Introduction',
  reasons: 'Why this trip',
  handledByUs: 'We take care of',
  youBring: 'You bring',
} as const satisfies Record<'coverWord' | 'country' | 'category' | 'roomBasis' | 'introduction' | 'reasons' | 'handledByUs' | 'youBring', string>;
/** Hints shown under the wording inputs. */
export const ITINERARY_WORDING_HINT = {
  coverWord: 'One or two words for the cover, for example the destination.',
  introduction: 'A short welcome paragraph. Customer text: no supplier names, net rates or internal notes.',
  reasons: 'One point per line.',
  handledByUs: 'One point per line, for example airport transfers.',
  youBring: 'One point per line, for example passport and comfortable shoes.',
} as const;

// ---------------------------------------------------------------------------
// Differences (field paths only; never values)
// ---------------------------------------------------------------------------

export type DifferenceKind = 'missing' | 'different' | 'extra';
export const DIFFERENCE_KIND_LABEL: Record<DifferenceKind, string> = {
  missing: 'In the quotation or booking, not in the itinerary',
  different: 'Different from the quotation or booking',
  extra: 'In the itinerary, not in the quotation or booking',
};

/**
 * How staff settle a difference. `use_basis` is not an acknowledgement: the
 * server copies the quotation/booking value into the facts and checks the
 * differences again (useItineraryBasisValueAction; the difference then
 * disappears). `keep_itinerary` and `note` acknowledge it with a note.
 */
export type DifferenceChoice = 'use_basis' | 'keep_itinerary' | 'note';
export const DIFFERENCE_CHOICES = ['use_basis', 'keep_itinerary', 'note'] as const satisfies readonly DifferenceChoice[];
export const DIFFERENCE_CHOICE_LABEL: Record<DifferenceChoice, string> = {
  use_basis: 'Use the quotation or booking value',
  keep_itinerary: 'Keep the itinerary value',
  note: 'Keep it and add a note',
};
export const KEEP_ITINERARY_NOTE = 'Itinerary value kept on purpose.';
export const DIFFERENCE_NOTE_MAX = 500;

export type BasisKind = 'quotation_version' | 'booking_version' | 'none';
export const BASIS_KIND_LABEL: Record<BasisKind, string> = {
  quotation_version: 'Compared with the quotation',
  booking_version: 'Compared with the booking',
  none: 'Nothing to compare with yet',
};

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export type SourceMime = EvidenceMime | typeof DOCX_MIME;
export const SOURCE_MIMES = ['application/pdf', DOCX_MIME, 'image/jpeg', 'image/png', 'image/webp'] as const satisfies readonly SourceMime[];
export const SOURCE_MAX_BYTES = 4 * 1024 * 1024;
export const SOURCE_MAX_FILES = 10;
export const SOURCE_BUCKET = 'itinerary-sources';
export const RENDERED_BUCKET = 'rendered-documents';

export type SourceStatus = 'pending_upload' | 'stored' | 'failed';
export const SOURCE_STATUSES = ['pending_upload', 'stored', 'failed'] as const satisfies readonly SourceStatus[];

/** /app/itineraries/sources/{fileId} and /app/itineraries/rendered/{renderedId} (route files owned by the UI agent). */
export function itinerarySourceHref(fileId: string): string {
  return `/app/itineraries/sources/${fileId}`;
}
export function itineraryRenderedHref(renderedId: string): string {
  return `/app/itineraries/rendered/${renderedId}`;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface ItinerarySummary {
  documentId: string;
  title: string;
  subjectKind: ItinerarySubjectKind;
  draftStatus: ItineraryDraftStatus;
  createdAt: string;
  latestFinal: { renderedId: string; createdAt: string; downloadHref: string } | null;
}

export interface ItineraryListView {
  subjectKind: ItinerarySubjectKind;
  subjectId: string;
  documents: ItinerarySummary[];
  /** Readers are editors: a visible list means "Make branded itinerary" is offered; the database decides. */
  canCreate: boolean;
}

export interface ItineraryDifferenceView {
  differenceId: string;
  path: string;
  kind: DifferenceKind;
  /** Plain words for the path ("Stay 2 · hotel name"). */
  label: string;
  acknowledged: boolean;
  acknowledgedByName: string | null;
  acknowledgedAt: string | null;
  note: string | null;
}

export interface ItinerarySourceView {
  fileId: string;
  fileName: string;
  mime: SourceMime;
  sizeLabel: string;
  status: SourceStatus;
  uploadedAt: string;
  downloadHref: string | null;
}

export interface ItineraryJobView {
  jobId: string;
  kind: RenderKind;
  status: RenderJobStatus;
  attempts: number;
  statusText: string;
  errorText: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface ItineraryRenderedView {
  renderedId: string;
  kind: RenderKind;
  pageCount: number | null;
  sizeLabel: string;
  createdAt: string;
  downloadHref: string;
  /** Preview QA notes (counts and codes only). */
  qa: { placeholders: number; layoutIssues: string[]; safetyHits: string[] } | null;
  /**
   * The QA placeholders in words for the list: "2 missing facts in brackets",
   * with the company GSTIN gap (DEC-50) said separately and not counted as a
   * fact; null when nothing is missing.
   */
  qaNote: string | null;
}

/** The itinerary editor (itinerary_document_get). */
export interface ItineraryEditorView {
  documentId: string;
  title: string;
  /** Batch 3: referralDraftId set when kind is 'referral' (optional for older callers). */
  subject: { kind: ItinerarySubjectKind; quotationId: string | null; dealId: string | null; referralDraftId?: string | null };
  draftId: string;
  status: ItineraryDraftStatus;
  rowVersion: number;
  facts: ItineraryFacts;
  factsHash: string;
  sourceFileId: string | null;
  updatedAt: string | null;
  basis: { kind: BasisKind; id: string | null; hash: string; label: string };
  differences: {
    runId: string | null;
    /** The last check matches the current facts and basis. */
    current: boolean;
    openCount: number;
    items: ItineraryDifferenceView[];
  };
  sources: ItinerarySourceView[];
  jobs: ItineraryJobView[];
  rendered: ItineraryRenderedView[];
  /**
   * DEC-48: the viewer may read the customer prices and the basis has some:
   * the itinerary prints them, and documents this viewer requests include
   * them. Absent on a database before DEC-48.
   */
  pricesIncluded?: boolean;
  canEditFacts: boolean;
  canCheckDifferences: boolean;
  canMarkReady: boolean;
  canRequestPreview: boolean;
  canRequestFinal: boolean;
  canAddSource: boolean;
  /** Plain words for what is needed next. */
  nextStepText: string;
  /**
   * Batch 3: the referral draft behind this itinerary (made on the draft or on a
   * referral quotation); null otherwise; absent from older callers. A closed
   * draft makes the page read-only (every write refuses draft_closed).
   */
  referral?: import('@/modules/quotations/contracts').QuotationReferralView | null;
}

// ---------------------------------------------------------------------------
// Results, refusals, wording
// ---------------------------------------------------------------------------

export interface ItineraryCreateResult {
  documentId: string;
  draftId: string;
  rowVersion: number;
  created: boolean;
}
export interface ItineraryFactsSaveResult {
  rowVersion: number;
  factsHash: string;
}
export interface ItineraryDifferencesResult {
  runId: string;
  differenceCount: number;
  openCount: number;
  outcome: 'created' | 'existing';
}
export interface ItineraryRenderResult {
  jobId: string;
  status: RenderJobStatus;
  outcome: 'created' | 'existing';
}

export type ItineraryReadinessCode = 'destination_missing' | 'dates_missing' | 'days_missing';
export const ITINERARY_READINESS_CODES = ['destination_missing', 'dates_missing', 'days_missing'] as const satisfies readonly ItineraryReadinessCode[];
export const ITINERARY_READINESS_TEXT: Record<ItineraryReadinessCode, string> = {
  destination_missing: 'Add the destination.',
  dates_missing: 'Add the trip start and end dates.',
  days_missing: 'Add the day-by-day plan.',
};

export type ItineraryErrorCode =
  | 'not_authorized'
  | 'not_found'
  | 'invalid_input'
  | 'version_changed'
  | 'request_conflict'
  | 'basis_changed'
  | 'differences_not_checked'
  | 'differences_open'
  | 'not_ready'
  | 'evidence_rejected'
  | 'deal_removed'
  | 'internal_wording'
  | 'basis_value_unavailable'
  | 'document_blocked'
  // Batch 3 referral drafts (atlas-batch3-shapes §1)
  | 'draft_closed'
  | 'referral_drafts_disabled';

export type ItineraryActionResult<T = undefined> =
  | { ok: true; data: T; message: string }
  | {
      ok: false;
      code: ItineraryErrorCode | 'session' | 'upload_failed';
      message: string;
      fields?: string[];
      /** not_ready: what still blocks. */
      issues?: ItineraryReadinessCode[];
      /** document_blocked: plain-word reasons (from DOCUMENT_BLOCK_TEXT). */
      blocks?: string[];
    };

export const ITINERARY_ERROR_STATES: Record<Exclude<ItineraryErrorCode, 'internal_wording' | 'basis_value_unavailable' | 'document_blocked'>, string> = {
  not_authorized: '42501',
  not_found: 'P0002',
  invalid_input: '22023',
  version_changed: '40001',
  request_conflict: '40001',
  basis_changed: '40001',
  differences_not_checked: '55000',
  differences_open: '55000',
  not_ready: '55000',
  evidence_rejected: '22023',
  deal_removed: '55000',
  draft_closed: '55000',
  referral_drafts_disabled: '55000',
};

export const ITINERARY_ERROR_TEXT: Record<ItineraryErrorCode | 'session' | 'upload_failed', string> = {
  not_authorized: 'Only the people preparing this quotation or booking can do this.',
  not_found: 'This itinerary is not available to you. It may not exist, or you may not have access.',
  invalid_input: 'Some details are missing or not valid. Check the highlighted fields.',
  version_changed: 'Not saved. Someone changed these facts after you opened them. Your typed values are still on screen; reload to see the latest.',
  request_conflict: 'This form was already submitted with different details. Reload the page and try again.',
  basis_changed: 'The quotation or booking changed while checking. Check the differences again.',
  differences_not_checked: 'Check the differences with the quotation or booking first (the facts or the quotation changed since the last check).',
  differences_open: 'Some differences are still open. Settle each one first.',
  not_ready: 'Not ready yet. Fix the items listed.',
  evidence_rejected: 'File not accepted: PDF, Word (.docx), JPG, PNG or WebP up to 4 MB, at most 10 files.',
  deal_removed: 'This Deal was removed from the CRM by the Bitrix sync. Nothing was changed.',
  internal_wording: 'Customer text contains internal words (for example net rate or margin). Reword it; nothing was saved.',
  basis_value_unavailable: 'That value can’t be copied automatically (the difference may already be gone). Check the differences again, or change the fact by hand.',
  document_blocked: 'The document can’t be made yet. Fix the items listed; nothing was requested.',
  // Batch 3: provisional plain words (DA-75, DA-78); Mercury confirms.
  draft_closed: 'This draft is closed. Reopen it to make changes. Nothing was saved.',
  referral_drafts_disabled: 'Referral drafts are switched off, so no new draft was made. Existing drafts keep working.',
  session: 'Your session has ended. Sign in again; your typed values are still on screen.',
  upload_failed: 'The file was not stored and does not count. Remove it if it is listed, then upload it again.',
};

/**
 * DEC-48: customer prices printed on the itinerary (selling side only; never
 * cost, margin or budget). Given only to staff who may read the customer
 * prices: the accepted quotation's customer money, or the booking's selling
 * total and payment plan. Paise as decimal strings.
 */
/** One quotation tier's customer prices (Mercury quotation_customer_money_json). */
export interface ItineraryMoneyTier {
  tierKey: 'quoted' | 'upgrade';
  label: string | null;
  /** null while the tier has no total yet. */
  quotedTotalPaise: string | null;
  payingTravellers: number | null;
  /** Only when the per-person amount is exact. */
  perPersonPaise: string | null;
  /** Category amounts add up to the total (else amounts are left out). */
  breakdownHasAmounts: boolean;
  breakdown: Array<{ categoryKey: string; descriptions: string[]; amountPaise: string | null }>;
  plan: Array<{ seq: number; label: string; amountPaise: string; dueRule: string | null; dueDays: number | null; dueDate: string | null }>;
}

export type ItineraryMoney =
  | {
      source: 'quotation_version';
      versionId: string;
      acceptedTier: 'quoted' | 'upgrade' | null;
      tiers: ItineraryMoneyTier[];
    }
  | {
      source: 'booking_version';
      versionId: string;
      sellingTotalPaise: string | null;
      plan: Array<{ seq: number; label: string; amountPaise: string; dueDate: string | null }>;
    };

export const ITINERARY_TEXT = {
  notAvailable: 'Itineraries are not available to you here.',
  /** DEC-48. */
  // I-10
  pricesIncluded: 'Shows customer prices. Never our cost.',
  pricesNotIncluded: 'Documents you request show no prices.',
  notInstalled: 'Branded itineraries are not available on this CRM yet.',
  created: 'Itinerary started. Attach the existing itinerary if you have one, then enter the facts.',
  factsSaved: 'Facts saved. Check the differences with the quotation or booking next.',
  differencesNone: 'No differences with the quotation or booking.',
  differencesFound: '{count} {noun} with the quotation or booking. Settle each one before the itinerary is ready.',
  acknowledged: 'Difference settled.',
  useBasisHint: 'Use “Use the quotation or booking value” on the difference, or change the fact by hand and check again.',
  basisValueUsed: 'The quotation or booking value is now in the itinerary facts, and the differences were checked again.',
  markedReady: 'Facts ready. You can now request the final document.',
  // I-07, I-09
  renderRequested: 'Requested. You can download it here when it is ready.',
  renderExisting: 'This exact document was already requested; showing that request.',
  sourceUploaded: 'File attached privately. It is never sent anywhere.',
  sourceRemoved: 'File removed.',
  nextAttachOrFacts: 'Enter the facts (attach the existing itinerary first if you have one).',
  nextCheck: 'Check the differences with the quotation or booking.',
  nextSettle: 'Settle the open differences.',
  nextReady: 'Mark the facts ready.',
  // Batch 3 (DA-75; provisional words, Mercury confirms).
  referralDraftClosed: 'This referral draft is closed. Reopen it to make changes.',
  nextFinal: 'Request the final document.',
} as const;
