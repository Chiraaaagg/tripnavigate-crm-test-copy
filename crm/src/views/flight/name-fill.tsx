'use client';

import { UserPlus } from 'lucide-react';
import { useId, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Submit, type DecisionAction, type UiResult } from '@/views/accounts/supplier-forms';
import { ActionForm } from './kit';
import { PAX_LABEL, PAX_ORDER } from './labels';
import type { PaxType } from './types';

/*
 * Owner decision R3 (5 Nov 2026): the Deal's Sales owner (or the branch
 * Manager when the Deal has no active owner) may add a MISSING traveller name
 * so Flight can ticket them, without a booking revision. Only blank places
 * are offered; a name that exists cannot be changed here. HandForm keeps what
 * was typed after a refusal; on success focus moves to the result line.
 */

export function NameFillSection({
  dealId,
  versionId,
  slots,
  action,
  initialState,
}: {
  dealId: string;
  versionId: string;
  slots: Array<{ seq: number; type: PaxType | null }>;
  action: DecisionAction;
  /** Preview gallery only: the first slot's first answer. */
  initialState?: UiResult | null;
}) {
  if (slots.length === 0) return null;
  return (
    <section aria-labelledby="name-fill-heading" className="flex flex-col gap-3 rounded-control border border-status-warning-line bg-status-warning-tint px-3.5 py-3">
      <h3 id="name-fill-heading" className="m-0 flex items-center gap-2 text-base font-semibold text-ink">
        <UserPlus aria-hidden="true" className="size-4" />
        Fill in the missing traveller names
      </h3>
      <p className="m-0 text-sm text-copy">
        Only a missing name can be added here, so the Flight team can book that traveller. Names already in the booking cannot be changed here.
      </p>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {slots.map((s, i) => (
          <li key={s.seq} className="m-0 rounded-control border border-line bg-card px-3 py-3">
            <NameFillForm dealId={dealId} versionId={versionId} seq={s.seq} type={s.type} action={action} initialState={i === 0 ? initialState : undefined} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function NameFillForm({ dealId, versionId, seq, type, action, initialState }: { dealId: string; versionId: string; seq: number; type: PaxType | null; action: DecisionAction; initialState?: UiResult | null }) {
  const base = useId();
  const [name, setName] = useState('');
  const [pax, setPax] = useState<PaxType | ''>(type ?? '');
  const [errors, setErrors] = useState<{ name?: string; type?: string }>({});
  const label = `Traveller ${seq}${type ? ` (${PAX_LABEL[type].toLowerCase()})` : ''}`;
  return (
    <ActionForm
      action={action}
      fields={{ dealId, versionId, seq, fullName: name.trim(), travellerType: pax }}
      label={`Fill in the name of ${label}`}
      initialState={initialState}
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        const errs: typeof errors = {};
        const n = name.trim();
        if (n.length < 1) errs.name = 'Type the traveller’s full name as on their ID.';
        else if (n.length > 120) errs.name = 'Keep the name under 120 characters.';
        if (!pax) errs.type = 'Choose adult, child or infant.';
        setErrors(errs);
        if (errs.name || errs.type) {
          e.preventDefault();
          document.getElementById(errs.name ? `${base}-name` : `${base}-type`)?.focus();
        }
      }}
    >
      {(state) =>
        state?.ok ? null : (
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
              <label htmlFor={`${base}-name`} className="text-sm font-semibold text-ink">
                Full name of {label}
              </label>
              <Input
                id={`${base}-name`}
                value={name}
                maxLength={120}
                autoComplete="off"
                onChange={(e) => setName(e.target.value)}
                invalid={!!errors.name}
                aria-describedby={errors.name ? `${base}-name-error` : undefined}
              />
              {errors.name ? (
                <span id={`${base}-name-error`} className="text-sm font-medium text-status-danger">
                  {errors.name}
                </span>
              ) : null}
            </div>
            {type === null ? (
              <div className="flex flex-col gap-1">
                <label htmlFor={`${base}-type`} className="text-sm font-semibold text-ink">
                  Traveller type
                </label>
                <Select
                  id={`${base}-type`}
                  value={pax}
                  onChange={(e) => setPax(e.target.value as PaxType | '')}
                  invalid={!!errors.type}
                  aria-describedby={errors.type ? `${base}-type-error` : undefined}
                >
                  <option value="">Choose</option>
                  {PAX_ORDER.map((t) => (
                    <option key={t} value={t}>
                      {PAX_LABEL[t]}
                    </option>
                  ))}
                </Select>
                {errors.type ? (
                  <span id={`${base}-type-error`} className="text-sm font-medium text-status-danger">
                    {errors.type}
                  </span>
                ) : null}
              </div>
            ) : null}
            <Submit label="Save the name" pendingLabel="Saving…" variant="secondary" />
          </div>
        )
      }
    </ActionForm>
  );
}
