import { FileQuestion, FileText, FolderOpen } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { RecordHeader } from '@/components/ui/record-header';
import { Skeleton } from '@/components/ui/skeleton';
import type { DepartmentTaskTabsVM, TaskHistoryVM } from '@/modules/settings/contracts';
import { VISA_TEXT } from '@/modules/visa/contracts';
import { formatIst } from '../deal-labels';
import { defaultTaskTab } from '../department/task-default-tab';
import { InternalTaskLine, TaskHistoryPanel, TaskTabsNav } from '../department/task-frame';
import type { VisaWorkActions } from './actions';
import { VisaStatusBadge } from './bits';
import { ClaimTaskForm } from './claim';
import { dayText } from './format';
import type { VisaResult } from './kit';
import { feePaidByText, KIND_LABEL, nameOf, PASSPORT_APPLICATION_LABEL, plural, STEP_NEXT_TEXT } from './labels';
import type { VisaTaskFile, VisaWorkspace } from './types';
import { VisaWorkTab } from './work-tab';
import type { Popup, PopupSeed } from './work-model';

/*
 * Visa or passport task page (contract 11.1; HTML visaTask H:15282,
 * visaSummary H:14583, visaNext H:15055, bookingChanges H:14598): back link,
 * eyebrow "Visa task · BX-…", title, status words + "Taken by", ONE primary
 * action ("Take this task" for the desk on a task nobody holds, or "Continue
 * the applications" for the assignee when not on Work), the Next line, the
 * summary card, the booking-changes banner and the link tabs Details · Work ·
 * Files · History (?tab=, server allowlist). The branch Manager reads
 * everything with one banner and no controls. No customer name or contact
 * (VL26), no money beyond the visa costs.
 */

export function visaNextText(ws: VisaWorkspace): string {
  if (ws.status.code === 'completed') return 'Nothing waiting.';
  if (!ws.assignee.name && !ws.assignee.isYou) return ws.canClaim ? 'take this task' : 'the Visa and passport desk takes this task';
  if (!ws.assignee.isYou) return `${ws.assignee.name ?? 'Another staff member'} works on this task`;
  return ws.status.step ? STEP_NEXT_TEXT[ws.status.step] : 'finish the steps on the Work tab';
}

function titleOf(ws: VisaWorkspace): string {
  return ws.title || ('visa' in ws.facts ? [ws.facts.visa.country, ws.facts.visa.purpose].filter(Boolean).join(' · ') : 'Passport');
}

