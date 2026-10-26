import type { ReactNode } from 'react';
import type { FlightTaskView, PurchaseTaskSummary, TaskIdProofsView, VisaQueueView } from '@/modules/fulfilment/contracts';
import { taskTabsFor, type DepartmentTaskHistoryRecord, type TaskTab } from '@/modules/settings/contracts';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import { DepartmentCostCard } from '@/views/b11/department-cost';
import { TravellerIdProofsCard } from '@/views/b11/id-proofs-list';
import { VisaQueuePage, VisaTaskPage } from '@/views/b11/visa-desk';
import type { QueueShow } from '@/views/department/queue-show';
import { toTaskHistoryVM } from '@/views/department/task-history-vm';
import type { TaskFilesVM } from '@/views/department/task-frame';
import { FlightQueuePage, FlightTaskPage } from '@/views/flight-views';
import { PurchaseWorkSection } from '@/views/procurement-views';
import { PurchaseQueuePage, PurchaseTaskPage } from '@/views/purchase-views';
import { flight, flightView, purchase, purchaseQueue, purchaseView } from './b1-states';
import { applicant, cost, costActions, docs, outcomeDoc, proof, visaActions, visaDesk, visaTask } from './b11-work-states';
import { previewB11SavedAction } from './b11-preview-actions';
import { confirmed as confirmedWs, inProgress, managerView, task as hotelTask } from './procurement-states';

/*
 * Batch 4 preview states: Luna dept track (Purchase, Flight, Visa task lists
 * with Not taken · Mine · All, and task pages with Details · Work · Files ·
 * History). Synthetic props only (example names, made-up amounts, no real
 * supplier, traveller or customer data); rendered by the design-review
 * gallery (page.tsx), never in production.
 */

const manager: ShellViewer = { ...purchase, displayName: 'Synthetic Manager Delhi', primaryRole: 'Manager', primaryBranch: 'Delhi' };
const sales: ShellViewer = { ...purchase, displayName: 'Synthetic Sales Delhi A', primaryRole: 'Sales', primaryBranch: 'Delhi', canSeePurchaseTasks: false };

// --- Shared fixtures ----------------------------------------------------------

const ID_PROOFS: TaskIdProofsView = {
  taskId: hotelTask.taskId,
  travellers: [
    { seq: 1, fullName: 'Sample Traveller A', type: 'adult', idProofs: [{ fileId: 'ip000000-0000-4000-8000-000000000001', fileName: 'sample-id-a.pdf', mime: 'application/pdf', sizeLabel: '210 KB', storedAt: '2026-10-02T06:00:00Z', downloadHref: '/preview/b4-purchase-task-files' }] },
    { seq: 2, fullName: 'Sample Traveller B', type: 'adult', idProofs: [] },
  ],
};

function history(department: 'purchase' | 'flight' | 'visa', events: DepartmentTaskHistoryRecord['events']): DepartmentTaskHistoryRecord {
  return { taskId: hotelTask.taskId, department, events, truncated: false };
}

const ev = (over: Partial<DepartmentTaskHistoryRecord['events'][number]> & Pick<DepartmentTaskHistoryRecord['events'][number], 'kind' | 'at'>): DepartmentTaskHistoryRecord['events'][number] => ({
  byName: null,
  byYou: false,
  toName: null,
  toYou: false,
  applicantSeq: null,
  state: null,
  note: null,
  ...over,
});

const PURCHASE_HISTORY = history('purchase', [
  ev({ kind: 'file_added', at: '2026-10-03T06:05:00Z', byYou: true }),
  ev({ kind: 'cost_recorded', at: '2026-10-03T06:00:00Z', byYou: true }),
  ev({ kind: 'offer_added', at: '2026-10-03T05:10:00Z', byYou: true }),
  ev({ kind: 'reassigned', at: '2026-10-02T09:00:00Z', byName: null, toYou: true }),
  ev({ kind: 'taken', at: '2026-10-02T08:00:00Z', byName: null }),
  ev({ kind: 'created', at: '2026-10-02T07:05:00Z' }),
]);

