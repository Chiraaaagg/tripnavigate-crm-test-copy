'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';
import { FormMessage } from '@/components/FormMessage';
import { SubmitButton } from '@/components/SubmitButton';
import { type FormState, initialFormState } from '@/lib/forms';
import { registerRecoveryFactorAction } from '@/modules/identity/server/recovery-actions';

/**
 * Registers the authenticator the user just set up with their open recovery
 * case. On success the server issues a confirmation code; the page re-renders
 * from the server so the code shown is the one the database stored.
 */
export function RegisterRecoveryFactorForm({ caseId, initialState }: { caseId: string; initialState?: FormState }) {
  const [state, action] = useActionState(registerRecoveryFactorAction, initialState ?? initialFormState);
  const router = useRouter();
  useEffect(() => {
    if (state.status === 'success') router.refresh();
  }, [state.status, router]);
  return (
    <form action={action} noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="caseId" value={caseId} />
      <p id="register-factor-help" className="hint">
        Use this only after your new authenticator app has been set up and verified in this session.
      </p>
      <SubmitButton pendingLabel="Registering…" describedBy="register-factor-help">
        Get my confirmation code
      </SubmitButton>
    </form>
  );
}

/** Copies the confirmation code (for reading it out from a phone screen or notes). */
export function CopyCodeButton({ code }: { code: string }) {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  return (
    <p>
      <button
        type="button"
        className="button secondary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(code);
            setCopied('done');
          } catch {
            setCopied('failed');
          }
        }}
      >
        Copy code
      </button>{' '}
      <span role="status">
        {copied === 'done' ? 'Copied.' : copied === 'failed' ? 'Could not copy. Read the code from the screen.' : ''}
      </span>
    </p>
  );
}
