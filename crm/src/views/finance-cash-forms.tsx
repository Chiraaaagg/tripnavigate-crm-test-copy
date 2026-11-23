'use client';

import { type MouseEvent, type ReactNode, useActionState, useState } from 'react';
import { SubmitButton } from '@/components/SubmitButton';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn, focusRing } from '@/components/ui/cn';
import { Drawer, DrawerBody, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer';
import { jumpTo } from '@/components/ui/jump-links';
import {
  ACTION_BLOCK_TEXT,
  type ActionBlock,
  type CashBranchView,
  type CashDepositView,
  type CashReconciliationView,
  type CompanyDestinationView,
  DESTINATION_KIND_LABEL,
  DESTINATION_KINDS,
  type DestinationKind,
  type DestinationVersionView,
} from '@/modules/finance/contracts';
import { BlockedReason, formatInr } from './finance-common';
import {
  ACCEPT,
  type DestinationDetailAction,
  type DestinationDetailState,
  Field,
  FILE_HINT,
  FIN_FIELD,
  type FinanceAction,
  type FinanceActions,
  type FinanceActionState,
  FinanceResult,
  RequestId,
  UnavailableButton,
  useFinanceForm,
} from './finance-policy-forms';

/*
 * Cash and bank Accounts forms: cash deposits, daily cash counts and company
 * accounts (bank accounts and UPI IDs). Shared plumbing is in
 * finance-policy-forms.tsx.
 *
 * UX redesign R4 (A8, helper A4): the deposit, cash count and "add a company
 * account" forms open from a button at the top of their page in the existing
 * side drawer (Radix Dialog: focus trap, Escape, focus back on the button).
 * Field names, actions, messages and the request-id rule are unchanged; only
 * where the forms open changed. Every rule (two different Accounts people,
 * whole paise, cash caps, reversals) stays on the server.
 */

/** Contract reason text, with "own_record" worded for the record type (a deposit or a cash count is not a receipt). */
function custodyBlockText(block: Exclude<ActionBlock, null>, what: 'deposit' | 'cash count'): string {
  return block === 'own_record' ? `You recorded this ${what}. Another Accounts person must do this step.` : ACTION_BLOCK_TEXT[block];
}

// ---------------------------------------------------------------------------
// Cash custody
// ---------------------------------------------------------------------------

/** Side drawer for a cash form (A8): the page keeps "Record deposit" and "Record cash count" at the top. */
function CashDrawerContent({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <DrawerContent className="w-[min(40rem,calc(100vw-1rem))]" closeLabel={`Close: ${title}`}>
      <DrawerHeader>
        <DrawerTitle className="m-0 text-lg font-semibold text-ink">{title}</DrawerTitle>
        <DrawerDescription className="m-0 text-sm text-quiet">{description}</DrawerDescription>
      </DrawerHeader>
      <DrawerBody>{children}</DrawerBody>
    </DrawerContent>
  );
}

/**
 * "Record deposit" (UX redesign R4, A8): a button at the top of Branch cash
 * that opens the same deposit form in a side drawer (same fields, action and
 * messages as before). The form state lives here, outside the drawer, so
 * closing and reopening the drawer keeps typed values and the request id
 * (a resubmit after an unknown outcome still replays instead of recording a
 * second deposit). No button when no verified cash is waiting.
 */
export function RecordDepositForm({
  entityId,
  branch,
  action,
  initialState = null,
}: {
  entityId: string;
  branch: CashBranchView;
  action: FinanceAction;
  /** Design previews only: open the drawer with a refusal already shown. */
  initialState?: FinanceActionState | null;
}) {
  const f = useFinanceForm(action, initialState);
  const [open, setOpen] = useState(initialState !== null);
  const p = `dep-${branch.branchId}`;
  const waiting = branch.undepositedVerified.length > 0;
  if (!waiting && !open) return null;
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      {waiting ? (
        <DrawerTrigger asChild>
          <Button variant="primary">
            Record deposit<span className="sr-only">{` for ${branch.branchName}`}</span>
          </Button>
        </DrawerTrigger>
      ) : null}
      <CashDrawerContent title="Record a bank deposit" description={`${branch.branchName} branch cash`}>
        {waiting ? (
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
        ) : (
          <>
            {/* The last deposit took every waiting receipt: keep its answer visible until the drawer closes. */}
            <FinanceResult state={f.state} />
            <p className="hint">No verified cash is waiting to be deposited at {branch.branchName}.</p>
          </>
        )}
      </CashDrawerContent>
    </Drawer>
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

/**
 * "Record cash count" (A8): a button at the top of Branch cash that opens the
 * same daily count form in a side drawer. State lives outside the drawer, as
 * for the deposit. It is the page's primary button when no cash waits for a
 * deposit.
 */
export function RecordReconciliationForm({
  entityId,
  branch,
  action,
  primary = false,
  initialState = null,
}: {
  entityId: string;
  branch: CashBranchView;
  action: FinanceAction;
  /** The page's one primary button (no deposit waiting). */
  primary?: boolean;
  /** Design previews only: open the drawer with a refusal already shown. */
  initialState?: FinanceActionState | null;
}) {
  const f = useFinanceForm(action, initialState);
  const [open, setOpen] = useState(initialState !== null);
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <Button variant={primary ? 'primary' : 'secondary'}>
          Record cash count<span className="sr-only">{` for ${branch.branchName}`}</span>
        </Button>
      </DrawerTrigger>
      <CashDrawerContent title="Record a daily cash count" description={`${branch.branchName} branch cash`}>
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
      </CashDrawerContent>
    </Drawer>
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

/**
 * "Add a company account" (A8): the page's button opening the same add form
 * (DestinationForm, unchanged) in the side drawer. The form's state lives in
 * DestinationForm inside the drawer; a refusal keeps the drawer open with the
 * typed values. Closing the drawer drops what was typed, which is intended:
 * account numbers and UPI IDs are not kept on the page.
 */
export function AddDestinationDrawer({
  entityId,
  action,
  initialState = null,
}: {
  entityId: string;
  action: FinanceAction;
  /** Design previews only: open the drawer with a refusal already shown. */
  initialState?: FinanceActionState | null;
}) {
  return (
    <Drawer defaultOpen={initialState !== null}>
      <DrawerTrigger asChild>
        <Button variant="primary">Add a company account</Button>
      </DrawerTrigger>
      <CashDrawerContent title="Add a company account" description="Where customers pay the company. A different Accounts person approves it.">
        <DestinationForm entityId={entityId} action={action} initialState={initialState} />
      </CashDrawerContent>
    </Drawer>
  );
}

/**
 * A row control that moves to a part of the same page (A8 "Next step" and the
 * account name in the Company accounts table). A plain "#id" link without
 * script; with script it opens the fold around the target and moves focus to
 * it (jumpTo). Modified clicks keep the browser's own behaviour.
 */
export function JumpToRow({
  targetId,
  look = 'button',
  children,
}: {
  targetId: string;
  /** 'button': a small row button; 'link': the account name. */
  look?: 'button' | 'link';
  children: ReactNode;
}) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (jumpTo(targetId)) event.preventDefault();
  };
  return (
    <a
      href={`#${targetId}`}
      onClick={onClick}
      className={cn(
        look === 'button'
          ? cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'h-auto min-h-8 py-1 whitespace-normal max-sm:w-full')
          : cn('rounded-chip font-semibold text-brand-strong underline underline-offset-4 hover:text-brand-deep', focusRing),
      )}
    >
      {children}
    </a>
  );
}
