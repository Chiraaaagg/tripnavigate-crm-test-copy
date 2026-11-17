'use client';

import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useHandFormStatus } from '@/components/hand-form';
import { Submit, type DecisionAction } from '@/views/accounts/supplier-forms';
import { FF } from './actions';
import { ActionForm } from './kit';

/** "Take these flights": takes every open flight task of the Deal at once (A1). */
export function ClaimGroupForm({ dealId, flightCount, action }: { dealId: string; flightCount: number; action: DecisionAction }) {
  const helpId = useId();
  return (
    <ActionForm action={action} fields={{ [FF.dealId]: dealId }} label="Take these flights" className="flex flex-col items-start gap-2 sm:items-end">
      {(state) =>
        state?.ok ? null : (
          <>
            <p id={helpId} className="m-0 text-sm text-quiet">
              {flightCount > 1 ? `Takes all ${flightCount} flights of this Deal. ` : ''}It does not issue a ticket.
            </p>
            <TakeButton describedBy={helpId} />
          </>
        )
      }
    </ActionForm>
  );
}

/** The page's one primary action: large (44 px target), pending state in words. */
function TakeButton({ describedBy }: { describedBy: string }) {
  const { pending } = useHandFormStatus();
  return (
    <Button
      type="submit"
      variant="primary"
      size="lg"
      className="min-h-11"
      aria-disabled={pending || undefined}
      aria-describedby={describedBy}
      onClick={(e) => {
        if (pending) e.preventDefault();
      }}
    >
      {pending ? 'Taking the flights…' : 'Take these flights'}
    </Button>
  );
}

/** Branch Manager: move all in-progress flights of the Deal to another Flight colleague (A2). */
export function ReassignGroupDrawer({
  dealId,
  expectedAssignee,
  candidates,
  action,
}: {
  dealId: string;
  expectedAssignee: string;
  candidates: Array<{ userId: string; name: string }>;
  action: DecisionAction;
}) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<{ to?: string; reason?: string }>({});
  const base = useId();
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <Button variant="secondary">Move to another colleague</Button>
      </DrawerTrigger>
      <DrawerContent aria-describedby={`${base}-desc`}>
        <DrawerHeader>
          <DrawerTitle className="m-0 text-lg font-semibold text-ink">Move these flights</DrawerTitle>
          <DrawerDescription id={`${base}-desc`} className="m-0 text-sm text-quiet">
            All flights of this Deal that are in progress move together. Finished flights keep their Flight colleague.
          </DrawerDescription>
        </DrawerHeader>
        <ActionForm
          action={action}
          fields={{ [FF.dealId]: dealId, [FF.expectedAssignee]: expectedAssignee }}
          label="Move these flights"
          className="flex flex-1 flex-col"
          onSubmit={(e) => {
            const p: typeof problem = {};
            if (!to) p.to = 'Choose a Flight colleague.';
            const len = reason.trim().length;
            if (len < 10 || len > 300) p.reason = 'Write a reason of 10 to 300 characters.';
            setProblem(p);
            if (p.to || p.reason) {
              e.preventDefault();
              document.getElementById(p.to ? `${base}-to` : `${base}-reason`)?.focus();
            }
          }}
        >
          <DrawerBody className="flex flex-col gap-4">
            <Field htmlFor={`${base}-to`} label="Move to" error={problem.to}>
              <Select id={`${base}-to`} name={FF.toUserId} value={to} onChange={(e) => setTo(e.target.value)} invalid={!!problem.to} aria-describedby={fieldDescribedBy(`${base}-to`, { error: problem.to })}>
                <option value="">Choose a colleague</option>
                {candidates.map((c) => (
                  <option key={c.userId} value={c.userId}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field htmlFor={`${base}-reason`} label="Reason" hint="10 to 300 characters. Shown in the History." error={problem.reason}>
              <Textarea
                id={`${base}-reason`}
                name={FF.reason}
                rows={3}
                maxLength={300}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                invalid={!!problem.reason}
                aria-describedby={fieldDescribedBy(`${base}-reason`, { hint: true, error: problem.reason })}
              />
            </Field>
          </DrawerBody>
          <DrawerFooter>
            <Submit label="Move the flights" pendingLabel="Moving…" />
          </DrawerFooter>
        </ActionForm>
      </DrawerContent>
    </Drawer>
  );
}
