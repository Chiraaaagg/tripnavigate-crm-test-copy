import type { ReactNode } from 'react';
import { cn } from './cn';

/**
 * Top of a screen: title, one line of context, status and owner near the top,
 * and the screen's ONE primary action (plus optional secondary ones).
 */
export function PageHeader({
  title,
  description,
  eyebrow,
  status,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Small label above the title, e.g. the record reference. */
  eyebrow?: ReactNode;
  /** Status pill(s) and owner, shown under the title. */
  status?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn('mb-5 flex flex-col gap-4 font-sans sm:flex-row sm:items-end sm:justify-between', className)}
      data-slot="page-header"
    >
      <div className="min-w-0">
        {eyebrow ? <p className="m-0 mb-1 text-sm font-medium text-quiet">{eyebrow}</p> : null}
        <h1 className="m-0 text-2xl leading-tight font-display tracking-heading text-ink max-sm:text-xl">{title}</h1>
        {description ? <p className="m-0 mt-1.5 text-base text-quiet">{description}</p> : null}
        {status ? <div className="mt-2.5 flex flex-wrap items-center gap-2 text-sm text-quiet">{status}</div> : null}
      </div>
      {actions ? (
        <div className="flex min-w-min flex-wrap items-center gap-2 max-sm:[&>*]:flex-1">{actions}</div>
      ) : null}
    </header>
  );
}
