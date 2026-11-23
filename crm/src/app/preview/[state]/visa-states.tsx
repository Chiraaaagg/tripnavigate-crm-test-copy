import type { ReactNode } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import type { TaskTab } from '@/modules/settings/contracts';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import type { DealServicesView, ServiceItemView } from '@/modules/fulfilment/contracts';
import { DealServicesCard } from '@/views/deal-services-view';
import { DealHistoryTab } from '@/views/deal-workspace/history';
import { toTaskHistoryVM } from '@/views/department/task-history-vm';
import { HomeView, NO_HOME_ROLES } from '@/views/home-view';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import type { VisaWorkActions } from '@/views/visa/actions';
import { DealVisaCard, DealVisaUnavailable } from '@/views/visa/deal-visa-card';
import { VisaQueueError, VisaQueueLoading, VisaQueuePage } from '@/views/visa/queue';
import type { VisaApplicant, VisaWorkspace } from '@/views/visa/types';
import { VisaTaskLoading, VisaTaskNotAvailable, VisaTaskPage, type VisaTaskPageProps } from '@/views/visa/workspace';
import { renderBookformState } from './bookform-states';
import { applicant, applied, DEAL, DEAL_SUMMARY, docs, NAMES, QUEUE, ready, steps, T_PASSPORT, workspace } from './visa-fixtures';
import * as A from './visa-preview-actions';

/*
 * Visa build preview states (visa-): the queue (desk and Manager), the task
 * page in each state, every Work-tab popup (open on first paint; the
 * "-refused" ones answer Save with the refusal), the Deal visa card with
 * notices, Deal History, Home rows and the Book now visa drawer. Synthetic
 * props only; rendered by the design-review gallery only.
 */

const visaViewer: ShellViewer = { displayName: 'Synthetic Visa Jodhpur', primaryRole: 'Visa', primaryBranch: 'Jodhpur', canAdministerStaff: false, canManageGrants: false, canSeeVisaDesk: true };
const managerViewer: ShellViewer = { ...visaViewer, displayName: 'Synthetic Manager Jodhpur', primaryRole: 'Manager', canSeeLeads: true, canSeeApprovals: true, canSeePurchaseTasks: true, canSeeFlightTasks: true };
const salesViewer: ShellViewer = { ...visaViewer, displayName: 'Synthetic Sales Jodhpur', primaryRole: 'Sales', canSeeVisaDesk: false };

const act = (a: unknown) => a as DecisionAction;

function actions(over: Partial<VisaWorkActions> = {}): VisaWorkActions {
  return {
    claim: act(A.vsClaim),
    saveRow: act(A.vsRowSaved),
    addDocument: act(A.vsDocAdded),
    removeDocument: act(A.vsDocRemoved),
    apply: act(A.vsApplied),
    decide: act(A.vsDecided),
    setHandover: act(A.vsHandover),
    markDelivered: act(A.vsDelivered),
    withdraw: act(A.vsWithdrawn),
    reapply: act(A.vsReapplied),
    sendFee: act(A.vsFeeSent),
    saveOtherCost: act(A.vsOtherCost),
    confirmTraveller: act(A.vsConfirmed),
    uploadDocument: act(A.vsUploaded),
    uploadEvidence: act(A.vsEvidence),
    ...over,
  };
}

function shell(viewer: ShellViewer, path: string, body: ReactNode) {
  return (
    <StaffShell viewer={viewer} currentPath={path}>
      {body}
    </StaffShell>
  );
}

function page(ws: VisaWorkspace, tab: TaskTab, p: Partial<VisaTaskPageProps> = {}, viewer: ShellViewer = visaViewer) {
  return shell(viewer, '/app/visa', <VisaTaskPage ws={ws} tabs={{ tabs: ['details', 'work', 'files', 'history'], current: tab }} actions={actions()} {...p} />);
}

/* ---------- workspaces ---------- */

const notTaken = workspace({
  status: { code: 'not_taken', step: null, text: 'Not taken' },
  assignee: { name: null, isYou: false, takenAt: null },
  canClaim: true,
  canWork: false,
  applicants: [],
  steps: steps({ ready: 0, applied: 0, decision: 0, handover: 0 }, 0, false),
  catalogue: [],
  canUpload: false,
});

const docsStage = workspace();

const withChanges = workspace({
  applicants: [
    ready(1),
    applicant(2, { travellerChanged: { was: 'Synthetic Vikram Rao', now: 'Synthetic Vikram R. Rao' }, documents: docs(2, 3), appointment: { date: '2026-11-06', time: null }, notReady: ['traveller_changed'] }),
    applicant(3),
    applicant(4, { removed: true, notReady: ['removed'] }),
    applicant(5, { fullName: 'Synthetic New Traveller', documents: docs(5, 0) }),
  ],
  bookingChange: {
    versionNo: 3,
    at: '2026-11-07T07:00:00Z',
    added: [{ seq: 5, name: 'Synthetic New Traveller' }],
    removed: [{ seq: 4, name: NAMES[3]! }],
    back: [],
    renamed: [{ seq: 2, oldName: 'Synthetic Vikram Rao', newName: 'Synthetic Vikram R. Rao' }],
    documentsAdded: 2,
    fields: ['Documents needed'],
  },
});

