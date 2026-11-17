import { CalendarRange, Check, CircleSlash, Eye, Scale, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { StatusBadge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { dayText, inr } from '@/views/accounts-desk/labels';
import { blockText, DIRECTION_WORDS, PRESET_WORDS, smallBalancesHref, STATUS_WORDS, WRITE_OFF_MONTHLY_PATH } from './labels';
import { WriteOffRowActions, type WriteOffActions, type WriteOffPreviewOpen } from './row-actions';
import { SMALL_BALANCE_PRESETS, type SmallBalanceFilter, type SmallBalancePage, type SmallBalanceRow, type SmallBalancesViewer } from './types';

/*
 * Accounts › Small balances (contract 6.6 R-B1, 15 screen 6). Deals whose
 * trip ended with a balance or credit at or under the write-off limit, and
 * every Deal with a write-off. Accounts propose (the whole balance only); a
 * branch Manager approves, returns or undoes. Quick views are links, so the
 * address keeps them; keyset pages ("Next page"). Status is icon + words.
 */

const chip = (on: boolean) =>
  cn(
    'inline-flex min-h-9 items-center gap-1.5 rounded-control border px-3 py-1 text-sm font-medium no-underline',
    on ? 'border-brand-strong bg-brand-strong text-white hover:bg-brand-deep hover:text-white' : 'border-line-strong bg-card text-ink hover:bg-wash hover:text-ink',
    focusRing,
  );

export function SmallBalancesView({
  viewer,
  filter,
  page,
  actions,
  writeOffsOn,
  limitPaise,
  after = null,
  preview,
}: {
  viewer: SmallBalancesViewer;
  filter: SmallBalanceFilter;
  page: SmallBalancePage | 'error';
  actions: WriteOffActions;
  /** accounts_settings.write_off_enabled for the viewer's company. */
  writeOffsOn: boolean;
  limitPaise: string;
  after?: string | null;
  preview?: WriteOffPreviewOpen | null;
}) {
  const manager = viewer.kind === 'manager';
  const scope = manager ? `${viewer.branchNames.join(', ') || 'Your branches'} · Managers approve, return and undo` : `${viewer.entityName} · Accounts propose, a branch Manager approves`;
  return (
    <div className="flex flex-col gap-5 font-sans text-base text-copy">
      <PageHeader
        eyebrow="Accounts"
        title="Small balances"
        description={scope}
        actions={
          <Link href={WRITE_OFF_MONTHLY_PATH} className={buttonVariants({ variant: 'secondary' })}>
            <CalendarRange aria-hidden="true" />
            Monthly totals
          </Link>
        }
      />
      <p className="m-0 max-w-prose">
        A small amount left after the trip ended can be written off: the customer no longer owes it, or the company keeps a small overpayment. Always the whole balance, at most {inr(limitPaise)} per Deal. No money moves; dues show the write-off line.
      </p>
      {!writeOffsOn ? (
        <Notice tone="locked" title="Write-offs are not switched on yet.">
          <p>A Super Admin switches them on in Settings · Accounts. The list below shows what could be written off.</p>
        </Notice>
      ) : null}
      <nav aria-label="Quick views">
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          <li className="m-0">
            <Link href={smallBalancesHref({ branchId: filter.branchId })} aria-current={!filter.preset ? 'page' : undefined} className={chip(!filter.preset)}>
              {!filter.preset ? <Check aria-hidden="true" className="size-3.5" /> : null}
              All
            </Link>
          </li>
          {SMALL_BALANCE_PRESETS.map((p) => (
            <li key={p} className="m-0">
              <Link href={smallBalancesHref({ ...filter, preset: p })} aria-current={filter.preset === p ? 'page' : undefined} className={chip(filter.preset === p)}>
                {filter.preset === p ? <Check aria-hidden="true" className="size-3.5" /> : null}
                {PRESET_WORDS[p].label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {page === 'error' ? (
        <Notice tone="warning" role="status" title="Small balances did not load">
          <p>Nothing was changed. Reload the page. If it keeps happening, tell the CRM team.</p>
        </Notice>
      ) : page.items.length === 0 ? (
        <Card>
          <EmptyState
            headingLevel={2}
            icon={Scale}
            title={filter.preset ? 'Nothing here' : 'No small balances'}
            description={filter.preset ? PRESET_WORDS[filter.preset].empty : 'Deals whose trip ended with a small balance or credit show here.'}
            action={
              filter.preset ? (
                <Link href={smallBalancesHref({})} className={buttonVariants({ variant: 'secondary' })}>
                  Show all
                </Link>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <>
          <Table label="Small balances" stackOnMobile wrapperClassName="rounded-card border border-line bg-card">
            <TableHeader>
              <TableRow>
                <TableHead>Deal</TableHead>
                <TableHead>Trip ended</TableHead>
                <TableHead numeric>Balance</TableHead>
                <TableHead>Write-off</TableHead>
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.items.map((row) => (
                <SmallBalanceRowView key={row.dealId} row={row} actions={actions} preview={preview} manager={manager} />
              ))}
            </TableBody>
          </Table>
          <div className="flex flex-wrap items-center gap-3">
            {page.hasMore && page.nextAfter ? (
              <Link href={smallBalancesHref(filter, page.nextAfter)} className={buttonVariants({ variant: 'secondary' })}>
                Next page
              </Link>
            ) : (
              <p className="m-0 text-sm text-quiet">That is all for this view.</p>
            )}
            {after ? (
              <Link href={smallBalancesHref(filter)} className="text-sm font-semibold text-brand-strong underline underline-offset-4">
                Back to the first page
              </Link>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

export function SmallBalanceRowView({ row, actions, preview, manager }: { row: SmallBalanceRow; actions: WriteOffActions; preview?: WriteOffPreviewOpen | null; manager: boolean }) {
  const wo = row.writeOff;
  const needsReview = wo?.status === 'approved' && BigInt(row.balancePaise) > 0n;
  return (
    <TableRow>
      <TableCell label="Deal">
        <span className="flex flex-col">
          <Link href={manager ? `/app/deals/${row.dealId}` : `/app/accounts/deals/${row.dealId}?tab=dues`} className="font-semibold wrap-anywhere text-brand-strong underline-offset-4 hover:underline">
            {row.dealReference}
            <span className="sr-only"> — open the Deal</span>
          </Link>
          <span className="text-sm text-quiet">{row.branchName}</span>
        </span>
      </TableCell>
      <TableCell label="Trip ended">
        <span className="whitespace-nowrap">{row.tripEnd ? dayText(row.tripEnd) : 'Cancelled trip'}</span>
      </TableCell>
      <TableCell label="Balance" numeric>
        <span className="flex flex-col items-end max-sm:items-start">
          <span className="font-semibold whitespace-nowrap text-ink tabular-nums">{inr(row.balancePaise)}</span>
          <span className="text-sm text-quiet">{DIRECTION_WORDS[row.direction].balance}</span>
        </span>
      </TableCell>
      <TableCell label="Write-off">
        <span className="flex max-w-[34ch] flex-col items-start gap-1.5">
          {wo ? (
            <>
              <StatusBadge tone={STATUS_WORDS[wo.status].tone} wrap>
                {wo.refNo} · {STATUS_WORDS[wo.status].word}
              </StatusBadge>
              <span className="text-sm">
                {inr(wo.amountPaise)}
                {wo.proposedByName ? ` · proposed by ${wo.proposedByName}` : ''}
              </span>
              <span className="text-sm text-quiet wrap-anywhere">{wo.reason}</span>
            </>
          ) : (
            <StatusBadge tone="neutral" icon={CircleSlash} wrap>
              None yet
            </StatusBadge>
          )}
          {needsReview ? (
            <StatusBadge tone="warning" icon={TriangleAlert} wrap>
              Needs review: a balance is back after the write-off
            </StatusBadge>
          ) : null}
          {!wo && row.blockedBy.length > 1 ? (
            <ul className="m-0 list-disc pl-4 text-sm text-quiet">
              {row.blockedBy.slice(1).map((c) => (
                <li key={c}>{blockText(c)}</li>
              ))}
            </ul>
          ) : null}
        </span>
      </TableCell>
      <TableCell label="Actions">
        <WriteOffRowActions row={row} actions={actions} preview={preview} />
      </TableCell>
    </TableRow>
  );
}

export function SmallBalancesLoading() {
  return (
    <LoadingRegion label="Loading small balances">
      <h1 className="sr-only">Small balances</h1>
      <Skeleton className="mb-2 h-8 w-56" />
      <Skeleton className="mb-5 h-4 w-96 max-w-full" />
      <div className="mb-4 flex gap-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-9 w-24 rounded-control" />
        ))}
      </div>
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="mb-3 h-14 w-full" />
      ))}
    </LoadingRegion>
  );
}

export function SmallBalancesNoAccess() {
  return (
    <div className="font-sans">
      <PageHeader title="Small balances" />
      <Notice tone="restricted" title="For Accounts and branch Managers">
        <p>Write-offs are proposed by Accounts and approved by a branch Manager. Sales see the write-off line on the Deal&apos;s dues.</p>
      </Notice>
    </div>
  );
}

/** Manager's Approvals page › "Write-offs" tab: the proposed write-offs waiting for this Manager. */
export function WriteOffApprovalsTab({ page, actions, preview }: { page: SmallBalancePage | 'error'; actions: WriteOffActions; preview?: WriteOffPreviewOpen | null }) {
  if (page === 'error')
    return (
      <Notice tone="warning" role="status" title="Write-offs did not load">
        <p>Nothing was changed. Reload the page.</p>
      </Notice>
    );
  if (page.items.length === 0)
    return (
      <Card>
        <EmptyState headingLevel={2} icon={Scale} title="No write-offs to approve" description="When Accounts propose writing off a small balance of your branch, it waits here." />
      </Card>
    );
  return (
    <section aria-labelledby="wo-approvals-h" className="flex flex-col gap-3 font-sans">
      <h2 id="wo-approvals-h" className="m-0 text-lg font-semibold text-ink">
        Write-offs waiting for you <span className="font-normal text-quiet">({page.items.length}{page.hasMore ? '+' : ''})</span>
      </h2>
      <p className="m-0 max-w-prose text-copy">Approving makes the Deal&apos;s balance zero. No money moves. You can undo it later with a reason.</p>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {page.items.map((row) => (
          <li key={row.dealId} className="m-0">
            <Card>
              <CardBody className="flex flex-col gap-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="m-0 font-semibold wrap-anywhere text-ink">
                    {row.writeOff?.refNo} · {row.dealReference}
                    <span className="font-normal text-quiet"> · {row.branchName}</span>
                  </p>
                  <StatusBadge tone="info" icon={Eye} wrap>
                    {STATUS_WORDS.proposed.word}
                  </StatusBadge>
                </div>
                <p className="m-0">
                  <span className="font-semibold text-ink tabular-nums">{inr(row.writeOff?.amountPaise ?? row.balancePaise)}</span> · {DIRECTION_WORDS[row.direction].title.toLowerCase()} · trip ended {row.tripEnd ? dayText(row.tripEnd) : '—'}
                </p>
                <p className="m-0 text-sm wrap-anywhere">
                  <span className="font-semibold text-ink">Reason{row.writeOff?.proposedByName ? ` (${row.writeOff.proposedByName})` : ''}: </span>
                  {row.writeOff?.reason}
                </p>
                <WriteOffRowActions row={row} actions={actions} preview={preview} />
              </CardBody>
            </Card>
          </li>
        ))}
      </ul>
      {page.hasMore ? (
        <Link href={smallBalancesHref({ preset: 'to_approve' })} className="text-sm font-semibold text-brand-strong underline underline-offset-4">
          See all write-offs to approve
        </Link>
      ) : null}
    </section>
  );
}
