'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';
import type { BookingActionResult } from '@/modules/fulfilment/contracts';
import { FIELD } from '@/modules/fulfilment/forms';
import { guard, type UiResult } from './booking-forms';
import { ActionNotice } from './intake-forms';

/** A server action in the frozen shape `(prev, FormData) => BookingActionResult`. */
export type FlightAction = (prev: never, formData: FormData) => Promise<BookingActionResult<unknown>>;

function TakeButton({ describedBy }: { describedBy: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" size="lg" loading={pending} aria-describedby={describedBy} className="min-h-11">
      {pending ? 'Taking the task…' : 'Take this task'}
    </Button>
  );
}

/** "Take this task": assigns the Flight task to the viewer and marks it in progress (server decides). */
export function ClaimFlightTaskForm({
  taskId,
  canTake,
  action,
  initialState = null,
}: {
  taskId: string;
  /** False once anyone has the task: only the result message stays. */
  canTake: boolean;
  action: FlightAction;
  /** Preview gallery only. */
  initialState?: UiResult | null;
}) {
  const [state, formAction] = useActionState(guard(action), initialState);
  return (
    <form action={formAction} noValidate className="flex flex-col items-start gap-2 sm:items-end">
      <input type="hidden" name={FIELD.taskId} value={taskId} />
      {canTake ? (
        <>
          <p id="flight-claim-help" className="m-0 text-sm text-quiet">
            Shows colleagues you are handling it. It does not issue a ticket.
          </p>
          <TakeButton describedBy="flight-claim-help" />
        </>
      ) : null}
      <ActionNotice result={state} className="w-full" />
    </form>
  );
}
