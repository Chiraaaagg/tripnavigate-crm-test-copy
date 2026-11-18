import { ChevronLeft, FileQuestion, Plane } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  ERROR_TEXT,
  type FlightQueueView,
  type FlightTaskView,
} from '@/modules/fulfilment/contracts';
import { tabHref, type DepartmentTaskTabsVM, type TaskHistoryVM } from '@/modules/settings/contracts';
import { filterQueue, isNotTaken, parseQueueShow, type QueueShow } from './department/queue-show';
import {
  budgetText,
  InternalTaskLine,
  QueueEmpty,
  QueueShowTabs,
  TaskBackLink,
  TaskFilesPanel,
  TaskHistoryPanel,
  TaskNextLine,
  TaskStatusBadge,
  TaskTabsNav,
  takenByText,
  taskNextText,
  type TaskFilesVM,
} from './department/task-frame';
import { formatIst } from './deal-labels';
import { ClaimFlightTaskForm, type FlightAction } from './flight-forms';
import type { UiResult } from './booking-forms';
import { FactsBlock, segmentText } from './service-labels';
import { formatInr } from '@/modules/fulfilment/booking-form-model';

/*
 * Flight queue and task (B1, minimal, Lagoon): list, take, facts. Ticket
 * evidence and extraction come with B5. The DTOs carry no selling price,
 * margin, acceptance proof or other departments' budgets; these views add
 * none. Patterns (21st.dev, ideas only, nothing copied): a quiet data table in
 * a card with status pills (shadcn 1050 / originui 89, as the Deals list) and
 * a record page with facts beside the work (kavikatiyar 8248, as the Deal page).
 */

/** DA-317a (amends DA-280): states the process; the CRM has no ticket step. */
export const FLIGHT_INTERNAL_TEXT = 'Internal task. Tickets are issued outside the CRM.';
/** DA-316 (amends DA-273 list line). */
export const FLIGHT_QUEUE_NOTE = 'Flight tasks from submitted bookings. Issue each ticket outside the CRM, then record the fare on the task.';

/** DA-317b: what the CRM stored for a confirmed flight task (a supplier confirmation, never "ticket issued"). */
export function flightConfirmedText(confirmedAt: string | null | undefined): string {
  return confirmedAt
    ? `Internal task. Supplier confirmation recorded on ${formatIst(confirmedAt)}. No payment, bill or invoice was created by the CRM.`
    : 'Internal task. Supplier confirmation recorded. No payment, bill or invoice was created by the CRM.';
}