function SummaryCard({ ws }: { ws: VisaWorkspace }) {
  const v = 'visa' in ws.facts ? ws.facts.visa : null;
  const p = 'passport' in ws.facts ? ws.facts.passport : null;
  const passengers = ws.applicants.filter((a) => !a.removed).length;
  const rows: Array<[string, ReactNode]> = [
    ['Deal ID', ws.dealReference],
    [v ? 'Country / Visa category' : 'Passport application', v ? [v.country, v.purpose].filter(Boolean).join(' · ') || 'Not set' : `${PASSPORT_APPLICATION_LABEL[p?.applicationType ?? ''] ?? p?.applicationType ?? 'Passport'}${p?.officeCity ? ` · ${p.officeCity}` : ''}`],
    [v ? 'Travel date' : 'Needed by', dayText(v ? v.travelDate : (p?.neededBy ?? null))],
    ['Passengers', ws.status.code === 'not_taken' ? 'Shown when taken' : String(passengers)],
    ['Branch', ws.branchName || '—'],
    [
      'Assigned executive',
      <>
        {ws.assignee.isYou ? 'You' : (ws.assignee.name ?? 'Not taken yet')}
        {ws.assignee.takenAt ? <span className="block text-sm font-normal text-quiet">Taken {formatIst(ws.assignee.takenAt)}</span> : null}
      </>,
    ],
  ];
  return (
    <Card className="mb-4 px-4.5 py-3.5">
      <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-3 lg:grid-cols-4" aria-label="Task summary">
        {rows.map(([k, val]) => (
          <div key={k} className="min-w-0">
            <dt className="text-sm font-medium text-quiet">{k}</dt>
            <dd className="m-0 font-semibold wrap-anywhere text-ink">{val}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function BookingChanges({ ws }: { ws: VisaWorkspace }) {
  const c = ws.bookingChange;
  if (!c) return null;
  const who = (x: { seq: number; name: string | null }) => x.name ?? `Traveller ${x.seq}`;
  const lines: string[] = [];
  if (c.added.length) lines.push(`Added: ${c.added.map(who).join(', ')}. ${c.added.length === 1 ? 'They have' : 'They each have'} a new application.`);
  if (c.removed.length) lines.push(`Removed from the booking: ${c.removed.map(who).join(', ')}. Their records are kept here.`);
  if (c.back.length) lines.push(`Back on the booking: ${c.back.map(who).join(', ')}.`);
  for (const r of c.renamed) lines.push(`Renamed: ${r.oldName ?? 'no name'} → ${r.newName ?? 'no name'}. Check and press “OK, checked”.`);
  if (c.documentsAdded) lines.push(`${plural(c.documentsAdded, 'document')} added to passengers not applied yet.`);
  for (const f of c.fields) lines.push(`Changed: ${f}`);
  return (
    <Notice tone="info" title={VISA_TEXT.bookingChanged.replace('{n}', String(c.versionNo))} className="mb-4">
      {lines.length ? (
        <ul className="m-0 list-disc pl-5">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : (
        <p>Nothing on this task changed.</p>
      )}
      <p className="text-sm text-quiet">{formatIst(c.at)}</p>
    </Notice>
  );
}

function DetailsTab({ ws, idProofs }: { ws: VisaWorkspace; idProofs?: ReactNode }) {
  const v = 'visa' in ws.facts ? ws.facts.visa : null;
  const p = 'passport' in ws.facts ? ws.facts.passport : null;
  const sales = <span className="text-quiet"> · from Sales</span>;
  const facts: Array<[string, ReactNode]> = v
    ? [
        ['Service', [v.country, v.purpose, v.travelDate ? `travel ${dayText(v.travelDate)}` : null, v.applyBy ? `apply by ${dayText(v.applyBy)}` : null].filter(Boolean).join(' · ')],
        ['Government fee paid by', feePaidByText(v.feePaidBy)],
        ['E-visa or sticker visa', v.visaKind ? <>{KIND_LABEL[v.visaKind]}{sales}</> : 'Not decided yet'],
        ['Jurisdiction passport', v.jurisdiction ? <>{v.jurisdiction === 'yes' ? 'Yes' : 'No'}{sales}</> : 'Not decided yet'],
        ...(v.jurisdiction === 'yes' ? [['Jurisdiction place', <>{v.jurisdictionPlace ?? '—'}{sales}</>] as [string, ReactNode]] : []),
        ['Documents needed', v.documentsNeeded.length ? <>{v.documentsNeeded.join(', ')}{sales}</> : 'None listed by Sales'],
      ]
    : [['Service', [PASSPORT_APPLICATION_LABEL[p?.applicationType ?? ''] ?? p?.applicationType, p?.officeCity, p?.neededBy ? `needed by ${dayText(p.neededBy)}` : null].filter(Boolean).join(' · ')]];
  const notes = v?.notes ?? p?.notes;
  if (notes) facts.push(['Requirements from Sales', notes]);
  facts.push(['From', `Accepted version ${ws.versionNo}${ws.confirmedAt ? ` · ${formatIst(ws.confirmedAt)}` : ''}`]);
  facts.push(['Applicants', ws.status.code === 'not_taken' ? 'Shown when the task is taken' : ws.applicants.length ? ws.applicants.map(nameOf).join(', ') : 'None came with this task']);
  return (
    <div className="flex flex-col gap-5">
      <Card>
        <section aria-labelledby="visa-details-heading">
          <CardHeader>
            <CardTitle id="visa-details-heading">Service</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-3">
            <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 max-sm:grid-cols-1">
              {facts.map(([k, val]) => (
                <div key={k} className="contents">
                  <dt className="text-sm font-semibold text-quiet">{k}</dt>
                  <dd className="m-0 wrap-anywhere">{val}</dd>
                </div>
              ))}
            </dl>
            <Notice tone="restricted">Private applicant documents: Visa and passport desk and branch Manager only.</Notice>
          </CardBody>
        </section>
      </Card>
      {idProofs}
    </div>
  );
}

const FILE_KIND: Record<VisaTaskFile['kind'], string> = { applicant_document: 'Document', fee_receipt: 'Fee receipt', authority_outcome: 'Decision proof', other: 'Other file' };

function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Files tab: per passenger, the documents (with their label), fee receipts and decision proofs. Every open is recorded. */
function FilesTab({ ws }: { ws: VisaWorkspace }) {
  const stored = ws.files.filter((f) => f.status === 'stored');
  const docLabel = new Map(ws.applicants.flatMap((a) => a.documents.map((d) => [d.documentId, d.label] as const)));
  const groups = [
    ...ws.applicants.map((a) => ({ key: a.applicationId, title: nameOf(a), files: stored.filter((f) => f.applicationId === a.applicationId) })),
    { key: 'task', title: 'Whole task', files: stored.filter((f) => !f.applicationId || !ws.applicants.some((a) => a.applicationId === f.applicationId)) },
  ].filter((g) => g.files.length > 0);
  return (
    <Card>
      <section aria-labelledby="visa-files-heading">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id="visa-files-heading">Files</CardTitle>
            <CardDescription>Only files for this task. Private: every open is recorded.</CardDescription>
          </div>
          <FolderOpen aria-hidden="true" className="size-4 text-faint" />
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          {groups.length === 0 ? <p className="m-0 text-quiet">No files on this task yet.</p> : null}
          {groups.map((g) => (
            <section key={g.key} aria-labelledby={`files-${g.key}`} className="flex flex-col gap-2">
              <h3 id={`files-${g.key}`} className="m-0 text-base font-semibold text-ink">
                {g.title}
              </h3>
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {g.files.map((f) => (
                  <li key={f.evidenceId} className="m-0 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                    <FileText aria-hidden="true" className="size-4 shrink-0 text-faint" />
                    <a href={`/app/department/evidence/${f.evidenceId}`} rel="noopener" className={cn('rounded-chip font-medium wrap-anywhere text-brand-strong underline underline-offset-4 hover:text-brand-deep', focusRing)}>
                      {f.fileName}
                    </a>
                    <span className="text-quiet">
                      {FILE_KIND[f.kind]}
                      {f.visaDocumentId && docLabel.get(f.visaDocumentId) ? `: ${docLabel.get(f.visaDocumentId)}` : ''} · {sizeText(f.sizeBytes)} · {formatIst(f.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </CardBody>
      </section>
    </Card>
  );
}

export interface VisaTaskPageProps {
  ws: VisaWorkspace;
  tabs: DepartmentTaskTabsVM;
  actions: VisaWorkActions;
  /** History tab only. */
  history?: TaskHistoryVM | null;
  /** Details tab: ID proofs card (assignee only). */
  idProofs?: ReactNode;
  /** Preview gallery only. */
  preview?: { popup?: Popup | null; claimState?: VisaResult | null; editId?: string | null; selected?: string[]; seed?: PopupSeed };
}

export function VisaTaskPage({ ws, tabs, actions, history, idProofs, preview }: VisaTaskPageProps) {
  const base = `/app/visa/${ws.taskId}`;
  const current = tabs.current;
  const passport = ws.serviceType === 'passport';
  const taken = ws.assignee.isYou ? 'You' : (ws.assignee.name ?? 'Not taken yet');
  // UX redesign R3 (C4): "Take this task" stays the existing claim form (beside the title); "Continue the
  // applications" is the record header's one primary button, with the same label and address as before.
  const continueWork = ws.canWork && ws.status.code === 'in_progress' && current !== 'work';
  return (
    <div className="font-sans text-base text-copy">
      {/* UX redesign R3 (C4, owner Q6): the shared record header around the approved Work form. */}
      <RecordHeader
        back={{ href: '/app/visa', label: 'Back to Visa and passport tasks' }}
        recordId={`${passport ? 'Passport task' : 'Visa task'} · ${ws.dealReference}`}
        title={<span className="block wrap-anywhere">{titleOf(ws)}</span>}
        status={<VisaStatusBadge status={ws.status} />}
        owner={taken}
        ownerLabel="Taken by"
        actions={ws.canClaim ? <ClaimTaskForm taskId={ws.taskId} dealId={ws.dealId} action={actions.claim} initialState={preview?.claimState ?? null} /> : undefined}
        next={{ text: visaNextText(ws), button: continueWork ? { label: 'Continue the applications', href: `${base}?tab=work` } : undefined }}
        className="mb-4"
      />
      {ws.isManagerView ? (
        <Notice tone="locked" className="mb-4">
          {VISA_TEXT.managerBanner}
        </Notice>
      ) : null}
      <BookingChanges ws={ws} />
      {ws.status.code === 'completed' && ws.addedAfterCompletion > 0 ? (
        <Notice tone="warning" className="mb-4">
          {VISA_TEXT.addedAfterCompletion.replace('{n}', String(ws.addedAfterCompletion)).replace(/^1 travellers added after completion have/, '1 traveller added after completion has')}.
        </Notice>
      ) : null}
      <div className="mb-4">
        <InternalTaskLine>Internal task. The CRM does not send anything to the embassy or the customer; the desk records what it did.</InternalTaskLine>
      </div>
      <SummaryCard ws={ws} />
      {/* D6: the bare address opens Work for the holder, so Details gets "?tab=details". */}
      <TaskTabsNav basePath={base} tabs={tabs} defaultTab={defaultTaskTab(tabs.tabs, ws.assignee.isYou)} variant="pill" />
      {current === 'work' ? (
        <VisaWorkTab ws={ws} actions={actions} initialPopup={preview?.popup ?? null} initialEditId={preview?.editId ?? null} initialSelected={preview?.selected ?? []} initialSeed={preview?.seed} />
      ) : current === 'files' ? (
        <FilesTab ws={ws} />
      ) : current === 'history' ? (
        history ? <TaskHistoryPanel history={history} /> : <Notice tone="locked">History is not available to you on this task.</Notice>
      ) : (
        <DetailsTab ws={ws} idProofs={idProofs} />
      )}
    </div>
  );
}

/** Same answer for "does not exist" and "not allowed" (ids cannot be probed). */
export function VisaTaskNotAvailable() {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader title="Task not available" />
      <Card role="status">
        <div className="flex items-start gap-3 px-4.5 py-4">
          <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-control bg-brand-tint text-brand">
            <FileQuestion className="size-4.5" />
          </span>
          <p className="m-0 self-center text-copy">{VISA_TEXT.notAvailable}</p>
        </div>
      </Card>
      <p className="m-0 mt-4">
        <Link href="/app/visa" className={buttonVariants({ variant: 'secondary' })}>
          Back to Visa and passport tasks
        </Link>
      </p>
    </div>
  );
}

export function VisaTaskLoading() {
  return (
    <div className="flex flex-col gap-4 font-sans">
      <h1 className="sr-only">Visa and passport task</h1>
      <p role="status" aria-live="polite" className="m-0 text-sm font-medium text-quiet">
        Loading the task…
      </p>
      <div aria-busy="true" className="flex flex-col gap-4">
        <Skeleton className="h-7 w-56 max-w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}
