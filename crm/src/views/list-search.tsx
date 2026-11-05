'use client';

import { CircleAlert, Info, Search, SearchX } from 'lucide-react';
import { type ReactNode, type SubmitEvent, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { HandForm, useHandFormStatus } from '@/components/hand-form';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { Table, TableBody, TableCaption } from '@/components/ui/table';
import type { DealListRowModel, LeadListRowModel } from '@/modules/deals/list-model';
import {
  type DealSearchResult,
  type LeadSearchResult,
  normaliseSearchQuery,
  SEARCH_FIELD,
  SEARCH_LIMITS,
  type SearchErrorCode,
  type SearchKind,
  searchQueryLength,
} from '@/modules/search/contracts';
import { DealListRow, DealsTableHeader, LeadListRow, LeadsTableHeader } from './list-rows';
import { SEARCH_TEXT, type SearchNoun } from './list-search-text';

/*
 * List search boxes.
 *
 * ListSearch: "Search this page" (DA-100 to DA-102). It hides and shows rows
 * that are ALREADY rendered on this page, using each row's `data-search` text
 * (reference and title only). It receives no row data and never fetches
 * anything, so it cannot reveal a record the page did not show. Quotations and
 * itineraries still use it.
 *
 * LeadsServerSearch / DealsServerSearch (Batch 5, contracts.md section E):
 * search every lead or deal the person can see. The words travel only in the
 * POST body of a server action (HandForm, so the typed words are never reset),
 * never in the address. Found rows render with the list's own row components.
 * The state lives here, so a live refresh of the list (router.refresh) keeps
 * the results. If the database has no search yet (`not_installed`), the box
 * falls back to the page-only search above, and says so.
 *
 * Without script neither box is shown (it could not work), as before; the
 * list itself always renders.
 */
const noop = () => () => {};

/** False on the server and during hydration, true in the browser: the box appears only where it works. */
function useMounted(): boolean {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}

/** Shows or hides the rendered rows; returns how many match. DOM only, no data. */
function applyFilter(tableId: string, query: string): { shown: number; total: number } | null {
  const table = document.getElementById(tableId);
  if (!table) return null;
  const rows = Array.from(table.querySelectorAll<HTMLElement>('tbody tr[data-search]'));
  const needle = query.trim().toLowerCase();
  let shown = 0;
  for (const row of rows) {
    const match = needle === '' || (row.dataset.search ?? '').includes(needle);
    row.hidden = !match;
    if (match) shown += 1;
  }
  return needle === '' ? null : { shown, total: rows.length };
}

const SINGLE: Record<ListSearchNoun, string> = {
  leads: 'lead',
  deals: 'deal',
  quotations: 'quotation',
  itineraries: 'itinerary',
};

/** DA-102: Leads and Deals point to Bitrix; quotations and itineraries live in the CRM (Batch 3). */
const NO_MATCH: Record<ListSearchNoun, (single: string) => string> = {
  leads: (single) => `No match on this page. Try Next page, or find the ${single} in Bitrix.`,
  deals: (single) => `No match on this page. Try Next page, or find the ${single} in Bitrix.`,
  quotations: () => 'No match on this page. Try Next page, another filter, or open a quotation by its reference.',
  itineraries: () => 'No match on this page. Try Next page or another filter.',
};

function pageResultText(noun: ListSearchNoun, result: { shown: number; total: number } | null): string {
  if (result === null) return '';
  return result.shown === 0 ? NO_MATCH[noun](SINGLE[noun]) : `${result.shown} of ${result.total} ${noun} on this page match.`;
}

export type ListSearchNoun = 'leads' | 'deals' | 'quotations' | 'itineraries';

export function ListSearch({ tableId, noun }: { tableId: string; noun: ListSearchNoun }) {
  const id = useId();
  const mounted = useMounted();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<{ shown: number; total: number } | null>(null);

  // A live refresh can re-render the rows: apply the current words again (DOM only).
  useEffect(() => {
    if (query) applyFilter(tableId, query);
  });

  if (!mounted) return null;
  return (
    <div className="flex w-full max-w-md flex-col gap-1 font-sans" data-slot="list-search">
      <label htmlFor={id} className="text-sm font-semibold text-ink">
        Search this page
      </label>
      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2 text-quiet" />
        <Input
          id={id}
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setResult(applyFilter(tableId, event.target.value));
          }}
          placeholder="Name, trip or reference"
          aria-describedby={`${id}-scope ${id}-result`}
          autoComplete="off"
          // The legacy stylesheet pads every input; the icon needs the wider left padding.
          className="pl-9!"
        />
      </div>
      {/* DA-101a: the label already names the scope; the hint stays for screen readers. */}
      <p id={`${id}-scope`} className="sr-only">
        Searches this page only.
      </p>
      <p id={`${id}-result`} role="status" aria-live="polite" className="m-0 text-sm text-copy">
        {pageResultText(noun, result)}
      </p>
    </div>
  );
}

