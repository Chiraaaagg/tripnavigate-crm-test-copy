import { ArrowLeft, ArrowRight, CalendarRange, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { StatusBadge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { StatCard } from '@/components/ui/stat-card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { inr } from '@/views/accounts-desk/labels';
import { duesWriteOffLine, monthlyTotal, monthText, shiftMonth, SMALL_BALANCES_PATH, STATUS_WORDS, WRITE_OFF_MONTHLY_PATH } from './labels';
import type { DuesWriteOff, WriteOffMonthly } from './types';

/*
 * Write-off monthly totals (contract 6.6 R-B2): per branch, how many Deals
 * and how much was waived (due) or kept (excess) in one month. Branch
 * Managers see their branches, the Super Admin all of them. Plus the dues
 * line every Deal reader sees (Sales included) once a write-off exists.
 */

export function WriteOffMonthlyView({ data, canSeeList = true }: { data: WriteOffMonthly | 'error'; canSeeList?: boolean }) {
  if (data === 'error')
    return (
      <div className="font-sans">
        <PageHeader eyebrow="Accounts" title="Write-offs by month" />
        <Notice tone="warning" role="status" title="The totals did not load">
          <p>Nothing was changed. Reload the page.</p>
        </Notice>
      </div>
    );
  const total = monthlyTotal(data.branches);
  const href = (m: string) => `${WRITE_OFF_MONTHLY_PATH}?month=${m.slice(0, 7)}`;
  return (
    <div className="flex flex-col gap-5 font-sans text-base text-copy">
      <PageHeader
        eyebrow="Accounts"
        title={`Write-offs in ${monthText(data.month)}`}
        description="Approved write-offs by the month they were approved. Undone write-offs are not counted."
        actions={
          canSeeList ? (
            <Link href={SMALL_BALANCES_PATH} className={buttonVariants({ variant: 'secondary' })}>
              Small balances
            </Link>
          ) : undefined
        }
      />
      <nav aria-label="Choose the month" className="flex flex-wrap gap-2">
        <Link href={href(shiftMonth(data.month, -1))} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
          <ArrowLeft aria-hidden="true" />
          {monthText(shiftMonth(data.month, -1))}
        </Link>
        <Link href={href(shiftMonth(data.month, 1))} className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
          {monthText(shiftMonth(data.month, 1))}
          <ArrowRight aria-hidden="true" />
        </Link>
      </nav>
      {data.branches.length === 0 ? (
        <Card>
          <EmptyState headingLevel={2} icon={CalendarRange} title="No write-offs this month" description="Approved write-offs of this month will be counted here." />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard label="Deals written off" value={total.count} />
            <StatCard label="Waived (customer owed)" value={inr(total.duePaise)} />
            <StatCard label="Kept (customer overpaid)" value={inr(total.excessPaise)} />
          </div>
          <Table label={`Write-offs in ${monthText(data.month)} by branch`} stackOnMobile wrapperClassName="rounded-card border border-line bg-card">
            <TableHeader>
              <TableRow>
                <TableHead>Branch</TableHead>
                <TableHead numeric>Deals</TableHead>
                <TableHead numeric>Waived</TableHead>
                <TableHead numeric>Kept</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.branches.map((b) => (
                <TableRow key={b.branchName}>
                  <TableCell label="Branch">
                    <span className="font-semibold text-ink">{b.branchName}</span>
                  </TableCell>
                  <TableCell label="Deals" numeric>
                    {b.count}
                  </TableCell>
                  <TableCell label="Waived" numeric>
                    <span className="tabular-nums">{inr(b.duePaise)}</span>
                  </TableCell>
                  <TableCell label="Kept" numeric>
                    <span className="tabular-nums">{inr(b.excessPaise)}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </div>
  );
}

/**
 * The dues line (contract 15 screen 6): "Written off ₹X by <Manager> on <date> — reason".
 * Shown on the Deal's dues card for Accounts, the branch Manager and the Sales owner.
 * Returned, withdrawn and undone write-offs show nothing here (they live in the history).
 */
export function DuesWriteOffLine({ writeOff, needsReview }: { writeOff: DuesWriteOff | null; needsReview: boolean }) {
  if (!writeOff || !(writeOff.status === 'approved' || writeOff.status === 'proposed')) return null;
  return (
    <div className="flex flex-col items-start gap-1.5 font-sans text-sm" data-slot="dues-write-off">
      <StatusBadge tone={STATUS_WORDS[writeOff.status].tone} wrap>
        {writeOff.refNo} · {STATUS_WORDS[writeOff.status].word}
      </StatusBadge>
      <p className="m-0 wrap-anywhere text-copy">{duesWriteOffLine(writeOff)}</p>
      {needsReview ? (
        <StatusBadge tone="warning" icon={TriangleAlert} wrap>
          Needs review: a balance is back after the write-off. Accounts check it; nothing is undone by itself.
        </StatusBadge>
      ) : null}
    </div>
  );
}
