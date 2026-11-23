'use client';

import { useActionState, useEffect, useId, useRef, useState, useTransition, type ReactNode } from 'react';
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
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { SwitchRow, switchRowDescribedBy, type SwitchState } from '@/components/ui/switch-row';
import { ConfirmChange, REASON_LIMITS, type ConfirmAction, type ConfirmResult } from '@/components/ui/confirm-change';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { Textarea } from '@/components/ui/textarea';
import type { SettingKey, SettingReviewVM } from '@/modules/settings/contracts';
import type { ReasonRule } from '@/modules/settings/reason';
import type { VisaPreviewModel } from '@/modules/settings/rows';
import { SWITCH_FIELD, type SwitchActionResult } from '@/modules/settings/switch';
import { SETTINGS_TEXT } from '@/modules/settings/text';

/*
 * UX redesign R1 (C6 switch row, C7 confirm dialog, owner D9): one switch's
 * change control. "Change" opens one confirm dialog that switches to the
 * other state: title, what happens, who is affected, the reason box (optional
 * outside the four STANDING-RULES families, required inside them), Cancel
 * (focused first) and one button named for the action. The form posts the
 * same fields as before: settingKey, state, reason, confirm=yes (and
 * reviewedCount when Visa and passport tasks are switched on). A refusal
 * keeps the dialog open with the typed reason; a save closes it and the
 * server's words appear beside the button.
 *
 * Visa and passport tasks switched on counts the waiting services when the
 * dialog opens (DA-258, never at page load) and keeps the confirm button
 * disabled until the CRM returned a count (lead ruling). ConfirmChange cannot
 * disable its confirm button, so that one dialog is built here on the same
 * Alert Dialog frame, with the same layout and rules.
 */

export interface SettingSwitchActions {
  change: (prev: SwitchActionResult | null, formData: FormData) => Promise<SwitchActionResult>;
  /** Visa and passport tasks: counted when the confirm dialog opens (never at page load). */
  previewVisa?: () => Promise<VisaPreviewModel>;
}

const fill = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (all, k: string) => (k in v ? v[k]! : all));

/** "Change" on screen; "Change {switch}" for screen readers and tests (each row button names its record). */
export function changeLabel(title: string): ReactNode {
  return (
    <>
      <span className="sr-only">Change {title}</span>
      <span aria-hidden="true">Change</span>
    </>
  );
}

export function reasonHintFor(rule: ReasonRule): string {
  return rule === 'optional' ? SETTINGS_TEXT.reasonOptionalHint : SETTINGS_TEXT.reasonRequiredHint;
}

/** The change control of one Features or Bitrix connection switch (changeSettingSwitchAction). */
export function SettingSwitchChange({
  settingKey,
  title,
  state,
  review,
  actions,
  reasonRule,
  describedBy,
  initialOpen,
  initialReason,
  initialResult,
  initialVisa,
}: {
  settingKey: SettingKey;
  title: string;
  /** The state now; the dialog switches to the other one. */
  state: 'on' | 'off';
  review: SettingReviewVM;
  actions: SettingSwitchActions;
  reasonRule: ReasonRule;
  /** The switch row's name and state ids. */
  describedBy?: string;
  /** Preview gallery only. */
  initialOpen?: boolean;
  initialReason?: string;
  initialResult?: SwitchActionResult | null;
  initialVisa?: VisaPreviewModel | null;
}) {
  const target = state === 'on' ? 'off' : 'on';
  const confirmLabel = fill(SETTINGS_TEXT.confirmButton, { switch: title, state: target });
  const effect = target === 'on' ? review.onText : review.offText;
  if (settingKey === 'visa_passport_tasks_enabled' && target === 'on') {
    return (
      <VisaSwitchOn
        title={title}
        effect={effect}
        approvalLine={review.approvalLine}
        confirmLabel={confirmLabel}
        actions={actions}
        reasonRule={reasonRule}
        describedBy={describedBy}
        initialOpen={initialOpen}
        initialReason={initialReason}
        initialResult={initialResult}
        initialVisa={initialVisa}
      />
    );
  }
  return (
    <ConfirmChange<SwitchActionResult>
      title={`${confirmLabel}?`}
      effect={effect}
      affected="Every branch."
      confirmLabel={confirmLabel}
      tone={target === 'off' ? 'danger' : 'primary'}
      reason={reasonRule}
      reasonName={SWITCH_FIELD.reason}
      reasonLabel={SETTINGS_TEXT.reasonLabel}
      reasonHint={reasonHintFor(reasonRule)}
      formAction={actions.change}
      hiddenFields={{ [SWITCH_FIELD.key]: settingKey, [SWITCH_FIELD.state]: target, [SWITCH_FIELD.confirm]: 'yes' }}
      trigger={{ label: changeLabel(title), describedBy }}
      initialOpen={initialOpen}
      initialReason={initialReason}
      initialResult={initialResult}
    >
      <p className="m-0 text-sm text-quiet">{review.approvalLine}</p>
    </ConfirmChange>
  );
}

