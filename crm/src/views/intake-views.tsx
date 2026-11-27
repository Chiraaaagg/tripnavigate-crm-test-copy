import {
  ChevronLeft,
  CircleCheck,
  CircleX,
  Clock,
  FileQuestion,
  FileText,
  Hourglass,
  Info,
  ListChecks,
  Lock,
  PlayCircle,
  TriangleAlert,
  UserRound,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { StatusBadge, type StatusTone } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import {
  BITRIX_SOURCE_BADGE_TEXT,
  CRM_SOURCE_BADGE_TEXT,
  DEAL_NOT_ACTIVE_NEXT_TEXT,
  ERROR_TEXT,
  EVIDENCE_KIND_LABEL,
  EVIDENCE_MAX_FILES,
  type EvidenceItemView,
  type EvidenceStatus,
  INTAKE_DISABLED_TEXT,
  type IntakeChecklistItem,
  type IntakeView,
  PROOF_HIDDEN_TEXT,
  SERVICE_DEPARTMENT_LABEL,
  type ServiceItemView,
  progressText,
} from '@/modules/fulfilment/contracts';
import { RemoveEvidenceForm, UploadEvidenceForm } from './booking-forms';
import { formatIst } from './deal-labels';
import {
  CHECKLIST_OWNER_LABEL,
  checklistItemText,
  confirmSuccessText,
  INTAKE_STAGE_LABEL,
  type IntakeStage,
  intakeStage,
  plannedTaskCount,
  splitChecklist,
  TRAVELLER_TYPE_LABEL,
  travellersNeeded,
} from './intake-fields';
import {
  type IntakeActions,
  type IntakePreview,
  IntakeConfirmForm,
  IntakeStatusAnnouncer,
  RemoveServiceForm,
  ServiceItemForm,
  StartIntakeDraftForm,
  TravellersForm,
} from './intake-forms';
import {
  FactsBlock,
  formatBudget,
  serviceNextHref,
  serviceNextLinkText,
  serviceNextStepText,
  serviceOwnerText,
  ServiceStatePill,
  ServiceTypePill,
} from './service-labels';
import { HiddenForRole } from './value-states';

/*
 * SCR-INTAKE (B1, Lagoon): "Confirm what was sold and fill the gaps". One
 * primary action (save the accepted version and create tasks); status, owner
 * and next step near the top; then what Bitrix sent, travellers, services,
 * the checklist and the acceptance proof. Adapted from the owner's prototype
 * (docs/implementation/frontend-first-plan-2026-10-10/prototype, intake view)
 * and these 21st.dev patterns (ideas only, nothing copied): a setup checklist
 * card with blocking and optional steps (ssychui 30552), repeating form rows
 * with add/remove (Reshaped Table 18314 idea of row composition), the
 * foundation's page header and cards. Record: ui-foundation-21st-log-2026-10-09.md.
 */

const STAGE_PILL: Record<IntakeStage, { tone: StatusTone; icon: typeof Clock }> = {
  not_started: { tone: 'neutral', icon: Clock },
  needs_details: { tone: 'warning', icon: TriangleAlert },
  ready: { tone: 'info', icon: PlayCircle },
  created: { tone: 'success', icon: CircleCheck },
};

const EVIDENCE_STATUS_TEXT: Record<EvidenceStatus, string> = {
  stored: 'Stored',
  pending_upload: 'Upload did not finish',
  failed: 'Upload failed',
  removed: 'Removed',
};

function SourceBadge({ source }: { source: IntakeView['prefillSource'] }) {
  return (
    <span className="inline-flex items-center rounded-chip border border-brand-line bg-brand-tint px-1.5 text-xs leading-5 font-semibold text-brand-strong">
      {source === 'bitrix' ? BITRIX_SOURCE_BADGE_TEXT : CRM_SOURCE_BADGE_TEXT}
    </span>
  );
}

function StagePill({ stage }: { stage: IntakeView['stage'] }) {
  if (!stage) {
    return (
      <StatusBadge tone="neutral" icon={Info} wrap>
        <span className="sr-only">Bitrix stage: </span>No Bitrix stage · CRM record
      </StatusBadge>
    );
  }
  if (stage.isTriggerStage) {
    return (
      <StatusBadge tone="success" icon={CircleCheck} wrap>
        <span className="sr-only">Bitrix stage: </span>
        {stage.label ?? stage.stageId} · tasks can start
      </StatusBadge>
    );
  }
  return (
    <StatusBadge tone="warning" icon={Hourglass} wrap>
      <span className="sr-only">Bitrix stage: </span>
      {stage.label ?? `Bitrix stage ${stage.stageId}`} · waiting for “Won - Payment Received”
    </StatusBadge>
  );
}

function BackToDeal({ dealId }: { dealId: string }) {
  return (
    <p className="m-0 mb-3">
      <Link
        href={`/app/deals/${dealId}`}
        className={cn('inline-flex items-center gap-1 rounded-chip text-sm font-medium text-brand-strong no-underline hover:text-brand-deep hover:underline', focusRing)}
      >
        <ChevronLeft aria-hidden="true" className="size-4" />
        Back to the deal
      </Link>
    </p>
  );
}

function NextStepFacts({ who, next }: { who: ReactNode; next: ReactNode }) {
  return (
    <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 max-sm:grid-cols-1 max-sm:gap-y-0.5">
      <dt className="text-sm font-semibold text-quiet">Who acts next</dt>
      <dd className="m-0 max-sm:mb-1.5">{who}</dd>
      <dt className="text-sm font-semibold text-quiet">Next step</dt>
      <dd className="m-0">{next}</dd>
    </dl>
  );
}

export interface IntakeScreenProps {
  view: IntakeView;
  /** Owner text from the deal record ("You", a name, or null while waiting). */
  ownerText?: string | null;
  actions: IntakeActions;
  preview?: IntakePreview;
}

/** The intake screen for a Deal the viewer may see. */
export function IntakeScreen({ view, ownerText = null, actions, preview }: IntakeScreenProps) {
  const { services } = view;
  const version = services.version;
  const items = services.items;
  const groups = splitChecklist(view.checklist);
  const stage = intakeStage({ version, itemCount: items.length, blockingCount: groups.blocking.length, canConfirm: view.canConfirm });
  const created = stage === 'created';
  const taskCount = plannedTaskCount(items);
  const editable = view.canEdit && version?.status === 'draft';
  const pill = STAGE_PILL[stage];
  const needed = travellersNeeded(items);

  let who: ReactNode;
  let next: ReactNode;
  if (created) {
    who = 'Purchase team and Flight team';
    next = `${progressText(services.progress)}. Each team takes its own task; nothing is booked until the supplier confirms.`;
  } else if (view.openBlockedReason) {
    who = 'No one';
    next = DEAL_NOT_ACTIVE_NEXT_TEXT;
  } else if (!view.canEdit) {
    who = 'The deal owner or a Sales Manager for this branch';
    next = 'They confirm the sold services and travellers, then save the accepted version.';
  } else if (!version) {
    who = 'You';
    next = 'Start the intake draft, then add the travellers and the sold services.';
  } else if (groups.blocking.length > 0) {
    who = 'You';
    next = 'Fix the blocking items in the checklist below, then save the accepted version.';
  } else if (!view.canConfirm) {
    who = view.confirmBlockedReason === ERROR_TEXT.not_authorized ? 'The deal owner or a Sales Manager for this branch' : 'An admin';
    next = view.confirmBlockedReason ?? 'Saving the accepted version is not possible right now.';
  } else {
    who = 'You';
    next = `Review the services and travellers, then save the accepted version. That creates ${taskCount} internal ${taskCount === 1 ? 'task' : 'tasks'}.`;
  }

  const confirmAvailable = editable && view.canConfirm && version && groups.blocking.length === 0;

  return (
    <div className="font-sans text-base text-copy">
      <BackToDeal dealId={view.dealId} />
      <PageHeader
        eyebrow={<span className="wrap-anywhere">Confirmed booking intake · {view.dealReference}</span>}
        title={
          <span id="intake-heading" tabIndex={-1} className="block wrap-anywhere outline-none">
            {view.dealTitle}
          </span>
        }
        status={
          <>
            <StatusBadge tone={pill.tone} icon={pill.icon} wrap>
              <span className="sr-only">Intake status: </span>
              {INTAKE_STAGE_LABEL[stage]}
              {version ? ` · version ${version.versionNo}` : ''}
            </StatusBadge>
            <StagePill stage={view.stage} />
            {ownerText !== undefined ? (
              ownerText === null ? (
                <StatusBadge tone="warning" icon={Hourglass}>
                  Waiting for owner
                </StatusBadge>
              ) : (
                <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 wrap-break-word text-copy">
                  <UserRound aria-hidden="true" className="size-4 shrink-0 text-faint" />
                  <span className="min-w-0">
                    Owner: <span className="font-semibold text-ink">{ownerText}</span>
                  </span>
                </span>
              )
            ) : null}
          </>
        }
        actions={
          confirmAvailable && version ? (
            <IntakeConfirmForm
              dealId={view.dealId}
              versionId={version.versionId}
              versionNo={version.versionNo}
              contentHash={version.contentHash}
              taskCount={taskCount}
              action={actions.confirmIntake}
              initialState={preview?.confirmState ?? null}
              defaultOpen={preview?.confirmOpen}
            />
          ) : created ? (
            <Link href={`/app/deals/${view.dealId}`} className={buttonVariants({ variant: 'secondary', size: 'lg' })}>
              Open the deal
            </Link>
          ) : undefined
        }
      />

      <Card className="mb-5">
        <CardBody className="flex flex-col gap-3">
          <NextStepFacts who={who} next={next} />
          <IntakeStatusAnnouncer dealId={view.dealId} created={created} text={confirmSuccessText(services.progress.total)} />
          {!version && view.canEdit && !view.openBlockedReason ? (
            <StartIntakeDraftForm dealId={view.dealId} action={actions.openDraft} initialState={preview?.openState ?? null} />
          ) : null}
          {created ? (
            <p className="m-0 flex gap-2 text-sm text-quiet">
              <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-faint" />
              <span>{ERROR_TEXT.already_confirmed}</span>
            </p>
          ) : null}
          {editable && !view.canConfirm && view.confirmBlockedReason ? (
            <p role="note" className="m-0 flex gap-2 rounded-control border border-status-info-line bg-status-info-tint px-3.5 py-3 text-copy">
              <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-info" />
              <span>{view.confirmBlockedReason}</span>
            </p>
          ) : null}
          {view.openBlockedReason ? (
            <p role="note" className="m-0 flex gap-2 rounded-control border border-status-info-line bg-status-info-tint px-3.5 py-3 text-copy">
              <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-info" />
              <span>{view.openBlockedReason}</span>
            </p>
          ) : null}
          {!view.canEdit && !created ? (
            <p className="m-0 flex gap-2 text-sm text-quiet">
              <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-faint" />
              <span>You can read this intake. The deal owner, assigned Sales or a Sales Manager for this branch can change it.</span>
            </p>
          ) : null}
        </CardBody>
      </Card>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-5">
          <TravellersCard view={view} editable={editable} needed={needed} actions={actions} preview={preview} />
          <ServicesCard view={view} editable={editable} actions={actions} preview={preview} />
          <ProofCard view={view} editable={editable} />
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <BitrixCard view={view} />
          <ChecklistCard blocking={groups.blocking} warnings={groups.warnings} created={created} />
        </div>
      </div>
    </div>
  );
}

function BitrixCard({ view }: { view: IntakeView }) {
  return (
    <Card>
      <section aria-labelledby="intake-bitrix-heading">
        <CardHeader>
          <CardTitle id="intake-bitrix-heading">What Bitrix sent</CardTitle>
          <FileText aria-hidden="true" className="size-4 text-faint" />
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <dl className="m-0 flex flex-col divide-y divide-line">
            <div className="grid grid-cols-1 gap-0.5 py-2 first:pt-0">
              <dt className="text-sm font-medium text-quiet">Deal title</dt>
              <dd className="m-0 wrap-break-word text-ink">{view.dealTitle}</dd>
            </div>
            <div className="grid grid-cols-1 gap-0.5 py-2">
              <dt className="text-sm font-medium text-quiet">Stage</dt>
              <dd className="m-0 wrap-anywhere text-ink">
                {view.stage ? (view.stage.label ?? view.stage.stageId) : 'No Bitrix stage (this deal was not imported from Bitrix)'}
              </dd>
            </div>
            <div className="grid grid-cols-1 gap-0.5 py-2 last:pb-0">
              <dt className="text-sm font-medium text-quiet">Travellers and services below</dt>
              <dd className="m-0 text-ink">
                <SourceBadge source={view.prefillSource} />
              </dd>
            </div>
          </dl>
          <p className="m-0 flex gap-2 text-sm text-quiet">
            <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-faint" />
            <span>
              Bitrix owns the title, stage and salesperson. A stage is not proof of payment: Accounts still verifies receipts.
              {view.prefillSource === 'crm' ? ' Bitrix sends no traveller or service facts yet; Sales types them here.' : ''}
            </span>
          </p>
        </CardBody>
      </section>
    </Card>
  );
}

function TravellersCard({
  view,
  editable,
  needed,
  actions,
  preview,
}: {
  view: IntakeView;
  editable: boolean;
  needed: number;
  actions: IntakeActions;
  preview?: IntakePreview;
}) {
  const version = view.services.version;
  const travellers = [...view.travellers].sort((a, b) => a.seq - b.seq);
  return (
    <Card>
      <section aria-labelledby="intake-travellers-heading">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id="intake-travellers-heading">Travellers</CardTitle>
            <CardDescription>
              Names as they must appear on tickets and vouchers.{' '}
              {needed > 0 ? `The services need ${needed} ${needed === 1 ? 'traveller' : 'travellers'}.` : ''}
            </CardDescription>
          </div>
          <Users aria-hidden="true" className="size-4 shrink-0 text-faint" />
        </CardHeader>
        <CardBody>
          {editable && version ? (
            <TravellersForm
              dealId={view.dealId}
              rowVersion={version.rowVersion}
              travellers={travellers}
              needed={needed}
              action={actions.saveTravellers}
              initialState={preview?.travellersState ?? null}
            />
          ) : travellers.length === 0 ? (
            <p className="m-0 text-quiet">No travellers listed yet.</p>
          ) : (
            <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
              {travellers.map((t) => (
                <li key={t.seq} className="m-0 flex flex-wrap items-baseline gap-x-2">
                  <span className="font-semibold text-ink">{t.fullName}</span>
                  <span className="text-sm text-quiet">{TRAVELLER_TYPE_LABEL[t.type]}</span>
                </li>
              ))}
            </ol>
          )}
        </CardBody>
      </section>
    </Card>
  );
}

function ServicesCard({ view, editable, actions, preview }: { view: IntakeView; editable: boolean; actions: IntakeActions; preview?: IntakePreview }) {
  const version = view.services.version;
  const items = view.services.items;
  return (
    <Card>
      <section aria-labelledby="intake-services-heading">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id="intake-services-heading">Services sold</CardTitle>
            <CardDescription>One row per sold service. Each becomes one internal task when the accepted version is saved.</CardDescription>
          </div>
          <ListChecks aria-hidden="true" className="size-4 shrink-0 text-faint" />
        </CardHeader>
        {items.length === 0 ? (
          <EmptyState
            icon={ListChecks}
            title="No services yet"
            description={editable ? 'Add the first service that was sold below.' : 'The deal owner adds the sold services.'}
          />
        ) : (
          <ol className="m-0 flex list-none flex-col divide-y divide-line p-0">
            {items.map((item) => (
              <li key={item.itemId} className="m-0">
                <ServiceRow view={view} item={item} editable={editable && item.state === 'planned' && !item.task} actions={actions} />
              </li>
            ))}
          </ol>
        )}
        {editable && version ? (
          <CardFooter className="block border-t border-line px-4.5 py-4 text-base text-copy">
            <h3 id="intake-add-heading" className="m-0 mb-3 text-base font-semibold text-ink">
              Add a service
            </h3>
            <ServiceItemForm
              label="Add a service"
              dealId={view.dealId}
              versionId={version.versionId}
              rowVersion={version.rowVersion}
              action={actions.addServiceItem}
              initialState={preview?.addState ?? null}
            />
          </CardFooter>
        ) : null}
      </section>
    </Card>
  );
}

function ServiceRow({ view, item, editable, actions }: { view: IntakeView; item: ServiceItemView; editable: boolean; actions: IntakeActions }) {
  const version = view.services.version;
  const headingId = `intake-service-${item.itemNo}-heading`;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 px-4.5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={headingId} className="m-0 flex flex-wrap items-center gap-2 text-base font-semibold text-ink">
            <span className="text-sm font-medium text-quiet tabular-nums">Service {item.itemNo}</span>
            <ServiceTypePill type={item.serviceType} />
            <span className="wrap-break-word">{item.title}</span>
          </h3>
          <p className="m-0 mt-1.5 text-sm text-quiet">
            {SERVICE_DEPARTMENT_LABEL[item.department]} · {serviceOwnerText(item)}
            {item.purchaseBudgetPaise !== undefined ? ` · Budget ${formatBudget(item.purchaseBudgetPaise)}` : ''}
          </p>
        </div>
        <ServiceStatePill item={item} />
      </div>
      {editable && version ? (
        <>
          <ServiceItemForm
            label={`Service ${item.itemNo}: ${item.title}`}
            dealId={view.dealId}
            versionId={version.versionId}
            rowVersion={version.rowVersion}
            item={item}
            action={actions.saveServiceItem}
          />
          <RemoveServiceForm dealId={view.dealId} versionId={version.versionId} rowVersion={version.rowVersion} item={item} action={actions.removeServiceItem} />
        </>
      ) : (
        <>
          <FactsBlock facts={item.facts} />
          <p className="m-0 text-sm text-quiet">
            {serviceNextStepText(item)}{' '}
            {item.task ? (
              <Link href={serviceNextHref(item, view.dealId)} className={cn('rounded-chip font-medium text-brand-strong underline underline-offset-4 hover:text-brand-deep', focusRing)}>
                {serviceNextLinkText(item)}
              </Link>
            ) : null}
          </p>
        </>
      )}
    </section>
  );
}

