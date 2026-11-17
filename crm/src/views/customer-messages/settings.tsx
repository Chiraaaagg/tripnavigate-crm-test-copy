import { FileText, KeyRound, ListChecks, MessageSquareText } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { StatusBadge } from '@/components/ui/badge';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn, focusRing } from '@/components/ui/cn';
import { Field } from '@/components/ui/field';
import { Fold } from '@/components/ui/fold';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { Select } from '@/components/ui/select';
import { LoadingRegion, Skeleton } from '@/components/ui/skeleton';
import { Status } from '@/components/ui/status';
import { SwitchRow } from '@/components/ui/switch-row';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs } from '@/components/ui/tabs';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { BlockedButton, DialogAction, ReasonField } from '@/views/accounts-desk/acc2-kit';
import type { DeskResult } from '@/views/accounts-desk/desk-kit';
import { whenText } from '@/views/accounts-desk/labels';
import { SettingsSectionHeading } from '@/views/settings/settings-frame';
import { CHANNEL_LABEL, PROVIDER_KEY_LABEL, QUIET_HOURS_TYPES, TEMPLATE_STATUS_WORD, TYPE_LABEL, TYPE_WHEN, queueAgeText } from './labels';
import {
  englishTemplate,
  MESSAGE_SETTINGS_TAB_LABEL,
  MESSAGE_SETTINGS_TABS,
  messageSettingsTabHref,
  switchesSummary,
  whatsappBlockText,
  type MessageSettingsTab,
} from './settings-tabs';
import { CHANNELS, MESSAGE_TYPES, type AdminCustomerMessages, type Channel, type MessageType, type TemplateStatus } from './types';

/*
 * Settings › Customer messages, its own Settings area (contract §5.9 A7–A11,
 * §5.10 R-A2, §15 screen 4; UX redesign R1, prototype S7). Super Admin only.
 * Sub-tabs on the same address (?tab=): Switches (the nine approved messages
 * × e-mail and WhatsApp, 18 switches, each changed with a reason), Texts (the
 * English texts and their WhatsApp approval), Pilot list (pilot mode and its
 * Deals) and Set-up (the timer and whether each sending key is saved — names
 * only, values never reach a screen). Owner decision D12: every customer
 * message goes in English, so no language is shown or chosen here (the
 * stored Hindi templates stay unused). Every dialog posts the same fields as
 * before.
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

type OpenDialog = NonNullable<MessageSettingsPreview['open']>;

const TEMPLATE_STATUSES: TemplateStatus[] = ['not_submitted', 'submitted', 'approved', 'rejected'];

const AREA_LINE =
  'The nine booking messages the owner approved, by e-mail and WhatsApp. Every message is in English. Each message and channel has its own switch, Off until the owner approves it. Bills, payment-due reminders and marketing never go to customers.';

const linkClass = cn('rounded-chip font-semibold text-brand-strong underline decoration-1 underline-offset-4 hover:text-brand-deep hover:decoration-2', focusRing);

/** Heading and sub-tabs of the area (once per page, also with several companies). */
function AreaHead({ tab, pilotCount }: { tab: MessageSettingsTab; pilotCount?: number }) {
  return (
    <>
      <SettingsSectionHeading id="cmsg-settings-heading" description={AREA_LINE}>
        Customer messages
      </SettingsSectionHeading>
      <Tabs
        label="Customer messages sections"
        variant="pill"
        items={MESSAGE_SETTINGS_TABS.map((t) => ({
          href: messageSettingsTabHref(t),
          label: MESSAGE_SETTINGS_TAB_LABEL[t],
          current: t === tab,
          ...(t === 'pilot' && pilotCount !== undefined ? { count: pilotCount } : {}),
        }))}
      />
    </>
  );
}

export function CustomerMessageSettingsView({
  data,
  actions,
  preview,
  tab = 'switches',
  head = true,
}: {
  data: AdminCustomerMessages | 'error';
  actions: Partial<MessageSettingsActions> | null;
  preview?: MessageSettingsPreview;
  /** The sub-tab to show (default Switches, the address without ?tab=). */
  tab?: MessageSettingsTab;
  /** false: the page already shows the heading and sub-tabs (several companies). */
  head?: boolean;
}) {
  const pilotCount = data !== 'error' && data.pilotOnly ? data.pilot.length : undefined;
  return (
    <section aria-labelledby={head ? 'cmsg-settings-heading' : undefined} className="flex flex-col gap-5" data-slot="cmsg-settings" data-tab={tab}>
      {head ? <AreaHead tab={tab} pilotCount={pilotCount} /> : null}
      {data === 'error' ? (
        <Notice tone="warning" role="status">
          <p>The customer message settings could not be loaded just now. Nothing was changed. Reload the page.</p>
        </Notice>
      ) : tab === 'texts' ? (
        <TextsTab d={data} actions={actions} preview={preview} />
      ) : tab === 'pilot' ? (
        <PilotTab d={data} actions={actions} preview={preview} />
      ) : tab === 'setup' ? (
        <SetupTab d={data} actions={actions} preview={preview} />
      ) : (
        <SwitchesTab d={data} actions={actions} preview={preview} />
      )}
    </section>
  );
}

