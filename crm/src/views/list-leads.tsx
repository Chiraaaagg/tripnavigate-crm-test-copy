import { Building2, FilePlus2, FileQuestion, Inbox, Lock } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { FilterChips } from '@/components/ui/filter-chips';
import { ListPager, pagerRangeText } from '@/components/ui/list-pager';
import { PageHeader } from '@/components/ui/page-header';
import { RecordTabs } from '@/components/ui/record-tabs';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Table, TableBody, TableCaption } from '@/components/ui/table';
import type {
  BitrixNameVM,
  LeadBitrixDetailsVM,
  LeadListFilter,
  LeadWorkspaceVM,
  ListFiltersVM,
  ListFreshnessVM,
  ListPagerVM,
  RecordOwnerVM,
} from '@/modules/deals/workspace-contract';
import { bitrixCodeDetail, dayText, formatIst, recordOwnerText } from './deal-labels';
import { TabUnavailable } from './deal-workspace/tab-error';
import type { LeadRelation } from './lead-views';
import { BackLink, BitrixName, FreshnessLine, LateRecordNotice, namesSwitchedOff, nothingVisible, OwnerValue } from './list-parts';
import { LeadListRow, LeadsTableHeader } from './list-rows';
import { type LeadSearchAction, LeadsServerSearch, ListSearch } from './list-search';
import { LEAD_SEEN_BECAUSE } from './list-seen-because';

/*
 * Direction A, Batch 1: Leads list (LE-01) and Lead record (LE-02). Server
 * components. Props per Luna's luna-batch1-props.md; view models from
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

/** Leads list (LE-01): freshness line, filter chips with exact counts, search, compact table, true pager. */
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
          <div className="mb-4 flex flex-col gap-4">
            <FilterChips filters={filters} label="Filter leads" />
            {rows.length > 0 ? <ListSearch tableId="leads-table" noun="leads" /> : null}
          </div>
          {list}
        </>
      )}
    </div>
  );
}

export interface LeadWorkspaceViewProps {
  workspace: LeadWorkspaceVM;
  /** Quotations tab body (today's SubjectQuotationsCard), placed by the route only when the Quotations tab is open. */
  quotationsTab?: ReactNode;
}

function LeadOverviewTab({ overview }: { overview: NonNullable<LeadWorkspaceVM['overview']> }) {
  return (
    <Card>
      <section aria-labelledby="lead-overview-heading">
        <CardHeader>
          <CardTitle id="lead-overview-heading">Overview</CardTitle>
        </CardHeader>
        <CardBody>
          <SummaryList>
            <SummaryRow label="Source">
              <BitrixName name={overview.source} kind="source" />
            </SummaryRow>
            <SummaryRow label="Created in Bitrix">{formatIst(overview.createdInBitrixAt)}</SummaryRow>
            <SummaryRow label="Branch">{overview.branchName}</SummaryRow>
            <SummaryRow label="Owner">
              <OwnerValue owner={overview.owner} />
            </SummaryRow>
          </SummaryList>
        </CardBody>
      </section>
    </Card>
  );
}

function LeadBitrixTab({ bitrix }: { bitrix: LeadBitrixDetailsVM }) {
  return (
    <Card>
      <section aria-labelledby="lead-bitrix-heading">
        <CardHeader>
          <CardTitle id="lead-bitrix-heading">Bitrix details</CardTitle>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          <SummaryList>
            <SummaryRow label="Bitrix lead">#{bitrix.sourceLeadId}</SummaryRow>
            <SummaryRow label="Status">
              <BitrixName name={bitrix.status} kind="status" />
              <span className="block text-sm text-quiet">{bitrixCodeDetail(bitrix.status)}</span>
            </SummaryRow>
            <SummaryRow label="Source">
              <BitrixName name={bitrix.source} kind="source" />
              <span className="block text-sm text-quiet">{bitrixCodeDetail(bitrix.source)}</span>
              <span className="block text-sm text-quiet">Source is the label staff set in Bitrix. It does not prove which form the customer used.</span>
            </SummaryRow>
            <SummaryRow label="Created in Bitrix">{formatIst(bitrix.createdInBitrixAt)}</SummaryRow>
            <SummaryRow label="Last checked with Bitrix">{formatIst(bitrix.lastCheckedAt)}</SummaryRow>
            <SummaryRow label="Last change received from Bitrix">{formatIst(bitrix.lastChangeAt)}</SummaryRow>
            <SummaryRow label="Why you see it">You see this lead because {LEAD_SEEN_BECAUSE[bitrix.relation]}.</SummaryRow>
          </SummaryList>
          <p className="m-0 flex gap-2 text-sm text-quiet">
            <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-faint" />
            <span>Title, status, source and owner come from Bitrix. Change them in Bitrix.</span>
          </p>
        </CardBody>
      </section>
    </Card>
  );
}

/** Lead record (LE-02): header with one primary action, link tabs, only the open tab's body. */
export function LeadWorkspaceView({ workspace, quotationsTab }: LeadWorkspaceViewProps) {
  const { header, tabs, current } = workspace;
  const quotationsTabItem = tabs.find((t) => t.tab === 'quotations');
  // On the Quotations tab the card's own "Create quotation" is the one primary (copy §16.3), so the header link is hidden there.
  const showPrimary = header.canCreateQuotation && quotationsTabItem && current !== 'quotations';
  const nextActor = header.next.actor ?? recordOwnerText(header.owner);
  const body =
    current === 'quotations' ? (
      quotationsTab ?? <TabUnavailable thing="Quotations" />
    ) : current === 'bitrix' ? (
      workspace.bitrix ? <LeadBitrixTab bitrix={workspace.bitrix} /> : <TabUnavailable thing="Bitrix details" />
    ) : workspace.overview ? (
      <LeadOverviewTab overview={workspace.overview} />
    ) : (
      <TabUnavailable thing="Overview" />
    );
  return (
    <div className="font-sans text-base text-copy">
      <BackLink href="/app/leads">Back to leads</BackLink>
      <PageHeader
        eyebrow={header.reference}
        title={<span className="block wrap-anywhere">{header.title}</span>}
        status={
          <>
            <BitrixName name={header.status} kind="status" capitalDetails />
            <OwnerValue owner={header.owner} withLabel />
            <span className="inline-flex items-center gap-1.5 text-copy">
              <Building2 aria-hidden="true" className="size-4 shrink-0 text-faint" />
              {header.branchName}
            </span>
          </>
        }
        actions={
          showPrimary ? (
            <Link href={quotationsTabItem.href} className={buttonVariants({ variant: 'primary' })} data-slot="lead-primary">
              <FilePlus2 aria-hidden="true" />
              New quotation
            </Link>
          ) : undefined
        }
        className="mb-3"
      />
      <div className="mb-4 flex flex-col gap-2">
        <p className="m-0 text-copy">
          <span className="font-semibold text-ink">Next:</span> {header.next.text}
          {nextActor ? <span className="text-quiet"> · {nextActor}</span> : null}
        </p>
        {header.bitrixLate ? <LateRecordNotice thing="lead" /> : null}
      </div>
      <RecordTabs tabs={tabs} label="Lead sections" className="mb-4" />
      {body}
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
