'use client';

import { Ban, CircleCheck, Hourglass, TriangleAlert } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChoiceGroup, Radio } from '@/components/ui/choice';
import { Field } from '@/components/ui/field';
import { MoneyInput } from '@/components/ui/money-input';
import { Notice } from '@/components/ui/notice';
import { Textarea } from '@/components/ui/textarea';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { DeskDialog, DeskResultLine, type DeskResult } from '@/views/accounts-desk/desk-kit';
import { paiseToRupees, TRIP_CANCELLED_VISA_TEXT, type VisaCancellationFee, type VisaWorkspaceCancellation } from '@/views/cancellations/types';
import { inr } from './format';
import { COST_KIND_LABEL, nameOf } from './labels';
import type { VisaApplicant, VisaCostKind, VisaWorkspace } from './types';

/*
 * Visa task · "Trip cancelled" (Accounts phase 2 contract 7.4 C10/C11, 11 item 7).
 * While the cancellation is open: a banner only (the block starts at the
 * Manager's approval, LD12). After approval: new fees, applications and
 * payments are stopped; for every submitted application the Visa person
 * chooses "Withdraw" or "Let it finish" with a reason; for every fee the
 * company paid they enter the refund expected (no entry = not refundable).
 * Visa sees only its own fees: never the customer's price, money or refund.
 */

export interface VisaCancellationActions {
  /** C10 chooseVisaCancellationAction: applicationId, expectedRowVersion, choice, reason, requestId (+ taskId, dealId). */
  chooseCancellation?: DecisionAction;
  /** C11 setVisaCancellationFeeAction: entryId, refundExpectedRupees, note, expectedRevision, requestId (+ taskId, dealId). */
  setCancellationFee?: DecisionAction;
}

type Applicant = VisaApplicant;

export function visaCancellationOf(ws: VisaWorkspace): VisaWorkspaceCancellation | null {
  return ws.cancellation ?? null;
}

const SUBMITTED = new Set(['submitted', 'decision_pending']);

