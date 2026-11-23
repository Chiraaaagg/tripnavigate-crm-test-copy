import { Repeat } from 'lucide-react';
import type { ReactNode } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Notice } from '@/components/ui/notice';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { CommandButton, DialogAction, ReasonField } from '@/views/accounts-desk/acc2-kit';
import type { DeskResult } from '@/views/accounts-desk/desk-kit';
import { dayText, inr } from '@/views/accounts-desk/labels';
import { ReconfirmFields } from './fields';
import { RECONFIRM_TONE, RECONFIRM_WORD, SELLING_FIELDS, STATUS_WORD } from './labels';
import { overBudgetBlockedReason } from './rules';
import type { FactLine, ProofOption, TaskReconfirmationView } from './types';

/*
 * Purchase task › "Reconfirm with supplier" (contract 10.3 G7–G9, 10.5
 * R-G3, screen 15.10). The earlier confirmed booking and the changed one
 * side by side (changed lines marked in words), then the supplier's answer:
 * new rate, change fee, new reference and the proof file — or "Supplier
 * refused". Nothing changes on the task until the whole change is applied,
 * so the earlier confirmation stays valid (LD25). Above budget, the branch
 * Manager approves the new cost here. Never a selling price (section 14).
 */

export interface ReconfirmActions {
  record: DecisionAction;
  refuse: DecisionAction;
  approveOverBudget: DecisionAction;
}

