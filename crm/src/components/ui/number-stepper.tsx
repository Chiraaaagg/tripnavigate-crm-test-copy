'use client';

import { Minus, Plus } from 'lucide-react';
import { useState } from 'react';
import { cn, focusRing } from './cn';
import { controlClass } from './field';

/*
 * Whole-number field with visible − and + buttons (voice-note batch, owner
 * item 6: "make the arrows visible"). The number input stays a native
 * spinbutton (arrow keys, typing, screen readers announce the value); the
 * buttons are ordinary buttons with words for screen readers, 44 px for
 * touch, and stop at the limits. The form posts the input as before.
 * 21st.dev: "Quantity Stepper" (arihantcodes 29940) seen for the layout of
 * buttons either side of the value; nothing copied (no animation, no
 * press-and-hold).
 */

export interface NumberStepperProps {
  id: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  min: number;
  max: number;
  /** What one unit is, for the button names: "vehicle" gives "Fewer vehicles" / "More vehicles". */
  unitLabel: { decrease: string; increase: string };
  invalid?: boolean;
  disabled?: boolean;
  'aria-describedby'?: string;
  /** Visible label is a <label htmlFor={id}> outside; or name the input here. */
  'aria-label'?: string;
  form?: string;
  className?: string;
  /** Shown in an empty box (for example a worked-out value). */
  placeholder?: string;
  /** Where − and + start from while the box is empty (default: the limits). */
  emptyBase?: number | null;
  /** Words before the value in the spoken status after − or +, e.g. "Number of vehicles: ". */
  statusLabel?: string;
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

export function NumberStepper(p: NumberStepperProps) {
  const n = /^\d+$/.test(p.value.trim()) ? Number(p.value.trim()) : null;
  // Echo-B L1: focus stays on − or +, so the new value is said in a polite status.
  const [said, setSaid] = useState('');
  const step = (d: number) => {
    const base = n === null ? (p.emptyBase ?? (d > 0 ? p.min - 1 : p.min + 1)) : n;
    const next = clamp(base + d, p.min, p.max);
    p.onChange(String(next));
    setSaid(`${p.statusLabel ?? ''}${next}`);
  };
  const btn = cn(
    'grid size-11 shrink-0 cursor-pointer place-items-center rounded-control border border-control bg-card p-0 text-ink',
    'hover:border-quiet hover:bg-wash disabled:cursor-not-allowed disabled:opacity-55',
    focusRing,
  );
  return (
    <div className={cn('flex items-center gap-1.5', p.className)} data-slot="number-stepper">
      <button type="button" className={btn} aria-label={p.unitLabel.decrease} aria-controls={p.id} disabled={p.disabled || (n !== null && n <= p.min)} onClick={() => step(-1)}>
        <Minus aria-hidden="true" className="size-4" />
      </button>
      <input
        id={p.id}
        name={p.name}
        type="number"
        inputMode="numeric"
        min={p.min}
        max={p.max}
        step={1}
        value={p.value}
        onChange={(e) => p.onChange(e.target.value)}
        aria-invalid={p.invalid || undefined}
        aria-describedby={p['aria-describedby']}
        aria-label={p['aria-label']}
        placeholder={p.placeholder}
        disabled={p.disabled}
        form={p.form}
        className={cn(controlClass, 'w-16 min-h-11 px-1 text-center tabular-nums [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none')}
      />
      <button type="button" className={btn} aria-label={p.unitLabel.increase} aria-controls={p.id} disabled={p.disabled || (n !== null && n >= p.max)} onClick={() => step(1)}>
        <Plus aria-hidden="true" className="size-4" />
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {said}
      </span>
    </div>
  );
}
