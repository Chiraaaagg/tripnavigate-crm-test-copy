import { FileText, KeyRound, ListChecks, MessageSquareText, Timer } from 'lucide-react';
import type { ReactNode } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { Select } from '@/components/ui/select';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { BlockedButton, DialogAction, ReasonField } from '@/views/accounts-desk/acc2-kit';
import type { DeskResult } from '@/views/accounts-desk/desk-kit';
import { whenText } from '@/views/accounts-desk/labels';
import { SettingsSectionHeading } from '@/views/settings/settings-frame';
import { CHANNEL_LABEL, LANGUAGE_LABEL, PROVIDER_KEY_LABEL, QUIET_HOURS_TYPES, TEMPLATE_STATUS_WORD, TYPE_LABEL, TYPE_WHEN, queueAgeText, whatsappSwitchBlock } from './labels';
import { CHANNELS, MESSAGE_TYPES, type AdminCustomerMessages, type Channel, type MessageType, type TemplateStatus } from './types';

/*
 * Settings › Customer messages (contract §5.9 A7–A11, §5.10 R-A2, §15
 * screen 4). Super Admin only. 18 switches (nine messages × two channels),
 * each changed with a reason; WhatsApp needs both language texts approved by
 * WhatsApp first. Pilot list mode and its Deals, the message texts in
 * English and Hindi with their WhatsApp approval, the timer, and whether
 * each provider key is saved (names only — values never reach a screen).
 */

export interface MessageSettingsActions {
  /** A7 admin_set_customer_message_switch. */
  setSwitch: DecisionAction;
  /** A8 admin_set_customer_message_pilot. */
  setPilotMode: DecisionAction;
  /** A9 customer_message_pilot_set (remove: by Deal id). */
  setPilotDeal: DecisionAction;
  /** A9 by the exact Deal reference (add: entityId, dealReference, inPilot, reason). */
  addPilotDeal: DecisionAction;
  /** A10 admin_set_whatsapp_template_status. */
  setTemplateStatus: DecisionAction;
  /** A11 admin_set_timer_enabled. */
  setTimer: DecisionAction;
}

export type MessageSettingsPreview = {
  open?: { dialog: 'switch'; type: MessageType; channel: Channel } | { dialog: 'pilot' | 'timer' | 'add-pilot' } | { dialog: 'template'; templateCode: string } | { dialog: 'remove-pilot'; dealId: string };
  state?: DeskResult | null;
  /** Preview gallery: what was typed in the open dialog before the refusal (the dialog keeps it). */
  typed?: { dealReference?: string; reason?: string };
};

const TEMPLATE_STATUSES: TemplateStatus[] = ['not_submitted', 'submitted', 'approved', 'rejected'];

