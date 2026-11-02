'use client';

import { useActionState } from 'react';
import { FormMessage } from '@/components/FormMessage';
import { SubmitButton } from '@/components/SubmitButton';
import { type FormState, initialFormState } from '@/lib/forms';
import { retryInboxItemAction, runReconcileNowAction } from '@/modules/integration/server/actions';

/** Moves one review/failed/dead-letter inbox row back to the queue (server checks integration.manage). */
export function RetryInboxItemForm({
  inboxId,
  sourceDealId,
  sourceObject = 'deal',
  initialState,
}: {
  inboxId: string;
  sourceDealId: string;
  /** Phase 6: Bitrix object type of the row; names the record in the button. */
  sourceObject?: 'deal' | 'lead';
  /** Preview gallery only. */
  initialState?: FormState;
}) {
  const [state, action] = useActionState(retryInboxItemAction, initialState ?? initialFormState);
  return (
    <form action={action} noValidate className="inline-form">
      <FormMessage state={state} />
      <input type="hidden" name="inboxId" value={inboxId} />
      <SubmitButton pendingLabel="Queuing again…" variant="secondary">
        Retry<span className="visually-hidden"> Bitrix {sourceObject} #{sourceDealId}</span>
      </SubmitButton>
    </form>
  );
}

/** Runs one sync now (the same run the automatic scheduler makes). Read-only towards Bitrix. */
export function ReconcileNowForm({ initialState }: { initialState?: FormState }) {
  const [state, action] = useActionState(runReconcileNowAction, initialState ?? initialFormState);
  return (
    <form action={action} noValidate>
      <FormMessage state={state} />
      <p id="reconcile-help" className="hint">
        Reads new and changed deals now. Once every 5 minutes at most. Nothing changes in Bitrix.
      </p>
      <SubmitButton pendingLabel="Checking Bitrix…" describedBy="reconcile-help">
        Check Bitrix now
      </SubmitButton>
    </form>
  );
}
