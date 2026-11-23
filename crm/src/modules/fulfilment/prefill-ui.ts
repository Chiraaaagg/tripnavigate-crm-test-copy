import { PREFILL_FIELD_LABEL, PREFILL_SKIP_TEXT, type PrefillFieldCode, type PrefillMarkState, type PrefillView } from './contracts';
import type { PrefillAutoFillRead, PrefillMarkerVM, PrefillNoticeVM, PrefillSectionKey, PrefillSectionVM, PrefillUiMode, PrefillUiModeOf, PrefillUiVM } from './prefill-contract';

/*
 * Batch 2 prefill view model (pure, server-safe; contract prefill-contract.ts).
 * Lead ruling D1: switch off (or a database without migration A) keeps
 * today's panel; switch on gives the inline screen (marker per field,
 * details on demand, one section check, "Fill empty fields", one-line
 * "Bitrix now says … Use it · Keep mine"). Billing, GSTIN, consent and the
 * contact confirmation tick are not prefill fields and never get a marker.
 * Wording is provisional (copy-catalogue BP-01..BP-13); Mercury confirms.
 */

export const prefillUiMode: PrefillUiModeOf = (autoFill: PrefillAutoFillRead | null | undefined): PrefillUiMode => (autoFill?.enabled === true ? 'inline' : 'panel');

export type PrefillTarget = 'booking' | 'quotation';

/** Section of each field and the input id its marker labels (ids of today's markup; Luna keeps them). */
const PLACE: Record<PrefillTarget, Partial<Record<PrefillFieldCode, { section: PrefillSectionKey; fieldId: string }>>> = {
  // Booking form (22 October 2026): the input ids of the booking form (booking-form-model.ts BOOKING_FORM_FIELD_ID).
  booking: {
    'contacts.contactName': { section: 'customer', fieldId: 'bf-contact-name' },
    'contacts.mobile': { section: 'customer', fieldId: 'bf-contact-mobile' },
    'contacts.email': { section: 'customer', fieldId: 'bf-contact-email' },
    'contacts.bookingFor': { section: 'customer', fieldId: 'bf-bill-type' },
    'trip.start': { section: 'trip', fieldId: 'bf-trip-start' },
    'trip.end': { section: 'trip', fieldId: 'bf-trip-end' },
  },
  quotation: {
    'trip.start': { section: 'details', fieldId: 'q-details-tripStart' },
    'trip.end': { section: 'details', fieldId: 'q-details-tripEnd' },
    requirementsNote: { section: 'details', fieldId: 'q-details-requirementsNote' },
    'contacts.contactName': { section: 'contact', fieldId: 'q-contact-contactName' },
    'contacts.mobile': { section: 'contact', fieldId: 'q-contact-mobile' },
    'contacts.email': { section: 'contact', fieldId: 'q-contact-email' },
    'contacts.companyName': { section: 'contact', fieldId: 'q-contact-companyName' },
    'contacts.bookingFor': { section: 'contact', fieldId: 'q-contact-bookingFor' },
  },
};

const SECTION_ORDER: Record<PrefillTarget, PrefillSectionKey[]> = { booking: ['customer', 'trip'], quotation: ['details', 'contact'] };

/** Inline marker words (DA-160), shown beside the label only while the value is still Bitrix's. */
const MARKER_TEXT: Partial<Record<PrefillMarkState, string>> = {
  from_bitrix: 'From Bitrix',
  kept: 'From Bitrix, saved, not checked',
};
/** Details words for every state. */
const DETAILS_TEXT: Record<PrefillMarkState, string> = {
  from_bitrix: 'From Bitrix, not checked yet',
  kept: 'From Bitrix, saved, not checked',
  checked: 'From Bitrix, checked',
  changed: 'Changed by staff after filling from Bitrix',
  replaced_by_quotation: 'Replaced by the accepted quotation',
};

const DATE = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

/** Display text of a Bitrix value (dates "12 Nov 2026", booking-for in words). */
export function bitrixValueText(field: PrefillFieldCode, value: string): string {
  if (field === 'trip.start' || field === 'trip.end') return /^\d{4}-\d{2}-\d{2}$/.test(value) ? DATE.format(new Date(`${value}T00:00:00+05:30`)) : value;
  if (field === 'contacts.bookingFor') return value === 'business' ? 'A business (GST)' : 'An individual';
  return value;
}

export const PREFILL_UI_TEXT = {
  unavailable: 'Bitrix details are not available right now. Type them in.',
  readIssues: 'Some Bitrix details could not be read. Type them yourself.',
} as const;

/**
 * The prefill view model for one target. `editable`: the working version is
 * editable by the viewer (the server decides again on every command).
 * "Fill empty fields" is offered only for a target without a creation fill;
 * the client disables it while any form is dirty.
 */
export function toPrefillUi(view: PrefillView, opts: { target: PrefillTarget; editable: boolean }): PrefillUiVM {
  if (prefillUiMode(view.autoFill) === 'panel') return { mode: 'panel', view };
  const places = PLACE[opts.target];
  const states = new Map((view.fieldStates ?? []).map((f) => [f.field, f]));
  const sections: PrefillSectionVM[] = SECTION_ORDER[opts.target].map((section) => {
    const codes = (Object.keys(places) as PrefillFieldCode[]).filter((c) => places[c]!.section === section);
    const fields: PrefillMarkerVM[] = codes.map((field) => {
      const marker = states.get(field)?.state ?? view.fields.find((f) => f.field === field)?.state ?? null;
      return { field, fieldId: places[field]!.fieldId, label: PREFILL_FIELD_LABEL[field], marker, markerText: marker ? (MARKER_TEXT[marker] ?? null) : null, detailsText: marker ? DETAILS_TEXT[marker] : null };
    });
    // Booking form (lead ruling, 22 October 2026): passive "From Bitrix" markers only; no "Use it / Keep mine" notices.
    const notices: PrefillNoticeVM[] = opts.target === 'booking' ? [] : codes.flatMap((field) => {
      const s = states.get(field);
      if (!s?.notice || s.clearedByStaff || s.state === 'replaced_by_quotation') return [];
      return [{ field, fieldId: places[field]!.fieldId, bitrixValueText: bitrixValueText(field, s.notice.bitrixValue), sourceModifiedAt: s.notice.sourceModifiedAt, inline: s.notice.inline, canUse: opts.editable, canKeep: opts.editable }];
    });
    const checkable = fields.filter((f) => f.marker === 'from_bitrix' || f.marker === 'kept').map((f) => f.field);
    const notFilled = (view.autoFill?.run?.skipped ?? []).filter((s) => codes.includes(s.field)).map((s) => ({ field: s.field, label: PREFILL_FIELD_LABEL[s.field], reasonText: PREFILL_SKIP_TEXT[s.reason] }));
    return {
      section,
      fields,
      notices,
      checkable,
      canCheck: opts.editable && checkable.length > 0,
      details: { readAt: view.lastVerifiedAt, sourceModifiedAt: view.sourceModifiedAt, issues: view.issues.length > 0 ? [PREFILL_UI_TEXT.readIssues] : [], notFilled },
    };
  });
  const offered = opts.editable && view.available && view.autoFill?.run == null && view.autoFill?.canFillEmpty === true;
  return {
    mode: 'inline',
    available: view.available,
    unavailableText: view.available ? null : PREFILL_UI_TEXT.unavailable,
    sections,
    fillEmpty: { offered, disabledReason: null },
    reference: { bookingNotes: view.bookingNotes, notesHidden: view.notesHidden, customerTypeLabel: view.customerTypeLabel, travellerTotal: view.travellerTotal },
  };
}
