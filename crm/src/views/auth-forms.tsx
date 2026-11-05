'use client';

import { useActionState, useId, useState, useTransition } from 'react';
import { FormMessage } from '@/components/FormMessage';
import { SubmitButton } from '@/components/SubmitButton';
import { type FormState, initialFormState } from '@/lib/forms';
import {
  type EnrollmentStart,
  requestPasswordResetAction,
  setInitialPasswordAction,
  signInAction,
  startTotpEnrollmentAction,
  verifyChallengeAction,
  verifyEnrollmentAction,
} from '@/modules/identity/server/actions';

export function SignInForm({ next, initialState }: { next?: string; initialState?: FormState }) {
  const [state, action] = useActionState(signInAction, initialState ?? initialFormState);
  const errorId = useId();
  const invalid = state.status === 'error';
  return (
    <form action={action} noValidate aria-describedby={invalid ? errorId : undefined}>
      <FormMessage state={state} id={errorId} />
      <input type="hidden" name="next" value={next ?? ''} />
      <div className="field">
        <label htmlFor="email">Work email</label>
        <input id="email" name="email" type="email" autoComplete="username" required aria-invalid={invalid} />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={invalid}
        />
      </div>
      <SubmitButton pendingLabel="Signing in…">Sign in</SubmitButton>
    </form>
  );
}

export function PasswordForm({ initialState }: { initialState?: FormState }) {
  const [state, action] = useActionState(setInitialPasswordAction, initialState ?? initialFormState);
  const invalid = state.status === 'error';
  return (
    <form action={action} noValidate>
      <FormMessage state={state} />
      <div className="field">
        <label htmlFor="password">New password</label>
        <span className="hint" id="password-hint">
          At least 12 characters, including upper and lower case letters and a digit.
        </span>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          aria-describedby="password-hint"
          required
          minLength={12}
          aria-invalid={invalid}
        />
      </div>
      <div className="field">
        <label htmlFor="confirm">Confirm new password</label>
        <input id="confirm" name="confirm" type="password" autoComplete="new-password" required aria-invalid={invalid} />
      </div>
      <SubmitButton pendingLabel="Saving…">Save password and continue</SubmitButton>
    </form>
  );
}

function CodeField({ invalid }: { invalid: boolean }) {
  return (
    <div className="field">
      <label htmlFor="code">6-digit code</label>
      <span className="hint" id="code-hint">
        Open your authenticator app and enter the current code for TripNavigate CRM.
      </span>
      <input
        id="code"
        name="code"
        className="code-input"
        inputMode="numeric"
        pattern="[0-9]{6}"
        maxLength={6}
        autoComplete="one-time-code"
        aria-describedby="code-hint"
        required
        aria-invalid={invalid}
      />
    </div>
  );
}

export function MfaEnrollForm({
  initialEnrollment,
  initialState,
}: {
  initialEnrollment?: EnrollmentStart;
  initialState?: FormState;
}) {
  const [enrollment, setEnrollment] = useState<EnrollmentStart | undefined>(initialEnrollment);
  const [starting, startTransition] = useTransition();
  const [state, action] = useActionState(verifyEnrollmentAction, initialState ?? initialFormState);

  if (!enrollment || enrollment.status === 'error') {
    return (
      <div>
        {enrollment?.status === 'error' ? (
          <div className="message error" role="alert">
            <strong>Error: </strong>
            {enrollment.message}
          </div>
        ) : null}
        <ol className="steps">
          <li>Install an authenticator app on your phone (for example Google Authenticator or Microsoft Authenticator).</li>
          <li>Select the button below to show a QR code.</li>
          <li>Scan it, then enter the 6-digit code the app shows.</li>
        </ol>
        <button
          type="button"
          className="button"
          aria-disabled={starting}
          onClick={() => {
            if (starting) return;
            startTransition(async () => setEnrollment(await startTotpEnrollmentAction()));
          }}
        >
          {starting ? 'Preparing…' : 'Set up authenticator app'}
        </button>
      </div>
    );
  }

  return (
    <form action={action} noValidate>
      <FormMessage state={state} />
      <p>Scan this QR code with your authenticator app.</p>
      {/* eslint-disable-next-line @next/next/no-img-element -- data URI from Supabase Auth */}
      <img className="qr" src={enrollment.qrCode} alt="QR code to add TripNavigate CRM to your authenticator app" />
      <details>
        <summary>Cannot scan? Enter this setup key instead</summary>
        <p className="secret" aria-label="Setup key">
          {enrollment.secret}
        </p>
      </details>
      <input type="hidden" name="factorId" value={enrollment.factorId} />
      <CodeField invalid={state.status === 'error'} />
      <SubmitButton pendingLabel="Checking…">Verify and continue</SubmitButton>
    </form>
  );
}

export function MfaChallengeForm({
  factors,
  next,
  initialState,
}: {
  factors: Array<{ id: string; name: string }>;
  next?: string;
  initialState?: FormState;
}) {
  const [state, action] = useActionState(verifyChallengeAction, initialState ?? initialFormState);
  return (
    <form action={action} noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="next" value={next ?? ''} />
      {factors.length > 1 ? (
        <div className="field">
          <label htmlFor="factorId">Authenticator</label>
          <select id="factorId" name="factorId" defaultValue={factors[0]?.id}>
            {factors.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <input type="hidden" name="factorId" value={factors[0]?.id ?? ''} />
      )}
      <CodeField invalid={state.status === 'error'} />
      <SubmitButton pendingLabel="Checking…">Verify</SubmitButton>
    </form>
  );
}

/** The only message the forgot-password form ever shows on success (no account enumeration). */
export const PASSWORD_RESET_GENERIC_MESSAGE =
  'If this email belongs to a staff account, we have asked the mail service to send a reset link. It expires soon. You will still need your authenticator app.';

export function ForgotPasswordForm({ initialState }: { initialState?: FormState }) {
  const [state, action] = useActionState(requestPasswordResetAction, initialState ?? initialFormState);
  const errorId = useId();
  const invalid = state.status === 'error';
  if (state.status === 'success') {
    return (
      <div className="message success" role="status">
        {PASSWORD_RESET_GENERIC_MESSAGE}
      </div>
    );
  }
  return (
    <form action={action} noValidate aria-describedby={invalid ? errorId : undefined}>
      <FormMessage state={state} id={errorId} />
      <div className="field">
        <label htmlFor="reset-email">Work email</label>
        <span className="hint" id="reset-email-hint">
          The email address your administrator invited.
        </span>
        <input
          id="reset-email"
          name="email"
          type="email"
          autoComplete="username"
          required
          aria-describedby="reset-email-hint"
          aria-invalid={invalid}
        />
      </div>
      <SubmitButton pendingLabel="Sending…">Send reset email</SubmitButton>
    </form>
  );
}
