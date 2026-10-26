import type { InputHTMLAttributes, ReactNode } from 'react';
import { cn, focusRing } from './cn';

/**
 * A checkbox shown as a chip (who takes part in a service). The native
 * checkbox stays visible inside its label, so keyboard, screen readers and
 * forms work as usual and the focus ring sits on the box itself; the tick and
 * the bold text show the state, not colour alone.
 */
export function ChipCheck({ id, label, className, checked, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { id: string; label: ReactNode }) {
  return (
    <label
      htmlFor={id}
      className={cn(
        'inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 font-sans text-sm text-copy',
        'has-[:checked]:border-brand-strong has-[:checked]:bg-brand-tint has-[:checked]:font-semibold has-[:checked]:text-brand-deep',
        'border-control bg-card hover:border-quiet has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-70',
        className,
      )}
      data-slot="chip-check"
    >
      <input id={id} type="checkbox" checked={checked} className={cn('m-0 size-4 min-h-0 shrink-0 cursor-pointer accent-brand-strong', focusRing)} {...props} />
      <span className="min-w-0 wrap-anywhere">{label}</span>
    </label>
  );
}
