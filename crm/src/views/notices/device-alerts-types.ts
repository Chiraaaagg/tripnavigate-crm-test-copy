/*
 * Accounts phase 3, contract 8.3–8.5: the typed adapter for "Alerts on this
 * device" in the bell settings. The shapes mirror track D's frozen read
 * D3 push_devices_list and the push-policy states; the functions are passed
 * in by the layout (track D's actions and browser adapter) or by the preview
 * gallery (stubs), so the bell never imports server or browser push code.
 */

import type { PushDeviceDTO, PushDevicesListDTO, PushState } from '@/modules/notices/contracts';

/** This browser's push state (track D's push-policy states). */
export type PushDeviceState = PushState;
/** D3 row: never an endpoint or key. */
export type PushDeviceRow = PushDeviceDTO;
/** D3 push_devices_list(). */
export type PushDevicesList = PushDevicesListDTO;

export type PushActionResult<T = undefined> = { ok: true; data: T; message?: string } | { ok: false; code: string; message: string };

export interface DeviceAlertsApi {
  /** Feature detection plus the browser permission and this device's subscription. Never asks the browser. */
  detect: () => Promise<PushDeviceState>;
  /** D3 */
  list: () => Promise<PushActionResult<PushDevicesList>>;
  /** Registers the service worker, asks the browser, subscribes and calls D1. Only after a click. */
  turnOn: () => Promise<PushActionResult<PushDeviceState>>;
  /** Unsubscribes this browser and calls D2 push_device_remove_current. */
  turnOff: () => Promise<PushActionResult<PushDeviceState>>;
  /** D2 push_device_remove */
  remove: (deviceId: string) => Promise<PushActionResult>;
  /** D4 push_test_send */
  test: (deviceId: string) => Promise<PushActionResult>;
}

/** Preview gallery only: the starting state; never calls the network. */
export interface DeviceAlertsPreview {
  pushEnabled: boolean;
  state: PushDeviceState;
  devices: PushDeviceRow[];
  /** Start with a result line on screen (e.g. a refusal). */
  message?: { ok: boolean; text: string };
  loading?: boolean;
  loadError?: boolean;
}