// ===========================================================================
// Server search (Batch 5)
// ===========================================================================

export type LeadSearchAction = (formData: FormData) => Promise<LeadSearchResult>;
export type DealSearchAction = (formData: FormData) => Promise<DealSearchResult>;

type SearchRow = { id: string };

type SearchReply<R> =
  | {
      ok: true;
      query: string;
      rows: R[];
      nextAfter: string | null;
      titlesSearched: boolean;
    }
  | { ok: false; query: string; code: SearchErrorCode; message: string };

/** What the area below the box shows. "Searching" is a flag on top (the last answer stays visible while the next loads). */
type SearchView<R> =
  | { state: 'idle' }
  | { state: 'too_short' }
  | { state: 'refused'; code: 'not_authorized' | 'unexpected' }
  | {
      state: 'results';
      query: string;
      rows: R[];
      nextAfter: string | null;
      titlesSearched: boolean;
      moreFailed: boolean;
    };

interface ServerSearchProps {
  /** id of the list table (the page-only fallback filters its rows). */
  tableId: string;
  /** The server-rendered list: shown when no search result is on screen. */
  list: ReactNode;
  /** Beside the box while the list shows (the Deals order control); hidden with search results, which it does not order. */
  aside?: ReactNode;
  /** Above the box while the list shows (the filter chips); hidden with search results, which filters do not apply to (Echo-B L4). */
  chips?: ReactNode;
  /** A filter other than All is chosen: the results note then says it comes back after Clear search (DA-308). */
  filterActive?: boolean;
}

function SearchSubmit({ searching }: { searching: boolean }) {
  // aria-disabled, not disabled: a disabled button would drop keyboard focus. Presses while searching are ignored (onSubmit).
  return (
    <Button type="submit" variant="primary" aria-disabled={searching || undefined} aria-busy={searching || undefined} data-slot="search-submit">
      <Search aria-hidden="true" />
      {searching ? SEARCH_TEXT.submitting : SEARCH_TEXT.submit}
    </Button>
  );
}

function ShowMoreSubmit({ noun }: { noun: SearchNoun }) {
  const { pending } = useHandFormStatus();
  return (
    <Button type="submit" variant="secondary" aria-disabled={pending || undefined} aria-busy={pending || undefined} data-slot="search-more">
      {pending ? SEARCH_TEXT.showingMore : SEARCH_TEXT.showMore(noun)}
    </Button>
  );
}

