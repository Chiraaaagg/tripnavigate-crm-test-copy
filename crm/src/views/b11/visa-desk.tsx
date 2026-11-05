'use client';

import { CheckCheck, FileCheck2, Stamp } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { HandForm } from '@/components/hand-form';
import { StatusBadge, type StatusTone } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Timeline, type TimelineItem } from '@/components/ui/timeline';
import {
  DEPARTMENT_EVIDENCE_KIND_LABEL,
  PASSPORT_APPLICATION_TYPE_LABEL,
  VISA_APPLICATION_STATE_LABEL,
  VISA_DOCUMENT_STATUS_LABEL,
  VISA_DOCUMENT_STATUSES,
  VISA_FEE_PAID_BY_LABEL,
  VISA_TEXT,
  maskPassportNumber,
  type DepartmentEvidenceView,
  type PassportServiceFacts,
  type VisaApplicantView,
  type VisaApplicationState,
  type VisaDocumentStatus,
  type VisaQueueView,
  type VisaServiceFacts,
  type VisaTaskSummary,
  type VisaTaskView,
} from '@/modules/fulfilment/contracts';
import { tabHref, type DepartmentTaskTabsVM, type TaskHistoryVM } from '@/modules/settings/contracts';
import { filterQueue, isNotTaken, parseQueueShow, type QueueShow } from '../department/queue-show';
import { QueueEmpty, QueueShowTabs, TaskBackLink, TaskFilesPanel, TaskHistoryPanel, TaskNextLine, TaskStatusBadge, TaskTabsNav, takenByText, taskNextText, type TaskFilesVM } from '../department/task-frame';
import { dateText } from './book-fields';
import { SelectField, TextField, problemFor } from './controls';
import { DepartmentCostCard, DepartmentUploadForm, type CostActions } from './department-cost';
import { newRequestId, PendingButton, refusedFields, ResultBox, useB11Action, type UiResult } from './form-kit';
import type { B11Action } from './shapes';

/*
 * Visa & Passport desk (B1.1c, DEC-28): queue and task. The desk takes a task,
 * checks each applicant's documents, records the submission (reference,
 * appointment), the authority's outcome with its document, and the return of
 * the documents. A fee receipt or reference never proves the outcome.
 * Applicant documents are private to the desk and the branch Manager.
 */

/** An applicant whose application row exists (the task was taken). */
type TakenApplicant = VisaApplicantView & { applicationId: string; state: VisaApplicationState; rowVersion: number };

function isTaken(a: VisaApplicantView): a is TakenApplicant {
  return a.applicationId !== null && a.state !== null && a.rowVersion !== null;
}

const STATE_TONE: Record<VisaApplicationState, StatusTone> = {
  docs_pending: 'warning',
  submitted: 'info',
  decision_pending: 'info',
  issued: 'success',
  refused: 'danger',
  withdrawn: 'neutral',
};

export function VisaStatePill({ state }: { state: VisaApplicationState }) {
  return (
    <StatusBadge tone={STATE_TONE[state]} wrap>
      <span className="sr-only">Application: </span>
      {VISA_APPLICATION_STATE_LABEL[state]}
    </StatusBadge>
  );
}

function factsLine(t: Pick<VisaTaskSummary, 'serviceType' | 'facts'>): string {
  if (t.serviceType === 'visa') {
    const f = t.facts as VisaServiceFacts;
    return [f.country, f.purpose, `travel ${dateText(f.travelDate)}`, f.applyBy ? `apply by ${dateText(f.applyBy)}` : null].filter(Boolean).join(' · ');
  }
  const f = t.facts as PassportServiceFacts;
  return [PASSPORT_APPLICATION_TYPE_LABEL[f.applicationType] ?? f.applicationType, f.officeCity, f.neededBy ? `needed by ${dateText(f.neededBy)}` : null].filter(Boolean).join(' · ');
}

