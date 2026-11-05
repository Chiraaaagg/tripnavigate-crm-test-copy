import { Briefcase, Check, Info } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { FilterChips } from '@/components/ui/filter-chips';
import { ListPager, pagerRangeText } from '@/components/ui/list-pager';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCaption, TableCell } from '@/components/ui/table';
import type { ViewerRelation } from '@/modules/deals/dto';
import type { BitrixNameVM, DealListFilter, ListFiltersVM, ListFreshnessVM, ListPagerVM, RecordOwnerVM } from '@/modules/deals/workspace-contract';
import { type DealProgress, type DealServiceSummaryView, progressText } from '@/modules/fulfilment/contracts';
import { FreshnessLine, namesSwitchedOff, nothingVisible } from './list-parts';
import { DealListRow, DealsTableHeader } from './list-rows';
import { type DealSearchAction, DealsServerSearch, ListSearch } from './list-search';
import { DEAL_SEEN_BECAUSE } from './list-seen-because';
import { ServiceTypeChips } from './service-labels';

/*
 * Deals list (DE-01, Direction A Batch 1): freshness line and live indicator,
 * filter chips with exact counts, "Search this page", a compact table with
 * row details on demand, and a true pager. Server component; rows carry no
 * money (money-privacy P5). Patterns: originui dense Table 89 (register §10),
 * a two-option order control built as links, and the table skeleton for
 * loading (uiable 19969). Earlier record:
 * docs/implementation/current/design/ui-foundation-21st-log-2026-10-09.md.
 */

export interface DealsPaging {
  /** All deals visible to the viewer (countVisibleDeals). */
  total: number;
  /** 1-based page shown. */
  page: number;
  pageSize: number;
  /** Rows before this page. */
  offset: number;
  /** Bitrix deal ID order; kept in the URL so paging and refresh keep it. */
  sort?: 'id_desc' | 'id_asc';
}

/** /app/deals URL for a page and order (defaults left out). */
export function dealsHref(page: number, sort: DealsPaging['sort'] = 'id_desc'): string {
  const q = new URLSearchParams();
  if (sort === 'id_asc') q.set('sort', sort);
  if (page > 1) q.set('page', String(page));
  const qs = q.toString();
  return qs ? `/app/deals?${qs}` : '/app/deals';
}

/**
 * Loading state of the Deals list (route loading file): a visually hidden
 * "Deals" heading, then the page header, the order control and a few table
 * rows as grey shapes. Announced once, politely;
 * the shapes are hidden from screen readers and the placeholder area is busy.
 */
