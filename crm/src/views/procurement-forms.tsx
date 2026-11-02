'use client';

import { unstable_rethrow } from 'next/navigation';
import Link from 'next/link';
import { useActionState, useState } from 'react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SubmitButton } from '@/components/SubmitButton';
import { HandForm, useSavedKey } from '@/components/hand-form';
import { EVIDENCE_MIME_TYPES } from '@/modules/fulfilment/contracts';
import { paiseToRupeesInput } from '@/modules/fulfilment/forms';
import {
  A1_TEXT,
  PROCUREMENT_ISSUE_TEXT,
  PURCHASE_FILE_HINT,
  PROCUREMENT_UNKNOWN_OUTCOME_TEXT,
  type ProcurementActionResult,
  type ProcurementIssueCode,
  PURCHASE_EVIDENCE_KIND_LABEL,
  type PurchaseEvidenceKind,
  SERVICE_TYPE_LABEL,
  SUPPLIER_CONFIRM_DIALOG_TEXT,
  type SupplierDetailView,
  type SupplierServiceType,
} from '@/modules/procurement/contracts';
import { PFIELD } from '@/modules/procurement/forms';
import { useKeepValuesOnFailure } from './keep-form-values';
import {
  addBeneficiaryAction,
  addQuoteAction,
  approveBeneficiaryAction,
  approveOverBudgetAction,
  reassignTaskAction,
  releaseTaskAction,
  verifySupplierAction,
  confirmSupplierAction,
  createSupplierAction,
  proposeCostAction,
  removePurchaseEvidenceAction,
  updateSupplierAction,
  uploadPurchaseEvidenceAction,
  withdrawQuoteAction,
} from '@/modules/procurement/server/actions';

/*
 * Purchase work forms (Phase 4). Every write carries a request id generated
 * once per form: a double click or a retry after a lost response reuses it,
 * so the database returns the same row instead of creating a second one. The
 * id is renewed only after a confirmed success.
 */

export const UNEXPECTED_TEXT = `${PROCUREMENT_UNKNOWN_OUTCOME_TEXT} Your typed details are still here.`;

export type ProcUiResult =
  | ProcurementActionResult<unknown>
  | { ok: false; code: 'unexpected'; message: string; values?: Record<string, string> };

/**
 * A thrown (unknown-outcome) failure has no server reply, so the typed
 * supplier reference is taken from the submitted form instead. A result that
 * already carries the server's echo is returned unchanged.
 */
export function keepSubmittedReference(result: ProcUiResult, formData: FormData): ProcUiResult {
  if (result.ok || result.values) return result;
  const typed = formData.get(PFIELD.reference);
  return { ...result, values: { reference: typeof typed === 'string' ? typed.slice(0, 120) : '' } };
}

function guard<T>(action: (prev: never, formData: FormData) => Promise<ProcurementActionResult<T>>) {
  return async (_prev: ProcUiResult | null, formData: FormData): Promise<ProcUiResult> => {
    try {
      return (await action(null as never, formData)) as ProcUiResult;
    } catch (error) {
      unstable_rethrow(error);
      return { ok: false, code: 'unexpected', message: UNEXPECTED_TEXT };
    }
  };
}

