import { Stamp } from 'lucide-react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { cn, focusRing } from '@/components/ui/cn';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { QueueToolbar, type QueueChip } from '@/components/ui/queue-toolbar';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { dayText, plural } from '@/lib/format';
import { parseTab } from '@/lib/parse-tab';
import { VISA_TEXT } from '@/modules/fulfilment/contracts';
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
import { InternalTaskLine, QueueEmpty, QueueShowTabs, takenByText } from '../department/task-frame';
import { VisaStatusBadge } from './bits';
import { STEP_NEXT_TEXT, STEP_STATUS_TEXT } from './labels';
import type { VisaQueueTask, VisaQueueView } from './types';

/*
 * Visa and passport queue (contract 9.1 / 11.1; UX redesign R3, C2): the
 * shared work-queue pattern (design plan 1.2), the same as the Flight and
 * Purchase desks: pill tabs Not taken · Mine · All with counts for the desk
 * (the branch Manager gets Not taken · All, read-only, no row button), one
 * toolbar row (search, filter chips by step, sort by travel date), and a
 * table What · Dates · Status · Next step · Who · Deal that stacks into
 * labelled cards on phones. It filters the rows visa_queue already returned
 * for this viewer: no extra read, no money, no passport number.
 *
 * Every old address keeps its rows: `?show=` means what it meant; `?only=`,
 * `?q=` and `?sort=` are new.
 */

export function isNotTakenTask(t: VisaQueueTask): boolean {
  return !t.assignedToYou && !t.assigneeName && t.status.code === 'not_taken';
}

export function filterVisaTasks(tasks: VisaQueueTask[], show: QueueShow): VisaQueueTask[] {
  if (show === 'mine') return tasks.filter((t) => t.assignedToYou);
  if (show === 'not_taken') return tasks.filter(isNotTakenTask);
  return tasks;
}

/**
 * Per task, not per page (Track B per-task flags): a person can hold the Visa role in one entity and be
 * a branch Manager in another. The desk tabs (with Mine) show when any task is a desk task; the
 * view-only line shows only when every task is a Manager view; a Manager-view row says "View only".
 */
export function isDeskViewer(queue: VisaQueueView): boolean {
  return queue.tasks.length > 0 ? queue.tasks.some((t) => !t.isManagerView) : !queue.isManagerView;
}

/** Filter chips (`?only=`, server allowlist): the open step, or completed. */
export type VisaQueueOnly = 'ready' | 'applied' | 'decision' | 'handover' | 'completed';
export const VISA_ONLY_LABEL: Record<VisaQueueOnly, string> = {
  ready: STEP_STATUS_TEXT.ready,
  applied: STEP_STATUS_TEXT.applied,
  decision: STEP_STATUS_TEXT.decision,
  handover: STEP_STATUS_TEXT.handover,
  completed: 'Completed',
};
const VISA_ONLY_KEYS = Object.keys(VISA_ONLY_LABEL) as VisaQueueOnly[];

export function parseVisaQueueOnly(raw: string | string[] | undefined): VisaQueueOnly | null {
  return parseTab<VisaQueueOnly | ''>(raw, VISA_ONLY_KEYS, '') || null;
}

function onlyTest(only: VisaQueueOnly, t: VisaQueueTask): boolean {
  if (only === 'completed') return t.status.code === 'completed';
  return t.status.code === 'in_progress' && t.status.step === only;
}

function kindWord(t: VisaQueueTask): string {
  return t.serviceType === 'passport' ? 'Passport' : 'Visa';
}

/** The words the search looks in: kind, title, facts, Deal, branch and who holds it. */
export function visaSearchText(t: VisaQueueTask): Array<string | null> {
  return [kindWord(t), t.title, t.factsLine, t.dealReference, t.branchName, t.assigneeName];
}

export interface VisaQueueModel {
  canTake: boolean;
  current: QueueShow;
  only: VisaQueueOnly | null;
  q: string;
  sort: QueueSort;
  tabRows: VisaQueueTask[];
  rows: VisaQueueTask[];
  counts: Record<QueueShow, number>;
  chipCounts: Record<VisaQueueOnly, number>;
}