export function CustomerMessageSettingsView({ data, actions, preview }: { data: AdminCustomerMessages | 'error'; actions: Partial<MessageSettingsActions> | null; preview?: MessageSettingsPreview }) {
  if (data === 'error') {
    return (
      <section aria-labelledby="cmsg-settings-heading" className="flex flex-col gap-4">
        <SettingsSectionHeading id="cmsg-settings-heading">Customer messages</SettingsSectionHeading>
        <Notice tone="warning" role="status">
          <p>The customer message settings could not be loaded just now. Nothing was changed. Reload the page.</p>
        </Notice>
      </section>
    );
  }
  const d = data;
  const on = d.switches.filter((s) => s.enabled).length;
  const open = preview?.open;
  const isOpen = (pred: (o: NonNullable<MessageSettingsPreview['open']>) => boolean) => (open ? pred(open) : false);
  const stateFor = (pred: (o: NonNullable<MessageSettingsPreview['open']>) => boolean) => (open && pred(open) ? (preview?.state ?? null) : null);
  const missingKeys = d.providers.filter((p) => !p.configured);

  return (
    <section aria-labelledby="cmsg-settings-heading" className="flex flex-col gap-5">
      <SettingsSectionHeading id="cmsg-settings-heading" description="The nine booking messages the owner approved on 12 November 2026. Each type and channel has its own switch, Off until the owner approves it. Bills, payment-due reminders and marketing never go to customers.">
        Customer messages
      </SettingsSectionHeading>

      <dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Summary label="Switched on" value={`${on} of ${d.switches.length}`} badge={on === 0 ? { tone: 'neutral', text: 'Nothing is sent' } : { tone: 'success', text: 'Sending' }} />
        <Summary label="Who gets messages" value={d.pilotOnly ? `Pilot Deals only (${d.pilot.length})` : 'Every Deal'} badge={d.pilotOnly ? { tone: 'info', text: 'Pilot list on' } : { tone: 'warning', text: 'Pilot list off' }} />
        <Summary label="Timer" value={d.timer.enabled ? 'Running' : 'Switched off'} badge={d.timer.enabled ? { tone: 'success', text: 'On' } : { tone: 'neutral', text: 'Off' }} />
      </dl>

      {missingKeys.length > 0 ? (
        <Notice tone="info" title="Sending is not fully set up yet">
          <p>Messages wait as “Failed — sending is not set up yet” until the owner saves these keys in Vercel: {missingKeys.map((k) => PROVIDER_KEY_LABEL[k.key] ?? k.key).join(', ')}.</p>
        </Notice>
      ) : null}

      <SettingsCard id="cmsg-switches" title="Messages and channels" description="Turning a switch on or off needs a reason. Switch Off: nothing is recorded for that type and channel." icon={<MessageSquareText aria-hidden="true" className="size-4 text-faint" />}>
        <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
          {MESSAGE_TYPES.map((type) => (
            <li key={type} className="m-0 grid grid-cols-1 gap-3 py-4 first:pt-0 last:pb-0 md:grid-cols-3">
              <div className="min-w-0">
                <h4 className="m-0 text-base font-semibold text-ink">{TYPE_LABEL[type]}</h4>
                <p className="m-0 text-sm text-quiet">
                  {TYPE_WHEN[type]}
                  {QUIET_HOURS_TYPES.includes(type) ? ' Held between 9 pm and 8 am.' : ''}
                </p>
              </div>
              {CHANNELS.map((channel) => {
                const sw = d.switches.find((s) => s.type === type && s.channel === channel);
                if (!sw) return <p key={channel} className="m-0 text-sm text-quiet">{CHANNEL_LABEL[channel]}: not set up</p>;
                const block = channel === 'whatsapp' ? whatsappSwitchBlock(type, d.templates, sw.enabled) : null;
                const match = (o: NonNullable<MessageSettingsPreview['open']>) => o.dialog === 'switch' && o.type === type && o.channel === channel;
                const verb = sw.enabled ? 'Turn off' : 'Turn on';
                const name = `${TYPE_LABEL[type]} by ${CHANNEL_LABEL[channel]}`;
                return (
                  <div key={channel} className="flex min-w-0 flex-col items-start gap-2">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm text-quiet">{CHANNEL_LABEL[channel]}</span>
                      <StatusBadge tone={sw.enabled ? 'success' : 'neutral'}>{sw.enabled ? 'On' : 'Off'}</StatusBadge>
                    </span>
                    {block ? (
                      <BlockedButton label={verb} reason={block} ariaLabel={`${verb}: ${name}`} />
                    ) : (
                      <DialogAction
                        buttonLabel={verb}
                        ariaLabel={`${verb}: ${name}`}
                        title={`${verb}: ${name}`}
                        description={sw.enabled ? 'Messages of this type stop going by this channel. Messages already waiting are skipped when their turn comes.' : 'From now on this message goes to customers by this channel (pilot Deals only while the pilot list is on).'}
                        primaryLabel={verb}
                        pendingLabel="Saving…"
                        danger={sw.enabled}
                        action={actions?.setSwitch}
                        fields={{ entityId: d.entityId, type, channel, enabled: sw.enabled ? 'false' : 'true', expectedRowVersion: sw.rowVersion }}
                        okTitle="Saved"
                        initialOpen={isOpen(match)}
                        initialState={stateFor(match)}
                      >
                        <ReasonField id={`cmsg-sw-${type}-${channel}-reason`} hint="10 to 500 characters, e.g. the owner's approval." defaultValue={preview?.typed?.reason} />
                      </DialogAction>
                    )}
                  </div>
                );
              })}
            </li>
          ))}
        </ul>
      </SettingsCard>

      <SettingsCard id="cmsg-pilot" title="Pilot list" description={d.pilotOnly ? 'On: only the Deals below get messages. Every other Deal is skipped with the reason “not on the pilot list”.' : 'Off: every Deal gets the messages that are switched on.'} icon={<ListChecks aria-hidden="true" className="size-4 text-faint" />}>
        <div className="flex flex-wrap gap-3">
          <DialogAction
            buttonLabel={d.pilotOnly ? 'Send to every Deal' : 'Back to pilot Deals only'}
            title={d.pilotOnly ? 'Send to every Deal' : 'Pilot Deals only'}
            description={d.pilotOnly ? 'Messages that are switched on will go to every Deal’s customer, not only the pilot Deals. This needs the owner’s approval.' : 'Only the pilot Deals will get messages again.'}
            primaryLabel={d.pilotOnly ? 'Send to every Deal' : 'Pilot Deals only'}
            pendingLabel="Saving…"
            danger={d.pilotOnly}
            action={actions?.setPilotMode}
            fields={{ entityId: d.entityId, pilotOnly: d.pilotOnly ? 'false' : 'true' }}
            okTitle="Saved"
            initialOpen={isOpen((o) => o.dialog === 'pilot')}
            initialState={stateFor((o) => o.dialog === 'pilot')}
          >
            <ReasonField id="cmsg-pilot-reason" defaultValue={preview?.typed?.reason} />
          </DialogAction>
          <DialogAction
            buttonLabel="Add a pilot Deal"
            title="Add a Deal to the pilot list"
            description="Its customer gets the messages that are switched on. Test Deals never get messages."
            primaryLabel="Add to the pilot list"
            pendingLabel="Adding…"
            action={actions?.addPilotDeal}
            fields={{ entityId: d.entityId, inPilot: 'true' }}
            okTitle="Added"
            initialOpen={isOpen((o) => o.dialog === 'add-pilot')}
            initialState={stateFor((o) => o.dialog === 'add-pilot')}
          >
            <Field htmlFor="cmsg-pilot-deal" label="Deal reference" hint="The exact reference shown on the Deal, for example SYN-JOD-101. Never a customer name.">
              <Input id="cmsg-pilot-deal" name="dealReference" required maxLength={60} autoComplete="off" spellCheck={false} aria-describedby="cmsg-pilot-deal-hint" defaultValue={preview?.typed?.dealReference} className="max-w-md font-mono" />
            </Field>
            <ReasonField id="cmsg-pilot-add-reason" defaultValue={preview?.typed?.reason} />
          </DialogAction>
        </div>
        {d.pilot.length === 0 ? (
          <p className="m-0 text-copy">No pilot Deal yet{d.pilotOnly ? ', so no customer gets a message.' : '.'}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
            {d.pilot.map((p) => {
              const match = (o: NonNullable<MessageSettingsPreview['open']>) => o.dialog === 'remove-pilot' && o.dealId === p.dealId;
              return (
                <li key={p.dealId} className="m-0 flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="m-0 font-semibold text-ink">{p.dealReference}</p>
                    <p className="m-0 text-sm text-quiet">
                      {p.addedByName ? `Added by ${p.addedByName} on ` : 'Added on '}
                      {whenText(p.addedAt)}
                    </p>
                  </div>
                  <DialogAction
                    buttonLabel="Remove"
                    ariaLabel={`Remove ${p.dealReference} from the pilot list`}
                    title={`Remove ${p.dealReference} from the pilot list`}
                    description="Its customer gets no more messages while the pilot list is on."
                    primaryLabel="Remove"
                    pendingLabel="Removing…"
                    danger
                    action={actions?.setPilotDeal}
                    fields={{ entityId: d.entityId, dealId: p.dealId, inPilot: 'false' }}
                    okTitle="Removed"
                    initialOpen={isOpen(match)}
                    initialState={stateFor(match)}
                  >
                    <ReasonField id={`cmsg-pilot-rm-${p.dealId}`} defaultValue={preview?.typed?.reason} />
                  </DialogAction>
                </li>
              );
            })}
          </ul>
        )}
      </SettingsCard>

      <SettingsCard id="cmsg-texts" title="Message texts" description="The only texts that can be sent. WhatsApp sends a text only after WhatsApp has approved it; set the status here to match the Interakt dashboard. Values below are made up." icon={<FileText aria-hidden="true" className="size-4 text-faint" />}>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {MESSAGE_TYPES.map((type) => (
            <li key={type} className="m-0">
              <details className="group rounded-control border border-line bg-card px-3 py-2" open={open?.dialog === 'template' && d.templates.some((t) => t.type === type && t.templateCode === open.templateCode)}>
                <summary className="cursor-pointer py-1 font-semibold text-ink">
                  {TYPE_LABEL[type]}{' '}
                  <span className="font-normal text-quiet">
                    · {(['en', 'hi'] as const).map((l) => `${LANGUAGE_LABEL[l]}: ${TEMPLATE_STATUS_WORD[d.templates.find((t) => t.type === type && t.language === l)?.status ?? 'not_submitted'].label}`).join(' · ')}
                  </span>
                </summary>
                <div className="grid grid-cols-1 gap-4 py-3 lg:grid-cols-2">
                  {(['en', 'hi'] as const).map((lang) => {
                    const pv = d.previews.find((x) => x.type === type && x.language === lang);
                    const tpl = d.templates.find((t) => t.type === type && t.language === lang);
                    const word = TEMPLATE_STATUS_WORD[tpl?.status ?? 'not_submitted'];
                    const match = (o: NonNullable<MessageSettingsPreview['open']>) => o.dialog === 'template' && !!tpl && o.templateCode === tpl.templateCode;
                    return (
                      <div key={lang} className="flex min-w-0 flex-col gap-2" lang={lang}>
                        <div className="flex flex-wrap items-center gap-2">
                          <h4 className="m-0 text-sm font-semibold text-ink" lang="en">
                            {LANGUAGE_LABEL[lang]}
                          </h4>
                          <StatusBadge tone={word.tone} lang="en">
                            {word.label}
                          </StatusBadge>
                        </div>
                        {pv ? (
                          <div className="rounded-control border border-line bg-wash px-3 py-2 text-sm text-copy">
                            <p className="m-0 font-semibold text-ink">{pv.subject}</p>
                            <p className="m-0 whitespace-pre-line wrap-anywhere">{pv.body}</p>
                          </div>
                        ) : (
                          <p className="m-0 text-sm text-quiet" lang="en">
                            No text yet.
                          </p>
                        )}
                        {tpl ? (
                          <div lang="en">
                            <p className="m-0 mb-2 font-mono text-xs text-quiet">{tpl.templateCode}</p>
                            <DialogAction
                              buttonLabel="Set WhatsApp status"
                              ariaLabel={`Set WhatsApp status: ${TYPE_LABEL[type]}, ${LANGUAGE_LABEL[lang]}`}
                              title={`WhatsApp status — ${TYPE_LABEL[type]}, ${LANGUAGE_LABEL[lang]}`}
                              description="Copy the status shown in the Interakt dashboard. WhatsApp messages of this type go only when both languages are approved."
                              primaryLabel="Save status"
                              pendingLabel="Saving…"
                              action={actions?.setTemplateStatus}
                              fields={{ entityId: d.entityId, templateCode: tpl.templateCode }}
                              okTitle="Saved"
                              initialOpen={isOpen(match)}
                              initialState={stateFor(match)}
                            >
                              <Field htmlFor={`cmsg-tpl-${tpl.templateCode}`} label="Status in WhatsApp">
                                <Select id={`cmsg-tpl-${tpl.templateCode}`} name="status" defaultValue={tpl.status}>
                                  {TEMPLATE_STATUSES.map((s) => (
                                    <option key={s} value={s}>
                                      {TEMPLATE_STATUS_WORD[s].label}
                                    </option>
                                  ))}
                                </Select>
                              </Field>
                              <ReasonField id={`cmsg-tpl-${tpl.templateCode}-reason`} defaultValue={preview?.typed?.reason} />
                            </DialogAction>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </details>
            </li>
          ))}
        </ul>
      </SettingsCard>

      <SettingsCard id="cmsg-timer" title="Timer" description="Runs every minute: trip reminders, retries, held-bill checks and the alerts backstop. If it stops, nothing is lost — work waits." icon={<Timer aria-hidden="true" className="size-4 text-faint" />}>
        <dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Summary label="State" value={d.timer.enabled ? 'Switched on' : 'Switched off'} badge={d.timer.enabled ? { tone: 'success', text: 'On' } : { tone: 'neutral', text: 'Off' }} />
          <Summary label="Last good run" value={d.timer.lastOkAt ? whenText(d.timer.lastOkAt) : 'Never'} />
          <Summary label="Queue" value={queueAgeText(d.timer.queueOldestMinutes)} badge={d.timer.queueOldestMinutes !== null && d.timer.queueOldestMinutes > 15 ? { tone: 'warning', text: 'Late' } : undefined} />
        </dl>
        <DialogAction
          buttonLabel={d.timer.enabled ? 'Switch the timer off' : 'Switch the timer on'}
          title={d.timer.enabled ? 'Switch the timer off' : 'Switch the timer on'}
          description={d.timer.enabled ? 'Reminders, retries and re-checks wait until it is on again. Messages already sent are not affected.' : 'The scheduled job must also be active on the database (an approved operator step).'}
          primaryLabel={d.timer.enabled ? 'Switch off' : 'Switch on'}
          pendingLabel="Saving…"
          danger={d.timer.enabled}
          action={actions?.setTimer}
          fields={{ entityId: d.entityId, enabled: d.timer.enabled ? 'false' : 'true' }}
          okTitle="Saved"
          initialOpen={isOpen((o) => o.dialog === 'timer')}
          initialState={stateFor((o) => o.dialog === 'timer')}
        >
          <ReasonField id="cmsg-timer-reason" defaultValue={preview?.typed?.reason} />
        </DialogAction>
      </SettingsCard>

      <SettingsCard id="cmsg-keys" title="Sending set-up" description="Saved by the owner in Vercel. This page shows only whether each one is saved — never its value." icon={<KeyRound aria-hidden="true" className="size-4 text-faint" />}>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {d.providers.map((p) => (
            <li key={p.key} className="m-0 flex flex-wrap items-center justify-between gap-2">
              <span className="text-copy">{PROVIDER_KEY_LABEL[p.key] ?? p.key}</span>
              <StatusBadge tone={p.configured ? 'success' : 'warning'}>{p.configured ? 'Configured' : 'Not configured'}</StatusBadge>
            </li>
          ))}
        </ul>
      </SettingsCard>
    </section>
  );
}

function Summary({ label, value, badge }: { label: string; value: string; badge?: { tone: 'success' | 'neutral' | 'info' | 'warning'; text: string } }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-control border border-line bg-card px-3 py-2">
      <dt className="text-sm text-quiet">{label}</dt>
      <dd className="m-0 flex flex-wrap items-center gap-2 font-semibold text-ink">
        <span className="wrap-anywhere">{value}</span>
        {badge ? <StatusBadge tone={badge.tone}>{badge.text}</StatusBadge> : null}
      </dd>
    </div>
  );
}

function SettingsCard({ id, title, description, icon, children }: { id: string; title: string; description: string; icon: ReactNode; children: ReactNode }) {
  return (
    <Card id={id}>
      <section aria-labelledby={`${id}-heading`}>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle id={`${id}-heading`} level={3}>
              {title}
            </CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          {icon}
        </CardHeader>
        <CardBody className="flex flex-col gap-4">{children}</CardBody>
      </section>
    </Card>
  );
}

/** Loading state of the settings page. */
export function CustomerMessageSettingsLoading() {
  return (
    <LoadingRegion label="Loading customer message settings…">
      <Skeleton className="h-7 w-1/3" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-40 w-full" />
    </LoadingRegion>
  );
}

/** Not a Super Admin. */
export function CustomerMessageSettingsNoAccess() {
  return (
    <Notice tone="restricted" title="Only a Super Admin can open this page">
      <p>Customer message switches, the pilot list and the timer are kept to Super Admins.</p>
    </Notice>
  );
}

/** One settings section per company the Super Admin administers (heading only when there are several). */
export function CustomerMessageSettingsCompanies({ companies, actions }: { companies: Array<{ id: string; name: string; data: AdminCustomerMessages | 'error' }>; actions: Partial<MessageSettingsActions> | null }) {
  return (
    <>
      {companies.map((c) => (
        <div key={c.id} className="flex flex-col gap-2">
          {companies.length > 1 ? <h2 className="m-0 text-lg font-semibold text-ink">{c.name}</h2> : null}
          <CustomerMessageSettingsView data={c.data} actions={actions} />
        </div>
      ))}
    </>
  );
}
