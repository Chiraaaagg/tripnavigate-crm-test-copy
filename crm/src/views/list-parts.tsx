import { ChevronLeft, CircleHelp, Clock, Hourglass, RefreshCw, Tag, UserRound } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { cn, focusRing } from '@/components/ui/cn';
import { Notice } from '@/components/ui/notice';
import { Skeleton } from '@/components/ui/skeleton';
import type { BitrixNameVM, ListFiltersVM, ListFreshnessVM, ListPagerVM, RecordOwnerVM } from '@/modules/deals/workspace-contract';
import {
  type BitrixCodeKind,
  bitrixNameText,
  bitrixNameUnrecognised,
  freshnessText,
  LATE_TEXT,
  recordOwnerText,
  WAITING_FOR_OWNER_TEXT,
} from './deal-labels';

/*
 * Small server-rendered parts shared by the Leads and Deals lists and the
 * Lead and Deal record headers (Direction A, Batch 1). Every status is a word
 * with an icon (never colour alone); unknown is said in words, never shown as
 * empty or zero. Leaf module: imports no other view.
 */

/**
 * DA-45a list line, kept apart from the live-update indicator (DA-46), which
 * never claims freshness. `namesOff` (DA-94a): only for people who may change
 * the Bitrix names switch, appended to the same line.
 */
export function FreshnessLine({ freshness, now, namesOff }: { freshness: ListFreshnessVM; now?: string; namesOff?: 'stages' | 'statuses' }) {
  const parsed = now ? Date.parse(now) : Number.NaN;
  const at = Number.isNaN(parsed) ? undefined : parsed;
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-quiet" data-slot="freshness">
      <RefreshCw aria-hidden="true" className="size-3.5 shrink-0 text-faint" />
      <span>
        {freshnessText(freshness, at)}.{freshness.state === 'known' && freshness.anyLate ? ' Rows over a day old are marked.' : ''}
        {namesOff ? ` Bitrix names are off, so ${namesOff} show as not recognised.` : ''}
      </span>
    </p>
  );
}

/** DA-94: one line on the list while Bitrix names are switched off. */
export function namesSwitchedOff(names: Array<BitrixNameVM | undefined>): boolean {
  return names.some((n) => n?.labelState === 'switched_off');
}

/** A Bitrix stage, status or source in a cell or header: the Bitrix name, or the DA-91..93 fallback with a help icon. */
export function BitrixName({ name, kind, className, capitalDetails = false }: { name: BitrixNameVM; kind: BitrixCodeKind; className?: string; /** Record headers say "(code in Details)" (DA-115): the Details disclosure is named on the page. */ capitalDetails?: boolean }) {
  const text = capitalDetails ? bitrixNameText(name, kind).replace('(code in details)', '(code in Details)') : bitrixNameText(name, kind);
  if (bitrixNameUnrecognised(name)) {
    return (
      <span className={cn('inline-flex max-w-full items-start gap-1.5 text-sm text-quiet', className)}>
        <CircleHelp aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0">{text}</span>
      </span>
    );
  }
  return (
    <span className={cn('inline-flex max-w-full items-start gap-1.5 text-ink', className)}>
      <Tag aria-hidden="true" className="mt-1.5 size-3.5 shrink-0 text-faint" />
      <span className="min-w-0 wrap-break-word">
        {text}
        {name.noLongerInList ? <span className="block text-sm text-quiet">No longer in the Bitrix list</span> : null}
      </span>
    </span>
  );
}

/** Owner in a list cell or header: "You", the owner's name, "Another staff member", or the status "Waiting for owner". */
export function OwnerValue({ owner, withLabel = false }: { owner: RecordOwnerVM; withLabel?: boolean }) {
  const text = recordOwnerText(owner);
  if (text === null) {
    return (
      <StatusBadge tone="warning" icon={Hourglass}>
        {WAITING_FOR_OWNER_TEXT}
      </StatusBadge>
    );
  }
  if (!withLabel) return <span className="wrap-break-word">{text}</span>;
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 wrap-break-word text-copy">
      <UserRound aria-hidden="true" className="size-4 shrink-0 text-faint" />
      <span className="min-w-0">
        Owner: <span className="font-semibold text-ink">{text}</span>
      </span>
    </span>
  );
}

/** DA-45 row badge, only on late rows. */
export function LateBadge() {
  return (
    <StatusBadge tone="warning" icon={Clock} wrap>
      {LATE_TEXT}
    </StatusBadge>
  );
}

/**
 * Row details on demand (P-LIST): a native disclosure, so it works without
 * script and by keyboard. The summary names the record for screen readers.
 */
