import { FlaskConical } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { cn, focusRing } from '@/components/ui/cn';
import { TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { bitrixCodeDetail, dayText, formatIst } from './deal-labels';
import type { DealListRowVM } from './deals-list-view';
import { BitrixName, DetailFacts, LateBadge, OwnerValue, RowDetails } from './list-parts';
import type { LeadListRowVM } from './list-leads';
import { DEAL_SEEN_BECAUSE, LEAD_SEEN_BECAUSE } from './list-seen-because';

/*
 * One Leads row and one Deals row (Direction A, Batch 1 markup, moved here in
 * Batch 5). The server lists and the client search results render these same
 * components, so a found row looks exactly like the same row in the list.
 * No directive: usable from server and client components. Imports only
 * display helpers (no data access, no validation library); the Deals list
 * passes its Services and Progress cells in, so the service labels stay out
 * of the search bundle.
 */

/** Text the "Search this page" box matches: reference and title only (both already on screen). */
export function rowSearchText(reference: string, title: string): string {
  return `${reference} ${title}`.toLowerCase();
}

export function LeadsTableHeader() {
  return (
    <TableHeader>
      <TableRow className="hover:bg-transparent">
        <TableHead>Customer and trip</TableHead>
        <TableHead>Status</TableHead>
        <TableHead>Source</TableHead>
        <TableHead>Owner</TableHead>
        <TableHead>Branch</TableHead>
        <TableHead>Created</TableHead>
        <TableHead>
          <span className="sr-only">Details</span>
        </TableHead>
      </TableRow>
    </TableHeader>
  );
}

export function LeadListRow({ lead }: { lead: LeadListRowVM }) {
  return (
    <TableRow className="align-top" data-search={rowSearchText(lead.reference, lead.title)}>
      <TableCell label="Customer and trip" className="align-top">
        <Link
          href={`/app/leads/${lead.id}`}
          className={cn('rounded-chip font-semibold wrap-anywhere text-brand-strong underline-offset-4 hover:text-brand-deep', focusRing)}
          data-slot="row-link"
        >
          {lead.title}
        </Link>
        <span className="block text-sm text-quiet">{lead.reference}</span>
        {lead.late ? (
          <span className="mt-1.5 block">
            <LateBadge />
          </span>
        ) : null}
      </TableCell>
      <TableCell label="Status" className="align-top">
        <BitrixName name={lead.status} kind="status" />
      </TableCell>
      <TableCell label="Source" className="align-top">
        <BitrixName name={lead.source} kind="source" />
      </TableCell>
      <TableCell label="Owner" className="align-top">
        <OwnerValue owner={lead.owner} />
      </TableCell>
      <TableCell label="Branch" className="align-top">
        {lead.branchName}
      </TableCell>
      <TableCell label="Created" className="align-top whitespace-nowrap">
        {dayText(lead.createdInBitrixAt)}
      </TableCell>
      {/* No stacked-card label: the control itself says "Details" (no "Details Details" on phones). */}
      <TableCell label="" className="align-top">
        <RowDetails reference={lead.reference}>
          <DetailFacts
            items={[
              { label: 'Bitrix lead', value: `#${lead.details.sourceLeadId}` },
              { label: 'Status', value: bitrixCodeDetail(lead.status) },
              { label: 'Source', value: bitrixCodeDetail(lead.source) },
              { label: 'Created in Bitrix', value: formatIst(lead.createdInBitrixAt) },
              { label: 'Last checked with Bitrix', value: formatIst(lead.details.lastCheckedAt) },
              { label: 'Why you see it', value: `You see this lead because ${LEAD_SEEN_BECAUSE[lead.details.relation]}.` },
            ]}
          />
        </RowDetails>
      </TableCell>
    </TableRow>
  );
}

export function DealsTableHeader({ showServices }: { showServices: boolean }) {
  return (
    <TableHeader>
      <TableRow className="hover:bg-transparent">
        <TableHead>Reference</TableHead>
        <TableHead>Customer and trip</TableHead>
        <TableHead>Stage</TableHead>
        <TableHead>Owner</TableHead>
        {showServices ? <TableHead>Services</TableHead> : null}
        {showServices ? <TableHead>Progress</TableHead> : null}
        <TableHead>
          <span className="sr-only">Details</span>
        </TableHead>
      </TableRow>
    </TableHeader>
  );
}

export type DealRowFact = { label: string; value: ReactNode };

/**
 * One Deals row. `extraCells` (Services and Progress) and `extraFacts`
 * (services in detail) come from the server list only; search results have
 * no service summary and leave both out.
 */
export function DealListRow({ deal: d, extraCells, extraFacts = [] }: { deal: DealListRowVM; extraCells?: ReactNode; extraFacts?: DealRowFact[] }) {
  return (
    <TableRow className="align-top" data-search={rowSearchText(d.reference, d.title)}>
      <TableCell label="Reference" className="align-top">
        <Link
          href={`/app/deals/${d.id}`}
          className={cn('rounded-chip font-semibold whitespace-nowrap text-brand-strong underline-offset-4 hover:text-brand-deep', focusRing)}
          data-slot="row-link"
        >
          {d.reference}
        </Link>
      </TableCell>
      <TableCell label="Customer and trip" className="align-top font-medium wrap-anywhere text-ink">
        {d.title}
        {d.late ? (
          <span className="mt-1.5 block font-normal">
            <LateBadge />
          </span>
        ) : null}
      </TableCell>
      <TableCell label="Stage" className="align-top">
        {d.stage ? (
          <BitrixName name={d.stage} kind="stage" />
        ) : d.testRecord ? (
          <StatusBadge tone="warning" icon={FlaskConical}>
            Test record
          </StatusBadge>
        ) : (
          <span className="text-sm text-quiet">Not from Bitrix</span>
        )}
      </TableCell>
      <TableCell label="Owner" className="align-top">
        <OwnerValue owner={d.owner} />
      </TableCell>
      {extraCells}
      {/* No stacked-card label: the control itself says "Details" (no "Details Details" on phones). */}
      <TableCell label="" className="align-top">
        <RowDetails reference={d.reference}>
          <DetailFacts
            items={[
              ...(d.details.sourceDealId ? [{ label: 'Bitrix deal', value: `#${d.details.sourceDealId}` }] : []),
              ...(d.stage ? [{ label: 'Stage', value: bitrixCodeDetail(d.stage) }] : []),
              { label: 'Branch', value: d.branchName },
              { label: 'Created', value: dayText(d.details.createdOn) },
              ...(d.details.lastCheckedAt ? [{ label: 'Last checked with Bitrix', value: formatIst(d.details.lastCheckedAt) }] : []),
              ...(d.details.lastChangeAt ? [{ label: 'Last change received', value: formatIst(d.details.lastChangeAt) }] : []),
              ...extraFacts,
              ...(d.testRecord ? [{ label: 'Source', value: 'Test record (not from Bitrix)' }] : []),
              { label: 'Why you can see this deal', value: DEAL_SEEN_BECAUSE[d.details.relation] },
            ]}
          />
        </RowDetails>
      </TableCell>
    </TableRow>
  );
}
