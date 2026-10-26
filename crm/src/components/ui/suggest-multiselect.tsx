'use client';

import { Plus, X } from 'lucide-react';
import { useId, useState, type CSSProperties } from 'react';
import { cn, focusRing } from './cn';

/*
 * Multi-select with a suggestion list (Book now v2, changes 16 and 17: hotel
 * special requests, flight preferences, passenger special requests). Chosen
 * items are chips (the 21st.dev "Selector Chips" look, preetsuthar17 demo
 * 1963) and the list follows the "Country Combobox" pattern (cnippet-dev
 * v-combobox-10, demo 26105); both restyled to the CRM tokens with no
 * animation library.
 *
 * Behaviour copies the owner-approved prototype: focus or typing opens the
 * list of suggestions not chosen yet; arrow keys move, Enter adds the
 * highlighted item (or the typed text when own values are allowed);
 * Backspace in an empty box removes the last chip; Escape closes the list.
 * The list opens upwards when the drawer footer would hide it. When more than
 * one person is on the service, each chip carries a small "for everyone /
 * for <name>" select.
 */

export interface SuggestOption {
  value: string;
  label: string;
}

export interface SuggestItem {
  value: string;
  /** Person the item is for (a ChipPerson value); null = everyone. */
  forKey: string | null;
}

const BOX_GAP = 8;

