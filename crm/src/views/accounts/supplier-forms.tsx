'use client';

import { unstable_rethrow } from 'next/navigation';
import { useActionState, useId, useState } from 'react';
import { HandForm, useHandFormStatus, useSavedKey } from '@/components/hand-form';
import { Button } from '@/components/ui/button';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  PAYMENT_MODE_LABEL,
  RECORD_PAYMENT_DIALOG_TEXT,
  SM_FIELD,
  SUPPLIER_MONEY_FILE_HINT,
  SUPPLIER_MONEY_MIME,
  SUPPLIER_MONEY_UNKNOWN_OUTCOME_TEXT,
  SUPPLIER_PAYMENT_MODES,
  type SupplierPaymentMode,
} from '@/modules/supplier-money/contracts';

/*
 * Client forms for the Accounts supplier pages and the Manager's Approvals
 * page (Purchase build, Track C). Every form gets its server action as a
 * prop (the route passes the real 'use server' action; the preview gallery
 * passes a stub), so these files never import server code. Each write
 * carries one request id per form, renewed only after a confirmed success,
 * so a double press or a retry after a lost reply is the same request.
 * Refusals keep what was typed (HandForm is never reset).
 */

/** The shape every Purchase-build action returns (procurement and supplier-money results both fit). */
export type DecisionResult =
  | { ok: true; message: string; data?: unknown }
  | { ok: false; code: string; message: string; values?: Record<string, string> };

/** A server action (prev, formData) => result. Typed loosely on `prev` so any module's action fits. */
export type DecisionAction = (prev: never, formData: FormData) => Promise<DecisionResult>;

export type UiResult = DecisionResult | { ok: false; code: 'unexpected'; message: string };

export function guard(action: DecisionAction) {
  return async (_prev: UiResult | null, formData: FormData): Promise<UiResult> => {
    try {
      return await action(null as never, formData);
    } catch (error) {
      unstable_rethrow(error);
      return { ok: false, code: 'unexpected', message: SUPPLIER_MONEY_UNKNOWN_OUTCOME_TEXT };
    }
  };
}

/** One request id per form; a new one only after a confirmed success. */
export function useRequestId(state: UiResult | null): string {
  const [id, setId] = useState(() => crypto.randomUUID());
  const [seen, setSeen] = useState(state);
  if (state !== seen) {
    setSeen(state);
    if (state?.ok) setId(crypto.randomUUID());
  }
  return id;
}

export function ResultLine({ state }: { state: UiResult | null }) {
  if (!state) return <div role="status" aria-live="polite" />;
  return state.ok ? (
    <Notice tone="success" role="status">
      <p>
        <strong>Done: </strong>
        {state.message}
      </p>
    </Notice>
  ) : (
    <Notice tone="danger" role="alert">
      <p>
        <strong>Not saved: </strong>
        {state.message}
      </p>
    </Notice>
  );
}

export function Hidden({ fields }: { fields: Record<string, string | number> }) {
  return (
    <>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={String(value)} />
      ))}
    </>
  );
}

export function Submit({ label, pendingLabel, variant = 'primary', name, value, describedBy }: { label: string; pendingLabel: string; variant?: 'primary' | 'secondary' | 'danger'; name?: string; value?: string; describedBy?: string }) {
  const { pending, data } = useHandFormStatus();
  const mine = pending && (!name || data?.get(name) === value);
  return (
    <Button
      type="submit"
      variant={variant}
      name={name}
      value={value}
      aria-disabled={pending || undefined}
      aria-describedby={describedBy}
      onClick={(e) => {
        if (pending) e.preventDefault();
      }}
    >
      {mine ? pendingLabel : label}
    </Button>
  );
}

/** A button shown but not usable now: stays focusable, says why in one short line. */
export function UnavailableAction({ label, reason }: { label: string; reason: string }) {
  const id = useId();
  return (
    <div className="flex flex-col items-start gap-1">
      <Button type="button" variant="secondary" aria-disabled="true" aria-describedby={id} onClick={(e) => e.preventDefault()}>
        {label}
      </Button>
      <p id={id} className="m-0 text-sm text-quiet">
        {reason}
      </p>
    </div>
  );
}

/**
 * Approve or return, in one form. "Return" needs a reason (10–500
 * characters); approve sends no reason. The pressed button is the decision.
 */
