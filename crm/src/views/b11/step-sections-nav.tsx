'use client';

import { ChevronDown, Circle, CircleAlert, CircleCheck, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { cn, focusRing } from '@/components/ui/cn';
import { BOOK_STEP_STATUS_SR_TEXT, type BookSection } from '@/modules/fulfilment/contracts';
import type { BookSectionNavState, BookStepSectionsVM } from '@/modules/fulfilment/book-flow-contract';
import { nextSectionNeedingInput } from '@/modules/fulfilment/book-flow';
import type { BookStepStatus } from '@/modules/fulfilment/contracts';
import { initialCurrentSection, initialOpenSections } from './step-sections-model';
import { BOOK_SECTION_LABEL } from './book-fields';
import { useDraftSync } from './draft-sync';
import { OpenPartsProvider, useOpenParts } from './open-parts';

/*
 * Batch 2 Book now sections (BK-02..BK-04, catalog gap G13, lead decision L3).
 *
 * - Every section is a `data-part` block whose heading keeps the id
 *   `{section}-heading` and the marker in words.
 * - Step 3 sections can be closed; the "Review and submit" section is always
 *   open. Closed sections stay mounted (only `hidden`), and a section with
 *   unsaved changes cannot be closed.
 * - Step 3 starts with the first section that still needs input open, and an
 *   in-page section list (Saved · Optional · To finish · Worth checking, in
 *   words and icon) opens any section; one aria-current marks the section
 *   opened last.
 * - Saving a passport, price or payment section on its own opens the next
 *   section that still needs input (Terra's single rule, nextSectionNeedingInput;
 *   Review and submit when nothing else needs input) and moves focus to its
 *   heading.
 */

const NAV_STATE: Record<BookSectionNavState, { icon: LucideIcon; className: string; text: string }> = {
  saved: { icon: CircleCheck, className: 'text-status-success', text: 'Saved' },
  optional: { icon: Circle, className: 'text-quiet', text: 'Optional' },
  to_finish: { icon: CircleAlert, className: 'text-status-danger', text: 'To finish' },
  check: { icon: TriangleAlert, className: 'text-status-warning', text: 'Worth checking' },
};

/** Sections whose own Save moves on to the next section that needs input (services and hotels add and remove cards instead). */
const ADVANCING: ReadonlySet<BookSection> = new Set<BookSection>(['identity', 'price', 'payment']);

/**
 * Open-state of the sections of one step, plus "save opens the next section".
 * Steps 1 and 2 are not collapsible (short cards); every section stays open.
 */
export function StepSectionsProvider({
  sections,
  sectionStatus,
  collapsible,
  extraOpen = [],
  children,
}: {
  sections: BookStepSectionsVM;
  /** The view's section status (the next-section rule reads it). */
  sectionStatus: Readonly<Record<BookSection, BookStepStatus>>;
  collapsible: boolean;
  extraOpen?: readonly BookSection[];
  children: ReactNode;
}) {
  const open = initialOpenSections(sections.items, extraOpen);
  return (
    <OpenPartsProvider initialOpen={open} initialCurrent={initialCurrentSection(open)} collapsible={collapsible}>
      {collapsible ? <AdvanceOnSave sectionStatus={sectionStatus} /> : null}
      {children}
    </OpenPartsProvider>
  );
}

function AdvanceOnSave({ sectionStatus }: { sectionStatus: Readonly<Record<BookSection, BookStepStatus>> }) {
  const sync = useDraftSync();
  const parts = useOpenParts();
  const { subscribeSaved } = sync;
  const latest = useRef({ sectionStatus, sync, parts });
  useEffect(() => {
    latest.current = { sectionStatus, sync, parts };
  });
  useEffect(
    () =>
      subscribeSaved(({ id, section }) => {
        const { sectionStatus: status, sync: s, parts: p } = latest.current;
        if (!ADVANCING.has(section as BookSection)) return;
        // The saved form itself still counts as dirty until its next render.
        if (s.dirtyEntries().some((e) => e.section === section && e.id !== id)) return;
        // The just-saved section no longer needs input from this save's point of view.
        let next = nextSectionNeedingInput({ ...status, [section]: 'complete' }, section as BookSection);
        // Without price access the payment plan has no section of its own: it sits in "Price and payment".
        if (next && !document.getElementById(`${next}-heading`)) next = next === 'payment' && document.getElementById('price-heading') ? 'price' : 'review';
        if (next) p.open(next);
      }),
    [subscribeSaved],
  );
  return null;
}

/** G13: the in-page list of the step's sections with their state in words. */
export function StepSectionsNav({ sections, stepLabel }: { sections: BookStepSectionsVM; stepLabel: string }) {
  const parts = useOpenParts();
  return (
    <nav aria-label={`Sections of ${stepLabel}`} className="rounded-card border border-line bg-card px-3 py-3 shadow-card">
      <p className="m-0 px-1 pb-2 text-sm font-semibold text-quiet">On this step</p>
      <ol className="m-0 grid list-none gap-1 p-0 sm:grid-cols-2">
        {sections.items.map((item) => {
          const marker = NAV_STATE[item.state];
          const Icon = marker.icon;
          const current = parts.collapsible && parts.current === item.section && parts.isOpen(item.section);
          return (
            <li key={item.section} className="m-0">
              <a
                href={item.href}
                aria-current={current ? 'step' : undefined}
                className={cn(
                  'flex min-h-11 items-center gap-2.5 rounded-control border border-transparent px-2.5 py-2 text-base text-copy no-underline hover:bg-wash hover:text-ink',
                  current && 'border-brand-line bg-brand-tint text-brand-deep',
                  focusRing,
                )}
              >
                <Icon aria-hidden="true" className={cn('size-4.5 shrink-0', marker.className)} />
                <span className="min-w-0 flex-1">{item.label}</span>
                <span className="shrink-0 text-sm text-quiet">{marker.text}</span>
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

const SECTION_MARKER = {
  complete: { icon: CircleCheck, className: 'text-status-success' },
  needs_input: { icon: CircleAlert, className: 'text-status-danger' },
  warnings_only: { icon: TriangleAlert, className: 'text-status-warning' },
} as const;

/**
 * A section of a step: anchor id = section key (freeze note §2.1), heading
 * focusable for links and the save report, marker icon plus screen-reader
 * words (status never by colour alone). On a collapsible step the heading
 * holds the open/close button; the body stays mounted when closed.
 */
export function BookSectionBlock({
  section,
  status,
  title,
  description,
  alwaysOpen = false,
  children,
  className,
}: {
  section: BookSection;
  status: keyof typeof SECTION_MARKER | undefined;
  title?: string;
  description?: ReactNode;
  /** Never closes (Review and submit). */
  alwaysOpen?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const parts = useOpenParts();
  const marker = SECTION_MARKER[status ?? 'complete'];
  const Icon = marker.icon;
  const collapsible = parts.collapsible && !alwaysOpen;
  const open = !collapsible || parts.isOpen(section);
  const dirty = collapsible && open && parts.isDirty(section);
  const noteId = useId();
  const label = title ?? BOOK_SECTION_LABEL[section];
  const bodyId = `${section}-body`;
  return (
    <section id={section} data-part={section} aria-labelledby={`${section}-heading`} className={cn('scroll-mt-24 flex flex-col gap-4 border-t border-line pt-6 first:border-t-0 first:pt-0', className)}>
      <div className="flex flex-col gap-1">
        <h3 id={`${section}-heading`} tabIndex={-1} className="m-0 flex items-center gap-2 text-lg font-semibold text-ink outline-none">
          <Icon aria-hidden="true" className={cn('size-4.5 shrink-0', marker.className)} />
          {collapsible ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={bodyId}
              aria-disabled={dirty || undefined}
              aria-describedby={dirty ? noteId : undefined}
              onClick={() => parts.toggle(section)}
              className={cn('-mx-1 m-0 flex min-h-11 flex-1 items-center justify-between gap-2 rounded-control border-0 bg-transparent px-1 text-left text-lg font-semibold text-ink shadow-none', focusRing)}
            >
              <span>
                {label}
                <span className="sr-only"> {BOOK_STEP_STATUS_SR_TEXT[status ?? 'complete']}</span>
              </span>
              <ChevronDown aria-hidden="true" className={cn('size-4.5 shrink-0 text-quiet transition-transform motion-reduce:transition-none', open && 'rotate-180')} />
            </button>
          ) : (
            <>
              <span>{label}</span>
              <span className="sr-only"> {BOOK_STEP_STATUS_SR_TEXT[status ?? 'complete']}</span>
            </>
          )}
        </h3>
        {dirty ? (
          <p id={noteId} className="m-0 text-sm text-quiet">
            Unsaved changes: this section stays open until you save or undo them.
          </p>
        ) : null}
        {description && open ? <div className="m-0 text-quiet">{description}</div> : null}
      </div>
      <div id={bodyId} hidden={!open} className={open ? 'flex flex-col gap-4' : 'hidden'}>
        {children}
      </div>
    </section>
  );
}
