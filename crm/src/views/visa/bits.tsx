import { Ban, Check, CircleCheck, CircleDashed, Hourglass, PencilLine, RefreshCw, Repeat2, Undo2, UserX, type LucideIcon } from 'lucide-react';
import { StatusBadge, type StatusTone } from '@/components/ui/badge';
import { cn, focusRing } from '@/components/ui/cn';
import { STEP_LABEL, STEP_STATUS_TEXT } from './labels';
import type { VisaApplicant, VisaStep, VisaTaskStatus } from './types';

/*
 * Small server-safe pieces shared by the Visa queue, task page and Deal
 * card: the status word with its icon (never colour alone), the applicant
 * chips and the five-step bar (contract 8, HTML visaStepper H:15082).
 */

const STATUS_LOOK: Record<VisaTaskStatus['code'], { tone: StatusTone; icon: LucideIcon }> = {
  not_taken: { tone: 'neutral', icon: Hourglass },
  in_progress: { tone: 'info', icon: PencilLine },
  completed: { tone: 'success', icon: CircleCheck },
};

/** Status words: the server's text, else contract 8 words from the code and step. */
export function statusWords(s: VisaTaskStatus): string {
  if (s.text) return s.text;
  if (s.code === 'not_taken') return 'Not taken';
  if (s.code === 'completed') return 'Completed';
  return s.step ? STEP_STATUS_TEXT[s.step] : 'In progress';
}

export function VisaStatusBadge({ status, label = 'Task status' }: { status: VisaTaskStatus; label?: string }) {
  const look = STATUS_LOOK[status.code];
  return (
    <StatusBadge tone={look.tone} icon={look.icon} wrap>
      <span className="sr-only">{label}: </span>
      {statusWords(status)}
    </StatusBadge>
  );
}

export interface Chip {
  key: string;
  text: string;
  tone: StatusTone;
  icon: LucideIcon;
}

/** Contract 8 applicant words, as chips (text + icon). */
export function applicantChips(a: VisaApplicant): Chip[] {
  const out: Chip[] = [];
  if (a.removed) out.push({ key: 'removed', text: 'Removed from the booking', tone: 'warning', icon: UserX });
  if (a.travellerChanged) out.push({ key: 'changed', text: 'Traveller changed', tone: 'warning', icon: RefreshCw });
  if (a.secondApplication) out.push({ key: 'second', text: 'Second application', tone: 'brand', icon: Repeat2 });
  const decided = a.decision?.outcome;
  if (decided === 'approved') out.push({ key: 'state', text: 'Approved', tone: 'success', icon: CircleCheck });
  else if (decided === 'rejected') out.push({ key: 'state', text: 'Rejected', tone: 'danger', icon: Ban });
  else if (decided === 'withdrawn') out.push({ key: 'state', text: 'Withdrawn', tone: 'neutral', icon: Undo2 });
  else if (a.applied || a.state === 'submitted' || a.state === 'decision_pending') out.push({ key: 'state', text: 'Applied', tone: 'info', icon: Check });
  else if (a.ready) out.push({ key: 'state', text: 'Ready · in Appointment', tone: 'success', icon: CircleCheck });
  else if (!a.removed) out.push({ key: 'state', text: 'Not applied', tone: 'neutral', icon: CircleDashed });
  if (a.closed) out.push({ key: 'closed', text: 'Closed', tone: 'neutral', icon: CircleCheck });
  return out;
}

export function Chips({ chips, label = 'Passenger status', className }: { chips: Chip[]; label?: string; className?: string }) {
  if (chips.length === 0) return null;
  return (
    <ul className={cn('m-0 flex list-none flex-wrap gap-1 p-0', className)} aria-label={label}>
      {chips.map((c) => (
        <li key={c.key} className="m-0">
          <StatusBadge tone={c.tone} icon={c.icon} wrap>
            {c.text}
          </StatusBadge>
        </li>
      ))}
    </ul>
  );
}

/** Contract 8 words under each step: Completed · "x of y" / Now · Pending. */
function stepWord(step: VisaStep, current: boolean): string {
  if (step.done) return 'Completed';
  if (current) return step.of > 1 ? `${step.met} of ${step.of}` : 'Now';
  return 'Pending';
}