export function VisaQueuePage({ queue, show }: { queue: VisaQueueView; /** Batch 4: `?show=` (parseQueueShow, the desk always takes tasks). */ show?: QueueShow }) {
  const current = show ?? parseQueueShow(undefined, true);
  const all = queue.tasks;
  const tasks = filterQueue(all, current);
  const counts = { not_taken: all.filter(isNotTaken).length, mine: all.filter((t) => t.assignedToYou).length, all: all.length };
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader eyebrow="Visa and passport desk" title="Visa and passport tasks" description="Visa and passport tasks from submitted bookings." />
      {queue.launch === 'off' ? (
        <Notice tone="warning" className="mb-4" title="Not started yet">
          <p>{VISA_TEXT.notLaunched}</p>
          {queue.waitingCount !== null ? <p>{queue.waitingCount} sold {queue.waitingCount === 1 ? 'service is' : 'services are'} waiting.</p> : null}
        </Notice>
      ) : queue.launch === 'unknown' ? (
        // Unknown is never shown as "Not started yet" (DA-255: Unknown is not Off).
        <Notice tone="warning" className="mb-4" title="Desk state could not be read">
          <p>{VISA_TEXT.launchUnknown}</p>
        </Notice>
      ) : null}
      <QueueShowTabs basePath="/app/visa" show={current} canTakeTasks counts={counts} label="Visa and passport task filters" />
      <Card>
        <section aria-labelledby="visa-queue-heading">
          <CardHeader>
            <CardTitle id="visa-queue-heading">Tasks</CardTitle>
            <span className="text-sm text-quiet">
              {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
            </span>
          </CardHeader>
          {tasks.length === 0 ? (
            <div role="status">
              {queue.launch === 'off' && all.length === 0 ? (
                <EmptyState icon={Stamp} title="No tasks yet" description="Tasks appear once the desk is started." />
              ) : (
                <QueueEmpty icon={Stamp} anyTasks={all.length > 0} show={current} serviceWords="a visa or passport service" />
              )}
            </div>
          ) : (
            <ol className="m-0 flex list-none flex-col divide-y divide-line p-0" aria-label="Visa and passport tasks">
              {tasks.map((t) => (
                <li key={t.taskId} className="m-0 flex flex-col gap-1.5 px-4.5 py-3.5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="m-0 font-semibold text-ink">
                      <Link href={`/app/visa/${t.taskId}`} className={cn('rounded-chip text-brand-strong underline underline-offset-4 hover:text-brand-deep', focusRing)}>
                        {t.serviceType === 'visa' ? 'Visa' : 'Passport'} · {t.itemTitle}
                      </Link>
                    </p>
                    <p className="m-0 text-sm text-copy">{factsLine(t)}</p>
                    <p className="m-0 text-sm text-quiet">
                      {t.dealReference} · {t.branchName}
                      {t.applicantCount !== null && t.applicantCount !== undefined ? ` · ${t.applicantCount} ${t.applicantCount === 1 ? 'applicant' : 'applicants'}` : ''} · Taken by: {takenByText(t)}
                    </p>
                  </div>
                  <TaskStatusBadge department="visa" status={t.status} wrap />
                </li>
              ))}
            </ol>
          )}
        </section>
      </Card>
    </div>
  );
}

export interface VisaActions {
  claim: B11Action;
  setDocument: B11Action;
  recordSubmission: B11Action;
  decisionPending: B11Action;
  recordOutcome: B11Action;
  withdraw: B11Action;
  documentsReturned: B11Action;
  customerInformed: B11Action;
  upload: B11Action;
  cost: CostActions;
}

export interface VisaPreview {
  claimState?: UiResult | null;
  submitState?: UiResult | null;
  outcomeState?: UiResult | null;
}

