'use client';

import { useActionState, useEffect, useId, useRef, useState, type ReactNode, type SubmitEvent } from 'react';
import { HandForm } from '@/components/hand-form';
import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from './alert-dialog';
import { Button, type ButtonVariantProps } from './button';
import { Field, fieldDescribedBy } from './field';
import { Notice } from './notice';
import { Textarea } from './textarea';

/*
 * C7: one confirm dialog for a change (Settings switches, Return with a
 * reason, and similar). Title, one sentence of effect, who is affected, the
 * reason box, Cancel (focused first) and ONE confirm button named for the
 * action. The form inside posts the same field names the page posts today:
 * the page's hidden fields plus the reason under `reasonName`.
 *
 * reason 'optional' (owner D9): may be left empty; an empty box posts "".
 * reason 'required': 10 to 500 characters, checked here and again on the server.
 * A refusal (from this check or from the server) keeps the dialog open with
 * the typed reason and says what to fix; a save closes it, puts focus back on
 * the opener and shows the server's words beside it. Built on HandForm, so
 * React never resets the typed reason.
 *
 * The approved forms (Book now, Purchase, Flight, Visa) keep their current
 * dialog; this part is for the redesigned screens only.
 */

/** What a page's change action returns. SwitchActionResult (modules/settings/switch.ts) fits as it is. */
export interface ConfirmResult {
  ok: boolean;
  message?: string;
  /** Field names the server refused; the reason box shows as invalid when it is listed. */
  fields?: readonly string[];
}

export type ConfirmAction<R extends ConfirmResult> = (prev: R | null, formData: FormData) => Promise<R>;

export type ReasonMode = 'none' | 'optional' | 'required';

/** The reason rule the database applies to Settings changes and Returns (authz.settings_change_reason). */
export const REASON_LIMITS = { min: 10, max: 500 } as const;

