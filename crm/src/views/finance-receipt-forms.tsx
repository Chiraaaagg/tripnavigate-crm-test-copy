'use client';

import { Plus } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useState } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useHandFormStatus } from '@/components/hand-form';
import { SubmitButton } from '@/components/SubmitButton';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Drawer, DrawerBody, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer';
import {
  ACTION_BLOCK_TEXT,
  type ActionBlock,
  type AccountsClaimView,
  type AccountsDealDetail,
  type BillingProfileView,
  type BookingReviewView,
  type DestinationKind,
  destinationKindForMode,
  type DestinationOption,
  type FinanceEvidenceKind,
  RECEIPT_MODE_LABEL,
  RECEIPT_MODES,
  type ReceiptAction,
  type ReceiptMode,
  type ReceiptView,
} from '@/modules/finance/contracts';
import { BlockedReason, blockText, EVIDENCE_KIND_LABEL, formatInr, isZero, maskedDestination, paiseToRupeesField, verifyButtonId } from './finance-common';
import {
  ACCEPT,
  Field,
  FILE_HINT,
  FIN_FIELD,
  type FinanceAction,
  type FinanceActions,
  type FinanceFormState,
  FinanceResult,
  RequestId,
  UnavailableButton,
  useFinanceForm,
} from './finance-policy-forms';

/*
 * Receipt-side Accounts forms of a Deal: billing details, booking review,
 * recording a receipt, receipt actions and evidence upload. Shared plumbing
 * is in finance-policy-forms.tsx.
 */

// ---------------------------------------------------------------------------
// Billing details
// ---------------------------------------------------------------------------

export function BillingForm({ dealId, billing, action }: { dealId: string; billing: BillingProfileView | null; action: FinanceAction }) {
  const f = useFinanceForm(action);
  const b = billing;
  // Booking form Bill To (Echo M2): shown when the database sends it (absent on an older database).
  const withBillTo = !b || b.billToType !== undefined;
  const [type, setType] = useState<'personal' | 'business'>(() => (f.v(FIN_FIELD.billToType, b?.billToType ?? (b?.gstin ? 'business' : 'personal')) === 'business' ? 'business' : 'personal'));
  const [gst, setGst] = useState<string>(() => f.v(FIN_FIELD.gstStatus, b?.gstStatus ?? (b?.gstin ? 'registered' : '')));
  return (
    <form key={f.formKey} action={f.formAction} noValidate aria-label="Customer billing details">
      <FinanceResult state={f.state} />
      <RequestId id={f.requestId} />
      <input type="hidden" name={FIN_FIELD.dealId} value={dealId} />
      <input type="hidden" name={FIN_FIELD.expectedRowVersion} value={b?.rowVersion ?? 0} />
      <div className="form-grid">
        {withBillTo ? (
          <Field label="Bill To type" error={f.err(FIN_FIELD.billToType)}>
            {(p) => (
              <select {...p} name={FIN_FIELD.billToType} value={type} onChange={(e) => setType(e.target.value === 'business' ? 'business' : 'personal')}>
                <option value="personal">Personal</option>
                <option value="business">Business</option>
              </select>
            )}
          </Field>
        ) : null}
        <Field label={withBillTo && type === 'business' ? 'Company name' : 'Billing name'} error={f.err(FIN_FIELD.billingName)} wide>
          {(p) => <input {...p} name={FIN_FIELD.billingName} defaultValue={f.v(FIN_FIELD.billingName, b?.billingName)} maxLength={200} autoComplete="off" required />}
        </Field>
        <Field label="Address line 1" error={f.err(FIN_FIELD.addressLine1)}>
          {(p) => <input {...p} name={FIN_FIELD.addressLine1} defaultValue={f.v(FIN_FIELD.addressLine1, b?.addressLine1)} maxLength={200} autoComplete="off" required />}
        </Field>
        <Field label="Address line 2 (optional)" error={f.err(FIN_FIELD.addressLine2)}>
          {(p) => <input {...p} name={FIN_FIELD.addressLine2} defaultValue={f.v(FIN_FIELD.addressLine2, b?.addressLine2 ?? '')} maxLength={200} autoComplete="off" />}
        </Field>
        <Field label="City" error={f.err(FIN_FIELD.city)}>
          {(p) => <input {...p} name={FIN_FIELD.city} defaultValue={f.v(FIN_FIELD.city, b?.city)} maxLength={120} autoComplete="off" required />}
        </Field>
        <Field label="State code" hint="Two digits, 01 to 38, or 97 for other territory." error={f.err(FIN_FIELD.stateCode)}>
          {(p) => <input {...p} name={FIN_FIELD.stateCode} defaultValue={f.v(FIN_FIELD.stateCode, b?.stateCode)} inputMode="numeric" maxLength={2} autoComplete="off" required />}
        </Field>
        <Field label="PIN code" error={f.err(FIN_FIELD.postalCode)}>
          {(p) => <input {...p} name={FIN_FIELD.postalCode} defaultValue={f.v(FIN_FIELD.postalCode, b?.postalCode)} inputMode="numeric" maxLength={6} autoComplete="off" required />}
        </Field>
        {withBillTo ? (
          <>
            {type === 'business' ? (
              <Field label="Contact name" error={f.err(FIN_FIELD.contactPerson)}>
                {(p) => <input {...p} name={FIN_FIELD.contactPerson} defaultValue={f.v(FIN_FIELD.contactPerson, b?.contactPerson ?? '')} maxLength={120} autoComplete="off" />}
              </Field>
            ) : null}
            <Field label="Phone (optional)" error={f.err(FIN_FIELD.billingPhone)}>
              {(p) => <input {...p} name={FIN_FIELD.billingPhone} type="tel" defaultValue={f.v(FIN_FIELD.billingPhone, b?.phone ?? '')} maxLength={16} autoComplete="off" />}
            </Field>
            <Field label="Email (optional)" error={f.err(FIN_FIELD.billingEmail)}>
              {(p) => <input {...p} name={FIN_FIELD.billingEmail} type="email" defaultValue={f.v(FIN_FIELD.billingEmail, b?.email ?? '')} maxLength={254} autoComplete="off" />}
            </Field>
            {type === 'business' ? (
              <Field label="GST registration" error={f.err(FIN_FIELD.gstStatus)}>
                {(p) => (
                  <select {...p} name={FIN_FIELD.gstStatus} value={gst} onChange={(e) => setGst(e.target.value)}>
                    <option value="">Choose</option>
                    <option value="registered">GST registered</option>
                    <option value="unregistered">Not GST registered</option>
                  </select>
                )}
              </Field>
            ) : null}
          </>
        ) : null}
        {!withBillTo || (type === 'business' && gst === 'registered') ? (
          <Field label={withBillTo ? 'GSTIN' : 'GSTIN (optional)'} hint="Its first two digits must match the state code. The CRM checks the format only." error={f.err(FIN_FIELD.gstin)}>
            {(p) => (
              <input {...p} name={FIN_FIELD.gstin} defaultValue={f.v(FIN_FIELD.gstin, b?.gstin ?? '')} maxLength={15} autoCapitalize="characters" spellCheck={false} autoComplete="off" />
            )}
          </Field>
        ) : (
          <input type="hidden" name={FIN_FIELD.gstin} value="" />
        )}
        {withBillTo && type === 'business' && gst === 'unregistered' ? (
          <Field label="Reason for no GSTIN" hint="10 to 500 characters." error={f.err(FIN_FIELD.gstReason)} wide>
            {(p) => <textarea {...p} name={FIN_FIELD.gstReason} defaultValue={f.v(FIN_FIELD.gstReason, b?.gstReason ?? '')} maxLength={500} rows={2} />}
          </Field>
        ) : null}
      </div>
      <p id="billing-save-help" className="hint">
        Saving keeps the details as not checked. If Accounts had already approved the booking review, saving puts the review back to waiting.
      </p>
      <SubmitButton pendingLabel="Saving…" variant="secondary" describedBy="billing-save-help">
        Save billing details
      </SubmitButton>
    </form>
  );
}