export function ProcResultMessage({ result, issues }: { result: ProcUiResult | null; issues?: ProcurementIssueCode[] }) {
  if (result && !result.ok) {
    return (
      <div className="message error" role="alert">
        <strong>Error: </strong>
        {result.message}
        {result.code === 'not_ready' && issues && issues.length > 0 ? (
          <ul className="mt-1 mb-0">
            {issues.map((code) => (
              <li key={code}>{PROCUREMENT_ISSUE_TEXT[code]}</li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }
  if (result?.ok) {
    return (
      <div className="message success" role="status">
        <strong>Done: </strong>
        {result.message}
      </div>
    );
  }
  return <div role="status" aria-live="polite" />;
}

/** One request id per form; renewed after a confirmed success so the next submit is a new row. */
function useRequestId(state: ProcUiResult | null): string {
  const [id, setId] = useState(() => crypto.randomUUID());
  const [seen, setSeen] = useState(state);
  // Derived during render (React's "store information from previous renders" pattern).
  if (state !== seen) {
    setSeen(state);
    if (state?.ok) setId(crypto.randomUUID());
  }
  return id;
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

const SERVICE_TYPES = Object.keys(SERVICE_TYPE_LABEL) as SupplierServiceType[];

function SupplierFieldset({ supplier, idPrefix }: { supplier?: SupplierDetailView; idPrefix: string }) {
  const id = (name: string) => `${idPrefix}-${name}`;
  return (
    <>
      <div className="form-grid">
        <div className="field">
          <label htmlFor={id('name')}>Supplier name</label>
          <input id={id('name')} name={PFIELD.name} defaultValue={supplier?.name} maxLength={200} required autoComplete="organization" />
        </div>
        <div className="field">
          <label htmlFor={id('city')}>City</label>
          <input id={id('city')} name={PFIELD.city} defaultValue={supplier?.city ?? ''} maxLength={120} autoComplete="off" />
        </div>
      </div>
      <fieldset className="group">
        <legend>Services they supply</legend>
        <div className="choice-row">
          {SERVICE_TYPES.map((t) => (
            <label key={t} className="choice">
              <input type="checkbox" name={PFIELD.serviceTypes} value={t} defaultChecked={supplier ? supplier.serviceTypes.includes(t) : t === 'hotel'} />{' '}
              {SERVICE_TYPE_LABEL[t]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="form-grid">
        <div className="field">
          <label htmlFor={id('contact')}>Contact person</label>
          <input id={id('contact')} name={PFIELD.contactName} defaultValue={supplier?.contactName ?? ''} maxLength={120} autoComplete="off" />
        </div>
        <div className="field">
          <label htmlFor={id('phone')}>Phone</label>
          <input id={id('phone')} name={PFIELD.contactPhone} type="tel" inputMode="tel" defaultValue={supplier?.contactPhone ?? ''} maxLength={40} autoComplete="off" />
        </div>
        <div className="field">
          <label htmlFor={id('email')}>Email</label>
          <input id={id('email')} name={PFIELD.contactEmail} type="email" inputMode="email" defaultValue={supplier?.contactEmail ?? ''} maxLength={254} autoComplete="off" />
        </div>
      </div>
      <div className="field">
        <label htmlFor={id('terms')}>Payment terms</label>
        <span id={id('terms-hint')} className="hint">
          What the supplier told you, in your words. Recording terms does not schedule any payment.
        </span>
        <textarea id={id('terms')} name={PFIELD.paymentTerms} defaultValue={supplier?.paymentTerms ?? ''} maxLength={1000} rows={3} aria-describedby={id('terms-hint')} />
      </div>
    </>
  );
}

export function CreateSupplierForm({ entities }: { entities: Array<{ id: string; name: string }> }) {
  const [state, action] = useActionState(guard(createSupplierAction), null);
  const keepValues = useKeepValuesOnFailure(state);
  return (
    <form onSubmit={keepValues} action={action} noValidate aria-label="Add a supplier">
      <ProcResultMessage result={state} />
      {entities.length === 1 ? (
        <input type="hidden" name={PFIELD.entityId} value={entities[0]!.id} />
      ) : (
        <div className="field">
          <label htmlFor="supplier-entity">Company</label>
          <select id="supplier-entity" name={PFIELD.entityId} required>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <SupplierFieldset idPrefix="new-supplier" />
      <SubmitButton pendingLabel="Adding…">Add supplier</SubmitButton>
    </form>
  );
}

export function EditSupplierForm({ supplier }: { supplier: SupplierDetailView }) {
  const [state, action] = useActionState(guard(updateSupplierAction), null);
  const keepValues = useKeepValuesOnFailure(state);
  return (
    <form onSubmit={keepValues} action={action} noValidate aria-label="Edit supplier">
      <ProcResultMessage result={state} />
      <input type="hidden" name={PFIELD.supplierId} value={supplier.supplierId} />
      <input type="hidden" name={PFIELD.rowVersion} value={supplier.rowVersion} />
      <SupplierFieldset supplier={supplier} idPrefix="edit-supplier" />
      <div className="field">
        <label htmlFor="edit-supplier-status">Status</label>
        <select id="edit-supplier-status" name={PFIELD.status} defaultValue={supplier.status}>
          <option value="active">Active · can be chosen for new offers</option>
          <option value="archived">Archived · kept for history only</option>
        </select>
      </div>
      <SubmitButton pendingLabel="Saving…">Save supplier</SubmitButton>
    </form>
  );
}

export function AddBeneficiaryForm({ supplierId }: { supplierId: string }) {
  const [state, action] = useActionState(guard(addBeneficiaryAction), null);
  const keepValues = useKeepValuesOnFailure(state);
  const requestId = useRequestId(state);
  return (
    <form onSubmit={keepValues} key={requestId} action={action} noValidate aria-label="Record bank details" autoComplete="off">
      <ProcResultMessage result={state} />
      <input type="hidden" name={PFIELD.supplierId} value={supplierId} />
      <input type="hidden" name={PFIELD.requestId} value={requestId} />
      <div className="form-grid">
        <div className="field">
          <label htmlFor="ben-holder">Account holder</label>
          <input id="ben-holder" name={PFIELD.accountHolder} maxLength={120} required />
        </div>
        <div className="field">
          <label htmlFor="ben-bank">Bank</label>
          <input id="ben-bank" name={PFIELD.bankName} maxLength={120} required />
        </div>
        <div className="field">
          <label htmlFor="ben-ifsc">IFSC</label>
          <input id="ben-ifsc" name={PFIELD.ifsc} maxLength={11} required autoCapitalize="characters" spellCheck={false} />
        </div>
        <div className="field">
          <label htmlFor="ben-account">Account number</label>
          <span id="ben-account-hint" className="hint">
            Only the last 4 digits are shown afterwards.
          </span>
          <input id="ben-account" name={PFIELD.accountNumber} inputMode="numeric" maxLength={18} required aria-describedby="ben-account-hint" spellCheck={false} />
        </div>
      </div>
      <SubmitButton pendingLabel="Recording…" variant="secondary">
        Record bank details
      </SubmitButton>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Task work
// ---------------------------------------------------------------------------

export function AddQuoteForm({
  taskId,
  suppliers,
  defaultHotelName,
}: {
  taskId: string;
  suppliers: Array<{ supplierId: string; name: string }>;
  defaultHotelName: string;
}) {
  const [state, action] = useActionState(guard(addQuoteAction), null);
  const keepValues = useKeepValuesOnFailure(state);
  const requestId = useRequestId(state);
  if (suppliers.length === 0) {
    return (
      <p className="note info">
        No active hotel supplier yet. <Link href="/app/purchase/suppliers">Add a supplier</Link> first, then come back.
      </p>
    );
  }
  return (
    <form onSubmit={keepValues} key={requestId} action={action} noValidate aria-label="Add a supplier offer">
      <ProcResultMessage result={state} />
      <input type="hidden" name={PFIELD.taskId} value={taskId} />
      <input type="hidden" name={PFIELD.requestId} value={requestId} />
      <div className="form-grid">
        <div className="field">
          <label htmlFor="quote-supplier">Supplier</label>
          <select id="quote-supplier" name={PFIELD.supplierId} required>
            {suppliers.map((s) => (
              <option key={s.supplierId} value={s.supplierId}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="quote-hotel">Hotel offered</label>
          <input id="quote-hotel" name={PFIELD.hotelName} defaultValue={defaultHotelName} maxLength={200} required />
        </div>
        <div className="field">
          <label htmlFor="quote-room">Room type</label>
          <input id="quote-room" name={PFIELD.roomType} maxLength={120} />
        </div>
        <div className="field">
          <label htmlFor="quote-meal">Meal plan</label>
          <input id="quote-meal" name={PFIELD.mealPlan} maxLength={60} />
        </div>
        <div className="field">
          <label htmlFor="quote-cost">Supplier price for the stay (₹)</label>
          <input id="quote-cost" name={PFIELD.quotedCostRupees} inputMode="decimal" required />
        </div>
        <div className="field">
          <label htmlFor="quote-hold">Held until</label>
          <span id="quote-hold-hint" className="hint">
            Leave empty if the supplier is not holding rooms.
          </span>
          <input id="quote-hold" name={PFIELD.holdUntil} type="date" aria-describedby="quote-hold-hint" />
        </div>
      </div>
      <div className="field">
        <label htmlFor="quote-cancel">Cancellation terms</label>
        <textarea id="quote-cancel" name={PFIELD.cancellationTerms} maxLength={2000} rows={2} />
      </div>
      <SubmitButton pendingLabel="Adding…" variant="secondary">
        Add offer
      </SubmitButton>
    </form>
  );
}

export function WithdrawQuoteForm({ taskId, quoteId, label }: { taskId: string; quoteId: string; label: string }) {
  const [state, action] = useActionState(guard(withdrawQuoteAction), null);
  return (
    <form action={action} noValidate>
      <input type="hidden" name={PFIELD.taskId} value={taskId} />
      <input type="hidden" name={PFIELD.quoteId} value={quoteId} />
      <SubmitButton pendingLabel="Withdrawing…" variant="secondary">
        Withdraw<span className="visually-hidden"> offer from {label}</span>
      </SubmitButton>
      {state && !state.ok ? <ProcResultMessage result={state} /> : null}
    </form>
  );
}

export function ProposeCostForm({
  taskId,
  openQuotes,
  latestVersionNo,
  defaultQuoteId,
  defaultAmountPaise,
}: {
  taskId: string;
  openQuotes: Array<{ quoteId: string; label: string }>;
  latestVersionNo: number;
  defaultQuoteId: string | null;
  defaultAmountPaise: string | null;
}) {
  const [state, action] = useActionState(guard(proposeCostAction), null);
  const keepValues = useKeepValuesOnFailure(state);
  const requestId = useRequestId(state);
  if (openQuotes.length === 0) return <p className="note info">Add an open supplier offer before proposing a cost.</p>;
  return (
    <form onSubmit={keepValues} key={requestId} action={action} noValidate aria-label="Propose a cost">
      <ProcResultMessage result={state} />
      {state && !state.ok && state.code === 'version_changed' ? (
        <p className="mb-0">
          <Link href={`/app/purchase/${taskId}`}>Load the latest costs</Link>
        </p>
      ) : null}
      <input type="hidden" name={PFIELD.taskId} value={taskId} />
      <input type="hidden" name={PFIELD.requestId} value={requestId} />
      <input type="hidden" name={PFIELD.expectedVersionNo} value={latestVersionNo} />
      <div className="form-grid">
        <div className="field">
          <label htmlFor="cost-quote">For offer</label>
          <select id="cost-quote" name={PFIELD.quoteId} defaultValue={defaultQuoteId ?? undefined} required>
            {openQuotes.map((q) => (
              <option key={q.quoteId} value={q.quoteId}>
                {q.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="cost-amount">Agreed cost (₹)</label>
          <input id="cost-amount" name={PFIELD.amountRupees} inputMode="decimal" defaultValue={paiseToRupeesInput(defaultAmountPaise)} required />
        </div>
        <div className="field">
          <label htmlFor="cost-due">Supplier payment due</label>
          <span id="cost-due-hint" className="hint">
            For planning only. Nothing is paid or scheduled.
          </span>
          <input id="cost-due" name={PFIELD.dueDate} type="date" aria-describedby="cost-due-hint" />
        </div>
      </div>
      <div className="field">
        <label htmlFor="cost-note">Note</label>
        <textarea id="cost-note" name={PFIELD.note} maxLength={500} rows={2} />
      </div>
      <SubmitButton pendingLabel="Proposing…" variant="secondary">
        Propose cost
      </SubmitButton>
    </form>
  );
}

const ACCEPT = EVIDENCE_MIME_TYPES.join(',');

export function UploadPurchaseFileForm({ taskId, fileCount }: { taskId: string; fileCount: number }) {
  const [state, action] = useActionState(guard(uploadPurchaseEvidenceAction), null);
  const [kind, setKind] = useState<PurchaseEvidenceKind>('supplier_confirmation');
  // Submitted by hand (no React reset, so the kind stays as chosen); the file input empties after a save.
  const savedKey = useSavedKey(state);
  if (fileCount >= 10) return <p className="note info">You have uploaded the maximum of 10 files. Remove one to add another.</p>;
  return (
    <HandForm action={action} noValidate aria-label="Upload a Purchase file">
      <ProcResultMessage result={state} />
      <input type="hidden" name={PFIELD.taskId} value={taskId} />
      <div className="form-grid">
        <div className="field">
          <label htmlFor="pfile-kind">What is this file?</label>
          <select id="pfile-kind" name={PFIELD.kind} value={kind} onChange={(e) => setKind(e.target.value as PurchaseEvidenceKind)}>
            {(Object.keys(PURCHASE_EVIDENCE_KIND_LABEL) as PurchaseEvidenceKind[]).map((k) => (
              <option key={k} value={k}>
                {PURCHASE_EVIDENCE_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="pfile-file">File</label>
          <span id="pfile-file-hint" className="hint">
            {PURCHASE_FILE_HINT}
          </span>
          <input key={savedKey} id="pfile-file" name={PFIELD.file} type="file" accept={ACCEPT} aria-describedby="pfile-file-hint" required />
        </div>
      </div>
      <SubmitButton pendingLabel="Uploading…" variant="secondary">
        Upload file
      </SubmitButton>
    </HandForm>
  );
}

export function RemovePurchaseFileForm({ taskId, evidenceId, fileName }: { taskId: string; evidenceId: string; fileName: string }) {
  const [state, action] = useActionState(guard(removePurchaseEvidenceAction), null);
  return (
    <form action={action} noValidate>
      <input type="hidden" name={PFIELD.taskId} value={taskId} />
      <input type="hidden" name={PFIELD.evidenceId} value={evidenceId} />
      <SubmitButton pendingLabel="Removing…" variant="secondary">
        Remove<span className="visually-hidden"> {fileName}</span>
      </SubmitButton>
      {state && !state.ok ? <ProcResultMessage result={state} /> : null}
    </form>
  );
}

/** Shown under a refusal: the typed reference stays, and resubmitting the same reference is the same request. */
export const SUPPLIER_REFERENCE_KEPT_TEXT = 'Your reference is still in the field. Check it, fix what the message says, then record again.';

/**
 * Supplier confirmation (Milestone A §7). The reference input is controlled:
 * it keeps the typed value after a refusal or an unknown outcome (so an exact
 * retry sends the same task, version and reference) and is cleared only after
 * a confirmed success. The command and its retry identity are unchanged.
 */
export function ConfirmSupplierForm({
  taskId,
  latestVersionNo,
  issues,
  defaultOpen,
  initialState = null,
  initialReference = '',
  action: confirmAction = confirmSupplierAction,
}: {
  taskId: string;
  latestVersionNo: number;
  issues: ProcurementIssueCode[];
  defaultOpen?: boolean;
  initialState?: ProcUiResult | null;
  /** Preview gallery only: a reference already typed. */
  initialReference?: string;
  /** Preview gallery only: a stub with the same signature as confirmSupplierAction. */
  action?: typeof confirmSupplierAction;
}) {
  const confirm = guard(confirmAction);
  const [state, action] = useActionState(
    async (prev: ProcUiResult | null, formData: FormData) => keepSubmittedReference(await confirm(prev, formData), formData),
    initialState,
  );
  // Controlled: the field keeps what the user typed (also while a save is pending, so a late
  // refusal never wipes newer typing) and is cleared only by a confirmed success.
  const [reference, setReference] = useState(
    () => (initialState && !initialState.ok ? initialState.values?.reference : undefined) ?? initialReference,
  );
  const [seen, setSeen] = useState(state);
  // Derived during render (React's "store information from previous renders" pattern).
  if (state !== seen) {
    setSeen(state);
    if (state?.ok) setReference('');
  }
  const T = SUPPLIER_CONFIRM_DIALOG_TEXT;
  return (
    <ConfirmDialog
      triggerLabel="Record supplier confirmation"
      title={T.title}
      cancelLabel={T.cancelLabel}
      defaultOpen={defaultOpen || (state !== null && !state.ok)}
      body={
        <ul>
          {T.body.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      }
      renderActions={(cancel) => (
        <form action={action} noValidate>
          <ProcResultMessage result={state} issues={issues} />
          {state && !state.ok && state.code !== 'unexpected' ? <p className="hint">{SUPPLIER_REFERENCE_KEPT_TEXT}</p> : null}
          <input type="hidden" name={PFIELD.taskId} value={taskId} />
          <input type="hidden" name={PFIELD.expectedVersionNo} value={latestVersionNo} />
          <div className="field">
            <label htmlFor="supplier-ref">Supplier confirmation reference</label>
            <span id="supplier-ref-hint" className="hint">
              The number or code on the supplier’s confirmation.
            </span>
            <input
              id="supplier-ref"
              name={PFIELD.reference}
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              maxLength={120}
              required
              aria-describedby="supplier-ref-hint"
              autoComplete="off"
            />
          </div>
          <div className="dialog-actions">
            {cancel}
            <SubmitButton pendingLabel="Recording…">{T.confirmLabel}</SubmitButton>
          </div>
        </form>
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// Amendment A1 (contract §9): manager decisions, release, reassignment
// ---------------------------------------------------------------------------

/** Result line for small one-button forms: errors as alerts, success as status. */
function SmallResult({ state }: { state: ProcUiResult | null }) {
  return state ? <ProcResultMessage result={state} /> : null;
}

export function VerifySupplierForm({ supplierId, rowVersion }: { supplierId: string; rowVersion: number }) {
  const [state, action] = useActionState(guard(verifySupplierAction), null);
  return (
    <form action={action} noValidate aria-label="Verify supplier" className="primary-slot">
      <input type="hidden" name={PFIELD.supplierId} value={supplierId} />
      <input type="hidden" name={PFIELD.rowVersion} value={rowVersion} />
      <p id="verify-help" className="hint mb-0">
        {A1_TEXT.verifyHelp}
      </p>
      <SubmitButton pendingLabel="Verifying…" describedBy="verify-help">
        {A1_TEXT.verifyLabel}
      </SubmitButton>
      <SmallResult state={state} />
    </form>
  );
}

export function ApproveBeneficiaryForm({ supplierId, revisionNo }: { supplierId: string; revisionNo: number }) {
  const [state, action] = useActionState(guard(approveBeneficiaryAction), null);
  return (
    <form action={action} noValidate>
      <input type="hidden" name={PFIELD.supplierId} value={supplierId} />
      <input type="hidden" name={PFIELD.revisionNo} value={revisionNo} />
      <SubmitButton pendingLabel="Approving…" variant="secondary">
        {A1_TEXT.approveBankLabel}
        <span className="visually-hidden"> (revision {revisionNo})</span>
      </SubmitButton>
      <SmallResult state={state} />
    </form>
  );
}

export function ApproveOverBudgetForm({ taskId, versionNo }: { taskId: string; versionNo: number }) {
  const [state, action] = useActionState(guard(approveOverBudgetAction), null);
  return (
    <form action={action} noValidate aria-label="Approve cost above budget">
      <input type="hidden" name={PFIELD.taskId} value={taskId} />
      <input type="hidden" name={PFIELD.versionNo} value={versionNo} />
      <p id="approve-cost-help" className="hint mb-0">
        {A1_TEXT.approveCostHelp}
      </p>
      <SubmitButton pendingLabel="Approving…" describedBy="approve-cost-help">
        {A1_TEXT.approveCostLabel}
        <span className="visually-hidden"> (version {versionNo})</span>
      </SubmitButton>
      <SmallResult state={state} />
    </form>
  );
}

export function ReleaseTaskForm({ taskId }: { taskId: string }) {
  const [state, action] = useActionState(guard(releaseTaskAction), null);
  return (
    <form action={action} noValidate aria-label="Hand the task back">
      <input type="hidden" name={PFIELD.taskId} value={taskId} />
      <p id="release-help" className="hint mb-0">
        {A1_TEXT.releaseHelp}
      </p>
      <SubmitButton pendingLabel="Handing back…" variant="secondary" describedBy="release-help">
        {A1_TEXT.releaseLabel}
      </SubmitButton>
      <SmallResult state={state} />
    </form>
  );
}

export function ReassignTaskForm({
  taskId,
  expectedAssigneeId,
  candidates,
}: {
  taskId: string;
  expectedAssigneeId: string;
  candidates: Array<{ userId: string; name: string }>;
}) {
  const [state, action] = useActionState(guard(reassignTaskAction), null);
  const keepValues = useKeepValuesOnFailure(state);
  if (candidates.length === 0) return <p className="note info">{A1_TEXT.reassignNobody}</p>;
  return (
    <form onSubmit={keepValues} action={action} noValidate aria-label="Reassign task">
      <SmallResult state={state} />
      <input type="hidden" name={PFIELD.taskId} value={taskId} />
      <input type="hidden" name={PFIELD.expectedAssigneeId} value={expectedAssigneeId} />
      <div className="field">
        <label htmlFor="reassign-to">Move to</label>
        <span id="reassign-help" className="hint">
          {A1_TEXT.reassignHelp}
        </span>
        <select id="reassign-to" name={PFIELD.toUserId} required aria-describedby="reassign-help">
          {candidates.map((c) => (
            <option key={c.userId} value={c.userId}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <SubmitButton pendingLabel="Reassigning…" variant="secondary">
        {A1_TEXT.reassignLabel}
      </SubmitButton>
    </form>
  );
}