export function VisaTaskPage({
  task,
  actions,
  idProofs,
  preview = {},
  tabs,
  files,
  history,
}: {
  task: VisaTaskView;
  actions: VisaActions;
  /** Details tab: B1.2 "Traveller ID proofs" card (server-rendered by the route). */
  idProofs?: ReactNode;
  preview?: VisaPreview;
  /** Batch 4 tabs. Omitted = the one long page of before. */
  tabs?: DepartmentTaskTabsVM;
  /** Files tab content. This is a client component: pass it only when Files is the open tab. */
  files?: TaskFilesVM;
  /** History tab content. Pass it only when History is the open tab. */
  history?: TaskHistoryVM | null;
}) {
  const [claimState, claim] = useB11Action(actions.claim, { initialState: preview.claimState });
  const [claimRequest] = useState(() => newRequestId());
  const basePath = `/app/visa/${task.taskId}`;
  const current = tabs?.current ?? 'details';
  const workLink =
    tabs && tabs.tabs.includes('work') && current !== 'work' && task.canWork ? (
      <Link href={tabHref(basePath, 'work', 'details')} className={buttonVariants({ variant: 'primary', size: 'lg' })}>
        Continue the applications
      </Link>
    ) : null;
  const details = (
    <div className="flex flex-col gap-5">
      <Card>
        <section aria-labelledby="visa-details-heading">
          <CardHeader>
            <CardTitle id="visa-details-heading">Service</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-3">
            <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 max-sm:grid-cols-1">
              <dt className="text-sm font-semibold text-quiet">Service</dt>
              <dd className="m-0">{factsLine(task)}</dd>
              {task.serviceType === 'visa' ? (
                <>
                  <dt className="text-sm font-semibold text-quiet">Government fee paid by</dt>
                  <dd className="m-0">{VISA_FEE_PAID_BY_LABEL[(task.facts as VisaServiceFacts).feePaidBy] ?? (task.facts as VisaServiceFacts).feePaidBy}</dd>
                </>
              ) : null}
              <dt className="text-sm font-semibold text-quiet">From</dt>
              <dd className="m-0">
                Accepted version {task.versionNo} · {dateText(task.confirmedAt)}
              </dd>
              <dt className="text-sm font-semibold text-quiet">Applicants</dt>
              <dd className="m-0">{task.applicantCount ?? task.applicants.length}</dd>
            </dl>
            <Notice tone="restricted">{VISA_TEXT.privateDocuments}</Notice>
          </CardBody>
        </section>
      </Card>
      {idProofs ? <div>{idProofs}</div> : null}
    </div>
  );
  const work = (
    <div className="flex flex-col gap-5">
      {task.applicants.length === 0 ? (
        <Notice tone="info">Applicants appear when the task is taken.</Notice>
      ) : (
        task.applicants.map((a) =>
          isTaken(a) ? <ApplicantCard key={a.applicationId} task={task} applicant={a} actions={actions} preview={preview} /> : <NotTakenApplicant key={`seq-${a.travellerSeq}`} applicant={a} />,
        )
      )}
      <DepartmentCostCard taskId={task.taskId} department="visa" costs={task.costs} evidence={task.evidence} canRecord={task.canWork} readOnlyReason={null} actions={task.canWork ? actions.cost : undefined} />
      {task.canWork ? (
        <Card>
          <section aria-labelledby={`fee-${task.taskId}-heading`}>
            <CardHeader>
              <CardTitle id={`fee-${task.taskId}-heading`}>Fee receipt</CardTitle>
            </CardHeader>
            <CardBody>
              <DepartmentUploadForm taskId={task.taskId} kinds={[{ value: 'fee_receipt', label: DEPARTMENT_EVIDENCE_KIND_LABEL.fee_receipt }]} action={actions.upload} label="Upload the fee receipt" />
              <p className="m-0 mt-2.5 text-sm text-quiet">{VISA_TEXT.outcomeNeedsDocument}</p>
            </CardBody>
          </section>
        </Card>
      ) : null}
    </div>
  );
  return (
    <div className="font-sans text-base text-copy">
      <TaskBackLink href="/app/visa">Back to Visa and passport tasks</TaskBackLink>
      <PageHeader
        eyebrow={`${task.serviceType === 'visa' ? 'Visa' : 'Passport'} task · ${task.dealReference}`}
        title={<span className="block wrap-anywhere">{task.itemTitle}</span>}
        status={
          <>
            <TaskStatusBadge department="visa" status={task.status} wrap />
            <span className="text-copy">Taken by: {takenByText(task)}</span>
          </>
        }
        actions={
          task.canClaim && !task.assigneeName ? (
            <form action={claim} noValidate>
              <input type="hidden" name="taskId" value={task.taskId} />
              <input type="hidden" name="requestId" value={claimRequest} />
              <PendingButton pendingLabel="Taking…" variant="primary">
                Take this task
              </PendingButton>
            </form>
          ) : (workLink ?? undefined)
        }
        className="mb-3"
      />
      <ResultBox result={claimState} successText="The task is yours. Nothing has been filed yet." className="mb-4" />
      <TaskNextLine text={taskNextText({ department: 'visa', status: task.status, assignedToYou: task.assignedToYou, assigneeName: task.assigneeName, canClaim: task.canClaim })} />
      {tabs ? <TaskTabsNav basePath={basePath} tabs={tabs} /> : null}
      {!tabs ? (
        <div className="flex flex-col gap-5">
          {details}
          {work}
        </div>
      ) : current === 'work' ? (
        work
      ) : current === 'files' ? (
        <TaskFilesPanel files={files ?? {}} />
      ) : current === 'history' && history ? (
        <TaskHistoryPanel history={history} />
      ) : (
        details
      )}
    </div>
  );
}

