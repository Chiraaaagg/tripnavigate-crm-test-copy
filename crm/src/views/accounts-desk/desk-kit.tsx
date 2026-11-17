'use client';

import { useCallback, useEffect, useId, useRef, useState, useTransition, type FormEvent, type ReactNode, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ErrorSummary } from '@/components/ui/error-summary';
import { Notice } from '@/components/ui/notice';
import { guard, useRequestId, type DecisionAction, type UiResult } from '@/views/accounts/supplier-forms';

/*
 * Client kit for the Accounts desk forms (contract 0 UI rules). A form is
 * never reset: the browser keeps every typed value while the dialog is open,
 * and a refusal leaves the dialog open with the values and one plain line.
 * One request id per form, renewed only after a confirmed success, so a
 * double press or a retry after a lost reply is the same request.
 */

export type DeskResult = UiResult;

export function useDeskCommand(action: DecisionAction, initialState: DeskResult | null = null) {
  const [state, setState] = useState<DeskResult | null>(initialState);
  const [pending, start] = useTransition();
  const requestId = useRequestId(state);
  const busy = useRef(false);
  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>, after?: (r: DeskResult) => void) => {
      event.preventDefault();
      if (busy.current) return;
      busy.current = true;
      const fd = new FormData(event.currentTarget);
      start(async () => {
        try {
          const r = await guard(action)(null, fd);
          setState(r);
          after?.(r);
        } finally {
          busy.current = false;
        }
      });
    },
    [action],
  );
  return { state, pending, requestId, submit, setState };
}

/** The field a refusal names: `field` (Accounts desk actions) or the first of `fields` (other modules). */
export function refusedField(state: DeskResult | null): string | null {
  if (!state || state.ok) return null;
  const s = state as { field?: unknown; fields?: unknown };
  if (typeof s.field === 'string' && s.field) return s.field;
  if (Array.isArray(s.fields) && typeof s.fields[0] === 'string') return s.fields[0];
  return null;
}

/** Plain words for refusal hints that name a situation rather than a field. */
const HINT_TEXT: Record<string, string> = {
  notReopenable: 'A GST invoice reference cannot be reopened. Withdraw the GST reference on the Deal page instead, then add the right one.',
};

/** The message to show for a refusal (a known hint wins over the generic text). */
export function refusalMessage(state: DeskResult): string {
  const f = refusedField(state);
  return (f && HINT_TEXT[f]) || (state.ok ? '' : state.message);
}

/** Result line under a form or at the top of a list after a dialog closed. */
export function DeskResultLine({ state, okTitle = 'Done', failTitle = 'Not saved', id, warnOkMessage }: { state: DeskResult | null; okTitle?: string; failTitle?: string; id?: string; /** A success with exactly this message is shown as a warning (saved, but something is left to check). */ warnOkMessage?: string }) {
  if (!state) return <div id={id} role="status" aria-live="polite" className="contents" />;
  if (state.ok && warnOkMessage && state.message === warnOkMessage)
    return (
      <Notice tone="warning" role="status" id={id}>
        <p>
          <strong>Saved, check this: </strong>
          {state.message}
        </p>
      </Notice>
    );
  return state.ok ? (
    <Notice tone="success" role="status" id={id}>
      <p>
        <strong>{okTitle}: </strong>
        {state.message || 'Saved.'}
      </p>
    </Notice>
  ) : (
    <Notice tone="danger" role="alert" id={id}>
      <p>
        <strong>{failTitle}: </strong>
        {refusalMessage(state)}
      </p>
    </Notice>
  );
}

/** The visible control a refusal names inside a form (tries the rupee twin of a paise field). */
export function controlFor(form: HTMLFormElement | null, field: string | null): HTMLElement | null {
  if (!form || !field) return null;
  for (const name of [field, field.replace(/Paise$/, 'Rupees')]) {
    const el = form.elements.namedItem(name);
    if (el instanceof HTMLElement && !(el instanceof HTMLInputElement && el.type === 'hidden')) return el;
  }
  return null;
}

/**
 * Marks the control a refusal names (aria-invalid, described by the refusal)
 * and focuses it (pass the form element itself, from a callback ref). Returns its id and label for the summary link, or null.
 */
