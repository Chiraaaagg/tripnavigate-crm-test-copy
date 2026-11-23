'use client';

import { useRef, type KeyboardEvent } from 'react';
import { cn, focusRing } from './cn';

/*
 * Segmented control: a radio group of a few options (Book now v2: Bill To
 * Personal / Business, car type, flight "Type the details" / "Attach a
 * screenshot"). Adapted from 21st.dev ddoemonn "Segmented Control" (demo
 * 23552): role="radiogroup" with role="radio" buttons, roving tab index and
 * arrow / Home / End keys. Its sliding animated thumb is left out (no
 * animation library); the chosen option is a white raised segment, as in the
 * owner-approved prototype.
 */

export interface SegmentOption<V extends string> {
  value: V;
  label: string;
}

export function SegmentedControl<V extends string>({
  id,
  label,
  labelledBy,
  options,
  value,
  onChange,
  disabled = false,
  className,
}: {
  id?: string;
  /** Accessible name (aria-label) when no visible label names the group. */
  label?: string;
  labelledBy?: string;
  options: ReadonlyArray<SegmentOption<V>>;
  value: V;
  onChange: (value: V) => void;
  disabled?: boolean;
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const go = (i: number) => {
    const n = options.length;
    const next = ((i % n) + n) % n;
    refs.current[next]?.focus();
    const o = options[next];
    if (o && o.value !== value) onChange(o.value);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (disabled) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      go(i + 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      go(i - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      go(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      go(options.length - 1);
    }
  };
  return (
    <div
      id={id}
      role="radiogroup"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-disabled={disabled || undefined}
      tabIndex={-1}
      data-slot="segmented-control"
      className={cn('inline-flex flex-wrap gap-0.75 rounded-[0.5625rem] border border-line bg-wash p-0.75 outline-none', className)}
    >
      {options.map((o, i) => {
        const on = i === index;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={disabled}
            onClick={() => {
              if (!on) onChange(o.value);
            }}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              'min-h-8 cursor-pointer rounded-chip border-0 bg-transparent px-3 text-sm font-medium text-quiet disabled:cursor-not-allowed',
              'hover:text-ink',
              on && 'bg-card font-semibold text-brand-deep shadow-[0_1px_3px_rgb(0_0_0/0.12)] hover:text-brand-deep',
              focusRing,
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
