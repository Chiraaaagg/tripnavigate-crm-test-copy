'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Hidden, type DecisionAction } from '@/views/accounts/supplier-forms';
import { DeskResultLine, useDeskCommand, useRefusedControl, type DeskResult } from './desk-kit';

/*
 * Settings · Accounts (contract 6.2.6, 6.3.3, 7.1 T6/T7, 11.8): the notices
 * switch (Super Admin), the Tally export switch and the exception owner per
 * company (the finance policy managers: Super Admin without Accounts). Each
 * change needs a reason (10 to 500 characters) and is recorded. Current
 * values come from the server; "Not known" never reads as Off.
 *
 * Accounts phase 2 (contract 6.2 B9, 7.3 C12, 11.12): per company the
 * customer documents switch and the refunds switch, same pattern. Both stay
 * Off until the owner approves switching them on; a company whose read does
 * not carry the value shows "Not known" and no switch.
 */

export const SETTINGS_FIELD = { entityId: 'entityId', enabled: 'enabled', userId: 'userId', reason: 'reason' } as const;

export interface AccountsSettingsViewModel {
  /** null = could not be read. */
  noticesEnabled: boolean | null;
  canSetNotices: boolean;
  entities: Array<{
    entityId: string;
    entityName: string;
    tallyExportEnabled: boolean | null;
    /** Phase 2 (B9). Omitted or null = not known: no switch. */
    customerDocumentsEnabled?: boolean | null;
    /** Phase 2 (C12). Omitted or null = not known: no switch. */
    refundsEnabled?: boolean | null;
    exceptionOwnerUserId: string | null;
    /** Active Accounts people of the company without Purchase (the only valid owners). */
    accountsPeople: Array<{ userId: string; name: string }>;
  }>;
}

export interface AccountsSettingsActions {
  setNotices: DecisionAction;
  setTallyExport: DecisionAction;
  setExceptionOwner: DecisionAction;
  /** Phase 2 B9 (track B). Omitted until the action exists: the section is not shown. */
  setCustomerDocuments?: DecisionAction;
  /** Phase 2 C12 (track C setRefundsEnabledAction). Omitted until the action exists. */
  setRefunds?: DecisionAction;
}

const onOff = (v: boolean | null) => (v === null ? 'Not known (could not be read)' : v ? 'On' : 'Off');

export function AccountsSettingsView({ model, actions, initial }: { model: AccountsSettingsViewModel; actions: AccountsSettingsActions; initial?: Partial<Record<'notices' | 'tally' | 'owner' | 'documents' | 'refunds', DeskResult>> }) {
  return (
    <div className="flex flex-col gap-5 font-sans text-base text-copy">
      {model.canSetNotices ? (
        <Card>
          <section aria-labelledby="set-notices">
            <CardHeader>
              <div>
                <CardTitle id="set-notices">Staff notices (the bell)</CardTitle>
                <CardDescription>Now: {onOff(model.noticesEnabled)}. While off, nothing is written and the bell is hidden for everyone. Work lists and Home counts never depend on it.</CardDescription>
              </div>
            </CardHeader>
            <CardBody>
              <SwitchForm
                legend="Staff notices"
                current={model.noticesEnabled}
                action={actions.setNotices}
                fields={{}}
                initialState={initial?.notices}
              />
            </CardBody>
          </section>
        </Card>
      ) : null}
      {model.entities.map((e) => (
        <Card key={e.entityId}>
          <section aria-labelledby={`set-acc-${e.entityId}`}>
            <CardHeader>
              <CardTitle id={`set-acc-${e.entityId}`}>Accounts · {e.entityName}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-6">
              <div className="flex flex-col gap-2">
                <h3 className="m-0 text-base font-semibold text-ink">Tally export</h3>
                <p className="m-0 text-copy">Now: {onOff(e.tallyExportEnabled)}. When on, Accounts can create CSV exports on the Tally page. Exporting never marks anything matched.</p>
                <SwitchForm legend={`Tally export for ${e.entityName}`} current={e.tallyExportEnabled} action={actions.setTallyExport} fields={{ [SETTINGS_FIELD.entityId]: e.entityId }} initialState={initial?.tally} />
                <p className="m-0 text-sm">
                  <Link href={`/app/admin/accounts/tally-mapping?entity=${e.entityId}`} className="font-semibold text-brand-strong underline underline-offset-4">
                    Tally ledger mapping<span className="sr-only"> for {e.entityName}</span>
                  </Link>{' '}
                  <span className="text-quiet">— which Tally ledgers and voucher types each export row uses.</span>
                </p>
              </div>
              <OwnerForm entity={e} action={actions.setExceptionOwner} initialState={initial?.owner} />
              {actions.setCustomerDocuments ? (
                <div className="flex flex-col gap-2">
                  <h3 className="m-0 text-base font-semibold text-ink">Customer documents</h3>
                  <p className="m-0 text-copy">
                    Now: {onOff(e.customerDocumentsEnabled ?? null)}. When on, Accounts can draft and release Advance Invoices, Invoices and Credit Notes, and Sales owners and Managers can download them. Keep it off until the company’s CA has confirmed the document names and numbering.
                  </p>
                  <SwitchForm legend={`Customer documents for ${e.entityName}`} current={e.customerDocumentsEnabled ?? null} action={actions.setCustomerDocuments} fields={{ [SETTINGS_FIELD.entityId]: e.entityId }} initialState={initial?.documents} />
                </div>
              ) : null}
              {actions.setRefunds ? (
                <div className="flex flex-col gap-2">
                  <h3 className="m-0 text-base font-semibold text-ink">Refunds</h3>
                  <p className="m-0 text-copy">
                    Now: {onOff(e.refundsEnabled ?? null)}. When on, Sales owners can ask for customer refunds, a branch Manager approves the exact amount, and Accounts pay out with proof. Supplier refunds received can be recorded.
                  </p>
                  <SwitchForm legend={`Refunds for ${e.entityName}`} current={e.refundsEnabled ?? null} action={actions.setRefunds} fields={{ [SETTINGS_FIELD.entityId]: e.entityId }} initialState={initial?.refunds} />
                </div>
              ) : null}
            </CardBody>
          </section>
        </Card>
      ))}
    </div>
  );
}

