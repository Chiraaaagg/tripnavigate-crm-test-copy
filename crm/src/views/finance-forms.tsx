'use client';

import Link from 'next/link';
import { unstable_rethrow } from 'next/navigation';
import { type ReactNode, useActionState, useId, useState } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SubmitButton } from '@/components/SubmitButton';
import {
  ACTION_BLOCK_TEXT,
  type ActionBlock,
  FINANCE_ERROR_TEXT,
  type AccountsClaimView,
  type AccountsDealDetail,
  type BillingProfileView,
  type BookingReviewView,
  type CashBranchView,
  type CashDepositView,
  type CashReconciliationView,
  type CompanyDestinationView,
  DESTINATION_KIND_LABEL,
  DESTINATION_KINDS,
  type DestinationKind,
  destinationKindForMode,
  type DestinationOption,
  type DestinationVersionDetail,
  type DestinationVersionView,
  FINANCE_EVIDENCE_MAX_BYTES,
  FINANCE_EVIDENCE_MIME,
  type FinanceEvidenceKind,
  type FinancePolicyPage,
  RECEIPT_MODE_LABEL,
  RECEIPT_MODES,
  type ReceiptAction,
  type ReceiptMode,
  type ReceiptView,
} from '@/modules/finance/contracts';
import { BlockedReason, blockText, EVIDENCE_KIND_LABEL, formatInr, isZero, maskedDestination, paiseToRupeesField } from './finance-common';

/*
 * Phase 5A Accounts forms. Server actions are passed in as props (pages pass
 * the real ones from modules/finance/server/actions; the preview gallery
 * passes a stub), so every view stays a pure function of contracts.ts shapes.
 *
 * Every write carries a hidden requestId. The database replays a committed
 * result for the same id and writes nothing on a refusal, so a fresh id is
 * issued after every answer (success or error); a double click inside one
 * pending submit reuses the same id. Typed values are kept after an error.
 */

// ---------------------------------------------------------------------------
// Action plumbing
// ---------------------------------------------------------------------------

export interface FinanceActionState {
  status: 'idle' | 'ok' | 'error';
  message?: string;
  fieldErrors?: Record<string, string | string[] | undefined>;
  /** Refusal token when the database (or the form parser) refused. */
  code?: string;
}

export type FinanceAction = (prev: FinanceActionState, formData: FormData) => Promise<FinanceActionState>;

export interface FinanceActions {
  saveBillingAction: FinanceAction;
  verifyBillingAction: FinanceAction;
  returnReviewAction: FinanceAction;
  approveReviewAction: FinanceAction;
  recordReceiptAction: FinanceAction;
  verifyReceiptAction: FinanceAction;
  rejectReceiptAction: FinanceAction;
  clearChequeAction: FinanceAction;
  markChequeAction: FinanceAction;
  representChequeAction: FinanceAction;
  reverseReceiptAction: FinanceAction;
  recordDepositAction: FinanceAction;
  verifyDepositAction: FinanceAction;
  rejectDepositAction: FinanceAction;
  recordReconciliationAction: FinanceAction;
  verifyReconciliationAction: FinanceAction;
  updatePolicyAction: FinanceAction;
  /** Evidence upload (bank proof, cheque image, deposit slip). Optional until the module provides it. */
  uploadEvidenceAction?: FinanceAction;
  /** Stage 2: company bank and UPI destinations. */
  submitDestinationAction: FinanceAction;
  approveDestinationAction: FinanceAction;
  returnDestinationAction: FinanceAction;
  retireDestinationAction: FinanceAction;
  showDestinationDetailAction: DestinationDetailAction;
}

/** Answer of the audited "Show full details" read (same shape as the server action's DestinationDetailState). */
export type DestinationDetailState =
  | { status: 'idle' }
  | { status: 'ok'; detail: DestinationVersionDetail }
  | { status: 'error'; message: string };

export type DestinationDetailAction = (prev: DestinationDetailState, formData: FormData) => Promise<DestinationDetailState>;

/** Form field names shared with modules/finance/server/actions. */
export const FIN_FIELD = {
  requestId: 'requestId',
  dealId: 'dealId',
  entityId: 'entityId',
  branchId: 'branchId',
  bookingVersionId: 'bookingVersionId',
  receiptId: 'receiptId',
  depositId: 'depositId',
  reconciliationId: 'reconciliationId',
  expectedRowVersion: 'expectedRowVersion',
  billingName: 'billingName',
  addressLine1: 'addressLine1',
  addressLine2: 'addressLine2',
  city: 'city',
  stateCode: 'stateCode',
  postalCode: 'postalCode',
  gstin: 'gstin',
  // Booking form Bill To (same names as the Book now Bill To form)
  billToType: 'billToType',
  contactPerson: 'contactPerson',
  billingPhone: 'billingPhone',
  billingEmail: 'billingEmail',
  gstStatus: 'gstStatus',
  gstReason: 'gstReason',
  reason: 'reason',
  mode: 'mode',
  amountRupees: 'amountRupees',
  receivedOn: 'receivedOn',
  collectorUserId: 'collectorUserId',
  payerName: 'payerName',
  payerPan: 'payerPan',
  payerMobile: 'payerMobile',
  reference: 'reference',
  micrCode: 'micrCode',
  chequeNumber: 'chequeNumber',
  chequeDate: 'chequeDate',
  accountPayee: 'accountPayee',
  correctsReceiptId: 'correctsReceiptId',
  note: 'note',
  kind: 'kind',
  outcomeDate: 'outcomeDate',
  file: 'file',
  receiptIds: 'receiptIds',
  depositedOn: 'depositedOn',
  bankReference: 'bankReference',
  businessDate: 'businessDate',
  countedRupees: 'countedRupees',
  receiptMaxRupees: 'receiptMaxRupees',
  cashPayerDayCapRupees: 'cashPayerDayCapRupees',
  cashTripCapRupees: 'cashTripCapRupees',
  cashDepositDays: 'cashDepositDays',
  reconciliationRequired: 'reconciliationRequired',
  effectiveAt: 'effectiveAt',
  destinationVersionId: 'destinationVersionId',
  destinationId: 'destinationId',
  versionId: 'versionId',
  destinationKind: 'destinationKind',
  label: 'label',
  holderName: 'holderName',
  bankName: 'bankName',
  accountNumber: 'accountNumber',
  ifsc: 'ifsc',
  payeeName: 'payeeName',
  upiId: 'upiId',
} as const;

