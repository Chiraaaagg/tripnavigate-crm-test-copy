'use client';

import { CircleCheck, CircleHelp, CircleOff, type LucideIcon, TriangleAlert } from 'lucide-react';
import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { HandForm } from '@/components/hand-form';
import { StatusBadge, type StatusTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { ChoiceGroup, Radio } from '@/components/ui/choice';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { Textarea } from '@/components/ui/textarea';
import { NAME_READ_REASON, type NameReadStateView } from '@/modules/integration/name-map';
import type { NameReadSwitchActionResult } from '@/modules/integration/server/name-map-actions';
import { formatIst } from './deal-labels';

/*
 * DEC-55 (plan.md §12c): the "Bitrix names" switch (bitrix_name_read) on the
 * Bitrix sync page. On, Off or Unknown in words with an icon (Unknown is never
 * shown as Off). Only a Super Admin gets the change control; the server
 * refuses everyone else and writes the audit row. Change flow: choose On or
 * Off, type a reason (10 to 500 characters), review, then confirm. Focus moves
 * to each step's heading; a refusal keeps the typed reason and focuses it; a
 * save closes the steps and announces the result; the submit button is
 * disabled while saving (no double submit). P-SETTING pattern, catalog gap G5.
 * Copy: copy-catalogue §16.10 DA-139 to DA-141.
 */

export type NameReadAction = (prev: NameReadSwitchActionResult | null, formData: FormData) => Promise<NameReadSwitchActionResult>;

export const NAMES_CARD_LINE = 'Shows Bitrix stage, status and source names. Read-only; nothing is written to Bitrix.';
/** DA-139: both directions, in the review step. */
export const NAMES_APPROVAL_LINE = 'Changing this in the live CRM needs the owner’s approval first. Write the approval in the reason.';

type Step = 'closed' | 'choose' | 'review';

/**
 * Words of one Bitrix read switch card. The Bitrix names card is the default;
 * the voice-note batch reuses the same flow for "Bitrix trip details"
 * (bitrix_trip_details_read): same state shape, same reason, review and
 * confirm, Unknown never shown as Off.
 */
export interface ReadSwitchCopy {
  title: string;
  line: string;
  /** Screen-reader prefix of the state word, e.g. "Bitrix names: ". */
  stateLabel: string;
  onNoConnection: string;
  trigger: string;
  legend: string;
  onChoice: string;
  offChoice: string;
  reviewOn: string;
  reviewOff: string;
  /** "Turn Bitrix names" (followed by on or off). */
  turn: string;
  slot: string;
}

export const NAMES_COPY: ReadSwitchCopy = {
  title: 'Bitrix names',
  line: NAMES_CARD_LINE,
  stateLabel: 'Bitrix names: ',
  onNoConnection: 'On, but the Bitrix connection is off: codes are shown.',
  trigger: 'Change Bitrix names setting',
  legend: 'Turn Bitrix names',
  onChoice: "Lists, Lead and Deal pages show Bitrix's own names after the next daily read.",
  offChoice: 'Screens show the codes again with “not recognised (code in details)”. Stored names are kept.',
  reviewOn: 'Lists, Lead and Deal pages will show Bitrix stage, status and source names after the next daily read.',
  reviewOff: 'Screens will show codes again; stored names are kept.',
  turn: 'Turn Bitrix names',
  slot: 'names',
};

/** Voice-note batch (owner answer 3): Bitrix trip details, starts Off. */
export const TRIP_DETAILS_COPY: ReadSwitchCopy = {
  title: 'Bitrix trip details',
  line: 'Read trip details from Bitrix (destination, adults, children, infants). Read-only; nothing is written to Bitrix.',
  stateLabel: 'Bitrix trip details: ',
  onNoConnection: 'On, but the Bitrix connection is off: nothing new is read.',
  trigger: 'Change Bitrix trip details setting',
  legend: 'Turn Bitrix trip details',
  onChoice: 'Bookings show the destination and the adult, child and infant counts from the Deal after the next Bitrix update. Missing values are still asked on the booking.',
  offChoice: 'Bookings ask for these values again. Values already saved on bookings are kept.',
  reviewOn: 'Bookings will take the destination and the adult, child and infant counts from the Bitrix Deal after the next Bitrix update.',
  reviewOff: 'Bookings will ask staff for these values again; saved bookings keep theirs.',
  turn: 'Turn Bitrix trip details',
  slot: 'trip-details',
};

const LOOK: Record<'on' | 'on_no_connection' | 'off' | 'unknown', { word: string; tone: StatusTone; icon: LucideIcon }> = {
  on: { word: 'On', tone: 'success', icon: CircleCheck },
  // Atlas Echo-A L1: the switch is on but the Bitrix connection is off, so screens still show codes.
  on_no_connection: { word: 'On, but the Bitrix connection is off', tone: 'warning', icon: TriangleAlert },
  off: { word: 'Off', tone: 'neutral', icon: CircleOff },
  unknown: { word: 'Unknown', tone: 'warning', icon: CircleHelp },
};

const UNKNOWN_TEXT: Record<Extract<NameReadStateView, { state: 'unknown' }>['reason'], string> = {
  not_authorized: 'This setting could not be read for your role.',
  not_configured: 'The Bitrix connection is not set up, so this setting cannot be read.',
  not_installed: 'This setting is not available on this database yet.',
  failed: 'This setting could not be read. Reload the page. Nothing was changed.',
};

function SwitchWord({ value, label }: { value: 'on' | 'on_no_connection' | 'off' | 'unknown'; label: string }) {
  const look = LOOK[value];
  return (
    <StatusBadge tone={look.tone} icon={look.icon} wrap>
      <span className="sr-only">{label}</span>
      {look.word}
    </StatusBadge>
  );
}

export function BitrixNamesCard({
  state,
  action,
  initialResult = null,
  initialStep = 'closed',
  initialReason = '',
  copy = NAMES_COPY,
}: {
  state: NameReadStateView;
  action: NameReadAction;
  /** Preview gallery only. */
  initialResult?: NameReadSwitchActionResult | null;
  /** Preview gallery only. */
  initialStep?: Step;
  /** Preview gallery only. */
  initialReason?: string;
  /** Words of the card (default: Bitrix names). */
  copy?: ReadSwitchCopy;
}) {
  const id = useId();
  const [result, formAction, pending] = useActionState(action, initialResult);
  // "On" only when names are really shown (switch on AND connection on); `enabled` is the switch itself.
  const current = state.state === 'known' ? (state.enabled ? (state.effective ? 'on' : 'on_no_connection') : 'off') : 'unknown';
  const [step, setStep] = useState<Step>(initialStep);
  const [target, setTarget] = useState<'on' | 'off'>(state.state === 'known' && state.enabled ? 'off' : 'on');
  const [reason, setReason] = useState(initialReason);
  const [reasonError, setReasonError] = useState<string | null>(null);
  // Where focus goes after the next render (a step heading, the reason field, the trigger, the result).
  // A counter makes a repeated target (Back, then Back again) still move focus.
  const [focus, setFocus] = useState<{ target: 'choose' | 'review' | 'reason' | 'trigger' | 'result'; n: number } | null>(null);
  const moveFocus = (target: 'choose' | 'review' | 'reason' | 'trigger' | 'result') => setFocus((f) => ({ target, n: (f?.n ?? 0) + 1 }));
  const chooseHeading = useRef<HTMLHeadingElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const reasonField = useRef<HTMLTextAreaElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const resultBox = useRef<HTMLDivElement>(null);
  const [seenResult, setSeenResult] = useState(result);

  // A new action result (render-time state adjustment, no effect): a save closes the steps and
  // clears the reason; a reason refusal reopens the first step with the typed reason kept.
  if (result !== seenResult) {
    setSeenResult(result);
    if (result?.ok) {
      setStep('closed');
      setReason('');
      moveFocus('result');
    } else if (result && result.code === 'invalid_input') {
      setStep('choose');
      moveFocus(result.fields.includes('reason') ? 'reason' : 'choose');
    } else if (result) {
      moveFocus('result');
    }
  }

  useEffect(() => {
    if (!focus) return;
    const el = { choose: chooseHeading, review: reviewHeading, reason: reasonField, trigger, result: resultBox }[focus.target].current;
    el?.focus();
  }, [focus]);

  const refusedFields = result && !result.ok && result.code === 'invalid_input' ? result.fields : [];
  const reasonProblem = reasonError ?? (refusedFields.includes('reason') ? `Type a reason of ${NAME_READ_REASON.min} to ${NAME_READ_REASON.max} characters.` : null);
  const trimmed = reason.replace(/\s+/g, ' ').trim();
  const reasonId = `${id}-reason`;
  const go = (next: Step, target: 'choose' | 'review' | 'trigger') => {
    setStep(next);
    moveFocus(target);
  };

  const review = () => {
    if (trimmed.length < NAME_READ_REASON.min || trimmed.length > NAME_READ_REASON.max) {
      setReasonError(`Type a reason of ${NAME_READ_REASON.min} to ${NAME_READ_REASON.max} characters.`);
      moveFocus('reason');
      return;
    }
    setReasonError(null);
    go('review', 'review');
  };

  const stepHeading = 'm-0 text-base font-semibold text-ink outline-none';

  return (
    <Card className="mt-6">
      <section aria-labelledby={`${id}-heading`}>
        <CardHeader>
          <CardTitle id={`${id}-heading`}>{copy.title}</CardTitle>
          <SwitchWord value={current} label={copy.stateLabel} />
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          <p className="m-0 text-copy">{copy.line}</p>
          {state.state === 'known' && state.enabled && !state.effective ? (
            <Notice tone="warning" icon={TriangleAlert}>
              <p>{copy.onNoConnection}</p>
            </Notice>
          ) : null}
          {state.state === 'unknown' ? (
            <Notice tone="warning" icon={CircleHelp}>
              <p>{UNKNOWN_TEXT[state.reason]} The setting is shown as Unknown, not as Off.</p>
            </Notice>
          ) : state.lastChange ? (
            <div className="text-sm text-copy" data-slot={`${copy.slot}-last-change`}>
              <p className="m-0">
                {state.lastChange.byName
                  ? `Last changed by ${state.lastChange.byName} on ${formatIst(state.lastChange.at)}`
                  : `Last changed on ${formatIst(state.lastChange.at)} by a system update (no person recorded)`}
                {state.lastChange.to === null ? '' : ` (turned ${state.lastChange.to ? 'on' : 'off'})`}.
              </p>
              {state.lastChange.reason ? <p className="m-0 mt-1.5 wrap-break-word text-quiet">Reason: {state.lastChange.reason}</p> : null}
            </div>
          ) : (
            <p className="m-0 text-sm text-quiet">Not changed since it was installed (it starts Off).</p>
          )}

          <div ref={resultBox} tabIndex={-1} className="outline-none" data-slot={`${copy.slot}-result`}>
            {result ? (
              <Notice tone={result.ok ? 'success' : 'danger'} role={result.ok ? 'status' : 'alert'}>
                <p>{result.message}</p>
              </Notice>
            ) : null}
          </div>

          {state.state === 'known' && !state.canSwitch ? <p className="m-0 text-sm text-quiet">Only a Super Admin can change this setting.</p> : null}

          {state.state === 'known' && state.canSwitch ? (
            step === 'closed' ? (
              <div>
                <Button ref={trigger} variant="secondary" onClick={() => {
                    // Start from the opposite of the current switch, so reopening after a save never pre-selects a no-op change.
                    setTarget(state.state === 'known' && state.enabled ? 'off' : 'on');
                    go('choose', 'choose');
                  }}
                >
                  {copy.trigger}
                </Button>
              </div>
            ) : (
              <HandForm action={formAction} noValidate className="flex flex-col gap-4">
                {step === 'choose' ? (
                  <>
                    <h3 ref={chooseHeading} tabIndex={-1} className={stepHeading}>
                      Step 1 of 2: choose and give a reason
                    </h3>
                    <ChoiceGroup id={`${id}-state`} legend={copy.legend}>
                      <Radio id={`${id}-on`} name="state-choice" value="on" label="On" description={copy.onChoice} checked={target === 'on'} onChange={() => setTarget('on')} />
                      <Radio id={`${id}-off`} name="state-choice" value="off" label="Off" description={copy.offChoice} checked={target === 'off'} onChange={() => setTarget('off')} />
                    </ChoiceGroup>
                    <Field
                      htmlFor={reasonId}
                      label="Why are you changing it?"
                      hint={`${NAME_READ_REASON.min} to ${NAME_READ_REASON.max} characters, saved with your name in the audit log.`}
                      error={reasonProblem}
                    >
                      <Textarea
                        ref={reasonField}
                        id={reasonId}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        maxLength={NAME_READ_REASON.max}
                        invalid={Boolean(reasonProblem)}
                        aria-describedby={fieldDescribedBy(reasonId, { hint: true, error: reasonProblem })}
                      />
                    </Field>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="primary" onClick={review}>
                        Review change
                      </Button>
                      <Button variant="ghost" onClick={() => go('closed', 'trigger')}>
                        Cancel
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <h3 ref={reviewHeading} tabIndex={-1} className={stepHeading}>
                      Step 2 of 2: check and confirm
                    </h3>
                    <Notice tone="info" title={`${copy.turn} ${target}?`}>
                      <p>{target === 'on' ? copy.reviewOn : copy.reviewOff}</p>
                      <p>Nothing is written to Bitrix.</p>
                      <p>{NAMES_APPROVAL_LINE}</p>
                      <p className="wrap-break-word">Reason: {trimmed}</p>
                    </Notice>
                    <input type="hidden" name="state" value={target} />
                    <input type="hidden" name="reason" value={trimmed} />
                    <input type="hidden" name="confirm" value="yes" />
                    <div className="flex flex-wrap gap-2">
                      <Button type="submit" variant="primary" loading={pending} disabled={pending}>
                        {pending ? 'Saving…' : `${copy.turn} ${target}`}
                      </Button>
                      <Button variant="ghost" onClick={() => go('choose', 'choose')} disabled={pending}>
                        Back
                      </Button>
                    </div>
                  </>
                )}
              </HandForm>
            )
          ) : null}
        </CardBody>
      </section>
    </Card>
  );
}

/** Settings · Bitrix connection: the "Bitrix trip details" switch (voice-note batch), same flow as Bitrix names. */
export function BitrixTripDetailsCard(props: Omit<Parameters<typeof BitrixNamesCard>[0], 'copy'>) {
  return <BitrixNamesCard {...props} copy={TRIP_DETAILS_COPY} />;
}