const club = ['Synthetic Asha Rao', 'Synthetic Vikram Rao'];
const appliedWs = workspace({
  status: { code: 'in_progress', step: 'decision', text: 'Waiting for decision' },
  applicants: [applied(1, {}, true, [club[1]!]), applied(2, {}, true, [club[0]!]), ready(3), applicant(4, { documents: docs(4, 2) })],
  steps: steps({ ready: 3, applied: 2, decision: 0, handover: 0 }, 4),
});

const mixed = workspace({
  status: { code: 'in_progress', step: 'decision', text: 'Waiting for decision' },
  applicants: [
    applied(1, { state: 'issued', stateText: 'Approved', decision: { outcome: 'approved', at: '2026-11-07T08:00:00Z', remark: null, reason: null, proof: { evidenceId: 'e1000000-0000-4000-8000-000000000501', fileName: 'synthetic-visa-1.pdf' } }, handover: { kind: 'method', recipientEmail: null, sentAt: null, method: 'courier', courierNumber: 'SYN-COURIER-4410', deliveredOn: null, remark: null }, closed: { at: '2026-11-07T09:00:00Z', reason: 'courier_dispatched' } }),
    applied(2, { state: 'issued', stateText: 'Approved', decision: { outcome: 'approved', at: '2026-11-07T08:00:00Z', remark: null, reason: null, proof: null }, handover: { kind: 'method', recipientEmail: null, sentAt: null, method: 'office', courierNumber: null, deliveredOn: null, remark: null } }),
    applied(3, { state: 'refused', stateText: 'Rejected', decision: { outcome: 'rejected', at: '2026-11-07T09:00:00Z', remark: null, reason: 'Synthetic reason: the bank statement was older than six months.', proof: null } }),
    applied(4, { state: 'issued', stateText: 'Approved', decision: { outcome: 'approved', at: '2026-11-06T08:00:00Z', remark: null, reason: null, proof: null }, handover: { kind: 'method', recipientEmail: null, sentAt: null, method: 'executive', courierNumber: null, deliveredOn: '2026-11-07', remark: 'Synthetic: handed to the father.' }, closed: { at: '2026-11-07T10:00:00Z', reason: 'delivered' } }),
  ],
  steps: steps({ ready: 4, applied: 4, decision: 4, handover: 2 }, 4),
});
const handoverPending = workspace({ ...mixed, status: { code: 'in_progress', step: 'handover', text: 'Handover pending' }, applicants: [mixed.applicants[0]!, applied(2, { state: 'issued', stateText: 'Approved', decision: { outcome: 'approved', at: '2026-11-07T08:00:00Z', remark: null, reason: null, proof: null } }), mixed.applicants[2]!, mixed.applicants[3]!] });

const evisa = (n: number, over: Partial<VisaApplicant> = {}) =>
  applied(n, { visaKind: { value: 'e_visa', source: 'applied' }, jurisdiction: { required: null, place: null, source: null }, appointment: { date: null, time: null }, applied: { reference: `SYN-EV-26-${200 + n}`, appliedOn: '2026-11-03', clubId: null, clubWith: [], remark: null, passportTaken: false }, ...over });
const evisaWs = workspace({
  title: 'United Arab Emirates · Tourism',
  facts: { visa: { country: 'United Arab Emirates', purpose: 'Tourism', travelDate: '2026-11-20', applyBy: null, feePaidBy: 'customer', notes: null, visaKind: null, jurisdiction: null, jurisdictionPlace: null, documentsNeeded: ['Passport copy (front and back)', 'Photo, white background'] } },
  status: { code: 'in_progress', step: 'decision', text: 'Waiting for decision' },
  applicants: [
    evisa(1, { state: 'issued', stateText: 'Approved', decision: { outcome: 'approved', at: '2026-11-07T08:00:00Z', remark: null, reason: null, proof: null }, handover: { kind: 'evisa', recipientEmail: 'synthetic.family@example.test', sentAt: '2026-11-07T08:00:00Z', method: null, courierNumber: null, deliveredOn: null, remark: null }, closed: { at: '2026-11-07T08:00:00Z', reason: 'evisa_sent' } }),
    evisa(2),
    applicant(3, { visaKind: { value: null, source: null }, jurisdiction: { required: null, place: null, source: null }, documents: docs(3, 2, ['Passport copy (front and back)', 'Photo, white background']), notReady: ['kind_missing'] }),
  ],
  steps: steps({ ready: 2, applied: 2, decision: 1, handover: 1 }, 3),
});

