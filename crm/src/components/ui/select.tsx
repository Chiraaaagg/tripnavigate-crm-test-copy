import { ChevronDown } from 'lucide-react';
import type { SelectHTMLAttributes } from 'react';
import { cn } from './cn';
import { controlClass } from './field';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

/**
 * Native <select> (keyboard, screen-reader and mobile pickers for free; no
 * script-rendered style attributes under the Content Security Policy).
 */
export function Select({ className, invalid, children, ...props }: SelectProps) {
  return (
    <div className="relative" data-slot="select">
      <select aria-invalid={invalid || undefined} className={cn(controlClass, 'cursor-pointer pr-9', className)} {...props}>
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-quiet"
      />
    </div>
  );
}
