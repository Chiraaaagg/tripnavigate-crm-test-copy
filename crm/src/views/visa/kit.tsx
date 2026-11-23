'use client';

import { useCallback, useEffect, useId, useRef, useState, useTransition, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ErrorSummary, type ErrorSummaryItem } from '@/components/ui/error-summary';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { guard, useRequestId, type DecisionAction, type UiResult } from '@/views/accounts/supplier-forms';
import { FILE_ACCEPT, FILE_HINT } from './format';
import { refusalText } from './labels';

/*
 * Client kit for the Visa screens. Every write keeps its typed values in
 * React state (never a form reset), so a refusal leaves everything on
 * screen. One request id per form, renewed only after a confirmed success,
 * so a double press or a retry after a lost reply is the same request.
 */

export type VisaResult = UiResult & { fields?: string[] };

/** Hint names the server returned for invalid_input (contract 6: comma-separated, e.g. "applicants[1].reference"). */
export function refusedFields(state: VisaResult | null): Set<string> {
  if (!state || state.ok) return new Set();
  const raw = (state as { fields?: unknown }).fields;
  const list = Array.isArray(raw) ? raw.filter((f): f is string => typeof f === 'string') : [];
  return new Set(list.flatMap((f) => f.split(',').map((x) => x.trim())).filter(Boolean));
}

export function messageOf(state: VisaResult): string {
  return state.ok ? state.message : refusalText(state.code, state.message);
}

/** One command: state, pending, the request id and send(). */
export function useCommand(action: DecisionAction, initialState: VisaResult | null = null) {
  const [state, setState] = useState<VisaResult | null>(initialState);
  const [pending, start] = useTransition();
  const requestId = useRequestId(state);
  const busy = useRef(false);
  const send = useCallback(
    (build: (requestId: string) => FormData | Promise<FormData | null>, after?: (r: VisaResult) => void) => {
      if (busy.current) return;
      busy.current = true;
      start(async () => {
        try {
          const fd = await build(requestId);
          if (!fd) return;
          const r = (await guard(action)(null, fd)) as VisaResult;
          setState(r);
          after?.(r);
        } finally {
          busy.current = false;
        }
      });
    },
    [action, requestId],
  );
  const clear = useCallback(() => setState(null), []);
  return { state, pending, requestId, send, setState, clear };
}

