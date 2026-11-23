import { FileCheck2 } from 'lucide-react';
import Link from 'next/link';
import { StatusBadge } from '@/components/ui/badge';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { DialogAction, ReasonField } from '@/views/accounts-desk/acc2-kit';
import type { DeskResult } from '@/views/accounts-desk/desk-kit';
import { dayText, inr, whenText } from '@/views/accounts-desk/labels';
import { DOCUMENT_STATUS_WORDS } from '@/modules/customer-documents/status';
import { PayoutFields, RefundRequestFields } from './fields';
import { OUTCOME_WORD, PAYOUT_MODE_WORD, REFUND_KIND_WORD, STATUS_TONE, statusWord } from './labels';
import type { DealRefundsView, RefundRequestView } from './types';

/*
 * One refund request with its timeline and the actions the database allows
 * this viewer (`can`): resubmit and withdraw (requester), approve and return
 * (the approving Manager, binding the exact amounts shown), withdraw an
 * approved unpaid refund (a branch Manager, LD31), pay out and verify
 * (Accounts, not the requester or approver). Used on the Deal page refund
 * card, Approvals › Refunds and Accounts › Refunds. A Server Component; the
 * dialogs are client islands.
 */

export interface RefundActions {
  request: DecisionAction;
  resubmit: DecisionAction;
  withdraw: DecisionAction;
  decide: DecisionAction;
  payOut: DecisionAction;
  recordSupplierRefund: DecisionAction;
  cancelSupplierRefund: DecisionAction;
}

export type RefundDialog = 'resubmit' | 'withdraw' | 'approve' | 'return' | 'payout';
export interface RefundPreviewOpen {
  requestId: string;
  dialog: RefundDialog;
  state?: DeskResult | null;
}

