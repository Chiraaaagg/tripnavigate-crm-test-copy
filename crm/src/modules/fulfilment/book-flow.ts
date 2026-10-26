import type {
  BookPriceAccess,
  BookSectionNavItem,
  BookSectionNavState,
  BookStepSectionsVM,
  ErrorSummaryItem,
  ErrorSummaryItemKind,
  ErrorSummaryVM,
  NextSectionNeedingInput,
  SaveRunReport,
} from './book-flow-contract';
import { BOOK_SECTION_LABEL, BOOK_SECTION_STEP, BOOK_SECTIONS, type BookChecklistItem, type BookNowView, type BookSection, type BookStep } from './contracts';

/*
 * Batch 2 Book now flow (pure, server-safe; contract book-flow-contract.ts):
 * the step-3 section list, the next section that still needs input after a
 * save (lead decision L3), the price access line, the error summary shared
 * with the quotation editor, and the honest report of several saves in a row.
 * No data access, no React.
 */

const KIND_ORDER: Record<ErrorSummaryItemKind, number> = { unsaved: 0, refused: 1, blocking: 2, skipped: 3 };

/** Sections of one step in page order. */
export function bookSectionsOf(step: BookStep): BookSection[] {
  return BOOK_SECTIONS.filter((s) => BOOK_SECTION_STEP[s] === step);
}

/** /app/deals/{id}/book/{step}, optionally with ?at= (kept when a redirect drops the fragment) and #anchor. */
export function bookStepAddress(dealId: string, step: BookStep, anchor?: string | null, at?: BookSection | null): string {
  const base = `/app/deals/${dealId}/book/${step}`;
  const query = at ? `?at=${at}` : '';
  return `${base}${query}${anchor ? `#${anchor}` : ''}`;
}

/** "Review and submit" from the Deal header or Home (lead ruling): step 3 at the review section. */
export function reviewAndSubmitHref(dealId: string): string {
  return bookStepAddress(dealId, 'finish', 'review');
}

/**
 * The next section to open after `after` saved: a later section of the same
 * step that needs input, else an earlier one; on step 3, review when nothing
 * else needs input (J8: "Review and submit opens after Save payment plan").
 * null = nothing to open (focus stays with the save report).
 */
export const nextSectionNeedingInput: NextSectionNeedingInput = (status, after) => {
  const step = BOOK_SECTION_STEP[after];
  const sections = bookSectionsOf(step).filter((s) => s !== after);
  const index = BOOK_SECTIONS.indexOf(after);
  const later = sections.filter((s) => BOOK_SECTIONS.indexOf(s) > index);
  const earlier = sections.filter((s) => BOOK_SECTIONS.indexOf(s) < index);
  const open = [...later, ...earlier].find((s) => s !== 'review' && status[s] === 'needs_input');
  if (open) return open;
  if (step === 'finish' && after !== 'review') return 'review';
  return null;
};

type FlowView = Pick<BookNowView, 'dealId' | 'sectionStatus' | 'items' | 'travellers' | 'canEdit' | 'canEditCommercials' | 'version' | 'dealNotActive'>;

/** A section that holds nothing and asks for nothing: hotels or other services with none added, ID details nobody needs. */
function isEmptyOptional(view: FlowView, section: BookSection): boolean {
  const active = view.items.filter((i) => i.state !== 'cancelled');
  switch (section) {
    case 'hotels':
      return !active.some((i) => i.serviceType === 'hotel');
    case 'services':
      return !active.some((i) => i.serviceType !== 'hotel');
    case 'identity':
      return !view.travellers.some((t) => t.identityRequired);
    default:
      return false;
  }
}

export function bookSectionNavState(view: FlowView, section: BookSection): BookSectionNavState {
  const status = view.sectionStatus[section];
  if (status === 'needs_input') return 'to_finish';
  if (status === 'warnings_only') return 'check';
  return isEmptyOptional(view, section) ? 'optional' : 'saved';
}

/** Editable draft, but no price access: one line instead of two locked sections (FP-033). */
export function bookPriceAccess(view: FlowView): BookPriceAccess {
  const editable = view.canEdit && view.version?.status === 'draft' && !view.dealNotActive;
  return editable && !view.canEditCommercials ? 'note' : 'edit';
}

