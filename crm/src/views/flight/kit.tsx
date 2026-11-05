'use client';

import { useActionState, useEffect, useRef, type ReactNode, type SubmitEvent } from 'react';
import { HandForm } from '@/components/hand-form';
import { Notice } from '@/components/ui/notice';
import { guard, Hidden, useRequestId, type DecisionAction, type UiResult } from '@/views/accounts/supplier-forms';
import { FLIGHT_PURCHASE_HOLDER_HINT, FLIGHT_PURCHASE_HOLDER_TEXT } from '@/modules/flight/money-contracts';
import { FF } from './actions';
import { FLIGHT_ERROR_TEXT } from './labels';

/*
 * Client form kit for the Flight screens. Every write is a HandForm (React
 * never resets it), so a refusal keeps every typed value and choice on
 * screen; one request id per form, renewed only after a confirmed success.
 */

/** Refusal hints with their own words (the server message wins when it is set). */
const HINT_TEXT: Record<string, string> = {
  [FLIGHT_PURCHASE_HOLDER_HINT]: FLIGHT_PURCHASE_HOLDER_TEXT,
};

export function messageOf(state: UiResult): string {
  if (state.ok) return state.message;
  const hint = (state as { fields?: string[] }).fields?.find((f) => HINT_TEXT[f]);
  if (hint) return HINT_TEXT[hint]!;
  return state.message || FLIGHT_ERROR_TEXT[state.code] || FLIGHT_ERROR_TEXT.invalid_input!;
}

export function FlightResult({ state, okTitle = 'Done', failTitle = 'Not saved' }: { state: UiResult | null; okTitle?: string; failTitle?: string }) {
  if (!state) return <div role="status" aria-live="polite" />;
  return state.ok ? (
    <Notice tone="success" role="status">
      <p>
        <strong>{okTitle}: </strong>
        {messageOf(state)}
      </p>
    </Notice>
  ) : (
    <Notice tone="danger" role="alert">
      <p>
        <strong>{failTitle}: </strong>
        {messageOf(state)}
      </p>
    </Notice>
  );
}

/** One action form: hidden ids, a request id, the result line, the fields. */
export function useFlightAction(action: DecisionAction, initialState: UiResult | null = null) {
  const [state, run] = useActionState(guard(action), initialState);
  const requestId = useRequestId(state);
  return { state, run, requestId };
}

export function ActionForm({
  action,
  fields,
  label,
  children,
  className,
  onDone,
  failTitle,
  onSubmit,
  initialState,
}: {
  action: DecisionAction;
  fields: Record<string, string | number>;
  label: string;
  children: ReactNode | ((state: UiResult | null) => ReactNode);
  className?: string;
  /** Called once after a confirmed success (close a dialog, move focus). */
  onDone?: (state: UiResult) => void;
  failTitle?: string;
  onSubmit?: (e: SubmitEvent<HTMLFormElement>) => void;
  /** Preview gallery only: the first answer shown. */
  initialState?: UiResult | null;
}) {
  const { state, run, requestId } = useFlightAction(action, initialState);
  const seen = useRef<UiResult | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (state && state.ok && seen.current !== state) {
      seen.current = state;
      // The pressed button often disappears after a success: move focus to the result line so it is
      // not lost to the page (a dialog that closes in onDone moves it on to its opener afterwards).
      resultRef.current?.focus();
      onDone?.(state);
    }
  }, [state, onDone]);
  return (
    <HandForm action={run} noValidate aria-label={label} className={className ?? 'flex flex-col gap-3'} onSubmit={onSubmit}>
      <div ref={resultRef} tabIndex={-1} className="outline-none">
        <FlightResult state={state} failTitle={failTitle} />
      </div>
      <Hidden fields={{ ...fields, [FF.requestId]: requestId }} />
      {typeof children === 'function' ? children(state) : children}
    </HandForm>
  );
}
