'use client';

import { unstable_rethrow } from 'next/navigation';
import { type ReactNode, useActionState, useId, useState } from 'react';
import { SubmitButton } from '@/components/SubmitButton';
import {
  FINANCE_ERROR_TEXT,
  type DestinationVersionDetail,
  FINANCE_EVIDENCE_MAX_BYTES,
  FINANCE_EVIDENCE_MIME,
  type FinancePolicyPage,
} from '@/modules/finance/contracts';
import { BlockedReason, formatInr, paiseToRupeesField } from './finance-common';

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

/*
 * This file holds the shared form plumbing (action types, field names,
 * useFinanceForm, Field, result and unavailable-button parts, evidence file
 * limits) and the finance policy form. Receipt forms live in
 * finance-receipt-forms.tsx, cash custody and company account forms in
 * finance-cash-forms.tsx. finance-forms.tsx re-exports the public parts.
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

export function useFinanceForm(action: FinanceAction, initial?: FinanceActionState | null) {
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

export function RequestId({ id }: { id: string }) {
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
export function Field({
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

export const ACCEPT = FINANCE_EVIDENCE_MIME.join(',');
const MAX_MB = FINANCE_EVIDENCE_MAX_BYTES / (1024 * 1024);
export const FILE_HINT = `PDF, JPG, PNG or WebP, up to ${MAX_MB} MB. Kept private; only Accounts can open it.`;

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
