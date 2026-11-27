import type { BookSection, OpenDraftResult, PrefillFieldCode, PrefillMarkState, PrefillSkipReason, PrefillTargetKind, PrefillView } from './contracts';
import type { QuotationSection } from '@/modules/quotations/contracts';

/*
 * Batch 2 frozen contract (lead Step 0, 20 October 2026): automatic filling
 * from Bitrix on Book now and the quotation editor. Types only, no values and
 * no logic. Read and command shapes follow atlas-batch2-shapes.md (migration
 * 20261122000100_prefill_auto_fill); Atlas's zod schemas must satisfy the
 * read types below. View-model types are what Terra builds on the server and
 * Luna renders; client components receive only these, never the raw reads.
 *
 * Lead ruling D1: the screen mode follows the `prefill_auto_fill` switch as
 * the read reports it (`prefill.autoFill.enabled`):
 *   - off, or `autoFill` absent (database without migration A): mode 'panel'
 *     = today's "From Bitrix" panel with "Use Bitrix value" / "Mark checked"
 *     (restyled only, same commands);
 *   - on: mode 'inline' = values in the fields, a "From Bitrix" marker per
 *     field, details on demand, one "I checked these Bitrix details" per
 *     section, "Fill empty fields from Bitrix" when `canFillEmpty`, and the
 *     one-line "Bitrix now says … Use it · Keep mine" notice.
 * Billing, GSTIN, consent and the contact confirmation tick never carry a
 * marker and are never filled in either mode.
 */

// ---------------------------------------------------------------------------
// Reads (booking_form_get.prefill, quotation_get.prefill; additive keys)
// ---------------------------------------------------------------------------

/** What happened to the creation fill of one target (booking_start_draft, quotation_create). */
export type PrefillAutoFillOutcome = 'filled' | 'off' | 'existing_draft' | 'unavailable' | 'accepted_quotation' | 'not_package' | 'failed';

/** Which path last wrote a field from Bitrix. */
export type PrefillFilledBy = 'auto_fill' | 'fill_empty' | 'apply';

export interface PrefillSkip {
  field: PrefillFieldCode;
  reason: PrefillSkipReason;
}

/** The creation fill of this target; null when it never ran (switch off at the time, older draft, replay). */
export interface PrefillFillRunRead {
  mode: 'create';
  ranAt: string;
  filled: PrefillFieldCode[];
  skipped: PrefillSkip[];
}

export interface PrefillAutoFillRead {
  /** The prefill_auto_fill switch. */
  enabled: boolean;
  run: PrefillFillRunRead | null;
  /** Editable target, Bitrix available, at least one untouched empty field with a usable value. */
  canFillEmpty: boolean;
}

/** "Bitrix now says …". Only on editable targets, after a newer snapshot, value differs, not dismissed for that snapshot. */
export interface PrefillNoticeRead {
  /** Dates YYYY-MM-DD, mobile 10 digits, booking-for 'business', notes only for price-scope callers. */
  bitrixValue: string;
  sourceModifiedAt: string;
  /** true: one line under the field (state from_bitrix, kept or checked); false: in the details only (changed or no mark). */
  inline: boolean;
}

export interface PrefillFieldStateRead {
  field: PrefillFieldCode;
  state: PrefillMarkState | null;
  filledBy: PrefillFilledBy | null;
  /** Staff typed a value at least once (value-free history). */
  staffTouched: boolean;
  /** Empty now and the latest staff event was a clearing. */
  clearedByStaff: boolean;
  notice: PrefillNoticeRead | null;
}

/** The Batch 2 keys of the prefill read. Both are absent on a database without migration A. */
export interface PrefillAutoReadKeys {
  autoFill?: PrefillAutoFillRead;
  fieldStates?: PrefillFieldStateRead[];
}

// ---------------------------------------------------------------------------
// Command results
// ---------------------------------------------------------------------------

/** booking_start_draft: "Start booking" (falls back to booking_open_draft, without these keys, on an older database). */
export interface BookingStartDraftResult extends OpenDraftResult {
  autoFill: PrefillAutoFillOutcome;
  filled: PrefillFieldCode[];
  skipped: PrefillSkip[];
}

/** Keys quotation_create adds to its reply (a replay answers created false, autoFill 'existing_draft'). */
export interface QuotationCreateAutoFill {
  autoFill: PrefillAutoFillOutcome;
  filled: PrefillFieldCode[];
  skipped: PrefillSkip[];
}

