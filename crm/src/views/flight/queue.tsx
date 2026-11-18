import { Plane } from 'lucide-react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { budgetText, InternalTaskLine, QueueEmpty, QueueShowTabs } from '../department/task-frame';
import type { QueueShow } from '../department/queue-show';
import { chipsOf, FlightChips, FlightStatusBadge } from './bits';
import { plural, shortDate } from './format';
import { FLIGHT_TEXT } from './labels';
import type { FlightQueueGroup, FlightQueueView } from './types';

/*
 * Flight queue (contract 9.1 / 11.1, prototype flightQueue FV:1031): one row
 * per Deal. A Deal with two or more flights gets a native disclosure
 * ("Show N flights") listing route · date · "x of y tickets" (21st.dev
 * "Expanding Sub-Rows Table" idea only: no extra library, the CRM table kit
 * and <details>). Tabs Not taken · Mine · All filter the rows the database
 * already returned; a branch Manager sees All only, read-only.
 */

export function workspaceHref(dealId: string, extra?: string): string {
  return `/app/flight/deals/${dealId}${extra ? `?${extra}` : ''}`;
}

function isNotTakenGroup(g: FlightQueueGroup): boolean {
  return !g.assignedToYou && !g.assigneeName && g.status.code === 'waiting';
}

/** Narrower views of Mine that Home rows open (`?only=`, server allowlist). */
export type QueueOnly = 'booking_changed' | 'payment' | 'change_decision' | 'ready';
export const QUEUE_ONLY_LABEL: Record<QueueOnly, string> = {
  booking_changed: 'Booking changed',
  payment: 'Payment needed',
  change_decision: 'Change decisions to see',
  ready: 'Ready to mark done',
};
export function parseQueueOnly(raw: string | string[] | undefined): QueueOnly | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v && v in QUEUE_ONLY_LABEL ? (v as QueueOnly) : null;
}

const ONLY_TEST: Record<QueueOnly, (g: FlightQueueGroup) => boolean> = {
  booking_changed: (g) => g.chips.bookingChanged,
  payment: (g) => g.chips.paymentNeeded,
  change_decision: (g) => !!g.hasChangeDecision,
  ready: (g) => !!g.readyToFinish,
};

/** Mine = your flights still to finish (Done groups stay under All), so it matches Home's "Your flights in progress". */
export function filterGroups(groups: FlightQueueGroup[], show: QueueShow): FlightQueueGroup[] {
  if (show === 'mine') return groups.filter((g) => g.assignedToYou && g.status.code !== 'done');
  if (show === 'not_taken') return groups.filter(isNotTakenGroup);
  return groups;
}

function takenBy(g: FlightQueueGroup): string {
  if (g.assignedToYou) return 'You';
  return g.assigneeName ?? 'Not taken yet';
}

function routeOf(g: FlightQueueGroup): string {
  return g.flights.length === 1 ? g.flights[0]!.route : g.flights.map((f) => f.route).join(' · ');
}

export function FlightQueuePage({ queue, canTakeTasks, show, only = null }: { queue: FlightQueueView; canTakeTasks: boolean; show: QueueShow; only?: QueueOnly | null }) {
  const all = queue.groups;
  const current: QueueShow = canTakeTasks ? show : 'all';
  const narrowed = canTakeTasks && current === 'mine' ? only : null;
  const tabRows = filterGroups(all, current);
  const rows = narrowed ? tabRows.filter(ONLY_TEST[narrowed]) : tabRows;
  const counts = { not_taken: all.filter(isNotTakenGroup).length, mine: filterGroups(all, 'mine').length, all: all.length };
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader eyebrow="Flight team" title="Flight tasks" description={canTakeTasks ? FLIGHT_TEXT.queueNote : 'Your branches’ flights. You can follow them here; the Flight team works on them.'} />
      <div className="mb-4">
        <InternalTaskLine>{FLIGHT_TEXT.noMoney}</InternalTaskLine>
      </div>
      {canTakeTasks ? <QueueShowTabs basePath="/app/flight" show={current} canTakeTasks counts={counts} label="Flight task filters" /> : null}
      {narrowed ? (
        <p className="m-0 mb-3 flex flex-wrap items-center gap-x-2 text-sm text-copy" role="status">
          <span>
            Showing only: <strong className="text-ink">{QUEUE_ONLY_LABEL[narrowed]}</strong> ({plural(rows.length, 'Deal')})
          </span>
          <Link href="/app/flight?show=mine" className={cn('rounded-chip font-medium text-brand-strong underline underline-offset-4', focusRing)}>
            Show all my flights
          </Link>
        </p>
      ) : null}
      <Card>
        {rows.length === 0 ? (
          <div role="status">
            <QueueEmpty icon={Plane} anyTasks={all.length > 0} show={current} serviceWords="a flight" />
          </div>
        ) : (
          <Table stackOnMobile label="Flight tasks table" wrapperClassName="rounded-card">
            <TableCaption className="caption-top border-b border-line py-3 font-medium text-copy max-sm:block">{plural(rows.length, 'Deal')} with flights</TableCaption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Route</TableHead>
                <TableHead>Flights</TableHead>
                <TableHead>Travellers</TableHead>
                <TableHead>Approved budget</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Taken by</TableHead>
                <TableHead>Deal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((g) => (
                <TableRow key={g.dealId} className="align-top">
                  <TableCell label="Route" className="align-top">
                    <Link href={workspaceHref(g.dealId)} className={cn('rounded-chip font-semibold wrap-anywhere text-brand-strong underline-offset-4 hover:text-brand-deep', focusRing)}>
                      {routeOf(g)}
                      <span className="sr-only"> — open the flights of {g.dealReference}</span>
                    </Link>
                  </TableCell>
                  <TableCell label="Flights" className="align-top text-sm">
                    {g.flights.length === 1 ? (
                      <span className="whitespace-nowrap">{g.flights[0]!.firstDate ? shortDate(g.flights[0]!.firstDate) : g.flights[0]!.entryMode === 'screenshot' ? 'From screenshot' : '—'}</span>
                    ) : (
                      <details className="group">
                        <summary className={cn('cursor-pointer rounded-chip font-medium text-brand-strong underline-offset-4 hover:underline', focusRing)}>Show {g.flights.length} flights</summary>
                        <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0">
                          {g.flights.map((f) => (
                            <li key={f.taskId} className="m-0">
                              <Link href={workspaceHref(g.dealId, `tab=work&flight=${f.taskId}`)} className={cn('rounded-chip text-copy underline underline-offset-4 hover:text-ink', focusRing)}>
                                {f.route}
                              </Link>
                              <span className="block text-quiet">
                                {f.firstDate ? shortDate(f.firstDate) : 'Date not typed yet'} · {f.status.required > 0 ? `${f.status.confirmed} of ${f.status.required} tickets` : f.status.text}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </TableCell>
                  <TableCell label="Travellers" className="align-top tabular-nums">
                    {typeof g.travellerCount === 'number' ? g.travellerCount : '—'}
                  </TableCell>
                  <TableCell label="Approved budget" className="align-top whitespace-nowrap tabular-nums">
                    {budgetText(g.budgetPaise)}
                  </TableCell>
                  <TableCell label="Status" className="align-top">
                    <div className="flex flex-col items-start gap-1.5">
                      <FlightStatusBadge status={g.status} />
                      <FlightChips chips={chipsOf(g.chips)} />
                    </div>
                  </TableCell>
                  <TableCell label="Taken by" className="align-top">
                    {takenBy(g)}
                  </TableCell>
                  <TableCell label="Deal" className="align-top text-sm">
                    {g.dealReference} · {g.branchName}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
