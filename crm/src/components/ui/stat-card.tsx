import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from './cn';

/**
 * One number with its label and a plain sentence. Calm: no count-up motion,
 * no colour-only meaning (put the meaning in `note`).
 */
export function StatCard({
  label,
  value,
  note,
  icon: Icon,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  icon?: LucideIcon;
  className?: string;
}) {
  return (
    <div
      className={cn('rounded-card border border-line bg-card px-4.5 py-4 font-sans shadow-card', className)}
      data-slot="stat-card"
    >
      <div className="flex items-center justify-between gap-2 text-sm font-medium text-quiet">
        <span>{label}</span>
        {Icon ? (
          <span className="grid size-7.5 place-items-center rounded-control bg-brand-tint text-brand-strong">
            <Icon aria-hidden="true" className="size-4" />
          </span>
        ) : null}
      </div>
      <p className="m-0 mt-1.5 mb-0.5 text-3xl font-display tracking-display text-ink tabular-nums max-sm:text-2xl">{value}</p>
      {note ? <p className="m-0 text-sm text-quiet">{note}</p> : null}
    </div>
  );
}

/**
 * A row of numbers as a description list (term = label, definition = value),
 * each styled like StatCard. Use when the numbers belong to one heading.
 */
export function StatList({ className, children }: { className?: string; children: ReactNode }) {
  return <dl className={cn('m-0 grid grid-cols-1 gap-3 sm:grid-cols-3 lg:gap-4', className)}>{children}</dl>;
}

export function StatItem({
  label,
  value,
  note,
  icon: Icon,
}: {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <div className="rounded-card border border-line bg-card px-4.5 py-4 font-sans shadow-card" data-slot="stat-item">
      {/* dt and dd must be direct children of this group (div inside dl). */}
      <dt className="flex items-center justify-between gap-2 text-sm font-medium text-quiet">
        <span>{label}</span>
        {Icon ? (
          <span aria-hidden="true" className="grid size-7.5 place-items-center rounded-control bg-brand-tint text-brand-strong">
            <Icon className="size-4" />
          </span>
        ) : null}
      </dt>
      <dd className="m-0 mt-1.5 text-3xl font-display tracking-display text-ink tabular-nums max-sm:text-2xl">{value}</dd>
      {note ? <dd className="m-0 mt-0.5 text-sm text-quiet">{note}</dd> : null}
    </div>
  );
}