export function DealsListLoading() {
  return (
    <div className="flex flex-col gap-4 font-sans">
      {/* The page keeps one level-1 heading while it loads (visually hidden; the real one replaces it). */}
      <h1 className="sr-only">Deals</h1>
      <p role="status" aria-live="polite" className="m-0 text-sm font-medium text-quiet">
        Loading deals…
      </p>
      <div aria-busy="true" className="flex flex-col gap-4">
        <Skeleton className="h-7 w-40 max-w-full" />
        <Skeleton className="h-4 w-full max-w-xl" />
        <Skeleton className="h-9 w-80 max-w-full self-end max-sm:self-start" />
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

// ===========================================================================
// Direction A, Batch 1 (DE-01). Server component. Props per Luna's
// luna-batch1-props.md; view models from src/modules/deals/workspace-contract.ts.
// ===========================================================================

/** One Deals list row (built on the server by the route; display data only, never money: money-privacy P5). */
export interface DealListRowVM {
  id: string;
  reference: string;
  /** Customer and trip (the Bitrix title). */
  title: string;
  branchName: string;
  owner: RecordOwnerVM;
  /** Undefined for a CRM-native or synthetic record. */
  stage?: BitrixNameVM;
  /** "Test record" tag (no Bitrix source, DL-05). */
  testRecord: boolean;
  /** Row badge "Not updated from Bitrix for over a day" (DA-45). */
  late: boolean;
  details: {
    relation: ViewerRelation;
    /** Already formatted date. */
    createdOn: string;
    sourceDealId?: string;
    /** ISO. */
    lastCheckedAt?: string;
    /** ISO. */
    lastChangeAt?: string;
  };
}

export interface DealsListScreenProps {
  rows: DealListRowVM[];
  filters: ListFiltersVM<DealListFilter>;
  freshness: ListFreshnessVM;
  pager: ListPagerVM;
  sort: { current: 'id_desc' | 'id_asc'; newestHref: string; oldestHref: string };
  /** Sold services per deal id. null = the projection failed (one notice, columns left out); undefined = not loaded. */
  services?: Map<string, DealServiceSummaryView> | null;
  /** Live-update indicator (DA-46), separate from the freshness line. */
  live?: ReactNode;
  /** Role-specific empty text (DE-01). */
  emptyFor?: 'accounts' | 'super_admin';
  /** ISO clock for "updated … ago" (tests and previews). */
  now?: string;
  /** The viewer may change the Bitrix names switch (Super Admin): the freshness line then says when names are off (DA-94a). */
  namesSwitchable?: boolean;
  /**
   * Batch 5: search every deal the viewer can see (server action, POST only).
   * Omitted: today's "Search this page" box.
   */
  search?: DealSearchAction;
}

/** DL-03 reason, moved to Details (list-seen-because.ts, shared with search results). */
export { DEAL_SEEN_BECAUSE };

/** DL-09: "{done} of {total} confirmed"; the breakdown stays on the Deal page. */
export function shortProgressText(p: DealProgress): string {
  if (p.total === 0) return progressText(p);
  const done = p.byState.supplierConfirmed + (p.byState.completed ?? 0);
  const active = p.byState.notStarted + p.byState.inProgress + done;
  return active > 0 ? `${done} of ${active} confirmed` : progressText(p);
}

/** DL-10. */
export const SERVICES_DID_NOT_LOAD_TEXT = 'Services did not load. The deal list itself is fine. Reload to try again.';

/** "Newest first" / "Oldest first" (DL-06): two links, so each order is a real address; page reset to 1, filter kept. */
function DealsOrderToggle({ sort }: { sort: DealsListScreenProps['sort'] }) {
  const options = [
    { value: 'id_desc', label: 'Newest first', href: sort.newestHref },
    { value: 'id_asc', label: 'Oldest first', href: sort.oldestHref },
  ] as const;
  return (
    <div role="group" aria-label="Order of deals" className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-quiet">Order:</span>
      <span className="inline-flex gap-0.5 rounded-control border border-line bg-wash p-0.5">
        {options.map((option) =>
          option.value === sort.current ? (
            <strong
              key={option.value}
              aria-current="true"
              className="inline-flex items-center gap-1.5 rounded-chip bg-card px-2.5 py-1 text-sm font-semibold text-ink shadow-button"
            >
              <Check aria-hidden="true" className="size-3.5 text-brand-strong" />
              {option.label}
            </strong>
          ) : (
            <Link
              key={option.value}
              href={option.href}
              className={cn('inline-flex items-center rounded-chip px-2.5 py-1 text-sm font-medium text-brand-strong no-underline hover:bg-card hover:text-brand-deep', focusRing)}
            >
              {option.label}
            </Link>
          ),
        )}
      </span>
    </div>
  );
}

function DealsEmpty({ filters, pager, emptyFor }: Pick<DealsListScreenProps, 'filters' | 'pager' | 'emptyFor'>) {
  const all = filters.chips.find((c) => c.filter === 'all');
  const current = filters.chips.find((c) => c.current);
  const back = (label: string) =>
    all ? (
      <Link href={all.href} className={buttonVariants({ variant: 'secondary' })}>
        {label}
      </Link>
    ) : undefined;
  if (pager.previousHref) {
    return (
      <Card role="status">
        <EmptyState icon={Briefcase} headingLevel={2} title="That was the last page" description="There are no more deals you can see after this point." action={back('Back to first page')} />
      </Card>
    );
  }
  if (current && current.filter !== 'all') {
    return (
      <Card role="status">
        <EmptyState icon={Briefcase} headingLevel={2} title="Nothing matches this filter" description="Other deals you can see are under All deals." action={back('Clear filters')} />
      </Card>
    );
  }
  const description =
    emptyFor === 'accounts'
      ? 'No deal is visible to you here. Your Deal work is in Accounts.'
      : emptyFor === 'super_admin'
        ? 'No deal is visible to you. Deals show here only when you are given access to them.'
        : 'No deal is visible to you. Ask your manager if you expected to see one.';
  return (
    <Card role="status">
      <EmptyState
        icon={Briefcase}
        headingLevel={2}
        title="No deals to show"
        description={description}
        action={
          emptyFor === 'accounts' ? (
            <Link href="/app/accounts" className={buttonVariants({ variant: 'secondary' })}>
              Open To check
            </Link>
          ) : undefined
        }
      />
    </Card>
  );
}

/** Deals list (DE-01): freshness line + live indicator, chips with exact counts, search, compact table, true pager. */
export function DealsListScreen({ rows, filters, freshness, pager, sort, services, live, emptyFor, now, namesSwitchable = false, search }: DealsListScreenProps) {
  const showServices = services instanceof Map;
  const namesOff = namesSwitchable && namesSwitchedOff(rows.map((r) => r.stage));
  const servicesNotice =
    services === null ? (
      <p className="m-0 flex items-start gap-2 text-sm text-copy" role="status">
        <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-warning" />
        <span>{SERVICES_DID_NOT_LOAD_TEXT}</span>
      </p>
    ) : null;
  const list =
    rows.length === 0 ? (
      <>
        <DealsEmpty filters={filters} pager={pager} emptyFor={emptyFor} />
        {pager.previousHref || pager.nextHref ? (
          <ListPager pager={pager} noun="deals" label="Deal pages" className="mt-3 rounded-card border border-line bg-card" />
        ) : null}
      </>
    ) : (
      <Card>
        <Table stackOnMobile label="Deals table" wrapperClassName="rounded-card" id="deals-table">
          <TableCaption className="sr-only">{pagerRangeText(pager, 'deals')}</TableCaption>
          <DealsTableHeader showServices={showServices} />
          <TableBody>
            {rows.map((d) => {
              const summary = showServices ? services.get(d.id) : undefined;
              return (
                <DealListRow
                  key={d.id}
                  deal={d}
                  extraCells={
                    showServices ? (
                      <>
                        <TableCell label="Services" className="align-top">
                          <ServiceTypeChips types={summary?.serviceTypes ?? []} />
                        </TableCell>
                        <TableCell label="Progress" className="align-top text-sm text-copy">
                          {summary ? shortProgressText(summary) : 'No services yet'}
                        </TableCell>
                      </>
                    ) : undefined
                  }
                  extraFacts={summary && summary.total > 0 ? [{ label: 'Services in detail', value: progressText(summary) }] : undefined}
                />
              );
            })}
          </TableBody>
        </Table>
        <ListPager pager={pager} noun="deals" label="Deal pages" />
      </Card>
    );
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader
        title="Deals"
        description="Deals from Bitrix that you can open."
        status={
          <>
            <FreshnessLine freshness={freshness} now={now} namesOff={namesOff ? 'stages' : undefined} />
            {live ? <span className="[&_.live-indicator]:m-0">{live}</span> : null}
          </>
        }
      />
      {search && !nothingVisible(rows.length, filters, pager) ? (
        <>
          {/* Batch 5: the box searches every deal the viewer can see; the chips and the order control show only while the list shows. */}
          <DealsServerSearch
            action={search}
            tableId="deals-table"
            chips={<FilterChips filters={filters} label="Filter deals" srSuffix={{ assigned: ', owned by someone else' }} />}
            filterActive={filters.chips.some((c) => c.current && c.filter !== 'all')}
            aside={rows.length > 0 ? <DealsOrderToggle sort={sort} /> : undefined}
            list={
              <div className="flex flex-col gap-4">
                {servicesNotice}
                <div>{list}</div>
              </div>
            }
          />
        </>
      ) : (
        <>
          <div className="mb-4 flex flex-col gap-4">
            <FilterChips filters={filters} label="Filter deals" srSuffix={{ assigned: ', owned by someone else' }} />
            {rows.length > 0 ? (
              <div className="flex flex-wrap items-end justify-between gap-3">
                <ListSearch tableId="deals-table" noun="deals" />
                <DealsOrderToggle sort={sort} />
              </div>
            ) : null}
            {servicesNotice}
          </div>
          {list}
        </>
      )}
    </div>
  );
}
