import Link from 'next/link';
import { AuthCard } from '@/components/AuthCard';
import type { FormState } from '@/lib/forms';
import type { OwnRecoveryView } from '@/modules/identity/contracts';
import { signOutAction } from '@/modules/identity/server/actions';
import { CopyCodeButton, RegisterRecoveryFactorForm } from './recovery-forms';

const STEPS = [
  'Administrator starts recovery',
  'Set up a new authenticator',
  'Read your code to the administrator',
  'Sign in again with the new authenticator',
] as const;

const STEP_FOR: Record<OwnRecoveryView['status'], number> = {
  provider_pending: 0,
  provider_failed: 0,
  awaiting_reenrollment: 1,
  awaiting_admin_confirmation: 2,
  completed: 3,
};

/** Numbered progress (text carries the state; colour is decoration). */
function RecoverySteps({ status }: { status: OwnRecoveryView['status'] }) {
  const current = STEP_FOR[status];
  return (
    <ol className="step-indicator" aria-label="Recovery progress">
      {STEPS.map((label, i) => {
        const state = i < current || status === 'completed' ? 'done' : i === current ? 'current' : 'todo';
        return (
          <li key={label} className={`step-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="step-number" aria-hidden="true">
              {i + 1}
            </span>
            <span>
              {label}
              <span className="visually-hidden">
                {state === 'done' ? ' (done)' : state === 'current' ? ' (current step)' : ' (not started)'}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function SignOutButton() {
  return (
    <form action={signOutAction} className="mt-15">
      <button type="submit" className="button secondary">
        Sign out
      </button>
    </form>
  );
}

const BLOCKED_NOTE =
  'While recovery is open, this account cannot see or change CRM data on any device, including sessions that were open before recovery started.';

/** What a staff member under authenticator recovery sees, by case status. */
export function AccountRecoveryView({
  recovery,
  registerInitialState,
}: {
  recovery: OwnRecoveryView | null;
  /** Preview gallery only. */
  registerInitialState?: FormState;
}) {
  if (!recovery) {
    return (
      <AuthCard title="No authenticator recovery in progress">
        <p>Your account is not under authenticator recovery.</p>
        <Link className="button" href="/app">
          Go to the CRM home page
        </Link>
        <SignOutButton />
      </AuthCard>
    );
  }

  switch (recovery.status) {
    case 'provider_pending':
    case 'provider_failed':
      return (
        <AuthCard title="Authenticator recovery in progress">
          <RecoverySteps status={recovery.status} />
          <div className="message info" role="status">
            Your administrator has started recovery. Wait for them to finish.
          </div>
          <p>{BLOCKED_NOTE}</p>
          <p>Your administrator will tell you when to sign in again and set up a new authenticator app.</p>
          <SignOutButton />
        </AuthCard>
      );
    case 'awaiting_reenrollment':
      return (
        <AuthCard title="Set up a new authenticator">
          <RecoverySteps status={recovery.status} />
          <div className="message info" role="status">
            Your old authenticator has been removed. Set up a new authenticator app to continue recovery.
          </div>
          <p>{BLOCKED_NOTE}</p>
          <ol className="steps">
            <li>
              <Link href="/mfa/enroll">Set up a new authenticator app</Link>.
            </li>
            <li>Come back to this page and get your confirmation code.</li>
            <li>Read the code to your administrator over the channel you agreed with them.</li>
          </ol>
          <RegisterRecoveryFactorForm caseId={recovery.caseId} initialState={registerInitialState} />
          <SignOutButton />
        </AuthCard>
      );
    case 'awaiting_admin_confirmation':
      return (
        <AuthCard title="Read this code to your administrator">
          <RecoverySteps status={recovery.status} />
          {recovery.confirmationCode ? (
            <>
              <h2>Your confirmation code</h2>
              <p className="confirmation-code" data-testid="confirmation-code">
                {recovery.confirmationCode}
              </p>
              <CopyCodeButton code={recovery.confirmationCode} />
              <ol className="steps">
                <li>
                  Contact your administrator over the channel you agreed with them (for example in person or by a phone
                  number they already know). Do not send the code by email or chat.
                </li>
                <li>Read the code to them. They will check it and confirm your identity.</li>
                <li>
                  When they have confirmed, sign out and sign in again with your password and your new authenticator
                  app. Confirming ends every earlier session, including this one.
                </li>
              </ol>
            </>
          ) : (
            <div className="message info" role="status">
              Your confirmation code is shown on the device where you set up the new authenticator.
            </div>
          )}
          <p>{BLOCKED_NOTE}</p>
          <SignOutButton />
        </AuthCard>
      );
    case 'completed':
      return (
        <AuthCard title="Recovery complete">
          <RecoverySteps status={recovery.status} />
          <div className="message success" role="status">
            Your administrator has confirmed your identity. For security, every earlier session has ended.
          </div>
          <p>Sign in again with your password and your new authenticator app to continue.</p>
          <p className="hint">
            Your administrator must also finish removing your old authenticators. If you still cannot get in after
            signing in again, ask them to check that step.
          </p>
          <form action={signOutAction}>
            <button type="submit" className="button">
              Sign out and sign in again
            </button>
          </form>
        </AuthCard>
      );
  }
}
