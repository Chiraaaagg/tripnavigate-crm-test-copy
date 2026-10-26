import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import type { ListPagerVM } from '@/modules/deals/workspace-contract';
import { buttonVariants } from './button';
import { cn } from './cn';

/** "1–25 of 107 deals", or "1–25 (total not known)" when the total could not be counted (never a made-up number). */
export function pagerRangeText(pager: ListPagerVM, noun: string): string {
  if (pager.from === 0) return pager.total === null || pager.total === 0 ? `No ${noun} on this page` : `No ${noun} on this page (${pager.total} in total)`;
  const range = `${pager.from}–${pager.to}`;
  return pager.total === null ? `${range} of the ${noun} you can see (total not known)` : `${range} of ${pager.total} ${noun}`;
}

/**
 * True pager (P-LIST, DL-07, DL-08): range text plus "Previous page" and
 * "Next page" links that keep the list's filter and order. Links only where
 * they lead somewhere; the range alone when everything fits on one page.
 */
export function ListPager({ pager, noun, label, className }: { pager: ListPagerVM; noun: string; label: string; className?: string }) {
  // 44 px touch targets on phones (Echo M9); compact on wider screens.
  const button = cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'max-sm:h-11 max-sm:px-3.5');
  return (
    <nav aria-label={label} className={cn('flex flex-wrap items-center justify-between gap-3 border-t border-line px-4.5 py-3 font-sans', className)} data-slot="list-pager">
      {pager.previousHref ? (
        <Link href={pager.previousHref} rel="prev" className={button}>
          <ChevronLeft aria-hidden="true" />
          Previous page
        </Link>
      ) : (
        <span aria-hidden="true" />
      )}
      <span className="text-sm text-quiet tabular-nums">{pagerRangeText(pager, noun)}</span>
      {pager.nextHref ? (
        <Link href={pager.nextHref} rel="next" className={button}>
          Next page
          <ChevronRight aria-hidden="true" />
        </Link>
      ) : (
        <span aria-hidden="true" />
      )}
    </nav>
  );
}
