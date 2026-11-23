import { Ban, Check, Eye, FlagTriangleRight, CalendarClock } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { cn, focusRing } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Select } from '@/components/ui/select';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DUES_PATH, duesHref } from './address';
import { duesEveryStatusHref, duesToggleHref } from './r4-address';
import { basisText, CANCELLATION_TEXT, dayText, DUES_LABEL, DUES_TONE, inr, REPORTED_TEXT } from './labels';
import { DUES_STATUSES, type DuesFilter, type DuesPage, type DuesRow, type DuesStatus } from './types';

/*
 * Accounts › Dues (contract 4.4, 8.3, 11.2): what customers still owe, per
 * Deal, from the Accounts-approved booking version and verified money only.
 * Reported payments are shown beside it ("Reported, not yet money") and
 * never reduce dues. Accounts see the company, a branch Manager their
 * branches (view only), Sales their own Deals. Filters are links and a GET
 * form, so the address keeps them.
 *
 * UX redesign R4 (audit A9): the bare address opens on Overdue plus Due
 * today (`defaulted`, see r4-address.ts); "Every status" is ?status=all. The
 * Money in tab strip sits under the header (D5).
 */

export type DuesViewerKind = { kind: 'accounts'; entityName: string } | { kind: 'manager'; branchNames: string[] } | { kind: 'sales' };

