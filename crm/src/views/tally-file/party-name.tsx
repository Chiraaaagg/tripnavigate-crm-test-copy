'use client';

import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { DeskResultLine, useDeskCommand, type DeskResult } from '@/views/accounts-desk/desk-kit';
import { Hidden, type DecisionAction } from '@/views/accounts/supplier-forms';
import { partyNameProblem } from './labels';
import { TF_FIELD, type TallyPartyName } from './types';

/*
 * Customer page › "Tally party name" (contract 7.2 C1; 15 screen 7), Accounts
 * only. Without it, this customer's receipts and refunds are left out of the
 * Tally file ("The customer has no Tally party name"). The name must match the
 * ledger in Tally exactly; the file never creates a ledger.
 */

export function TallyPartyNameField({ party, action, initialState = null }: { party: TallyPartyName; action: DecisionAction | null; initialState?: DeskResult | null }) {
  const uid = useId();
  const cmd = useDeskCommand(action ?? (async () => ({ ok: false, code: 'not_authorized', message: 'Only Accounts set the Tally party name.' })), initialState);
  const [local, setLocal] = useState<string | null>(null);
  const shown: DeskResult | null = local ? { ok: false, code: 'invalid_input', message: local } : cmd.state;
  const id = `${uid}-name`;
  if (!action)
    return (
      <div className="flex flex-col gap-1 font-sans text-sm">
        <span className="font-semibold text-ink">Tally party name</span>
        <span>{party.name ?? 'Not set — Accounts add it before the Tally file.'}</span>
      </div>
    );
  return (
    <form
      noValidate
      className="flex flex-col gap-2 font-sans"
      onSubmit={(e) => {
        const value = (e.currentTarget.elements.namedItem(TF_FIELD.name) as HTMLInputElement).value;
        const problem = partyNameProblem(value);
        if (problem) {
          e.preventDefault();
          setLocal(problem);
          document.getElementById(id)?.focus();
          return;
        }
        setLocal(null);
        cmd.submit(e);
      }}
    >
      <Hidden fields={{ [TF_FIELD.partyId]: party.partyId, [TF_FIELD.expectedRowVersion]: party.rowVersion, requestId: cmd.requestId }} />
      <div className="flex flex-wrap items-end gap-2">
        <Field htmlFor={id} label="Tally party name" hint="Exactly as the customer's ledger is named in Tally. Without it, this customer's money is left out of the Tally file." className="min-w-0 flex-1 basis-64">
          <Input id={id} name={TF_FIELD.name} defaultValue={party.name ?? ''} maxLength={100} autoComplete="off" spellCheck={false} aria-describedby={`${id}-hint`} aria-invalid={shown && !shown.ok ? true : undefined} />
        </Field>
        <Button type="submit" variant="secondary" aria-disabled={cmd.pending || undefined} onClick={(e) => (cmd.pending ? e.preventDefault() : undefined)}>
          {cmd.pending ? 'Saving…' : 'Save name'}
        </Button>
      </div>
      <DeskResultLine state={shown} okTitle="Saved" />
    </form>
  );
}

/** The customer page block (C1): the Tally party name in its own card under the customer details. */
export function TallyPartyNameCard({ party, action }: { party: TallyPartyName; action: DecisionAction | null }) {
  return (
    <Card className="mt-5">
      <section aria-labelledby="tally-party-h">
        <CardHeader>
          <CardTitle id="tally-party-h">Tally</CardTitle>
        </CardHeader>
        <CardBody>
          <TallyPartyNameField party={party} action={action} />
        </CardBody>
      </section>
    </Card>
  );
}
