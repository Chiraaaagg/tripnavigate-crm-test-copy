'use client';

import { useId, useState, type ReactNode } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChoiceGroup, Radio } from '@/components/ui/choice';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { MoneyInput } from '@/components/ui/money-input';
import { Notice } from '@/components/ui/notice';
import { Textarea } from '@/components/ui/textarea';
import { Hidden, type DecisionAction } from '@/views/accounts/supplier-forms';
import { releaseEffect, rupeesInputText } from '@/views/customer-documents/acc3-pure';
import { DeskResultLine, useDeskCommand, useRefusedControl, type DeskResult } from './desk-kit';
import { inr } from './labels';

/*
 * Settings › Accounts, Accounts phase 3 additions (contract 6.1 B1, B2,
 * 7.2 C2, screen 5): per company the automatic bills switches (drafts, and
 * automatic release — On by default and effective only while customer
 * documents and automatic drafts are on), the write-off switch and its limit
 * (₹1 to ₹5,000 per Deal) and the Tally file switch with the Tally company
 * name. Finance policy managers only (the route decides). Each change needs
 * a reason (10 to 500 characters) and is recorded; a refusal keeps every
 * typed value and marks the field it names. "Not known" never reads as Off.
 *
 * Slot: rendered by the Settings › Accounts route under the Phase 2
 * AccountsSettingsView (it does not edit that file).
 */

export const ACC3_SETTINGS_FIELD = {
  entityId: 'entityId',
  drafts: 'drafts',
  release: 'release',
  enabled: 'enabled',
  limitRupees: 'limitRupees',
  companyName: 'companyName',
  reason: 'reason',
} as const;

export interface Acc3AccountsSettingsEntity {
  entityId: string;
  entityName: string;
  /** Phase 2 switch, shown here only to explain whether automatic bills can act. null = not known. */
  customerDocumentsEnabled: boolean | null;
  autoBillsEnabled: boolean | null;
  /** Default On (owner, 12 Nov 2026). */
  autoBillReleaseEnabled: boolean | null;
  writeOffEnabled: boolean | null;
  /** Whole paise, decimal string. */
  writeOffLimitPaise: string | null;
  tallyXmlEnabled: boolean | null;
  tallyCompanyName: string | null;
}

export interface Acc3AccountsSettingsActions {
  /** B1 admin_set_auto_bills(entity, drafts, release, reason). */
  setAutoBills: DecisionAction;
  /** B2 admin_set_write_off(entity, enabled, limit, reason). */
  setWriteOff: DecisionAction;
  /** C2 admin_set_tally_xml(entity, enabled, companyName, reason). */
  setTallyXml: DecisionAction;
}

type FormKey = 'autoBills' | 'writeOff' | 'tallyXml';

const onOff = (v: boolean | null) => (v === null ? 'Not known' : v ? 'On' : 'Off');

