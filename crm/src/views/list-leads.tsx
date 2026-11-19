import { FileQuestion, Inbox, Lock } from 'lucide-react';
import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { FilterChips } from '@/components/ui/filter-chips';
import { ListPager, pagerRangeText } from '@/components/ui/list-pager';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCaption } from '@/components/ui/table';
import type {
  BitrixNameVM,
  LeadListFilter,
  ListFiltersVM,
  ListFreshnessVM,
  ListPagerVM,
  RecordOwnerVM,
} from '@/modules/deals/workspace-contract';
import { dayText } from './deal-labels';
import type { LeadRelation } from './lead-views';
import { FreshnessLine, ListLoading, ListToolbar, namesSwitchedOff, nothingVisible } from './list-parts';
import { LeadListRow, LeadsTableHeader } from './list-rows';
import { type LeadSearchAction, LeadsServerSearch, ListSearch } from './list-search';
import { LEAD_SEEN_BECAUSE } from './list-seen-because';

/*
 * Direction A, Batch 1: Leads list (LE-01). Server components. The Lead
 * record (LE-02) moved to lead-views.tsx in the UX redesign (R2). Props per Luna's luna-batch1-props.md; view models from
 * src/modules/deals/workspace-contract.ts. Re-exported by lead-views.tsx (the
 * route import path). Kept in its own file so Tailwind scans the new markup
 * and never the legacy helper class names of the older lead views.
 * Patterns: originui dense Table 89 (lists), shadcn Tabs 953 (record tabs),
 * sean0205 29356 summary list idea (facts); 21st-register.md §10.
 */

/** One Leads list row (built on the server by the route; display data only, no contact fields). */
export interface LeadListRowVM {
  id: string;
  /** BXL-<lead id>. */
  reference: string;
  /** Customer and trip (the Bitrix title). */
  title: string;
  status: BitrixNameVM;
  source: BitrixNameVM;
  owner: RecordOwnerVM;
  branchName: string;
  /** ISO "Created in Bitrix" (column "Created"). */
  createdInBitrixAt: string;
  /** Row badge "Not updated from Bitrix for over a day" (DA-45). */
  late: boolean;
  /** Row Details on demand (L-04, L-05, L-15). */
  details: { sourceLeadId: string; lastCheckedAt: string; relation: LeadRelation };
}

export interface LeadsListScreenProps {
  rows: LeadListRowVM[];
  filters: ListFiltersVM<LeadListFilter>;
  freshness: ListFreshnessVM;
  pager: ListPagerVM;
  /** ISO clock for "updated … ago" (tests and previews); default: render time. */
  now?: string;
  /** The viewer may change the Bitrix names switch (Super Admin): the freshness line then says when names are off (DA-94a). */
  namesSwitchable?: boolean;
  /**
   * Batch 5: search every lead the viewer can see (server action, POST only).
   * Omitted: today's "Search this page" box.
   */
  search?: LeadSearchAction;
}

/** L-04 reason, moved to Details: "You see this lead because: …" (list-seen-because.ts, shared with search results). */
export { LEAD_SEEN_BECAUSE };

/** "4 Oct 2026" (IST) for list cells; the raw value when unparsable (same format as every Batch 1 date). */
export const leadDayText = dayText;

function LeadsEmpty({ filters, pager }: { filters: ListFiltersVM<LeadListFilter>; pager: ListPagerVM }) {
  const current = filters.chips.find((c) => c.current);
  const all = filters.chips.find((c) => c.filter === 'all');
  if (pager.previousHref) {
    return (
      <Card role="status">
        <EmptyState
          icon={Inbox}
          headingLevel={2}
          title="That was the last page"
          description="There are no more leads you can see after this point."
          action={
            all ? (
              <Link href={all.href} className={buttonVariants({ variant: 'secondary' })}>
                Back to first page
              </Link>
            ) : undefined
          }
        />
      </Card>
    );
  }
  if (current && current.filter !== 'all') {
    return (
      <Card role="status">
        <EmptyState
          icon={Inbox}
          headingLevel={2}
          title="Nothing matches this filter"
          description="No lead you own is in the CRM yet."
          action={
            all ? (
              <Link href={all.href} className={buttonVariants({ variant: 'secondary' })}>
                Clear filters
              </Link>
            ) : undefined
          }
        />
      </Card>
    );
  }
  return (
    <Card role="status">
      <EmptyState
        icon={Inbox}
        headingLevel={2}
        title="No leads to show"
        description="No lead is visible to you yet. New Bitrix leads you can see appear here after the next Bitrix update."
      />
    </Card>
  );
}

