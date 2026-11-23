import type { ReactNode } from 'react';
import { Card, CardBody, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import { DealCustomerMessagesCard, DealCustomerMessagesLoading, type MessageActions } from '@/views/customer-messages/deal-card';
import { BookNowMessagePrefsCard, BookNowMessagePrefsUnavailable } from '@/views/customer-messages/book-now-card';
import { CustomerLanguageFields } from '@/views/customer-messages/language-fields';
import { CustomerMessageSettingsLoading, CustomerMessageSettingsNoAccess, CustomerMessageSettingsView, type MessageSettingsActions } from '@/views/customer-messages/settings';
import { BoardingPassPanel, CustomerVoucherPanel, TaskBoardingPassPanel, type TaskCustomerFilesView } from '@/views/customer-messages/task-panels';
import type { DealCustomerMessages } from '@/views/customer-messages/types';
import type { DeskResult } from '@/views/accounts-desk/desk-kit';
import { INBOX } from './acc-fixtures';
import { accNoticeNoop } from './acc-preview-actions';
import {
  ADMIN,
  ADMIN_RUNNING,
  BP_STATUS,
  DEAL_MESSAGES,
  DEAL_MESSAGES_ACCOUNTS,
  DEAL_MESSAGES_EMPTY,
  DEAL_MESSAGES_OFF,
  DEAL_MESSAGES_STOPPED,
  DEAL_MESSAGES_UNKNOWN,
  DEAL_MESSAGES_UNCONFIRMED,
  FLIGHT_TASK_ID,
  MESSAGES,
  NOW,
  SLOTS,
  TASK_ID,
  VOUCHERS,
  VOUCHER_STATUS,
} from './acc3-messages-fixtures';
import * as A from './acc3-messages-preview-actions';
import { R1_S3_STATES } from './r1-settings-s3-states';
import { inSettings, settingsOwner } from './settings-preview-frame';

/*
 * Accounts phase 3 preview states (acc3-messages-*), track U: Book now
 * customer language, the Deal page "Messages to customer" card (Sales owner,
 * Manager, Accounts read-only, Purchase sees nothing), Purchase "Customer
 * voucher", Flight "Boarding passes", Settings › Customer messages. Synthetic
 * props only; rendered by the design-review gallery only (a 404 outside
 * local preview mode).
 */

const act = (a: unknown) => a as DecisionAction;
const refused = (code: string, message: string, field?: string) => ({ ok: false, code, message, ...(field ? { field } : {}) }) as DeskResult;

const salesViewer: ShellViewer = { displayName: 'Synthetic Sales Jodhpur', primaryRole: 'Sales', primaryBranch: 'Jodhpur', canAdministerStaff: false, canManageGrants: false, canSeeOwnDues: true, canSeeLeads: true };
const managerViewer: ShellViewer = { ...salesViewer, displayName: 'Synthetic Manager Jodhpur', primaryRole: 'Manager', canSeeBranchMoney: true, canSeeApprovals: true };
const accountsViewer: ShellViewer = { ...salesViewer, displayName: 'Synthetic Accounts 1', primaryRole: 'Accounts', canUseAccounts: true, canSeeAccountsDesk: true, canSeeLeads: false, canSeeOwnDues: false };
const purchaseViewer: ShellViewer = { ...salesViewer, displayName: 'Synthetic Purchase Jodhpur', primaryRole: 'Purchase', canSeePurchaseTasks: true, canSeeLeads: false, canSeeOwnDues: false };
const SEC_OUT = 'a0004521-0000-4000-8000-000000004521';
const SEC_BACK = 'a0004522-0000-4000-8000-000000004522';
const TASK_FILES: TaskCustomerFilesView = {
  taskId: 'a0004501-0000-4000-8000-000000004501',
  kind: 'boarding_pass',
  taskConfirmed: true,
  can: { upload: true, markReady: false },
  due: true,
  files: [
    { evidenceId: 'a0004511-0000-4000-8000-000000004511', fileName: 'boarding-pass-synthetic-traveller-1.pdf', status: 'stored', storedAt: '2026-11-13T04:10:00Z', readyAt: null, sectorId: SEC_OUT, passengerSeq: 1, email: { state: 'sent' }, whatsapp: { state: 'waiting' } },
    { evidenceId: 'a0004512-0000-4000-8000-000000004512', fileName: 'boarding-pass-synthetic-traveller-2.pdf', status: 'failed', storedAt: null, readyAt: null, sectorId: null, passengerSeq: null, email: { state: 'not_sent' }, whatsapp: { state: 'not_sent' } },
  ],
  slots: [
    { sectorId: SEC_OUT, sectorLabel: 'JDH → DEL, 14 Nov 06:40', passengerSeq: 1, passengerName: 'Synthetic Traveller One', evidenceId: 'a0004511-0000-4000-8000-000000004511', email: { state: 'sent' }, whatsapp: { state: 'waiting' } },
    { sectorId: SEC_OUT, sectorLabel: 'JDH → DEL, 14 Nov 06:40', passengerSeq: 2, passengerName: 'Synthetic Traveller Two', evidenceId: null, email: { state: 'not_sent' }, whatsapp: { state: 'not_sent' } },
    { sectorId: SEC_BACK, sectorLabel: 'DEL → JDH, 18 Nov 19:15', passengerSeq: 1, passengerName: 'Synthetic Traveller One', evidenceId: null, email: { state: 'not_sent' }, whatsapp: { state: 'not_sent' } },
    { sectorId: SEC_BACK, sectorLabel: 'DEL → JDH, 18 Nov 19:15', passengerSeq: 2, passengerName: 'Synthetic Traveller Two', evidenceId: null, email: { state: 'not_sent' }, whatsapp: { state: 'not_sent' } },
  ],
};
const flightViewer: ShellViewer = { ...salesViewer, displayName: 'Synthetic Flight Jodhpur', primaryRole: 'Flight', canSeeLeads: false, canSeeOwnDues: false };

const NOOP = accNoticeNoop as never;
function shell(viewer: ShellViewer, path: string, body: ReactNode) {
  return (
    <StaffShell viewer={viewer} currentPath={path} notices={{ api: { inbox: NOOP, history: NOOP, mark: NOOP, markAllRead: NOOP, setSound: NOOP }, realtime: null, preview: { inbox: INBOX } }}>
      {body}
    </StaffShell>
  );
}

/** A Purchase or Flight task page stand-in: the task header (the page's one h1) above the panel. */
function task(viewer: ShellViewer, path: string, body: ReactNode) {
  const flight = path === '/app/flight';
  return shell(
    viewer,
    path,
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow={flight ? 'Flight task · SYN-JOD-101' : 'Purchase task · SYN-JOD-101'} title={flight ? 'Jodhpur to Delhi and back' : 'Sample Lake Hotel, Udaipur'} />
      {body}
    </div>,
  );
}

const ACTIONS: MessageActions = { setPrefs: act(A.cmsgPrefsOk), resend: act(A.cmsgResendOk), restartWhatsapp: act(A.cmsgRestartOk) };
type CardProps = Parameters<typeof DealCustomerMessagesCard>[0];

function deal(viewer: ShellViewer, data: DealCustomerMessages | 'error' | null, over: Partial<Pick<CardProps, 'actions' | 'preview'>> = {}) {
  return shell(
    viewer,
    '/app/deals',
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Deal · SYN-JOD-101" title="Synthetic family trip to Udaipur" />
      {data === null ? <p className="m-0 text-quiet">Preview note: Purchase, Flight and Visa do not see the customer messages card (the read returns nothing).</p> : null}
      <DealCustomerMessagesCard data={data} actions={over.actions === undefined ? ACTIONS : over.actions} preview={over.preview} />
    </div>,
  );
}

function bookNow(over: { same?: boolean; whatsapp?: string; error?: string } = {}) {
  return shell(
    salesViewer,
    '/app/deals',
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Book now · SYN-JOD-101" title="Customer and trip" />
      <Card>
        <section aria-labelledby="bn-contact-heading">
          <CardHeader>
            <div className="min-w-0">
              <CardTitle id="bn-contact-heading">Booking contact</CardTitle>
              <CardDescription>The person Holiday Chacha sends booking messages to.</CardDescription>
            </div>
          </CardHeader>
          <CardBody className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field htmlFor="bn-mobile" label="Mobile">
                <Input id="bn-mobile" name="mobile" inputMode="numeric" defaultValue="6000012345" />
              </Field>
              <Field htmlFor="bn-email" label="E-mail">
                <Input id="bn-email" name="email" type="email" defaultValue="guest@example.test" />
              </Field>
            </div>
            <CustomerLanguageFields idPrefix="bn-msg" defaultSameAsMobile={over.same} defaultWhatsapp={over.whatsapp} errorField={over.error} mobileHint="Messages go to the mobile above." />
            {over.error ? <p className="m-0 text-sm font-semibold text-status-danger">Not saved: enter a 10-digit Indian mobile number for WhatsApp.</p> : null}
          </CardBody>
        </section>
      </Card>
    </div>,
  );
}

const SETTINGS_ACTIONS: MessageSettingsActions = {
  setSwitch: act(A.cmsgSettingOk),
  setPilotMode: act(A.cmsgSettingOk),
  setPilotDeal: act(A.cmsgSettingOk),
  addPilotDeal: act(A.cmsgSettingOk),
  setTemplateStatus: act(A.cmsgSettingOk),
  setTimer: act(A.cmsgSettingOk),
};
const settings = (body: ReactNode) => inSettings(settingsOwner, '/app/admin/customer-messages', body);
const VOUCHER_ACTIONS = { upload: act(A.cmsgUploadOk), markReady: act(A.cmsgReadyOk) };

const states: Record<string, () => ReactNode> = {
  /* Book now */
  'acc3-messages-booknow': () => bookNow(),
  /* The wired Book now card (own form on the customer step; saves on the Deal). */
  'acc3-messages-booknow-card': () =>
    shell(salesViewer, '/app/deals', <BookNowMessagePrefsCard prefs={{ dealId: 'a0004401-0000-4000-8000-000000004401', language: 'en', whatsappSameAsMobile: true, whatsappMasked: '60xxxxxx21', rowVersion: 1 }} action={act(A.cmsgPrefsOk)} />),
  'acc3-messages-booknow-card-refused': () =>
    shell(salesViewer, '/app/deals', <BookNowMessagePrefsCard prefs={{ dealId: 'a0004401-0000-4000-8000-000000004401', language: 'hi', whatsappSameAsMobile: false, whatsappMasked: '60xxxxxx54', rowVersion: 2 }} action={act(A.cmsgPrefsNumber)} />),
  'acc3-messages-booknow-card-read-only': () =>
    shell(salesViewer, '/app/deals', <BookNowMessagePrefsCard prefs={{ dealId: 'a0004401-0000-4000-8000-000000004401', language: 'en', whatsappSameAsMobile: true, whatsappMasked: null, rowVersion: 1 }} action={null} />),
  'acc3-messages-booknow-card-error': () => shell(salesViewer, '/app/deals', <BookNowMessagePrefsUnavailable />),
  // D12: no language choice; a Deal stored as Hindi shows no language and posts English (see -card-refused).
  'acc3-messages-booknow-other-number': () => bookNow({ same: false, whatsapp: '6000054321' }),
  'acc3-messages-booknow-number-refused': () => bookNow({ same: false, whatsapp: '12345', error: 'whatsappMobile' }),

  /* Deal page card */
  'acc3-messages-deal-sales': () => deal(salesViewer, DEAL_MESSAGES),
  'acc3-messages-deal-manager': () => deal(managerViewer, DEAL_MESSAGES),
  'acc3-messages-deal-accounts': () => deal(accountsViewer, DEAL_MESSAGES_ACCOUNTS, { actions: null }),
  'acc3-messages-deal-purchase': () => deal(purchaseViewer, null),
  'acc3-messages-deal-stopped': () => deal(salesViewer, DEAL_MESSAGES_STOPPED),
  'acc3-messages-deal-unknown': () => deal(salesViewer, DEAL_MESSAGES_UNKNOWN),
  'acc3-messages-deal-unknown-prefs': () => deal(salesViewer, DEAL_MESSAGES_UNKNOWN, { preview: { prefsOpen: true } }),
  'acc3-messages-deal-restart-open': () => deal(salesViewer, DEAL_MESSAGES_STOPPED, { preview: { restartOpen: true } }),
  'acc3-messages-deal-restart-refused': () =>
    deal(salesViewer, DEAL_MESSAGES_STOPPED, { actions: { ...ACTIONS, restartWhatsapp: act(A.cmsgReasonShort) }, preview: { restartOpen: true, restartReason: 'Asked', restartState: refused('invalid_input', 'Check the highlighted field.', 'reason') } }),
  'acc3-messages-deal-unconfirmed': () => deal(salesViewer, DEAL_MESSAGES_UNCONFIRMED),
  'acc3-messages-deal-channel-off': () => deal(salesViewer, DEAL_MESSAGES_OFF),
  'acc3-messages-deal-empty': () => deal(salesViewer, DEAL_MESSAGES_EMPTY),
  'acc3-messages-deal-error': () => deal(salesViewer, 'error'),
  'acc3-messages-deal-loading': () =>
    shell(
      salesViewer,
      '/app/deals',
      <div className="flex flex-col gap-5">
        <PageHeader eyebrow="Deal · SYN-JOD-101" title="Synthetic family trip to Udaipur" />
        <DealCustomerMessagesLoading />
      </div>,
    ),
  'acc3-messages-deal-prefs-open': () => deal(salesViewer, DEAL_MESSAGES, { preview: { prefsOpen: true } }),
  'acc3-messages-deal-prefs-refused': () =>
    deal(salesViewer, DEAL_MESSAGES, { actions: { ...ACTIONS, setPrefs: act(A.cmsgPrefsStale) }, preview: { prefsOpen: true, prefsState: refused('version_changed', 'Someone changed this just now. Reload the page and try again.') } }),
  'acc3-messages-deal-resend-done': () => deal(salesViewer, DEAL_MESSAGES, { preview: { resend: { messageId: MESSAGES[0]!.id, state: { ok: true, message: 'Synthetic preview: queued again. It goes in a few seconds.' } } } }),
  'acc3-messages-deal-resend-refused': () =>
    deal(salesViewer, DEAL_MESSAGES, { actions: { ...ACTIONS, resend: act(A.cmsgResendWrong) }, preview: { resend: { messageId: MESSAGES[0]!.id, state: refused('wrong_state', 'This message cannot be sent again in its current state.') } } }),

  /* Purchase task: customer voucher */
  'acc3-messages-voucher': () => task(purchaseViewer, '/app/purchase', <CustomerVoucherPanel taskId={TASK_ID} supplierConfirmed canWork files={VOUCHERS} status={VOUCHER_STATUS} actions={VOUCHER_ACTIONS} />),
  'acc3-messages-voucher-empty': () => task(purchaseViewer, '/app/purchase', <CustomerVoucherPanel taskId={TASK_ID} supplierConfirmed canWork files={[]} status={null} actions={VOUCHER_ACTIONS} />),
  'acc3-messages-voucher-not-confirmed': () => task(purchaseViewer, '/app/purchase', <CustomerVoucherPanel taskId={TASK_ID} supplierConfirmed={false} canWork files={[]} status={null} actions={VOUCHER_ACTIONS} />),
  'acc3-messages-voucher-upload-open': () => task(purchaseViewer, '/app/purchase', <CustomerVoucherPanel taskId={TASK_ID} supplierConfirmed canWork files={VOUCHERS} status={VOUCHER_STATUS} actions={VOUCHER_ACTIONS} preview={{ uploadOpen: true }} />),
  'acc3-messages-voucher-ready-refused': () =>
    task(
      purchaseViewer,
      '/app/purchase',
      <CustomerVoucherPanel
        taskId={TASK_ID}
        supplierConfirmed
        canWork
        files={VOUCHERS}
        status={VOUCHER_STATUS}
        actions={{ ...VOUCHER_ACTIONS, markReady: act(A.cmsgReadyNotConfirmed) }}
        preview={{ ready: { evidenceId: VOUCHERS[1]!.evidenceId, state: refused('not_ready', 'The supplier has not confirmed this booking yet.') } }}
      />,
    ),
  'acc3-messages-voucher-error': () => task(purchaseViewer, '/app/purchase', <CustomerVoucherPanel taskId={TASK_ID} supplierConfirmed canWork files={VOUCHERS} status="error" actions={VOUCHER_ACTIONS} />),
  'acc3-messages-voucher-read-only': () => task(managerViewer, '/app/purchase', <CustomerVoucherPanel taskId={TASK_ID} supplierConfirmed canWork={false} files={VOUCHERS} status="error" actions={null} />),

  /* Flight task: boarding passes, task-level slot read (the wired panel) */
  'acc3-messages-boarding-task': () => task(flightViewer, '/app/flight', <TaskBoardingPassPanel data={TASK_FILES} upload={act(A.cmsgUploadOk)} />),
  'acc3-messages-boarding-task-empty': () => task(flightViewer, '/app/flight', <TaskBoardingPassPanel data={{ ...TASK_FILES, due: false, files: [], slots: TASK_FILES.slots.map((x) => ({ ...x, evidenceId: null, email: { state: 'not_sent' as const }, whatsapp: { state: 'not_sent' as const } })) }} upload={act(A.cmsgUploadOk)} />),
  'acc3-messages-boarding-task-no-tickets': () => task(flightViewer, '/app/flight', <TaskBoardingPassPanel data={{ ...TASK_FILES, taskConfirmed: false, due: false, files: [], slots: [] }} upload={act(A.cmsgUploadOk)} />),
  'acc3-messages-boarding-task-open': () => task(flightViewer, '/app/flight', <TaskBoardingPassPanel data={TASK_FILES} upload={act(A.cmsgUploadOk)} preview={{ open: true, slot: `${SEC_OUT}:2` }} />),
  'acc3-messages-boarding-task-whole-flight': () => task(flightViewer, '/app/flight', <TaskBoardingPassPanel data={{ ...TASK_FILES, slots: [] }} upload={act(A.cmsgUploadOk)} preview={{ open: true }} />),
  'acc3-messages-boarding-task-slot-taken': () =>
    task(flightViewer, '/app/flight', <TaskBoardingPassPanel data={TASK_FILES} upload={act(A.cmsgUploadOk)} preview={{ open: true, slot: `${SEC_BACK}:1`, state: refused('already_recorded', 'A boarding pass is already stored for this passenger and flight.') }} />),
  'acc3-messages-boarding-task-not-linked': () => task(flightViewer, '/app/flight', <TaskBoardingPassPanel data={TASK_FILES} upload={act(A.cmsgUploadNotLinked)} preview={{ open: true, slot: `${SEC_OUT}:2` }} />),
  'acc3-messages-boarding-task-error': () => task(flightViewer, '/app/flight', <TaskBoardingPassPanel data="error" upload={act(A.cmsgUploadOk)} />),
  /* Flight task: boarding passes */
  'acc3-messages-boarding': () => task(flightViewer, '/app/flight', <BoardingPassPanel taskId={FLIGHT_TASK_ID} hasTicketBatch canWork slots={SLOTS} status={BP_STATUS} actions={{ upload: act(A.cmsgUploadOk) }} now={NOW} />),
  'acc3-messages-boarding-upload-open': () =>
    task(flightViewer, '/app/flight', <BoardingPassPanel taskId={FLIGHT_TASK_ID} hasTicketBatch canWork slots={SLOTS} status={BP_STATUS} actions={{ upload: act(A.cmsgUploadOk) }} now={NOW} preview={{ upload: { key: 's1-p2' } }} />),
  'acc3-messages-boarding-no-tickets': () =>
    task(flightViewer, '/app/flight', <BoardingPassPanel taskId={FLIGHT_TASK_ID} hasTicketBatch={false} canWork slots={SLOTS.map((s) => ({ ...s, file: null }))} status={null} actions={{ upload: act(A.cmsgUploadOk) }} now="2026-11-10T10:00:00Z" />),
  'acc3-messages-boarding-read-only': () => task(flightViewer, '/app/flight', <BoardingPassPanel taskId={FLIGHT_TASK_ID} hasTicketBatch canWork={false} slots={SLOTS} status={BP_STATUS} actions={null} now={NOW} />),
  'acc3-messages-boarding-empty': () => task(flightViewer, '/app/flight', <BoardingPassPanel taskId={FLIGHT_TASK_ID} hasTicketBatch canWork slots={[]} status={null} actions={{ upload: act(A.cmsgUploadOk) }} now={NOW} />),

  /* Settings › Customer messages */
  'acc3-messages-settings': () => settings(<CustomerMessageSettingsView data={ADMIN} actions={SETTINGS_ACTIONS} />),
  'acc3-messages-settings-empty': () => settings(<CustomerMessageSettingsView data={{ ...ADMIN, pilot: [] }} actions={SETTINGS_ACTIONS} />),
  'acc3-messages-settings-running': () => settings(<CustomerMessageSettingsView data={ADMIN_RUNNING} actions={SETTINGS_ACTIONS} />),
  /* UX redesign R1 (D12): the nine-by-two grid with blocked WhatsApp cells (text not approved; only the unused second text not approved), and the other sub-tabs. */
  'acc3-messages-settings-whatsapp-blocked': () =>
    settings(<CustomerMessageSettingsView data={{ ...ADMIN, switches: ADMIN.switches.map((x) => ({ ...x, enabled: x.channel === 'email' && x.enabled })) }} actions={SETTINGS_ACTIONS} />),
  'acc3-messages-settings-texts': () => settings(<CustomerMessageSettingsView data={ADMIN} actions={SETTINGS_ACTIONS} tab="texts" />),
  'acc3-messages-settings-pilot': () => settings(<CustomerMessageSettingsView data={ADMIN} actions={SETTINGS_ACTIONS} tab="pilot" />),
  'acc3-messages-settings-pilot-everyone': () => settings(<CustomerMessageSettingsView data={ADMIN_RUNNING} actions={SETTINGS_ACTIONS} tab="pilot" />),
  'acc3-messages-settings-setup': () => settings(<CustomerMessageSettingsView data={ADMIN} actions={SETTINGS_ACTIONS} tab="setup" />),
  'acc3-messages-settings-setup-running': () => settings(<CustomerMessageSettingsView data={ADMIN_RUNNING} actions={SETTINGS_ACTIONS} tab="setup" />),
  'acc3-messages-settings-switch-open': () => settings(<CustomerMessageSettingsView data={ADMIN} actions={SETTINGS_ACTIONS} preview={{ open: { dialog: 'switch', type: 'e_ticket', channel: 'email' } }} />),
  'acc3-messages-settings-switch-refused': () =>
    settings(
      <CustomerMessageSettingsView
        data={{ ...ADMIN, templates: ADMIN.templates.map((t) => (t.type === 'hotel_voucher' ? { ...t, status: 'approved' as const } : t)) }}
        actions={{ ...SETTINGS_ACTIONS, setSwitch: act(A.cmsgTemplateNotApproved) }}
        preview={{ open: { dialog: 'switch', type: 'hotel_voucher', channel: 'whatsapp' }, typed: { reason: 'Owner approved the hotel voucher on WhatsApp.' }, state: refused('template_not_approved', 'WhatsApp has not approved this message text yet.') }}
      />,
    ),
  'acc3-messages-settings-template-open': () => settings(<CustomerMessageSettingsView data={ADMIN} actions={SETTINGS_ACTIONS} tab="texts" preview={{ open: { dialog: 'template', templateCode: 'tn_e_ticket_en_v1' } }} />),
  'acc3-messages-settings-pilot-add-refused': () =>
    settings(
      <CustomerMessageSettingsView
        data={ADMIN}
        tab="pilot"
        actions={{ ...SETTINGS_ACTIONS, addPilotDeal: act(A.cmsgPilotNotFound) }}
        preview={{ open: { dialog: 'add-pilot' }, typed: { dealReference: 'SYN-JOD-199', reason: 'Owner asked to pilot this Deal first.' }, state: refused('not_found', 'No Deal of this company has that reference. Check it on the Deal page.', 'dealReference') }}
      />,
    ),
  'acc3-messages-settings-pilot-off-open': () => settings(<CustomerMessageSettingsView data={ADMIN} actions={SETTINGS_ACTIONS} tab="pilot" preview={{ open: { dialog: 'pilot' } }} />),
  'acc3-messages-settings-error': () => settings(<CustomerMessageSettingsView data="error" actions={SETTINGS_ACTIONS} />),
  'acc3-messages-settings-loading': () => settings(<CustomerMessageSettingsLoading />),
  'acc3-messages-settings-no-access': () => shell(managerViewer, '/app/settings', <CustomerMessageSettingsNoAccess />),

  /* UX redesign R1, helper S3: Bitrix connection sub-tabs and the Imports index (r1-settings-s3-states.tsx). */
  ...R1_S3_STATES,
};

export const ACC3_MESSAGES_STATES = Object.keys(states);

export function renderAcc3MessagesState(state: string): ReactNode | null {
  return states[state]?.() ?? null;
}
