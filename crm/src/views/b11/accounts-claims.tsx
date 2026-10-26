'use client';

import { Inbox } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { HandForm } from '@/components/hand-form';
import { StatusBadge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn, focusRing } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Tabs } from '@/components/ui/tabs';
import {
  CLAIM_ACTION_BLOCK_TEXT,
  CLAIM_TEXT,
  type AccountsClaimsFilter,
  type AccountsClaimsPage,
  type AccountsClaimView,
  type AccountsDealDetail,
  type DestinationOption,
} from '@/modules/finance/contracts';
import { RecordReceiptForm, type FinanceAction } from '../finance-forms';
import { CLAIM_TONE } from './book-claims';
import { CLAIM_STATUS_ACCOUNTS_LABEL, RECEIPT_MODE_TEXT, dateText, inr } from './book-fields';
import { AreaField, SelectField, problemFor } from './controls';
import { newRequestId, PendingButton, refusedFields, ResultBox, useB11Action } from './form-kit';

/*
 * Accounts side of reported payments (B1.1b): the claims section on the
 * Accounts deal page and the claims list (/app/accounts/claims). A claim is
 * never money; Accounts records the real receipt from it (the existing
 * receipt form, prefilled), links a receipt already recorded, or says the
 * money was not found. A different Accounts person verifies the receipt.
 */

export interface ClaimActions {
  record: FinanceAction;
  link: FinanceAction;
  notReceived: FinanceAction;
}

export function AccountsClaimStatus({ status }: { status: AccountsClaimView['displayStatus'] }) {
  return (
    <StatusBadge tone={CLAIM_TONE[status]} wrap>
      <span className="sr-only">Claim status: </span>
      {CLAIM_STATUS_ACCOUNTS_LABEL[status]}
    </StatusBadge>
  );
}