function NotTakenApplicant({ applicant: a }: { applicant: VisaApplicantView }) {
  return (
    <Card>
      <section aria-labelledby={`app-seq-${a.travellerSeq}-heading`}>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id={`app-seq-${a.travellerSeq}-heading`}>{a.fullName}</CardTitle>
            <CardDescription>
              Applicant {a.travellerSeq}
              {a.type ? ` · ${a.type}` : ''}
              {a.ageYears !== null ? `, ${a.ageYears}` : ''}
            </CardDescription>
          </div>
          <StatusBadge tone="neutral" wrap>
            <span className="sr-only">Application: </span>Not taken yet
          </StatusBadge>
        </CardHeader>
        <CardBody>
          <p className="m-0 text-copy">The application, its documents and its steps appear once someone at the desk takes this task.</p>
        </CardBody>
      </section>
    </Card>
  );
}

function applicantTimeline(a: TakenApplicant): TimelineItem[] {
  const order: VisaApplicationState[] = ['docs_pending', 'submitted', 'decision_pending'];
  const reached = (s: VisaApplicationState) => order.indexOf(a.state) > order.indexOf(s) || ['issued', 'refused', 'withdrawn'].includes(a.state);
  const outcomeTitle = a.state === 'issued' ? 'Issued' : a.state === 'refused' ? 'Refused' : a.state === 'withdrawn' ? 'Withdrawn' : 'Authority’s decision';
  const final = ['issued', 'refused', 'withdrawn'].includes(a.state);
  return [
    { id: 'docs', title: 'Documents checked', state: reached('docs_pending') ? 'done' : a.state === 'docs_pending' ? 'current' : 'upcoming' },
    { id: 'sub', title: 'Application submitted', meta: a.reference ? `Reference ${a.reference}${a.submittedAt ? ` · ${dateText(a.submittedAt)}` : ''}` : undefined, state: reached('submitted') ? 'done' : a.state === 'submitted' ? 'current' : 'upcoming' },
    { id: 'dec', title: outcomeTitle, meta: a.outcomeAt ? dateText(a.outcomeAt) ?? undefined : undefined, state: final ? 'done' : a.state === 'decision_pending' ? 'current' : 'upcoming' },
    {
      id: 'ret',
      title: a.state === 'issued' ? 'Documents returned to the customer' : 'Customer informed',
      meta: a.documentsReturnedAt ? `${dateText(a.documentsReturnedAt)}${a.documentsReturnedByName ? ` · ${a.documentsReturnedByName}` : ''}` : a.customerInformedAt ? dateText(a.customerInformedAt) ?? undefined : undefined,
      state: a.closed ? 'done' : final ? 'current' : 'upcoming',
    },
  ];
}

