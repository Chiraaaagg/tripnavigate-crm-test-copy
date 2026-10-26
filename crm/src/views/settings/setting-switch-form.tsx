'use client';

import { useActionState, useEffect, useId, useRef, useState, useTransition } from 'react';
import { HandForm } from '@/components/hand-form';
import { Button } from '@/components/ui/button';
import { ChoiceGroup, Radio } from '@/components/ui/choice';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { Textarea } from '@/components/ui/textarea';
import { SETTINGS_REASON_LIMITS, type SettingKey, type SettingReviewVM } from '@/modules/settings/contracts';
import type { VisaPreviewModel } from '@/modules/settings/rows';
import { SWITCH_FIELD, type SwitchActionResult } from '@/modules/settings/switch';
import { SETTINGS_TEXT } from '@/modules/settings/text';

/*
 * One switch's change flow (DA-256, pattern P-SETTING, catalog gap G5):
 * "Change {switch}" opens step 1 (Set it to On/Off and the reason), "Review
 * change" opens step 2 (what changes, the owner-approval line, the reason;
 * for Visa and passport tasks the count is read now, DA-258), and only the
 * confirm button posts, with confirm=yes (the server refuses a post without
 * it). Built on the shared HandForm, so the choice and the reason stay on
 * screen after every refusal (R10). Focus moves to each step's heading, to
 * the reason after a reason refusal, and to the result after a save.
 */

export interface SettingSwitchActions {
  change: (prev: SwitchActionResult | null, formData: FormData) => Promise<SwitchActionResult>;
  /** Visa and passport tasks: counted when "Review change" is pressed (never at page load). */
  previewVisa?: () => Promise<VisaPreviewModel>;
}

type Step = 'closed' | 'choose' | 'review';
type FocusTarget = 'choose' | 'review' | 'reason' | 'trigger' | 'result';

const fill = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (all, k: string) => (k in v ? v[k]! : all));

