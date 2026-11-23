'use client';

import { useId, useState } from 'react';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChoiceGroup, Radio } from '@/components/ui/choice';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { MoneyInput } from '@/components/ui/money-input';
import { Notice } from '@/components/ui/notice';
import { releaseEffect, rupeesInputText } from '@/views/customer-documents/acc3-pure';
import { ActionSwitchRow, NOT_READ_TEXT, onOffState, type ActionRowPreview, type ExistingSettingsAction } from '@/views/settings/setting-switch-form';
import { inr } from './labels';

/*
 * Settings › Accounts, Accounts phase 3 rows (contract 6.1 B1, B2, 7.2 C2),
 * UX redesign R1 (C6 rows, C7 confirm dialog, owner D9): per company
 * automatic drafts, automatic release (On by default; effective only while
 * customer documents and automatic drafts are on), write-offs with their
 * limit (₹1 to ₹5,000 per Deal) and the Tally import file with the Tally
 * company name. Each row shows the state in words and "Change", which opens
 * one confirm dialog with a required reason (finance-mode switches, lead
 * ruling on Q1). The dialogs post the old fields:
 * entityId, drafts, release, reason (automatic bills); entityId, enabled,
 * limitRupees, reason (write-offs); entityId, enabled, companyName, reason
 * (Tally file). A refusal keeps every typed value and marks the field it
 * names. "Not known" never reads as Off. Finance policy managers only (the
 * route decides).
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
  customerDocumentsEnabled?: boolean | null;
  autoBillsEnabled?: boolean | null;
  /** Default On (owner, 12 Nov 2026). */
  autoBillReleaseEnabled?: boolean | null;
  writeOffEnabled?: boolean | null;
  /** Whole paise, decimal string. */
  writeOffLimitPaise?: string | null;
  tallyXmlEnabled?: boolean | null;
  tallyCompanyName?: string | null;
}

export interface Acc3AccountsSettingsActions {
  /** B1 admin_set_auto_bills(entity, drafts, release, reason). */
  setAutoBills: ExistingSettingsAction;
  /** B2 admin_set_write_off(entity, enabled, limit, reason). */
  setWriteOff: ExistingSettingsAction;
  /** C2 admin_set_tally_xml(entity, enabled, companyName, reason). */
  setTallyXml: ExistingSettingsAction;
}

export type Acc3RowKey = 'autoDrafts' | 'autoRelease' | 'writeOff' | 'tallyXml';

const bool = (v: boolean | null | undefined) => (v ? 'true' : 'false');