const UNEXPECTED = 'We could not confirm this was saved. Reload the page to check before you try again. Your typed details are still here.';

interface UiState extends FinanceActionState {
  /** Values typed before the last submit, restored after an error. */
  values?: Record<string, string>;
  /** Bumps on every answer so the form remounts with the restored values. */
  seq: number;
  /** Bumps only on a definitive answer, which is when a fresh requestId is issued. */
  idSeq: number;
}

const IDLE: UiState = { status: 'idle', seq: 0, idSeq: 0 };
const KNOWN_CODES = new Set<string>(Object.keys(FINANCE_ERROR_TEXT));

/**
 * A definitive answer: success, or a refusal carrying a known finance token
 * (a refusal writes nothing, so the id is not reserved). After an unexpected
 * failure the outcome is unknown, so the same requestId is kept: a resubmit
 * then replays the committed result instead of recording a second receipt.
 */
function isDefinitive(result: FinanceActionState): boolean {
  return result.status === 'ok' || (result.status === 'error' && !!result.code && KNOWN_CODES.has(result.code));
}

function snapshot(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  formData.forEach((value, key) => {
    if (typeof value === 'string' && key !== FIN_FIELD.requestId) out[key] = value;
  });
  return out;
}

function useFinanceForm(action: FinanceAction, initial?: FinanceActionState | null) {
  const [state, formAction] = useActionState(async (prev: UiState, formData: FormData): Promise<UiState> => {
    const values = snapshot(formData);
    try {
      const result = await action({ status: prev.status, message: prev.message, fieldErrors: prev.fieldErrors, code: prev.code }, formData);
      return {
        ...result,
        values: result.status === 'error' ? values : undefined,
        seq: prev.seq + 1,
        idSeq: isDefinitive(result) ? prev.idSeq + 1 : prev.idSeq,
      };
    } catch (error) {
      unstable_rethrow(error);
      return { status: 'error', message: UNEXPECTED, values, seq: prev.seq + 1, idSeq: prev.idSeq };
    }
  }, initial ? { ...initial, seq: 0, idSeq: 0 } : IDLE);
  const [requestIds, setRequestIds] = useState<{ idSeq: number; id: string }>(() => ({ idSeq: state.idSeq, id: crypto.randomUUID() }));
  // A fresh request id only after a definitive answer (React's "adjust state during render" pattern).
  if (requestIds.idSeq !== state.idSeq) setRequestIds({ idSeq: state.idSeq, id: crypto.randomUUID() });
  const v = (name: string, fallback = '') => state.values?.[name] ?? fallback;
  const err = (name: string): string | undefined => {
    const e = state.fieldErrors?.[name];
    return Array.isArray(e) ? e.join(' ') : e;
  };
  // The form remounts after every answer so restored values show; the request id may stay the same.
  return { state, formAction, requestId: requestIds.id, formKey: `${requestIds.id}-${state.seq}`, v, err };
}

function RequestId({ id }: { id: string }) {
  return <input type="hidden" name={FIN_FIELD.requestId} value={id} />;
}

export function FinanceResult({ state }: { state: FinanceActionState }) {
  if (state.status === 'error') {
    return (
      <div className="message error" role="alert">
        <strong>Not saved: </strong>
        {state.message ?? 'Check the highlighted fields.'}
      </div>
    );
  }
  if (state.status === 'ok') {
    return (
      <div className="message success" role="status">
        <strong>Done: </strong>
        {state.message ?? 'Saved.'}
      </div>
    );
  }
  return <div role="status" aria-live="polite" />;
}

