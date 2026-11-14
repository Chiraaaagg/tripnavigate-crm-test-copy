import { ArrowLeft, Check, FileSearch } from 'lucide-react';
import Link from 'next/link';
import { StatusBadge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DialogAction } from '@/views/accounts-desk/acc2-kit';
import type { DeskResult } from '@/views/accounts-desk/desk-kit';
import { dayText, inr, whenText } from '@/views/accounts-desk/labels';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { applySummary, BATCH_STATUS_WORDS, matchBatchHref, MATCH_WORDS, TALLY_PATH } from './labels';
import { MATCH_OUTCOMES, TF_FIELD, type TallyMatchPage } from './types';

/*
 * One staged Tally matching upload (contract 7.4 R-C4, C5, C6; 15 screen 7):
 * the counts per outcome as filter links, the vouchers with the CRM amount
 * beside Tally's, then "Apply" (bound to the proposal hash the screen shows:
 * anything changed since the check is refused) or "Cancel". Matched rows get
 * Tally's voucher number; amount differences become Tally exceptions for the
 * exception owner; every other row changes nothing.
 */

const chip = (on: boolean) =>
  cn(
    'inline-flex min-h-9 items-center gap-1.5 rounded-control border px-3 py-1 text-sm font-medium no-underline',
    on ? 'border-brand-strong bg-brand-strong text-white hover:bg-brand-deep hover:text-white' : 'border-line-strong bg-card text-ink hover:bg-wash hover:text-ink',
    focusRing,
  );

export interface MatchBatchActions {
  apply?: DecisionAction | null;
  cancel?: DecisionAction | null;
}

