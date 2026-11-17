import { ClipboardList, FileQuestion } from 'lucide-react';
import type { GoAheadState, PurchaseQueueFlags } from '@/modules/procurement/contracts';
import Link from 'next/link';
import type React from 'react';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { FocusHashTarget } from '@/components/ui/jump-links';
import { PageHeader } from '@/components/ui/page-header';
import { QueueToolbar, type QueueChip } from '@/components/ui/queue-toolbar';
import { RecordHeader, type NextButton } from '@/components/ui/record-header';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { TabItem } from '@/components/ui/tabs';
import type { TimelineItem } from '@/components/ui/timeline';
import { dateRangeText, dayText, plural } from '@/lib/format';
import {
  type BookingActionResult,
  ERROR_TEXT,
  type PurchaseQueueView,
  type PurchaseTaskSummary,
  type PurchaseTaskView,
  SERVICE_TYPE_LABEL,
} from '@/modules/fulfilment/contracts';
import { tabHref, type DepartmentTaskTabsVM, type TaskHistoryVM, type TaskTab } from '@/modules/settings/contracts';
import { formatIst } from './deal-labels';
import {
  defaultQueueShow,
  filterQueue,
  isNotTaken,
  matchesSearch,
  parseQueueShow,
  queueAddress,
  QUEUE_SORT_OPTIONS,
  sortQueue,
  type QueueQuery,
  type QueueShow,
  type RowNext,
} from './department/queue-show';
import { QueueNothingMatches, QueueRowButton } from './department/queue-parts';
import {
  budgetText as departmentBudgetText,
  InternalTaskLine,
  QueueEmpty,
  QueueShowTabs,
  TaskFilesPanel,
  TaskHistoryPanel,
  TaskStatusBadge,
  TaskTabsNav,
  takenByText,
  taskNextText,
  type TaskFilesVM,
} from './department/task-frame';
import { ClaimTaskForm } from './purchase-forms';
import { factsSummary, ServiceTypePill } from './service-labels';
import { WhatSalesBookedCard } from './purchase/what-sales-booked';
import { GO_AHEAD_LABEL, goAheadOf, GoAheadBadge } from './purchase/go-ahead';

/*
 * Purchase screens (Direction A Batch 4, screen plan PU-01 / PU-02, DA-16,
 * DA-270 to DA-273; R3 redesign C1, 18 Nov 2026). The DTOs have no selling
 * price, margin or proof field at all; these views add none and start no read.
 *
 * List (design plan 1.2, C2): one muted line, pill tabs Not taken · Mine · All
 * (+ Payment requests for Purchase, DM-19), one toolbar row (search, status
 * chips, sort "Soonest travel first"), one row per task: What · Dates ·
 * Approved budget · Status (one badge + one plain fact) · Next step (words +
 * one row button) · Taken by · Deal. Search, chips and sort work only on the
 * rows the database already returned (`?show=&q=&chip=&sort=`).
 *
 * Task (C4, O6): the shared record header (back link · kind and Deal; title,
 * type, status, go-ahead, taken by; "Next:" with the one primary) around the
 * frozen Work form; pill link tabs Details · Work · Files · History (no counts,
 * no Money tab). A status-only viewer (Sales, Accounts) gets no tab bar.
 */

/** A budget of zero means none was entered (the database treats it as "budget missing"), never an approved ₹0.00. */
export function budgetText(paise: string): string {
  return departmentBudgetText(paise);
}

/** DA-273 list line (Purchase also handles transfers and activities, so it names them). */
export const PURCHASE_QUEUE_NOTE = 'Hotels, transfers and activities from submitted bookings. Each counts as booked only after you record the supplier’s confirmation.';
/** The branch Manager (and anyone else who only follows progress). */
export const PURCHASE_QUEUE_FOLLOW_NOTE = 'Purchase colleagues take these tasks. You can follow progress here.';

