'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from '@/components/ui/button';
import { FIELD } from '@/modules/fulfilment/forms';
import { claimPurchaseTaskAction } from '@/modules/fulfilment/server/actions';
import { guard, type UiResult } from './booking-forms';
import { ActionNotice } from './intake-forms';

function TakeButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" size="lg" loading={pending} aria-describedby="claim-help" className="min-h-11">
      {pending ? 'Taking the task…' : 'Take this task'}
    </Button>
  );
}

/** "Take this task": assigns the task to the viewer and marks it in progress (server decides). The header's one primary. */
export function ClaimTaskForm({
  taskId,
  canTake,
  initialState = null,
}: {
  taskId: string;
  /** False once anyone has the task: only the result message stays. */
  canTake: boolean;
  /** Preview gallery only. */
  initialState?: UiResult | null;
}) {
  const [state, action] = useActionState(guard(claimPurchaseTaskAction), initialState ?? null);
  return (
    <form action={action} noValidate className="flex flex-col items-start gap-2 sm:items-end">
      <input type="hidden" name={FIELD.taskId} value={taskId} />
      {canTake ? (
        <>
          <p id="claim-help" className="m-0 text-sm text-quiet">
            Shows colleagues you are handling it. It does not book the hotel.
          </p>
          <TakeButton />
        </>
      ) : null}
      <ActionNotice result={state} className="w-full" />
      {state?.ok ? (
        <p role="status" className="m-0 text-sm text-copy">
          {state.message || 'The task is yours. Nothing is booked yet.'}
        </p>
      ) : null}
    </form>
  );
}