const FLIGHT_HISTORY = history('flight', [
  ev({ kind: 'accounts_returned', at: '2026-11-05T08:00:00Z', note: 'The card slip is unreadable. Upload a clearer copy (synthetic).' }),
  ev({ kind: 'sent_to_accounts', at: '2026-11-04T10:00:00Z', byYou: true }),
  ev({ kind: 'cost_recorded', at: '2026-11-04T09:40:00Z', byYou: true }),
  ev({ kind: 'taken', at: '2026-10-09T08:00:00Z', byYou: true }),
  ev({ kind: 'created', at: '2026-10-09T07:05:00Z' }),
]);

const VISA_HISTORY = history('visa', [
  ev({ kind: 'applicant_stage', at: '2026-11-05T06:00:00Z', byYou: true, applicantSeq: 1, state: 'submitted' }),
  ev({ kind: 'applicant_updated', at: '2026-11-04T06:00:00Z', byName: 'Synthetic Visa Desk Jodhpur', applicantSeq: 2 }),
  ev({ kind: 'taken', at: '2026-11-02T09:30:00Z', byName: 'Synthetic Visa Desk Jodhpur' }),
  ev({ kind: 'created', at: '2026-11-02T09:00:00Z' }),
]);

function tabsOf(current: TaskTab, has: { work: boolean; files: boolean; history: boolean } = { work: true, files: true, history: true }) {
  const tabs = taskTabsFor(has);
  return { tabs, current: tabs.includes(current) ? current : 'details' } as const;
}

function shell(viewer: ShellViewer, path: string, body: ReactNode): ReactNode {
  return (
    <StaffShell viewer={viewer} currentPath={path}>
      {body}
    </StaffShell>
  );
}

// --- Purchase -----------------------------------------------------------------

const PURCHASE_QUEUE: PurchaseTaskSummary[] = [
  ...purchaseQueue,
  { ...purchaseQueue[0]!, taskId: 'f0000000-0000-4000-8000-0000000000a4', itemTitle: 'Synthetic Fort View Stay, Jodhpur', status: 'supplier_confirmed', assigneeName: 'Synthetic Purchase Colleague', assignedToYou: false, purchaseBudgetPaise: '0', supplierConfirmedAt: '2026-10-09T09:30:00Z' },
];

function purchaseQueuePage(viewer: ShellViewer, canTake: boolean, show?: QueueShow, tasks = PURCHASE_QUEUE): ReactNode {
  return shell(viewer, '/app/purchase', <PurchaseQueuePage queue={{ tasks }} canTakeTasks={canTake} show={show} />);
}

const idProofsCard = <TravellerIdProofsCard state={ID_PROOFS} />;
const purchaseWork = (
  <div className="flex flex-col gap-5">
    <PurchaseWorkSection ws={inProgress} />
    <DepartmentCostCard taskId={hotelTask.taskId} department="purchase" costs={[]} canRecord={false} readOnlyReason={null} />
  </div>
);
const PURCHASE_FILES: TaskFilesVM = { purchase: inProgress.evidence, idProofs: ID_PROOFS };

function purchaseTask(tab: TaskTab, extra: Partial<Parameters<typeof PurchaseTaskPage>[0]> = {}): ReactNode {
  return shell(
    purchase,
    '/app/purchase',
    <PurchaseTaskPage
      task={hotelTask}
      tabs={tabsOf(tab)}
      idProofs={tab === 'details' ? idProofsCard : undefined}
      work={tab === 'work' ? purchaseWork : undefined}
      files={tab === 'files' ? PURCHASE_FILES : undefined}
      history={tab === 'history' ? toTaskHistoryVM(PURCHASE_HISTORY, 'purchase') : undefined}
      {...extra}
    />,
  );
}

// --- Flight -------------------------------------------------------------------