function travellers(t: PurchaseTaskSummary['travellers']): string {
  const adults = plural(t.adults, 'adult');
  return t.children > 0 ? `${adults}, ${plural(t.children, 'child', 'children')}` : adults;
}

const linkClass = cn('rounded-chip font-semibold text-brand-strong underline-offset-4 hover:text-brand-deep hover:underline', focusRing);

// ---------------------------------------------------------------------------
// Queue: pure helpers (unit-tested in tests/unit/purchase-queue.test.ts)
// ---------------------------------------------------------------------------

/** Status chips, from the task rows and the go-ahead flags only (no extra read). */
export const PURCHASE_QUEUE_CHIPS = ['goahead', 'returned', 'open', 'confirmed', 'cancelled'] as const;
export type PurchaseQueueChip = (typeof PURCHASE_QUEUE_CHIPS)[number];
export const PURCHASE_CHIP_LABEL: Record<PurchaseQueueChip, string> = {
  goahead: 'Waiting for go-ahead',
  returned: 'Go-ahead returned',
  open: 'Not booked yet',
  confirmed: 'Confirmed',
  cancelled: 'Trip cancelled',
};

export const PURCHASE_SEARCH_PLACEHOLDER = 'Deal, hotel, service or place';

type Flags = Record<string, PurchaseQueueFlags>;

function goAheadFor(t: PurchaseTaskSummary, flags: Flags): GoAheadState | null {
  return flags[t.taskId]?.goAheadState ?? goAheadOf(t);
}

export function purchaseChipMatches(chip: PurchaseQueueChip, t: PurchaseTaskSummary, flags: Flags): boolean {
  const confirmed = t.status === 'supplier_confirmed';
  const ga = goAheadFor(t, flags);
  switch (chip) {
    case 'goahead':
      return !confirmed && ga === 'pending';
    case 'returned':
      return !confirmed && (ga === 'returned' || ga === 'stale');
    case 'open':
      return !confirmed && (t.assignedToYou || !!t.assigneeName);
    case 'confirmed':
      return confirmed;
    case 'cancelled':
      return !!flags[t.taskId]?.tripCancelled;
  }
}

/** First and last travel day of the service (YYYY-MM-DD), from the row's own facts. */
export function purchaseTravelDays(t: PurchaseTaskSummary): { from: string | null; to: string | null } {
  if (t.serviceType === 'hotel') return { from: t.checkIn ?? null, to: t.checkOut ?? null };
  const f = t.facts;
  if (f.type === 'transfer') return { from: f.facts.date || null, to: f.facts.endDate || null };
  if (f.type === 'activity') return { from: f.facts.date || null, to: null };
  if (f.type === 'hotel') return { from: f.facts.checkIn || null, to: f.facts.checkOut || null };
  return { from: null, to: null };
}

/** The words a search looks in: name, details, Deal, branch, place, kind and who has it. */
export function purchaseSearchFields(t: PurchaseTaskSummary): string[] {
  return [t.itemTitle, factsSummary(t.facts), t.dealReference, t.branchName, t.city ?? '', t.hotelName ?? '', SERVICE_TYPE_LABEL[t.serviceType], takenByText(t)];
}

export interface PurchaseQueueModel {
  /** Rows on the open tab before search and chip. */
  tabRows: PurchaseTaskSummary[];
  /** After search and chip, sorted. */
  rows: PurchaseTaskSummary[];
  /** Rows behind each chip, after search, on the open tab. */
  chipCounts: Record<PurchaseQueueChip, number>;
}

