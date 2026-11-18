'use client';

import { ArrowRight, Check, ChevronDown, Search } from 'lucide-react';
import Form from 'next/form';
import Link from 'next/link';
import { useEffect, useId, useRef, type ChangeEvent } from 'react';
import { Button, buttonVariants } from './button';
import { cn, focusRing } from './cn';
import { controlClass } from './field';
import { Select } from './select';

/*
 * C2: the work-list toolbar (owner choice A: the CRM table and filter chips
 * with the toolbar layout of olewandowski1 Search Toolbar Page Header 26793,
 * pattern only). One row on wide screens: search, filter chips, sort.
 *
 * It is a GET form to the page's own address (next/form: client-side
 * navigation with script, a normal page load without). The search submits on
 * Enter or the arrow button; the sort submits when changed (with script) or
 * with its "Sort" button (always). Chips are plain links. The first four chips
 * show; the rest sit under "More" (the current chip always shows). `keep`
 * carries the address values the page already uses (for example the chip's
 * filter) so a search does not lose them; a page number is never kept.
 *
 * On a list the server pages, give only the search, chips and sort the
 * server already offers (build plan F7).
 */

export interface QueueChip {
  href: string;
  label: string;
  /** Number of rows behind the chip; 'unknown' says so in words, never 0. */
  count?: number | 'unknown';
  current?: boolean;
}

export interface QueueToolbarProps {
  /** The page address the form submits to, e.g. "/app/purchase". */
  action: string;
  search?: { name: string; value?: string; placeholder?: string; label: string };
  chips?: QueueChip[];
  sort?: { name: string; value?: string; label?: string; options: { value: string; label: string }[] };
  /** Address values to keep on submit (not the page number). */
  keep?: Readonly<Record<string, string>>;
  /** Accessible name of the toolbar. */
  label?: string;
  /** Accessible name of the chip list. */
  chipsLabel?: string;
  className?: string;
}

const VISIBLE_CHIPS = 4;

function splitChips(chips: QueueChip[]): { shown: QueueChip[]; more: QueueChip[] } {
  const shown = chips.slice(0, VISIBLE_CHIPS);
  const more = chips.slice(VISIBLE_CHIPS);
  const current = more.findIndex((c) => c.current);
  if (current >= 0) {
    const [chip] = more.splice(current, 1);
    more.unshift(shown.pop()!);
    shown.push(chip!);
  }
  return { shown, more };
}

function ChipCount({ count, current }: { count: QueueChip['count']; current?: boolean }) {
  if (count === undefined) return null;
  if (count === 'unknown') return <span className={cn('text-xs font-normal', current ? 'text-white' : 'text-quiet')}>(count not known)</span>;
  return <span className={cn('font-semibold tabular-nums', current ? 'text-white' : 'text-brand-strong')}>({count.toLocaleString('en-IN')})</span>;
}

function hrefWith(action: string, keep: Readonly<Record<string, string>> | undefined): string {
  const qs = new URLSearchParams(keep ?? {}).toString();
  return qs ? `${action}?${qs}` : action;
}

export function QueueToolbar({ action, search, chips = [], sort, keep, label = 'Search and filter', chipsLabel = 'Filter', className }: QueueToolbarProps) {
  const id = useId();
  const moreRef = useRef<HTMLDetailsElement>(null);
  const { shown, more } = splitChips(chips);

  // "More" closes on Escape (focus back on its button) and on a click outside it.
  useEffect(() => {
    const details = moreRef.current;
    if (!details) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !details.open) return;
      details.open = false;
      details.querySelector('summary')?.focus();
    };
    const onPointer = (e: PointerEvent) => {
      if (details.open && !details.contains(e.target as Node)) details.open = false;
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [more.length]);

  const onSortChange = (e: ChangeEvent<HTMLSelectElement>) => e.currentTarget.form?.requestSubmit();
  const searchId = `${id}-search`;
  const sortId = `${id}-sort`;
  const searched = search?.value?.trim();

  const chipLink = (chip: QueueChip) => (
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
      <span>{chip.label}</span>
      <ChipCount count={chip.count} current={chip.current} />
    </Link>
  );

  return (
    <Form
      action={action}
      role="search"
      aria-label={label}
      className={cn('m-0 mb-4 flex flex-col gap-3 font-sans lg:flex-row lg:flex-wrap lg:items-start', className)}
      data-slot="queue-toolbar"
    >
      {keep ? Object.entries(keep).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />) : null}
      {search ? (
        <div className="flex flex-col gap-1.5 lg:w-72 lg:flex-none">
          <div className="relative">
            <label htmlFor={searchId} className="sr-only">
              {search.label}
            </label>
            <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-quiet" />
            <input
              id={searchId}
              type="search"
              name={search.name}
              defaultValue={search.value}
              placeholder={search.placeholder ?? 'Search'}
              autoComplete="off"
              enterKeyHint="search"
              className={cn(controlClass, 'pr-11 pl-9')}
            />
            <span className="absolute top-1/2 right-1 -translate-y-1/2">
              <Button type="submit" variant="ghost" size="sm" aria-label="Search" className="px-2">
                <ArrowRight aria-hidden="true" />
              </Button>
            </span>
          </div>
          {searched ? (
            <p className="m-0 text-sm text-quiet" aria-live="polite">
              Showing matches for “{searched}”.{' '}
              <Link href={hrefWith(action, keep)} className={cn('rounded-chip font-medium text-brand-strong underline underline-offset-4 hover:text-brand-deep', focusRing)}>
                Clear search
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}
      {shown.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 lg:min-h-10">
          <nav aria-label={chipsLabel}>
            <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
              {shown.map((chip) => (
                <li key={chip.href} className="m-0">
                  {chipLink(chip)}
                </li>
              ))}
            </ul>
          </nav>
          {more.length > 0 ? (
            <details ref={moreRef} className="relative" data-slot="more-chips">
              <summary className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'min-h-9 list-none [&::-webkit-details-marker]:hidden')}>
                More
                <ChevronDown aria-hidden="true" />
                <span className="sr-only"> filters</span>
              </summary>
              <ul className="absolute top-full left-0 z-30 m-0 mt-1 flex min-w-56 list-none flex-col gap-1 rounded-card border border-line bg-card p-2 shadow-raised">
                {more.map((chip) => (
                  <li key={chip.href} className="m-0">
                    <Link
                      href={chip.href}
                      className={cn(
                        'flex min-h-9 items-center justify-between gap-3 rounded-control px-2.5 text-sm font-medium text-copy no-underline hover:bg-wash hover:text-ink',
                        focusRing,
                      )}
                    >
                      {chip.label}
                      {typeof chip.count === 'number' ? (
                        <span className="text-xs text-quiet tabular-nums">{chip.count.toLocaleString('en-IN')}</span>
                      ) : chip.count === 'unknown' ? (
                        <span className="text-xs text-quiet">count not known</span>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
      {sort && sort.options.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
          <label htmlFor={sortId} className="text-sm font-medium whitespace-nowrap text-quiet">
            {sort.label ?? 'Sort by'}
          </label>
          <Select id={sortId} name={sort.name} defaultValue={sort.value} onChange={onSortChange} className="min-w-48">
            {sort.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Button type="submit" size="sm">
            Sort
          </Button>
        </div>
      ) : null}
    </Form>
  );
}
