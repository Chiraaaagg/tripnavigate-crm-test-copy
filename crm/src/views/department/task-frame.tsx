import { ChevronLeft, FileText, FolderOpen, History, Lock, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { Status, type StatusKind } from '@/components/ui/status';
import { Tabs, type TabItem, type TabsVariant } from '@/components/ui/tabs';
import { Timeline, type TimelineItem } from '@/components/ui/timeline';
import { formatPaise } from '@/modules/deals/dto';
import type { ServiceItemFileView } from '@/modules/fulfilment/booking-form-contract';
import {
  DEPARTMENT_EVIDENCE_KIND_LABEL,
  FLIGHT_TASK_STATUS_LABEL,
  PURCHASE_TASK_STATUS_LABEL,
  VISA_TASK_STATUS_LABEL,
  type DepartmentEvidenceView,
  type DepartmentTaskStatus,
} from '@/modules/fulfilment/contracts';
import { PURCHASE_EVIDENCE_KIND_LABEL, type PurchaseEvidenceView } from '@/modules/procurement/contracts';
import { TASK_TAB_LABEL, tabHref, type DepartmentTaskTabsVM, type TaskHistoryVM, type TaskTab } from '@/modules/settings/contracts';
import type { IdProofsState } from '../b11/id-proofs-list';
import { formatIst } from '../deal-labels';
import { TASK_HISTORY_TEXT } from './task-history-vm';
import { defaultQueueShow, QUEUE_SHOW_LABEL, queueAddress, queueShowsFor, type QueueShow, type QueueSort } from './queue-show';

/*
 * Department task frame (Direction A Batch 4, DA-16, DA-270 to DA-273,
 * screen plan PU-02 / FL-02 / VI-02). Shared by the Purchase, Flight and
 * Visa & Passport task pages and lists: status word with an icon (never
 * colour alone), one "Next:" line (replaces the Who acts next / Next step
 * cards), link tabs Details · Work · Files · History (shadcn Tabs 953 look,
 * no counts, no Money tab), a read-only Files list of the existing audited
 * download links and the task's History (CRM Timeline). Server-safe: no
 * hooks, no data access; the Visa page (a client component) imports it too.
 * Catalog gap G8 (task list) and G9 (record header) compositions.
 */

export type TaskDepartment = 'purchase' | 'flight' | 'visa';

const STATUS_LABEL: Record<TaskDepartment, Partial<Record<DepartmentTaskStatus, string>>> = {
  purchase: PURCHASE_TASK_STATUS_LABEL,
  flight: FLIGHT_TASK_STATUS_LABEL,
  visa: VISA_TASK_STATUS_LABEL,
};

/** R3 (C3): task states read from the one shared status table; the department's own words stay on the badge. */
const STATUS_KIND: Record<DepartmentTaskStatus, StatusKind> = {
  not_started: 'waiting_to_be_taken',
  in_progress: 'in_progress',
  supplier_confirmed: 'confirmed_by_supplier',
  completed: 'completed',
};

/** M14: a budget of zero or none means none was entered, never an approved ₹0.00. */
export function budgetText(paise: string | null | undefined): string {
  if (!paise) return 'Budget not set';
  try {
    return BigInt(paise) === 0n ? 'Budget not set' : formatPaise(paise);
  } catch {
    return 'Budget not set';
  }
}

export function taskStatusText(department: TaskDepartment, status: DepartmentTaskStatus): string {
  return STATUS_LABEL[department][status] ?? STATUS_LABEL.visa[status] ?? status;
}

/** DA-271 status word with its icon (shared status table, C3: tone, icon and words, never colour alone). */
export function TaskStatusBadge({ department, status, wrap = false }: { department: TaskDepartment; status: DepartmentTaskStatus; wrap?: boolean }) {
  return <Status kind={STATUS_KIND[status] ?? 'not_known'} label={taskStatusText(department, status)} srPrefix="Task status: " wrap={wrap} />;
}

const DEPARTMENT_ACTOR: Record<TaskDepartment, string> = {
  purchase: 'Purchase',
  flight: 'Flight',
  visa: 'the Visa and passport desk',
};

/**
 * DA-272 "Next:" text (lower case after "Next:"). Flight has no "ticket issued"
 * command in the CRM yet, so its in-progress line names the real work instead.
 */
export function taskNextText(t: {
  department: TaskDepartment;
  status: DepartmentTaskStatus;
  assignedToYou: boolean;
  assigneeName: string | null;
  canClaim: boolean;
}): string {
  if (t.status === 'supplier_confirmed' || t.status === 'completed') return 'Nothing waiting.';
  if (!t.assignedToYou && !t.assigneeName) return t.canClaim ? 'take this task' : `${DEPARTMENT_ACTOR[t.department]} takes this task`;
  if (t.assignedToYou) {
    if (t.department === 'purchase') return 'record the supplier’s confirmation';
    if (t.department === 'flight') return 'issue the ticket, then record the fare on the Work tab'; // DA-279
    return 'finish the steps on the Work tab';
  }
  return `${t.assigneeName} works on this task`;
}

/** One "Next:" line under the header; "Nothing waiting." has no prefix. */
export function TaskNextLine({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-col gap-1.5">
      <p className="m-0 text-copy" data-slot="task-next">
        {text === 'Nothing waiting.' ? (
          text
        ) : (
          <>
            <span className="font-semibold text-ink">Next:</span> {text}
          </>
        )}
      </p>
      {children}
    </div>
  );
}

/** "Taken by" value for headers and lists. */
export function takenByText(t: { assignedToYou: boolean; assigneeName: string | null }): string {
  if (t.assignedToYou) return 'You';
  return t.assigneeName ?? 'Not taken yet';
}

export function TaskBackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <p className="m-0 mb-3">
      <Link href={href} className={cn('inline-flex items-center gap-1 rounded-chip text-sm font-medium text-brand-strong no-underline hover:text-brand-deep hover:underline', focusRing)}>
        <ChevronLeft aria-hidden="true" className="size-4" />
        {children}
      </Link>
    </p>
  );
}

