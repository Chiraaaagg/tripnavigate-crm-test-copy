'use client';

import { ChevronDown, Search, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { cn, focusRing } from './cn';
import { controlClass } from './field';

/*
 * Compact searchable multi-select (voice-note batch: flight passengers and
 * passenger special requests). Chosen values show as chips with a remove
 * button each; "Choose" opens a panel under the field with a search box and
 * a list of native checkboxes, so keyboard, touch and screen readers use the
 * controls they already know (no aria-activedescendant tricks). Escape or a
 * click outside closes the panel and focus returns to the toggle. The panel
 * sits in the page flow (not a floating layer), so it works inside drawers,
 * at 200% zoom and under the strict style policy.
 * 21st.dev: "Multi Select" (starc007 26775, kuratlielia 35008) seen for chips
 * plus a searchable list; nothing copied (no animation, no overflow count).
 */

export interface MultiSelectOption {
  value: string;
  label: string;
  /** Second line in the list, e.g. "Adult". */
  hint?: string;
}

export interface MultiSelectProps {
  id: string;
  /** Visible label text (rendered by the caller as <label id={`${id}-label`}>) is referenced by the group. */
  labelId: string;
  options: readonly MultiSelectOption[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  /** Toggle text when nothing is chosen, e.g. "Choose passengers". */
  placeholder: string;
  /** Plural noun for counts and the search label, e.g. "passengers". */
  noun: string;
  /** Search box only when the list is longer than this (default 6). */
  searchFrom?: number;
  emptyText?: string;
  invalid?: boolean;
  disabled?: boolean;
  'aria-describedby'?: string;
  /** Only one value may be chosen (a passport applicant). */
  single?: boolean;
}

export function MultiSelect(p: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const panelId = `${p.id}-panel`;
  const listId = useId();
  const chosen = p.options.filter((o) => p.selected.includes(o.value));
  const q = query.trim().toLowerCase();
  const shown = q ? p.options.filter((o) => o.label.toLowerCase().includes(q) || (o.hint ?? '').toLowerCase().includes(q)) : p.options;
  const showSearch = p.options.length > (p.searchFrom ?? 6);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  // Escape closes only this panel. Dialogs and drawers listen for Escape on the document in the
  // capture phase, so the panel answers first, on the window.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || !root.current?.contains(document.activeElement)) return;
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
      setQuery('');
      requestAnimationFrame(() => toggle.current?.focus());
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => (searchRef.current ?? root.current?.querySelector<HTMLInputElement>(`#${CSS.escape(panelId)} input[type=checkbox]`))?.focus());
  }, [open, panelId]);

  const close = () => {
    setOpen(false);
    setQuery('');
    requestAnimationFrame(() => toggle.current?.focus());
  };
  const flip = (value: string) => {
    if (p.single) return p.onChange(p.selected.includes(value) ? [] : [value]);
    p.onChange(p.selected.includes(value) ? p.selected.filter((v) => v !== value) : [...p.selected, value]);
  };

  return (
    <div ref={root} className="flex flex-col gap-2" data-slot="multi-select">
      <div
        role="group"
        aria-labelledby={p.labelId}
        aria-describedby={p['aria-describedby']}
        className={cn(controlClass, 'flex min-h-11 flex-wrap items-center gap-1.5 px-1.5 py-1.5', p.invalid && 'border-2 border-status-danger', p.disabled && 'bg-wash')}
      >
        {chosen.map((o) => (
          <span key={o.value} className="inline-flex max-w-full items-center gap-1 rounded-full bg-brand-tint py-0.5 pr-0.5 pl-2.5 text-sm font-medium text-brand-deep">
            <span className="min-w-0 wrap-anywhere">{o.label}</span>
            {p.disabled ? null : (
              <button
                type="button"
                onClick={() => flip(o.value)}
                aria-label={`Remove ${o.label}`}
                className={cn('grid size-7 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-brand-deep hover:bg-card', focusRing)}
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
            )}
          </span>
        ))}
        <button
          ref={toggle}
          id={p.id}
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          disabled={p.disabled}
          onClick={() => (open ? close() : setOpen(true))}
          className={cn(
            'ml-auto inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-chip border-0 bg-transparent px-2 text-base text-brand-strong hover:bg-wash disabled:cursor-not-allowed disabled:text-quiet',
            focusRing,
          )}
        >
          {chosen.length === 0 ? p.placeholder : 'Change'}
          <span className="sr-only">
            {' '}
            ({chosen.length} of {p.options.length} {p.noun} chosen)
          </span>
          <ChevronDown aria-hidden="true" className={cn('size-4 transition-transform motion-reduce:transition-none', open && 'rotate-180')} />
        </button>
      </div>
      <div id={panelId} hidden={!open} className={cn('rounded-control border border-line-strong bg-card p-2 shadow-raised', !open && 'hidden')}>
        {showSearch ? (
          <div className="relative mb-2">
            <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.75 size-4 -translate-y-1/2 text-quiet" />
            <input
              ref={searchRef}
              type="search"
              aria-label={`Search ${p.noun}`}
              aria-controls={listId}
              autoComplete="off"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  document.getElementById(listId)?.querySelector<HTMLInputElement>('input')?.focus();
                }
              }}
              className={cn(controlClass, 'pl-8.5')}
            />
          </div>
        ) : null}
        <ul id={listId} className="m-0 flex max-h-64 list-none flex-col overflow-auto p-0" aria-label={p.noun}>
          {shown.length === 0 ? <li className="p-2 text-sm text-quiet">{p.emptyText ?? `No ${p.noun} match.`}</li> : null}
          {shown.map((o) => {
            const cid = `${p.id}-opt-${o.value}`;
            return (
              <li key={o.value} className="m-0">
                <label htmlFor={cid} className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-chip px-2 py-1.5 hover:bg-wash has-[:checked]:font-semibold">
                  <input
                    id={cid}
                    type={p.single ? 'radio' : 'checkbox'}
                    name={p.single ? `${p.id}-single` : undefined}
                    checked={p.selected.includes(o.value)}
                    onChange={() => flip(o.value)}
                    className={cn('m-0 size-4 min-h-0 shrink-0 cursor-pointer accent-brand-strong', focusRing)}
                  />
                  <span className="min-w-0 wrap-anywhere text-ink">{o.label}</span>
                  {o.hint ? <span className="ml-auto shrink-0 text-sm font-normal text-quiet">{o.hint}</span> : null}
                </label>
              </li>
            );
          })}
        </ul>
        <div className="mt-[0.25rem] flex justify-end border-t border-line pt-2">
          <button type="button" onClick={close} className={cn('min-h-9 cursor-pointer rounded-chip border-0 bg-transparent px-3 text-sm font-semibold text-brand-strong hover:bg-wash', focusRing)}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