function ApplicantCard({ task, applicant: a, actions, preview }: { task: VisaTaskView; applicant: TakenApplicant; actions: VisaActions; preview: VisaPreview }) {
  const work = task.canWork && !a.closed;
  const checked = a.documents.filter((d) => d.status === 'checked').length;
  const evidence = task.evidence.filter((e) => e.applicationId === a.applicationId);
  return (
    <Card>
      <section aria-labelledby={`app-${a.applicationId}-heading`}>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id={`app-${a.applicationId}-heading`}>{a.fullName}</CardTitle>
            <CardDescription>
              Applicant {a.travellerSeq}
              {a.type ? ` · ${a.type}` : ''}
              {a.ageYears !== null ? `, ${a.ageYears}` : ''}
              {a.identity ? ` · born ${dateText(a.identity.dateOfBirth) ?? 'not given'} · ${a.identity.nationality ?? 'nationality not given'} · passport ${a.identity.passportNumber ?? 'not given'}` : ''}
            </CardDescription>
          </div>
          <VisaStatePill state={a.state} />
        </CardHeader>
        <CardBody className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="flex min-w-0 flex-col gap-5">
            <section aria-labelledby={`app-${a.applicationId}-docs`} className="flex flex-col gap-2">
              <h3 id={`app-${a.applicationId}-docs`} className="m-0 text-base font-semibold text-ink">
                Documents <span className="font-normal text-quiet">({checked} of {a.documents.length} checked)</span>
              </h3>
              {a.documents.length === 0 ? (
                <p className="m-0 text-quiet">No document list yet.</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {a.documents.map((d) => (
                    <li key={d.code} className="m-0">
                      <DocumentRow taskId={task.taskId} applicant={a} code={d.code} label={d.label} status={d.status} editable={work && a.state === 'docs_pending'} action={actions.setDocument} />
                    </li>
                  ))}
                </ul>
              )}
              {work ? (
                <details className="rounded-control border border-line bg-canvas">
                  <summary className={cn('flex min-h-11 cursor-pointer items-center px-3 font-medium text-brand-strong', focusRing)}>Upload a document for {a.fullName}</summary>
                  <div className="border-t border-line bg-card px-3 py-3">
                    <DepartmentUploadForm
                      taskId={task.taskId}
                      applicationId={a.applicationId}
                      kinds={[
                        { value: 'applicant_document', label: DEPARTMENT_EVIDENCE_KIND_LABEL.applicant_document },
                        { value: 'authority_outcome', label: DEPARTMENT_EVIDENCE_KIND_LABEL.authority_outcome },
                      ]}
                      action={actions.upload}
                      label={`Upload a document for ${a.fullName}`}
                    />
                  </div>
                </details>
              ) : null}
              <EvidenceList items={evidence} />
            </section>
            {work ? <ApplicantSteps task={task} applicant={a} evidence={evidence} actions={actions} preview={preview} /> : null}
            {a.closed ? (
              <Notice tone="success" icon={CheckCheck}>
                This applicant is closed.
              </Notice>
            ) : null}
          </div>
          <Timeline label={`Progress for ${a.fullName}`} items={applicantTimeline(a)} showState />
        </CardBody>
      </section>
    </Card>
  );
}

