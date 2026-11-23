'use client';

import { useState } from 'react';
import { HandForm } from '@/components/hand-form';
import { StatusBadge, type StatusTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Fieldset } from '@/components/ui/fieldset';
import { Notice } from '@/components/ui/notice';
import { NotEntered, SummaryList, SummaryRow } from '@/components/ui/summary-list';
import type { ReceiptMode } from '@/modules/finance/contracts';
import { CLAIM_DISCLAIMER, CLAIM_STATUS_SALES_LABEL, RECEIPT_MODE_TEXT, dateText, inr } from './book-fields';
import { AreaField, MoneyField, SelectField, TextField, problemFor } from './controls';
import { type FieldRef, newRequestId, PendingButton, refusedFields, ResultBox, useB11Action, type UiResult } from './form-kit';
import type { B11Action, ClaimDisplayStatus, SalesClaim, SalesClaims } from './shapes';

/*
 * Reported payments (B1.1b, freeze §3.2 M1): Sales tells Accounts what the
 * customer says they paid, at any time while the Deal has a draft or an
 * accepted version. A report is never money: Accounts records the receipt
 * and a different Accounts person verifies it. Shown on step 5 and on the
 * submitted booking.
 */

export const CLAIM_TONE: Record<ClaimDisplayStatus, StatusTone> = {
  reported: 'warning',
  recorded: 'info',
  verified: 'success',
  pending_clearance: 'info',
  cleared: 'success',
  bounced: 'danger',
  rejected: 'danger',
  reversed: 'danger',
  not_received: 'danger',
  withdrawn: 'neutral',
};

const REPORT_BLOCK_TEXT: Record<string, string> = {
  service_items_disabled: 'Book now is switched off, so payments cannot be reported here yet.',
  deal_not_active: 'This deal is lost or rejected in Bitrix, so new booking work is paused.',
  finance_not_ready: 'Accounts is not set up for this company yet, so payments cannot be reported here.',
  no_booking: 'Save the booking draft first; then you can report a payment.',
};

export function ClaimStatusPill({ status }: { status: ClaimDisplayStatus }) {
  return (
    <StatusBadge tone={CLAIM_TONE[status]} wrap>
      <span className="sr-only">Payment status: </span>
      {CLAIM_STATUS_SALES_LABEL[status]}
    </StatusBadge>
  );
}

export function ClaimsSummary({ claims }: { claims: SalesClaims }) {
  return (
    <SummaryList>
      <SummaryRow label="Final selling total" numeric>
        {inr(claims.sellingTotalPaise) ?? <NotEntered />}
      </SummaryRow>
      <SummaryRow label="Reported, not checked (not money)" numeric>
        {inr(claims.reportedPaise)}
      </SummaryRow>
      <SummaryRow label="Checked by Accounts" numeric>
        {inr(claims.confirmedPaise)}
      </SummaryRow>
      <SummaryRow label="Still to pay (based on checked money)" numeric total>
        {inr(claims.balancePaise) ?? <NotEntered>Not known until the total is entered</NotEntered>}
      </SummaryRow>
    </SummaryList>
  );
}

export function SalesClaimsPanel({
  dealId,
  claims,
  reportAction,
  withdrawAction,
  reportInitialState,
  headingLevel = 3,
}: {
  dealId: string;
  claims: SalesClaims | null | undefined;
  reportAction: B11Action;
  withdrawAction: B11Action;
  reportInitialState?: UiResult | null;
  headingLevel?: 2 | 3 | 4;
}) {
  const H = `h${headingLevel}` as const;
  if (claims === undefined || claims === null) {
    return (
      <section aria-labelledby="bk-claims-heading" className="flex flex-col gap-3">
        <H id="bk-claims-heading" className="m-0 text-lg font-semibold text-ink">
          Payments the customer told you about
        </H>
        <Notice tone="locked">Reported payments are not available here yet. Tell Accounts directly until they are.</Notice>
      </section>
    );
  }
  return (
    <section aria-labelledby="bk-claims-heading" className="flex flex-col gap-4">
      <H id="bk-claims-heading" className="m-0 text-lg font-semibold text-ink">
        Payments the customer told you about
      </H>
      <Notice tone="info">
        <p>{CLAIM_DISCLAIMER}</p>
        <p>No advance is required. A Bitrix stage does not prove payment.</p>
      </Notice>
      <ClaimsSummary claims={claims} />
      {claims.claims.length === 0 ? (
        <p className="m-0 text-quiet">No payment reported yet.</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-3 p-0" aria-label="Reported payments, newest first">
          {claims.claims.map((c) => (
            <li key={c.claimId} className="m-0">
              <ClaimRow claim={c} withdrawAction={withdrawAction} />
            </li>
          ))}
        </ol>
      )}
      {claims.canReport ? (
        <ReportClaimForm dealId={dealId} claims={claims} action={reportAction} initialState={reportInitialState} />
      ) : claims.reportBlock ? (
        <Notice tone="locked">{REPORT_BLOCK_TEXT[claims.reportBlock] ?? 'Payments cannot be reported right now.'}</Notice>
      ) : null}
    </section>
  );
}