export function useRefusedControl(form: HTMLFormElement | null, refused: DeskResult | null, summaryId: string) {
  const [target, setTarget] = useState<{ id: string; label: string } | null>(null);
  useEffect(() => {
    form?.querySelectorAll('[data-refused="true"]').forEach((el) => {
      el.removeAttribute('aria-invalid');
      el.removeAttribute('data-refused');
      const d = el.getAttribute('data-described-before');
      if (d) el.setAttribute('aria-describedby', d);
      else el.removeAttribute('aria-describedby');
      el.removeAttribute('data-described-before');
    });
    const el = controlFor(form, refusedField(refused));
    const frame = requestAnimationFrame(() => {
      if (!el) {
        setTarget(null);
        return;
      }
      const before = el.getAttribute('aria-describedby') ?? '';
      el.setAttribute('aria-invalid', 'true');
      el.setAttribute('data-refused', 'true');
      el.setAttribute('data-described-before', before);
      el.setAttribute('aria-describedby', `${before} ${summaryId}`.trim());
      const label = el.id ? (form?.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent ?? '') : '';
      setTarget(el.id ? { id: el.id, label: label.replace('(optional)', '').trim() || 'the highlighted field' } : null);
      el.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [form, refused, summaryId]);
  return target;
}

/**
 * A dialog with one form: title, what happens, the fields, Cancel and one
 * primary button. A confirmed success closes it and calls onDone (the caller
 * shows the result line and moves focus); a refusal keeps it open, marks the
 * field it names and focuses it. When the dialog closes, focus returns to
 * `returnFocus` (the button that opened it) unless the caller already moved
 * it (for example to the result line).
 */
export function DeskDialog({
  open,
  onOpenChange,
  title,
  description,
  primaryLabel,
  pendingLabel,
  action,
  initialState,
  danger,
  cancelLabel = 'Cancel',
  onDone,
  hidePrimary = false,
  returnFocus,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  primaryLabel: string;
  pendingLabel: string;
  action: DecisionAction;
  /** Preview gallery: start with a refusal on screen. */
  initialState?: DeskResult | null;
  danger?: boolean;
  /** The close button's words ("Keep the request" when the primary itself cancels something). */
  cancelLabel?: string;
  onDone: (r: DeskResult & { ok: true }) => void;
  /** Nothing to submit (e.g. no task to choose): only the close button shows. */
  hidePrimary?: boolean;
  /** The control that opened the dialog: focus returns there on close. */
  returnFocus?: RefObject<HTMLElement | null>;
  children: (ctx: { requestId: string; refused: DeskResult | null }) => ReactNode;
}) {
  const cmd = useDeskCommand(action, initialState ?? null);
  const refused = cmd.state && !cmd.state.ok ? cmd.state : null;
  // A callback ref: the dialog's form mounts after this component (portal), so the effect waits for it.
  const [form, setForm] = useState<HTMLFormElement | null>(null);
  const summaryId = useId();
  const target = useRefusedControl(form, refused, summaryId);

  // The dialog unmounts when closed: return focus to the opener unless something else already took it.
  useEffect(() => {
    const ref = returnFocus;
    return () => {
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (!active || active === document.body) ref?.current?.focus();
      });
    };
  }, [returnFocus]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={(e) => {
          if (returnFocus?.current) {
            e.preventDefault();
            returnFocus.current.focus();
          }
        }}
      >
        <form
          ref={setForm}
          noValidate
          onSubmit={(e) =>
            cmd.submit(e, (r) => {
              if (r.ok) onDone(r);
            })
          }
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4">
            {refused ? (
              <div id={summaryId}>
                {/* The named field takes focus; without one the summary does. */}
                <ErrorSummary
                  title="Nothing was saved"
                  description={refusalMessage(refused)}
                  focusOnMount={!controlFor(form, refusedField(refused))}
                  items={target ? [{ fieldId: target.id, text: `Check: ${target.label}` }] : []}
                >
                  {form?.querySelector('input:not([type="hidden"]), textarea, select') ? <p className="m-0 mt-[0.25rem] text-sm">What you typed is still here.</p> : null}
                </ErrorSummary>
              </div>
            ) : null}
            {children({ requestId: cmd.requestId, refused })}
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                {cancelLabel}
              </Button>
            </DialogClose>
            {hidePrimary ? null : (
              <Button
                type="submit"
                variant={danger ? 'danger' : 'primary'}
                aria-disabled={cmd.pending || undefined}
                onClick={(e) => {
                  if (cmd.pending) e.preventDefault();
                }}
              >
                {cmd.pending ? pendingLabel : primaryLabel}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** IST "today" as YYYY-MM-DD (the local `max` of date inputs; the database decides). */
export function todayIst(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
