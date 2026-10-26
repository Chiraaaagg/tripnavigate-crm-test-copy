import { BadgeCheck, Building2, CircleCheck, CircleDot, CircleHelp, FileCheck2, Landmark, MinusCircle, PlayCircle, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import type React from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Timeline, type TimelineItem } from '@/components/ui/timeline';
import { formatPaise } from '@/modules/deals/dto';
import {
  A1_TEXT,
  BENEFICIARY_NOTICE,
  BENEFICIARY_STATUS_LABEL,
  COST_STAGE_LABEL,
  PROCUREMENT_ISSUE_TEXT,
  PURCHASE_EVIDENCE_KIND_LABEL,
  type PurchaseWorkspaceView,
  QUOTE_STATUS_LABEL,
  SERVICE_TYPE_LABEL,
  type SupplierDetailView,
  type SupplierSummary,
  VERIFICATION_LABEL,
} from '@/modules/procurement/contracts';
import { latestCostVersionNo } from '@/modules/procurement/dto';
import { formatDateOnly } from './booking-views';
import { budgetText, TaskBackLink } from './department/task-frame';
import {
  AddBeneficiaryForm,
  AddQuoteForm,
  ApproveBeneficiaryForm,
  ApproveOverBudgetForm,
  ConfirmSupplierForm,
  CreateSupplierForm,
  EditSupplierForm,
  type ProcUiResult,
  ProposeCostForm,
  ReassignTaskForm,
  ReleaseTaskForm,
  RemovePurchaseFileForm,
  UploadPurchaseFileForm,
  VerifySupplierForm,
  WithdrawQuoteForm,
} from './procurement-forms';
import { formatIst } from './staff-views';
import { OrNotRecorded } from './value-states';

/*
 * Phase 4 Purchase screens. Data comes only from the Purchase workspace and
 * supplier reads, which carry no selling price, margin or acceptance proof.
 * Design: offers as compact cards (21st.dev "Card Status List" 2514 idea),
 * cost history on the CRM Timeline (21st.dev "Tracker Card" 8035 idea; Batch 4
 * Direction A cards), bank
 * details as masked rows (21st.dev "Payment Methods Checkbox" 24933). See
 * docs/implementation/phase-4/design/21st-dev-log.md.
 */

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const metaClass = 'm-0 text-sm text-quiet';

function WorkCard({ id, title, description, children }: { id: string; title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card>
      <section aria-labelledby={id}>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id={id} level={3}>
              {title}
            </CardTitle>
            {description ? <CardDescription>{description}</CardDescription> : null}
          </div>
        </CardHeader>
        <CardBody className="flex flex-col gap-4">{children}</CardBody>
      </section>
    </Card>
  );
}

/**
 * The Purchase work (Work tab, DA-16): offers, cost history, files, hand back
 * and reassign. Only rendered for Purchase role holders and the branch Manager.
 * The task header carries the one "Next:" line; this section says only what
 * the viewer can do here. Upload stays here (R13), next to the confirmation.
 */