/** The phase 3 rows of one company (list items; the caller gives the list). */
export function Acc3SettingRows({ e, actions, initial }: { e: Acc3AccountsSettingsEntity; actions: Partial<Acc3AccountsSettingsActions>; initial?: Partial<Record<Acc3RowKey, ActionRowPreview>> }) {
  const base = `acc-${e.entityId}`;
  const effect = releaseEffect({ documents: e.customerDocumentsEnabled ?? null, drafts: e.autoBillsEnabled ?? null, release: e.autoBillReleaseEnabled ?? null });
  const docsLine =
    e.customerDocumentsEnabled === true ? null : (
      <p className="m-0 mt-1">Customer documents are {e.customerDocumentsEnabled === false ? 'off' : 'not known'} for this company, so nothing is drafted or released until they are switched on.</p>
    );
  const bothKnown = e.autoBillsEnabled !== null && e.autoBillReleaseEnabled !== null;
  return (
    <>
      {actions.setAutoBills && e.autoBillsEnabled !== undefined ? (
        <ActionSwitchRow
          id={`${base}-auto-drafts`}
          rowKey="auto_drafts"
          name="Automatic drafts"
      changeName={`Automatic drafts for ${e.entityName}`}
          effect="The CRM makes and checks bill drafts: Advance Invoice when a payment is verified, Invoice when Accounts approve the booking, Credit Note when a refund is settled."
          more={
            <>
              <p className="m-0">A draft that fails a check is held for Accounts with the reason (Accounts › Bills to check). Off: Accounts make drafts by hand.</p>
              {docsLine}
            </>
          }
          state={onOffState(e.autoBillsEnabled)}
          readOnlyReason={bothKnown ? undefined : NOT_READ_TEXT}
          change={{
            confirmLabel: `Turn automatic drafts for ${e.entityName} ${e.autoBillsEnabled ? 'off' : 'on'}`,
            effect: e.autoBillsEnabled ? 'Accounts make bill drafts by hand again. Drafts already made stay.' : 'The CRM makes and checks bill drafts. Released bills are never sent to customers.',
            affected: 'Accounts of this company.',
            tone: e.autoBillsEnabled ? 'danger' : 'primary',
            action: actions.setAutoBills,
            hiddenFields: { [ACC3_SETTINGS_FIELD.entityId]: e.entityId, [ACC3_SETTINGS_FIELD.drafts]: bool(!e.autoBillsEnabled), [ACC3_SETTINGS_FIELD.release]: bool(e.autoBillReleaseEnabled) },
            reasonRule: 'required',
          }}
          preview={initial?.autoDrafts}
        />
      ) : null}
      {actions.setAutoBills && e.autoBillReleaseEnabled !== undefined ? (
        <ActionSwitchRow
          id={`${base}-auto-release`}
          rowKey="auto_release"
          name="Automatic release"
      changeName={`Automatic release for ${e.entityName}`}
          effect={effect === 'no_effect' ? 'Release has no effect yet: it acts only while customer documents and automatic drafts are both on.' : 'Drafts that pass every check get their number without a click. Released bills are never sent to customers.'}
          more={
            <>
              <p className="m-0">On by default. It has effect only when customer documents and automatic drafts are both on. Off: ready drafts wait for Accounts.</p>
              {docsLine}
            </>
          }
          state={onOffState(e.autoBillReleaseEnabled)}
          readOnlyReason={bothKnown ? undefined : NOT_READ_TEXT}
          change={{
            confirmLabel: `Turn automatic release for ${e.entityName} ${e.autoBillReleaseEnabled ? 'off' : 'on'}`,
            effect: e.autoBillReleaseEnabled ? 'Ready drafts wait for Accounts to release them.' : 'Drafts that pass every check are released without a click (only while customer documents and automatic drafts are on).',
            affected: 'Accounts of this company.',
            tone: e.autoBillReleaseEnabled ? 'danger' : 'primary',
            action: actions.setAutoBills,
            hiddenFields: { [ACC3_SETTINGS_FIELD.entityId]: e.entityId, [ACC3_SETTINGS_FIELD.drafts]: bool(e.autoBillsEnabled), [ACC3_SETTINGS_FIELD.release]: bool(!e.autoBillReleaseEnabled) },
            reasonRule: 'required',
          }}
          preview={initial?.autoRelease}
        />
      ) : null}
      {actions.setWriteOff && e.writeOffEnabled !== undefined ? <WriteOffRow e={e} action={actions.setWriteOff} id={`${base}-write-off`} preview={initial?.writeOff} /> : null}
      {actions.setTallyXml && e.tallyXmlEnabled !== undefined ? <TallyXmlRow e={e} action={actions.setTallyXml} id={`${base}-tally-xml`} preview={initial?.tallyXml} /> : null}
    </>
  );
}

function OnOffChoice({ uid, legend, current, onLabel, offLabel }: { uid: string; legend: string; current: boolean; onLabel: string; offLabel: string }) {
  return (
    <ChoiceGroup id={`${uid}-enabled`} legend={legend}>
      <div className="flex flex-col gap-2">
        <Radio id={`${uid}-enabled-on`} name={ACC3_SETTINGS_FIELD.enabled} value="true" defaultChecked={current} label={onLabel} />
        <Radio id={`${uid}-enabled-off`} name={ACC3_SETTINGS_FIELD.enabled} value="false" defaultChecked={!current} label={offLabel} />
      </div>
    </ChoiceGroup>
  );
}

function WriteOffRow({ e, action, id, preview }: { e: Acc3AccountsSettingsEntity; action: ExistingSettingsAction; id: string; preview?: ActionRowPreview }) {
  const uid = useId();
  const limitRefused = (f: string | null) => f === 'limitPaise' || f === ACC3_SETTINGS_FIELD.limitRupees;
  return (
    <ActionSwitchRow
      id={id}
      rowKey="write_off"
      name="Write-offs of small balances"
      changeName={`Write-offs of small balances for ${e.entityName}`}
      effect={`Accounts propose writing off a small remaining balance after the trip; the branch Manager approves. Limit per Deal: ${e.writeOffLimitPaise ? inr(e.writeOffLimitPaise) : 'Not known'}.`}
      more={<p className="m-0">A write-off is always the whole remaining balance (a small amount still owed, or a small overpayment kept). The Manager can undo it with a reason. No money moves.</p>}
      state={onOffState(e.writeOffEnabled)}
      change={{
        confirmLabel: 'Save write-offs',
        effect: 'Sets whether Accounts can propose write-offs, and the limit per Deal.',
        affected: 'Accounts and branch Managers of this company.',
        action,
        hiddenFields: { [ACC3_SETTINGS_FIELD.entityId]: e.entityId },
        reasonRule: 'required',
        fields: (refused) => (
          <>
            <OnOffChoice uid={uid} legend={`Write-offs for ${e.entityName}`} current={!!e.writeOffEnabled} onLabel="On" offLabel="Off" />
            <Field htmlFor={`${uid}-limit`} label="Limit per Deal (₹)" hint="₹1 to ₹5,000. A write-off is always the whole remaining balance." error={limitRefused(refused) ? 'Type a limit from ₹1 to ₹5,000.' : null}>
              <MoneyInput
                id={`${uid}-limit`}
                name={ACC3_SETTINGS_FIELD.limitRupees}
                required
                defaultValue={rupeesInputText(e.writeOffLimitPaise) ?? '5000'}
                invalid={limitRefused(refused)}
                aria-describedby={fieldDescribedBy(`${uid}-limit`, { hint: true, error: limitRefused(refused) })}
                className="max-w-48"
              />
            </Field>
          </>
        ),
      }}
      preview={preview}
    />
  );
}

