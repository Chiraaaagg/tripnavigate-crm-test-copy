'use client';

import type { ReactNode } from 'react';
import { useHandFormStatus } from './hand-form';

export function SubmitButton({
  children,
  pendingLabel,
  variant,
  describedBy,
}: {
  children: ReactNode;
  pendingLabel: string;
  variant?: 'secondary' | 'danger';
  /** id of helper or warning text that explains the consequence of submitting. */
  describedBy?: string;
}) {
  const { pending } = useHandFormStatus();
  return (
    <button
      type="submit"
      className={`button${variant ? ` ${variant}` : ''}`}
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
