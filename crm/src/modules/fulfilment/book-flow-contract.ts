import type { BookSection, BookStep, BookStepStatus } from './contracts';
import type { QuotationSection } from '@/modules/quotations/contracts';

/*
 * Batch 2 frozen contract (lead Step 0, 20 October 2026): Book now step and
 * section navigation, the error summary and the multi-save report. Types
 * only. The error-summary and save-report types are shared with the
 * quotation editor (quotations/editor-contract.ts).
 *
 * Rulings this freezes:
 *   - Closed sections, parts and hotel cards stay mounted; a section with
 *     unsaved changes never collapses (typed values and the unsaved guard
 *     live in the mounted form).
 *   - Step 3: saving one section opens the next section that still needs
 *     input and moves focus to its heading (lead decision L3).
 *   - "Review and submit" links to /app/deals/{id}/book/finish#review.
 *   - Error-summary links focus a field id; SectionFocus opens the section
 *     that holds it (also through ?at= when a redirect drops the fragment).
 *   - Step names are provisional ("1 Travellers · 2 Stay · 3 Finish") until
 *     Mercury's copy pass; they live in contracts.ts BOOK_STEP_LABEL.
 */

// ---------------------------------------------------------------------------
// Step 3 section list (G13)
// ---------------------------------------------------------------------------

/** Saved (nothing open) · Optional (nothing required here) · To finish (blocking) · Check (warnings only). Shown in words and icon. */
export type BookSectionNavState = 'saved' | 'optional' | 'to_finish' | 'check';

export interface BookSectionNavItem {
  section: BookSection;
  label: string;
  state: BookSectionNavState;
  /** '#section' on the same step, else the step address with '#section'. */
  href: string;
  current: boolean;
}

/** 'edit': price and payment plan forms · 'note': one line names who enters the price, instead of two locked sections. */
export type BookPriceAccess = 'edit' | 'note';

/** The next section of the same step, after `after`, whose status is needs_input; null = none (stay, focus the save report). */
export type NextSectionNeedingInput = (status: Readonly<Record<BookSection, BookStepStatus>>, after: BookSection) => BookSection | null;

/** The section-list model of one step. */
export interface BookStepSectionsVM {
  step: BookStep;
  items: BookSectionNavItem[];
  priceAccess: BookPriceAccess;
  /** Sentence shown when priceAccess is 'note' (owner or assigned salesperson enters the price); null otherwise. */
  priceNote: string | null;
}

// ---------------------------------------------------------------------------
// Error summary (P-ERRSUM), shared with the quotation editor
// ---------------------------------------------------------------------------

/**
 * Order of kinds in every summary: unsaved parts first, then the refusal of
 * this save, then blocking checks, then parts not tried. Inside a kind: page
 * order. The same message for the same part is listed once.
 */
export type ErrorSummaryItemKind = 'unsaved' | 'refused' | 'blocking' | 'skipped';

export interface ErrorSummaryItem {
  kind: ErrorSummaryItemKind;
  /** Book now section key or quotation part key that holds the field. */
  partId: BookSection | QuotationSection;
  /** Input id to focus after the part opens; null = focus the part heading. */
  fieldId: string | null;
  /** Plain words, never a database code or text. */
  message: string;
  /** '#fieldId' (or '#partId') on this page; a step address with '?at=' and '#' when on another step. */
  href: string;
}

/**
 * One summary per page. The container takes focus when shown (tabIndex -1),
 * has a heading and a list of links, and does not use role="alert".
 */
export interface ErrorSummaryVM {
  title: string;
  items: ErrorSummaryItem[];
}

// ---------------------------------------------------------------------------
// Several saves in a row: "Save and continue", "Save prices"
// ---------------------------------------------------------------------------

/**
 * The honest result of running several existing commands one after another
 * (no new command): stop at the first refusal, keep typed values, name what
 * was saved, what was refused (its reason is shown at the form) and what was
 * not tried. Never "Saved" for the whole unless every form saved.
 */
export type SaveRunOutcome = 'all_saved' | 'nothing_to_save' | 'partial' | 'refused';

export interface SaveRunReport {
  outcome: SaveRunOutcome;
  /** Labels of the forms saved in this run, in order. */
  saved: string[];
  /** The first refusal; null when none. */
  refused: { label: string; partId: BookSection | QuotationSection; fieldId: string | null; message: string } | null;
  /** Labels of changed forms not tried because an earlier one was refused. */
  skipped: string[];
  /** Forms that cannot be saved for you (a chosen file not attached, a half-added service): the run does not start. */
  blocked: string[];
}
