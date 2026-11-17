import type { ReactNode } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import type { DecisionAction } from '@/views/accounts/supplier-forms';
import type { DeskResult } from '@/views/accounts-desk/desk-kit';
import { AccountsSettingsView, type AccountsSettingsViewModel } from '@/views/accounts-desk/settings';
import type { NoticeInbox, NoticesConfig } from '@/views/notices/types';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import { TallyMappingLoading, TallyMappingNoAccess, TallyMappingView, type TallyMappingPreview } from '@/views/tally-mapping/mapping';
import type { TallyMappingPageView } from '@/views/tally-mapping/types';
import { HISTORY, INBOX_ACCOUNTS } from './acc-fixtures';
import { ENTITY_ID, INBOX_ACCOUNTS_ALL_OFF, INBOX_SOUND_ON, MAPPING_COMPLETE, MAPPING_HISTORY, MAPPING_LIST, MAPPING_ROWS } from './acc2-settings-fixtures';
import * as A from './acc2-settings-preview-actions';
import { inSettings, settingsOwner } from './settings-preview-frame';
import { PreviewTyped } from './preview-typed';

/*
 * Accounts phase 2 preview states (acc2-settings-*), Track E: Settings ›
 * Accounts › Tally mapping (contract 8.1, 11.11), the customer documents and
 * refunds switches (11.12) and the bell's sound and pop-up settings (8.4,
 * 8.5, 11.13). Synthetic props only; rendered by the design-review gallery
 * only (a 404 outside local preview mode).
 */

const act = (a: unknown) => a as DecisionAction;

const accountsViewer: ShellViewer = {
  displayName: 'Synthetic Accounts 1',
  primaryRole: 'Accounts',
  primaryBranch: 'Jodhpur',
  canAdministerStaff: false,
  canManageGrants: false,
  canUseAccounts: true,
  canSeeAccountsDesk: true,
};
const managerViewer: ShellViewer = { ...accountsViewer, displayName: 'Synthetic Manager Jodhpur', primaryRole: 'Manager', canUseAccounts: false, canSeeAccountsDesk: false, canSeeBranchMoney: true, canSeeApprovals: true };

const PATH = '/app/admin/accounts/tally-mapping';
function mapping(view: Partial<TallyMappingPageView> = {}, preview?: TallyMappingPreview, action: DecisionAction | null = act(A.acc2MappingSaveOk)) {
  return inSettings(accountsViewer, PATH, <TallyMappingView view={{ entityName: 'Holiday Chacha Pvt LTD', list: MAPPING_LIST, baseHref: '/preview/acc2-settings-tally-mapping', ...view }} action={action} preview={preview} />);
}

const MODEL: AccountsSettingsViewModel = {
  noticesEnabled: true,
  canSetNotices: true,
  entities: [
    {
      entityId: ENTITY_ID,
      entityName: 'Holiday Chacha Pvt LTD',
      tallyExportEnabled: true,
      customerDocumentsEnabled: false,
      refundsEnabled: false,
      exceptionOwnerUserId: 'a0000991-0000-4000-8000-000000000991',
      accountsPeople: [
        { userId: 'a0000990-0000-4000-8000-000000000990', name: 'Synthetic Accounts 2' },
        { userId: 'a0000991-0000-4000-8000-000000000991', name: 'Synthetic Accounts 1' },
      ],
    },
  ],
};
const SETTINGS_ACTIONS = { setNotices: act(A.acc2SwitchOk), setTallyExport: act(A.acc2SwitchOk), setExceptionOwner: act(A.acc2SwitchOk), setCustomerDocuments: act(A.acc2SwitchOk), setRefunds: act(A.acc2SwitchOk) };
function accountsSettings(model: AccountsSettingsViewModel = MODEL, initial?: Partial<Record<'documents' | 'refunds', DeskResult>>) {
  return inSettings(
    settingsOwner,
    '/app/admin/accounts',
    <>
      <PageHeader title="Accounts settings" description="Staff notices, Tally export, the Tally exception owner, customer documents and refunds. Each change needs a reason and is recorded." />
      <AccountsSettingsView model={model} actions={SETTINGS_ACTIONS} initial={initial} />
    </>,
  );
}

const NOOP = A.acc2NoticeNoop as never;
function bell(inbox: NoticeInbox, preview: Omit<NonNullable<NoticesConfig['preview']>, 'inbox'>): ReactNode {
  const config: NoticesConfig = { api: { inbox: NOOP, history: NOOP, mark: NOOP, markAllRead: NOOP, setSound: NOOP, setPopups: NOOP }, realtime: null, preview: { inbox, history: HISTORY, open: true, view: 'settings', ...preview } };
  return (
    <StaffShell viewer={accountsViewer} currentPath="/app/accounts" notices={config}>
      <PageHeader title="To check" description="The bell sits in the menu column (desktop) and the top bar (phone); its settings show sound and pop-ups." />
    </StaffShell>
  );
}

