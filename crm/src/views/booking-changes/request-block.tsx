import Link from 'next/link';
import { StatusBadge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { CommandButton, DialogAction, ReasonField } from '@/views/accounts-desk/acc2-kit';
import type { DeskResult } from '@/views/accounts-desk/desk-kit';
import { inr, whenText } from '@/views/accounts-desk/labels';
import { ChangeRequestFields } from './fields';
import { DEPARTMENT_WORD, KIND_WORD, RECONFIRM_TONE, RECONFIRM_WORD, ROUTE_WORD, STATUS_TONE, STATUS_WORD } from './labels';
import { changeNextStep, itemNosText, LIVE_STATUSES, reconfirmProgress } from './rules';
import type { ChangeRequestView, ChangeViewer, DealChangeRequestsView } from './types';

/*
 * One change request on the Deal page (R-G1 requests[], H additive keys):
 * status in words, what changes and why, who asked and who decided, the
 * reconfirmation progress per supplier, the removal route and charge state,
 * and the actions the database allows this viewer (`can`). A Server
 * Component; the dialogs are client islands.
 */

export interface ChangeRequestActions {
  create: DecisionAction;
  /** Track H (11.2): ask to add a service. */
  createAdd: DecisionAction;
  /** Track H (11.3): ask to remove a service (customerChargeRupees for a booked one). */
  createRemove: DecisionAction;
  resubmit: DecisionAction;
  withdraw: DecisionAction;
  openVersion: DecisionAction;
}

export type RequestDialog = 'resubmit' | 'withdraw';
export interface RequestPreviewOpen {
  requestId: string;
  dialog: RequestDialog;
  state?: DeskResult | null;
}

export function ChangeRequestBlock({
  r,
  deal,
  viewer,
  actions,
  editHref,
  open,
}: {
  r: ChangeRequestView;
  deal: Pick<DealChangeRequestsView, 'dealId' | 'confirmed' | 'removable' | 'addableTypes'>;
  viewer: ChangeViewer;
  actions: Partial<ChangeRequestActions> | null;
  /** The booking form in change mode for this request (route-built). */
  editHref: string | null;
  open?: RequestPreviewOpen;
}) {
  const base = { changeRequestId: r.id, expectedRowVersion: r.rowVersion, dealId: deal.dealId, kind: r.kind };
  const progress = reconfirmProgress(r.reconfirmations);
  const o = (d: RequestDialog) => (open?.requestId === r.id && open.dialog === d ? open : undefined);
  const live = LIVE_STATUSES.has(r.status);
  const next = changeNextStep(r, viewer);
  return (
    <article aria-labelledby={`cr-${r.id}`} className="flex flex-col gap-3 rounded-control border border-line bg-canvas p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 id={`cr-${r.id}`} className="m-0 text-base font-semibold text-ink">
          {KIND_WORD[r.kind]} {r.refNo}
        </h4>
        <StatusBadge tone={STATUS_TONE[r.status]} wrap>
          {STATUS_WORD[r.status]}
        </StatusBadge>
      </div>
      {next ? <p className="m-0 text-sm font-medium text-ink">Next: {next}</p> : null}
      <dl className="m-0 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[minmax(7rem,10rem)_1fr]">
        <dt className="text-quiet">{r.kind === 'add_service' ? 'Adds' : 'Services'}</dt>
        <dd className="m-0 text-ink">{r.kind === 'add_service' ? 'A new service (details in the booking)' : itemNosText(r.itemNos)}</dd>
        <dt className="text-quiet">{r.kind === 'add_service' ? 'What to add' : 'What changes'}</dt>
        <dd className="m-0 wrap-anywhere text-ink">{r.changeSummary}</dd>
        <dt className="text-quiet">Why</dt>
        <dd className="m-0 wrap-anywhere text-ink">{r.reason}</dd>
        <dt className="text-quiet">Asked by</dt>
        <dd className="m-0 text-ink">
          {r.requestedByName} · {whenText(r.requestedAt)}
        </dd>
        {r.decidedByName && r.decidedAt ? (
          <>
            <dt className="text-quiet">{r.status === 'returned' ? 'Returned by' : 'Approved by'}</dt>
            <dd className="m-0 text-ink">
              {r.decidedByName} · {whenText(r.decidedAt)}
            </dd>
          </>
        ) : null}
        {r.kind === 'remove_service' && r.removalRoute ? (
          <>
            <dt className="text-quiet">Removal</dt>
            <dd className="m-0 text-ink">{ROUTE_WORD[r.removalRoute]}</dd>
          </>
        ) : null}
        {r.kind === 'remove_service' && r.customerChargePaise != null ? (
          <>
            <dt className="text-quiet">Customer charge</dt>
            <dd className="m-0 tabular-nums text-ink">{inr(r.customerChargePaise)}</dd>
          </>
        ) : null}
      </dl>
      {r.returnReason && r.status === 'returned' ? (
        <p className="m-0 rounded-control border border-status-danger-line bg-status-danger-tint px-3 py-2 text-sm text-ink">
          <strong>Manager&apos;s reason: </strong>
          {r.returnReason}
        </p>
      ) : null}
      {r.closeReason && (r.status === 'not_possible' || r.status === 'withdrawn') ? (
        <p className="m-0 text-sm text-copy">
          <strong className="text-ink">{r.status === 'not_possible' ? 'Supplier said: ' : 'Withdrawn because: '}</strong>
          {r.closeReason}
        </p>
      ) : null}
      {r.charges && r.charges.length > 0 ? (
        <section aria-label={`Supplier charges for ${r.refNo}`} className="flex flex-col gap-1">
          <p className="m-0 text-sm font-semibold text-ink">Supplier charges</p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {r.charges.map((c) => (
              <li key={c.department} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-ink">{DEPARTMENT_WORD[c.department]}</span>
                <StatusBadge tone={c.complete ? 'success' : 'warning'}>{c.complete ? `Entered${c.enteredByName ? ` by ${c.enteredByName}` : ''}` : 'Not entered yet'}</StatusBadge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {r.reconfirmations.length > 0 ? (
        <section aria-label={`Supplier reconfirmations for ${r.refNo}`} className="flex flex-col gap-1">
          <p className="m-0 text-sm font-semibold text-ink">{progress}</p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {r.reconfirmations.map((l) => (
              <li key={l.taskId} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-ink">{l.serviceTitle}</span>
                <StatusBadge tone={RECONFIRM_TONE[l.status]}>{RECONFIRM_WORD[l.status]}</StatusBadge>
                {l.overBudget && l.status === 'recorded' ? <StatusBadge tone="warning">Above budget — Manager approves</StatusBadge> : null}
                {l.refusedReason ? <span className="w-full text-quiet">{l.refusedReason}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {live ? (
        <div className="flex flex-wrap items-start gap-3">
          {r.can.openVersion ? (
            <CommandButton
              action={actions?.openVersion}
              fields={{ changeRequestId: r.id }}
              label="Start the change in the booking"
              pendingLabel="Opening…"
              variant="primary"
              okTitle="Ready"
              ariaLabel={`Start the change in the booking for ${r.refNo}`}
            />
          ) : null}
          {r.changeVersionId && editHref && (r.can.submit || r.status === 'draft' || r.status === 'returned') ? (
            <Link href={editHref} className={buttonVariants({ variant: r.can.openVersion ? 'secondary' : 'primary', size: 'sm' })}>
              {r.can.submit ? (r.status === 'returned' ? 'Fix the change and send it again' : 'Fill in and send the change') : 'See the change version'}
            </Link>
          ) : null}
          {r.can.resubmit ? (
            <DialogAction
              buttonLabel="Edit the request details"
              title={`Edit ${r.refNo}`}
              description='Change what the request says and why. Then fix the booking and press "Send change" again; the Manager approves the version you send.'
              primaryLabel="Save the details"
              pendingLabel="Saving…"
              action={actions?.resubmit}
              fields={base}
              okTitle="Saved"
              initialOpen={Boolean(o('resubmit'))}
              initialState={o('resubmit')?.state}
              ariaLabel={`Edit the details of ${r.refNo}`}
            >
              <ChangeRequestFields kind={r.kind} confirmed={deal.confirmed} removable={deal.removable} addableTypes={deal.addableTypes} defaults={{ itemIds: itemIdsOf(r, deal), changeSummary: r.changeSummary, reason: r.reason, customerChargeRupees: r.customerChargePaise ? paiseToRupees(r.customerChargePaise) : undefined }} />
            </DialogAction>
          ) : null}
          {r.can.withdraw ? (
            <DialogAction
              buttonLabel="Withdraw"
              title={`Withdraw ${r.refNo}`}
              description={
                r.status === 'approved' || r.status === 'submitted'
                  ? 'The change version is thrown away and any supplier reconfirmation already recorded is called off. Purchase is told to ask the supplier to keep the earlier booking. The earlier booking stays as it is.'
                  : r.changeVersionId
                    ? 'The request is closed and its change version is thrown away. The booking stays as it is.'
                    : 'The request is closed. The booking stays as it is.'
              }
              primaryLabel="Withdraw the request"
              pendingLabel="Withdrawing…"
              action={actions?.withdraw}
              fields={base}
              danger
              cancelLabel="Keep it"
              okTitle="Withdrawn"
              initialOpen={Boolean(o('withdraw'))}
              initialState={o('withdraw')?.state}
              ariaLabel={`Withdraw ${r.refNo}`}
            >
              <ReasonField id={`cr-wd-${r.id}`} />
            </DialogAction>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function itemIdsOf(r: ChangeRequestView, deal: Pick<DealChangeRequestsView, 'confirmed' | 'removable'>): string[] {
  const pool = r.kind === 'remove_service' && deal.removable ? deal.removable : deal.confirmed;
  return pool.filter((s) => r.itemNos.includes(s.itemNo)).map((s) => s.itemId);
}

function paiseToRupees(p: string): string {
  const n = BigInt(p);
  const f = n % 100n;
  return f === 0n ? (n / 100n).toString() : `${n / 100n}.${f.toString().padStart(2, '0')}`;
}
