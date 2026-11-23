'use client';

import { Button } from '@/components/ui/button';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { formOf, VF } from './actions';
import { ResultNotice, useCommand, type VisaResult } from './kit';

/**
 * "Take this task" (C1 visa_task_claim): the header's one primary action for
 * the Visa desk on a task nobody holds. A conflict ("Someone at the desk
 * took this task first.") shows its words under the button.
 */
export function ClaimTaskForm({ taskId, dealId, action, initialState = null }: { taskId: string; dealId: string; action: DecisionAction; initialState?: VisaResult | null }) {
  const cmd = useCommand(action, initialState);
  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <Button variant="primary" size="lg" loading={cmd.pending} aria-disabled={cmd.pending || undefined} onClick={() => cmd.send((rid) => formOf({ [VF.taskId]: taskId, [VF.dealId]: dealId }, rid))}>
        {cmd.pending ? 'Taking…' : 'Take this task'}
      </Button>
      <div className="max-w-sm">
        <ResultNotice state={cmd.state} okTitle="Taken" failTitle="Not taken" />
      </div>
    </div>
  );
}