const flightMine: FlightTaskView = {
  ...flightView,
  status: 'in_progress',
  assigneeName: 'Synthetic Flight Jodhpur',
  assignedToYou: true,
  canClaim: false,
  participants: [
    { seq: 1, fullName: 'Sample Traveller A', type: 'adult', ageYears: null, specialNeeds: null },
    { seq: 2, fullName: 'Sample Traveller B', type: 'adult', ageYears: null, specialNeeds: null },
  ],
  files: [{ fileId: 'ff000000-0000-4000-8000-000000000001', kind: 'flight_screenshot', fileName: 'sample-fare-screenshot.png', sizeLabel: '240 KB', uploadedAt: '2026-10-09T07:00:00Z', uploadedByYou: false, downloadHref: '/preview/b4-flight-task-files' }] as FlightTaskView['files'],
};
const flightCost = <DepartmentCostCard taskId={flightMine.taskId} department="flight" costs={[cost({ receiptEvidenceId: proof.id, expenseStatus: 'returned', returnReason: 'The card slip is unreadable. Upload a clearer copy (synthetic).', canSubmit: true })]} evidence={[proof]} canRecord readOnlyReason={null} actions={costActions} />;

function flightTask(tab: TaskTab, task: FlightTaskView = flightMine, has?: { work: boolean; files: boolean; history: boolean }): ReactNode {
  return shell(
    flight,
    '/app/flight',
    <FlightTaskPage
      task={task}
      claimAction={previewB11SavedAction}
      tabs={tabsOf(tab, has)}
      idProofs={tab === 'details' ? idProofsCard : undefined}
      workForm={tab === 'work' ? flightCost : undefined}
      files={tab === 'files' ? { flight: task.files, department: [proof], idProofs: ID_PROOFS } : undefined}
      history={tab === 'history' ? toTaskHistoryVM(FLIGHT_HISTORY, 'flight') : undefined}
    />,
  );
}

const FLIGHT_QUEUE = { tasks: [flightView, { ...flightMine }, { ...flightView, taskId: 'f0000000-0000-4000-8000-0000000000b6', itemTitle: 'JAI → DEL', status: 'supplier_confirmed' as const, assigneeName: 'Synthetic Flight Colleague', purchaseBudgetPaise: '9000000', supplierConfirmedAt: '2026-10-09T09:30:00Z' }] };

// --- Visa ---------------------------------------------------------------------

const visaQueue = (launch: VisaQueueView['launch'], tasks = true): VisaQueueView => ({
  launch,
  waitingCount: launch === 'off' ? 3 : null,
  tasks: tasks ? [visaTask(), visaTask({ taskId: 'vt2', serviceType: 'passport', itemTitle: 'Renewal · Jaipur', facts: { applicationType: 'renewal', officeCity: 'Jaipur', neededBy: '2026-11-01' }, status: 'not_started', assigneeName: null, assignedToYou: false })] : [],
});

function visaTaskState(tab: TaskTab, over: Parameters<typeof visaTask>[0] = {}): ReactNode {
  const t = visaTask({ evidence: [outcomeDoc, { ...proof, id: 'de4', kind: 'fee_receipt', fileName: 'synthetic-fee-receipt.pdf' }], ...over });
  return shell(
    visaDesk,
    '/app/visa',
    <VisaTaskPage
      task={t}
      actions={visaActions}
      tabs={tabsOf(tab)}
      idProofs={tab === 'details' ? idProofsCard : undefined}
      files={tab === 'files' ? { department: t.evidence, idProofs: ID_PROOFS } : undefined}
      history={tab === 'history' ? toTaskHistoryVM(VISA_HISTORY, 'visa') : undefined}
    />,
  );
}