export function Acc3AccountsSettings({
  entities,
  actions,
  initial,
}: {
  entities: Acc3AccountsSettingsEntity[];
  actions: Acc3AccountsSettingsActions;
  /** Preview gallery: a result already on screen, by form. */
  initial?: Partial<Record<FormKey, DeskResult>>;
}) {
  return (
    <div className="flex flex-col gap-5 font-sans text-base text-copy">
      {entities.map((e) => (
        <Card key={e.entityId}>
          <section aria-labelledby={`acc3-set-${e.entityId}`}>
            <CardHeader>
              <div>
                <CardTitle id={`acc3-set-${e.entityId}`}>Automatic bills, write-offs and the Tally file · {e.entityName}</CardTitle>
                <CardDescription>Each switch stays off until the owner approves it. Bills are never sent to customers from here.</CardDescription>
              </div>
            </CardHeader>
            <CardBody className="flex flex-col gap-7">
              <AutoBillsForm e={e} action={actions.setAutoBills} initialState={initial?.autoBills} />
              <WriteOffForm e={e} action={actions.setWriteOff} initialState={initial?.writeOff} />
              <TallyXmlForm e={e} action={actions.setTallyXml} initialState={initial?.tallyXml} />
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
      <Textarea id={id} name={ACC3_SETTINGS_FIELD.reason} required minLength={10} maxLength={500} rows={2} aria-describedby={fieldDescribedBy(id, { hint: true })} />
    </Field>
  );
}

function NotKnown() {
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="m-0 text-sm text-copy">The current setting could not be read, so it cannot be changed from here right now.</p>
      <Button type="button" variant="secondary" onClick={() => window.location.reload()}>
        Check again
      </Button>
    </div>
  );
}

/** One section: heading, "Now" line with words (never colour alone), then the form. */
function SettingForm({
  title,
  now,
  explain,
  action,
  fields,
  initialState,
  saveLabel,
  children,
}: {
  title: string;
  now: ReactNode;
  explain: ReactNode;
  action: DecisionAction;
  fields: Record<string, string>;
  initialState?: DeskResult;
  saveLabel: string;
  children: (uid: string) => ReactNode;
}) {
  const cmd = useDeskCommand(action, initialState ?? null);
  const uid = useId();
  const [formEl, setFormEl] = useState<HTMLFormElement | null>(null);
  useRefusedControl(formEl, cmd.state && !cmd.state.ok ? cmd.state : null, `${uid}-result`);
  return (
    <form ref={setFormEl} noValidate aria-labelledby={`${uid}-h`} className="flex flex-col gap-3" onSubmit={(ev) => cmd.submit(ev)}>
      <h3 id={`${uid}-h`} className="m-0 text-base font-semibold text-ink">
        {title}
      </h3>
      <div className="flex flex-wrap items-center gap-2">{now}</div>
      <div className="m-0 text-copy">{explain}</div>
      <Hidden fields={fields} />
      <DeskResultLine state={cmd.state} okTitle="Saved" id={`${uid}-result`} />
      {children(uid)}
      <ReasonField id={`${uid}-reason`} />
      <div>
        <Button type="submit" variant="secondary" aria-disabled={cmd.pending || undefined} onClick={(ev) => cmd.pending && ev.preventDefault()}>
          {cmd.pending ? 'Saving…' : saveLabel}
        </Button>
      </div>
    </form>
  );
}

function OnOffRadios({ uid, name, legend, current, onLabel, offLabel, hint }: { uid: string; name: string; legend: string; current: boolean; onLabel: string; offLabel: string; hint?: ReactNode }) {
  return (
    <ChoiceGroup id={`${uid}-${name}`} legend={legend} hint={hint}>
      <div className="flex flex-col gap-2">
        <Radio id={`${uid}-${name}-on`} name={name} value="true" defaultChecked={current} label={onLabel} />
        <Radio id={`${uid}-${name}-off`} name={name} value="false" defaultChecked={!current} label={offLabel} />
      </div>
    </ChoiceGroup>
  );
}

function NowBadge({ label, value }: { label: string; value: boolean | null }) {
  return (
    <StatusBadge tone={value === null ? 'neutral' : value ? 'success' : 'neutral'} wrap>
      {label}: {onOff(value)}
    </StatusBadge>
  );
}

function AutoBillsForm({ e, action, initialState }: { e: Acc3AccountsSettingsEntity; action: DecisionAction; initialState?: DeskResult }) {
  if (e.autoBillsEnabled === null || e.autoBillReleaseEnabled === null) {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="m-0 text-base font-semibold text-ink">Automatic bills</h3>
        <NotKnown />
      </div>
    );
  }
  const effect = releaseEffect({ documents: e.customerDocumentsEnabled, drafts: e.autoBillsEnabled, release: e.autoBillReleaseEnabled });
  return (
    <SettingForm
      title="Automatic bills"
      now={
        <>
          <NowBadge label="Automatic drafts" value={e.autoBillsEnabled} />
          <NowBadge label="Automatic release" value={e.autoBillReleaseEnabled} />
          {effect === 'no_effect' ? (
            <StatusBadge tone="info" wrap>
              Release has no effect yet
            </StatusBadge>
          ) : null}
        </>
      }
      explain={
        <>
          <p className="m-0">
            With automatic drafts on, the CRM makes the Advance Invoice when a payment is verified, the Invoice when Accounts approve the booking (a replacement when the approved booking changes) and the Credit Note when a refund is settled, then checks each draft. A draft that fails a check is held for Accounts with the reason (Accounts › Bills to check).
          </p>
          <p className="m-0 mt-2.5">
            Automatic release is on by default. It has effect only when customer documents and automatic drafts are both on: drafts that pass every check get their number without a click. Released bills are never sent to customers.
          </p>
          {e.customerDocumentsEnabled !== true ? (
            <Notice tone="info" className="mt-2.5">
              <p>Customer documents are {e.customerDocumentsEnabled === false ? 'off' : 'not known'} for this company, so nothing is drafted or released until they are switched on above.</p>
            </Notice>
          ) : null}
        </>
      }
      action={action}
      fields={{ [ACC3_SETTINGS_FIELD.entityId]: e.entityId }}
      initialState={initialState}
      saveLabel="Save automatic bills"
    >
      {(uid) => (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <OnOffRadios uid={uid} name={ACC3_SETTINGS_FIELD.drafts} legend={`Automatic drafts for ${e.entityName}`} current={e.autoBillsEnabled!} onLabel="On — the CRM makes and checks drafts" offLabel="Off — Accounts make drafts by hand" />
          <OnOffRadios
            uid={uid}
            name={ACC3_SETTINGS_FIELD.release}
            legend={`Automatic release for ${e.entityName}`}
            current={e.autoBillReleaseEnabled!}
            onLabel="On — release drafts that pass every check"
            offLabel="Off — ready drafts wait for Accounts"
            hint="Has effect only when customer documents and automatic drafts are on."
          />
        </div>
      )}
    </SettingForm>
  );
}

function WriteOffForm({ e, action, initialState }: { e: Acc3AccountsSettingsEntity; action: DecisionAction; initialState?: DeskResult }) {
  if (e.writeOffEnabled === null) {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="m-0 text-base font-semibold text-ink">Write-offs of small balances</h3>
        <NotKnown />
      </div>
    );
  }
  return (
    <SettingForm
      title="Write-offs of small balances"
      now={
        <>
          <NowBadge label="Write-offs" value={e.writeOffEnabled} />
          <StatusBadge tone="neutral" wrap>
            Limit per Deal: {e.writeOffLimitPaise ? inr(e.writeOffLimitPaise) : 'Not known'}
          </StatusBadge>
        </>
      }
      explain={<p className="m-0">When on, Accounts can propose writing off the whole remaining balance of a Deal after the trip (a small amount still owed, or a small overpayment kept), up to the limit. The branch Manager approves, and can undo it with a reason. No money moves.</p>}
      action={action}
      fields={{ [ACC3_SETTINGS_FIELD.entityId]: e.entityId }}
      initialState={initialState}
      saveLabel="Save write-offs"
    >
      {(uid) => (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <OnOffRadios uid={uid} name={ACC3_SETTINGS_FIELD.enabled} legend={`Write-offs for ${e.entityName}`} current={e.writeOffEnabled!} onLabel="On" offLabel="Off" />
          <Field htmlFor={`${uid}-limit`} label="Limit per Deal (₹)" hint="₹1 to ₹5,000. A write-off is always the whole remaining balance.">
            <MoneyInput id={`${uid}-limit`} name={ACC3_SETTINGS_FIELD.limitRupees} required defaultValue={rupeesInputText(e.writeOffLimitPaise) ?? '5000'} aria-describedby={fieldDescribedBy(`${uid}-limit`, { hint: true })} className="max-w-48" />
          </Field>
        </div>
      )}
    </SettingForm>
  );
}

