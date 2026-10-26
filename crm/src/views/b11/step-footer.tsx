'use client';

import { useRouter } from 'next/navigation';
import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn, focusRing } from '@/components/ui/cn';
import { saveReportText, saveRunReport, saveRunSummaryTitle, SUMMARY_ITEM_TEXT } from '@/modules/fulfilment/book-flow';
import type { ErrorSummaryItem } from '@/modules/fulfilment/book-flow-contract';
import type { BookSection } from '@/modules/fulfilment/contracts';
import { useDraftSync, type SyncedEntry } from './draft-sync';
import { PageErrorSummary } from './error-summary';

/*
 * The footer of a Book now step (BK-02, BK-03): Back, the step's save state
 * in words, and "Save and continue". It sticks to the bottom of the window on
 * wide screens only (at 200% zoom and on phones it stays in the page flow, so
 * it never covers the fields).
 *
 * "Save and continue" saves every changed form of the step one at a time in
 * page order, stops at the first refusal (typed values stay), and shows the
 * page error summary (P-ERRSUM) in the page flow above the footer: the report
 * sentence (Terra's saveReportText, DA-155) plus links to the refused form's
 * answer and to the forms not tried. Nothing is called "saved" for the step
 * unless every changed form saved. The footer's sticky band is matched by a
 * scroll padding (globals.css), so a focused field is never hidden under it.
 */

const SAVED_FLAG = 'tn-b11-saved';

function partOf(entry: SyncedEntry): BookSection {
  return entry.section as BookSection;
}

/** Summary items of one run (DA-155 words, Terra's SUMMARY_ITEM_TEXT). */
function summaryItems(refused: SyncedEntry | null, skipped: SyncedEntry[], blocked: SyncedEntry[]): ErrorSummaryItem[] {
  const link = (e: SyncedEntry) => `#${e.targetId ?? e.section}`;
  return [
    ...blocked.map<ErrorSummaryItem>((e) => ({ kind: 'unsaved', partId: partOf(e), fieldId: e.targetId ?? null, message: SUMMARY_ITEM_TEXT.blocked(e.label), href: link(e) })),
    ...(refused ? [{ kind: 'refused' as const, partId: partOf(refused), fieldId: refused.targetId ?? null, message: SUMMARY_ITEM_TEXT.refused(refused.label), href: link(refused) }] : []),
    ...skipped.map<ErrorSummaryItem>((e) => ({ kind: 'skipped', partId: partOf(e), fieldId: e.targetId ?? null, message: SUMMARY_ITEM_TEXT.skipped(e.label), href: link(e) })),
  ];
}

interface Shown {
  title: string;
  text: string;
  items: ErrorSummaryItem[];
  key: number;
}

/** The report of the step's "Save and continue" lives in the page flow above the footer, never inside the sticky footer (Echo M7). */
const ReportCtx = createContext<{ shown: Shown | null; setShown: (s: Shown | null) => void } | null>(null);

