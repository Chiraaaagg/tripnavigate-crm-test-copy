'use client';

import { CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react';
import { cn, focusRing } from '@/components/ui/cn';
import { BOOKING_FORM_STEP_LABEL } from '@/modules/fulfilment/booking-form-contract';
import type { BookStepStatus } from '@/modules/fulfilment/contracts';
import { useFormStep } from './step-context';
import { FORM_STEPS, type FormStep } from './types';

/*
 * Horizontal step bar of the approved preview: three equal buttons with a
 * number, the current one underlined in brand blue. Steps switch on this page
 * (nothing is lost); each step's state is also given in words for screen
 * readers and as an icon (never colour alone). Composition of the recorded
 * 21st.dev steppers (originui 778, sean0205 29815) and tabs (shadcn 953) looks;
 * no new catalog part.
 */

const STATE_TEXT: Record<BookStepStatus, string> = {
  complete: '(done)',
  needs_input: '(needs details)',
  warnings_only: '(check, not blocking)',
};

export function StepsBar({ status }: { status: Record<FormStep, BookStepStatus | undefined> }) {
  const { step, go } = useFormStep();
  return (
    <nav aria-label="Booking steps" className="mb-5">
      <ol className="m-0 grid list-none grid-cols-3 overflow-hidden rounded-card border border-line bg-card p-0 max-sm:rounded-control">
        {FORM_STEPS.map((key, i) => {
          const current = key === step;
          const s = status[key];
          const Icon = s === 'needs_input' ? CircleAlert : s === 'warnings_only' ? TriangleAlert : s === 'complete' ? CircleCheck : null;
          return (
            <li key={key} className="m-0 min-w-0 border-line not-first:border-l">
              <button
                type="button"
                aria-current={current ? 'step' : undefined}
                onClick={() => go(key)}
                className={cn(
                  'flex h-full min-h-14 w-full cursor-pointer items-center gap-2.5 border-0 border-b-3 border-transparent bg-card px-5 py-3 text-left text-base text-quiet',
                  'hover:bg-wash hover:text-ink max-sm:min-h-13 max-sm:gap-1.5 max-sm:px-2 max-sm:text-xs',
                  current && 'border-b-brand-strong bg-brand-tint/50 font-semibold text-brand-deep hover:bg-brand-tint/50 hover:text-brand-deep',
                  focusRing,
                  '-outline-offset-2',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'grid size-6.5 shrink-0 place-items-center rounded-full border border-line-strong text-sm tabular-nums max-sm:size-5.75 max-sm:text-xs max-[380px]:hidden',
                    current && 'border-brand-strong bg-brand-strong text-white',
                  )}
                >
                  {i + 1}
                </span>
                <span className="min-w-0">
                  <span className="sr-only">Step {i + 1}: </span>
                  {BOOKING_FORM_STEP_LABEL[key]}
                  {s ? <span className="sr-only"> {STATE_TEXT[s]}</span> : null}
                </span>
                {Icon && s !== 'complete' ? (
                  <Icon aria-hidden="true" className={cn('ml-auto size-4 shrink-0 max-sm:hidden', s === 'needs_input' ? 'text-status-danger' : 'text-status-warning')} />
                ) : null}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
