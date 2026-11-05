'use client';

import { Check } from 'lucide-react';
import { cn, focusRing } from './cn';

/*
 * Traveller chips: who is on a service (Book now v2, change 6). Adapted from
 * 21st.dev preetsuthar17 "Selector Chips" (demo 1963): toggle chips with a
 * tick, restyled to the CRM tokens, without its animation library. "All N"
 * chooses or clears everyone; each chip is a toggle button (aria-pressed),
 * and the line under the chips says how many are chosen in words.
 */

export interface ChipPerson {
  /** Stable value (the traveller seq as text). */
  value: string;
  label: string;
}

export const travellerChipClass = cn(
  'inline-flex min-h-8.5 cursor-pointer items-center gap-1.5 rounded-full border border-line-strong bg-card px-3 text-sm font-medium text-copy',
  'hover:border-quiet disabled:cursor-not-allowed disabled:opacity-60',
  'aria-pressed:border-brand-line aria-pressed:bg-brand-tint aria-pressed:text-brand-deep',
  focusRing,
);

export function TravellerChips({
  id,
  label,
  people,
  selected,
  onChange,
  disabled = false,
  single = false,
  emptyText = 'Name the passengers in step 1 to choose them here.',
  note,
  error,
}: {
  id: string;
  label: string;
  people: readonly ChipPerson[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** One person at most (passport applicant): no "All" chip. */
  single?: boolean;
  /** Shown instead of the chips when nobody can be chosen yet. */
  emptyText?: string;
  /** A quiet line after the count (for example travellers not named yet). */
  note?: string | null;
  error?: string | null;
}) {
  const labelId = `${id}-label`;
  if (people.length === 0) {
    return (
      <div className="flex flex-col gap-1.5" data-slot="traveller-chips">
        <span id={labelId} className="font-semibold text-ink">
          {label}
        </span>
        <p id={id} tabIndex={-1} className="m-0 text-sm text-quiet outline-none">
          {emptyText}
        </p>
        {note ? <p className="m-0 text-sm text-quiet">{note}</p> : null}
        {error ? (
          <p id={`${id}-error`} className="m-0 text-sm font-medium text-status-danger">
            {error}
          </p>
        ) : null}
      </div>
    );
  }
  const chosen = new Set(selected);
  const all = people.every((p) => chosen.has(p.value));
  const toggle = (v: string) => {
    if (single) onChange(chosen.has(v) ? [] : [v]);
    else onChange(chosen.has(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  };
  const count = people.filter((p) => chosen.has(p.value)).length;
  return (
    <div className="flex flex-col gap-1.5" data-slot="traveller-chips">
      <span id={labelId} className="font-semibold text-ink">
        {label}
      </span>
      <div id={id} role="group" aria-labelledby={labelId} aria-describedby={[`${id}-line`, error ? `${id}-error` : null].filter(Boolean).join(' ')} tabIndex={-1} className="flex flex-wrap gap-2 outline-none">
        {single ? null : (
          <button type="button" aria-pressed={all} disabled={disabled} onClick={() => onChange(all ? [] : people.map((p) => p.value))} className={cn(travellerChipClass, 'font-semibold')}>
            {all ? <Check aria-hidden="true" className="size-3.5" /> : null}
            All {people.length}
          </button>
        )}
        {people.map((p) => {
          const on = chosen.has(p.value);
          return (
            <button key={p.value} type="button" aria-pressed={on} disabled={disabled} onClick={() => toggle(p.value)} className={travellerChipClass}>
              {on ? <Check aria-hidden="true" className="size-3.5" /> : null}
              {p.label}
            </button>
          );
        })}
      </div>
      <p id={`${id}-line`} className="m-0 mt-0.5 text-sm text-quiet" aria-live="polite">
        {count} of {people.length} chosen
        {note ? <span className="block">{note}</span> : null}
      </p>
      {error ? (
        <p id={`${id}-error`} className="m-0 text-sm font-medium text-status-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
