import { ChevronLeft, CircleHelp, Clock, Hourglass, RefreshCw, Tag, UserRound } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { cn, focusRing } from '@/components/ui/cn';
import { Notice } from '@/components/ui/notice';
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
