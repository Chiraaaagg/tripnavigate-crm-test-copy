import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

/*
 * Key–value summary with dividers and an optional bold total row. Idea from
 * 21st.dev order summaries (sean0205 29356; astralyxdev 36084 shows unknown
 * charges as "not known yet" instead of a false zero); nothing copied.
 * Unknown values must use <NotEntered /> rather than ₹0.
 */

export function SummaryList({ className, ...props }: HTMLAttributes<HTMLDListElement>) {
  return <dl className={cn('m-0 flex flex-col divide-y divide-line font-sans', className)} data-slot="summary-list" {...props} />;
}

export function SummaryRow({
  label,
  children,
  total = false,
  numeric = false,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  /** The total row: bold, with a stronger top border. */
  total?: boolean;
  /** Right-align and use tabular figures (amounts). */
  numeric?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-1 gap-0.5 py-2.5 first:pt-0 last:pb-0 sm:grid-cols-[minmax(10rem,40%)_1fr] sm:gap-4',
        total && 'border-t-2 border-line-strong',
        className,
      )}
    >
      <dt className={cn('text-sm font-medium text-quiet', total && 'font-semibold text-ink')}>{label}</dt>
      <dd className={cn('m-0 wrap-break-word text-ink', numeric && 'tabular-nums sm:text-right', total && 'text-lg font-semibold')}>{children}</dd>
    </div>
  );
}

/** Honest placeholder for a value nobody has entered yet. */
export function NotEntered({ children = 'Not entered yet' }: { children?: ReactNode }) {
  return <span className="font-normal text-quiet italic">{children}</span>;
}
