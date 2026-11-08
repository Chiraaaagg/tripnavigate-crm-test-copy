import { Eye, Stamp } from 'lucide-react';
import { StatusBadge } from '@/components/ui/badge';
import Link from 'next/link';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { InternalTaskLine, QueueEmpty, QueueShowTabs } from '../department/task-frame';
import type { QueueShow } from '../department/queue-show';
import { VisaStatusBadge } from './bits';
import { plural } from './labels';
import type { VisaQueueTask, VisaQueueView } from './types';

/*
 * Visa and passport queue (contract 9.1 / 11.1, HTML visaQueue H:14558): one
 * row per task with its title link, facts line, Deal · branch · passengers ·
 * "Taken by", and the status words with the current step. Tabs Not taken ·
 * Mine · All for the desk; the branch Manager gets Not taken · All, read-only
 * (no Take anywhere on the list). Rows stack at 375 px.
 */

export function isNotTakenTask(t: VisaQueueTask): boolean {
  return !t.assignedToYou && !t.assigneeName && t.status.code === 'not_taken';
}

export function filterVisaTasks(tasks: VisaQueueTask[], show: QueueShow): VisaQueueTask[] {
  if (show === 'mine') return tasks.filter((t) => t.assignedToYou);
  if (show === 'not_taken') return tasks.filter(isNotTakenTask);
  return tasks;
}

function takenBy(t: VisaQueueTask): string {
  if (t.assignedToYou) return 'You';
  return t.assigneeName ?? 'Not taken yet';
}

/**
 * Per task, not per page (Track B per-task flags): a person can hold the Visa role in one entity and be
 * a branch Manager in another. The desk tabs (with Mine) show when any task is a desk task; the
 * view-only line shows only when every task is a Manager view; a Manager-view row says "View only".
 */
export function isDeskViewer(queue: VisaQueueView): boolean {
  return queue.tasks.length > 0 ? queue.tasks.some((t) => !t.isManagerView) : !queue.isManagerView;
}

export function VisaQueuePage({ queue, show }: { queue: VisaQueueView; show: QueueShow }) {
  const canTake = isDeskViewer(queue);
  const current: QueueShow = !canTake && show === 'mine' ? 'all' : show;
  const all = queue.tasks;
  const rows = filterVisaTasks(all, current);
  const counts = { not_taken: all.filter(isNotTakenTask).length, mine: all.filter((t) => t.assignedToYou).length, all: all.length };
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
      <QueueShowTabs basePath="/app/visa" show={current} canTakeTasks={canTake} counts={counts} label="Visa and passport task filters" />
      <Card>
        <section aria-labelledby="visa-queue-heading">
          <CardHeader>
            <CardTitle id="visa-queue-heading">Tasks</CardTitle>
            <span className="text-sm text-quiet">{plural(rows.length, 'task')}</span>
          </CardHeader>
          {rows.length === 0 ? (
            <div role="status">
              <QueueEmpty icon={Stamp} anyTasks={all.length > 0} show={current} serviceWords="a visa or passport service" />
            </div>
          ) : (
            <ol className="m-0 flex list-none flex-col divide-y divide-line p-0" aria-label="Visa and passport tasks">
              {rows.map((t) => (
                <li key={t.taskId} className="m-0 flex flex-col gap-2 px-4.5 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                  <div className="min-w-0">
                    <p className="m-0 font-semibold text-ink">
                      <Link href={`/app/visa/${t.taskId}`} className={cn('rounded-chip wrap-anywhere text-brand-strong underline underline-offset-4 hover:text-brand-deep', focusRing)}>
                        {t.serviceType === 'passport' ? 'Passport' : 'Visa'} · {t.title}
                      </Link>
                    </p>
                    <p className="m-0 text-sm wrap-anywhere text-copy">{t.factsLine}</p>
                    <p className="m-0 text-sm text-quiet">
                      {t.dealReference} · {t.branchName} · {plural(t.applicantCount, 'passenger')} · Taken by: {takenBy(t)}
                      {t.status.code === 'in_progress' && t.applicantCount > 0 ? ` · ${t.appliedCount} of ${t.applicantCount} applied` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <VisaStatusBadge status={t.status} />
                    {canTake && t.isManagerView ? (
                      <StatusBadge tone="neutral" icon={Eye}>
                        View only
                      </StatusBadge>
                    ) : null}
                    {t.canTake ? <span className="sr-only">You can take this task.</span> : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </Card>
    </div>
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
        <Skeleton className="h-10 w-80 max-w-full" />
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
