'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { Field, fieldDescribedBy } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { Select } from '@/components/ui/select';
import { StateBlock } from '@/components/ui/state-block';
import { Status } from '@/components/ui/status';
import { switchRowDescribedBy } from '@/components/ui/switch-row';
import { Tabs } from '@/components/ui/tabs';
import { ActionSwitchRow, ExistingActionChange, onOffState, type ActionRowPreview, type ExistingSettingsAction } from '@/views/settings/setting-switch-form';
import { TALLY_MAPPING_PATH, type accountsSettingsTabs } from '@/views/tally-mapping/labels';
import { Acc3SettingRows, type Acc3AccountsSettingsActions, type Acc3RowKey } from './acc3-settings';

/*
 * Settings › Accounts, UX redesign R1 (C6 switch rows, C7 confirm dialog,
 * owner D9 and D12; audit S4, S8, S12). Per company one card with eight
 * rows: Tally export, Tally exception owner, customer documents, refunds,
 * automatic drafts, automatic release, write-offs and the Tally import file.
 * Each row shows the value in words and "Change", which opens one confirm
 * dialog. These are finance-mode switches (lead ruling on Q1), so the reason
 * stays required (10 to 500 characters); only the exception owner, a person
 * and not a switch, takes the optional reason ("No reason given" is saved).
 * The dialog posts the same fields as the old forms. "Not known" never reads as Off and offers no
 * change. The staff notices switch moved to Features (D12).
 *
 * Tally mapping is a sub-tab (its own address, kept). A Super Admin who also
 * holds Accounts in a company sees that company read only, with the reason:
 * the database lets only a Super Admin without Accounts change these.
 */

export const SETTINGS_FIELD = { entityId: 'entityId', enabled: 'enabled', userId: 'userId', reason: 'reason' } as const;


export interface AccountsCompanySettings {
  entityId: string;
  entityName: string;
  tallyExportEnabled: boolean | null;
  /** Phase 2 (B9). Omitted or null = not known: no change. */
  customerDocumentsEnabled?: boolean | null;
  /** Phase 2 (C12). Omitted or null = not known: no change. */
  refundsEnabled?: boolean | null;
  exceptionOwnerUserId: string | null;
  /** Active Accounts people of the company without Purchase (the only valid owners). */
  accountsPeople: Array<{ userId: string; name: string }>;
  /** Phase 3 (B1, B2, C2). Omitted = the row is not shown; null = not known. */
  autoBillsEnabled?: boolean | null;
  autoBillReleaseEnabled?: boolean | null;
  writeOffEnabled?: boolean | null;
  /** Whole paise, decimal string. */
  writeOffLimitPaise?: string | null;
  tallyXmlEnabled?: boolean | null;
  tallyCompanyName?: string | null;
}

export interface AccountsSettingsViewModel {
  entities: AccountsCompanySettings[];
  /** Companies where this Super Admin also holds Accounts: shown read only with the reason (S12). */
  readOnlyEntities?: Array<{ entityId: string; entityName: string }>;
  /** Settings › Features, where the staff notices switch is now (D12); null hides the line. */
  featuresHref?: string | null;
  /** Kept for older callers; the notices switch is on Features now. */
  noticesEnabled?: boolean | null;
  canSetNotices?: boolean;
}

export interface AccountsSettingsActions extends Partial<Acc3AccountsSettingsActions> {
  setTallyExport: ExistingSettingsAction;
  setExceptionOwner: ExistingSettingsAction;
  /** Phase 2 B9. Omitted: the row is not shown. */
  setCustomerDocuments?: ExistingSettingsAction;
  /** Phase 2 C12. Omitted: the row is not shown. */
  setRefunds?: ExistingSettingsAction;
  /** Kept for older callers; not shown here (moved to Features). */
  setNotices?: ExistingSettingsAction;
}

export type AccountsRowKey = 'tallyExport' | 'owner' | 'documents' | 'refunds' | Acc3RowKey;

export function AccountsSettingsTabs({ tabs }: { tabs: ReturnType<typeof accountsSettingsTabs> }) {
  if (tabs.length < 2) return null;
  return <Tabs label="Accounts settings" items={tabs} variant="pill" />;
}

const linkClass = cn('rounded-chip font-semibold text-brand-strong underline decoration-1 underline-offset-4 hover:text-brand-deep hover:decoration-2', focusRing);