/** Tab, then search, then chip, then sort, over the rows already returned. Pure. */
export function visaQueueModel(
  queue: VisaQueueView,
  { show, only = null, q = '', sort = DEFAULT_QUEUE_SORT }: { show: QueueShow; only?: VisaQueueOnly | null; q?: string; sort?: QueueSort },
): VisaQueueModel {
  const canTake = isDeskViewer(queue);
  const current: QueueShow = !canTake && show === 'mine' ? 'all' : show;
  const all = queue.tasks;
  const tabRows = filterVisaTasks(all, current);
  const searched = tabRows.filter((t) => matchesSearch(q, visaSearchText(t)));
  const chipCounts = Object.fromEntries(VISA_ONLY_KEYS.map((k) => [k, searched.filter((t) => onlyTest(k, t)).length])) as Record<VisaQueueOnly, number>;
  const chipped = only ? searched.filter((t) => onlyTest(only, t)) : searched;
  const rows = sortQueue(chipped, sort, (t) => t.travelDate, (t) => t.dealReference);
  const counts = { not_taken: all.filter(isNotTakenTask).length, mine: all.filter((t) => t.assignedToYou).length, all: all.length };
  return { canTake, current, only, q, sort, tabRows, rows, counts, chipCounts };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The row's "Next step" (the task page's "Next:" line in the same words). Manager-view rows get no button. */
export function visaRowNext(t: VisaQueueTask): RowNext {
  if (t.status.code === 'completed') return { text: 'Nothing waiting' };
  if (!t.assignedToYou && !t.assigneeName) {
    return t.canTake && !t.isManagerView
      ? { text: 'Take this task', button: { label: 'Review and take', href: `/app/visa/${t.taskId}`, primary: true } }
      : { text: 'The Visa and passport desk takes this task' };
  }
  if (!t.assignedToYou) return { text: `${t.assigneeName ?? 'Another staff member'} works on this task` };
  return {
    text: t.status.step ? cap(STEP_NEXT_TEXT[t.status.step]) : 'Finish the steps on the Work tab',
    button: { label: 'Continue', href: `/app/visa/${t.taskId}?tab=work` },
  };
}