export interface ConfirmChangeProps<R extends ConfirmResult> {
  /** Dialog title, a question naming the change: "Switch Hotel go-ahead off?" */
  title: string;
  /** One sentence: what happens when confirmed. */
  effect: ReactNode;
  /** Who notices the change: "Accounts and every Purchase person in Jodhpur." */
  affected?: ReactNode;
  /** The confirm button, named for the action: "Switch off". */
  confirmLabel: string;
  /** danger = red confirm button (switching something off, returning work). */
  tone?: 'primary' | 'danger';
  reason: ReasonMode;
  /** Field name the reason posts under (the page's existing name). Default "reason". */
  reasonName?: string;
  reasonLabel?: string;
  reasonHint?: ReactNode;
  /** The page's existing server action. */
  formAction: ConfirmAction<R>;
  /** Fields the page posts today, sent unchanged. */
  hiddenFields?: Readonly<Record<string, string>>;
  /** The button that opens the dialog. */
  trigger: {
    label: ReactNode;
    variant?: ButtonVariantProps['variant'];
    size?: ButtonVariantProps['size'];
    /** ids that name what the button changes (e.g. the switch row's name and state). */
    describedBy?: string;
    className?: string;
  };
  /** Extra content inside the form, above the reason (for example a choice the change needs). */
  children?: ReactNode;
  /** Preview gallery only: open on first load. */
  initialOpen?: boolean;
  /** Preview gallery only: text already in the reason box. */
  initialReason?: string;
  /** Preview gallery only: a reply already received. */
  initialResult?: R | null;
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

export function ConfirmChange<R extends ConfirmResult>({
  title,
  effect,
  affected,
  confirmLabel,
  tone = 'primary',
  reason: mode,
  reasonName = 'reason',
  reasonLabel = 'Reason',
  reasonHint,
  formAction,
  hiddenFields,
  trigger,
  children,
  initialOpen = false,
  initialReason = '',
  initialResult = null,
}: ConfirmChangeProps<R>) {
  const id = useId();
  const reasonId = `${id}-reason`;
  const [open, setOpen] = useState(initialOpen);
  const [reason, setReason] = useState(initialReason);
  const [checkError, setCheckError] = useState<string | null>(null);
  // Typed through ConfirmResult: React's useActionState cannot infer Awaited<R> for a generic R.
  const action = (prev: ConfirmResult | null, formData: FormData): Promise<ConfirmResult> => formAction(prev as R | null, formData);
  const [result, dispatch, pending] = useActionState<ConfirmResult | null, FormData>(action, initialResult);
  const [seenResult, setSeenResult] = useState(result);
  const [focusTick, setFocusTick] = useState<{ to: 'reason' | 'refusal'; n: number } | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const refusalRef = useRef<HTMLDivElement>(null);

  // A new reply (render-time adjustment): a save closes the dialog; a refusal stays open with the reason kept.
  if (result !== seenResult) {
    setSeenResult(result);
    if (result?.ok) {
      setOpen(false);
      setReason('');
      setCheckError(null);
    } else if (result) {
      setFocusTick((f) => ({ to: result.fields?.includes(reasonName) ? 'reason' : 'refusal', n: (f?.n ?? 0) + 1 }));
    }
  }

  useEffect(() => {
    if (!focusTick) return;
    (focusTick.to === 'reason' ? reasonRef.current : refusalRef.current)?.focus();
  }, [focusTick]);

  const refused = result && !result.ok ? result : null;
  const reasonRefused = Boolean(refused?.fields?.includes(reasonName));
  const reasonProblem =
    checkError ?? (reasonRefused ? `Write the reason in ${REASON_LIMITS.min} to ${REASON_LIMITS.max} characters. Your text is still in the box.` : null);
  const hint =
    reasonHint ??
    (mode === 'required'
      ? `${REASON_LIMITS.min} to ${REASON_LIMITS.max} characters. It is kept with the change, with your name and the time.`
      : 'You may leave it empty. The change, your name and the time are kept either way.');

  const check = (event: SubmitEvent<HTMLFormElement>) => {
    if (mode !== 'required') return;
    const length = collapse(reason).length;
    if (length >= REASON_LIMITS.min && length <= REASON_LIMITS.max) {
      setCheckError(null);
      return;
    }
    event.preventDefault();
    setCheckError(
      length < REASON_LIMITS.min
        ? `Write the reason: at least ${REASON_LIMITS.min} characters. Nothing was changed.`
        : `Shorten the reason to ${REASON_LIMITS.max} characters or fewer. Nothing was changed.`,
    );
    setFocusTick((f) => ({ to: 'reason', n: (f?.n ?? 0) + 1 }));
  };

  const onOpenChange = (next: boolean) => {
    if (pending) return;
    setOpen(next);
    if (!next) {
      setReason('');
      setCheckError(null);
    }
  };

  return (
    <div className="flex flex-col items-start gap-1.5" data-slot="confirm-change">
      <AlertDialog open={open} onOpenChange={onOpenChange}>
        <AlertDialogTrigger asChild>
          <Button variant={trigger.variant ?? 'secondary'} size={trigger.size ?? 'sm'} aria-describedby={trigger.describedBy} className={trigger.className}>
            {trigger.label}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{effect}</AlertDialogDescription>
            {affected ? (
              <p className="m-0 mt-1 text-sm text-quiet">
                <span className="font-semibold text-ink">Who is affected: </span>
                {affected}
              </p>
            ) : null}
          </AlertDialogHeader>
          <HandForm action={dispatch} onSubmit={check} noValidate aria-label={title}>
            <AlertDialogBody>
              {refused ? (
                <div ref={refusalRef} tabIndex={-1} className="outline-none">
                  <Notice tone="danger" role="alert" title="Not changed">
                    <p>{refused.message ?? 'The change was refused.'}</p>
                    {mode !== 'none' ? <p>Your typed reason is still in the box.</p> : null}
                  </Notice>
                </div>
              ) : null}
              {children}
              {hiddenFields ? Object.entries(hiddenFields).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />) : null}
              {mode === 'none' ? null : (
                <Field htmlFor={reasonId} label={reasonLabel} optional={mode === 'optional'} hint={hint} error={reasonProblem}>
                  <Textarea
                    ref={reasonRef}
                    id={reasonId}
                    name={reasonName}
                    rows={3}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    maxLength={REASON_LIMITS.max}
                    required={mode === 'required'}
                    invalid={Boolean(reasonProblem)}
                    aria-describedby={fieldDescribedBy(reasonId, { hint: true, error: reasonProblem })}
                  />
                </Field>
              )}
            </AlertDialogBody>
            <AlertDialogFooter>
              <AlertDialogCancel asChild>
                <Button variant="secondary" disabled={pending}>
                  Cancel
                </Button>
              </AlertDialogCancel>
              <Button type="submit" variant={tone === 'danger' ? 'danger' : 'primary'} loading={pending}>
                {confirmLabel}
              </Button>
            </AlertDialogFooter>
          </HandForm>
        </AlertDialogContent>
      </AlertDialog>
      {/* Always in the page (empty until a save, never display:none), so screen readers announce the words when they appear. */}
      <p role="status" className="m-0 text-sm text-copy">
        {result?.ok && result.message ? result.message : null}
      </p>
    </div>
  );
}
