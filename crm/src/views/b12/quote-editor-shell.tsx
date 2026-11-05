'use client';

import { useRouter } from 'next/navigation';
import { ChevronDown, Circle, CircleAlert, CircleCheck, CircleDashed, EyeOff, Lock, TriangleAlert, type LucideIcon } from 'lucide-react';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import type { ErrorSummaryVM, SaveRunReport } from '@/modules/fulfilment/book-flow-contract';
import { saveReportText, saveRunReport } from '@/modules/fulfilment/book-flow';
import type { PrefillUiVM } from '@/modules/fulfilment/prefill-contract';
import type { QuotationChecklistCode } from '@/modules/quotations/contracts';
import type { QuotePartKey, QuotePartState } from '@/modules/quotations/editor-contract';
import { notReadySummary, QUOTE_MARKED_READY_TEXT, QUOTE_PART_LABEL, QUOTE_PART_ORDER, quoteParts, quotePartState, quoteReadiness, unsavedCheckSummary, warningLines } from '@/modules/quotations/editor-model';
import { QFIELD } from '@/modules/quotations/forms';
import { DraftSyncProvider, useDraftSync, useSectionForm, type SyncedEntry } from '../b11/draft-sync';
import { PageErrorSummary } from '../b11/error-summary';
import { OpenPartsProvider, useOpenParts } from '../b11/open-parts';
import { PrefillInlineProvider } from '../b11/prefill-inline';
import { SectionFocus } from '../b11/section-focus';
import { asSyncAction, type QuoteActions } from './quote-kit';
import type { QuoteVersionView } from './quote-shapes';

/*
 * Batch 2 quotation editor frame (QU-02, catalog gaps G1 and G7; lead rulings
 * R8, R6). One client shell around the whole quotation page while it can be
 * edited, so the header's one primary ("Check and mark ready"), the six
 * collapsible parts, the readiness card and the error summary share the same
 * unsaved-changes bookkeeping (DraftSync).
 *
 * - Nothing is red before "Check and mark ready". Pressing it with unsaved
 *   parts shows the summary (unsaved parts first, then the blocking checks
 *   the page holds) and calls nothing; otherwise it calls the existing
 *   mark-ready command, whose not_ready answer is authoritative.
 * - Parts stay mounted when closed; a part with unsaved changes never closes.
 * - "Save prices" runs the existing price commands in page order and reports
 *   honestly what saved, what was refused and what was not tried.
 */

interface CheckContext {
  version: QuoteVersionView;
  summary: ErrorSummaryVM | null;
  summaryKey: number;
  checked: boolean;
  /** "Marked ready to share." after a successful check (DA-183). */
  success: boolean;
  pressCheck: () => Promise<void>;
  busy: boolean;
  /** A refusal that is not a list of checks (conflict, not allowed…), in words. */
  refusal: string | null;
}

const Ctx = createContext<CheckContext | null>(null);

function useCheck(): CheckContext {
  const c = useContext(Ctx);
  if (!c) throw new Error('Quotation editor parts must be inside QuoteEditorShell.');
  return c;
}

/** Parts with unsaved changes, from the page's DraftSync entries. */
function dirtyParts(entries: readonly SyncedEntry[]): Set<QuotePartKey> {
  return new Set(entries.map((e) => e.section as QuotePartKey).filter((s) => (QUOTE_PART_ORDER as readonly string[]).includes(s)));
}

export function QuoteEditorShell({ version, actions, prefillUi = null, reloadHref, children }: { version: QuoteVersionView; actions: QuoteActions; prefillUi?: PrefillUiVM | null; reloadHref: string; children: ReactNode }) {
  const fieldStates = version.prefill?.fieldStates ?? null;
  const initialOpen = quoteParts(version, { fieldStates })
    .filter((p) => p.open)
    .map((p) => p.key);
  return (
    <DraftSyncProvider view={{ version: { rowVersion: version.rowVersion } }}>
      <PrefillInlineProvider
        ui={prefillUi}
        panel={version.prefill}
        target="quotation_version"
        versionId={version.versionId}
        dealId={null}
        rowVersion={version.rowVersion}
        editable={version.canEdit}
        actions={{ use: actions.usePrefill, check: actions.markPrefillChecked, fillEmpty: actions.fillEmptyPrefill, dismiss: actions.dismissPrefillNotice }}
        reloadHref={reloadHref}
      >
        <OpenPartsProvider initialOpen={initialOpen} collapsible>
          <CheckProvider version={version} actions={actions}>
            <SectionFocus />
            {children}
          </CheckProvider>
        </OpenPartsProvider>
      </PrefillInlineProvider>
    </DraftSyncProvider>
  );
}

