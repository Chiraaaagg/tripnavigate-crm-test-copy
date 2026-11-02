'use client';

import { type FormEvent, useLayoutEffect, useRef, useState } from 'react';

/**
 * React 19 resets an uncontrolled `<form action={fn}>` after every action that
 * returns without throwing, including a refusal, so typed work would be lost
 * on "invalid input" or "could not confirm" (AUDIT-017). This hook snapshots
 * the submitted fields and, when the action's result is a failure, puts them
 * back after React's reset. A success still clears the form as before.
 *
 * Hidden inputs keep their React-controlled values; file inputs cannot be
 * restored by a page (browser rule), so a file must be chosen again.
 */
export function useKeepValuesOnFailure<S extends { ok: boolean } | null>(
  state: S,
): (event: FormEvent<HTMLFormElement>) => void {
  // Written only in the submit handler and read only in the effect (never during render).
  const form = useRef<HTMLFormElement | null>(null);
  const submitted = useRef<Array<[string, FormDataEntryValue]> | null>(null);
  useLayoutEffect(() => {
    if (!form.current || !submitted.current || !state || state.ok) return;
    restoreFormValues(form.current, submitted.current);
  }, [state]);
  return (event) => {
    form.current = event.currentTarget;
    submitted.current = [...new FormData(event.currentTarget).entries()];
  };
}

function restoreFormValues(form: HTMLFormElement, entries: Array<[string, FormDataEntryValue]>): void {
  const values = new Map<string, string[]>();
  for (const [name, value] of entries) {
    if (typeof value === 'string') values.set(name, [...(values.get(name) ?? []), value]);
  }
  const next = new Map<string, number>();
  for (const element of Array.from(form.elements)) {
    if (element instanceof HTMLInputElement) {
      if (!element.name || ['hidden', 'file', 'submit', 'button', 'reset'].includes(element.type)) continue;
      const submittedValues = values.get(element.name) ?? [];
      if (element.type === 'checkbox' || element.type === 'radio') {
        element.checked = submittedValues.includes(element.value);
      } else {
        element.value = take(next, element.name, submittedValues);
      }
    } else if (element instanceof HTMLSelectElement && element.name) {
      const submittedValues = values.get(element.name) ?? [];
      if (element.multiple) {
        for (const option of Array.from(element.options)) option.selected = submittedValues.includes(option.value);
      } else {
        element.value = take(next, element.name, submittedValues);
      }
    } else if (element instanceof HTMLTextAreaElement && element.name) {
      element.value = take(next, element.name, values.get(element.name) ?? []);
    }
  }
}

/** Repeated names (several inputs with one name) get their submitted values in order. */
function take(next: Map<string, number>, name: string, submittedValues: string[]): string {
  const index = next.get(name) ?? 0;
  next.set(name, index + 1);
  return submittedValues[index] ?? '';
}

/**
 * Batch 4: a key that changes after every successful `FormState` reply. Put it
 * on a HandForm (which never resets) so the form starts empty after a save,
 * while a refusal keeps every typed value and choice on screen.
 */
export function useFormStateSavedKey(state: { status: 'idle' | 'error' | 'success' }): number {
  const [seen, setSeen] = useState(state);
  const [count, setCount] = useState(0);
  if (state !== seen) {
    setSeen(state);
    if (state.status === 'success') setCount((c) => c + 1);
  }
  return count;
}
