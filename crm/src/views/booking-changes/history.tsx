import { History } from 'lucide-react';
import type { ReactNode } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Timeline, type TimelineItem } from '@/components/ui/timeline';
import { inr, whenText } from '@/views/accounts-desk/labels';
import { KIND_WORD, SELLING_FIELDS, fieldWord } from './labels';
import type { ChangeHistoryView } from './types';

/*
 * Deal page › History of changes (contract 10.5 R-G4, screen 15.10): each
 * booking version in time order with the fields that changed and the change
 * request behind it, and each supplier confirmation with its number,
 * reference and who confirmed it. Amounts appear only for the Manager and
 * Accounts (the database returns null otherwise). A Purchase reader gets
 * only their own tasks' confirmations and department-safe changed fields;
 * selling fields are dropped here again as a second guard.
 */

export function ChangeHistory({ history, viewer }: { history: ChangeHistoryView | 'error'; viewer: 'sales' | 'manager' | 'accounts' | 'purchase' }) {
  if (history === 'error') {
    return (
      <HistoryShell status="Could not load">
        <Notice tone="warning" role="status">
          <p>The history could not be loaded just now. Reload the page.</p>
        </Notice>
      </HistoryShell>
    );
  }
  const purchase = viewer === 'purchase';
  const showMoney = (viewer === 'manager' || viewer === 'accounts') && history.confirmations.some((c) => c.amountPaise !== null);
  if (history.versions.length === 0 && history.confirmations.length === 0) {
    return (
      <HistoryShell status="Nothing yet">
        <EmptyState icon={History} title="No changes yet" description="Booking versions and supplier confirmations appear here once the booking is confirmed." />
      </HistoryShell>
    );
  }
  const items: TimelineItem[] = history.versions.map((v, i) => {
    const fields = v.changedFields.filter((f) => !(purchase && SELLING_FIELDS.has(f)));
    return {
      id: `v${v.versionNo}`,
      state: i === history.versions.length - 1 ? 'current' : 'done',
      title: (
        <span className="flex flex-wrap items-center gap-2">
          <span>Version {v.versionNo}</span>
          <StatusBadge tone={v.status === 'confirmed' ? 'success' : v.status === 'superseded' ? 'neutral' : 'info'}>{versionStatusWord(v.status)}</StatusBadge>
        </span>
      ),
      meta: v.confirmedAt ? `Confirmed ${whenText(v.confirmedAt)}` : 'Not confirmed',
      detail: (
        <span className="flex flex-col gap-1">
          {v.changeRequest ? (
            <span>
              {KIND_WORD[v.changeRequest.kind]} {v.changeRequest.refNo} · asked by {v.changeRequest.requestedByName}
              {v.changeRequest.decidedByName ? ` · approved by ${v.changeRequest.decidedByName}` : ''}
            </span>
          ) : i === 0 ? (
            <span>First confirmed booking</span>
          ) : (
            <span>Revised before commitment</span>
          )}
          {fields.length > 0 ? <span>Changed: {fields.map(fieldWord).join(', ')}</span> : null}
        </span>
      ),
    };
  });
  return (
    <HistoryShell status={`${history.versions.length} ${history.versions.length === 1 ? 'version' : 'versions'} · ${history.confirmations.length} supplier ${history.confirmations.length === 1 ? 'confirmation' : 'confirmations'}`}>
      {purchase ? (
        <Notice tone="restricted">
          <p>You see your own tasks&apos; confirmations and the booking details that matter to Purchase.</p>
        </Notice>
      ) : null}
      {history.versions.length > 0 ? (
        <section aria-labelledby="history-versions" className="flex flex-col gap-2">
          <h3 id="history-versions" className="m-0 text-base font-semibold text-ink">
            Booking versions
          </h3>
          <Timeline items={items} label="Booking versions, oldest first" showState />
        </section>
      ) : null}
      {history.confirmations.length > 0 ? (
        <section aria-labelledby="history-confirmations" className="flex flex-col gap-2">
          <h3 id="history-confirmations" className="m-0 text-base font-semibold text-ink">
            Supplier confirmations
          </h3>
          <Table label="Supplier confirmations, oldest first" stackOnMobile wrapperClassName="rounded-control border border-line">
            <TableHeader>
              <TableRow>
                <TableHead>Service</TableHead>
                <TableHead>Confirmation</TableHead>
                <TableHead>Supplier and reference</TableHead>
                <TableHead>Confirmed by</TableHead>
                {showMoney ? <TableHead numeric>Cost</TableHead> : null}
                {showMoney ? <TableHead numeric>Change fee</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.confirmations.map((c) => (
                <TableRow key={`${c.serviceTitle}-${c.confirmationNo}`}>
                  <TableCell label="Service">
                    <span className="font-medium text-ink">{c.serviceTitle}</span>
                  </TableCell>
                  <TableCell label="Confirmation">{c.confirmationNo === 1 ? 'First' : `Number ${c.confirmationNo}`}</TableCell>
                  <TableCell label="Supplier and reference">
                    <span className="wrap-anywhere">
                      {c.supplierName ?? '—'}
                      {c.reference ? ` · ${c.reference}` : ''}
                    </span>
                  </TableCell>
                  <TableCell label="Confirmed by">
                    {c.confirmedByName ?? '—'}
                    <span className="block text-sm text-quiet">{whenText(c.confirmedAt)}</span>
                  </TableCell>
                  {showMoney ? (
                    <TableCell label="Cost" numeric>
                      {inr(c.amountPaise)}
                    </TableCell>
                  ) : null}
                  {showMoney ? (
                    <TableCell label="Change fee" numeric>
                      {c.changeFeePaise ? inr(c.changeFeePaise) : '—'}
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      ) : null}
    </HistoryShell>
  );
}

function versionStatusWord(s: string): string {
  switch (s) {
    case 'confirmed':
      return 'Current';
    case 'superseded':
      return 'Replaced';
    case 'draft':
      return 'Draft';
    default:
      return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
  }
}

function HistoryShell({ status, children }: { status: string; children: ReactNode }) {
  return (
    <Card id="change-history">
      <section aria-labelledby="change-history-heading">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id="change-history-heading">History of changes</CardTitle>
            <CardDescription>{status}</CardDescription>
          </div>
          <History aria-hidden="true" className="size-4 text-faint" />
        </CardHeader>
        <CardBody className="flex flex-col gap-5">{children}</CardBody>
      </section>
    </Card>
  );
}

export function ChangeHistoryLoading() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>History of changes</CardTitle>
      </CardHeader>
      <CardBody>
        <LoadingRegion label="Loading the history…">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </LoadingRegion>
      </CardBody>
    </Card>
  );
}