function EvidenceList({ items }: { items: DepartmentEvidenceView[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label="Stored files">
      {items.map((e) => (
        <li key={e.id} className="m-0 flex flex-wrap items-center gap-2 text-sm">
          <FileCheck2 aria-hidden="true" className="size-4 text-status-success" />
          <a href={`/app/department/evidence/${e.id}`} rel="noopener" className={cn('rounded-chip font-medium wrap-anywhere text-brand-strong underline underline-offset-4', focusRing)}>
            {e.fileName}
          </a>
          <span className="text-quiet">
            {DEPARTMENT_EVIDENCE_KIND_LABEL[e.kind]} · {e.sizeLabel}
          </span>
        </li>
      ))}
    </ul>
  );
}

function DocumentRow({ taskId, applicant, code, label, status, editable, action }: { taskId: string; applicant: TakenApplicant; code: string; label: string; status: VisaDocumentStatus; editable: boolean; action: B11Action }) {
  const [value, setValue] = useState<VisaDocumentStatus>(status);
  const [state, formAction] = useB11Action(action);
  const id = `doc-${applicant.applicationId}-${code}`;
  return (
    <HandForm action={formAction} noValidate className="flex flex-col gap-2 rounded-control border border-line px-3 py-2 sm:flex-row sm:items-end sm:justify-between">
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="applicationId" value={applicant.applicationId} />
      <input type="hidden" name="rowVersion" value={applicant.rowVersion} />
      <input type="hidden" name="documentCode" value={code} />
      <div className="min-w-0 flex-1">
        {editable ? (
          <SelectField id={id} name="documentStatus" label={label} value={value} onChange={(x) => setValue(x as VisaDocumentStatus)} options={VISA_DOCUMENT_STATUSES.map((s) => ({ value: s, label: VISA_DOCUMENT_STATUS_LABEL[s] }))} />
        ) : (
          <p className="m-0 flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-ink">{label}</span>
            <StatusBadge tone={status === 'checked' ? 'success' : status === 'received' ? 'info' : 'warning'}>{VISA_DOCUMENT_STATUS_LABEL[status]}</StatusBadge>
          </p>
        )}
        <ResultBox result={state && !state.ok ? state : null} />
      </div>
      {editable ? (
        <PendingButton pendingLabel="Saving…" disabled={value === status}>
          Save<span className="sr-only"> {label}</span>
        </PendingButton>
      ) : null}
    </HandForm>
  );
}

function ApplicantSteps({ task, applicant: a, evidence, actions, preview }: { task: VisaTaskView; applicant: TakenApplicant; evidence: DepartmentEvidenceView[]; actions: VisaActions; preview: VisaPreview }) {
  const allChecked = a.documents.length > 0 && a.documents.every((d) => d.status === 'checked');
  const outcomeDocs = evidence.filter((e) => e.kind === 'authority_outcome' && e.status === 'stored');
  return (
    <section aria-labelledby={`app-${a.applicationId}-steps`} className="flex flex-col gap-3">
      <h3 id={`app-${a.applicationId}-steps`} className="m-0 text-base font-semibold text-ink">
        Next for {a.fullName}
      </h3>
      {a.state === 'docs_pending' ? <SubmissionForm taskId={task.taskId} applicant={a} allChecked={allChecked} action={actions.recordSubmission} initialState={preview.submitState} /> : null}
      {a.state === 'submitted' ? <SimpleStateForm taskId={task.taskId} state="decision_pending" applicant={a} action={actions.decisionPending} label="Mark waiting for the decision" pending="Saving…" success="Marked as waiting for the authority’s decision." /> : null}
      {a.state === 'submitted' || a.state === 'decision_pending' ? <OutcomeForm taskId={task.taskId} applicant={a} outcomeDocs={outcomeDocs} action={actions.recordOutcome} initialState={preview.outcomeState} /> : null}
      {a.state === 'issued' && !a.documentsReturnedAt ? <SimpleStateForm taskId={task.taskId} state="documents_returned" applicant={a} action={actions.documentsReturned} label="Record documents returned to the customer" pending="Saving…" success="Documents recorded as returned." /> : null}
      {(a.state === 'refused' || a.state === 'withdrawn') && !a.customerInformedAt ? <SimpleStateForm taskId={task.taskId} state="customer_informed" applicant={a} action={actions.customerInformed} label="Record that the customer was informed" pending="Saving…" success="Recorded that the customer was informed." /> : null}
      {!['issued', 'refused', 'withdrawn'].includes(a.state) ? <SimpleStateForm taskId={task.taskId} state="withdrawn" applicant={a} action={actions.withdraw} label="Withdraw this application" pending="Withdrawing…" success="Application withdrawn." variant="ghost" /> : null}
      <p className="m-0 text-sm text-quiet">{task.serviceType === 'visa' ? VISA_TEXT.outcomeNeedsDocument : 'A passport counts as issued only with the passport office’s document.'}</p>
    </section>
  );
}

/** ISO instant → "YYYY-MM-DDTHH:MM" in India time, for a datetime-local input. */
function isoToIstLocal(iso: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t + 330 * 60_000).toISOString().slice(0, 16);
}

function SubmissionForm({ taskId, applicant: a, allChecked, action, initialState }: { taskId: string; applicant: TakenApplicant; allChecked: boolean; action: B11Action; initialState?: UiResult | null }) {
  const [v, setV] = useState({ reference: a.reference ?? '', appointmentAt: isoToIstLocal(a.appointmentAt), appointmentPlace: a.appointmentPlace ?? '' });
  const [state, formAction] = useB11Action(action, { initialState });
  const fields = refusedFields(state);
  const id = `sub-${a.applicationId}`;
  return (
    <form action={formAction} noValidate aria-label={`Record the submission for ${a.fullName}`} className="flex flex-col gap-3 rounded-control border border-line bg-canvas px-3.5 py-3">
      <ResultBox result={state} successText="Submission recorded. Nothing is issued until the authority decides." />
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="applicationId" value={a.applicationId} />
      <input type="hidden" name="rowVersion" value={a.rowVersion} />
      <input type="hidden" name="state" value="submitted" />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField id={`${id}-ref`} name="reference" label="Application or file reference" value={v.reference} onChange={(x) => setV({ ...v, reference: x })} maxLength={120} error={problemFor(fields, 'reference', 'Enter the reference the authority gave.')} />
        <TextField id={`${id}-at`} name="appointmentAt" label="Appointment (India time)" type="datetime-local" hint="If there is one." optional value={v.appointmentAt} onChange={(x) => setV({ ...v, appointmentAt: x })} />
        <TextField id={`${id}-place`} name="appointmentPlace" label="Appointment place" optional className="sm:col-span-2" value={v.appointmentPlace} onChange={(x) => setV({ ...v, appointmentPlace: x })} maxLength={200} />
      </div>
      {!allChecked ? <p id={`${id}-note`} className="m-0 text-sm text-copy">All documents must be checked before the application is marked submitted.</p> : null}
      <div>
        <PendingButton pendingLabel="Saving…" variant={allChecked ? 'primary' : 'secondary'} describedBy={!allChecked ? `${id}-note` : undefined}>
          Record submission
        </PendingButton>
      </div>
    </form>
  );
}

