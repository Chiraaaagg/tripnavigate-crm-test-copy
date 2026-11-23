import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn, focusRing } from './cn';

export interface TabItem {
  href: string;
  label: ReactNode;
  /** True for the page being shown (sets aria-current="page"). */
  current?: boolean;
  /**
   * Optional count shown after the label, e.g. waiting items. 'unknown' (the
   * count could not be read) shows a dash read out as "count not known", never 0.
   */
  count?: number | 'unknown';
}

/**
 * Tab looks. 'underline' is the original look (default; every existing caller,
 * including the approved forms, keeps it unchanged). 'pill' is the redesign
 * look of C5 (coss.com Tabs "With Badge", 21st.dev 11646): pill tabs on a grey
 * track with a count badge, the current tab white with a hairline and bold
 * words (never colour alone). Built with classes only: the Base UI trial of
 * build plan 4.2 failed check 1 (Base UI turns the links into role="tab"
 * elements with tabindex="-1" before script runs), so no dependency was added
 * (owner answer Q4).
 */
export type TabsVariant = 'underline' | 'pill';

const PILL_COUNT =
  'inline-flex min-w-5 justify-center rounded-full border border-line bg-card px-1.5 text-xs leading-5 font-medium text-quiet tabular-nums group-aria-[current=page]/tab:bg-wash group-aria-[current=page]/tab:text-ink';
const UNDERLINE_COUNT = 'rounded-full bg-wash px-1.5 text-xs leading-5 font-medium text-quiet tabular-nums';

function TabCount({ count, variant }: { count: TabItem['count']; variant: TabsVariant }) {
  const box = variant === 'pill' ? PILL_COUNT : UNDERLINE_COUNT;
  if (count === 'unknown') {
    return (
      <span className={box}>
        <span aria-hidden="true">–</span>
        <span className="sr-only">, count not known</span>
      </span>
    );
  }
  if (typeof count !== 'number') return null;
  if (variant === 'underline') return <span className={box}>{count}</span>;
  return (
    <span className={box}>
      <span className="sr-only">, </span>
      {count}
    </span>
  );
}

/**
 * Link-based tabs: each tab is a page (or a ?view= URL), so they work without
 * script, keep the browser's back button and need no tab-panel scripting.
 * Semantics are navigation (nav + aria-current), not an ARIA tablist.
 */
export function Tabs({
  label,
  items,
  className,
  variant = 'underline',
}: {
  label: string;
  items: TabItem[];
  className?: string;
  /** Default 'underline' (unchanged). 'pill' = the redesign look (C5). */
  variant?: TabsVariant;
}) {
  if (variant === 'pill') {
    return (
      <nav aria-label={label} className={cn('max-w-full font-sans', className)} data-slot="tabs" data-variant="pill">
        {/* The track wraps onto more rows on narrow screens: every tab stays visible, no sideways scroll. */}
        <ul className="m-0 inline-flex max-w-full list-none flex-wrap gap-1 rounded-control bg-wash p-1">
          {items.map((item) => (
            <li key={item.href} className="m-0 max-w-full min-w-0 shrink-0">
              <Link
                href={item.href}
                aria-current={item.current ? 'page' : undefined}
                className={cn(
                  'group/tab inline-flex min-h-9 max-w-full items-center gap-2 rounded-chip px-3 py-1.5 text-base font-medium text-quiet no-underline',
                  'transition-[color,background-color] duration-(--ui-duration-quick) motion-reduce:transition-none',
                  'hover:bg-card hover:text-ink',
                  'aria-[current=page]:bg-card aria-[current=page]:font-semibold aria-[current=page]:text-ink aria-[current=page]:shadow-[0_1px_2px_rgb(10_10_10/0.08),0_0_0_1px_var(--color-line)]',
                  focusRing,
                  // Drawn just inside the pill so the track never clips it.
                  'focus-visible:-outline-offset-2',
                )}
              >
                {item.label}
                <TabCount count={item.count} variant="pill" />
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    );
  }
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
              <TabCount count={item.count} variant="underline" />
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