/** DA-153: one line for an editor without price access (it replaces both price and payment plan). */
export const BOOK_PRICE_NOTE = 'The price and payment plan are filled by Sales on this deal.';
/** DA-151: the merged block for staff without price access. */
export const BOOK_PRICE_AND_PAYMENT_LABEL = 'Price and payment';

/**
 * The section list of one step. An editor without price access (Echo M3):
 * only `payment` is dropped; `price` stays as the merged "Price and payment"
 * block (it holds the note and, when the read includes them, the reported
 * payments), so the list and the page show the same sections.
 */
export function bookStepSections(view: FlowView, step: BookStep, current: BookSection | null = null): BookStepSectionsVM {
  const priceAccess = bookPriceAccess(view);
  const sections = bookSectionsOf(step).filter((s) => !(priceAccess === 'note' && s === 'payment'));
  const items: BookSectionNavItem[] = sections.map((section) => ({
    section,
    label: priceAccess === 'note' && section === 'price' ? BOOK_PRICE_AND_PAYMENT_LABEL : BOOK_SECTION_LABEL[section],
    state: bookSectionNavState(view, section),
    href: `#${section}`,
    current: section === current,
  }));
  return { step, items, priceAccess, priceNote: priceAccess === 'note' && step === 'finish' ? BOOK_PRICE_NOTE : null };
}

// ---------------------------------------------------------------------------
// Field ids (the input ids of today's Book now markup; Luna keeps them stable)
// ---------------------------------------------------------------------------

/** Form field name (checklist `field`) → input id. A name not listed focuses the section heading. */
export const BOOK_FIELD_INPUT_ID: Readonly<Record<string, string>> = {
  contactName: 'customer-contact-name',
  mobile: 'customer-mobile',
  email: 'customer-email',
  contactConfirmed: 'customer-contact-confirmed',
  bookingFor: 'customer-booking-for',
  billingName: 'customer-billing-name',
  gstin: 'customer-gstin',
  travellerName: 'passengers-1-name',
  travellerAge: 'passengers-1-age',
  destination: 'trip-destination',
  tripScope: 'trip-scope',
  tripStart: 'trip-start',
  tripEnd: 'trip-end',
  sellingTotalRupees: 'price-total',
  instalmentLabel: 'payment-1-label',
  instalmentAmountRupees: 'payment-1-amount',
};

/** A link to a field (or its section) from `fromStep`: same step → fragment only; other step → address with ?at= and the fragment. */
export function bookFieldHref(dealId: string, fromStep: BookStep | null, section: BookSection, fieldId: string | null): string {
  const anchor = fieldId ?? section;
  const step = BOOK_SECTION_STEP[section];
  return step === fromStep ? `#${anchor}` : bookStepAddress(dealId, step, anchor, section);
}

// ---------------------------------------------------------------------------
// Error summary (shared with the quotation editor)
// ---------------------------------------------------------------------------