function ReasonField({ id }: { id: string }) {
  return (
    <Field htmlFor={id} label="Reason" hint="10 to 500 characters, for example the owner’s approval. It is recorded with the change.">
      <Textarea id={id} name={SETTINGS_FIELD.reason} required minLength={10} maxLength={500} rows={2} aria-describedby={fieldDescribedBy(id, { hint: true })} />
    </Field>
  );
}

function SwitchForm({ legend, current, action, fields, initialState }: { legend: string; current: boolean | null; action: DecisionAction; fields: Record<string, string>; initialState?: DeskResult }) {
  const cmd = useDeskCommand(action, initialState ?? null);
  const uid = useId();
  const [formEl, setFormEl] = useState<HTMLFormElement | null>(null);
  useRefusedControl(formEl, cmd.state && !cmd.state.ok ? cmd.state : null, `${uid}-result`);
  const next = current === true ? false : true;
  // Not known is never Off: no switch until the current value can be read.
  if (current === null) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="m-0 text-sm text-copy">The current setting could not be read, so it cannot be changed from here right now.</p>
        <Button type="button" variant="secondary" onClick={() => window.location.reload()}>
          Check again
        </Button>
      </div>
    );
  }
  return (
    <form ref={setFormEl} noValidate aria-label={legend} className="flex flex-col gap-3" onSubmit={(e) => cmd.submit(e)}>
      <Hidden fields={{ ...fields, [SETTINGS_FIELD.enabled]: String(next) }} />
      <DeskResultLine state={cmd.state} okTitle="Saved" id={`${uid}-result`} />
      <ReasonField id={`${uid}-reason`} />
      <div>
        <Button type="submit" variant="secondary" aria-disabled={cmd.pending || undefined} onClick={(e) => cmd.pending && e.preventDefault()}>
          {cmd.pending ? 'Saving…' : next ? 'Switch on' : 'Switch off'}
        </Button>
      </div>
    </form>
  );
}

function OwnerForm({ entity, action, initialState }: { entity: AccountsSettingsViewModel['entities'][number]; action: DecisionAction; initialState?: DeskResult }) {
  const cmd = useDeskCommand(action, initialState ?? null);
  const uid = useId();
  const [formEl, setFormEl] = useState<HTMLFormElement | null>(null);
  useRefusedControl(formEl, cmd.state && !cmd.state.ok ? cmd.state : null, `${uid}-result`);
  const current = entity.accountsPeople.find((p) => p.userId === entity.exceptionOwnerUserId);
  return (
    <form ref={setFormEl} noValidate aria-labelledby={`${uid}-h`} className="flex flex-col gap-3" onSubmit={(e) => cmd.submit(e)}>
      <h3 id={`${uid}-h`} className="m-0 text-base font-semibold text-ink">
        Tally exception owner
      </h3>
      <p className="m-0 text-copy">
        Now: {current ? <strong className="text-ink">{current.name}</strong> : 'Not set — every Accounts person gets the exception notices.'} The owner gets the Tally exception notices and runs the daily check. Anyone in Accounts may still match and raise exceptions.
      </p>
      <Hidden fields={{ [SETTINGS_FIELD.entityId]: entity.entityId }} />
      <DeskResultLine state={cmd.state} okTitle="Saved" id={`${uid}-result`} />
      {entity.accountsPeople.length === 0 ? (
        <Notice tone="info">
          <p>No active Accounts person without a Purchase role in this company.</p>
        </Notice>
      ) : (
        <Field htmlFor={`${uid}-who`} label="Exception owner">
          <Select id={`${uid}-who`} name={SETTINGS_FIELD.userId} defaultValue={entity.exceptionOwnerUserId ?? ''}>
            <option value="">Nobody (everyone in Accounts is told)</option>
            {entity.accountsPeople.map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <ReasonField id={`${uid}-reason`} />
      <div>
        <Button type="submit" variant="secondary" aria-disabled={cmd.pending || undefined} onClick={(e) => cmd.pending && e.preventDefault()}>
          {cmd.pending ? 'Saving…' : 'Save exception owner'}
        </Button>
      </div>
    </form>
  );
}
