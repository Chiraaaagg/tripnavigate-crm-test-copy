'use client';

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { FM_FIELD } from '@/modules/flight/money-contracts';
import { Hidden, type DecisionAction } from '@/views/accounts/supplier-forms';
import { DeskDialog, DeskResultLine, type DeskResult } from '@/views/accounts-desk/desk-kit';

/*
 * Accounts phase 0 (contract 5.3, 11.6): "Cancel request" on a pending Flight
 * supplier payment request, for its requester or the current owner of the
 * batch's cost task (the database decides; the button shows only when the
 * money read says canCancel). One confirm dialog; a refusal keeps it open
 * with the frozen message.
 */
export function CancelPaymentRequest({
  refNo,
  paymentId,
  rowVersion,
  dealId,
  action,
  initialOpen = false,
  initialState = null,
}: {
  refNo: string | null;
  paymentId: string;
  rowVersion: number;
  dealId: string;
  action: DecisionAction;
  /** Preview gallery only. */
  initialOpen?: boolean;
  initialState?: DeskResult | null;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [done, setDone] = useState<DeskResult | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const name = refNo ?? 'this payment request';
  return (
    <div className="flex flex-col items-start gap-2">
      <div ref={resultRef} tabIndex={-1} className="outline-none">
        <DeskResultLine state={done} />
      </div>
      {done?.ok ? null : (
        <Button ref={opener} variant="secondary" onClick={() => setOpen(true)}>
          Cancel request<span className="sr-only"> {name}</span>
        </Button>
      )}
      {open ? (
        <DeskDialog
          open
          returnFocus={opener}
          onOpenChange={setOpen}
          title={`Cancel payment request ${name}?`}
          description="Accounts will no longer see it. You can raise a new request later."
          primaryLabel="Cancel the request"
          pendingLabel="Cancelling…"
          danger
          cancelLabel="Keep the request"
          action={action}
          initialState={initialState}
          onDone={(r) => {
            setOpen(false);
            setDone(r);
            requestAnimationFrame(() => resultRef.current?.focus());
          }}
        >
          {({ requestId }) => <Hidden fields={{ [FM_FIELD.paymentId]: paymentId, [FM_FIELD.dealId]: dealId, [FM_FIELD.expectedRowVersion]: rowVersion, [FM_FIELD.requestId]: requestId }} />}
        </DeskDialog>
      ) : null}
    </div>
  );
}
