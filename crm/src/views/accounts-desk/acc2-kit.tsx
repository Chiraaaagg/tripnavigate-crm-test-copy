'use client';

import { useId, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { DeskDialog, DeskResultLine, useDeskCommand, type DeskResult } from './desk-kit';

/*
 * Accounts phase 2 client kit (customer documents and refunds, contract 0 UI
 * rules, Addendum L3 form shape). Built on the Phase 1 desk kit: one request
 * id per form renewed only after a confirmed success, refusals keep every
 * typed value and mark the field the refusal names, one primary button per
 * dialog, aria-disabled with one short reason instead of a hidden control.
 */

const WRAP = 'h-auto min-h-8 max-w-full py-1 whitespace-normal text-left';

export type Fields = Record<string, string | number | null | undefined>;

function HiddenFields({ fields, requestId }: { fields: Fields; requestId: string }) {
  return (
    <>
      {Object.entries(fields).map(([name, value]) => (value === null || value === undefined ? null : <input key={name} type="hidden" name={name} value={String(value)} />))}
      <input type="hidden" name="requestId" value={requestId} />
    </>
  );
}

/** A button that cannot be pressed now, with its one-line reason (never hidden). */
export function BlockedButton({ label, reason, variant = 'secondary', ariaLabel }: { label: string; reason: string; variant?: 'primary' | 'secondary'; ariaLabel?: string }) {
  const id = useId();
  return (
    <span className="inline-flex max-w-full flex-col items-start gap-1">
      <Button type="button" variant={variant} size="sm" className={WRAP} aria-disabled="true" aria-label={ariaLabel} aria-describedby={id} onClick={(e) => e.preventDefault()}>
        {label}
      </Button>
      <span id={id} className="text-sm text-quiet">
        {reason}
      </span>
    </span>
  );
}

/**
 * A one-press command (create a draft, refresh, make the PDF again): hidden
 * fields only, the result line under the button. A refusal says why in words.
 */
export function CommandButton({
  action,
  fields,
  label,
  pendingLabel,
  variant = 'secondary',
  blockedReason,
  okTitle = 'Done',
  initialState,
  ariaLabel,
}: {
  /** Accessible name with context when several rows repeat the same visible label. */
  ariaLabel?: string;
  action: DecisionAction | null | undefined;
  fields: Fields;
  label: string;
  pendingLabel: string;
  variant?: 'primary' | 'secondary';
  /** Set: the button is aria-disabled with this reason. */
  blockedReason?: string | null;
  okTitle?: string;
  initialState?: DeskResult | null;
}) {
  if (!action || blockedReason) return <BlockedButton label={label} reason={blockedReason ?? 'Not available to you.'} variant={variant} ariaLabel={ariaLabel} />;
  return <LiveCommandButton action={action} fields={fields} label={label} pendingLabel={pendingLabel} variant={variant} okTitle={okTitle} initialState={initialState} ariaLabel={ariaLabel} />;
}

function LiveCommandButton({ action, fields, label, pendingLabel, variant, okTitle, initialState, ariaLabel }: { action: DecisionAction; fields: Fields; label: string; pendingLabel: string; variant: 'primary' | 'secondary'; okTitle: string; initialState?: DeskResult | null; ariaLabel?: string }) {
  const cmd = useDeskCommand(action, initialState ?? null);
  return (
    <form noValidate onSubmit={(e) => cmd.submit(e)} className="flex max-w-full flex-col items-start gap-2">
      <HiddenFields fields={fields} requestId={cmd.requestId} />
      <Button
        type="submit"
        variant={variant}
        size="sm"
        className={WRAP}
        aria-label={ariaLabel && !cmd.pending ? ariaLabel : undefined}
        aria-disabled={cmd.pending || undefined}
        onClick={(e) => {
          if (cmd.pending) e.preventDefault();
        }}
      >
        {cmd.pending ? pendingLabel : label}
      </Button>
      {cmd.state ? <DeskResultLine state={cmd.state} okTitle={okTitle} /> : <div role="status" aria-live="polite" className="contents" />}
    </form>
  );
}

/**
 * A button that opens one dialog with one form. The hidden fields and the
 * request id are added for the caller; the caller renders the typed fields.
 * After a confirmed success the dialog closes and the result line shows
 * beside the button (focus moves there).
 */
export function DialogAction({
  buttonLabel,
  buttonVariant = 'secondary',
  blockedReason,
  title,
  description,
  primaryLabel,
  pendingLabel,
  action,
  fields,
  danger,
  cancelLabel,
  okTitle = 'Done',
  initialOpen = false,
  initialState,
  children,
  ariaLabel,
  warnOkMessage,
}: {
  /** A success with exactly this message shows as a warning beside the button (e.g. saved but not linked). */
  warnOkMessage?: string;
  /** Accessible name of the opening button with context (the dialog title already carries it). */
  ariaLabel?: string;
  buttonLabel: string;
  buttonVariant?: 'primary' | 'secondary' | 'ghost';
  blockedReason?: string | null;
  title: string;
  description: ReactNode;
  primaryLabel: string;
  pendingLabel: string;
  action: DecisionAction | null | undefined;
  fields: Fields;
  danger?: boolean;
  cancelLabel?: string;
  okTitle?: string;
  /** Preview gallery: start open. */
  initialOpen?: boolean;
  /** Preview gallery: start with a refusal on screen. */
  initialState?: DeskResult | null;
  /** The typed fields (plain nodes, so a Server Component can pass them). */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [done, setDone] = useState<DeskResult | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const resultId = useId();
  if (!action || blockedReason) return <BlockedButton label={buttonLabel} reason={blockedReason ?? 'Not available to you.'} variant={buttonVariant === 'primary' ? 'primary' : 'secondary'} ariaLabel={ariaLabel} />;
  return (
    <span className="inline-flex max-w-full flex-col items-start gap-2">
      <Button ref={opener} type="button" variant={buttonVariant} size="sm" className={WRAP} onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={ariaLabel}>
        {buttonLabel}
      </Button>
      {open ? (
        <DeskDialog
          open={open}
          onOpenChange={setOpen}
          title={title}
          description={description}
          primaryLabel={primaryLabel}
          pendingLabel={pendingLabel}
          action={action}
          initialState={initialState}
          danger={danger}
          cancelLabel={cancelLabel}
          returnFocus={opener}
          onDone={(r) => {
            setOpen(false);
            setDone(r);
            requestAnimationFrame(() => document.getElementById(resultId)?.focus());
          }}
        >
          {({ requestId }) => (
            <>
              <HiddenFields fields={fields} requestId={requestId} />
              {children}
            </>
          )}
        </DeskDialog>
      ) : null}
      {done ? (
        <div id={resultId} tabIndex={-1} className="outline-none">
          <DeskResultLine state={done} okTitle={okTitle} warnOkMessage={warnOkMessage} />
        </div>
      ) : null}
    </span>
  );
}

/** Reason textarea (10..500 characters unless stated), kept after a refusal. */
export function ReasonField({ id, label = 'Reason', hint, min = 10, max = 500, name = 'reason', defaultValue }: { id: string; label?: string; hint?: ReactNode; min?: number; max?: number; name?: string; defaultValue?: string }) {
  return (
    <Field htmlFor={id} label={label} hint={hint ?? `${min} to ${max} characters. Saved with the change and shown in the history.`}>
      <Textarea id={id} name={name} minLength={min} maxLength={max} required rows={3} defaultValue={defaultValue} aria-describedby={`${id}-hint`} />
    </Field>
  );
}
