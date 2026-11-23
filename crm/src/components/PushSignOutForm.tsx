'use client';

import { useRef, type ReactNode } from 'react';
import { PUSH_SIGNOUT_FIELD } from '@/modules/notices/contracts';
import { fillPushSignOutField } from '@/modules/notices/push-client';

/*
 * A sign-out form that first fills this browser's push endpoint (Accounts
 * phase 3 contract 8.4, R10), so signing out also removes this device's
 * closed-browser alerts. The server action reads the hidden field; without
 * JavaScript it is sent empty and sign-out works as before. Reading the
 * endpoint never asks the browser for anything and is capped at 1.5 s.
 */
export function PushSignOutForm({ action, className, children }: { action: (formData: FormData) => void | Promise<void>; className?: string; children: ReactNode }) {
  const filled = useRef(false);
  return (
    <form
      action={action}
      className={className}
      onSubmit={(e) => {
        if (filled.current) {
          filled.current = false;
          return;
        }
        e.preventDefault();
        const form = e.currentTarget;
        const fill = fillPushSignOutField(form).catch(() => undefined);
        const cap = new Promise<void>((resolve) => setTimeout(resolve, 1500));
        void Promise.race([fill, cap]).then(() => {
          filled.current = true;
          form.requestSubmit();
        });
      }}
    >
      <input type="hidden" name={PUSH_SIGNOUT_FIELD} defaultValue="" />
      {children}
    </form>
  );
}