export function AccountsSettingsView({
  model,
  actions,
  tabs = [],
  initial,
}: {
  model: AccountsSettingsViewModel;
  actions: AccountsSettingsActions;
  /** accountsSettingsTabs(...) from the page. */
  tabs?: ReturnType<typeof accountsSettingsTabs>;
  /** Preview gallery only: one row's dialog open, by row. */
  initial?: Partial<Record<AccountsRowKey, ActionRowPreview>>;
}) {
  const readOnly = model.readOnlyEntities ?? [];
  return (
    <div className="flex flex-col gap-5 font-sans text-base text-copy">
      <AccountsSettingsTabs tabs={tabs} />
      {model.entities.map((e) => (
        <Card key={e.entityId}>
          <section aria-labelledby={`set-acc-${e.entityId}`}>
            <CardHeader>
              <CardTitle id={`set-acc-${e.entityId}`}>{e.entityName}</CardTitle>
            </CardHeader>
            <ul className="m-0 list-none border-t border-line p-0" aria-label={`Accounts settings for ${e.entityName}`}>
              <ActionSwitchRow
                id={`acc-${e.entityId}-tally-export`}
                rowKey="tally_export"
                name="Tally export"
                changeName={`Tally export for ${e.entityName}`}
                effect="Accounts can create CSV exports on the Tally page. Exporting never marks anything matched."
                more={
                  <p className="m-0">
                    The ledger names each export line uses are on{' '}
                    <Link href={`${TALLY_MAPPING_PATH}?entity=${e.entityId}`} className={linkClass}>
                      Tally mapping<span className="sr-only"> for {e.entityName}</span>
                    </Link>
                    .
                  </p>
                }
                state={onOffState(e.tallyExportEnabled)}
                change={switchChange(`Tally export for ${e.entityName}`, e.tallyExportEnabled, actions.setTallyExport, e.entityId, {
                  on: 'Accounts can create CSV exports on the Tally page.',
                  off: 'Accounts can no longer create CSV exports. Exports already made stay.',
                })}
                preview={initial?.tallyExport}
              />
              <OwnerRow entity={e} action={actions.setExceptionOwner} preview={initial?.owner} />
              {actions.setCustomerDocuments ? (
                <ActionSwitchRow
                  id={`acc-${e.entityId}-documents`}
                  rowKey="customer_documents"
                  name="Customer documents"
                  changeName={`Customer documents for ${e.entityName}`}
                  effect="Accounts draft and release Advance Invoices, Invoices and Credit Notes; Sales owners and Managers download them."
                  more={<p className="m-0">Keep it off until the company’s CA has confirmed the document names and numbering.</p>}
                  state={onOffState(e.customerDocumentsEnabled)}
                  change={switchChange(`Customer documents for ${e.entityName}`, e.customerDocumentsEnabled ?? null, actions.setCustomerDocuments, e.entityId, {
                    on: 'Accounts can draft and release Advance Invoices, Invoices and Credit Notes. Keep it off until the CA has confirmed the names and numbering.',
                    off: 'No new customer documents are drafted or released. Documents already released stay.',
                  })}
                  preview={initial?.documents}
                />
              ) : null}
              {actions.setRefunds ? (
                <ActionSwitchRow
                  id={`acc-${e.entityId}-refunds`}
                  rowKey="refunds"
                  name="Refunds"
                  changeName={`Refunds for ${e.entityName}`}
                  effect="Sales owners ask for customer refunds, a branch Manager approves the amount, Accounts pay out with proof."
                  more={<p className="m-0">Supplier refunds received can be recorded too.</p>}
                  state={onOffState(e.refundsEnabled)}
                  change={switchChange(`Refunds for ${e.entityName}`, e.refundsEnabled ?? null, actions.setRefunds, e.entityId, {
                    on: 'Sales owners can ask for customer refunds; a branch Manager approves the exact amount and Accounts pay out with proof.',
                    off: 'No new refund requests. Refunds already started can still be finished.',
                  })}
                  preview={initial?.refunds}
                />
              ) : null}
              <Acc3SettingRows e={e} actions={actions} initial={initial} />
            </ul>
          </section>
        </Card>
      ))}
      {readOnly.map((e) => (
        <Card key={e.entityId}>
          <section aria-labelledby={`set-acc-ro-${e.entityId}`}>
            <CardHeader>
              <CardTitle id={`set-acc-ro-${e.entityId}`}>{e.entityName}</CardTitle>
            </CardHeader>
            <div className="border-t border-line px-4.5 py-3.5">
              <StateBlock kind="readOnly" text={`You also work in Accounts at ${e.entityName}, so another Super Admin changes these settings.`} who="Nobody sets the rules for their own work." />
            </div>
          </section>
        </Card>
      ))}
      {model.entities.length === 0 && readOnly.length === 0 ? (
        <Notice tone="info">
          <p>No company here uses the Accounts tools yet, so there is nothing to set.</p>
        </Notice>
      ) : null}
      {model.featuresHref ? (
        <p className="m-0 text-sm text-copy">
          Staff notices (the bell) are switched on Features now.{' '}
          <Link href={model.featuresHref} className={linkClass}>
            Open Features
          </Link>
        </p>
      ) : null}
    </div>
  );
}

