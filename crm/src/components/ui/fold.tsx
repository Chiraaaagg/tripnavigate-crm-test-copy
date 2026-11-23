import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn, focusRing } from './cn';

/*
 * C11: plain fold-out inside pages (owner choice A). A native <details>, so it
 * works without script, the browser's find-in-page opens it, and screen
 * readers announce it as expandable. No height animation (motion rule); the
 * chevron turns instantly. `flat` drops the card frame for a fold inside a
 * card. jumpTo() (jump-links.tsx) opens a closed fold around its target.
 */
export function Fold({
  summary,
  meta,
  open,
  flat = false,
  id,
  className,
  bodyClassName,
  children,
}: {
  /** The always-visible line. Plain words: what is inside ("System details"). */
  summary: ReactNode;
  /** Small text at the right of the summary line, e.g. "3 paid". */
  meta?: ReactNode;
  /** Open on first load. */
  open?: boolean;
  /** No card frame (a fold inside a card): a top hairline only. */
  flat?: boolean;
  id?: string;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <details
      id={id}
      open={open}
      className={cn(
        'group/fold font-sans text-base text-copy',
        flat ? 'border-t border-line' : 'rounded-card border border-line bg-card shadow-card',
        className,
      )}
      data-slot="fold"
    >
      <summary
        className={cn(
          'flex min-h-11 cursor-pointer list-none items-center gap-2.5 px-4.5 py-2.5 text-base font-medium text-ink hover:bg-wash [&::-webkit-details-marker]:hidden',
          flat ? undefined : 'rounded-card group-open/fold:rounded-b-none',
          focusRing,
          'focus-visible:-outline-offset-2',
        )}
      >
        <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-quiet group-open/fold:rotate-90" />
        <span className="min-w-0 flex-1">{summary}</span>
        {meta ? <span className="text-sm font-normal text-quiet">{meta}</span> : null}
      </summary>
      <div className={cn('border-t border-line px-4.5 py-3', bodyClassName)}>{children}</div>
    </details>
  );
}