/** Line fill as a width class (production CSP forbids inline style attributes). */
const FILLS: Array<[number, string]> = [
  [0, 'w-0'],
  [100 / 6, 'w-1/6'],
  [20, 'w-1/5'],
  [25, 'w-1/4'],
  [100 / 3, 'w-1/3'],
  [40, 'w-2/5'],
  [50, 'w-1/2'],
  [60, 'w-3/5'],
  [200 / 3, 'w-2/3'],
  [75, 'w-3/4'],
  [80, 'w-4/5'],
  [500 / 6, 'w-5/6'],
  [100, 'w-full'],
];
function fillClass(pct: number): string {
  let best = FILLS[0]!;
  for (const f of FILLS) if (Math.abs(f[0] - pct) < Math.abs(best[0] - pct)) best = f;
  return best[1];
}

const SECTION_OF: Partial<Record<VisaStep['key'], 'pax' | 'appt'>> = { ready: 'pax', applied: 'appt', decision: 'appt', handover: 'appt' };

/**
 * Five-step bar (contract 8). An ordered list inside a labelled, focusable
 * region that scrolls sideways on narrow screens (contract 11.1); each step
 * past "Task taken" is a link to its section. Status in words, never colour
 * alone; the line fill does not animate under reduced motion.
 */
export function VisaStepBar({ steps, taskId }: { steps: VisaStep[]; taskId: string }) {
  const current = steps.findIndex((s) => !s.done);
  return (
    <div className="rounded-card border border-line bg-card">
      <div role="region" aria-label="Visa progress, scrolls sideways on small screens" tabIndex={0} className={cn('overflow-x-auto px-3 pt-4.5 pb-3.5', focusRing)}>
        <ol aria-label="Visa progress" className="m-0 grid min-w-[33.75rem] list-none grid-cols-5 p-0">
          {steps.map((s, i) => {
            const isCurrent = i === current;
            const next = steps[i + 1];
            const fill = next && s.done && next.of ? (next.done ? 100 : Math.round((next.met / next.of) * 100)) : 0;
            const section = SECTION_OF[s.key];
            const face = (
              <>
                <span
                  aria-hidden="true"
                  className={cn(
                    'mb-1.5 grid size-10 place-items-center rounded-full border-2 bg-card font-bold',
                    s.done && 'border-brand-strong bg-brand-strong text-white',
                    isCurrent && 'border-brand-strong text-brand-strong ring-4 ring-brand-tint',
                    !s.done && !isCurrent && 'border-line text-quiet',
                  )}
                >
                  {s.done ? <Check className="size-5" /> : i + 1}
                </span>
                <span className={cn('leading-tight font-semibold', s.done || isCurrent ? 'text-ink' : 'text-quiet')}>{s.label || STEP_LABEL[s.key]}</span>
                <span className={cn('text-[0.8125rem]', s.done || isCurrent ? 'font-semibold text-brand-strong' : 'text-quiet')}>
                  <span className="sr-only">, </span>
                  {stepWord(s, isCurrent)}
                </span>
              </>
            );
            return (
              <li key={s.key} aria-current={isCurrent ? 'step' : undefined} className="relative m-0">
                {i < steps.length - 1 ? (
                  <span aria-hidden="true" className="absolute top-[1.1875rem] right-[calc(-50%+1.5rem)] left-[calc(50%+1.5rem)] h-0.75 overflow-hidden rounded-sm bg-line">
                    <span className={cn('block h-full bg-brand-strong motion-safe:transition-[width] motion-safe:duration-300', fillClass(fill))} />
                  </span>
                ) : null}
                {section ? (
                  <a href={`#sec-${taskId}-${section}`} className={cn('flex w-full flex-col items-center gap-0.5 rounded-control text-center text-copy no-underline', focusRing)}>
                    <span className="sr-only">Step {i + 1} of {steps.length}: </span>
                    {face}
                  </a>
                ) : (
                  <div className="flex w-full flex-col items-center gap-0.5 text-center">
                    <span className="sr-only">Step {i + 1} of {steps.length}: </span>
                    {face}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