export function PurchaseWorkSection({ ws, confirmState }: { ws: PurchaseWorkspaceView; confirmState?: ProcUiResult | null }) {
  const taskId = ws.task.taskId;
  const confirmed = ws.task.status === 'supplier_confirmed';
  const latestNo = latestCostVersionNo(ws);
  const latest = ws.costVersions.find((c) => c.versionNo === latestNo) ?? null;
  const openQuotes = ws.quotes.filter((q) => q.status === 'open');
  const quoteLabel = (id: string) => {
    const q = ws.quotes.find((x) => x.quoteId === id);
    return q ? `${q.supplierName} · ${q.hotelName}` : 'Offer';
  };
  const budget = BigInt(ws.task.purchaseBudgetPaise);
  const situation = confirmed
    ? `The supplier confirmed the hotel${ws.supplierConfirmedByName ? ` (recorded by ${ws.supplierConfirmedByName})` : ''}. No payment, bill or invoice was created.`
    : ws.canApproveOverBudget
      ? null
      : ws.canWork
        ? ws.issues.length === 0
          ? 'Everything needed is here. Record the supplier’s confirmation.'
          : 'Add offers, propose the agreed cost and upload the supplier’s confirmation.'
        : ws.task.status === 'not_started'
          ? 'Take this task first. Only the person who takes it can record offers and costs.'
          : `${ws.task.assigneeName ?? 'A colleague'} is working on this. You can read it.`;
  const costItems: TimelineItem[] = ws.costVersions.map((c) => ({
    id: String(c.versionNo),
    icon: c.stage === 'committed' ? CircleCheck : undefined,
    state: c.stage === 'committed' || c.versionNo !== latestNo ? 'done' : 'current',
    title: (
      <>
        <strong>
          {COST_STAGE_LABEL[c.stage]} · version {c.versionNo}
        </strong>
        {c.versionNo === latestNo && c.stage === 'proposed' ? ' · latest' : ''}
      </>
    ),
    meta: (
      <>
        <span className="font-semibold text-ink tabular-nums">{formatPaise(c.amountPaise)}</span> for {quoteLabel(c.quoteId)}
        <br />
        {c.dueDate ? `Supplier payment due ${formatDateOnly(c.dueDate)} · ` : ''}Not requested for payment · {formatIst(c.createdAt)}
        {c.createdByName ? ` by ${c.createdByName}` : ''}
      </>
    ),
    detail:
      c.overBudgetApprovedAt || c.note ? (
        <>
          {c.overBudgetApprovedAt ? (
            <p className="m-0">
              Approved above budget{c.overBudgetApprovedByName ? ` by ${c.overBudgetApprovedByName}` : ''} · {formatIst(c.overBudgetApprovedAt)}
            </p>
          ) : null}
          {c.note ? <p className="m-0 whitespace-pre-wrap wrap-break-word">{c.note}</p> : null}
        </>
      ) : undefined,
  }));

  return (
    <section className="flex flex-col gap-5" aria-labelledby="work-heading">
      <Card>
        <CardHeader className="max-sm:flex-col max-sm:items-start">
          <div className="flex min-w-0 flex-col gap-2">
            <CardTitle id="work-heading">Supplier offers, cost and confirmation</CardTitle>
            {confirmed ? (
              <StatusBadge tone="success" icon={CircleCheck} wrap>
                <span className="sr-only">Supplier: </span>Confirmed · reference {ws.supplierReference}
              </StatusBadge>
            ) : (
              <StatusBadge tone="info" icon={PlayCircle} wrap>
                <span className="sr-only">Supplier: </span>Not confirmed yet · hotel not booked
              </StatusBadge>
            )}
            {situation ? <p className="m-0 text-copy">{situation}</p> : null}
          </div>
          {ws.canWork && !confirmed ? (
            <div className="shrink-0" data-slot="work-primary">
              <ConfirmSupplierForm taskId={taskId} latestVersionNo={latestNo} issues={ws.issues} initialState={confirmState ?? null} />
            </div>
          ) : null}
        </CardHeader>
        {ws.gateIssue || (ws.canWork && ws.issues.length > 0) ? (
          <CardBody className="flex flex-col gap-3">
            {ws.gateIssue ? <Notice tone="warning">{PROCUREMENT_ISSUE_TEXT[ws.gateIssue]}</Notice> : null}
            {ws.canWork && ws.issues.length > 0 ? (
              <section aria-labelledby="work-missing" className="flex flex-col gap-1.5">
                <h3 id="work-missing" className="m-0 text-base font-semibold text-ink">
                  Before you can record the supplier’s confirmation
                </h3>
                <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-copy">
                  {ws.issues.map((code) => (
                    <li key={code}>{PROCUREMENT_ISSUE_TEXT[code]}</li>
                  ))}
                </ul>
              </section>
            ) : null}
          </CardBody>
        ) : null}
      </Card>

      <WorkCard id="work-offers" title="Supplier offers">
        {ws.quotes.length === 0 ? (
          <p className="m-0 text-quiet">No offers yet.</p>
        ) : (
          <ul className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2" aria-label="Supplier offers">
            {ws.quotes.map((q) => (
              <li key={q.quoteId} className={cn('m-0 flex flex-col gap-1 rounded-control border border-line bg-canvas px-3.5 py-3', q.status === 'withdrawn' && 'border-dashed bg-wash')}>
                <StatusBadge tone={q.status === 'selected' ? 'success' : q.status === 'open' ? 'info' : 'neutral'} icon={q.status === 'selected' ? CircleCheck : q.status === 'open' ? CircleDot : MinusCircle} className="self-start">
                  <span className="sr-only">Offer: </span>
                  {QUOTE_STATUS_LABEL[q.status]}
                </StatusBadge>
                <h4 className="m-0 mt-4 text-base font-semibold text-ink wrap-anywhere">{q.supplierName}</h4>
                <p className={metaClass}>{VERIFICATION_LABEL[q.supplierVerification]}</p>
                <p className="m-0 text-lg font-semibold text-ink tabular-nums">{formatPaise(q.quotedCostPaise)}</p>
                <p className={metaClass}>
                  {q.hotelName}
                  {q.roomType ? ` · ${q.roomType}` : ''}
                  {q.mealPlan ? ` · ${q.mealPlan}` : ''}
                </p>
                <p className={metaClass}>{q.holdUntil ? `Held until ${formatDateOnly(q.holdUntil)}` : 'No hold'}</p>
                {q.cancellationTerms ? <p className={cn(metaClass, 'whitespace-pre-wrap wrap-break-word')}>Cancellation: {q.cancellationTerms}</p> : null}
                {BigInt(q.quotedCostPaise) > budget ? <p className={metaClass}>Above the approved budget.</p> : null}
                {ws.canWork && q.status === 'open' ? <WithdrawQuoteForm taskId={taskId} quoteId={q.quoteId} label={q.supplierName} /> : null}
              </li>
            ))}
          </ul>
        )}
        {ws.canWork ? (
          <details className="form-section work-form">
            <summary>
              <span className="form-section-title">Add a supplier offer</span>
            </summary>
            <AddQuoteForm taskId={taskId} suppliers={ws.supplierChoices} defaultHotelName={ws.task.hotelName ?? ''} />
          </details>
        ) : null}
      </WorkCard>

      <WorkCard id="work-cost" title="Cost history" description={`Budget: ${budgetText(ws.task.purchaseBudgetPaise)}. Payments are not made from here.`}>
        {ws.costVersions.length === 0 ? <p className="m-0 text-quiet">No cost proposed yet.</p> : <Timeline label="Cost versions, newest first" items={costItems} />}
        {ws.canApproveOverBudget && latest ? (
          <Notice tone="warning" title="Above the approved budget">
            <p>
              Version {latest.versionNo} ({formatPaise(latest.amountPaise)}) is above the approved budget of {budgetText(ws.task.purchaseBudgetPaise)}. As the branch manager, approve it below if you agree.
            </p>
            <ApproveOverBudgetForm taskId={taskId} versionNo={latest.versionNo} />
          </Notice>
        ) : null}
        {ws.canWork ? (
          <details className="form-section work-form">
            <summary>
              <span className="form-section-title">{latest ? 'Propose a new cost' : 'Propose the agreed cost'}</span>
            </summary>
            <ProposeCostForm
              taskId={taskId}
              openQuotes={openQuotes.map((q) => ({ quoteId: q.quoteId, label: `${q.supplierName} · ${formatPaise(q.quotedCostPaise)}` }))}
              latestVersionNo={latestNo}
              defaultQuoteId={latest?.quoteId ?? openQuotes[0]?.quoteId ?? null}
              defaultAmountPaise={latest?.amountPaise ?? openQuotes[0]?.quotedCostPaise ?? null}
            />
          </details>
        ) : null}
      </WorkCard>

      <WorkCard id="work-files" title="Purchase files" description="Supplier quotes and confirmations. Private to the Purchase team; Sales does not see them.">
        {ws.evidence.length === 0 ? (
          <p className="m-0 text-quiet">No files yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Purchase files">
            {ws.evidence.map((f) => {
              const problem = f.status !== 'stored';
              return (
                <li key={f.id} className={cn('m-0 flex flex-wrap items-start gap-3 rounded-control border px-3.5 py-2.5', problem ? 'border-status-warning-line bg-status-warning-tint' : 'border-line bg-canvas')}>
                  {problem ? <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-warning" /> : <FileCheck2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-status-success" />}
                  <div className="min-w-40 flex-1">
                    <p className="m-0 font-medium wrap-anywhere text-ink">
                      {f.status === 'stored' ? (
                        <a href={`/app/purchase/files/${f.id}`} className={cn('rounded-chip text-brand-strong underline underline-offset-4 hover:text-brand-deep', focusRing)}>
                          {f.fileName}
                        </a>
                      ) : (
                        f.fileName
                      )}
                    </p>
                    <p className={metaClass}>
                      {PURCHASE_EVIDENCE_KIND_LABEL[f.kind]} · {sizeLabel(f.sizeBytes)} ·{' '}
                      {f.status === 'stored' ? 'Stored' : f.status === 'failed' ? 'Upload failed — does not count. Remove it and upload again.' : 'Upload not finished — does not count yet.'}
                    </p>
                  </div>
                  {ws.canWork ? (
                    <div className="shrink-0">
                      <RemovePurchaseFileForm taskId={taskId} evidenceId={f.id} fileName={f.fileName} />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {ws.canWork ? <UploadPurchaseFileForm taskId={taskId} fileCount={ws.evidence.length} /> : null}
      </WorkCard>

      {ws.canRelease ? (
        <WorkCard id="work-release" title={A1_TEXT.releaseLabel}>
          <ReleaseTaskForm taskId={taskId} />
        </WorkCard>
      ) : null}

      {ws.canReassign && ws.assigneeUserId ? (
        <WorkCard id="work-reassign" title={A1_TEXT.reassignLabel} description={`Currently with ${ws.task.assigneeName ?? 'a Purchase colleague'}.`}>
          <ReassignTaskForm taskId={taskId} expectedAssigneeId={ws.assigneeUserId} candidates={ws.reassignCandidates} />
        </WorkCard>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

function VerificationPill({ status }: { status: SupplierSummary['verificationStatus'] }) {
  return (
    <StatusBadge tone={status === 'verified' ? 'success' : 'warning'} icon={status === 'verified' ? BadgeCheck : CircleHelp} wrap>
      <span className="sr-only">Verification: </span>
      {VERIFICATION_LABEL[status]}
    </StatusBadge>
  );
}

function SectionCard({ id, title, children, description }: { id: string; title: string; children: React.ReactNode; description?: React.ReactNode }) {
  return (
    <Card className="mt-5">
      <section aria-labelledby={id}>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id={id}>{title}</CardTitle>
            {description ? <CardDescription>{description}</CardDescription> : null}
          </div>
        </CardHeader>
        <CardBody>{children}</CardBody>
      </section>
    </Card>
  );
}

/** PU-03 Suppliers (Direction A list look; forms unchanged). */
export function SupplierListPage({ suppliers, entities }: { suppliers: SupplierSummary[]; entities: Array<{ id: string; name: string }> }) {
  const canAdd = entities.length > 0;
  return (
    <div className="font-sans text-base text-copy">
      <TaskBackLink href="/app/purchase">Back to Purchase tasks</TaskBackLink>
      <PageHeader eyebrow="Purchase" title="Suppliers" description="Supplier details are recorded by Purchase and stay marked “not verified” until a manager verifies them; any later change by Purchase marks them not verified again." />
      <Card>
        {suppliers.length === 0 ? (
          <EmptyState icon={Building2} headingLevel={2} title="No suppliers yet" description={canAdd ? 'Add the first supplier below.' : 'Purchase colleagues add suppliers here.'} />
        ) : (
          <Table stackOnMobile label="Suppliers table" wrapperClassName="rounded-card">
            <TableCaption className="caption-top border-b border-line py-3 font-medium text-copy max-sm:block">
              {suppliers.length} {suppliers.length === 1 ? 'supplier' : 'suppliers'}
            </TableCaption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Supplier</TableHead>
                <TableHead>Services</TableHead>
                <TableHead>City</TableHead>
                <TableHead>Details</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {suppliers.map((s) => (
                <TableRow key={s.supplierId} className="align-top">
                  <TableCell label="Supplier" className="align-top">
                    <Link href={`/app/purchase/suppliers/${s.supplierId}`} className={cn('rounded-chip font-semibold text-brand-strong underline-offset-4 hover:text-brand-deep hover:underline', focusRing)}>
                      {s.name}
                    </Link>
                  </TableCell>
                  <TableCell label="Services" className="align-top">
                    {s.serviceTypes.map((t) => SERVICE_TYPE_LABEL[t]).join(', ')}
                  </TableCell>
                  <TableCell label="City" className="align-top">
                    <OrNotRecorded value={s.city} />
                  </TableCell>
                  <TableCell label="Details" className="align-top">
                    <VerificationPill status={s.verificationStatus} />
                  </TableCell>
                  <TableCell label="Status" className="align-top">
                    {s.status === 'active' ? 'Active' : 'Archived'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
      {canAdd ? (
        <SectionCard id="supplier-add" title="Add a supplier">
          <CreateSupplierForm entities={entities} />
        </SectionCard>
      ) : null}
    </div>
  );
}

/** PU-04 Supplier record (Direction A frame; forms unchanged). */
export function SupplierDetailPage({ supplier, justCreated }: { supplier: SupplierDetailView; justCreated?: boolean }) {
  return (
    <div className="font-sans text-base text-copy">
      <TaskBackLink href="/app/purchase/suppliers">Back to suppliers</TaskBackLink>
      <PageHeader
        eyebrow="Supplier"
        title={<span className="block wrap-anywhere">{supplier.name}</span>}
        status={
          <>
            <VerificationPill status={supplier.verificationStatus} />
            {supplier.verificationStatus === 'verified' && supplier.verifiedAt ? (
              <span className="text-copy">
                Verified{supplier.verifiedByName ? ` by ${supplier.verifiedByName}` : ''} · {formatIst(supplier.verifiedAt)}. A change of details by Purchase marks it not verified again.
              </span>
            ) : null}
          </>
        }
        actions={supplier.canVerify ? <VerifySupplierForm supplierId={supplier.supplierId} rowVersion={supplier.rowVersion} /> : undefined}
      />
      {justCreated ? (
        <Notice tone="success" role="status">
          <strong>Done: </strong>Supplier added. Details are marked not verified.
        </Notice>
      ) : null}
      <SectionCard id="supplier-edit" title="Details" description={`Last changed ${formatIst(supplier.updatedAt)}.`}>
        {supplier.canEdit ? <EditSupplierForm supplier={supplier} /> : <SupplierFacts supplier={supplier} />}
      </SectionCard>
      <SectionCard id="supplier-bank" title="Bank details">
        <div className="flex flex-col gap-4">
          <Notice tone="warning">{BENEFICIARY_NOTICE}</Notice>
          {supplier.beneficiaries.length === 0 ? (
            <p className="m-0 text-quiet">No bank details recorded.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label="Bank detail revisions, newest first">
              {supplier.beneficiaries.map((b) => (
                <li key={b.revisionNo} className="m-0 flex gap-3 rounded-control border border-line bg-canvas px-3.5 py-3">
                  <Landmark aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-faint" />
                  <div className="min-w-0 flex-1">
                    <p className="m-0 text-ink">
                      <strong>Revision {b.revisionNo}</strong>
                      {b.revisionNo === supplier.beneficiaries[0]!.revisionNo ? ' · latest' : ' · earlier'} · {BENEFICIARY_STATUS_LABEL[b.status]}
                    </p>
                    <p className="m-0 wrap-anywhere">
                      {b.accountHolder} · {b.bankName} · {b.ifsc} ·{' '}
                      <span className="whitespace-nowrap tabular-nums">
                        <span aria-hidden="true">•••• </span>
                        <span className="sr-only">account ending </span>
                        {b.accountLast4}
                      </span>
                    </p>
                    <p className={metaClass}>
                      Recorded {formatIst(b.createdAt)}
                      {b.createdByName ? ` by ${b.createdByName}` : ''}
                      {b.approvedAt ? ` · approved ${formatIst(b.approvedAt)}${b.approvedByName ? ` by ${b.approvedByName}` : ''}` : ''}
                    </p>
                    {b.canApprove ? <ApproveBeneficiaryForm supplierId={supplier.supplierId} revisionNo={b.revisionNo} /> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {supplier.canEdit ? (
            <details className="form-section work-form">
              <summary>
                <span className="form-section-title">Record new bank details</span>
              </summary>
              <AddBeneficiaryForm supplierId={supplier.supplierId} />
            </details>
          ) : null}
        </div>
      </SectionCard>
    </div>
  );
}

/** Read-only supplier details for managers (they verify; Purchase edits). */
function SupplierFacts({ supplier }: { supplier: SupplierDetailView }) {
  return (
    <dl className="facts m-0">
      <dt>Services</dt>
      <dd>{supplier.serviceTypes.map((t) => SERVICE_TYPE_LABEL[t]).join(', ')}</dd>
      <dt>City</dt>
      <dd>
        <OrNotRecorded value={supplier.city} />
      </dd>
      <dt>Contact person</dt>
      <dd>
        <OrNotRecorded value={supplier.contactName} />
      </dd>
      <dt>Phone</dt>
      <dd>
        <OrNotRecorded value={supplier.contactPhone} />
      </dd>
      <dt>Email</dt>
      <dd>
        <OrNotRecorded value={supplier.contactEmail} />
      </dd>
      <dt>Payment terms</dt>
      <dd className="prewrap">
        <OrNotRecorded value={supplier.paymentTerms} />
      </dd>
      <dt>Status</dt>
      <dd>{supplier.status === 'active' ? 'Active' : 'Archived'}</dd>
    </dl>
  );
}

export function SupplierNotFoundView() {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader title="Supplier not available" />
      <Notice tone="locked" role="status">
        We couldn’t find this supplier, or you may not have access.
      </Notice>
      <p className="m-0 mt-4">
        <Link href="/app/purchase/suppliers" className={buttonVariants({ variant: 'secondary' })}>
          Back to suppliers
        </Link>
      </p>
    </div>
  );
}
