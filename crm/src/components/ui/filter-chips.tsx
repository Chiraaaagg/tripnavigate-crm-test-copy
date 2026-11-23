import { Check } from 'lucide-react';
import Link from 'next/link';
import type { ListFiltersVM } from '@/modules/deals/workspace-contract';
import { cn, focusRing } from './cn';

/*
 * Filter chips for a list (P-LIST): each chip is a link to the same list with
 * that server filter, so it works without script and keeps the back button.
 * The count is exact over every record the viewer can see (not this page);
 * a count that could not be read says so in words, never "0". The current
 * chip carries aria-current and a check icon, so it never relies on colour.
 * The scope sentence sits on the same row in small text (DA-132). `srSuffix`
 * adds screen-reader-only words to a chip (", owned by someone else").
 * Composition of design-system links (catalog gap, register §10.3).
 */
export function FilterChips<F extends string>({
  filters,
  label,
  srSuffix,
  className,
}: {
  filters: ListFiltersVM<F>;
  label: string;
  srSuffix?: Partial<Record<F, string>>;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5 font-sans', className)} data-slot="filter-chips">
      <nav aria-label={label}>
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          {filters.chips.map((chip) => (
            <li key={chip.filter} className="m-0">
              <Link
                href={chip.href}
                aria-current={chip.current ? 'page' : undefined}
                className={cn(
                  'inline-flex min-h-9 items-center gap-1.5 rounded-control border px-3 py-1 text-sm font-medium no-underline',
                  'transition-[color,background-color,border-color] duration-(--ui-duration-quick) motion-reduce:transition-none',
                  chip.current
                    ? 'border-brand-strong bg-brand-strong text-white hover:bg-brand-deep hover:text-white'
                    : 'border-line-strong bg-card text-ink hover:bg-wash hover:text-ink',
                  focusRing,
                )}
              >
                {chip.current ? <Check aria-hidden="true" className="size-3.5 shrink-0" /> : null}
                <span>
                  {chip.label}
                  {srSuffix?.[chip.filter] ? <span className="sr-only">{srSuffix[chip.filter]}</span> : null}
                </span>
                {chip.count === null ? (
                  <span className={cn('text-xs font-normal', chip.current ? 'text-white' : 'text-quiet')}>(count unavailable)</span>
                ) : (
                  <span className={cn('font-semibold tabular-nums', chip.current ? 'text-white' : 'text-brand-strong')}>({chip.count})</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <p className="m-0 text-xs text-quiet">{filters.scopeText}</p>
    </div>
  );
}