const returnedWs = workspace({
  ...appliedWs,
  applicants: [
    applied(1, {
      fees: [
        { entryId: 'f1000000-0000-4000-8000-000000000011', costKind: 'government_fee', amountPaise: '650000', paidBy: 'company', paymentMode: 'upi', expenseStatus: 'returned', returnReason: 'Synthetic: the receipt shows ₹6,300. Upload the full receipt or correct the amount.', rowVersion: 2, receipt: { evidenceId: 'e1000000-0000-4000-8000-000000000900', fileName: 'synthetic-vfs-receipt.pdf' } },
        { entryId: 'f1000000-0000-4000-8000-000000000012', costKind: 'service_fee', amountPaise: '80000', paidBy: 'company', paymentMode: 'upi', expenseStatus: 'accepted', returnReason: null, rowVersion: 2, receipt: { evidenceId: 'e1000000-0000-4000-8000-000000000900', fileName: 'synthetic-vfs-receipt.pdf' } },
      ],
    }),
    applied(2, { fees: [{ entryId: 'f1000000-0000-4000-8000-000000000021', costKind: 'government_fee', amountPaise: '650000', paidBy: 'company', paymentMode: 'cash', expenseStatus: 'draft', returnReason: null, rowVersion: 1, receipt: null }] }),
    ready(3),
  ],
  returnedFees: [{ entryId: 'f1000000-0000-4000-8000-000000000011', applicantName: NAMES[0]!, costKind: 'government_fee', amountPaise: '650000', returnReason: 'Synthetic: the receipt shows ₹6,300. Upload the full receipt or correct the amount.', rowVersion: 2 }],
});

const completed = workspace({
  ...mixed,
  status: { code: 'completed', step: null, text: 'Completed' },
  canWork: false,
  applicants: mixed.applicants.map((a, i) => ({ ...a, closed: a.closed ?? { at: '2026-11-08T08:00:00Z', reason: i === 2 ? ('reapplied' as const) : ('delivered' as const) }, can: { edit: false, select: false, decide: false, handover: false, deliver: false, withdraw: false, reapply: false, confirmTraveller: false } })),
  steps: steps({ ready: 4, applied: 4, decision: 4, handover: 4 }, 4),
  addedAfterCompletion: 1,
});

/* Completed task, last assignee: fee work stays open (canManageFees, Track A 0140); everything else is read-only. */
const completedFee = (n: number, over: Partial<VisaApplicant['fees'][number]>) => ({
  entryId: `f1000000-0000-4000-8000-0000000000${40 + n}`,
  costKind: 'government_fee' as const,
  amountPaise: '650000',
  paidBy: 'company' as const,
  paymentMode: 'cash' as const,
  expenseStatus: 'draft' as const,
  returnReason: null,
  rowVersion: 1,
  receipt: null,
  ...over,
});
const completedDraftFee = workspace({
  ...completed,
  canManageFees: true,
  applicants: completed.applicants.map((a, i) =>
    i === 0 ? { ...a, fees: [completedFee(1, {}), { ...completedFee(5, { costKind: 'other', amountPaise: '45000', expenseStatus: 'draft' }) }] } : a,
  ),
});
const completedReturnedFee = workspace({
  ...completed,
  canManageFees: true,
  applicants: completed.applicants.map((a, i) =>
    i === 1
      ? { ...a, fees: [completedFee(2, { expenseStatus: 'returned', returnReason: 'Synthetic: the receipt is for another passenger.', paymentMode: 'upi', receipt: { evidenceId: 'e1000000-0000-4000-8000-000000000900', fileName: 'synthetic-vfs-receipt.pdf' } })] }
      : a,
  ),
  returnedFees: [{ entryId: 'f1000000-0000-4000-8000-000000000042', applicantName: NAMES[1]!, costKind: 'government_fee', amountPaise: '650000', returnReason: 'Synthetic: the receipt is for another passenger.', rowVersion: 1 }],
});

const reappliedWs = workspace({
  ...mixed,
  applicants: [mixed.applicants[0]!, mixed.applicants[1]!, applicant(3, { secondApplication: true, previousApplicationId: 'b1000000-0000-4000-8000-000000000003', documents: docs(3, 3), ready: true, notReady: [], appointment: { date: '2026-11-12', time: null } }), mixed.applicants[3]!],
  previousApplications: [{ applicationId: 'b1000000-0000-4000-8000-000000000003', seq: 3, reference: 'SYN-VFS-26-1103', state: 'refused', closed: true, decision: 'rejected' }],
});

const withdrawnWs = workspace({ ...appliedWs, applicants: [appliedWs.applicants[0]!, applicant(2, { state: 'withdrawn', stateText: 'Withdrawn', decision: { outcome: 'withdrawn', at: '2026-11-06T08:00:00Z', remark: null, reason: 'Synthetic: the customer cancelled this traveller.', proof: null }, closed: { at: '2026-11-06T08:00:00Z', reason: 'customer_informed' }, applied: null }), ready(3)] });

