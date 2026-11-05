'use client';

import { LoaderCircle, Search } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from './cn';
import { controlClass } from './field';

/*
 * Type-ahead search over stored records (voice-note batch: hotel names, Bill To
 * customers). ARIA 1.2 combobox: the text box keeps focus, Up/Down move
 * through the results (aria-activedescendant), Enter picks, Escape closes.
 * Results come from a server search after `minQuery` characters and a short
 * pause; the list never shows everything. The list sits under the field in
 * the page flow (absolute inside a relative box, classes only), so it works
 * in drawers and dialogs under the strict style policy. The typed text stays
 * the field's value (a hotel not in the list can still be typed).
 * 21st.dev: "Combobox" (shugar 4032 "filters large lists", coss.com 11404)
 * seen for the input-plus-list layout; nothing copied.
 */

export type ComboResult<T> = { ok: true; items: T[]; more: boolean } | { ok: false; message: string };

export interface SearchComboboxProps<T> {
  id: string;
  /** The input's form name (omit for a search-only box). */
  name?: string;
  value: string;
  onValueChange: (text: string) => void;
  search: (query: string) => Promise<ComboResult<T>>;
  keyOf: (item: T) => string;
  /** Plain text of an option (for screen readers when highlighted). */
  textOf: (item: T) => string;
  renderOption: (item: T) => ReactNode;
  onPick: (item: T) => void;
  minQuery?: number;
  placeholder?: string;
  /** Shown when the search found nothing (e.g. an "Add customer" hint). */
  noMatchText?: string;
  /** Under the results, e.g. an "Add customer" button. */
  footer?: ReactNode;
  invalid?: boolean;
  disabled?: boolean;
  maxLength?: number;
  'aria-describedby'?: string;
  /** Leading search icon (search-only boxes). */
  searchIcon?: boolean;
}

export function SearchCombobox<T>(p: SearchComboboxProps<T>) {
  const minQuery = p.minQuery ?? 2;
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<T[]>([]);
  const [more, setMore] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const [asked, setAsked] = useState('');
  const seq = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const { search } = p;
  const q = p.value.trim();

  useEffect(() => {
    if (!open || q.length < minQuery) return;
    const mine = ++seq.current;
    const t = setTimeout(() => {
      setBusy(true);
      search(q)
        .then((r) => {
          if (mine !== seq.current) return;
          if (r.ok) {
            setItems(r.items);
            setMore(r.more);
            setProblem(null);
          } else {
            setItems([]);
            setMore(false);
            setProblem(r.message);
          }
          setAsked(q);
          setActive(-1);
        })
        .catch(() => {
          // Echo-B M2: a failed search is an answer too, so the list says what happened (never "Searching…" forever).
          if (mine !== seq.current) return;
          setItems([]);
          setMore(false);
          setProblem('Search did not work. Try again, or type the details.');
          setAsked(q);
          setActive(-1);
        })
        .finally(() => {
          if (mine === seq.current) setBusy(false);
        });
    }, 250);
    return () => clearTimeout(t);
  }, [q, open, minQuery, search]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const searching = open && q.length >= minQuery;
  // Echo-B L2: with a footer action ("Add customer") the panel opens on focus, before any typing.
  const showList = searching || (open && Boolean(p.footer));
  // Escape closes only the list. Dialogs and drawers listen for Escape on the document in the
  // capture phase, so the list answers first, on the window.
  useEffect(() => {
    if (!showList) return;
    const onEsc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || !root.current?.contains(document.activeElement)) return;
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
    };
    window.addEventListener('keydown', onEsc, true);
    return () => window.removeEventListener('keydown', onEsc, true);
  }, [showList]);
  const ready = searching && asked === q && !busy;
  const pick = (item: T) => {
    p.onPick(item);
    setOpen(false);
    setActive(-1);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(-1, a - 1));
    } else if (e.key === 'Enter' && showList && active >= 0 && items[active]) {
      e.preventDefault();
      pick(items[active]);
    }
  };
  const optionId = (i: number) => `${listId}-o${i}`;
  const status = !searching ? '' : busy || asked !== q ? 'Searching…' : problem ? problem : items.length === 0 ? (p.noMatchText ?? 'No match.') : `${items.length}${more ? '+' : ''} found. Use the arrow keys to choose.`;

  return (
    <div ref={root} className="relative" data-slot="search-combobox">
      <div className="relative">
        {p.searchIcon ? <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.75 size-4 -translate-y-1/2 text-quiet" /> : null}
        <input
          id={p.id}
          name={p.name}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={showList && active >= 0 ? optionId(active) : undefined}
          aria-invalid={p.invalid || undefined}
          aria-describedby={p['aria-describedby']}
          autoComplete="off"
          placeholder={p.placeholder}
          maxLength={p.maxLength}
          disabled={p.disabled}
          value={p.value}
          onChange={(e) => {
            p.onValueChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          className={cn(controlClass, p.searchIcon && 'pl-8.5', 'pr-9')}
        />
        {busy ? <LoaderCircle aria-hidden="true" className="absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-ui-spin text-quiet motion-reduce:animate-none" /> : null}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
      <div hidden={!showList} className={cn('absolute inset-x-0 top-full z-30 mt-[0.25rem] overflow-hidden rounded-control border border-line-strong bg-card shadow-raised', !showList && 'hidden')}>
        <ul id={listId} role="listbox" aria-label="Matches" className="m-0 max-h-64 list-none overflow-auto p-1">
          {ready
            ? items.map((item, i) => (
                <li
                  key={p.keyOf(item)}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === active}
                  aria-label={p.textOf(item)}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => pick(item)}
                  onPointerMove={() => setActive(i)}
                  className={cn('m-0 flex min-h-11 cursor-pointer flex-col justify-center gap-0.5 rounded-chip px-2.5 py-1.5 wrap-anywhere', i === active ? 'bg-brand-tint outline-2 -outline-offset-2 outline-brand-strong' : 'hover:bg-wash')}
                >
                  {p.renderOption(item)}
                </li>
              ))
            : null}
        </ul>
        {!searching ? <p className="m-0 px-3 py-2.5 text-sm text-quiet">Type {minQuery} letters to search.</p> : !ready ? <p className="m-0 px-3 py-2.5 text-sm text-quiet">Searching…</p> : null}
        {ready && problem ? <p className="m-0 px-3 py-2.5 text-sm font-medium text-status-danger">{problem}</p> : null}
        {ready && !problem && items.length === 0 ? <p className="m-0 px-3 py-2.5 text-sm text-quiet">{p.noMatchText ?? 'No match.'}</p> : null}
        {ready && more ? <p className="m-0 border-t border-line px-3 py-2 text-sm text-quiet">More found. Type more to narrow the list.</p> : null}
        {p.footer ? <div className="border-t border-line p-1">{p.footer}</div> : null}
      </div>
    </div>
  );
}
