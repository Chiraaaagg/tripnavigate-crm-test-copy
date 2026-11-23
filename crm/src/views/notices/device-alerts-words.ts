import type { PushDeviceRow, PushDeviceState } from './device-alerts-types';

/*
 * Pure words for "Alerts on this device" (contract 15.8, 8.4). Status is
 * always said in words, never by colour alone. Unit-tested in
 * tests/unit/acc3u-alerts-words.test.ts.
 */

export const MAX_PUSH_DEVICES = 10;

export const DEVICE_ALERT_TEXT = {
  heading: 'Alerts on this device',
  what: 'Alerts reach this device even when the CRM is closed: urgent notices, new tasks and tasks assigned to you. They show the reference only, never names, phone numbers or amounts.',
  switchOff: 'Alerts on devices are not switched on yet.',
  turnOn: 'Turn on alerts on this device',
  turnOff: 'Turn off on this device',
  test: 'Send a test alert',
  remove: 'Remove',
  devicesHeading: 'Your devices',
  noDevices: 'No devices yet. Turn alerts on in the browser you use for work.',
  loadFailed: 'Could not load your devices. Close and open the bell to try again.',
  sharedComputer: 'On a shared computer, leave alerts off. Signing out removes this device.',
  tooMany: 'You already have 10 devices. Remove one first.',
} as const;

/** One line saying what this browser can do now. */
export function deviceStateLine(state: PushDeviceState): string {
  switch (state) {
    case 'unsupported':
      return 'Not supported: this browser cannot show alerts when the CRM is closed. The bell still shows every notice.';
    case 'needs_home_screen':
      return 'On iPhone, add TripNavigate to the Home Screen first (Share, then Add to Home Screen), open it from there and turn alerts on.';
    case 'blocked':
      return 'Blocked by this browser. Allow notifications for this site in the browser settings, then turn alerts on again.';
    case 'off':
      return 'Off on this device.';
    case 'on':
      return 'On for this device.';
  }
}

/**
 * UI review finding 5: a browser that is subscribed but whose device is not in
 * the person's list (removed elsewhere, moved to another person) gets no
 * alerts, so it counts as off. Unknown list (loading, failed) keeps the browser's word.
 */
export function effectiveDeviceState(state: PushDeviceState, devices: readonly PushDeviceRow[] | null): PushDeviceState {
  if (state === 'on' && devices !== null && !devices.some((d) => d.thisDevice)) return 'off';
  return state;
}

/** Why "Send a test alert" cannot be pressed now, or null when it can. */
export function testBlockedReason(devices: readonly PushDeviceRow[] | null, loadError: boolean): string | null {
  if (loadError) return 'Your devices did not load, so this device cannot be found.';
  if (devices === null) return 'Wait until your devices load.';
  if (!devices.some((d) => d.thisDevice)) return 'This device is not in your list. Turn alerts on again.';
  return null;
}

/** The state word shown in the heading ("Alerts on this device: on"). */
export function deviceStateWord(state: PushDeviceState, pushEnabled: boolean): string {
  if (!pushEnabled) return 'not switched on';
  if (state === 'on') return 'on';
  if (state === 'off') return 'off';
  if (state === 'blocked') return 'blocked';
  if (state === 'needs_home_screen') return 'needs Home Screen';
  return 'not supported';
}

/** Why "Turn on" cannot be pressed now, or null when it can. */
export function turnOnBlockedReason(state: PushDeviceState, pushEnabled: boolean, devices: readonly PushDeviceRow[]): string | null {
  if (!pushEnabled) return DEVICE_ALERT_TEXT.switchOff;
  if (state === 'unsupported') return 'This browser does not support alerts.';
  if (state === 'needs_home_screen') return 'Add TripNavigate to the Home Screen first.';
  if (state === 'blocked') return 'Allow notifications in the browser settings first.';
  if (!devices.some((d) => d.thisDevice) && devices.length >= MAX_PUSH_DEVICES) return DEVICE_ALERT_TEXT.tooMany;
  return null;
}

const DATE = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'Asia/Kolkata' });

export function deviceDate(iso: string | null): string {
  if (!iso) return 'not yet';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : DATE.format(t);
}

/** "Added 3 Nov 2026 · last alert 12 Nov 2026" (or "no alert yet"). */
export function deviceSummary(d: PushDeviceRow): string {
  return `Added ${deviceDate(d.createdAt)} · ${d.lastUsedAt ? `last alert ${deviceDate(d.lastUsedAt)}` : 'no alert yet'}`;
}
