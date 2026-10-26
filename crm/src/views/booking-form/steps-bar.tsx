'use client';

import { CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react';
import { cn, focusRing } from '@/components/ui/cn';
import { BOOKING_FORM_STEP_LABEL } from '@/modules/fulfilment/booking-form-contract';
import { useFormStep } from './step-context';
import { FORM_STEPS, type FormStep } from './types';

/*
 * Step bar of the owner-approved prototype: three equal buttons with a
 * number, the current one underlined in brand blue, and on the right of each
 * a tick, a warning or an alert (change 2) worked out from the screen and the
 * server's readiness together. The state is also given in words for screen
 * readers (never colour alone). Steps switch on this page; nothing is lost.
 */

export type StepState = 'ok' | 'warn' | 'bad';

const STATE_TEXT: Record<StepState, string> = { ok: '(done)', warn: '(check, not blocking)', bad: '(needs details)' };

export function StepsBar({ status }: { status: Record<FormStep, StepState> }) {
  const { step, go } = useFormStep();
  return (
    <nav aria-label="Booking steps" className="my-5">
      <ol className="m-0 grid list-none grid-cols-3 overflow-hidden rounded-card border border-line bg-card p-0">
        {FORM_STEPS.map((key, i) => {
          const current = key === step;
          const s = status[key];
          const Icon = s === 'bad' ? CircleAlert : s === 'warn' ? TriangleAlert : CircleCheck;
          return (
            <li key={key} className="m-0 min-w-0 border-line not-first:border-l">
              <button
                type="button"
                aria-current={current ? 'step' : undefined}
                onClick={() => go(key)}
                className={cn(
                  'flex h-full min-h-14 w-full cursor-pointer items-center gap-2.5 border-0 border-b-3 border-transparent bg-card px-4.5 py-3 text-left text-base text-quiet',
                  'hover:bg-wash hover:text-ink max-sm:min-h-13 max-sm:gap-1.5 max-sm:px-2 max-sm:py-2.5 max-sm:text-xs',
                  current && 'border-b-brand-strong bg-brand-tint/50 font-semibold text-brand-deep hover:bg-brand-tint/50 hover:text-brand-deep',
                  focusRing,
                  '-outline-offset-2',
                )}
              >
                <span aria-hidden="true" className={cn('grid size-6.5 shrink-0 place-items-center rounded-full border border-line-strong text-sm tabular-nums max-sm:size-5.5 max-sm:text-xs', current && 'border-brand-strong bg-brand-strong text-white')}>
                  {i + 1}
                </span>
                <span className="min-w-0">
                  <span className="sr-only">Step {i + 1}: </span>
                  {BOOKING_FORM_STEP_LABEL[key]}
                  <span className="sr-only"> {STATE_TEXT[s]}</span>
                </span>
                <Icon aria-hidden="true" className={cn('ml-auto size-4.5 shrink-0', s === 'bad' ? 'text-status-danger' : s === 'warn' ? 'text-status-warning' : 'text-status-success')} />
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