function ServerSearch<R extends SearchRow>({
  kind,
  noun,
  action,
  tableId,
  list,
  aside,
  chips,
  filterActive = false,
  renderRows,
}: ServerSearchProps & {
  kind: SearchKind;
  noun: SearchNoun;
  action: (formData: FormData) => Promise<SearchReply<R>>;
  /** The results table, built from the list's own row components. */
  renderRows: (rows: R[], caption: string) => ReactNode;
}) {
  const id = useId();
  const mounted = useMounted();
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'server' | 'page'>('server');
  const [view, setView] = useState<SearchView<R>>({ state: 'idle' });
  const [searching, setSearching] = useState(false);
  const [announce, setAnnounce] = useState('');
  const [pageResult, setPageResult] = useState<{
    shown: number;
    total: number;
  } | null>(null);
  // Every new search or clear bumps the ticket; an answer for an older ticket is dropped.
  const ticket = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLElement>(null);
  // After "Show more": the index of the first new row, focused once it is on screen.
  const focusRow = useRef<number | null>(null);

  // Page-only fallback: a live refresh re-renders the rows, so apply the words again (DOM only).
  useEffect(() => {
    if (mode === 'page' && query) applyFilter(tableId, query);
  });

  useEffect(() => {
    const index = focusRow.current;
    if (index === null) return;
    focusRow.current = null;
    resultsRef.current?.querySelectorAll<HTMLElement>('[data-slot="row-link"]')[index]?.focus();
  }, [view]);

  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const headingId = `${id}-results`;
  const results = view.state === 'results' ? view : null;
  const canClear = view.state !== 'idle' || query !== '';

  const clear = () => {
    ticket.current += 1;
    setSearching(false);
    setQuery('');
    setView({ state: 'idle' });
    if (mode === 'page') setPageResult(applyFilter(tableId, ''));
    setAnnounce(SEARCH_TEXT.cleared);
    inputRef.current?.focus();
  };

  /*
   * The search runs from here, not from HandForm's own transition: the
   * "Searching…" state shows at once (updates inside a pending transition wait
   * for its end), and a search pressed right after Clear search is never
   * ignored while an older, dropped answer is still on its way. HandForm still
   * gives the form its never-reset contract. (The form renders only after the
   * page's script runs, so there is no no-script path: DA-315.)
   */
  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Page-only fallback filters while typing; Enter sends nothing.
    if (mode === 'page') return;
    // A press while a search runs is ignored (the button says "Searching…", aria-busy); Clear search ends the wait.
    if (searching) return;
    if (searchQueryLength(normaliseSearchQuery(query)) < SEARCH_LIMITS.minLength) {
      ticket.current += 1;
      setSearching(false);
      setView({ state: 'too_short' });
      setAnnounce(SEARCH_TEXT.tooShort);
      inputRef.current?.focus();
      return;
    }
    void runSearch(new FormData(event.currentTarget));
  };

  const refuse = (reply: Extract<SearchReply<R>, { ok: false }> | null) => {
    const code = reply?.code ?? 'unexpected';
    if (code === 'not_installed') {
      setMode('page');
      setView({ state: 'idle' });
      setPageResult(applyFilter(tableId, query));
      setAnnounce(SEARCH_TEXT.notInstalled(noun));
    } else if (code === 'too_short') {
      setView({ state: 'too_short' });
      setAnnounce(SEARCH_TEXT.tooShort);
    } else {
      setView({ state: 'refused', code });
      setAnnounce(code === 'not_authorized' ? SEARCH_TEXT.notAuthorized(noun) : SEARCH_TEXT.failed);
    }
  };

  const runSearch = async (formData: FormData) => {
    const mine = ++ticket.current;
    setSearching(true);
    setAnnounce(SEARCH_TEXT.searching(noun));
    let reply: SearchReply<R> | null;
    try {
      reply = await action(formData);
    } catch {
      reply = null;
    }
    if (mine !== ticket.current) return;
    setSearching(false);
    if (reply?.ok) {
      setView({
        state: 'results',
        query: reply.query,
        rows: reply.rows,
        nextAfter: reply.nextAfter,
        titlesSearched: reply.titlesSearched,
        moreFailed: false,
      });
      setAnnounce(
        reply.rows.length === 0
          ? `${SEARCH_TEXT.noResultsTitle(reply.query, noun, reply.titlesSearched)} ${SEARCH_TEXT.noResultsBody(reply.query, noun, reply.titlesSearched)}`
          : SEARCH_TEXT.found(reply.rows.length, reply.query, reply.nextAfter !== null),
      );
    } else {
      refuse(reply);
    }
  };

  const runMore = async (formData: FormData) => {
    // The results this press belongs to. A new search or Clear search bumps the ticket, so a late answer is dropped.
    const current = view;
    const mine = ticket.current;
    if (current.state !== 'results') return;
    let reply: SearchReply<R> | null;
    try {
      reply = await action(formData);
    } catch {
      reply = null;
    }
    if (mine !== ticket.current) return;
    if (!reply?.ok) {
      setView({ ...current, moreFailed: true });
      setAnnounce(SEARCH_TEXT.moreFailed(noun));
      return;
    }
    const seen = new Set(current.rows.map((r) => r.id));
    const added = reply.rows.filter((r) => !seen.has(r.id));
    const rows = [...current.rows, ...added];
    // Focus the first new row (the pressed button may disappear); with nothing new, the last row.
    focusRow.current = added.length > 0 ? current.rows.length : Math.max(0, rows.length - 1);
    setView({
      ...current,
      rows,
      nextAfter: reply.nextAfter,
      moreFailed: false,
    });
    setAnnounce(SEARCH_TEXT.found(rows.length, current.query, reply.nextAfter !== null));
  };

  const tooShort = view.state === 'too_short';
  const label = mode === 'page' ? 'Search this page' : SEARCH_TEXT.label(noun);

  return (
    <div className="flex flex-col gap-4 font-sans" data-slot="server-search" data-search-state={!mounted ? 'no-script' : mode === 'page' ? 'page' : view.state}>
      {results ? null : chips}
      {/* Without script (and before hydration) the box could not work, so only the order control shows; the list keeps its place in the tree. */}
      <div className={cn('flex flex-wrap items-end gap-3', mounted ? 'justify-between' : 'justify-end')}>
        {mounted ? (
          <HandForm action={runSearch} onSubmit={onSubmit} role="search" aria-label={label} className="flex w-full max-w-xl min-w-0 flex-col gap-1">
            <label htmlFor={id} className="text-sm font-semibold text-ink">
              {label}
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-0 flex-1 basis-56">
                <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2 text-quiet" />
                <Input
                  ref={inputRef}
                  id={id}
                  name={SEARCH_FIELD.query}
                  type="search"
                  value={query}
                  maxLength={SEARCH_LIMITS.maxLength}
                  invalid={tooShort}
                  onChange={(event) => {
                    const next = event.target.value;
                    // Emptying the box (the browser's own × or deleting every character) is Clear search (Echo-B L3).
                    if (next === '' && (view.state !== 'idle' || mode === 'page')) {
                      clear();
                      return;
                    }
                    setQuery(next);
                    if (mode === 'page') setPageResult(applyFilter(tableId, next));
                    else if (tooShort && searchQueryLength(normaliseSearchQuery(next)) >= SEARCH_LIMITS.minLength) {
                      setView({ state: 'idle' });
                      setAnnounce('');
                    }
                  }}
                  onKeyDown={(event) => {
                    // Escape is Clear search (in one step, instead of the browser's own emptying of a search box).
                    if (event.key === 'Escape' && canClear) {
                      event.preventDefault();
                      clear();
                    }
                  }}
                  placeholder={mode === 'page' ? 'Name, trip or reference' : SEARCH_TEXT.placeholder}
                  aria-describedby={tooShort ? `${errorId} ${hintId}` : hintId}
                  autoComplete="off"
                  enterKeyHint="search"
                  // The legacy stylesheet pads every input; the icon needs the wider left padding.
                  className="pl-9!"
                />
              </div>
              <input type="hidden" name={SEARCH_FIELD.kind} value={kind} />
              {mode === 'server' ? <SearchSubmit searching={searching} /> : null}
              {canClear ? (
                <Button type="button" variant="ghost" onClick={clear} data-slot="search-clear">
                  {SEARCH_TEXT.clear}
                </Button>
              ) : null}
            </div>
            {tooShort ? (
              <p id={errorId} className="m-0 flex items-start gap-1.5 text-sm font-medium text-status-danger">
                <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <span>{SEARCH_TEXT.tooShort}</span>
              </p>
            ) : null}
            {/* DA-302 visible hint; in the page-only fallback, DA-101a as today (the label names the scope). */}
            <p id={hintId} className={mode === 'page' ? 'sr-only' : 'm-0 text-sm text-quiet'}>
              {mode === 'page' ? 'Searches this page only.' : SEARCH_TEXT.hint(noun)}
            </p>
            {mode === 'page' && pageResult ? <p className="m-0 text-sm text-copy">{pageResultText(noun, pageResult)}</p> : null}
            {/* One polite live region for every change: searching, counts, refusals, clearing. */}
            <p role="status" aria-live="polite" className="sr-only" data-slot="search-announce">
              {announce}
            </p>
          </HandForm>
        ) : null}
        {results ? null : aside}
      </div>

      {mode === 'page' ? (
        <Notice tone="info" role="none">
          {SEARCH_TEXT.notInstalled(noun)}
        </Notice>
      ) : null}
      {view.state === 'refused' ? (
        <Notice tone={view.code === 'not_authorized' ? 'restricted' : 'danger'} role="none">
          {view.code === 'not_authorized' ? SEARCH_TEXT.notAuthorized(noun) : SEARCH_TEXT.failed}
        </Notice>
      ) : null}

      {results ? (
        <section ref={resultsRef} aria-labelledby={headingId} aria-busy={searching || undefined} data-slot="search-results">
          <div className="mb-3 flex flex-col gap-1">
            <h2 id={headingId} className="m-0 text-lg leading-6 font-semibold text-ink">
              {SEARCH_TEXT.resultsHeading}
            </h2>
            {results.rows.length > 0 ? (
              <p className="m-0 text-sm font-semibold wrap-anywhere text-ink" data-slot="search-count">
                {SEARCH_TEXT.found(results.rows.length, results.query, results.nextAfter !== null)}
              </p>
            ) : null}
            <p className="m-0 text-sm text-copy" data-slot="search-filters-note">
              {SEARCH_TEXT.filtersNote(filterActive)}
            </p>
            {/* DA-305 (or its number / "@" variant); with no results the DA-310 text already says it. */}
            {results.titlesSearched || results.rows.length === 0 ? null : (
              <p className="m-0 flex items-start gap-1.5 text-sm text-quiet">
                <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <span>{SEARCH_TEXT.referencesOnly(results.query)}</span>
              </p>
            )}
            {noun === 'deals' && results.rows.length > 0 ? <p className="m-0 text-sm text-quiet">{SEARCH_TEXT.dealsNoServices}</p> : null}
          </div>
          {results.rows.length === 0 ? (
            <Card>
              <EmptyState
                icon={SearchX}
                headingLevel={3}
                title={<span className="wrap-anywhere">{SEARCH_TEXT.noResultsTitle(results.query, noun, results.titlesSearched)}</span>}
                description={SEARCH_TEXT.noResultsBody(results.query, noun, results.titlesSearched)}
              />
            </Card>
          ) : (
            <Card>
              {renderRows(results.rows, SEARCH_TEXT.caption(results.query, noun))}
              {results.nextAfter !== null ? (
                <div className="flex flex-col gap-2 border-t border-line px-4.5 py-3">
                  <HandForm action={runMore} className="flex">
                    <input type="hidden" name={SEARCH_FIELD.query} value={results.query} />
                    <input type="hidden" name={SEARCH_FIELD.kind} value={kind} />
                    <input type="hidden" name={SEARCH_FIELD.after} value={results.nextAfter} />
                    <ShowMoreSubmit noun={noun} />
                  </HandForm>
                  {results.moreFailed ? (
                    <p className="m-0 flex items-start gap-1.5 text-sm font-medium text-status-danger">
                      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                      <span>{SEARCH_TEXT.moreFailed(noun)}</span>
                    </p>
                  ) : null}
                </div>
              ) : null}
            </Card>
          )}
        </section>
      ) : (
        list
      )}
    </div>
  );
}