export function FlightQueuePage({
  queue,
  canTakeTasks,
  show,
}: {
  queue: FlightQueueView;
  /** The viewer holds the Flight role. Managers only follow progress. */
  canTakeTasks: boolean;
  /** Batch 4: `?show=` (parseQueueShow). Omitted = the default tab. */
  show?: QueueShow;
}) {
  const current = show ?? parseQueueShow(undefined, canTakeTasks);
  const all = queue.tasks;
  const tasks = filterQueue(all, current);
  const counts = { not_taken: all.filter(isNotTaken).length, mine: all.filter((t) => t.assignedToYou).length, all: all.length };
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader eyebrow="Flight team" title="Flight tasks" description={FLIGHT_QUEUE_NOTE} />
      <div className="mb-4">
        <InternalTaskLine>Customer prices and proof files are never shown here.</InternalTaskLine>
      </div>
      <QueueShowTabs basePath="/app/flight" show={current} canTakeTasks={canTakeTasks} counts={counts} label="Flight task filters" />
      <Card>
        {tasks.length === 0 ? (
          <div role="status">
            <QueueEmpty icon={Plane} anyTasks={all.length > 0} show={current} serviceWords="a flight" />
          </div>
        ) : (
          <Table stackOnMobile label="Flight tasks table" wrapperClassName="rounded-card">
            <TableCaption className="caption-top border-b border-line py-3 font-medium text-copy max-sm:block">
              {tasks.length} flight {tasks.length === 1 ? 'task' : 'tasks'}
            </TableCaption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Route</TableHead>
                <TableHead>Segments</TableHead>
                <TableHead>Passengers</TableHead>
                <TableHead>Approved budget</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Taken by</TableHead>
                <TableHead>Deal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((t) => (
                <TableRow key={t.taskId} className="align-top">
                  <TableCell label="Route" className="align-top">
                    <Link href={`/app/flight/${t.taskId}`} className={cn('rounded-chip font-semibold text-brand-strong underline-offset-4 hover:text-brand-deep', focusRing)}>
                      {t.itemTitle}
                      <span className="sr-only"> — open task</span>
                    </Link>
                  </TableCell>
                  <TableCell label="Segments" className="align-top text-sm">
                    {screenshotOf(t.facts) ? (
                      <span>
                        From screenshot
                        {screenshotOf(t.facts)!.note ? <span className="block text-quiet">{screenshotOf(t.facts)!.note}</span> : null}
                      </span>
                    ) : (
                      <ul className="m-0 list-none p-0">
                        {(t.facts.segments ?? []).map((s, i) => (
                          <li key={i} className="m-0 whitespace-nowrap">
                            {segmentText(s)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </TableCell>
                  <TableCell label="Passengers" className="align-top tabular-nums">
                    {t.facts.passengers}
                  </TableCell>
                  <TableCell label="Approved budget" className="align-top whitespace-nowrap tabular-nums">
                    {budgetText(t.purchaseBudgetPaise)}
                  </TableCell>
                  <TableCell label="Status" className="align-top">
                    <TaskStatusBadge department="flight" status={t.status} wrap />
                  </TableCell>
                  <TableCell label="Taken by" className="align-top">
                    {takenByText(t)}
                  </TableCell>
                  <TableCell label="Deal" className="align-top text-sm">
                    {t.dealReference} · {t.branchName}
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

/** Book now v2: a flight added from a screenshot (no typed legs) and its note. */
function screenshotOf(facts: unknown): { note: string | null } | null {
  const f = (facts ?? {}) as { entryMode?: string; screenshotNote?: string | null };
  if (f.entryMode !== 'screenshot') return null;
  return { note: f.screenshotNote?.trim() || null };
}

/** Book now v2 (change 18): fare per person on this flight and the typed totals for all flights; older flights keep the total. */
function FareLines({ task }: { task: FlightTaskView }) {
  const e = task.estimate?.estimate;
  const fare = e && e.kind === 'flight' ? e : null;
  const per = fare ? ([['Adult', fare.fareAdultPaise], ['Child', fare.fareChildPaise], ['Infant', fare.fareInfantPaise]] as const).filter(([, p]) => p) : [];
  const totals = (task as FlightTaskView & { fareTotals?: { adultPaise: string | null; childPaise: string | null; infantPaise: string | null } | null }).fareTotals ?? null;
  const typed = totals ? ([['Adult', totals.adultPaise], ['Child', totals.childPaise], ['Infant', totals.infantPaise]] as const).filter(([, p]) => p) : [];
  return (
    <>
      <dt className="text-sm font-medium text-quiet">{per.length > 0 ? 'Fare per person' : 'Estimated fare (total)'}</dt>
      <dd className="m-0 text-ink">
        {per.length > 0 ? (
          <span className="tabular-nums">{per.map(([l, p]) => `${l} ${formatInr(p)}`).join(' · ')}</span>
        ) : (
          // A flight saved before per-person fares keeps its total.
          <span className="whitespace-nowrap tabular-nums">{formatInr(fare?.fareTotalPaise ?? task.estimate?.totalPaise ?? null, 'Not priced')}</span>
        )}
        {typed.length > 0 ? <span className="block tabular-nums">All flights, per person: {typed.map(([l, p]) => `${l} ${formatInr(p)}`).join(' · ')}</span> : null}
        <span className="block text-sm text-quiet">An estimate of our cost only. It is not a price, a budget or a booking.</span>
      </dd>
    </>
  );
}

const dlClass = 'm-0 grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(7rem,10rem)_1fr]';

function FlightDetails({ task, idProofs }: { task: FlightTaskView; idProofs?: ReactNode }) {
  return (
    <div className="grid items-start gap-5 md:grid-cols-2">
      <Card>
        <section aria-labelledby="flight-facts-heading">
          <CardHeader>
            <CardTitle id="flight-facts-heading">Flight details</CardTitle>
            <Plane aria-hidden="true" className="size-4 text-faint" />
          </CardHeader>
          <CardBody>
            <FactsBlock facts={{ type: 'flight', facts: task.facts }} />
          </CardBody>
        </section>
      </Card>
      <Card>
        <section aria-labelledby="flight-budget-heading">
          <CardHeader>
            <CardTitle id="flight-budget-heading">Travellers and budget</CardTitle>
          </CardHeader>
          <CardBody>
            <dl className={dlClass}>
              <dt className="text-sm font-medium text-quiet">Travellers on the accepted version</dt>
              <dd className="m-0 text-ink tabular-nums">{task.travellerCount}</dd>
              <dt className="text-sm font-medium text-quiet">Approved budget</dt>
              <dd className="m-0 whitespace-nowrap text-ink tabular-nums">{budgetText(task.purchaseBudgetPaise)}</dd>
              {task.estimate ? <FareLines task={task} /> : null}
            </dl>
            {screenshotOf(task.facts) ? (
              <div className="mt-3 rounded-control border border-line bg-wash px-3.5 py-3 text-sm text-copy">
                <p className="m-0 font-semibold text-ink">From screenshot</p>
                <p className="m-0">Sales attached the chosen flight or fare quote instead of typing the details. Book from the screenshots below.</p>
                {screenshotOf(task.facts)!.note ? <p className="m-0 mt-[0.25rem]">Note for the Flight team: {screenshotOf(task.facts)!.note}</p> : null}
                {!task.files || task.files.length === 0 ? <p className="m-0 mt-[0.25rem] text-quiet">The screenshots are shown to the Flight colleague who takes this task.</p> : null}
              </div>
            ) : null}
            {task.files && task.files.length > 0 ? (
              <ul className="m-0 mt-3 flex list-none flex-col gap-1.5 p-0" aria-label="Flight screenshots">
                {task.files.map((f) => (
                  <li key={f.fileId} className="flex flex-wrap items-center gap-x-2 text-sm wrap-anywhere">
                    <a href={f.downloadHref} className={cn('rounded-chip font-medium text-brand-strong underline underline-offset-4', focusRing)}>
                      {f.fileName}
                    </a>
                    <span className="text-quiet">{f.sizeLabel}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {task.participants && task.participants.length > 0 ? (
              <ul className="m-0 mt-3 flex list-none flex-col gap-1 p-0" aria-label="Travellers on this flight">
                {task.participants.map((p) => (
                  <li key={p.seq} className="text-copy">
                    {p.fullName} <span className="text-sm text-quiet">({p.type}{p.ageYears !== null && p.ageYears !== undefined ? `, ${p.ageYears}` : ''})</span>
                    {p.specialNeeds ? <span className="block text-sm text-quiet">Needs: {p.specialNeeds}</span> : null}
                    {/* Freeze §3.4 answer 6: the assigned Flight person on an international trip sees identity in full. */}
                    {p.identity ? (
                      <span className="block text-sm text-copy">
                        Born {p.identity.dateOfBirth ?? 'not given'} · {p.identity.nationality ?? 'nationality not given'} · passport {p.identity.passportNumber ?? 'not given yet'}
                        {p.identity.passportExpiry ? `, expires ${p.identity.passportExpiry}` : ''}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 mt-3 text-sm text-quiet">Traveller names are not shown to the Flight team in this version.</p>
            )}
          </CardBody>
        </section>
      </Card>
      <Card className="md:col-span-2">
        <section aria-labelledby="flight-origin-heading">
          <CardHeader>
            <CardTitle id="flight-origin-heading">Where this came from</CardTitle>
          </CardHeader>
          <CardBody>
            <dl className={dlClass}>
              <dt className="text-sm font-medium text-quiet">Deal</dt>
              <dd className="m-0 text-ink">{task.dealReference}</dd>
              <dt className="text-sm font-medium text-quiet">Branch</dt>
              <dd className="m-0 text-ink">{task.branchName}</dd>
              <dt className="text-sm font-medium text-quiet">Accepted version</dt>
              <dd className="m-0 text-ink">{task.versionNo}</dd>
              <dt className="text-sm font-medium text-quiet">Saved</dt>
              <dd className="m-0 text-ink">
                {formatIst(task.confirmedAt)} by {task.confirmedByName}
              </dd>
              <dt className="text-sm font-medium text-quiet">Task created</dt>
              <dd className="m-0 text-ink">{formatIst(task.createdAt)}</dd>
            </dl>
          </CardBody>
        </section>
      </Card>
      {idProofs ? <div className="md:col-span-2">{idProofs}</div> : null}
    </div>
  );
}

export function FlightTaskPage({
  task,
  claimAction,
  claimInitialState,
  workForm,
  tabs,
  idProofs,
  files,
  history,
}: {
  task: FlightTaskView;
  claimAction: FlightAction;
  /** Preview gallery only. */
  claimInitialState?: UiResult | null;
  /** Work tab: the shared department cost block (fare paid, paid by, direct-payment proof). */
  workForm?: ReactNode;
  /** Batch 4 tabs. Omitted = the one long page of before. [] = status only. */
  tabs?: DepartmentTaskTabsVM;
  /** Details tab: "Traveller ID proofs" (assignee only, DEC-41). */
  idProofs?: ReactNode;
  /** Files tab content (only when Files is open). */
  files?: TaskFilesVM;
  /** History tab content (only when History is open). */
  history?: TaskHistoryVM | null;
}) {
  const basePath = `/app/flight/${task.taskId}`;
  const current = tabs?.current ?? 'details';
  const showClaim = task.canClaim && !task.assignedToYou && !task.assigneeName;
  const workLink =
    tabs && tabs.tabs.includes('work') && current !== 'work' && task.assignedToYou && task.status === 'in_progress' ? (
      <Link href={tabHref(basePath, 'work', 'details')} className={buttonVariants({ variant: 'primary', size: 'lg' })}>
        Record the fare
      </Link>
    ) : null;
  return (
    <div className="font-sans text-base text-copy">
      <TaskBackLink href="/app/flight">Back to Flight tasks</TaskBackLink>
      <PageHeader
        eyebrow={`Flight task · ${task.dealReference}`}
        title={<span className="block wrap-anywhere">{task.itemTitle}</span>}
        status={
          <>
            <TaskStatusBadge department="flight" status={task.status} wrap />
            <span className="text-copy">Taken by: {takenByText(task)}</span>
          </>
        }
        actions={
          task.canClaim ? <ClaimFlightTaskForm taskId={task.taskId} canTake={showClaim} action={claimAction} initialState={claimInitialState ?? null} /> : (workLink ?? undefined)
        }
        className="mb-3"
      />
      <TaskNextLine text={taskNextText({ department: 'flight', status: task.status, assignedToYou: task.assignedToYou, assigneeName: task.assigneeName, canClaim: task.canClaim })}>
        <InternalTaskLine>
          {task.status === 'supplier_confirmed' ? flightConfirmedText(task.supplierConfirmedAt) : FLIGHT_INTERNAL_TEXT}{' '}
          {task.assignedToYou && task.status !== 'supplier_confirmed' ? 'Taking the task did not book the flight. ' : ''}
          Nothing has been sent to the airline or the customer by the CRM.
        </InternalTaskLine>
      </TaskNextLine>
      {tabs ? <TaskTabsNav basePath={basePath} tabs={tabs} /> : null}
      {!tabs ? (
        <>
          <FlightDetails task={task} idProofs={idProofs} />
          {workForm ? <div className="mt-5">{workForm}</div> : null}
        </>
      ) : current === 'work' ? (
        (workForm ?? null)
      ) : current === 'files' ? (
        <TaskFilesPanel files={files ?? {}} />
      ) : current === 'history' && history ? (
        <TaskHistoryPanel history={history} />
      ) : (
        <FlightDetails task={task} idProofs={idProofs} />
      )}
    </div>
  );
}

export function FlightTaskNotFoundView() {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader title="Task not available" />
      <Card role="status">
        <div className="flex items-start gap-3 px-4.5 py-4">
          <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-control bg-brand-tint text-brand">
            <FileQuestion className="size-4.5" />
          </span>
          <p className="m-0 self-center text-copy">{ERROR_TEXT.not_found}</p>
        </div>
      </Card>
      <p className="m-0 mt-4">
        <Link href="/app/flight" className={buttonVariants({ variant: 'secondary' })}>
          <ChevronLeft aria-hidden="true" />
          Back to Flight tasks
        </Link>
      </p>
    </div>
  );
}

export function FlightQueueLoading() {
  return (
    <div className="flex flex-col gap-4 font-sans">
      <h1 className="sr-only">Flight tasks</h1>
      <p role="status" aria-live="polite" className="m-0 text-sm font-medium text-quiet">
        Loading flight tasks…
      </p>
      <div aria-busy="true" className="flex flex-col gap-4">
        <Skeleton className="h-7 w-40 max-w-full" />
        <Skeleton className="h-4 w-full max-w-xl" />
        <div className="rounded-card border border-line bg-card shadow-card">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex items-center gap-6 border-b border-line px-4.5 py-4 last:border-b-0 max-sm:flex-col max-sm:items-start max-sm:gap-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-48 max-w-full flex-1 max-sm:flex-none" />
              <Skeleton className="h-6 w-28 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