function CheckProvider({ version: v, actions, children }: { version: QuoteVersionView; actions: QuoteActions; children: ReactNode }) {
  const sync = useDraftSync();
  const router = useRouter();
  const [summary, setSummary] = useState<ErrorSummaryVM | null>(null);
  const [summaryKey, setSummaryKey] = useState(0);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const f = useSectionForm({ id: 'quote-mark-ready', section: 'details', label: 'Check and mark ready', order: 0, action: asSyncAction(actions.markReady), initial: {}, versionBound: true, rowVersion: v.rowVersion, saveable: false, tracksDirty: false });
  const { post } = f;
  // The press reads the page's unsaved state at that moment, not at the last render of this provider.
  const syncRef = useRef(sync);
  useEffect(() => {
    syncRef.current = sync;
  });
  const show = (s: ErrorSummaryVM | null) => {
    setSummary(s);
    setSummaryKey((k) => k + 1);
  };
  const pressCheck = async () => {
    if (busy) return;
    setChecked(true);
    setRefusal(null);
    setSuccess(false);
    // R8 step 1: unsaved parts are named first and nothing is sent.
    const unsaved = [...dirtyParts(syncRef.current.dirtyEntries())].sort((a, b) => QUOTE_PART_ORDER.indexOf(a) - QUOTE_PART_ORDER.indexOf(b)).map((part) => ({ part, label: QUOTE_PART_LABEL[part] }));
    const local = unsavedCheckSummary(v, unsaved);
    if (local) {
      show(local);
      return;
    }
    setBusy(true);
    const fd = new FormData();
    fd.set(QFIELD.versionId, v.versionId);
    const result = await post(fd, { refresh: false });
    setBusy(false);
    if (result.ok) {
      show(null);
      setSuccess(true);
      router.refresh();
      return;
    }
    // R8 step 2: the server's not_ready list is authoritative.
    const codes = ((result as { issues?: string[] }).issues ?? []) as QuotationChecklistCode[];
    if (result.code === 'not_ready' && codes.length > 0) {
      show(notReadySummary(codes, { priceAccess: v.money !== undefined }));
      return;
    }
    show(null);
    setRefusal(result.message || 'Reload the page and try again.');
  };
  // A summary from an earlier press goes stale once a part saves (Echo L5): clear it; the part states stay checked.
  const { subscribeSaved } = sync;
  useEffect(
    () =>
      subscribeSaved(() => {
        setSummary(null);
        setRefusal(null);
        // A later save can return the version to draft: never leave "Marked ready to share." on screen (Echo N2).
        setSuccess(false);
      }),
    [subscribeSaved],
  );
  const pressRef = useRef(pressCheck);
  useEffect(() => {
    pressRef.current = pressCheck;
  });
  const value = useMemo<CheckContext>(() => ({ version: v, summary, summaryKey, checked, success, pressCheck: () => pressRef.current(), busy, refusal }), [v, summary, summaryKey, checked, success, busy, refusal]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The header's one primary for a draft: "Check and mark ready" (enabled, so keyboard and screen-reader users can always press it). */
export function CheckAndMarkReadyButton() {
  const c = useCheck();
  return (
    <Button variant="primary" size="lg" className="min-h-11" onClick={() => void c.pressCheck()} loading={c.busy} disabled={c.busy}>
      {c.busy ? 'Checking…' : 'Check and mark ready'}
    </Button>
  );
}

/** The summary after "Check and mark ready" (one per page; takes focus; not an alert). */
export function QuoteCheckSummary() {
  const c = useCheck();
  if (c.success) {
    return (
      <p role="status" className="m-0 rounded-control border border-status-success-line bg-status-success-tint px-3.5 py-3 text-copy">
        {QUOTE_MARKED_READY_TEXT}
      </p>
    );
  }
  if (c.refusal) {
    return (
      <div role="status" className="rounded-control border-2 border-status-danger-line bg-status-danger-tint px-3.5 py-3 text-copy">
        <p className="m-0 font-semibold text-ink">Not marked ready.</p>
        <p className="m-0 mt-0.75">{c.refusal}</p>
      </div>
    );
  }
  if (!c.summary) return null;
  return <PageErrorSummary id="quote-check-summary" summary={c.summary} focusKey={c.summaryKey} />;
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

const PART_STATE: Record<QuotePartState, { icon: LucideIcon; className: string; text: string }> = {
  not_started: { icon: CircleDashed, className: 'text-quiet', text: 'Not started' },
  saved: { icon: CircleCheck, className: 'text-status-success', text: 'Saved' },
  needs_input: { icon: CircleAlert, className: 'text-status-danger', text: 'Needs input' },
  optional: { icon: Circle, className: 'text-quiet', text: 'Optional' },
  read_only: { icon: Lock, className: 'text-faint', text: 'Read only' },
  prices_hidden: { icon: EyeOff, className: 'text-faint', text: 'Prices hidden' },
};

function usePartState(part: QuotePartKey): QuotePartState {
  const c = useCheck();
  const sync = useDraftSync();
  const dirty = dirtyParts(sync.dirtyEntries());
  return quotePartState(c.version, part, { dirty, checked: c.checked, fieldStates: c.version.prefill?.fieldStates ?? null });
}

/** One of the six parts (G1): a card whose heading opens and closes it, its state in words and icon. */
export function QuotePart({ part, number, description, children, footer }: { part: QuotePartKey; number: number; description?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const parts = useOpenParts();
  const state = usePartState(part);
  const open = parts.isOpen(part);
  const dirty = open && parts.isDirty(part);
  const marker = PART_STATE[state];
  const Icon = marker.icon;
  const bodyId = `${part}-body`;
  const label = QUOTE_PART_LABEL[part];
  return (
    <Card>
      <section id={part} data-part={part} aria-labelledby={`${part}-heading`} className="scroll-mt-24">
        <CardHeader className="py-2">
          <CardTitle id={`${part}-heading`} tabIndex={-1} className="w-full outline-none">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={bodyId}
              aria-disabled={dirty || undefined}
              aria-describedby={dirty ? `${part}-stays-open` : undefined}
              onClick={() => parts.toggle(part)}
              className={cn('m-0 flex min-h-11 w-full items-center gap-2.5 rounded-control border-0 bg-transparent px-0 text-left text-lg font-semibold text-ink shadow-none', focusRing)}
            >
              <span className="min-w-0 flex-1">
                <span className="tabular-nums">{number}.</span> {label}
              </span>
              <span className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-copy">
                <Icon aria-hidden="true" className={cn('size-4', marker.className)} />
                {marker.text}
              </span>
              <ChevronDown aria-hidden="true" className={cn('size-4.5 shrink-0 text-quiet transition-transform motion-reduce:transition-none', open && 'rotate-180')} />
            </button>
          </CardTitle>
          {dirty ? (
            <p id={`${part}-stays-open`} className="m-0 basis-full text-sm text-quiet">
              Unsaved changes: this part stays open until you save or undo them.
            </p>
          ) : null}
        </CardHeader>
        <div id={bodyId} hidden={!open} className={open ? 'block' : 'hidden'}>
          <CardBody className="flex flex-col gap-4">
            {description ? <p className="m-0 text-quiet">{description}</p> : null}
            {children}
            {footer}
          </CardBody>
        </div>
      </section>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Readiness card (right column)
// ---------------------------------------------------------------------------

export function QuoteReadinessCard() {
  const c = useCheck();
  const v = c.version;
  const sync = useDraftSync();
  const parts = useOpenParts();
  const dirty = dirtyParts(sync.dirtyEntries());
  const fieldStates = v.prefill?.fieldStates ?? null;
  const readiness = quoteReadiness(v, { dirty, checked: c.checked, fieldStates });
  const states = QUOTE_PART_ORDER.map((key) => ({ key, state: quotePartState(v, key, { dirty, checked: c.checked, fieldStates }) }));
  const warnings = warningLines(v);
  const unchecked = v.prefill?.unchecked.length ?? 0;
  const title = readiness.state === 'ready' ? 'Ready to share' : readiness.state === 'not_started' ? 'Not started' : `${readiness.savedParts} of ${readiness.totalParts} parts done`;
  return (
    <Card className="[@media(min-width:64rem)_and_(min-height:48rem)]:sticky [@media(min-width:64rem)_and_(min-height:48rem)]:top-20">
      <section aria-labelledby="quote-readiness-heading">
        <CardHeader>
          <CardTitle id="quote-readiness-heading">{title}</CardTitle>
          <CardDescription className="basis-full">
            {v.status === 'ready' ? 'Any change moves it back to draft.' : 'Fill the parts in any order, then press “Check and mark ready”.'}
          </CardDescription>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Parts of this quotation">
            {states.map(({ key, state }, i) => {
              const marker = PART_STATE[state];
              const Icon = marker.icon;
              return (
                <li key={key} className="m-0">
                  <a
                    href={`#${key}`}
                    onClick={(e) => {
                      e.preventDefault();
                      parts.open(key);
                    }}
                    className={cn('flex min-h-11 items-center gap-2 rounded-control px-1.5 text-copy no-underline hover:bg-wash hover:text-ink', focusRing)}
                  >
                    <Icon aria-hidden="true" className={cn('size-4 shrink-0', marker.className)} />
                    <span className="min-w-0 flex-1">
                      {i + 1}. {QUOTE_PART_LABEL[key]}
                    </span>
                    <span className="shrink-0 text-sm text-quiet">{marker.text}</span>
                  </a>
                </li>
              );
            })}
          </ul>
          {unchecked > 0 ? (
            <p className="m-0 flex gap-2 text-sm text-copy">
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-warning" />
              <span>
                <span className="sr-only">Worth checking: </span>
                {unchecked} {unchecked === 1 ? 'detail' : 'details'} came from Bitrix. Check {unchecked === 1 ? 'it' : 'them'} with the customer.
              </span>
            </p>
          ) : null}
          {warnings.length > 0 ? (
            <div>
              <p className="m-0 text-sm font-semibold text-ink">Worth checking ({warnings.length}) — these do not stop sharing</p>
              <ul className="m-0 mt-1.5 flex list-none flex-col gap-1.5 p-0 text-sm">
                {warnings.map((w) => (
                  <li key={w.code} className="m-0 flex gap-2">
                    <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-warning" />
                    <a
                      href={`#${w.fieldId}`}
                      className={cn('rounded-chip font-medium text-brand-strong underline underline-offset-4 hover:text-brand-deep', focusRing)}
                    >
                      <span className="sr-only">Worth checking: </span>
                      {w.internal ? (
                        <span className="mr-1 inline-flex items-center gap-1 rounded-chip border border-line-strong px-1 text-xs font-semibold text-copy no-underline">
                          <Lock aria-hidden="true" className="size-3" />
                          Internal
                        </span>
                      ) : null}
                      {w.text}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardBody>
      </section>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// "Save prices": the existing price commands, in page order, one report
// ---------------------------------------------------------------------------

export function SavePricesButton() {
  const sync = useDraftSync();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<{ r: SaveRunReport; key: number; refusedTarget: string | null } | null>(null);
  const runs = useRef(0);
  const dirty = sync.dirtyEntries().filter((e) => e.section === 'money' && e.saveable);
  const go = async () => {
    if (busy) return;
    setBusy(true);
    setReport(null);
    const pending = sync.dirtyEntries().filter((e) => e.section === 'money' && e.saveable);
    const saved: string[] = [];
    let refused: SyncedEntry | null = null;
    let skipped: string[] = [];
    for (const [i, entry] of pending.entries()) {
      const result = await entry.submit({ refresh: false });
      if (!result.ok) {
        refused = entry;
        skipped = pending.slice(i + 1).map((e) => e.label);
        break;
      }
      saved.push(entry.label);
    }
    const r = saveRunReport({ saved, refused: refused ? { label: refused.label, partId: 'money', fieldId: refused.targetId ?? null, message: 'not saved (the reason is shown there)' } : null, skipped });
    runs.current += 1;
    setReport({ r, key: runs.current, refusedTarget: refused?.targetId ?? null });
    setBusy(false);
    router.refresh();
  };
  const r = report?.r ?? null;
  const failed = r && (r.outcome === 'partial' || r.outcome === 'refused');
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4">
      {failed && r ? (
        <PageErrorSummary
          id="quote-prices-summary"
          focusKey={report!.key}
          summary={{
            title: r.saved.length > 0 ? 'Some prices were not saved' : 'Prices were not saved',
            items: [
              ...(r.refused ? [{ kind: 'refused' as const, partId: 'money' as const, fieldId: report!.refusedTarget, message: `${r.refused.label}: not saved (the reason is shown there)`, href: `#${report!.refusedTarget ?? 'money'}` }] : []),
              ...r.skipped.map((label) => ({ kind: 'skipped' as const, partId: 'money' as const, fieldId: null, message: `${label}: not saved because an earlier part failed`, href: '#money' })),
            ],
          }}
        >
          <p id="quote-prices-report" className="m-0 mt-0.75">
            {saveReportText(r)}
          </p>
        </PageErrorSummary>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" size="lg" className="min-h-11" onClick={() => void go()} loading={busy} disabled={busy}>
          {busy ? 'Saving…' : 'Save prices'}
        </Button>
        {/* Only the report is announced; the unsaved line changes with every keystroke (Echo L4). */}
        <span className="text-sm text-quiet">{dirty.length > 0 ? `Unsaved: ${dirty.map((e) => e.label).join(', ')}.` : r && !failed ? '' : 'No unsaved price changes.'}</span>
        <span className="text-sm text-copy" role="status">
          {r && !failed ? saveReportText(r) : ''}
        </span>
      </div>
    </div>
  );
}