function OutcomeForm({ taskId, applicant: a, outcomeDocs, action, initialState }: { taskId: string; applicant: TakenApplicant; outcomeDocs: DepartmentEvidenceView[]; action: B11Action; initialState?: UiResult | null }) {
  const [outcome, setOutcome] = useState<'issued' | 'refused'>('issued');
  const [evidenceId, setEvidenceId] = useState(outcomeDocs[0]?.id ?? '');
  const [state, formAction] = useB11Action(action, { initialState });
  const id = `out-${a.applicationId}`;
  return (
    <HandForm action={formAction} noValidate aria-label={`Record the outcome for ${a.fullName}`} className="flex flex-col gap-3 rounded-control border border-line bg-canvas px-3.5 py-3">
      <ResultBox result={state} successText="Outcome recorded with the authority’s document." />
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="applicationId" value={a.applicationId} />
      <input type="hidden" name="rowVersion" value={a.rowVersion} />
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField id={`${id}-state`} name="state" label="Outcome" value={outcome} onChange={(x) => setOutcome(x as 'issued' | 'refused')} options={[{ value: 'issued', label: 'Issued' }, { value: 'refused', label: 'Refused' }]} />
        <SelectField
          id={`${id}-doc`}
          name="evidenceId"
          label="Authority’s document"
          value={evidenceId}
          onChange={setEvidenceId}
          options={outcomeDocs.length > 0 ? outcomeDocs.map((d) => ({ value: d.id, label: d.fileName })) : [{ value: '', label: 'None uploaded yet' }]}
          hint={outcomeDocs.length === 0 ? 'Upload the approval or refusal letter above first (kind: authority outcome document).' : undefined}
        />
      </div>
      <div>
        <PendingButton pendingLabel="Saving…" variant={outcome === 'refused' ? 'danger' : 'primary'}>
          {outcome === 'issued' ? 'Record issued' : 'Record refused'}
        </PendingButton>
      </div>
    </HandForm>
  );
}

function SimpleStateForm({ taskId, state: command, applicant: a, action, label, pending, success, variant = 'secondary' }: { taskId: string; state: string; applicant: TakenApplicant; action: B11Action; label: string; pending: string; success: string; variant?: 'secondary' | 'ghost' }) {
  const [state, formAction] = useB11Action(action);
  return (
    <form action={formAction} noValidate className="flex flex-col gap-2">
      <ResultBox result={state} successText={success} />
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="applicationId" value={a.applicationId} />
      <input type="hidden" name="rowVersion" value={a.rowVersion} />
      <input type="hidden" name="state" value={command} />
      <div>
        <PendingButton pendingLabel={pending} variant={variant}>
          {label}
        </PendingButton>
      </div>
    </form>
  );
}

/** Same answer for "does not exist" and "not yours", so IDs cannot be probed. */
export function VisaTaskNotAvailableView() {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader title="Task not available" />
      <Notice tone="locked" role="status">
        {VISA_TEXT.notVisible}
      </Notice>
      <p className="m-0 mt-4">
        <Link href="/app" className={buttonVariants({ variant: 'secondary' })}>
          Back to Home
        </Link>
      </p>
    </div>
  );
}

export function VisaQueueLoading() {
  return (
    <div className="flex flex-col gap-4 font-sans">
      <h1 className="sr-only">Visa &amp; Passport desk</h1>
      <p role="status" aria-live="polite" className="m-0 text-sm font-medium text-quiet">
        Loading the desk…
      </p>
      <div aria-busy="true" className="flex flex-col gap-3">
        <Skeleton className="h-7 w-72 max-w-full" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-16 w-full rounded-card" />
        ))}
      </div>
    </div>
  );
}

/** Masked passport for read views (the full value only in the editor's field and the assigned desk). */
export function maskedPassport(value: string | null | undefined): string {
  return maskPassportNumber(value) ?? 'not given';
}