export function DecisionForm({
  action,
  fields,
  approveLabel,
  returnLabel,
  approveHelp,
  reasonLabel = 'Reason for returning',
  reasonHint = 'Required to return: 10 to 500 characters. The requester reads it.',
  decisionField = 'decision',
  reasonField = 'reason',
  requestIdField = 'requestId',
  label,
  approveBlockedReason,
  approveValue = 'approve',
}: {
  action: DecisionAction;
  /** Hidden fields (ids and row versions). */
  fields: Record<string, string | number>;
  approveLabel: string;
  returnLabel: string;
  approveHelp?: string;
  reasonLabel?: string;
  reasonHint?: string;
  decisionField?: string;
  reasonField?: string;
  requestIdField?: string;
  /** Accessible name of the form, e.g. "Decide go-ahead for SYN-DEL-001". */
  label: string;
  /** Approve is not possible now (return still is): the button stays focusable with this one-line reason. */
  approveBlockedReason?: string;
  /** Value the approve button posts in `decisionField` (default 'approve'). */
  approveValue?: string;
}) {
  const [state, run] = useActionState(guard(action), null);
  const requestId = useRequestId(state);
  const blockedId = useId();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const base = useId();
  const reasonId = `${base}-reason`;
  const helpId = `${base}-help`;
  if (state?.ok) {
    return <ResultLine state={state} />;
  }
  return (
    <HandForm
      action={run}
      noValidate
      aria-label={label}
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        const submitter = (e.nativeEvent as globalThis.SubmitEvent).submitter as HTMLButtonElement | null;
        if (submitter?.value === 'return') {
          const len = reason.trim().length;
          if (len < 10 || len > 500) {
            e.preventDefault();
            setProblem('Write a reason of 10 to 500 characters before returning.');
            document.getElementById(reasonId)?.focus();
            return;
          }
        }
        setProblem(null);
      }}
    >
      <ResultLine state={state} />
      <Hidden fields={{ ...fields, [requestIdField]: requestId }} />
      {approveHelp ? (
        <p id={helpId} className="m-0 text-sm text-quiet">
          {approveHelp}
        </p>
      ) : null}
      <Field htmlFor={reasonId} label={reasonLabel} hint={reasonHint} error={problem} optional>
        <Textarea
          id={reasonId}
          name={reasonField}
          rows={2}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          invalid={!!problem}
          aria-describedby={fieldDescribedBy(reasonId, { hint: reasonHint, error: problem })}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        {approveBlockedReason ? (
          <Button type="button" variant="primary" aria-disabled="true" aria-describedby={blockedId} onClick={(e) => e.preventDefault()}>
            {approveLabel}
          </Button>
        ) : (
          <Submit label={approveLabel} pendingLabel="Saving…" name={decisionField} value={approveValue} describedBy={approveHelp ? helpId : undefined} />
        )}
        <Submit label={returnLabel} pendingLabel="Returning…" variant="secondary" name={decisionField} value="return" />
      </div>
      {approveBlockedReason ? (
        <p id={blockedId} className="m-0 text-sm text-quiet">
          {approveBlockedReason}
        </p>
      ) : null}
    </HandForm>
  );
}

/** One button plus an optional note (verify a payment, mark funding recovered). */
export function SingleActionForm({
  action,
  fields,
  submitLabel,
  pendingLabel = 'Saving…',
  help,
  note,
  label,
  variant = 'primary',
}: {
  action: DecisionAction;
  fields: Record<string, string | number>;
  submitLabel: string;
  pendingLabel?: string;
  help?: string;
  /** A required note field, e.g. how the company money was recovered. */
  note?: { name: string; label: string; hint: string; min: number; max: number };
  label: string;
  variant?: 'primary' | 'secondary';
}) {
  const [state, run] = useActionState(guard(action), null);
  const requestId = useRequestId(state);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const base = useId();
  if (state?.ok) return <ResultLine state={state} />;
  return (
    <HandForm
      action={run}
      noValidate
      aria-label={label}
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        if (note) {
          const len = text.trim().length;
          if (len < note.min || len > note.max) {
            e.preventDefault();
            setProblem(`Write ${note.min} to ${note.max} characters.`);
            document.getElementById(`${base}-note`)?.focus();
            return;
          }
        }
        setProblem(null);
      }}
    >
      <ResultLine state={state} />
      <Hidden fields={{ ...fields, requestId }} />
      {help ? (
        <p id={`${base}-help`} className="m-0 text-sm text-quiet">
          {help}
        </p>
      ) : null}
      {note ? (
        <Field htmlFor={`${base}-note`} label={note.label} hint={note.hint} error={problem}>
          <Textarea
            id={`${base}-note`}
            name={note.name}
            rows={2}
            maxLength={note.max}
            value={text}
            onChange={(e) => setText(e.target.value)}
            invalid={!!problem}
            aria-describedby={fieldDescribedBy(`${base}-note`, { hint: note.hint, error: problem })}
          />
        </Field>
      ) : null}
      <div>
        <Submit label={submitLabel} pendingLabel={pendingLabel} variant={variant} describedBy={help ? `${base}-help` : undefined} />
      </div>
    </HandForm>
  );
}