const passportApplicant = (over: Partial<VisaApplicant> = {}) =>
  applied(1, { visaKind: { value: null, source: null }, jurisdiction: { required: null, place: null, source: null }, documents: docs(1, 2, ['Aadhaar card', 'Birth certificate']), applied: { reference: 'SYN-PSK-26-0091', appliedOn: '2026-11-02', clubId: null, clubWith: [], remark: null, passportTaken: false }, ...over });
const passportWs = workspace({
  taskId: T_PASSPORT,
  serviceType: 'passport',
  dealReference: 'SYN-JOD-703',
  title: 'Fresh passport · Jodhpur',
  facts: { passport: { applicationType: 'fresh', officeCity: 'Jodhpur', neededBy: '2026-12-15', notes: null } },
  status: { code: 'in_progress', step: 'handover', text: 'Handover pending' },
  applicants: [passportApplicant({ state: 'issued', stateText: 'Approved', decision: { outcome: 'approved', at: '2026-11-07T08:00:00Z', remark: null, reason: null, proof: null } })],
  steps: steps({ ready: 1, applied: 1, decision: 1, handover: 0 }, 1),
});

const managerWs = (ws: VisaWorkspace): VisaWorkspace => ({
  ...ws,
  isManagerView: true,
  canWork: false,
  canClaim: false,
  canManageFees: false,
  assignee: { ...ws.assignee, isYou: false },
  catalogue: [],
  canUpload: false,
  applicants: ws.applicants.map((a) => ({ ...a, passport: null, can: { edit: false, select: false, decide: false, handover: false, deliver: false, withdraw: false, reapply: false, confirmTraveller: false } })),
});

/* Deal page Services tab: one visa and one passport item with their tasks (the "Next step" link per viewer). */
const visaServiceItem = (n: number, serviceType: 'visa' | 'passport', taskId: string): ServiceItemView => ({
  itemId: `51000000-0000-4000-8000-00000000000${n}`,
  itemNo: n,
  serviceType,
  department: 'visa',
  state: 'active',
  title: serviceType === 'visa' ? 'France · Tourism' : 'Fresh passport · Jodhpur',
  facts:
    serviceType === 'visa'
      ? { type: 'visa', facts: { country: 'France', purpose: 'Tourism', travelDate: '2027-02-06', applyBy: null, feePaidBy: 'company', notes: null, visaKind: 'sticker' } }
      : { type: 'passport', facts: { applicationType: 'fresh', officeCity: 'Jodhpur', neededBy: null, notes: null } },
  factsHash: String(n).repeat(64),
  task: { taskId, status: 'in_progress', assigneeName: 'Synthetic Visa Jodhpur', assignedToYou: false, supplierConfirmedAt: null },
  // The real loader gives an in-progress visa or passport task 'visa_processing' (20261119000500).
  nextStep: 'visa_processing',
});
const DEAL_SERVICES: DealServicesView = {
  dealId: DEAL,
  version: { versionId: '52000000-0000-4000-8000-000000000001', versionNo: 2, status: 'confirmed', rowVersion: 3, contentHash: 'a'.repeat(64), serviceType: 'package' },
  items: [visaServiceItem(1, 'visa', 'a1000000-0000-4000-8000-000000000001'), visaServiceItem(2, 'passport', T_PASSPORT)],
  progress: { total: 2, byState: { planned: 0, notStarted: 0, inProgress: 2, supplierConfirmed: 0 }, fulfilled: false, staleCount: 0, needs: ['visa_processing'] },
  canEdit: false,
  canConfirm: false,
};
function dealServices(viewer: ShellViewer, canOpenVisaDesk: boolean) {
  return shell(
    viewer,
    '/app/deals',
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Deal · SYN-JOD-701" title="Synthetic family trip to France" />
      <DealVisaCard summary={DEAL_SUMMARY} dealId={DEAL} actions={{ ackNotice: act(A.vsAck) }} canOpenTasks={canOpenVisaDesk} />
      <DealServicesCard services={DEAL_SERVICES} canOpenVisaDesk={canOpenVisaDesk} />
    </div>,
  );
}

const id = (ws: VisaWorkspace, n: number) => ws.applicants[n - 1]!.applicationId;
// Stable popup objects: a seeded popup is recognised by identity (the seed applies to the first popup only).
const APPLY_REFUSED_POPUP = { kind: 'apply' as const, ids: [id(docsStage, 1), id(docsStage, 2)] };
const APPROVE_REFUSED_POPUP = { kind: 'approve' as const, id: id(appliedWs, 1) };

const HISTORY = toTaskHistoryVM(
  {
    taskId: docsStage.taskId,
    truncated: false,
    events: [
      { at: '2026-11-07T09:00:00Z', kind: 'rejected', byYou: true, byName: null, applicantSeq: 3, note: 'Synthetic reason: the bank statement was older than six months.' },
      { at: '2026-11-07T08:00:00Z', kind: 'approved', byYou: true, byName: null, applicantSeq: 1, note: null },
      { at: '2026-11-04T07:00:00Z', kind: 'applied', byYou: true, byName: null, applicantSeq: 1, note: null, clubSize: 2 },
      { at: '2026-11-04T06:00:00Z', kind: 'document_added', byYou: true, byName: null, applicantSeq: 2, note: null },
      { at: '2026-11-03T05:30:00Z', kind: 'taken', byYou: true, byName: null, applicantSeq: null, note: null },
    ],
  } as never,
  'visa',
);