/**
 * Loading state of the Leads list (route loading file, UX redesign R2): the
 * list's own shapes (ListLoading), so the page does not jump when it arrives.
 */
export function LeadsListLoading() {
  return <ListLoading title="Leads" noun="leads" />;
}

/**
 * Leads list (LE-01; UX redesign R2 queue pattern C2): freshness line, one
 * toolbar row (search, filter chips with exact counts), compact table where
 * the customer name is the row's link, true pager.
 */
export function LeadsListScreen({ rows, filters, freshness, pager, now, namesSwitchable = false, search }: LeadsListScreenProps) {
  const namesOff = namesSwitchable && namesSwitchedOff(rows.flatMap((r) => [r.status, r.source]));
  const list = (
    <>
      {rows.length === 0 ? (
        <LeadsEmpty filters={filters} pager={pager} />
      ) : (
        <Card>
          <Table stackOnMobile label="Leads table" wrapperClassName="rounded-card" id="leads-table">
            <TableCaption className="sr-only">{pagerRangeText(pager, 'leads')}</TableCaption>
            <LeadsTableHeader />
            <TableBody>
              {rows.map((lead) => (
                <LeadListRow key={lead.id} lead={lead} />
              ))}
            </TableBody>
          </Table>
          <ListPager pager={pager} noun="leads" label="Lead pages" />
        </Card>
      )}
      {rows.length === 0 && (pager.previousHref || pager.nextHref) ? (
        <ListPager pager={pager} noun="leads" label="Lead pages" className="mt-3 rounded-card border border-line bg-card" />
      ) : null}
      <p className="m-0 mt-3 text-sm text-quiet">Sorted by Bitrix lead number, newest first.</p>
    </>
  );
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader
        title="Leads"
        description="Leads from Bitrix. Follow them up in Bitrix; make quotations here."
        status={<FreshnessLine freshness={freshness} now={now} namesOff={namesOff ? 'statuses' : undefined} />}
      />
      {search && !nothingVisible(rows.length, filters, pager) ? (
        <>
          {/* Batch 5: the box searches every lead the viewer can see, so it shows even when this page or filter is empty. The chips hide while search results show. */}
          <LeadsServerSearch
            action={search}
            tableId="leads-table"
            chips={<FilterChips filters={filters} label="Filter leads" />}
            filterActive={filters.chips.some((c) => c.current && c.filter !== 'all')}
            list={<div>{list}</div>}
          />
        </>
      ) : (
        <>
          {/* UX redesign R2 (C2): the same toolbar row as with server search: search, then chips. */}
          <ListToolbar className="mb-4">
            {rows.length > 0 ? (
              <div className="w-full max-w-xl min-w-0 lg:w-auto lg:max-w-md lg:min-w-64 lg:flex-1">
                <ListSearch tableId="leads-table" noun="leads" />
              </div>
            ) : null}
            <div className={cn('min-w-0', rows.length > 0 && 'lg:pt-6')}>
              <FilterChips filters={filters} label="Filter leads" />
            </div>
          </ListToolbar>
          {list}
        </>
      )}
    </div>
  );
}

/** Purchase and other roles without lead access (L-19). Shows no lead detail and no link at all. */
export function LeadsNoPermissionView() {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader title="Leads" />
      <Card role="status">
        <div className="flex items-start gap-3 px-4.5 py-4">
          <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-control bg-brand-tint text-brand">
            <Lock className="size-4.5" />
          </span>
          <p className="m-0 self-center text-copy">Leads are not part of your role. Sales handles leads in Bitrix.</p>
        </div>
      </Card>
    </div>
  );
}

/**
 * Same response for "does not exist" and "not visible to you", so lead ids
 * cannot be probed (L-20). Same look as DealNotFoundView; the way back sits
 * outside the status, so the live region announces only the message.
 */
export function LeadNotFoundView() {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader title="Lead not available" />
      <Card role="status">
        <div className="flex items-start gap-3 px-4.5 py-4">
          <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-control bg-brand-tint text-brand">
            <FileQuestion className="size-4.5" />
          </span>
          <p className="m-0 self-center text-copy">This lead does not exist in the CRM, or your role and branch do not let you see it.</p>
        </div>
      </Card>
      <p className="m-0 mt-4">
        <Link href="/app/leads" className={buttonVariants({ variant: 'secondary' })}>
          Back to leads
        </Link>
      </p>
    </div>
  );
}
