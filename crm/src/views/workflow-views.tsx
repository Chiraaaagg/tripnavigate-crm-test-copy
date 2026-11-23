import { CircleCheck, Info, Link2, Lock, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { StatusBadge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import type { ConfirmResult } from '@/components/ui/confirm-change';
import { Notice } from '@/components/ui/notice';
import { SwitchRow, switchRowDescribedBy } from '@/components/ui/switch-row';
import { ID_PROOF_COPY_TEXT, type IdProofCopyAlertsView } from '@/modules/fulfilment/contracts';
import type { FeaturesPageModel } from '@/modules/settings/server/queries';
import { SETTINGS_TEXT } from '@/modules/settings/text';
import { formatIst } from './deal-labels';
import { CopyRetryForm } from './b11/id-proof-slot';
import type { B11Action } from './b11/shapes';
import { SettingsSectionHeading } from './settings/settings-frame';
import type { SettingKey } from '@/modules/settings/contracts';
import { SettingsSectionView, type SettingRowPreview, type SettingSwitchActions } from './settings/setting-rows';
import { ExistingActionChange, type ExistingSettingsAction } from './settings/setting-switch-form';

/*
 * Settings · Features, UX redesign R1 (C6 switch rows, C7 confirm dialog,
 * owner D9 and D12). One card of switches for every branch: the five
 * workflow switches and the staff notices switch (the bell, moved here from
 * Settings › Accounts, D12). Each row shows the state in words with an icon
 * and "Change", which opens one confirm dialog with an optional reason
 * ("No reason given" is saved when it is left empty; change, person and time
 * stay recorded). Every key is always shown (featureRows is exhaustive), so a
 * switch the database did not return is Not known with its Change disabled,
 * never Off. A second card, "Big switches", shows real bookings and supplier
 * confirmation read only: the CRM team changes them with the owner's
 * approval. One closing line links Money rules, Bitrix connection and
 * Customer messages.
 */

export interface FeaturesNoticesModel {
  /** null = could not be read. */
  enabled: boolean | null;
  /** setNoticesEnabledAction (fields enabled, reason). */
  action: ExistingSettingsAction;
}

const NOTICES_ID = 'setting-staff_notices';
const linkClass = cn('rounded-chip font-semibold text-brand-strong underline decoration-1 underline-offset-4 hover:text-brand-deep hover:decoration-2', focusRing);

/** Staff notices (the bell) as a switch row (Super Admin only; D12). */
export function NoticesSwitchRow({ notices, preview }: { notices: FeaturesNoticesModel; /** Preview gallery only. */ preview?: { open?: boolean; reason?: string; result?: ConfirmResult | null } }) {
  const state = notices.enabled === null ? 'unknown' : notices.enabled ? 'on' : 'off';
  const target = notices.enabled ? 'off' : 'on';
  return (
    <li className="m-0 border-b border-line last:border-b-0" data-slot="setting-row" data-key="staff_notices" data-state={state}>
      <SwitchRow
        id={NOTICES_ID}
        className="border-b-0"
        name={NOTICES_TITLE}
        effect="The bell and its notices for every staff member. Work lists and Home counts never depend on it."
        more={<p className="m-0">Affects: every staff member. While off, nothing is written and the bell is hidden for everyone.</p>}
        state={state}
        disabledReason={notices.enabled === null ? SETTINGS_TEXT.unknownOne : undefined}
        change={
          notices.enabled === null ? null : (
            <ExistingActionChange
              title={NOTICES_TITLE}
              confirmLabel={`Turn ${NOTICES_TITLE} ${target}`}
              effect={target === 'off' ? 'Nothing more is written and the bell is hidden for everyone. Work lists and Home counts stay as they are.' : 'Staff see the bell again and get a notice when work arrives for them.'}
              affected="Every staff member."
              tone={target === 'off' ? 'danger' : 'primary'}
              action={notices.action}
              hiddenFields={{ enabled: String(target === 'on') }}
              reasonRule="optional"
              okMessage={target === 'on' ? 'Staff notices are switched on.' : 'Staff notices are switched off.'}
              describedBy={switchRowDescribedBy(NOTICES_ID)}
              initialOpen={preview?.open}
              initialReason={preview?.reason}
              initialResult={preview?.result}
            />
          )
        }
      />
    </li>
  );
}

const NOTICES_TITLE = 'Staff notices (the bell)';

export function FeaturesSettingsView({
  model,
  actions,
  bitrixHref,
  customerMessagesHref = null,
  moneyRulesHref = null,
  notices = null,
  preview,
  noticesPreview,
}: {
  model: FeaturesPageModel;
  actions: SettingSwitchActions;
  /** Settings · Bitrix connection, when this person may open it (D3 link); null hides the link. */
  bitrixHref: string | null;
  /** Settings · Customer messages (Super Admin switches); null hides the link. */
  customerMessagesHref?: string | null;
  /** Settings · Money rules (payment modes), when this person may open it; null hides the link. */
  moneyRulesHref?: string | null;
  /** The staff notices switch (Super Admin only, D12); null = not shown. */
  notices?: FeaturesNoticesModel | null;
  /** Preview gallery only: one row's dialog open. */
  preview?: { key: SettingKey } & SettingRowPreview;
  /** Preview gallery only: the staff notices dialog open. */
  noticesPreview?: { open?: boolean; reason?: string; result?: ConfirmResult | null };
}) {
  const links = [
    moneyRulesHref ? { href: moneyRulesHref, text: 'Open Money rules', what: 'payment modes' } : null,
    bitrixHref ? { href: bitrixHref, text: 'Open Bitrix connection', what: 'the Bitrix switches, ID-proof copies and “Bring in deals only when won”' } : null,
    customerMessagesHref ? { href: customerMessagesHref, text: 'Open Customer messages', what: 'the nine booking messages to customers' } : null,
  ].filter((l): l is { href: string; text: string; what: string } => l !== null);
  return (
    <>
      <SettingsSectionHeading id="features-heading">Features</SettingsSectionHeading>
      <SettingsSectionView
        id="feature-switches"
        title="Switches for every branch"
        section={model.features}
        actions={actions}
        preview={preview}
        extraRows={notices ? <NoticesSwitchRow notices={notices} preview={noticesPreview} /> : undefined}
      />
      <SettingsSectionView id="feature-read-only" title="Big switches" description="Set by the CRM team with the owner’s approval. Shown here so you can see them; they cannot be changed on this page." section={model.live} />
      {links.length > 0 ? (
        <p className="m-0 flex flex-wrap items-start gap-x-2 gap-y-1 text-sm text-copy" data-slot="features-elsewhere">
          <Link2 aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-faint" />
          <span className="min-w-0 flex-1">
            Elsewhere:{' '}
            {links.map((l, i) => (
              <span key={l.href}>
                {l.what} (
                <Link href={l.href} className={linkClass}>
                  {l.text}
                </Link>
                ){i < links.length - 1 ? '; ' : '.'}
              </span>
            ))}
          </span>
        </p>
      ) : null}
      {/* Echo-B L9: said only to people who can view but not change the switches (never under a Super Admin's Change buttons). */}
      {!model.features.canSwitch && model.features.rows.length > 0 && !model.features.sectionText ? (
        <p className="m-0 flex gap-2 text-sm text-quiet">
          <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-faint" />
          <span>You can view these switches. Only a Super Admin can change them.</span>
        </p>
      ) : null}
    </>
  );
}

/** N1 (Batch 5): words for someone who manages the Bitrix connection but also works in Purchase (and is not a Super Admin). */
export const FEATURES_PURCHASE_REFUSAL = 'Features is not available to staff who also work in Purchase. Ask a Super Admin to change these switches.';

/**
 * Features refused. `reason`: 'role' (default) for staff with neither role;
 * 'purchase' for a Bitrix-connection manager who also holds Purchase (N1),
 * decided by the route from data already loaded (canOpenFeaturesSettings).
 */
export function WorkflowNoPermissionView({ reason = 'role' }: { reason?: 'role' | 'purchase' }) {
  return (
    <>
      <SettingsSectionHeading>Features</SettingsSectionHeading>
      <Card role="status">
        <div className="flex items-start gap-3 px-4.5 py-4">
          <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-control bg-brand-tint text-brand">
            <Info className="size-4.5" />
          </span>
          <p className="m-0 self-center text-copy">
            {reason === 'purchase' ? FEATURES_PURCHASE_REFUSAL : 'Only a Super Admin or staff who manage the Bitrix connection can open Features.'}
          </p>
        </div>
      </Card>
      <p className="m-0">
        <Link href="/app" className={buttonVariants({ variant: 'secondary' })}>
          Back to Home
        </Link>
      </p>
    </>
  );
}

/** The switch states could not be read at all: Unknown, never Off (DA-255 section line). */
export function WorkflowUnavailableView() {
  return (
    <>
      <SettingsSectionHeading>Features</SettingsSectionHeading>
      <Notice tone="warning" role="status" icon={ShieldAlert}>
        <p>{SETTINGS_TEXT.unknownSection}</p>
      </Notice>
    </>
  );
}

/**
 * DEC-43 Super Admin: the copy of ID proofs to Bitrix. Automatic stops, open
 * first (copying stops on its own when files on a Bitrix Deal went missing;
 * switching copying on again with a reason closes every open stop), and the
 * copies needing a manual check (look at the Bitrix Deal, then Try again: the
 * CRM reads the Deal first). Shown only to the Super Admin (the read is null
 * for everyone else); an unread list is said, never shown as empty.
 */
export function IdProofCopyAlertsCard({ alerts, retryAction }: { alerts: IdProofCopyAlertsView | 'error'; retryAction?: B11Action }) {
  const stops = alerts === 'error' ? [] : alerts.stops;
  const checks = alerts === 'error' ? [] : alerts.manualChecks;
  const open = stops.filter((a) => a.open);
  const closed = stops.filter((a) => !a.open);
  return (
    <Card>
      <section aria-labelledby="copy-alerts-heading">
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id="copy-alerts-heading">{ID_PROOF_COPY_TEXT.alertsTitle}</CardTitle>
            <CardDescription>ID proofs are copied to the Bitrix deal only while the Super Admin has copying switched on.</CardDescription>
          </div>
          {alerts === 'error' ? null : open.length + checks.length > 0 ? (
            <StatusBadge tone="danger" icon={ShieldAlert}>
              {open.length} open · {checks.length} to check
            </StatusBadge>
          ) : (
            <StatusBadge tone="success" icon={CircleCheck}>
              Nothing open
            </StatusBadge>
          )}
        </CardHeader>
        <CardBody className="flex flex-col gap-4">
          {alerts === 'error' ? (
            <p className="m-0 text-copy" role="status">
              The copy alerts could not be read. Nothing is assumed. Reload the page.
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                <h3 className="m-0 text-base font-semibold text-ink">Automatic stops</h3>
                {stops.length === 0 ? (
                  <p className="m-0 text-copy">{ID_PROOF_COPY_TEXT.noAlerts}</p>
                ) : (
                  <>
                    {open.length > 0 ? <p className="m-0 text-copy">{ID_PROOF_COPY_TEXT.alertsHelp} Switching copying on again with a reason closes every open stop.</p> : null}
                    <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Automatic stops">
                      {[...open, ...closed].map((a) => (
                        <li key={a.stopId} className={a.open ? 'm-0 flex flex-col gap-0.5 rounded-control border border-status-danger-line bg-status-danger-tint px-3.5 py-2.5' : 'm-0 flex flex-col gap-0.5 rounded-control border border-line bg-canvas px-3.5 py-2.5'}>
                          <span className="font-semibold text-ink">
                            {a.open ? 'Open' : 'Closed'} · Bitrix deal {a.bitrixDealId}
                          </span>
                          <span className="text-sm text-copy">{a.reasonText}</span>
                          <span className="text-sm text-quiet">
                            Stopped {formatIst(a.openedAt)}
                            {a.acknowledgedAt ? ` · closed ${formatIst(a.acknowledgedAt)} when copying was switched on again` : ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <h3 className="m-0 text-base font-semibold text-ink">{ID_PROOF_COPY_TEXT.manualChecksTitle}</h3>
                {checks.length === 0 ? (
                  <p className="m-0 text-copy">{ID_PROOF_COPY_TEXT.noManualChecks}</p>
                ) : (
                  <>
                    <p className="m-0 text-copy">{ID_PROOF_COPY_TEXT.manualChecksHelp}</p>
                    <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Copies to check by hand">
                      {checks.map((c) => (
                        <li key={c.jobId} className="m-0 flex flex-wrap items-center gap-3 rounded-control border border-status-warning-line bg-status-warning-tint px-3.5 py-2.5">
                          <span className="min-w-48 flex-1">
                            <span className="block font-semibold text-ink">Bitrix deal {c.bitrixDealId}</span>
                            <span className="block text-sm text-copy">
                              {c.statusText}
                              {c.reasonText ? ` ${c.reasonText}` : ''}
                            </span>
                            <span className="block text-sm text-quiet">
                              Last checked {formatIst(c.updatedAt)} · read back {c.readBackAttempts} {c.readBackAttempts === 1 ? 'time' : 'times'}
                            </span>
                          </span>
                          {retryAction ? <CopyRetryForm dealId={null} jobId={c.jobId} fileName={`the file for Bitrix deal ${c.bitrixDealId}`} action={retryAction} /> : null}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </>
          )}
        </CardBody>
      </section>
    </Card>
  );
}