export function TallyMatchBatchView({
  page,
  actions,
  after = null,
  preview,
}: {
  page: TallyMatchPage | 'error';
  actions: MatchBatchActions;
  after?: string | null;
  /** Preview gallery: open a dialog, optionally with a refusal. */
  preview?: { dialog: 'apply' | 'cancel'; state?: DeskResult | null } | null;
}) {
  const back = (
    <Link href={TALLY_PATH} className={buttonVariants({ variant: 'secondary' })}>
      <ArrowLeft aria-hidden="true" />
      Back to Tally
    </Link>
  );
  if (page === 'error')
    return (
      <div className="font-sans">
        <PageHeader eyebrow="Accounts · Tally" title="Tally vouchers" actions={back} />
        <Notice tone="warning" role="status" title="The upload did not load">
          <p>Nothing was changed. Reload the page.</p>
        </Notice>
      </div>
    );
  const b = page.batch;
  const s = applySummary(b.summary);
  const staged = b.status === 'staged';
  const open = (d: 'apply' | 'cancel') => (preview?.dialog === d ? { initialOpen: true, initialState: preview.state ?? null } : {});
  return (
    <div className="flex flex-col gap-5 font-sans text-base text-copy">
      <PageHeader
        eyebrow="Accounts · Tally · Upload"
        title={b.fileName}
        description={`Checked ${whenText(b.stagedAt)}${b.stagedByName ? ` by ${b.stagedByName}` : ''}. ${s.total} vouchers.`}
        status={
          <StatusBadge tone={BATCH_STATUS_WORDS[b.status].tone} wrap>
            {BATCH_STATUS_WORDS[b.status].word}
          </StatusBadge>
        }
        actions={back}
      />
      {staged ? (
        <Card className="flex flex-col gap-3 px-4.5 py-4">
          <p className="m-0">
            <strong className="text-ink">Next: </strong>
            apply to give {s.willMatch} {s.willMatch === 1 ? 'entry' : 'entries'} their Tally voucher number
            {s.willBecomeExceptions ? `, and open ${s.willBecomeExceptions} Tally ${s.willBecomeExceptions === 1 ? 'exception' : 'exceptions'} for the amounts that differ` : ''}. {s.unchanged ? `${s.unchanged} other ${s.unchanged === 1 ? 'voucher changes' : 'vouchers change'} nothing.` : ''}
          </p>
          <div className="flex flex-wrap items-start gap-2">
            <DialogAction
              {...open('apply')}
              buttonLabel="Apply"
              buttonVariant="primary"
              blockedReason={s.willMatch + s.willBecomeExceptions === 0 ? 'Nothing in this file matches a CRM entry.' : null}
              title="Apply the Tally vouchers"
              description={`${s.willMatch} matched, ${s.willBecomeExceptions} amount differences become exceptions. If anything changed since the check, nothing is applied and you check the file again.`}
              primaryLabel="Apply"
              pendingLabel="Applying…"
              action={actions.apply}
              fields={{ [TF_FIELD.batchId]: b.batchId, [TF_FIELD.proposalHash]: b.proposalHash }}
            />
            <DialogAction
              {...open('cancel')}
              buttonLabel="Cancel this upload"
              title="Cancel this upload"
              description="Nothing in the CRM changes. You can upload the same Day Book again."
              primaryLabel="Cancel upload"
              pendingLabel="Cancelling…"
              cancelLabel="Keep it"
              action={actions.cancel}
              fields={{ [TF_FIELD.batchId]: b.batchId }}
            />
          </div>
        </Card>
      ) : (
        <Notice tone={b.status === 'applied' ? 'success' : 'locked'} title={b.status === 'applied' ? `Applied ${b.appliedAt ? whenText(b.appliedAt) : ''}` : 'This upload was cancelled'}>
          <p>{b.status === 'applied' ? 'Matched entries carry Tally’s voucher numbers. Amount differences are in Open exceptions on the Tally page.' : 'Nothing was changed by it.'}</p>
        </Notice>
      )}
      <nav aria-label="Show vouchers by outcome">
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          <li className="m-0">
            <Link href={matchBatchHref(b.batchId)} aria-current={!page.outcome ? 'page' : undefined} className={chip(!page.outcome)}>
              {!page.outcome ? <Check aria-hidden="true" className="size-3.5" /> : null}
              All <span className="tabular-nums">({s.total})</span>
            </Link>
          </li>
          {MATCH_OUTCOMES.filter((o) => b.summary[o]).map((o) => (
            <li key={o} className="m-0">
              <Link href={matchBatchHref(b.batchId, o)} aria-current={page.outcome === o ? 'page' : undefined} className={chip(page.outcome === o)}>
                {page.outcome === o ? <Check aria-hidden="true" className="size-3.5" /> : null}
                {MATCH_WORDS[o].word} <span className="tabular-nums">({b.summary[o]})</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {page.rows.length === 0 ? (
        <Card>
          <EmptyState headingLevel={2} icon={FileSearch} title="No vouchers here" description="No voucher of this file has this outcome." />
        </Card>
      ) : (
        <>
          <Table label="Vouchers in the uploaded Day Book" stackOnMobile wrapperClassName="rounded-card border border-line bg-card">
            <TableHeader>
              <TableRow>
                <TableHead>Tally voucher</TableHead>
                <TableHead>CRM entry</TableHead>
                <TableHead numeric>Tally amount</TableHead>
                <TableHead numeric>CRM amount</TableHead>
                <TableHead>Outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.rows.map((r) => (
                <TableRow key={r.rowNo}>
                  <TableCell label="Tally voucher">
                    <span className="flex flex-col">
                      <span className="font-semibold wrap-anywhere text-ink">
                        {r.voucherType ?? "Voucher"} {r.voucherRef}
                      </span>
                      <span className="text-sm text-quiet">
                        {dayText(r.voucherDate)} · row {r.rowNo}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell label="CRM entry">
                    <span className="flex flex-col">
                      <span className="wrap-anywhere">{r.crmReference ?? '—'}</span>
                      <span className="text-sm text-quiet wrap-anywhere">{r.tnTag ?? 'No TN: tag'}</span>
                    </span>
                  </TableCell>
                  <TableCell label="Tally amount" numeric>
                    <span className="whitespace-nowrap tabular-nums">{inr(r.amountPaise)}</span>
                  </TableCell>
                  <TableCell label="CRM amount" numeric>
                    <span className="whitespace-nowrap tabular-nums">{inr(r.crmAmountPaise)}</span>
                  </TableCell>
                  <TableCell label="Outcome">
                    <StatusBadge tone={MATCH_WORDS[r.outcome].tone} wrap>
                      {MATCH_WORDS[r.outcome].word}
                    </StatusBadge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex flex-wrap items-center gap-3">
            {page.hasMore && page.nextAfter ? (
              <Link href={matchBatchHref(b.batchId, page.outcome, page.nextAfter)} className={buttonVariants({ variant: 'secondary' })}>
                Next page
              </Link>
            ) : (
              <p className="m-0 text-sm text-quiet">That is all.</p>
            )}
            {after ? (
              <Link href={matchBatchHref(b.batchId, page.outcome)} className="text-sm font-semibold text-brand-strong underline underline-offset-4">
                Back to the first page
              </Link>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