export function StepSaveReportProvider({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const value = useMemo(() => ({ shown, setShown }), [shown]);
  return <ReportCtx.Provider value={value}>{children}</ReportCtx.Provider>;
}

/** Where the "Save and continue" summary shows (in flow, after the sections). */
export function StepSaveReport() {
  const ctx = useContext(ReportCtx);
  const shown = ctx?.shown ?? null;
  if (!shown) return <p id="bk-save-report" className="sr-only" aria-live="polite" />;
  return (
    <PageErrorSummary id="bk-save-summary" summary={{ title: shown.title, items: shown.items }} focusKey={shown.key}>
      <p id="bk-save-report" className="m-0 mt-0.75">
        {shown.text}
      </p>
    </PageErrorSummary>
  );
}

export function SaveAndContinue({ nextHref, label, editable }: { nextHref: string; label: string; editable: boolean }) {
  const sync = useDraftSync();
  const router = useRouter();
  const ctx = useContext(ReportCtx);
  const [busy, setBusy] = useState(false);
  const runs = useRef(0);
  const shown = ctx?.shown ?? null;
  const show = (title: string, text: string, items: ErrorSummaryItem[]) => {
    runs.current += 1;
    ctx?.setShown({ title, text, items, key: runs.current });
  };
  const go = async () => {
    if (busy) return;
    setBusy(true);
    ctx?.setShown(null);
    const pending = sync.dirtyEntries();
    const blocked = pending.filter((e) => !e.saveable);
    if (blocked.length > 0) {
      setBusy(false);
      const report = saveRunReport({ saved: [], refused: null, skipped: [], blocked: blocked.map((e) => e.label) });
      show(saveRunSummaryTitle(report), saveReportText(report), summaryItems(null, [], blocked));
      return;
    }
    const saved: SyncedEntry[] = [];
    for (const [i, entry] of pending.entries()) {
      const result = await entry.submit({ refresh: false });
      if (!result.ok) {
        const skipped = pending.slice(i + 1);
        const report = saveRunReport({
          saved: saved.map((e) => e.label),
          refused: { label: entry.label, partId: partOf(entry), fieldId: entry.targetId ?? null, message: 'not saved (the reason is shown there)' },
          skipped: skipped.map((e) => e.label),
        });
        show(saveRunSummaryTitle(report), saveReportText(report), summaryItems(entry, skipped, []));
        setBusy(false);
        router.refresh();
        return;
      }
      saved.push(entry);
    }
    try {
      sessionStorage.setItem(SAVED_FLAG, saveReportText(saveRunReport({ saved: saved.map((e) => e.label), refused: null, skipped: [] })));
    } catch {
      // Storage blocked: the next step simply does not announce it.
    }
    router.push(nextHref);
  };
  if (!editable) {
    return (
      <a href={nextHref} className="inline-flex min-h-11 items-center justify-center rounded-control border border-brand-strong bg-brand-strong px-4 font-semibold text-white no-underline shadow-button hover:bg-brand-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-strong">
        {label.replace('Save and continue', 'Continue')}
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={go}
      aria-busy={busy || undefined}
      aria-describedby={shown ? 'bk-save-report' : undefined}
      className="inline-flex min-h-11 items-center justify-center rounded-control border border-brand-strong bg-brand-strong px-4 py-2 font-semibold whitespace-normal text-white shadow-button hover:bg-brand-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-strong disabled:opacity-60"
      disabled={busy}
    >
      {busy ? 'Saving…' : label}
    </button>
  );
}

/** Step footer: Back, the unsaved state of the step in words, and the step's primary. Sticky on wide screens. */
export function StepFooterBar({ backHref, children, editable }: { backHref: string | null; children?: ReactNode; editable: boolean }) {
  const sync = useDraftSync();
  const dirty = sync.dirtyEntries();
  return (
    <div
      data-slot="step-footer"
      className="mt-2.5 flex flex-col-reverse gap-3 border-t border-line bg-card pt-4 pb-1 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between [@media(min-width:64rem)_and_(min-height:45rem)]:sticky [@media(min-width:64rem)_and_(min-height:45rem)]:bottom-0 [@media(min-width:64rem)_and_(min-height:45rem)]:z-10 [@media(min-width:64rem)_and_(min-height:45rem)]:pb-4"
    >
      <div className="flex flex-wrap items-center gap-3">
        {backHref ? (
          <a href={backHref} className={cn('inline-flex min-h-11 items-center rounded-control px-1 font-medium text-brand-strong underline underline-offset-4', focusRing)}>
            Back
          </a>
        ) : null}
        <span className="text-sm text-quiet" aria-live="polite">
          {!editable ? 'Read only for you.' : dirty.length > 0 ? `Unsaved changes in: ${dirty.map((e) => e.label).join(', ')}.` : 'No unsaved changes on this step.'}
        </span>
      </div>
      {children}
    </div>
  );
}
