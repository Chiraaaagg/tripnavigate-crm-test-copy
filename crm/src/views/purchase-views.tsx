import { ClipboardList, FileQuestion } from 'lucide-react';
import Link from 'next/link';
import type React from 'react';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Timeline, type TimelineItem } from '@/components/ui/timeline';
import {
  type BookingActionResult,
  ERROR_TEXT,
  type PurchaseQueueView,
  type PurchaseTaskSummary,
  type PurchaseTaskView,
  SERVICE_TYPE_LABEL,
} from '@/modules/fulfilment/contracts';
import { formatInr } from '@/modules/fulfilment/booking-form-model';
import { tabHref, type DepartmentTaskTabsVM, type TaskHistoryVM } from '@/modules/settings/contracts';
import { formatDateOnly } from './booking-views';
import { formatIst } from './deal-labels';
import { filterQueue, isNotTaken, parseQueueShow, type QueueShow } from './department/queue-show';
import {
  budgetText as departmentBudgetText,
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
import { ClaimTaskForm } from './purchase-forms';
import { FactsBlock, factsSummary, ServiceTypePill } from './service-labels';
import { OrNotRecorded } from './value-states';

/*
 * Purchase screens (Direction A Batch 4, screen plan PU-01 / PU-02, DA-16,
 * DA-270 to DA-273). The DTOs have no selling price, margin or proof field at
 * all; these views add none. List: Not taken · Mine · All over the rows the
 * database returned (originui Table 89 look, catalog gap G8). Task: record
 * header (status word with icon, taken by, one "Next:" line, one primary) and
 * link tabs Details · Work · Files · History (shadcn Tabs 953 look; no counts,
 * no Money tab). A status-only viewer (Sales, Accounts) gets no tab bar.
 */

/** A budget of zero means none was entered (the database treats it as "budget missing"), never an approved ₹0.00. */
export function budgetText(paise: string): string {
  return departmentBudgetText(paise);
}

/** DA-273 list line (Purchase also handles transfers and activities, so it names them). */
export const PURCHASE_QUEUE_NOTE = 'Hotels, transfers and activities from submitted bookings. Each counts as booked only after you record the supplier’s confirmation.';

function travellers(t: PurchaseTaskSummary['travellers']): string {
  const adults = `${t.adults} ${t.adults === 1 ? 'adult' : 'adults'}`;
  return t.children > 0 ? `${adults}, ${t.children} ${t.children === 1 ? 'child' : 'children'}` : adults;
}

function nights(n: number): string {
  return `${n} ${n === 1 ? 'night' : 'nights'}`;
}

const linkClass = cn('rounded-chip font-semibold text-brand-strong underline-offset-4 hover:text-brand-deep hover:underline', focusRing);

export function PurchaseQueuePage({
  queue,
  canTakeTasks,
  show,
}: {
  queue: PurchaseQueueView;
  /** The viewer holds the Purchase role. Sales and managers only follow progress. */
  canTakeTasks: boolean;
  /** Batch 4: `?show=` (parseQueueShow). Omitted = the default tab. */
  show?: QueueShow;
}) {
  const current = show ?? parseQueueShow(undefined, canTakeTasks);
  const all = queue.tasks;
  const tasks = filterQueue(all, current);
  const counts = { not_taken: all.filter(isNotTaken).length, mine: all.filter((t) => t.assignedToYou).length, all: all.length };
  const allHotel = tasks.every((t) => t.serviceType === 'hotel');
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader eyebrow="Purchase" title="Purchase tasks" description={PURCHASE_QUEUE_NOTE} />
      <div className="mb-4">
        <InternalTaskLine>Customer prices and proof files are never shown here.</InternalTaskLine>
        {/* Sales and branch Managers only follow progress (contract §12 A4: never invited to take a task). */}
        {!canTakeTasks ? <p className="m-0 mt-1.5 text-copy">Purchase colleagues take these tasks. You can follow progress here.</p> : null}
      </div>
      <QueueShowTabs basePath="/app/purchase" show={current} canTakeTasks={canTakeTasks} counts={counts} label="Purchase task filters" />
      <Card>
        {tasks.length === 0 ? (
          <div role="status">
            <QueueEmpty icon={ClipboardList} anyTasks={all.length > 0} show={current} serviceWords="a hotel, transfer or activity" />
          </div>
        ) : (
          <Table stackOnMobile label="Purchase tasks table" wrapperClassName="rounded-card">
            <TableCaption className="caption-top border-b border-line py-3 font-medium text-copy max-sm:block">
              {tasks.length} {allHotel ? 'hotel ' : ''}
              {tasks.length === 1 ? 'task' : 'tasks'}
            </TableCaption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Service</TableHead>
                <TableHead>Service details</TableHead>
                <TableHead>Stay</TableHead>
                <TableHead>Rooms and travellers</TableHead>
                <TableHead>Approved budget</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Taken by</TableHead>
                <TableHead>Deal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((t) => (
                <TableRow key={t.taskId} className="align-top">
                  <TableCell label="Service" className="align-top">
                    <ServiceTypePill type={t.serviceType} />
                  </TableCell>
                  <TableCell label="Service details" className="align-top">
                    <Link href={`/app/purchase/${t.taskId}`} className={linkClass}>
                      {t.itemTitle}
                      <span className="sr-only"> — open task</span>
                    </Link>
                    {t.serviceType !== 'hotel' ? <span className="block text-sm text-quiet">{factsSummary(t.facts)}</span> : null}
                  </TableCell>
                  <TableCell label="Stay" className="align-top text-sm">
                    {t.serviceType === 'hotel' && t.checkIn && t.checkOut ? (
                      <>
                        <span className="whitespace-nowrap">{formatDateOnly(t.checkIn)}</span> → <span className="whitespace-nowrap">{formatDateOnly(t.checkOut)}</span> · {nights(t.nights)}
                      </>
                    ) : (
                      <span className="text-quiet">Not a hotel</span>
                    )}
                  </TableCell>
                  <TableCell label="Rooms and travellers" className="align-top text-sm">
                    {t.serviceType === 'hotel' ? (
                      <>
                        {t.rooms} {t.rooms === 1 ? 'room' : 'rooms'} · {travellers(t.travellers)}
                      </>
                    ) : (
                      travellers(t.travellers)
                    )}
                  </TableCell>
                  <TableCell label="Approved budget" className="align-top whitespace-nowrap tabular-nums">
                    {budgetText(t.purchaseBudgetPaise)}
                  </TableCell>
                  <TableCell label="Status" className="align-top">
                    <TaskStatusBadge department="purchase" status={t.status} wrap />
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

// ---------------------------------------------------------------------------
// Task page
// ---------------------------------------------------------------------------

const dlClass = 'm-0 grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(7rem,11rem)_1fr]';
const dtClass = 'text-sm font-medium text-quiet';
const ddClass = 'm-0 text-ink';

function FactsCard({ id, title, children, className }: { id: string; title: string; children: React.ReactNode; className?: string }) {
  return (
    <Card className={className}>
      <section aria-labelledby={id}>
        <CardHeader>
          <CardTitle id={id}>{title}</CardTitle>
        </CardHeader>
        <CardBody>{children}</CardBody>
      </section>
    </Card>
  );
}

/** Booking form: the supplier estimate of this item (cost only; absent keys show nothing). */
function EstimateFact({ task }: { task: PurchaseTaskView }) {
  if (!task.estimate) return null;
  return (
    <>
      <dt className={dtClass}>Estimated supplier cost</dt>
      <dd className={ddClass}>
        <span className="whitespace-nowrap tabular-nums">{formatInr(task.estimate.totalPaise, 'Not priced')}</span>
        <span className="block text-sm text-quiet">An estimate only. It is not a price, a budget or a booking.</span>
      </dd>
    </>
  );
}

/** Sales submitted → Purchase takes the task → Purchase records the supplier's confirmation. */
export function taskHandoff(task: PurchaseTaskView): TimelineItem[] {
  const taken = task.assignedToYou || !!task.assigneeName;
  const confirmed = task.status === 'supplier_confirmed';
  return [
    { id: 'sales', title: 'Booking details confirmed by Sales', meta: `By ${task.confirmedByName}`, state: 'done' },
    {
      id: 'take',
      title: 'Take the task',
      meta: taken ? `Taken by ${task.assignedToYou ? 'you' : task.assigneeName}` : 'Not taken yet',
      state: taken ? 'done' : 'current',
    },
    {
      id: 'confirm',
      title: 'Supplier confirms the hotel',
      meta: confirmed
        ? `Confirmed${task.supplierConfirmedAt ? ` ${formatIst(task.supplierConfirmedAt)}` : ''}`
        : 'Offers, agreed cost and the supplier’s confirmation are recorded by Purchase.',
      state: confirmed ? 'done' : taken ? 'current' : 'upcoming',
    },
  ];
}

function PurchaseDetails({ task, idProofs }: { task: PurchaseTaskView; idProofs?: React.ReactNode }) {
  return (
    <div className="grid items-start gap-5 md:grid-cols-2">
      {task.serviceType === 'hotel' ? (
        <>
          <FactsCard id="task-stay" title="Stay">
            <dl className={dlClass}>
              <dt className={dtClass}>Check-in</dt>
              <dd className={ddClass}>{task.checkIn ? formatDateOnly(task.checkIn) : 'Not set'}</dd>
              <dt className={dtClass}>Check-out</dt>
              <dd className={ddClass}>{task.checkOut ? formatDateOnly(task.checkOut) : 'Not set'}</dd>
              <dt className={dtClass}>Nights</dt>
              <dd className={ddClass}>{task.nights}</dd>
              <dt className={dtClass}>Rooms</dt>
              <dd className={ddClass}>{task.rooms}</dd>
              <dt className={dtClass}>Room type</dt>
              <dd className={ddClass}>
                <OrNotRecorded value={task.roomType} />
              </dd>
              <dt className={dtClass}>Meal plan</dt>
              <dd className={ddClass}>
                <OrNotRecorded value={task.mealPlan} />
              </dd>
            </dl>
          </FactsCard>
          <FactsCard id="task-travellers" title="Travellers and budget">
            <dl className={dlClass}>
              <dt className={dtClass}>Adults</dt>
              <dd className={ddClass}>{task.travellers.adults}</dd>
              <dt className={dtClass}>Children</dt>
              <dd className={ddClass}>{task.travellers.children}</dd>
              <dt className={dtClass}>Approved budget</dt>
              <dd className={cn(ddClass, 'whitespace-nowrap tabular-nums')}>{budgetText(task.purchaseBudgetPaise)}</dd>
              <EstimateFact task={task} />
            </dl>
          </FactsCard>
          <FactsCard id="task-notes" title="Notes from Sales" className="md:col-span-2">
            <dl className={dlClass}>
              <dt className={dtClass}>Inclusions</dt>
              <dd className={cn(ddClass, 'whitespace-pre-wrap wrap-break-word')}>{task.inclusions ?? 'None'}</dd>
              <dt className={dtClass}>Special requests</dt>
              <dd className={cn(ddClass, 'whitespace-pre-wrap wrap-break-word')}>{task.specialRequests ?? 'None'}</dd>
            </dl>
          </FactsCard>
        </>
      ) : (
        <>
          <FactsCard id="task-facts" title={`${SERVICE_TYPE_LABEL[task.serviceType]} details`}>
            <FactsBlock facts={task.facts} legacy />
          </FactsCard>
          <FactsCard id="task-budget" title="Travellers and budget">
            <dl className={dlClass}>
              <dt className={dtClass}>Travellers</dt>
              <dd className={ddClass}>{travellers(task.travellers)}</dd>
              <dt className={dtClass}>Approved budget</dt>
              <dd className={cn(ddClass, 'whitespace-nowrap tabular-nums')}>{budgetText(task.purchaseBudgetPaise)}</dd>
              <EstimateFact task={task} />
            </dl>
          </FactsCard>
        </>
      )}
      <FactsCard id="task-origin" title="Where this came from">
        <dl className={dlClass}>
          <dt className={dtClass}>Deal</dt>
          <dd className={ddClass}>{task.dealReference}</dd>
          <dt className={dtClass}>Branch</dt>
          <dd className={ddClass}>{task.branchName}</dd>
          <dt className={dtClass}>Booking version</dt>
          <dd className={ddClass}>{task.versionNo}</dd>
          <dt className={dtClass}>Confirmed</dt>
          <dd className={ddClass}>
            {formatIst(task.confirmedAt)} by {task.confirmedByName}
          </dd>
          <dt className={dtClass}>Task created</dt>
          <dd className={ddClass}>{formatIst(task.createdAt)}</dd>
        </dl>
      </FactsCard>
      <FactsCard id="task-handoffs" title="Hand-offs">
        <Timeline label="Task hand-offs" items={taskHandoff(task)} showState />
      </FactsCard>
      {idProofs ? <div className="md:col-span-2">{idProofs}</div> : null}
    </div>
  );
}

export function PurchaseTaskPage({
  task,
  claimInitialState,
  work,
  tabs,
  idProofs,
  files,
  history,
  managerReadOnly = false,
}: {
  task: PurchaseTaskView;
  /** Preview gallery only. */
  claimInitialState?: BookingActionResult<unknown>;
  /** Work tab: the Purchase work section and the cost block (Purchase role holders and the branch Manager). */
  work?: React.ReactNode;
  /** Batch 4 tabs. Omitted = the one long page of before (details, then `work`). [] = status only, no tab bar. */
  tabs?: DepartmentTaskTabsVM;
  /** Details tab: the "Traveller ID proofs" card (assignee only, DEC-41). */
  idProofs?: React.ReactNode;
  /** Files tab content (only when Files is the open tab). */
  files?: TaskFilesVM;
  /** History tab content (only when History is the open tab). */
  history?: TaskHistoryVM | null;
  /** The branch Manager reading a Purchase task (DA-272). */
  managerReadOnly?: boolean;
}) {
  const basePath = `/app/purchase/${task.taskId}`;
  const current = tabs?.current ?? 'details';
  const showClaim = task.canClaim && !task.assignedToYou && !task.assigneeName;
  const workLink =
    tabs && tabs.tabs.includes('work') && current !== 'work' && task.assignedToYou && task.status === 'in_progress' ? (
      <Link href={tabHref(basePath, 'work', 'details')} className={buttonVariants({ variant: 'primary', size: 'lg' })}>
        Record supplier confirmation
      </Link>
    ) : null;
  const confirmed = task.status === 'supplier_confirmed';
  return (
    <div className="font-sans text-base text-copy">
      <TaskBackLink href="/app/purchase">Back to Purchase tasks</TaskBackLink>
      <PageHeader
        eyebrow={`${SERVICE_TYPE_LABEL[task.serviceType]} task · ${task.dealReference}`}
        title={<span className="block wrap-anywhere">{task.itemTitle}</span>}
        status={
          <>
            <ServiceTypePill type={task.serviceType} />
            <TaskStatusBadge department="purchase" status={task.status} wrap />
            <span className="text-copy">Taken by: {takenByText(task)}</span>
          </>
        }
        // Kept mounted while the viewer may claim, so a "taken by a colleague" result survives the refresh.
        actions={task.canClaim ? <ClaimTaskForm taskId={task.taskId} canTake={showClaim} initialState={claimInitialState} /> : (workLink ?? undefined)}
        className="mb-3"
      />
      <TaskNextLine text={taskNextText({ department: 'purchase', status: task.status, assignedToYou: task.assignedToYou, assigneeName: task.assigneeName, canClaim: task.canClaim })}>
        {managerReadOnly ? <p className="m-0 text-sm text-copy">You can view this but not change it. Purchase in {task.branchName} works on it.</p> : null}
        <InternalTaskLine>
          {confirmed
            ? `Internal task — supplier confirmed${task.supplierConfirmedAt ? ` on ${formatIst(task.supplierConfirmedAt)}` : ''}. The CRM sent nothing to the customer. No payment, bill or invoice was created.`
            : `Internal task — the hotel is not booked yet. ${task.assignedToYou ? 'Taking the task did not book the hotel. ' : ''}Nothing has been sent to the hotel or the customer by the CRM.`}
        </InternalTaskLine>
      </TaskNextLine>
      {tabs ? <TaskTabsNav basePath={basePath} tabs={tabs} /> : null}
      {!tabs ? (
        <>
          <PurchaseDetails task={task} idProofs={idProofs} />
          {work ? <div className="mt-5">{work}</div> : null}
        </>
      ) : current === 'work' ? (
        (work ?? null)
      ) : current === 'files' ? (
        <TaskFilesPanel files={files ?? {}} />
      ) : current === 'history' && history ? (
        <TaskHistoryPanel history={history} />
      ) : (
        <PurchaseDetails task={task} idProofs={idProofs} />
      )}
    </div>
  );
}

export function PurchaseTaskNotFoundView() {
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
        <Link href="/app/purchase" className={buttonVariants({ variant: 'secondary' })}>
          Back to Purchase tasks
        </Link>
      </p>
    </div>
  );
}