export function VerifyBillingForm({ dealId, rowVersion, action }: { dealId: string; rowVersion: number; action: FinanceAction }) {
  const f = useFinanceForm(action);
  return (
    <form key={f.formKey} action={f.formAction} noValidate aria-label="Check billing details" className="fin-inline-form">
      <RequestId id={f.requestId} />
      <input type="hidden" name={FIN_FIELD.dealId} value={dealId} />
      <input type="hidden" name={FIN_FIELD.expectedRowVersion} value={rowVersion} />
      <p id="billing-verify-help" className="hint mb-0">
        Confirms they match the customer’s documents. Approves no money.
      </p>
      <SubmitButton pendingLabel="Checking…" describedBy="billing-verify-help">
        Check billing details
      </SubmitButton>
      <FinanceResult state={f.state} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Booking review
// ---------------------------------------------------------------------------

/**
 * Approve the booking review (DA-275, lead ruling D8 / plan L4): the button
 * opens a confirmation dialog (native <dialog>: focus trap, Escape, focus
 * back to the button) and the keyed form with the request id and the
 * expected row version sits inside it, so nothing is approved by one click.
 * A refusal reopens the dialog with the reason.
 */
export function ApproveReviewForm({ dealId, booking, action, defaultOpen = false }: { dealId: string; booking: BookingReviewView; action: FinanceAction; defaultOpen?: boolean }) {
  const f = useFinanceForm(action);
  if (!booking.canApprove) {
    return <UnavailableButton label="Approve booking" reason={booking.approveBlock ? blockText(booking.approveBlock) : ACTION_BLOCK_TEXT.wrong_state} />;
  }
  return (
    <div className="fin-inline-form">
      <p id="review-approve-help" className="hint mb-0">
        Records your check. No money, no document, no change to the booking.
      </p>
      <ConfirmDialog
        triggerDescribedBy="review-approve-help"
        triggerLabel="Approve booking"
        title={`Approve booking version ${booking.versionNo}?`}
        cancelLabel="Cancel"
        defaultOpen={defaultOpen || f.state.status === 'error'}
        body={
          <ul>
            <li>Records that you checked this booking version.</li>
            <li>No money is posted and no document is issued.</li>
            <li>The booking itself does not change. Saving billing details later puts the review back to waiting.</li>
          </ul>
        }
        renderActions={(cancel) => (
          <form key={f.formKey} action={f.formAction} noValidate aria-label="Approve booking review">
            <FinanceResult state={f.state} />
            <RequestId id={f.requestId} />
            <input type="hidden" name={FIN_FIELD.dealId} value={dealId} />
            <input type="hidden" name={FIN_FIELD.bookingVersionId} value={booking.bookingVersionId} />
            <input type="hidden" name={FIN_FIELD.expectedRowVersion} value={booking.reviewRowVersion} />
            <div className="dialog-actions">
              {cancel}
              <SubmitButton pendingLabel="Approving…">Yes, approve booking</SubmitButton>
            </div>
          </form>
        )}
      />
    </div>
  );
}

export function ReturnReviewForm({ dealId, booking, action }: { dealId: string; booking: BookingReviewView; action: FinanceAction }) {
  const f = useFinanceForm(action);
  return (
    <details className="form-section work-form" open={f.state.status === 'error' || undefined}>
      <summary>
        <span className="form-section-title">Return to Sales with a reason</span>
      </summary>
      <form key={f.formKey} action={f.formAction} noValidate aria-label="Return booking review">
        <FinanceResult state={f.state} />
        <RequestId id={f.requestId} />
        <input type="hidden" name={FIN_FIELD.dealId} value={dealId} />
        <input type="hidden" name={FIN_FIELD.bookingVersionId} value={booking.bookingVersionId} />
        <div className="note info" role="note">
          <p>Sales sees this reason on the booking in Book now. Write it so Sales knows exactly what to fix.</p>
        </div>
        <Field label="Reason" hint="10 to 500 characters. Say what Sales must fix." error={f.err(FIN_FIELD.reason)} wide>
          {(p) => <textarea {...p} name={FIN_FIELD.reason} defaultValue={f.v(FIN_FIELD.reason)} minLength={10} maxLength={500} rows={3} required />}
        </Field>
        <SubmitButton pendingLabel="Returning…" variant="secondary">
          Return review
        </SubmitButton>
      </form>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Record a receipt
// ---------------------------------------------------------------------------

function modeBlocked(detail: AccountsDealDetail, mode: ReceiptMode): string | null {
  if (!detail.modesAllowed[mode]) return ACTION_BLOCK_TEXT.mode_not_live;
  if (mode === 'cash' && (isZero(detail.policy.cashPayerDayCapPaise) || isZero(detail.policy.cashTripCapPaise))) {
    return 'Cash is switched off by company policy (the cash limit is ₹0). Ask for a bank transfer, UPI or cheque instead.';
  }
  return null;
}

export function RecordReceiptForm({
  detail,
  action,
  correcting = null,
  idPrefix = 'receipt',
  destinationOptions = [],
  destinationOptionsUnavailable = false,
  fromClaim = null,
  form,
}: {
  detail: AccountsDealDetail;
  action: FinanceAction;
  /** Record a correction of this receipt: same deal and mode. */
  correcting?: ReceiptView | null;
  /** B1.1: record the receipt from a Sales claim (prefilled; a difference needs a reason). */
  fromClaim?: AccountsClaimView | null;
  idPrefix?: string;
  /** Approved current company accounts this deal's receipts may select (masked). */
  destinationOptions?: DestinationOption[];
  /** True when the company-accounts read was refused, so the empty list means "unknown", not "none approved". */
  destinationOptionsUnavailable?: boolean;
  /**
   * The form state from a parent that outlives this form (the receipt drawer unmounts its content when it
   * closes). Keeps the request id and the restored values across close and reopen, so a resubmit after an
   * unknown outcome replays instead of recording a second receipt.
   */
  form?: FinanceFormState;
}) {
  const own = useFinanceForm(action);
  const f = form ?? own;
  const firstAllowed = RECEIPT_MODES.find((m) => detail.modesAllowed[m]) ?? 'bank_transfer';
  const [mode, setMode] = useState<ReceiptMode>(correcting?.mode ?? fromClaim?.mode ?? ((f.v(FIN_FIELD.mode) || firstAllowed) as ReceiptMode));
  const current: ReceiptMode = RECEIPT_MODES.includes(mode) ? mode : firstAllowed;
  const destinationKind = destinationKindForMode(current);
  const options = destinationKind ? destinationOptions.filter((o) => o.kind === destinationKind) : [];
  const modeBlock = modeBlocked(detail, current);
  // The destination problem is explained once, next to the selector; here it only disables the button.
  const destinationBlock = !destinationKind ? null : destinationOptionsUnavailable ? DESTINATIONS_UNAVAILABLE_TEXT : options.length === 0 ? NO_DESTINATION_TEXT : null;
  const blocked = modeBlock ?? destinationBlock;
  // After destination_changed the earlier choice is no longer current: never restore it, and never pick a replacement silently.
  const mustChooseAgain = f.state.code === 'destination_changed';
  const restoredDestination = f.v(FIN_FIELD.destinationVersionId, fromClaim?.destination?.isCurrent ? (destinationOptions.find((o) => o.label === fromClaim.destination?.label)?.versionId ?? '') : '');
  const claimDefault = (claimValue: string | null | undefined) => claimValue ?? '';
  const policy = detail.policy;
  const legendId = `${idPrefix}-mode-legend`;
  return (
    <form key={f.formKey} action={f.formAction} noValidate aria-label={correcting ? `Record a correction of ${correcting.receiptNo}` : fromClaim ? 'Record receipt from this claim' : 'Record a receipt'}>
      <FinanceResult state={f.state} />
      <RequestId id={f.requestId} />
      <input type="hidden" name={FIN_FIELD.dealId} value={detail.dealId} />
      {correcting ? <input type="hidden" name={FIN_FIELD.correctsReceiptId} value={correcting.receiptId} /> : null}
      {fromClaim ? <input type="hidden" name="claimId" value={fromClaim.claimId} /> : null}

      {correcting ? (
        <>
          <input type="hidden" name={FIN_FIELD.mode} value={correcting.mode} />
          <p className="hint">
            Correcting <strong>{correcting.receiptNo}</strong> ({RECEIPT_MODE_LABEL[correcting.mode]}). The original stays visible with a link to this correction.
          </p>
        </>
      ) : (
        <fieldset className="group fin-modes" aria-describedby={`${idPrefix}-mode-help`}>
          <legend id={legendId}>How did the customer pay?</legend>
          <span id={`${idPrefix}-mode-help`} className="hint">
            Payment modes are switched on by the CRM team with the owner’s approval, after the CA confirms the rules.
          </span>
          <div className="fin-segment">
            {RECEIPT_MODES.map((m) => (
              <label key={m} className={`fin-segment-option${current === m ? ' is-selected' : ''}`}>
                <input type="radio" name={FIN_FIELD.mode} value={m} checked={current === m} onChange={() => setMode(m)} />
                <span className="fin-segment-label">{RECEIPT_MODE_LABEL[m]}</span>
                <span className={`fin-live${detail.liveModes[m] ? ' is-live' : ''}`}>
                  {detail.liveModes[m] ? 'Available' : detail.modesAllowed[m] ? 'Not available yet · test data only' : 'Not available yet'}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <ul className="fin-limits" aria-label="Company limits for this receipt">
        <li>
          One receipt can be at most <strong>{formatInr(policy.receiptMaxPaise)}</strong>.
        </li>
        {current === 'cash' ? (
          <>
            <li>
              Cash from one payer on one day, across all branches: at most <strong>{formatInr(policy.cashPayerDayCapPaise)}</strong>.
            </li>
            <li>
              Cash for this trip in total: at most <strong>{formatInr(policy.cashTripCapPaise)}</strong>.
            </li>
          </>
        ) : null}
        <li>Policy version {policy.versionNo}.</li>
      </ul>

      {modeBlock ? (
        <div className="note warn" role="note">
          <p>{modeBlock}</p>
        </div>
      ) : null}

      <div className="form-grid">
        <Field label="Amount received (₹)" hint="Rupees, up to two decimals." error={f.err(FIN_FIELD.amountRupees) ?? f.err('amountPaise')}>
          {(p) => <input {...p} name={FIN_FIELD.amountRupees} defaultValue={f.v(FIN_FIELD.amountRupees, correcting ? paiseToRupeesField(correcting.amountPaise) : fromClaim ? paiseToRupeesField(fromClaim.amountPaise) : '')} inputMode="decimal" autoComplete="off" required />}
        </Field>
        <Field label="Date received" hint="Within the last 30 days (IST)." error={f.err(FIN_FIELD.receivedOn)}>
          {(p) => <input {...p} name={FIN_FIELD.receivedOn} type="date" defaultValue={f.v(FIN_FIELD.receivedOn, correcting?.receivedOn ?? claimDefault(fromClaim?.paidOn))} required />}
        </Field>
        <Field label="Collecting branch" error={f.err(FIN_FIELD.branchId)}>
          {(p) => (
            <select {...p} name={FIN_FIELD.branchId} defaultValue={f.v(FIN_FIELD.branchId, detail.branchId)} required>
              {detail.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        {current === 'cash' ? (
          <Field label="Who collected the cash" error={f.err(FIN_FIELD.collectorUserId)}>
            {(p) => (
              <select {...p} name={FIN_FIELD.collectorUserId} defaultValue={f.v(FIN_FIELD.collectorUserId)} required>
                <option value="">Choose a person</option>
                {detail.collectors.map((c) => (
                  <option key={c.userId} value={c.userId}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : null}
      </div>

      <fieldset className="group">
        <legend>Who paid</legend>
        <span className="hint">Payer name plus at least one of PAN or mobile number.</span>
        <div className="form-grid">
          <Field label="Payer name" error={f.err(FIN_FIELD.payerName)}>
            {(p) => <input {...p} name={FIN_FIELD.payerName} defaultValue={f.v(FIN_FIELD.payerName, correcting?.payerName ?? claimDefault(fromClaim?.payerName))} maxLength={200} autoComplete="off" required />}
          </Field>
          <Field label="Payer PAN" hint="For example ABCDE1234F." error={f.err(FIN_FIELD.payerPan)}>
            {(p) => <input {...p} name={FIN_FIELD.payerPan} defaultValue={f.v(FIN_FIELD.payerPan)} maxLength={10} autoCapitalize="characters" spellCheck={false} autoComplete="off" />}
          </Field>
          <Field label="Payer mobile" hint="10 digits; +91 or a leading 0 is fine." error={f.err(FIN_FIELD.payerMobile)}>
            {(p) => <input {...p} name={FIN_FIELD.payerMobile} defaultValue={f.v(FIN_FIELD.payerMobile)} type="tel" inputMode="tel" maxLength={16} autoComplete="off" />}
          </Field>
        </div>
      </fieldset>

      {current === 'bank_transfer' || current === 'upi' ? (
        <Field
          label={current === 'upi' ? 'UPI transaction reference' : 'Bank reference (UTR)'}
          hint="6 to 40 letters, digits, / or -. The same reference cannot be recorded twice."
          error={f.err(FIN_FIELD.reference)}
        >
          {(p) => <input {...p} name={FIN_FIELD.reference} defaultValue={f.v(FIN_FIELD.reference, correcting?.reference ?? claimDefault(fromClaim?.reference))} maxLength={40} spellCheck={false} autoComplete="off" required />}
        </Field>
      ) : null}

      {destinationKind ? (
        <DestinationSelect
          key={destinationKind}
          kind={destinationKind}
          options={options}
          unavailable={destinationOptionsUnavailable}
          mustChooseAgain={mustChooseAgain}
          value={!mustChooseAgain && options.some((o) => o.versionId === restoredDestination) ? restoredDestination : ''}
          error={f.err(FIN_FIELD.destinationVersionId)}
        />
      ) : null}

      {current === 'cheque' ? (
        <fieldset className="group">
          <legend>Cheque details</legend>
          <div className="form-grid">
            <Field label="Cheque number" hint="6 digits." error={f.err(FIN_FIELD.chequeNumber)}>
              {(p) => <input {...p} name={FIN_FIELD.chequeNumber} defaultValue={f.v(FIN_FIELD.chequeNumber, correcting?.chequeNumber ?? claimDefault(fromClaim?.chequeNumber))} inputMode="numeric" maxLength={6} autoComplete="off" required />}
            </Field>
            <Field label="MICR code" hint="9 digits printed at the bottom of the cheque." error={f.err(FIN_FIELD.micrCode)}>
              {(p) => <input {...p} name={FIN_FIELD.micrCode} defaultValue={f.v(FIN_FIELD.micrCode, correcting?.micrCode ?? '')} inputMode="numeric" maxLength={9} autoComplete="off" required />}
            </Field>
            <Field label="Cheque date" hint="Within 90 days before or after today." error={f.err(FIN_FIELD.chequeDate)}>
              {(p) => <input {...p} name={FIN_FIELD.chequeDate} type="date" defaultValue={f.v(FIN_FIELD.chequeDate, correcting?.chequeDate ?? claimDefault(fromClaim?.chequeDate))} required />}
            </Field>
          </div>
          <label className="choice">
            <input type="checkbox" name={FIN_FIELD.accountPayee} value="true" defaultChecked={f.v(FIN_FIELD.accountPayee) === 'true'} required /> The cheque is crossed “Account payee”
          </label>
          {f.err(FIN_FIELD.accountPayee) ? <span className="field-issue">{f.err(FIN_FIELD.accountPayee)}</span> : null}
        </fieldset>
      ) : null}

      {detail.booking ? (
        <Field label="Link to booking" error={f.err(FIN_FIELD.bookingVersionId)}>
          {(p) => (
            <select {...p} name={FIN_FIELD.bookingVersionId} defaultValue={f.v(FIN_FIELD.bookingVersionId, detail.booking!.bookingVersionId)}>
              <option value={detail.booking!.bookingVersionId}>Confirmed booking, version {detail.booking!.versionNo}</option>
              <option value="">Not linked to a booking</option>
            </select>
          )}
        </Field>
      ) : null}

      <Field label="Note (optional)" error={f.err(FIN_FIELD.note)} wide>
        {(p) => <textarea {...p} name={FIN_FIELD.note} defaultValue={f.v(FIN_FIELD.note)} maxLength={500} rows={2} />}
      </Field>

      {fromClaim ? (
        <Field
          label="Reason for any difference from the claim (optional)"
          hint="Needed only when the amount, mode, reference or cheque number differs from what Sales reported: 10 to 500 characters."
          error={f.err('mismatchReason')}
          wide
        >
          {(p) => <textarea {...p} name="mismatchReason" defaultValue={f.v('mismatchReason')} maxLength={500} rows={2} />}
        </Field>
      ) : null}

      <p id={`${idPrefix}-submit-help`} className="hint">
        Another Accounts person must check it before it counts as money{current === 'cheque' ? ', and the bank must clear the cheque' : ''}.
      </p>
      {blocked ? (
        <UnavailableButton label={correcting ? 'Record correction' : fromClaim ? 'Record receipt from this claim' : 'Record receipt'} reason={blocked} />
      ) : (
        <SubmitButton pendingLabel="Recording…" describedBy={`${idPrefix}-submit-help`}>
          {correcting ? 'Record correction' : fromClaim ? 'Record receipt from this claim' : `Record ${RECEIPT_MODE_LABEL[current].toLowerCase().replace('upi', 'UPI')} receipt`}
        </SubmitButton>
      )}
    </form>
  );
}

const NO_DESTINATION_TEXT =
  'No approved company account is in use. Another Accounts person must approve one in Company accounts first.';

const DESTINATIONS_UNAVAILABLE_TEXT =
  'Company accounts could not be loaded, so bank transfer and UPI receipts cannot be recorded right now. Reload the page. If this continues, finance may not be set up for company accounts yet.';

/**
 * Required choice of the company account the money was paid into (bank
 * transfer and UPI only). Several accounts: no silent default. Exactly one:
 * selected and said so, except right after a destination_changed refusal,
 * when the person must choose again. None in use: honest empty state with the
 * way to fix it. Read refused: says the list could not be loaded.
 */
function DestinationSelect({
  kind,
  options,
  unavailable,
  mustChooseAgain,
  value,
  error,
}: {
  kind: DestinationKind;
  options: DestinationOption[];
  unavailable: boolean;
  mustChooseAgain: boolean;
  value: string;
  error?: string;
}) {
  const what = kind === 'bank' ? 'bank account' : 'UPI ID';
  if (unavailable) {
    return (
      <div className="note warn" role="note">
        <p className="mb-0">
          <strong>Company account the money was paid into: </strong>
          {DESTINATIONS_UNAVAILABLE_TEXT}
        </p>
      </div>
    );
  }
  if (options.length === 0) {
    return (
      <div className="note warn" role="note">
        <p>
          <strong>Company account the money was paid into: </strong>
          {NO_DESTINATION_TEXT}
        </p>
        <p className="mb-0">
          <Link href="/app/accounts/destinations">Open Company accounts</Link>
        </p>
      </div>
    );
  }
  const preselect = options.length === 1 && !mustChooseAgain;
  const hint = mustChooseAgain
    ? `The account chosen before was replaced or retired. Choose the approved company ${what} again; the list is up to date.`
    : preselect
      ? `Only one approved company ${what} is in use, so it is selected. Check it matches the customer’s payment proof.`
      : `Choose the approved company ${what} shown on the customer’s payment proof. Masked; only approved versions in use are listed.`;
  return (
    <Field label="Company account the money was paid into" hint={hint} error={error} wide>
      {(p) => (
        <select {...p} name={FIN_FIELD.destinationVersionId} defaultValue={preselect ? options[0]!.versionId : value} required>
          {preselect ? null : <option value="">Choose a company {what}</option>}
          {options.map((o) => (
            <option key={o.versionId} value={o.versionId}>
              {o.label} · {maskedDestination(o)} · version {o.versionNo}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

// ---------------------------------------------------------------------------
// Receipt actions
// ---------------------------------------------------------------------------

export const RECEIPT_ACTION_LABEL: Record<ReceiptAction, string> = {
  verify: 'Verify receipt',
  reject: 'Reject receipt',
  cheque_clear: 'Record cheque cleared',
  cheque_mark: 'Record cheque not honoured',
  cheque_represent: 'Re-present cheque',
  reverse: 'Reverse receipt',
  correct: 'Record a correction',
};

const CHEQUE_ONLY: ReceiptAction[] = ['cheque_clear', 'cheque_mark', 'cheque_represent'];

function HiddenIds({ dealId, receiptId, requestId }: { dealId: string; receiptId: string; requestId: string }) {
  return (
    <>
      <RequestId id={requestId} />
      <input type="hidden" name={FIN_FIELD.dealId} value={dealId} />
      <input type="hidden" name={FIN_FIELD.receiptId} value={receiptId} />
    </>
  );
}

/** A row-sized submit button with an id (SubmitButton has none); same pending behaviour. */
function RowSubmit({ id, pendingLabel, describedBy, variant, children }: { id?: string; pendingLabel: string; describedBy?: string; variant?: 'secondary'; children: ReactNode }) {
  const { pending } = useHandFormStatus();
  return (
    <button
      id={id}
      type="submit"
      className={cn('button small', variant)}
      aria-disabled={pending}
      aria-describedby={describedBy}
      onClick={(event) => {
        if (pending) event.preventDefault();
      }}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}

function VerifyReceipt({ dealId, receipt, action, row = false }: { dealId: string; receipt: ReceiptView; action: FinanceAction; row?: boolean }) {
  const f = useFinanceForm(action);
  const helpId = `verify-help-${receipt.receiptId}`;
  return (
    <form key={f.formKey} action={f.formAction} noValidate className="fin-inline-form" aria-label={`Verify ${receipt.receiptNo}`}>
      <HiddenIds dealId={dealId} receiptId={receipt.receiptId} requestId={f.requestId} />
      <p id={helpId} className={row ? 'visually-hidden' : 'hint mb-0'}>
        {receipt.mode === 'cheque'
          ? 'Confirms the cheque details and image. The cheque then waits for bank clearance; nothing is available yet.'
          : 'Confirms the money arrived, matching the proof. It then counts as available customer funds.'}
      </p>
      {row ? (
        <RowSubmit id={verifyButtonId(receipt.receiptId)} pendingLabel="Verifying…" describedBy={helpId}>
          Verify<span className="visually-hidden"> receipt {receipt.receiptNo}</span>
        </RowSubmit>
      ) : (
        <SubmitButton pendingLabel="Verifying…" describedBy={helpId}>
          {RECEIPT_ACTION_LABEL.verify}
          <span className="visually-hidden"> {receipt.receiptNo}</span>
        </SubmitButton>
      )}
      <FinanceResult state={f.state} />
    </form>
  );
}

function ReasonForm({
  title,
  dealId,
  receipt,
  action,
  kinds,
  submitLabel,
  pendingLabel,
  help,
  dateLabel,
  noteLabel = 'Reason',
}: {
  title: string;
  dealId: string;
  receipt: ReceiptView;
  action: FinanceAction;
  kinds?: Array<{ value: string; label: string }>;
  submitLabel: string;
  pendingLabel: string;
  help: string;
  dateLabel?: string;
  noteLabel?: string;
}) {
  const f = useFinanceForm(action);
  const isNote = noteLabel !== 'Reason';
  return (
    <details className="form-section work-form fin-action-form" open={f.state.status === 'error' || undefined}>
      <summary>
        <span className="form-section-title">
          {title}
          <span className="visually-hidden"> for {receipt.receiptNo}</span>
        </span>
      </summary>
      <form key={f.formKey} action={f.formAction} noValidate aria-label={`${title} ${receipt.receiptNo}`}>
        <FinanceResult state={f.state} />
        <HiddenIds dealId={dealId} receiptId={receipt.receiptId} requestId={f.requestId} />
        <p className="hint">{help}</p>
        <div className="form-grid">
          {kinds ? (
            <Field label="What happened" error={f.err(FIN_FIELD.kind)}>
              {(p) => (
                <select {...p} name={FIN_FIELD.kind} defaultValue={f.v(FIN_FIELD.kind, kinds[0]!.value)} required>
                  {kinds.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : null}
          {dateLabel ? (
            <Field label={dateLabel} error={f.err(FIN_FIELD.outcomeDate)}>
              {(p) => <input {...p} name={FIN_FIELD.outcomeDate} type="date" defaultValue={f.v(FIN_FIELD.outcomeDate)} required />}
            </Field>
          ) : null}
        </div>
        {noteLabel ? (
          <Field label={noteLabel} hint="10 to 500 characters." error={f.err(isNote ? FIN_FIELD.note : FIN_FIELD.reason)} wide>
            {(p) => (
              <textarea
                {...p}
                name={isNote ? FIN_FIELD.note : FIN_FIELD.reason}
                defaultValue={f.v(isNote ? FIN_FIELD.note : FIN_FIELD.reason)}
                maxLength={500}
                rows={2}
                required={!isNote}
              />
            )}
          </Field>
        ) : null}
        <SubmitButton pendingLabel={pendingLabel} variant="secondary">
          {submitLabel}
        </SubmitButton>
      </form>
    </details>
  );
}

function ClearCheque({ dealId, receipt, action }: { dealId: string; receipt: ReceiptView; action: FinanceAction }) {
  const f = useFinanceForm(action);
  return (
    <details className="form-section work-form fin-action-form" open={f.state.status === 'error' || undefined}>
      <summary>
        <span className="form-section-title">
          {RECEIPT_ACTION_LABEL.cheque_clear}
          <span className="visually-hidden"> for {receipt.receiptNo}</span>
        </span>
      </summary>
      <form key={f.formKey} action={f.formAction} noValidate aria-label={`Record cheque cleared ${receipt.receiptNo}`}>
        <FinanceResult state={f.state} />
        <HiddenIds dealId={dealId} receiptId={receipt.receiptId} requestId={f.requestId} />
        <p className="hint">
          Needs bank proof. Then the amount counts as money.
        </p>
        <Field label="Date the bank cleared it" error={f.err(FIN_FIELD.outcomeDate)}>
          {(p) => <input {...p} name={FIN_FIELD.outcomeDate} type="date" defaultValue={f.v(FIN_FIELD.outcomeDate)} required />}
        </Field>
        <SubmitButton pendingLabel="Recording…">Record cheque cleared</SubmitButton>
      </form>
    </details>
  );
}

function RepresentCheque({ dealId, receipt, action, row = false }: { dealId: string; receipt: ReceiptView; action: FinanceAction; row?: boolean }) {
  const f = useFinanceForm(action);
  const helpId = `represent-help-${receipt.receiptId}`;
  return (
    <form key={f.formKey} action={f.formAction} noValidate className="fin-inline-form" aria-label={`Re-present ${receipt.receiptNo}`}>
      <HiddenIds dealId={dealId} receiptId={receipt.receiptId} requestId={f.requestId} />
      <p id={helpId} className={row ? 'visually-hidden' : 'hint mb-0'}>
        Upload a new cheque image or bank proof first. The same receipt and amount go back to “awaiting bank clearance”; nothing is counted twice.
      </p>
      {row ? (
        <RowSubmit pendingLabel="Re-presenting…" variant="secondary" describedBy={helpId}>
          Re-present cheque<span className="visually-hidden"> {receipt.receiptNo}</span>
        </RowSubmit>
      ) : (
        <SubmitButton pendingLabel="Re-presenting…" variant="secondary" describedBy={helpId}>
          Re-present cheque<span className="visually-hidden"> {receipt.receiptNo}</span>
        </SubmitButton>
      )}
      <FinanceResult state={f.state} />
    </form>
  );
}

/**
 * The one action a receipt row offers (design plan 2.3: "Verify" on the row):
 * Verify while the receipt waits for its second Accounts person (shown
 * disabled with the database's reason when this person may not, for example
 * the recorder), otherwise Re-present for a bounced cheque. Every other action
 * stays in the row's Details. null = nothing to do on the row.
 */
export function receiptMainAction(receipt: ReceiptView): 'verify' | 'cheque_represent' | null {
  const verify = receipt.actions.verify ?? null;
  if (verify !== 'wrong_state') return 'verify';
  if (receipt.mode === 'cheque' && (receipt.actions.cheque_represent ?? null) === null) return 'cheque_represent';
  return null;
}

export function ReceiptRowAction({ dealId, receipt, actions }: { dealId: string; receipt: ReceiptView; actions: FinanceActions }) {
  const main = receiptMainAction(receipt);
  if (main === 'verify') {
    const block = receipt.actions.verify ?? null;
    if (block !== null) return <UnavailableButton label={`Verify receipt ${receipt.receiptNo}`} reason={ACTION_BLOCK_TEXT[block]} />;
    return <VerifyReceipt dealId={dealId} receipt={receipt} action={actions.verifyReceiptAction} row />;
  }
  if (main === 'cheque_represent') return <RepresentCheque dealId={dealId} receipt={receipt} action={actions.representChequeAction} row />;
  return <span className="text-sm text-quiet">Nothing to do on the row</span>;
}

/**
 * Every action this viewer could take on a receipt: available ones as forms,
 * blocked ones as an unavailable button with the plain reason. Actions that
 * only fail on the receipt's state are listed together in one line.
 */
export function ReceiptActionsPanel({
  dealId,
  receipt,
  detail,
  actions,
  destinationOptions = [],
  destinationOptionsUnavailable = false,
  inRow = false,
}: {
  dealId: string;
  receipt: ReceiptView;
  detail: AccountsDealDetail;
  actions: FinanceActions;
  destinationOptions?: DestinationOption[];
  destinationOptionsUnavailable?: boolean;
  /**
   * R4: the panel sits in a receipt row's Details. The row's own action
   * (receiptMainAction) is left out here, and actions that only fail on the
   * receipt's state are not listed (no "Not possible now" line).
   */
  inRow?: boolean;
}) {
  const isCheque = receipt.mode === 'cheque';
  const main = inRow ? receiptMainAction(receipt) : null;
  const relevant = (Object.keys(RECEIPT_ACTION_LABEL) as ReceiptAction[]).filter((a) => (isCheque || !CHEQUE_ONLY.includes(a)) && a !== main);
  const block = (a: ReceiptAction): ActionBlock => receipt.actions[a] ?? null;
  const stateOnly = relevant.filter((a) => block(a) === 'wrong_state');
  const shown = relevant.filter((a) => block(a) !== 'wrong_state');
  const correctionDone = receipt.correctedByReceiptNo !== null;
  if (inRow && shown.filter((a) => a !== 'correct' || !correctionDone).length === 0) return null;
  return (
    <div className="fin-actions" aria-label={`${inRow ? 'More actions' : 'Actions'} for ${receipt.receiptNo}`} role="group">
      {shown.map((a) => {
        const b = block(a);
        if (b !== null) return <UnavailableButton key={a} label={RECEIPT_ACTION_LABEL[a]} reason={ACTION_BLOCK_TEXT[b]} />;
        switch (a) {
          case 'verify':
            return <VerifyReceipt key={a} dealId={dealId} receipt={receipt} action={actions.verifyReceiptAction} />;
          case 'reject':
            return (
              <ReasonForm
                key={a}
                title={RECEIPT_ACTION_LABEL.reject}
                dealId={dealId}
                receipt={receipt}
                action={actions.rejectReceiptAction}
                kinds={
                  receipt.correctsReceiptNo
                    ? [{ value: 'data_error', label: 'Details entered wrongly' }]
                    : [
                        { value: 'not_received', label: 'Money not received' },
                        { value: 'data_error', label: 'Details entered wrongly' },
                      ]
                }
                submitLabel="Reject receipt"
                pendingLabel="Rejecting…"
                help="Nothing was posted for this receipt. A receipt rejected as “details entered wrongly” can be corrected with a new receipt."
              />
            );
          case 'cheque_clear':
            return <ClearCheque key={a} dealId={dealId} receipt={receipt} action={actions.clearChequeAction} />;
          case 'cheque_mark':
            return (
              <ReasonForm
                key={a}
                title={RECEIPT_ACTION_LABEL.cheque_mark}
                dealId={dealId}
                receipt={receipt}
                action={actions.markChequeAction}
                kinds={[
                  { value: 'bounced', label: 'Bounced' },
                  { value: 'stopped', label: 'Payment stopped' },
                  { value: 'cancelled', label: 'Cancelled' },
                ]}
                dateLabel="Date of the outcome"
                noteLabel="Note (needed for a cancelled cheque)"
                submitLabel="Record outcome"
                pendingLabel="Recording…"
                help="Bounced or stopped needs bank proof uploaded first. Nothing is posted. A bounced cheque can be re-presented."
              />
            );
          case 'cheque_represent':
            return <RepresentCheque key={a} dealId={dealId} receipt={receipt} action={actions.representChequeAction} />;
          case 'reverse':
            return (
              <ReasonForm
                key={a}
                title={RECEIPT_ACTION_LABEL.reverse}
                dealId={dealId}
                receipt={receipt}
                action={actions.reverseReceiptAction}
                kinds={
                  receipt.correctsReceiptNo
                    ? [{ value: 'data_error', label: 'Details entered wrongly' }]
                    : [
                        ...(receipt.mode === 'cash' ? [] : [{ value: 'bank_return', label: 'Returned by the bank' }]),
                        { value: 'not_received', label: 'Money not received' },
                        { value: 'data_error', label: 'Details entered wrongly' },
                      ]
                }
                submitLabel="Reverse receipt"
                pendingLabel="Reversing…"
                help="Reverses this receipt. The original stays in history. This is not a refund."
              />
            );
          case 'correct':
            if (correctionDone) return null;
            return (
              <details key={a} className="form-section work-form fin-action-form">
                <summary>
                  <span className="form-section-title">
                    {RECEIPT_ACTION_LABEL.correct}
                    <span className="visually-hidden"> for {receipt.receiptNo}</span>
                  </span>
                </summary>
                <RecordReceiptForm
                  detail={detail}
                  action={actions.recordReceiptAction}
                  correcting={receipt}
                  idPrefix={`correct-${receipt.receiptId}`}
                  destinationOptions={destinationOptions}
                  destinationOptionsUnavailable={destinationOptionsUnavailable}
                />
              </details>
            );
          default:
            return null;
        }
      })}
      {inRow ? null : shown.length === 0 ? (
        <p className="fin-state-only">No further action is possible on this receipt in its current state.</p>
      ) : stateOnly.length > 0 ? (
        <p className="fin-state-only">
          <span className="visually-hidden">Not possible in the current state: </span>
          <span aria-hidden="true">Not possible now: </span>
          {stateOnly.map((a) => RECEIPT_ACTION_LABEL[a]).join(', ')}.
        </p>
      ) : null}
    </div>
  );
}

/** id of the "Record a receipt" button, so the page header's "Next:" can jump to it. */
export const RECORD_RECEIPT_BUTTON_ID = 'record-receipt-open';

/**
 * R4 (design plan 2.3): "Record a receipt" at the top of the Accounts deal
 * page opens the existing receipt form in a drawer (Radix Dialog: focus
 * trap, Escape, focus back on the button). The form, its fields and its
 * server action are unchanged; the drawer stays open after an answer so the
 * result and any kept values stay in view.
 */
export function RecordReceiptDrawer({
  detail,
  action,
  destinationOptions = [],
  destinationOptionsUnavailable = false,
  primary = false,
  defaultOpen = false,
}: {
  detail: AccountsDealDetail;
  action: FinanceAction;
  destinationOptions?: DestinationOption[];
  destinationOptionsUnavailable?: boolean;
  /** The page's one primary action (nothing else waits on this deal). */
  primary?: boolean;
  /** Preview gallery only. */
  defaultOpen?: boolean;
}) {
  const anyAllowed = Object.values(detail.modesAllowed).some(Boolean);
  // Above the drawer, as for the cash forms: closing the drawer unmounts its content, and the request id
  // (kept after an unknown outcome) and the restored values must survive that.
  const form = useFinanceForm(action);
  return (
    <Drawer defaultOpen={defaultOpen}>
      <DrawerTrigger asChild>
        <Button id={RECORD_RECEIPT_BUTTON_ID} variant={primary ? 'primary' : 'secondary'} data-slot="record-receipt-open">
          <Plus aria-hidden="true" />
          Record a receipt
        </Button>
      </DrawerTrigger>
      <DrawerContent className="w-[min(44rem,calc(100vw-1rem))]" closeLabel="Close the receipt form">
        <DrawerHeader>
          <DrawerTitle className="m-0 text-xl font-semibold text-ink">Record a receipt</DrawerTitle>
          <DrawerDescription className="m-0 text-sm text-quiet">
            {detail.dealReference} · {detail.dealTitle}. Another Accounts person must verify it before it counts as money.
          </DrawerDescription>
        </DrawerHeader>
        <DrawerBody>
          {!anyAllowed ? (
            <div className="note warn mb-3" role="note">
              <p>
                <strong>No payment mode is available yet.</strong> Payment modes are switched on by the CRM team with the owner’s approval, after the CA confirms the rules. You can still verify
                receipts that were already recorded.
              </p>
            </div>
          ) : null}
          <RecordReceiptForm detail={detail} action={action} form={form} destinationOptions={destinationOptions} destinationOptionsUnavailable={destinationOptionsUnavailable} />
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Evidence upload
// ---------------------------------------------------------------------------

export function EvidenceUploadForm({
  dealId,
  receipt,
  action,
}: {
  dealId: string;
  receipt: ReceiptView;
  action: FinanceAction | undefined;
}) {
  const f = useFinanceForm(action ?? (async () => ({ status: 'error', message: 'File upload is not available yet.' })));
  const kinds: FinanceEvidenceKind[] = receipt.mode === 'cheque' ? ['cheque_image', 'bank_proof'] : ['bank_proof'];
  if (receipt.mode === 'cash') return null;
  if (!action) return <BlockedReason>File upload is not available yet. Proof cannot be attached from this screen.</BlockedReason>;
  return (
    <details className="form-section work-form fin-action-form" open={f.state.status === 'error' || undefined}>
      <summary>
        <span className="form-section-title">
          Upload proof<span className="visually-hidden"> for {receipt.receiptNo}</span>
        </span>
      </summary>
      <form key={f.formKey} action={f.formAction} noValidate aria-label={`Upload proof for ${receipt.receiptNo}`}>
        <FinanceResult state={f.state} />
        <HiddenIds dealId={dealId} receiptId={receipt.receiptId} requestId={f.requestId} />
        <div className="form-grid">
          <Field label="What is this file?" error={f.err(FIN_FIELD.kind)}>
            {(p) => (
              <select {...p} name={FIN_FIELD.kind} defaultValue={f.v(FIN_FIELD.kind, kinds[0])}>
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {EVIDENCE_KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="File" hint={FILE_HINT} error={f.err(FIN_FIELD.file)}>
            {(p) => <input {...p} name={FIN_FIELD.file} type="file" accept={ACCEPT} required />}
          </Field>
        </div>
        <SubmitButton pendingLabel="Uploading…" variant="secondary">
          Upload file
        </SubmitButton>
      </form>
    </details>
  );
}

export { EVIDENCE_KIND_LABEL };