/** Visa and passport tasks: switch on, with the count read when the dialog opens. */
function VisaSwitchOn({
  title,
  effect,
  approvalLine,
  confirmLabel,
  actions,
  reasonRule,
  describedBy,
  initialOpen = false,
  initialReason = '',
  initialResult = null,
  initialVisa = null,
}: {
  title: string;
  effect: string;
  approvalLine: string;
  confirmLabel: string;
  actions: SettingSwitchActions;
  reasonRule: ReasonRule;
  describedBy?: string;
  initialOpen?: boolean;
  initialReason?: string;
  initialResult?: SwitchActionResult | null;
  initialVisa?: VisaPreviewModel | null;
}) {
  const id = useId();
  const reasonId = `${id}-reason`;
  const [open, setOpen] = useState(initialOpen);
  const [reason, setReason] = useState(initialReason);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [visa, setVisa] = useState<VisaPreviewModel | null>(initialVisa);
  const [counting, startCounting] = useTransition();
  const [result, dispatch, pending] = useActionState(actions.change, initialResult);
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
      setVisa(null);
      setCheckError(null);
    } else if (result) {
      setFocusTick((f) => ({ to: result.fields?.includes('reason') ? 'reason' : 'refusal', n: (f?.n ?? 0) + 1 }));
    }
  }

  useEffect(() => {
    if (!focusTick) return;
    (focusTick.to === 'reason' ? reasonRef.current : refusalRef.current)?.focus();
  }, [focusTick]);

  const count = () => {
    const preview = actions.previewVisa;
    if (!preview) return;
    setVisa(null);
    startCounting(async () => {
      try {
        setVisa(await preview());
      } catch {
        setVisa({ state: 'uncounted', lines: [SETTINGS_TEXT.visaUncounted], canConfirm: false });
      }
    });
  };

  const onOpenChange = (next: boolean) => {
    if (pending) return;
    setOpen(next);
    if (next) {
      if (!visa) count();
    } else {
      setReason('');
      setCheckError(null);
      setVisa(null);
    }
  };

  const refused = result && !result.ok ? result : null;
  const reasonProblem = checkError ?? (refused?.fields?.includes('reason') ? SETTINGS_TEXT.refusedReason : null);
  const noPreview = !actions.previewVisa;
  const blocked = counting || !visa || !visa.canConfirm || noPreview;

  const check = (event: { preventDefault: () => void }) => {
    const length = reason.replace(/\s+/g, ' ').trim().length;
    // An optional reason may be empty; a typed one needs 10 to 500 characters (the database rule).
    if ((reasonRule === 'optional' && length === 0) || (length >= REASON_LIMITS.min && length <= REASON_LIMITS.max)) {
      setCheckError(null);
      return;
    }
    event.preventDefault();
    setCheckError(SETTINGS_TEXT.refusedReason);
    setFocusTick((f) => ({ to: 'reason', n: (f?.n ?? 0) + 1 }));
  };

  return (
    <div className="flex flex-col items-start gap-1.5" data-slot="confirm-change">
      <AlertDialog open={open} onOpenChange={onOpenChange}>
        <AlertDialogTrigger asChild>
          <Button variant="secondary" size="sm" aria-describedby={describedBy}>
            {changeLabel(title)}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{`${confirmLabel}?`}</AlertDialogTitle>
            <AlertDialogDescription>{effect}</AlertDialogDescription>
            <p className="m-0 mt-1 text-sm text-quiet">
              <span className="font-semibold text-ink">Who is affected: </span>
              Every branch.
            </p>
          </AlertDialogHeader>
          <HandForm action={dispatch} onSubmit={check} noValidate aria-label={`${confirmLabel}?`}>
            <AlertDialogBody>
              {refused ? (
                <div ref={refusalRef} tabIndex={-1} className="outline-none">
                  <Notice tone="danger" role="alert" title="Not changed">
                    <p>{refused.message}</p>
                    <p>Your typed reason is still in the box.</p>
                  </Notice>
                </div>
              ) : null}
              <div aria-live="polite" className="flex flex-col gap-1.5 text-copy" data-slot="visa-count">
                {noPreview ? (
                  <p className="m-0 font-semibold text-ink">{SETTINGS_TEXT.visaUncounted}</p>
                ) : counting || !visa ? (
                  <p className="m-0">{SETTINGS_TEXT.visaCounting}</p>
                ) : (
                  visa.lines.map((line) => (
                    <p key={line} className={visa.canConfirm ? 'm-0' : 'm-0 font-semibold text-ink'}>
                      {line}
                    </p>
                  ))
                )}
              </div>
              <p className="m-0 text-sm text-quiet">{approvalLine}</p>
              <input type="hidden" name={SWITCH_FIELD.key} value="visa_passport_tasks_enabled" />
              <input type="hidden" name={SWITCH_FIELD.state} value="on" />
              <input type="hidden" name={SWITCH_FIELD.confirm} value="yes" />
              {visa?.state === 'counted' ? <input type="hidden" name={SWITCH_FIELD.reviewedCount} value={String(visa.wouldCreate)} /> : null}
              <Field htmlFor={reasonId} label={SETTINGS_TEXT.reasonLabel} optional={reasonRule === 'optional'} hint={reasonHintFor(reasonRule)} error={reasonProblem}>
                <Textarea
                  ref={reasonRef}
                  id={reasonId}
                  name={SWITCH_FIELD.reason}
                  rows={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={REASON_LIMITS.max}
                  required={reasonRule === 'required'}
                  invalid={Boolean(reasonProblem)}
                  aria-describedby={fieldDescribedBy(reasonId, { hint: true, error: reasonProblem })}
                />
              </Field>
            </AlertDialogBody>
            <AlertDialogFooter>
              <AlertDialogCancel asChild>
                <Button variant="secondary" disabled={pending}>
                  Cancel
                </Button>
              </AlertDialogCancel>
              <Button type="submit" variant="primary" loading={pending} disabled={blocked}>
                {confirmLabel}
              </Button>
            </AlertDialogFooter>
          </HandForm>
        </AlertDialogContent>
      </AlertDialog>
      {/* Always in the page, so screen readers announce the words when they appear. */}
      <p role="status" className="m-0 text-sm text-copy">
        {result?.ok && result.message ? result.message : null}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Adapter: the existing server actions keep their own result shapes; the
// dialog needs { ok, message, fields }. The action and the posted fields are
// unchanged.
// ---------------------------------------------------------------------------

/** Any existing settings action (Accounts desk, documents, refunds, write-offs, Tally file, notices). */
export type ExistingSettingsAction = (prev: never, formData: FormData) => Promise<unknown>;

const UNKNOWN_OUTCOME = 'We could not confirm this was saved. Reload the page to check before you try again. Your typed details are still here.';

/**
 * Wraps an existing action for ConfirmChange. A refusal names its field as
 * `field` (Accounts desk) or `fields` (other modules); both become `fields`.
 * `onRefusedField` lets the dialog mark one of its own inputs (a limit, a
 * company name). A thrown error is "could not confirm", never "not saved".
 */
export function confirmActionOf(action: ExistingSettingsAction, opts: { okMessage?: string; onRefusedField?: (field: string | null) => void } = {}): ConfirmAction<ConfirmResult> {
  return async (_prev, formData) => {
    let reply: unknown;
    try {
      reply = await action(null as never, formData);
    } catch (error) {
      // Next.js control-flow errors (a sign-in redirect) carry a digest: let Next.js handle them.
      if (error && typeof error === 'object' && 'digest' in error) throw error;
      opts.onRefusedField?.(null);
      return { ok: false, message: UNKNOWN_OUTCOME };
    }
    const r = (reply ?? {}) as { ok?: boolean; message?: string; field?: unknown; fields?: unknown };
    if (r.ok) {
      opts.onRefusedField?.(null);
      return { ok: true, message: r.message || opts.okMessage || 'Saved.' };
    }
    const field = typeof r.field === 'string' && r.field ? r.field : Array.isArray(r.fields) && typeof r.fields[0] === 'string' ? (r.fields[0] as string) : null;
    opts.onRefusedField?.(field);
    return { ok: false, message: r.message || UNKNOWN_OUTCOME, ...(field ? { fields: [field] } : {}) };
  };
}

/**
 * The change control of a switch with its own existing action (staff notices,
 * the Accounts switches). Posts `hiddenFields` (the page's existing field
 * names) plus the reason; `fields(refusedField)` adds inputs the change needs
 * (a limit, a company name) and marks the one a refusal names.
 */
export function ExistingActionChange({
  title,
  confirmLabel,
  effect,
  affected,
  tone = 'primary',
  action,
  hiddenFields,
  reasonRule,
  okMessage,
  describedBy,
  fields,
  initialOpen,
  initialReason,
  initialResult,
}: {
  /** The thing changed, for the button's name: "Change {title}". */
  title: string;
  confirmLabel: string;
  effect: ReactNode;
  affected?: ReactNode;
  tone?: 'primary' | 'danger';
  action: ExistingSettingsAction;
  hiddenFields: Readonly<Record<string, string>>;
  reasonRule: ReasonRule;
  okMessage?: string;
  describedBy?: string;
  fields?: (refusedField: string | null) => ReactNode;
  /** Preview gallery only. */
  initialOpen?: boolean;
  initialReason?: string;
  initialResult?: ConfirmResult | null;
}) {
  const [refusedField, setRefusedField] = useState<string | null>(initialResult && !initialResult.ok ? (initialResult.fields?.[0] ?? null) : null);
  const [formAction] = useState(() => confirmActionOf(action, { okMessage, onRefusedField: setRefusedField }));
  return (
    <ConfirmChange
      title={`${confirmLabel}?`}
      effect={effect}
      affected={affected}
      confirmLabel={confirmLabel}
      tone={tone}
      reason={reasonRule}
      reasonName="reason"
      reasonLabel={SETTINGS_TEXT.reasonLabel}
      reasonHint={reasonHintFor(reasonRule)}
      formAction={formAction}
      hiddenFields={hiddenFields}
      trigger={{ label: changeLabel(title), describedBy }}
      initialOpen={initialOpen}
      initialReason={initialReason}
      initialResult={initialResult}
    >
      {fields ? fields(refusedField) : null}
    </ConfirmChange>
  );
}

/** Preview gallery only: a row's dialog open with a reason or a reply. */
export interface ActionRowPreview {
  open?: boolean;
  reason?: string;
  result?: ConfirmResult | null;
}

/**
 * One Settings row whose change uses an existing action (C6 + C7): name, one
 * line of effect, state in words, "Change" opening the confirm dialog. A
 * state that could not be read shows Not known with Change disabled and the
 * reason; `readOnlyReason` does the same for a person who may not change it.
 */
export function ActionSwitchRow({
  id,
  rowKey,
  name,
  changeName,
  effect,
  more,
  state,
  readOnlyReason,
  change,
  preview,
}: {
  id: string;
  /** data-key of the row (tests and the gallery). */
  rowKey: string;
  name: string;
  /** The Change button's accessible name after "Change" (default the row name), e.g. "Refunds for Holiday Chacha Pvt LTD". */
  changeName?: string;
  effect: ReactNode;
  more?: ReactNode;
  state: SwitchState;
  readOnlyReason?: ReactNode;
  /** Everything ExistingActionChange needs except the parts this row fills in. */
  change: Omit<Parameters<typeof ExistingActionChange>[0], 'title' | 'describedBy' | 'initialOpen' | 'initialReason' | 'initialResult'>;
  preview?: ActionRowPreview;
}) {
  const unknown = state === 'unknown';
  return (
    <li className="m-0 border-b border-line last:border-b-0" data-slot="setting-row" data-key={rowKey} data-state={state}>
      <SwitchRow
        id={id}
        className="border-b-0"
        name={name}
        effect={effect}
        more={more}
        state={state}
        disabledReason={unknown ? NOT_READ_TEXT : (readOnlyReason ?? undefined)}
        change={
          unknown || readOnlyReason ? null : (
            <ExistingActionChange
              {...change}
              title={changeName ?? name}
              describedBy={switchRowDescribedBy(id)}
              initialOpen={preview?.open}
              initialReason={preview?.reason}
              initialResult={preview?.result}
            />
          )
        }
      />
    </li>
  );
}

/** A setting the CRM could not read: Not known, never Off, and no change until it can be read. */
export const NOT_READ_TEXT = 'The current setting could not be read, so it shows as Not known and cannot be changed from here right now. Reload the page to check again.';

export const onOffState = (v: boolean | null | undefined): SwitchState => (v === true ? 'on' : v === false ? 'off' : 'unknown');

/**
 * Money rules (R1): one "Change" that opens an existing multi-field form in a
 * dialog (the finance policy form: same fields, rules, action and messages).
 * The form keeps its own result line; a refusal leaves the dialog open with
 * the typed values. Content renders only while open, on the client.
 */
export function FormChangeDialog({
  label,
  title,
  description,
  initialOpen = false,
  children,
}: {
  /** The button: "Change the policy". */
  label: string;
  title: string;
  description?: ReactNode;
  /** Preview gallery only (and a refused post shown again). */
  initialOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="primary" size="sm">
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogBody>{children}</DialogBody>
      </DialogContent>
    </Dialog>
  );
}
