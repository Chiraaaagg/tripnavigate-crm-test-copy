'use client';

import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Hidden, type DecisionAction } from '@/views/accounts/supplier-forms';
import { DeskDialog, DeskResultLine, todayIst, type DeskResult } from './desk-kit';
import { DESK_FIELD } from './labels';

/*
 * Deal money card forms (contract 7.1 T4, T5; 11.4), Accounts only: add a
 * Tally GST invoice reference (typed by Accounts from Tally; the CRM issues no
 * invoice) and withdraw one with a reason. A refusal keeps the dialog open
 * with what was typed.
 */

export function AddTallyInvoice({ dealId, action, initialOpen = false, initialState = null }: { dealId: string; action: DecisionAction; initialOpen?: boolean; initialState?: DeskResult | null }) {
  const [open, setOpen] = useState(initialOpen);
  const [done, setDone] = useState<DeskResult | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const uid = useId();
  return (
    <div className="flex flex-col items-start gap-2">
      <div ref={resultRef} tabIndex={-1} className="outline-none">
        <DeskResultLine state={done} />
      </div>
      <Button ref={opener} variant="secondary" onClick={() => setOpen(true)}>
        Add GST invoice reference
      </Button>
      {open ? (
        <DeskDialog
          open
          returnFocus={opener}
          onOpenChange={setOpen}
          title="Add a Tally GST invoice reference"
          description="Type the invoice number exactly as Tally shows it. The CRM does not create or send invoices."
          primaryLabel="Add reference"
          pendingLabel="Saving…"
          action={action}
          initialState={initialState}
          onDone={(r) => {
            setOpen(false);
            setDone(r);
            requestAnimationFrame(() => resultRef.current?.focus());
          }}
        >
          {({ requestId }) => (
            <>
              <Hidden fields={{ [DESK_FIELD.dealId]: dealId, [DESK_FIELD.requestId]: requestId }} />
              <Field htmlFor={`${uid}-ref`} label="Invoice number in Tally" hint="Letters, numbers, spaces and / . - only; up to 40 characters.">
                <Input id={`${uid}-ref`} name={DESK_FIELD.invoiceRef} required maxLength={40} pattern="[A-Za-z0-9/ .\-]+" autoComplete="off" aria-describedby={fieldDescribedBy(`${uid}-ref`, { hint: true })} />
              </Field>
              <Field htmlFor={`${uid}-date`} label="Invoice date">
                <Input id={`${uid}-date`} name={DESK_FIELD.invoiceDate} type="date" required min="2000-01-01" max={todayIst()} />
              </Field>
              <Field htmlFor={`${uid}-note`} label="Note" optional hint="Up to 300 characters.">
                <Textarea id={`${uid}-note`} name={DESK_FIELD.note} maxLength={300} rows={2} aria-describedby={fieldDescribedBy(`${uid}-note`, { hint: true })} />
              </Field>
            </>
          )}
        </DeskDialog>
      ) : null}
    </div>
  );
}

export function WithdrawTallyInvoice({ id, dealId, invoiceRef, rowVersion, action }: { id: string; dealId: string; invoiceRef: string; rowVersion: number; action: DecisionAction }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<DeskResult | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const uid = useId();
  if (done?.ok) return <DeskResultLine state={done} />;
  return (
    <>
      <Button ref={opener} variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Withdraw<span className="sr-only"> GST invoice reference {invoiceRef}</span>
      </Button>
      {open ? (
        <DeskDialog
          open
          returnFocus={opener}
          onOpenChange={setOpen}
          title={`Withdraw ${invoiceRef}?`}
          description="Use this when the reference was typed wrongly or the invoice was cancelled in Tally. It stays in the history."
          primaryLabel="Withdraw reference"
          pendingLabel="Saving…"
          cancelLabel="Keep it"
          danger
          action={action}
          onDone={(r) => {
            setOpen(false);
            setDone(r);
          }}
        >
          {({ requestId }) => (
            <>
              <Hidden fields={{ [DESK_FIELD.recordId]: id, [DESK_FIELD.dealId]: dealId, [DESK_FIELD.expectedRowVersion]: rowVersion, [DESK_FIELD.requestId]: requestId }} />
              <Field htmlFor={`${uid}-why`} label="Why" hint="10 to 500 characters.">
                <Textarea id={`${uid}-why`} name={DESK_FIELD.reason} required minLength={10} maxLength={500} rows={3} aria-describedby={fieldDescribedBy(`${uid}-why`, { hint: true })} />
              </Field>
            </>
          )}
        </DeskDialog>
      ) : null}
    </>
  );
}