export function RowDetails({ reference, children }: { reference: string; children: ReactNode }) {
  return (
    <details className="group/details max-w-80 text-sm" data-slot="row-details">
      <summary
        className={cn(
          'inline-flex min-h-8 cursor-pointer list-none items-center rounded-chip px-1 font-medium text-brand-strong underline decoration-1 underline-offset-4 hover:text-brand-deep [&::-webkit-details-marker]:hidden',
          focusRing,
        )}
      >
        Details<span className="sr-only"> for {reference}</span>
      </summary>
      <div className="mt-2.5 rounded-control border border-line bg-canvas px-3 py-2.5 text-left text-copy">{children}</div>
    </details>
  );
}

/** Label/value lines inside row details or a details tab. */
export function DetailFacts({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="m-0 flex flex-col gap-1.5">
      {items.map((item) => (
        <div key={item.label} className="flex flex-col">
          <dt className="text-xs font-semibold text-quiet">{item.label}</dt>
          <dd className="m-0 wrap-anywhere text-copy">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** "Back to leads" / "Back to deals" above a record header. */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <p className="m-0 mb-3">
      <Link
        href={href}
        className={cn(
          'inline-flex items-center gap-1 rounded-chip text-sm font-medium text-brand-strong no-underline hover:text-brand-deep hover:underline',
          focusRing,
        )}
      >
        <ChevronLeft aria-hidden="true" className="size-4" />
        {children}
      </Link>
    </p>
  );
}

/**
 * Late-update warning under a record title (D-20 / L-13), with one "Next:"
 * line (copy L-14; standing rule 5: honest status and repair text; Echo M6).
 */
export function LateRecordNotice({ thing }: { thing: 'deal' | 'lead' }) {
  return (
    <Notice tone="warning" icon={Clock}>
      <p>
        {LATE_TEXT}. Check the {thing === 'deal' ? 'stage' : 'lead'} in Bitrix before you rely on it.
      </p>
      <p className="text-sm">
        <span className="font-semibold text-ink">Next:</span> an admin checks the Bitrix connection.
      </p>
    </Notice>
  );
}

/**
 * True when the viewer can see no record at all (first page, All, nothing
 * shown): a search box could only ever find nothing, so it is left out.
 */
export function nothingVisible(shown: number, filters: ListFiltersVM<string>, pager: ListPagerVM): boolean {
  const current = filters.chips.find((c) => c.current)?.filter ?? 'all';
  return shown === 0 && !pager.previousHref && !pager.nextHref && current === 'all';
}

/**
 * UX redesign R2 (C2, owner choice A: the CRM table and filter chips with the
 * toolbar layout of olewandowski1 Search Toolbar Page Header, pattern only):
 * one row on wide screens, in reading and keyboard order: search, filter
 * chips, order. Stacks on narrow screens. Layout only; each part keeps its
 * own behaviour (chips and order are links, the search box its own form).
 */
export function ListToolbar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-start', className)} data-slot="list-toolbar">
      {children}
    </div>
  );
}

/**
 * Loading state of a list page (route loading file): a visually hidden level-1
 * heading (the real one replaces it), one polite "Loading …" line, then grey
 * shapes in the page's own layout: title, one line, the toolbar row (search,
 * chips, order) and table rows. The shapes are hidden from screen readers, the
 * placeholder area is busy, and the pulse stops under reduced motion.
 */
export function ListLoading({ title, noun, withOrder = false }: { title: string; noun: string; withOrder?: boolean }) {
  return (
    <div className="flex flex-col gap-4 font-sans">
      <h1 className="sr-only">{title}</h1>
      <p role="status" aria-live="polite" className="m-0 text-sm font-medium text-quiet">
        Loading {noun}…
      </p>
      <div aria-busy="true" className="flex flex-col gap-4">
        <Skeleton className="h-7 w-40 max-w-full" />
        <Skeleton className="h-4 w-full max-w-xl" />
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center" data-slot="list-toolbar-loading">
          <Skeleton className="h-10 w-full max-w-md rounded-control lg:w-96" />
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-9 w-44 rounded-control" />
            <Skeleton className="h-9 w-32 rounded-control" />
            <Skeleton className="h-9 w-36 rounded-control max-sm:hidden" />
          </div>
          {withOrder ? <Skeleton className="h-9 w-56 max-w-full rounded-control lg:ml-auto" /> : null}
        </div>
        <div className="rounded-card border border-line bg-card shadow-card">
          <div className="border-b border-line px-4.5 py-3">
            <Skeleton className="h-4 w-56 max-w-full" />
          </div>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center gap-6 border-b border-line px-4.5 py-4 last:border-b-0 max-sm:flex-col max-sm:items-start max-sm:gap-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-48 max-w-full flex-1 max-sm:flex-none" />
              <Skeleton className="h-4 w-16 max-sm:hidden" />
              <Skeleton className="h-4 w-20 max-sm:hidden" />
              <Skeleton className="h-4 w-32 max-sm:w-40" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
