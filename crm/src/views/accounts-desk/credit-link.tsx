'use client';

import { useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { Hidden, type DecisionAction } from '@/views/accounts/supplier-forms';
import { DeskDialog, DeskResultLine, type DeskResult } from './desk-kit';
import { DESK_FIELD } from './labels';

/*
 * Accounts › Supplier invoices: "Link to its invoice" on a credit note that
 * has none yet (contract 7.3 S3, set once). The choices are the invoices of
 * the same supplier already on the page; nothing is typed again.
 */
export function CreditLinkButton({ documentId, number, invoices, action }: { documentId: string; number: string; invoices: Array<{ id: string; label: string }>; action: DecisionAction }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<DeskResult | null>(null);
  const uid = useId();
  const opener = useRef<HTMLButtonElement | null>(null);
  if (done?.ok) return <DeskResultLine state={done} />;
  if (invoices.length === 0) return <p className="m-0 text-sm text-quiet">No invoice of this supplier is listed to link this credit note to.</p>;
  return (
    <>
      <Button ref={opener} variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Link to its invoice<span className="sr-only"> (credit note {number})</span>
      </Button>
      {open ? (
        <DeskDialog
          open
          returnFocus={opener}
          onOpenChange={setOpen}
          title={`Which invoice does credit note ${number} reduce?`}
          description="This is set once. Ask a colleague to check if you are not sure."
          primaryLabel="Link credit note"
          pendingLabel="Linking…"
          action={action}
          onDone={(r) => {
            setOpen(false);
            setDone(r);
          }}
        >
          {({ requestId }) => (
            <>
              <Hidden fields={{ [DESK_FIELD.documentId]: documentId, [DESK_FIELD.requestId]: requestId }} />
              <Field htmlFor={`${uid}-inv`} label="Invoice">
                <Select id={`${uid}-inv`} name={DESK_FIELD.invoiceId} required defaultValue="">
                  <option value="" disabled>
                    Choose the invoice
                  </option>
                  {invoices.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
        </DeskDialog>
      ) : null}
    </>
  );
}