const STATES: Record<string, () => ReactNode> = {
  // Purchase lists
  'b4-purchase-queue': () => purchaseQueuePage(purchase, true),
  'b4-purchase-queue-mine': () => purchaseQueuePage(purchase, true, 'mine'),
  'b4-purchase-queue-all': () => purchaseQueuePage(purchase, true, 'all'),
  'b4-purchase-queue-manager': () => purchaseQueuePage(manager, false),
  'b4-purchase-queue-empty': () => purchaseQueuePage(purchase, true, undefined, []),
  'b4-purchase-queue-mine-empty': () => purchaseQueuePage(purchase, true, 'mine', PURCHASE_QUEUE.filter((t) => !t.assignedToYou)),
  // Purchase task tabs
  'b4-purchase-task-details': () => purchaseTask('details'),
  'b4-purchase-task-work': () => purchaseTask('work'),
  'b4-purchase-task-files': () => purchaseTask('files'),
  'b4-purchase-task-files-empty': () => purchaseTask('files', { files: { purchase: [], idProofs: null } }),
  'b4-purchase-task-files-id-error': () => purchaseTask('files', { files: { purchase: inProgress.evidence, idProofs: 'error' } }),
  'b4-purchase-task-history': () => purchaseTask('history'),
  'b4-purchase-task-history-empty': () => purchaseTask('history', { history: toTaskHistoryVM(history('purchase', []), 'purchase') }),
  'b4-purchase-task-history-error': () => purchaseTask('history', { history: toTaskHistoryVM('error', 'purchase') }),
  'b4-purchase-task-history-not-installed': () => purchaseTask('history', { history: toTaskHistoryVM('not_installed', 'purchase') }),
  'b4-purchase-task-not-taken': () =>
    shell(purchase, '/app/purchase', <PurchaseTaskPage task={purchaseView(purchaseQueue[0]!)} tabs={tabsOf('details', { work: true, files: true, history: true })} />),
  'b4-purchase-task-confirmed': () =>
    shell(purchase, '/app/purchase', <PurchaseTaskPage task={confirmedWs.task} tabs={tabsOf('work')} work={<PurchaseWorkSection ws={confirmedWs} />} />),
  'b4-purchase-task-manager': () =>
    shell(manager, '/app/purchase', <PurchaseTaskPage task={managerView.task} managerReadOnly tabs={tabsOf('work')} work={<PurchaseWorkSection ws={managerView} />} />),
  'b4-purchase-task-manager-details': () => shell(manager, '/app/purchase', <PurchaseTaskPage task={managerView.task} managerReadOnly tabs={tabsOf('details')} />),
  // Sales opening a Purchase task: status only, no tab bar (R11).
  'b4-purchase-task-sales': () => shell(sales, '/app/deals', <PurchaseTaskPage task={{ ...confirmedWs.task, assignedToYou: false }} tabs={tabsOf('details', { work: false, files: false, history: false })} />),
  // Flight
  'b4-flight-queue': () => shell(flight, '/app/flight', <FlightQueuePage queue={FLIGHT_QUEUE} canTakeTasks />),
  'b4-flight-queue-mine': () => shell(flight, '/app/flight', <FlightQueuePage queue={FLIGHT_QUEUE} canTakeTasks show="mine" />),
  'b4-flight-queue-all': () => shell(flight, '/app/flight', <FlightQueuePage queue={FLIGHT_QUEUE} canTakeTasks show="all" />),
  'b4-flight-task-details': () => flightTask('details'),
  'b4-flight-task-work': () => flightTask('work'),
  'b4-flight-task-files': () => flightTask('files'),
  'b4-flight-task-history': () => flightTask('history'),
  'b4-flight-task-not-taken': () => flightTask('details', flightView),
  // Visa
  'b4-visa-queue': () => shell(visaDesk, '/app/visa', <VisaQueuePage queue={visaQueue('on')} />),
  'b4-visa-queue-all': () => shell(visaDesk, '/app/visa', <VisaQueuePage queue={visaQueue('on')} show="all" />),
  'b4-visa-queue-off': () => shell(visaDesk, '/app/visa', <VisaQueuePage queue={visaQueue('off', false)} />),
  'b4-visa-queue-unknown': () => shell(visaDesk, '/app/visa', <VisaQueuePage queue={visaQueue('unknown')} show="all" />),
  'b4-visa-task-details': () => visaTaskState('details'),
  'b4-visa-task-work': () => visaTaskState('work', { applicants: [applicant({ documents: docs(['checked', 'checked', 'checked']) })] }),
  'b4-visa-task-files': () => visaTaskState('files'),
  'b4-visa-task-history': () => visaTaskState('history'),
  'b4-visa-task-not-taken': () => visaTaskState('details', { status: 'not_started', assigneeName: null, assignedToYou: false, canClaim: true, canWork: false }),
};

export const BATCH4_DEPT_PREVIEW_STATES = Object.keys(STATES);

export function renderBatch4DeptState(state: string): ReactNode | null {
  return STATES[state]?.() ?? null;
}