export function VisaTripCancelledPanel({
  ws,
  actions,
  preview,
}: {
  ws: VisaWorkspace;
  actions?: VisaCancellationActions | null;
  /** Preview gallery only: a dialog open on first paint, optionally with a refusal. */
  preview?: { choiceFor?: string; feeFor?: string; state?: DeskResult | null };
}) {
  const c = visaCancellationOf(ws);
  const base = useId();
  const [result, setResult] = useState<DeskResult | null>(null);
  const resultId = `${base}-result`;
  if (!c) return null;
  if (!c.approved) {
    return (
      <Notice tone="warning" title="Trip cancellation in progress" role="status">
        <p>The branch Manager is deciding the trip cancellation. You can keep working for now. Once it is approved, new fees, applications and payments stop, and you decide what happens to each submitted application.</p>
      </Notice>
    );
  }
  const applicants = ws.applicants.filter((a) => !a.removed && !a.superseded && (SUBMITTED.has(a.state) || !!a.cancellationChoice));
  // The company-paid fees come from the cancellation block (with their refund revision and who may set it).
  const fees = c.fees.map((f) => ({ a: ws.applicants.find((x) => x.applicationId === f.applicationId) ?? null, f }));
  const open = applicants.filter((a) => !a.cancellationChoice).length;
  const done = (r: DeskResult) => {
    setResult(r);
    window.setTimeout(() => document.getElementById(resultId)?.focus(), 60);
  };
  return (
    <Card id={`visa-cancel-${ws.taskId}`} className="border-status-danger-line">
      <section aria-labelledby={`${base}-title`}>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id={`${base}-title`}>Trip cancelled</CardTitle>
            <CardDescription>The branch Manager approved the trip cancellation.</CardDescription>
          </div>
          {open > 0 ? (
            <StatusBadge tone="warning" icon={TriangleAlert} wrap>
              {open === 1 ? '1 application to decide' : `${open} applications to decide`}
            </StatusBadge>
          ) : (
            <StatusBadge tone="success" icon={CircleCheck} wrap>
              Every application decided
            </StatusBadge>
          )}
        </CardHeader>
        <CardBody className="flex flex-col gap-5">
          <Notice tone="locked" icon={Ban}>
            <p>{TRIP_CANCELLED_VISA_TEXT}</p>
          </Notice>
          <div id={resultId} tabIndex={-1} className="outline-none empty:hidden">
            {result ? <DeskResultLine state={result} okTitle="Saved" /> : null}
          </div>

          <section aria-labelledby={`${base}-apps`} className="flex flex-col gap-2">
            <h3 id={`${base}-apps`} className="m-0 text-base font-semibold text-ink">
              Submitted applications
            </h3>
            {applicants.length === 0 ? (
              <p className="m-0 text-copy">No application was submitted, so there is nothing to withdraw.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {applicants.map((a) => (
                  <ApplicationChoice key={a.applicationId} ws={ws} a={a} action={actions?.chooseCancellation ?? null} initialOpen={preview?.choiceFor === a.applicationId} initialState={preview?.choiceFor === a.applicationId ? preview.state : undefined} onDone={done} />
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby={`${base}-fees`} className="flex flex-col gap-2">
            <h3 id={`${base}-fees`} className="m-0 text-base font-semibold text-ink">
              Fees the company paid
            </h3>
            {fees.length === 0 ? (
              <p className="m-0 text-copy">No fee was paid by the company on this task.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {fees.map(({ a, f }) => (
                  <FeeRefund key={f.entryId} ws={ws} a={a} f={f} action={f.canSet ? (actions?.setCancellationFee ?? null) : null} initialOpen={preview?.feeFor === f.entryId} initialState={preview?.feeFor === f.entryId ? preview.state : undefined} onDone={done} />
                ))}
              </ul>
            )}
            <p className="m-0 text-sm text-quiet">A fee without a refund expected is treated as not refundable. Accounts records what is actually received.</p>
          </section>
        </CardBody>
      </section>
    </Card>
  );
}

const CHOICE_WORD = { withdraw: 'Withdrawn because of the cancellation', finish: 'Letting it finish' } as const;

function ApplicationChoice({
  ws,
  a,
  action,
  initialOpen,
  initialState,
  onDone,
}: {
  ws: VisaWorkspace;
  a: Applicant;
  action: DecisionAction | null;
  initialOpen?: boolean;
  initialState?: DeskResult | null;
  onDone: (r: DeskResult) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(!!initialOpen);
  const opener = useRef<HTMLButtonElement>(null);
  const name = nameOf(a);
  return (
    <li className="m-0 flex flex-wrap items-center justify-between gap-2 rounded-control border border-line bg-canvas px-3 py-2">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-semibold wrap-anywhere text-ink">{name}</span>
        <span className="text-sm text-quiet">{a.stateText}</span>
        {a.cancellationChoice && a.cancellationChoiceReason ? (
          <span className="text-sm text-copy">
            <span className="font-semibold text-ink">Reason: </span>
            {a.cancellationChoiceReason}
          </span>
        ) : null}
      </div>
      {a.cancellationChoice ? (
        <StatusBadge tone={a.cancellationChoice === 'withdraw' ? 'neutral' : 'info'} icon={a.cancellationChoice === 'withdraw' ? Ban : Hourglass} wrap>
          {CHOICE_WORD[a.cancellationChoice]}
        </StatusBadge>
      ) : action && a.canChooseCancellation ? (
        <>
          <Button ref={opener} type="button" variant="secondary" onClick={() => setOpen(true)} aria-label={`Decide the application of ${name}`}>
            Decide
          </Button>
          {open ? (
            <DeskDialog
              open={open}
              onOpenChange={setOpen}
              title={`Application of ${name}`}
              description="The trip is cancelled. Withdraw the application now, or let the embassy finish it (its fees are already paid)."
              primaryLabel="Save the choice"
              pendingLabel="Saving…"
              action={action}
              initialState={initialState}
              returnFocus={opener}
              onDone={(r) => {
                setOpen(false);
                onDone(r);
              }}
            >
              {({ requestId }) => (
                <>
                  <input type="hidden" name="taskId" value={ws.taskId} />
                  <input type="hidden" name="dealId" value={ws.dealId} />
                  <input type="hidden" name="applicationId" value={a.applicationId} />
                  <input type="hidden" name="expectedRowVersion" value={String(a.rowVersion)} />
                  <input type="hidden" name="requestId" value={requestId} />
                  <ChoiceGroup id={`${id}-choice`} legend="What happens to this application?">
                    <Radio id={`${id}-withdraw`} name="choice" value="withdraw" defaultChecked label="Withdraw the application" description="Same as withdrawing it on the Passengers card: the passport handover follows." />
                    <Radio id={`${id}-finish`} name="choice" value="finish" label="Let it finish" description="The embassy decides as usual; you record the decision later." />
                  </ChoiceGroup>
                  <Field htmlFor={`${id}-reason`} label="Reason" hint="10 to 300 characters, for example what the customer asked for.">
                    <Textarea id={`${id}-reason`} name="reason" rows={3} maxLength={300} aria-describedby={`${id}-reason-hint`} />
                  </Field>
                </>
              )}
            </DeskDialog>
          ) : null}
        </>
      ) : (
        <StatusBadge tone="warning" icon={TriangleAlert} wrap>
          Choice needed · the Visa person on this task decides
        </StatusBadge>
      )}
    </li>
  );
}

function FeeRefund({
  ws,
  a,
  f,
  action,
  initialOpen,
  initialState,
  onDone,
}: {
  ws: VisaWorkspace;
  a: Applicant | null;
  f: VisaCancellationFee;
  action: DecisionAction | null;
  initialOpen?: boolean;
  initialState?: DeskResult | null;
  onDone: (r: DeskResult) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(!!initialOpen);
  const opener = useRef<HTMLButtonElement>(null);
  const kind = COST_KIND_LABEL[f.costKind as VisaCostKind] ?? 'Fee';
  const what = a ? `${kind} of ${nameOf(a)}` : `${kind} (whole task)`;
  const has = f.refundExpectedPaise !== null && f.refundExpectedPaise !== undefined;
  return (
    <li className="m-0 flex flex-wrap items-center justify-between gap-2 rounded-control border border-line bg-canvas px-3 py-2">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="font-semibold wrap-anywhere text-ink">{what}</span>
        <span className="text-sm text-quiet tabular-nums">
          Paid {inr(f.amountPaise)} · Refund expected {has ? inr(f.refundExpectedPaise) : 'not entered (not refundable)'}
        </span>
      </div>
      {action ? (
        <>
          <Button ref={opener} type="button" variant="secondary" onClick={() => setOpen(true)} aria-label={`${has ? 'Change' : 'Set'} refund expected for ${what}`}>
            {has ? 'Change refund expected' : 'Set refund expected'}
          </Button>
          {open ? (
            <DeskDialog
              open={open}
              onOpenChange={setOpen}
              title={`Refund expected · ${what}`}
              description={`The company paid ${inr(f.amountPaise)}. Enter what the embassy or service provider will refund. Enter 0 when nothing comes back.`}
              primaryLabel="Save refund expected"
              pendingLabel="Saving…"
              action={action}
              initialState={initialState}
              returnFocus={opener}
              onDone={(r) => {
                setOpen(false);
                onDone(r);
              }}
            >
              {({ requestId }) => (
                <>
                  <input type="hidden" name="taskId" value={ws.taskId} />
                  <input type="hidden" name="dealId" value={ws.dealId} />
                  <input type="hidden" name="entryId" value={f.entryId} />
                  <input type="hidden" name="expectedRevision" value={String(f.revisionNo)} />
                  <input type="hidden" name="requestId" value={requestId} />
                  <Field htmlFor={`${id}-amount`} label="Refund expected (₹)" hint={`Up to ${inr(f.amountPaise)}.`}>
                    <MoneyInput id={`${id}-amount`} name="refundExpectedRupees" defaultValue={paiseToRupees(f.refundExpectedPaise)} aria-describedby={`${id}-amount-hint`} />
                  </Field>
                  <Field htmlFor={`${id}-note`} label="Note" optional hint="Up to 500 characters, for example the embassy's refund rule.">
                    <Textarea id={`${id}-note`} name="note" rows={2} maxLength={500} aria-describedby={`${id}-note-hint`} />
                  </Field>
                </>
              )}
            </DeskDialog>
          ) : null}
        </>
      ) : null}
    </li>
  );
}