function TallyXmlRow({ e, action, id, preview }: { e: Acc3AccountsSettingsEntity; action: ExistingSettingsAction; id: string; preview?: ActionRowPreview }) {
  const uid = useId();
  const [name, setName] = useState(e.tallyCompanyName ?? '');
  const nameRefused = (f: string | null) => f === ACC3_SETTINGS_FIELD.companyName;
  return (
    <ActionSwitchRow
      id={id}
      rowKey="tally_xml"
      name="Tally import file"
      changeName={`Tally import file for ${e.entityName}`}
      effect={`Accounts make a TallyPrime import file of money entries and match Tally’s voucher list back. Tally company: ${e.tallyCompanyName ?? 'Not set'}.`}
      more={<p className="m-0">The CRM never connects to Tally. Turning it on needs the company name exactly as it is in Tally.</p>}
      state={onOffState(e.tallyXmlEnabled)}
      change={{
        confirmLabel: 'Save Tally file',
        effect: 'Sets whether Accounts can make the Tally import file, and the company name in Tally.',
        affected: 'Accounts of this company.',
        action,
        hiddenFields: { [ACC3_SETTINGS_FIELD.entityId]: e.entityId },
        reasonRule: 'required',
        fields: (refused) => (
          <>
            <OnOffChoice uid={uid} legend={`Tally import file for ${e.entityName}`} current={!!e.tallyXmlEnabled} onLabel="On" offLabel="Off" />
            <Field
              htmlFor={`${uid}-company`}
              label="Company name in Tally"
              hint="Needed to switch on. Up to 100 characters, exactly as Tally shows it."
              error={nameRefused(refused) ? 'Type the Tally company name exactly as it appears in TallyPrime (1 to 100 characters).' : null}
            >
              <Input
                id={`${uid}-company`}
                name={ACC3_SETTINGS_FIELD.companyName}
                maxLength={100}
                value={name}
                onChange={(ev) => setName(ev.target.value)}
                autoComplete="off"
                spellCheck={false}
                invalid={nameRefused(refused)}
                aria-describedby={fieldDescribedBy(`${uid}-company`, { hint: true, error: nameRefused(refused) })}
              />
            </Field>
          </>
        ),
      }}
      preview={preview}
    />
  );
}

/** The phase 3 rows on their own, one card per company (the acc3-bills-settings gallery states). */
export function Acc3AccountsSettings({
  entities,
  actions,
  initial,
}: {
  entities: Acc3AccountsSettingsEntity[];
  actions: Acc3AccountsSettingsActions;
  /** Preview gallery: a row's dialog open with a reason or a reply. */
  initial?: Partial<Record<Acc3RowKey, ActionRowPreview>>;
}) {
  return (
    <div className="flex flex-col gap-5 font-sans text-base text-copy">
      {entities.map((e) => (
        <Card key={e.entityId}>
          <section aria-labelledby={`acc3-set-${e.entityId}`}>
            <CardHeader>
              <div>
                <CardTitle id={`acc3-set-${e.entityId}`}>{e.entityName}</CardTitle>
                <CardDescription>Each switch stays off until the owner approves it. Bills are never sent to customers from here.</CardDescription>
              </div>
            </CardHeader>
            {e.autoBillsEnabled === null && e.writeOffEnabled === null && e.tallyXmlEnabled === null ? (
              <div className="border-t border-line px-4.5 py-3.5">
                <Notice tone="warning" role="status">
                  <p>{NOT_READ_TEXT}</p>
                </Notice>
              </div>
            ) : null}
            <ul className="m-0 list-none border-t border-line p-0" aria-label={`Automatic bills, write-offs and the Tally file for ${e.entityName}`}>
              <Acc3SettingRows e={e} actions={actions} initial={initial} />
            </ul>
          </section>
        </Card>
      ))}
    </div>
  );
}