export function AccountsClaimsSection({
  detail,
  actions,
  destinationOptions = [],
  destinationOptionsUnavailable = false,
  openClaimId,
}: {
  detail: AccountsDealDetail;
  actions: ClaimActions;
  destinationOptions?: DestinationOption[];
  destinationOptionsUnavailable?: boolean;
  /** Preview gallery: start with this claim's record form open. */
  openClaimId?: string;
}) {
  const claims = detail.claims ?? [];
  return (
    <section aria-labelledby="fin-claims-heading" className="rounded-card border border-line bg-card px-4.5 py-4 font-sans text-base text-copy shadow-card">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="fin-claims-heading" className="m-0 text-lg font-semibold text-ink">
          Reported payments
        </h2>
        {detail.claimsReportedPaise && detail.claimsReportedPaise !== '0' ? (
          <span className="text-sm text-quiet">
            {CLAIM_TEXT.reportedNotMoney}: <span className="font-semibold text-ink tabular-nums">{inr(detail.claimsReportedPaise)}</span>
          </span>
        ) : null}
      </div>
      <Notice tone="info" className="mb-4">
        <p>{CLAIM_TEXT.accountsCallout}</p>
        <p>Existing receipt rules apply unchanged: cash limits, cheque clearance, approved company accounts and the maximum receipt.</p>
      </Notice>
      {claims.length === 0 ? (
        <p className="m-0 text-quiet">No payments reported by Sales for this deal.</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-4 p-0" aria-label="Claims, newest first">
          {claims.map((c) => (
            <li key={c.claimId} id={`claim-${c.claimId}`} className="m-0">
              <ClaimCard claim={c} detail={detail} actions={actions} destinationOptions={destinationOptions} destinationOptionsUnavailable={destinationOptionsUnavailable} startOpen={openClaimId === c.claimId} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ClaimCard({
  claim,
  detail,
  actions,
  destinationOptions,
  destinationOptionsUnavailable,
  startOpen,
}: {
  claim: AccountsClaimView;
  detail: AccountsDealDetail;
  actions: ClaimActions;
  destinationOptions: DestinationOption[];
  destinationOptionsUnavailable: boolean;
  startOpen: boolean;
}) {
  const [panel, setPanel] = useState<'record' | 'link' | 'not_received' | null>(startOpen ? 'record' : null);
  const linkable = detail.receipts.filter((r) => claim.possibleReceiptIds.includes(r.receiptId));
  const blocks = claim.actions;
  const open = claim.status === 'reported';
  return (
    <article aria-label={`Claim of ${inr(claim.amountPaise)} reported ${dateText(claim.reportedAt)}`} className="flex flex-col gap-3 rounded-control border border-line bg-canvas px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="m-0 text-base font-semibold text-ink tabular-nums">
          {inr(claim.amountPaise)} · {RECEIPT_MODE_TEXT[claim.mode]}
        </p>
        <AccountsClaimStatus status={claim.displayStatus} />
      </div>
      <SummaryList>
        <SummaryRow label="Paid on, by">
          {dateText(claim.paidOn)} · {claim.payerName}
        </SummaryRow>
        {claim.reference ? <SummaryRow label="Reference">{claim.reference}</SummaryRow> : null}
        {claim.chequeNumber ? (
          <SummaryRow label="Cheque">
            {claim.chequeNumber}
            {claim.chequeDate ? ` dated ${dateText(claim.chequeDate)}` : ''}
          </SummaryRow>
        ) : null}
        {claim.destination ? (
          <SummaryRow label="Into company account">
            {claim.destination.label}
            {claim.destination.isCurrent ? '' : ' (no longer in use)'}
          </SummaryRow>
        ) : null}
        <SummaryRow label="Reported">
          {claim.reportedByName ?? 'Sales'} · {dateText(claim.reportedAt)} · booking version {claim.bookingVersionNo}
        </SummaryRow>
        {claim.note ? <SummaryRow label="Note from Sales">{claim.note}</SummaryRow> : null}
        {claim.linkedReceiptNo ? (
          <SummaryRow label="Receipt">
            {claim.linkedReceiptNo} · {claim.linkKind === 'recorded_from_claim' ? 'recorded from this claim' : 'existing receipt linked'}
            {claim.linkedByName ? ` by ${claim.linkedByName}` : ''}
            {claim.linkReason ? ` · reason: ${claim.linkReason}` : ''}
          </SummaryRow>
        ) : null}
        {claim.closedReason ? (
          <SummaryRow label={claim.status === 'withdrawn' ? 'Withdrawn by Sales' : 'Money not found'}>
            {claim.closedReason}
            {claim.closedByName ? ` · ${claim.closedByName}` : ''}
          </SummaryRow>
        ) : null}
      </SummaryList>

      {open ? (
        <>
          <div className="flex flex-wrap gap-2" role="group" aria-label="What to do with this claim">
            {blocks.recordReceipt ? null : (
              <Button variant={panel === 'record' ? 'primary' : 'secondary'} aria-expanded={panel === 'record'} onClick={() => setPanel(panel === 'record' ? null : 'record')}>
                {CLAIM_TEXT.recordLabel}
              </Button>
            )}
            {blocks.linkReceipt || linkable.length === 0 ? null : (
              <Button variant={panel === 'link' ? 'primary' : 'secondary'} aria-expanded={panel === 'link'} onClick={() => setPanel(panel === 'link' ? null : 'link')}>
                {CLAIM_TEXT.linkLabel}
              </Button>
            )}
            {blocks.markNotReceived ? null : (
              <Button variant="ghost" aria-expanded={panel === 'not_received'} onClick={() => setPanel(panel === 'not_received' ? null : 'not_received')}>
                {CLAIM_TEXT.notReceivedLabel}
              </Button>
            )}
          </div>
          {[blocks.recordReceipt, blocks.linkReceipt, blocks.markNotReceived].filter(Boolean).length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm text-quiet">
              {[...new Set([blocks.recordReceipt, blocks.linkReceipt, blocks.markNotReceived].filter((b): b is NonNullable<typeof b> => Boolean(b)))].map((b) => (
                <li key={b}>{CLAIM_ACTION_BLOCK_TEXT[b]}</li>
              ))}
            </ul>
          ) : null}
          {panel === 'record' ? (
            <div className="rounded-control border border-line bg-card px-3.5 py-3">
              <RecordReceiptForm detail={detail} action={actions.record} fromClaim={claim} idPrefix={`claim-${claim.claimId}`} destinationOptions={destinationOptions} destinationOptionsUnavailable={destinationOptionsUnavailable} />
            </div>
          ) : null}
          {panel === 'link' ? <LinkReceiptForm claim={claim} receipts={linkable} action={actions.link} /> : null}
          {panel === 'not_received' ? <NotReceivedForm claim={claim} action={actions.notReceived} /> : null}
        </>
      ) : null}
    </article>
  );
}

function LinkReceiptForm({ claim, receipts, action }: { claim: AccountsClaimView; receipts: AccountsDealDetail['receipts']; action: FinanceAction }) {
  const [receiptId, setReceiptId] = useState(receipts[0]?.receiptId ?? '');
  const [reason, setReason] = useState('');
  const [requestId] = useState(() => newRequestId());
  const [state, formAction] = useB11Action(action);
  const chosen = receipts.find((r) => r.receiptId === receiptId);
  const differs = chosen ? chosen.amountPaise !== claim.amountPaise || chosen.mode !== claim.mode : false;
  const fields = refusedFields(state);
  return (
    <HandForm action={formAction} noValidate aria-label="Link an existing receipt to this claim" className="flex flex-col gap-3 rounded-control border border-line bg-card px-3.5 py-3">
      <ResultBox result={state} successText="Linked to the existing receipt. No new money record was created." />
      <input type="hidden" name="claimId" value={claim.claimId} />
      <input type="hidden" name="requestId" value={requestId} />
      <SelectField
        id={`claim-${claim.claimId}-receipt`}
        name="receiptId"
        label="Receipt on this deal"
        value={receiptId}
        onChange={setReceiptId}
        options={receipts.map((r) => ({ value: r.receiptId, label: `${r.receiptNo} · ${inr(r.amountPaise)} · ${RECEIPT_MODE_TEXT[r.mode]}${r.reference ? ` · ${r.reference}` : ''}` }))}
        error={problemFor(fields, 'receiptId', 'Choose a receipt on this deal that is not linked to another claim.')}
      />
      <AreaField
        id={`claim-${claim.claimId}-link-reason`}
        name="mismatchReason"
        label="Reason for the difference"
        optional={!differs}
        hint={differs ? 'The receipt differs from the claim (amount or mode): 10 to 500 characters.' : 'Only needed when the receipt differs from the claim.'}
        value={reason}
        onChange={setReason}
        rows={2}
        maxLength={500}
        error={problemFor(fields, 'mismatchReason', 'Write 10 to 500 characters about the difference.')}
      />
      <div>
        <PendingButton pendingLabel="Linking…" variant="primary">
          Link this receipt
        </PendingButton>
      </div>
    </HandForm>
  );
}

function NotReceivedForm({ claim, action }: { claim: AccountsClaimView; action: FinanceAction }) {
  const [reason, setReason] = useState('');
  const [requestId] = useState(() => newRequestId());
  const [state, formAction] = useB11Action(action);
  return (
    <form action={formAction} noValidate aria-label="Money not found for this claim" className="flex flex-col gap-3 rounded-control border border-line bg-card px-3.5 py-3">
      <ResultBox result={state} successText="Claim marked “money not found”. Sales sees this status and your reason." />
      <input type="hidden" name="claimId" value={claim.claimId} />
      <input type="hidden" name="requestId" value={requestId} />
      <AreaField
        id={`claim-${claim.claimId}-nf-reason`}
        name="reason"
        label="What did you check?"
        hint={`${CLAIM_TEXT.notReceivedReasonNote} 10 to 500 characters.`}
        value={reason}
        onChange={setReason}
        rows={2}
        maxLength={500}
        error={problemFor(refusedFields(state), 'reason', 'Write 10 to 500 characters.')}
      />
      <div>
        <PendingButton pendingLabel="Saving…" variant="danger">
          Mark money not found
        </PendingButton>
      </div>
    </form>
  );
}

const FILTER_LABEL: Record<AccountsClaimsFilter, string> = {
  reported: 'To process',
  linked: 'Linked to a receipt',
  closed: 'Closed',
  all: 'All',
};

export function AccountsClaimsListView({ page, filter, hrefs, moreHref }: { page: AccountsClaimsPage; filter: AccountsClaimsFilter; hrefs: Record<AccountsClaimsFilter, string>; moreHref: string | null }) {
  return (
    <div className="font-sans text-base text-copy">
      <PageHeader eyebrow="Accounts" title="Reported payments" description={CLAIM_TEXT.accountsCallout} />
      <Tabs label="Claim filters" items={(Object.keys(FILTER_LABEL) as AccountsClaimsFilter[]).map((f) => ({ href: hrefs[f], label: FILTER_LABEL[f], current: f === filter, count: f === filter ? page.totalCount : undefined }))} className="mb-4" />
      {page.items.length === 0 ? (
        <div className="rounded-card border border-line bg-card shadow-card">
          <EmptyState icon={Inbox} title={filter === 'reported' ? 'No claims to process' : 'No claims here'} description={filter === 'reported' ? 'When Sales reports a payment, it appears here for you to record or link the receipt.' : 'Nothing matches this filter.'} headingLevel={2} />
        </div>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-3 p-0" aria-label={`${FILTER_LABEL[filter]}, oldest first`}>
          {page.items.map((c) => (
            <li key={c.claimId} className="m-0 flex flex-col gap-2 rounded-card border border-line bg-card px-4 py-3 shadow-card sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="m-0 font-semibold text-ink">
                  <Link href={`/app/accounts/deals/${c.dealId}?tab=money#claim-${c.claimId}`} className={cn('rounded-chip text-brand-strong underline underline-offset-4 hover:text-brand-deep', focusRing)}>
                    {c.dealReference}
                  </Link>{' '}
                  <span className="font-normal wrap-anywhere text-copy">· {c.dealTitle}</span>
                </p>
                <p className="m-0 text-sm text-copy tabular-nums">
                  {inr(c.amountPaise)} · {RECEIPT_MODE_TEXT[c.mode]} · paid {dateText(c.paidOn)} by {c.payerName}
                  {c.reference ? ` · ${c.reference}` : ''}
                  {c.chequeNumber ? ` · cheque ${c.chequeNumber}` : ''}
                </p>
                <p className="m-0 text-sm text-quiet">
                  {c.branchName} · reported {c.reportedByName ? `by ${c.reportedByName} ` : ''}on {dateText(c.reportedAt)}
                  {c.linkedReceiptNo ? ` · receipt ${c.linkedReceiptNo}` : ''}
                </p>
              </div>
              <AccountsClaimStatus status={c.displayStatus} />
            </li>
          ))}
        </ol>
      )}
      {page.hasMore && moreHref ? (
        <p className="m-0 mt-4">
          <Link href={moreHref} className={buttonVariants({ variant: 'secondary' })}>
            Show more claims
          </Link>
        </p>
      ) : null}
    </div>
  );
}
