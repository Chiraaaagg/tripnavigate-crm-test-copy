import { Ban, ClipboardList, FileQuestion } from 'lucide-react';
import { StatusBadge } from '@/components/ui/badge';
import type { PurchaseQueueFlags } from '@/modules/procurement/contracts';
import Link from 'next/link';
import type React from 'react';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { TimelineItem } from '@/components/ui/timeline';
import {
  type BookingActionResult,
  ERROR_TEXT,
  type PurchaseQueueView,
  type PurchaseTaskSummary,
  type PurchaseTaskView,
  SERVICE_TYPE_LABEL,
} from '@/modules/fulfilment/contracts';
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
import { factsSummary, ServiceTypePill } from './service-labels';
import { WhatSalesBookedCard } from './purchase/what-sales-booked';
import { goAheadOf, GoAheadBadge, type GoAheadState } from './purchase/go-ahead';

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
  flags = {},
}: {
  queue: PurchaseQueueView;
  /** The viewer holds the Purchase role. Sales and managers only follow progress. */
  canTakeTasks: boolean;
  /** Batch 4: `?show=` (parseQueueShow). Omitted = the default tab. */
  show?: QueueShow;
  /** Purchase build: go-ahead state and trip-cancelled flag per task id (loadPurchaseQueueFlags). */
  flags?: Record<string, PurchaseQueueFlags>;
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
                <TableHead>Stay</TableHead>
                <TableHead>Rooms and travellers</TableHead>
                <TableHead>Approved budget</TableHead>
                <TableHead className="min-w-44">Status</TableHead>
                <TableHead>Taken by</TableHead>
                <TableHead>Deal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((t) => (
                <TableRow key={t.taskId} className="align-top">
                  <TableCell label="Service" className="align-top">
                    {/* Prototype (1 Nov): the type pill sits above the service name, so Status keeps its width. */}
                    <span className="flex flex-col items-start gap-1.5">
                      <ServiceTypePill type={t.serviceType} />
                      <Link href={`/app/purchase/${t.taskId}`} className={linkClass}>
                        {t.itemTitle}
                        <span className="sr-only"> — open task</span>
                      </Link>
                      {t.serviceType !== 'hotel' ? <span className="block text-sm text-quiet">{factsSummary(t.facts)}</span> : null}
                    </span>
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
                  <TableCell label="Status" className="min-w-44 align-top">
                    <span className="flex flex-col items-start gap-1.5 max-sm:items-end">
                      <TaskStatusBadge department="purchase" status={t.status} wrap />
                      {t.status !== 'supplier_confirmed' ? <GoAheadBadge state={flags[t.taskId]?.goAheadState ?? goAheadOf(t)} compact /> : null}
                      {flags[t.taskId]?.tripCancelled ? (
                        <StatusBadge tone="danger" icon={Ban} wrap>
                          Trip cancelled
                        </StatusBadge>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell label="Taken by" className="align-top">
                    {takenByText(t)}
                  </TableCell>
                  <TableCell label="Deal" className="align-top text-sm">
                    <span className="whitespace-nowrap">{t.dealReference}</span> · {t.branchName}
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
  // Prototype (owner review, 1 Nov 2026): one "What Sales booked" card replaces Stay, Travellers and
  // budget and Notes from Sales; the Hand-offs card is gone (the Next line and History carry it).
  return (
    <div className="flex flex-col gap-5">
      <WhatSalesBookedCard task={task} />
      {idProofs ? <div>{idProofs}</div> : null}
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
  goAheadState,
  nextText,
  filesExtra,
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
  /** Purchase build: the hotel's Accounts go-ahead (from the workspace read; absent for viewers without it). */
  goAheadState?: GoAheadState | null;
  /** Purchase build: the "Next:" line computed from the workspace (purchaseNextText); default = the task-only line. */
  nextText?: string;
  /** Purchase build: supplier invoices and credit notes under the Files list (Files tab only). */
  filesExtra?: React.ReactNode;
}) {
  const basePath = `/app/purchase/${task.taskId}`;
  const current = tabs?.current ?? 'details';
  const showClaim = task.canClaim && !task.assignedToYou && !task.assigneeName;
  const workLink =
    tabs && tabs.tabs.includes('work') && current !== 'work' && task.assignedToYou && task.status === 'in_progress' ? (
      <Link href={tabHref(basePath, 'work', 'details')} className={buttonVariants({ variant: 'primary', size: 'lg' })}>
        Open the Work tab
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
            {task.status !== 'supplier_confirmed' ? <GoAheadBadge state={goAheadState} /> : null}
            <span className="text-copy">Taken by: {takenByText(task)}</span>
          </>
        }
        // Kept mounted while the viewer may claim, so a "taken by a colleague" result survives the refresh.
        actions={task.canClaim ? <ClaimTaskForm taskId={task.taskId} canTake={showClaim} initialState={claimInitialState} /> : (workLink ?? undefined)}
        className="mb-3"
      />
      <TaskNextLine text={nextText ?? taskNextText({ department: 'purchase', status: task.status, assignedToYou: task.assignedToYou, assigneeName: task.assigneeName, canClaim: task.canClaim })}>
        {managerReadOnly ? <p className="m-0 text-sm text-copy">You can view this but not change it. Purchase in {task.branchName} works on it.</p> : null}
        <InternalTaskLine>
          {confirmed
            ? `Internal task — supplier confirmed${task.supplierConfirmedAt ? ` on ${formatIst(task.supplierConfirmedAt)}` : ''}. The CRM sent nothing to the customer. Paying the supplier is a separate request to Accounts.`
            : `Internal task — ${task.serviceType === 'hotel' ? 'the hotel is' : 'this service is'} not booked yet. ${task.assignedToYou ? `Taking the task did not book ${task.serviceType === 'hotel' ? 'the hotel' : 'it'}. ` : ''}The CRM sends nothing to the customer.`}
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
        <div className="flex flex-col gap-5">
          <TaskFilesPanel files={files ?? {}} />
          {filesExtra}
        </div>
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
