import { Plane } from 'lucide-react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { PageHeader } from '@/components/ui/page-header';
import { QueueToolbar, type QueueChip } from '@/components/ui/queue-toolbar';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { dateRangeText, plural } from '@/lib/format';
import { parseTab } from '@/lib/parse-tab';
import { QueueNothingMatches, QueueRowButton } from '../department/queue-parts';
import {
  DEFAULT_QUEUE_SORT,
  deskQueueHref,
  deskToolbarKeep,
  matchesSearch,
  QUEUE_SORT_OPTIONS,
  sortQueue,
  type DeskQueueQuery,
  type QueueShow,
  type QueueSort,
  type RowNext,
} from '../department/queue-show';
import { budgetText, QueueEmpty, QueueShowTabs, takenByText } from '../department/task-frame';
import { chipsOf, FlightStatusBadge } from './bits';
import { shortDate } from './format';
import { FLIGHT_TEXT } from './labels';
import type { FlightQueueGroup, FlightQueueView } from './types';

/*
 * Flight queue (contract 9.1 / 11.1; UX redesign R3, C2): one row per Deal,
 * in the shared work-queue pattern (design plan 1.2): pill tabs Not taken ·
 * Mine · All with counts, one toolbar row (search, filter chips, sort), rows
 * What · Dates · Approved budget · Status · Next step · Who · Deal, and one
 * row button when the viewer can act. A Deal with two or more flights keeps
 * its native disclosure ("Show N flights"). Everything filters, searches and
 * sorts the rows the database already returned (flight_queue under the
 * viewer's session): no extra read, nothing hidden is sent, no customer price.
 *
 * Every old address keeps its rows: `?show=` (tabs) and `?only=` (Home rows,
 * now the filter chips) mean what they meant; `?q=` and `?sort=` are new.
 * The search, sort, address and row parts are shared with Purchase and Visa
 * (department/queue-show.ts, department/queue-parts.tsx).
 */

/* ---------- Flight ---------- */

export function workspaceHref(dealId: string, extra?: string): string {
  return `/app/flight/deals/${dealId}${extra ? `?${extra}` : ''}`;
}

function isNotTakenGroup(g: FlightQueueGroup): boolean {
  return !g.assignedToYou && !g.assigneeName && g.status.code === 'waiting';
}

/** Filter chips (`?only=`, server allowlist). Home rows open Mine with one of them. */
export type QueueOnly = 'booking_changed' | 'payment' | 'change_decision' | 'ready';
export const QUEUE_ONLY_LABEL: Record<QueueOnly, string> = {
  booking_changed: 'Booking changed',
  payment: 'Payment needed',
  change_decision: 'Change decisions to see',
  ready: 'Ready to mark done',
};
const QUEUE_ONLY_KEYS = Object.keys(QUEUE_ONLY_LABEL) as QueueOnly[];

