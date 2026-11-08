'use client';

import { useId, useState } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { Submit, type DecisionAction } from '@/views/accounts/supplier-forms';
import { FF } from './actions';
import { ActionForm } from './kit';

/**
 * Approve or reject (or return) in one form. The second button needs a
 * reason (10–500 characters); the pressed button is the decision. Used for
 * flight changes on the Deal page (A7: approve | reject) and fares above
 * budget on Approvals (B6: approve | return).
 */
export function ApproveRejectForm({
  action,
  fields,
  label,
  approveLabel,
  rejectLabel,
  rejectValue,
  reasonLabel,
  reasonHint,
  help,
}: {
  action: DecisionAction;
  fields: Record<string, string | number>;
  label: string;
  approveLabel: string;
  rejectLabel: string;
  rejectValue: 'reject' | 'return';
  reasonLabel: string;
  reasonHint: string;
  help?: string;
}) {
  const base = useId();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <ActionForm
      action={action}
      fields={fields}
      label={label}
      onSubmit={(e) => {
        const submitter = (e.nativeEvent as globalThis.SubmitEvent).submitter as HTMLButtonElement | null;
        if (submitter?.value === rejectValue) {
          const len = reason.trim().length;
          if (len < 10 || len > 500) {
            e.preventDefault();
            setProblem('Write a reason of 10 to 500 characters first.');
            document.getElementById(`${base}-reason`)?.focus();
            return;
          }
        }
        setProblem(null);
      }}
    >
      {(state) =>
        state?.ok ? null : (
          <>
            {help ? (
              <p id={`${base}-help`} className="m-0 text-sm text-quiet">
                {help}
              </p>
            ) : null}
            <div className="flex flex-col gap-1">
              <label htmlFor={`${base}-reason`} className="text-sm font-semibold text-ink">
                {reasonLabel} <span className="font-normal text-quiet">(only to {rejectValue})</span>
              </label>
              <Textarea
                id={`${base}-reason`}
                name={FF.reason}
                rows={2}
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                invalid={!!problem}
                aria-describedby={`${base}-hint${problem ? ` ${base}-error` : ''}`}
              />
              <span id={`${base}-hint`} className="text-xs text-quiet">
                {reasonHint}
              </span>
              {problem ? (
                <span id={`${base}-error`} className="text-sm font-medium text-status-danger">
                  {problem}
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <Submit label={approveLabel} pendingLabel="Saving…" name={FF.decision} value="approve" describedBy={help ? `${base}-help` : undefined} />
              <Submit label={rejectLabel} pendingLabel="Saving…" variant="secondary" name={FF.decision} value={rejectValue} />
            </div>
          </>
        )
      }
    </ActionForm>
  );
}