/** Internal-task reassurance line (lock icon + words). */
export function InternalTaskLine({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 flex gap-2 text-sm text-quiet" data-slot="task-internal">
      <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-faint" />
      <span>{children}</span>
    </p>
  );
}

/**
 * Link tabs (DA-16). No tab bar for a status-only viewer (tabs = []). Never a count.
 * `defaultTab` is the tab the bare address opens for this viewer (D6: Work for
 * the task holder); it keeps the bare address and every other tab gets its
 * `?tab=`, so Details stays reachable when the page opens on Work.
 */
export function TaskTabsNav({
  basePath,
  tabs,
  defaultTab = 'details',
  variant = 'underline',
}: {
  basePath: string;
  tabs: DepartmentTaskTabsVM;
  defaultTab?: TaskTab;
  variant?: TabsVariant;
}) {
  if (tabs.tabs.length === 0) return null;
  return (
    <Tabs
      label="Task sections"
      className="mb-5"
      variant={variant}
      items={tabs.tabs.map((tab) => ({ href: tabHref(basePath, tab, defaultTab), label: TASK_TAB_LABEL[tab], current: tab === tabs.current }))}
    />
  );
}

// ---------------------------------------------------------------------------
// Files tab (DA-270): read-only list of the links the viewer already gets
// ---------------------------------------------------------------------------

/** Files this viewer may open on this task. Each link is the existing audited route. */
export interface TaskFilesVM {
  /** Purchase files (stored only are linked). Purchase and the branch Manager only. */
  purchase?: PurchaseEvidenceView[];
  /** Department documents: fee receipts, direct-payment proofs, applicant documents, authority outcomes. */
  department?: DepartmentEvidenceView[];
  /** Flight screenshots from the booking form (Flight assignee only). */
  flight?: ServiceItemFileView[];
  /** The travellers' ID proofs for the assignee (DEC-41). */
  idProofs?: IdProofsState;
}

export const TASK_FILES_TEXT = {
  note: 'Only files for this task. Customer payment proofs and acceptance messages are never listed here.',
  empty: 'No files on this task yet.',
  idProofsError: 'The ID proofs could not be loaded just now. Reload the page to try again.',
  idProofsRefused: 'Your session could not show the ID proofs. Sign in again or reload the page to see them.',
} as const;

interface FileLine {
  key: string;
  href: string;
  name: string;
  meta: string;
}