export function VisaQueuePage({
  queue,
  show,
  only = null,
  q = '',
  sort = DEFAULT_QUEUE_SORT,
}: {
  queue: VisaQueueView;
  show: QueueShow;
  only?: VisaQueueOnly | null;
  q?: string;
  sort?: QueueSort;
}) {
  const m = visaQueueModel(queue, { show, only, q, sort });
  const { canTake } = m;
  const all = queue.tasks;
  const base = '/app/visa';
  const query: DeskQueueQuery = { show: m.current, only: m.only, q: m.q, sort: m.sort };
  const chips: QueueChip[] = VISA_ONLY_KEYS.map((k) => ({
    label: VISA_ONLY_LABEL[k],
    count: m.chipCounts[k],
    current: m.only === k,
    href: deskQueueHref(base, canTake, { ...query, only: m.only === k ? null : k }),
  }));
  const filtered = !!(m.q || m.only);
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader
        eyebrow="Visa and passport desk"
        title="Visa and passport tasks"
        description={!canTake ? 'Your branches’ visa and passport tasks. You can follow them here; the Visa desk does the work.' : 'Visa and passport tasks from accepted bookings.'}
      />
      {!canTake ? (
        <div className="mb-4">
          <InternalTaskLine>View only. The Visa desk takes and works on these tasks.</InternalTaskLine>
        </div>
      ) : null}
      {queue.launch === 'off' ? (
        <Notice tone="warning" className="mb-4" title="Not started yet">
          <p>{VISA_TEXT.notLaunched}</p>
          {queue.waitingCount !== null ? <p>{plural(queue.waitingCount, 'sold service')} {queue.waitingCount === 1 ? 'is' : 'are'} waiting.</p> : null}
        </Notice>
      ) : queue.launch === 'unknown' ? (
        // Unknown is never shown as "Not started yet" (DA-255: Unknown is not Off).
        <Notice tone="warning" className="mb-4" title="Desk state could not be read">
          <p>{VISA_TEXT.launchUnknown}</p>
        </Notice>
      ) : null}
      <QueueShowTabs basePath={base} show={m.current} canTakeTasks={canTake} counts={m.counts} label="Visa and passport task filters" keep={{ q: m.q, sort: m.sort }} variant="pill" />
      {all.length > 0 ? (
        <QueueToolbar
          action={base}
          label="Search, filter and sort visa and passport tasks"
          chipsLabel="Show only"
          keep={deskToolbarKeep(canTake, query)}
          search={{ name: 'q', value: m.q, label: 'Search visa and passport tasks', placeholder: 'Deal, country, branch or colleague' }}
          chips={chips}
          sort={{ name: 'sort', value: m.sort, options: QUEUE_SORT_OPTIONS }}
        />
      ) : null}
      <Card>
        {m.rows.length === 0 ? (
          <div role="status">
            {filtered && m.tabRows.length > 0 ? (
              <QueueNothingMatches clearHref={deskQueueHref(base, canTake, { show: m.current, sort: m.sort })} />
            ) : queue.launch === 'off' && all.length === 0 ? (
              <EmptyState icon={Stamp} headingLevel={2} title="No tasks yet" description="Tasks appear once the desk is started." />
            ) : (
              <QueueEmpty icon={Stamp} anyTasks={all.length > 0} show={m.current} serviceWords="a visa or passport service" />
            )}
          </div>
        ) : (
          <Table stackOnMobile label="Visa and passport tasks" wrapperClassName="rounded-card">
            <TableCaption className="caption-top border-b border-line py-3 font-medium text-copy max-sm:block">
              {plural(m.rows.length, 'task')}
              {filtered ? ` (of ${m.tabRows.length} on this tab)` : ''}
            </TableCaption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>What</TableHead>
                <TableHead>Dates</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Next step</TableHead>
                <TableHead>Who</TableHead>
                <TableHead>Deal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {m.rows.map((t) => (
                <VisaRow key={t.taskId} t={t} markViewOnly={canTake && t.isManagerView} />
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function VisaRow({ t, markViewOnly }: { t: VisaQueueTask; markViewOnly: boolean }) {
  const next = visaRowNext(t);
  // One status badge; progress and "View only" as plain words beside it (design plan 1.2).
  const second = [t.status.code === 'in_progress' && t.applicantCount > 0 ? `${t.appliedCount} of ${t.applicantCount} applied` : null, markViewOnly ? 'View only' : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <TableRow className="align-top">
      <TableCell label="What" className="align-top">
        <span className="flex flex-col items-start gap-0.5">
          <Link href={`/app/visa/${t.taskId}`} className={cn('rounded-chip font-semibold wrap-anywhere text-brand-strong underline-offset-4 hover:text-brand-deep', focusRing)}>
            {kindWord(t)} · {t.title}
          </Link>
          {t.factsLine ? <span className="text-sm wrap-anywhere text-quiet">{t.factsLine}</span> : null}
        </span>
      </TableCell>
      <TableCell label="Dates" className="align-top">
        <span className="block whitespace-nowrap">{t.travelDate ? `Travel ${dayText(t.travelDate)}` : 'Travel date not set'}</span>
        <span className="block text-sm text-quiet">{plural(t.applicantCount, 'passenger')}</span>
      </TableCell>
      <TableCell label="Status" className="align-top">
        <span className="flex flex-col items-start gap-1 max-sm:items-end">
          <VisaStatusBadge status={t.status} />
          {second ? <span className="text-sm text-copy">{second}</span> : null}
        </span>
      </TableCell>
      <TableCell label="Next step" className="align-top max-sm:flex-col max-sm:items-stretch max-sm:text-left">
        <span className="flex flex-col items-start gap-2 max-sm:items-stretch">
          <span className="text-sm text-copy">{next.text}</span>
          {next.button ? <QueueRowButton href={next.button.href} label={next.button.label} context={`${kindWord(t)} · ${t.title}, ${t.dealReference}`} primary={next.button.primary} /> : null}
        </span>
      </TableCell>
      <TableCell label="Who" className="align-top">
        {takenByText(t)}
      </TableCell>
      <TableCell label="Deal" className="align-top text-sm">
        <span className="block whitespace-nowrap">{t.dealReference}</span>
        <span className="block text-quiet">{t.branchName}</span>
      </TableCell>
    </TableRow>
  );
}

export function VisaQueueLoading() {
  return (
    <div className="flex flex-col gap-4 font-sans">
      <h1 className="sr-only">Visa and passport tasks</h1>
      <p role="status" aria-live="polite" className="m-0 text-sm font-medium text-quiet">
        Loading the visa and passport tasks…
      </p>
      <div aria-busy="true" className="flex flex-col gap-4">
        <Skeleton className="h-7 w-64 max-w-full" />
        <Skeleton className="h-10 w-72 max-w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}

/** A read that failed (never shown as "no tasks"). */
export function VisaQueueError() {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader eyebrow="Visa and passport desk" title="Visa and passport tasks" />
      <Card role="alert">
        <p className="m-0 px-4.5 py-4 text-copy">The tasks could not be loaded just now. Nothing was changed. Reload the page; if it keeps happening, tell your admin.</p>
      </Card>
    </div>
  );
}
