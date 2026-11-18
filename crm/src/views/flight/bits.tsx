import { Ban, CircleCheck, CircleDashed, FileWarning, Hourglass, PencilLine, RefreshCw, Undo2, UserX, HandCoins, type LucideIcon } from 'lucide-react';
import { StatusBadge, type StatusTone } from '@/components/ui/badge';
import { cn } from '@/components/ui/cn';
import { CHANGE_STATUS_LABEL, PAYMENT_STATE_LABEL, PROGRESS_LABEL } from './labels';
import type { ChangeStatus, FlightQueueChips, FlightStatus, PaymentState, ProgressStep } from './types';

/*
 * Small server-safe pieces shared by the Flight queue, workspace and Deal
 * card: the status word with its icon (never colour alone), the secondary
 * chips, the progress bar and the change / payment badges.
 */

const STATUS_LOOK: Record<FlightStatus['code'], { tone: StatusTone; icon: LucideIcon }> = {
  waiting: { tone: 'neutral', icon: Hourglass },
  in_progress: { tone: 'info', icon: PencilLine },
  all_confirmed: { tone: 'brand', icon: CircleCheck },
  done: { tone: 'success', icon: CircleCheck },
};

export function FlightStatusBadge({ status, label = 'Flight status' }: { status: FlightStatus; label?: string }) {
  const look = STATUS_LOOK[status.code];
  return (
    <StatusBadge tone={look.tone} icon={look.icon} wrap>
      <span className="sr-only">{label}: </span>
      {status.text}
    </StatusBadge>
  );
}

interface Chip {
  key: string;
  text: string;
  icon: LucideIcon;
  tone: StatusTone;
}

export function chipsOf(chips: FlightQueueChips, dealKind?: 'package' | 'flight_only'): Chip[] {
  const out: Chip[] = [];
  if (chips.bookingChanged) out.push({ key: 'booking', text: 'Booking changed', icon: RefreshCw, tone: 'warning' });
  if (chips.unnamed > 0) out.push({ key: 'unnamed', text: `${chips.unnamed} ${chips.unnamed === 1 ? 'traveller' : 'travellers'} not named yet`, icon: UserX, tone: 'warning' });
  if (chips.changesWaiting > 0) out.push({ key: 'changes', text: dealKind === 'flight_only' ? 'Change waiting' : 'Change waiting for Sales', icon: Hourglass, tone: 'warning' });
  if (chips.faresWaiting) out.push({ key: 'fares', text: 'Fares waiting for the Manager', icon: Hourglass, tone: 'warning' });
  if (chips.paymentNeeded) out.push({ key: 'payment', text: 'Payment needed', icon: HandCoins, tone: 'neutral' });
  return out;
}

export function FlightChips({ chips, className }: { chips: Chip[]; className?: string }) {
  if (chips.length === 0) return null;
  return (
    <ul className={cn('m-0 flex list-none flex-wrap gap-1.5 p-0', className)} aria-label="Things to look at">
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

const STEP_STATE_TEXT = { done: 'done', current: 'current step', todo: 'not started' } as const;

/**
 * Flight progress bar (contract 7, prototype flightProgress fixed): one
 * ordered list; each step says its number, name and state in words. Wraps
 * into a vertical list on narrow screens (no sideways scroll).
 */
export function FlightProgress({ steps }: { steps: ProgressStep[] }) {
  const total = steps.length;
  return (
    <section aria-label="Flight progress" className="mb-4 rounded-card border border-line bg-card px-4 py-3.5">
      <ol className="m-0 flex list-none flex-col gap-2 p-0 sm:flex-row sm:gap-0">
        {steps.map((step, i) => (
          <li
            key={step.key}
            aria-current={step.state === 'current' ? 'step' : undefined}
            className="relative m-0 flex min-w-0 flex-1 items-center gap-2.5 sm:flex-col sm:items-center sm:gap-1.5 sm:text-center"
          >
            {i > 0 ? (
              <span aria-hidden="true" className={cn('absolute top-4 right-1/2 hidden h-0.5 w-full -translate-x-4 sm:block', steps[i - 1]!.state === 'done' ? 'bg-status-success' : 'bg-line')} />
            ) : null}
            <span
              aria-hidden="true"
              className={cn(
                'relative z-[1] grid size-8 shrink-0 place-items-center rounded-full border-2 text-sm font-semibold',
                step.state === 'done' && 'border-status-success bg-status-success text-white',
                step.state === 'current' && 'border-ink bg-card text-ink',
                step.state === 'todo' && 'border-line-strong bg-card text-quiet',
              )}
            >
              {step.state === 'done' ? <CircleCheck className="size-4" /> : i + 1}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="sr-only">
                Step {i + 1} of {total}:{' '}
              </span>
              <span className={cn('text-sm', step.state === 'current' ? 'font-semibold text-ink' : 'text-copy')}>{PROGRESS_LABEL[step.key]}</span>
              {step.sub ? <span className="text-sm text-quiet">{step.sub}</span> : null}
              <span className="sr-only">, {STEP_STATE_TEXT[step.state]}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

const CHANGE_LOOK: Record<ChangeStatus, { tone: StatusTone; icon: LucideIcon }> = {
  pending: { tone: 'warning', icon: Hourglass },
  approved: { tone: 'success', icon: CircleCheck },
  rejected: { tone: 'danger', icon: Ban },
  withdrawn: { tone: 'neutral', icon: Undo2 },
  superseded: { tone: 'neutral', icon: RefreshCw },
};

export function ChangeStatusBadge({ status, waitingFor }: { status: ChangeStatus; waitingFor?: string }) {
  const look = CHANGE_LOOK[status];
  return (
    <StatusBadge tone={look.tone} icon={look.icon} wrap>
      {status === 'pending' && waitingFor ? `Waiting for ${waitingFor}` : CHANGE_STATUS_LABEL[status]}
    </StatusBadge>
  );
}

const PAYMENT_LOOK: Record<PaymentState, { tone: StatusTone; icon: LucideIcon }> = {
  unpaid: { tone: 'neutral', icon: CircleDashed },
  direct_submitted: { tone: 'info', icon: Hourglass },
  direct_accepted: { tone: 'success', icon: CircleCheck },
  direct_returned: { tone: 'danger', icon: Undo2 },
  request_pending: { tone: 'warning', icon: Hourglass },
  request_approved: { tone: 'info', icon: CircleCheck },
  request_paid: { tone: 'success', icon: CircleCheck },
  request_verified: { tone: 'success', icon: CircleCheck },
  request_returned: { tone: 'danger', icon: Undo2 },
  request_cancelled: { tone: 'neutral', icon: FileWarning },
};

export function PaymentBadge({ state }: { state: PaymentState }) {
  const look = PAYMENT_LOOK[state];
  return (
    <StatusBadge tone={look.tone} icon={look.icon} wrap>
      <span className="sr-only">Payment: </span>
      {PAYMENT_STATE_LABEL[state]}
    </StatusBadge>
  );
}