/** Label + control + hint + field error, wired with aria-describedby and aria-invalid. */
function Field({
  label,
  hint,
  error,
  wide,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  wide?: boolean;
  children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: true }) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`field${wide ? ' field-wide' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {hint ? (
        <span id={hintId} className="hint">
          {hint}
        </span>
      ) : null}
      {children({ id, 'aria-describedby': describedBy, ...(error ? { 'aria-invalid': true as const } : {}) })}
      {error ? (
        <span id={errId} className="field-issue">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** A button that cannot be used now, with the reason read out with it. */
export function UnavailableButton({ label, reason }: { label: string; reason: string }) {
  const id = useId();
  return (
    <div className="fin-unavailable">
      <button type="button" className="button secondary small" aria-disabled="true" aria-describedby={id}>
        {label}
      </button>
      <BlockedReason id={id}>{reason}</BlockedReason>
    </div>
  );
}

/** Contract reason text, with "own_record" worded for the record type (a deposit or a cash count is not a receipt). */
function custodyBlockText(block: Exclude<ActionBlock, null>, what: 'deposit' | 'cash count'): string {
  return block === 'own_record' ? `You recorded this ${what}. Another Accounts person must do this step.` : ACTION_BLOCK_TEXT[block];
}

const ACCEPT = FINANCE_EVIDENCE_MIME.join(',');
const MAX_MB = FINANCE_EVIDENCE_MAX_BYTES / (1024 * 1024);
const FILE_HINT = `PDF, JPG, PNG or WebP, up to ${MAX_MB} MB. Kept private; only Accounts can open it.`;

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
}) {
  const f = useFinanceForm(action);
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

function VerifyReceipt({ dealId, receipt, action }: { dealId: string; receipt: ReceiptView; action: FinanceAction }) {
  const f = useFinanceForm(action);
  const helpId = `verify-help-${receipt.receiptId}`;
  return (
    <form key={f.formKey} action={f.formAction} noValidate className="fin-inline-form" aria-label={`Verify ${receipt.receiptNo}`}>
      <HiddenIds dealId={dealId} receiptId={receipt.receiptId} requestId={f.requestId} />
      <p id={helpId} className="hint mb-0">
        {receipt.mode === 'cheque'
          ? 'Confirms the cheque details and image. The cheque then waits for bank clearance; nothing is available yet.'
          : 'Confirms the money arrived, matching the proof. It then counts as available customer funds.'}
      </p>
      <SubmitButton pendingLabel="Verifying…" describedBy={helpId}>
        {RECEIPT_ACTION_LABEL.verify}
        <span className="visually-hidden"> {receipt.receiptNo}</span>
      </SubmitButton>
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

function RepresentCheque({ dealId, receipt, action }: { dealId: string; receipt: ReceiptView; action: FinanceAction }) {
  const f = useFinanceForm(action);
  const helpId = `represent-help-${receipt.receiptId}`;
  return (
    <form key={f.formKey} action={f.formAction} noValidate className="fin-inline-form" aria-label={`Re-present ${receipt.receiptNo}`}>
      <HiddenIds dealId={dealId} receiptId={receipt.receiptId} requestId={f.requestId} />
      <p id={helpId} className="hint mb-0">
        Upload a new cheque image or bank proof first. The same receipt and amount go back to “awaiting bank clearance”; nothing is counted twice.
      </p>
      <SubmitButton pendingLabel="Re-presenting…" variant="secondary" describedBy={helpId}>
        Re-present cheque<span className="visually-hidden"> {receipt.receiptNo}</span>
      </SubmitButton>
      <FinanceResult state={f.state} />
    </form>
  );
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
}: {
  dealId: string;
  receipt: ReceiptView;
  detail: AccountsDealDetail;
  actions: FinanceActions;
  destinationOptions?: DestinationOption[];
  destinationOptionsUnavailable?: boolean;
}) {
  const isCheque = receipt.mode === 'cheque';
  const relevant = (Object.keys(RECEIPT_ACTION_LABEL) as ReceiptAction[]).filter((a) => isCheque || !CHEQUE_ONLY.includes(a));
  const block = (a: ReceiptAction): ActionBlock => receipt.actions[a] ?? null;
  const stateOnly = relevant.filter((a) => block(a) === 'wrong_state');
  const shown = relevant.filter((a) => block(a) !== 'wrong_state');
  const correctionDone = receipt.correctedByReceiptNo !== null;
  return (
    <div className="fin-actions" aria-label={`Actions for ${receipt.receiptNo}`} role="group">
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
      {shown.length === 0 ? (
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

// ---------------------------------------------------------------------------
// Cash custody
// ---------------------------------------------------------------------------

export function RecordDepositForm({ entityId, branch, action }: { entityId: string; branch: CashBranchView; action: FinanceAction }) {
  const f = useFinanceForm(action);
  const p = `dep-${branch.branchId}`;
  if (branch.undepositedVerified.length === 0) {
    return <p className="hint">No verified cash is waiting to be deposited at {branch.branchName}.</p>;
  }
  return (
    <details className="form-section work-form" open={f.state.status === 'error' || undefined}>
      <summary>
        <span className="form-section-title">
          Record a bank deposit<span className="visually-hidden"> for {branch.branchName}</span>
        </span>
      </summary>
      <form key={f.formKey} action={f.formAction} noValidate aria-label={`Record a bank deposit for ${branch.branchName}`}>
        <FinanceResult state={f.state} />
        <RequestId id={f.requestId} />
        <input type="hidden" name={FIN_FIELD.entityId} value={entityId} />
        <input type="hidden" name={FIN_FIELD.branchId} value={branch.branchId} />
        <fieldset className="group" aria-describedby={`${p}-help`}>
          <legend>Cash receipts in this deposit</legend>
          <span id={`${p}-help`} className="hint">
            The deposit total is the exact sum of the receipts you tick. Another Accounts person verifies it against the slip.
          </span>
          <ul className="fin-check-list">
            {branch.undepositedVerified.map((r) => (
              <li key={r.receiptId}>
                <label className="choice">
                  <input
                    type="checkbox"
                    name={FIN_FIELD.receiptIds}
                    value={r.receiptId}
                    defaultChecked={f.state.values ? false : true}
                  />{' '}
                  {r.receiptNo} · {formatInr(r.amountPaise)} · received {r.receivedOn} · {r.dealReference}
                </label>
              </li>
            ))}
          </ul>
          {f.err(FIN_FIELD.receiptIds) ? <span className="field-issue">{f.err(FIN_FIELD.receiptIds)}</span> : null}
        </fieldset>
        <div className="form-grid">
          <Field label="Deposited on" error={f.err(FIN_FIELD.depositedOn)}>
            {(q) => <input {...q} name={FIN_FIELD.depositedOn} type="date" defaultValue={f.v(FIN_FIELD.depositedOn)} required />}
          </Field>
          <Field label="Bank reference on the slip" error={f.err(FIN_FIELD.bankReference)}>
            {(q) => <input {...q} name={FIN_FIELD.bankReference} defaultValue={f.v(FIN_FIELD.bankReference)} maxLength={60} autoComplete="off" required />}
          </Field>
          <Field label="Deposit slip" hint={FILE_HINT} error={f.err(FIN_FIELD.file)}>
            {(q) => <input {...q} name={FIN_FIELD.file} type="file" accept={ACCEPT} required />}
          </Field>
        </div>
        <SubmitButton pendingLabel="Recording…">Record deposit</SubmitButton>
      </form>
    </details>
  );
}

export function DepositDecisionForms({ entityId, deposit, actions }: { entityId: string; deposit: CashDepositView; actions: FinanceActions }) {
  const v = useFinanceForm(actions.verifyDepositAction);
  const r = useFinanceForm(actions.rejectDepositAction);
  if (deposit.status !== 'recorded') return null;
  const helpId = `dep-verify-help-${deposit.depositId}`;
  return (
    <div className="fin-actions" role="group" aria-label={`Actions for deposit ${deposit.bankReference}`}>
      {deposit.actions.verify === null ? (
        <form key={v.formKey} action={v.formAction} noValidate className="fin-inline-form" aria-label={`Verify deposit ${deposit.bankReference}`}>
          <RequestId id={v.requestId} />
          <input type="hidden" name={FIN_FIELD.entityId} value={entityId} />
          <input type="hidden" name={FIN_FIELD.depositId} value={deposit.depositId} />
          <p id={helpId} className="hint mb-0">
            Confirms the slip matches. Moves the cash from the branch to the bank; customer funds do not change.
          </p>
          <SubmitButton pendingLabel="Verifying…" describedBy={helpId}>
            Verify deposit<span className="visually-hidden"> {deposit.bankReference}</span>
          </SubmitButton>
          <FinanceResult state={v.state} />
        </form>
      ) : (
        <UnavailableButton label="Verify deposit" reason={custodyBlockText(deposit.actions.verify, 'deposit')} />
      )}
      {deposit.actions.reject === null ? (
        <details className="form-section work-form fin-action-form" open={r.state.status === 'error' || undefined}>
          <summary>
            <span className="form-section-title">
              Reject deposit<span className="visually-hidden"> {deposit.bankReference}</span>
            </span>
          </summary>
          <form key={r.formKey} action={r.formAction} noValidate aria-label={`Reject deposit ${deposit.bankReference}`}>
            <FinanceResult state={r.state} />
            <RequestId id={r.requestId} />
            <input type="hidden" name={FIN_FIELD.entityId} value={entityId} />
            <input type="hidden" name={FIN_FIELD.depositId} value={deposit.depositId} />
            <p className="hint">The receipts become free for a new deposit.</p>
            <Field label="Reason" hint="10 to 500 characters." error={r.err(FIN_FIELD.reason)} wide>
              {(p) => <textarea {...p} name={FIN_FIELD.reason} defaultValue={r.v(FIN_FIELD.reason)} maxLength={500} rows={2} required />}
            </Field>
            <SubmitButton pendingLabel="Rejecting…" variant="secondary">
              Reject deposit
            </SubmitButton>
          </form>
        </details>
      ) : (
        <UnavailableButton label="Reject deposit" reason={custodyBlockText(deposit.actions.reject, 'deposit')} />
      )}
    </div>
  );
}

export function RecordReconciliationForm({ entityId, branch, action }: { entityId: string; branch: CashBranchView; action: FinanceAction }) {
  const f = useFinanceForm(action);
  return (
    <details className="form-section work-form" open={f.state.status === 'error' || undefined}>
      <summary>
        <span className="form-section-title">
          Record a daily cash count<span className="visually-hidden"> for {branch.branchName}</span>
        </span>
      </summary>
      <form key={f.formKey} action={f.formAction} noValidate aria-label={`Record a daily cash count for ${branch.branchName}`}>
        <FinanceResult state={f.state} />
        <RequestId id={f.requestId} />
        <input type="hidden" name={FIN_FIELD.entityId} value={entityId} />
        <input type="hidden" name={FIN_FIELD.branchId} value={branch.branchId} />
        <p className="hint">
          Count the cash physically at the branch. The CRM compares it with verified cash in hand up to that date. Any difference needs a note.
        </p>
        <div className="form-grid">
          <Field label="Business date" error={f.err(FIN_FIELD.businessDate)}>
            {(p) => <input {...p} name={FIN_FIELD.businessDate} type="date" defaultValue={f.v(FIN_FIELD.businessDate)} required />}
          </Field>
          <Field label="Cash counted (₹)" error={f.err(FIN_FIELD.countedRupees)}>
            {(p) => <input {...p} name={FIN_FIELD.countedRupees} defaultValue={f.v(FIN_FIELD.countedRupees)} inputMode="decimal" autoComplete="off" required />}
          </Field>
        </div>
        <Field label="Note (needed when the count differs)" hint="10 to 500 characters." error={f.err(FIN_FIELD.note)} wide>
          {(p) => <textarea {...p} name={FIN_FIELD.note} defaultValue={f.v(FIN_FIELD.note)} maxLength={500} rows={2} />}
        </Field>
        <SubmitButton pendingLabel="Recording…" variant="secondary">
          Record cash count
        </SubmitButton>
      </form>
    </details>
  );
}

export function VerifyReconciliationForm({ entityId, rec, action }: { entityId: string; rec: CashReconciliationView; action: FinanceAction }) {
  const f = useFinanceForm(action);
  if (rec.status !== 'recorded') return null;
  if (rec.actions.verify !== null) return <UnavailableButton label="Verify cash count" reason={custodyBlockText(rec.actions.verify, 'cash count')} />;
  return (
    <form key={f.formKey} action={f.formAction} noValidate className="fin-inline-form" aria-label={`Verify cash count for ${rec.businessDate}`}>
      <RequestId id={f.requestId} />
      <input type="hidden" name={FIN_FIELD.entityId} value={entityId} />
      <input type="hidden" name={FIN_FIELD.reconciliationId} value={rec.reconciliationId} />
      <SubmitButton pendingLabel="Verifying…" variant="secondary">
        Verify cash count<span className="visually-hidden"> for {rec.businessDate}</span>
      </SubmitButton>
      <FinanceResult state={f.state} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Finance policy
// ---------------------------------------------------------------------------

export function PolicyEditForm({ page, action, initialState = null }: { page: FinancePolicyPage; action: FinanceAction; initialState?: FinanceActionState | null }) {
  const f = useFinanceForm(action, initialState);
  const c = page.current;
  return (
    <form key={f.formKey} action={f.formAction} noValidate aria-label="Schedule a new policy version">
      <FinanceResult state={f.state} />
      <RequestId id={f.requestId} />
      <input type="hidden" name={FIN_FIELD.entityId} value={page.legalEntityId} />
      <p className="hint">
        Creates a new version; earlier versions and every recorded receipt stay unchanged. Values must stay within the legal ceilings above.
      </p>
      <div className="form-grid">
        <Field label="Largest single receipt (₹)" hint={`At most ${formatInr(page.ceilings.receiptMaxCeilingPaise)}.`} error={f.err(FIN_FIELD.receiptMaxRupees)}>
          {(p) => <input {...p} name={FIN_FIELD.receiptMaxRupees} defaultValue={f.v(FIN_FIELD.receiptMaxRupees, paiseToRupeesField(c.receiptMaxPaise))} inputMode="decimal" autoComplete="off" required />}
        </Field>
        <Field label="Cash per payer per day (₹)" hint={`0 switches cash off. At most ${formatInr(page.ceilings.cashCapCeilingPaise)}.`} error={f.err(FIN_FIELD.cashPayerDayCapRupees)}>
          {(p) => (
            <input {...p} name={FIN_FIELD.cashPayerDayCapRupees} defaultValue={f.v(FIN_FIELD.cashPayerDayCapRupees, paiseToRupeesField(c.cashPayerDayCapPaise) || '0')} inputMode="decimal" autoComplete="off" required />
          )}
        </Field>
        <Field label="Cash per trip (₹)" hint={`0 switches cash off. At most ${formatInr(page.ceilings.cashCapCeilingPaise)}.`} error={f.err(FIN_FIELD.cashTripCapRupees)}>
          {(p) => <input {...p} name={FIN_FIELD.cashTripCapRupees} defaultValue={f.v(FIN_FIELD.cashTripCapRupees, paiseToRupeesField(c.cashTripCapPaise) || '0')} inputMode="decimal" autoComplete="off" required />}
        </Field>
        <Field label="Days to deposit cash" hint="1 to 7 working days (Monday to Saturday)." error={f.err(FIN_FIELD.cashDepositDays)}>
          {(p) => <input {...p} name={FIN_FIELD.cashDepositDays} type="number" min={1} max={7} step={1} defaultValue={f.v(FIN_FIELD.cashDepositDays, String(c.cashDepositDays))} required />}
        </Field>
        <Field label="Takes effect at (IST)" hint="Now or later, up to 90 days ahead, and not before the latest scheduled version." error={f.err(FIN_FIELD.effectiveAt)}>
          {(p) => <input {...p} name={FIN_FIELD.effectiveAt} type="datetime-local" defaultValue={f.v(FIN_FIELD.effectiveAt)} required />}
        </Field>
      </div>
      <label className="choice">
        <input type="checkbox" name={FIN_FIELD.reconciliationRequired} value="true" defaultChecked={f.state.values ? f.v(FIN_FIELD.reconciliationRequired) === 'true' : c.reconciliationRequired} /> Daily cash count required at each branch
      </label>
      <Field label="Reason for the change" hint="10 to 500 characters. Kept in the history." error={f.err(FIN_FIELD.reason)} wide>
        {(p) => <textarea {...p} name={FIN_FIELD.reason} defaultValue={f.v(FIN_FIELD.reason)} maxLength={500} rows={3} required />}
      </Field>
      <SubmitButton pendingLabel="Saving…">Save new policy version</SubmitButton>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Stage 2: company destinations (bank accounts and UPI IDs)
// ---------------------------------------------------------------------------

const DESTINATION_SCOPE_TEXT =
  'Approval confirms these company details as entered. It does not check that the bank account belongs to the company, and it is not a payment.';

/** The viewer made the open version, so the decision belongs to someone else. */
export const DESTINATION_OWN_VERSION_TEXT = 'You submitted this version. Another Accounts person must approve or return it.';

/**
 * Add a company account (no `destination`: kind, internal name and values),
 * or submit a replacement or correction for an existing one (kind fixed).
 * Masked values are never prefilled; the full account number or UPI ID is
 * typed again. Typed values stay after a refusal (kept in memory only).
 */
export function DestinationForm({
  entityId,
  action,
  destination = null,
  initialState = null,
}: {
  entityId: string;
  action: FinanceAction;
  destination?: CompanyDestinationView | null;
  initialState?: FinanceActionState | null;
}) {
  const f = useFinanceForm(action, initialState);
  const replacing = destination !== null;
  const base = replacing ? `dest-${destination.destinationId}` : 'dest-new';
  const restoredKind = f.v(FIN_FIELD.destinationKind);
  const [chosen, setChosen] = useState<DestinationKind | ''>(
    replacing ? destination.kind : restoredKind === 'bank' || restoredKind === 'upi' ? restoredKind : '',
  );
  const kind: DestinationKind | '' = replacing ? destination.kind : chosen;
  // Non-secret values of the latest version may be offered again; account numbers and UPI IDs never are.
  const latest = replacing ? (destination.versions.find((v) => v.versionNo === destination.latestVersionNo) ?? null) : null;
  return (
    <form
      key={f.formKey}
      action={f.formAction}
      noValidate
      aria-label={replacing ? `Submit new details for ${destination.label}` : 'Add a company account'}
    >
      <FinanceResult state={f.state} />
      <RequestId id={f.requestId} />
      <input type="hidden" name={FIN_FIELD.entityId} value={entityId} />
      {replacing ? (
        <>
          <input type="hidden" name={FIN_FIELD.destinationId} value={destination.destinationId} />
          <input type="hidden" name={FIN_FIELD.destinationKind} value={destination.kind} />
          <input type="hidden" name={FIN_FIELD.expectedRowVersion} value={destination.rowVersion} />
          <p className="hint">
            Creates version {destination.latestVersionNo + 1} of this {DESTINATION_KIND_LABEL[destination.kind].toLowerCase()}. Version{' '}
            {destination.latestVersionNo} and every earlier version stay in the history.
            {destination.current && destination.state !== 'retired'
              ? ` Receipts keep using version ${destination.current.versionNo} until another Accounts person approves the new one.`
              : ''}
          </p>
        </>
      ) : (
        <>
          <fieldset className="group fin-modes" aria-describedby={`${base}-kind-help`}>
            <legend>What kind of company account?</legend>
            <span id={`${base}-kind-help`} className="hint">
              Where customers pay the company. Bank transfer receipts select a bank account; UPI receipts select a UPI ID.
            </span>
            <div className="fin-segment">
              {DESTINATION_KINDS.map((k) => (
                <label key={k} className={`fin-segment-option${kind === k ? ' is-selected' : ''}`}>
                  <input type="radio" name={FIN_FIELD.destinationKind} value={k} checked={kind === k} onChange={() => setChosen(k)} />
                  <span className="fin-segment-label">{DESTINATION_KIND_LABEL[k]}</span>
                </label>
              ))}
            </div>
            {f.err(FIN_FIELD.destinationKind) ? <span className="field-issue">{f.err(FIN_FIELD.destinationKind)}</span> : null}
          </fieldset>
          <Field
            label="Internal name"
            hint="A short name staff will recognise, like “Main current account”. Up to 80 characters. Do not type account numbers or UPI IDs here."
            error={f.err(FIN_FIELD.label)}
            wide
          >
            {(p) => <input {...p} name={FIN_FIELD.label} defaultValue={f.v(FIN_FIELD.label)} maxLength={80} autoComplete="off" required />}
          </Field>
        </>
      )}

      {kind === 'bank' ? (
        <fieldset className="group">
          <legend>Bank account details</legend>
          <div className="form-grid">
            <Field label="Account holder name" hint="Exactly as the bank shows it." error={f.err(FIN_FIELD.holderName)}>
              {(p) => <input {...p} name={FIN_FIELD.holderName} defaultValue={f.v(FIN_FIELD.holderName, latest?.holderName ?? '')} maxLength={120} autoComplete="off" required />}
            </Field>
            <Field label="Bank name" error={f.err(FIN_FIELD.bankName)}>
              {(p) => <input {...p} name={FIN_FIELD.bankName} defaultValue={f.v(FIN_FIELD.bankName, latest?.bankName ?? '')} maxLength={120} autoComplete="off" required />}
            </Field>
            <Field label="Account number" hint="9 to 18 digits. Leading zeros are kept." error={f.err(FIN_FIELD.accountNumber)}>
              {(p) => (
                <input {...p} name={FIN_FIELD.accountNumber} defaultValue={f.v(FIN_FIELD.accountNumber)} inputMode="numeric" maxLength={24} spellCheck={false} autoComplete="off" required />
              )}
            </Field>
            <Field label="IFSC" hint="11 characters, like ABCD0123456." error={f.err(FIN_FIELD.ifsc)}>
              {(p) => (
                <input {...p} name={FIN_FIELD.ifsc} defaultValue={f.v(FIN_FIELD.ifsc, latest?.ifsc ?? '')} maxLength={11} autoCapitalize="characters" spellCheck={false} autoComplete="off" required />
              )}
            </Field>
          </div>
        </fieldset>
      ) : kind === 'upi' ? (
        <fieldset className="group">
          <legend>UPI details</legend>
          <div className="form-grid">
            <Field label="Payee name" hint="The name the UPI app shows when paying." error={f.err(FIN_FIELD.payeeName)}>
              {(p) => <input {...p} name={FIN_FIELD.payeeName} defaultValue={f.v(FIN_FIELD.payeeName, latest?.payeeName ?? '')} maxLength={120} autoComplete="off" required />}
            </Field>
            <Field label="UPI ID" hint="Like name@bank." error={f.err(FIN_FIELD.upiId)}>
              {(p) => <input {...p} name={FIN_FIELD.upiId} defaultValue={f.v(FIN_FIELD.upiId)} maxLength={321} autoCapitalize="none" spellCheck={false} autoComplete="off" required />}
            </Field>
          </div>
        </fieldset>
      ) : (
        <p className="hint">Choose bank account or UPI ID to see the details to enter.</p>
      )}

      <p id={`${base}-help`} className="hint">
        Submitting sends this exact version for approval by a different Accounts person. {DESTINATION_SCOPE_TEXT}
      </p>
      <SubmitButton pendingLabel="Submitting…" describedBy={`${base}-help`}>
        {replacing ? 'Submit new details for approval' : 'Submit for approval'}
      </SubmitButton>
    </form>
  );
}

function DecisionIds({ version, destination, requestId }: { version: DestinationVersionView; destination: CompanyDestinationView; requestId: string }) {
  return (
    <>
      <RequestId id={requestId} />
      <input type="hidden" name={FIN_FIELD.versionId} value={version.versionId} />
      <input type="hidden" name={FIN_FIELD.expectedRowVersion} value={destination.rowVersion} />
    </>
  );
}

/** Approve and return for the open version, or the reason this viewer cannot. */
export function DestinationDecisionForms({
  destination,
  version,
  actions,
}: {
  destination: CompanyDestinationView;
  version: DestinationVersionView;
  actions: Pick<FinanceActions, 'approveDestinationAction' | 'returnDestinationAction'>;
}) {
  const a = useFinanceForm(actions.approveDestinationAction);
  const r = useFinanceForm(actions.returnDestinationAction);
  const block = destination.actions.decide;
  const retired = destination.state === 'retired';
  const name = `version ${version.versionNo} of ${destination.label}`;
  if (block !== null) {
    const reasonId = `dest-decide-${version.versionId}`;
    const reason = block === 'own_record' ? DESTINATION_OWN_VERSION_TEXT : 'This version can no longer be approved or returned. Reload the page to see the latest state.';
    return (
      <div className="fin-actions" role="group" aria-label={`Decision on ${name}`}>
        <div className="fin-unavailable">
          <button type="button" className="button secondary small" aria-disabled="true" aria-describedby={reasonId}>
            Approve version {version.versionNo}
          </button>
          <button type="button" className="button secondary small" aria-disabled="true" aria-describedby={reasonId}>
            Return version {version.versionNo}
          </button>
          <BlockedReason id={reasonId}>{reason}</BlockedReason>
        </div>
      </div>
    );
  }
  const helpId = `dest-approve-help-${version.versionId}`;
  return (
    <div className="fin-actions" role="group" aria-label={`Decision on ${name}`}>
      {retired ? (
        <UnavailableButton label={`Approve version ${version.versionNo}`} reason="This account is retired, so this version can only be returned." />
      ) : (
        <form key={a.formKey} action={a.formAction} noValidate className="fin-inline-form" aria-label={`Approve ${name}`}>
          <DecisionIds version={version} destination={destination} requestId={a.requestId} />
          <p id={helpId} className="hint mb-0">
            Check the full details first. Approving makes this exact version the one new receipts select
            {destination.current ? `; version ${destination.current.versionNo} stays in the history` : ''}. {DESTINATION_SCOPE_TEXT}
          </p>
          <SubmitButton pendingLabel="Approving…" describedBy={helpId}>
            Approve version {version.versionNo}
            <span className="visually-hidden"> of {destination.label}</span>
          </SubmitButton>
          <FinanceResult state={a.state} />
        </form>
      )}
      <details className="form-section work-form fin-action-form" open={r.state.status === 'error' || undefined}>
        <summary>
          <span className="form-section-title">
            Return version {version.versionNo} with a reason<span className="visually-hidden"> for {destination.label}</span>
          </span>
        </summary>
        <form key={r.formKey} action={r.formAction} noValidate aria-label={`Return ${name}`}>
          <FinanceResult state={r.state} />
          <DecisionIds version={version} destination={destination} requestId={r.requestId} />
          <p className="hint">The maker then submits a corrected version. Nothing changes for receipts.</p>
          <Field label="Reason" hint="10 to 500 characters. Say what must be corrected, without typing the account number or UPI ID." error={r.err(FIN_FIELD.reason)} wide>
            {(p) => <textarea {...p} name={FIN_FIELD.reason} defaultValue={r.v(FIN_FIELD.reason)} minLength={10} maxLength={500} rows={2} required />}
          </Field>
          <SubmitButton pendingLabel="Returning…" variant="secondary">
            Return version {version.versionNo}
          </SubmitButton>
        </form>
      </details>
    </div>
  );
}

export function RetireDestinationForm({ destination, action }: { destination: CompanyDestinationView; action: FinanceAction }) {
  const f = useFinanceForm(action);
  return (
    <details className="form-section work-form fin-action-form" open={f.state.status === 'error' || undefined}>
      <summary>
        <span className="form-section-title">
          Retire this account<span className="visually-hidden"> {destination.label}</span>
        </span>
      </summary>
      <form key={f.formKey} action={f.formAction} noValidate aria-label={`Retire ${destination.label}`}>
        <FinanceResult state={f.state} />
        <RequestId id={f.requestId} />
        <input type="hidden" name={FIN_FIELD.destinationId} value={destination.destinationId} />
        <input type="hidden" name={FIN_FIELD.expectedRowVersion} value={destination.rowVersion} />
        <div className="note warn" role="note">
          <p className="mb-0">
            Takes effect now and cannot be undone. New receipts cannot use it. Earlier receipts keep their record of it. To use an account again, add it as a new
            company account and have it approved.
          </p>
        </div>
        <Field label="Reason" hint="10 to 500 characters. Kept in the history." error={f.err(FIN_FIELD.reason)} wide>
          {(p) => <textarea {...p} name={FIN_FIELD.reason} defaultValue={f.v(FIN_FIELD.reason)} minLength={10} maxLength={500} rows={2} required />}
        </Field>
        <SubmitButton pendingLabel="Retiring…" variant="danger">
          Retire account
        </SubmitButton>
      </form>
    </details>
  );
}

const HIDE_INTENT = 'hide';

/**
 * "Show full details": a POST to the audited read. The values exist only in
 * this component's action state from that response; they are never put in a
 * URL, title or message. "Hide details" resets that state to idle on the
 * client (no server call), so the values leave both the page and memory.
 */
export function ShowDestinationDetailForm({
  kind,
  version,
  destinationLabel,
  action,
}: {
  kind: DestinationKind;
  version: DestinationVersionView;
  destinationLabel: string;
  action: DestinationDetailAction;
}) {
  const [state, formAction] = useActionState(
    (prev: DestinationDetailState, formData: FormData): DestinationDetailState | Promise<DestinationDetailState> =>
      formData.get('intent') === HIDE_INTENT ? { status: 'idle' } : action(prev, formData),
    { status: 'idle' } as DestinationDetailState,
  );
  const helpId = `dest-show-help-${version.versionId}`;
  const shown = state.status === 'ok' ? state.detail : null;
  return (
    <div>
      {shown ? (
        <>
          <dl className="facts" aria-label={`Full details of version ${version.versionNo}`}>
            {kind === 'bank' ? (
              <>
                <dt>Account holder</dt>
                <dd>{shown.holderName ?? '—'}</dd>
                <dt>Bank</dt>
                <dd>{shown.bankName ?? '—'}</dd>
                <dt>Account number</dt>
                <dd className="fin-mono">{shown.accountNumber}</dd>
                <dt>IFSC</dt>
                <dd className="fin-mono">{shown.ifsc ?? '—'}</dd>
              </>
            ) : (
              <>
                <dt>Payee name</dt>
                <dd>{shown.payeeName ?? '—'}</dd>
                <dt>UPI ID</dt>
                <dd className="fin-mono">{shown.upiId ?? '—'}</dd>
              </>
            )}
          </dl>
          <form action={formAction} className="fin-inline-form" aria-label={`Hide full details of version ${version.versionNo} of ${destinationLabel}`}>
            <input type="hidden" name="intent" value={HIDE_INTENT} />
            <button type="submit" className="button secondary small">
              Hide details<span className="visually-hidden"> of version {version.versionNo}</span>
            </button>
          </form>
        </>
      ) : (
        <form action={formAction} className="fin-inline-form" aria-label={`Show full details of version ${version.versionNo} of ${destinationLabel}`}>
          <input type="hidden" name={FIN_FIELD.versionId} value={version.versionId} />
          <p id={helpId} className="hint mb-0">
            Opening the full details is recorded with your name and the time.
          </p>
          <SubmitButton pendingLabel="Opening…" variant="secondary" describedBy={helpId}>
            Show full details<span className="visually-hidden"> of version {version.versionNo}</span>
          </SubmitButton>
        </form>
      )}
      {state.status === 'error' ? (
        <div className="message error" role="alert">
          <strong>Not shown: </strong>
          {state.message}
        </div>
      ) : null}
    </div>
  );
}