const PROOF_ACCEPT = SUPPLIER_MONEY_MIME.join(',');

/**
 * Accounts records a payment: upload the payment proof first (its own
 * action returns the evidence id), then record paid on, mode and bank
 * reference against it. A refused record keeps the uploaded proof, so a
 * retry does not upload it twice. Confirmation text says the CRM sends no
 * money.
 */
export function RecordPaymentForm({
  paymentId,
  taskId,
  rowVersion,
  recordAction,
  uploadAction,
  today,
}: {
  paymentId: string;
  taskId: string;
  rowVersion: number;
  recordAction: DecisionAction;
  uploadAction: DecisionAction;
  /** YYYY-MM-DD, the latest date allowed for "Paid on". */
  today: string;
}) {
  const [proofId, setProofId] = useState<string | null>(null);
  // The upload is its own command: its own request id, kept for the life of the form.
  const [uploadRequestId] = useState(() => crypto.randomUUID());
  const [state, run] = useActionState(async (prev: UiResult | null, formData: FormData): Promise<UiResult> => {
    let evidenceId = proofId;
    if (!evidenceId) {
      const file = formData.get(SM_FIELD.file);
      if (!(file instanceof File) || file.size === 0) return { ok: false, code: 'invalid_input', message: 'Choose the payment proof file first.' };
      const up = new FormData();
      // The payment proof belongs to the payment request: the upload command needs its id (taskId is for the page).
      up.set(SM_FIELD.paymentId, paymentId);
      up.set(SM_FIELD.taskId, taskId);
      up.set(SM_FIELD.kind, 'payment_proof');
      up.set(SM_FIELD.file, file);
      up.set(SM_FIELD.requestId, uploadRequestId);
      const uploaded = await guard(uploadAction)(prev, up);
      if (!uploaded.ok) return uploaded;
      const data = (uploaded as { data?: { evidenceId?: string } }).data;
      if (!data?.evidenceId) return { ok: false, code: 'unexpected', message: SUPPLIER_MONEY_UNKNOWN_OUTCOME_TEXT };
      evidenceId = data.evidenceId;
      setProofId(evidenceId);
    }
    formData.set(SM_FIELD.proofEvidenceId, evidenceId);
    formData.delete(SM_FIELD.file);
    return guard(recordAction)(prev, formData);
  }, null);
  const requestId = useRequestId(state);
  const savedKey = useSavedKey(state && state.ok ? state : null);
  const [mode, setMode] = useState<SupplierPaymentMode>('bank_transfer');
  const base = useId();
  const T = RECORD_PAYMENT_DIALOG_TEXT;
  if (state?.ok) return <ResultLine state={state} />;
  return (
    <HandForm action={run} noValidate aria-label={T.title} className="flex flex-col gap-3" encType="multipart/form-data">
      <ResultLine state={state} />
      <Hidden fields={{ [SM_FIELD.paymentId]: paymentId, [SM_FIELD.expectedRowVersion]: rowVersion, [SM_FIELD.requestId]: requestId }} />
      <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-sm text-copy">
        {T.body.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field htmlFor={`${base}-paid`} label="Paid on">
          <Input id={`${base}-paid`} type="date" name={SM_FIELD.paidOn} max={today} required />
        </Field>
        <Field htmlFor={`${base}-mode`} label="How it was paid">
          <Select id={`${base}-mode`} name={SM_FIELD.paymentMode} value={mode} onChange={(e) => setMode(e.target.value as SupplierPaymentMode)}>
            {SUPPLIER_PAYMENT_MODES.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_MODE_LABEL[m]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field htmlFor={`${base}-ref`} label={mode === 'cheque' ? 'Cheque number' : 'Bank reference (UTR)'} hint="Exactly as on the bank statement.">
        <Input id={`${base}-ref`} name={SM_FIELD.bankReference} maxLength={60} required autoComplete="off" spellCheck={false} aria-describedby={`${base}-ref-hint`} />
      </Field>
      {proofId ? (
        <Notice tone="success" role="status">
          <p>Payment proof uploaded. Press “{T.confirmLabel}” again to finish.</p>
        </Notice>
      ) : (
        <Field htmlFor={`${base}-proof`} label="Payment proof" hint={SUPPLIER_MONEY_FILE_HINT}>
          <input key={savedKey} id={`${base}-proof`} name={SM_FIELD.file} type="file" accept={PROOF_ACCEPT} required aria-describedby={`${base}-proof-hint`} className="block w-full text-base" />
        </Field>
      )}
      <div>
        <Submit label={T.confirmLabel} pendingLabel="Recording…" />
      </div>
    </HandForm>
  );
}