interface TabProps {
  d: AdminCustomerMessages;
  actions: Partial<MessageSettingsActions> | null;
  preview?: MessageSettingsPreview;
}

function previewHelpers(preview: MessageSettingsPreview | undefined) {
  const open = preview?.open;
  return {
    open,
    isOpen: (pred: (o: OpenDialog) => boolean) => (open ? pred(open) : false),
    stateFor: (pred: (o: OpenDialog) => boolean) => (open && pred(open) ? (preview?.state ?? null) : null),
  };
}

/** Switches: the nine-by-two grid. Each cell is the state in words with its own change dialog. */
function SwitchesTab({ d, actions, preview }: TabProps) {
  const { isOpen, stateFor } = previewHelpers(preview);
  const missingKeys = d.providers.filter((p) => !p.configured);
  return (
    <>
      <p className="m-0 text-copy" data-slot="cmsg-summary">
        {switchesSummary(d)}
      </p>
      {missingKeys.length > 0 ? (
        <Notice tone="info" title="Sending is not fully set up yet">
          <p>Messages wait as “Failed — sending is not set up yet” until the owner saves these keys in Vercel: {missingKeys.map((k) => PROVIDER_KEY_LABEL[k.key] ?? k.key).join(', ')}.</p>
          <p>
            <Link href={messageSettingsTabHref('setup')} className={linkClass}>
              Open Set-up
            </Link>
          </p>
        </Notice>
      ) : null}
      <SettingsCard id="cmsg-switches" title="Messages and channels" description="Turning a switch on or off needs a reason. Switch Off: nothing is recorded for that message and channel." icon={<MessageSquareText aria-hidden="true" className="size-4 text-faint" />} flush>
        <Table label="Customer message switches" stackOnMobile>
          <TableCaption>Nine messages by e-mail and WhatsApp: {d.switches.filter((s) => s.enabled).length} of {d.switches.length} on.</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Message</TableHead>
              {CHANNELS.map((c) => (
                <TableHead key={c}>{CHANNEL_LABEL[c]}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {MESSAGE_TYPES.map((type) => (
              <TableRow key={type} data-type={type}>
                <TableCell label="Message" className="min-w-48">
                  <span className="block font-semibold text-ink">{TYPE_LABEL[type]}</span>
                  <span className="block text-sm text-quiet">
                    {TYPE_WHEN[type]}
                    {QUIET_HOURS_TYPES.includes(type) ? ' Held between 9 pm and 8 am.' : ''}
                  </span>
                </TableCell>
                {CHANNELS.map((channel) => {
                  const sw = d.switches.find((s) => s.type === type && s.channel === channel);
                  const name = `${TYPE_LABEL[type]} by ${CHANNEL_LABEL[channel]}`;
                  if (!sw) {
                    return (
                      <TableCell key={channel} label={CHANNEL_LABEL[channel]}>
                        <span className="text-sm text-quiet">Not set up</span>
                      </TableCell>
                    );
                  }
                  const block = channel === 'whatsapp' ? whatsappBlockText(type, d.templates, sw.enabled) : null;
                  const match = (o: OpenDialog) => o.dialog === 'switch' && o.type === type && o.channel === channel;
                  const verb = sw.enabled ? 'Turn off' : 'Turn on';
                  return (
                    <TableCell key={channel} label={CHANNEL_LABEL[channel]} data-cell={`${type}-${channel}`}>
                      <div className="flex min-w-0 flex-col items-end gap-2 sm:items-start">
                        <Status kind={sw.enabled ? 'on' : 'off'} srPrefix={`${name}: `} />
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
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </SettingsCard>
    </>
  );
}

/** Texts: the English text of each message and its WhatsApp approval. */
function TextsTab({ d, actions, preview }: TabProps) {
  const { open, isOpen, stateFor } = previewHelpers(preview);
  return (
    <SettingsCard id="cmsg-texts" title="Message texts" description="The only texts that can be sent, all in English. WhatsApp sends a text only after WhatsApp has approved it; set the status here to match the Interakt dashboard. Values below are made up." icon={<FileText aria-hidden="true" className="size-4 text-faint" />}>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {MESSAGE_TYPES.map((type) => {
          const tpl = englishTemplate(type, d.templates);
          const pv = d.previews.find((x) => x.type === type && x.language === 'en');
          const word = TEMPLATE_STATUS_WORD[tpl?.status ?? 'not_submitted'];
          const match = (o: OpenDialog) => o.dialog === 'template' && !!tpl && o.templateCode === tpl.templateCode;
          return (
            <li key={type} className="m-0">
              <Fold summary={TYPE_LABEL[type]} meta={`WhatsApp: ${word.label}`} open={open?.dialog === 'template' && !!tpl && open.templateCode === tpl.templateCode}>
                <div className="flex min-w-0 flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-quiet">WhatsApp</span>
                    <StatusBadge tone={word.tone}>{word.label}</StatusBadge>
                  </div>
                  {pv ? (
                    <div className="rounded-control border border-line bg-wash px-3 py-2 text-sm text-copy">
                      <p className="m-0 font-semibold text-ink">{pv.subject}</p>
                      <p className="m-0 whitespace-pre-line wrap-anywhere">{pv.body}</p>
                    </div>
                  ) : (
                    <p className="m-0 text-sm text-quiet">No text yet.</p>
                  )}
                  {tpl ? (
                    <div>
                      <p className="m-0 mb-2 font-mono text-xs text-quiet">{tpl.templateCode}</p>
                      <DialogAction
                        buttonLabel="Set WhatsApp status"
                        ariaLabel={`Set WhatsApp status: ${TYPE_LABEL[type]}`}
                        title={`WhatsApp status — ${TYPE_LABEL[type]}`}
                        description="Copy the status shown in the Interakt dashboard. WhatsApp messages of this type go only once WhatsApp has approved the text."
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
              </Fold>
            </li>
          );
        })}
      </ul>
    </SettingsCard>
  );
}

/** Pilot list: pilot mode as one switch row, then the pilot Deals. */
function PilotTab({ d, actions, preview }: TabProps) {
  const { isOpen, stateFor } = previewHelpers(preview);
  return (
    <>
      <Card id="cmsg-pilot">
        <SwitchRow
          id="cmsg-pilot-only"
          name="Only pilot Deals get messages"
          effect={d.pilotOnly ? 'On: only the Deals below get messages. Every other Deal is skipped with the reason “not on the pilot list”.' : 'Off: every Deal gets the messages that are switched on.'}
          state={d.pilotOnly ? 'on' : 'off'}
          change={
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
          }
        />
      </Card>
      <SettingsCard id="cmsg-pilot-deals" title="Pilot Deals" description="Test Deals never get messages, on the list or not." icon={<ListChecks aria-hidden="true" className="size-4 text-faint" />}>
        <div>
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
              const match = (o: OpenDialog) => o.dialog === 'remove-pilot' && o.dealId === p.dealId;
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
    </>
  );
}

/** Set-up: the timer as one switch row with its facts, then whether each sending key is saved. */
function SetupTab({ d, actions, preview }: TabProps) {
  const { isOpen, stateFor } = previewHelpers(preview);
  const late = d.timer.queueOldestMinutes !== null && d.timer.queueOldestMinutes > 15;
  return (
    <>
      <Card id="cmsg-timer">
        <SwitchRow
          id="cmsg-timer-switch"
          name="Timer"
          effect="Runs every minute: trip reminders, retries, held-bill checks and the alerts backstop. If it stops, nothing is lost — work waits."
          more={
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-quiet">Last good run</dt>
              <dd className="m-0">{d.timer.lastOkAt ? whenText(d.timer.lastOkAt) : 'Never'}</dd>
              <dt className="text-quiet">Queue</dt>
              <dd className="m-0">
                {queueAgeText(d.timer.queueOldestMinutes)}
                {late ? ' (late)' : ''}
              </dd>
            </dl>
          }
          state={d.timer.enabled ? 'on' : 'off'}
          change={
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
          }
        />
        {late ? (
          <div className="px-4.5 pb-3.5">
            <Notice tone="warning" role="status">
              <p>The oldest waiting message is {queueAgeText(d.timer.queueOldestMinutes)}. Check that the timer is running.</p>
            </Notice>
          </div>
        ) : null}
      </Card>
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
    </>
  );
}

function SettingsCard({ id, title, description, icon, flush = false, children }: { id: string; title: string; description: string; icon: ReactNode; /** No body padding (a table to the card's edges). */ flush?: boolean; children: ReactNode }) {
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
        {flush ? children : <CardBody className="flex flex-col gap-4">{children}</CardBody>}
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
    <>
      <SettingsSectionHeading>Customer messages</SettingsSectionHeading>
      <Notice tone="restricted" title="Only a Super Admin can open this page">
        <p>Customer message switches, the pilot list, the WhatsApp text approvals and the timer are kept to Super Admins.</p>
      </Notice>
    </>
  );
}

/** One settings section per company the Super Admin administers (heading and sub-tabs once; company name only when there are several). */
export function CustomerMessageSettingsCompanies({
  companies,
  actions,
  tab = 'switches',
}: {
  companies: Array<{ id: string; name: string; data: AdminCustomerMessages | 'error' }>;
  actions: Partial<MessageSettingsActions> | null;
  tab?: MessageSettingsTab;
}) {
  if (companies.length === 1) return <CustomerMessageSettingsView data={companies[0]!.data} actions={actions} tab={tab} />;
  return (
    <section aria-labelledby="cmsg-settings-heading" className="flex flex-col gap-5">
      <AreaHead tab={tab} />
      {companies.map((c) => (
        <div key={c.id} className="flex flex-col gap-2">
          <h3 className="m-0 text-lg font-semibold text-ink">{c.name}</h3>
          <CustomerMessageSettingsView data={c.data} actions={actions} tab={tab} head={false} />
        </div>
      ))}
    </section>
  );
}