function ClaimRow({ claim, withdrawAction }: { claim: SalesClaim; withdrawAction: B11Action }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [requestId] = useState(() => newRequestId());
  const [state, formAction] = useB11Action(withdrawAction, {});
  return (
    <article className="flex flex-col gap-2 rounded-card border border-line bg-card px-4 py-3" aria-label={`Payment of ${inr(claim.amountPaise)} on ${dateText(claim.paidOn)}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 text-base font-semibold text-ink tabular-nums">
          {inr(claim.amountPaise)} · {RECEIPT_MODE_TEXT[claim.mode]}
        </p>
        <ClaimStatusPill status={claim.displayStatus} />
      </div>
      <p className="m-0 text-sm text-copy">
        Paid on {dateText(claim.paidOn)} by {claim.payerName}
        {claim.reference ? ` · reference ${claim.reference}` : ''}
        {claim.chequeNumber ? ` · cheque ${claim.chequeNumber}${claim.chequeDate ? ` dated ${dateText(claim.chequeDate)}` : ''}` : ''}
        {claim.destinationLabel ? ` · into ${claim.destinationLabel}` : ''}
      </p>
      <p className="m-0 text-sm text-quiet">
        Reported{claim.reportedByName ? ` by ${claim.reportedByName}` : ''} on {dateText(claim.reportedAt)}
        {claim.receiptAmountPaise && claim.receiptAmountPaise !== claim.amountPaise ? ` · Accounts recorded ${inr(claim.receiptAmountPaise)}` : ''}
      </p>
      {claim.notReceivedReason ? <p className="m-0 text-sm text-copy">Accounts: {claim.notReceivedReason}</p> : null}
      {claim.canWithdraw ? (
        <form action={formAction} noValidate className="flex flex-col gap-2">
          <ResultBox result={state} successText="Report withdrawn." />
          <input type="hidden" name="claimId" value={claim.claimId} />
          <input type="hidden" name="rowVersion" value={claim.rowVersion} />
          <input type="hidden" name="requestId" value={requestId} />
          {open ? (
            <>
              <AreaField
                id={`bk-claim-${claim.claimId}-reason`}
                name="reason"
                label="Why are you withdrawing this report?"
                hint="10 to 500 characters. Accounts sees it."
                value={reason}
                onChange={setReason}
                rows={2}
                maxLength={500}
                error={problemFor(refusedFields(state), 'reason', 'Write 10 to 500 characters.')}
              />
              <div className="flex flex-wrap gap-2">
                <PendingButton pendingLabel="Withdrawing…" variant="secondary">
                  Withdraw report
                </PendingButton>
                <Button variant="ghost" onClick={() => setOpen(false)}>
                  Keep it
                </Button>
              </div>
            </>
          ) : (
            <div>
              <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
                Withdraw this report
              </Button>
            </div>
          )}
        </form>
      ) : null}
    </article>
  );
}

const MODES: ReceiptMode[] = ['bank_transfer', 'upi', 'cash', 'cheque'];

function ReportClaimForm({ dealId, claims, action, initialState }: { dealId: string; claims: SalesClaims; action: B11Action; initialState?: UiResult | null }) {
  const blank = { mode: 'bank_transfer' as ReceiptMode, amount: '', paidOn: '', payer: '', reference: '', destination: '', chequeNumber: '', chequeDate: '', note: '' };
  const [v, setV] = useState(blank);
  const [requestId, setRequestId] = useState(() => newRequestId());
  const [state, formAction] = useB11Action(action, {
    initialState,
    onSuccess: () => {
      setV(blank);
      setRequestId(newRequestId());
    },
  });
  const fields = refusedFields(state);
  const refs: FieldRef[] = [
    { field: 'claimMode', id: 'bk-claim-mode', label: 'How they paid' },
    { field: 'claimAmountRupees', id: 'bk-claim-amount', label: 'Amount: rupees, not more than the final total' },
    { field: 'claimPaidOn', id: 'bk-claim-paid-on', label: 'Paid on: today or earlier (up to a year back)' },
    { field: 'claimPayerName', id: 'bk-claim-payer', label: 'Paid by' },
    { field: 'claimReference', id: 'bk-claim-reference', label: 'Reference or UTR: 6 to 40 letters, digits, / or -' },
    { field: 'claimDestinationVersionId', id: 'bk-claim-destination', label: 'Company account that received it' },
    { field: 'claimChequeNumber', id: 'bk-claim-cheque-number', label: 'Cheque number: 6 digits' },
    { field: 'claimChequeDate', id: 'bk-claim-cheque-date', label: 'Cheque date: within 90 days of today' },
    { field: 'claimNote', id: 'bk-claim-note', label: 'Note: up to 500 characters' },
  ];
  const err = (name: string) => problemFor(fields, name, refs.find((r) => r.field === name)?.label ?? 'Check this field.');
  const electronic = v.mode === 'bank_transfer' || v.mode === 'upi';
  const destinations = claims.destinations.filter((d) => (v.mode === 'upi' ? d.kind === 'upi' : d.kind === 'bank'));
  return (
    <HandForm action={formAction} noValidate aria-labelledby="bk-claim-form-heading" className="flex flex-col gap-3">
      <h4 id="bk-claim-form-heading" className="m-0 text-base font-semibold text-ink">
        Tell Accounts about a payment
      </h4>
      <ResultBox result={state} fields={refs} successText="Sent to Accounts. It is not money until Accounts checks it." />
      <input type="hidden" name="dealId" value={dealId} />
      <input type="hidden" name="requestId" value={requestId} />
      <Fieldset legend="What the customer says they paid" columns={2}>
        <SelectField id="bk-claim-mode" name="claimMode" label="How they paid" value={v.mode} onChange={(x) => setV({ ...v, mode: x as ReceiptMode })} options={MODES.map((m) => ({ value: m, label: RECEIPT_MODE_TEXT[m] }))} error={err('claimMode')} />
        <MoneyField id="bk-claim-amount" name="claimAmountRupees" label="Amount ₹" value={v.amount} onChange={(x) => setV({ ...v, amount: x })} error={err('claimAmountRupees')} />
        <TextField id="bk-claim-paid-on" name="claimPaidOn" label="Paid on" type="date" value={v.paidOn} onChange={(x) => setV({ ...v, paidOn: x })} error={err('claimPaidOn')} />
        <TextField id="bk-claim-payer" name="claimPayerName" label="Paid by" value={v.payer} onChange={(x) => setV({ ...v, payer: x })} error={err('claimPayerName')} maxLength={200} />
        {electronic ? (
          <>
            <TextField id="bk-claim-reference" name="claimReference" label="Reference or UTR" hint="Identifies the payment. It is not proof that money arrived." value={v.reference} onChange={(x) => setV({ ...v, reference: x })} error={err('claimReference')} maxLength={40} />
            <SelectField
              id="bk-claim-destination"
              name="claimDestinationVersionId"
              label="Company account that received it"
              value={v.destination}
              onChange={(x) => setV({ ...v, destination: x })}
              options={[{ value: '', label: destinations.length === 0 ? 'No approved account for this mode' : 'Choose the account' }, ...destinations.map((d) => ({ value: d.versionId, label: d.label }))]}
              error={err('claimDestinationVersionId')}
            />
          </>
        ) : null}
        {v.mode === 'cheque' ? (
          <>
            <TextField id="bk-claim-cheque-number" name="claimChequeNumber" label="Cheque number" inputMode="numeric" value={v.chequeNumber} onChange={(x) => setV({ ...v, chequeNumber: x })} error={err('claimChequeNumber')} maxLength={6} />
            <TextField id="bk-claim-cheque-date" name="claimChequeDate" label="Cheque date" type="date" value={v.chequeDate} onChange={(x) => setV({ ...v, chequeDate: x })} error={err('claimChequeDate')} />
          </>
        ) : null}
        <AreaField id="bk-claim-note" name="claimNote" label="Note for Accounts" optional className="sm:col-span-2" value={v.note} onChange={(x) => setV({ ...v, note: x })} error={err('claimNote')} rows={2} maxLength={500} />
      </Fieldset>
      {v.mode === 'cash' ? <Notice tone="warning">Accounts cannot accept cash above the daily limit per payer.</Notice> : null}
      {v.mode === 'cheque' ? <Notice tone="info">A cheque counts only after the bank clears it.</Notice> : null}
      <div>
        <PendingButton pendingLabel="Sending…" variant="secondary">
          Send to Accounts
        </PendingButton>
      </div>
    </HandForm>
  );
}