function TallyXmlForm({ e, action, initialState }: { e: Acc3AccountsSettingsEntity; action: DecisionAction; initialState?: DeskResult }) {
  if (e.tallyXmlEnabled === null) {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="m-0 text-base font-semibold text-ink">Tally import file</h3>
        <NotKnown />
      </div>
    );
  }
  return (
    <SettingForm
      title="Tally import file"
      now={
        <>
          <NowBadge label="Tally file" value={e.tallyXmlEnabled} />
          <StatusBadge tone="neutral" wrap>
            Tally company: {e.tallyCompanyName ?? 'Not set'}
          </StatusBadge>
        </>
      }
      explain={<p className="m-0">When on, Accounts can make a TallyPrime import file of money entries on the Tally page and upload Tally’s voucher list back to match them. The CRM never connects to Tally. Turning it on needs the company name exactly as it is in Tally.</p>}
      action={action}
      fields={{ [ACC3_SETTINGS_FIELD.entityId]: e.entityId }}
      initialState={initialState}
      saveLabel="Save Tally file"
    >
      {(uid) => (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <OnOffRadios uid={uid} name={ACC3_SETTINGS_FIELD.enabled} legend={`Tally import file for ${e.entityName}`} current={e.tallyXmlEnabled!} onLabel="On" offLabel="Off" />
          <Field htmlFor={`${uid}-company`} label="Company name in Tally" hint="Needed to switch on. Up to 100 characters, exactly as Tally shows it.">
            <Input id={`${uid}-company`} name={ACC3_SETTINGS_FIELD.companyName} maxLength={100} defaultValue={e.tallyCompanyName ?? ''} autoComplete="off" spellCheck={false} aria-describedby={fieldDescribedBy(`${uid}-company`, { hint: true })} />
          </Field>
        </div>
      )}
    </SettingForm>
  );
}