const refused = (message: string, field: string) => ({ ok: false, code: 'invalid_input', message, field }) as unknown as DeskResult;


/** Preview only: the refusal state shows what was typed before it (PreviewTyped fills the fields once). */
function typed(values: Record<string, string>, body: ReactNode, firstOnly = false) {
  return (
    <>
      {body}
      <PreviewTyped values={values} firstOnly={firstOnly} />
    </>
  );
}

const states: Record<string, () => ReactNode> = {
  /* Settings › Accounts › Tally mapping */
  'acc2-settings-tally-mapping': () => mapping(),
  'acc2-settings-tally-mapping-missing-only': () => mapping({}, { missingOnly: true }),
  'acc2-settings-tally-mapping-complete': () => mapping({ list: MAPPING_COMPLETE }, { missingOnly: true }),
  'acc2-settings-tally-mapping-edit-open': () => mapping({}, { editMappingId: MAPPING_ROWS[0]!.mappingId }),
  'acc2-settings-tally-mapping-edit-refused': () =>
    mapping({}, { editMappingId: MAPPING_ROWS[20]!.mappingId, editState: refused('Check the highlighted field: a ledger name cannot start with = + - or @.', 'creditLedger') }, act(A.acc2MappingSaveRefused)),
  'acc2-settings-tally-mapping-history': () => mapping({ history: { mappingId: MAPPING_ROWS[0]!.mappingId, items: MAPPING_HISTORY } }),
  'acc2-settings-tally-mapping-history-error': () => mapping({ history: { mappingId: MAPPING_ROWS[0]!.mappingId, items: 'error' } }),
  'acc2-settings-tally-mapping-two-companies': () =>
    mapping({
      entities: [
        { id: ENTITY_ID, name: 'Holiday Chacha Pvt LTD', href: '/preview/acc2-settings-tally-mapping-two-companies', current: true },
        { id: 'a0000002-0000-4000-8000-000000000002', name: 'Synthetic Second Company', href: '/preview/acc2-settings-tally-mapping-two-companies', current: false },
      ],
    }),
  'acc2-settings-tally-mapping-empty': () => mapping({ list: { entityId: ENTITY_ID, rows: [], missingCount: 0 } }),
  'acc2-settings-tally-mapping-error': () => mapping({ list: 'error' }),
  'acc2-settings-tally-mapping-loading': () => inSettings(accountsViewer, PATH, <TallyMappingLoading />),
  'acc2-settings-tally-mapping-no-access': () => inSettings(managerViewer, PATH, <TallyMappingNoAccess />),

  /* Settings › Accounts: customer documents and refunds switches */
  'acc2-settings-accounts': () => accountsSettings(),
  'acc2-settings-accounts-on': () => accountsSettings({ ...MODEL, entities: MODEL.entities.map((e) => ({ ...e, customerDocumentsEnabled: true, refundsEnabled: true })) }),
  'acc2-settings-accounts-unknown': () => accountsSettings({ ...MODEL, entities: MODEL.entities.map((e) => ({ ...e, customerDocumentsEnabled: null, refundsEnabled: null })) }),
  'acc2-settings-accounts-refused': () => typed({ reason: 'Owner OK' }, accountsSettings(MODEL, { documents: refused('Check the highlighted field: the reason needs 10 to 500 characters.', 'reason') }), true),

  /* Bell: sound and pop-ups (on by default) */
  'acc2-settings-bell-default': () => bell(INBOX_SOUND_ON, { popupsOn: true, popupPermission: 'default' }),
  'acc2-settings-bell-popups-on': () => bell(INBOX_SOUND_ON, { popupsOn: true, popupPermission: 'granted' }),
  'acc2-settings-bell-popups-blocked': () => bell(INBOX_SOUND_ON, { popupsOn: true, popupPermission: 'denied' }),
  'acc2-settings-bell-popups-unsupported': () => bell(INBOX_SOUND_ON, { popupsOn: true, popupPermission: 'unsupported' }),
  'acc2-settings-bell-all-off': () => bell(INBOX_ACCOUNTS_ALL_OFF, { popupsOn: false, popupPermission: 'granted' }),
  'acc2-settings-bell-audio-locked': () => bell({ ...INBOX_ACCOUNTS, soundOn: true }, { popupsOn: true, popupPermission: 'granted', audioLocked: true }),
};

export const ACC2_SETTINGS_STATES = Object.keys(states);

export function renderAcc2SettingsState(state: string): ReactNode | null {
  return states[state]?.() ?? null;
}