export function ReconfirmPanel({
  view,
  proofs,
  actions,
  viewer,
  roles,
  proofUpload,
  voided = [],
  preview,
}: {
  /** Finding 8: the viewer's roles (route-derived) so a blocked over-budget approval says the real cause. */
  roles?: { isManager: boolean; worksTask: boolean };
  /**
   * Finding 1: the upload form for the supplier's new confirmation (kind supplier_confirmation only), shown
   * while the reconfirmation waits and `can.uploadProof` (the task is confirmed, so the normal upload is closed).
   */
  proofUpload?: ReactNode;
  view: TaskReconfirmationView | 'error';
  /**
   * Addendum L10: after this person refused, the other reconfirmations of the same change that they also
   * handle were voided. Notice 56 never goes to the person who acted, so the panel lists them here.
   */
  voided?: Array<{ taskId: string; serviceTitle: string; href: string }>;
  proofs: ProofOption[];
  actions: Partial<ReconfirmActions> | null;
  viewer: 'purchase' | 'manager';
  preview?: { open?: 'record' | 'refuse'; state?: DeskResult | null; defaults?: { newRateRupees?: string; supplierFeeRupees?: string; newReference?: string; evidenceId?: string } };
}) {
  if (view === 'error') {
    return (
      <PanelShell status="Could not load">
        <Notice tone="warning" role="status">
          <p>The reconfirmation could not be loaded just now. Nothing was changed. Reload the page.</p>
        </Notice>
      </PanelShell>
    );
  }
  const v = view;
  const rc = v.reconfirmation;
  const changed = new Set(v.new.changedFields.filter((k) => !SELLING_FIELDS.has(k)));
  const ids = { reconfirmationId: rc.id, expectedRowVersion: rc.rowVersion, taskId: v.taskId };
  const next =
    rc.status === 'pending'
      ? viewer === 'purchase'
        ? 'Ask the supplier to change the booking, upload their confirmation, then record their answer.'
        : 'Purchase asks the supplier and records the answer.'
      : rc.status === 'recorded' && rc.overBudget
        ? viewer === 'manager'
          ? 'The new cost is above budget. Approve it so the change can be applied.'
          : 'The new cost is above budget. The branch Manager approves it before the change is applied.'
        : rc.status === 'recorded'
          ? 'Waiting for the other suppliers in this change. It is applied when every supplier agreed.'
          : rc.status === 'refused'
            ? 'The change is off. The earlier booking stays with the supplier.'
            : rc.status === 'void'
              ? 'The change was called off. Tell the supplier to keep the earlier booking.'
              : null;
  return (
    <PanelShell status={`Change ${v.changeRequest.refNo} · ${STATUS_WORD[v.changeRequest.status]}`}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={RECONFIRM_TONE[rc.status]}>{RECONFIRM_WORD[rc.status]}</StatusBadge>
        {rc.overBudget && rc.status !== 'pending' ? <StatusBadge tone="warning">Above budget</StatusBadge> : null}
      </div>
      {next ? <p className="m-0 font-medium text-ink">Next: {next}</p> : null}
      {rc.status === 'refused' && voided.length > 0 ? (
        <Notice tone="warning" title="Other suppliers in this change">
          <p>The change is off for every service in it. You also handle these; each supplier must keep the earlier booking:</p>
          <ul className="m-0 flex list-disc flex-col gap-1 pl-5">
            {voided.map((x) => (
              <li key={x.taskId}>
                <a href={x.href} className="font-semibold text-brand-strong underline-offset-4 hover:underline">
                  {x.serviceTitle}
                </a>
                : tell this supplier the change is off.
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {rc.status === 'void' ? (
        <Notice tone="warning" title="Tell the supplier to keep the earlier booking">
          <p>The Sales owner withdrew the change, or another supplier in it refused. What you recorded is kept for the record only.</p>
        </Notice>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <FactsColumn
          title="Confirmed now"
          caption={v.old.confirmedAt ? `Confirmed ${dayText(v.old.confirmedAt)}` : null}
          lines={v.old.details}
          extra={[
            { label: 'Supplier rate', value: inr(v.old.ratePaise) },
            { label: 'Supplier reference', value: v.old.reference ?? '—' },
          ]}
        />
        <FactsColumn title="Changed booking" caption={`${changed.size} ${changed.size === 1 ? 'detail changes' : 'details change'}`} lines={v.new.details} changed={changed} />
      </div>

      {rc.status === 'pending' && v.can.uploadProof && proofUpload ? (
        <section aria-labelledby={`rc-proof-${rc.id}`} className="flex flex-col gap-2 rounded-control border border-line p-3">
          <h3 id={`rc-proof-${rc.id}`} className="m-0 text-base font-semibold text-ink">
            Upload the supplier&apos;s new confirmation
          </h3>
          <p className="m-0 text-sm text-copy">
            {proofs.length === 0 ? 'Upload it first; it then appears in the list when you record the answer.' : `${proofs.length} ${proofs.length === 1 ? 'file' : 'files'} uploaded for this change. Upload another if the supplier sent a newer one.`}
          </p>
          {proofUpload}
        </section>
      ) : null}

      {rc.status !== 'pending' && rc.newRatePaise ? (
        <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-2 rounded-control border border-line bg-canvas p-3 sm:grid-cols-4">
          <Fig label="New rate" value={inr(rc.newRatePaise)} />
          <Fig label="Change fee" value={inr(rc.supplierFeePaise)} />
          <Fig label="Budget for this service" value={inr(rc.budgetPaise)} />
          <Fig label="New reference" value={rc.newReference ?? '—'} />
        </dl>
      ) : null}

      <div className="flex flex-wrap items-start gap-3">
        {rc.status === 'pending' ? (
          <>
            <DialogAction
              buttonLabel="Record the supplier's answer"
              buttonVariant="primary"
              blockedReason={
                v.can.record
                  ? proofs.length === 0
                    ? v.can.uploadProof && proofUpload
                      ? 'Upload the supplier\u2019s new confirmation above first.'
                      : 'Upload the supplier\u2019s new confirmation first.'
                    : null
                  : viewer === 'manager'
                    ? 'Purchase records the answer.'
                    : 'Only the task assignee records it.'
              }
              title="Supplier agreed to the change"
              description="The new rate, fee, reference and proof wait on this change. The task keeps its earlier confirmation until the whole change is applied."
              primaryLabel="Save the supplier's answer"
              pendingLabel="Saving…"
              action={actions?.record}
              fields={ids}
              okTitle="Saved"
              initialOpen={preview?.open === 'record'}
              initialState={preview?.open === 'record' ? preview.state : undefined}
            >
              <ReconfirmFields budgetPaise={rc.budgetPaise} proofs={proofs} defaults={preview?.open === 'record' ? preview.defaults : undefined} />
            </DialogAction>
            <DialogAction
              buttonLabel="Supplier refused"
              blockedReason={v.can.refuse ? null : viewer === 'manager' ? 'Purchase records the answer.' : 'Only the task assignee records it.'}
              title="The supplier cannot make the change"
              description="The whole change is called off: other suppliers' answers are voided and the earlier booking stands. The Sales owner is told at once. Nothing else changes."
              primaryLabel="Call off the change"
              pendingLabel="Saving…"
              action={actions?.refuse}
              fields={ids}
              danger
              cancelLabel="Keep waiting"
              okTitle="Called off"
              initialOpen={preview?.open === 'refuse'}
              initialState={preview?.open === 'refuse' ? preview.state : undefined}
            >
              <ReasonField id={`rc-refuse-${rc.id}`} label="What the supplier said" />
            </DialogAction>
          </>
        ) : null}
        {rc.status === 'recorded' && rc.overBudget ? (
          <CommandButton
            action={actions?.approveOverBudget}
            fields={ids}
            label="Approve the cost above budget"
            pendingLabel="Approving…"
            variant="primary"
            okTitle="Approved"
            blockedReason={overBudgetBlockedReason({ isManager: roles?.isManager ?? viewer === 'manager', worksTask: roles?.worksTask ?? viewer === 'purchase', canApprove: v.can.approveOverBudget })}
          />
        ) : null}
      </div>
    </PanelShell>
  );
}

function FactsColumn({ title, caption, lines, changed, extra = [] }: { title: string; caption: string | null; lines: FactLine[]; changed?: Set<string>; extra?: Array<{ label: string; value: string }> }) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-2 rounded-control border border-line p-3">
      <div>
        <h3 className="m-0 text-base font-semibold text-ink">{title}</h3>
        {caption ? <p className="m-0 text-sm text-quiet">{caption}</p> : null}
      </div>
      <dl className="m-0 flex flex-col gap-1.5 text-sm">
        {lines.map((l) => {
          const isChanged = changed?.has(l.key);
          return (
            <div key={l.key} className={`flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded-chip px-1.5 py-0.5 ${isChanged ? 'bg-status-warning-tint' : ''}`}>
              <dt className="text-quiet">{l.label}</dt>
              <dd className="m-0 flex flex-wrap items-center gap-1.5 text-right wrap-anywhere text-ink">
                {l.value ?? '—'}
                {isChanged ? <StatusBadge tone="warning">Changed</StatusBadge> : null}
              </dd>
            </div>
          );
        })}
        {extra.map((e) => (
          <div key={e.label} className="flex flex-wrap items-baseline justify-between gap-x-3 px-1.5">
            <dt className="text-quiet">{e.label}</dt>
            <dd className="m-0 text-right tabular-nums text-ink">{e.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Fig({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-sm text-quiet">{label}</dt>
      <dd className="m-0 wrap-anywhere tabular-nums text-ink">{value}</dd>
    </div>
  );
}

function PanelShell({ status, children }: { status: string; children: ReactNode }) {
  return (
    <Card id="reconfirm">
      <section aria-labelledby="reconfirm-heading">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id="reconfirm-heading">Reconfirm with supplier</CardTitle>
            <CardDescription>{status}</CardDescription>
          </div>
          <Repeat aria-hidden="true" className="size-4 text-faint" />
        </CardHeader>
        <CardBody className="flex flex-col gap-4">{children}</CardBody>
      </section>
    </Card>
  );
}

export function ReconfirmPanelLoading() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Reconfirm with supplier</CardTitle>
      </CardHeader>
      <CardBody>
        <LoadingRegion label="Loading the reconfirmation…">
          <Skeleton className="h-40 w-full" />
        </LoadingRegion>
      </CardBody>
    </Card>
  );
}
