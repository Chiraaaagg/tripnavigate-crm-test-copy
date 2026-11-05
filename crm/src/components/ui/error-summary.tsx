'use client';

import { CircleAlert } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { cn, focusRing } from './cn';

export interface ErrorSummaryItem {
  /** id of the field to jump to (without "#"). */
  fieldId: string;
  text: ReactNode;
}

/**
 * "Check these fields" box shown at the top of a form after a refusal. It is
 * an alert, takes focus once when it appears (so keyboard and screen-reader
 * users land on it), and each line links to its field. The message says what
 * happened and whether anything was saved; the typed values stay in the form.
 */
export function ErrorSummary({
  title,
  description,
  items = [],
  focusOnMount = true,
  className,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  items?: ErrorSummaryItem[];
  focusOnMount?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusOnMount) ref.current?.focus();
  }, [focusOnMount]);
  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      className={cn(
        'flex gap-2.5 rounded-control border-2 border-status-danger-line bg-status-danger-tint px-3.5 py-3 font-sans text-base text-copy outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-status-danger',
        className,
      )}
      data-slot="error-summary"
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4.5 shrink-0 text-status-danger" />
      <div className="min-w-0 flex-1">
        <p className="m-0 font-semibold text-ink">{title}</p>
        {description ? <p className="m-0 mt-0.75">{description}</p> : null}
        {items.length > 0 ? (
          <ul className="m-0 mt-1.5 flex list-disc flex-col gap-1 pl-5">
            {items.map((item) => (
              <li key={item.fieldId}>
                <a
                  href={`#${item.fieldId}`}
                  className={cn('rounded-chip font-medium text-status-danger underline underline-offset-4 hover:text-status-danger-strong', focusRing)}
                >
                  {item.text}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
        {children}
      </div>
    </div>
  );
}