export function parseQueueOnly(raw: string | string[] | undefined): QueueOnly | null {
  return parseTab<QueueOnly | ''>(raw, QUEUE_ONLY_KEYS, '') || null;
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

function routeOf(g: FlightQueueGroup): string {
  return g.flights.length === 1 ? g.flights[0]!.route : g.flights.map((f) => f.route).join(' · ');
}

/** The words the search looks in: Deal, branch, who holds it, routes and flight titles. */
export function flightSearchText(g: FlightQueueGroup): Array<string | null> {
  return [g.dealReference, g.branchName, g.assigneeName, ...g.flights.flatMap((f) => [f.route, f.title])];
}

/** First and last typed travel date of the Deal's flights, or the group's first date. */
export function flightDates(g: FlightQueueGroup): { from: string | null; to: string | null } {
  const dates = g.flights.map((f) => f.firstDate).filter((d): d is string => !!d).sort();
  return { from: dates[0] ?? g.firstDate ?? null, to: dates[dates.length - 1] ?? g.firstDate ?? null };
}

export interface FlightQueueModel {
  current: QueueShow;
  only: QueueOnly | null;
  q: string;
  sort: QueueSort;
  /** Rows of the current tab before search and chip. */
  tabRows: FlightQueueGroup[];
  /** Rows shown, in order. */
  rows: FlightQueueGroup[];
  counts: Record<QueueShow, number>;
  /** Rows behind each chip, within the current tab and search. */
  chipCounts: Record<QueueOnly, number>;
}

/** Tab, then search, then chip, then sort, over the rows already returned. Pure. */
export function flightQueueModel(
  groups: FlightQueueGroup[],
  { canTakeTasks, show, only = null, q = '', sort = DEFAULT_QUEUE_SORT }: { canTakeTasks: boolean; show: QueueShow; only?: QueueOnly | null; q?: string; sort?: QueueSort },
): FlightQueueModel {
  // A branch Manager has no tabs and sees every row (unchanged).
  const current: QueueShow = canTakeTasks ? show : 'all';
  const tabRows = filterGroups(groups, current);
  const searched = tabRows.filter((g) => matchesSearch(q, flightSearchText(g)));
  const chipCounts = Object.fromEntries(QUEUE_ONLY_KEYS.map((k) => [k, searched.filter(ONLY_TEST[k]).length])) as Record<QueueOnly, number>;
  const chipped = only ? searched.filter(ONLY_TEST[only]) : searched;
  const rows = sortQueue(chipped, sort, (g) => flightDates(g).from, (g) => g.dealReference);
  const counts = { not_taken: groups.filter(isNotTakenGroup).length, mine: filterGroups(groups, 'mine').length, all: groups.length };
  return { current, only, q, sort, tabRows, rows, counts, chipCounts };
}

/** The row's "Next step", from the queue facts (the workspace's "Next:" line says the same in more detail). */
export function flightRowNext(g: FlightQueueGroup): RowNext {
  if (g.status.code === 'done') return { text: 'Nothing waiting' };
  if (!g.assignedToYou && !g.assigneeName) {
    return g.canTake
      ? { text: 'Take these flights', button: { label: 'Review and take', href: workspaceHref(g.dealId), primary: true } }
      : { text: 'The Flight team takes these flights' };
  }
  if (!g.assignedToYou) return { text: `${g.assigneeName} works on these flights` };
  const go = (text: string): RowNext => ({ text, button: { label: 'Continue', href: workspaceHref(g.dealId, 'tab=work') } });
  if (g.chips.bookingChanged) return go('Review the booking change Sales sent');
  if (g.hasChangeDecision) return go('See the decided change');
  if (g.readyToFinish) return go('Mark the flights done');
  if (g.chips.paymentNeeded) return go('Pay or request payment for the fare');
  if (g.status.code === 'in_progress') return go('Confirm each traveller’s ticket');
  return go('Finish the steps under “Finish this flight”');
}

export function FlightQueuePage({
  queue,
  canTakeTasks,
  show,
  only = null,
  q = '',
  sort = DEFAULT_QUEUE_SORT,
}: {
  queue: FlightQueueView;
  canTakeTasks: boolean;
  show: QueueShow;
  only?: QueueOnly | null;
  q?: string;
  sort?: QueueSort;
}) {
  const all = queue.groups;
  const m = flightQueueModel(all, { canTakeTasks, show, only, q, sort });
  const query: DeskQueueQuery = { show: m.current, only: m.only, q: m.q, sort: m.sort };
  const base = '/app/flight';
  const chips: QueueChip[] = QUEUE_ONLY_KEYS.map((k) => ({
    label: QUEUE_ONLY_LABEL[k],
    count: m.chipCounts[k],
    current: m.only === k,
    href: deskQueueHref(base, canTakeTasks, { ...query, only: m.only === k ? null : k }),
  }));
  const filtered = !!(m.q || m.only);
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader
        eyebrow="Flight team"
        title="Flight tasks"
        description={
          canTakeTasks
            ? `${FLIGHT_TEXT.queueNote} ${FLIGHT_TEXT.noMoney}`
            : `Your branches’ flights. You can follow them here; the Flight team works on them. ${FLIGHT_TEXT.noMoney}`
        }
      />
      {canTakeTasks ? (
        <QueueShowTabs basePath={base} show={m.current} canTakeTasks counts={m.counts} label="Flight task filters" keep={{ q: m.q, sort: m.sort }} variant="pill" />
      ) : null}
      <QueueToolbar
        action={base}
        label="Search, filter and sort flight tasks"
        chipsLabel="Show only"
        keep={deskToolbarKeep(canTakeTasks, query)}
        search={{ name: 'q', value: m.q, label: 'Search flight tasks', placeholder: 'Deal, route, branch or colleague' }}
        chips={chips}
        sort={{ name: 'sort', value: m.sort, options: QUEUE_SORT_OPTIONS }}
      />
      <Card>
        {m.rows.length === 0 ? (
          <div role="status">
            {filtered && m.tabRows.length > 0 ? (
              <QueueNothingMatches clearHref={deskQueueHref(base, canTakeTasks, { show: m.current, sort: m.sort })} />
            ) : (
              <QueueEmpty icon={Plane} anyTasks={all.length > 0} show={m.current} serviceWords="a flight" />
            )}
          </div>
        ) : (
          <Table stackOnMobile label="Flight tasks table" wrapperClassName="rounded-card">
            <TableCaption className="caption-top border-b border-line py-3 font-medium text-copy max-sm:block">
              {plural(m.rows.length, 'Deal')} with flights{filtered ? ` (of ${m.tabRows.length} on this tab)` : ''}
            </TableCaption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>What</TableHead>
                <TableHead>Dates</TableHead>
                <TableHead numeric>Approved budget</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Next step</TableHead>
                <TableHead>Who</TableHead>
                <TableHead>Deal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {m.rows.map((g) => (
                <FlightRow key={g.dealId} g={g} />
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function FlightRow({ g }: { g: FlightQueueGroup }) {
  const { from, to } = flightDates(g);
  const onlyScreenshots = g.flights.length > 0 && g.flights.every((f) => f.entryMode === 'screenshot');
  const next = flightRowNext(g);
  // One status badge; the other facts as plain words beside it (design plan 1.2), not more stacked badges.
  const second = chipsOf(g.chips).map((c) => c.text).join(' · ');
  return (
    <TableRow className="align-top">
      <TableCell label="What" className="align-top">
        <span className="flex flex-col items-start gap-0.5">
          <Link href={workspaceHref(g.dealId)} className={cn('rounded-chip font-semibold wrap-anywhere text-brand-strong underline-offset-4 hover:text-brand-deep', focusRing)}>
            {routeOf(g)}
            <span className="sr-only"> — open the flights of {g.dealReference}</span>
          </Link>
          {g.flights.length > 1 ? (
            <details className="text-sm">
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
          ) : (
            <span className="text-sm text-quiet">1 flight</span>
          )}
        </span>
      </TableCell>
      <TableCell label="Dates" className="align-top">
        <span className="block whitespace-nowrap">{from ? dateRangeText(from, to) : onlyScreenshots ? 'From screenshot' : 'Date not typed yet'}</span>
        {typeof g.travellerCount === 'number' ? <span className="block text-sm text-quiet">{plural(g.travellerCount, 'traveller')}</span> : null}
      </TableCell>
      <TableCell label="Approved budget" numeric className="align-top whitespace-nowrap">
        {budgetText(g.budgetPaise)}
      </TableCell>
      <TableCell label="Status" className="align-top">
        <span className="flex flex-col items-start gap-1 max-sm:items-end">
          <FlightStatusBadge status={g.status} />
          {second ? <span className="text-sm text-copy">{second}</span> : null}
        </span>
      </TableCell>
      <TableCell label="Next step" className="align-top max-sm:flex-col max-sm:items-stretch max-sm:text-left">
        <span className="flex flex-col items-start gap-2 max-sm:items-stretch">
          <span className="text-sm text-copy">{next.text}</span>
          {next.button ? <QueueRowButton href={next.button.href} label={next.button.label} context={`flights of ${g.dealReference}`} primary={next.button.primary} /> : null}
        </span>
      </TableCell>
      <TableCell label="Who" className="align-top">
        {takenByText(g)}
      </TableCell>
      <TableCell label="Deal" className="align-top text-sm">
        <span className="block whitespace-nowrap">{g.dealReference}</span>
        <span className="block text-quiet">{g.branchName}</span>
      </TableCell>
    </TableRow>
  );
}