const states: Record<string, () => ReactNode> = {
  /* Queue */
  'visa-queue': () => shell(visaViewer, '/app/visa', <VisaQueuePage queue={QUEUE} show="not_taken" />),
  'visa-queue-mine': () => shell(visaViewer, '/app/visa', <VisaQueuePage queue={QUEUE} show="mine" />),
  'visa-queue-all': () => shell(visaViewer, '/app/visa', <VisaQueuePage queue={QUEUE} show="all" />),
  'visa-queue-manager': () => shell(managerViewer, '/app/visa', <VisaQueuePage queue={{ ...QUEUE, isManagerView: true, canTake: false, tasks: QUEUE.tasks.map((t) => ({ ...t, assignedToYou: false, canTake: false, isManagerView: true, assigneeName: t.assigneeName ? 'Synthetic Visa Jodhpur' : null })) }} show="all" />),
  'visa-queue-mixed-roles': () =>
    shell({ ...visaViewer, displayName: 'Synthetic Visa and Manager' }, '/app/visa', <VisaQueuePage queue={{ ...QUEUE, tasks: [...QUEUE.tasks, { ...QUEUE.tasks[1]!, taskId: 'a1000000-0000-4000-8000-000000000005', dealReference: 'SYN-DEL-801', branchName: 'Delhi', canTake: false, isManagerView: true }] }} show="all" />),
  'visa-queue-off': () => shell(visaViewer, '/app/visa', <VisaQueuePage queue={{ ...QUEUE, launch: 'off', waitingCount: 3, tasks: [] }} show="not_taken" />),
  'visa-queue-unknown': () => shell(visaViewer, '/app/visa', <VisaQueuePage queue={{ ...QUEUE, launch: 'unknown', waitingCount: null }} show="all" />),
  'visa-queue-empty': () => shell(visaViewer, '/app/visa', <VisaQueuePage queue={{ ...QUEUE, tasks: [] }} show="not_taken" />),
  'visa-queue-loading': () => shell(visaViewer, '/app/visa', <VisaQueueLoading />),
  'visa-queue-error': () => shell(visaViewer, '/app/visa', <VisaQueueError />),
  /* UX redesign R3 (C2): the queue toolbar's search, filter chip, sort and "nothing matches" states. */
  'visa-queue-search': () => shell(visaViewer, '/app/visa', <VisaQueuePage queue={QUEUE} show="all" q="france" />),
  'visa-queue-chip': () => shell(visaViewer, '/app/visa', <VisaQueuePage queue={QUEUE} show="all" only="decision" />),
  'visa-queue-sort-latest': () => shell(visaViewer, '/app/visa', <VisaQueuePage queue={QUEUE} show="all" sort="latest" />),
  'visa-queue-no-match': () => shell(visaViewer, '/app/visa', <VisaQueuePage queue={QUEUE} show="all" q="nothing-like-this" />),

  /* Task page */
  'visa-task-not-taken': () => page(notTaken, 'details'),
  'visa-task-not-taken-work': () => page(notTaken, 'work'),
  'visa-task-claim-conflict': () => page(notTaken, 'details', { preview: { claimState: { ok: false, code: 'task_conflict', message: 'Someone at the desk took this task first.' } } }),
  'visa-task-details': () => page(docsStage, 'details'),
  'visa-task-files': () => page(mixed, 'files'),
  'visa-task-history': () => page(mixed, 'history', { history: HISTORY }),
  'visa-task-not-found': () => shell(visaViewer, '/app/visa', <VisaTaskNotAvailable />),
  'visa-task-loading': () => shell(visaViewer, '/app/visa', <VisaTaskLoading />),

  /* Work tab: Passengers and documents */
  'visa-work': () => page(docsStage, 'work'),
  'visa-work-edit-row': () => page(docsStage, 'work', { preview: { editId: id(docsStage, 3) } }),
  'visa-work-edit-row-refused': () => page(docsStage, 'work', { actions: actions({ saveRow: act(A.vsRowRefused) }), preview: { editId: id(docsStage, 3) } }),
  'visa-work-edit-row-echo': () => page(docsStage, 'work', { actions: actions({ saveRow: act(A.vsRowEcho) }), preview: { editId: id(docsStage, 3) } }),
  'visa-work-edit-row-kind': () => page(evisaWs, 'work', { preview: { editId: id(evisaWs, 3) } }),
  'visa-work-booking-changed': () => page(withChanges, 'work'),
  'visa-popup-add-doc': () => page(docsStage, 'work', { preview: { popup: { kind: 'addDoc', id: id(docsStage, 3) }, editId: id(docsStage, 3) } }),
  'visa-popup-add-doc-refused': () => page(docsStage, 'work', { actions: actions({ addDocument: act(A.vsDocDuplicate) }), preview: { popup: { kind: 'addDoc', id: id(docsStage, 3) }, editId: id(docsStage, 3) } }),
  'visa-popup-upload-doc': () => page(docsStage, 'work', { preview: { popup: { kind: 'uploadDoc', id: id(docsStage, 3) }, editId: id(docsStage, 3) } }),
  'visa-popup-remove-doc': () => page(docsStage, 'work', { preview: { popup: { kind: 'removeDoc', id: id(docsStage, 3), documentId: docsStage.applicants[2]!.documents[2]!.documentId }, editId: id(docsStage, 3) } }),
  'visa-popup-other-cost': () => page(appliedWs, 'work', { preview: { popup: { kind: 'otherCost', id: id(appliedWs, 1) } } }),

  /* Work tab: Appointment */
  'visa-popup-apply': () => page(docsStage, 'work', { preview: { popup: { kind: 'apply', ids: [id(docsStage, 1)] } } }),
  'visa-popup-apply-club': () => page(docsStage, 'work', { preview: { popup: { kind: 'apply', ids: [id(docsStage, 1), id(docsStage, 2)] }, selected: [id(docsStage, 1), id(docsStage, 2)] } }),
  'visa-popup-apply-refused': () =>
    page(docsStage, 'work', {
      actions: actions({ apply: act(A.vsApplyDuplicateRef) }),
      preview: {
        popup: APPLY_REFUSED_POPUP,
        selected: [id(docsStage, 1), id(docsStage, 2)],
        seed: {
          references: ['SYN-VFS-26-1101', 'SYN-VFS-26-1101'],
          governmentFees: ['6,500', '6,500'],
          paymentMode: 'upi',
          remark: 'Synthetic: applied together at the centre.',
          result: { ok: false, code: 'duplicate_reference', message: 'This reference is already used on this task.', fields: ['applicants[1].reference'] },
        },
      },
    }),
  'visa-popup-apply-kind': () => page(evisaWs, 'work', { preview: { popup: { kind: 'apply', ids: [id(evisaWs, 2)] } } }),
  'visa-work-selected': () => page(docsStage, 'work', { preview: { selected: [id(docsStage, 1)] } }),
  'visa-work-applied': () => page(appliedWs, 'work'),
  'visa-popup-approve': () => page(appliedWs, 'work', { preview: { popup: { kind: 'approve', id: id(appliedWs, 1) } } }),
  'visa-popup-approve-refused': () =>
    page(appliedWs, 'work', {
      actions: actions({ decide: act(A.vsDecideNoProof) }),
      preview: {
        popup: APPROVE_REFUSED_POPUP,
        seed: {
          handoverMethod: 'courier',
          courierNumber: 'SYN-COURIER-4410',
          remark: 'Synthetic: visa valid for 90 days.',
          result: { ok: false, code: 'outcome_document_required', message: 'Upload the visa or refusal document first.', fields: ['outcomeEvidenceId'] },
        },
      },
    }),
  'visa-popup-approve-evisa': () => page(evisaWs, 'work', { preview: { popup: { kind: 'approve', id: id(evisaWs, 2) } } }),
  'visa-popup-reject': () => page(appliedWs, 'work', { preview: { popup: { kind: 'reject', id: id(appliedWs, 2) } } }),
  'visa-popup-reject-evisa': () => page(evisaWs, 'work', { preview: { popup: { kind: 'reject', id: id(evisaWs, 2) } } }),
  'visa-popup-withdraw': () => page(appliedWs, 'work', { preview: { popup: { kind: 'withdraw', id: id(appliedWs, 1) } } }),
  'visa-work-approved-evisa': () => page(evisaWs, 'work'),
  'visa-work-handover-pending': () => page(handoverPending, 'work'),
  'visa-popup-handover': () => page(handoverPending, 'work', { preview: { popup: { kind: 'handover', id: id(handoverPending, 2) } } }),
  'visa-popup-delivered': () => page(mixed, 'work', { preview: { popup: { kind: 'delivered', id: id(mixed, 2) } } }),
  'visa-popup-delivered-refused': () => page(mixed, 'work', { actions: actions({ markDelivered: act(A.vsDeliveredFuture) }), preview: { popup: { kind: 'delivered', id: id(mixed, 2) } } }),
  'visa-work-rejected': () => page(mixed, 'work'),
  'visa-popup-reapply': () => page(mixed, 'work', { preview: { popup: { kind: 'reapply', id: id(mixed, 3) } } }),
  'visa-work-second-application': () => page(reappliedWs, 'work'),
  'visa-work-withdrawn': () => page(withdrawnWs, 'work'),
  'visa-work-fee-returned': () => page(returnedWs, 'work'),
  'visa-popup-fix-fee': () => page(returnedWs, 'work', { preview: { popup: { kind: 'fee', entryId: 'f1000000-0000-4000-8000-000000000011' } } }),
  'visa-popup-fix-fee-refused': () => page(returnedWs, 'work', { actions: actions({ sendFee: act(A.vsFeeLocked) }), preview: { popup: { kind: 'fee', entryId: 'f1000000-0000-4000-8000-000000000011' } } }),
  'visa-popup-send-fee': () => page(returnedWs, 'work', { preview: { popup: { kind: 'fee', entryId: 'f1000000-0000-4000-8000-000000000021' } } }),
  'visa-work-completed': () => page(completed, 'work'),
  'visa-work-completed-draft-fee': () => page(completedDraftFee, 'work'),
  'visa-work-completed-returned-fee': () => page(completedReturnedFee, 'work'),
  'visa-popup-completed-send-fee': () => page(completedDraftFee, 'work', { preview: { popup: { kind: 'fee', entryId: 'f1000000-0000-4000-8000-000000000041' } } }),

  /* Passport task */
  'visa-passport-work': () => page(passportWs, 'work'),
  'visa-passport-details': () => page(passportWs, 'details'),
  'visa-popup-passport-handover': () => page(passportWs, 'work', { preview: { popup: { kind: 'handover', id: id(passportWs, 1) } } }),

  /* Branch Manager (read-only) */
  'visa-manager-work': () => page(managerWs(mixed), 'work', {}, managerViewer),
  'visa-manager-details': () => page(managerWs(docsStage), 'details', {}, managerViewer),
  'visa-manager-not-taken': () => page(managerWs({ ...notTaken, canClaim: false }), 'details', {}, managerViewer),

  /* Deal page */
  'visa-deal-card': () =>
    shell(
      salesViewer,
      '/app/deals',
      <div className="flex flex-col gap-5">
        <PageHeader eyebrow="Deal · SYN-JOD-701" title="Synthetic family trip to France" />
        <DealVisaCard summary={DEAL_SUMMARY} dealId={DEAL} actions={{ ackNotice: act(A.vsAck) }} />
      </div>,
    ),
  'visa-deal-card-other-sales': () =>
    shell(
      salesViewer,
      '/app/deals',
      <div className="flex flex-col gap-5">
        <PageHeader eyebrow="Deal · SYN-JOD-701" title="Synthetic family trip to France" />
        <DealVisaCard summary={{ ...DEAL_SUMMARY, notices: [] }} dealId={DEAL} />
      </div>,
    ),
  'visa-deal-card-manager': () =>
    shell(
      managerViewer,
      '/app/deals',
      <div className="flex flex-col gap-5">
        <PageHeader eyebrow="Deal · SYN-JOD-701" title="Synthetic family trip to France" />
        <DealVisaCard summary={DEAL_SUMMARY} dealId={DEAL} actions={{ ackNotice: act(A.vsAck) }} canOpenTasks />
      </div>,
    ),
  'visa-deal-services-sales': () => dealServices(salesViewer, false),
  'visa-deal-services-manager': () => dealServices(managerViewer, true),
  'visa-deal-card-unavailable': () =>
    shell(
      salesViewer,
      '/app/deals',
      <div className="flex flex-col gap-5">
        <PageHeader eyebrow="Deal · SYN-JOD-701" title="Synthetic family trip to France" />
        <DealVisaUnavailable />
      </div>,
    ),
  'visa-deal-history': () =>
    shell(
      salesViewer,
      '/app/deals',
      <div className="flex flex-col gap-5">
        <PageHeader eyebrow="Deal · SYN-JOD-701" title="Synthetic family trip to France" />
        <DealHistoryTab
          history={{
            state: 'ok',
            events: [
              { kind: 'visa_event', id: 'v-3', at: '2026-11-07T09:00:00Z', visaKind: 'rejected', taskId: 'a1000000-0000-4000-8000-000000000001', title: 'France · Tourism', travellerName: NAMES[2]!, byName: 'Synthetic Visa Jodhpur', byYou: false, note: 'Synthetic reason: the bank statement was older than six months.', clubSize: null },
              { kind: 'visa_event', id: 'v-2', at: '2026-11-07T08:00:00Z', visaKind: 'approved', taskId: 'a1000000-0000-4000-8000-000000000001', title: 'France · Tourism', travellerName: NAMES[0]!, byName: 'Synthetic Visa Jodhpur', byYou: false, note: null, clubSize: null },
              { kind: 'visa_event', id: 'v-1', at: '2026-11-04T07:00:00Z', visaKind: 'applied', taskId: 'a1000000-0000-4000-8000-000000000001', title: 'France · Tourism', travellerName: null, byName: 'Synthetic Visa Jodhpur', byYou: false, note: null, clubSize: 3 },
              { kind: 'booking_version', id: 'bv-2', at: '2026-11-02T09:00:00Z', versionNo: 2, statusText: 'Accepted', changeClass: null },
            ],
          }}
        />
      </div>,
    ),
  'visa-deal-history-unavailable': () =>
    shell(
      salesViewer,
      '/app/deals',
      <div className="flex flex-col gap-5">
        <PageHeader eyebrow="Deal · SYN-JOD-701" title="Synthetic family trip to France" />
        <DealHistoryTab history={{ state: 'ok', events: [{ kind: 'booking_version', id: 'bv-2', at: '2026-11-02T09:00:00Z', versionNo: 2, statusText: 'Accepted', changeClass: null }], visaUnavailable: true }} />
      </div>,
    ),

  /* Home */
  'visa-home-desk': () =>
    shell(
      visaViewer,
      '/app',
      <HomeView
        displayName="Synthetic Visa Jodhpur"
        counts={{ visible: 4, owned: 0, assigned: 3 }}
        roles={{ ...NO_HOME_ROLES, visa: true }}
        myWork={{ waitingForMe: 2, visaTasksWaiting: 2 } as never}
        visa={{ visaApplicantsWaitingResult: 3, visaApplicantsWaitingResultTaskId: 'a1000000-0000-4000-8000-000000000001', visaHandoverPending: 1, visaHandoverPendingTaskId: 'a1000000-0000-4000-8000-000000000001', visaFeesReturned: 1, visaFeesReturnedTaskId: 'a1000000-0000-4000-8000-000000000001', visaFeesWithoutReceipt: 1, visaFeesWithoutReceiptTaskId: null, visaTravellerChanged: 0, visaTravellerChangedTaskId: null, salesVisaResultsToSee: null, salesVisaResultsDealId: null }}
      />,
    ),
  'visa-home-sales': () =>
    shell(
      salesViewer,
      '/app',
      <HomeView
        displayName="Synthetic Sales Jodhpur"
        counts={{ visible: 12, owned: 9, assigned: 0 }}
        roles={{ ...NO_HOME_ROLES, bookings: true }}
        myWork={{ waitingForMe: 0, draftsToContinue: 0, returnedToMe: 0, missingDetails: 0, intakeNeeded: 0 } as never}
        visa={{ visaApplicantsWaitingResult: null, visaHandoverPending: null, visaFeesReturned: null, visaFeesWithoutReceipt: null, visaTravellerChanged: null, salesVisaResultsToSee: 2, salesVisaResultsDealId: DEAL, visaApplicantsWaitingResultTaskId: null, visaHandoverPendingTaskId: null, visaFeesReturnedTaskId: null, visaFeesWithoutReceiptTaskId: null, visaTravellerChangedTaskId: null }}
      />,
    ),

  /* Book now visa drawer: the services step; open "Visa" there (synthetic Book now data). */
  'visa-book-now-drawer': () => renderBookformState('bookform-v2--stay'),
};