export function purchaseQueueModel(all: readonly PurchaseTaskSummary[], show: QueueShow, query: QueueQuery<PurchaseQueueChip>, flags: Flags = {}): PurchaseQueueModel {
  const tabRows = filterQueue([...all], show);
  const searched = tabRows.filter((t) => matchesSearch(query.q, purchaseSearchFields(t)));
  const chipCounts = Object.fromEntries(PURCHASE_QUEUE_CHIPS.map((c) => [c, searched.filter((t) => purchaseChipMatches(c, t, flags)).length])) as Record<PurchaseQueueChip, number>;
  const chosen = query.chip ? searched.filter((t) => purchaseChipMatches(query.chip!, t, flags)) : searched;
  const rows = sortQueue(chosen, query.sort, (t) => purchaseTravelDays(t).from, (t) => t.dealReference);
  return { tabRows, rows, chipCounts };
}

/** The second status fact beside the one badge, as plain words (never a second badge). */
export function purchaseSecondFact(t: PurchaseTaskSummary, flags: Flags): string | null {
  if (flags[t.taskId]?.tripCancelled) return 'Trip cancelled';
  if (t.status === 'supplier_confirmed') return null;
  const ga = goAheadFor(t, flags);
  return ga === 'pending' || ga === 'returned' || ga === 'stale' || ga === 'approved' ? GO_AHEAD_LABEL[ga] : null;
}

/** Queue "Next step": words in the task page's own terms, and one row button when the viewer can act. */
export function purchaseRowNext(t: PurchaseTaskSummary, flags: Flags, canTakeTasks: boolean): RowNext {
  const next = purchaseRowNextFor(t, flags, canTakeTasks);
  // A viewer who cannot take tasks (the branch Manager) only follows progress: words, never a row button.
  return canTakeTasks ? next : { text: next.text };
}

function purchaseRowNextFor(t: PurchaseTaskSummary, flags: Flags, canTakeTasks: boolean): RowNext {
  const href = `/app/purchase/${t.taskId}`;
  if (t.status === 'supplier_confirmed') return { text: 'Nothing waiting' };
  if (!t.assignedToYou && !t.assigneeName) {
    return canTakeTasks ? { text: 'Take this task', button: { label: 'Open to take', href } } : { text: 'Purchase takes this task' };
  }
  if (!t.assignedToYou) return { text: `${t.assigneeName} works on it` };
  const work = { label: 'Continue', href: `${href}?tab=work` };
  if (flags[t.taskId]?.tripCancelled) return { text: 'Enter what the supplier keeps and refunds', button: work };
  const ga = goAheadFor(t, flags);
  if (ga === 'pending') return { text: 'Wait for the Accounts go-ahead' };
  if (ga === 'returned' || ga === 'stale') return { text: 'Send the booking request again', button: work };
  return { text: 'Continue on the Work tab', button: work };
}

function DatesCell({ t }: { t: PurchaseTaskSummary }) {
  const { from, to } = purchaseTravelDays(t);
  const when = from && to ? dateRangeText(from, to) : from ? dayText(from) : null;
  const who =
    t.serviceType === 'hotel' ? [plural(t.nights, 'night'), plural(t.rooms, 'room'), travellers(t.travellers)].join(' · ') : travellers(t.travellers);
  return (
    <>
      {when ? <span className="block whitespace-nowrap">{when}</span> : <span className="block text-quiet">Dates not set</span>}
      <span className="block text-sm text-quiet">{who}</span>
    </>
  );
}