export function SuggestMultiSelect({
  id,
  label,
  hint,
  options,
  items,
  onChange,
  people = [],
  allowCustom = true,
  maxItems = 20,
  maxLength = 80,
  disabled = false,
  error,
}: {
  id: string;
  label: string;
  hint?: string;
  options: readonly SuggestOption[];
  items: readonly SuggestItem[];
  onChange: (next: SuggestItem[]) => void;
  /** People on the service: the "for" select shows only when there are two or more. */
  people?: ReadonlyArray<{ value: string; label: string }>;
  /** Staff may type their own item (hotel and flight). Passenger requests are fixed codes (lead ruling D6). */
  allowCustom?: boolean;
  maxItems?: number;
  maxLength?: number;
  disabled?: boolean;
  error?: string | null;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [placement, setPlacement] = useState<CSSProperties>({});
  const boxId = `${id}-box`;
  const focusInput = () => document.getElementById(id)?.focus();
  const listId = useId();
  const labelId = `${id}-label`;
  const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? v;
  const chosen = new Set(items.map((i) => i.value.toLowerCase()));
  const t = query.trim().toLowerCase();
  const res = options.filter((o) => !chosen.has(o.value.toLowerCase()) && o.label.toLowerCase().includes(t));
  const custom = allowCustom && t !== '' && !options.some((o) => o.label.toLowerCase() === t) && !chosen.has(t) ? query.trim().slice(0, maxLength) : '';
  const rows: SuggestOption[] = [...res, ...(custom ? [{ value: custom, label: custom }] : [])];
  const full = items.length >= maxItems;
  const showFor = people.length >= 2;

  const place = () => {
    const box = document.getElementById(boxId);
    const scroller = box?.closest<HTMLElement>('[role="dialog"]');
    if (!box || !scroller) {
      setPlacement({});
      return;
    }
    const b = box.getBoundingClientRect();
    const r = scroller.getBoundingClientRect();
    const footer = scroller.querySelector<HTMLElement>('[data-drawer-footer]');
    const bottom = footer ? footer.getBoundingClientRect().top : r.bottom;
    const below = bottom - b.bottom - BOX_GAP;
    const above = b.top - r.top - BOX_GAP;
    const up = below < 200 && above > below;
    const maxHeight = Math.max(120, Math.min(260, up ? above : below));
    setPlacement(up ? { top: 'auto', bottom: 'calc(100% + 0.25rem)', maxHeight } : { maxHeight });
  };
  const show = () => {
    place();
    setOpen(true);
  };
  const add = (v: string) => {
    const value = v.trim();
    if (!value || full || chosen.has(value.toLowerCase())) return;
    onChange([...items, { value, forKey: null }]);
    setQuery('');
    setActive(0);
    requestAnimationFrame(() => {
      focusInput();
      show();
    });
  };
  const remove = (i: number) => {
    onChange(items.filter((_, j) => j !== i));
    focusInput();
  };
  const optId = (i: number) => `${id}-opt-${i}`;
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-slot="suggest-multiselect">
      <span id={labelId} className="font-semibold text-ink">
        {label} <span className="font-normal text-quiet">(optional)</span>
      </span>
      <div className="relative">
        <div
          id={boxId}
          onClick={(e) => {
            if (!(e.target as HTMLElement).closest('button,select')) focusInput();
          }}
          className={cn(
            'flex min-h-10 cursor-text flex-wrap items-center gap-1.5 rounded-control border border-control bg-card px-2 py-1.25',
            'focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-brand-strong',
            error && 'border-2 border-status-danger',
            disabled && 'cursor-not-allowed bg-wash',
          )}
        >
          <ul className="m-0 flex max-w-full list-none flex-wrap items-center gap-1.5 p-0 empty:hidden" aria-label={`${label}: chosen`}>
            {items.map((it, i) => {
              const text = labelOf(it.value);
              const forValue = showFor && it.forKey && people.some((p) => p.value === it.forKey) ? it.forKey : '';
              return (
                <li key={it.value} className="inline-flex min-h-7 items-center gap-1 rounded-full border border-brand-line bg-brand-tint py-0 pr-1 pl-2.5 text-sm font-medium text-brand-deep">
                  {text}
                  {showFor ? (
                    <select
                      aria-label={`${text} is for`}
                      value={forValue}
                      disabled={disabled}
                      onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, forKey: e.target.value || null } : x)))}
                      className={cn('ml-0.5 max-w-37.5 cursor-pointer border-0 bg-transparent py-0.5 text-xs font-semibold text-brand-deep underline decoration-dotted underline-offset-3', focusRing)}
                    >
                      <option value="">for everyone</option>
                      {people.map((p) => (
                        <option key={p.value} value={p.value}>
                          for {p.label}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <button type="button" disabled={disabled} aria-label={`Remove ${text}`} onClick={() => remove(i)} className={cn('grid size-5.5 cursor-pointer place-items-center rounded-full border-0 bg-transparent text-brand-deep hover:bg-brand-tint-2', focusRing)}>
                    <X aria-hidden="true" className="size-3.25" />
                  </button>
                </li>
              );
            })}
          </ul>
          <input
            id={id}
            role="combobox"
            aria-labelledby={labelId}
            aria-describedby={describedBy}
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && rows[active] ? optId(active) : undefined}
            aria-invalid={error ? true : undefined}
            autoComplete="off"
            disabled={disabled}
            maxLength={maxLength}
            placeholder={items.length ? 'Add more…' : allowCustom ? 'Choose or type…' : 'Choose…'}
            value={query}
            onFocus={show}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              show();
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (!open) show();
                setActive((a) => Math.min(Math.max(rows.length - 1, 0), a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                const o = open ? rows[active] : undefined;
                if (o) add(o.value);
                else if (custom) add(custom);
              } else if (e.key === 'Backspace' && !query && items.length) {
                remove(items.length - 1);
              } else if (e.key === 'Escape' && open) {
                e.stopPropagation();
                setOpen(false);
              }
            }}
            onBlur={() => setTimeout(() => setOpen(false), 120)}
            className="min-w-35 flex-1 border-0 bg-transparent p-1 text-base text-ink shadow-none outline-none placeholder:text-faint focus:shadow-none focus-visible:shadow-none max-sm:text-lg"
          />
        </div>
        <div id={listId} role="listbox" aria-labelledby={labelId} hidden={!open} style={placement} className="absolute top-[calc(100%+0.25rem)] right-0 left-0 z-80 max-h-65 overflow-auto rounded-control border border-line-strong bg-card p-1 shadow-raised">
          {open && full ? <div className="p-2.5 text-sm text-quiet">Up to {maxItems}. Remove one to add another.</div> : null}
          {open && !full && rows.length === 0 ? <div className="p-2.5 text-sm text-quiet">{allowCustom ? 'All suggestions chosen. Type your own.' : 'All of them are chosen.'}</div> : null}
          {open && !full
            ? rows.map((o, i) => {
                const isCustom = custom !== '' && i === rows.length - 1;
                return (
                  <div
                    key={`${isCustom ? 'add-' : ''}${o.value}`}
                    id={optId(i)}
                    role="option"
                    aria-selected={i === active}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      add(o.value);
                    }}
                    onMouseEnter={() => setActive(i)}
                    className={cn('flex cursor-pointer items-center gap-2 rounded-chip px-2.5 py-2 text-copy', i === active && 'bg-brand-tint', isCustom && 'font-semibold text-brand-deep')}
                  >
                    {isCustom ? (
                      <>
                        <Plus aria-hidden="true" className="size-4" /> Add “{o.label}”
                      </>
                    ) : (
                      o.label
                    )}
                  </div>
                );
              })
            : null}
        </div>
      </div>
      {hint ? (
        <p id={`${id}-hint`} className="m-0 text-sm text-quiet">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="m-0 text-sm font-medium text-status-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