/** prefill_fill_empty: "Fill empty fields from Bitrix". Bumps the row version (joins the own-save chain). */
export interface PrefillFillEmptyResult {
  rowVersion: number;
  filled: PrefillFieldCode[];
  skipped: PrefillSkip[];
}

/** prefill_notice_dismiss: "Keep mine". No row-version bump. */
export interface PrefillDismissResult {
  field: PrefillFieldCode;
  sourceModifiedAt: string;
  dismissed: true;
}

// ---------------------------------------------------------------------------
// Forms the two new actions read (values never come from the browser)
// ---------------------------------------------------------------------------

export interface PrefillFillEmptyForm {
  targetKind: PrefillTargetKind;
  versionId: string;
  expectedRowVersion: number;
  /** Booking target only (revalidation). */
  dealId: string | null;
}

export interface PrefillDismissForm extends PrefillFillEmptyForm {
  field: PrefillFieldCode;
  /** The snapshot time the notice was shown for (from PrefillNoticeRead). */
  sourceModifiedAt: string;
}

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

export type PrefillUiMode = 'panel' | 'inline';

/**
 * Where a prefill field sits. Booking: contacts.* → 'customer', trip.* → 'trip'.
 * Quotation: trip.* and requirementsNote → 'details', contacts.* → 'contact'.
 */
export type PrefillSectionKey = Extract<BookSection, 'customer' | 'trip'> | Extract<QuotationSection, 'details' | 'contact'>;

/** The marker beside one field label (words, never colour alone). null marker = nothing shown. */
export interface PrefillMarkerVM {
  field: PrefillFieldCode;
  /** Input id of the field the marker labels. */
  fieldId: string;
  label: string;
  marker: PrefillMarkState | null;
  /** e.g. "From Bitrix", "From Bitrix, saved, not checked". */
  markerText: string | null;
  /** On demand: "Filled from Bitrix on …", "Changed by you". */
  detailsText: string | null;
}

export interface PrefillNoticeVM {
  field: PrefillFieldCode;
  fieldId: string;
  /** Display text of the Bitrix value ("12 Nov 2026"). */
  bitrixValueText: string;
  sourceModifiedAt: string;
  inline: boolean;
  /** "Use it" (booking_prefill_apply / quotation_prefill_apply with this one field). */
  canUse: boolean;
  /** "Keep mine" (prefill_notice_dismiss). */
  canKeep: boolean;
}

export interface PrefillSectionVM {
  section: PrefillSectionKey;
  fields: PrefillMarkerVM[];
  notices: PrefillNoticeVM[];
  /** Fields the section check sends: state from_bitrix or kept. */
  checkable: PrefillFieldCode[];
  /** "I checked these Bitrix details": editable target and checkable not empty. */
  canCheck: boolean;
  details: {
    readAt: string | null;
    sourceModifiedAt: string | null;
    /** Plain-word read issues (never raw codes). */
    issues: string[];
    /** "Not filled from Bitrix" lines: field label + skip reason words. */
    notFilled: Array<{ field: PrefillFieldCode; label: string; reasonText: string }>;
  };
}

export interface PrefillFillEmptyVM {
  /** Shown only for a draft without a creation fill and with canFillEmpty. */
  offered: boolean;
  /** "Save your changes first" while any form of the page is dirty; null when it may be pressed. */
  disabledReason: string | null;
}

/** What a Book now step or the quotation editor receives about Bitrix values. */
export type PrefillUiVM =
  | { mode: 'panel'; view: PrefillView }
  | {
      mode: 'inline';
      available: boolean;
      /** "Bitrix details are not available right now. Type them in." when not available; else null. */
      unavailableText: string | null;
      sections: PrefillSectionVM[];
      fillEmpty: PrefillFillEmptyVM;
      /** Reference only (never copied into a booking): Booking Notes (price readers), Customer Type label, traveller total. */
      reference: { bookingNotes: string | null; notesHidden: boolean; customerTypeLabel: string | null; travellerTotal: number | null };
    };

/** D1: 'inline' only when the read says the switch is on; absent or off → 'panel'. */
export type PrefillUiModeOf = (autoFill: PrefillAutoFillRead | null | undefined) => PrefillUiMode;