export function PurchaseQueuePage({
  queue,
  canTakeTasks,
  show,
  flags = {},
  query = { q: '', chip: null, sort: 'soonest' },
}: {
  queue: PurchaseQueueView;
  /** The viewer holds the Purchase role. Sales and managers only follow progress. */
  canTakeTasks: boolean;
  /** Batch 4: `?show=` (parseQueueShow). Omitted = the default tab. */
  show?: QueueShow;
  /** Purchase build: go-ahead state and trip-cancelled flag per task id (loadPurchaseQueueFlags). */
  flags?: Flags;
  /** R3: `?q=&chip=&sort=` (parseQueueQuery). Omitted = no search, no chip, soonest travel first. */
  query?: QueueQuery<PurchaseQueueChip>;
}) {
  const current = show ?? parseQueueShow(undefined, canTakeTasks);
  const all = queue.tasks;
  const { tabRows, rows, chipCounts } = purchaseQueueModel(all, current, query, flags);
  const counts = { not_taken: all.filter(isNotTaken).length, mine: all.filter((t) => t.assignedToYou).length, all: all.length };
  const allHotel = rows.every((t) => t.serviceType === 'hotel');
  const showParam = current === defaultQueueShow(canTakeTasks) ? null : current;
  const base = '/app/purchase';
  const filtered = !!query.q || !!query.chip;
  const chips: QueueChip[] = PURCHASE_QUEUE_CHIPS.filter((c) => chipCounts[c] > 0 || query.chip === c).map((c) => ({
    href: queueAddress(base, { show: showParam, q: query.q, chip: query.chip === c ? null : c, sort: query.sort }),
    label: PURCHASE_CHIP_LABEL[c],
    count: chipCounts[c],
    current: query.chip === c,
  }));
  const keep: Record<string, string> = {};
  if (showParam) keep.show = showParam;
  if (query.chip) keep.chip = query.chip;
  // DM-19: Payment requests is a tab beside the task lists (Purchase only; no count here, this page reads only tasks).
  const extra: TabItem[] = canTakeTasks ? [{ href: '/app/purchase/payments', label: 'Payment requests' }] : [];
  const noun = `${allHotel ? 'hotel ' : ''}${rows.length === 1 ? 'task' : 'tasks'}`;
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader eyebrow="Purchase" title="Purchase tasks" description={canTakeTasks ? PURCHASE_QUEUE_NOTE : PURCHASE_QUEUE_FOLLOW_NOTE} />
      <QueueShowTabs
        basePath={base}
        show={current}
        canTakeTasks={canTakeTasks}
        counts={counts}
        label="Purchase task filters"
        keep={{ q: query.q, sort: query.sort }}
        extra={extra}
        variant="pill"
      />
      {all.length > 0 ? (
        <QueueToolbar
          action={base}
          label="Search and filter Purchase tasks"
          chipsLabel="Filter by status"
          keep={keep}
          search={{ name: 'q', value: query.q, placeholder: PURCHASE_SEARCH_PLACEHOLDER, label: 'Search Purchase tasks' }}
          chips={chips}
          sort={{ name: 'sort', value: query.sort, options: QUEUE_SORT_OPTIONS }}
        />
      ) : null}
      {rows.length === 0 && filtered && tabRows.length > 0 ? (
        <div role="status">
          <QueueNothingMatches card clearHref={queueAddress(base, { show: showParam })} />
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <div role="status">
            <QueueEmpty icon={ClipboardList} anyTasks={all.length > 0} show={current} serviceWords="a hotel, transfer or activity" />
          </div>
        </Card>
      ) : (
        <Card>
          <Table stackOnMobile label="Purchase tasks table" wrapperClassName="rounded-card">
            <TableCaption className="caption-top border-b border-line py-3 font-medium text-copy max-sm:block">
              {rows.length} {noun}
              {filtered ? <span className="font-normal text-quiet"> of {tabRows.length} on this tab</span> : null}
            </TableCaption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="px-3">What</TableHead>
                <TableHead className="px-3">Dates</TableHead>
                <TableHead className="px-3" numeric>
                  Approved budget
                </TableHead>
                <TableHead className="min-w-40 px-3">Status</TableHead>
                <TableHead className="px-3">Next step</TableHead>
                <TableHead className="px-3">Taken by</TableHead>
                <TableHead className="px-3">Deal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((t) => {
                const fact = purchaseSecondFact(t, flags);
                const next = purchaseRowNext(t, flags, canTakeTasks);
                return (
                  <TableRow key={t.taskId} className="align-top">
                    <TableCell label="What" className="px-3 align-top">
                      <span className="flex flex-col items-start gap-1.5 max-sm:items-end">
                        <ServiceTypePill type={t.serviceType} />
                        <Link href={`/app/purchase/${t.taskId}`} className={linkClass}>
                          {t.itemTitle}
                          <span className="sr-only"> — open task</span>
                        </Link>
                        {t.serviceType !== 'hotel' ? <span className="block text-sm text-quiet">{factsSummary(t.facts)}</span> : null}
                      </span>
                    </TableCell>
                    <TableCell label="Dates" className="px-3 align-top">
                      <DatesCell t={t} />
                    </TableCell>
                    <TableCell label="Approved budget" numeric className="px-3 align-top whitespace-nowrap tabular-nums">
                      {budgetText(t.purchaseBudgetPaise)}
                    </TableCell>
                    <TableCell label="Status" className="min-w-40 px-3 align-top">
                      <span className="flex flex-col items-start gap-1 max-sm:items-end">
                        <TaskStatusBadge department="purchase" status={t.status} wrap />
                        {fact ? <span className="text-sm text-copy">{fact}</span> : null}
                      </span>
                    </TableCell>
                    <TableCell label="Next step" className="px-3 align-top">
                      <span className="flex flex-col items-start gap-2 max-sm:items-end">
                        <span className="text-sm text-copy">{next.text}</span>
                        {next.button ? <QueueRowButton href={next.button.href} label={next.button.label} context={t.itemTitle} /> : null}
                      </span>
                    </TableCell>
                    <TableCell label="Taken by" className="px-3 align-top">
                      {takenByText(t)}
                    </TableCell>
                    <TableCell label="Deal" className="px-3 align-top text-sm">
                      <span className="whitespace-nowrap">{t.dealReference}</span>
                      <span className="block text-quiet">{t.branchName}</span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}
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

// ---------------------------------------------------------------------------
// O6: the header's "Next:" button jumps to the matching control on Work.
// Target ids (helper F adds them inside the frozen Work form, same names):
//   purchase-next-charges · purchase-next-add-rate · purchase-next-final-rate
//   purchase-next-booking-request · purchase-next-confirmation
// ---------------------------------------------------------------------------

export const PURCHASE_NEXT_STEPS = ['charges', 'add-rate', 'final-rate', 'booking-request', 'confirmation'] as const;
export type PurchaseNextStep = (typeof PURCHASE_NEXT_STEPS)[number];

/** The id of the control a step's header button moves to. */
export function purchaseNextTargetId(step: PurchaseNextStep): string {
  return `purchase-next-${step}`;
}

/** Visible label of the header button per step (the control's own words). */
export const PURCHASE_NEXT_LABEL: Record<PurchaseNextStep, string> = {
  charges: 'Enter the charges',
  'add-rate': 'Add a rate',
  'final-rate': 'Choose the final rate',
  'booking-request': 'Send booking request',
  confirmation: 'Record supplier confirmation',
};

/**
 * The step behind a "Next:" line. The lines come from `purchaseNextText` (Work
 * form, frozen) and `taskNextText`; each wording the assignee can act on maps
 * to one control. Waiting lines ("wait for …") and lines about someone else
 * map to none, so they get no button.
 */
const STEP_BY_TEXT: Readonly<Record<string, PurchaseNextStep>> = {
  'enter what the supplier keeps and refunds': 'charges',
  'ask the supplier for rates, then add each rate you get': 'add-rate',
  'choose the final rate': 'final-rate',
  'send the booking request from the final rate, then record the supplier’s confirmation': 'booking-request',
  'send the booking request again': 'booking-request',
  'record the supplier’s confirmation': 'confirmation',
};

export function purchaseNextStep(text: string): PurchaseNextStep | null {
  return STEP_BY_TEXT[text] ?? null;
}

/** A line about who else acts ("Synthetic Colleague works on this task", "Purchase takes this task"). */
export function isSomeoneElseNext(text: string): boolean {
  return /works on this task$/.test(text) || /^Purchase /.test(text);
}

export function PurchaseTaskPage({
  task,
  claimInitialState,
  work,
  tabs,
  defaultTab = 'details',
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
  /** D6 (helper F): the tab the bare address opens for this viewer. It keeps the bare address; the others get `?tab=`. */
  defaultTab?: TaskTab;
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
  const confirmed = task.status === 'supplier_confirmed';
  const text = nextText ?? taskNextText({ department: 'purchase', status: task.status, assignedToYou: task.assignedToYou, assigneeName: task.assigneeName, canClaim: task.canClaim });
  // O6: one primary that jumps to the control (on Work), or opens Work at it (from another tab).
  const step = purchaseNextStep(text);
  const hasWork = tabs ? tabs.tabs.includes('work') : !!work;
  const onWork = tabs ? current === 'work' : !!work;
  let button: NextButton | undefined;
  if (step && hasWork && !showClaim) {
    const target = purchaseNextTargetId(step);
    button = onWork
      ? { label: <>{PURCHASE_NEXT_LABEL[step]}<span className="sr-only"> (go to it below)</span></>, jumpTo: target }
      : { label: <>{PURCHASE_NEXT_LABEL[step]}<span className="sr-only"> (opens the Work tab)</span></>, href: `${tabHref(basePath, 'work', defaultTab)}#${target}` };
  }
  const someoneElse = isSomeoneElseNext(text);
  const statusOnly = !!tabs && tabs.tabs.length === 0;
  const readOnly = managerReadOnly
    ? `You can view this but not change it. Purchase in ${task.branchName} works on it.`
    : statusOnly
      ? `You can view this. Purchase in ${task.branchName} can change it.`
      : undefined;
  const thing = task.serviceType === 'hotel' ? 'the hotel' : 'it';
  const internal = confirmed
    ? `Internal task — supplier confirmed${task.supplierConfirmedAt ? ` on ${formatIst(task.supplierConfirmedAt)}` : ''}. The CRM sent nothing to the customer. Paying the supplier is a separate request to Accounts.`
    : `Internal task — ${task.serviceType === 'hotel' ? 'the hotel is' : 'this service is'} not booked yet. ${task.assignedToYou ? `Taking the task did not book ${thing}. ` : ''}The CRM sends nothing to the customer.`;
  return (
    <div className="font-sans text-base text-copy">
      <RecordHeader
        back={{ href: '/app/purchase', label: 'Back to Purchase tasks' }}
        recordId={`${SERVICE_TYPE_LABEL[task.serviceType]} task · ${task.dealReference}`}
        title={<span className="block wrap-anywhere">{task.itemTitle}</span>}
        status={
          <>
            <ServiceTypePill type={task.serviceType} />
            <TaskStatusBadge department="purchase" status={task.status} wrap />
            {!confirmed ? <GoAheadBadge state={goAheadState} /> : null}
          </>
        }
        owner={takenByText(task)}
        ownerLabel="Taken by"
        next={someoneElse ? null : { text, button }}
        nextWho={someoneElse ? `${text}.` : undefined}
        readOnly={readOnly}
        details={<InternalTaskLine>{internal}</InternalTaskLine>}
        detailsLabel="About this task"
        // Kept mounted while the viewer may claim, so a "taken by a colleague" result survives the refresh.
        actions={task.canClaim ? <ClaimTaskForm taskId={task.taskId} canTake={showClaim} initialState={claimInitialState} /> : undefined}
      />
      {tabs ? <TaskTabsNav basePath={basePath} tabs={tabs} defaultTab={defaultTab} variant="pill" /> : null}
      {!tabs ? (
        <>
          <PurchaseDetails task={task} idProofs={idProofs} />
          {work ? <div className="mt-5">{work}</div> : null}
        </>
      ) : current === 'work' ? (
        <>
          {/* O6: arriving from another tab at "?tab=work#purchase-next-…" moves focus to that control. */}
          <FocusHashTarget />
          {work ?? null}
        </>
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
