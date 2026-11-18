'use client';

import { type FormEvent, type ReactNode, useActionState, useEffect, useMemo, useRef, useState } from 'react';
import { FormMessage } from '@/components/FormMessage';
import { SubmitButton } from '@/components/SubmitButton';
import { initialFormState } from '@/lib/forms';
import {
  deactivateStaffAction,
  grantScopeAction,
  inviteStaffAction,
  revokeGrantAction,
  sendStaffEmailAction,
} from '@/modules/access/server/staff-actions';
import { type RecoveryCase, recoveryCleanupState, type VerificationMethodOption } from '@/modules/identity/contracts';
import {
  beginMfaRecoveryAction,
  confirmMfaRecoveryAction,
  resumeMfaRecoveryProviderAction,
  retryMfaRecoveryCleanupAction,
} from '@/modules/identity/server/recovery-actions';
import { useFormStateSavedKey, useKeepValuesOnFailure } from './keep-form-values';
import { HandForm } from '@/components/hand-form';

export interface Option {
  value: string;
  label: string;
}

export function InviteStaffForm({ branches, roles }: { branches: Option[]; roles: Option[] }) {
  const [state, action] = useActionState(inviteStaffAction, initialFormState);
  // Batch 4: submitted by hand so a refusal keeps the chosen branch and role; empty again after a save.
  const savedKey = useFormStateSavedKey(state);
  return (
    <HandForm key={savedKey} action={action} noValidate>
      <FormMessage state={state} />
      <div className="panel-grid">
        <div className="field">
          <label htmlFor="invite-name">Full name</label>
          <input id="invite-name" name="displayName" required maxLength={120} autoComplete="off" />
        </div>
        <div className="field">
          <label htmlFor="invite-email">Work email</label>
          <input id="invite-email" name="email" type="email" required autoComplete="off" />
        </div>
        <div className="field">
          <label htmlFor="invite-branch">Branch</label>
          <select id="invite-branch" name="branchId" required defaultValue="">
            <option value="" disabled>
              Choose a branch
            </option>
            {branches.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="invite-role">Role</label>
          <select id="invite-role" name="roleCode" required defaultValue="">
            <option value="" disabled>
              Choose a role
            </option>
            {roles.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <SubmitButton pendingLabel="Sending invitation…">Send invitation</SubmitButton>
    </HandForm>
  );
}

/** Resend invitation (invited staff) or send a password reset email (active staff). */
function StaffEmailForm({ userId, status }: { userId: string; status: 'invited' | 'active' }) {
  const [state, action] = useActionState(sendStaffEmailAction, initialFormState);
  const kind = status === 'invited' ? 'invitation_resend' : 'password_reset';
  const helpId = `email-help-${userId}`;
  return (
    <form action={action} noValidate className="action-block">
      <h3>{status === 'invited' ? 'Invitation email' : 'Password reset email'}</h3>
      <FormMessage state={state} />
      <p id={helpId} className="hint">
        {status === 'invited'
          ? 'Sends a new link to finish setup. The person still has to set up an authenticator app.'
          : 'Sends a link to choose a new password. Their authenticator app is still required to sign in.'}
      </p>
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="kind" value={kind} />
      <SubmitButton pendingLabel="Sending…" variant="secondary" describedBy={helpId}>
        {status === 'invited' ? 'Resend invitation' : 'Send password reset email'}
      </SubmitButton>
    </form>
  );
}

type FormAction = (payload: FormData) => void;
type SubmitHandler = (event: FormEvent<HTMLFormElement>) => void;

/**
 * Starts a NEW administrator-assisted authenticator recovery. The form state
 * lives in RecoverySection so the server's result stays visible after the
 * page re-renders with the new case status.
 */
function BeginRecoveryForm({
  userId,
  name,
  action,
  invalid,
  onSubmit,
}: {
  userId: string;
  name: string;
  action: FormAction;
  invalid: boolean;
  onSubmit: SubmitHandler;
}) {
  const warnId = `recovery-warn-${userId}`;
  return (
    <form action={action} noValidate onSubmit={onSubmit}>
      <p id={warnId} className="warning-text">
        Warning: starting recovery immediately blocks every current session of {name}, on all devices. They cannot see
        CRM data until they set up a new authenticator and you confirm their identity.
      </p>
      <input type="hidden" name="userId" value={userId} />
      <div className="field">
        <label htmlFor={`recovery-reason-${userId}`}>Reason for recovery</label>
        <input
          id={`recovery-reason-${userId}`}
          name="reason"
          required
          minLength={10}
          maxLength={500}
          aria-describedby={warnId}
          aria-invalid={invalid}
        />
      </div>
      <SubmitButton pendingLabel="Starting…" variant="danger" describedBy={warnId}>
        Start authenticator recovery
      </SubmitButton>
    </form>
  );
}

/**
 * Retries (`failed`) or reconciles (`pending`, result unknown) the provider
 * step of the exact case shown. The database refuses if that case moved on,
 * so a stale page never opens a new case or removes a new authenticator.
 */
function ResumeProviderForm({
  recoveryCase,
  name,
  mode,
  action,
  onSubmit,
}: {
  recoveryCase: RecoveryCase;
  name: string;
  mode: 'failed' | 'pending';
  action: FormAction;
  onSubmit: SubmitHandler;
}) {
  const helpId = `recovery-retry-help-${recoveryCase.caseId}`;
  return (
    <form action={action} noValidate onSubmit={onSubmit}>
      <input type="hidden" name="caseId" value={recoveryCase.caseId} />
      <p id={helpId} className="hint">
        {mode === 'pending'
          ? 'No result is recorded for removing the old authenticator, so the outcome is unknown. Checking continues the same recovery case; it does not start a new one, and the person stays blocked.'
          : 'Retrying continues the same recovery case; it does not start a new one, and the person stays blocked.'}
      </p>
      <SubmitButton pendingLabel={mode === 'pending' ? 'Checking…' : 'Retrying…'} variant="secondary" describedBy={helpId}>
        {mode === 'pending' ? 'Check and finish removing the old authenticator' : 'Retry removing the old authenticator'}
        <span className="visually-hidden"> for {name}</span>
      </SubmitButton>
    </form>
  );
}

/**
 * Identity is confirmed but removing the person's other authenticators has no
 * successful result. Retries cleanup on the same completed case; the consumed
 * confirmation code is never asked for again and no new recovery starts.
 */
function RetryCleanupForm({
  recoveryCase,
  name,
  action,
  onSubmit,
}: {
  recoveryCase: RecoveryCase;
  name: string;
  action: FormAction;
  onSubmit: SubmitHandler;
}) {
  const helpId = `recovery-cleanup-help-${recoveryCase.caseId}`;
  return (
    <form action={action} noValidate onSubmit={onSubmit}>
      <input type="hidden" name="caseId" value={recoveryCase.caseId} />
      <p id={helpId} className="hint">
        {name} stays blocked until this succeeds. Retrying keeps their new authenticator and removes only the others. You
        do not need a new confirmation code.
      </p>
      <SubmitButton pendingLabel="Retrying…" variant="secondary" describedBy={helpId}>
        Retry removing other authenticators<span className="visually-hidden"> for {name}</span>
      </SubmitButton>
    </form>
  );
}

const NO_METHOD_TEXT =
  'No identity-verification method has been approved yet; recovery cannot be completed in this environment.';

/** Administrator confirms recovery with an approved method and the code read out by the staff member. */
function ConfirmRecoveryForm({
  recoveryCase,
  methods,
  action,
  invalid,
  onSubmit,
}: {
  recoveryCase: RecoveryCase;
  methods: VerificationMethodOption[];
  action: FormAction;
  invalid: boolean;
  onSubmit: SubmitHandler;
}) {
  const id = recoveryCase.caseId;
  if (methods.length === 0) {
    return (
      <p className="message info" role="note">
        {NO_METHOD_TEXT}
      </p>
    );
  }
  return (
    <form action={action} noValidate onSubmit={onSubmit}>
      <input type="hidden" name="caseId" value={id} />
      <div className="field">
        <label htmlFor={`confirm-method-${id}`}>How you verified their identity</label>
        <select id={`confirm-method-${id}`} name="method" required defaultValue="" aria-invalid={invalid}>
          <option value="" disabled>
            Choose an approved method
          </option>
          {methods.map((m) => (
            <option key={m.code} value={m.code}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`confirm-code-${id}`}>Confirmation code</label>
        <span className="hint" id={`confirm-code-hint-${id}`}>
          6 characters, read to you by the staff member from their own screen over the agreed channel.
        </span>
        <input
          id={`confirm-code-${id}`}
          name="confirmationCode"
          className="code-input"
          required
          minLength={6}
          maxLength={6}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`confirm-code-hint-${id}`}
          aria-invalid={invalid}
        />
      </div>
      <div className="field">
        <label htmlFor={`confirm-note-${id}`}>Note</label>
        <input id={`confirm-note-${id}`} name="note" maxLength={500} aria-invalid={invalid} />
      </div>
      <SubmitButton pendingLabel="Confirming…">Confirm and restore access</SubmitButton>
    </form>
  );
}

const RECOVERY_HEADING: Record<RecoveryCase['status'] | 'none' | 'cleanup', string> = {
  none: 'Authenticator recovery',
  completed: 'Authenticator recovery',
  cleanup: 'Authenticator recovery: removing other authenticators',
  provider_pending: 'Authenticator recovery: removing old authenticator',
  provider_failed: 'Authenticator recovery: removing old authenticator failed',
  awaiting_reenrollment: 'Authenticator recovery: waiting for new authenticator',
  awaiting_admin_confirmation: 'Authenticator recovery: confirm identity',
};

/** Recovery section of a staff member's actions, by case status. */
function RecoverySection({
  userId,
  name,
  recoveryCase,
  methods,
}: {
  userId: string;
  name: string;
  recoveryCase: RecoveryCase | null;
  methods: VerificationMethodOption[];
}) {
  const [beginState, begin] = useActionState(beginMfaRecoveryAction, initialFormState);
  const [confirmState, confirm] = useActionState(confirmMfaRecoveryAction, initialFormState);
  const [cleanupState, retryCleanup] = useActionState(retryMfaRecoveryCleanupAction, initialFormState);
  const [resumeState, resume] = useActionState(resumeMfaRecoveryProviderAction, initialFormState);
  // One message for the most recent submission, focused when it arrives:
  // the submitted form often unmounts because the case moved on.
  const [last, setLast] = useState<'begin' | 'confirm' | 'cleanup' | 'resume' | null>(null);
  const shown = last === 'begin' ? beginState : last === 'confirm' ? confirmState : last === 'cleanup' ? cleanupState
    : last === 'resume' ? resumeState : initialFormState;
  const messageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (shown.status !== 'idle') messageRef.current?.focus();
  }, [shown]);
  // Typed reason, method and note survive a refusal.
  const keepBegin = useKeepValuesOnFailure(useMemo(() => (beginState.status === 'idle' ? null : { ok: beginState.status === 'success' }), [beginState]));
  const keepConfirm = useKeepValuesOnFailure(useMemo(() => (confirmState.status === 'idle' ? null : { ok: confirmState.status === 'success' }), [confirmState]));
  const submitted = (which: NonNullable<typeof last>, keep?: SubmitHandler): SubmitHandler => (event) => {
    setLast(which);
    keep?.(event);
  };
  const cleanup = recoveryCase?.status === 'completed' ? recoveryCleanupState(recoveryCase) : 'done';
  const status = cleanup === 'failed' || cleanup === 'pending' ? 'cleanup' : (recoveryCase?.status ?? 'none');
  let body: ReactNode = null;
  switch (status) {
    case 'none':
    case 'completed':
      body = (
        <>
          {cleanup === 'stuck' ? (
            <p className="message info" role="note">
              Cleanup of the last recovery cannot finish: the new authenticator registered for it is missing, or the case
              was replaced. {name} stays blocked. Start a new recovery to restore access.
            </p>
          ) : null}
          <BeginRecoveryForm userId={userId} name={name} action={begin} invalid={beginState.status === 'error'} onSubmit={submitted('begin', keepBegin)} />
        </>
      );
      break;
    case 'cleanup':
      body = <RetryCleanupForm recoveryCase={recoveryCase!} name={name} action={retryCleanup} onSubmit={submitted('cleanup')} />;
      break;
    case 'provider_failed':
      body = <ResumeProviderForm recoveryCase={recoveryCase!} name={name} mode="failed" action={resume} onSubmit={submitted('resume')} />;
      break;
    case 'provider_pending':
      body = <ResumeProviderForm recoveryCase={recoveryCase!} name={name} mode="pending" action={resume} onSubmit={submitted('resume')} />;
      break;
    case 'awaiting_reenrollment':
      body = (
        <p className="hint">
          Waiting for {name} to sign in with their password and set up a new authenticator app. Their sessions stay
          blocked.
        </p>
      );
      break;
    case 'awaiting_admin_confirmation':
      body = (
        <ConfirmRecoveryForm
          recoveryCase={recoveryCase!}
          methods={methods}
          action={confirm}
          invalid={confirmState.status === 'error'}
          onSubmit={submitted('confirm', keepConfirm)}
        />
      );
      break;
  }
  return (
    <div className="action-block">
      <h3>{RECOVERY_HEADING[status]}</h3>
      <div ref={messageRef} tabIndex={-1}>
        <FormMessage state={shown} />
      </div>
      {body}
    </div>
  );
}

export function StaffMemberActions({
  userId,
  name,
  status,
  recoveryCase = null,
  verificationMethods = [],
}: {
  userId: string;
  name: string;
  status: 'invited' | 'active';
  recoveryCase?: RecoveryCase | null;
  verificationMethods?: VerificationMethodOption[];
}) {
  const [deactivateState, deactivate] = useActionState(deactivateStaffAction, initialFormState);
  return (
    <details className="staff-actions">
      <summary>
        Actions<span className="visually-hidden"> for {name}</span>
      </summary>
      <StaffEmailForm userId={userId} status={status} />
      {status === 'active' ? (
        <RecoverySection userId={userId} name={name} recoveryCase={recoveryCase} methods={verificationMethods} />
      ) : null}
      <form action={deactivate} noValidate className="action-block danger-zone">
        <h3>Deactivate</h3>
        <FormMessage state={deactivateState} />
        <p id={`deactivate-help-${userId}`} className="hint">
          Ends access at once: open sessions lose access to CRM data at their next request.
        </p>
        <input type="hidden" name="userId" value={userId} />
        <div className="field">
          <label htmlFor={`deactivate-${userId}`}>Reason for deactivation</label>
          <input
            id={`deactivate-${userId}`}
            name="reason"
            required
            minLength={10}
            aria-describedby={`deactivate-help-${userId}`}
          />
        </div>
        <SubmitButton pendingLabel="Deactivating…" variant="danger">
          Deactivate staff member
        </SubmitButton>
      </form>
    </details>
  );
}

export function GrantForm({
  staff,
  entities,
  branches,
}: {
  staff: Option[];
  entities: Option[];
  branches: Option[];
}) {
  const [state, action] = useActionState(grantScopeAction, initialFormState);
  // Batch 4 (T-B4-18): submitted by hand so a refusal keeps the person, access, scope and reason; empty again after a save.
  const savedKey = useFormStateSavedKey(state);
  return (
    <HandForm key={savedKey} action={action} noValidate>
      <FormMessage state={state} />
      <div className="panel-grid">
        <div className="field">
          <label htmlFor="grant-user">Staff member</label>
          <select id="grant-user" name="userId" required defaultValue="">
            <option value="" disabled>
              Choose a staff member
            </option>
            {staff.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="grant-permission">Access</label>
          <select id="grant-permission" name="permission" required defaultValue="deal.read">
            <option value="deal.read">View deals</option>
            <option value="deal.read_commercial">See prices and margin</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="grant-entity">Legal entity</label>
          <select id="grant-entity" name="legalEntityId" required>
            {entities.map((e) => (
              <option key={e.value} value={e.value}>
                {e.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="grant-branch">Branch</label>
          <span className="hint" id="grant-branch-hint">
            Leave as “Whole entity” only when the person needs every branch.
          </span>
          <select id="grant-branch" name="branchId" aria-describedby="grant-branch-hint" defaultValue="">
            <option value="">Whole entity</option>
            {branches.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="grant-expiry">Expires on (optional)</label>
          <input id="grant-expiry" name="expiresAt" type="date" />
        </div>
      </div>
      <div className="field">
        <label htmlFor="grant-reason">Business reason</label>
        <input id="grant-reason" name="reason" required minLength={10} maxLength={500} />
      </div>
      <SubmitButton pendingLabel="Saving…">Record grant</SubmitButton>
    </HandForm>
  );
}

export function RevokeGrantForm({ grantId, label }: { grantId: string; label: string }) {
  const [state, action] = useActionState(revokeGrantAction, initialFormState);
  return (
    <details>
      <summary>
        Revoke<span className="visually-hidden"> {label}</span>
      </summary>
      <form action={action} noValidate>
        <FormMessage state={state} />
        <input type="hidden" name="grantId" value={grantId} />
        <div className="field">
          <label htmlFor={`revoke-${grantId}`}>Reason</label>
          <input id={`revoke-${grantId}`} name="reason" required minLength={10} />
        </div>
        <SubmitButton pendingLabel="Revoking…" variant="danger">
          Revoke grant
        </SubmitButton>
      </form>
    </details>
  );
}
