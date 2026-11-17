import type { ReactNode } from 'react';
import { cn } from './cn';

/*
 * Grouped fields with a legend and a responsive grid (labels above controls).
 * Idea from 21st.dev grouped fieldsets (cnippet-dev 25063); nothing copied.
 */
export function Fieldset({
  legend,
  description,
  columns = 2,
  actions,
  className,
  children,
}: {
  legend: ReactNode;
  description?: ReactNode;
  /** Grid columns from the sm breakpoint (one column on phones). */
  columns?: 1 | 2 | 3;
  /** Small actions next to the legend, e.g. "Remove traveller". */
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <fieldset className={cn('m-0 min-w-0 rounded-card border border-line bg-card px-4 pt-1 pb-4 font-sans', className)} data-slot="fieldset">
      <legend className="px-1 text-base font-semibold text-ink">{legend}</legend>
      {description || actions ? (
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          {description ? <p className="m-0 text-sm text-quiet">{description}</p> : <span />}
          {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={cn('grid gap-4', columns === 2 && 'sm:grid-cols-2', columns === 3 && 'sm:grid-cols-2 lg:grid-cols-3')}>{children}</div>
    </fieldset>
  );
}
