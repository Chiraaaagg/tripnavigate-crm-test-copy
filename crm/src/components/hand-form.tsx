'use client';

import { createContext, useContext, useState, useTransition, type ComponentProps, type SubmitEvent } from 'react';
import { useFormStatus } from 'react-dom';

/*
 * React 19 resets a `<form action={fn}>` after every reply, a save or a
 * refusal. Text inputs survive (React keeps their default in step), but a
 * controlled <select>, checkbox or radio goes back to the value it had when
 * the form first appeared, while component state still holds the chosen one.
 * The screen then shows the old value and the next press (a retry after a
 * refusal, a quick second save, or a runner that reads the form) posts it.
 *
 * HandForm submits by hand instead (as the booking form does): the submit
 * event is stopped, the fields are read with the pressed button, and the
 * action runs in a transition. React never resets the form, so every field
 * stays exactly as shown. Use it for forms whose fields are all controlled.
 *
 * A file input is not cleared by a reset any more: key it with `useSavedKey`
 * so it empties after a save.
 */

interface HandStatus {
  pending: boolean;
  data: FormData | null;
}

const HandStatusContext = createContext<HandStatus | null>(null);

/** The pressed button travels with the fields, like a normal submit (name="intent" value="continue"). */
function formDataOf(form: HTMLFormElement, submitter: HTMLElement | null): FormData {
  if (submitter && (submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement) && submitter.form === form) {
    try {
      return new FormData(form, submitter);
    } catch {
      const fd = new FormData(form);
      if (submitter.name) fd.append(submitter.name, submitter.value);
      return fd;
    }
  }
  return new FormData(form);
}

export type HandFormProps = Omit<ComponentProps<'form'>, 'action'> & {
  /** A form action (from useActionState or a section form); it receives the fields as they are on screen. */
  action: (formData: FormData) => unknown;
};

/**
 * A `<form>` that submits by hand, so React does not reset it after the reply.
 * An `onSubmit` given here runs first; if it prevents the default, nothing is sent.
 */
export function HandForm({ action, onSubmit, children, ...props }: HandFormProps) {
  const [pending, startTransition] = useTransition();
  const [data, setData] = useState<FormData | null>(null);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    onSubmit?.(event);
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (pending) return;
    const fd = formDataOf(event.currentTarget, event.submitter);
    setData(fd);
    startTransition(async () => {
      await action(fd);
    });
  };
  return (
    <HandStatusContext.Provider value={{ pending, data: pending ? data : null }}>
      {/* method="post": a press before the page has loaded its script sends a normal POST, never the fields in the address. */}
      <form method="post" {...props} onSubmit={submit}>
        {children}
      </form>
    </HandStatusContext.Provider>
  );
}

/**
 * The pending state of the enclosing form: a HandForm's own transition, or
 * React's form status for a `<form action>` (useFormStatus does not see a
 * form that is submitted by hand).
 */
export function useHandFormStatus(): HandStatus {
  const status = useFormStatus();
  const hand = useContext(HandStatusContext);
  // A `<form action>` that is pending is the nearest form (a dialog form portalled inside a HandForm).
  if (status.pending || !hand) return { pending: status.pending, data: status.data };
  return hand;
}

/**
 * A key that changes after every successful reply. A HandForm is never reset,
 * so a file input keeps the chosen file after an upload; put this key on the
 * file input to clear it after a save (a refusal keeps the file chosen).
 */
export function useSavedKey(reply: { ok: boolean } | null | undefined): string {
  const [seen, setSeen] = useState(reply);
  const [count, setCount] = useState(0);
  if (reply !== seen) {
    setSeen(reply);
    if (reply?.ok) setCount((c) => c + 1);
  }
  return `saved-${count}`;
}