/** The change of a plain On/Off Accounts switch: posts entityId, enabled and reason (the old fields). */
function switchChange(what: string, current: boolean | null, action: ExistingSettingsAction, entityId: string, words: { on: string; off: string }) {
  const target = current ? 'off' : 'on';
  return {
    confirmLabel: `Turn ${what} ${target}`,
    effect: target === 'on' ? words.on : words.off,
    affected: 'Accounts of this company.',
    tone: target === 'off' ? ('danger' as const) : ('primary' as const),
    action,
    hiddenFields: { [SETTINGS_FIELD.entityId]: entityId, [SETTINGS_FIELD.enabled]: String(target === 'on') },
    // Lead ruling on Q1: the Accounts switches are finance-mode switches; the reason stays required.
    reasonRule: 'required' as const,
  };
}

/** The Tally exception owner: a person, not On/Off, so the row shows the name in words. */
function OwnerRow({ entity, action, preview }: { entity: AccountsCompanySettings; action: ExistingSettingsAction; preview?: ActionRowPreview }) {
  const id = `acc-${entity.entityId}-owner`;
  const uid = useId();
  const current = entity.accountsPeople.find((p) => p.userId === entity.exceptionOwnerUserId);
  const [who, setWho] = useState(entity.exceptionOwnerUserId ?? '');
  return (
    <li className="m-0 border-b border-line last:border-b-0" data-slot="setting-row" data-key="exception_owner">
      <div id={`${id}-row`} className="flex flex-col gap-2.5 px-4.5 py-3.5 font-sans sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0 flex-1">
          <p id={`${id}-name`} className="m-0 font-semibold text-ink">
            Tally exception owner
          </p>
          <p className="m-0 text-sm text-copy">Gets the Tally exception notices and runs the daily check. Anyone in Accounts may still match and raise exceptions.</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3 sm:justify-end">
          <span id={`${id}-state`}>
            {current ? <Status kind="on" label={current.name} srPrefix="Exception owner: " /> : <Status kind="off" label="Nobody: every Accounts person is told" srPrefix="Exception owner: " />}
          </span>
          <ExistingActionChange
            title={`Tally exception owner for ${entity.entityName}`}
            confirmLabel="Save exception owner"
            effect="The person chosen gets the Tally exception notices and runs the daily check."
            affected="Accounts of this company."
            action={action}
            hiddenFields={{ [SETTINGS_FIELD.entityId]: entity.entityId }}
            reasonRule="optional"
            describedBy={switchRowDescribedBy(id)}
            initialOpen={preview?.open}
            initialReason={preview?.reason}
            initialResult={preview?.result}
            fields={(refused) =>
              entity.accountsPeople.length === 0 ? (
                <Notice tone="info">
                  <p>No active Accounts person without a Purchase role in this company. Saving keeps “Nobody”.</p>
                  <input type="hidden" name={SETTINGS_FIELD.userId} value="" />
                </Notice>
              ) : (
                <Field htmlFor={`${uid}-who`} label="Exception owner" error={refused === SETTINGS_FIELD.userId ? 'Choose an active Accounts person of this company.' : null}>
                  <Select
                    id={`${uid}-who`}
                    name={SETTINGS_FIELD.userId}
                    value={who}
                    onChange={(ev) => setWho(ev.target.value)}
                    invalid={refused === SETTINGS_FIELD.userId}
                    aria-describedby={fieldDescribedBy(`${uid}-who`, { error: refused === SETTINGS_FIELD.userId })}
                  >
                    <option value="">Nobody (everyone in Accounts is told)</option>
                    {entity.accountsPeople.map((p) => (
                      <option key={p.userId} value={p.userId}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )
            }
          />
        </div>
      </div>
    </li>
  );
}