/** Leads search: every lead the person can see (Batch 5). Results use the Leads list rows. */
export function LeadsServerSearch({ action, ...props }: ServerSearchProps & { action: LeadSearchAction }) {
  return (
    <ServerSearch<LeadListRowModel>
      {...props}
      kind="lead"
      noun="leads"
      action={action}
      renderRows={(rows, caption) => (
        <Table stackOnMobile label="Lead search results" wrapperClassName="rounded-card" id={`${props.tableId}-search`}>
          <TableCaption className="sr-only">{caption}</TableCaption>
          <LeadsTableHeader />
          <TableBody>
            {rows.map((lead) => (
              <LeadListRow key={lead.id} lead={lead} />
            ))}
          </TableBody>
        </Table>
      )}
    />
  );
}

/** Deals search: every deal the person can see (Batch 5). Results use the Deals list rows (no service summary). */
export function DealsServerSearch({ action, ...props }: ServerSearchProps & { action: DealSearchAction }) {
  return (
    <ServerSearch<DealListRowModel>
      {...props}
      kind="deal"
      noun="deals"
      action={action}
      renderRows={(rows, caption) => (
        <Table stackOnMobile label="Deal search results" wrapperClassName="rounded-card" id={`${props.tableId}-search`}>
          <TableCaption className="sr-only">{caption}</TableCaption>
          <DealsTableHeader showServices={false} />
          <TableBody>
            {rows.map((deal) => (
              <DealListRow key={deal.id} deal={deal} />
            ))}
          </TableBody>
        </Table>
      )}
    />
  );
}