function ChecklistCard({ blocking, warnings, created }: { blocking: IntakeChecklistItem[]; warnings: IntakeChecklistItem[]; created: boolean }) {
  const total = blocking.length + warnings.length;
  return (
    <Card>
      <section aria-labelledby="intake-checklist-heading">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id="intake-checklist-heading">Before tasks can be created</CardTitle>
            <CardDescription>
              {created ? 'The accepted version is saved.' : blocking.length === 0 ? 'Nothing blocks saving the accepted version.' : `${blocking.length} blocking ${blocking.length === 1 ? 'item' : 'items'}.`}
            </CardDescription>
          </div>
          {blocking.length === 0 ? (
            <StatusBadge tone="success" icon={CircleCheck}>
              Clear
            </StatusBadge>
          ) : (
            <StatusBadge tone="danger" icon={CircleX}>
              {blocking.length} blocking
            </StatusBadge>
          )}
        </CardHeader>
        <CardBody>
          {total === 0 ? (
            <p className="m-0 flex items-center gap-2 text-copy">
              <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-status-success" />
              Nothing is missing.
            </p>
          ) : (
            <ol className="m-0 flex list-none flex-col gap-3 p-0">
              {[...blocking, ...warnings].map((item) => (
                <li key={item.code} className="m-0 flex gap-2.5">
                  {item.blocking ? (
                    <CircleX aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-danger" />
                  ) : (
                    <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-warning" />
                  )}
                  <div className="min-w-0">
                    <p className="m-0 text-copy">
                      <span className={cn('font-semibold', item.blocking ? 'text-status-danger' : 'text-status-warning')}>{item.blocking ? 'Blocking: ' : 'Check: '}</span>
                      {checklistItemText(item)}
                    </p>
                    <p className="m-0 text-sm text-quiet">{CHECKLIST_OWNER_LABEL[item.owner]}</p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardBody>
      </section>
    </Card>
  );
}

function ProofCard({ view, editable }: { view: IntakeView; editable: boolean }) {
  const version = view.services.version;
  const items = view.evidence.filter((e) => e.status !== 'removed');
  return (
    <Card>
      <section aria-labelledby="intake-proof-heading">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id="intake-proof-heading">Proof the customer accepted</CardTitle>
            <CardDescription>Visible only to the Sales owner, assigned Sales and the branch Sales Manager — never to Purchase or Flight.</CardDescription>
          </div>
          <FileText aria-hidden="true" className="size-4 shrink-0 text-faint" />
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          {!view.evidenceVisible ? (
            <p className="m-0">
              <HiddenForRole /> <span className="text-sm text-quiet">{PROOF_HIDDEN_TEXT}</span>
            </p>
          ) : items.length === 0 ? (
            <p className="m-0 text-quiet">No proof uploaded yet.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Proof files">
              {items.map((item) => (
                <ProofRow key={item.id} item={item} dealId={view.dealId} editable={editable} />
              ))}
            </ul>
          )}
          {editable && version && view.evidenceVisible ? (
            <div className="[&_.form-grid]:grid [&_.form-grid]:gap-3 [&_.form-grid]:sm:grid-cols-2">
              <UploadEvidenceForm dealId={view.dealId} versionId={version.versionId} fileCount={items.length} />
              <p className="m-0 mt-2.5 text-sm text-quiet">Up to {EVIDENCE_MAX_FILES} files per version.</p>
            </div>
          ) : null}
        </CardBody>
      </section>
    </Card>
  );
}

function ProofRow({ item, dealId, editable }: { item: EvidenceItemView; dealId: string; editable: boolean }) {
  const problem = item.status === 'failed' || item.status === 'pending_upload';
  return (
    <li
      className={cn(
        'm-0 flex flex-wrap items-center gap-3 rounded-control border px-3.5 py-3',
        problem ? 'border-status-danger-line bg-status-danger-tint' : 'border-line bg-canvas',
      )}
    >
      {problem ? (
        <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-status-danger" />
      ) : (
        <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-status-success" />
      )}
      <div className="min-w-0 flex-1">
        <p className="m-0 font-medium wrap-anywhere text-ink">{item.fileName}</p>
        <p className={cn('m-0 text-sm', problem ? 'text-status-danger' : 'text-quiet')}>
          {EVIDENCE_KIND_LABEL[item.kind]} · {item.sizeLabel} · {EVIDENCE_STATUS_TEXT[item.status]}
          {item.uploadedByYou ? ' · uploaded by you' : ''} · {formatIst(item.uploadedAt)}
          {problem ? '. Remove it or upload it again.' : ''}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {item.status === 'stored' ? (
          <a className={buttonVariants({ variant: 'secondary', size: 'sm' })} href={`/app/bookings/evidence/${item.id}`} rel="noopener">
            Download<span className="sr-only"> {item.fileName}</span>
          </a>
        ) : null}
        {editable ? <RemoveEvidenceForm dealId={dealId} evidenceId={item.id} fileName={item.fileName} /> : null}
      </div>
    </li>
  );
}

/** Shown in the preview gallery for the "switched off" case; the real route redirects to the deal instead. */
export function IntakeDisabledView({ dealId }: { dealId: string }) {
  return (
    <div className="font-sans text-base text-copy">
      <BackToDeal dealId={dealId} />
      <PageHeader title="Confirmed booking intake" />
      <Card role="status">
        <div className="flex items-start gap-3 px-4.5 py-4">
          <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-control bg-brand-tint text-brand">
            <Info className="size-4.5" />
          </span>
          <p className="m-0 self-center text-copy">{INTAKE_DISABLED_TEXT}</p>
        </div>
      </Card>
    </div>
  );
}

/** Same response for "does not exist" and "not yours", so IDs cannot be probed. */
export function IntakeNotAvailableView() {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader title="Intake not available" />
      <Card role="status">
        <div className="flex items-start gap-3 px-4.5 py-4">
          <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-control bg-brand-tint text-brand">
            <FileQuestion className="size-4.5" />
          </span>
          <p className="m-0 self-center text-copy">This deal does not exist, or it is not visible to you.</p>
        </div>
      </Card>
      <p className="m-0 mt-4">
        <Link href="/app/deals" className={buttonVariants({ variant: 'secondary' })}>
          <ChevronLeft aria-hidden="true" />
          Back to deals
        </Link>
      </p>
    </div>
  );
}

/** Loading state of the intake route: hidden h1, one polite status, grey shapes in the page's layout. */
export function IntakeLoading() {
  return (
    <div className="flex flex-col gap-4 font-sans">
      <h1 className="sr-only">Confirmed booking intake</h1>
      <p role="status" aria-live="polite" className="m-0 text-sm font-medium text-quiet">
        Loading intake…
      </p>
      <div aria-busy="true" className="flex flex-col gap-4">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-4 w-64 max-w-full" />
        <Skeleton className="h-7 w-96 max-w-full" />
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-6 w-40 rounded-full" />
          <Skeleton className="h-6 w-48 rounded-full" />
        </div>
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="flex flex-col gap-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex flex-col gap-3 rounded-card border border-line bg-card px-4.5 py-4 shadow-card">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-10 w-full rounded-control" />
                <Skeleton className="h-4 w-3/4" />
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-4">
            {[0, 1].map((i) => (
              <div key={i} className="flex flex-col gap-3 rounded-card border border-line bg-card px-4.5 py-4 shadow-card">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
