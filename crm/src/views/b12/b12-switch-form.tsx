'use client';

import { useState } from 'react';
import { HandForm } from '@/components/hand-form';
import { Button } from '@/components/ui/button';
import { ChoiceGroup, Radio } from '@/components/ui/choice';
import { B12_SWITCH_ACTION_TEXT, B12_SWITCH_LIMITS, B12_SWITCH_TEXT, type B12SwitchView } from '@/modules/fulfilment/contracts';
import { B12_SWITCH_FIELD } from '@/modules/fulfilment/b11-forms';
import { AreaField } from '../b11/controls';
import { PendingButton, ResultBox, useB11Action } from '../b11/form-kit';
import type { B11Action } from '../b11/shapes';

/*
 * One B1.2 switch (Super Admin): the new state, a reason (10–500 characters)
 * and a confirmation that says in words what changes for staff before
 * anything is saved. Typed values stay after a refusal.
 */
export function B12SwitchForm({ row, action }: { row: B12SwitchView; action: B11Action }) {
  const [target, setTarget] = useState<'on' | 'off' | ''>('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [state, formAction] = useB11Action(action, {
    onSuccess: () => {
      setConfirming(false);
      setReason('');
      setTarget('');
    },
  });
  const text = B12_SWITCH_TEXT[row.key];
  const id = `b12-switch-${row.key}`;
  const trimmed = reason.trim();
  const reasonOk = trimmed.length >= B12_SWITCH_LIMITS.reason.min && trimmed.length <= B12_SWITCH_LIMITS.reason.max;
  const changes = target !== '' && (target === 'on') !== row.on;
  const refused = state && !state.ok && 'fields' in state ? (state.fields ?? []) : [];
  const consequence = target === 'on' ? text.onNote : target === 'off' ? text.offNote : '';
  // Unknown is never treated as off: no change form until the state can be read.
  if (row.on === null) return <p className="m-0 text-sm text-copy">The CRM could not read this setting, so it shows as Unknown. Unknown is not Off. It cannot be changed until the CRM can read it. Reload the page; if it stays Unknown, tell the CRM team.</p>;
  return (
    <HandForm action={formAction} noValidate className="flex flex-col gap-3" aria-label={`Change: ${text.title}`}>
      <ResultBox result={state} fields={[{ field: B12_SWITCH_FIELD.reason, id: `${id}-reason`, label: 'Reason: 10 to 500 characters' }]} />
      <input type="hidden" name={B12_SWITCH_FIELD.key} value={row.key} />
      <ChoiceGroup id={`${id}-state`} legend="Set it to">
        <Radio id={`${id}-on`} name={B12_SWITCH_FIELD.state} value="on" checked={target === 'on'} onChange={() => { setTarget('on'); setConfirming(false); }} label="On" description={row.on === true ? 'It is on now.' : undefined} />
        <Radio id={`${id}-off`} name={B12_SWITCH_FIELD.state} value="off" checked={target === 'off'} onChange={() => { setTarget('off'); setConfirming(false); }} label="Off" description={row.on === false ? 'It is off now.' : undefined} />
      </ChoiceGroup>
      <AreaField
        id={`${id}-reason`}
        name={B12_SWITCH_FIELD.reason}
        label="Reason"
        hint={B12_SWITCH_ACTION_TEXT.reasonHint}
        rows={2}
        maxLength={B12_SWITCH_LIMITS.reason.max}
        value={reason}
        onChange={setReason}
        error={refused.includes(B12_SWITCH_FIELD.reason) ? 'Say why, in 10 to 500 characters.' : null}
      />
      {confirming && changes ? (
        <div className="flex flex-col gap-2 rounded-control border border-status-warning-line bg-status-warning-tint px-3.5 py-3" role="note">
          <p className="m-0 font-semibold text-ink">
            Switch “{text.title}” {target}?
          </p>
          <p className="m-0 text-copy">{consequence}</p>
          {row.key === 'bitrix_id_proof_copy' && target === 'on' && (row.openStops ?? 0) > 0 ? (
            <p className="m-0 text-copy">
              {row.openStops} open automatic {row.openStops === 1 ? 'stop' : 'stops'} will be closed with your reason. Check those Bitrix Deals first.
            </p>
          ) : null}
          <p className="m-0 text-sm text-quiet">{B12_SWITCH_ACTION_TEXT.approvalNote}</p>
          <div className="flex flex-wrap gap-2">
            <PendingButton pendingLabel="Saving…" variant="primary">
              Yes, switch it {target}
            </PendingButton>
            <Button variant="ghost" className="min-h-11" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" className="min-h-11" disabled={!changes || !reasonOk} onClick={() => setConfirming(true)}>
            Review the change
          </Button>
          <span className="text-sm text-quiet" aria-live="polite">
            {target === '' ? 'Choose on or off first.' : !changes ? `It is already ${target}.` : !reasonOk ? 'Write a reason of 10 to 500 characters.' : ''}
          </span>
        </div>
      )}
    </HandForm>
  );
}