export function RefundRequestBlock({
  r,
  deal,
  dealId,
  actions,
  today,
  headingLevel = 4,
  showDealLink,
  dealReference,
  open,
  viewer,
}: {
  /** Who reads (R-C1 viewer): Sales see a credit note only once it is released. */
  viewer?: 'accounts' | 'manager' | 'sales';
  r: RefundRequestView;
  /** The Deal's refund read (money held, payers) for resubmit. */
  deal: Pick<DealRefundsView, 'heldPaise' | 'basisTotalPaise' | 'cancellation' | 'payers' | 'enabled' | 'keptCreditUnusedPaise' | 'approvedChargePaise'>;
  dealId: string;
  actions: Partial<RefundActions> | null;
  today: string;
  headingLevel?: 3 | 4;
  showDealLink?: boolean;
  dealReference?: string;
  open?: RefundPreviewOpen;
}) {
  const H = headingLevel === 3 ? 'h3' : 'h4';
  const off = deal.enabled ? null : 'Refunds are not switched on yet.';
  const base = { refundRequestId: r.id, expectedRowVersion: r.rowVersion, dealId };
  const amountWords = r.outcome === 'charge_only' ? `charge ${inr(r.customerChargePaise)}` : `${inr(r.amountPaise)}${r.kind === 'cancellation' ? ` (charge ${inr(r.customerChargePaise)})` : ''}`;
  const o = (d: RefundDialog) => (open?.requestId === r.id && open.dialog === d ? open : undefined);
  return (
    <article aria-labelledby={`rf-${r.id}`} className="flex flex-col gap-3 rounded-control border border-line bg-canvas p-3">
      <div className="flex flex-wrap items-center gap-2">
        <H id={`rf-${r.id}`} className="m-0 text-base font-semibold text-ink">
          Refund {r.refNo}
          {showDealLink && dealReference ? (
            <>
              {' · '}
              <Link href={`/app/deals/${dealId}?tab=money#refunds`} className="text-brand-strong underline-offset-4 hover:underline">
                {dealReference}
              </Link>
            </>
          ) : null}
        </H>
        <StatusBadge tone={STATUS_TONE[r.status]} wrap>
          <span className="sr-only">Status: </span>
          {statusWord(r.status, r.outcome)}
        </StatusBadge>
      </div>

      <dl className="m-0 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
        <Fig label="For" value={REFUND_KIND_WORD[r.kind]} />
        <Fig label="Outcome" value={OUTCOME_WORD[r.outcome]} />
        {r.kind === 'cancellation' ? <Fig label="Customer charge" value={inr(r.customerChargePaise)} num /> : null}
        {r.outcome !== 'charge_only' ? <Fig label={r.outcome === 'keep_credit' ? 'Kept as credit' : 'To pay back'} value={inr(r.amountPaise)} num strong /> : null}
        <Fig label="Money held when asked" value={inr(r.heldAtRequestPaise)} num />
        {r.outcome === 'payout' ? (
          <Fig
            label="Pay to"
            value={`${r.payeeName ?? 'Not named'}${r.payeeKind === 'original_payer' ? ' (the person who paid)' : r.payeeKind === 'other' ? ' (someone else)' : ''}`}
          />
        ) : null}
      </dl>
      {r.payeeKind === 'other' && r.payeeReason ? (
        <p className="m-0 text-sm text-copy">
          <span className="font-semibold text-ink">Why someone else: </span>
          {r.payeeReason}
        </p>
      ) : null}
      <p className="m-0 text-sm text-copy">
        <span className="font-semibold text-ink">Reason: </span>
        {r.reason}
      </p>
      {r.useKeptCredit ? <p className="m-0 text-sm text-copy">Paid from the customer credit kept earlier on this Deal.</p> : null}
      {viewer !== 'accounts' && (r.warnings ?? []).includes('charge_below_costs_kept') ? (
        <p className="m-0 text-sm font-medium text-ink">
          <span className="font-semibold">Check: </span>The customer charge is below what suppliers and airlines kept.
        </p>
      ) : null}

      <ol className="m-0 flex list-none flex-col gap-1 border-l-2 border-line p-0 pl-3 text-sm text-copy" aria-label={`History of refund ${r.refNo}`}>
        <li>
          Asked {whenText(r.requestedAt)}
          {r.requestedByName ? ` by ${r.requestedByName}` : ''}
          {r.requestedAs === 'manager' ? ' (branch Manager, no Sales owner)' : ''}.
        </li>
        {r.decidedAt ? (
          <li>
            {r.status === 'returned' ? 'Returned' : 'Approved'} {whenText(r.decidedAt)}
            {r.decidedByName ? ` by ${r.decidedByName}` : ''}
            {r.returnReason ? ` — ${r.returnReason}` : ''}.
          </li>
        ) : null}
        {r.payout ? (
          <li>
            Paid {dayText(r.payout.paidOn)} by {PAYOUT_MODE_WORD[r.payout.mode]}
            {r.payout.reference ? ` (ref ${r.payout.reference})` : ''}
            {r.payout.recordedByName ? `, recorded and verified by ${r.payout.recordedByName}` : ''}.
            {r.payout.evidenceId ? (
              <>
                {' '}
                <a href={`/app/accounts/refunds/evidence/${r.payout.evidenceId}`} className="font-semibold text-brand-strong underline underline-offset-4" target="_blank" rel="noopener">
                  Open the proof<span className="sr-only"> of refund {r.refNo} (opens in a new tab)</span>
                </a>
              </>
            ) : null}
          </li>
        ) : null}
        {r.withdrawnAt ? (
          <li>
            Withdrawn {whenText(r.withdrawnAt)}
            {r.withdrawnByName ? ` by ${r.withdrawnByName}` : ''}
            {r.withdrawReason ? ` — ${r.withdrawReason}` : ''}.
          </li>
        ) : null}
        {r.creditNote && (viewer === 'accounts' || ['released', 'replaced', 'cancelled'].includes(r.creditNote.status)) ? (
          <li className="flex items-center gap-1">
            <FileCheck2 aria-hidden="true" className="size-3.5" />
            {r.creditNote.number ? `Credit Note ${r.creditNote.number}` : 'Credit Note'} —{' '}
            {(DOCUMENT_STATUS_WORDS as Record<string, string>)[r.creditNote.status] ?? r.creditNote.status}.
          </li>
        ) : null}
      </ol>

      {actions ? (
        <div className="flex flex-wrap items-start gap-2">
          {r.can.approve ? (
            <DialogAction
              buttonLabel={r.outcome === 'charge_only' ? `Approve charge ${inr(r.customerChargePaise)}` : `Approve ${inr(r.amountPaise)} ${r.outcome === 'keep_credit' ? 'credit' : 'refund'}${r.kind === 'cancellation' ? ` (charge ${inr(r.customerChargePaise)})` : ''}`}
              buttonVariant="primary"
              blockedReason={off}
              title={`Approve refund ${r.refNo}?`}
              description={`You approve exactly: ${amountWords}, ${OUTCOME_WORD[r.outcome].toLowerCase()}. If the amounts change meanwhile, nothing is approved and you are asked to look again.`}
              primaryLabel="Approve"
              pendingLabel="Approving…"
              action={actions.decide}
              fields={{ ...base, decision: 'approve', expectedAmountPaise: r.amountPaise, expectedChargePaise: r.customerChargePaise }}
              okTitle="Approved"
              initialOpen={!!o('approve')}
              initialState={o('approve')?.state}
            />
          ) : null}
          {r.can.return ? (
            <DialogAction
              buttonLabel="Return with reason"
              ariaLabel={`Return with reason refund ${r.refNo}`}
              blockedReason={off}
              title={`Return refund ${r.refNo} to the requester?`}
              description="The requester can change it and send it again, or withdraw it."
              primaryLabel="Return it"
              pendingLabel="Returning…"
              action={actions.decide}
              fields={{ ...base, decision: 'return', expectedAmountPaise: r.amountPaise, expectedChargePaise: r.customerChargePaise }}
              okTitle="Returned"
              initialOpen={!!o('return')}
              initialState={o('return')?.state}
            >
              <ReasonField id={`return-${r.id}`} label="What needs to change" />
            </DialogAction>
          ) : null}
          {r.can.payout ? (
            <DialogAction
              buttonLabel={`Pay out and verify ${r.refNo}`}
              buttonVariant="primary"
              blockedReason={off}
              title={`Pay out and verify ${r.refNo}`}
              description={`Record the ${inr(r.amountPaise)} paid to ${r.payeeName ?? 'the payee'}. You record and verify it in one step; the journal entry is posted at once. You cannot pay out a refund you asked for or approved.`}
              primaryLabel={`Pay out and verify ${inr(r.amountPaise)}`}
              pendingLabel="Recording…"
              action={actions.payOut}
              fields={base}
              okTitle="Paid out"
              initialOpen={!!o('payout')}
              initialState={o('payout')?.state}
            >
              <PayoutFields today={today} approvedOn={r.decidedAt ? r.decidedAt.slice(0, 10) : null} />
            </DialogAction>
          ) : null}
          {r.can.resubmit ? (
            <DialogAction
              buttonLabel="Change and send again"
              ariaLabel={`Change and send again refund ${r.refNo}`}
              buttonVariant="primary"
              blockedReason={off}
              title={`Change refund ${r.refNo}`}
              description="Fix what the Manager asked for, then send it again for approval."
              primaryLabel="Send again"
              pendingLabel="Sending…"
              action={actions.resubmit}
              fields={base}
              okTitle="Sent again"
              initialOpen={!!o('resubmit')}
              initialState={o('resubmit')?.state}
            >
              <RefundRequestFields
                keptCreditUnusedPaise={deal.keptCreditUnusedPaise}
                approvedChargePaise={deal.approvedChargePaise}
                heldPaise={deal.heldPaise}
                basisTotalPaise={deal.basisTotalPaise}
                cancellationApproved={deal.cancellation?.status === 'approved'}
                payers={deal.payers}
                defaults={{ useKeptCredit: r.useKeptCredit, kind: r.kind, outcome: r.outcome, customerChargePaise: r.customerChargePaise, amountPaise: r.amountPaise, payeeKind: r.payeeKind, payeeReceiptId: r.payeeReceiptId, payeeName: r.payeeKind === 'other' ? r.payeeName : null, payeeReason: r.payeeReason, reason: r.reason }}
              />
            </DialogAction>
          ) : null}
          {r.can.withdraw ? (
            <DialogAction
              buttonLabel="Withdraw"
              ariaLabel={`Withdraw refund ${r.refNo}`}
              buttonVariant="ghost"
              title={`Withdraw refund ${r.refNo}?`}
              description="It stays in the history as withdrawn. A new request can be made afterwards."
              primaryLabel="Withdraw the refund"
              pendingLabel="Withdrawing…"
              danger
              cancelLabel="Keep it"
              action={actions.withdraw}
              fields={base}
              okTitle="Withdrawn"
              initialOpen={!!o('withdraw')}
              initialState={o('withdraw')?.state}
            >
              <ReasonField id={`withdraw-${r.id}`} label="Why it is withdrawn" />
            </DialogAction>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function Fig({ label, value, num, strong }: { label: string; value: string; num?: boolean; strong?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-sm text-quiet">{label}</dt>
      <dd className={`m-0 wrap-anywhere ${num ? 'tabular-nums' : ''} ${strong ? 'font-semibold text-ink' : 'text-ink'}`}>{value}</dd>
    </div>
  );
}