/** The result line of a form: success (status) or refusal (alert). */
export function ResultNotice({ state, okTitle = 'Saved', failTitle = 'Not saved' }: { state: VisaResult | null; okTitle?: string; failTitle?: string }) {
  if (!state) return <div role="status" aria-live="polite" className="contents" />;
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

/** Refusal summary for a popup: what happened, that nothing was saved, links to the fields. */
export function RefusalSummary({ state, items, keptFile }: { state: VisaResult | null; items?: ErrorSummaryItem[]; keptFile?: boolean }) {
  if (!state || state.ok) return null;
  return (
    <ErrorSummary title="Nothing was saved" description={messageOf(state)} items={items}>
      {keptFile ? <p className="m-0 mt-[0.25rem] text-sm">Your typed details are still here. A file you chose is kept too.</p> : null}
    </ErrorSummary>
  );
}

/** A local check failed before anything was sent. */
export function CheckSummary({ problems }: { problems: ErrorSummaryItem[] }) {
  if (problems.length === 0) return null;
  return <ErrorSummary title="Check these details" description="Nothing was sent yet." items={problems} />;
}

/**
 * Popup (contract 11.1 "popup", HTML vp-popup width 44rem): Radix dialog with
 * focus trap, Escape and focus return; Cancel plus one primary button that
 * submits the form inside. Content stays mounted only while open.
 */
export function VisaPopup({
  open,
  onOpenChange,
  title,
  description,
  formId,
  primaryLabel,
  pendingLabel,
  pending,
  wide,
  children,
  onSubmit,
  danger,
  returnFocusId,
  result,
  onDone,
}: {
  /** The command's answer: a confirmed success calls onDone once (the caller closes the popup). */
  result?: VisaResult | null;
  onDone?: (r: VisaResult) => void;
  /** The control that opened the popup (a menu item has no trigger to return to). */
  returnFocusId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  formId: string;
  primaryLabel: string;
  pendingLabel?: string;
  pending: boolean;
  wide?: boolean;
  danger?: boolean;
  children: ReactNode;
  onSubmit: () => void;
}) {
  const seen = useRef(result);
  useEffect(() => {
    if (result && result !== seen.current) {
      seen.current = result;
      if (result.ok) onDone?.(result);
    }
  }, [result, onDone]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={wide ? 'max-w-[min(56rem,calc(100vw-2rem))]' : 'max-w-[min(44rem,calc(100vw-2rem))]'}
        onCloseAutoFocus={(e) => {
          const el = returnFocusId ? document.getElementById(returnFocusId) : null;
          if (el) {
            e.preventDefault();
            el.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : <DialogDescription className="sr-only">{title}</DialogDescription>}
        </DialogHeader>
        <DialogBody>
          <form
            id={formId}
            noValidate
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!pending) onSubmit();
            }}
          >
            {children}
          </form>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">Cancel</Button>
          </DialogClose>
          <Button type="submit" form={formId} variant={danger ? 'danger' : 'primary'} aria-disabled={pending || undefined} loading={pending}>
            {pending ? (pendingLabel ?? 'Saving…') : primaryLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Read-only facts at the top of a popup (passenger, passport, appointment …). */
export function PopupFacts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 rounded-control border border-line bg-canvas px-3.5 py-2.5 text-sm max-sm:grid-cols-1">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="font-semibold text-quiet">{k}</dt>
          <dd className="m-0 wrap-anywhere text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** File field (PDF/JPG/PNG/WebP ≤ 4 MB); the chosen file stays after a refusal. */
export function FileField({
  id,
  label,
  optional,
  error,
  hint,
  file,
  onFile,
  keptName,
}: {
  id: string;
  label: string;
  optional?: boolean;
  error?: string | null;
  hint?: string;
  file: File | null;
  onFile: (f: File | null) => void;
  /** A file already uploaded during this popup (a later refusal does not upload it again). */
  keptName?: string | null;
}) {
  const fullHint = `${hint ? `${hint} ` : ''}${FILE_HINT}${keptName ? ` Uploaded: ${keptName}.` : file ? ` Chosen: ${file.name}.` : ''}`;
  return (
    <Field htmlFor={id} label={label} optional={optional} hint={fullHint} error={error}>
      <input
        id={id}
        type="file"
        accept={FILE_ACCEPT}
        className="block w-full max-w-full text-sm text-copy file:mr-3 file:rounded-control file:border file:border-line-strong file:bg-card file:px-3 file:py-1.5 file:font-semibold file:text-ink"
        aria-invalid={error ? true : undefined}
        aria-describedby={fieldDescribedBy(id, { hint: fullHint, error })}
        onChange={(e) => onFile(e.currentTarget.files?.[0] ?? null)}
      />
    </Field>
  );
}

/** Moves focus to an element by id after the next paint (popup fields, row pencils). */
export function focusLater(id: string) {
  requestAnimationFrame(() => document.getElementById(id)?.focus());
}

/** Stable ids for one component instance. */
export function useIds(prefix: string) {
  const base = useId().replace(/:/g, '');
  return (name: string) => `${prefix}-${base}-${name}`;
}

/** Closes a popup once after a confirmed success. */
export function useCloseOnSuccess(state: VisaResult | null, close: () => void) {
  const seen = useRef<VisaResult | null>(state);
  useEffect(() => {
    if (state && state !== seen.current) {
      seen.current = state;
      if (state.ok) close();
    }
  }, [state, close]);
}