/** Unsaved first, then the refusal, then blocking checks, then not tried; page order inside a kind (stable); same part + message once. */
export function orderSummaryItems(items: readonly ErrorSummaryItem[]): ErrorSummaryItem[] {
  const seen = new Set<string>();
  const unique = items.filter((i) => {
    const key = `${i.partId}\u0000${i.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.map((item, index) => ({ item, index })).sort((a, b) => KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind] || a.index - b.index).map((x) => x.item);
}

/** DA-156 (submit summary). */
export const SUMMARY_TITLE = {
  submit: (n: number) => `To finish before submitting (${n})`,
} as const;

/** DA-155: summary lines of a run of saves (Save and continue, Save prices). */
export const SUMMARY_ITEM_TEXT = {
  blocked: (section: string) => `${section}: save or undo it there`,
  refused: (section: string) => `${section}: not saved (the reason is shown there)`,
  skipped: (section: string) => `${section}: not saved because an earlier part failed`,
} as const;

/** DA-155 summary title: unsaved forms that cannot be saved for you block the run; else some or none saved. */
export function saveRunSummaryTitle(r: SaveRunReport): string {
  if (r.blocked.length > 0) return 'Save these first';
  return r.saved.length > 0 ? 'Some changes were not saved' : 'Your changes were not saved';
}

export function errorSummary(title: string, items: readonly ErrorSummaryItem[]): ErrorSummaryVM | null {
  const ordered = orderSummaryItems(items);
  return ordered.length === 0 ? null : { title, items: ordered };
}

/** Blocking checklist items of the booking as summary items (links open the step and focus the field). */
export function bookBlockingItems(view: Pick<BookNowView, 'dealId' | 'checklist'>, fromStep: BookStep | null): ErrorSummaryItem[] {
  return view.checklist
    .filter((i: BookChecklistItem) => i.blocking)
    .map((i) => {
      const fieldId = i.field ? (BOOK_FIELD_INPUT_ID[i.field] ?? null) : null;
      const who = i.travellerSeqs.length > 0 ? `Traveller ${i.travellerSeqs.join(', ')}: ` : '';
      return { kind: 'blocking' as const, partId: i.section, fieldId, message: `${BOOK_SECTION_LABEL[i.section]}: ${who}${i.text}`, href: bookFieldHref(view.dealId, fromStep, i.section, fieldId) };
    });
}

/** Sections with unsaved changes as summary items (same page: link to the section heading). */
export function unsavedItems(entries: ReadonlyArray<{ label: string; partId: BookSection | ErrorSummaryItem['partId'] }>, message: (label: string) => string): ErrorSummaryItem[] {
  return entries.map((e) => ({ kind: 'unsaved' as const, partId: e.partId, fieldId: null, message: message(e.label), href: `#${e.partId}` }));
}

// ---------------------------------------------------------------------------
// Several saves in a row
// ---------------------------------------------------------------------------

export function saveRunReport(input: { saved: readonly string[]; refused: SaveRunReport['refused']; skipped: readonly string[]; blocked?: readonly string[] }): SaveRunReport {
  const blocked = [...(input.blocked ?? [])];
  const saved = [...input.saved];
  const skipped = [...input.skipped];
  const outcome: SaveRunReport['outcome'] = blocked.length > 0 || input.refused ? (saved.length > 0 ? 'partial' : 'refused') : saved.length > 0 ? 'all_saved' : 'nothing_to_save';
  return { outcome, saved, refused: input.refused, skipped, blocked };
}

/** DA-155 sentence for a save report. Never "Saved" for the whole unless everything saved; never implies anything saves by itself. */
export function saveReportText(r: SaveRunReport): string {
  if (r.blocked.length > 0) return `You have unsaved changes in: ${r.blocked.join(', ')}. Save or undo them first.`;
  if (r.outcome === 'nothing_to_save') return 'Nothing to save.';
  if (r.outcome === 'all_saved') return `Saved: ${r.saved.join(', ')}.`;
  const parts = [r.saved.length > 0 ? `Saved: ${r.saved.join(', ')}.` : 'Nothing was saved.', `Not saved: ${r.refused?.label ?? 'nothing'} (reason shown there).`];
  if (r.skipped.length > 0) parts.push(`Not saved because an earlier part failed: ${r.skipped.join(', ')}.`);
  return parts.join(' ');
}

/** The refusal of a save run as a summary item (focus goes to the refused field, else its part). */
export function refusedItem(r: SaveRunReport, href: (partId: ErrorSummaryItem['partId'], fieldId: string | null) => string): ErrorSummaryItem | null {
  if (!r.refused) return null;
  return { kind: 'refused', partId: r.refused.partId, fieldId: r.refused.fieldId, message: SUMMARY_ITEM_TEXT.refused(r.refused.label), href: href(r.refused.partId, r.refused.fieldId) };
}

export function skippedItems(r: SaveRunReport, partOf: (label: string) => ErrorSummaryItem['partId']): ErrorSummaryItem[] {
  return r.skipped.map((label) => {
    const partId = partOf(label);
    return { kind: 'skipped' as const, partId, fieldId: null, message: SUMMARY_ITEM_TEXT.skipped(label), href: `#${partId}` };
  });
}