export function DuesPageView({
  viewer,
  filter,
  page,
  branches,
  owners = [],
  after,
  defaulted = false,
  sectionTabs,
}: {
  viewer: DuesViewerKind;
  filter: DuesFilter;
  page: DuesPage | 'error';
  branches: Array<{ id: string; name: string }>;
  /** Accounts and the Manager: owner filter choices (addendum B2). */
  owners?: Array<{ id: string; name: string }>;
  after?: string | null;
  /** The bare address: the page shows Overdue plus Due today (r4-address.ts). */
  defaulted?: boolean;
  /** R4 (D5): the Money in tab strip, rendered under the header. */
  sectionTabs?: ReactNode;
}) {
  const scope = viewer.kind === 'accounts' ? `${viewer.entityName} · all branches` : viewer.kind === 'manager' ? `${viewer.branchNames.join(', ')} · view only` : 'Your deals';
  const statusSet = new Set(filter.status ?? []);
  const toggle = (s: DuesStatus) => duesToggleHref(filter, s);
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader
        title="Dues"
        description={scope}
        status={
          viewer.kind === 'manager' ? (
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-quiet">
              <Eye aria-hidden="true" className="size-4" />
              View only
            </span>
          ) : undefined
        }
      />
      {sectionTabs}
      <p className="m-0 mb-4 max-w-prose text-copy">
        Dues follow the booking version Accounts approved and count only verified money. A reported payment is not money until Accounts records and verifies it. Overdue means the day after the due date.
      </p>
      <nav aria-label="Filter by status" className="mb-3">
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          <li className="m-0">
            <Link href={duesEveryStatusHref(filter)} aria-current={statusSet.size === 0 ? 'page' : undefined} className={chip(statusSet.size === 0)}>
              {statusSet.size === 0 ? <Check aria-hidden="true" className="size-3.5" /> : null}
              Every status
            </Link>
          </li>
          {DUES_STATUSES.map((s) => (
            <li key={s} className="m-0">
              <Link href={toggle(s)} aria-current={statusSet.has(s) ? 'true' : undefined} className={chip(statusSet.has(s))}>
                {statusSet.has(s) ? <Check aria-hidden="true" className="size-3.5" /> : null}
                {DUES_LABEL[s]}
                <span className="sr-only">{statusSet.has(s) ? ' (shown; press to remove)' : ' (press to add)'}</span>
              </Link>
            </li>
          ))}
          <li className="m-0">
            <Link href={duesHref({ ...filter, reported: filter.reported ? undefined : true })} aria-current={filter.reported ? 'true' : undefined} className={chip(!!filter.reported)}>
              {filter.reported ? <Check aria-hidden="true" className="size-3.5" /> : null}
              {REPORTED_TEXT}
            </Link>
          </li>
        </ul>
      </nav>
      {defaulted ? (
        <p className="m-0 mb-3 text-sm text-quiet">
          Showing overdue and due today first.{' '}
          <Link href={duesEveryStatusHref(filter)} className={cn('rounded-chip font-medium text-brand-strong underline underline-offset-4', focusRing)}>
            Show every status
          </Link>
        </p>
      ) : null}
      <form action={DUES_PATH} method="get" className="mb-5 flex flex-wrap items-end gap-3" aria-label="Find dues">
        {/* The statuses shown are carried, the default (Overdue plus Due today) too, as the chip links do; "Every status" widens a search. */}
        {(filter.status ?? []).map((s) => (
          <input key={s} type="hidden" name="status" value={s} />
        ))}
        {filter.reported ? <input type="hidden" name="reported" value="yes" /> : null}
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor="dues-deal">Deal reference</Label>
          <Input id="dues-deal" name="deal" defaultValue={filter.dealReference ?? ''} maxLength={40} autoComplete="off" className="w-48" />
        </div>
        {viewer.kind !== 'sales' && branches.length > 1 ? (
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor="dues-branch">Branch</Label>
            <Select id="dues-branch" name="branch" defaultValue={filter.branchId ?? ''}>
              <option value="">All branches</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        {viewer.kind !== 'sales' && owners.length > 0 ? (
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor="dues-owner">Deal owner</Label>
            <Select id="dues-owner" name="owner" defaultValue={filter.ownerUserId ?? ''}>
              <option value="">Anyone</option>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor="dues-from">Next due from</Label>
          <Input id="dues-from" name="nextFrom" type="date" defaultValue={filter.nextDueFrom ?? ''} />
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor="dues-to">Next due up to</Label>
          <Input id="dues-to" name="nextTo" type="date" defaultValue={filter.nextDueTo ?? ''} />
        </div>
        <button type="submit" className={buttonVariants({ variant: 'primary' })}>
          Show dues
        </button>
      </form>
      {page === 'error' ? (
        <Notice tone="warning" role="alert" title="Dues could not be loaded">
          <p>Nothing was changed. Reload the page to try again.</p>
        </Notice>
      ) : page.items.length === 0 ? (
        defaulted ? (
          <EmptyState
            headingLevel={2}
            icon={CalendarClock}
            title="Nothing overdue or due today"
            description="No customer payment is overdue or due today."
            action={
              <Link href={duesEveryStatusHref(filter)} className={buttonVariants({ variant: 'secondary' })}>
                Show every status
              </Link>
            }
          />
        ) : (
          <EmptyState headingLevel={2} icon={CalendarClock} title="No deals match" description={Object.keys(filter).length ? 'Remove a filter above to see more deals.' : 'Deals with a confirmed booking show here.'} />
        )
      ) : (
        <>
          {after ? (
            <p className="m-0 mb-2 text-sm text-quiet">
              Showing later deals.{' '}
              <Link href={duesHref(filter)} className={cn('rounded-chip font-medium text-brand-strong underline underline-offset-4', focusRing)}>
                Back to the start
              </Link>
            </p>
          ) : null}
          <DuesTable rows={page.items} showOwner={viewer.kind !== 'sales'} />
          <p className="m-0 mt-[0.5rem] text-sm text-quiet">Most urgent first: overdue, then due today, then upcoming.</p>
          {page.hasMore && page.nextAfter ? (
            <Link href={duesHref(filter, { after: page.nextAfter })} className={cn(buttonVariants({ variant: 'secondary' }), 'mt-3')}>
              Show more
            </Link>
          ) : null}
        </>
      )}
    </div>
  );
}

function chip(current: boolean) {
  return cn(
    'inline-flex min-h-9 items-center gap-1.5 rounded-control border px-3 py-1 text-sm font-medium no-underline',
    current ? 'border-brand-strong bg-brand-strong text-white hover:bg-brand-deep hover:text-white' : 'border-line-strong bg-card text-ink hover:bg-wash',
    focusRing,
  );
}

export function DuesFlags({
  row,
  hideProvisional = false,
  hideReported = false,
}: {
  row: Pick<DuesRow, 'basis' | 'reportedPaise' | 'cancellation' | 'awaitingVerificationPaise'>;
  /** The Deal card says these once elsewhere (its notice and its figures). */
  hideProvisional?: boolean;
  hideReported?: boolean;
}) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {row.basis.kind === 'awaiting_review' && !hideProvisional ? (
        <StatusBadge tone="warning" icon={FlagTriangleRight} wrap>
          Provisional
        </StatusBadge>
      ) : null}
      {BigInt(row.reportedPaise) > 0n && !hideReported ? (
        <StatusBadge tone="info" wrap>
          {REPORTED_TEXT}: {inr(row.reportedPaise)}
        </StatusBadge>
      ) : null}
      {row.cancellation ? (
        <StatusBadge tone={row.cancellation === 'open' ? 'warning' : 'neutral'} icon={Ban} wrap>
          {CANCELLATION_TEXT[row.cancellation]}
        </StatusBadge>
      ) : null}
    </span>
  );
}

function DuesTable({ rows, showOwner }: { rows: DuesRow[]; showOwner: boolean }) {
  return (
    <Table label="Dues by deal" stackOnMobile wrapperClassName="rounded-card border border-line bg-card">
      <TableHeader>
        <TableRow>
          <TableHead>Deal</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Next due</TableHead>
          <TableHead numeric>Overdue</TableHead>
          <TableHead numeric>Total</TableHead>
          <TableHead numeric>Received (verified)</TableHead>
          <TableHead numeric>Still to pay</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.dealId}>
            <TableCell label="Deal" className="align-top">
              <span className="flex flex-col">
                <Link href={`/app/deals/${r.dealId}?tab=money#dues`} className={cn('w-fit rounded-chip font-semibold text-brand-strong underline-offset-4 hover:underline', focusRing)}>
                  {r.dealReference}
                </Link>
                <span className="text-sm text-quiet">
                  {r.branchName}
                  {showOwner && r.ownerName ? ` · ${r.ownerName}` : ''}
                </span>
                <span className="text-xs text-quiet">{basisText(r.basis)}</span>
              </span>
            </TableCell>
            <TableCell label="Status" className="align-top">
              <span className="flex flex-col items-start gap-1.5">
                <StatusBadge tone={DUES_TONE[r.status]} wrap>
                  {DUES_LABEL[r.status]}
                  {r.status === 'credit' ? ` ${inr(r.creditPaise)}` : ''}
                </StatusBadge>
                <DuesFlags row={r} />
              </span>
            </TableCell>
            <TableCell label="Next due" className="align-top">
              {r.nextDue ? (
                <span className="flex flex-col">
                  <span className="whitespace-nowrap">{dayText(r.nextDue.date)}</span>
                  <span className="text-sm text-quiet tabular-nums">{inr(r.nextDue.openPaise)}</span>
                </span>
              ) : (
                <span className="text-quiet">Nothing due</span>
              )}
            </TableCell>
            <TableCell label="Overdue" numeric className="align-top">
              {BigInt(r.overduePaise) > 0n ? <span className="text-status-danger">{inr(r.overduePaise)}</span> : '—'}
            </TableCell>
            <TableCell label="Total" numeric className="align-top">
              {inr(r.totalPaise)}
            </TableCell>
            <TableCell label="Received" numeric className="align-top">
              {inr(r.verifiedPaise)}
              {BigInt(r.awaitingVerificationPaise) > 0n ? <span className="block text-xs font-normal text-quiet">{inr(r.awaitingVerificationPaise)} waiting to be verified</span> : null}
            </TableCell>
            <TableCell label="Still to pay" numeric className="align-top">
              {inr(r.balancePaise)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function DuesLoading() {
  return (
    <LoadingRegion label="Loading dues">
      <h1 className="sr-only">Dues</h1>
      <Skeleton className="mb-2 h-8 w-40" />
      <Skeleton className="mb-5 h-4 w-56" />
      <Skeleton className="mb-4 h-10 w-full" />
      <Skeleton className="h-64 w-full" />
    </LoadingRegion>
  );
}

export function DuesNoAccess() {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader title="Dues" />
      <Notice tone="restricted" title="Not available for your role">
        <p>Dues are for Accounts, branch Managers and the Sales owner of each deal. Purchase, Flight and Visa never see customer money.</p>
      </Notice>
    </div>
  );
}
