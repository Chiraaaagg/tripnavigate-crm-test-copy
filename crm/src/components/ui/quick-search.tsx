'use client';

import { Briefcase, Inbox, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { createContext, type KeyboardEvent, type ReactNode, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { DealListRowModel, LeadListRowModel } from '@/modules/deals/list-model';
import {
  type DealSearchResult,
  type LeadSearchResult,
  normaliseSearchQuery,
  SEARCH_FIELD,
  SEARCH_LIMITS,
  searchesTitles,
  searchQueryLength,
} from '@/modules/search/contracts';
import { SEARCH_TEXT } from '@/modules/search/text';
import { Button } from './button';
import { cn, focusRing } from './cn';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog';
import { Input } from './input';
import { Notice } from './notice';

/*
 * C9 quick search (owner choice A: the CRM's search box, shugar Combobox
 * source, in a dialog). Opens from the sidebar find box, the phone top bar
 * search button, or the "/" key (never while the person is typing in a field
 * or while another dialog is open).
 *
 * It uses only the two existing search actions (searchDealsAction,
 * searchLeadsAction, Batch 5): the same rules as the Deals and Leads lists
 * (reference, Bitrix number, customer and trip; never phone or e-mail, D10 is
 * deferred), run under the person's own session, so the database decides
 * every row. The Leads search is passed only to people the Leads page lets
 * in. The words travel only in the actions' POST body, never in an address.
 * Results show the reference, the customer and trip words and the branch:
 * the list rows' own fields, no money.
 *
 * Keyboard: type, arrow keys move through the matches, Enter opens the one
 * marked, Escape closes and focus returns to where it was. The number of
 * matches is announced politely; a failed search is an alert and keeps the
 * typed words.
 */

export type DealSearchAction = (formData: FormData) => Promise<DealSearchResult>;
export type LeadSearchAction = (formData: FormData) => Promise<LeadSearchResult>;

/** The first matches shown per kind; the lists show the rest. */
export const QUICK_SEARCH_SHOWN = 6;
/** Wait after the last key before searching (one search per pause, not per key). */
const DEBOUNCE_MS = 300;

/** True when a key press is typing: in a text field, a select, or editable text. "/" there is a character, not a shortcut. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  const el = target as HTMLElement;
  if (el.isContentEditable) return true;
  return !!el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="combobox"]');
}

/** Whether a key press should open the quick search ("/", no modifier, not typing, no dialog already open). */
export function opensQuickSearch(event: Pick<globalThis.KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing' | 'defaultPrevented' | 'target'>, dialogOpen: boolean): boolean {
  if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.defaultPrevented) return false;
  if (dialogOpen || isTypingTarget(event.target)) return false;
  return true;
}

type Hit = { kind: 'deal'; row: DealListRowModel; href: string } | { kind: 'lead'; row: LeadListRowModel; href: string };

type Outcome =
  | { state: 'idle' }
  | { state: 'short'; query: string }
  | { state: 'searching'; query: string }
  | {
      state: 'done';
      query: string;
      deals: DealListRowModel[];
      leads: LeadListRowModel[];
      moreDeals: boolean;
      moreLeads: boolean;
      titlesSearched: boolean;
      /** Messages of a kind that was not searched (not installed, not allowed). */
      notes: string[];
    }
  | { state: 'error'; query: string };

const QuickSearchContext = createContext<{ open: () => void; label: string } | null>(null);

/**
 * Holds the one quick search dialog of the staff frame and the "/" key.
 * Render it around the frame; put a QuickSearchBox or QuickSearchButton
 * wherever the search should open from. Without a Deals search action it
 * renders its children only (nothing to search with).
 */
export function QuickSearchRoot({
  searchDeals,
  searchLeads,
  defaultOpen = false,
  defaultQuery = '',
  children,
}: {
  searchDeals?: DealSearchAction;
  /** Only for people who may open Leads (the action would refuse anyone else). */
  searchLeads?: LeadSearchAction;
  /** Preview gallery only: open on first load with these words. */
  defaultOpen?: boolean;
  defaultQuery?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const label = searchLeads ? 'Find a Deal or Lead' : 'Find a Deal';
  const ctx = useMemo(() => ({ open: () => setOpen(true), label }), [label]);

  useEffect(() => {
    if (!searchDeals) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const dialogOpen = !!document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]');
      if (!opensQuickSearch(event, dialogOpen)) return;
      event.preventDefault();
      setOpen(true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [searchDeals]);

  if (!searchDeals) return <>{children}</>;
  return (
    <QuickSearchContext.Provider value={ctx}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        {open ? <QuickSearchDialog label={label} searchDeals={searchDeals} searchLeads={searchLeads} defaultQuery={defaultQuery} onDone={() => setOpen(false)} /> : null}
      </Dialog>
    </QuickSearchContext.Provider>
  );
}

/** The sidebar find box: looks like a search field, is a button that opens the dialog. */
export function QuickSearchBox({ className }: { className?: string }) {
  const ctx = useContext(QuickSearchContext);
  if (!ctx) return null;
  return (
    <button
      type="button"
      onClick={ctx.open}
      aria-haspopup="dialog"
      aria-keyshortcuts="/"
      className={cn(
        'flex min-h-10 w-full cursor-pointer items-center gap-2 rounded-control border border-line-strong bg-card px-2.5 py-1.5 text-left font-sans text-sm text-quiet hover:border-control hover:text-ink',
        focusRing,
        className,
      )}
      data-slot="quick-search-box"
    >
      <Search aria-hidden="true" className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{ctx.label}</span>
      <kbd aria-hidden="true" className="rounded-[0.25rem] border border-line-strong bg-wash px-1.5 font-sans text-xs leading-4.5 text-quiet">
        /
      </kbd>
    </button>
  );
}

/** The phone top bar search button (icon, named in words for screen readers). */
export function QuickSearchButton({ className }: { className?: string }) {
  const ctx = useContext(QuickSearchContext);
  if (!ctx) return null;
  return (
    <Button variant="ghost" size="icon" onClick={ctx.open} aria-haspopup="dialog" aria-keyshortcuts="/" aria-label={ctx.label} className={className} data-slot="quick-search-button">
      <Search aria-hidden="true" />
    </Button>
  );
}

function rowText(hit: Hit): { reference: string; title: string; second: string } {
  return { reference: hit.row.reference, title: hit.row.title, second: hit.row.branchName ? `${hit.row.branchName} branch` : '' };
}

function QuickSearchDialog({
  label,
  searchDeals,
  searchLeads,
  defaultQuery,
  onDone,
}: {
  label: string;
  searchDeals: DealSearchAction;
  searchLeads?: LeadSearchAction;
  defaultQuery: string;
  onDone: () => void;
}) {
  const router = useRouter();
  const id = useId();
  const inputId = `${id}-input`;
  const listId = `${id}-list`;
  const hintId = `${id}-hint`;
  const [query, setQuery] = useState(defaultQuery);
  const [outcome, setOutcome] = useState<Outcome>({ state: 'idle' });
  const [active, setActive] = useState(0);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(
    async (raw: string) => {
      const q = normaliseSearchQuery(raw);
      const mine = ++seq.current;
      if (searchQueryLength(q) === 0) {
        setOutcome({ state: 'idle' });
        return;
      }
      if (searchQueryLength(q) < SEARCH_LIMITS.minLength) {
        setOutcome({ state: 'short', query: q });
        return;
      }
      setOutcome({ state: 'searching', query: q });
      const form = () => {
        const data = new FormData();
        data.set(SEARCH_FIELD.query, q);
        return data;
      };
      const [deals, leads] = await Promise.all([
        searchDeals(form()).catch((): null => null),
        searchLeads ? searchLeads(form()).catch((): null => null) : Promise.resolve(undefined),
      ]);
      if (mine !== seq.current) return;
      const unexpected = (r: DealSearchResult | LeadSearchResult | null | undefined) => r === null || (!!r && !r.ok && r.code === 'unexpected');
      if (deals === null || unexpected(deals) || unexpected(leads)) {
        setOutcome({ state: 'error', query: q });
        return;
      }
      const notes = [deals, leads].flatMap((r) => (r && !r.ok && r.code !== 'too_short' ? [r.message] : []));
      setActive(0);
      setOutcome({
        state: 'done',
        query: q,
        deals: deals.ok ? deals.rows : [],
        leads: leads && leads.ok ? leads.rows : [],
        moreDeals: deals.ok && (deals.rows.length > QUICK_SEARCH_SHOWN || deals.nextAfter !== null),
        moreLeads: !!leads && leads.ok && (leads.rows.length > QUICK_SEARCH_SHOWN || leads.nextAfter !== null),
        titlesSearched: deals.ok ? deals.titlesSearched : searchesTitles(q),
        notes,
      });
    },
    [searchDeals, searchLeads],
  );

  // Preview gallery: words given on first load are searched at once.
  useEffect(() => {
    if (defaultQuery) timer.current = setTimeout(() => void run(defaultQuery), 0);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [defaultQuery, run]);

  const hits: Hit[] =
    outcome.state === 'done'
      ? [
          ...outcome.deals.slice(0, QUICK_SEARCH_SHOWN).map((row): Hit => ({ kind: 'deal', row, href: `/app/deals/${row.id}` })),
          ...outcome.leads.slice(0, QUICK_SEARCH_SHOWN).map((row): Hit => ({ kind: 'lead', row, href: `/app/leads/${row.id}` })),
        ]
      : [];
  const optionId = (index: number) => `${id}-option-${index}`;
  const activeIndex = hits.length > 0 ? Math.min(active, hits.length - 1) : -1;

  const go = (hit: Hit | undefined) => {
    if (!hit) return;
    onDone();
    router.push(hit.href);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (hits.length === 0) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = (activeIndex + step + hits.length) % hits.length;
      setActive(next);
      document.getElementById(optionId(next))?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (activeIndex >= 0 && outcome.state === 'done' && outcome.query === normaliseSearchQuery(query)) go(hits[activeIndex]);
      else {
        if (timer.current) clearTimeout(timer.current);
        void run(query);
      }
    }
  };

  const onChange = (value: string) => {
    setQuery(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(value), DEBOUNCE_MS);
  };

  const status =
    outcome.state === 'searching'
      ? 'Searching…'
      : outcome.state === 'done'
        ? hits.length === 0
          ? 'No matches.'
          : `${hits.length === 1 ? '1 match' : `${hits.length} matches`} shown.`
        : '';

  const group = (kind: 'deal' | 'lead', heading: string) => {
    const list = hits.map((hit, index) => ({ hit, index })).filter((x) => x.hit.kind === kind);
    if (list.length === 0) return null;
    const headingId = `${id}-${kind}-heading`;
    return (
      <div role="group" aria-labelledby={headingId}>
        <div id={headingId} role="presentation" className="px-2.5 pt-2 pb-1 text-xs font-semibold text-quiet">
          {heading}
        </div>
        {list.map(({ hit, index }) => {
          const text = rowText(hit);
          const Icon = kind === 'deal' ? Briefcase : Inbox;
          const selected = index === activeIndex;
          return (
            <div
              key={`${kind}-${hit.row.id}`}
              id={optionId(index)}
              role="option"
              aria-selected={selected}
              onClick={() => go(hit)}
              onMouseMove={() => setActive(index)}
              className={cn(
                'flex cursor-pointer items-center gap-2.5 rounded-control px-2.5 py-2',
                selected ? 'bg-brand-tint shadow-[inset_3px_0_0_var(--color-brand-strong)]' : 'hover:bg-wash',
              )}
              data-href={hit.href}
            >
              <Icon aria-hidden="true" className="size-4 shrink-0 text-quiet" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  <span className="font-semibold text-ink tabular-nums">{text.reference}</span> <span className="text-copy">{text.title}</span>
                </span>
                {text.second ? <span className="block truncate text-sm text-quiet">{text.second}</span> : null}
              </span>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <DialogContent
      closeLabel="Close search"
      aria-describedby={hintId}
      className="top-[10dvh] max-h-[80dvh] max-w-xl translate-y-0"
      data-slot="quick-search"
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        document.getElementById(inputId)?.focus();
      }}
    >
      <div className="flex flex-col gap-2 px-5 pt-5 pr-14 pb-2">
        <DialogTitle className="text-lg leading-6">{label}</DialogTitle>
        <DialogDescription id={hintId} className="text-sm">
          By reference, Bitrix number, or customer and trip. Not by phone or e-mail. Arrow keys move, Enter opens.
        </DialogDescription>
      </div>
      <div className="px-5">
        <div className="relative">
          <label htmlFor={inputId} className="sr-only">
            {label}
          </label>
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-quiet" />
          <Input
            id={inputId}
            type="search"
            role="combobox"
            aria-expanded={hits.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            autoComplete="off"
            enterKeyHint="go"
            maxLength={SEARCH_LIMITS.maxLength * 2}
            placeholder={SEARCH_TEXT.placeholder}
            value={query}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={onKeyDown}
            className="pl-9"
          />
        </div>
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {status}
      </p>
      <div className="min-h-16 overflow-y-auto px-5 pt-2 pb-5" data-slot="quick-search-results">
        {outcome.state === 'short' ? <p className="m-0 py-2 text-sm text-quiet">{SEARCH_TEXT.tooShort}</p> : null}
        {outcome.state === 'searching' ? <p className="m-0 py-2 text-sm text-quiet">Searching…</p> : null}
        {outcome.state === 'error' ? (
          <Notice tone="danger" role="alert" title="Search did not finish">
            <p>Nothing was changed. Your words are still in the box, so you can try again.</p>
            <div>
              <Button size="sm" onClick={() => void run(query)}>
                Try again
              </Button>
            </div>
          </Notice>
        ) : null}
        {outcome.state === 'done' ? (
          <>
            {outcome.notes.map((note) => (
              <Notice key={note} tone="info" className="mb-2">
                <p>{note}</p>
              </Notice>
            ))}
            {!outcome.titlesSearched && hits.length > 0 ? <p className="m-0 pb-1 text-sm text-quiet">{SEARCH_TEXT.referencesOnly(outcome.query)}</p> : null}
            {hits.length === 0 ? (
              <div className="py-2" data-slot="quick-search-empty">
                <p className="m-0 font-semibold text-ink">{`Nothing you can see matches “${outcome.query}”.`}</p>
                <p className="m-0 mt-1 text-sm text-quiet">
                  {outcome.titlesSearched
                    ? 'Search checks the reference, Bitrix number and customer and trip only. Check the spelling, or find it in Bitrix.'
                    : `${SEARCH_TEXT.referencesOnly(outcome.query)} Check the reference, or find it in Bitrix.`}
                </p>
              </div>
            ) : null}
          </>
        ) : null}
        <div id={listId} role="listbox" aria-label="Matches" className="empty:hidden">
          {group('deal', 'Deals')}
          {group('lead', 'Leads')}
        </div>
        {outcome.state === 'done' && (outcome.moreDeals || outcome.moreLeads) ? (
          <p className="m-0 mt-2 text-sm text-quiet">
            {outcome.moreDeals && outcome.moreLeads
              ? 'More Deals and Leads match. Search the Deals or Leads list to see all of them.'
              : outcome.moreDeals
                ? 'More Deals match. Search the Deals list to see all of them.'
                : 'More Leads match. Search the Leads list to see all of them.'}
          </p>
        ) : null}
      </div>
    </DialogContent>
  );
}