/*
 * Older visa state names (B1.1, Batch 4) now render the Visa build screens:
 * the retired desk (applicant cards, "checked" documents, manual cost card)
 * is no longer shown anywhere in the gallery.
 */
const LEGACY_ALIASES: Record<string, string> = {
  'b11-visa-queue': 'visa-queue',
  'b11-visa-queue-empty': 'visa-queue-empty',
  'b11-visa-queue-not-launched': 'visa-queue-off',
  'b11-visa-queue-loading': 'visa-queue-loading',
  'b11-visa-task-new': 'visa-task-not-taken',
  'b11-visa-task-claim-conflict': 'visa-task-claim-conflict',
  'b11-visa-task-docs-pending': 'visa-work',
  'b11-visa-task-submit-refused': 'visa-popup-apply-refused',
  'b11-visa-task-submitted': 'visa-work-applied',
  'b11-visa-task-outcome-refused': 'visa-popup-approve-refused',
  'b11-visa-task-issued': 'visa-work-handover-pending',
  'b11-visa-task-refused': 'visa-work-rejected',
  'b11-visa-task-returned': 'visa-work-completed',
  'b11-visa-task-passport': 'visa-passport-work',
  'b11-visa-task-fee-expense': 'visa-work-fee-returned',
  'b11-visa-task-manager': 'visa-manager-work',
  'b11-visa-task-not-visible': 'visa-task-not-found',
  'b4-visa-queue': 'visa-queue',
  'b4-visa-queue-all': 'visa-queue-all',
  'b4-visa-queue-off': 'visa-queue-off',
  'b4-visa-queue-unknown': 'visa-queue-unknown',
  'b4-visa-task-details': 'visa-task-details',
  'b4-visa-task-work': 'visa-work',
  'b4-visa-task-files': 'visa-task-files',
  'b4-visa-task-history': 'visa-task-history',
  'b4-visa-task-not-taken': 'visa-task-not-taken',
};
for (const [from, to] of Object.entries(LEGACY_ALIASES)) states[from] = states[to]!;

export const VISA_PREVIEW_STATES = Object.keys(states).filter((s) => !(s in LEGACY_ALIASES));

export function renderVisaState(state: string): ReactNode | null {
  return states[state]?.() ?? null;
}