export function SettingSwitchForm({
  settingKey,
  title,
  state,
  review,
  actions,
  initialResult = null,
  initialStep = 'closed',
  initialReason = '',
  initialVisa = null,
}: {
  settingKey: SettingKey;
  title: string;
  state: 'on' | 'off';
  review: SettingReviewVM;
  actions: SettingSwitchActions;
  /** Preview gallery only. */
  initialResult?: SwitchActionResult | null;
  /** Preview gallery only. */
  initialStep?: Step;
  /** Preview gallery only. */
  initialReason?: string;
  /** Preview gallery only. */
  initialVisa?: VisaPreviewModel | null;
}) {
  const id = useId();
  const [result, formAction, pending] = useActionState(actions.change, initialResult);
  const [step, setStep] = useState<Step>(initialStep);
  const [target, setTarget] = useState<'on' | 'off'>(state === 'on' ? 'off' : 'on');
  const [reason, setReason] = useState(initialReason);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [visa, setVisa] = useState<VisaPreviewModel | null>(initialVisa);
  const [counting, startCounting] = useTransition();
  const [focus, setFocus] = useState<{ target: FocusTarget; n: number } | null>(null);
  const moveFocus = (to: FocusTarget) => setFocus((f) => ({ target: to, n: (f?.n ?? 0) + 1 }));
  const chooseHeading = useRef<HTMLHeadingElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const reasonField = useRef<HTMLTextAreaElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const resultBox = useRef<HTMLDivElement>(null);
  const [seenResult, setSeenResult] = useState(result);

  // A new reply (render-time adjustment): a save closes the steps; a reason or review refusal
  // goes back to step 1 with the choice and the reason kept; anything else stays where it is.
  if (result !== seenResult) {
    setSeenResult(result);
    if (result?.ok) {
      setStep('closed');
      setReason('');
      setVisa(null);
      moveFocus('result');
    } else if (result && (result.code === 'invalid_input' || result.code === 'review_required')) {
      setStep('choose');
      moveFocus(result.fields?.includes('reason') ? 'reason' : 'choose');
    } else if (result) {
      moveFocus('result');
    }
  }

  useEffect(() => {
    if (!focus) return;
    const el = { choose: chooseHeading, review: reviewHeading, reason: reasonField, trigger, result: resultBox }[focus.target].current;
    el?.focus();
  }, [focus]);

  const isVisa = settingKey === 'visa_passport_tasks_enabled';
  const visaOn = isVisa && target === 'on';
  const trimmed = reason.replace(/\s+/g, ' ').trim();
  const refusedFields = result && !result.ok ? (result.fields ?? []) : [];
  const reasonProblem = reasonError ?? (refusedFields.includes('reason') ? SETTINGS_TEXT.refusedReason : null);
  const reasonId = `${id}-reason`;
  const stateWord = target === 'on' ? 'on' : 'off';
  const go = (next: Step, to: FocusTarget) => {
    setStep(next);
    moveFocus(to);
  };

  const openReview = () => {
    if (trimmed.length < SETTINGS_REASON_LIMITS.min || trimmed.length > SETTINGS_REASON_LIMITS.max) {
      setReasonError(SETTINGS_TEXT.refusedReason);
      moveFocus('reason');
      return;
    }
    setReasonError(null);
    if (visaOn && actions.previewVisa) {
      const preview = actions.previewVisa;
      setVisa(null);
      go('review', 'review');
      startCounting(async () => {
        try {
          setVisa(await preview());
        } catch {
          setVisa({ state: 'uncounted', lines: [SETTINGS_TEXT.visaUncounted], canConfirm: false });
        }
      });
      return;
    }
    go('review', 'review');
  };

  // Visa on: confirm only with a count the CRM returned (lead ruling; DA-258).
  const visaBlocked = visaOn && (counting || !visa || !visa.canConfirm || !actions.previewVisa);
  const stepHeading = 'm-0 text-base font-semibold text-ink outline-none';

  return (
    <div className="flex flex-col gap-3" data-slot="setting-change">
      <div ref={resultBox} tabIndex={-1} className="outline-none empty:hidden" data-slot="setting-result">
        {result ? (
          <Notice tone={result.ok ? 'success' : 'danger'} role={result.ok ? 'status' : 'alert'}>
            <p>{result.message}</p>
          </Notice>
        ) : null}
      </div>
      {step === 'closed' ? (
        <div>
          <Button
            ref={trigger}
            variant="secondary"
            className="h-auto min-h-10 max-w-full py-2 text-left whitespace-normal"
            onClick={() => {
              // Start from the opposite of the current state, so reopening never pre-selects a no-op.
              setTarget(state === 'on' ? 'off' : 'on');
              go('choose', 'choose');
            }}
          >
            {fill(SETTINGS_TEXT.changeButton, { switch: title })}
          </Button>
        </div>
      ) : (
        <HandForm action={formAction} noValidate aria-label={fill(SETTINGS_TEXT.changeButton, { switch: title })} className="flex flex-col gap-4 rounded-control border border-line-strong bg-canvas px-3.5 py-3.5">
          {step === 'choose' ? (
            <>
              <h4 ref={chooseHeading} tabIndex={-1} className={stepHeading}>
                {fill(SETTINGS_TEXT.changeButton, { switch: title })}
              </h4>
              <ChoiceGroup id={`${id}-state`} legend={SETTINGS_TEXT.setItTo}>
                <Radio id={`${id}-on`} name="state-choice" value="on" label="On" description={state === 'on' ? SETTINGS_TEXT.itIsOn : undefined} checked={target === 'on'} onChange={() => setTarget('on')} />
                <Radio id={`${id}-off`} name="state-choice" value="off" label="Off" description={state === 'off' ? SETTINGS_TEXT.itIsOff : undefined} checked={target === 'off'} onChange={() => setTarget('off')} />
              </ChoiceGroup>
              <Field htmlFor={reasonId} label={SETTINGS_TEXT.reasonLabel} hint={SETTINGS_TEXT.reasonHint} error={reasonProblem}>
                <Textarea
                  ref={reasonField}
                  id={reasonId}
                  rows={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={SETTINGS_REASON_LIMITS.max}
                  invalid={Boolean(reasonProblem)}
                  aria-describedby={fieldDescribedBy(reasonId, { hint: true, error: reasonProblem })}
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" onClick={openReview}>
                  {SETTINGS_TEXT.reviewButton}
                </Button>
                <Button variant="ghost" onClick={() => go('closed', 'trigger')}>
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <>
              <h4 ref={reviewHeading} tabIndex={-1} className={stepHeading}>
                {fill(SETTINGS_TEXT.reviewTitle, { switch: title, state: stateWord })}
              </h4>
              <Notice tone="info" role="none">
                <p>{target === 'on' ? review.onText : review.offText}</p>
                {visaOn ? (
                  <div aria-live="polite" className="flex flex-col gap-1.5" data-slot="visa-count">
                    {counting || !visa ? <p>{SETTINGS_TEXT.visaCounting}</p> : visa.lines.map((line) => <p key={line} className={visa.canConfirm ? undefined : 'font-semibold text-ink'}>{line}</p>)}
                  </div>
                ) : null}
                <p>{review.approvalLine}</p>
                <p className="wrap-break-word">Reason: “{trimmed}”</p>
              </Notice>
              <input type="hidden" name={SWITCH_FIELD.key} value={settingKey} />
              <input type="hidden" name={SWITCH_FIELD.state} value={target} />
              <input type="hidden" name={SWITCH_FIELD.reason} value={trimmed} />
              <input type="hidden" name={SWITCH_FIELD.confirm} value="yes" />
              {visaOn && visa?.state === 'counted' ? <input type="hidden" name={SWITCH_FIELD.reviewedCount} value={String(visa.wouldCreate)} /> : null}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="primary" loading={pending} disabled={pending || visaBlocked} className="h-auto min-h-10 max-w-full py-2 text-left whitespace-normal">
                  {pending ? SETTINGS_TEXT.pending : fill(SETTINGS_TEXT.confirmButton, { switch: title, state: stateWord })}
                </Button>
                <Button variant="ghost" onClick={() => go('choose', 'choose')} disabled={pending}>
                  {SETTINGS_TEXT.goBack}
                </Button>
              </div>
            </>
          )}
        </HandForm>
      )}
    </div>
  );
}
