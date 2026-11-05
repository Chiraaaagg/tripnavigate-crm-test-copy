'use client';

import { CircleAlert } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { cn, focusRing } from '@/components/ui/cn';
import type { ErrorSummaryVM } from '@/modules/fulfilment/book-flow-contract';
import { useFocusTarget } from './open-parts';
import { orderSummaryItems } from './summary-model';

/*
 * Batch 2 page error summary (P-ERRSUM, catalog gap G7): one per page, shown
 * after "Save and continue", "Save prices" or "Check and mark ready". A
 * heading and a list of links in a fixed order (unsaved parts, the refusal,
 * blocking checks, parts not tried). The box takes focus when it appears
 * (tabIndex -1) and is not an alert, so nothing is read out on page load.
 * Each link opens the part that holds the field, then focuses the field;
 * a link to another step is an ordinary (guarded) link.
 */

export function PageErrorSummary({
  id,
  summary,
  focusKey,
  children,
  tone = 'danger',
  className,
}: {
  id: string;
  summary: ErrorSummaryVM;
  /** Changes every time the summary is shown again (each press), so focus moves to it again. */
  focusKey: number | string;
  /** Extra lines under the title (for example the save report sentence). */
  children?: ReactNode;
  tone?: 'danger' | 'warning';
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const focusTarget = useFocusTarget();
  useEffect(() => {
    ref.current?.focus();
    ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [focusKey]);
  const items = orderSummaryItems(summary.items);
  return (
    <div
      ref={ref}
      id={id}
      tabIndex={-1}
      aria-labelledby={`${id}-title`}
      data-slot="page-error-summary"
      className={cn(
        'flex gap-2.5 rounded-control border-2 px-3.5 py-3 font-sans text-base text-copy outline-none focus-visible:outline-2 focus-visible:outline-offset-2',
        tone === 'danger' ? 'border-status-danger-line bg-status-danger-tint focus-visible:outline-status-danger' : 'border-status-warning-line bg-status-warning-tint focus-visible:outline-status-warning',
        className,
      )}
    >
      <CircleAlert aria-hidden="true" className={cn('mt-0.5 size-4.5 shrink-0', tone === 'danger' ? 'text-status-danger' : 'text-status-warning')} />
      <div className="min-w-0 flex-1">
        <h2 id={`${id}-title`} className="m-0 text-base font-semibold text-ink">
          {summary.title}
        </h2>
        {children}
        {items.length > 0 ? (
          <ul className="m-0 mt-1.5 flex list-disc flex-col gap-1 pl-5">
            {items.map((item, i) => (
              <li key={`${item.kind}-${item.partId}-${i}`}>
                <a
                  href={item.href}
                  onClick={(e) => {
                    if (!item.href.startsWith('#')) return;
                    const target = item.fieldId ?? item.partId;
                    if (focusTarget(target)) {
                      e.preventDefault();
                      window.history.replaceState(null, '', item.href);
                    }
                  }}
                  className={cn('rounded-chip font-medium text-status-danger underline underline-offset-4 hover:text-status-danger-strong', focusRing)}
                >
                  {item.message}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
