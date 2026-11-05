'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { airportLabel, findAirport, loadAirports, searchAirports, type Airport } from '@/lib/airports/search';
import { cn } from './cn';
import { controlClass } from './field';

/*
 * Airport search box (Book now v2, change 3). Adapted from 21st.dev
 * cnippet-dev "Country Combobox" (v-combobox-10, demo 26105): a typed search,
 * an empty-state line and a scrolling list. Its Base UI dependency is not in
 * the lockfile, so this is a plain ARIA combobox (role="combobox" input,
 * role="listbox" list, aria-activedescendant), restyled to the CRM tokens.
 *
 * Behaviour copies the owner-approved prototype: typing a city, an airport
 * name, a 3-letter code or "Jodhpur (JDH)" finds the airport; arrow keys move,
 * Enter picks; leaving the box with exactly one match picks it, otherwise the
 * hint asks to pick from the list and keeps the typed text. The value is the
 * IATA code. A stored place name from before this release (for example
 * "Delhi") shows as it is and stays the value until it is changed.
 */

const ERROR_TEXT = 'Pick an airport from the list, e.g. DEL. What you typed is still here.';
const HINT_TEXT = 'Type a city, airport name or 3-letter code.';

export function AirportCombobox({
  id,
  label,
  name,
  value,
  onChange,
  error,
  disabled = false,
}: {
  id: string;
  label: string;
  /** Form input name of the value (the code). */
  name?: string;
  /** IATA code, a stored place name, or '' (nothing picked). */
  value: string;
  onChange: (value: string) => void;
  /** A refusal or local check about this field. */
  error?: string | null;
  disabled?: boolean;
}) {
  const [list, setList] = useState<Airport[] | null>(null);
  useEffect(() => {
    let live = true;
    void loadAirports().then((l) => {
      if (live) setList(l);
    });
    return () => {
      live = false;
    };
  }, []);
  const picked = list ? findAirport(list, value) : null;
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (picked ? airportLabel(picked) : value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [blurError, setBlurError] = useState(false);
  const results = list && text !== null ? searchAirports(list, text) : [];
  const listId = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const pick = (a: Airport) => {
    setText(null);
    setOpen(false);
    setBlurError(false);
    onChange(a.c);
  };
  const shownError = error ?? (blurError ? ERROR_TEXT : null);
  const hint = picked ? picked.name : HINT_TEXT;
  const optId = (i: number) => `${id}-opt-${i}`;
  return (
    <div className="relative flex min-w-0 flex-col gap-1.5" data-slot="airport-combobox">
      <label htmlFor={id} className="block text-base font-semibold text-ink">
        {label}
      </label>
      <div className="relative">
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && results[active] ? optId(active) : undefined}
        aria-invalid={shownError ? true : undefined}
        aria-describedby={`${id}-hint`}
        autoComplete="off"
        placeholder="City or code, e.g. Delhi or DEL"
        maxLength={60}
        disabled={disabled}
        value={shown}
        className={controlClass}
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
          setOpen(e.target.value.trim() !== '');
          setBlurError(false);
          if (value) onChange('');
        }}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(Math.max(results.length - 1, 0), a + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === 'Enter') {
            // Never submits the drawer; picks the highlighted airport.
            e.preventDefault();
            const a = results[active];
            if (a) pick(a);
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        onBlur={() => {
          timer.current = setTimeout(() => {
            setOpen(false);
            if (text === null || !text.trim() || !list) return;
            const r = searchAirports(list, text);
            if (r.length === 1) pick(r[0]!);
            else setBlurError(true);
          }, 120);
        }}
      />
      <div
        id={listId}
        role="listbox"
        aria-label={`${label} airports`}
        hidden={!open}
        className="absolute top-[calc(100%+0.25rem)] right-0 left-0 z-80 max-h-65 overflow-auto rounded-control border border-line-strong bg-card p-1 shadow-raised"
      >
        {open && results.length === 0 ? <div className="p-2.5 text-sm text-quiet">{list ? 'No airport found. Try the city name or the 3-letter code.' : 'Loading airports…'}</div> : null}
        {open
          ? results.map((a, i) => (
              <div
                key={a.c}
                id={optId(i)}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(a);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn('flex cursor-pointer items-baseline gap-2.5 rounded-chip px-2.5 py-2', i === active && 'bg-brand-tint')}
              >
                <span className="w-9.5 shrink-0 font-bold text-brand-deep">{a.c}</span>
                <span className="min-w-0 text-copy">
                  {a.city}
                  <small className="block text-sm text-quiet">{a.name}</small>
                </span>
              </div>
            ))
          : null}
      </div>
      </div>
      {name ? <input type="hidden" name={name} value={value} /> : null}
      <p id={`${id}-hint`} className={cn('m-0 text-sm', shownError ? 'flex gap-1.5 font-medium text-status-danger' : 'text-quiet')} aria-live="polite">
        {shownError ?? hint}
      </p>
    </div>
  );
}
