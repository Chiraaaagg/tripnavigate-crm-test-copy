import type { BookSection } from '@/modules/fulfilment/contracts';
import type { BookSectionNavItem } from '@/modules/fulfilment/book-flow-contract';

/*
 * Pure helper of the Batch 2 step 3 section list (server-safe, unit-tested).
 * The list itself and the "next section after a save" rule are Terra's
 * (modules/fulfilment/book-flow.ts: bookStepSections, nextSectionNeedingInput);
 * the screen uses those, so one rule runs everywhere.
 */

/** Sections open on first render of step 3: review (always), the first that still needs input, and any section a preview pre-answers. */
export function initialOpenSections(items: readonly BookSectionNavItem[], extra: readonly BookSection[] = []): BookSection[] {
  const first = items.find((x) => x.state === 'to_finish' && x.section !== 'review')?.section;
  return [...new Set<BookSection>(['review', ...(first ? [first] : []), ...extra])];
}

/** The section that starts as "current" in the list (one aria-current): the first open section that is not review. */
export function initialCurrentSection(open: readonly BookSection[]): BookSection | null {
  return open.find((s) => s !== 'review') ?? null;
}
