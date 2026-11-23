import type { ReactNode } from 'react';
import { PageHeader } from '@/components/ui/page-header';
import type { DeviceAlertsPreview, PushDeviceRow } from '@/views/notices/device-alerts-types';
import type { NoticeInbox, NoticesConfig } from '@/views/notices/types';
import { StaffShell, type ShellViewer } from '@/views/StaffShell';
import { HISTORY, INBOX_ACCOUNTS } from './acc-fixtures';
import { acc2NoticeNoop } from './acc2-settings-preview-actions';

/*
 * Accounts phase 3 preview states (acc3-alerts-*), track U: bell settings ›
 * "Alerts on this device" (contract 15.8, 8.1–8.5). Synthetic props only;
 * the buttons answer with synthetic words and never touch the browser's push
 * service. Rendered by the design-review gallery only (a 404 outside local
 * preview mode).
 */

const viewer: ShellViewer = {
  displayName: 'Synthetic Accounts 1',
  primaryRole: 'Accounts',
  primaryBranch: 'Jodhpur',
  canAdministerStaff: false,
  canManageGrants: false,
  canUseAccounts: true,
  canSeeAccountsDesk: true,
};

const NOOP = acc2NoticeNoop as never;
const INBOX_PUSH = { ...INBOX_ACCOUNTS, pushEnabled: true } as NoticeInbox;

const DEVICES: PushDeviceRow[] = [
  { deviceId: 'a0004801-0000-4000-8000-000000004801', label: 'Chrome on Windows', createdAt: '2026-11-03T05:30:00Z', lastUsedAt: '2026-11-12T09:10:00Z', thisDevice: true },
  { deviceId: 'a0004802-0000-4000-8000-000000004802', label: 'Safari on iPhone (Home Screen)', createdAt: '2026-11-05T07:00:00Z', lastUsedAt: '2026-11-11T16:45:00Z', thisDevice: false },
  { deviceId: 'a0004803-0000-4000-8000-000000004803', label: 'Edge on Windows', createdAt: '2026-11-08T10:15:00Z', lastUsedAt: null, thisDevice: false },
];
const TEN: PushDeviceRow[] = Array.from({ length: 10 }, (_, i) => ({
  deviceId: `a00049${String(10 + i)}-0000-4000-8000-0000000049${String(10 + i)}`,
  label: i % 2 === 0 ? `Chrome on Windows (desk ${String(i + 1)})` : `Firefox on Linux (desk ${String(i + 1)})`,
  createdAt: '2026-11-01T05:30:00Z',
  lastUsedAt: i === 0 ? '2026-11-12T09:10:00Z' : null,
  thisDevice: false,
}));

function bell(alerts: DeviceAlertsPreview): ReactNode {
  const config: NoticesConfig = {
    api: { inbox: NOOP, history: NOOP, mark: NOOP, markAllRead: NOOP, setSound: NOOP, setPopups: NOOP },
    realtime: null,
    preview: { inbox: alerts.pushEnabled ? INBOX_PUSH : INBOX_ACCOUNTS, history: HISTORY, open: true, view: 'settings', popupsOn: true, popupPermission: 'granted', deviceAlerts: alerts },
  };
  return (
    <StaffShell viewer={viewer} currentPath="/app/accounts" notices={config}>
      <PageHeader title="To check" description="Open the bell's settings to see sound, pop-ups and alerts on this device." />
    </StaffShell>
  );
}

const states: Record<string, () => ReactNode> = {
  'acc3-alerts-off-switch': () => bell({ pushEnabled: false, state: 'off', devices: [] }),
  'acc3-alerts-off-device': () => bell({ pushEnabled: true, state: 'off', devices: DEVICES.slice(1) }),
  'acc3-alerts-off-no-devices': () => bell({ pushEnabled: true, state: 'off', devices: [] }),
  'acc3-alerts-on': () => bell({ pushEnabled: true, state: 'on', devices: DEVICES }),
  'acc3-alerts-on-test-sent': () => bell({ pushEnabled: true, state: 'on', devices: DEVICES, message: { ok: true, text: 'Test alert sent. It should arrive within a minute.' } }),
  'acc3-alerts-blocked': () => bell({ pushEnabled: true, state: 'blocked', devices: DEVICES.slice(1) }),
  'acc3-alerts-iphone': () => bell({ pushEnabled: true, state: 'needs_home_screen', devices: DEVICES.slice(0, 1).map((d) => ({ ...d, thisDevice: false })) }),
  'acc3-alerts-unsupported': () => bell({ pushEnabled: true, state: 'unsupported', devices: [] }),
  'acc3-alerts-too-many': () => bell({ pushEnabled: true, state: 'off', devices: TEN }),
  'acc3-alerts-refused-too-many': () => bell({ pushEnabled: true, state: 'off', devices: TEN.slice(0, 9), message: { ok: false, text: 'You already have 10 devices. Remove one first.' } }),
  'acc3-alerts-refused-off': () => bell({ pushEnabled: true, state: 'off', devices: [], message: { ok: false, text: 'Alerts on devices are not switched on yet.' } }),
  'acc3-alerts-loading': () => bell({ pushEnabled: true, state: 'off', devices: [], loading: true }),
  'acc3-alerts-load-error': () => bell({ pushEnabled: true, state: 'on', devices: [], loadError: true }),
};

export const ACC3_ALERTS_STATES = Object.keys(states);

export function renderAcc3AlertsState(state: string): ReactNode | null {
  return states[state]?.() ?? null;
}