function FileGroup({ id, title, lines }: { id: string; title: string; lines: FileLine[] }) {
  if (lines.length === 0) return null;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h3 id={id} className="m-0 text-base font-semibold text-ink">
        {title}
      </h3>
      <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label={title}>
        {lines.map((f) => (
          <li key={f.key} className="m-0 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
            <FileText aria-hidden="true" className="size-4 shrink-0 text-faint" />
            <a href={f.href} rel="noopener" className={cn('rounded-chip font-medium wrap-anywhere text-brand-strong underline underline-offset-4 hover:text-brand-deep', focusRing)}>
              {f.name}
            </a>
            <span className="text-quiet">{f.meta}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function TaskFilesPanel({ files }: { files: TaskFilesVM }) {
  const purchase: FileLine[] = (files.purchase ?? [])
    .filter((f) => f.status === 'stored')
    .map((f) => ({ key: f.id, href: `/app/purchase/files/${f.id}`, name: f.fileName, meta: `${PURCHASE_EVIDENCE_KIND_LABEL[f.kind]} · ${sizeLabel(f.sizeBytes)} · ${formatIst(f.createdAt)}` }));
  const flight: FileLine[] = (files.flight ?? []).map((f) => ({ key: f.fileId, href: f.downloadHref, name: f.fileName, meta: `Flight screenshot · ${f.sizeLabel}` }));
  const department: FileLine[] = (files.department ?? [])
    .filter((f) => f.status === 'stored')
    .map((f) => ({ key: f.id, href: `/app/department/evidence/${f.id}`, name: f.fileName, meta: `${DEPARTMENT_EVIDENCE_KIND_LABEL[f.kind]} · ${f.sizeLabel} · ${formatIst(f.uploadedAt)}` }));
  const proofs = files.idProofs;
  const idProofs: FileLine[] =
    proofs && proofs !== 'error' && proofs !== 'refused'
      ? proofs.travellers.flatMap((t) =>
          t.idProofs.map((f) => ({ key: f.fileId, href: f.downloadHref, name: f.fileName, meta: `ID proof of ${t.fullName || `traveller ${t.seq}`} · ${f.sizeLabel}` })),
        )
      : [];
  const total = purchase.length + flight.length + department.length + idProofs.length;
  return (
    <Card>
      <section aria-labelledby="task-files-heading">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id="task-files-heading">Files</CardTitle>
            <CardDescription>{TASK_FILES_TEXT.note}</CardDescription>
          </div>
          <FolderOpen aria-hidden="true" className="size-4 text-faint" />
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          {proofs === 'error' || proofs === 'refused' ? <Notice tone="warning">{proofs === 'error' ? TASK_FILES_TEXT.idProofsError : TASK_FILES_TEXT.idProofsRefused}</Notice> : null}
          {total === 0 ? <p className="m-0 text-quiet">{TASK_FILES_TEXT.empty}</p> : null}
          <FileGroup id="task-files-purchase" title="Purchase files" lines={purchase} />
          <FileGroup id="task-files-flight" title="Flight screenshots" lines={flight} />
          <FileGroup id="task-files-department" title="Department files" lines={department} />
          <FileGroup id="task-files-id" title="Traveller ID proofs" lines={idProofs} />
          {idProofs.length > 0 ? <InternalTaskLine>Private identity documents for this work. Every view is recorded.</InternalTaskLine> : null}
        </CardBody>
      </section>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// History tab (DA-270): only this task's events; a failed read is never "none"
// ---------------------------------------------------------------------------

export function TaskHistoryPanel({ history }: { history: TaskHistoryVM }) {
  let body: ReactNode;
  if (history.state === 'error') body = <Notice tone="warning" role="status">{TASK_HISTORY_TEXT.error}</Notice>;
  else if (history.state === 'not_installed') body = <Notice tone="locked" role="status">{TASK_HISTORY_TEXT.notInstalled}</Notice>;
  else if (history.events.length === 0) body = <EmptyState icon={History} headingLevel={3} title="No history yet" description={TASK_HISTORY_TEXT.empty} />;
  else {
    const items: TimelineItem[] = history.events.map((e) => ({
      id: e.id,
      title: e.title,
      meta: `${formatIst(e.at)}${e.byText ? ` · by ${e.byText === 'You' ? 'you' : e.byText}` : ''}`,
      detail: e.detail ? <span className="wrap-break-word">{e.detail}</span> : undefined,
      state: 'done',
    }));
    body = <Timeline label="Task history, newest first" items={items} />;
  }
  return (
    <Card>
      <section aria-labelledby="task-history-heading">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id="task-history-heading">History</CardTitle>
            <CardDescription>What happened on this task. No amounts are shown here.</CardDescription>
          </div>
        </CardHeader>
        <CardBody>{body}</CardBody>
      </section>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Lists: Not taken · Mine · All (counts from the rows already on the page)
// ---------------------------------------------------------------------------

export function QueueShowTabs({
  basePath,
  show,
  canTakeTasks,
  counts,
  label,
  keep,
  extra = [],
  variant = 'underline',
}: {
  basePath: string;
  /** null = another list is open (for example Payment requests beside Purchase tasks). */
  show: QueueShow | null;
  canTakeTasks: boolean;
  /** Counts from the rows already on the page; omitted when this page did not read the tasks. */
  counts?: Record<QueueShow, number>;
  label: string;
  /** R3: the search and sort carried over when the tab changes (the chip is not: it belongs to one tab's rows). */
  keep?: { q?: string; sort?: QueueSort };
  /** R3: more list tabs after All (for example "Payment requests"). */
  extra?: TabItem[];
  variant?: TabsVariant;
}) {
  const items: TabItem[] = queueShowsFor(canTakeTasks).map((s) => ({
    href: queueAddress(basePath, { show: s === defaultQueueShow(canTakeTasks) ? null : s, q: keep?.q, sort: keep?.sort }),
    label: (
      <>
        {QUEUE_SHOW_LABEL[s]}
        <span className="sr-only">:</span>
      </>
    ),
    current: s === show,
    count: counts?.[s],
  }));
  return <Tabs label={label} className="mb-4" variant={variant} items={[...items, ...extra]} />;
}

/** Empty list (DA-273) or an empty tab of a non-empty list. */
export function QueueEmpty({ icon, anyTasks, show, serviceWords }: { icon: LucideIcon; anyTasks: boolean; show: QueueShow; serviceWords: string }) {
  if (!anyTasks) {
    return <EmptyState icon={icon} headingLevel={2} title="No tasks here yet" description={`Tasks appear after Sales submits a booking with ${serviceWords}.`} />;
  }
  return (
    <EmptyState
      icon={icon}
      headingLevel={2}
      title={show === 'mine' ? 'No tasks taken by you' : 'Nothing waiting to be taken'}
      description={show === 'mine' ? 'Open the Not taken tab to pick one up.' : 'Open the All tab to see who has each task.'}
    />
  );
}
