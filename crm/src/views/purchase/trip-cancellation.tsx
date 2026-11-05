'use client';

import { CircleCheck, Hourglass, TriangleAlert } from 'lucide-react';
import { useActionState, useId, useState } from 'react';
import { HandForm } from '@/components/hand-form';
import { StatusBadge } from '@/components/ui/badge';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { CANCELLATION_STATUS_LABEL, PURCHASE_BUILD_TEXT, type DealCancellationSummary } from '@/modules/procurement/contracts';
import { formatIst } from '../deal-labels';
import { guard, Hidden, ResultLine, Submit, useRequestId, type DecisionAction, type UiResult } from '../accounts/supplier-forms';

/*
 * Deal page · Services tab: "Trip cancelled" (owner decision 4, 2 Nov 2026).
 * Only the branch Manager of the Deal may open it (the database decides);
 * Purchase then enters what each supplier keeps and refunds on its tasks.
 * The customer refund side is not handled here and no amount is shown.
 */

export function TripCancellationCard({ dealId, summary, action }: { dealId: string; summary: DealCancellationSummary; action: DecisionAction }) {
  const T = PURCHASE_BUILD_TEXT;
  const base = useId();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [state, run] = useActionState((prev: UiResult | null, fd: FormData) => guard(action)(prev as never, fd), null);
  const requestId = useRequestId(state);
  const c = summary.cancellation;
  if (!c && !summary.canOpen) return null;
  return (
    <Card>
      <section aria-labelledby={`${base}-title`}>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id={`${base}-title`}>Trip cancellation</CardTitle>
            <CardDescription>{T.tripCancelHelp}</CardDescription>
          </div>
          {c ? (
            <StatusBadge tone={c.status === 'approved' ? 'success' : c.status === 'sent_to_manager' ? 'info' : 'warning'} icon={c.status === 'approved' ? CircleCheck : c.status === 'sent_to_manager' ? Hourglass : TriangleAlert} wrap>
              <span className="sr-only">Cancellation: </span>
              {CANCELLATION_STATUS_LABEL[c.status]}
            </StatusBadge>
          ) : null}
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          {c ? (
            <>
              <p className="m-0 text-copy">
                <span className="font-semibold text-ink">Reason:</span> <span className="whitespace-pre-wrap wrap-break-word">{c.reason}</span>
              </p>
              <p className="m-0 text-sm text-quiet">
                Opened {formatIst(c.openedAt)}
                {c.openedByName ? ` by ${c.openedByName}` : ''}. Supplier charges are approved on your Approvals page.
              </p>
            </>
          ) : state?.ok ? (
            <ResultLine state={state} />
          ) : (
            <HandForm
              action={run}
              noValidate
              aria-label="Mark this trip cancelled"
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                const len = reason.trim().length;
                if (len < 10 || len > 500) {
                  e.preventDefault();
                  setProblem('Write 10 to 500 characters about why the trip is cancelled.');
                  document.getElementById(`${base}-reason`)?.focus();
                  return;
                }
                setProblem(null);
              }}
            >
              <ResultLine state={state} />
              <Hidden fields={{ dealId, requestId }} />
              <Field htmlFor={`${base}-reason`} label="Why is the trip cancelled?" hint="10 to 500 characters. Purchase and Accounts read it. No customer amounts." error={problem}>
                <Textarea
                  id={`${base}-reason`}
                  name="reason"
                  rows={3}
                  maxLength={500}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  invalid={!!problem}
                  aria-describedby={fieldDescribedBy(`${base}-reason`, { hint: true, error: problem })}
                />
              </Field>
              <div>
                <Submit label={T.tripCancelLabel} pendingLabel="Saving…" variant="danger" />
              </div>
            </HandForm>
          )}
        </CardBody>
      </section>
    </Card>
  );
}
