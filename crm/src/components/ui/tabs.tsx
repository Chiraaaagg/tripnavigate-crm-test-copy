import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn, focusRing } from './cn';

export interface TabItem {
  href: string;
  label: ReactNode;
  /** True for the page being shown (sets aria-current="page"). */
  current?: boolean;
  /** Optional count shown after the label, e.g. waiting items. */
  count?: number;
}

/**
 * Link-based tabs: each tab is a page (or a ?view= URL), so they work without
 * script, keep the browser's back button and need no tab-panel scripting.
 * Semantics are navigation (nav + aria-current), not an ARIA tablist.
 */
export function Tabs({ label, items, className }: { label: string; items: TabItem[]; className?: string }) {
  return (
    <nav aria-label={label} className={cn('font-sans', className)} data-slot="tabs">
      {/* Phones: the tabs wrap onto a second row, so every tab is visible and reachable (no hidden sideways scroll). */}
      <ul className="m-0 flex list-none flex-wrap gap-1 border-b border-line p-0 sm:flex-nowrap sm:overflow-x-auto">
        {items.map((item) => (
          <li key={item.href} className="m-0 shrink-0">
            <Link
              href={item.href}
              aria-current={item.current ? 'page' : undefined}
              className={cn(
                '-mb-px inline-flex min-h-10 items-center gap-2 rounded-t-control border-b-2 border-transparent px-3 py-2 text-base font-medium text-quiet no-underline',
                'transition-[color,background-color,border-color] duration-(--ui-duration-quick) motion-reduce:transition-none',
                'hover:bg-wash hover:text-ink',
                'aria-[current=page]:border-brand-strong aria-[current=page]:font-semibold aria-[current=page]:text-brand-deep',
                focusRing,
                // The tab row scrolls sideways on narrow screens (overflow), which would clip an outer
                // outline: draw the same 2px ring just inside the tab instead.
                'focus-visible:-outline-offset-3',
              )}
            >
              {item.label}
              {typeof item.count === 'number' ? (
                <span className="rounded-full bg-wash px-1.5 text-xs leading-5 font-medium text-quiet tabular-nums">{item.count}</span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
